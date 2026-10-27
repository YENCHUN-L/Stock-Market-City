"""Stdlib-only growth-aware valuation for the market city.

Quarterly financials come from SEC EDGAR (one companyfacts file per company, reduced to a few KB of
quarterly figures). Each company is valued two ways:

- fade DCF:    fair value if today's revenue growth decays towards 3%, the way fast growth usually does;
- reverse DCF: the 10-year cash-flow growth that today's price already assumes.

A stock is "highly undervalued" when the price is below the pessimistic DCF, the upside to the middle
DCF is at least 30%, the price assumes less growth than the fading path, and the business passes basic
quality checks, so a cheap but shrinking company (a value trap) isn't flagged.
"""
import json
import math
import os
import time
import urllib.request
from datetime import date

FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
# Contracted revenue not yet recognized (backlog), for every filer in one request per quarter.
RPO_URL = "https://data.sec.gov/api/xbrl/frames/us-gaap/RevenueRemainingPerformanceObligation/USD/CY{period}I.json"
AGENT = "StockBS/1.0 personal stock tracker"
MAX_AGE = 7 * 24 * 3600      # re-fetch a company's filings weekly
VERSION = 5                  # bump when CONCEPTS change, so cached extracts are re-fetched

YEARS = 10                   # explicit DCF years
TERMINAL = 0.03              # growth after year 10
RATE = 0.09                  # discount rate for a debt-free company; the fair range uses rate ± RATE_STEP
RATE_STEP = 0.01
RISK_FREE = 0.04             # RATE = RISK_FREE + EQUITY_PREMIUM for an unlevered company; debt scales the premium
MAX_RATE = 0.16
DEBT_YIELD = 0.05            # debt is at least TTM interest / this (catches debt filed under company-specific tags)
NORM_QUARTERS = 12           # margins are averaged over this many quarters to smooth capex cycles
GROWTH_CAP = (-0.10, 0.40)   # starting growth is clipped to this range before it fades
HALF_LIFE = 3                # years for growth above the terminal rate to halve
# Backlog (RPO): signed contracts make future revenue more certain. Scaled by coverage = RPO / TTM revenue:
BACKLOG_WEIGHT = 0.5         # starting growth moves up to this far toward backlog growth (at coverage >= 1x)
BACKLOG_HALF_LIFE = 2.0      # and growth fades up to this many years slower (at coverage >= 2x)
BACKLOG_MIN = 0.1            # backlog smaller than 10% of revenue is ignored
TAX = 0.21                   # turns operating profit into after-tax profit
MIN_UPSIDE = 0.30            # margin of safety for "highly undervalued"
MAX_MARGIN_DROP = 0.05       # quality: after-tax operating margin may fall at most this much in a year
HISTORY_YEARS = 3            # fair-value trend: how far back to recompute the DCF quarter by quarter
FILING_LAG = 45              # days after a quarter ends before its numbers are public (10-Q deadline)
SPIKE = (2.0, 0.15)          # quality: 1-year growth at most 2x the 3-year rate + 15 points (no merger/cycle jump)
STALE_DAYS = 460             # quality: latest quarter must be newer than this
# A free-cash-flow DCF doesn't describe banks, insurers or REITs (deposits, float and property sales
# run through their cash flows), so they are not valued rather than valued wrongly.
NOT_VALUED = {"Financials": "DCF of free cash flow doesn't fit banks and insurers",
              "Real Estate": "REITs are valued on funds from operations, not free cash flow"}

CONCEPTS = {
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
                "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"],
    "operating_income": ["OperatingIncomeLoss"],
    "interest": ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense"],
    "net_interest": ["InterestIncomeExpenseNonoperatingNet", "InterestIncomeExpenseNet"],  # negative = net cost
    "net_income": ["NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"],
    "ocf": ["NetCashProvidedByUsedInOperatingActivities",
            "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
}
# Balance-sheet items (point in time) for leverage: total debt and cash.
DEBT = {"total": ["LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
        "parts": ["LongTermDebtNoncurrent", "LongTermDebtCurrent"],
        "short": ["ShortTermBorrowings", "CommercialPaper"],
        "cash": ["CashAndCashEquivalentsAtCarryingValue"],
        "securities": ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
                       "DebtSecuritiesCurrent"],
        "cash_and_securities": ["CashCashEquivalentsAndShortTermInvestments"]}
FORMS = {"10-Q", "10-K", "10-Q/A", "10-K/A"}


# ---------- fetching ----------
def fund_path(data_dir, cik):
    return os.path.join(data_dir, "fund", f"{cik}.json")


def is_stale(data_dir, cik):
    p = fund_path(data_dir, cik)
    if not os.path.exists(p) or time.time() - os.path.getmtime(p) > MAX_AGE:
        return True
    fund = load(data_dir, cik)
    return not fund or fund.get("v") != VERSION


def refresh(data_dir, cik):
    """Download one company's filings and cache just its quarterly figures; errors are cached too,
    so a company without usable filings is retried weekly rather than on every pass."""
    try:
        req = urllib.request.Request(FACTS_URL.format(cik=cik), headers={"User-Agent": AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            fund = extract(json.load(resp))
    except Exception as e:
        fund = {"error": str(e), "quarters": [], "v": VERSION}
    tmp = fund_path(data_dir, cik) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(fund, f)
    os.replace(tmp, fund_path(data_dir, cik))
    return fund


def load(data_dir, cik):
    try:
        with open(fund_path(data_dir, cik)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ---------- extraction ----------
def _days(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days + 1


def _next_day(d):
    return date.fromordinal(date.fromisoformat(d).toordinal() + 1).isoformat()


def _periods(units):
    """(start, end) -> {val, filed}: the value from the latest filing for each reported period."""
    out = {}
    for x in units:
        if x.get("form") not in FORMS or "start" not in x:
            continue
        k = (x["start"], x["end"])
        if k not in out or x["filed"] >= out[k]["filed"]:
            out[k] = {"val": x["val"], "filed": x["filed"]}
    return out


def _chain(q, start, end):
    """Sum of back-to-back quarters from `start` to `end`, or None if there is a gap."""
    total, cur = 0.0, start
    while True:
        hit = next(((e, v) for e, v in q.items() if abs(_days(v["start"], cur) - 1) <= 3 and e <= end), None)
        if hit is None:
            return None
        total += hit[1]["val"]
        if hit[0] == end:
            return total
        cur = _next_day(hit[0])


def _quarterly(units):
    """Quarter end -> {start, val}. Cash-flow statements are year-to-date and the fourth quarter only
    appears inside the annual total, so a missing quarter is the year-to-date value minus the
    year-to-date value one quarter earlier."""
    per = _periods(units)
    q = {e: {"start": s, "val": v["val"]} for (s, e), v in per.items() if 80 <= _days(s, e) <= 100}
    longer = sorted((k, v) for k, v in per.items() if _days(*k) > 100)
    added = True
    while added:  # each derived quarter can unlock the next one
        added = False
        for (s, e), v in longer:
            if e in q:
                continue
            for e2 in list(q):
                if e2 <= s or not 80 <= _days(e2, e) - 1 <= 100:
                    continue
                prefix = per.get((s, e2))
                pv = prefix["val"] if prefix else _chain(q, s, e2)
                if pv is not None:
                    q[e] = {"start": _next_day(e2), "val": v["val"] - pv}
                    added = True
                    break
    return q


def _merged(gaap, tags):
    """Combine the tags for one field: the most recently updated tag first, the others fill gaps."""
    series = []
    for t in tags:
        units = [x for us in gaap.get(t, {}).get("units", {}).values() for x in us]
        q = _quarterly(units) if units else {}
        if q:
            series.append(q)
    series.sort(key=lambda q: max(q), reverse=True)
    out = {}
    for q in series:
        for e, v in q.items():
            out.setdefault(e, v)
    return out


def extract(facts):
    gaap = facts.get("facts", {}).get("us-gaap")
    if not gaap:
        raise ValueError("no US-GAAP financials")
    fields = {k: _merged(gaap, tags) for k, tags in CONCEPTS.items()}
    quarters = [{"end": e, **{k: (q[e]["val"] if e in q else None) for k, q in fields.items()}}
                for e in sorted(fields["revenue"])]
    return {"name": facts.get("entityName"), "quarters": quarters[-24:], "balance": _balance(gaap), "v": VERSION}


def _latest_instant(gaap, tag):
    """(end, value) of the most recent balance-sheet figure for a tag, or None."""
    best = None
    for x in gaap.get(tag, {}).get("units", {}).get("USD", []):
        if x.get("form") in FORMS and "start" not in x and (best is None or (x["end"], x["filed"]) > best[:2]):
            best = (x["end"], x["filed"], x["val"])
    return best and (best[0], best[2])


def _balance(gaap):
    """Total debt and cash at the latest balance-sheet date (figures from older dates are ignored)."""
    vals = {t: _latest_instant(gaap, t) for ts in DEBT.values() for t in ts}
    dates = [v[0] for v in vals.values() if v]
    if not dates:
        return None
    end = max(dates)
    at = lambda t: vals[t][1] if vals[t] and vals[t][0] == end else None
    # Overlapping tags (e.g. a total and its parts) are combined with max, not summed, to avoid double counting.
    total = max([at(t) or 0 for t in DEBT["total"]] + [sum(at(t) or 0 for t in DEBT["parts"])])
    debt = total + sum(at(t) or 0 for t in DEBT["short"])
    cash = max(sum(at(t) or 0 for t in DEBT["cash"]) + max(at(t) or 0 for t in DEBT["securities"]),
               max(at(t) or 0 for t in DEBT["cash_and_securities"]))
    return {"end": end, "debt": debt, "cash": cash}


# ---------- valuation ----------
def _contiguous(quarters):
    """The longest run of back-to-back quarters with revenue, ending with the latest one."""
    qs = [q for q in quarters if q["revenue"] is not None]
    run = qs[-1:]
    for q in reversed(qs[:-1]):
        if not 80 <= _days(q["end"], run[0]["end"]) - 1 <= 100:
            break
        run.insert(0, q)
    return run


def _ttm(run, i, key, missing_zero=False):
    if i < 3:
        return None
    vals = [run[j][key] for j in range(i - 3, i + 1)]
    if missing_zero:
        vals = [v or 0 for v in vals]
    return None if None in vals else sum(vals)


def _dcf(cf0, growths, rate):
    v, cf = 0.0, cf0
    for t, g in enumerate(growths, 1):
        cf *= 1 + g
        v += cf / (1 + rate) ** t
    return v + cf * (1 + TERMINAL) / (rate - TERMINAL) / (1 + rate) ** len(growths)


def _fade(g0, half_life=HALF_LIFE):
    """Growth path starting at g0 whose excess over the terminal rate halves every `half_life` years."""
    return [TERMINAL + (g0 - TERMINAL) * 0.5 ** (k / half_life) for k in range(YEARS)]


def backlog(data_dir):
    """CIK -> [[date, RPO], ...] from the last 7 quarterly SEC frames (cached for a day)."""
    path = os.path.join(data_dir, "rpo.json")
    if not os.path.exists(path) or time.time() - os.path.getmtime(path) > 24 * 3600:
        today, out = date.today(), {}
        y, q = today.year, (today.month - 1) // 3 + 1
        for _ in range(7):
            try:
                req = urllib.request.Request(RPO_URL.format(period=f"{y}Q{q}"), headers={"User-Agent": AGENT})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    for r in json.load(resp)["data"]:
                        out.setdefault(str(r["cik"]), {})[r["end"]] = r["val"]
            except Exception:
                pass  # the current quarter's frame may not exist yet
            y, q = (y, q - 1) if q > 1 else (y - 1, 4)
        if out:
            with open(path, "w") as f:
                json.dump({c: sorted(v.items()) for c, v in out.items()}, f)
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _backlog_adjust(rpo, rev, g1, g3, g0, latest_end):
    """Raise starting growth toward backlog growth and slow the fade, in proportion to backlog coverage."""
    if not rpo:
        return g0, HALF_LIFE, None
    end, now = rpo[-1]
    if now <= 0 or abs(_days(end, latest_end)) > 200:  # stale backlog figure
        return g0, HALF_LIFE, None
    prev = next((v for d, v in reversed(rpo) if 330 <= _days(d, end) - 1 <= 400), None)
    cov = now / rev
    if cov < BACKLOG_MIN:
        return g0, HALF_LIFE, {"rpo": now, "coverage": round(cov, 2), "used": False}
    g_b = now / prev - 1 if prev and prev > 0 else None
    w = min(BACKLOG_WEIGHT, cov * BACKLOG_WEIGHT)
    if g_b is not None:
        base = (g1 + g3) / 2 if g3 is not None else g1
        g0 = min(max((1 - w) * base + w * g_b, GROWTH_CAP[0]), GROWTH_CAP[1])
    half_life = HALF_LIFE + min(BACKLOG_HALF_LIFE, cov)
    return g0, half_life, {"rpo": now, "date": end, "coverage": round(cov, 2), "growth": _pct(g_b), "weight": _pct(w),
                           "half_life": round(half_life, 1), "used": True}


def _equity_rate(net_debt, cap):
    """Discount rate for shareholders: debt makes equity riskier (Hamada), so the equity premium grows
    with net debt / market cap. A debt-free company gets RATE."""
    de = max(0.0, net_debt) / cap
    return min(MAX_RATE, RISK_FREE + (RATE - RISK_FREE) * (1 + (1 - TAX) * de)), de


def _implied_growth(cf0, target, rate):
    """Constant 10-year growth that makes the DCF equal `target` (the DCF rises with growth)."""
    lo, hi = -0.5, 1.0
    if _dcf(cf0, [hi] * YEARS, rate) < target:
        return hi
    if _dcf(cf0, [lo] * YEARS, rate) > target:
        return lo
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if _dcf(cf0, [mid] * YEARS, rate) < target else (lo, mid)
    return (lo + hi) / 2


def _pct(x):
    return None if x is None else round(100 * x, 1)


def _fcf(q):
    return None if q["ocf"] is None else q["ocf"] - (q["capex"] or 0)


def _interest(q):
    # Some companies (T-Mobile) only report net interest, negative when it's a cost.
    return q.get("interest") or max(0.0, -(q.get("net_interest") or 0))


def _op_after_interest(q):
    # Operating profit after interest: what's left for shareholders, since the DCF is compared with the
    # market cap (equity), not with equity plus debt. Without this, heavily indebted firms look cheap.
    return None if q["operating_income"] is None else (q["operating_income"] - _interest(q)) * (1 - TAX)


def _margin(rows, f):
    pairs = [(f(q), q["revenue"]) for q in rows]
    pairs = [p for p in pairs if p[0] is not None]
    return sum(v for v, _ in pairs) / sum(r for _, r in pairs) if len(pairs) >= 4 else None


def _earnings(run, i):
    """Inputs of the DCF using only quarters up to run[i], or None if they can't be computed."""
    rev, rev_1y, rev_3y = _ttm(run, i, "revenue"), _ttm(run, i - 4, "revenue"), _ttm(run, i - 12, "revenue")
    if not rev or rev <= 0 or not rev_1y or rev_1y <= 0:
        return None
    g1 = rev / rev_1y - 1
    g3 = (rev / rev_3y) ** (1 / 3) - 1 if rev_3y and rev_3y > 0 else None
    recent = run[max(0, i - NORM_QUARTERS + 1):i + 1]
    # Earnings power: free cash flow alone punishes heavy investment years, after-tax operating profit
    # ignores capex; averaging the two balances them.
    fcf_m, op_m = _margin(recent, _fcf), _margin(recent, _op_after_interest)
    used = [m for m in (fcf_m, op_m) if m is not None]
    power = sum(used) / len(used) if used else None
    g0 = min(max((g1 + g3) / 2 if g3 is not None else g1, GROWTH_CAP[0]), GROWTH_CAP[1])
    return {"rev": rev, "rev_1y": rev_1y, "g1": g1, "g3": g3, "fcf_m": fcf_m, "op_m": op_m, "g0": g0,
            "cf0": rev * power if power and power > 0 else None}


def value(fund, price, company_cap, sector, as_of, rpo=None):
    """Valuation label and figures for one stock. `company_cap` covers every share class."""
    if sector in NOT_VALUED:
        return {"label": "n/a", "why": NOT_VALUED[sector]}
    if not fund:
        return {"label": "n/a", "why": "SEC filings not loaded yet"}
    if fund.get("error"):
        return {"label": "n/a", "why": f"no usable SEC filings ({fund['error'][:80]})"}
    run = _contiguous(fund["quarters"])
    i = len(run) - 1
    if i < 7:
        return {"label": "n/a", "why": "fewer than 2 years of quarterly filings"}
    e = _earnings(run, i)
    if not e:
        return {"label": "n/a", "why": "missing revenue history"}
    rev, rev_1y, g1, g3, g0 = e["rev"], e["rev_1y"], e["g1"], e["g3"], e["g0"]
    out = {"g1": _pct(g1), "g3": _pct(g3), "fcf_margin": _pct(e["fcf_m"]), "op_margin": _pct(e["op_m"]),
           "quarter": run[i]["end"]}
    if not e["cf0"]:
        return {**out, "label": "n/a", "why": "cash flow and operating profit are negative, so a DCF can't value it"}

    g0, half_life, bk = _backlog_adjust(rpo, rev, g1, g3, g0, run[i]["end"])
    cf0, path = e["cf0"], _fade(g0, half_life)
    per_dollar = price / company_cap  # fair price = DCF equity value scaled to one share of this ticker
    bal = fund.get("balance") or {"debt": 0.0, "cash": 0.0}
    interest = sum(_interest(q) for q in run[max(0, i - 3):i + 1])
    net_debt = max(bal["debt"], interest / DEBT_YIELD) - bal["cash"]
    rate, de = _equity_rate(net_debt, company_cap)
    fair = {"low": _dcf(cf0, path, rate + RATE_STEP) * per_dollar, "mid": _dcf(cf0, path, rate) * per_dollar,
            "high": _dcf(cf0, path, rate - RATE_STEP) * per_dollar}
    implied = _implied_growth(cf0, company_cap, rate)
    fade_g = math.prod(1 + g for g in path) ** (1 / YEARS) - 1
    upside = fair["mid"] / price - 1

    ttm_fcf = _ttm(run, i, "ocf")
    ttm_fcf = None if ttm_fcf is None else ttm_fcf - (_ttm(run, i, "capex", missing_zero=True) or 0)
    op_now, op_then = _ttm(run, i, "operating_income"), _ttm(run, i - 4, "operating_income")
    margin_change = op_now / rev - op_then / rev_1y if op_now is not None and op_then is not None else None
    checks = {
        "fcf": ttm_fcf is not None and ttm_fcf > 0,
        "growth": g1 > 0,
        "margin": margin_change is None or margin_change * (1 - TAX) >= -MAX_MARGIN_DROP,
        "fresh": _days(run[i]["end"], as_of) <= STALE_DAYS,
        # A jump far above the longer trend is usually a merger or a cycle peak, not lasting growth.
        "steady": g3 is None or g1 <= SPIKE[0] * max(g3, 0) + SPIKE[1],
    }
    failed = [{"fcf": "free cash flow negative over the last year", "growth": "revenue shrinking",
               "margin": "operating margin fell more than 5 points", "fresh": "latest filing too old",
               "steady": "revenue jump looks like a merger or cycle peak, not steady growth"}[k]
              for k, ok in checks.items() if not ok]
    if price < fair["low"] and upside >= MIN_UPSIDE and implied < fade_g and not failed:
        label, why = "high", "price below the pessimistic DCF with at least 30% upside, and quality checks pass"
    elif price < fair["low"]:
        label = "under"
        why = "; ".join(failed + ([f"upside {upside:.0%} is under 30%"] if upside < MIN_UPSIDE else [])
                        + (["price already assumes more growth than the fading path"] if implied >= fade_g else []))
    elif price > fair["high"]:
        label, why = "over", "price above the optimistic DCF"
    else:
        label, why = "fair", "price inside the fair range"
    # Fair-value trend: the same DCF recomputed at each past quarter with only the filings known then,
    # at today's discount rate and share count, so the line moves with the business, not the inputs.
    history = []
    for j in range(len(run)):
        if _days(run[j]["end"], run[i]["end"]) > HISTORY_YEARS * 366 + 1:
            continue
        ej = _earnings(run, j) if j >= 7 else None
        if ej and ej["cf0"]:
            pj = _fade(ej["g0"])
            history.append({"end": run[j]["end"],
                            # ~45 days after the quarter, but never after the latest price date (the filing is already in)
                            "from": min(as_of, date.fromordinal(date.fromisoformat(run[j]["end"]).toordinal() + FILING_LAG).isoformat()),
                            "low": round(_dcf(ej["cf0"], pj, rate + RATE_STEP) * per_dollar, 2),
                            "mid": round(_dcf(ej["cf0"], pj, rate) * per_dollar, 2),
                            "high": round(_dcf(ej["cf0"], pj, rate - RATE_STEP) * per_dollar, 2)})
    # The latest step is today's estimate, so it must match the panel exactly (including the backlog boost,
    # which only uses current backlog figures; earlier steps use reported revenue only).
    if history and history[-1]["end"] == run[i]["end"]:
        history[-1].update({k: round(v, 2) for k, v in fair.items()})
    trend = None
    if len(history) >= 2:
        avg = sum(h["mid"] for h in history) / len(history)
        years = max(0.25, (_days(history[0]["end"], history[-1]["end"]) - 1) / 365.25)
        first, last = history[0]["mid"], history[-1]["mid"]
        trend = {"avg": round(avg, 2), "vs_avg": _pct(avg / price - 1), "quarters": len(history),
                 "since": history[0]["end"], "cagr": _pct((last / first) ** (1 / years) - 1) if first > 0 else None}
    return {**out, "label": label, "why": why, "upside": _pct(upside), "rate": _pct(rate), "debt_to_cap": round(de, 2),
            "backlog": bk, "half_life": round(half_life, 1),
            "history": history, "trend": trend,
            "net_debt": net_debt,
            "fair": {k: round(v, 2) for k, v in fair.items()},
            "implied_g": _pct(implied), "fade_g": _pct(fade_g), "g0": _pct(g0),
            "ttm_fcf": ttm_fcf, "margin_change": _pct(margin_change), "checks": checks}


if __name__ == "__main__":  # python3 valuation.py NVDA BKNG   (uses the server's cached data)
    import sys
    import sp500
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(os.path.join(base, "fund"), exist_ok=True)
    m = sp500.Market(base, 10800)
    ciks = {s["sym"]: s["cik"] for s in sp500.constituents(base)}
    for sym in sys.argv[1:]:
        if is_stale(base, ciks[sym]):
            refresh(base, ciks[sym])
    by = {s["sym"]: s for s in m.snapshot()["stocks"]}
    for sym in sys.argv[1:]:
        print(sym, by[sym]["price"], json.dumps(by[sym].get("val")))

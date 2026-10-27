"""Stdlib-only growth-aware valuation for TWSE stocks, from Yahoo Finance fundamentals.

One request per stock returns the last 5 quarters and 4 fiscal years of revenue, operating income, net income,
free cash flow, interest, debt and cash. The model is the same as the US city's:

- fade DCF:    fair value if today's revenue growth decays towards 3%, the way fast growth usually does;
- reverse DCF: the 10-year cash-flow growth that today's price already assumes;
- "highly undervalued": price below the pessimistic DCF, >=30% upside, price assumes less growth than the
  fading path, and quality checks pass (positive free cash flow, growing revenue, stable margin, steady growth).
"""
import json
import math
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date

URL = ("https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{sym}{suffix}"
       "?type={types}&period1={p1}&period2={p2}")
FIELDS = ["TotalRevenue", "OperatingIncome", "NetIncome", "FreeCashFlow", "InterestExpense"]
POINT = ["TotalDebt", "CashAndCashEquivalents", "CashCashEquivalentsAndShortTermInvestments"]
UA = "Mozilla/5.0 (X11; Linux x86_64) StockBS/1.0"
MAX_AGE = 7 * 24 * 3600
WORKERS = 6
VERSION = 1

YEARS, TERMINAL = 10, 0.03
RATE, RATE_STEP = 0.09, 0.01           # discount rate for a debt-free company; fair range = rate ± step
RISK_FREE, MAX_RATE = 0.04, 0.16       # debt scales the equity premium (Hamada), capped
TAX = 0.20                             # Taiwan corporate income tax
GROWTH_CAP, HALF_LIFE = (-0.10, 0.40), 3
MIN_UPSIDE, MAX_MARGIN_DROP, STALE_DAYS = 0.30, 0.05, 200
SPIKE = (2.0, 0.15)                    # 1-year growth at most 2x the 3-year rate + 15 points
QUIRK_UPSIDE = 3.0                     # >300% upside almost always means a data quirk, not a bargain
NOT_VALUED = {"金融保險業": "free-cash-flow DCFs don't fit banks and insurers",
              "建材營造": "developers' cash flow swings with pre-sales, land buys and completion-based revenue",
              "存託憑證": "depositary receipts of foreign companies (no comparable statements)"}


def _path(data_dir, sym):
    return os.path.join(data_dir, "fund", f"{sym}.json")


def _get(sym, suffix=".TW"):
    p2 = int(time.time())
    types = ",".join([f"quarterly{f}" for f in FIELDS + POINT] + [f"annual{f}" for f in FIELDS])
    req = urllib.request.Request(URL.format(sym=sym, suffix=suffix, types=types, p1=p2 - 6 * 366 * 86400, p2=p2), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.load(resp)["timeseries"]["result"]
    out = {"v": VERSION}
    for r in res:
        key = r["meta"]["type"][0]
        out[key] = sorted([[x["asOfDate"], x["reportedValue"]["raw"]] for x in r.get(key) or [] if x], key=lambda p: p[0])
    return out


def refresh(data_dir, symbols, progress=None):
    """`symbols`: [(code, Yahoo suffix)], e.g. ("2330", ".TW") or ("5347", ".TWO")."""
    """Fetch fundamentals for stocks whose cached copy is a week old (or missing)."""
    os.makedirs(os.path.join(data_dir, "fund"), exist_ok=True)
    todo = [(s, x) for s, x in symbols if not os.path.exists(_path(data_dir, s)) or time.time() - os.path.getmtime(_path(data_dir, s)) > MAX_AGE]
    done = [len(symbols) - len(todo)]

    def one(item):
        sym, suffix = item
        try:
            data = _get(sym, suffix)
        except Exception as e:
            data = {"v": VERSION, "error": str(e)}
        with open(_path(data_dir, sym), "w") as f:
            json.dump(data, f)
        done[0] += 1
        if progress:
            progress(done[0], len(symbols))
        time.sleep(0.05)

    if progress:
        progress(done[0], len(symbols))
    with ThreadPoolExecutor(WORKERS) as pool:
        list(pool.map(one, todo))


def load(data_dir, sym):
    try:
        with open(_path(data_dir, sym)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ---------- model ----------
def _dcf(cf0, growths, rate):
    v, cf = 0.0, cf0
    for t, g in enumerate(growths, 1):
        cf *= 1 + g
        v += cf / (1 + rate) ** t
    return v + cf * (1 + TERMINAL) / (rate - TERMINAL) / (1 + rate) ** len(growths)


def _fade(g0):
    return [TERMINAL + (g0 - TERMINAL) * 0.5 ** (k / HALF_LIFE) for k in range(YEARS)]


def _implied_growth(cf0, target, rate):
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


def _days(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _series(f, key):
    return {d: v for d, v in f.get(key, [])}


def _earnings(f, upto=None, monthly=None):
    """DCF inputs from the annual figures (and, for today, the latest four quarters), using only data up to `upto`."""
    ann = {k: {d: v for d, v in _series(f, f"annual{k}").items() if not upto or d <= upto} for k in FIELDS}
    years = sorted(ann["TotalRevenue"])
    if len(years) < 2:
        return None
    rev_q = sorted(_series(f, "quarterlyTotalRevenue").items())
    # Revenue now: the latest four quarters if they're contiguous, else the latest fiscal year.
    if not upto and len(rev_q) >= 4 and _days(rev_q[-4][0], rev_q[-1][0]) <= 290:
        rev, as_of = sum(v for _, v in rev_q[-4:]), rev_q[-1][0]
    else:
        rev, as_of = ann["TotalRevenue"][years[-1]], years[-1]
    fy, fy1 = ann["TotalRevenue"][years[-1]], ann["TotalRevenue"][years[-2]]
    g_fy = fy / fy1 - 1 if fy1 > 0 else None
    # 1-year growth: the latest fiscal year, blended with the latest quarter vs the same quarter a year earlier.
    g_q = rev_q[-1][1] / rev_q[0][1] - 1 if not upto and len(rev_q) >= 5 and rev_q[0][1] > 0 and _days(rev_q[0][0], rev_q[-1][0]) > 330 else None
    parts = [g for g in (g_fy, g_q) if g is not None]
    g1 = sum(parts) / len(parts) if parts else None
    # Monthly revenue (月營收, published by the 10th of each month) is the most current read: use its
    # year-to-date growth as today's 1-year growth when it's recent.
    if monthly and not upto and monthly.get("ytd") is not None:
        g1 = monthly["ytd"] / 100
    g3 = (fy / ann["TotalRevenue"][years[-4]]) ** (1 / 3) - 1 if len(years) >= 4 and ann["TotalRevenue"][years[-4]] > 0 else None
    if g1 is None or rev <= 0:
        return None
    # Earnings power: the free-cash-flow margin and the after-tax operating margin after interest, both over
    # up to the last 3 fiscal years (revenue-weighted), times revenue now.
    recent = years[-3:]
    rsum = sum(ann["TotalRevenue"][y] for y in recent)
    fcf = [ann["FreeCashFlow"].get(y) for y in recent]
    fcf_m = sum(fcf) / rsum if None not in fcf and rsum > 0 else None
    ops = [ann["OperatingIncome"].get(y) for y in recent]
    op_m = (sum((o - (ann["InterestExpense"].get(y) or 0)) * (1 - TAX) for o, y in zip(ops, recent)) / rsum
            if None not in ops and rsum > 0 else None)
    # Taiwan reports under IFRS 16, where rent and lease payments move out of operating cash flow, which
    # inflates free cash flow for airlines, restaurants, hotels and retailers. Take the lower of the two
    # margins (not their average) so a lease-driven cash-flow boost can't make a stock look cheap.
    used = [m for m in (fcf_m, op_m) if m is not None]
    power = min(used) if used else None
    g0 = (g1 + g3) / 2 if g3 is not None else g1
    # When growth is slowing (e.g. a post-COVID rebound in the 3-year rate), start no more than 10 points
    # above the latest 1-year growth, so an old jump isn't projected forward.
    g0 = min(max(min(g0, g1 + 0.10), GROWTH_CAP[0]), GROWTH_CAP[1])
    op_now, op_prev = ann["OperatingIncome"].get(years[-1]), ann["OperatingIncome"].get(years[-2])
    margin_change = op_now / fy - op_prev / fy1 if op_now is not None and op_prev is not None and fy > 0 and fy1 > 0 else None
    return {"rev": rev, "as_of": as_of, "g1": g1, "g3": g3, "g0": g0, "fcf_m": fcf_m, "op_m": op_m,
            "cf0": rev * power if power and power > 0 else None, "margin_change": margin_change, "years": years}


def _equity_rate(net_debt, cap):
    de = max(0.0, net_debt) / cap
    return min(MAX_RATE, RISK_FREE + (RATE - RISK_FREE) * (1 + (1 - TAX) * de)), de


def value(f, price, cap, sector, as_of, monthly=None):
    if sector in NOT_VALUED:
        return {"label": "n/a", "why": NOT_VALUED[sector]}
    if not f:
        return {"label": "n/a", "why": "fundamentals not loaded yet"}
    if f.get("error"):
        return {"label": "n/a", "why": "no fundamentals on Yahoo"}
    if monthly and _days(monthly["month"] + "-01", as_of) > 100:  # ignore a stale month
        monthly = None
    e = _earnings(f, monthly=monthly)
    if not e:
        return {"label": "n/a", "why": "fewer than 2 years of financials"}
    out = {"g1": _pct(e["g1"]), "g3": _pct(e["g3"]), "fcf_margin": _pct(e["fcf_m"]), "op_margin": _pct(e["op_m"]),
           "quarter": e["as_of"]}
    if not e["cf0"]:
        return {**out, "label": "n/a", "why": "cash flow and operating profit are negative, so a DCF can't value it"}
    debt = _series(f, "quarterlyTotalDebt"); cash = _series(f, "quarterlyCashCashEquivalentsAndShortTermInvestments") or _series(f, "quarterlyCashAndCashEquivalents")
    interest = sum(v for _, v in sorted(_series(f, "quarterlyInterestExpense").items())[-4:])
    net_debt = max(debt[max(debt)] if debt else 0.0, interest / 0.05) - (cash[max(cash)] if cash else 0.0)
    rate, de = _equity_rate(net_debt, cap)
    path, per_dollar = _fade(e["g0"]), price / cap
    fair = {"low": _dcf(e["cf0"], path, rate + RATE_STEP) * per_dollar, "mid": _dcf(e["cf0"], path, rate) * per_dollar,
            "high": _dcf(e["cf0"], path, max(rate - RATE_STEP, TERMINAL + 0.01)) * per_dollar}
    implied = _implied_growth(e["cf0"], cap, rate)
    fade_g = math.prod(1 + g for g in path) ** (1 / YEARS) - 1
    upside = fair["mid"] / price - 1
    fcf_q = sorted(_series(f, "quarterlyFreeCashFlow").items())[-4:]
    ttm_fcf = sum(v for _, v in fcf_q) if len(fcf_q) == 4 else (sorted(_series(f, "annualFreeCashFlow").items()) or [[0, None]])[-1][1]
    checks = {"fcf": ttm_fcf is not None and ttm_fcf > 0, "growth": e["g1"] > 0,
              "margin": e["margin_change"] is None or e["margin_change"] * (1 - TAX) >= -MAX_MARGIN_DROP,
              "fresh": _days(e["as_of"], as_of) <= STALE_DAYS,
              "steady": e["g3"] is None or e["g1"] <= SPIKE[0] * max(e["g3"], 0) + SPIKE[1]}
    failed = [{"fcf": "free cash flow negative over the last year", "growth": "revenue shrinking",
               "margin": "operating margin fell more than 5 points", "fresh": "latest financials too old",
               "steady": "revenue jump looks like a merger or cycle peak, not steady growth"}[k] for k, ok in checks.items() if not ok]
    if upside > QUIRK_UPSIDE:
        failed.append("upside over 300% usually means a data quirk (one-off cash flow, leases under IFRS 16, lumpy "
                      "revenue): check the statements")
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
    # Fair-value trend: the same DCF at each fiscal year-end (only the figures known then), then today.
    history = []
    for y in e["years"][1:]:  # every fiscal year that has a prior year to measure growth against
        ey = _earnings(f, upto=y)
        if ey and ey["cf0"]:
            py = _fade(ey["g0"])
            history.append({"end": y, "from": min(as_of, date.fromordinal(date.fromisoformat(y).toordinal() + 75).isoformat()),
                            **{k: round(_dcf(ey["cf0"], py, r) * per_dollar, 2) for k, r in
                               (("low", rate + RATE_STEP), ("mid", rate), ("high", max(rate - RATE_STEP, TERMINAL + 0.01)))}})
    # Today's estimate starts when its figures were public (~45 days after the quarter), but never later than the
    # latest price date: the data is already here, so the chart must show it.
    history.append({"end": e["as_of"], "from": min(as_of, date.fromordinal(date.fromisoformat(e["as_of"]).toordinal() + 45).isoformat()),
                    **{k: round(v, 2) for k, v in fair.items()}})
    trend = None
    if len(history) >= 2:
        avg = sum(h["mid"] for h in history) / len(history)
        yrs = max(0.25, _days(history[0]["end"], history[-1]["end"]) / 365.25)
        first, last = history[0]["mid"], history[-1]["mid"]
        trend = {"avg": round(avg, 2), "vs_avg": _pct(avg / price - 1), "quarters": len(history), "since": history[0]["end"],
                 "cagr": _pct((last / first) ** (1 / yrs) - 1) if first > 0 and last > 0 else None}
    return {**out, "label": label, "why": why, "upside": _pct(upside), "rate": _pct(rate), "debt_to_cap": round(de, 2),
            "monthly": monthly,
            "net_debt": net_debt, "history": history, "trend": trend, "fair": {k: round(v, 2) for k, v in fair.items()},
            "implied_g": _pct(implied), "fade_g": _pct(fade_g), "g0": _pct(e["g0"]), "ttm_fcf": ttm_fcf,
            "margin_change": _pct(e["margin_change"]), "checks": checks}

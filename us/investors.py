"""Stdlib-only 13F tracker: what 10 famous investors and 8 giant institutions hold, and whether they are
adding or trimming.

Every investment manager with over $100M in US stocks files Form 13F each quarter (up to 45 days after
it ends), listing its long positions. Comparing a manager's last two filings shows, per stock, whether
the share count went up (new / added), down (reduced / sold) or stayed the same.

- filing lists:  data.sec.gov submissions API
- holdings:      the filing's information table on www.sec.gov/Archives (needs a contact User-Agent)
- tickers:       13F lists CUSIPs, mapped to tickers with OpenFIGI and cached for good
                 (set OPENFIGI_KEY for a free API key's 10x faster rate)
"""
import bisect
import json
import os
import time
import urllib.request
import xml.etree.ElementTree as ET

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accn}/"
FIGI_URL = "https://api.openfigi.com/v3/mapping"
FIGI_KEY = os.environ.get("OPENFIGI_KEY")
# OpenFIGI without a key: 10 jobs per request, 25 requests per minute; with one: 100 jobs, 25 requests per 6 s.
FIGI_BATCH, FIGI_PAUSE = (100, 0.3) if FIGI_KEY else (10, 2.6)
UNCHANGED = 0.01                   # share count within ±1% counts as unchanged
LIST_MAX_AGE = 24 * 3600           # re-check each manager's filing list daily
QUARTERS = 13                      # ~3 years of filings: enough to see when each position was opened
BACK = 5                           # latest + 4 earlier quarters of shares in each institution row, for the 1Y window
# Institutions hold ~10,000 securities, mostly too small to matter. CUSIPs are looked up biggest first: those
# worth INST_FIRST anywhere, then the summary is written, then the rest down to INST_MIN (every S&P 1500
# stock is far above that at the index giants).
INST_FIRST, INST_MIN = 250e6, 5e6

INVESTORS = [
    {"key": "buffett", "person": "Warren Buffett", "firm": "Berkshire Hathaway", "cik": 1067983},
    {"key": "ackman", "person": "Bill Ackman", "firm": "Pershing Square", "cik": 1336528},
    {"key": "druckenmiller", "person": "Stanley Druckenmiller", "firm": "Duquesne Family Office", "cik": 1536411},
    {"key": "tepper", "person": "David Tepper", "firm": "Appaloosa", "cik": 1656456},
    {"key": "klarman", "person": "Seth Klarman", "firm": "Baupost", "cik": 1061768},
    {"key": "lilu", "person": "Li Lu", "firm": "Himalaya Capital", "cik": 1709323},
    {"key": "marks", "person": "Howard Marks", "firm": "Oaktree", "cik": 949509},
    {"key": "smith", "person": "Terry Smith", "firm": "Fundsmith", "cik": 1569205},
    {"key": "loeb", "person": "Dan Loeb", "firm": "Third Point", "cik": 1040273},
    {"key": "akre", "person": "Chuck Akre", "firm": "Akre Capital", "cik": 1112520},
]

# The giants. Index managers own a slice of nearly every stock and mostly trade on fund flows and index changes;
# active ones pick stocks. A firm that reports through several entities lists them all, added up per quarter.
INSTITUTIONS = [
    # Until Q4 2025 Vanguard Group filed one combination report for all its entities. Since 2026 it files a notice and
    # each entity reports itself: the two new advisers (most of it), Fiduciary Trust, Global Advisers, the UK and
    # Australian arms, Vanguard Advisers and National Trust. (Personalized Indexing, ~$12B, always filed on its own and
    # was also in the combination report, so it's left out rather than counted twice.)
    {"key": "vanguard", "person": "Vanguard", "firm": "Vanguard (all reporting entities)", "style": "index",
     "ciks": [102909, 2100121, 2100119, 933478, 1811242, 1680208, 1550100, 947529, 1984256]},
    # BlackRock's new holding company took over the filings from Q3 2024 (the old one became BlackRock Finance).
    {"key": "blackrock", "person": "BlackRock", "firm": "BlackRock, Inc.", "style": "index", "ciks": [2012383, 1364742]},
    {"key": "statestreet", "person": "State Street", "firm": "State Street Corp", "style": "index", "ciks": [93751]},
    {"key": "norges", "person": "Norges Bank", "firm": "Norway's sovereign wealth fund", "style": "index", "ciks": [1374170]},
    {"key": "fidelity", "person": "Fidelity", "firm": "FMR LLC", "style": "active", "ciks": [315066]},
    {"key": "capital", "person": "Capital Group", "firm": "Capital Research Global + World + International Investors",
     "style": "active", "ciks": [1422848, 1422849, 1562230]},
    {"key": "troweprice", "person": "T. Rowe Price", "firm": "T. Rowe Price Associates", "style": "active", "ciks": [80255]},
    {"key": "wellington", "person": "Wellington", "firm": "Wellington Management", "style": "active", "ciks": [902219]},
]

MANAGERS = ([{**i, "group": "famous", "ciks": [i["cik"]], "quarters": QUARTERS} for i in INVESTORS]
            + [{**i, "group": "inst", "quarters": QUARTERS} for i in INSTITUTIONS])


def _get(url, agent, data=None, as_json=True):
    headers = {"User-Agent": agent}
    if FIGI_KEY and url == FIGI_URL:
        headers["X-OPENFIGI-APIKEY"] = FIGI_KEY
    if data is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(data).encode()
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp) if as_json else resp.read()


def _write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def _read(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ---------- filings ----------
FORM_RANK = {"13F-HR": 2, "13F-HR/A": 1, "13F-NT": 0, "13F-NT/A": 0}


def filings(cik, agent, quarters=QUARTERS):
    """The last `quarters` quarters' 13F filings, newest first: [{report, filed, accn, notice, amends}]. The
    original filing is the base, and `amends` lists the later amendments in filing order: some add holdings left
    out of the original (Vanguard files its holdings across an original and "NEW HOLDINGS" amendments), some
    restate it. A 13F-NT notice means another entity reported the holdings, so it counts as filed with nothing in it."""
    subs = _get(SUBMISSIONS_URL.format(cik=cik), agent)["filings"]
    pages = [p["name"] for p in subs.get("files", [])]
    r, by_q, amends = subs["recent"], {}, {}
    while True:
        for i, form in enumerate(r["form"]):
            if form not in FORM_RANK or not r["reportDate"][i]:
                continue
            f = {"report": r["reportDate"][i], "filed": r["filingDate"][i], "accn": r["accessionNumber"][i],
                 "original": form == "13F-HR", "notice": form.startswith("13F-NT"), "rank": FORM_RANK[form]}
            if form == "13F-HR/A":
                amends.setdefault(f["report"], []).append((f["filed"], f["accn"]))
            cur = by_q.get(f["report"])
            if cur is None or (f["rank"], f["filed"]) > (cur.get("rank", 2 if cur["original"] else 1), cur["filed"]):
                by_q[f["report"]] = f
        # Managers that file thousands of other forms (13G) push older 13Fs onto the paged history.
        if len(by_q) >= quarters or not pages:
            break
        r = _get("https://data.sec.gov/submissions/" + pages.pop(0), agent)
    out = [by_q[q] for q in sorted(by_q, reverse=True)[:quarters]]
    for f in out:
        f["amends"] = [a for filed, a in sorted(amends.get(f["report"], [])) if a != f["accn"] and filed >= f["filed"]]
    return out


def _amendment(cik, accn, agent):
    """An amendment's type and holdings: {"type": "NEW HOLDINGS" | "RESTATEMENT", "h": {...}}. One without an
    information table (a cover-page fix) changes nothing."""
    base = ARCHIVE_URL.format(cik=cik, accn=accn.replace("-", ""))
    doc = ET.fromstring(_get(base + "primary_doc.xml", agent, as_json=False))
    kind = next(((e.text or "").strip().upper() for e in doc.iter() if _local(e.tag) == "amendmentType"), "RESTATEMENT")
    try:
        return {"type": kind, "h": holdings(cik, accn, agent)}
    except ValueError:  # no information table
        return {"type": "NEW HOLDINGS", "h": {}}


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def holdings(cik, accn, agent):
    """CUSIP -> {name, cls, shares, value} from a filing's information table, summed over the rows a
    manager splits one position into (Berkshire reports each holding per sub-manager). Options and
    bond principal amounts are left out."""
    base = ARCHIVE_URL.format(cik=cik, accn=accn.replace("-", ""))
    items = _get(base + "index.json", agent)["directory"]["item"]
    xmls = [i for i in items if i["name"].lower().endswith(".xml") and i["name"] != "primary_doc.xml"]
    if not xmls:
        raise ValueError(f"no information table in {accn}")
    table = max(xmls, key=lambda i: int(i.get("size") or 0))["name"]
    root = ET.fromstring(_get(base + table, agent, as_json=False))
    out = {}
    for row in root.iter():
        if _local(row.tag) != "infoTable":
            continue
        f = {_local(e.tag): (e.text or "").strip() for e in row.iter()}
        if f.get("putCall") or f.get("sshPrnamtType", "SH") != "SH" or not f.get("cusip"):
            continue
        h = out.setdefault(f["cusip"].upper(), {"name": f.get("nameOfIssuer"), "cls": f.get("titleOfClass"),
                                                 "shares": 0, "value": 0})
        h["shares"] += float(f.get("sshPrnamt") or 0)
        h["value"] += float(f.get("value") or 0)
    return out


def _dollars(h):
    """Since 2023 values are reported in dollars, but some managers still file in thousands. A median value
    per share under $1 can only mean thousands, so scale those filings up."""
    per_share = sorted(x["value"] / x["shares"] for x in h.values() if x["shares"])
    if per_share and per_share[len(per_share) // 2] < 1:
        for x in h.values():
            x["value"] *= 1000
    return h


# ---------- CUSIP -> ticker ----------
def cusip_map(data_dir, cusips, agent, progress=None):
    """Ticker for each CUSIP via OpenFIGI, looked up in the order given; misses are cached too, so each CUSIP
    is looked up once. `progress(done, total)` follows the lookups."""
    path = os.path.join(data_dir, "cusip_map.json")
    known = _read(path) or {}
    todo = [c for c in dict.fromkeys(cusips) if c not in known]
    for k in range(0, len(todo), FIGI_BATCH):
        batch = todo[k:k + FIGI_BATCH]
        try:
            res = _get(FIGI_URL, agent, [{"idType": "ID_CUSIP", "idValue": c, "exchCode": "US"} for c in batch])
        except Exception:
            time.sleep(FIGI_PAUSE * 4)  # rate-limited or offline: leave these for the next refresh
            continue
        for c, r in zip(batch, res):
            data = r.get("data") or []
            pick = next((d for d in data if d.get("securityType") == "Common Stock"), data[0] if data else None)
            known[c] = pick["ticker"].replace("/", "-").replace(".", "-").replace(" ", "-") if pick else None
        _write(path, known)
        if progress:
            progress(min(k + FIGI_BATCH, len(todo)), len(todo))
        time.sleep(FIGI_PAUSE)
    return known


# ---------- changes ----------
def _by_ticker(h, tickers):
    out = {}
    for cusip, x in h.items():
        t = tickers.get(cusip)
        if t:
            y = out.setdefault(t, {"shares": 0, "value": 0})
            y["shares"] += x["shares"]
            y["value"] += x["value"]
    return out


def timelines(fl, hs, tickers):
    """Per ticker, [date, shares, value] at each filed quarter-end (oldest first), plus when the current (or
    last) run of holding began. `since_before` means it was already held in the oldest filing we have."""
    quarters = [(f["report"], _by_ticker(h, tickers)) for f, h in zip(fl, hs) if h is not None][::-1]
    out = {}
    for t in {t for _, q in quarters for t in q}:
        series = [[d, q.get(t, {}).get("shares", 0), q.get(t, {}).get("value", 0)] for d, q in quarters]
        last = max(i for i, x in enumerate(series) if x[1])   # latest quarter it was held
        start = last
        while start > 0 and series[start - 1][1]:
            start -= 1
        out[t] = {"series": series, "since": series[start][0], "since_before": start == 0,
                  "exited": series[last + 1][0] if last + 1 < len(series) else None}
    return out


def _status(sh, ps, has_prev):
    if not ps:
        status, pct = ("new", None) if has_prev else ("held", None)
    elif not sh:
        status, pct = "sold", -100.0
    else:
        pct = 100 * (sh / ps - 1)
        status = "added" if pct > 100 * UNCHANGED else "reduced" if pct < -100 * UNCHANGED else "unchanged"
    return {"status": status, "change_pct": None if pct is None else round(pct, 1)}


def changes(now, prev, tickers):
    """Per ticker, how the position changed between the previous and the latest filing."""
    a, b = _by_ticker(now, tickers), _by_ticker(prev or {}, tickers)
    total = sum(x["value"] for x in now.values()) or 1
    out = {}
    for t in set(a) | set(b):
        sh, ps = a.get(t, {}).get("shares", 0), b.get(t, {}).get("shares", 0)
        value = a.get(t, {}).get("value", 0)
        out[t] = {**_status(sh, ps, prev is not None), "shares": sh, "prev_shares": ps, "value": value,
                  "prev_value": b.get(t, {}).get("value", 0), "weight": round(100 * value / total, 2)}
    return out


# ---------- stock splits ----------
SPLIT_TOL = 1.25  # a filed price within ±25% of the split-adjusted close is the same share


def _close_on(bars, d):
    """Last close on or before date d (bars are [[date, close]], oldest first)."""
    i = bisect.bisect_right(bars, [d, float("inf")]) if d else 0
    return bars[i - 1][1] if i else None


def _split_factor(value, shares, close):
    """How many of today's shares one filed share became: the filing's price (value ÷ shares) over Yahoo's
    split-adjusted close that day (10 after a 10-for-1 split, 0.1 after a 1-for-10 reverse split)."""
    if not value or not shares or not close:
        return 1
    f = value / shares / close
    return 1 if 1 / SPLIT_TOL < f < SPLIT_TOL else f


def adjust_splits(rows, managers, bars):
    """Share counts in today's shares, so a split between two filings (KLAC 10-for-1, BKNG 25-for-1) isn't read
    as buying, and holdings compare with today's share count. `managers`: key -> {report_date, prev_report_date}."""
    out = []
    for r in rows:
        m = managers.get(r["key"]) or {}
        fn = _split_factor(r["value"], r["shares"], _close_on(bars, m.get("report_date")))
        fp = _split_factor(r.get("prev_value"), r["prev_shares"], _close_on(bars, m.get("prev_report_date")))
        if fn != 1 or fp != 1:
            sh, ps = r["shares"] * fn, r["prev_shares"] * fp
            r = {**r, "shares": sh, "prev_shares": ps, **_status(sh, ps, r["status"] != "held"), "split": True}
        if r.get("back"):
            r = {**r, "back": _series_today(r["back"], bars)}
        out.append(r)
    return out


def _series_today(series, bars):
    """[date, shares, value] history with the shares in today's shares. Old caches have no value: left as is."""
    out = []
    for x in series:
        d, sh, v = x[0], x[1], (x[2] if len(x) > 2 else 0)
        out.append([d, sh * _split_factor(v, sh, _close_on(bars, d)), v])
    return out


def adjust_timeline(tl, bars):
    """The chart's per-manager share histories in today's shares (see adjust_splits)."""
    return {k: {**x, "series": _series_today(x.get("series", []), bars)} for k, x in tl.items()}


# ---------- refresh ----------
def _merge(parts):
    """One quarter's holdings from several entities of the same firm, added up per CUSIP."""
    out = {}
    for h in parts:
        for c, x in h.items():
            y = out.setdefault(c, {"name": x["name"], "cls": x["cls"], "shares": 0, "value": 0})
            y["shares"] += x["shares"]
            y["value"] += x["value"]
    return out


def _quarters(m, folder, agent):
    """A manager's filed quarters (newest first) and the holdings of each, summed over its entities.
    A quarter whose holdings couldn't be fetched is None."""
    per = {}  # report date -> [(cik, filing)]
    for cik in m["ciks"]:
        list_path = os.path.join(folder, f"{cik}_filings{m['quarters']}a.json")
        fl = _read(list_path)
        if fl is None or time.time() - os.path.getmtime(list_path) > LIST_MAX_AGE:
            try:
                fl = filings(cik, agent, m["quarters"])
                _write(list_path, fl)
            except Exception as e:
                print(f"[13f] {m['person']} ({cik}): filing list failed: {e}", flush=True)
        for f in fl or []:
            per.setdefault(f["report"], []).append((cik, f))
    dates = sorted(per, reverse=True)[:m["quarters"]]
    # The newest quarter is complete only once every entity that reported the quarter before has filed too.
    if len(dates) > 1 and {c for c, _ in per[dates[1]]} - {c for c, _ in per[dates[0]]}:
        dates = dates[1:]
    fl, hs = [], []
    for d in dates:
        parts = []
        for cik, f in per[d]:
            if f.get("notice"):
                parts.append({})
                continue
            path = os.path.join(folder, f"{cik}_{d}.json")
            h = _read(path)
            if h is None:
                try:
                    h = holdings(cik, f["accn"], agent)
                    _write(path, h)  # a filing never changes, so it's fetched once
                except Exception as e:
                    print(f"[13f] {m['person']} ({cik}) {d}: {e}", flush=True)
                time.sleep(0.2)
            h = _dollars(h) if h else None
            for accn in f.get("amends", []) if h is not None else []:
                apath = os.path.join(folder, f"{cik}_{d}_{accn}.json")
                a = _read(apath)
                if a is None:
                    try:
                        a = _amendment(cik, accn, agent)
                        _write(apath, a)
                    except Exception as e:
                        print(f"[13f] {m['person']} ({cik}) {d} amendment {accn}: {e}", flush=True)
                        continue
                    time.sleep(0.2)
                ah = _dollars(a["h"])
                h = ah if a["type"] == "RESTATEMENT" else _merge([h, ah])
            parts.append(h)
        h = None if None in parts else _merge(parts)
        # Some managers (Norges Bank) report real holdings only every half-year and file an empty placeholder
        # table in between; skip those quarters so changes compare two real filings.
        if h is not None and not any(x["shares"] for x in h.values()):
            continue
        fl.append({"report": d, "filed": max(f["filed"] for _, f in per[d])})
        hs.append(h)
    return fl, hs


def _summary(loaded, tickers):
    investors, by_sym, timeline = [], {}, {}
    for inv, fl, hs in loaded:
        if not hs or hs[0] is None:
            continue
        now, prev = hs[0], (hs[1] if len(hs) > 1 else None)
        ch = changes(now, prev, tickers)
        tl = timelines(fl, hs, tickers)
        investors.append({**{k: inv[k] for k in ("key", "person", "firm", "group") + (("style",) if "style" in inv else ())},
                          "report_date": fl[0]["report"],
                          "prev_report_date": fl[1]["report"] if len(fl) > 1 and prev else None,
                          "filed": fl[0]["filed"], "total_value": sum(x["value"] for x in now.values()),
                          "positions": len(now)})
        for t, c in ch.items():
            x = tl.get(t, {})
            by_sym.setdefault(t, []).append({"key": inv["key"], **c, "since": x.get("since"),
                                             "since_before": x.get("since_before"),
                                             # institutions: recent share history, for the period buttons
                                             **({"back": x["series"][-BACK:]} if inv["group"] == "inst" else {})})
        # Full share history per stock, for the chart's entry/exit markers (served with the price history).
        for t, x in tl.items():
            timeline.setdefault(t, {})[inv["key"]] = x
    return {"investors": investors, "by_sym": by_sym, "timeline": timeline,
            "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def _by_issuer(tickers):
    """A CUSIP retired by a corporate action (DuPont's after its reverse split) no longer maps to a ticker. The
    first 6 characters name the issuer, so give it the ticker of that issuer's other CUSIP, if there's just one."""
    issuer = {}
    for c, t in tickers.items():
        if t:
            issuer.setdefault(c[:6], set()).add(t)
    return {c: t or (next(iter(issuer[c[:6]])) if len(issuer.get(c[:6], ())) == 1 else None)
            for c, t in tickers.items()}


def refresh(data_dir, agent, progress=None, lookups=None):
    """Fetch new filings for every manager and rebuild data/13f/summary.json. `progress(n)` is called after
    each manager and again whenever a new summary is written; `lookups(done, total)` follows the CUSIP lookups."""
    folder = os.path.join(data_dir, "13f")
    os.makedirs(folder, exist_ok=True)
    loaded = []
    for m in MANAGERS:
        fl, hs = _quarters(m, folder, agent)
        loaded.append((m, fl, hs))
        if progress:
            progress(len(loaded))
    famous = {c for m, _, hs in loaded if m["group"] == "famous" for h in hs if h for c in h}
    # Institutions' CUSIPs by their largest position anywhere, biggest first.
    top = {}
    for m, _, hs in loaded:
        if m["group"] == "inst":
            for h in hs:
                for c, x in (h or {}).items():
                    top[c] = max(top.get(c, 0), x["value"])
    ranked = sorted((c for c in top if top[c] >= INST_MIN and c not in famous), key=lambda c: -top[c])
    first = [c for c in ranked if top[c] >= INST_FIRST]
    summary_path = os.path.join(folder, "summary.json")
    known = _read(os.path.join(data_dir, "cusip_map.json")) or {}
    total = sum(c not in known for c in list(famous) + ranked)  # both passes, for one progress bar
    done = [0]

    def step(n, _):
        if lookups:
            lookups(done[0] + n, total)
    tickers = _by_issuer(cusip_map(data_dir, sorted(famous) + first, agent, step))
    done[0] = total - sum(c not in tickers for c in ranked)
    summary = _summary(loaded, tickers)
    _write(summary_path, summary)
    if progress:
        progress(len(loaded))
    if len(first) < len(ranked):  # smaller positions: mostly small caps and securities outside the S&P 1500
        tickers = _by_issuer(cusip_map(data_dir, ranked, agent, step))
        summary = _summary(loaded, tickers)
        _write(summary_path, summary)
    return summary


def load(data_dir):
    return _read(os.path.join(data_dir, "13f", "summary.json"))


if __name__ == "__main__":  # STOCKBS_SEC_AGENT="Name email" python3 investors.py
    import sys
    agent = os.environ.get("STOCKBS_SEC_AGENT")
    if not agent:
        sys.exit("set STOCKBS_SEC_AGENT to 'Your Name your@email' (SEC requires a contact for 13F downloads)")
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    s = refresh(base, agent, progress=lambda n: print(f"  {n}/{len(MANAGERS)} managers", flush=True))
    for inv in s["investors"]:
        print(f"{inv['person']:22} {inv['report_date']} (vs {inv['prev_report_date']}) ${inv['total_value']/1e9:6.1f}B "
              f"{inv['positions']} positions")
    top = sorted(((t, x) for t, xs in s["by_sym"].items() for x in xs if x["key"] == "buffett"),
                 key=lambda p: -p[1]["value"])[:10]
    for t, x in top:
        print(f"  BRK {t:6} {x['status']:9} {x['change_pct']!s:>7}% {x['shares']:>14,.0f} sh  ${x['value']/1e9:6.2f}B  {x['weight']}%")

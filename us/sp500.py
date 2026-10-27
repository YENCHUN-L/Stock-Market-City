"""Stdlib-only S&P 1500 data for the market city (S&P 500 + MidCap 400 + SmallCap 600).

- constituents: Wikipedia's lists of S&P 500 / 400 / 600 companies (symbol, name, GICS sector, CIK)
- prices:       Yahoo Finance daily closes for the last 3 years, one cached file per ticker
- market cap:   last close x shares outstanding from SEC EDGAR "frames" (every filer in one request)
- valuation:    growth-aware DCF from each company's quarterly SEC filings (see valuation.py)
"""
import json
import os
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from html.parser import HTMLParser

import investors
import valuation

WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_{idx}_companies"
INDEXES = {"500": 503, "400": 400, "600": 600}  # index -> expected size, for a sanity check
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=3y&interval=1d"
FRAME_URL = "https://data.sec.gov/api/xbrl/frames/{concept}/shares/CY{period}.json"
COVER_SHARES = "dei/EntityCommonStockSharesOutstanding"           # period-end count from the filing cover
DILUTED_SHARES = "us-gaap/WeightedAverageNumberOfDilutedSharesOutstanding"
# Multi-class companies tag cover counts per class, which frames leave out, so they fall back to the
# company-wide diluted average. Berkshire reports that in Class A equivalents (1 A = 1,500 B).
SHARE_UNITS = {"BRK-B": 1500}
# Last resort for companies whose SEC filings have no company-wide share count in any standard tag:
# approximate counts (in this ticker's class-equivalent shares, mid-2025). They change slowly, and the
# page marks these caps as estimated.
APPROX_SHARES = {"BRK-B": 2.16e9, "V": 1.95e9, "HSY": 2.03e8, "STZ": 1.78e8, "ERIE": 5.2e7, "ARES": 3.3e8}
AGENT = "StockBS/1.0 personal stock tracker"
CONSTITUENTS_MAX_AGE = 7 * 24 * 3600
SHARES_MAX_AGE = 24 * 3600
WORKERS = 6
FUND_WORKERS = 3  # SEC allows 10 requests/s; each worker pauses between companies
PERIODS = {"1d": 1, "1w": 5, "1m": 21, "3m": 63, "1y": 252}  # bars back; YTD handled apart
PRICE_DIR = "prices3y"  # 3 years of closes, so the chart can show the fair-value trend over the same span


def _get(url, as_json=True):
    req = urllib.request.Request(url, headers={"User-Agent": AGENT if "sec.gov" in url or "wiki" in url
                                               else "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp) if as_json else resp.read().decode("utf-8", "replace")


def _fresh(path, max_age):
    return os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age


def _write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


# ---------- constituents ----------
class _TableParser(HTMLParser):
    """Collects the text of each cell of the table with id="constituents"."""

    def __init__(self):
        super().__init__()
        self.depth, self.rows, self.row, self.cell = 0, [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "table" and (self.depth or dict(attrs).get("id") == "constituents"):
            self.depth += 1
        elif self.depth == 1 and tag == "tr":
            self.row = []
        elif self.depth == 1 and tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if tag == "table" and self.depth:
            self.depth -= 1
        elif self.depth == 1 and tag in ("td", "th") and self.cell is not None:
            self.row.append("".join(self.cell).strip())
            self.cell = None
        elif self.depth == 1 and tag == "tr" and self.row:
            self.rows.append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def _sec_ciks(data_dir):
    """Ticker -> CIK from SEC's company list, for index tables without a CIK column (the S&P 400)."""
    path = os.path.join(data_dir, "sec_tickers.json")
    if not _fresh(path, CONSTITUENTS_MAX_AGE):
        _write(path, {v["ticker"].upper().replace(".", "-"): v["cik_str"] for v in _get(SEC_TICKERS_URL).values()})
    with open(path) as f:
        return json.load(f)


def _index_table(idx):
    p = _TableParser()
    p.feed(_get(WIKI_URL.format(idx=idx), as_json=False))
    head, rows = p.rows[0], p.rows[1:]
    col = {name: i for i, name in enumerate(head)}
    cell = lambda r, name: r[col[name]] if name in col and col[name] < len(r) else ""
    return [{"sym": cell(r, "Symbol").replace(".", "-"), "name": cell(r, "Security"), "idx": idx,
             "sector": cell(r, "GICS Sector"), "industry": cell(r, "GICS Sub-Industry"),
             "cik": int(cell(r, "CIK")) if cell(r, "CIK").isdigit() else None} for r in rows if cell(r, "Symbol")]


def constituents(data_dir):
    """The S&P 1500, each stock tagged with its index. A failed or odd-looking refresh keeps the old list."""
    path = os.path.join(data_dir, "constituents1500.json")
    if not _fresh(path, CONSTITUENTS_MAX_AGE):
        try:
            out, seen = [], set()
            for idx, expected in INDEXES.items():
                rows = _index_table(idx)
                if abs(len(rows) - expected) > expected * 0.1:
                    raise ValueError(f"S&P {idx} table looks wrong ({len(rows)} rows)")
                for r in rows:  # during index changes a stock can briefly sit in two lists
                    if r["sym"] not in seen:
                        seen.add(r["sym"])
                        out.append(r)
            ciks = _sec_ciks(data_dir)
            for r in out:
                r["cik"] = r["cik"] or ciks.get(r["sym"])
            _write(path, out)
        except Exception as e:
            if not os.path.exists(path):
                raise
            print(f"[constituents] refresh failed, keeping the cached list: {e}", flush=True)
    with open(path) as f:
        return json.load(f)


# ---------- shares outstanding ----------
def _frames(concept, periods):
    """CIK -> value from a list of SEC frames, newest period first (newer values win)."""
    out = {}
    for period in periods:
        try:
            for row in _get(FRAME_URL.format(concept=concept, period=period))["data"]:
                out.setdefault(str(row["cik"]), row["val"])
        except Exception:
            pass  # the current quarter's frame may not exist yet
    return out


def shares(data_dir):
    """CIK -> {"cover": shares outstanding, "diluted": diluted average}, from the last five quarters."""
    path = os.path.join(data_dir, "shares.json")
    if not _fresh(path, SHARES_MAX_AGE):
        today = date.today()
        y, q, quarters = today.year, (today.month - 1) // 3 + 1, []
        for _ in range(5):
            quarters.append(f"{y}Q{q}")
            y, q = (y, q - 1) if q > 1 else (y - 1, 4)
        cover = _frames(COVER_SHARES, [p + "I" for p in quarters])
        # Annual frame last: a fiscal fourth quarter only appears inside the full-year figure.
        diluted = _frames(DILUTED_SHARES, quarters + [str(today.year - 1)])
        if cover or diluted:
            _write(path, {"cover": cover, "diluted": diluted})
    if not os.path.exists(path):
        return {"cover": {}, "diluted": {}}
    with open(path) as f:
        return json.load(f)


def shares_for(sh, cik, sym):
    n = sh["cover"].get(str(cik))
    if n:
        return n, False
    n = sh["diluted"].get(str(cik))
    return (n * SHARE_UNITS.get(sym, 1), True) if n else (None, False)


# ---------- prices ----------
def price_path(data_dir, sym):
    return os.path.join(data_dir, PRICE_DIR, f"{sym}.json")


def fetch_prices(data_dir, sym):
    res = _get(CHART_URL.format(sym=urllib.request.quote(sym)))["chart"]["result"][0]
    off = res.get("meta", {}).get("gmtoffset", 0)
    closes = res["indicators"]["quote"][0]["close"]
    bars = [[datetime.fromtimestamp(t + off, tz=timezone.utc).strftime("%Y-%m-%d"), round(c, 4)]
            for t, c in zip(res.get("timestamp") or [], closes) if c is not None]
    if not bars:
        raise ValueError(f"no prices for {sym}")
    _write(price_path(data_dir, sym), bars)
    return bars


def load_prices(data_dir, sym):
    p = price_path(data_dir, sym)
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def returns(bars):
    """Percent return for each period, from the closes."""
    closes = [c for _, c in bars]
    last, out = closes[-1], {}
    for k, n in PERIODS.items():
        base = closes[-1 - n] if len(closes) > n else closes[0] if k == "1y" else None  # young listings: 1y = since IPO
        out[k] = round(100 * (last / base - 1), 2) if base else None
    year = bars[-1][0][:4]
    prior = [c for d, c in bars if d[:4] < year]  # last close of the previous year
    out["ytd"] = round(100 * (last / prior[-1] - 1), 2) if prior else out["1y"]
    return out


# ---------- the market ----------
class Market:
    """Keeps the S&P 500 snapshot up to date in a background thread."""

    def __init__(self, data_dir, price_max_age, sec_agent=None):
        self.data_dir, self.price_max_age, self.sec_agent = data_dir, price_max_age, sec_agent
        os.makedirs(os.path.join(data_dir, PRICE_DIR), exist_ok=True)
        os.makedirs(os.path.join(data_dir, "fund"), exist_ok=True)
        self.lock = threading.Lock()
        self.progress = {"done": 0, "total": 0, "running": False, "errors": {}, "fund_done": 0, "fund_total": 0,
                         "inv_done": 0, "inv_total": len(investors.MANAGERS) if sec_agent else 0,
                         "figi_done": 0, "figi_total": 0}
        self.updated = None
        self._snapshot = None
        self.history = {}  # sym -> fair-value trend, served with the price history instead of in every snapshot
        self.inv_timeline = {}  # sym -> {investor: share history}, also served with the price history

    def refresh(self, force=False):
        with self.lock:
            if self.progress["running"]:
                return
            self.progress.update(running=True, done=0, errors={})
        try:
            stocks = constituents(self.data_dir)
            self.progress["total"] = len(stocks)

            def one(s):
                p = price_path(self.data_dir, s["sym"])
                try:
                    if force or not _fresh(p, self.price_max_age):
                        fetch_prices(self.data_dir, s["sym"])
                        time.sleep(0.1)
                except Exception as e:
                    self.progress["errors"][s["sym"]] = str(e)
                self.progress["done"] += 1
                if self.progress["done"] % 50 == 0:
                    self._snapshot = None  # let the page show the city filling in

            shares(self.data_dir)
            with ThreadPoolExecutor(WORKERS) as pool:
                list(pool.map(one, stocks))
            self.updated = datetime.now(timezone.utc).isoformat(timespec="seconds")
            self._snapshot = None
            self._refresh_fundamentals(stocks)
            self._snapshot = None
            if self.sec_agent:  # 13F downloads need a contact User-Agent (SEC's rule)
                self.progress["inv_done"] = 0
                try:
                    def inv_progress(n):  # also called whenever a new 13F summary is written
                        self.progress["inv_done"] = n
                        self._snapshot = None
                    investors.refresh(self.data_dir, self.sec_agent, progress=inv_progress,
                                      lookups=lambda d, t: self.progress.update(figi_done=d, figi_total=t))
                except Exception as e:
                    print(f"[13f] failed: {e}", flush=True)
                self.progress["inv_done"] = self.progress["inv_total"]
        finally:
            self._snapshot = None
            self.progress["running"] = False

    def _refresh_fundamentals(self, stocks):
        """Second pass: fetch the SEC filings of companies whose cached copy is a week old or missing."""
        ciks = sorted({s["cik"] for s in stocks if s["cik"] and s["sector"] not in valuation.NOT_VALUED})
        todo = [c for c in ciks if valuation.is_stale(self.data_dir, c)]
        self.progress.update(fund_done=len(ciks) - len(todo), fund_total=len(ciks))

        def one(cik):
            valuation.refresh(self.data_dir, cik)
            time.sleep(0.3)
            self.progress["fund_done"] += 1
            if self.progress["fund_done"] % 50 == 0:
                self._snapshot = None  # let the page show beacons as they're found

        with ThreadPoolExecutor(FUND_WORKERS) as pool:
            list(pool.map(one, todo))

    def snapshot(self):
        snap = self._snapshot
        if snap is None:
            snap = self._snapshot = self._build()
        return {**snap, "progress": {k: v for k, v in self.progress.items() if k != "errors"},
                "errors": len(self.progress["errors"]), "updated": self.updated}

    def _build(self):
        try:
            stocks = constituents(self.data_dir)
        except Exception:
            return {"stocks": []}
        sh = shares(self.data_dir)
        by_cik = {}
        for s in stocks:
            by_cik.setdefault(s["cik"], []).append(s["sym"])
        out, last_day, bars_of = [], None, {}
        for s in stocks:
            bars = bars_of[s["sym"]] = load_prices(self.data_dir, s["sym"])
            if not bars or len(bars) < 2:
                continue
            price = bars[-1][1]
            n, company_wide = shares_for(sh, s["cik"], s["sym"])
            # Share classes of one company (GOOGL/GOOG, FOXA/FOX…) share one CIK, and the diluted average
            # counts every class: split that company's cap evenly between its listed classes.
            classes = len(by_cik.get(s["cik"], [])) if company_wide else 1
            cap = price * n / classes if n else None
            approx = cap is None and s["sym"] in APPROX_SHARES
            if approx:
                cap = price * APPROX_SHARES[s["sym"]]
            out.append({"sym": s["sym"], "name": s["name"], "idx": s.get("idx", "500"), "sector": s["sector"],
                        "industry": s["industry"], "price": price, "date": bars[-1][0], "cap": cap, "approx": approx,
                        "ret": returns(bars)})
            last_day = max(last_day or "", bars[-1][0])
        # A company with no SEC share count still gets a building, at the median size of its own index
        # (so a small cap missing data isn't drawn like a large cap).
        median = {}
        for idx in INDEXES:
            caps = sorted(x["cap"] for x in out if x["cap"] and x["idx"] == idx)
            median[idx] = caps[len(caps) // 2] if caps else 1.0
        for x in out:
            x["cap_estimated"] = x.pop("approx") or x["cap"] is None
            x["cap"] = x["cap"] or median[x["idx"]]
        # Value the whole company (all share classes) once, then express it per share of each ticker.
        cik_of = {s["sym"]: s["cik"] for s in stocks}
        company_cap = {}
        for x in out:
            company_cap[cik_of[x["sym"]]] = company_cap.get(cik_of[x["sym"]], 0) + x["cap"]
        rpo = valuation.backlog(self.data_dir)  # contracted backlog per company (SEC frames, cached daily)
        for x in out:
            cik = cik_of[x["sym"]]
            if x["cap_estimated"] and x["sector"] not in valuation.NOT_VALUED:
                x["val"] = {"label": "n/a", "why": "market cap is estimated, so the DCF can't be compared with it"}
                continue
            fund = valuation.load(self.data_dir, cik) if cik else None
            try:
                x["val"] = valuation.value(fund, x["price"], company_cap[cik], x["sector"], last_day, rpo.get(str(cik)))
            except Exception as e:  # one odd filing must not break the city
                x["val"] = {"label": "n/a", "why": f"valuation failed: {e}"}
            self.history[x["sym"]] = x["val"].pop("history", [])
        # Famous investors' and institutions' positions and whether they're adding or trimming (latest two 13F
        # filings). The page groups and counts them, so each stock just carries its rows.
        inv = investors.load(self.data_dir) if self.sec_agent else None
        by_sym = inv["by_sym"] if inv else {}
        managers = {i["key"]: i for i in inv["investors"]} if inv else {}
        for x in out:
            rows = by_sym.get(x["sym"], [])
            if rows:
                x["inv"] = {"rows": investors.adjust_splits(rows, managers, bars_of[x["sym"]])}
        self.inv_timeline = inv.get("timeline", {}) if inv else {}
        investors_info = {"list": inv["investors"] if inv else [], "enabled": bool(self.sec_agent)}
        index_counts = {idx: sum(x["idx"] == idx for x in out) for idx in INDEXES}
        return {"stocks": out, "as_of": last_day, "investors": investors_info, "index_counts": index_counts}

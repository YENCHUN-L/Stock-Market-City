"""Stdlib-only Taiwan stock data for the market city: TWSE (上市) and TPEx (上櫃) companies.

- companies:  TWSE / TPEx OpenAPI company profiles: code, Chinese/English short name, industry, shares
- prices:     Yahoo Finance daily closes for the last 3 years (CODE.TW / CODE.TWO), one cached file per stock
- market cap: last close x issued common shares
- valuation:  growth-aware DCF from Yahoo Finance fundamentals (see valuation.py)
- 三大法人:   daily net buying by foreign investors, investment trusts and dealers (see institutional.py)
"""
import json
import os
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import institutional
import valuation

COMPANIES_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
TPEX_COMPANIES_URL = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"
# 月營收: every company's latest monthly revenue, one list per exchange.
MONTHLY_URLS = ["https://openapi.twse.com.tw/v1/opendata/t187ap05_L", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O"]
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}{suffix}?range=3y&interval=1d"
SUFFIX = {"TWSE": ".TW", "TPEx": ".TWO"}  # Yahoo ticker suffix per exchange
EXCHANGES = ["TWSE", "TPEx"]
UA = "Mozilla/5.0 (X11; Linux x86_64) StockBS/1.0"
COMPANIES_MAX_AGE = 7 * 24 * 3600
WORKERS = 6
PERIODS = {"1d": 1, "1w": 5, "1m": 21, "3m": 63, "1y": 252}  # bars back; YTD handled apart
PRICE_DIR = "prices3y"
# TWSE industry codes (產業別) used in the company profiles.
INDUSTRIES = {
    "01": "水泥工業", "02": "食品工業", "03": "塑膠工業", "04": "紡織纖維", "05": "電機機械", "06": "電器電纜",
    "08": "玻璃陶瓷", "09": "造紙工業", "10": "鋼鐵工業", "11": "橡膠工業", "12": "汽車工業", "14": "建材營造",
    "15": "航運業", "16": "觀光餐旅", "17": "金融保險業", "18": "貿易百貨", "20": "其他業", "21": "化學工業",
    "22": "生技醫療業", "23": "油電燃氣業", "24": "半導體業", "25": "電腦及週邊設備業", "26": "光電業",
    "27": "通信網路業", "28": "電子零組件業", "29": "電子通路業", "30": "資訊服務業", "31": "其他電子業",
    "32": "文化創意業", "33": "農業科技業", "35": "綠能環保", "36": "數位雲端", "37": "運動休閒", "38": "居家生活",
    "91": "存託憑證",
}


def _get(url, as_json=True):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp) if as_json else resp.read()


def _fresh(path, max_age):
    return os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age


def _write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


# ---------- companies ----------
def _company(code, name, name_en, full, ind, shares, listed, ex):
    shares = (shares or "").replace(",", "").strip()
    return {"sym": code, "name": name or code, "name_en": name_en, "full_name": full, "idx": ex,
            "sector": INDUSTRIES.get(ind, f"產業 {ind}"), "industry": INDUSTRIES.get(ind, ind),
            "shares": int(shares) if shares.isdigit() else None, "listed": listed}


def companies(data_dir):
    """All TWSE-listed (上市) and TPEx-listed (上櫃) companies, tagged with idx = exchange.
    A failed or odd-looking refresh keeps the cached list."""
    path = os.path.join(data_dir, "companies_tw_tpex.json")
    if not _fresh(path, COMPANIES_MAX_AGE):
        try:
            out = [_company(r.get("公司代號", "").strip(), r.get("公司簡稱", "").strip(), r.get("英文簡稱", "").strip(),
                            r.get("公司名稱", "").strip(), r.get("產業別", "").strip(),
                            r.get("已發行普通股數或TDR原股發行股數"), r.get("上市日期", "").strip(), "TWSE")
                   for r in _get(COMPANIES_URL) if r.get("公司代號", "").strip()]
            n_twse = len(out)
            out += [_company(r.get("SecuritiesCompanyCode", "").strip(), r.get("CompanyAbbreviation", "").strip(),
                             r.get("Symbol", "").replace("\u3000", " ").strip(), r.get("CompanyName", "").strip(),
                             r.get("SecuritiesIndustryCode", "").strip(), r.get("IssueShares"),
                             r.get("DateOfListing", "").strip(), "TPEx")
                    for r in _get(TPEX_COMPANIES_URL) if r.get("SecuritiesCompanyCode", "").strip()]
            if n_twse < 800 or len(out) - n_twse < 600:
                raise ValueError(f"company lists look wrong ({n_twse} TWSE, {len(out) - n_twse} TPEx)")
            _write(path, out)
        except Exception as e:
            if not os.path.exists(path):
                raise
            print(f"[companies] refresh failed, keeping the cached list: {e}", flush=True)
    with open(path) as f:
        return json.load(f)


def _float(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def monthly_revenue(data_dir):
    """code -> latest 月營收: {month, rev, yoy, ytd, mom, note}. One request for every company, cached for a day."""
    path = os.path.join(data_dir, "monthly.json")
    if not _fresh(path, 24 * 3600):
        try:
            out = {}
            for r in (row for url in MONTHLY_URLS for row in _get(url)):
                ym = r.get("資料年月", "").strip()  # ROC year + month, e.g. 11509 = 2026-09
                if len(ym) < 4:
                    continue
                out[r["公司代號"].strip()] = {
                    "month": f"{int(ym[:-2]) + 1911}-{ym[-2:]}", "rev": _float(r.get("營業收入-當月營收")),
                    "yoy": _float(r.get("營業收入-去年同月增減(%)")), "mom": _float(r.get("營業收入-上月比較增減(%)")),
                    "ytd": _float(r.get("累計營業收入-前期比較增減(%)")), "note": (r.get("備註") or "").strip()}
            if out:
                _write(path, out)
        except Exception as e:
            print(f"[monthly] refresh failed: {e}", flush=True)
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


# ---------- prices ----------
def price_path(data_dir, sym):
    return os.path.join(data_dir, PRICE_DIR, f"{sym}.json")


def fetch_prices(data_dir, sym, ex="TWSE"):
    res = _get(CHART_URL.format(sym=urllib.request.quote(sym), suffix=SUFFIX[ex]))["chart"]["result"][0]
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
    """Keeps the Taiwan (TWSE + TPEx) snapshot up to date in a background thread."""

    def __init__(self, data_dir, price_max_age):
        self.data_dir, self.price_max_age = data_dir, price_max_age
        for sub in (PRICE_DIR, "fund", "t86"):
            os.makedirs(os.path.join(data_dir, sub), exist_ok=True)
        self.lock = threading.Lock()
        self.progress = {"done": 0, "total": 0, "running": False, "errors": {}, "fund_done": 0, "fund_total": 0,
                         "inv_done": 0, "inv_total": institutional.DAYS}
        self.updated = None
        self._snapshot = None
        self.history = {}      # sym -> fair-value trend, served with the price history
        self.inst_series = {}  # sym -> daily 三大法人 net shares, also served with the price history

    def refresh(self, force=False):
        with self.lock:
            if self.progress["running"]:
                return
            self.progress.update(running=True, done=0, errors={})
        try:
            stocks = companies(self.data_dir)
            self.progress["total"] = len(stocks)

            def one(s):
                p = price_path(self.data_dir, s["sym"])
                try:
                    if force or not _fresh(p, self.price_max_age):
                        fetch_prices(self.data_dir, s["sym"], s.get("idx", "TWSE"))
                        time.sleep(0.1)
                except Exception as e:
                    self.progress["errors"][s["sym"]] = str(e)
                self.progress["done"] += 1
                if self.progress["done"] % 50 == 0:
                    self._snapshot = None  # let the page show the city filling in

            with ThreadPoolExecutor(WORKERS) as pool:
                list(pool.map(one, stocks))
            self.updated = datetime.now(timezone.utc).isoformat(timespec="seconds")
            self._snapshot = None
            # Fundamentals: one Yahoo request per company (cached, refreshed weekly). Financials aren't valued.
            try:
                valued = [(s["sym"], SUFFIX[s.get("idx", "TWSE")]) for s in stocks if s["sector"] not in valuation.NOT_VALUED]
                valuation.refresh(self.data_dir, valued, progress=lambda d, t: self.progress.update(fund_done=d, fund_total=t))
            except Exception as e:
                print(f"[fundamentals] failed: {e}", flush=True)
            self._snapshot = None
            try:
                institutional.refresh(self.data_dir, progress=lambda n: self.progress.update(inv_done=n))
            except Exception as e:
                print(f"[t86] failed: {e}", flush=True)
            self.progress["inv_done"] = self.progress["inv_total"]
        finally:
            self._snapshot = None
            self.progress["running"] = False

    def snapshot(self):
        snap = self._snapshot
        if snap is None:
            snap = self._snapshot = self._build()
        return {**snap, "progress": {k: v for k, v in self.progress.items() if k != "errors"},
                "errors": len(self.progress["errors"]), "updated": self.updated}

    def _build(self):
        try:
            stocks = companies(self.data_dir)
        except Exception:
            return {"stocks": []}
        all_bars = {s["sym"]: load_prices(self.data_dir, s["sym"]) for s in stocks}
        # Yahoo sometimes adds a bar for a day TWSE didn't trade (a holiday or typhoon day) that just repeats the
        # previous close. If nearly every stock is unchanged on the latest date, drop that date everywhere.
        latest = max((b[-1][0] for b in all_bars.values() if b and len(b) > 1), default=None)
        on_latest = [b for b in all_bars.values() if b and len(b) > 1 and b[-1][0] == latest]
        if len(on_latest) > 100 and sum(b[-1][1] == b[-2][1] for b in on_latest) > 0.9 * len(on_latest):
            for b in on_latest:
                b.pop()
        out, last_day = [], None
        for s in stocks:
            bars = all_bars[s["sym"]]
            if not bars or len(bars) < 2:
                continue
            price = bars[-1][1]
            out.append({"sym": s["sym"], "name": s["name"], "name_en": s["name_en"], "idx": s.get("idx", "TWSE"), "sector": s["sector"],
                        "industry": s["industry"], "price": price, "date": bars[-1][0],
                        "cap": price * s["shares"] if s["shares"] else None, "shares": s["shares"], "ret": returns(bars)})
            last_day = max(last_day or "", bars[-1][0])
        caps = sorted(x["cap"] for x in out if x["cap"])
        median = caps[len(caps) // 2] if caps else 1.0
        for x in out:
            x["cap_estimated"] = x["cap"] is None
            x["cap"] = x["cap"] or median
        monthly = monthly_revenue(self.data_dir)
        for x in out:
            x["monthly"] = monthly.get(x["sym"])
            try:
                x["val"] = (valuation.value(valuation.load(self.data_dir, x["sym"]), x["price"], x["cap"], x["sector"], last_day,
                                            x["monthly"])
                            if not x["cap_estimated"] else {"label": "n/a", "why": "share count unknown"})
            except Exception as e:  # one odd statement must not break the city
                x["val"] = {"label": "n/a", "why": f"valuation failed: {e}"}
            self.history[x["sym"]] = x["val"].pop("history", [])
        # 三大法人: net shares bought per window and buying/selling streaks, per group.
        inst = institutional.load(self.data_dir)
        self.inst_series = {}
        if inst:
            for x in out:
                summ = institutional.summarize(inst, x["sym"])
                if summ:
                    x["inst"] = summ
                    self.inst_series[x["sym"]] = institutional.series(inst, x["sym"])
        return {"stocks": out, "as_of": last_day,
                "inst": {"first": inst["days"][0] if inst else None, "last": inst["days"][-1] if inst else None,
                         "count": len(inst["days"]) if inst else 0, "groups": institutional.GROUPS,
                         "windows": list(institutional.WINDOWS)}}

"""Stdlib-only 三大法人 (institutional investors) tracker for TWSE (上市) and TPEx (上櫃) stocks.

TWSE and TPEx publish, every trading day, how many shares of each stock were net bought by:
- 外資 foreign investors (外陸資 + 外資自營商),
- 投信 domestic investment trusts (mutual funds),
- 自營商 securities dealers (own trading + hedging).

One request per exchange returns every stock for one day (TWSE T86, TPEx dailyTrade), so the last DAYS trading
days are fetched once, cached per day, and only new days are fetched afterwards. Both exchanges throttle rapid
requests, so they're spaced out.
"""
import json
import os
import time
import urllib.request
from datetime import date, datetime, timedelta

URL = "https://www.twse.com.tw/rwd/zh/fund/T86?date={d}&selectType=ALLBUT0999&response=json"
TPEX_URL = "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date={y}/{m}/{d}&response=json"
# TPEx rows: code, name, then (buy, sell, net) per group; the nets used are 外資及陸資合計, 投信 and 自營商合計.
TPEX_NET_COLS = [10, 13, 22]
UA = "Mozilla/5.0 (X11; Linux x86_64) StockBS/1.0"
DAYS = 60                 # trading days kept
PAUSE = 3.0               # seconds between requests (TWSE blocks bursts)
GROUPS = [{"key": "foreign", "name": "外資", "en": "Foreign investors"},
          {"key": "trust", "name": "投信", "en": "Investment trusts"},
          {"key": "dealer", "name": "自營商", "en": "Dealers"}]
WINDOWS = {"1d": 1, "5d": 5, "20d": 20, "60d": 60}
COLS = {"foreign": ["外陸資買賣超股數(不含外資自營商)", "外資自營商買賣超股數"],
        "trust": ["投信買賣超股數"], "dealer": ["自營商買賣超股數"]}


def _num(s):
    s = (s or "").replace(",", "").strip()
    return int(s) if s.lstrip("-").isdigit() else 0


def _day_path(data_dir, d):
    return os.path.join(data_dir, "t86", f"{d}.json")


def fetch_day(d):
    """{code: [foreign, trust, dealer]} net shares for one trading day, or None if TWSE has no data (holiday)."""
    req = urllib.request.Request(URL.format(d=d), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.load(resp)
    if res.get("stat") != "OK" or not res.get("data"):
        return None
    idx = {f: i for i, f in enumerate(res["fields"])}
    out = {}
    for row in res["data"]:
        code = row[idx["證券代號"]].strip()
        out[code] = [sum(_num(row[idx[c]]) for c in COLS[g["key"]] if c in idx) for g in GROUPS]
    return out


def fetch_tpex_day(d):
    """Same as fetch_day, for TPEx (上櫃) stocks."""
    req = urllib.request.Request(TPEX_URL.format(y=d[:4], m=d[4:6], d=d[6:]), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.load(resp)
    table = (res.get("tables") or [{}])[0]
    rows = table.get("data") or []
    if not rows or len(table.get("fields") or []) < 24:
        return None
    return {r[0].strip(): [_num(r[i]) for i in TPEX_NET_COLS] for r in rows}


def _cached(path, fetch, d):
    """(ok, data): the day's cached data, fetching and caching it first if needed. None data = no trading."""
    if os.path.exists(path):
        with open(path) as f:
            return True, json.load(f)
    try:
        data = fetch(d)
    except Exception as e:
        print(f"[3insti] {os.path.basename(path)}: {e}", flush=True)
        time.sleep(PAUSE * 3)
        return False, None
    with open(path, "w") as f:
        json.dump(data, f)  # None marks a holiday, so it isn't asked for again
    time.sleep(PAUSE)
    return True, data


def refresh(data_dir, progress=None):
    """Make sure the last DAYS trading days are cached, newest first, then rebuild summary.json."""
    folder = os.path.join(data_dir, "t86")
    os.makedirs(folder, exist_ok=True)
    now = datetime.now()
    # Today's figures appear in the evening; until then start from yesterday.
    day = now.date() if now.hour >= 17 else now.date() - timedelta(days=1)
    have, checked = [], 0
    while len(have) < DAYS and checked < DAYS * 2 + 30:
        checked += 1
        d = day.strftime("%Y%m%d")
        day -= timedelta(days=1)
        if date.fromisoformat(f"{d[:4]}-{d[4:6]}-{d[6:]}").weekday() >= 5:
            continue
        ok, data = _cached(_day_path(data_dir, d), fetch_day, d)  # TWSE decides whether it was a trading day
        if not ok or data is None:
            continue
        _cached(os.path.join(folder, f"tpex_{d}.json"), fetch_tpex_day, d)
        have.append(d)
        if progress:
            progress(len(have))
    days = sorted(have)
    by_day = {}
    for d in days:
        with open(_day_path(data_dir, d)) as f:
            by_day[d] = json.load(f)
        tpex = os.path.join(folder, f"tpex_{d}.json")
        if os.path.exists(tpex):
            with open(tpex) as f:
                by_day[d].update(json.load(f) or {})
    codes = sorted({c for v in by_day.values() for c in v})
    summary = {"days": [f"{d[:4]}-{d[4:6]}-{d[6:]}" for d in days],
               "by_code": {c: [by_day[d].get(c, [0, 0, 0]) for d in days] for c in codes},
               "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    tmp = os.path.join(folder, "summary.json.tmp")
    with open(tmp, "w") as f:
        json.dump(summary, f)
    os.replace(tmp, os.path.join(folder, "summary.json"))
    return summary


def load(data_dir):
    try:
        with open(os.path.join(data_dir, "t86", "summary.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def summarize(inst, code):
    """Net shares per window [foreign, trust, dealer], and each group's current buying (+) / selling (-) streak."""
    rows = inst["by_code"].get(code)
    if not rows:
        return None
    w = {k: [sum(r[g] for r in rows[-n:]) for g in range(len(GROUPS))] for k, n in WINDOWS.items()}
    streak = []
    for g in range(len(GROUPS)):
        n, sign = 0, 0
        for r in reversed(rows):
            s = (r[g] > 0) - (r[g] < 0)
            if s == 0 or (sign and s != sign):
                break
            sign, n = s, n + 1
        streak.append(sign * n)
    return {"w": w, "streak": streak}


def series(inst, code):
    """Daily net shares per group for the side-panel chart: {days, rows}."""
    rows = inst["by_code"].get(code)
    return {"days": inst["days"], "rows": rows} if rows else None

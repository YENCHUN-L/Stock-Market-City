# 台股 Market City (TWSE 上市 + TPEx 上櫃)

A 3D city of every Taiwan-listed company in three.js: about 1,100 on the Taiwan Stock Exchange (上市) and about 900
on the Taipei Exchange (上櫃, TPEx). It is the same app as the US city in `../us`, adapted to Taiwan's data.

**Exchange toggle** `[上市] [上櫃] [All]` in the header: each exchange turns on and off on its own, and **All**
shows both (`?index=TPEx`, `?index=all`). The summary, legend, lists and flow follow it. The tooltip and side
panel show each stock's exchange.

| What you see | What it means |
|---|---|
| Footprint (area) | √ market cap by default; switch to market cap or equal size |
| Height | Size of the return over the selected period (1D…1Y) |
| Color | Red ← grey → green by return |
| Districts | TWSE industries (產業別): 半導體業, 電子零組件業, 金融保險業 … |
| Roof labels | Chinese short names (台積電, 鴻海 …); hover or search shows code + English name |

## Run

```bash
cd twse
python3 server.py                 # http://127.0.0.1:8001
python3 server.py --port 9001 --interval 3600
```

No third-party Python packages are needed (stdlib only). The first start takes about 5 minutes, then
everything comes from the cache in `data/`:

| Data | Source | First start | Then |
|---|---|---|---|
| Companies, industries, shares | TWSE OpenAPI `t187ap03_L` + TPEx OpenAPI `mopsfin_t187ap03_O` | 2 requests | weekly |
| 月營收 | TWSE `t187ap05_L` + TPEx `mopsfin_t187ap05_O` | 2 requests | daily |
| Prices (3 years) | Yahoo Finance `CODE.TW` / `CODE.TWO` | ~2 min | every 3 h |
| Fundamentals | Yahoo Finance fundamentals timeseries | ~2 min | weekly |
| 三大法人 (60 trading days) | TWSE `T86` + TPEx `dailyTrade` | ~6–8 min (both throttle bursts) | new days only |

## 🏦 三大法人 view

TWSE's daily net buying by **外資** (foreign investors, incl. foreign dealers), **投信** (investment trusts) and
**自營商** (dealers), for every listed stock. This replaces the US city's 13F view, and it's more timely:
daily, not quarterly.

- Chips under the header pick the group (合計 / 外資 / 投信 / 自營商).
- The **period buttons** set the window: 1D → 1 day, 1W → 5 days, 1M → 20 days, and 3M / YTD / 1Y → 60 days, the
  most data kept. A label next to the chips shows the window in effect.
- The 150 stocks with the biggest net buying or selling light up. Beam color shows the direction, and beam
  height the amount (net shares × today's price).
- **買超 / 賣超** lists rank net buys and sells. Each row shows the value, its % of shares outstanding, and
  streaks like 外資連買5日.
- **Side panel:** a table by group × window, streaks, and a 60-day stacked bar chart of daily net buying.
- **⇄ Flow → 三大法人:** arcs show which industries 三大法人 are moving money into and out of.
- **★ + 🏦:** ◆ and cyan beams mark stocks that are highly undervalued *and* being net bought.

## ★ Valuation

The same growth-aware DCF as the US city, fed by Yahoo fundamentals: 5 quarters plus 4 fiscal years of
revenue, operating income, free cash flow, interest, debt and cash. The definition of "highly undervalued"
is the same: price below the pessimistic DCF, at least 30% upside, price assumes less growth than the fading
path, and the quality checks pass.

Taiwan-specific choices:

- **Earnings power = the lower of** the free-cash-flow margin and the after-tax operating margin (20% tax),
  not their average. Under IFRS 16, lease payments leave operating cash flow, which inflates free cash flow
  for airlines, restaurants, hotels and retailers.
- **1-year growth comes from 月營收** (monthly revenue, TWSE OpenAPI `t187ap05_L`, published by the 10th of
  each month). Its year-to-date growth replaces the older fiscal-year/quarter figures, so growth reflects
  orders already turning into sales. The side panel shows the latest month's YoY, YTD and the company's note.
- **Starting growth is at most the latest 1-year growth + 10 points**, so post-COVID rebounds in the 3-year
  rate aren't projected forward.
- **Not valued:**
  - 金融保險業 (banks and insurers);
  - 建材營造 (developers' cash flow swings with pre-sales and land purchases);
  - 存託憑證 (TDRs);
  - companies with negative operating margins.
- **Upside over 300%** is treated as a probable data quirk, never ★.
- The fair-value trend has annual steps (one per fiscal year, plus today), because Yahoo gives only 5
  quarters.

Not investment advice.

## Why these sources

MOPS (公開資訊觀測站) is slow, has no bulk cash-flow data, and its new site blocks scripts. Goodinfo has no
API, sits behind anti-bot checks, and forbids scraping. FinMind's free tier allows ~300 requests an hour,
too few for 1,100 stocks. Yahoo fundamentals return everything per stock in about 0.1 s. TWSE's own T86 is
the only free source that covers every stock's 三大法人 data in one request per day.

# S&P 1500 Market City

A 3D city of the S&P 1500 in three.js: the S&P 500 (large caps) + MidCap 400 + SmallCap 600, about 1,500
stocks and roughly 90% of US market value. Each company is a building:

| What you see | What it means |
|---|---|
| Footprint (area) | √ market cap by default; switch to market cap or equal size (squarified treemap: sector → company) |
| Height | Size of the return over the selected period (square-root scaled) |
| Color | Red ← grey → green by return; saturates at ±3% (1D), ±6% (1W), ±10% (1M), ±20% (3M), ±40% (YTD/1Y) |
| Districts | The 11 GICS sectors |

## Run

```bash
cd us
python3 server.py                 # http://127.0.0.1:8000
python3 server.py --port 9000 --interval 3600   # re-fetch prices every hour (default 3 h)
python3 server.py --sec-agent "Your Name you@example.com"   # enables the 👤 famous-investors view (SEC 13F)
```

No third-party Python packages are needed (stdlib only). The page loads three.js 0.160 from unpkg.

The first start downloads a lot. The page shows a progress bar and redraws as data arrives; after that
everything comes from the cache in `data/`.

| Data | First start | Then |
|---|---|---|
| Prices (~1,500 tickers) | ~3–4 min | every 3 h |
| SEC filings (~1,150 companies) | ~15 min, ~3 GB | weekly |
| 13F filings | ~5 min | daily check |

## Index and size

- **Index** `[500] [400] [600] [All]`: each index toggles on and off, and **All** turns on all three.
  - Combinations get their real names: 500+400 = S&P 900, 400+600 = S&P 1000, all three = S&P 1500.
  - Set it in the URL with `?index=500,400` or `?index=all`.
  - The summary, legend, ★ and 👤 counts follow it.
- **Size by** `[Cap] [√Cap] [Equal]` (`?size=cap`) sets the building footprints:
  - **Cap** keeps true proportions, but a small cap is about 1/2000th of NVDA and nearly invisible.
  - **√Cap** (the default) keeps big companies bigger while every small cap stays clickable.
  - **Equal** gives every company the same plot.
- Cap-weighted returns always use real market cap, whatever the size mode.
- The city, camera and shadows scale with the number of stocks shown.
- Each stock's index (large, mid or small cap) appears in the tooltip and side panel.

## How to view it

- **Start with 1D in 3D.** Look for districts that are mostly one color; that's a sector move. Big
  footprints with red or green show what drove the index. Tall towers on small plots are single-stock
  stories, such as earnings.
- **Switch periods** (1D → 1Y). Buildings animate to the new returns, so leaders and laggards over
  different horizons stand out.
- **Flat** gives a top-down heat map, the quickest read of the whole market.
- **Click a sector** in the legend to isolate it and fly there. Click a building for a 1-year
  sparkline and its returns for every period. Use **Fly to ticker** to search. **Esc** resets the view.
- Mouse: drag to orbit, right-drag to pan, wheel to zoom.

## ⇄ Sector flow

Press **⇄ Flow** (or open `/?view=flow`) to animate where value is moving between sectors.

- **Arcs** run from losing districts to gaining ones. Particles stream along them, red at the source turning
  green at the destination, and bigger flows get thicker arcs and more, faster particles. The largest arcs
  carry a dollar label.
- **District pulses:** each district pulses green or red, stronger for bigger moves.
- **Panel:** lists every sector's net change and the top flows. Click a row to isolate a sector, which shows
  only its flows.

There are three sources, switched in the header (`?flow=investors`, `?flow=institutions`):

| Source | What it measures |
|---|---|
| **Market** | Each sector's change in market value over the selected period (1D…1Y), **relative to the whole market**, so flows balance. The market's own move is shown separately. Each laggard's shortfall is split across the leaders in proportion. |
| **Investors** | Dollars the 10 tracked investors added or trimmed per sector between their last two 13F filings, at quarter-end prices. An investor chip narrows it to one investor. Net buying or selling is shown; the arcs cover the matched part. |
| **Institutions** | The 8 giant institutions (see 🏛 below), over the period's window. Index funds buy every sector at once as money flows in, so (like Market) each sector is shown **relative to their overall buying**, in proportion to what they hold; the arcs show where they tilted, and the panel gives the overall net buying. |

The arcs show rotation between sectors, not traced trades. Nobody can see which seller's money went to which buyer.

## ★ Undervalued view

Press **★ Undervalued** (or open `/?view=undervalued`). Highly undervalued companies turn gold with
a light beam on the roof, everything else dims, and a ranked list (bottom right) flies to each one.
Click any building to see its full valuation in the side panel, including *why* it is or isn't
flagged.

`valuation.py` values each company from its quarterly SEC filings with a **growth-aware DCF**:

- **Earnings power** = TTM revenue × the average of the free-cash-flow margin and the after-tax
  operating margin after interest (21% tax), both over the last 12 quarters. Interest is deducted
  because the DCF is compared with the market cap (equity); otherwise indebted firms look cheap. FCF alone punishes heavy investment
  years; operating profit alone ignores capex.
- **Growth** starts at the mean of 1-year and 3-year revenue growth (capped at 40%), and the part above
  3% halves every 3 years. Then 10 explicit years and 3% growth forever.
- **Discount rate** = 9% for a debt-free company, rising with net debt ÷ market cap (Hamada: 4% risk-free +
  5% premium × (1 + 0.79 × D/E), max 16%), because shareholders of indebted companies take more risk.
  Debt is the larger of the balance-sheet figure and TTM interest ÷ 5% (some companies file debt under
  their own tags); cash includes short-term securities.
- **Fair range** = DCF at that rate + 1 / ± 0 / − 1 point (low / mid / high), scaled to one share of the
  ticker through the market cap.
- **Reverse DCF:** the constant 10-year growth that today's price already assumes.
- **Backlog adjustment (RPO).** Remaining performance obligations are revenue already contracted but not yet
  recognized (SEC frames, cached daily). The adjustment scales with coverage = RPO ÷ TTM revenue:
  - starting growth moves toward backlog growth (RPO vs a year earlier), with weight = min(50%, 0.5 ×
    coverage);
  - growth fades more slowly: half-life 3 years + min(2, coverage) years.
  - Backlog under 10% of revenue is ignored. The 40% growth cap still applies, so huge backlog jumps (AVGO,
    GOOGL) only push growth to the cap.
  - Product sellers like NVDA carry little backlog and are unaffected.
  - Past fair-value points use reported revenue only, so today's point can sit above the trend.

A stock is **highly undervalued** when *all* of these hold:

1. price is below the pessimistic fair value (10% rate);
2. upside to the middle fair value is at least 30% (margin of safety);
3. the price assumes less growth than the fading path;
4. quality checks pass: positive TTM free cash flow, growing revenue, operating margin not down more than
   5 points in a year, a filing from the last ~15 months, and steady growth (1-year growth at most 2× the
   3-year rate + 15 points, so a merger or cycle peak isn't mistaken for growth). These keep
   cheap-but-shrinking companies (value traps) out.

**Fair-value trend.** The side panel chart shows 3 years of price against the fair-value range recomputed at
every past quarter: gold steps, each starting about 45 days after the quarter ended, when its filing comes out.
Each step uses only the filings known then, with today's discount rate and share count, so the line moves
with the business rather than with the inputs. The dashed line is the **average fair value** over those
quarters. The panel also gives the trend as %/yr and the price's distance from the average.

- **Price below both today's fair value and the average** (LULU, BKNG): cheap against the company's own
  history.
- **Price above the average** but below today's value (NVDA, APH): cheap only if the recent fast growth holds.

The ★ list folds by clicking its title, and the side panel shrinks to stay above it. `?focus=NVDA` opens a
stock's panel directly.

**Not valued:**
- Financials and Real Estate, because free-cash-flow DCFs don't fit banks, insurers or REITs.
- Companies with negative cash flow and operating profit.
- Companies whose market cap is estimated.

**Limits:**
- Margins are held flat, so a market expecting margins to expand reads as "overvalued".
- Debt lowers value through interest and a higher discount rate, but isn't subtracted directly;
  captive finance arms (Ford Credit, for example) and leases are left out.
- Valuation gaps tend to close over years, not weeks.
- Not investment advice.

## 👤 Famous investors view

Press **👤 Investors** (or open `/?view=investors`, or `/?view=undervalued,investors` for both views at once).
It shows what 10 famous stock-pickers hold from their quarterly **SEC Form 13F** filings, and whether they
are **adding or trimming** each position:

| Investor | Firm | Investor | Firm |
|---|---|---|---|
| Warren Buffett | Berkshire Hathaway | Li Lu | Himalaya Capital |
| Bill Ackman | Pershing Square | Howard Marks | Oaktree |
| Stanley Druckenmiller | Duquesne Family Office | Terry Smith | Fundsmith |
| David Tepper | Appaloosa | Dan Loeb | Third Point |
| Seth Klarman | Baupost | Chuck Akre | Akre Capital |

- **Direction** is the **share-count** change between each investor's last two filings: ↑ NEW / ↑ added,
  ↓ reduced, ✕ sold out, = unchanged (within ±1%). Share counts aren't distorted by price moves the way
  dollar values are.
- **In the city:**
  - Held stocks stay lit and the rest dim.
  - Beam color is the net direction across investors: green = more adding, red = more trimming,
    white = mixed or unchanged.
  - Beam height is how many of the 10 hold the stock.
  - With ★ Undervalued also on, gold = highly undervalued, and a **cyan beam and ◆** mark stocks that
    are highly undervalued *and* being bought.
- **Chips** under the header show one investor's portfolio. The list then ranks it by share of their
  portfolio and includes positions they sold out of.
- **When they went in:** the side panel chart has one lane per investor under the price.
  - The bar shows when they held the stock; brighter means more shares, so adds and trims are visible too.
  - ▲ marks the quarter they went in and ✕ the quarter they got out, with the same marks as dots on the
    price line.
  - The investor tables say "since Q3 2025", or "before Q4 2023" when the position predates the ~3 years
    (13 quarters) of filings fetched.
  - A 13F only shows quarter-end holdings, so the trade happened sometime during that quarter.
- The **list** (foldable, bottom right) ranks stocks by how many investors hold them. The **side panel**
  lists each holder's move, position value and portfolio weight.

**Data:**
- Filing lists come from `data.sec.gov`; information tables from `www.sec.gov/Archives`, which **requires
  a contact User-Agent**. Start the server with
  `--sec-agent "Your Name you@example.com"` (or set `STOCKBS_SEC_AGENT`); without it this view is off.
- 13F lists CUSIPs, which are mapped to tickers with the free [OpenFIGI](https://www.openfigi.com/api)
  API and cached in `data/cusip_map.json`.
- Filings are cached in `data/13f/` (they never change); the filing lists are re-checked daily.
- Some managers still report values in thousands of dollars; those filings are detected and scaled.

**Limits:**
- 13F is a quarter-end snapshot filed up to 45 days later, so positions may already have changed.
- It covers long US stock positions only: no shorts, options are left out, and non-US holdings are missing.
- Each investor's own report date is shown, because they don't all file at the same time.
- Not investment advice.

## 🏛 Institutions view

Press **🏛 Institutions** (or open `/?view=institutions`). It uses the same 13F data, and also needs
`--sec-agent`, for the 8 biggest asset managers:

| Index-style | Active |
|---|---|
| Vanguard (~$7T) | Fidelity (FMR) |
| BlackRock (~$7T) | Capital Group |
| State Street (~$3T) | T. Rowe Price |
| Norges Bank (Norway's oil fund) | Wellington |

They own a slice of nearly every stock, so "who holds it" says nothing. The view measures **ownership** instead:
shares held ÷ shares outstanding (market cap ÷ price), and how it changed over the selected period, in percentage
points. 13F is quarterly, so the **period buttons** map to filings: 1D–3M = the last quarter, YTD = since the last
year-end filing, 1Y = four quarters.

- **In the city:** the 150 stocks whose combined ownership rose or fell the most light up. Beam color shows
  the direction and beam height the size. With ★ Undervalued also on, a cyan beam and ◆ mark highly undervalued
  stocks they are buying.
- **List** tabs: **Ownership** (who owns the biggest share), **↑ Net buying** and **↓ Net selling**, in points
  and in dollars at quarter-end prices.
- **Chips** narrow the view to one firm. The side panel shows each firm's stake, its change and when the
  position began.
- **When they bought:** with 🏛 on, the side-panel chart has one lane per institution over 3 years. Brighter means
  more shares; ▲ / ▼ mark quarters they added or trimmed 5% or more.
- **⇄ Flow → Institutions** shows their sector flows over the same window.

**How to read it:** index funds buy and sell as money flows into or out of them and as indexes change, so
their moves show where money is going rather than an opinion about a stock. Pick an active manager's chip
(Fidelity, Capital Group, T. Rowe Price or Wellington) to see stock-picking.

**Data notes:**
- **Stock splits:** share counts are converted to today's shares, using each filing's price (value ÷ shares) against
  Yahoo's split-adjusted close. Without this, KLA's 10-for-1 split would read as KLAC buying of +900%. The famous
  investors' figures get the same correction.
- **Amendments** are applied in filing order: "NEW HOLDINGS" amendments add positions to the original (Vanguard
  splits its holdings this way), and restatements replace it. This applies to the famous investors too.
- **Index changes and corporate actions:** an S&P index addition or removal, spin-off, merger, reverse split or
  new listing moves every index fund's share count at once. When Vanguard's and BlackRock's combined shares jump
  more than 25% in a quarter inside the window, the stock is marked "index / corporate event" and left out of the
  buying and selling rankings.
- A CUSIP retired by a corporate action is matched to its issuer's current one.
- Stocks whose ownership comes out above 100% (share-class quirks) show n/a and are left out of the rankings.
- Firms that report through several entities are added together per quarter:
  - Until Q4 2025, Vanguard Group filed one combination report. Since 2026 each entity reports itself: Vanguard
    Portfolio Management, Vanguard Capital Management, Fiduciary Trust, Global Advisers, the UK and Australian arms,
    Vanguard Advisers and National Trust (about $890B outside the two main advisers).
  - BlackRock's filings moved to a new holding company in Q3 2024.
  - Capital Group reports as Capital Research Global, Capital World and Capital International Investors.
- Norges Bank files real holdings only every half-year (the other quarters are empty), so its changes compare
  half-years.
- These filings list about 10,000 securities. CUSIPs are looked up biggest first: positions over $250M, then
  the summary is written, then the rest down to $5M. Without an OpenFIGI key the first run takes roughly
  20–40 minutes (it continues in the background, with a progress bar in the header). Set `OPENFIGI_KEY` to a free [OpenFIGI](https://www.openfigi.com/api)
  API key for about 10× faster lookups.
- Not investment advice.

## Data

`sp500.py` fetches and caches into `data/`:

- **Constituents:** Wikipedia's *List of S&P 500 / 400 / 600 companies* (symbol, name, GICS sector, CIK).
  The 400 list has no CIK column, so those come from SEC's `company_tickers.json`. Re-fetched weekly; a
  failed or odd-looking refresh keeps the cached list.
- **Prices:** Yahoo Finance daily closes for 3 years, one file per ticker in `data/prices3y/`.
- **Market cap:** last close × shares outstanding from SEC EDGAR *frames*, which return every filer
  in one request:
  - The cover-page share count is used first.
  - Then the company-wide diluted average, which covers multi-class companies such as GOOGL/GOOG.
    Their cap is split evenly between the listed classes.
  - A few companies with no usable SEC count (BRK-B, V, HSY, STZ, ERIE, ARES) use approximate
    built-in share counts.
  - Any still missing get the median size.
  - Both fallbacks are marked *(est.)* in the page.
- **Financials for valuation:** each company's SEC `companyfacts`, reduced to about 6 years of
  quarterly revenue, operating income, net income, operating cash flow and capex in
  `data/fund/<CIK>.json`. The first run downloads about 1 GB over a few minutes; after that it
  refreshes weekly.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/market` | All stocks: sector, price, market cap, returns per period, plus load progress |
| GET | `/api/history/<SYMBOL>` | 1 year of daily closes |
| POST | `/api/refresh` | Force a re-fetch of every ticker |

Not investment advice.

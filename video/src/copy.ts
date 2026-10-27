// On-screen copy per market. Figures come from the capture metadata (the same frozen snapshot the footage was
// shot from), so every number on screen matches what the app shows in that frame.
export type Market = 'us' | 'tw';

export type Anchor = { sym: string; name: string; ret: number; cap: number };

const pct = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`;
const usd = (v: number) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : `$${(v / 1e9).toFixed(0)}B`);
const twd = (v: number) => (v >= 1e12 ? `NT$${(v / 1e12).toFixed(1)}兆` : `NT$${(v / 1e8).toFixed(0)}億`);

export const COPY = {
  us: {
    lang: 'en',
    eyebrow: 'S&P 500 + 400 + 600',
    title: ['S&P 1500', 'Market City'],
    subtitle: '1,500 companies. One living city.',
    heroCaption: 'Every building is a company.',
    footprint: (a: Anchor) => ({ head: `${a.sym}  ${usd(a.cap)}`, body: 'Footprint = market cap' }),
    height: (a: Anchor) => ({ head: `${a.sym}  ${pct(a.ret)} · 1Y`, body: 'Height = size of the move' }),
    color: (a: Anchor) => ({ head: `${a.sym}  ${pct(a.ret)}`, body: 'Green up · red down' }),
    periodCaption: 'Switch the period. The whole city re-ranks.',
    periodName: { '1d': '1 DAY', '1w': '1 WEEK', '1m': '1 MONTH', '3m': '3 MONTHS', '1y': '1 YEAR' } as Record<string, string>,
    card1: ['Where is the', 'money moving?'],
    card1Accent: 1,
    flowCaption: 'Sector flow: value rotating between districts',
    flowSub: '1 year · relative to the whole market',
    card2: ['Find what’s', 'undervalued.'],
    card2Accent: 1,
    feat1Caption: 'Growth-aware DCF + quality checks',
    feat1Label: 'highly undervalued',
    feat2Caption: '10 famous investors · SEC 13F',
    feat2Sub: 'Buffett · Ackman · Druckenmiller · Tepper · Klarman …',
    outroTitle: ['S&P 1500', 'Market City'],
    outroTag: 'The whole market, at a glance.',
    outroRun: 'Runs locally  ·  python3 server.py',
    disclaimer: 'Market data as of close 2026-10-23 · Not investment advice',
  },
  tw: {
    lang: 'zh',
    eyebrow: '上市 ＋ 上櫃',
    title: ['台股', 'Market City'],
    subtitle: '近 2,000 家公司，一座城市。',
    heroCaption: '每一棟建築，都是一家公司。',
    footprint: (a: Anchor) => ({ head: `${a.name}  ${twd(a.cap)}`, body: '占地 ＝ 市值' }),
    height: (a: Anchor) => ({ head: `${a.name}  ${pct(a.ret)} · 1年`, body: '高度 ＝ 漲跌幅度' }),
    color: (a: Anchor) => ({ head: `${a.name}  ${pct(a.ret)}`, body: '綠色漲 · 紅色跌' }),
    periodCaption: '切換期間，整座城市即時重排。',
    periodName: { '1d': '1 日', '1w': '1 週', '1m': '1 個月', '3m': '3 個月', '1y': '1 年' } as Record<string, string>,
    card1: ['資金，', '往哪裡流？'],
    card1Accent: 1,
    flowCaption: '產業資金流：看見類股輪動',
    flowSub: '近 1 年 · 相對整體市場',
    card2: ['三大法人，', '買了什麼？'],
    card2Accent: 1,
    feat1Caption: '外資 · 投信 · 自營商｜每日買賣超',
    feat1Label: '',
    feat2Caption: '成長型 DCF ＋ 品質檢查',
    feat2Sub: '',
    outroTitle: ['台股', 'Market City'],
    outroTag: '整個台股，一眼看盡。',
    outroRun: '本機執行  ·  python3 server.py',
    disclaimer: '資料截至 2026-10-22 收盤 · 非投資建議',
  },
};

// "S&P 1500 1 year: +27.89% · 920 up · 578 down · close 2026-10-23" → "+27.89%"
export const summaryReturn = (s?: string) => (s?.match(/:\s*([+−-][\d.]+%)/)?.[1] ?? '').replace('-', '−');
export const formatPct = pct;

// "NT$675.7B" → "NT$6,758億", "+NT$1.2T" → "+NT$1.2兆" (Taiwanese units); other markets pass through.
export const localAmount = (m: Market, s: string) => {
  if (m !== 'tw') return s;
  const r = s.match(/([+−-]?)NT\$([\d.]+)([MBT])/);
  if (!r) return s;
  const v = +r[2] * { M: 1e6, B: 1e9, T: 1e12 }[r[3] as 'M' | 'B' | 'T'];
  const body = v >= 1e12 ? `${(v / 1e12).toFixed(1)}兆` : `${Math.round(v / 1e8).toLocaleString('en-US')}億`;
  return `${r[1]}NT$${body}`;
};

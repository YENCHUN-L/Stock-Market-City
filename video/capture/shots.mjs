// Records every footage clip for one market: node capture/shots.mjs us|tw [shot ...]
// Each clip is a JPEG sequence in public/footage/<market>/<shot>/ plus <shot>.json with per-frame screen
// projections of the anchors the Remotion overlays track (so annotations live in the city's 3D space).
import fs from 'node:fs';
import path from 'node:path';
import { openCity, record, hideUI, tick, lerp, ease } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const TL = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/timeline.json'), 'utf8'));
const beatF = n => Math.round((TL.sourceBeat0 + n * TL.beatInt) * TL.fps);
const shotFrames = k => { const [a, b] = TL.shots[k]; return beatF(b) - (a === 0 ? 0 : beatF(a)); };
const HANDLE = 8;
// Bezier easing (same construction as the shot-card fixtures)
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = t => ((ax * t + bx) * t + cx) * t, sy = t => ((ay * t + by) * t + cy) * t, dx = t => (3 * ax * t + 2 * bx) * t + cx;
  return x => { if (x <= 0) return 0; if (x >= 1) return 1; let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x; if (Math.abs(e) < 1e-6) break; t -= e / (dx(t) || 1e-6); }
    return sy(t); };
}
const CRANE = bezier(0.2, 0, 0.25, 1);     // crane-rise-reveal: fast lift-off, soft top-out
const SMOOTH = bezier(0.65, 0, 0.35, 1);
const ramp = (i, a, d, e = SMOOTH) => e(Math.min(1, Math.max(0, (i - a) / d)));

const MARKETS = {
  us: { port: 8000, flagship: 'NVDA', near: 110,
        openA: { tx: -176, ty: 5, tz: -101, dist: 70, az: -50, el: 30 },
        wide: { tx: 4, ty: 0, tz: 8, dist: 360, az: 0, el: 40 },
        heroA: { tx: -176, ty: 4, tz: -55, dist: 100, az: -140, el: 20 }, heroB: { tx: -176, ty: 4, tz: -55, dist: 92, az: -118, el: 24 } },
  tw: { port: 8001, flagship: '2330', near: 170,
        openA: { tx: -173, ty: 8, tz: -118, dist: 105, az: -130, el: 32 },
        wide: { tx: 5, ty: 0, tz: 10, dist: 470, az: 0, el: 40 },
        heroA: { tx: -140, ty: 6, tz: -112, dist: 150, az: -140, el: 24 }, heroB: { tx: -140, ty: 6, tz: -112, dist: 138, az: -116, el: 28 } },
};
const market = process.argv[2];
const only = process.argv.slice(3);
const M = MARKETS[market];
const OUT = path.join(ROOT, 'public/footage', market);

const { browser, page } = await openCity({ market, port: M.port });
await page.evaluate(() => { window.__sc.controls.enableDamping = false; });

// --- page helpers -------------------------------------------------------------------------------------------
const click = sel => page.$eval(sel, el => el.click());
const period = p => click(`#periods button[data-p="${p}"]`);
async function cam(c) {
  await page.evaluate(c => {
    const { camera, controls, setFlight } = window.__sc;
    setFlight(null);
    const a = c.az * Math.PI / 180, e = c.el * Math.PI / 180;
    controls.target.set(c.tx, c.ty, c.tz);
    camera.position.set(c.tx + c.dist * Math.cos(e) * Math.sin(a), c.ty + c.dist * Math.sin(e), c.tz + c.dist * Math.cos(e) * Math.cos(a));
    camera.lookAt(c.tx, c.ty, c.tz);
  }, c);
}
const camMix = (A, B, t) => ({ tx: lerp(A.tx, B.tx, t), ty: lerp(A.ty, B.ty, t), tz: lerp(A.tz, B.tz, t),
  az: lerp(A.az, B.az, t), el: lerp(A.el, B.el, t), dist: Math.exp(lerp(Math.log(A.dist), Math.log(B.dist), t)) });
// Screen positions (CSS px) of world points, written per frame for overlay tracking.
async function project(points) {
  return page.evaluate(points => {
    const { THREE, camera } = window.__sc; const v = new THREE.Vector3(); const out = {};
    camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    for (const [k, p] of Object.entries(points)) {
      v.set(p[0], p[1], p[2]).project(camera);
      out[k] = [+((v.x + 1) / 2 * innerWidth).toFixed(1), +((1 - v.y) / 2 * innerHeight).toFixed(1), v.z < 1 ? 1 : 0];
    }
    return out;
  }, points);
}
const plot = sym => page.evaluate(sym => { const p = window.__sc.city.bySym.get(sym);
  return p && { sym, name: p.stock.name, cx: p.cx, cz: p.cz, bw: p.bw, bd: p.bd, h: p.hTo ?? p.hNow, ret: p.stock.ret, cap: p.stock.cap }; }, sym);
const home = () => page.evaluate(() => { const { camera, controls } = window.__sc;
  const t = controls.target, d = camera.position.distanceTo(t);
  return { tx: t.x, ty: t.y, tz: t.z, dist: d, az: 0, el: Math.asin((camera.position.y - t.y) / d) * 180 / Math.PI }; });
const sectorCenters = () => page.evaluate(() => Object.fromEntries(window.__sc.city.sectors.map(s => [s.name, [s.center.x ?? s.center[0], 0, s.center.z ?? s.center.y ?? s.center[1]]])));
const text = sel => page.$eval(sel, el => el.innerText);
const writeMeta = (shot, meta) => fs.writeFileSync(path.join(OUT, `${shot}.json`), JSON.stringify(meta));

const HOME = await home();
const meta = {};

// --- shots --------------------------------------------------------------------------------------------------
const SHOTS = {
  // crane-rise-reveal in 3D: hold on the flagship's roof label, then a decelerating crane up to the whole city.
  async open() {
    await hideUI(page); await period('1y'); await tick(page, 40);
    const f = await plot(M.flagship);
    const A = M.openA, B = M.wide;
    const N = shotFrames('open') + HANDLE, HOLD = 44, RISE = 128;
    const frames = [];
    await record(page, path.join(OUT, 'open'), N, async i => {
      const p = CRANE(Math.min(1, Math.max(0, (i - HOLD) / RISE)));
      const pre = 1 - 0.03 * ramp(i, 0, HOLD);                  // "breathe in": a 3% push during the hold
      const c = camMix(A, B, p); c.dist *= i < HOLD ? pre : lerp(0.97, 1, Math.min(1, p * 3));
      await cam(c);
      frames.push(await project({ roof: [f.cx, f.h + 1.5, f.cz] }));
    });
    writeMeta('open', { flagship: f, frames, summary: await text('#summary') });
  },

  // Hero orbit around the giants' row; anchors for footprint / height / color annotations.
  async hero() {
    await hideUI(page); await period('1y'); await tick(page, 40);
    const f = await plot(M.flagship);
    // Neighbours within reach of the flagship: the tallest (height) and the most negative (color).
    const near = await page.evaluate(([x, z, R]) => window.__sc.city.plots
      .filter(p => Math.hypot(p.cx - x, p.cz - z) < R && p.stock.cap > 0)
      .map(p => ({ sym: p.stock.sym, name: p.stock.name, cx: p.cx, cz: p.cz, h: p.hNow, ret: p.stock.ret['1y'], cap: p.stock.cap })), [f.cx, f.cz, M.near]);
    const big = near.filter(p => p.sym !== f.sym).sort((a, b) => b.cap - a.cap).slice(0, 12);
    const tall = big.filter(p => p.ret > 10).sort((a, b) => b.cap - a.cap)[0];
    const red = big.filter(p => p.ret < 0).sort((a, b) => b.cap - a.cap)[0];
    const flat = big.filter(p => Math.abs(p.ret) < 3).sort((a, b) => b.cap - a.cap)[0];
    const A = M.heroA, B = M.heroB;
    const frames = [];
    await record(page, path.join(OUT, 'hero'), shotFrames('hero') + HANDLE, async i => {
      await cam(camMix(A, B, ramp(i, 0, shotFrames('hero') + HANDLE, bezier(0.4, 0, 0.6, 1))));
      frames.push(await project({
        flag: [f.cx, f.h + 1, f.cz], flagBase: [f.cx - f.bw / 2, 0, f.cz + f.bd / 2],
        ...(tall ? { tall: [tall.cx, tall.h + 1, tall.cz] } : {}), ...(red ? { red: [red.cx, red.h + 0.5, red.cz] } : {}),
        ...(flat ? { flat: [flat.cx, flat.h + 0.5, flat.cz] } : {}),
      }));
    });
    writeMeta('hero', { flagship: { ...f, ret1y: f.ret['1y'] }, tall, red, flat, frames });
  },

  // Period sweep with the real header: one period per two beats, the city re-ranks each time.
  async periods() {
    await hideUI(page, false); await period('1y'); await tick(page, 30);
    const steps = [['1d', 0], ['1w', 2], ['1m', 4], ['3m', 6], ['1y', 8]];
    const N = shotFrames('periods') + HANDLE, start = beatF(TL.shots.periods[0]);
    const at = Object.fromEntries(steps.map(([p, b]) => [beatF(TL.shots.periods[0] + b) - start, p]));
    const A = { ...HOME, az: -7, dist: HOME.dist * 0.98 }, B = { ...HOME, az: 5, dist: HOME.dist * 0.9 };
    const summaries = {};
    await record(page, path.join(OUT, 'periods'), N, async i => {
      if (at[i] !== undefined) { await period(at[i]); summaries[at[i]] = await text('#summary'); }
      await cam(camMix(A, B, ramp(i, 0, N)));
    });
    writeMeta('periods', { steps: steps.map(([p, b]) => ({ p, beat: b, frame: beatF(TL.shots.periods[0] + b) - start, summary: summaries[p] })) });
  },

  // Sector flow: arcs and particles, low and slowly tracking; anchors on the top flow's two districts.
  async flow() {
    await hideUI(page, false); await period('1y'); await tick(page, 30);
    await click('#flowBtn'); await tick(page, 40);
    const panel = await text('#fpanel');
    await hideUI(page);
    const centers = await sectorCenters();
    const lines = panel.split('\n').map(s => s.trim()).filter(Boolean);
    const ti = lines.findIndex(l => /^TOP FLOWS/i.test(l));
    const top = []; for (let k = ti + 1; k < lines.length - 1 && top.length < 3; k += 2) if (lines[k].includes('→')) top.push({ path: lines[k], amount: lines[k + 1] });
    const [src, dst] = top[0].path.split('→').map(s => s.trim());
    const S = centers[src], D = centers[dst];
    const mid = [(S[0] + D[0]) / 2, 0, (S[2] + D[2]) / 2];
    const N = shotFrames('flow') + HANDLE;
    const A = { tx: mid[0], ty: 8, tz: mid[2], dist: HOME.dist * 0.62, az: -24, el: 30 }, B = { ...A, dist: HOME.dist * 0.56, az: -8, el: 34 };
    const frames = [];
    await record(page, path.join(OUT, 'flow'), N, async i => {
      await cam(camMix(A, B, ramp(i, 0, N, bezier(0.4, 0, 0.6, 1))));
      frames.push(await project({ src: S, dst: D }));
    });
    // Net change per sector, in panel order (leaders first).
    const nets = []; for (let k = 2; k < ti - 1; k += 2) nets.push({ name: lines[k], net: lines[k + 1] });
    writeMeta('flow', { top, src, dst, nets, frames, panelTitle: lines[0] });
    await click('#flowBtn'); await tick(page, 5);
  },

  // Highlight views with the real panels: undervalued (★) and 13F / 三大法人.
  async val() { await highlight('val', '#valBtn', '#vpanel', market === 'us' ? 'feat1' : 'feat2'); },
  async inv() { await highlight('inv', '#invBtn', '#ipanel', market === 'us' ? 'feat2' : 'feat1'); },

  // Outro: the flat treemap seen from above, slowly rising and turning.
  async outro() {
    await hideUI(page); await period('1y'); await page.$eval('#heightMode button[data-h="flat"]', el => el.click()); await tick(page, 40);
    const N = shotFrames('outro') + TL.tailFrames + HANDLE;
    const A = { ...HOME, tz: HOME.tz - 10, el: 70, az: 6, dist: HOME.dist * 0.82 }, B = { ...A, el: 78, az: -4, dist: HOME.dist * 1.0 };
    await record(page, path.join(OUT, 'outro'), N, async i => { await cam(camMix(A, B, ramp(i, 0, N, bezier(0.25, 0.1, 0.25, 1)))); });
    writeMeta('outro', {});
    await page.$eval('#heightMode button[data-h="return"]', el => el.click()); await tick(page, 30);
  },
};

async function highlight(name, btn, panelSel, slot) {
  await hideUI(page, false); await period('1y'); await tick(page, 30);
  const N = shotFrames(slot) + HANDLE;
  const A = { ...HOME, az: -4, el: 38, dist: HOME.dist * 1.0 }, B = { ...HOME, az: 4, el: 47, dist: HOME.dist * 0.9 };
  await record(page, path.join(OUT, name), N, async i => {
    if (i === 4) await click(btn);
    await cam(camMix(A, B, ramp(i, 0, N, bezier(0.4, 0, 0.6, 1))));
  });
  writeMeta(name, { panel: (await text(panelSel)).slice(0, 2000), count: await text(btn) });
  await click(btn); await tick(page, 5);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [k, fn] of Object.entries(SHOTS)) {
  if (only.length && !only.includes(k)) continue;
  const t = Date.now(); await fn(); console.log(`${market}/${k} done in ${((Date.now() - t) / 1000).toFixed(0)}s`);
}
await browser.close();

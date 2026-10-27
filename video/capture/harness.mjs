// Deterministic capture of the live market cities.
// - Serves a frozen /api/market snapshot so prices can't refresh mid-shot.
// - Rewrites city.js on the fly (the app source is untouched) to expose its module-scope objects as window.__sc.
// - Replaces performance.now / requestAnimationFrame with a virtual clock advanced one video frame at a time.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const FPS = 30;

const EXPOSE = `
;window.__sc = { THREE, camera, controls, scene, renderer, city, state, labels,
  flyTo, flyHome, focusPlot, select, closeSide, applyEncoding, refreshHighlights, isolate, markButtons, rebuild, frame,
  setFlight: v => { flight = v; }, getFlight: () => flight, get market() { return market; } };
`;

const VIRTUAL_CLOCK = `
(() => {
  let vt = 1000; const queue = [];
  performance.now = () => vt;
  window.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  window.__tick = ms => { vt += ms; const q = queue.splice(0); for (const cb of q) cb(vt); return vt; };
  window.__vt = () => vt;
})();
`;

export async function openCity({ market, port, width = 1920, height = 1080, scale = 1, query = '' }) {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--disable-features=VaapiVideoDecoder', '--disable-gpu-memory-buffer-video-frames', '--ignore-gpu-blocklist', '--disable-gpu-compositing',
           '--font-render-hinting=none', '--hide-scrollbars'],
    defaultViewport: { width, height, deviceScaleFactor: scale },
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('[page]', e.message));
  await page.evaluateOnNewDocument(VIRTUAL_CLOCK);
  const snapshot = fs.readFileSync(path.join(HERE, 'data', `${market}-market.json`));
  await page.setRequestInterception(true);
  page.on('request', async req => {
    const url = req.url();
    try {
      if (url.endsWith('/api/market')) return req.respond({ status: 200, contentType: 'application/json', body: snapshot });
      if (/\/city\.js(\?|$)/.test(url)) {
        const src = await (await fetch(url)).text();
        return req.respond({ status: 200, contentType: 'text/javascript', body: src + EXPOSE });
      }
    } catch (e) { console.error('intercept', url, e.message); }
    req.continue();
  });
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction(() => window.__sc && window.__sc.city.mesh, { timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  // Let the build animation finish.
  await tick(page, 60);
  return { browser, page };
}

export async function tick(page, frames = 1) {
  await page.evaluate(n => { for (let i = 0; i < n; i++) window.__tick(1000 / 30); }, frames);
}

// Shot recorder: calls step(i, t) before each frame, advances the clock one frame, writes a JPEG.
export async function record(page, dir, frames, step, { quality = 92 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  for (let i = 0; i < frames; i++) {
    if (step) await step(i, i / FPS);
    await tick(page, 1);
    // PREVIEW=n keeps every frame's timing but only writes every n-th image (fast camera-path checks).
    if (process.env.PREVIEW && i % +process.env.PREVIEW) continue;
    await page.screenshot({ path: path.join(dir, `${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality });
    if (i % 30 === 0) process.stdout.write(`  ${path.basename(dir)} ${i}/${frames}\n`);
  }
}

// Places the camera from spherical coords around a target (deg), bypassing OrbitControls damping.
export async function setCam(page, { tx = 0, ty = 0, tz = 0, dist, az, el }) {
  await page.evaluate((tx, ty, tz, dist, az, el) => {
    const { camera, controls } = window.__sc;
    const a = az * Math.PI / 180, e = el * Math.PI / 180;
    controls.target.set(tx, ty, tz);
    camera.position.set(tx + dist * Math.cos(e) * Math.sin(a), ty + dist * Math.sin(e), tz + dist * Math.cos(e) * Math.cos(a));
    camera.lookAt(tx, ty, tz);
  }, tx, ty, tz, dist, az, el);
}

export const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mix = (A, B, t) => Object.fromEntries(Object.keys(A).map(k => [k, lerp(A[k], B[k], t)]));

export async function hideUI(page, hide = true) {
  await page.evaluate(h => {
    let st = document.getElementById('__hideui');
    if (!st) { st = document.createElement('style'); st.id = '__hideui'; document.head.append(st); }
    st.textContent = h ? 'header,#legend,#help,#tip,#rightcol,#side{display:none!important}' : '';
    window.__sc.frame();
  }, hide);
}

// node capture/camtest.mjs us '<json array of {name, period, ui, cam:{tx,ty,tz,dist,az,el}}>'
import { openCity, tick, hideUI } from './harness.mjs';
const [market, json] = process.argv.slice(2);
const { browser, page } = await openCity({ market, port: market === 'us' ? 8000 : 8001 });
await page.evaluate(() => { window.__sc.controls.enableDamping = false; });
for (const s of JSON.parse(json)) {
  await hideUI(page, !s.ui);
  await page.$eval(`#periods button[data-p="${s.period || '1y'}"]`, el => el.click()); await tick(page, 25);
  await page.evaluate(c => { const { camera, controls, setFlight } = window.__sc; setFlight(null);
    const a = c.az * Math.PI / 180, e = c.el * Math.PI / 180; controls.target.set(c.tx, c.ty, c.tz);
    camera.position.set(c.tx + c.dist * Math.cos(e) * Math.sin(a), c.ty + c.dist * Math.sin(e), c.tz + c.dist * Math.cos(e) * Math.cos(a)); }, s.cam);
  await tick(page, 1);
  await page.screenshot({ path: `out/qa/cam-${market}-${s.name}.jpg`, type: 'jpeg', quality: 80 });
}
await browser.close();

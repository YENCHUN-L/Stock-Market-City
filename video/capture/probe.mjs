import { openCity, tick, setCam } from './harness.mjs';
const [market, port] = process.argv.slice(2);
const t0 = Date.now();
const { browser, page } = await openCity({ market, port });
console.log('loaded', (Date.now() - t0) / 1000);
await page.screenshot({ path: `out/qa/probe-${market}-ui.jpg`, type: 'jpeg', quality: 85 });
const info = await page.evaluate(() => { const { city, camera, controls } = window.__sc;
  return { sectors: city.sectors.map(s => ({ name: s.name, x: s.x, z: s.z, w: s.w, d: s.d, ...(s.cx!==undefined?{cx:s.cx}:{}) })).slice(0, 30),
    keys: Object.keys(city.sectors[0] || {}), plotKeys: Object.keys(city.plots[0] || {}), cam: camera.position.toArray(), tgt: controls.target.toArray() }; });
console.log(JSON.stringify(info).slice(0, 3000));
const t1 = Date.now(); await tick(page, 1); await page.screenshot({ path: `/dev/null`, type: 'jpeg' }); console.log('frame ms', Date.now() - t1);
await browser.close();

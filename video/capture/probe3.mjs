import { openCity, tick } from './harness.mjs';
const [market, port, sym] = process.argv.slice(2);
const { browser, page } = await openCity({ market, port });
for (const p of ['1d', '1y']) {
  await page.click(`#periods button[data-p="${p}"]`); await tick(page, 30);
  console.log(p, JSON.stringify(await page.evaluate(sym => { const { city, camera, controls } = window.__sc;
    const top = [...city.plots].sort((a, b) => b.stock.cap - a.stock.cap).slice(0, 8).map(q => [q.stock.sym, +q.cx.toFixed(1), +q.cz.toFixed(1), +q.bw.toFixed(1), +q.bd.toFixed(1), +q.hNow.toFixed(1), q.stock.ret]);
    const tall = [...city.plots].sort((a, b) => b.hNow - a.hNow).slice(0, 5).map(q => [q.stock.sym, +q.cx.toFixed(1), +q.cz.toFixed(1), +q.hNow.toFixed(1)]);
    const xs = city.plots.map(q => q.cx), zs = city.plots.map(q => q.cz);
    return { top, tall, bounds: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)], cam: camera.position.toArray().map(v => +v.toFixed(1)), tgt: controls.target.toArray().map(v => +v.toFixed(1)),
      summary: document.querySelector('#summary').innerText };
  }, sym)));
}
await page.click('#flowBtn'); await tick(page, 30);
console.log(await page.evaluate(() => document.querySelector('#fpanel').innerText.slice(0, 900)));
await page.click('#flowBtn'); await page.click('#valBtn'); await tick(page, 10);
console.log(await page.evaluate(() => document.querySelector('#vpanel').innerText.slice(0, 400)));
await page.click('#valBtn'); await page.click('#invBtn'); await tick(page, 10);
console.log(await page.evaluate(() => document.querySelector('#ipanel').innerText.slice(0, 700)));
await browser.close();

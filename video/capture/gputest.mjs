import puppeteer from 'puppeteer-core';
for (const args of [['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'], ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'], ['--use-gl=egl', '--ignore-gpu-blocklist']]) {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args });
  const p = await b.newPage();
  await p.setContent('<canvas id=c></canvas>');
  const r = await p.evaluate(() => { const gl = document.getElementById('c').getContext('webgl2'); if (!gl) return 'none';
    const e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER); });
  console.log(args.join(' '), '=>', r); await b.close();
}

// Deterministic capture: virtual time advances a fixed step per frame and each
// frame is rendered on demand, so a slow software renderer still yields smooth
// motion. Usage: node frames.cjs <url> <frames> <fps> <outdir> <warmupMs> <w> <h>
const { chromium } = require('playwright');
const { mkdirSync, writeFileSync } = require('node:fs');
(async () => {
  const [url, frames = '24', fps = '12', outDir = './frames', warmupMs = '8000', w = '1280', h = '720'] = process.argv.slice(2);
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--enable-begin-frame-control', '--disable-gpu-vsync', '--run-all-compositor-stages-before-draw'] });
  const context = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(Number(warmupMs));
  const step = Math.round(1000 / Number(fps));
  await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
  const t0 = Date.now();
  for (let i = 0; i < Number(frames); i++) {
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: step });
    const r = await cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks: undefined, interval: step, noDisplayUpdates: false, screenshot: { format: 'png' } });
    if (!r.screenshotData) { console.log('frame', i, 'no screenshot (hasDamage=' + r.hasDamage + ')'); continue; }
    writeFileSync(`${outDir}/f${String(i).padStart(4, '0')}.png`, Buffer.from(r.screenshotData, 'base64'));
  }
  console.log('captured', Number(frames), 'frames in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  await browser.close();
})().catch(e => { console.error('ERR', String(e).split('\n')[0]); process.exit(1); });

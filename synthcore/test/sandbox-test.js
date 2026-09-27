// Runs the synth inside a sandboxed srcdoc iframe with a strict CSP (no blob:/data: scripts,
// no eval), the way embedded previews host it. Location there is about:srcdoc.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const fs = require('fs');
(async () => {
  const html = fs.readFileSync(__dirname + '/../dist/synthcore.html', 'utf8')
    .replace(/const FORCE_OPEN = [^;]*;/, 'const FORCE_OPEN = true; // srcdoc has no #hash')
    .replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'; worker-src 'none'">`);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const host = __dirname + '/sandbox-host.html';
  fs.writeFileSync(host, '<!doctype html><iframe id="f" style="width:1340px;height:880px;border:0" sandbox="' + (process.argv[2] || 'allow-scripts allow-same-origin') + '"></iframe>');
  await page.goto('file://' + host);
  await page.$eval('#f', (f, h) => { f.srcdoc = h; }, html);
  await page.waitForTimeout(800);
  const frame = page.frames()[1];
  await frame.click('.brand');
  await page.waitForTimeout(2500);
  const state = await frame.textContent('#audioState');
  const loc = await frame.evaluate(() => location.href);
  await frame.focus('.brand');
  await page.keyboard.down('KeyA'); await page.waitForTimeout(800);
  const voices = await frame.textContent('#voiceCount');
  const lit = await frame.evaluate(() => { const d = document.querySelector('#xy').getContext('2d').getImageData(0, 0, 320, 200).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n; });
  await page.keyboard.up('KeyA');
  console.log(JSON.stringify({ loc, state, voices, litPixels: lit, errors }));
  const ok = /^Audio on/.test(state) && /^1 /.test(voices) && lit > 100;
  console.log(ok ? 'PASS' : 'FAIL');
  await browser.close();
})();

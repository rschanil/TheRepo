const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let fail = false; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); if (!c) fail = true; };
  // Normal launch from disk: real AudioWorklet thread.
  const p = await browser.newPage();
  await p.goto('file://' + __dirname + '/../dist/synthcore.html#open'); await p.waitForTimeout(300);
  await p.click('.brand'); await p.waitForTimeout(1200);
  ok(await p.evaluate(() => synthcore.synth.mode) === 'worklet' && (await p.textContent('#audioState')).indexOf('compat') < 0, 'double-clicked file still uses the AudioWorklet thread');
  // Sandboxed host: compatibility engine with a heavy patch, chords and arp.
  const html = fs.readFileSync(__dirname + '/../dist/synthcore.html', 'utf8')
    .replace(/const FORCE_OPEN = [^;]*;/, 'const FORCE_OPEN = true; // srcdoc has no #hash')
    .replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'; worker-src 'none'">`);
  fs.writeFileSync(__dirname + '/sandbox-host.html', '<!doctype html><iframe id="f" style="width:1340px;height:880px;border:0" sandbox="allow-scripts allow-same-origin"></iframe>');
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + __dirname + '/sandbox-host.html');
  await page.$eval('#f', (f, h) => { f.srcdoc = h; }, html);
  await page.waitForTimeout(800);
  const fr = page.frames()[1];
  await fr.click('.brand'); await page.waitForTimeout(1500);
  ok(await fr.evaluate(() => synthcore.synth.mode) === 'compat', 'sandboxed host falls back to the compatibility engine');
  ok((await fr.getAttribute('#audioState', 'title')).includes('blob:'), 'status tooltip explains why (blocked loader reasons listed)');
  await fr.selectOption('#presetLib', { label: 'Cloud Nine' });
  await fr.click('#chdPlay');
  await page.waitForTimeout(3000);
  const st = await fr.evaluate(() => ({ v: document.querySelector('#voiceCount').textContent, cpu: document.querySelector('#cpuTxt').textContent, pos: synthcore.chords.pos, run: synthcore.chords.running }));
  ok(st.run && parseInt(st.v, 10) >= 4, 'chords auto-play on the compatibility engine: ' + JSON.stringify(st));
  await fr.click('#chdPlay');
  await fr.selectOption('#presetLib', { label: 'Aurora Arp' });
  await fr.focus('.brand');
  await page.keyboard.down('KeyA'); await page.keyboard.down('KeyG'); await page.waitForTimeout(200); await page.keyboard.up('KeyA'); await page.keyboard.up('KeyG');
  await page.waitForTimeout(1200);
  ok(/step \d+/.test(await fr.textContent('#arpInfo')), 'latched arp runs: ' + await fr.textContent('#arpInfo'));
  ok(errors.length === 0, 'no errors ' + JSON.stringify(errors));
  console.log(fail ? 'FAIL' : 'PASS');
  await browser.close();
})();

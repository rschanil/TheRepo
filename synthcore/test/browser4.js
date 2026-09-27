const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = []; let fail = false;
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); if (!c) fail = true; };
  const url = 'file://' + __dirname + '/../dist/synthcore.html#open';
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(200);
  await page.click('.brand'); await page.waitForTimeout(1000);
  const groups = await page.$$eval('#presetLib optgroup', (g) => g.map((x) => x.label + ':' + x.children.length));
  const nLib = await page.evaluate(() => synthcore.PARAMS && document.querySelectorAll('#presetLib option[value]:not([value=""])').length);
  const nFactory = await page.evaluate(() => window.__factoryCount || [...document.querySelectorAll('#presetLib optgroup option')].length);
  ok(groups.length >= 6 && nLib === nFactory && nFactory >= 29, `library lists all ${nFactory} sounds in groups ` + groups.join(', '));
  const before = await page.evaluate(() => localStorage.getItem('synthcore_preset_0'));
  // audition every factory sound through the UI and play a chord on each
  const all = await page.$$eval('#presetLib option', (o) => o.filter((x) => x.value).map((x) => [x.value, x.textContent]));
  const res = [];
  for (const [v, name] of all) {
    await page.selectOption('#presetLib', v);
    await page.waitForTimeout(60);
    await page.keyboard.down('KeyA'); await page.keyboard.down('KeyE'); await page.keyboard.down('KeyG');
    await page.waitForTimeout(450);
    const st = await page.evaluate(() => ({ name: document.querySelector('#presetName').value, v: parseInt(document.querySelector('#voiceCount').textContent, 10), cpu: parseInt(document.querySelector('#cpuTxt').textContent, 10) }));
    await page.keyboard.up('KeyA'); await page.keyboard.up('KeyE'); await page.keyboard.up('KeyG');
    await page.click('#panic'); await page.waitForTimeout(60);
    res.push(name + ':' + st.v);
    if (st.name !== name || !(st.v > 0)) { ok(false, name + ' did not load/play ' + JSON.stringify(st)); }
  }
  ok(res.length === nFactory, 'every library sound loads and plays: ' + res.join(' '));
  ok((await page.evaluate(() => localStorage.getItem('synthcore_preset_0'))) === before, 'auditioning does not overwrite saved slots');
  await page.selectOption('#presetLib', { label: 'Tape Rhodes' });
  ok(await page.evaluate(() => synthcore.values[synthcore.PIDX.BPM] === 82 && synthcore.chords.labels.map(l => l.name).join() === 'Dm9,Em9,Am9'), 'Tape Rhodes sets 82 BPM and Neo-soul m9 chords');
  await page.click('#presetSave');
  ok(JSON.parse(await page.evaluate(() => localStorage.getItem('synthcore_preset_0')))._name === 'Tape Rhodes', 'Save stores the library sound into the current slot');
  await page.click('#presetSlots button:nth-child(3)');
  ok((await page.$eval('#presetLib', (s) => s.value)) === '2', 'loading a slot syncs the library menu');
  await page.selectOption('#presetLib', { label: 'Suitcase Rhodes' });
  await page.evaluate(() => document.querySelector('#p-scr').scrollIntoView());
  await page.keyboard.down('KeyA'); await page.keyboard.down('KeyE'); await page.keyboard.down('KeyG'); await page.keyboard.down('KeyU');
  await page.waitForTimeout(900);
  await page.screenshot({ path: __dirname + '/shot-rhodes.png' });
  await page.keyboard.up('KeyA'); await page.keyboard.up('KeyE'); await page.keyboard.up('KeyG'); await page.keyboard.up('KeyU');
  const m = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await m.goto(url); await m.waitForTimeout(200);
  ok(await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) === 0, 'no sideways scroll at 400px');
  ok(errors.length === 0, 'no errors ' + JSON.stringify(errors));
  console.log(fail ? 'FAIL' : 'PASS');
  await browser.close();
})();

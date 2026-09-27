const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const R = {}; let fail = false;
  const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); if (!c) fail = true; };
  const url = 'file://' + __dirname + '/../dist/synthcore.html#open';
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(300);
  await page.mouse.click(700, 20);
  await page.waitForTimeout(1200);
  ok((await page.textContent('#audioState')).startsWith('Audio on'), 'audio starts on first click');
  await page.click('#presetSlots button:nth-child(1)');
  const pads = await page.$$eval('.pad', (b) => b.map((x) => x.querySelector('.num').textContent + ' ' + x.querySelector('.nm').textContent));
  ok(pads.join('|') === 'i Am9|iv Dm9', 'default pads: A minor vamp in m9 (' + pads.join(', ') + ')');
  // pad press via mouse (scroll into view first)
  await page.evaluate(() => document.querySelector('#p-chd').scrollIntoView({ block: 'center' }));
  const pad = await page.$('#chdPad1'); const bb = await pad.boundingBox();
  await page.mouse.move(bb.x + 20, bb.y + 20); await page.mouse.down(); await page.waitForTimeout(400);
  let st = await page.evaluate(() => ({ v: document.querySelector('#voiceCount').textContent, keys: [...document.querySelectorAll('.key.on')].map(k => +k.dataset.note), want: synthcore.chords.voicings[1], padOn: document.querySelector('#chdPad1').classList.contains('on') }));
  ok(st.padOn && st.v.startsWith(String(st.want.length)) && st.keys.join() === st.want.filter(n => n >= 36 && n <= 72).join(), 'hold pad 2: Dm9 ' + st.want.map(n => n).join(' ') + ' → ' + st.v + ', lit ' + st.keys.join());
  ok(st.want.every(n => n >= 36 && n <= 72), 'default chords sit inside the on-screen keyboard (C2–C5)');
  await page.mouse.up(); await page.waitForTimeout(100);
  ok(await page.evaluate(() => document.querySelectorAll('.key.on').length === 0 && !document.querySelector('#chdPad1').classList.contains('on')), 'release pad clears keys');
  await page.keyboard.down('Digit1'); await page.waitForTimeout(400);
  const k1 = await page.evaluate(() => ({ on: document.querySelectorAll('.key.on').length, n: synthcore.chords.voicings[0].length, v: document.querySelector('#voiceCount').textContent }));
  ok(k1.on === k1.n && k1.v.startsWith(String(k1.n)), 'key 1 plays chord 1 (' + JSON.stringify(k1) + ')');
  await page.keyboard.up('Digit1'); await page.waitForTimeout(700);
  // change settings
  await page.selectOption('#sel-CHD_PROG', '5');
  await page.selectOption('#sel-CHD_KEY', '0');
  await page.click('[data-p="CHD_TYPE"] button:nth-child(3)');
  const pads2 = await page.$$eval('.pad', (b) => b.map((x) => x.querySelector('.num').textContent + ' ' + x.querySelector('.nm').textContent));
  ok(pads2.join('|') === 'i Cm11|♭vii B♭m11|♭vi A♭m11|v Gm11', 'C Descent m11 labels (' + pads2.join(', ') + ')');
  const voic = await page.evaluate(() => synthcore.chords.voicings);
  const moves = voic.slice(1).map((c, i) => c.reduce((s, n, j) => s + Math.abs(n - voic[i][j]), 0));
  ok(moves.every((m) => m <= 12), 'voice leading keeps total movement small ' + JSON.stringify(moves));
  // play
  await page.fill('#bpm', '240'); await page.press('#bpm', 'Enter');
  await page.selectOption('#sel-CHD_RATE', '0');
  await page.click('#chdPlay');
  const seen = new Set();
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(150); seen.add(await page.evaluate(() => synthcore.chords.pos)); }
  ok(seen.size >= 3 && (await page.textContent('#chdPlay')).includes('Stop'), 'auto-play steps through chords at 240 BPM (saw ' + [...seen].join(',') + ')');
  ok(await page.evaluate(() => document.querySelectorAll('.key.chd').length >= 4 && document.querySelectorAll('.pad.on').length === 1), 'current chord lit on pads and keyboard');
  // with arp
  await page.click('[data-p="ARP_ON"]');
  await page.waitForTimeout(700);
  const arpInfo = await page.textContent('#arpInfo');
  ok(/step \d+\/\d+/.test(arpInfo), 'arp arpeggiates playing chords (' + arpInfo + ')');
  await page.screenshot({ path: __dirname + '/shot-chords.png', clip: { x: 0, y: 0, width: 1360, height: 900 } });
  await page.click('#panic'); await page.waitForTimeout(400);
  ok((await page.textContent('#chdPlay')).includes('Play') && await page.evaluate(() => !synthcore.chords.running), 'panic stops the chord player');
  await page.click('[data-p="ARP_ON"]');
  // collapsible: fresh visit starts folded except Quick controls and the keyboard
  const plain = url.replace('#open', '');
  await page.evaluate(() => { localStorage.removeItem('synthcore_folds_v2'); localStorage.removeItem('synthcore_view'); });
  await page.goto(plain); await page.reload(); await page.waitForTimeout(300);
  const fresh = await page.evaluate(() => [...document.querySelectorAll('#app > section.panel')].map((p) => [p.id, p.classList.contains('folded')]));
  ok(fresh.every(([id, f]) => (id === 'p-quick' || id === 'p-kb') ? !f : f), 'fresh visit: every panel folded except Quick controls and Keyboard');
  ok(await page.evaluate(() => document.body.classList.contains('view-adv')), 'wide screen opens in Advanced view');
  await page.click('#p-filter .ph'); await page.click('#p-kb .ph');
  await page.reload(); await page.waitForTimeout(300);
  ok(await page.evaluate(() => !document.querySelector('#p-filter-body').hidden && document.querySelector('#p-kb-body').hidden && document.querySelector('#p-osc-body').hidden), 'fold choices remembered after reload');
  await page.click('#p-osc .ph');
  ok(await page.evaluate(() => !document.querySelector('#p-osc-body').hidden && document.querySelector('#p-osc .ph').getAttribute('aria-expanded') === 'true'), 'section unfolds');
  await page.click('#foldAll');
  const shownBodies = () => page.evaluate(() => [...document.querySelectorAll('#app > section.panel')].filter((p) => getComputedStyle(p).display !== 'none').map((p) => p.querySelector('.pbody').hidden));
  let sb = await shownBodies();
  ok(sb.every((h) => h) && (await page.textContent('#foldAll')) === 'Unfold all', 'fold all folds all ' + sb.length + ' visible sections');
  await page.click('#foldAll');
  sb = await shownBodies();
  ok(sb.every((h) => !h), 'unfold all');
  // Simple / Advanced
  await page.click('#viewSw [data-v="simple"]'); await page.waitForTimeout(100);
  const simple = await page.evaluate(() => ({ osc: getComputedStyle(document.querySelector('#p-osc')).display, fx: getComputedStyle(document.querySelector('#p-fx')).display, quick: getComputedStyle(document.querySelector('#p-quick')).display, claude: getComputedStyle(document.querySelector('#p-claude')).display, kb: getComputedStyle(document.querySelector('#p-kb')).display }));
  ok(simple.osc === 'none' && simple.fx === 'none' && simple.quick !== 'none' && simple.claude !== 'none' && simple.kb !== 'none', 'Simple view hides the deep panels, shows Quick controls, Claude and keyboard ' + JSON.stringify(simple));
  await page.evaluate(() => synthcore.set('FLT_CUTOFF', 1234));
  ok(await page.evaluate(() => /1\.23k/.test(document.querySelector('#p-quick [data-p="FLT_CUTOFF"]').textContent)), 'Quick knobs share the real parameters (cutoff 1.23k shows on the Brightness knob)');
  await page.reload(); await page.waitForTimeout(300);
  ok(await page.evaluate(() => document.body.classList.contains('view-simple')), 'view choice remembered after reload');
  await page.click('#viewSw [data-v="adv"]');
  await page.goto(url); await page.reload(); await page.waitForTimeout(300);
  // keyboard access: focus heading, press Enter
  await page.focus('#p-lfo .ph'); await page.keyboard.press('Enter');
  ok(await page.evaluate(() => document.querySelector('#p-lfo-body').hidden), 'heading toggles from keyboard');
  await page.keyboard.press('Enter');
  // audio still fine after reload + qwerty
  await page.click('.brand'); await page.click('#presetSlots button:nth-child(1)');
  await page.waitForTimeout(1500);
  await page.keyboard.down('KeyA'); await page.waitForTimeout(400);
  const vq = await page.evaluate(() => ({ v: document.querySelector('#voiceCount').textContent, focus: document.activeElement.className, on: [...document.querySelectorAll('.key.on')].map(k => k.dataset.note) }));
  ok(vq.v.startsWith('1') && vq.on.join() === '60', 'QWERTY still plays ' + JSON.stringify(vq));
  await page.keyboard.up('KeyA');
  // mobile
  const m = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await m.goto(url); await m.waitForTimeout(300);
  ok(await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) === 0, 'no sideways scroll at 400px');
  await m.evaluate(() => document.querySelector('#p-chd').scrollIntoView());
  await m.screenshot({ path: __dirname + '/shot-mobile-chd.png' });
  ok(errors.length === 0, 'no console or page errors ' + JSON.stringify(errors));
  console.log(fail ? 'FAIL' : 'PASS');
  await browser.close();
})();

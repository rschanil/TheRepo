const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let fail = false; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); if (!c) fail = true; };
  const url = 'file://' + __dirname + '/../dist/synthcore.html#open';
  // A canned answer in the exact line format, streamed in chunks like the real capability.
  const lines = ['{"title": "Test Nocturne", "sound": "Suitcase Rhodes", "bpm": 150, "bars": 4, "note": "A tiny test in A minor."}'];
  const prog = [[45, 57, 60, 64], [41, 57, 60, 65], [48, 55, 60, 64], [40, 56, 59, 64]];
  prog.forEach((c, b) => c.forEach((n) => lines.push(`${b * 4} 3.8 ${n} 70`)));
  [[0, 76], [1, 74], [2, 72], [4, 77], [6, 76], [8, 79], [10, 76], [12, 71], [14, 69]].forEach(([t, n]) => lines.push(`${t} 1 ${n} 90`));
  const answer = lines.join('\n');
  const mock = (mode) => `
    window.__prompts = [];
    window.claude = { use: async (name) => name !== 'sample' ? null : (${mode === 'absent' ? 'null' : `(() => {
      const s = (input, opts) => new Promise((res, rej) => {
        window.__prompts.push(input);
        if (${JSON.stringify(mode)} === 'denied') { setTimeout(() => rej({ code: 'not_granted', message: 'no' }), 50); return; }
        const text = ${JSON.stringify(mode)} === 'garbage' ? 'Sure! Here is a lovely piece.' : ${JSON.stringify(answer)};
        let i = 0; const step = Math.ceil(text.length / 12);
        const tick = () => {
          if (opts.signal && opts.signal.aborted) { rej({ code: 'cancelled', message: 'x', text: text.slice(0, i) }); return; }
          i = Math.min(text.length, i + step);
          opts.onText && opts.onText({ text: text.slice(0, i), delta: '' });
          if (i >= text.length) res({ text, truncated: false, modelTierApplied: 'default' }); else setTimeout(tick, 150);
        };
        setTimeout(tick, 300);
      });
      return s; })()`}) };`;
  // 1. Working Claude
  {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addInitScript(mock('ok'));
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url); await page.waitForTimeout(400);
    ok((await page.textContent('#clTitle')) === 'Rain on the Window', 'opens showing a built-in piece on the roll');
    ok(!(await page.$eval('#clPrompt', (e) => e.disabled)), 'compose box enabled when Claude is available');
    await page.fill('#clPrompt', 'a quick test nocturne');
    await page.click('#clGo');
    await page.waitForTimeout(1000);
    const mid = await page.evaluate(() => ({ st: document.querySelector('#clStatus').textContent, go: document.querySelector('#clGo').textContent, n: synthcore.claudePlays.draft && synthcore.claudePlays.draft.notes.length }));
    ok(/writing|thinking/.test(mid.st) && mid.go === 'Stop' && mid.n > 0, 'notes appear on the roll while Claude is still writing: ' + JSON.stringify(mid));
    await page.waitForTimeout(2200);
    const st = await page.evaluate(() => ({ title: document.querySelector('#clTitle').textContent, meta: document.querySelector('#clMeta').textContent, sound: document.querySelector('#presetName').value, bpm: synthcore.values[synthcore.PIDX.BPM], playing: synthcore.claudePlays.playing, prompt: window.__prompts[0] }));
    ok(st.title === 'Test Nocturne' && st.sound === 'Suitcase Rhodes' && st.bpm === 150, 'Claude’s choices applied: ' + st.meta + ' on ' + st.sound);
    ok(st.prompt.includes('a quick test nocturne') && st.prompt.includes('- Tape Rhodes:') && st.prompt.includes('start duration midi velocity'), 'prompt carries the request, the sound list and the format');
    await page.waitForTimeout(700);
    const pl = await page.evaluate(() => ({ playing: synthcore.claudePlays.playing, lit: [...document.querySelectorAll('.key.seq')].map((k) => +k.dataset.note), voices: document.querySelector('#voiceCount').textContent }));
    ok(pl.playing && pl.lit.length >= 3 && parseInt(pl.voices, 10) >= 3, 'the synth performs it: keys lit ' + pl.lit.join(',') + ', ' + pl.voices);
    await page.screenshot({ path: __dirname + '/shot-claude.png', clip: { x: 0, y: 440, width: 1360, height: 460 } });
    ok((await page.$$eval('#clPieces optgroup', (g) => g.map((x) => x.label))).includes('Composed for you'), 'new piece saved under “Composed for you”');
    await page.waitForTimeout(6500);
    ok(!(await page.evaluate(() => synthcore.claudePlays.playing)) && (await page.textContent('#clPlay')).includes('Play'), 'playback ends by itself after 4 bars');
    await page.click('#clLoop'); await page.click('#clPlay'); await page.waitForTimeout(7200);
    ok(await page.evaluate(() => synthcore.claudePlays.playing), 'loop keeps it going past the end');
    await page.click('#panic'); await page.waitForTimeout(300);
    ok(!(await page.evaluate(() => synthcore.claudePlays.playing)), 'panic stops the performance');
    // cancel mid-compose
    await page.fill('#clPrompt', 'another one'); await page.click('#clGo'); await page.waitForTimeout(600); await page.click('#clGo'); await page.waitForTimeout(400);
    ok(/Stopped/.test(await page.textContent('#clStatus')), 'Stop during composing cancels: ' + await page.textContent('#clStatus'));
    await page.selectOption('#clPieces', 'b:1'); await page.waitForTimeout(1500);
    ok((await page.textContent('#presetName')) === 'Cloud Nine' || (await page.inputValue('#presetName')) === 'Cloud Nine', 'built-in “Cloud Drift” loads Cloud Nine and plays');
    ok(errors.length === 0, 'no errors ' + JSON.stringify(errors));
    await ctx.close();
  }
  // 2. Viewer declines
  {
    const ctx = await browser.newContext(); await ctx.addInitScript(mock('denied'));
    const page = await ctx.newPage(); await page.goto(url); await page.waitForTimeout(300);
    await page.click('.brand'); await page.fill('#clPrompt', 'x'); await page.click('#clGo'); await page.waitForTimeout(600);
    ok(/not allowed/.test(await page.textContent('#clStatus')) && await page.$eval('#clGo', (e) => e.disabled), 'declined permission hides composing, explains, keeps built-ins');
    await ctx.close();
  }
  // 3. Unusable answer
  {
    const ctx = await browser.newContext(); await ctx.addInitScript(mock('garbage'));
    const page = await ctx.newPage(); await page.goto(url); await page.waitForTimeout(300);
    await page.click('.brand'); await page.fill('#clPrompt', 'x'); await page.click('#clGo'); await page.waitForTimeout(2600);
    ok(/not as playable notes/.test(await page.textContent('#clStatus')) && (await page.textContent('#clGo')) === 'Compose', 'a non-musical answer is reported and the button resets');
    await ctx.close();
  }
  // 4. No Claude at all (the double-clicked file)
  {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url); await page.waitForTimeout(400);
    ok(await page.$eval('#clPrompt', (e) => e.disabled) && /published page/.test(await page.textContent('#clStatus')), 'standalone file explains live composing needs claude.ai');
    await page.click('.brand'); await page.waitForTimeout(900);
    await page.click('#clPlay'); await page.waitForTimeout(1500);
    const v = await page.evaluate(() => ({ p: synthcore.claudePlays.playing, s: document.querySelector('#presetName').value, v: document.querySelector('#voiceCount').textContent }));
    ok(v.p && v.s === 'Tape Rhodes' && parseInt(v.v, 10) > 0, 'built-in piece still plays offline: ' + JSON.stringify(v));
    ok(errors.length === 0, 'no errors ' + JSON.stringify(errors));
  }
  console.log(fail ? 'FAIL' : 'PASS');
  await browser.close();
})();

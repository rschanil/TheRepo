// "Claude plays" turning knobs and using the arpeggiator. A mocked sample() streams an
// answer whose header is pretty-printed across several lines (a realistic deviation),
// sets knobs by option name, automates the cutoff, and hands its chords to the arp.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let fail = false; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); if (!c) fail = true; };
  const url = 'file://' + __dirname + '/../dist/synthcore.html#open';
  const header = {
    title: 'Knob Test', sound: 'Glass Cathedral', bpm: 150, bars: 4, note: 'Testing knobs and arp.',
    knobs: { FLT_CUTOFF: 700, FLT_RES: 0.5, REV_SEND: 0.8, ARP_MODE: 'UP-DN', ARP_DIV: '1/8T', ARP_OCT: 2, ARP_GATE: 0.4, ENV1_A: 0.01, BOGUS_KNOB: 3 },
    moves: [[0, 'FLT_CUTOFF', 700], [12, 'FLT_CUTOFF', 3000], [8, 'REV_SEND', 0.95], [6, 'ARP_MODE', 'DOWN'], [4, 'NOT_A_KNOB', 1]]
  };
  const lines = [JSON.stringify(header, null, 2)];
  const chords = [[57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65], [52, 56, 59, 64]];
  const bass = [45, 41, 43, 40];
  for (let b = 0; b < 4; b++) {
    lines.push(`${b * 4} 3.9 ${bass[b]} 70`);
    chords[b].forEach((n) => lines.push(`${b * 4} 4 ${n} 72 a`));
    lines.push(`${b * 4 + 1} 1.5 ${76 - b} 88`);
    lines.push(`${b * 4 + 2.5} 1 ${79 - b} 80`);
  }
  const answer = lines.join('\n');
  const mock = `
    window.__prompts = [];
    window.claude = { use: async (name) => name !== 'sample' ? null : ((input, opts) => new Promise((res) => {
      window.__prompts.push(input);
      const text = ${JSON.stringify(answer)};
      let i = 0; const step = Math.ceil(text.length / 10);
      const tick = () => { i = Math.min(text.length, i + step); opts.onText && opts.onText({ text: text.slice(0, i), delta: '' });
        if (i >= text.length) res({ text, truncated: false }); else setTimeout(tick, 100); };
      setTimeout(tick, 200);
    })) };`;
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript(mock);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url); await page.waitForTimeout(400);
  await page.click('.brand'); await page.waitForTimeout(600);

  // Prompt: asked-for arp is honoured; "no arp" is honoured; knobs are documented.
  await page.fill('#clPrompt', 'shimmering arpeggios please');
  await page.click('#clGo');
  await page.waitForTimeout(600);
  const draft = await page.evaluate(() => ({ chips: document.querySelector('#clKnobs').textContent, n: synthcore.claudePlays.draft && synthcore.claudePlays.draft.notes.length }));
  const p1 = await page.evaluate(() => window.__prompts[0]);
  ok(/use the arpeggiator for the chords/.test(p1), 'asking for arpeggios tells Claude to use the arp');
  ok(/FLT_CUTOFF \(Cutoff\): 20 to 20000 Hz/.test(p1) && /ARP_MODE \(Arp pattern\): UP \| DOWN \| UP-DN/.test(p1) && /"moves"/.test(p1), 'prompt documents knobs with ranges and options, and moves');

  // Setup phase: knobs glide into place, highlighted.
  await page.waitForTimeout(1500);
  const setup = await page.evaluate(() => {
    const V = (id) => synthcore.values[synthcore.PIDX[id]];
    const cut = synthcore.ui.ctls.get(synthcore.PIDX.FLT_CUTOFF)[0].el;
    return { preset: document.querySelector('#presetName').value, cutoff: V('FLT_CUTOFF'), res: V('FLT_RES'), rev: V('REV_SEND'), revOn: V('REV_ON'),
      arpOn: V('ARP_ON'), latch: V('ARP_LATCH'), mode: V('ARP_MODE'), div: V('ARP_DIV'), oct: V('ARP_OCT'), touched: cut.classList.contains('cl-touch') || cut.classList.contains('cl-auto'),
      chips: document.querySelector('#clKnobs').textContent, knobs: synthcore.claudePlays.piece.knobs };
  });
  ok(setup.preset === 'Glass Cathedral', 'Claude’s sound loaded: ' + setup.preset);
  ok(setup.arpOn === 1 && setup.latch === 0 && setup.mode === 2 && setup.div === 5 && setup.oct === 2, `arp switched on, unlatched, UP-DN at 1/8T over 2 octaves (${setup.arpOn} ${setup.latch} ${setup.mode} ${setup.div} ${setup.oct})`);
  ok(Math.abs(setup.res - 0.5) < 1e-6 && setup.revOn === 1, 'knobs set: resonance 0.5, reverb on');
  ok(!('BOGUS_KNOB' in setup.knobs), 'unknown knobs are ignored');
  ok(setup.touched, 'the cutoff knob is highlighted as Claude turns it');
  ok(/Claude set/.test(setup.chips) && /Cutoff/.test(setup.chips) && /Arp pattern/.test(setup.chips) && /and moves/.test(setup.chips), 'panel lists what Claude set and moves: ' + setup.chips.slice(0, 120));

  // Playback: the arp runs over the held chords, melody plays directly, cutoff rises.
  const samples = [];
  for (let k = 0; k < 6; k++) {
    await page.waitForTimeout(700);
    samples.push(await page.evaluate(() => ({
      beat: synthcore.claudePlays.beat, playing: synthcore.claudePlays.playing,
      cutoff: synthcore.values[synthcore.PIDX.FLT_CUTOFF], rev: synthcore.values[synthcore.PIDX.REV_SEND], mode: synthcore.values[synthcore.PIDX.ARP_MODE],
      arpKeys: document.querySelectorAll('.key.arp').length, voices: parseInt(document.querySelector('#voiceCount').textContent, 10),
      auto: synthcore.ui.ctls.get(synthcore.PIDX.FLT_CUTOFF)[0].el.classList.contains('cl-auto')
    })));
  }
  const playingS = samples.filter((s) => s.playing);
  ok(playingS.length >= 4, 'piece plays: ' + samples.map((s) => s.beat.toFixed(1)).join(', '));
  ok(playingS.some((s) => s.arpKeys > 0), 'the arpeggiator is stepping through Claude’s chords (arp keys lit)');
  ok(playingS.every((s) => s.voices >= 1), 'voices sounding throughout: ' + playingS.map((s) => s.voices).join(','));
  const early = playingS.find((s) => s.beat < 5), late = playingS.find((s) => s.beat > 9);
  ok(early && late && late.cutoff > early.cutoff * 1.8, `cutoff automation rises: ${early && early.cutoff.toFixed(0)} Hz @${early && early.beat.toFixed(1)} → ${late && late.cutoff.toFixed(0)} Hz @${late && late.beat.toFixed(1)}`);
  ok(playingS.some((s) => s.beat > 8.5 && s.rev > 0.9), 'reverb send reaches its move target');
  ok(playingS.some((s) => s.beat > 6.5 && s.mode === 1), 'arp pattern switches to DOWN at beat 6');
  ok(playingS.every((s) => s.auto), 'automated knob is marked while playing');
  await page.screenshot({ path: __dirname + '/shot-claude-knobs.png', clip: { x: 0, y: 380, width: 1360, height: 520 } });
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({ playing: synthcore.claudePlays.playing, cutoff: synthcore.values[synthcore.PIDX.FLT_CUTOFF], auto: document.querySelectorAll('.cl-auto').length, arpKeys: document.querySelectorAll('.key.arp').length, voices: document.querySelector('#voiceCount').textContent }));
  ok(!after.playing && Math.abs(after.cutoff - 3000) < 1 && after.auto === 0, `ends with knobs where Claude left them (cutoff ${after.cutoff.toFixed(0)}), marks cleared`);
  await page.waitForTimeout(1500);
  ok(await page.evaluate(() => document.querySelectorAll('.key.arp').length === 0), 'arp stops with the piece (not latched on)');

  // "no arp" request
  await page.fill('#clPrompt', 'a slow ballad, no arp');
  await page.click('#clGo'); await page.waitForTimeout(400);
  ok(/play every note yourself: no arpeggiator/.test(await page.evaluate(() => window.__prompts[1])), '"no arp" tells Claude to play every note itself');
  await page.click('#panic'); await page.waitForTimeout(3000); await page.click('#panic');

  // Keep my sound: only arp knobs change, no sound moves.
  await page.selectOption('#presetLib', { label: 'Suitcase Rhodes' }).catch(() => {});
  await page.evaluate(() => synthcore.presets.loadFactory(synthcore.presets.lib ? [...synthcore.presets.lib.options].find((o) => o.textContent === 'Suitcase Rhodes').value | 0 : 0));
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({ cut: synthcore.values[synthcore.PIDX.FLT_CUTOFF], rev: synthcore.values[synthcore.PIDX.REV_SEND] }));
  await page.check('#clKeep');
  await page.evaluate(() => synthcore.claudePlays.play(synthcore.claudePlays.recent[0], true));
  await page.waitForTimeout(2500);
  const kept = await page.evaluate(() => ({ name: document.querySelector('#presetName').value, cut: synthcore.values[synthcore.PIDX.FLT_CUTOFF], rev: synthcore.values[synthcore.PIDX.REV_SEND], arp: synthcore.values[synthcore.PIDX.ARP_ON], arpKeys: document.querySelectorAll('.key.arp').length }));
  ok(kept.name === 'Suitcase Rhodes' && kept.cut === before.cut && kept.rev === before.rev && kept.arp === 1, `"keep my sound" keeps the patch and its knobs, still arpeggiates (${JSON.stringify(kept)})`);
  await page.click('#panic'); await page.uncheck('#clKeep'); await page.waitForTimeout(300);

  // Built-in piece with arp + moves plays offline-style.
  await page.selectOption('#clPieces', 'b:2');
  await page.waitForTimeout(2200);
  const b1 = await page.evaluate(() => ({ t: document.querySelector('#clTitle').textContent, p: document.querySelector('#presetName').value, c: synthcore.values[synthcore.PIDX.FLT_CUTOFF], arpKeys: document.querySelectorAll('.key.arp').length, chips: document.querySelector('#clKnobs').textContent }));
  await page.waitForTimeout(4000);
  const b2 = await page.evaluate(() => ({ c: synthcore.values[synthcore.PIDX.FLT_CUTOFF], beat: synthcore.claudePlays.beat }));
  ok(b1.t === 'Starfield Lullaby' && b1.p === 'Starfield Arp' && b1.arpKeys > 0, 'built-in “Starfield Lullaby” arpeggiates on Starfield Arp');
  ok(b2.c > b1.c * 1.3, `its filter opens as it plays: ${b1.c.toFixed(0)} → ${b2.c.toFixed(0)} Hz by beat ${b2.beat.toFixed(1)}`);
  await page.click('#panic');
  ok(errors.length === 0, 'no errors ' + JSON.stringify(errors));
  await browser.close();
  console.log(fail ? 'FAIL' : 'PASS');
})();

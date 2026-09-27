const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  await page.goto('file://' + __dirname + '/../dist/synthcore.html#open');
  await page.waitForTimeout(300);
  await page.mouse.click(700, 20);
  await page.waitForTimeout(1200);
  const audio = await page.textContent('#audioState');
  await page.keyboard.down('KeyA'); await page.keyboard.down('KeyD'); await page.keyboard.down('KeyG');
  await page.waitForTimeout(700);
  const during = await page.evaluate(() => ({ voices: document.querySelector('#voiceCount').textContent, cpu: document.querySelector('#cpuTxt').textContent, keysOn: document.querySelectorAll('.key.on').length, state: synthcore.synth.ctx && synthcore.synth.ctx.state }));
  // Switch to Warm Pad, move cutoff knob by drag, play chord
  await page.click('#presetSlots button:nth-child(2)');
  const knob = await page.$('#p-filter [data-p="FLT_CUTOFF"] svg');
  const box = await knob.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 60, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => ({ cutoff: synthcore.values[synthcore.PIDX.FLT_CUTOFF], preset: document.querySelector('#presetName').value, bode: document.querySelector('#bodeInfo').textContent }));
  await page.keyboard.up('KeyA'); await page.keyboard.up('KeyD'); await page.keyboard.up('KeyG');
  // Hold a chord for screenshot
  const k = await page.$('.key.wk[data-note="48"]'); const kb = await k.boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height * 0.8); await page.mouse.down();
  await page.keyboard.down('KeyH');
  await page.waitForTimeout(900);
  await page.screenshot({ path: __dirname + '/shot-top.png', fullPage: false });
  await page.screenshot({ path: __dirname + '/shot-full.png', fullPage: true });
  await page.mouse.up(); await page.keyboard.up('KeyH');
  const mobile = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await mobile.goto('file://' + __dirname + '/../dist/synthcore.html#open');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(JSON.stringify({ audio, during, after, mobileOverflowPx: overflow, errors }, null, 1));
  await browser.close();
})();

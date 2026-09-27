// iPhone silent-switch handling: the free fix (silent looping clip) starts on iOS, and the
// opt-in "Silent switch" route sends output through an <audio> element and back again.
const { chromium, devices } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  let fail = false; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); if (!c) fail = true; };
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const url = 'file://' + __dirname + '/../dist/synthcore.html';
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.addInitScript(() => {
    window.__routes = [];
    const c = AudioNode.prototype.connect, d = AudioNode.prototype.disconnect;
    AudioNode.prototype.connect = function (t, ...a) { if (this instanceof AudioWorkletNode || this instanceof ScriptProcessorNode) window.__routes.push('+' + t.constructor.name); return c.call(this, t, ...a); };
    AudioNode.prototype.disconnect = function (t, ...a) { if (t && (this instanceof AudioWorkletNode || this instanceof ScriptProcessorNode)) window.__routes.push('-' + t.constructor.name); return d.call(this, t, ...a); };
    window.__played = [];
    const pl = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__played.push(this.srcObject ? 'stream' : 'clip'); return pl.call(this); };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url); await page.waitForTimeout(400);
  ok(await page.$eval('#silentSw', (b) => !b.hidden), 'iPhone shows the Silent switch button');
  await page.tap('.brand'); await page.waitForTimeout(1500);
  let st = await page.evaluate(() => ({ played: window.__played, routes: window.__routes }));
  ok(st.played.includes('clip'), 'free fix: silent clip starts on iPhone');
  ok(st.routes.join() === '+AudioDestinationNode', 'default route is direct (no added delay): ' + st.routes.join());
  await page.tap('#silentSw'); await page.waitForTimeout(800);
  st = await page.evaluate(() => ({ played: window.__played, routes: window.__routes, on: document.querySelector('#silentSw').getAttribute('aria-pressed') }));
  ok(st.on === 'true' && st.routes.slice(-2).join() === '-AudioDestinationNode,+MediaStreamAudioDestinationNode' && st.played.includes('stream'), 'Silent switch on: output goes through the music path: ' + st.routes.join(' '));
  await page.evaluate(() => synthcore.set('ARP_ON', 0));
  await page.keyboard.down('KeyA'); await page.waitForTimeout(500);
  const v = await page.textContent('#voiceCount');
  await page.keyboard.up('KeyA');
  ok(/^1 /.test(v), 'synth still plays with the route on: ' + v);
  await page.reload(); await page.waitForTimeout(300); await page.tap('.brand'); await page.waitForTimeout(1500);
  st = await page.evaluate(() => ({ routes: window.__routes, on: document.querySelector('#silentSw').getAttribute('aria-pressed') }));
  ok(st.on === 'true' && st.routes.includes('+MediaStreamAudioDestinationNode'), 'choice remembered after reload: ' + st.routes.join(' '));
  await page.tap('#silentSw'); await page.waitForTimeout(300);
  st = await page.evaluate(() => window.__routes);
  ok(st.slice(-2).join() === '-MediaStreamAudioDestinationNode,+AudioDestinationNode', 'Silent switch off: back to the direct path');
  ok(errors.length === 0, 'no errors ' + JSON.stringify(errors));
  await ctx.close();
  const pc = await browser.newPage();
  await pc.goto(url); await pc.waitForTimeout(300);
  ok(await pc.$eval('#silentSw', (b) => b.hidden), 'PC never shows the button (unchanged)');
  await browser.close();
  console.log(fail ? 'FAIL' : 'PASS');
})();

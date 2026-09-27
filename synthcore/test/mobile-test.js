// Emulates a touch-only mobile browser (Chromium/Android profile) tapping the page for the
// first time, using real touch dispatch (not .click()) and no autoplay-policy override, to
// check whether the first-gesture audio unlock actually fires from a touch tap.
const { chromium, devices } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const device = devices['Pixel 7'];
  const browser = await chromium.launch();
  const page = await browser.newPage({ ...device });
  // Record which DOM event each resume()/buffer start happens inside, and stand in for
  // Safari's navigator.audioSession, so the iOS unlock path can be checked here.
  await page.addInitScript(() => {
    window.__unlock = [];
    const P = (window.AudioContext || window.webkitAudioContext).prototype;
    // iOS rule, emulated: the context stays 'suspended' until resume() runs inside a
    // tap-end (touchend/click) — a resume() during pointerdown/touchstart is ignored.
    const stateGet = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state').get;
    Object.defineProperty(BaseAudioContext.prototype, 'state', { configurable: true, get() { return this.__iosUnlocked ? stateGet.call(this) : 'suspended'; } });
    const r = P.resume; P.resume = function () {
      const t = window.event ? window.event.type : '-';
      window.__unlock.push('resume:' + t);
      if (t === 'touchend' || t === 'click') this.__iosUnlocked = true;
      return r.call(this);
    };
    const b = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) { window.__unlock.push('buffer:' + (window.event ? window.event.type : '-')); return b.apply(this, a); };
    if (!navigator.audioSession) Object.defineProperty(navigator, 'audioSession', { value: { type: 'auto' } });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('page: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('file://' + __dirname + '/../dist/synthcore.html');
  await page.waitForTimeout(500);

  const before = await page.textContent('#audioState');

  // Real touch tap on the brand/title area (not a synthetic mouse click).
  const box = await page.$eval('.brand', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForTimeout(1500);

  const afterTap = await page.textContent('#audioState');
  const ctxState = await page.evaluate(() => (window.synthcore && synthcore.synth.ctx) ? synthcore.synth.ctx.state : 'no-ctx');
  const mode = await page.evaluate(() => (window.synthcore ? synthcore.synth.mode : 'no-synth'));

  // Now try playing a note via a real touch on the on-screen keyboard.
  const key = await page.$('.key');
  let voicesAfterKeyTap = null;
  if (key) {
    const kb = await key.boundingBox();
    if (kb) {
      await page.touchscreen.tap(kb.x + kb.width / 2, kb.y + kb.height / 2);
      await page.waitForTimeout(600);
      voicesAfterKeyTap = await page.textContent('#voiceCount').catch(() => null);
    }
  }

  const ios = await page.evaluate(() => ({ unlock: window.__unlock, session: navigator.audioSession.type, simple: document.body.classList.contains('view-simple'),
    open: [...document.querySelectorAll('#app > section.panel')].filter((p) => getComputedStyle(p).display !== 'none' && !p.classList.contains('folded')).map((p) => p.id),
    overflow: document.documentElement.scrollWidth - window.innerWidth }));
  console.log(JSON.stringify({ before, afterTap, ctxState, mode, voicesAfterKeyTap, errors, ios }, null, 2));
  const tapEnd = ios.unlock.some((u) => /resume:(touchend|click)/.test(u)) && ios.unlock.some((u) => /buffer:(touchend|click)/.test(u));
  console.log((tapEnd ? 'ok  ' : 'FAIL') + ' resume + silent unlock buffer fire on tap-end events (what iOS accepts)');
  console.log((ios.session === 'playback' ? 'ok  ' : 'FAIL') + ' asks for the playback audio session (plays with the silent switch on)');
  console.log((ios.simple ? 'ok  ' : 'FAIL') + ' phone opens in Simple view');
  console.log((ios.open.join() === 'p-quick,p-kb' ? 'ok  ' : 'FAIL') + ' only Quick controls and Keyboard start unfolded: ' + ios.open.join());
  console.log((ios.overflow <= 0 ? 'ok  ' : 'FAIL') + ' no sideways scroll');
  const ok = /^Audio on/.test(afterTap) && ctxState === 'running' && tapEnd && ios.session === 'playback' && ios.simple && ios.open.join() === 'p-quick,p-kb' && ios.overflow <= 0;
  console.log(ok ? 'PASS' : 'FAIL');
  await browser.close();
})();

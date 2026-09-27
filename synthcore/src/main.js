// ===========================================================================
// SYNTHCORE main thread
// ===========================================================================
const DPR = Math.min(2, window.devicePixelRatio || 1);
const $ = (s, r) => (r || document).querySelector(s);
const clampN = (x, a, b) => (x < a ? a : (x > b ? b : x));
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Live parameter values (main-thread mirror of the processor's table).
const values = new Float64Array(PARAMS.length);
PARAMS.forEach((p, i) => { values[i] = p.def; });

const CSSV = (() => {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return {
    osc: g('--osc'), filter: g('--filter'), env: g('--env'), fx: g('--fx'), mod: g('--mod'),
    label: g('--label'), value: g('--value'), danger: g('--danger'), muted: g('--muted'), border: g('--border'), active: g('--active')
  };
})();

function toNorm(p, v) {
  if (p.scale === 'log') return Math.log(v / p.min) / Math.log(p.max / p.min);
  if (p.scale === 'pow3') return Math.cbrt(Math.max(0, (v - p.min) / (p.max - p.min)));
  return (v - p.min) / (p.max - p.min);
}
function fromNorm(p, n) {
  n = clampN(n, 0, 1);
  let v;
  if (p.scale === 'log') v = p.min * Math.pow(p.max / p.min, n);
  else if (p.scale === 'pow3') v = p.min + (p.max - p.min) * n * n * n;
  else v = p.min + (p.max - p.min) * n;
  if (p.kind !== 'c') v = Math.round(v);
  return clampN(v, p.min, p.max);
}
function signed(v, digits) { const s = v.toFixed(digits); return v > 0 ? '+' + s : s; }
function fmt(p, v) {
  if (p.kind === 'e') return p.opts[Math.round(v)] || '';
  if (p.kind === 'b') return v > 0.5 ? 'On' : 'Off';
  switch (p.unit) {
    case 'hz':
      if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 1 : 2) + 'k';
      return v >= 100 ? v.toFixed(0) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
    case 's': return v < 1 ? (v * 1000).toFixed(v < 0.01 ? 1 : 0) + 'ms' : v.toFixed(v < 10 ? 2 : 1) + 's';
    case 'ms': return v.toFixed(v < 10 ? 1 : 0) + 'ms';
    case 'db': return signed(v, 1) + 'dB';
    case '%': return Math.round(v * 100) + '%';
    case 'pct': return Math.round(v) + '%';
    case 'ct': return signed(v, 0) + '¢';
    case 'st': return signed(v, Number.isInteger(v) ? 0 : 1) + 'st';
    case 'oct': return signed(v, 0);
    case 'deg': return Math.round(v) + '°';
    case 'phase': return Math.round(v * 360) + '°';
    case 'x': return v.toFixed(2) + '×';
    case 'ratio': return v.toFixed(1) + ':1';
    case 'bpm': return v.toFixed(1);
    case 'bits': return v + ' bit';
    case 'div': return '÷' + v;
    case 'bi': return signed(v, 2);
    default: return p.kind === 'i' ? String(v) : v.toFixed(2);
  }
}

// ---------------------------------------------------------------------------
// Worklet loading: blob URL first (works from file:// with no server), then a
// data: URL, then a sibling file for hosts whose CSP blocks both. Each failure
// is recorded; the caller falls back to the main-thread engine if none load.
function processorFileUrl() {
  let url = null;
  try { url = new URL('synthcore-processor.js', document.baseURI).href; } catch (e) { url = null; }
  if (!url || !/^(https?|file):/i.test(url)) throw new Error('page has no usable address for synthcore-processor.js');
  return url;
}
// Some mobile browsers (in-app/webview browsers especially) leave a Promise from
// ctx.resume() or ctx.audioWorklet.addModule() permanently unsettled — neither
// resolving nor rejecting — if the audio session is restricted. Racing against a
// timeout keeps boot() from hanging forever on "Starting audio…" in that case.
function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms))
  ]);
}
async function loadWorklet(ctx, src, errs) {
  const attempts = [
    ['blob', () => URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))],
    ['data', () => 'data:application/javascript;base64,' + btoa(unescape(encodeURIComponent(src)))],
    ['file', processorFileUrl]
  ];
  for (const [name, make] of attempts) {
    try { await ctx.audioWorklet.addModule(make()); return true; } catch (e) { errs.push(`${name}: ${e && e.message ? e.message : e}`); }
  }
  return false;
}

class SynthController {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.port = null;
    this.mode = '';
    this.why = '';
    this.booting = null;
    this.queue = [];
    this.onMeter = null;
  }
  boot() {
    if (!this.booting) this.booting = this._boot();
    return this.booting;
  }
  async _boot() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not available in this browser');
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    // Some mobile browsers (notably iOS Safari) only honor ctx.resume() as a
    // user-gesture-unlocking call when it is *made* synchronously in the same
    // call stack as the gesture that triggered boot(). Everything after this
    // point (module fetch/compile, node construction) is async, so the resume
    // call is fired here, immediately, before any await — we only await its
    // result later. Fire-and-forget the rejection: some browsers throw if the
    // context is already running, which is not an error worth surfacing.
    const resumeNow = ctx.resume ? withTimeout(ctx.resume().catch(() => {}), 4000) : Promise.resolve();
    const errs = [];
    let ok = false;
    if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
      const src = buildWorkletHeader() + '\n' + document.getElementById('synthcore-processor').textContent;
      ok = await withTimeout(loadWorklet(ctx, src, errs), 6000);
      if (ok === '__timeout__') { errs.push('worklet load timed out'); ok = false; }
    } else {
      errs.push('AudioWorklet is not offered here (sandboxed or insecure page)');
    }
    if (ok) {
      const node = new AudioWorkletNode(ctx, 'synthcore-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { values: Array.from(values) }
      });
      node.connect(ctx.destination);
      node.port.onmessage = (e) => { if (this.onMeter) this.onMeter(e.data); };
      node.onprocessorerror = () => setAudioState('err', 'Audio engine stopped');
      this.node = node;
      this.port = node.port;
      this.mode = 'worklet';
    } else {
      this.bootCompat(ctx, errs);
    }
    await resumeNow;
    if (ctx.state !== 'running' && ctx.resume) {
      try { await withTimeout(ctx.resume(), 2000); } catch (e) { /* resumed on next gesture */ }
    }
    for (const m of this.queue) this.port.postMessage(m);
    this.queue.length = 0;
    return this;
  }
  // Compatibility engine: the same DSP code, run on the page thread through a
  // ScriptProcessorNode, for hosts that block or lack AudioWorklet.
  bootCompat(ctx, errs) {
    const why = errs.join(' · ');
    if (typeof SYNTHCORE_DSP !== 'function') throw new Error('audio engine could not load (' + why + ')');
    if (typeof ctx.createScriptProcessor !== 'function') throw new Error('this browser blocked the audio engine (' + why + ')');
    const self = this;
    let Cls = null;
    class PortedProcessor {
      constructor() { this.port = { onmessage: null, postMessage: (m) => { if (self.onMeter) self.onMeter(m); } }; }
    }
    SYNTHCORE_DSP(PortedProcessor, (name, c) => { Cls = c; }, ctx.sampleRate);
    const proc = new Cls({ processorOptions: { values: Array.from(values) } });
    // Ask for one input channel even though it's unused: some WebKit builds accept
    // createScriptProcessor(n, 0, 2) without throwing but then never fire
    // 'audioprocess' at all, since the node has nothing wired in to pull it. A
    // silent 1-channel input keeps the node alive on every browser we've seen.
    let spn;
    try { spn = ctx.createScriptProcessor(1024, 1, 2); } catch (e) { spn = ctx.createScriptProcessor(1024, 0, 2); }
    const outs = [[null, null]], ins = [];
    spn.onaudioprocess = (ev) => {
      const ob = ev.outputBuffer;
      const L = ob.getChannelData(0), R = ob.numberOfChannels > 1 ? ob.getChannelData(1) : null;
      for (let o = 0; o + 128 <= L.length; o += 128) {
        outs[0][0] = L.subarray(o, o + 128);
        outs[0][1] = R ? R.subarray(o, o + 128) : new Float32Array(128);
        proc.process(ins, outs);
      }
    };
    spn.connect(ctx.destination);
    this.node = spn;
    this.proc = proc;
    this.port = { postMessage: (m) => proc.handleMessage(m) };
    this.mode = 'compat';
    this.why = why;
  }
  post(m) {
    if (this.port) this.port.postMessage(m);
    else if (this.booting && (m.type === 'on' || m.type === 'off')) this.queue.push(m);
  }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }
}

// ---------------------------------------------------------------------------
// Controls
const ARC_R = 19;
function polar(a, r) { const t = a * Math.PI / 180; return [24 + r * Math.sin(t), 24 - r * Math.cos(t)]; }
function arcPath(a0, a1, r) {
  if (a1 < a0) { const t = a0; a0 = a1; a1 = t; }
  if (a1 - a0 < 0.5) return '';
  const p0 = polar(a0, r), p1 = polar(a1, r);
  return `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`;
}

function attachDrag(target, ctl, mode) {
  let drag = null;
  const posNorm = (e) => {
    const r = target.getBoundingClientRect();
    return mode === 'v' ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
  };
  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    target.focus({ preventScroll: true });
    try { target.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported */ }
    let n = toNorm(ctl.p, values[ctl.i]);
    if (mode !== 'knob') { n = clampN(posNorm(e), 0, 1); ctl.ui.set(ctl.i, fromNorm(ctl.p, n)); }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, n };
  });
  target.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    const fine = e.shiftKey ? 0.1 : 1;
    const r = target.getBoundingClientRect();
    let d;
    if (mode === 'knob') d = -dy * 0.003 * fine;
    else if (mode === 'v') d = (-dy / Math.max(20, r.height)) * fine;
    else d = (dx / Math.max(20, r.width)) * fine;
    drag.n = clampN(drag.n + d, 0, 1);
    ctl.ui.set(ctl.i, fromNorm(ctl.p, drag.n));
  });
  const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

function stepValue(ctl, dir, fine) {
  const p = ctl.p;
  if (p.kind !== 'c') { ctl.ui.set(ctl.i, clampN(values[ctl.i] + dir, p.min, p.max)); return; }
  const n = toNorm(p, values[ctl.i]) + dir * (fine ? 0.001 : 0.01);
  ctl.ui.set(ctl.i, fromNorm(p, n));
}

function attachCommon(target, ctl) {
  target.addEventListener('dblclick', (e) => { e.preventDefault(); ctl.ui.set(ctl.i, ctl.p.def); });
  target.addEventListener('contextmenu', (e) => { e.preventDefault(); ctl.ui.toggleLearn(ctl.i, ctl.el); });
  target.addEventListener('wheel', (e) => {
    e.preventDefault();
    stepValue(ctl, e.deltaY < 0 ? 1 : -1, e.shiftKey);
  }, { passive: false });
  target.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); stepValue(ctl, 1, e.shiftKey); }
    else if (k === 'ArrowDown' || k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); stepValue(ctl, -1, e.shiftKey); }
    else if (k === 'Home') { e.preventDefault(); ctl.ui.set(ctl.i, ctl.p.min); }
    else if (k === 'End') { e.preventDefault(); ctl.ui.set(ctl.i, ctl.p.max); }
  });
}

class Knob {
  constructor(el, i, ui) {
    this.el = el; this.i = i; this.p = PARAMS[i]; this.ui = ui;
    el.classList.add('knob');
    if (el.dataset.size === 'lg') el.classList.add('lg');
    const label = el.dataset.l || this.p.label;
    el.innerHTML = `<svg viewBox="0 0 48 48" tabindex="0" role="slider" aria-label="${escapeHtml(label)}"><circle class="kn-body" cx="24" cy="24" r="14"/><path class="kn-track" d="${arcPath(-135, 135, ARC_R)}"/><path class="kn-val"/><circle class="kn-dot" r="2.4"/></svg><span class="lbl"></span><span class="val"></span>`;
    el.querySelector('.lbl').textContent = label;
    this.svg = el.querySelector('svg');
    this.valPath = el.querySelector('.kn-val');
    this.dot = el.querySelector('.kn-dot');
    this.valEl = el.querySelector('.val');
    const bip = this.p.min < 0 && this.p.max > 0;
    this.zeroAngle = bip ? -135 + 270 * toNorm(this.p, 0) : -135;
    el.title = `${label} · drag · shift-drag fine · double-click reset · right-click MIDI learn`;
    attachDrag(this.svg, this, 'knob');
    attachCommon(this.svg, this);
  }
  update(v) {
    const a = -135 + 270 * clampN(toNorm(this.p, v), 0, 1);
    this.valPath.setAttribute('d', arcPath(this.zeroAngle, a, ARC_R));
    const d = polar(a, 9.5);
    this.dot.setAttribute('cx', d[0].toFixed(2));
    this.dot.setAttribute('cy', d[1].toFixed(2));
    const t = fmt(this.p, v);
    this.valEl.textContent = t;
    this.svg.setAttribute('aria-valuetext', t);
  }
}

class Slider {
  constructor(el, i, ui, vertical) {
    this.el = el; this.i = i; this.p = PARAMS[i]; this.ui = ui; this.vertical = vertical;
    el.classList.add('slider', vertical ? 'v' : 'h');
    if (el.dataset.class) el.classList.add(el.dataset.class);
    const label = el.dataset.l || this.p.label;
    el.innerHTML = `<div class="sl-track" tabindex="0" role="slider" aria-label="${escapeHtml(label)}"><div class="sl-fill"></div><div class="sl-thumb"></div></div>` +
      (vertical ? `<span class="val"></span><span class="lbl"></span>` : `<span class="val"></span>`);
    const lbl = el.querySelector('.lbl');
    if (lbl) lbl.textContent = label;
    this.track = el.querySelector('.sl-track');
    this.fill = el.querySelector('.sl-fill');
    this.thumb = el.querySelector('.sl-thumb');
    this.valEl = el.querySelector('.val');
    this.zero = this.p.min < 0 && this.p.max > 0 ? toNorm(this.p, 0) : 0;
    el.title = `${label} · drag · shift-drag fine · double-click reset · right-click MIDI learn`;
    attachDrag(this.track, this, vertical ? 'v' : 'h');
    attachCommon(this.track, this);
  }
  update(v) {
    const n = clampN(toNorm(this.p, v), 0, 1);
    const lo = Math.min(n, this.zero), hi = Math.max(n, this.zero);
    if (this.vertical) {
      this.thumb.style.bottom = (n * 100) + '%';
      this.fill.style.bottom = (lo * 100) + '%';
      this.fill.style.height = ((hi - lo) * 100) + '%';
    } else {
      this.thumb.style.left = (n * 100) + '%';
      this.fill.style.left = (lo * 100) + '%';
      this.fill.style.width = ((hi - lo) * 100) + '%';
    }
    const t = fmt(this.p, v);
    this.valEl.textContent = t;
    this.track.setAttribute('aria-valuetext', t);
  }
}

const ICONS = {
  osc: [
    null,
    ['1,9.5 5,1.5 13,9.5 17,1.5'],
    ['1,9.5 9,1.5 9,9.5 17,1.5 17,9.5'],
    ['1,9.5 1,1.5 9,1.5 9,9.5 17,9.5 17,1.5'],
    ['1,9.5 1,1.5 4,1.5 4,9.5 9,9.5 9,1.5 12,1.5 12,9.5 17,9.5'],
    ['1,9.5 9,1.5 9,9.5 17,1.5 17,9.5', '1,7.5 7,1.5 7,9.5 15,2.5 15,9.5']
  ],
  lfo: [
    null,
    ['1,9.5 5,1.5 13,9.5 17,1.5'],
    ['1,9.5 9,1.5 9,9.5 17,1.5 17,9.5'],
    ['1,1.5 9,9.5 9,1.5 17,9.5 17,1.5'],
    ['1,9.5 1,1.5 9,1.5 9,9.5 17,9.5 17,1.5'],
    ['1,6 4,6 4,2 7,2 7,9 10,9 10,4 13,4 13,8 17,8'],
    null
  ]
};
function sinePoints() {
  const pts = [];
  for (let i = 0; i <= 16; i++) pts.push(`${1 + i},${(5.5 - 4 * Math.sin(2 * Math.PI * i / 16)).toFixed(2)}`);
  return pts.join(' ');
}
function smoothPoints() {
  const ys = [6, 2.5, 8.5, 4, 7.5];
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 4, k = Math.min(3, Math.floor(t)), f = t - k;
    const y = ys[k] + (ys[k + 1] - ys[k]) * (0.5 - 0.5 * Math.cos(Math.PI * f));
    pts.push(`${1 + i},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}
function waveIcon(set, k) {
  let lines = ICONS[set][k];
  if (!lines) lines = [set === 'lfo' && k === 6 ? smoothPoints() : sinePoints()];
  return `<svg viewBox="0 0 18 11" aria-hidden="true">${lines.map((l) => `<polyline points="${l}"/>`).join('')}</svg>`;
}

class Seg {
  constructor(el, i, ui) {
    this.el = el; this.i = i; this.p = PARAMS[i]; this.ui = ui;
    el.classList.add('seg');
    const icons = el.dataset.icons;
    if (icons) el.classList.add('icons');
    el.setAttribute('role', 'radiogroup');
    el.setAttribute('aria-label', el.dataset.l || this.p.label);
    this.btns = this.p.opts.map((o, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.innerHTML = icons ? waveIcon(icons, k) + `<span>${escapeHtml(o)}</span>` : escapeHtml(o);
      b.title = o;
      b.addEventListener('click', () => ui.set(i, k));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); ui.toggleLearn(i, el); });
      el.appendChild(b);
      return b;
    });
  }
  update(v) {
    const r = Math.round(v);
    this.btns.forEach((b, k) => { b.classList.toggle('on', k === r); b.setAttribute('aria-checked', k === r ? 'true' : 'false'); });
  }
}

class Toggle {
  constructor(el, i, ui) {
    this.i = i; this.p = PARAMS[i]; this.ui = ui;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tog';
    b.textContent = el.dataset.l || this.p.label;
    b.setAttribute('aria-pressed', 'false');
    b.dataset.p = el.dataset.p;
    el.replaceWith(b);
    this.el = b;
    b.addEventListener('click', () => ui.set(i, values[i] > 0.5 ? 0 : 1));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); ui.toggleLearn(i, b); });
  }
  update(v) {
    const on = v > 0.5;
    this.el.classList.toggle('on', on);
    this.el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

class Cycle {
  constructor(el, i, ui) {
    this.i = i; this.p = PARAMS[i]; this.ui = ui;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tog cyc';
    b.title = 'Curve: linear, squared, square-root, step';
    el.replaceWith(b);
    this.el = b;
    b.addEventListener('click', () => ui.set(i, (Math.round(values[i]) + 1) % this.p.opts.length));
  }
  update(v) { this.el.textContent = this.p.opts[Math.round(v)]; }
}

class Select {
  constructor(el, i, ui) {
    this.i = i; this.p = PARAMS[i]; this.ui = ui;
    const s = document.createElement('select');
    s.className = 'sel';
    s.id = 'sel-' + this.p.id;
    s.setAttribute('aria-label', el.dataset.l || this.p.label);
    this.p.opts.forEach((o, k) => { const op = document.createElement('option'); op.value = String(k); op.textContent = o.replace(/_/g, ' '); s.appendChild(op); });
    s.addEventListener('change', () => ui.set(i, +s.value));
    el.replaceWith(s);
    this.el = s;
    this.dimEl = s.closest('[data-dimwrap]') || s;
  }
  update(v) { this.el.value = String(Math.round(v)); }
}

class Check {
  constructor(el, i, ui) {
    this.i = i; this.p = PARAMS[i]; this.ui = ui;
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.id = 'chk-' + this.p.id;
    c.setAttribute('aria-label', el.dataset.l || this.p.label);
    c.addEventListener('change', () => ui.set(i, c.checked ? 1 : 0));
    el.replaceWith(c);
    this.el = c;
  }
  update(v) { this.el.checked = v > 0.5; }
}

// ---------------------------------------------------------------------------
class UIController {
  constructor(synth) {
    this.synth = synth;
    this.ctls = new Map();
    this.subs = [];
    this.learnI = -1;
    this.learnEl = null;
    this.bindings = {};
    try {
      const raw = localStorage.getItem('synthcore_midi_map');
      if (raw) this.bindings = JSON.parse(raw) || {};
    } catch (e) { this.bindings = {}; }
    const L = (id, fn) => [id, fn];
    const V = (id) => values[PIDX[id]];
    this.dimRules = [
      L('OSC1_PW', () => V('OSC1_WAVE') !== 4), L('OSC2_PW', () => V('OSC2_WAVE') !== 4),
      L('OSC1_SPREAD', () => V('OSC1_WAVE') !== 5), L('OSC2_SPREAD', () => V('OSC2_WAVE') !== 5),
      L('FLT_MODE', () => V('FLT_TYPE') === 1), L('FLT_DRIVE', () => V('FLT_SHAPER') === 0),
      L('WS_BITS', () => V('WS_MODE') !== 3), L('WS_SRDIV', () => V('WS_MODE') !== 3),
      L('DLY_TIME', () => V('DLY_SYNC') > 0.5), L('DLY_DIV', () => V('DLY_SYNC') < 0.5),
      L('UNI_DETUNE', () => V('UNISON') < 2), L('UNI_WIDTH', () => V('UNISON') < 2)
    ];
    for (let k = 1; k <= 4; k++) {
      this.dimRules.push(L(`LFO${k}_RATE`, () => V(`LFO${k}_SYNC`) > 0.5));
      this.dimRules.push(L(`LFO${k}_DIV`, () => V(`LFO${k}_SYNC`) < 0.5));
    }
  }
  hydrate(root) {
    root.querySelectorAll('[data-p][data-t]').forEach((el) => {
      const i = PIDX[el.dataset.p];
      if (i === undefined) throw new Error('Unknown parameter ' + el.dataset.p);
      const t = el.dataset.t;
      let ctl = null;
      if (t === 'knob') ctl = new Knob(el, i, this);
      else if (t === 'vs') ctl = new Slider(el, i, this, true);
      else if (t === 'hs') ctl = new Slider(el, i, this, false);
      else if (t === 'seg') ctl = new Seg(el, i, this);
      else if (t === 'tog') ctl = new Toggle(el, i, this);
      else if (t === 'sel') ctl = new Select(el, i, this);
      else if (t === 'cyc') ctl = new Cycle(el, i, this);
      else if (t === 'chk') ctl = new Check(el, i, this);
      if (ctl) this.register(i, ctl);
    });
    this.markLearned();
    this.applyDims();
  }
  register(i, ctl) {
    if (!this.ctls.has(i)) this.ctls.set(i, []);
    this.ctls.get(i).push(ctl);
    ctl.update(values[i]);
  }
  set(i, v, send = true) {
    const p = PARAMS[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    if (p.kind !== 'c') v = Math.round(v);
    v = clampN(v, p.min, p.max);
    if (values[i] === v) return;
    values[i] = v;
    const cs = this.ctls.get(i);
    if (cs) for (const c of cs) c.update(v);
    if (send) this.synth.post({ type: 'p', i, v });
    this.applyDims();
    for (const f of this.subs) f(i, v);
  }
  setNorm(i, n) { this.set(i, fromNorm(PARAMS[i], n)); }
  refreshAll() {
    for (const [i, cs] of this.ctls) for (const c of cs) c.update(values[i]);
    this.applyDims();
    for (const f of this.subs) f(-1, 0);
  }
  onChange(f) { this.subs.push(f); }
  applyDims() {
    for (const [id, fn] of this.dimRules) {
      const cs = this.ctls.get(PIDX[id]);
      if (!cs) continue;
      const d = fn();
      for (const c of cs) (c.dimEl || c.el).classList.toggle('dim', d);
    }
  }
  toggleLearn(i, el) {
    if (this.learnI === i) { this.cancelLearn(); return; }
    this.cancelLearn();
    this.learnI = i;
    this.learnEl = el;
    el.classList.add('learning');
    showNotice(`MIDI learn: move a controller to assign ${PARAMS[i].label}. Right-click again or press Esc to cancel.`, 'warn');
  }
  cancelLearn() {
    if (this.learnEl) this.learnEl.classList.remove('learning');
    if (this.learnI >= 0) showNotice(null);
    this.learnI = -1;
    this.learnEl = null;
  }
  bindCC(cc) {
    const id = PARAMS[this.learnI].id;
    for (const k of Object.keys(this.bindings)) if (this.bindings[k] === id) delete this.bindings[k];
    this.bindings[cc] = id;
    try { localStorage.setItem('synthcore_midi_map', JSON.stringify(this.bindings)); } catch (e) { /* stays in memory */ }
    const label = PARAMS[this.learnI].label;
    this.cancelLearn();
    this.markLearned();
    showNotice(`CC ${cc} now controls ${label}`, 'live', 2500);
  }
  markLearned() {
    const bound = new Set(Object.values(this.bindings));
    for (const [i, cs] of this.ctls) for (const c of cs) c.el.classList.toggle('learned', bound.has(PARAMS[i].id));
  }
}

// ---------------------------------------------------------------------------
let noticeTimer = 0;
let midiStatus = { text: 'MIDI —', cls: '' };
function showNotice(text, cls, ms) {
  const el = $('#midiState');
  clearTimeout(noticeTimer);
  if (!text) { el.textContent = midiStatus.text; el.className = 'pill ' + midiStatus.cls; return; }
  el.textContent = text;
  el.className = 'pill ' + (cls || '');
  if (ms) noticeTimer = setTimeout(() => showNotice(null), ms);
}
function setMidiStatus(text, cls) { midiStatus = { text, cls: cls || '' }; showNotice(null); }
function setAudioState(kind, text) {
  const el = $('#audioState');
  if (kind === 'live') { el.textContent = text; el.className = 'pill live'; }
  else if (kind === 'err') { el.textContent = text; el.className = 'pill err'; }
  else { el.textContent = text; el.className = 'pill warn'; }
  // Fixed-width pill (see CSS), so the full message also lives in the tooltip.
  if (!el.dataset.why) el.title = text;
}

// ---------------------------------------------------------------------------
class VisualsRenderer {
  constructor(synth, ui) {
    this.synth = synth;
    this.ui = ui;
    this.crt = { scope: new CRTScreen($('#scope'), 320, 200), phase: new CRTScreen($('#phase'), 320, 200), xy: new CRTScreen($('#xy'), 320, 200) };
    this.spec = new Spectrogram($('#spectro'), 900, 160, synth.sampleRate);
    this.queue = new StreamQueue(1 << 16);
    this.trig = new SweepTrigger(256);
    this.hist = new Float32Array(2048);
    this.histPos = 0;
    this.acc = 0;
    this.lastFrame = 0;
    this.visible = true;
    this.costMs = 0;
    this.scopeCfg = { intensity: 0.5, persistence: 0.4, trigger: 'auto' };
    this.initScopeControls();
    this.buildFreqAxis();
    this.arpScr = this.prep($('#arpView'), 480, 110, 1);
    this.bode = this.prep($('#bode'), 400, 100, 1);
    this.lag = 12;
    this.arpSeq = new Int16Array(0);
    this.arpPos = -1;
    this.arpRun = false;
    this.vu = [this.prep($('#vuL'), 20, 120, 1), this.prep($('#vuR'), 20, 120, 1)];
    this.adsr = [1, 2, 3, 4].map((k) => this.prep($('#adsr' + k), 80, 30, 2));
    this.hold = [{ v: -120, t: 0 }, { v: -120, t: 0 }];
    this.rms = [0, 0];
    this.envSnap = null;
    this.cpu = 0;
    this.bodeTimer = 0;
    this.lastScope = new Float32Array(256);
    this.buildVuScale();
    this.drawArp();
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((es) => { for (const e of es) this.visible = e.isIntersecting; }) : null;
    if (io) io.observe($('#p-scr-body') || $('#p-scr'));
    requestAnimationFrame((t) => this.frame(t));
    this.drawVU(0, 0, 0); this.drawVU(1, 0, 0);
    this.drawBode();
    for (let k = 0; k < 4; k++) this.drawAdsr(k);
    ui.onChange((i) => {
      if (i < 0) { this.scheduleBode(); for (let k = 0; k < 4; k++) this.drawAdsr(k); return; }
      const id = PARAMS[i].id;
      if (id.startsWith('FLT_')) this.scheduleBode();
      if (id.startsWith('ARP_') || id === 'BPM') this.drawArp();
      const m = /^ENV(\d)_/.exec(id);
      if (m) this.drawAdsr(+m[1] - 1);
    });
  }
  prep(c, w, h, extra) {
    const s = DPR * extra;
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, 0, 0);
    return { c, g, w, h };
  }
  buildVuScale() {
    const el = $('#vuScale');
    const marks = [[0, '0'], [-6, '−6'], [-14, '0 VU'], [-24, '−24'], [-36, '−36'], [-48, '−48']];
    el.innerHTML = marks.map(([d, t]) => `<span style="top:${(-d / 48) * 100}%">${t}</span>`).join('');
  }
  onMeter(m) {
    if (!m || m.type !== 'meter') return;
    if (m.scope) this.lastScope = m.scope;
    if (typeof m.lag === 'number' && m.lag !== this.lag) { this.lag = m.lag; $('#lagTxt').textContent = `τ ${m.lag} smp`; }
    if (m.strL && m.strL.length) this.queue.push(m.strL, m.strR);
    let arpChanged = false;
    if (m.arpSeq) { this.arpSeq = m.arpSeq; arpChanged = true; }
    if (m.arpPos !== this.arpPos || m.arpRun !== this.arpRun) { this.arpPos = m.arpPos; this.arpRun = !!m.arpRun; arpChanged = true; }
    if (arpChanged) this.drawArp();
    this.drawVU(0, m.rmsL, m.peakL);
    this.drawVU(1, m.rmsR, m.peakR);
    const gr = Math.max(0, m.gr || 0);
    $('#grFill').style.width = Math.min(100, gr / 24 * 100) + '%';
    $('#grTxt').textContent = (gr > 0.05 ? '−' : '') + gr.toFixed(1) + ' dB';
    this.cpu += ((m.cpu || 0) - this.cpu) * 0.2;
    const pct = Math.min(100, this.cpu * 100);
    const fill = $('#cpuFill');
    fill.style.width = pct + '%';
    fill.style.background = pct > 70 ? CSSV.danger : (pct > 45 ? CSSV.mod : CSSV.env);
    $('#cpuTxt').textContent = pct.toFixed(0) + '%';
    $('#voiceCount').textContent = `${m.voices} / 8 voices`;
    const wasActive = this.envSnap && this.envSnap.some((v, k) => k % 3 === 0 && v !== 0);
    this.envSnap = m.envs;
    const active = m.envs && Array.prototype.some.call(m.envs, (v, k) => k % 3 === 0 && v !== 0);
    if (active || wasActive) for (let k = 0; k < 4; k++) this.drawAdsr(k);
  }
  // Phosphor persistence: fade what is on the tube toward transparent (the
  // graticule is the CSS layer behind it), then add the new trace with additive glow.
  beam(scr, pathFn) {
    const g = scr.g;
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const passes = [[6, 'rgba(61,255,110,0.07)'], [3, 'rgba(61,255,110,0.18)'], [1.3, 'rgba(160,255,185,0.9)']];
    for (const [lw, col] of passes) {
      g.lineWidth = lw;
      g.strokeStyle = col;
      g.beginPath();
      pathFn(g);
      g.stroke();
    }
    g.restore();
  }
  spot(scr, x, y) {
    const g = scr.g;
    g.save();
    g.globalCompositeOperation = 'lighter';
    const r = g.createRadialGradient(x, y, 0, x, y, 7);
    r.addColorStop(0, 'rgba(200,255,215,0.9)');
    r.addColorStop(0.3, 'rgba(61,255,110,0.45)');
    r.addColorStop(1, 'rgba(61,255,110,0)');
    g.fillStyle = r;
    g.fillRect(x - 8, y - 8, 16, 16);
    g.restore();
  }
  initScopeControls() {
    const cfg = this.scopeCfg;
    try { Object.assign(cfg, JSON.parse(localStorage.getItem('synthcore_scope') || '{}')); } catch (e) { /* defaults */ }
    const save = () => { try { localStorage.setItem('synthcore_scope', JSON.stringify(cfg)); } catch (e) { /* not persisted */ } };
    const intEl = $('#crtInt'), persEl = $('#crtPers');
    const show = () => {
      $('#crtIntTxt').textContent = this.intensity().toFixed(1) + '×';
      const t = this.tau();
      $('#crtPersTxt').textContent = t < 1 ? Math.round(t * 1000) + ' ms' : t.toFixed(2) + ' s';
      document.querySelectorAll('#crtTrig button').forEach((b) => {
        const on = b.dataset.v === cfg.trigger;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      $('#tbTxt').textContent = `${(256 / this.synth.sampleRate / 10 * 1000).toFixed(2)} ms/div · trig ↑ ${cfg.trigger}`;
    };
    intEl.value = String(cfg.intensity);
    persEl.value = String(cfg.persistence);
    intEl.addEventListener('input', () => { cfg.intensity = +intEl.value; show(); save(); });
    persEl.addEventListener('input', () => { cfg.persistence = +persEl.value; show(); save(); });
    intEl.addEventListener('dblclick', () => { cfg.intensity = 0.5; intEl.value = '0.5'; show(); save(); });
    persEl.addEventListener('dblclick', () => { cfg.persistence = 0.4; persEl.value = '0.4'; show(); save(); });
    document.querySelectorAll('#crtTrig button').forEach((b) => b.addEventListener('click', () => { cfg.trigger = b.dataset.v; show(); save(); }));
    this.showScopeCfg = show;
    show();
  }
  intensity() { return 0.25 * Math.pow(16, this.scopeCfg.intensity); }
  tau() { return 0.02 * Math.pow(100, this.scopeCfg.persistence); }
  buildFreqAxis() {
    const el = $('#fAxis'), sp = this.spec;
    el.innerHTML = [50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((f) => f > sp.fmin && f < sp.fmax).map((f) => {
      const y = (1 - Math.log(f / sp.fmin) / Math.log(sp.fmax / sp.fmin)) * 100;
      return `<span style="top:${y.toFixed(2)}%">${f >= 1000 ? f / 1000 + 'k' : f}</span>`;
    }).join('');
    const cv = $('#spectro'), txt = $('#specTxt'), idle = txt.textContent;
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      const f = sp.freqAt(((e.clientY - r.top) / r.height) * sp.H);
      const midi = 69 + 12 * Math.log2(f / 440), n = Math.round(midi), cents = Math.round((midi - n) * 100);
      const ago = ((1 - (e.clientX - r.left) / r.width) * sp.W * sp.hop / sp.sr).toFixed(1);
      txt.textContent = `${f < 1000 ? f.toFixed(0) + ' Hz' : (f / 1000).toFixed(2) + ' kHz'} · ${noteName(n)} ${cents >= 0 ? '+' : ''}${cents}¢ · ${ago} s ago`;
    });
    cv.addEventListener('pointerleave', () => { txt.textContent = idle; });
  }
  // One animation frame: play the queued audio through the beams in real time.
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = now;
    const sr = this.synth.sampleRate, q = this.queue;
    const live = !!this.synth.node && this.synth.ctx && this.synth.ctx.state === 'running';
    let n;
    if (live) {
      const target = sr * 0.06;
      if (q.avail > sr * 0.3) q.r = q.w - Math.round(target);
      const rate = Math.min(1.25, Math.max(0.8, 1 + 0.5 * (q.avail - target) / target));
      this.acc += sr * dt * rate;
      n = Math.min(Math.floor(this.acc), q.avail);
      this.acc -= n;
      if (this.acc > sr * 0.1) this.acc = 0;
    } else {
      // No signal yet: a powered scope still free-runs its trace and parks the X-Y spot.
      n = Math.round(sr * dt);
      q.r = q.w;
    }
    if (!this.visible) {
      if (live) q.r += n;
      this.showCost(0);
      return;
    }
    const t0 = performance.now();
    this.run(n, live, dt);
    // Slow device: keep feeding the beams every frame but light the tubes at half rate.
    this.pendDt = (this.pendDt || 0) + dt;
    this.fc = (this.fc || 0) + 1;
    if (this.costMs < 7 || (this.fc & 1) === 0) {
      const tau = this.tau(), k = this.intensity();
      for (const key of ['scope', 'phase', 'xy']) this.crt[key].present(this.pendDt, tau, k);
      this.spec.present();
      this.pendDt = 0;
    }
    this.showCost(performance.now() - t0);
  }
  showCost(ms) {
    this.costMs += (ms - this.costMs) * 0.05;
    if (!this._costT || performance.now() - this._costT > 500) {
      this._costT = performance.now();
      const el = $('#crtCost');
      if (el) el.textContent = `display ${this.costMs.toFixed(1)} ms/frame`;
    }
  }
  run(n, live, dt) {
    const q = this.queue, sz = q.size, sr = this.synth.sampleRate, e = 1 / sr;
    const S = this.crt.scope, P = this.crt.phase, X = this.crt.xy, tr = this.trig, sp = this.spec;
    if (sp.sr !== sr) { sp.setRate(sr); this.buildFreqAxis(); }
    let pk = 0, pkL = 0;
    for (let i = 0; i < n; i++) {
      const k = (q.r + i) % sz;
      const L = live ? q.L[k] : 0, R = live ? q.R[k] : 0;
      const m = 0.5 * (L + R);
      const am = m < 0 ? -m : m, aL = Math.max(L < 0 ? -L : L, R < 0 ? -R : R);
      if (am > pk) pk = am;
      if (aL > pkL) pkL = aL;
      if (live) sp.push(m);
      // CH1: triggered sweep
      const v = m * S.gain;
      if (tr.state === 0) {
        tr.wait++;
        if (v < -0.04) tr.below = true;
        const edge = tr.below && tr.prev <= 0 && v > 0;
        if (edge || (this.scopeCfg.trigger === 'auto' && tr.wait > sr * 0.05)) {
          tr.state = 1; tr.idx = 0; tr.wait = 0; tr.below = false; S.penUp();
        }
      }
      if (tr.state === 1) {
        const x = 6 + (tr.idx / (tr.len - 1)) * (S.W - 12);
        S.point(x, S.H / 2 - Math.max(-1.08, Math.min(1.08, v)) * (S.H / 2 - 8), e);
        if (++tr.idx >= tr.len) { tr.state = 0; S.penUp(); }
      }
      tr.prev = v;
      // CH2: phase portrait x[n] against x[n - tau]
      const hp = this.histPos;
      this.hist[hp] = m;
      this.histPos = (hp + 1) & 2047;
      const lag = Math.max(1, Math.min(1024, this.lag | 0));
      const mb = this.hist[(hp - lag + 2048) & 2047];
      const pa = Math.min(P.W, P.H) / 2 - 8;
      P.point(P.W / 2 + Math.max(-1.1, Math.min(1.1, m * P.gain)) * pa, P.H / 2 - Math.max(-1.1, Math.min(1.1, mb * P.gain)) * pa, e);
      // X-Y: left on X, right on Y
      const xa = Math.min(X.W, X.H) / 2 - 8;
      X.point(X.W / 2 + Math.max(-1.1, Math.min(1.1, L * X.gain)) * xa, X.H / 2 - Math.max(-1.1, Math.min(1.1, R * X.gain)) * xa, e);
    }
    q.r += live ? n : 0;
    S.track(pk, dt); P.track(pk, dt); X.track(pkL, dt);
  }
  // Legacy stroke helpers: still used by the arp step trace and the filter plot.
  drawArp() {
    const scr = this.arpScr, { g, w, h } = scr;
    const on = values[PIDX.ARP_ON] > 0.5;
    const seq = this.arpSeq, n = on ? seq.length : 0;
    const modeName = PARAMS[PIDX.ARP_MODE].opts[values[PIDX.ARP_MODE]];
    const divName = PARAMS[PIDX.ARP_DIV].opts[values[PIDX.ARP_DIV]];
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(61,255,110,0.08)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 16; i++) { const x = Math.round(i * w / 16) + 0.5; g.moveTo(x, 0); g.lineTo(x, h); }
    for (let j = 1; j < 4; j++) { const y = Math.round(j * h / 4) + 0.5; g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    const info = $('#arpInfo');
    if (!on || n === 0) {
      g.fillStyle = CSSV.muted;
      g.font = `600 11px ${getComputedStyle(document.body).getPropertyValue('--mono')}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(on ? 'HOLD KEYS TO START' : 'ARP OFF · KEYS PLAY DIRECTLY', w / 2, h / 2);
      g.textAlign = 'start';
      info.textContent = on ? `${modeName} · ${divName} · waiting` : 'Arp off';
      return;
    }
    let lo = 127, hi = 0;
    for (let i = 0; i < n; i++) { if (seq[i] < lo) lo = seq[i]; if (seq[i] > hi) hi = seq[i]; }
    if (hi - lo < 12) { const mid = (hi + lo) / 2; lo = mid - 6; hi = mid + 6; }
    const padX = 6, padY = 12;
    const sw = (w - padX * 2) / n;
    const yOf = (note) => h - padY - (note - lo) / (hi - lo) * (h - padY * 2);
    this.beam(scr, (gg) => {
      for (let i = 0; i < n; i++) {
        const x0 = padX + i * sw, y = yOf(seq[i]);
        if (i === 0) gg.moveTo(x0, y); else gg.lineTo(x0, y);
        gg.lineTo(x0 + sw, y);
      }
    });
    if (this.arpRun && this.arpPos >= 0 && this.arpPos < n) {
      const x0 = padX + this.arpPos * sw, y = yOf(seq[this.arpPos]);
      g.fillStyle = 'rgba(61,255,110,0.12)';
      g.fillRect(x0, 0, Math.max(2, sw), h);
      this.spot(scr, x0 + sw / 2, y);
    }
    g.fillStyle = CSSV.muted;
    g.font = `9px ${getComputedStyle(document.body).getPropertyValue('--mono')}`;
    g.textBaseline = 'top';
    g.fillText(noteName(Math.round(hi)), 3, 2);
    g.textBaseline = 'bottom';
    g.fillText(noteName(Math.round(lo)), 3, h - 2);
    const posTxt = this.arpRun && this.arpPos >= 0 ? `step ${this.arpPos + 1}/${n}` : `${n} steps`;
    info.textContent = `${modeName} · ${divName} · ${posTxt}`;
  }
  drawVU(ch, rms, peak) {
    const { g, w, h } = this.vu[ch];
    const now = performance.now();
    const db = 20 * Math.log10((rms || 0) + 1e-9);
    const pdb = 20 * Math.log10((peak || 0) + 1e-9);
    const hold = this.hold[ch];
    if (pdb >= hold.v || now - hold.t > 3000) { hold.v = pdb; hold.t = now; }
    const yOf = (d) => h - (clampN(d, -48, 0) + 48) / 48 * h;
    const zones = [[-48, -14, CSSV.env], [-14, -6, CSSV.mod], [-6, 0, CSSV.danger]];
    g.clearRect(0, 0, w, h);
    for (const [lo, hi, col] of zones) {
      const y0 = yOf(hi), y1 = yOf(lo);
      g.globalAlpha = 0.12;
      g.fillStyle = col;
      g.fillRect(2, y0, w - 4, y1 - y0);
      g.globalAlpha = 1;
      const top = Math.max(y0, yOf(db));
      if (db > lo && top < y1) g.fillRect(2, top, w - 4, y1 - top);
    }
    g.fillStyle = 'rgba(210,255,220,0.45)';
    g.fillRect(0, Math.round(yOf(-14)), w, 1);
    if (hold.v > -48) {
      g.fillStyle = hold.v > -6 ? CSSV.danger : (hold.v > -14 ? CSSV.mod : CSSV.value);
      g.fillRect(2, Math.round(yOf(hold.v)), w - 4, 2);
    }
  }
  scheduleBode() {
    clearTimeout(this.bodeTimer);
    this.bodeTimer = setTimeout(() => this.drawBode(), 16);
  }
  drawBode() {
    const { g, w, h } = this.bode;
    const sr = this.synth.sampleRate;
    const V = (id) => values[PIDX[id]];
    const fc = V('FLT_CUTOFF'), res = V('FLT_RES'), type = V('FLT_TYPE'), mode = V('FLT_MODE');
    const R = 1.1 - Math.min(res, 1.1) + 0.001;
    const fcS = clampN(fc, 20, sr * 0.49);
    const wc = Math.tan(Math.PI * fcS / sr);
    const fcL = clampN(fc, 20, sr * 0.45);
    const k = 4 * Math.min(res, 1);
    const xOf = (f) => Math.log(f / 20) / Math.log(1000) * w;
    const yOf = (db) => (24 - db) / 72 * h;
    g.clearRect(0, 0, w, h);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(61,255,110,0.08)';
    g.beginPath();
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(xOf(f)) + 0.5; g.moveTo(x, 0); g.lineTo(x, h); }
    for (const d of [12, -12, -24, -36]) { const y = Math.round(yOf(d)) + 0.5; g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    g.strokeStyle = 'rgba(61,255,110,0.2)';
    g.beginPath(); g.moveTo(0, Math.round(yOf(0)) + 0.5); g.lineTo(w, Math.round(yOf(0)) + 0.5); g.stroke();
    g.fillStyle = CSSV.muted;
    g.font = `9px ${getComputedStyle(document.body).getPropertyValue('--mono')}`;
    g.textBaseline = 'bottom';
    for (const [f, t] of [[100, '100'], [1000, '1k'], [10000, '10k']]) g.fillText(t, xOf(f) + 3, h - 2);
    g.textBaseline = 'top';
    g.fillText('+12', 3, yOf(12) + 1);
    g.fillText('0 dB', 3, yOf(0) + 1);
    g.fillText('−24', 3, yOf(-24) + 1);

    const pts = [];
    for (let i = 0; i < 200; i++) {
      const f = 20 * Math.pow(1000, i / 199);
      let mag = 1;
      if (type !== 1) {
        const ww = Math.tan(Math.PI * Math.min(f, sr * 0.4999) / sr) / wc;
        const dr = 1 - ww * ww, di = 2 * R * ww;
        let nr, ni;
        switch (mode) {
          case 1: nr = -ww * ww; ni = 0; break;
          case 2: nr = 0; ni = ww; break;
          case 3: nr = 1 - ww * ww; ni = 0; break;
          case 4: nr = 1 + ww * ww; ni = 2 * R * ww; break;
          default: nr = 1; ni = 0;
        }
        mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
      }
      if (type !== 0) {
        const ww = f / fcL;
        const a = 1 - ww * ww;
        const re = a * a - 4 * ww * ww, im = 4 * ww * a;
        const dr = re + k, di = im;
        mag *= (1 + 0.5 * k) / Math.sqrt(dr * dr + di * di);
      }
      const db = 20 * Math.log10(mag + 1e-12);
      pts.push([xOf(f), clampN(yOf(db), -2, h + 2)]);
    }
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(61,255,110,0.22)');
    grad.addColorStop(1, 'rgba(61,255,110,0.01)');
    g.beginPath();
    g.moveTo(pts[0][0], h);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(pts[pts.length - 1][0], h);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    this.beam(this.bode, (gg) => pts.forEach(([x, y], i) => (i ? gg.lineTo(x, y) : gg.moveTo(x, y))));
    const selfOsc = (type !== 1 && res >= 1.0) || (type !== 0 && res >= 0.9);
    if (selfOsc) {
      const x = xOf(clampN(fc, 20, 20000));
      g.strokeStyle = CSSV.active;
      g.lineWidth = 2;
      g.shadowColor = CSSV.filter;
      g.shadowBlur = 8;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.shadowBlur = 0;
    }
    const q = 1 / (2 * R);
    const tName = PARAMS[PIDX.FLT_TYPE].opts[type];
    const mName = type === 1 ? '24 dB LP' : PARAMS[PIDX.FLT_MODE].opts[mode];
    $('#bodeInfo').textContent = `${tName} ${mName} · ${fmt(PARAMS[PIDX.FLT_CUTOFF], fc)} Hz · ${type === 1 ? 'k ' + k.toFixed(2) : 'Q ' + q.toFixed(2)}${selfOsc ? ' · self-osc' : ''}`;
  }
  drawAdsr(k) {
    const { g, w, h } = this.adsr[k];
    const b = PIDX[`ENV${k + 1}_A`];
    const A = values[b], H = values[b + 1], D = values[b + 2], S = values[b + 3], Rl = values[b + 4], curve = values[b + 5];
    const warp = (t) => Math.sqrt(Math.max(t, 0));
    const pad = 2, top = 3, bot = h - 3;
    const span = w - pad * 2;
    const wa = warp(A), wh = warp(H), wd = warp(D), wr = warp(Rl);
    const tot = wa + wh + wd + wr || 1;
    const sw = span * 0.18;
    const sc = (span - sw) / tot;
    const xA = pad, xH = xA + wa * sc, xD = xH + wh * sc, xS = xD + wd * sc, xR = xS + sw, xE = xR + wr * sc;
    const Y = (lv) => bot - lv * (bot - top);
    const shape = (p) => (curve === 1 ? (1 - Math.exp(-5 * p)) / (1 - Math.exp(-5)) : curve === 2 ? Math.log(1 + 99 * p) / Math.log(100) : p);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(61,255,110,0.12)';
    g.lineWidth = 0.5;
    g.beginPath(); g.moveTo(0, Y(S) + 0.25); g.lineTo(w, Y(S) + 0.25); g.stroke();
    const path = [];
    for (let i = 0; i <= 24; i++) { const p = i / 24; path.push([xA + (xH - xA) * p, Y(shape(p))]); }
    path.push([xD, Y(1)]);
    for (let i = 1; i <= 24; i++) { const t = i / 24; path.push([xD + (xS - xD) * t, Y(S + (1 - S) * Math.exp(-LN1000 * t))]); }
    path.push([xR, Y(S)]);
    for (let i = 1; i <= 24; i++) { const t = i / 24; path.push([xR + (xE - xR) * t, Y(S * Math.exp(-LN1000 * t))]); }
    g.beginPath();
    g.moveTo(path[0][0], bot);
    for (const [x, y] of path) g.lineTo(x, y);
    g.lineTo(xE, bot);
    g.closePath();
    g.fillStyle = 'rgba(61,255,110,0.12)';
    g.fill();
    g.save();
    g.beginPath();
    path.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = CSSV.env;
    g.lineWidth = 1;
    g.shadowColor = CSSV.env;
    g.shadowBlur = 3;
    g.stroke();
    g.restore();
    const s = this.envSnap;
    if (s) {
      const st = s[k * 3], lv = s[k * 3 + 1], pr = s[k * 3 + 2];
      let x = -1;
      if (st === 1) x = xA + (xH - xA) * pr;
      else if (st === 2) x = xH + (xD - xH) * pr;
      else if (st === 3) x = xD + (xS - xD) * pr;
      else if (st === 4) x = xS + sw * 0.5;
      else if (st === 5) x = xR + (xE - xR) * pr;
      if (x >= 0) {
        g.beginPath();
        g.arc(x, Y(clampN(lv, 0, 1)), 1.8, 0, Math.PI * 2);
        g.fillStyle = CSSV.value;
        g.shadowColor = CSSV.env;
        g.shadowBlur = 4;
        g.fill();
        g.shadowBlur = 0;
      }
    }
  }
}
const LN1000 = Math.log(1000);

// ---------------------------------------------------------------------------
// Central note bus: every input source goes through here so the on-screen
// keyboard shows notes from QWERTY, mouse, touch and MIDI alike.
class NoteBus {
  constructor(synth) {
    this.synth = synth;
    this.count = new Uint8Array(128);
    this.vel = new Uint8Array(128);
    this.listeners = [];
    this.lastVel = 0;
  }
  on(n, v, ch = 0) {
    if (n < 0 || n > 127) return;
    v = clampN(Math.round(v), 1, 127);
    this.synth.post({ type: 'on', n, v, c: ch });
    this.count[n] = Math.min(255, this.count[n] + 1);
    this.vel[n] = v;
    this.lastVel = v;
    this.emit(n);
  }
  off(n, ch = 0) {
    if (n < 0 || n > 127) return;
    this.synth.post({ type: 'off', n, c: ch });
    if (this.count[n]) this.count[n]--;
    this.emit(n);
  }
  pressure(n, v) { this.synth.post({ type: 'pat', n, v }); }
  clear() { this.count.fill(0); for (let n = 0; n < 128; n++) this.emit(n); }
  emit(n) { for (const f of this.listeners) f(n, this.count[n], this.vel[n]); }
}

const QWERTY = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16
};
const QWERTY_LABEL = {
  KeyA: 'A', KeyW: 'W', KeyS: 'S', KeyE: 'E', KeyD: 'D', KeyF: 'F', KeyT: 'T', KeyG: 'G', KeyY: 'Y', KeyH: 'H',
  KeyU: 'U', KeyJ: 'J', KeyK: 'K', KeyO: 'O', KeyL: 'L', KeyP: 'P', Semicolon: ';'
};

class KeyboardHandler {
  constructor(notes) {
    this.notes = notes;
    this.kb = $('#kb');
    this.base = 36;
    this.qOct = 4;
    this.qVel = 100;
    this.keys = new Map();
    this.pointers = new Map();
    this.codeNotes = new Map();
    this.build();
    this.bind();
    notes.listeners.push((n, c, v) => {
      const k = this.keys.get(n);
      if (!k) return;
      k.classList.toggle('on', c > 0);
      k.style.setProperty('--v', (v / 127).toFixed(3));
    });
  }
  build() {
    const kb = this.kb;
    kb.innerHTML = '';
    this.keys.clear();
    const black = [1, 3, 6, 8, 10];
    const count = 37;
    const whites = [];
    for (let n = this.base; n < this.base + count; n++) if (!black.includes(n % 12)) whites.push(n);
    const W = 100 / whites.length;
    let wi = 0;
    for (let n = this.base; n < this.base + count; n++) {
      const isBlack = black.includes(n % 12);
      const el = document.createElement('div');
      el.className = 'key ' + (isBlack ? 'bk' : 'wk');
      el.dataset.note = String(n);
      el.setAttribute('aria-label', noteName(n));
      if (isBlack) {
        const bw = W * 0.62;
        el.style.left = `calc(${wi * W - bw / 2}% )`;
        el.style.width = bw + '%';
      } else {
        if (n % 12 === 0) el.innerHTML = `<span class="cname">${noteName(n)}</span>`;
        wi++;
      }
      el.insertAdjacentHTML('beforeend', '<span class="klabel"></span>');
      if (this.marks) for (const cls of Object.keys(this.marks)) if (this.marks[cls].has(n)) el.classList.add(cls);
      if (this.notes.count[n]) { el.classList.add('on'); el.style.setProperty('--v', (this.notes.vel[n] / 127).toFixed(3)); }
      kb.appendChild(el);
      this.keys.set(n, el);
    }
    $('#kbRange').textContent = `${noteName(this.base)}–${noteName(this.base + count - 1)}`;
    this.labelQwerty();
  }
  labelQwerty() {
    const root = 12 * (this.qOct + 1);
    for (const [n, el] of this.keys) el.querySelector('.klabel').textContent = '';
    for (const code of Object.keys(QWERTY)) {
      const el = this.keys.get(root + QWERTY[code]);
      if (el) el.querySelector('.klabel').textContent = QWERTY_LABEL[code];
    }
    $('#qwertyRange').textContent = `${noteName(root)}–${noteName(root + 16)}`;
  }
  mark(cls, list) {
    if (!this.marks) this.marks = {};
    const prev = this.marks[cls];
    const next = new Set(list ? Array.from(list) : []);
    if (prev) for (const n of prev) if (!next.has(n)) { const k = this.keys.get(n); if (k) k.classList.remove(cls); }
    for (const n of next) { const k = this.keys.get(n); if (k) k.classList.add(cls); }
    this.marks[cls] = next;
  }
  setArp(list) { this.mark('arp', list); }
  setChord(list) { this.mark('chd', list); }
  shiftView(d) {
    const nb = clampN(this.base + d * 12, 12, 96);
    if (nb === this.base) return;
    this.base = nb;
    this.build();
  }
  showVel(v) {
    $('#velFill').style.width = (v / 127 * 100) + '%';
    $('#velTxt').textContent = String(v);
  }
  velFrom(e, key) {
    const r = key.getBoundingClientRect();
    const t = clampN((e.clientY - r.top) / r.height, 0, 1);
    return Math.round(127 - t * 126);
  }
  keyAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const key = el && el.closest ? el.closest('.key') : null;
    return key && key.parentElement === this.kb ? key : null;
  }
  bind() {
    const kb = this.kb;
    kb.addEventListener('pointerdown', (e) => {
      const key = e.target.closest('.key');
      if (!key || e.button > 0) return;
      e.preventDefault();
      try { kb.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported */ }
      const n = +key.dataset.note, v = this.velFrom(e, key);
      this.pointers.set(e.pointerId, { note: n });
      this.notes.on(n, v);
      this.showVel(v);
    });
    kb.addEventListener('pointermove', (e) => {
      const st = this.pointers.get(e.pointerId);
      if (!st) return;
      const key = this.keyAt(e.clientX, e.clientY);
      if (!key) return;
      const n = +key.dataset.note, v = this.velFrom(e, key);
      if (n !== st.note) {
        this.notes.off(st.note);
        this.notes.on(n, v);
        st.note = n;
      } else {
        this.notes.pressure(n, v / 127);
      }
      this.showVel(v);
    });
    const end = (e) => {
      const st = this.pointers.get(e.pointerId);
      if (!st) return;
      this.notes.off(st.note);
      this.notes.pressure(st.note, 0);
      this.pointers.delete(e.pointerId);
    };
    kb.addEventListener('pointerup', end);
    kb.addEventListener('pointercancel', end);
    kb.addEventListener('contextmenu', (e) => e.preventDefault());
    $('#kbDown').addEventListener('click', () => this.shiftView(-1));
    $('#kbUp').addEventListener('click', () => this.shiftView(1));

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'KeyZ' || e.code === 'KeyX') {
        e.preventDefault();
        if (e.repeat) return;
        this.qOct = clampN(this.qOct + (e.code === 'KeyZ' ? -1 : 1), 1, 6);
        this.labelQwerty();
        return;
      }
      const off = QWERTY[e.code];
      if (off === undefined) return;
      e.preventDefault();
      if (e.repeat || this.codeNotes.has(e.code)) return;
      const n = 12 * (this.qOct + 1) + off;
      this.codeNotes.set(e.code, n);
      this.notes.on(n, this.qVel);
      this.showVel(this.qVel);
    });
    window.addEventListener('keyup', (e) => {
      const n = this.codeNotes.get(e.code);
      if (n === undefined) return;
      this.codeNotes.delete(e.code);
      this.notes.off(n);
    });
    window.addEventListener('blur', () => this.releaseAll());
  }
  releaseAll() {
    for (const n of this.codeNotes.values()) this.notes.off(n);
    this.codeNotes.clear();
    for (const st of this.pointers.values()) this.notes.off(st.note);
    this.pointers.clear();
  }
}

// ---------------------------------------------------------------------------
class MIDIHandler {
  constructor(synth, ui, notes) {
    this.synth = synth;
    this.ui = ui;
    this.notes = notes;
    this.started = false;
    this.rpnMsb = new Uint8Array(16).fill(127);
    this.rpnLsb = new Uint8Array(16).fill(127);
    this.mpe = false;
    this.mpeMaster = 0;
  }
  init() {
    if (this.started) return;
    this.started = true;
    if (!navigator.requestMIDIAccess) { setMidiStatus('MIDI unavailable', ''); return; }
    navigator.requestMIDIAccess({ sysex: false })
      .then((access) => {
        const attach = () => {
          let n = 0;
          for (const input of access.inputs.values()) { input.onmidimessage = (e) => this.handle(e.data); n++; }
          setMidiStatus(n ? `MIDI · ${n} input${n > 1 ? 's' : ''}${this.mpe ? ' · MPE' : ''}` : 'MIDI · no devices', n ? 'live' : '');
        };
        attach();
        access.onstatechange = attach;
      })
      .catch(() => { setMidiStatus('MIDI off · keyboard works', ''); });
  }
  handle(d) {
    if (!d || d.length < 1) return;
    const st = d[0] & 0xf0, ch = d[0] & 0x0f;
    switch (st) {
      case 0x90:
        if (d[2] > 0) this.notes.on(d[1], d[2], ch); else this.notes.off(d[1], ch);
        break;
      case 0x80: this.notes.off(d[1], ch); break;
      case 0xE0: {
        const v = (((d[2] << 7) | d[1]) - 8192) / 8192;
        this.synth.post({ type: 'bend', v: clampN(v, -1, 1), c: ch });
        break;
      }
      case 0xD0: this.synth.post({ type: 'at', v: d[1] / 127, c: ch }); break;
      case 0xA0: this.notes.pressure(d[1], d[2] / 127); break;
      case 0xB0: this.cc(d[1], d[2], ch); break;
    }
  }
  cc(cc, val, ch) {
    if (this.ui.learnI >= 0 && cc !== 64 && cc !== 100 && cc !== 101 && cc !== 6 && cc < 120) { this.ui.bindCC(cc); return; }
    const bound = this.ui.bindings[cc];
    if (bound !== undefined && PIDX[bound] !== undefined) this.ui.setNorm(PIDX[bound], val / 127);
    switch (cc) {
      case 1: case 11: case 74:
        this.synth.post({ type: 'cc', cc, v: val / 127, c: ch });
        break;
      case 64: this.synth.post({ type: 'cc', cc, v: val >= 64 ? 1 : 0, c: ch }); break;
      case 101: this.rpnMsb[ch] = val; break;
      case 100: this.rpnLsb[ch] = val; break;
      case 6: this.rpn(ch, val); break;
      case 120: this.synth.post({ type: 'kill' }); this.notes.clear(); break;
      case 123: this.synth.post({ type: 'panic' }); this.notes.clear(); break;
    }
  }
  rpn(ch, v) {
    const msb = this.rpnMsb[ch], lsb = this.rpnLsb[ch];
    if (msb === 0 && lsb === 6 && (ch === 0 || ch === 15)) {
      this.mpe = v > 0;
      this.mpeMaster = ch;
      this.synth.post({ type: 'mpe', on: this.mpe, master: ch, range: 48 });
      showNotice(this.mpe ? `MPE on · ${v} member channels` : 'MPE off', 'live', 2500);
      midiStatus.text = midiStatus.text.replace(/ · MPE$/, '') + (this.mpe ? ' · MPE' : '');
    } else if (msb === 0 && lsb === 0) {
      if (this.mpe && ch !== this.mpeMaster) this.synth.post({ type: 'mperange', v });
      else this.ui.set(PIDX.BEND_RANGE, v);
    }
  }
}

// ---------------------------------------------------------------------------
class PresetManager {
  constructor(ui, synth) {
    this.ui = ui;
    this.synth = synth;
    this.mem = {};
    this.slot = 0;
    this.nameEl = $('#presetName');
    this.slotsEl = $('#presetSlots');
    this.btns = [];
    this.lib = $('#presetLib');
    this.buildLibrary();
    for (let i = 0; i < 8; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<b>${String(i + 1).padStart(2, '0')}</b><span></span>`;
      b.addEventListener('click', () => this.load(i));
      this.slotsEl.appendChild(b);
      this.btns.push(b);
    }
  }
  // Library: every factory sound, grouped by category. Loading one replaces the
  // current sound but does not overwrite a slot until Save is pressed.
  buildLibrary() {
    const sel = this.lib;
    sel.innerHTML = '<option value="">Library…</option>';
    const ORDER = ['Basics', 'Pads & atmospheres', 'Keys', 'Bells & plucks', 'Arps & sequences', 'Leads', 'Bass'];
    const cats = ORDER.filter((c) => FACTORY.some((f) => f.cat === c));
    FACTORY.forEach((f) => { if (!cats.includes(f.cat)) cats.push(f.cat); });
    for (const c of cats) {
      const g = document.createElement('optgroup');
      g.label = c;
      FACTORY.forEach((f, k) => {
        if (f.cat !== c) return;
        const o = document.createElement('option');
        o.value = String(k);
        o.textContent = f.name;
        g.appendChild(o);
      });
      sel.appendChild(g);
    }
    sel.addEventListener('change', () => {
      if (sel.value === '') return;
      this.loadFactory(+sel.value);
      sel.blur();
    });
  }
  loadFactory(k) {
    const f = FACTORY[k];
    if (!f) return;
    this.apply(factorySnapshot(k));
    this.nameEl.value = f.name;
    this.lib.value = String(k);
    this.render();
    showNotice(`${f.name} loaded · Save to keep it in slot ${this.slot + 1}`, 'live', 3500);
  }
  key(i) { return 'synthcore_preset_' + i; }
  read(i) {
    try {
      const s = localStorage.getItem(this.key(i));
      if (s) return JSON.parse(s);
    } catch (e) { /* storage unavailable: fall back to memory */ }
    return this.mem[i] || null;
  }
  write(i, o) {
    this.mem[i] = o;
    try { localStorage.setItem(this.key(i), JSON.stringify(o)); } catch (e) { /* memory copy remains */ }
  }
  seed() { for (let i = 0; i < 8; i++) if (!this.read(i)) this.write(i, factorySnapshot(i)); }
  snapshot(name) {
    const o = { _name: name };
    PARAMS.forEach((p, i) => { o[p.id] = Math.round(values[i] * 1e6) / 1e6; });
    return o;
  }
  apply(o) {
    PARAMS.forEach((p, i) => {
      let v = o[p.id];
      if (typeof v !== 'number' || !Number.isFinite(v)) v = p.def;
      if (p.kind !== 'c') v = Math.round(v);
      values[i] = clampN(v, p.min, p.max);
    });
    this.ui.refreshAll();
    this.synth.post({ type: 'all', values: Float32Array.from(values) });
  }
  load(i) {
    const o = this.read(i) || factorySnapshot(i % FACTORY.length);
    this.apply(o);
    this.slot = i;
    this.nameEl.value = o._name || `Preset ${i + 1}`;
    try { localStorage.setItem('synthcore_last_slot', String(i)); } catch (e) { /* not persisted */ }
    const fk = FACTORY.findIndex((f) => f.name === o._name);
    this.lib.value = fk >= 0 ? String(fk) : '';
    this.render();
  }
  save() {
    const name = this.nameEl.value.trim() || `Preset ${this.slot + 1}`;
    this.write(this.slot, this.snapshot(name));
    this.render();
    showNotice(`Saved “${name}” to slot ${this.slot + 1}`, 'live', 2000);
  }
  exportJson() {
    const name = this.nameEl.value.trim() || `Preset ${this.slot + 1}`;
    const blob = new Blob([JSON.stringify(this.snapshot(name), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `synthcore_${name.replace(/[^a-z0-9-_]+/gi, '_').toLowerCase()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  importFile(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const o = JSON.parse(String(r.result));
        if (!o || typeof o !== 'object') throw new Error('not an object');
        if (!o._name) o._name = file.name.replace(/\.json$/i, '');
        this.apply(o);
        this.write(this.slot, this.snapshot(o._name));
        this.nameEl.value = o._name;
        this.render();
        showNotice(`Imported “${o._name}” into slot ${this.slot + 1}`, 'live', 2500);
      } catch (e) {
        showNotice('That file is not a SynthCore preset (expected JSON of parameter values)', 'err', 4000);
      }
    };
    r.readAsText(file);
  }
  render() {
    this.btns.forEach((b, i) => {
      const o = this.read(i);
      b.querySelector('span').textContent = (o && o._name) || `Preset ${i + 1}`;
      b.classList.toggle('on', i === this.slot);
      b.setAttribute('aria-pressed', i === this.slot ? 'true' : 'false');
    });
  }
}

// ---------------------------------------------------------------------------
// Repeated panel markup
function buildEnvStrips() {
  const names = ['Amp', 'Filter', 'Pitch', 'Aux'];
  $('#envStrips').innerHTML = names.map((nm, j) => {
    const k = j + 1;
    const vs = ['A', 'H', 'D', 'S', 'R'].map((s) => `<div data-t="vs" data-p="ENV${k}_${s}"></div>`).join('');
    return `<div class="mod">
      <header><h3><em>ENV ${k}</em>${nm}</h3><div data-t="seg" data-p="ENV${k}_CURVE"></div></header>
      <div class="env-view">
        <canvas class="adsr" id="adsr${k}" width="80" height="30" aria-label="Envelope ${k} shape"></canvas>
        <div data-t="knob" data-p="ENV${k}_VEL" data-l="Vel curve"></div>
      </div>
      <div class="sliders">${vs}</div>
    </div>`;
  }).join('');
}
function buildLfoStrips() {
  const html = [];
  for (let k = 1; k <= 4; k++) {
    html.push(`<div class="mod">
      <header><h3><em>LFO ${k}</em>${k <= 2 ? 'rate/depth modulatable' : ''}</h3>
        <div class="row"><div data-t="tog" data-p="LFO${k}_SYNC"></div><div data-t="seg" data-p="LFO${k}_MODE"></div></div></header>
      <div data-t="seg" data-p="LFO${k}_WAVE" data-icons="lfo"></div>
      <div class="row">
        <div data-t="knob" data-p="LFO${k}_RATE"></div>
        <div class="selw" data-dimwrap="LFO${k}_DIV"><span class="lbl">Div</span><div data-t="sel" data-p="LFO${k}_DIV"></div></div>
        <div data-t="knob" data-p="LFO${k}_DEPTH"></div>
        <div data-t="knob" data-p="LFO${k}_FADE"></div>
        <div data-t="knob" data-p="LFO${k}_PHASE"></div>
      </div>
    </div>`);
  }
  $('#lfoStrips').innerHTML = html.join('');
}
function buildModMatrix() {
  const rows = [];
  for (let i = 0; i < 16; i++) {
    rows.push(`<tr data-slot="${i}">
      <td class="n">${String(i + 1).padStart(2, '0')}</td>
      <td><div data-t="sel" data-p="MOD${i}_SRC" data-l="Slot ${i + 1} source"></div></td>
      <td><div data-t="sel" data-p="MOD${i}_DST" data-l="Slot ${i + 1} destination"></div></td>
      <td class="d"><div data-t="hs" data-p="MOD${i}_DEPTH" data-l="Slot ${i + 1} depth"></div></td>
      <td><div data-t="cyc" data-p="MOD${i}_CURVE"></div></td>
      <td><div data-t="chk" data-p="MOD${i}_ON" data-l="Slot ${i + 1} enabled"></div></td>
    </tr>`);
  }
  $('#modMatrix tbody').innerHTML = rows.join('');
}
function refreshModRows() {
  document.querySelectorAll('#modMatrix tr[data-slot]').forEach((tr) => {
    const i = +tr.dataset.slot;
    const live = values[PIDX[`MOD${i}_SRC`]] > 0 && values[PIDX[`MOD${i}_DST`]] > 0 && values[PIDX[`MOD${i}_ON`]] > 0.5;
    tr.classList.toggle('live', live);
  });
}

// ---------------------------------------------------------------------------
// Chord section: minor-seventh family chords over common progressions.
const CHORD_IV = [[0, 3, 7, 10], [0, 3, 7, 10, 14], [0, 3, 10, 14, 17]]; // m7, m9, m11 (no 5th)
const NUMERALS = ['i', '♭ii', 'ii', '♭iii', 'iii', 'iv', '♯iv', 'v', '♭vi', 'vi', '♭vii', 'vii'];
const PAD_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];

class ChordSection {
  constructor(synth, ui, notes, keyboard) {
    this.synth = synth; this.ui = ui; this.notes = notes; this.keyboard = keyboard;
    this.padsEl = $('#chdPads');
    this.playBtn = $('#chdPlay');
    this.voicings = [];
    this.labels = [];
    this.running = false;
    this.pos = -1;
    this.held = new Map();
    this.pads = [];
    ui.onChange((i) => { if (i < 0 || PARAMS[i].id.startsWith('CHD_')) this.rebuild(); });
    this.playBtn.addEventListener('click', () => this.setPlaying(!this.running));
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const i = PAD_KEYS.indexOf(e.code);
      if (i < 0 || i >= this.voicings.length) return;
      e.preventDefault();
      if (e.repeat || this.held.has(e.code)) return;
      this.press(i, e.code);
    });
    window.addEventListener('keyup', (e) => { if (this.held.has(e.code)) this.release(e.code); });
    window.addEventListener('blur', () => { for (const src of [...this.held.keys()]) this.release(src); });
    this.rebuild();
  }
  // Voice-leading: pick the inversion and octave closest to the previous chord,
  // while keeping the chord centred near its home register.
  nearest(close, prev, home) {
    const n = close.length;
    let best = null, bestCost = Infinity;
    for (let inv = 0; inv < n; inv++) {
      const c = close.map((x, i) => (i < inv ? x + 12 : x)).sort((a, b) => a - b);
      for (const sh of [-24, -12, 0, 12]) {
        const cand = c.map((x) => x + sh);
        const mid = (cand[0] + cand[n - 1]) / 2;
        if (Math.abs(mid - home) > 8) continue;
        let cost = 0;
        for (let i = 0; i < n; i++) cost += Math.abs(cand[i] - prev[Math.min(i, prev.length - 1)]);
        if (cost < bestCost) { bestCost = cost; best = cand; }
      }
    }
    return best || close;
  }
  compute() {
    const V = (id) => values[PIDX[id]];
    const prog = PROGRESSIONS[V('CHD_PROG')] || PROGRESSIONS[0];
    const key = V('CHD_KEY'), type = V('CHD_TYPE');
    const base = 12 * (V('CHD_OCT') + 1) + key;
    const iv = CHORD_IV[type] || CHORD_IV[1];
    const home = base + (iv[0] + iv[iv.length - 1]) / 2;
    const vl = V('CHD_VL') > 0.5, bass = V('CHD_BASS') > 0.5;
    const out = [], labels = [];
    let prev = null;
    for (const r of prog.roots) {
      const root = base + r - (r > 6 ? 12 : 0);
      const close = iv.map((x) => root + x);
      const chord = vl && prev ? this.nearest(close, prev, home) : close;
      prev = chord;
      const ns = chord.slice();
      if (bass) { let b = root - 12; while (b >= ns[0]) b -= 12; ns.unshift(b); }
      out.push([...new Set(ns.filter((n) => n >= 0 && n <= 127))]);
      labels.push({ num: NUMERALS[r], name: KEY_NAMES[(key + r) % 12] + CHORD_TYPES[type] });
    }
    return { out, labels };
  }
  rebuild() {
    const { out, labels } = this.compute();
    this.voicings = out;
    this.labels = labels;
    this.renderPads();
    this.sync();
    this.showPos();
  }
  sync() { this.synth.post({ type: 'chords', list: this.voicings }); }
  renderPads() {
    const el = this.padsEl;
    const n = this.labels.length;
    if (this.pads.length !== n) {
      el.innerHTML = '';
      this.pads = this.labels.map((_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pad';
        b.id = 'chdPad' + i;
        b.innerHTML = `<b>${i + 1}</b><span class="num"></span><span class="nm"></span>`;
        b.addEventListener('pointerdown', (e) => {
          if (e.button > 0) return;
          e.preventDefault();
          try { b.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported */ }
          this.press(i, 'p' + e.pointerId);
        });
        const up = (e) => this.release('p' + e.pointerId);
        b.addEventListener('pointerup', up);
        b.addEventListener('pointercancel', up);
        b.addEventListener('keydown', (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !e.repeat && !this.held.has('kb')) { e.preventDefault(); this.press(i, 'kb'); }
        });
        b.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') this.release('kb'); });
        el.appendChild(b);
        return b;
      });
    }
    el.style.setProperty('--n', String(n));
    this.labels.forEach((l, i) => {
      const b = this.pads[i];
      b.querySelector('.num').textContent = l.num;
      b.querySelector('.nm').textContent = l.name;
      b.setAttribute('aria-label', `Chord ${i + 1}: ${l.name}, ${l.num}`);
      b.title = `${l.name} · ${this.voicings[i].map(noteName).join(' ')} · key ${i + 1}`;
    });
  }
  press(i, src) {
    if (this.running) {
      this.synth.post({ type: 'chordgo', i });
      this.held.set(src, { i, notes: [] });
      return;
    }
    const ns = this.voicings[i];
    if (!ns) return;
    for (const n of ns) this.notes.on(n, 100);
    this.held.set(src, { i, notes: ns.slice() });
    this.lightPads();
  }
  release(src) {
    const h = this.held.get(src);
    if (!h) return;
    this.held.delete(src);
    for (const n of h.notes) this.notes.off(n);
    this.lightPads();
  }
  setPlaying(on) {
    for (const src of [...this.held.keys()]) this.release(src);
    const send = () => { this.sync(); this.synth.post({ type: 'chordplay', on }); };
    if (this.synth.node) send();
    else if (this.synth.booting) this.synth.booting.then(send).catch(() => {});
    this.running = on;
    this.pos = -1;
    this.showPos();
  }
  onMeter(m) {
    const run = !!m.chRun, pos = typeof m.chPos === 'number' ? m.chPos : -1;
    if (run === this.running && pos === this.pos) return;
    this.running = run;
    this.pos = pos;
    this.showPos();
  }
  lightPads() {
    const held = new Set([...this.held.values()].filter((h) => h.notes.length).map((h) => h.i));
    this.pads.forEach((b, i) => b.classList.toggle('on', held.has(i) || (this.running && i === this.pos)));
  }
  showPos() {
    this.playBtn.classList.toggle('on', this.running);
    this.playBtn.setAttribute('aria-pressed', this.running ? 'true' : 'false');
    this.playBtn.textContent = this.running ? '■ Stop' : '▶ Play';
    this.keyboard.setChord(this.running && this.pos >= 0 ? this.voicings[this.pos] : null);
    this.lightPads();
  }
}

// ---------------------------------------------------------------------------
// Collapsible sections: each panel heading becomes a toggle; state is
// remembered per browser.
// A link ending in #open starts in Advanced view with every panel unfolded (not saved).
const FORCE_OPEN = /(^|[#&])open(&|$)/.test(location.hash);
function makeCollapsible() {
  // Panels start folded, except the ones needed to play right away; the viewer's own
  // choices are remembered (v2 key: earlier saves only recorded folded panels).
  const KEY = 'synthcore_folds_v2';
  const OPEN_BY_DEFAULT = { 'p-quick': 1, 'p-kb': 1 };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  const panels = [...document.querySelectorAll('#app > section.panel')];
  const foldBtn = $('#foldAll');
  const persist = () => {
    const o = {};
    panels.forEach((p) => { o[p.id] = p.classList.contains('folded') ? 1 : 0; });
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* not persisted */ }
  };
  const shown = () => panels.filter((p) => getComputedStyle(p).display !== 'none');
  const refreshAllBtn = () => {
    const allFolded = shown().every((p) => p.classList.contains('folded'));
    foldBtn.textContent = allFolded ? 'Unfold all' : 'Fold all';
  };
  const setFold = (p, folded) => {
    p.classList.toggle('folded', folded);
    p.querySelector(':scope > .pbody').hidden = folded;
    p.querySelector(':scope > h2 > .ph').setAttribute('aria-expanded', folded ? 'false' : 'true');
  };
  panels.forEach((p) => {
    const h2 = p.querySelector(':scope > h2');
    const body = document.createElement('div');
    body.className = 'pbody';
    body.id = p.id + '-body';
    while (h2.nextSibling) body.appendChild(h2.nextSibling);
    p.appendChild(body);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ph';
    btn.setAttribute('aria-controls', body.id);
    while (h2.firstChild) btn.appendChild(h2.firstChild);
    btn.insertAdjacentHTML('beforeend', '<span class="chev" aria-hidden="true"></span>');
    btn.title = 'Show or hide this section';
    h2.appendChild(btn);
    btn.addEventListener('click', () => {
      setFold(p, !p.classList.contains('folded'));
      persist();
      refreshAllBtn();
    });
    setFold(p, FORCE_OPEN ? false : (p.id in saved ? !!saved[p.id] : !OPEN_BY_DEFAULT[p.id]));
  });
  foldBtn.addEventListener('click', () => {
    const vis = shown();
    const fold = !vis.every((p) => p.classList.contains('folded'));
    vis.forEach((p) => setFold(p, fold));
    persist();
    refreshAllBtn();
  });
  refreshAllBtn();
  return refreshAllBtn;
}

// Simple / Advanced view. First visit: Simple on narrow screens, Advanced on wide ones.
function initViewSwitch(onChange) {
  const KEY = 'synthcore_view';
  let v = null;
  try { v = localStorage.getItem(KEY); } catch (e) { v = null; }
  if (v !== 'simple' && v !== 'adv') v = window.innerWidth < 900 ? 'simple' : 'adv';
  if (FORCE_OPEN) v = 'adv';
  const sw = $('#viewSw');
  const apply = (nv, save) => {
    v = nv;
    document.body.classList.toggle('view-simple', v === 'simple');
    document.body.classList.toggle('view-adv', v === 'adv');
    sw.querySelectorAll('button').forEach((b) => { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    if (save) { try { localStorage.setItem(KEY, v); } catch (e) { /* not persisted */ } }
    if (onChange) onChange(v);
  };
  sw.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.v !== v) apply(b.dataset.v, true); });
  apply(v, false);
}

// ---------------------------------------------------------------------------
// Bootstrap
const synth = new SynthController();
const ui = new UIController(synth);
buildEnvStrips();
buildLfoStrips();
buildModMatrix();
ui.hydrate(document);
const refreshFoldBtn = makeCollapsible();
initViewSwitch(() => refreshFoldBtn());
const visuals = new VisualsRenderer(synth, ui);
const notes = new NoteBus(synth);
const keyboard = new KeyboardHandler(notes);
const presets = new PresetManager(ui, synth);
const midi = new MIDIHandler(synth, ui, notes);
const chords = new ChordSection(synth, ui, notes, keyboard);
const claudePlays = new ClaudePlays(synth, ui, presets, keyboard, chords);
synth.onMeter = (m) => {
  visuals.onMeter(m);
  if (m && m.type === 'meter') { keyboard.setArp(m.arpNotes); chords.onMeter(m); claudePlays.onMeter(m); }
};

const bpmEl = $('#bpm');
ui.onChange((i) => {
  if (i < 0 || i === PIDX.BPM) bpmEl.value = values[PIDX.BPM].toFixed(1).replace(/\.0$/, '');
  if (i < 0 || PARAMS[i].id.startsWith('MOD')) refreshModRows();
});
bpmEl.addEventListener('change', () => {
  const v = parseFloat(bpmEl.value);
  if (Number.isFinite(v)) ui.set(PIDX.BPM, clampN(v, 20, 300));
  bpmEl.value = values[PIDX.BPM].toFixed(1).replace(/\.0$/, '');
});
const taps = [];
$('#tap').addEventListener('click', () => {
  const t = performance.now();
  const last = taps[taps.length - 1];
  if (last !== undefined && t - last < 200) return;
  if (last !== undefined && t - last > 2000) taps.length = 0;
  taps.push(t);
  if (taps.length > 5) taps.shift();
  if (taps.length >= 2) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    ui.set(PIDX.BPM, clampN(Math.round(60000 / avg * 10) / 10, 20, 300));
  }
});
$('#panic').addEventListener('click', () => {
  keyboard.releaseAll();
  notes.clear();
  keyboard.setArp(null);
  synth.post({ type: 'panic' });
  chords.setPlaying(false);
  claudePlays.stop();
});
$('#presetSave').addEventListener('click', () => presets.save());
$('#presetExport').addEventListener('click', () => presets.exportJson());
$('#presetImportBtn').addEventListener('click', () => $('#presetImport').click());
$('#presetImport').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) presets.importFile(f);
  e.target.value = '';
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') ui.cancelLearn(); });

presets.seed();
let startSlot = 0;
try { startSlot = clampN(parseInt(localStorage.getItem('synthcore_last_slot') || '0', 10) || 0, 0, 7); } catch (e) { startSlot = 0; }
presets.load(startSlot);

function audioLabel(ctx) {
  return `Audio on · ${(ctx.sampleRate / 1000).toFixed(1)} kHz` + (synth.mode === 'compat' ? ' · compatibility' : '');
}
function init() {
  const ctx = synth.ctx;
  if (ctx.state === 'running') {
    setAudioState('live', audioLabel(ctx));
  } else {
    // resume() was given up on (timeout) rather than actually confirmed — say so
    // honestly instead of claiming "Audio on" while the context may still be
    // suspended. A tap anywhere will retry (see the pointerdown handler below).
    setAudioState('warn', 'Audio paused · tap anywhere to resume');
  }
  if (synth.mode === 'compat') {
    $('#audioState').dataset.why = '1'; $('#audioState').title = 'This page is hosted where the browser blocks the low-latency audio thread, so the engine runs on the page thread instead. It sounds the same; heavy patches may crackle. Reason: ' + synth.why;
  }
  visuals.drawBode();
  chords.sync();
  if (mediaRoute.on) setMediaRoute(true);
  ctx.onstatechange = () => {
    if (ctx.state === 'running') setAudioState('live', audioLabel(ctx));
    else setAudioState('warn', 'Audio paused · tap anywhere to resume');
  };
  unlockAudio();
}
function boot() {
  setAudioState('warn', 'Starting audio…');
  midi.init();
  return synth.boot();
}
const startEvents = ['pointerdown', 'keydown', 'click'];
function firstGesture(e) {
  if (e.type === 'keydown' && (e.metaKey || e.ctrlKey || e.altKey)) return;
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (err) { /* older Safari */ }
  startEvents.forEach((t) => document.removeEventListener(t, firstGesture, true));
  boot().then(init).catch((err) => {
    setAudioState('err', 'Audio failed · ' + (err && err.message ? err.message : 'unknown error'));
  });
}
startEvents.forEach((t) => document.addEventListener(t, firstGesture, true));

// iPhone/iPad: Safari only lets audio start on the *end* of a tap (touchend / click),
// not on pointerdown, and it parks the context in 'interrupted' after calls or app
// switches. So every tap-end retries until the context runs, and plays a one-sample
// silent buffer inside the gesture, which is what actually unlocks output on iOS.
// Nothing about the engine or its sound changes.
function unlockAudio() {
  const ctx = synth.ctx;
  // Silent-switch handling runs on every tap: with the switch on, iOS reports the
  // context as 'running' while muting it, so this can't wait for a paused state.
  if (ctx) keepPlayingWhenSilenced();
  if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
  try { ctx.resume(); } catch (e) { /* retried on the next tap */ }
  try {
    const b = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = b; src.connect(ctx.destination); src.start(0);
  } catch (e) { /* not needed where resume() suffices */ }
}
['touchend', 'click', 'keydown', 'pointerup', 'pointerdown'].forEach((t) => document.addEventListener(t, unlockAudio, true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) unlockAudio(); });

// iOS routes web audio like a notification sound, so the ringer/silent switch mutes it.
// An instrument should play like a music app: ask for the 'playback' audio session
// (Safari 16.4+), or on older iOS keep a silent looping <audio> element running,
// which moves the page into the playback session too.
let silentEl = null;
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function keepPlayingWhenSilenced() {
  try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) { /* older Safari */ }
  if (!IS_IOS) return;
  if (mediaRoute.el && mediaRoute.on && mediaRoute.el.paused) mediaRoute.el.play().catch(() => {});
  if (silentEl) { if (silentEl.paused) silentEl.play().catch(() => {}); return; }
  // 0.1 s of 8 kHz mono silence as a WAV.
  const n = 800, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) d.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, 8000, true); d.setUint32(28, 16000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, n * 2, true);
  let bin = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  silentEl = document.createElement('audio');
  silentEl.setAttribute('playsinline', '');
  silentEl.setAttribute('x-webkit-airplay', 'deny');
  silentEl.loop = true;
  // Blob URL first (the artifact viewer's policy may refuse data: media), data: URL as backup.
  let blobUrl = null;
  try { blobUrl = URL.createObjectURL(new Blob([u], { type: 'audio/wav' })); } catch (e) { blobUrl = null; }
  const dataUrl = 'data:audio/wav;base64,' + btoa(bin);
  silentEl.src = blobUrl || dataUrl;
  silentEl.addEventListener('error', () => { if (silentEl.src !== dataUrl) { silentEl.src = dataUrl; silentEl.play().catch(() => {}); } }, { once: true });
  silentEl.play().catch(() => {});
}

// iPhone/iPad only, opt-in: send the synth's output through an <audio> element, which
// iOS plays as music even with the silent switch on. Costs some extra latency, so it is
// off unless the player turns it on; the sound itself (DSP, sample rate) is unchanged.
const mediaRoute = { on: false, dest: null, el: null };
function setMediaRoute(on) {
  mediaRoute.on = on;
  try { localStorage.setItem('synthcore_silent_route', on ? '1' : '0'); } catch (e) { /* not persisted */ }
  const b = $('#silentSw');
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  const ctx = synth.ctx, node = synth.node;
  if (!ctx || !node) return;
  try {
    if (on) {
      if (!mediaRoute.dest) {
        mediaRoute.dest = ctx.createMediaStreamDestination();
        mediaRoute.el = document.createElement('audio');
        mediaRoute.el.setAttribute('playsinline', '');
        mediaRoute.el.srcObject = mediaRoute.dest.stream;
      }
      try { node.disconnect(ctx.destination); } catch (e) { /* already */ }
      node.connect(mediaRoute.dest);
      mediaRoute.el.play().catch(() => {});
    } else {
      if (mediaRoute.dest) { try { node.disconnect(mediaRoute.dest); } catch (e) { /* already */ } }
      if (mediaRoute.el) mediaRoute.el.pause();
      node.connect(ctx.destination);
    }
  } catch (e) {
    mediaRoute.on = false;
    try { node.connect(ctx.destination); } catch (e2) { /* keep direct path */ }
  }
}
if (IS_IOS) {
  const sb = $('#silentSw');
  sb.hidden = false;
  try { mediaRoute.on = localStorage.getItem('synthcore_silent_route') === '1'; } catch (e) { mediaRoute.on = false; }
  sb.classList.toggle('on', mediaRoute.on);
  sb.setAttribute('aria-pressed', mediaRoute.on ? 'true' : 'false');
  sb.addEventListener('click', () => setMediaRoute(!mediaRoute.on));
}

// Console handle for inspection: synthcore.values, synthcore.set('FLT_CUTOFF', 800)
window.synthcore = {
  synth, ui, values, PARAMS, PIDX, presets, chords, visuals, claudePlays,
  set: (id, v) => ui.set(PIDX[id], v)
};

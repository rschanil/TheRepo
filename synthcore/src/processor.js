// ===========================================================================
// SYNTHCORE audio thread. Everything below runs inside AudioWorkletGlobalScope.
// process() only does arithmetic on memory allocated in constructors.
// ===========================================================================
const TWO_PI = 2 * Math.PI;
const TINY = 1e-20;
const LN1000 = 6.907755278982137;
const SEMI = 0.05776226504666211; // ln(2) / 12
const VOICE_GAIN = 0.5;
const ENV_STRIDE = P_ENV2_A - P_ENV1_A;
const LFO_STRIDE = P_LFO2_WAVE - P_LFO1_WAVE;
const LFO_RATE_OFF = P_LFO1_RATE - P_LFO1_WAVE;
const LFO_SYNC_OFF = P_LFO1_SYNC - P_LFO1_WAVE;
const LFO_DIV_OFF = P_LFO1_DIV - P_LFO1_WAVE;
const LFO_DEPTH_OFF = P_LFO1_DEPTH - P_LFO1_WAVE;
const LFO_PHASE_OFF = P_LFO1_PHASE - P_LFO1_WAVE;
const LFO_FADE_OFF = P_LFO1_FADE - P_LFO1_WAVE;
const LFO_MODE_OFF = P_LFO1_MODE - P_LFO1_WAVE;
const MOD_STRIDE = P_MOD1_SRC - P_MOD0_SRC;

const clock = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
  ? () => performance.now() : () => Date.now();

function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

// Band-limited step residual (Välimäki & Pekonen 2007)
function polyblep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1.0;
  } else if (t > 1.0 - dt) {
    t = (t - 1.0) / dt;
    return t * t + t + t + 1.0;
  }
  return 0.0;
}

// Current smoothed parameter values, shared by every DSP object on this thread.
let PV = null;

// Global per-sample state (controllers, tempo, derived rates). Fixed shape.
const G = {
  sr: 48000,
  bend: 0, modWheel: 0, at: 0, expr: 1, cc74: 0,
  bpm: 120,
  lfoHz: new Float64Array(4),
  lfoFree: new Float64Array(4),
  env: null,
  glideCoeff: 0, lastGlide: -1,
  noteCounter: 0,
  mpe: false, mpeMaster: 0, mpeRange: 48,
  chBend: new Float64Array(16), chPress: new Float64Array(16), chSlide: new Float64Array(16),
  notePress: new Float64Array(128),
  ctlK: 0.004, fadeStep: 0.01,
  modRev: 0, modDly: 0, modCh: 0
};

class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 0x1234567; }
  next() {
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x >>> 0;
    return this.s;
  }
  next01() { return this.next() / 4294967296; }
  nextBi() { return this.next() / 2147483648 - 1; }
}

// ---------------------------------------------------------------------------
class SmoothedParam {
  constructor(value, ms, sampleRate) {
    this.value = value;
    this.target = value;
    // One-pole IIR lowpass: coeff = exp(-1 / (ms_in_seconds * sampleRate))
    this.coeff = ms > 0 ? Math.exp(-1.0 / (ms * 0.001 * sampleRate)) : 0;
  }
  set(v) { this.target = v; }
  snap(v) { this.value = v; this.target = v; }
  tick() {
    const d = this.target - this.value;
    if (d === 0) return this.value;
    if ((d < 0 ? -d : d) <= 1e-9 * (1 + (this.target < 0 ? -this.target : this.target))) {
      this.value = this.target;
      return this.value;
    }
    this.value += d * (1.0 - this.coeff);
    return this.value;
  }
}

// ---------------------------------------------------------------------------
const W_SINE = 0, W_TRI = 1, W_SAW = 2, W_SQUARE = 3, W_PULSE = 4, W_SUPER = 5;
const SUPER_OFFS = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];
const SUPER_GAIN = 1 / Math.sqrt(7);

function naiveWave(p, wave, pw) {
  switch (wave) {
    case W_SINE: return Math.sin(TWO_PI * p);
    case W_TRI: return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case W_SAW: return 2 * p - 1;
    case W_SQUARE: return p < 0.5 ? 1 : -1;
    case W_PULSE: return (p < pw ? 1 : -1) - (2 * pw - 1);
    default: return 0;
  }
}

class WavetableOscillator {
  constructor(sampleRate, withSuper) {
    this.invSr = 1 / sampleRate;
    this.phase = 0;
    this.dt = 0;
    this.tri = -1;
    this.wrapped = false;
    this.syncPending = false;
    this.syncJ = 0;
    this.syncJb = 0;
    this.lastWave = W_SAW;
    this.lastPw = 0.5;
    this.children = null;
    this.ratios = null;
    this.lastSpread = -1;
    if (withSuper) {
      this.children = new Array(7);
      for (let i = 0; i < 7; i++) this.children[i] = new WavetableOscillator(sampleRate, false);
      this.ratios = new Float64Array(7);
    }
  }

  reset(phase, rng) {
    this.phase = phase;
    this.tri = naiveWave(phase, W_TRI, 0.5);
    this.syncPending = false;
    if (this.children) {
      for (let i = 0; i < 7; i++) {
        const c = this.children[i];
        c.phase = i === 3 ? phase : rng.next01();
        c.syncPending = false;
      }
    }
  }

  tick(freq, wave, pw, spread) {
    if (wave === W_SUPER && this.children) return this.tickSuper(freq, spread);
    let dt = freq * this.invSr;
    if (dt > 0.45) dt = 0.45;
    if (dt < 1e-7) dt = 1e-7;
    this.dt = dt;
    const p = this.phase;
    let out;
    switch (wave) {
      case W_SINE:
        out = Math.sin(TWO_PI * p);
        break;
      case W_TRI: {
        // Integrated band-limited square (leaky integrator keeps it centred).
        let sq = p < 0.5 ? 1 : -1;
        sq += polyblep(p, dt);
        let q = p + 0.5; if (q >= 1) q -= 1;
        sq -= polyblep(q, dt);
        let t = this.tri + 4 * dt * sq;
        t *= 1 - 0.05 * dt;
        this.tri = t;
        out = t;
        break;
      }
      case W_SAW:
        out = 2 * p - 1 - polyblep(p, dt);
        break;
      case W_SQUARE:
        pw = 0.5;
      // falls through: a square is a pulse at 50 %
      case W_PULSE: {
        let v = p < pw ? 1 : -1;
        v += polyblep(p, dt);
        let q = p - pw + 1; if (q >= 1) q -= 1;
        v -= polyblep(q, dt);
        out = v - (2 * pw - 1);
        break;
      }
      default:
        out = 2 * p - 1 - polyblep(p, dt);
    }
    if (this.syncPending) {
      this.syncPending = false;
      if (p < dt) {
        const u = p / dt;
        out += 0.5 * (this.syncJ - this.syncJb) * (u + u - u * u - 1);
      }
    }
    let np = p + dt;
    if (np >= 1) { np -= 1; this.wrapped = true; } else this.wrapped = false;
    this.phase = np;
    this.lastWave = wave;
    this.lastPw = pw;
    return out;
  }

  tickSuper(freq, spread) {
    if (spread !== this.lastSpread) {
      this.lastSpread = spread;
      for (let i = 0; i < 7; i++) this.ratios[i] = Math.pow(2, SUPER_OFFS[i] * spread * 0.5 / 1200);
    }
    const ch = this.children;
    let s = 0;
    for (let i = 0; i < 7; i++) s += ch[i].tick(freq * this.ratios[i], W_SAW, 0.5, 0);
    const c = ch[3];
    this.wrapped = c.wrapped;
    this.phase = c.phase;
    this.dt = c.dt;
    this.lastWave = W_SUPER;
    return s * SUPER_GAIN;
  }

  // Master crossed phase 0 `t` samples ago (0..1): restart the slave from there.
  syncReset(t) {
    if (this.lastWave === W_SUPER && this.children) {
      for (let i = 0; i < 7; i++) { const c = this.children[i]; c.phase = t * c.dt; }
      this.phase = this.children[3].phase;
      return;
    }
    const wave = this.lastWave;
    const np = t * this.dt;
    if (wave === W_SAW || wave === W_SQUARE || wave === W_PULSE) {
      const pw = wave === W_SQUARE ? 0.5 : this.lastPw;
      this.syncJ = naiveWave(np, wave, pw) - naiveWave(this.phase, wave, pw);
      this.syncJb = wave === W_SAW ? -2 : 2;
      this.syncPending = true;
    } else if (wave === W_TRI) {
      this.tri = naiveWave(np, W_TRI, 0.5);
    }
    this.phase = np;
  }
}

// ---------------------------------------------------------------------------
// Zavalishin TPT state-variable filter. Outputs are written to fields so the
// per-sample call allocates nothing; tick() returns the selected mode.
const F_LP = 0, F_HP = 1, F_BP = 2, F_NOTCH = 3, F_PEAK = 4;
class TPT_SVF {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.s1 = 0; this.s2 = 0;
    this.fc = new SmoothedParam(1000, 1, sampleRate);
    this.Q = new SmoothedParam(0.7, 1, sampleRate);
    this.lastFc = -1; this.g = 0;
    this.lp = 0; this.hp = 0; this.bp = 0; this.notch = 0; this.peak = 0;
  }
  reset() { this.s1 = 0; this.s2 = 0; }
  tick(x, mode) {
    const sr = this.sampleRate;
    const fcRaw = this.fc.tick();
    const Q = this.Q.tick();
    const fc = fcRaw < 20 ? 20 : (fcRaw > sr * 0.49 ? sr * 0.49 : fcRaw);
    if (fc !== this.lastFc) { this.lastFc = fc; this.g = Math.tan(Math.PI * fc / sr); }
    const g = this.g;
    const R = 1.0 / (2.0 * (Q > 0.001 ? Q : 0.001));
    const h = 1.0 / (1.0 + 2.0 * R * g + g * g);

    const yHP = h * (x - (2.0 * R + g) * this.s1 - this.s2);
    const yBP = g * yHP + this.s1;
    const yLP = g * yBP + this.s2;

    let s1 = g * yHP + yBP + TINY;
    let s2 = g * yBP + yLP + TINY;
    s1 -= TINY; s2 -= TINY;
    if (Math.abs(s1) < 1e-20) s1 = 0;
    if (Math.abs(s2) < 1e-20) s2 = 0;
    if (!(s1 === s1 && s2 === s2) || Math.abs(s1) > 1e8 || Math.abs(s2) > 1e8) {
      this.s1 = 0; this.s2 = 0;
      this.lp = this.hp = this.bp = this.notch = this.peak = 0;
      return 0;
    }
    this.s1 = s1; this.s2 = s2;
    this.lp = yLP; this.hp = yHP; this.bp = yBP;
    this.notch = yLP + yHP;
    this.peak = yLP - yHP + 2 * R * yBP;
    switch (mode) {
      case F_HP: return yHP;
      case F_BP: return yBP;
      case F_NOTCH: return this.notch;
      case F_PEAK: return this.peak;
      default: return yLP;
    }
  }
}

// ---------------------------------------------------------------------------
// Huovilainen-style 4-pole ladder, 2x oversampled.
class MoogLadderFilter {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.s = new Float64Array(4);
    this.xPrev = 0;
    this.lastFc = -1;
    this.g = 0;
  }
  reset() { this.s[0] = this.s[1] = this.s[2] = this.s[3] = 0; this.xPrev = 0; }
  stage(x, g, k) {
    const s = this.s;
    const fb = k * Math.tanh(s[3]);
    const xIn = Math.tanh(x - fb);
    s[0] += g * (Math.tanh(xIn) - s[0]);
    s[1] += g * (Math.tanh(s[0]) - s[1]);
    s[2] += g * (Math.tanh(s[1]) - s[2]);
    s[3] += g * (Math.tanh(s[2]) - s[3]);
    return s[3];
  }
  tick(x, fc, res) {
    const sr = this.sr;
    const fcS = fc < 20 ? 20 : (fc > sr * 0.45 ? sr * 0.45 : fc);
    if (fcS !== this.lastFc) {
      this.lastFc = fcS;
      this.g = 1 - Math.exp(-TWO_PI * fcS / (2 * sr));
    }
    const g = this.g;
    const k = 4.0 * (res < 0 ? 0 : (res > 1 ? 1 : res));
    const xm = 0.5 * (this.xPrev + x);
    this.xPrev = x;
    const y0 = this.stage(xm, g, k);
    const y1 = this.stage(x, g, k);
    const s = this.s;
    for (let i = 0; i < 4; i++) {
      let v = s[i] + TINY; v -= TINY;
      if (Math.abs(v) < 1e-20) v = 0;
      s[i] = v;
    }
    const out = 0.5 * (y0 + y1) * (1 + 0.5 * k);
    if (!(out === out)) { this.reset(); return 0; }
    return out;
  }
}

// ---------------------------------------------------------------------------
const ST_IDLE = 0, ST_ATT = 1, ST_HOLD = 2, ST_DEC = 3, ST_SUS = 4, ST_REL = 5;
const EXP_NORM = 1 / (1 - Math.exp(-5));
const LOG_NORM = 1 / Math.log(100);

// Coefficients shared by every voice's copy of one envelope; recomputed only
// when the smoothed time parameters move.
class EnvShape {
  constructor() {
    this.a = -1; this.h = -1; this.d = -1; this.r = -1; this.s = 0;
    this.curve = 0; this.velExp = 0;
    this.dp = 0; this.holdN = 0; this.dc = 0; this.rc = 0;
  }
  update(a, h, d, s, r, curve, velExp, sr) {
    if (a !== this.a) { this.a = a; this.dp = 1 / (Math.max(a, 0.0005) * sr); }
    if (h !== this.h) { this.h = h; this.holdN = Math.round(Math.max(h, 0) * sr); }
    // Times are measured to -60 dB: coeff = exp(-ln(1000) / (t * sr)).
    if (d !== this.d) { this.d = d; this.dc = Math.exp(-LN1000 / (Math.max(d, 0.001) * sr)); }
    if (r !== this.r) { this.r = r; this.rc = Math.exp(-LN1000 / (Math.max(r, 0.001) * sr)); }
    this.s = s < 0 ? 0 : (s > 1 ? 1 : s);
    this.curve = curve;
    this.velExp = velExp;
  }
}

class ADSR {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.state = ST_IDLE;
    this.level = 0;
    this.out = 0;
    this.depth = 1;
    this.start = 0;
    this.p = 0;
    this.n = 0;
  }
  noteOn(velN, sh) {
    this.depth = sh.velExp > 0 ? Math.pow(velN, sh.velExp) : 1;
    this.start = this.level; // attack always continues from the current level
    this.p = 0;
    this.n = 0;
    this.state = ST_ATT;
  }
  noteOff() {
    if (this.state !== ST_IDLE && this.state !== ST_REL) { this.state = ST_REL; this.n = 0; }
  }
  kill() { this.state = ST_IDLE; this.level = 0; this.out = 0; }
  tick(sh) {
    let lv = this.level;
    switch (this.state) {
      case ST_IDLE:
        this.out = 0;
        return 0;
      case ST_ATT: {
        const p = this.p + sh.dp;
        if (p >= 1) {
          lv = 1; this.p = 1; this.n = 0;
          this.state = sh.holdN > 0 ? ST_HOLD : ST_DEC;
        } else {
          this.p = p;
          let c;
          if (sh.curve === 1) c = (1 - Math.exp(-5 * p)) * EXP_NORM;
          else if (sh.curve === 2) c = Math.log(1 + 99 * p) * LOG_NORM;
          else c = p;
          lv = this.start + (1 - this.start) * c;
        }
        break;
      }
      case ST_HOLD:
        lv = 1;
        if (++this.n >= sh.holdN) { this.state = ST_DEC; this.n = 0; }
        break;
      case ST_DEC: {
        const s = sh.s;
        lv = s + (lv - s) * sh.dc;
        this.n++;
        if (Math.abs(lv - s) < 1e-4) { lv = s; this.state = ST_SUS; this.n = 0; }
        break;
      }
      case ST_SUS:
        lv = sh.s;
        break;
      case ST_REL:
        lv *= sh.rc;
        this.n++;
        if (lv < 1e-5) { lv = 0; this.state = ST_IDLE; }
        break;
    }
    this.level = lv;
    this.out = lv * this.depth;
    return this.out;
  }
}

// ---------------------------------------------------------------------------
const L_SINE = 0, L_TRI = 1, L_SAWUP = 2, L_SAWDN = 3, L_SQR = 4, L_SH = 5, L_SMOOTH = 6;
class LFO {
  constructor(sampleRate, seed) {
    this.invSr = 1 / sampleRate;
    this.sr = sampleRate;
    this.phase = 0;
    this.rng = new Rng(seed);
    this.sh = 0; this.shPrev = 0; this.shNext = 0;
    this.done = false;
    this.fade = 1; this.fadeInc = 0;
    this.out = 0;
  }
  reset(phase, fadeTime) {
    this.phase = phase;
    this.done = false;
    this.sh = this.rng.nextBi();
    this.shPrev = this.rng.nextBi();
    this.shNext = this.rng.nextBi();
    if (fadeTime > 0.0005) { this.fade = 0; this.fadeInc = 1 / (fadeTime * this.sr); }
    else { this.fade = 1; this.fadeInc = 0; }
  }
  tick(rateHz, wave, oneShot) {
    const p = this.phase;
    let v;
    switch (wave) {
      case L_TRI: v = p < 0.5 ? 4 * p - 1 : 3 - 4 * p; break;
      case L_SAWUP: v = 2 * p - 1; break;
      case L_SAWDN: v = 1 - 2 * p; break;
      case L_SQR: v = p < 0.5 ? 1 : -1; break;
      case L_SH: v = this.sh; break;
      case L_SMOOTH: v = this.shPrev + (this.shNext - this.shPrev) * (0.5 - 0.5 * Math.cos(Math.PI * p)); break;
      default: v = Math.sin(TWO_PI * p);
    }
    if (!this.done) {
      let np = p + rateHz * this.invSr;
      if (np >= 1) {
        if (oneShot) { np = 0.999999; this.done = true; }
        else np -= Math.floor(np);
        this.sh = this.rng.nextBi();
        this.shPrev = this.shNext;
        this.shNext = this.rng.nextBi();
      }
      this.phase = np;
    }
    if (this.fade < 1) { this.fade += this.fadeInc; if (this.fade > 1) this.fade = 1; }
    this.out = v * this.fade;
    return this.out;
  }
}

// ---------------------------------------------------------------------------
// Saturation / distortion, 2x oversampled (linear-interpolated upsample,
// 7-tap half-band decimator), followed by a DC blocker.
const WS_SOFT = 0, WS_HARD = 1, WS_TUBE = 2, WS_CRUSH = 3, WS_FOLD = 4;
const HB0 = 0.5, HB1 = 0.28220, HB3 = -0.03220;
class Waveshaper {
  constructor(sampleRate) {
    this.xPrev = 0;
    this.h = new Float64Array(7); // 2x-rate history, h[0] newest
    this.dcX = 0; this.dcY = 0;
    this.dcR = 1 - TWO_PI * 10 / sampleRate;
    this.lastDb = -1; this.d = 1; this.tanhD = Math.tanh(1); this.mk = 1;
    this.hold = 0; this.holdCount = 0;
    this.lastBits = -1; this.q = 128;
  }
  reset() {
    this.xPrev = 0; this.dcX = 0; this.dcY = 0; this.hold = 0; this.holdCount = 0;
    const h = this.h; for (let i = 0; i < 7; i++) h[i] = 0;
  }
  shape(x, mode) {
    const d = this.d;
    switch (mode) {
      case WS_HARD: {
        const y = d * x;
        return (y > 1 ? 1 : (y < -1 ? -1 : y)) * this.mk;
      }
      case WS_TUBE: {
        const y = d * x;
        const o = y >= 0 ? 1 - Math.exp(-y) : -(1 - Math.exp(1.4 * y)) / 1.4;
        return o * this.mk;
      }
      case WS_FOLD: {
        let f = (d * x + 1) * 0.25;
        f -= Math.floor(f);
        return 1 - 4 * Math.abs(f - 0.5);
      }
      default:
        return Math.tanh(d * x) / this.tanhD;
    }
  }
  tick(x, mode, driveDb, bits, srDiv) {
    if (driveDb !== this.lastDb) {
      this.lastDb = driveDb;
      this.d = Math.pow(10, driveDb / 20);
      this.tanhD = Math.tanh(this.d);
      this.mk = 1 / Math.sqrt(this.d);
    }
    let y;
    if (mode === WS_CRUSH) {
      if (bits !== this.lastBits) { this.lastBits = bits; this.q = Math.pow(2, Math.max(1, bits) - 1); }
      if (++this.holdCount >= srDiv) {
        this.holdCount = 0;
        const v = clamp(x * this.d, -1, 1);
        this.hold = Math.round(v * this.q) / this.q;
      }
      y = this.hold * this.mk;
    } else {
      const x0 = 0.5 * (this.xPrev + x);
      this.xPrev = x;
      const h = this.h;
      h[6] = h[4]; h[5] = h[3]; h[4] = h[2]; h[3] = h[1]; h[2] = h[0];
      h[1] = this.shape(x0, mode);
      h[0] = this.shape(x, mode);
      y = HB0 * h[3] + HB1 * (h[2] + h[4]) + HB3 * (h[0] + h[6]);
    }
    const o = y - this.dcX + this.dcR * this.dcY;
    this.dcX = y;
    let dy = o + TINY; dy -= TINY;
    if (Math.abs(dy) < 1e-20) dy = 0;
    this.dcY = dy;
    return o === o ? o : 0;
  }
}

// ---------------------------------------------------------------------------
class BBDChorus {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.N = 96000;
    this.bufs = new Array(6);
    for (let i = 0; i < 6; i++) this.bufs[i] = new Float32Array(this.N);
    this.w = 0;
    this.ph = new Float64Array(6);
    for (let i = 0; i < 6; i++) this.ph[i] = i / 6;
    this.lp = new Float64Array(6);
    this.lpC = 1 - Math.exp(-TWO_PI * 9000 / sampleRate);
    this.outL = 0; this.outR = 0;
  }
  clear() { for (let i = 0; i < 6; i++) { this.bufs[i].fill(0); this.lp[i] = 0; } }
  tick(inL, inR, lines, rate, depthMs, delayMs, mix) {
    const sr = this.sr, N = this.N, w = this.w;
    if (lines < 2) lines = 2; else if (lines > 6) lines = 6;
    let L = 0, R = 0, nL = 0, nR = 0;
    for (let i = 0; i < 6; i++) {
      const buf = this.bufs[i];
      buf[w] = (i & 1) ? inR : inL;
      if (i >= lines) continue;
      let p = this.ph[i] + (rate + 0.03 * i) / sr;
      if (p >= 1) p -= 1;
      this.ph[i] = p;
      const dMs = delayMs * (1 + 0.13 * i) + depthMs * Math.sin(TWO_PI * p);
      let rp = w - Math.max(1, dMs * 0.001 * sr);
      if (rp < 0) rp += N;
      const i0 = rp | 0, fr = rp - i0, i1 = i0 + 1 >= N ? 0 : i0 + 1;
      const y = buf[i0] + (buf[i1] - buf[i0]) * fr;
      let s = this.lp[i] + this.lpC * (y - this.lp[i]) + TINY;
      s -= TINY;
      if (Math.abs(s) < 1e-20) s = 0;
      this.lp[i] = s;
      if (i & 1) { R += s; nR++; } else { L += s; nL++; }
    }
    this.w = w + 1 >= N ? 0 : w + 1;
    L /= nL; R /= nR;
    this.outL = inL + (L - inL) * mix;
    this.outR = inR + (R - inR) * mix;
  }
}

// ---------------------------------------------------------------------------
class StereoDelay {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.size = Math.ceil(2 * sampleRate) + 4;
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.w = 0;
    this.time = new SmoothedParam(0.35 * sampleRate, 80, sampleRate);
    this.hpC = Math.exp(-TWO_PI * 200 / sampleRate);
    this.lpC = 1 - Math.exp(-TWO_PI * 8000 / sampleRate);
    this.hxL = 0; this.hyL = 0; this.lpL = 0;
    this.hxR = 0; this.hyR = 0; this.lpR = 0;
    this.outL = 0; this.outR = 0;
  }
  clear() {
    this.bufL.fill(0); this.bufR.fill(0);
    this.hxL = this.hyL = this.lpL = this.hxR = this.hyR = this.lpR = 0;
  }
  read(buf, d) {
    let rp = this.w - d;
    if (rp < 0) rp += this.size;
    const i0 = rp | 0, fr = rp - i0, i1 = i0 + 1 >= this.size ? 0 : i0 + 1;
    return buf[i0] + (buf[i1] - buf[i0]) * fr;
  }
  tick(inL, inR, send, delaySamples, fb, pingpong) {
    this.time.set(clamp(delaySamples, 1, this.size - 4));
    const d = this.time.tick();
    const yL = this.read(this.bufL, d);
    const yR = this.read(this.bufR, d);
    // Feedback path: 1-pole HPF 200 Hz then 1-pole LPF 8 kHz
    let hL = this.hpC * (this.hyL + yL - this.hxL); this.hxL = yL;
    let hR = this.hpC * (this.hyR + yR - this.hxR); this.hxR = yR;
    hL += TINY; hL -= TINY; hR += TINY; hR -= TINY;
    if (Math.abs(hL) < 1e-20) hL = 0;
    if (Math.abs(hR) < 1e-20) hR = 0;
    this.hyL = hL; this.hyR = hR;
    let lL = this.lpL + this.lpC * (hL - this.lpL);
    let lR = this.lpR + this.lpC * (hR - this.lpR);
    if (Math.abs(lL) < 1e-20) lL = 0;
    if (Math.abs(lR) < 1e-20) lR = 0;
    this.lpL = lL; this.lpR = lR;
    const g = fb < 0 ? 0 : (fb > 0.99 ? 0.99 : fb);
    let wL, wR;
    if (pingpong) {
      wL = (inL + inR) * 0.5 * send + lR * g;
      wR = lL * g;
    } else {
      wL = inL * send + lL * g;
      wR = inR * send + lR * g;
    }
    this.bufL[this.w] = wL === wL ? wL : 0;
    this.bufR[this.w] = wR === wR ? wR : 0;
    this.w++; if (this.w >= this.size) this.w = 0;
    this.outL = yL; this.outR = yR;
  }
}

// ---------------------------------------------------------------------------
const FDN_BASE = [1423, 1693, 2017, 2399, 2833, 3391, 4021, 4783];
const HADAMARD_SCALE = 1 / Math.sqrt(8);
class FDNReverb {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.scale = sampleRate / 44100;
    this.bufs = new Array(8);
    this.sizes = new Int32Array(8);
    this.w = new Int32Array(8);
    for (let i = 0; i < 8; i++) {
      const n = Math.ceil(FDN_BASE[i] * 2 * this.scale) + 8;
      this.bufs[i] = new Float32Array(n);
      this.sizes[i] = n;
    }
    this.lens = new Float64Array(8);
    this.gains = new Float64Array(8);
    this.lp = new Float64Array(8);
    this.tmp = new Float64Array(8);
    this.size = new SmoothedParam(1, 150, sampleRate);
    this.lastSize = -1; this.lastDecay = -1; this.lastDamp = -1; this.dampC = 0.5;
    this.preSize = Math.ceil(0.1 * sampleRate) + 4;
    this.pre = new Float32Array(this.preSize);
    this.pw = 0;
    this.outL = 0; this.outR = 0;
  }
  clear() {
    for (let i = 0; i < 8; i++) { this.bufs[i].fill(0); this.lp[i] = 0; }
    this.pre.fill(0);
  }
  tick(inL, inR, size, decay, damp, preMs, freeze) {
    this.size.set(clamp(size, 0.2, 2));
    const sz = this.size.tick();
    if (sz !== this.lastSize || decay !== this.lastDecay) {
      this.lastSize = sz; this.lastDecay = decay;
      const dcy = decay > 0.05 ? decay : 0.05;
      for (let i = 0; i < 8; i++) {
        const len = FDN_BASE[i] * this.scale * sz;
        this.lens[i] = len;
        this.gains[i] = Math.pow(10, -3 * len / (this.sr * dcy));
      }
    }
    if (damp !== this.lastDamp) {
      this.lastDamp = damp;
      this.dampC = 1 - Math.exp(-TWO_PI * clamp(damp, 200, 12000) / this.sr);
    }
    // Pre-delay
    this.pre[this.pw] = (inL + inR) * 0.5;
    const pd = clamp(preMs * 0.001 * this.sr, 0, this.preSize - 2) | 0;
    let prp = this.pw - pd; if (prp < 0) prp += this.preSize;
    const xin = freeze ? 0 : this.pre[prp];
    this.pw++; if (this.pw >= this.preSize) this.pw = 0;

    const t = this.tmp;
    let L = 0, R = 0;
    for (let i = 0; i < 8; i++) {
      const buf = this.bufs[i], n = this.sizes[i];
      let rp = this.w[i] - this.lens[i];
      if (rp < 0) rp += n;
      const i0 = rp | 0, fr = rp - i0, i1 = i0 + 1 >= n ? 0 : i0 + 1;
      const y = buf[i0] + (buf[i1] - buf[i0]) * fr;
      if (i & 1) R += y; else L += y;
      if (freeze) {
        t[i] = y;
      } else {
        let s = this.lp[i] + this.dampC * (y - this.lp[i]) + TINY;
        s -= TINY;
        if (Math.abs(s) < 1e-20) s = 0;
        this.lp[i] = s;
        t[i] = s * this.gains[i];
      }
    }
    // 8x8 Hadamard via fast Walsh–Hadamard butterflies (orthonormal after scaling)
    for (let h = 1; h < 8; h <<= 1) {
      for (let i = 0; i < 8; i += h << 1) {
        for (let j = i; j < i + h; j++) {
          const a = t[j], b = t[j + h];
          t[j] = a + b; t[j + h] = a - b;
        }
      }
    }
    for (let i = 0; i < 8; i++) {
      let v = t[i] * HADAMARD_SCALE + xin * ((i & 1) ? -0.5 : 0.5);
      if (!(v === v)) v = 0;
      this.bufs[i][this.w[i]] = v;
      this.w[i]++; if (this.w[i] >= this.sizes[i]) this.w[i] = 0;
    }
    this.outL = L * 0.3;
    this.outR = R * 0.3;
  }
}

// ---------------------------------------------------------------------------
class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1L = 0; this.z2L = 0; this.z1R = 0; this.z2R = 0;
    this.outL = 0; this.outR = 0;
  }
  set(b0, b1, b2, a0, a1, a2) {
    const i = 1 / a0;
    this.b0 = b0 * i; this.b1 = b1 * i; this.b2 = b2 * i; this.a1 = a1 * i; this.a2 = a2 * i;
  }
  lowShelf(f, db, sr) {
    const A = Math.pow(10, db / 40), w = TWO_PI * f / sr, c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.SQRT2, sa = 2 * Math.sqrt(A) * al;
    this.set(A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa),
      (A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa);
  }
  highShelf(f, db, sr) {
    const A = Math.pow(10, db / 40), w = TWO_PI * f / sr, c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.SQRT2, sa = 2 * Math.sqrt(A) * al;
    this.set(A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa),
      (A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa);
  }
  peaking(f, db, q, sr) {
    const A = Math.pow(10, db / 40), w = TWO_PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  tick(xL, xR) {
    const yL = this.b0 * xL + this.z1L;
    this.z1L = this.b1 * xL - this.a1 * yL + this.z2L;
    this.z2L = this.b2 * xL - this.a2 * yL;
    const yR = this.b0 * xR + this.z1R;
    this.z1R = this.b1 * xR - this.a1 * yR + this.z2R;
    this.z2R = this.b2 * xR - this.a2 * yR;
    if (Math.abs(this.z1L) < 1e-20) this.z1L = 0;
    if (Math.abs(this.z2L) < 1e-20) this.z2L = 0;
    if (Math.abs(this.z1R) < 1e-20) this.z1R = 0;
    if (Math.abs(this.z2R) < 1e-20) this.z2R = 0;
    this.outL = yL; this.outR = yR;
  }
}

class ThreeBandEQ {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.low = new Biquad(); this.mid = new Biquad(); this.high = new Biquad();
    this.gl = NaN; this.gm = NaN; this.gh = NaN;
    this.outL = 0; this.outR = 0;
  }
  tick(L, R, gl, gm, gh) {
    if (gl !== this.gl) { this.gl = gl; this.low.lowShelf(80, gl, this.sr); }
    if (gm !== this.gm) { this.gm = gm; this.mid.peaking(800, gm, 0.8, this.sr); }
    if (gh !== this.gh) { this.gh = gh; this.high.highShelf(8000, gh, this.sr); }
    if (gl === 0 && gm === 0 && gh === 0) { this.outL = L; this.outR = R; return; }
    this.low.tick(L, R);
    this.mid.tick(this.low.outL, this.low.outR);
    this.high.tick(this.mid.outL, this.mid.outR);
    this.outL = this.high.outL; this.outR = this.high.outR;
  }
}

// ---------------------------------------------------------------------------
// 300 ms RMS detector, 4 ms lookahead, ±3 dB soft knee, parallel blend.
class Compressor {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.win = Math.round(0.3 * sampleRate);
    this.sq = new Float64Array(this.win);
    this.idx = 0; this.sum = 0;
    this.la = Math.round(0.004 * sampleRate);
    this.dN = this.la + 1;
    this.dL = new Float32Array(this.dN); this.dR = new Float32Array(this.dN);
    this.di = 0;
    this.grDb = 0;
    this.lastAtt = -1; this.lastRel = -1; this.cA = 0; this.cR = 0;
    this.outL = 0; this.outR = 0;
  }
  tick(L, R, on, thr, ratio, attMs, relMs, makeupDb, mix) {
    const m = 0.5 * (L * L + R * R);
    this.sum += m - this.sq[this.idx];
    this.sq[this.idx] = m;
    if (++this.idx >= this.win) this.idx = 0;
    if (this.sum < 0) this.sum = 0;
    // lookahead: the audio path is delayed; the detector sees the undelayed input
    const dl = this.dL[this.di], dr = this.dR[this.di];
    this.dL[this.di] = L; this.dR[this.di] = R;
    if (++this.di >= this.dN) this.di = 0;
    if (!on) { this.grDb *= 0.999; this.outL = dl; this.outR = dr; return; }
    if (attMs !== this.lastAtt) { this.lastAtt = attMs; this.cA = Math.exp(-1 / (Math.max(attMs, 0.1) * 0.001 * this.sr)); }
    if (relMs !== this.lastRel) { this.lastRel = relMs; this.cR = Math.exp(-1 / (Math.max(relMs, 10) * 0.001 * this.sr)); }
    const rms = Math.sqrt(this.sum / this.win);
    const lvl = 20 * Math.log10(rms + 1e-12);
    const W = 6;
    const over = lvl - thr;
    let gr;
    if (2 * over < -W) gr = 0;
    else if (2 * Math.abs(over) <= W) { const t = over + W / 2; gr = (1 - 1 / ratio) * t * t / (2 * W); }
    else gr = over * (1 - 1 / ratio);
    if (gr > this.grDb) this.grDb = gr + (this.grDb - gr) * this.cA;
    else this.grDb = gr + (this.grDb - gr) * this.cR;
    const g = Math.pow(10, (makeupDb - this.grDb) / 20);
    this.outL = dl + (dl * g - dl) * mix;
    this.outR = dr + (dr * g - dr) * mix;
  }
}

// ---------------------------------------------------------------------------
// True-peak limiter: 4x windowed-sinc interpolation finds inter-sample peaks,
// an 8-sample lookahead minimum gives sample-accurate attack, 50 ms release,
// and a final clamp guarantees nothing exceeds the ceiling.
class TruePeakLimiter {
  constructor(sampleRate) {
    this.ceil = Math.pow(10, -0.1 / 20);
    this.rel = Math.exp(-1 / (0.05 * sampleRate));
    this.hL = new Float64Array(8); this.hR = new Float64Array(8);
    this.c = new Float64Array(24); // 3 fractional phases x 8 taps
    for (let k = 1; k <= 3; k++) {
      let sum = 0;
      for (let j = 0; j < 8; j++) {
        const x = j - (3 + k / 4);
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const win = 0.5 + 0.5 * Math.cos(Math.PI * x / 4.5);
        this.c[(k - 1) * 8 + j] = sinc * win;
        sum += sinc * win;
      }
      for (let j = 0; j < 8; j++) this.c[(k - 1) * 8 + j] /= sum;
    }
    this.W = 8;
    this.req = new Float64Array(this.W); this.ri = 0;
    for (let i = 0; i < this.W; i++) this.req[i] = 1;
    this.D = 4 + this.W - 1;
    this.dN = 16;
    this.dL = new Float32Array(this.dN); this.dR = new Float32Array(this.dN);
    this.dw = 0;
    this.g = 1;
    this.outL = 0; this.outR = 0;
  }
  truePeak(h) {
    let pk = Math.abs(h[3]);
    const c = this.c;
    for (let k = 0; k < 3; k++) {
      const o = k * 8;
      const v = c[o] * h[0] + c[o + 1] * h[1] + c[o + 2] * h[2] + c[o + 3] * h[3] +
        c[o + 4] * h[4] + c[o + 5] * h[5] + c[o + 6] * h[6] + c[o + 7] * h[7];
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
    }
    return pk;
  }
  tick(L, R) {
    const hL = this.hL, hR = this.hR;
    for (let i = 0; i < 7; i++) { hL[i] = hL[i + 1]; hR[i] = hR[i + 1]; }
    hL[7] = L; hR[7] = R;
    const pk = Math.max(this.truePeak(hL), this.truePeak(hR));
    this.req[this.ri] = pk > this.ceil ? this.ceil / pk : 1;
    if (++this.ri >= this.W) this.ri = 0;
    let gmin = 1;
    for (let i = 0; i < this.W; i++) if (this.req[i] < gmin) gmin = this.req[i];
    if (gmin < this.g) this.g = gmin;
    else this.g = gmin + (this.g - gmin) * this.rel;
    this.dL[this.dw] = L; this.dR[this.dw] = R;
    let rp = this.dw - this.D; if (rp < 0) rp += this.dN;
    if (++this.dw >= this.dN) this.dw = 0;
    const c = this.ceil;
    let oL = this.dL[rp] * this.g, oR = this.dR[rp] * this.g;
    oL = oL > c ? c : (oL < -c ? -c : oL);
    oR = oR > c ? c : (oR < -c ? -c : oR);
    this.outL = oL === oL ? oL : 0;
    this.outR = oR === oR ? oR : 0;
  }
}

// ---------------------------------------------------------------------------
// Modulation matrix: 16 slots read from the parameter table. compile() runs
// once per block; evaluate() runs once per voice per sample.
class ModMatrix {
  constructor() {
    this.n = 0;
    this.src = new Int32Array(16);
    this.dst = new Int32Array(16);
    this.curve = new Int32Array(16);
    this.depthIdx = new Int32Array(16);
    this.lfoUsed = new Uint8Array(4);
  }
  compile() {
    const pv = PV;
    let n = 0;
    this.lfoUsed[0] = this.lfoUsed[1] = this.lfoUsed[2] = this.lfoUsed[3] = 0;
    for (let i = 0; i < 16; i++) {
      const b = P_MOD0_SRC + i * MOD_STRIDE;
      if (pv[b + 4] < 0.5) continue;
      const s = pv[b] | 0, d = pv[b + 1] | 0;
      if (s <= 0 || d <= 0 || s >= NSRC || d >= NDST) continue;
      this.src[n] = s; this.dst[n] = d; this.curve[n] = pv[b + 3] | 0; this.depthIdx[n] = b + 2;
      if (s >= S_LFO1 && s <= S_LFO4) this.lfoUsed[s - S_LFO1] = 1;
      n++;
    }
    this.n = n;
  }
  evaluate(src, mod) {
    for (let i = 0; i < NDST; i++) mod[i] = 0;
    const pv = PV;
    for (let i = 0; i < this.n; i++) {
      const v = src[this.src[i]];
      let c;
      switch (this.curve[i]) {
        case 1: c = v * v; break;
        case 2: c = v < 0 ? -Math.sqrt(-v) : Math.sqrt(v); break;
        case 3: c = v > 0.5 ? 1 : 0; break;
        default: c = v;
      }
      mod[this.dst[i]] += pv[this.depthIdx[i]] * c;
    }
  }
}

// ---------------------------------------------------------------------------
const V_FREE = 0, V_ACTIVE = 1, V_RELEASING = 2;
class SynthVoice {
  constructor(sampleRate, idx) {
    this.sr = sampleRate;
    this.invSr = 1 / sampleRate;
    this.idx = idx;
    this.rng = new Rng(0x9E3779B9 ^ ((idx + 1) * 2654435761));
    this.osc1 = new WavetableOscillator(sampleRate, true);
    this.osc2 = new WavetableOscillator(sampleRate, true);
    this.subPhase = 0;
    this.svf = new TPT_SVF(sampleRate);
    this.ladder = new MoogLadderFilter(sampleRate);
    this.env = [new ADSR(sampleRate), new ADSR(sampleRate), new ADSR(sampleRate), new ADSR(sampleRate)];
    this.lfo = [
      new LFO(sampleRate, 1013 + idx * 17), new LFO(sampleRate, 2029 + idx * 31),
      new LFO(sampleRate, 3041 + idx * 43), new LFO(sampleRate, 4057 + idx * 59)
    ];
    this.shaper = new Waveshaper(sampleRate);
    this.src = new Float64Array(NSRC);
    this.mod = new Float64Array(NDST);
    this.state = V_FREE;
    this.note = 60; this.ch = 0; this.vel = 0; this.velN = 0;
    this.age = 0; this.claim = 0;
    this.keyDown = false; this.sustained = false;
    this.glideNote = 60; this.targetNote = 60;
    this.detune = 0; this.panOff = 0;
    this.bendS = 0; this.pressS = 0; this.slideS = 0;
    this.fading = false; this.fade = 1;
    this.pNote = 60; this.pVel = 0; this.pCh = 0; this.pDet = 0; this.pPan = 0;
    this.pRand = false; this.pGlide = -1; this.pKeyDown = false;
    this.lastPan = 99; this.gL = Math.SQRT1_2; this.gR = Math.SQRT1_2;
    this.outL = 0; this.outR = 0; this.level = 0;
  }

  start(note, vel, ch, detune, panOff, randPhase, glideFrom, resetOsc) {
    const pv = PV;
    const wasFree = this.state === V_FREE;
    this.note = note; this.targetNote = note;
    this.vel = vel; this.velN = vel / 127; this.ch = ch & 15;
    this.detune = detune; this.panOff = panOff;
    this.age = ++G.noteCounter;
    this.keyDown = true; this.sustained = false;
    this.state = V_ACTIVE;
    this.glideNote = glideFrom >= 0 ? glideFrom : note;
    if (wasFree) {
      this.svf.reset(); this.ladder.reset(); this.shaper.reset();
      this.bendS = G.chBend[this.ch]; this.pressS = 0; this.slideS = G.chSlide[this.ch];
    }
    if (resetOsc || wasFree) {
      const p1 = randPhase ? this.rng.next01() : 0;
      const p2 = randPhase ? this.rng.next01() : pv[P_OSC2_PHASE];
      this.osc1.reset(p1, this.rng);
      this.osc2.reset(p2, this.rng);
      this.subPhase = p1 * 0.5;
    }
    for (let k = 0; k < 4; k++) this.env[k].noteOn(this.velN, G.env[k]);
    for (let k = 0; k < 4; k++) {
      const b = P_LFO1_WAVE + k * LFO_STRIDE;
      const mode = pv[b + LFO_MODE_OFF] | 0;
      let ph = pv[b + LFO_PHASE_OFF] / 360;
      if (mode === 1) ph += G.lfoFree[k];
      ph -= Math.floor(ph);
      this.lfo[k].reset(ph, pv[b + LFO_FADE_OFF]);
    }
  }

  // Legato move to a new pitch: envelopes and phases keep running.
  retarget(note, vel) {
    this.note = note; this.targetNote = note;
    if (PV[P_GLIDE] <= 0.0005) this.glideNote = note;
    this.keyDown = true; this.sustained = false;
    if (this.state === V_RELEASING) {
      this.state = V_ACTIVE;
      for (let k = 0; k < 4; k++) this.env[k].noteOn(vel / 127, G.env[k]);
    }
  }

  // Voice stealing: release the old note, fade 1.5 ms, then start the new one.
  steal(note, vel, ch, detune, panOff, randPhase, glideFrom) {
    for (let k = 0; k < 4; k++) this.env[k].noteOff();
    this.pNote = note; this.pVel = vel; this.pCh = ch; this.pDet = detune; this.pPan = panOff;
    this.pRand = randPhase; this.pGlide = glideFrom; this.pKeyDown = true;
    this.note = note; this.ch = ch & 15;
    this.keyDown = true; this.sustained = false;
    this.age = ++G.noteCounter;
    this.state = V_ACTIVE;
    if (!this.fading) { this.fading = true; this.fade = 1; }
  }

  release() {
    if (this.fading) { this.pKeyDown = false; this.keyDown = false; return; }
    this.keyDown = false;
    this.sustained = false;
    if (this.state === V_FREE) return;
    for (let k = 0; k < 4; k++) this.env[k].noteOff();
    this.state = V_RELEASING;
  }

  kill() {
    for (let k = 0; k < 4; k++) this.env[k].kill();
    this.state = V_FREE; this.fading = false; this.fade = 1;
    this.keyDown = false; this.sustained = false;
    this.outL = this.outR = this.level = 0;
  }

  isFree() { return this.state === V_RELEASING && this.env[0].out < 1e-5; }

  tick(mm) {
    const pv = PV;
    const src = this.src, mod = this.mod;
    const kc = G.ctlK;
    const ch = this.ch;
    this.bendS += (G.chBend[ch] - this.bendS) * kc;
    const pT = G.chPress[ch] > G.notePress[this.note] ? G.chPress[ch] : G.notePress[this.note];
    this.pressS += (pT - this.pressS) * kc;
    this.slideS += (G.chSlide[ch] - this.slideS) * kc;

    // LFOs (rate/depth modulation uses the previous sample's matrix output)
    for (let k = 0; k < 4; k++) {
      if (!mm.lfoUsed[k]) { src[S_LFO1 + k] = 0; continue; }
      const b = P_LFO1_WAVE + k * LFO_STRIDE;
      let rate = G.lfoHz[k];
      let depth = pv[b + LFO_DEPTH_OFF];
      if (k === 0) {
        const rm = mod[D_LFO1_RATE];
        if (rm !== 0) rate *= Math.exp(rm * 4 * Math.LN2);
        depth += mod[D_LFO1_DEPTH];
      } else if (k === 1) {
        const rm = mod[D_LFO2_RATE];
        if (rm !== 0) rate *= Math.exp(rm * 4 * Math.LN2);
        depth += mod[D_LFO2_DEPTH];
      }
      rate = rate < 0.01 ? 0.01 : (rate > 100 ? 100 : rate);
      depth = depth < 0 ? 0 : (depth > 1 ? 1 : depth);
      src[S_LFO1 + k] = this.lfo[k].tick(rate, pv[b] | 0, (pv[b + LFO_MODE_OFF] | 0) === 2) * depth;
    }
    // Envelopes
    const e1 = this.env[0].tick(G.env[0]);
    src[S_ENV1] = e1;
    src[S_ENV2] = this.env[1].tick(G.env[1]);
    src[S_ENV3] = this.env[2].tick(G.env[2]);
    src[S_ENV4] = this.env[3].tick(G.env[3]);
    src[S_VELOCITY] = this.velN;
    src[S_AFTERTOUCH] = clamp(G.at + this.pressS, 0, 1);
    src[S_PITCH_BEND] = clamp(G.bend + this.bendS, -1, 1);
    src[S_MOD_WHEEL] = G.modWheel;
    src[S_EXPRESSION] = G.expr;
    src[S_CC74] = G.mpe ? this.slideS : G.cc74;
    src[S_NOTE_NUMBER] = (this.note - 60) / 64;
    mm.evaluate(src, mod);

    // Pitch
    if (this.glideNote !== this.targetNote) {
      if (pv[P_GLIDE] <= 0.0005) this.glideNote = this.targetNote;
      else {
        this.glideNote = this.targetNote + (this.glideNote - this.targetNote) * G.glideCoeff;
        if (Math.abs(this.glideNote - this.targetNote) < 1e-4) this.glideNote = this.targetNote;
      }
    }
    const bendRange = clamp(pv[P_BEND_RANGE] + mod[D_PITCH_BEND_RANGE] * 24, 0, 48);
    const base = this.glideNote + this.detune * 0.01 + G.bend * bendRange + this.bendS * G.mpeRange +
      pv[P_PITCH_ENV_AMT] * src[S_ENV3];
    const n1 = base + 12 * pv[P_OSC1_OCT] + pv[P_OSC1_COARSE] + (pv[P_OSC1_FINE] + mod[D_OSC1_FINE] * 100) * 0.01 + mod[D_OSC1_PITCH] * 24;
    const n2 = base + 12 * pv[P_OSC2_OCT] + pv[P_OSC2_COARSE] + (pv[P_OSC2_FINE] + mod[D_OSC2_FINE] * 100) * 0.01 + mod[D_OSC2_PITCH] * 24;
    const f1 = 440 * Math.exp((n1 - 69) * SEMI);
    const f2 = 440 * Math.exp((n2 - 69) * SEMI);
    const pw1 = clamp(pv[P_OSC1_PW] + mod[D_OSC1_PW] * 0.49, 0.01, 0.99);
    const pw2 = clamp(pv[P_OSC2_PW] + mod[D_OSC2_PW] * 0.49, 0.01, 0.99);

    const o1 = this.osc1.tick(f1, pv[P_OSC1_WAVE] | 0, pw1, pv[P_OSC1_SPREAD]);
    let o2 = this.osc2.tick(f2, pv[P_OSC2_WAVE] | 0, pw2, pv[P_OSC2_SPREAD]);
    if (pv[P_OSC2_SYNC] > 0.5 && this.osc1.wrapped && this.osc1.dt > 0) {
      this.osc2.syncReset(this.osc1.phase / this.osc1.dt);
    }
    if (pv[P_OSC2_RING] > 0.5) o2 = o1 * o2;
    const sub = Math.sin(TWO_PI * this.subPhase);
    let sp = this.subPhase + f1 * 0.5 * this.invSr;
    if (sp >= 1) sp -= Math.floor(sp);
    this.subPhase = sp;
    const noise = this.rng.nextBi();

    const l1 = clamp(pv[P_OSC1_LEVEL] + mod[D_OSC1_LEVEL], 0, 1);
    const l2 = clamp(pv[P_OSC2_LEVEL] + mod[D_OSC2_LEVEL], 0, 1);
    const ls = clamp(pv[P_SUB_LEVEL] + mod[D_SUB_LEVEL], 0, 1);
    const ln = clamp(pv[P_NOISE_LEVEL] + mod[D_NOISE_LEVEL], 0, 1);
    let x = o1 * l1 + o2 * l2 + sub * ls + noise * ln * 0.7;

    // Pre-filter waveshaper
    const shMode = pv[P_FLT_SHAPER] | 0;
    if (shMode > 0) {
      const drv = clamp(pv[P_FLT_DRIVE] + mod[D_FILTER_DRIVE] * 24, 0, 24);
      x = this.shaper.tick(x, shMode - 1, drv, 16 - drv * 0.5, 1 + ((drv * 0.5) | 0));
    }

    // Filter
    let oct = pv[P_FLT_ENV_AMT] * src[S_ENV2] * 6 +
      pv[P_FLT_KEYTRACK] * 0.01 * (this.glideNote - 60) / 12 +
      mod[D_FILTER_CUTOFF] * 5;
    const fm = clamp(pv[P_FLT_FM] + mod[D_FILTER_FM], 0, 1);
    if (fm > 0) oct += fm * o2 * 3;
    if (oct > 12) oct = 12; else if (oct < -12) oct = -12;
    const fc = pv[P_FLT_CUTOFF] * Math.exp(oct * Math.LN2);
    const res = clamp(pv[P_FLT_RES] + mod[D_FILTER_RESONANCE], 0, 1.1);
    const type = pv[P_FLT_TYPE] | 0;
    let y;
    if (type === 1) {
      y = this.ladder.tick(x, fc, res > 1 ? 1 : res);
    } else {
      const svf = this.svf;
      svf.fc.set(fc);
      svf.Q.set(1 / (2 * (1.1 - res + 0.001)));
      y = svf.tick(x, pv[P_FLT_MODE] | 0);
      if (type === 2) y = this.ladder.tick(y, fc, res > 1 ? 1 : res);
    }

    // VCA
    let amp = e1 * clamp(1 + mod[D_AMP], 0, 2);
    if (this.fading) {
      amp *= this.fade;
      this.fade -= G.fadeStep;
      if (this.fade <= 0) {
        this.fading = false;
        this.fade = 1;
        const kd = this.pKeyDown, sus = this.sustained;
        this.state = V_FREE;
        this.start(this.pNote, this.pVel, this.pCh, this.pDet, this.pPan, this.pRand, this.pGlide, true);
        if (sus) { this.keyDown = false; this.sustained = true; }
        else if (!kd) this.release();
      }
    }
    const pan = clamp(this.panOff + mod[D_PAN], -1, 1);
    if (pan !== this.lastPan) {
      this.lastPan = pan;
      const a = (pan + 1) * Math.PI * 0.25;
      this.gL = Math.cos(a); this.gR = Math.sin(a);
    }
    let v = y * amp;
    if (!(v === v)) v = 0;
    this.outL = v * this.gL;
    this.outR = v * this.gR;
    this.level = e1;
    if (!this.fading && this.state === V_RELEASING && this.env[0].state === ST_IDLE) this.state = V_FREE;
  }
}

// ---------------------------------------------------------------------------
class VoicePool {
  constructor(sampleRate) {
    this.voices = new Array(8);
    for (let i = 0; i < 8; i++) this.voices[i] = new SynthVoice(sampleRate, i);
    this.rr = 0;
    this.claimId = 0;
    this.sustain = false;
    this.stack = new Int16Array(128);
    this.stackN = 0;
    this.lastNote = -1;
    this.busL = 0; this.busR = 0;
  }

  allocate(claim) {
    const vs = this.voices;
    const strat = PV[P_ALLOC] | 0;
    for (let i = 0; i < 8; i++) {
      const idx = strat === 2 ? (this.rr + i) & 7 : i;
      const v = vs[idx];
      if (v.claim !== claim && v.state === V_FREE && !v.fading) {
        if (strat === 2) this.rr = (idx + 1) & 7;
        return v;
      }
    }
    if (strat === 2) {
      for (let i = 0; i < 8; i++) {
        const idx = (this.rr + i) & 7;
        if (vs[idx].claim !== claim) { this.rr = (idx + 1) & 7; return vs[idx]; }
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      let best = null, bestScore = Infinity;
      for (let i = 0; i < 8; i++) {
        const v = vs[i];
        if (v.claim === claim) continue;
        if (pass === 0 && v.state !== V_RELEASING) continue;
        const score = strat === 1 ? v.level : v.age;
        if (score < bestScore) { bestScore = score; best = v; }
      }
      if (best) return best;
    }
    return vs[0];
  }

  pushNote(note) {
    this.removeNote(note);
    if (this.stackN < 128) this.stack[this.stackN++] = note;
  }
  removeNote(note) {
    let w = 0;
    for (let i = 0; i < this.stackN; i++) if (this.stack[i] !== note) this.stack[w++] = this.stack[i];
    this.stackN = w;
  }

  noteOn(note, vel, ch) {
    const pv = PV;
    const mode = pv[P_VOICE_MODE] | 0;
    let uni = pv[P_UNISON] | 0; if (uni < 1) uni = 1; else if (uni > 8) uni = 8;
    const det = pv[P_UNI_DETUNE], width = pv[P_UNI_WIDTH];
    const glideOn = pv[P_GLIDE] > 0.0005;
    if (mode === 0) {
      const claim = ++this.claimId;
      const glideFrom = glideOn ? this.lastNote : -1;
      for (let u = 0; u < uni; u++) {
        const k = uni > 1 ? (u / (uni - 1)) * 2 - 1 : 0;
        const v = this.allocate(claim);
        v.claim = claim;
        if (v.state === V_FREE && !v.fading) v.start(note, vel, ch, k * det, k * width, uni > 1, glideFrom, true);
        else v.steal(note, vel, ch, k * det, k * width, uni > 1, glideFrom);
      }
    } else {
      const othersHeld = this.stackN > 0;
      this.pushNote(note);
      for (let u = 0; u < uni; u++) {
        const k = uni > 1 ? (u / (uni - 1)) * 2 - 1 : 0;
        const v = this.voices[u];
        if (mode === 2 && othersHeld && v.state === V_ACTIVE && !v.fading) {
          v.retarget(note, vel);
        } else {
          const glideFrom = glideOn && v.state !== V_FREE ? v.glideNote : (glideOn ? this.lastNote : -1);
          v.start(note, vel, ch, k * det, k * width, uni > 1 && v.state === V_FREE, glideFrom, v.state === V_FREE);
        }
      }
    }
    this.lastNote = note;
  }

  noteOff(note, ch) {
    const mode = PV[P_VOICE_MODE] | 0;
    const vs = this.voices;
    if (mode === 0) {
      for (let i = 0; i < 8; i++) {
        const v = vs[i];
        if (v.keyDown && v.note === note && (!G.mpe || v.ch === (ch & 15))) {
          if (this.sustain) { v.keyDown = false; v.sustained = true; if (v.fading) v.pKeyDown = true; }
          else v.release();
        }
      }
      return;
    }
    let uni = PV[P_UNISON] | 0; if (uni < 1) uni = 1; else if (uni > 8) uni = 8;
    const wasTop = this.stackN > 0 && this.stack[this.stackN - 1] === note;
    this.removeNote(note);
    if (!wasTop) return;
    if (this.stackN > 0) {
      const prev = this.stack[this.stackN - 1];
      for (let u = 0; u < uni; u++) if (vs[u].state !== V_FREE) vs[u].retarget(prev, vs[u].vel);
    } else {
      for (let u = 0; u < uni; u++) {
        const v = vs[u];
        if (this.sustain) { v.keyDown = false; v.sustained = true; }
        else v.release();
      }
    }
  }

  setSustain(on) {
    if (on) { this.sustain = true; return; }
    this.sustain = false;
    for (let i = 0; i < 8; i++) {
      const v = this.voices[i];
      if (v.sustained) { v.sustained = false; v.release(); }
    }
  }

  panic() {
    for (let i = 0; i < 8; i++) { const v = this.voices[i]; v.sustained = false; v.release(); }
    this.stackN = 0;
    this.sustain = false;
  }

  kill() {
    for (let i = 0; i < 8; i++) this.voices[i].kill();
    this.stackN = 0;
    this.sustain = false;
  }

  activeCount() {
    let n = 0;
    for (let i = 0; i < 8; i++) if (this.voices[i].state !== V_FREE) n++;
    return n;
  }

  newest() {
    let best = null;
    for (let i = 0; i < 8; i++) {
      const v = this.voices[i];
      if (v.state !== V_FREE && (!best || v.age > best.age)) best = v;
    }
    return best;
  }

  tick(mm) {
    let L = 0, R = 0, w = 0, rs = 0, ds = 0, cs = 0;
    const vs = this.voices;
    for (let i = 0; i < 8; i++) {
      const v = vs[i];
      if (v.state === V_FREE && !v.fading) continue;
      v.tick(mm);
      L += v.outL; R += v.outR;
      const a = v.level + 1e-9;
      w += a;
      rs += a * v.mod[D_REVERB_SEND];
      ds += a * v.mod[D_DELAY_SEND];
      cs += a * v.mod[D_CHORUS_DEPTH];
    }
    if (w > 1e-6) { G.modRev = rs / w; G.modDly = ds / w; G.modCh = cs / w; }
    else { G.modRev = 0; G.modDly = 0; G.modCh = 0; }
    this.busL = L * VOICE_GAIN;
    this.busR = R * VOICE_GAIN;
  }
}

// ---------------------------------------------------------------------------
// Arpeggiator: sample-accurate step clock driven by the global BPM. Tracks the
// physical keys at all times so it can be switched on or off mid-performance
// without stuck notes. Fixed-size typed arrays only; no allocation.
const ARP_UP = 0, ARP_DOWN = 1, ARP_UPDN = 2, ARP_DNUP = 3, ARP_ORDER = 4, ARP_RAND = 5, ARP_CHORD = 6;
const ARP_MAX = 64;
class Arpeggiator {
  constructor(sampleRate, pool) {
    this.sr = sampleRate;
    this.pool = pool;
    this.phys = new Uint8Array(128);
    this.physVel = new Uint8Array(128);
    this.physN = 0;
    this.held = new Int16Array(ARP_MAX);
    this.heldVel = new Uint8Array(ARP_MAX);
    this.heldN = 0;
    this.sorted = new Int16Array(ARP_MAX);
    this.sortedVel = new Uint8Array(ARP_MAX);
    this.line = new Int16Array(ARP_MAX * 4);
    this.lineVel = new Uint8Array(ARP_MAX * 4);
    this.seq = new Int16Array(ARP_MAX * 8);
    this.seqVel = new Uint8Array(ARP_MAX * 8);
    this.seqN = 0;
    this.sounding = new Int16Array(ARP_MAX);
    this.soundN = 0;
    this.stepNotes = new Int16Array(ARP_MAX);
    this.stepN = 0;
    this.pos = -1;
    this.stepCount = 0;
    this.until = 0;
    this.gateLeft = 0;
    this.running = false;
    this.sustain = false;
    this.dirty = true;
    this.uiDirty = true;
    this.rng = new Rng(0xA5F3C1E7);
  }
  on() { return PV[P_ARP_ON] > 0.5; }
  latchOn() { return PV[P_ARP_LATCH] > 0.5; }

  // Physical key events always arrive here; they reach the voices directly when the arp is off.
  keyOn(n, v) {
    if (!this.phys[n]) { this.phys[n] = 1; this.physN++; }
    this.physVel[n] = v;
    if (!this.on()) { this.pool.noteOn(n, v, 0); return; }
    if (this.latchOn() && !this.sustain && this.physN === 1 && this.heldN > 0) this.heldN = 0;
    this.addHeld(n, v);
  }
  keyOff(n) {
    if (this.phys[n]) { this.phys[n] = 0; this.physN--; }
    if (!this.on()) { this.pool.noteOff(n, 0); return; }
    if (this.latchOn() || this.sustain) return;
    this.removeHeld(n);
  }
  addHeld(n, v) {
    for (let i = 0; i < this.heldN; i++) if (this.held[i] === n) { this.heldVel[i] = v; this.dirty = true; return; }
    if (this.heldN >= ARP_MAX) return;
    this.held[this.heldN] = n; this.heldVel[this.heldN] = v; this.heldN++;
    this.dirty = true;
    if (!this.running) { this.running = true; this.pos = -1; this.stepCount = 0; this.until = 0; this.gateLeft = 0; }
  }
  removeHeld(n) {
    let w = 0;
    for (let i = 0; i < this.heldN; i++) {
      if (this.held[i] !== n) { this.held[w] = this.held[i]; this.heldVel[w] = this.heldVel[i]; w++; }
    }
    if (w === this.heldN) return;
    this.heldN = w;
    this.dirty = true;
    if (w === 0) this.stop();
  }
  dropReleased() {
    let w = 0;
    for (let i = 0; i < this.heldN; i++) {
      const n = this.held[i];
      if (this.phys[n]) { this.held[w] = n; this.heldVel[w] = this.heldVel[i]; w++; }
    }
    if (w !== this.heldN) { this.heldN = w; this.dirty = true; if (w === 0) this.stop(); }
  }
  setSustain(on) {
    this.sustain = on;
    if (!on && !this.latchOn()) this.dropReleased();
  }
  onLatchChange() { if (!this.latchOn() && !this.sustain) this.dropReleased(); }
  onModeChange() { this.dirty = true; }

  // Switching on: hand the keys already down to the pattern. Switching off: keys still down sound normally.
  enable() {
    this.pool.panic();
    this.heldN = 0; this.running = false; this.soundN = 0; this.stepN = 0;
    for (let n = 0; n < 128; n++) if (this.phys[n]) this.addHeld(n, this.physVel[n]);
    this.uiDirty = true;
  }
  disable() {
    this.releaseSounding();
    this.heldN = 0; this.running = false; this.stepN = 0; this.seqN = 0;
    this.uiDirty = true;
    for (let n = 0; n < 128; n++) if (this.phys[n]) this.pool.noteOn(n, this.physVel[n], 0);
  }
  stop() {
    this.releaseSounding();
    this.running = false;
    this.stepN = 0;
    this.seqN = 0;
    this.uiDirty = true;
  }
  reset() {
    this.releaseSounding();
    this.phys.fill(0); this.physN = 0;
    this.heldN = 0; this.running = false; this.sustain = false;
    this.stepN = 0; this.seqN = 0; this.dirty = true; this.uiDirty = true;
  }

  releaseSounding() {
    for (let i = 0; i < this.soundN; i++) this.pool.noteOff(this.sounding[i], 0);
    this.soundN = 0;
  }
  play(n, v) {
    if (n > 127 || this.soundN >= ARP_MAX) return;
    this.pool.noteOn(n, v, 0);
    this.sounding[this.soundN++] = n;
    if (this.stepN < ARP_MAX) this.stepNotes[this.stepN++] = n;
  }

  rebuild() {
    const n = this.heldN;
    const mode = clamp(PV[P_ARP_MODE] | 0, 0, ARP_CHORD);
    const oct = clamp(PV[P_ARP_OCT] | 0, 1, 4);
    for (let i = 0; i < n; i++) { this.sorted[i] = this.held[i]; this.sortedVel[i] = this.heldVel[i]; }
    if (mode !== ARP_ORDER) {
      for (let i = 1; i < n; i++) {
        const k = this.sorted[i], kv = this.sortedVel[i];
        let j = i - 1;
        while (j >= 0 && this.sorted[j] > k) { this.sorted[j + 1] = this.sorted[j]; this.sortedVel[j + 1] = this.sortedVel[j]; j--; }
        this.sorted[j + 1] = k; this.sortedVel[j + 1] = kv;
      }
    }
    let L = 0;
    for (let o = 0; o < oct; o++) {
      for (let i = 0; i < n; i++) {
        const note = this.sorted[i] + 12 * o;
        if (note > 127) continue;
        this.line[L] = note; this.lineVel[L] = this.sortedVel[i]; L++;
      }
    }
    const seq = this.seq, sv = this.seqVel;
    let S = 0;
    if (mode === ARP_CHORD) {
      for (let o = 0; o < oct; o++) { seq[S] = n > 0 ? this.sorted[0] + 12 * o : 0; sv[S] = 0; S++; }
    } else if (mode === ARP_DOWN) {
      for (let i = L - 1; i >= 0; i--) { seq[S] = this.line[i]; sv[S] = this.lineVel[i]; S++; }
    } else if (mode === ARP_UPDN || mode === ARP_DNUP) {
      const up = mode === ARP_UPDN;
      for (let i = 0; i < L; i++) { const k = up ? i : L - 1 - i; seq[S] = this.line[k]; sv[S] = this.lineVel[k]; S++; }
      for (let i = L - 2; i >= 1; i--) { const k = up ? i : L - 1 - i; seq[S] = this.line[k]; sv[S] = this.lineVel[k]; S++; }
    } else {
      for (let i = 0; i < L; i++) { seq[S] = this.line[i]; sv[S] = this.lineVel[i]; S++; }
    }
    this.seqN = S;
    if (this.pos >= S) this.pos = S > 0 ? this.pos % S : -1;
    this.dirty = false;
    this.uiDirty = true;
  }

  step() {
    this.releaseSounding();
    if (this.dirty) this.rebuild();
    const beats = SUBDIV_BEATS[clamp(PV[P_ARP_DIV] | 0, 0, SUBDIV_BEATS.length - 1)];
    const base = beats * 60 / (G.bpm > 1 ? G.bpm : 1) * this.sr;
    const sw = clamp(PV[P_ARP_SWING], 0, 0.5);
    const len = (this.stepCount & 1) ? base * (1 - sw) : base * (1 + sw);
    this.stepCount++;
    this.until += len;
    const gate = clamp(PV[P_ARP_GATE], 0.05, 1);
    this.gateLeft = gate >= 0.999 ? 0 : Math.max(1, len * gate);
    this.stepN = 0;
    const S = this.seqN;
    if (S === 0) return;
    const mode = clamp(PV[P_ARP_MODE] | 0, 0, ARP_CHORD);
    if (mode === ARP_RAND) {
      let k = (this.rng.next01() * S) | 0;
      if (S > 1 && k === this.pos) k = (k + 1 + ((this.rng.next01() * (S - 1)) | 0)) % S;
      this.pos = k;
    } else {
      this.pos = (this.pos + 1) % S;
    }
    if (mode === ARP_CHORD) {
      const shift = 12 * this.pos;
      for (let i = 0; i < this.heldN; i++) this.play(this.sorted[i] + shift, this.sortedVel[i]);
    } else {
      this.play(this.seq[this.pos], this.seqVel[this.pos]);
    }
  }

  tick() {
    if (!this.running) return;
    if (this.gateLeft > 0) {
      this.gateLeft -= 1;
      if (this.gateLeft <= 0) this.releaseSounding();
    }
    this.until -= 1;
    if (this.until <= 0) this.step();
  }
}

// ---------------------------------------------------------------------------
// Chord player: steps through the progression the page sends, one chord per
// CHD_RATE beats, sample-accurate against BPM. Notes go through the
// arpeggiator's key path, so an active arp arpeggiates each chord.
const CHORD_MAX = 8, CHORD_NOTES = 8;
class ChordPlayer {
  constructor(sampleRate, arp) {
    this.sr = sampleRate;
    this.arp = arp;
    this.notes = new Int16Array(CHORD_MAX * CHORD_NOTES);
    this.counts = new Uint8Array(CHORD_MAX);
    this.n = 0;
    this.sounding = new Int16Array(CHORD_NOTES);
    this.soundN = 0;
    this.pos = -1;
    this.until = 0;
    this.running = false;
    this.vel = 100;
  }
  // Called from handleMessage (never from process()): copies into owned arrays.
  load(list) {
    let n = 0;
    if (list && typeof list.length === 'number') {
      for (let i = 0; i < list.length && n < CHORD_MAX; i++) {
        const c = list[i];
        if (!c || typeof c.length !== 'number') continue;
        let k = 0;
        for (let j = 0; j < c.length && k < CHORD_NOTES; j++) {
          const v = c[j] | 0;
          if (v >= 0 && v < 128) this.notes[n * CHORD_NOTES + k++] = v;
        }
        this.counts[n++] = k;
      }
    }
    this.n = n;
    if (n === 0) this.stop();
    else if (this.pos >= n) this.pos = this.pos % n;
  }
  start() {
    if (this.n === 0) return;
    this.release();
    this.running = true;
    this.pos = -1;
    this.until = 0;
  }
  stop() {
    this.release();
    this.running = false;
    this.pos = -1;
  }
  jump(i) {
    if (!this.running || this.n === 0) return;
    this.pos = ((i | 0) % this.n + this.n - 1) % this.n;
    this.until = 0;
  }
  release() {
    for (let i = 0; i < this.soundN; i++) this.arp.keyOff(this.sounding[i]);
    this.soundN = 0;
  }
  step() {
    this.release();
    const beats = CHORD_BEATS[clamp(PV[P_CHD_RATE] | 0, 0, CHORD_BEATS.length - 1)];
    this.until += beats * 60 / (G.bpm > 1 ? G.bpm : 1) * this.sr;
    this.pos = (this.pos + 1) % this.n;
    const b = this.pos * CHORD_NOTES, c = this.counts[this.pos];
    for (let j = 0; j < c; j++) {
      const note = this.notes[b + j];
      this.arp.keyOn(note, this.vel);
      this.sounding[this.soundN++] = note;
    }
  }
  tick() {
    if (!this.running) return;
    this.until -= 1;
    if (this.until <= 0) this.step();
  }
}

// ---------------------------------------------------------------------------
// Sequence player: plays a composed piece (note-on/off events in beats),
// sample-accurate, following the live BPM. Each event's flag carries bit 0 =
// note on, bit 1 = route through the arpeggiator (held chords it arpeggiates);
// without bit 1 the note goes straight to the voices (melody, bass).
const SEQ_MAX = 4096;
class SequencePlayer {
  constructor(sampleRate, pool, arp) {
    this.sr = sampleRate;
    this.pool = pool;
    this.arp = arp;
    this.beat = new Float64Array(SEQ_MAX);
    this.note = new Uint8Array(SEQ_MAX);
    this.vel = new Uint8Array(SEQ_MAX);
    this.isOn = new Uint8Array(SEQ_MAX);
    this.viaArp = new Uint8Array(SEQ_MAX);
    this.held = new Uint8Array(128);
    this.heldA = new Uint8Array(128);
    this.n = 0;
    this.len = 0;
    this.pos = 0;
    this.idx = 0;
    this.running = false;
    this.loop = false;
  }
  // Called from handleMessage: flat [beat, note, velocity, flag, ...], sorted.
  load(flat, len) {
    this.stop();
    let n = 0;
    if (flat && typeof flat.length === 'number') {
      for (let i = 0; i + 3 < flat.length && n < SEQ_MAX; i += 4) {
        const b = +flat[i], nt = flat[i + 1] | 0, f = flat[i + 3] | 0;
        if (!(b >= 0 && b < 10000) || nt < 0 || nt > 127) continue;
        this.beat[n] = b; this.note[n] = nt;
        this.vel[n] = clamp(flat[i + 2] | 0, 1, 127);
        this.isOn[n] = f & 1;
        this.viaArp[n] = (f >> 1) & 1;
        n++;
      }
    }
    this.n = n;
    const last = n ? this.beat[n - 1] : 0;
    this.len = +len > last ? +len : last;
  }
  start(loop) {
    if (!this.n) return;
    this.releaseAll();
    this.running = true;
    this.loop = !!loop;
    this.pos = 0;
    this.idx = 0;
  }
  stop() {
    this.releaseAll();
    this.running = false;
  }
  releaseAll() {
    const h = this.held, a = this.heldA;
    for (let k = 0; k < 128; k++) {
      if (h[k]) { h[k] = 0; this.pool.noteOff(k, 0); }
      if (a[k]) { a[k] = 0; this.arp.keyOff(k); }
    }
  }
  tick() {
    if (!this.running) return;
    const h = this.held, a = this.heldA;
    while (this.idx < this.n && this.beat[this.idx] <= this.pos) {
      const i = this.idx++, k = this.note[i];
      if (this.viaArp[i]) {
        if (this.isOn[i]) {
          this.arp.keyOn(k, this.vel[i]);
          if (a[k] < 255) a[k]++;
        } else if (a[k]) {
          if (--a[k] === 0) this.arp.keyOff(k);
        }
      } else if (this.isOn[i]) {
        if (h[k]) this.pool.noteOff(k, 0);
        this.pool.noteOn(k, this.vel[i], 0);
        if (h[k] < 255) h[k]++;
      } else if (h[k]) {
        if (--h[k] === 0) this.pool.noteOff(k, 0);
      }
    }
    this.pos += (G.bpm > 1 ? G.bpm : 1) / 60 / this.sr;
    if (this.pos >= this.len && this.idx >= this.n) {
      if (this.loop) { this.releaseAll(); this.pos = 0; this.idx = 0; }
      else this.stop();
    }
  }
}

// ---------------------------------------------------------------------------
class EffectsChain {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.wsL = new Waveshaper(sampleRate);
    this.wsR = new Waveshaper(sampleRate);
    this.chorus = new BBDChorus(sampleRate);
    this.delay = new StereoDelay(sampleRate);
    this.reverb = new FDNReverb(sampleRate);
    this.eq = new ThreeBandEQ(sampleRate);
    this.comp = new Compressor(sampleRate);
    this.lim = new TruePeakLimiter(sampleRate);
    this.outL = 0; this.outR = 0;
  }
  tick(inL, inR, master) {
    const pv = PV;
    let L = inL, R = inR;
    if (pv[P_WS_ON] > 0.5) {
      const mode = pv[P_WS_MODE] | 0, drv = pv[P_WS_DRIVE], mix = pv[P_WS_MIX];
      const bits = pv[P_WS_BITS], div = pv[P_WS_SRDIV] | 0;
      const wl = this.wsL.tick(L, mode, drv, bits, div);
      const wr = this.wsR.tick(R, mode, drv, bits, div);
      L += (wl - L) * mix; R += (wr - R) * mix;
    }
    if (pv[P_CH_ON] > 0.5) {
      const depth = clamp(pv[P_CH_DEPTH] + G.modCh * 5, 0, 5);
      this.chorus.tick(L, R, pv[P_CH_LINES] | 0, pv[P_CH_RATE], depth, pv[P_CH_DELAY], pv[P_CH_MIX]);
      L = this.chorus.outL; R = this.chorus.outR;
    }
    let rl = 0, rr = 0;
    if (pv[P_DLY_ON] > 0.5) {
      const send = clamp(pv[P_DLY_SEND] + G.modDly, 0, 1);
      const tSec = pv[P_DLY_SYNC] > 0.5
        ? SUBDIV_BEATS[clamp(pv[P_DLY_DIV] | 0, 0, SUBDIV_BEATS.length - 1)] * 60 / G.bpm
        : pv[P_DLY_TIME] * 0.001;
      this.delay.tick(L, R, send, tSec * this.sr, pv[P_DLY_FB], pv[P_DLY_PINGPONG] > 0.5);
      rl += this.delay.outL; rr += this.delay.outR;
    }
    if (pv[P_REV_ON] > 0.5) {
      const send = clamp(pv[P_REV_SEND] + G.modRev, 0, 1);
      this.reverb.tick(L * send, R * send, pv[P_REV_SIZE], pv[P_REV_DECAY], pv[P_REV_DAMP], pv[P_REV_PREDELAY], pv[P_REV_FREEZE] > 0.5);
      rl += this.reverb.outL; rr += this.reverb.outR;
    }
    L += rl; R += rr;
    this.eq.tick(L, R, pv[P_EQ_LOW], pv[P_EQ_MID], pv[P_EQ_HIGH]);
    this.comp.tick(this.eq.outL, this.eq.outR, pv[P_CMP_ON] > 0.5, pv[P_CMP_THRESH], pv[P_CMP_RATIO],
      pv[P_CMP_ATTACK], pv[P_CMP_RELEASE], pv[P_CMP_MAKEUP], pv[P_CMP_MIX]);
    this.lim.tick(this.comp.outL, this.comp.outR);
    const m = master < 0 ? 0 : (master > 1 ? 1 : master);
    this.outL = this.lim.outL * m;
    this.outR = this.lim.outR * m;
  }
}

// ---------------------------------------------------------------------------
const SCOPE_N = 1024;
const STREAM_MAX = 8192;
class SynthCoreProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = sampleRate;
    this.sr = sr;
    G.sr = sr;
    const init = options && options.processorOptions && options.processorOptions.values;
    PV = new Float64Array(NPARAMS);
    this.sp = new Array(NPARAMS);
    for (let i = 0; i < NPARAMS; i++) {
      let v = init && typeof init[i] === 'number' && init[i] === init[i] ? init[i] : PARAM_DEF[i];
      this.sp[i] = new SmoothedParam(v, PARAM_SMOOTH[i], sr);
      PV[i] = v;
    }
    this.activeList = new Int32Array(NPARAMS);
    this.isActive = new Uint8Array(NPARAMS);
    this.nActive = 0;

    G.env = [new EnvShape(), new EnvShape(), new EnvShape(), new EnvShape()];
    G.bpm = PV[P_BPM];
    G.ctlK = 1 - Math.exp(-1 / (0.005 * sr));
    G.fadeStep = 1 / (0.0015 * sr);
    this.smBend = new SmoothedParam(0, 5, sr);
    this.smMod = new SmoothedParam(0, 5, sr);
    this.smAt = new SmoothedParam(0, 5, sr);
    this.smExpr = new SmoothedParam(1, 5, sr);
    this.smCC74 = new SmoothedParam(0, 5, sr);

    this.pool = new VoicePool(sr);
    this.arp = new Arpeggiator(sr, this.pool);
    this.chords = new ChordPlayer(sr, this.arp);
    this.seq = new SequencePlayer(sr, this.pool, this.arp);
    this.mm = new ModMatrix();
    this.fx = new EffectsChain(sr);

    this._meterFrames = 0;
    this._meterInterval = Math.ceil(sr / 30);
    this._scopeBuffer = new Float32Array(256);
    // Continuous output stream for the CRT displays: every sample, flushed with each meter message.
    this._strL = new Float32Array(STREAM_MAX);
    this._strR = new Float32Array(STREAM_MAX);
    this._strN = 0;
    this._scopeState = 0; this._scopeIdx = 0; this._scopeWait = 0; this._scopePrev = 0;
    this._envBuf = new Float32Array(12);
    this.kRms = 1 - Math.exp(-1 / (0.3 * sr));
    this.msL = 0; this.msR = 0; this.pkL = 0; this.pkR = 0;
    this._rmsL = 0; this._rmsR = 0; this._peak = 0;
    this.cpuBusy = 0; this.cpuSpan = 0; this.cpu = 0;

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  setParam(i, v) {
    if (!(i >= 0 && i < NPARAMS) || typeof v !== 'number' || !(v === v)) return;
    const sp = this.sp[i];
    if (PARAM_SMOOTH[i] <= 0) {
      const old = sp.value;
      sp.snap(v);
      PV[i] = v;
      if (old !== v) this.onDiscrete(i, v);
      return;
    }
    sp.set(v);
    if (!this.isActive[i]) { this.isActive[i] = 1; this.activeList[this.nActive++] = i; }
  }

  onDiscrete(i, v) {
    if (i === P_VOICE_MODE || i === P_UNISON) this.pool.panic();
    else if (i === P_DLY_ON && v > 0.5) this.fx.delay.clear();
    else if (i === P_REV_ON && v > 0.5) this.fx.reverb.clear();
    else if (i === P_CH_ON && v > 0.5) this.fx.chorus.clear();
    else if (i === P_BPM) G.bpm = v > 1 ? v : 1;
    else if (i === P_ARP_ON) { if (v > 0.5) this.arp.enable(); else this.arp.disable(); }
    else if (i === P_ARP_LATCH) this.arp.onLatchChange();
    else if (i === P_ARP_MODE || i === P_ARP_OCT) this.arp.onModeChange();
  }

  handleMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'p': this.setParam(m.i, m.v); break;
      case 'all': {
        const vals = m.values;
        if (vals && vals.length === NPARAMS) for (let i = 0; i < NPARAMS; i++) this.setParam(i, vals[i]);
        break;
      }
      case 'on':
        if (G.mpe && (m.c | 0) !== G.mpeMaster && !this.arp.on()) this.pool.noteOn(m.n | 0, clamp(m.v | 0, 1, 127), m.c | 0);
        else this.arp.keyOn(m.n & 127, clamp(m.v | 0, 1, 127));
        break;
      case 'off':
        if (G.mpe && (m.c | 0) !== G.mpeMaster && !this.arp.on()) this.pool.noteOff(m.n | 0, m.c | 0);
        else this.arp.keyOff(m.n & 127);
        break;
      case 'bend':
        if (G.mpe && (m.c | 0) !== G.mpeMaster) G.chBend[m.c & 15] = m.v;
        else this.smBend.set(m.v);
        break;
      case 'at':
        if (G.mpe && (m.c | 0) !== G.mpeMaster) G.chPress[m.c & 15] = m.v;
        else this.smAt.set(m.v);
        break;
      case 'pat': G.notePress[m.n & 127] = m.v; break;
      case 'cc':
        switch (m.cc) {
          case 1: this.smMod.set(m.v); break;
          case 11: this.smExpr.set(m.v); break;
          case 74:
            if (G.mpe && (m.c | 0) !== G.mpeMaster) G.chSlide[m.c & 15] = m.v;
            else this.smCC74.set(m.v);
            break;
          case 64:
            if (this.arp.on()) this.arp.setSustain(m.v >= 0.5);
            else this.pool.setSustain(m.v >= 0.5);
            break;
        }
        break;
      case 'mpe':
        G.mpe = !!m.on;
        G.mpeMaster = m.master | 0;
        if (typeof m.range === 'number') G.mpeRange = m.range;
        if (!G.mpe) { G.chBend.fill(0); G.chPress.fill(0); G.chSlide.fill(0); }
        break;
      case 'mperange': G.mpeRange = clamp(+m.v || 0, 0, 96); break;
      case 'chords': this.chords.load(m.list); break;
      case 'seq': this.seq.load(m.events, m.len); break;
      case 'seqplay': if (m.on) this.seq.start(m.loop); else this.seq.stop(); break;
      case 'seqloop': this.seq.loop = !!m.on; break;
      case 'chordplay': if (m.on) this.chords.start(); else this.chords.stop(); break;
      case 'chordgo': this.chords.jump(m.i); break;
      case 'panic': this.seq.stop(); this.chords.stop(); this.arp.reset(); this.pool.panic(); G.notePress.fill(0); break;
      case 'kill': this.seq.stop(); this.chords.stop(); this.arp.reset(); this.pool.kill(); G.notePress.fill(0); break;
    }
  }

  tickParams() {
    const sp = this.sp, list = this.activeList;
    let k = 0;
    for (let i = 0; i < this.nActive; i++) {
      const idx = list[i];
      const p = sp[idx];
      PV[idx] = p.tick();
      if (p.value !== p.target) list[k++] = idx;
      else this.isActive[idx] = 0;
    }
    this.nActive = k;
  }

  updateGlobals() {
    const pv = PV, sr = this.sr;
    G.bend = this.smBend.tick();
    G.modWheel = this.smMod.tick();
    G.at = this.smAt.tick();
    G.expr = this.smExpr.tick();
    G.cc74 = this.smCC74.tick();
    for (let k = 0; k < 4; k++) {
      const b = P_ENV1_A + k * ENV_STRIDE;
      G.env[k].update(pv[b], pv[b + 1], pv[b + 2], pv[b + 3], pv[b + 4], pv[b + 5] | 0, pv[b + 6], sr);
      const l = P_LFO1_WAVE + k * LFO_STRIDE;
      const hz = pv[l + LFO_SYNC_OFF] > 0.5
        ? (G.bpm / 60) / SUBDIV_BEATS[clamp(pv[l + LFO_DIV_OFF] | 0, 0, SUBDIV_BEATS.length - 1)]
        : pv[l + LFO_RATE_OFF];
      G.lfoHz[k] = hz;
      let f = G.lfoFree[k] + hz / sr;
      if (f >= 1) f -= Math.floor(f);
      G.lfoFree[k] = f;
    }
    const gl = pv[P_GLIDE];
    if (gl !== G.lastGlide) { G.lastGlide = gl; G.glideCoeff = gl > 0.0005 ? Math.exp(-1 / (gl * sr)) : 0; }
  }

  fillEnvSnapshot() {
    const buf = this._envBuf;
    const v = this.pool.newest();
    for (let k = 0; k < 4; k++) {
      const o = k * 3;
      if (!v) { buf[o] = ST_IDLE; buf[o + 1] = 0; buf[o + 2] = -1; continue; }
      const e = v.env[k], sh = G.env[k];
      let prog = -1;
      switch (e.state) {
        case ST_ATT: prog = e.p; break;
        case ST_HOLD: prog = sh.holdN > 0 ? e.n / sh.holdN : 1; break;
        case ST_DEC: prog = e.n / (Math.max(sh.d, 0.001) * this.sr); break;
        case ST_SUS: prog = 0.5; break;
        case ST_REL: prog = e.n / (Math.max(sh.r, 0.001) * this.sr); break;
      }
      buf[o] = e.state; buf[o + 1] = e.level; buf[o + 2] = prog > 1 ? 1 : prog;
    }
    return buf;
  }

  // Delay-embedding lag for the phase-portrait screen: a quarter period of the newest note.
  scopeLag() {
    const v = this.pool.newest();
    if (!v) return 12;
    const f = 440 * Math.pow(2, (v.note - 69) / 12);
    return clamp(Math.round(this.sr / (4 * f)), 1, SCOPE_N >> 1);
  }

  process(inputs, outputs) {
    const t0 = clock();
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : null;
    const n = oL.length;
    const mm = this.mm, pool = this.pool, fx = this.fx, arp = this.arp, chords = this.chords;
    mm.compile();
    const kr = this.kRms;
    for (let s = 0; s < n; s++) {
      this.tickParams();
      this.updateGlobals();
      chords.tick();
      this.seq.tick();
      arp.tick();
      pool.tick(mm);
      fx.tick(pool.busL, pool.busR, PV[P_MASTER_VOL]);
      const L = fx.outL, R = fx.outR;
      oL[s] = L;
      if (oR) oR[s] = R;
      this.msL += (L * L - this.msL) * kr;
      this.msR += (R * R - this.msR) * kr;
      const aL = L < 0 ? -L : L, aR = R < 0 ? -R : R;
      if (aL > this.pkL) this.pkL = aL;
      if (aR > this.pkR) this.pkR = aR;
      // Oscilloscope capture, armed on a rising zero crossing
      const mono = 0.5 * (L + R);
      if (this._scopeState === 0) {
        this._scopeWait++;
        if ((this._scopePrev <= 0 && mono > 0) || this._scopeWait > 4096) { this._scopeState = 1; this._scopeIdx = 0; }
      }
      if (this._scopeState === 1) {
        this._scopeBuffer[this._scopeIdx++] = mono;
        if (this._scopeIdx >= 256) this._scopeState = 2;
      }
      this._scopePrev = mono;
      const sn = this._strN;
      if (sn < STREAM_MAX) { this._strL[sn] = L; this._strR[sn] = R; this._strN = sn + 1; }
    }
    this.cpuBusy += clock() - t0;
    this.cpuSpan += n / this.sr * 1000;

    this._meterFrames += n;
    if (this._meterFrames >= this._meterInterval) {
      this._meterFrames = 0;
      this._rmsL = Math.sqrt(this.msL);
      this._rmsR = Math.sqrt(this.msR);
      this._peak = this.pkL > this.pkR ? this.pkL : this.pkR;
      if (this.cpuSpan >= 250) { this.cpu = this.cpuBusy / this.cpuSpan; this.cpuBusy = 0; this.cpuSpan = 0; }
      const scopeReady = this._scopeState === 2;
      const a = this.arp;
      const arpSeq = a.uiDirty ? a.seq.slice(0, a.seqN) : null;
      a.uiDirty = false;
      this.port.postMessage({
        type: 'meter',
        rmsL: this._rmsL,
        rmsR: this._rmsR,
        peak: this._peak,
        peakL: this.pkL,
        peakR: this.pkR,
        gr: this.fx.comp.grDb,
        cpu: this.cpu,
        voices: pool.activeCount(),
        envs: this.fillEnvSnapshot().slice(),
        scope: scopeReady ? this._scopeBuffer.slice() : null,
        strL: this._strL.slice(0, this._strN),
        strR: this._strR.slice(0, this._strN),
        lag: this.scopeLag(),
        arpRun: a.running,
        arpPos: a.pos,
        arpSeq,
        arpNotes: a.running ? a.stepNotes.slice(0, a.stepN) : null,
        chRun: this.chords.running,
        chPos: this.chords.pos,
        seqRun: this.seq.running,
        seqBeat: this.seq.pos
      });
      if (scopeReady) { this._scopeState = 0; this._scopeWait = 0; }
      this._strN = 0;
      this._peak = 0; this.pkL = 0; this.pkR = 0;
    }
    return true;
  }
}

registerProcessor('synthcore-processor', SynthCoreProcessor);

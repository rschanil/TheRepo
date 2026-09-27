// ===========================================================================
// Analog display simulation (main thread)
//
// A real CRT beam deposits light in proportion to how long it dwells on a spot,
// so fast-moving parts of a trace are dim and slow turns are bright. The
// phosphor then decays exponentially. This models exactly that: every audio
// sample moves the beam; energy per sample = its duration (1 / sampleRate),
// spread along a Catmull-Rom curve through neighbouring samples; the energy
// field decays with the persistence time constant, then goes through an
// exposure curve, bloom, and a phosphor colour ramp.
// ===========================================================================
const CRT_LUT_N = 2048;
const CRT_LUT_MAX = 8;
const CRT_TONE = (() => {
  const t = new Float32Array(CRT_LUT_N + 2);
  for (let i = 0; i < t.length; i++) t[i] = 1 - Math.exp(-(i / CRT_LUT_N) * CRT_LUT_MAX);
  return t;
})();
// P31-style phosphor: green at normal brightness, whitening where the beam saturates.
const CRT_COLOR = (() => {
  const n = 1024, lut = new Uint32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const v = i / n, v3 = v * v * v * v;
    const r = Math.round(40 + 150 * v3), g = 255, b = Math.round(100 + 110 * v3);
    const a = Math.round(255 * Math.min(1, v * 1.08));
    lut[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return lut;
})();

class StreamQueue {
  constructor(size) {
    this.size = size;
    this.L = new Float32Array(size);
    this.R = new Float32Array(size);
    this.w = 0;
    this.r = 0;
  }
  push(L, R) {
    const n = L.length, sz = this.size;
    for (let i = 0; i < n; i++) {
      const k = (this.w + i) % sz;
      this.L[k] = L[i];
      this.R[k] = R ? R[i] : L[i];
    }
    this.w += n;
    if (this.w - this.r > sz) this.r = this.w - sz;
  }
  get avail() { return this.w - this.r; }
}

class CRTScreen {
  constructor(canvas, W, H) {
    canvas.width = W;
    canvas.height = H;
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.W = W; this.H = H;
    this.E = new Float32Array(W * H);
    this.T = new Float32Array(W * H);
    this.img = this.g.createImageData(W, H);
    this.px = new Uint32Array(this.img.data.buffer);
    this.bw = Math.ceil(W / 4); this.bh = Math.ceil(H / 4);
    this.B = new Float32Array(this.bw * this.bh);
    this.B2 = new Float32Array(this.bw * this.bh);
    // bilinear upsample tables for the bloom layer
    this.ux0 = new Int32Array(W); this.ux1 = new Int32Array(W); this.uxw = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const f = Math.max(0, (x + 0.5) / 4 - 0.5), i0 = Math.min(this.bw - 1, Math.floor(f));
      this.ux0[x] = i0; this.ux1[x] = Math.min(this.bw - 1, i0 + 1); this.uxw[x] = f - i0;
    }
    this.uy0 = new Int32Array(H); this.uy1 = new Int32Array(H); this.uyw = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      const f = Math.max(0, (y + 0.5) / 4 - 0.5), i0 = Math.min(this.bh - 1, Math.floor(f));
      this.uy0[y] = i0; this.uy1[y] = Math.min(this.bh - 1, i0 + 1); this.uyw[y] = f - i0;
    }
    this.hx = new Float64Array(4); this.hy = new Float64Array(4);
    this.n = 0;
    this.K = 50;
    this.gain = 1;
    this.peak = 0;
    this.bloom = 0.4;
  }
  penUp() { this.n = 0; }
  // Beam passes through (x, y); e = time spent on the segment ending here.
  point(x, y, e) {
    const hx = this.hx, hy = this.hy;
    hx[0] = hx[1]; hx[1] = hx[2]; hx[2] = hx[3]; hx[3] = x;
    hy[0] = hy[1]; hy[1] = hy[2]; hy[2] = hy[3]; hy[3] = y;
    const n = ++this.n;
    if (n < 3) return;
    if (n === 3) { hx[0] = hx[1]; hy[0] = hy[1]; }
    this.segment(hx[0], hy[0], hx[1], hy[1], hx[2], hy[2], hx[3], hy[3], e);
  }
  segment(x0, y0, x1, y1, x2, y2, x3, y3, e) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    let steps = Math.ceil(len);
    if (steps < 1) steps = 1; else if (steps > 160) steps = 160;
    const es = e / steps;
    const ax = -x0 + 3 * x1 - 3 * x2 + x3, bx = 2 * x0 - 5 * x1 + 4 * x2 - x3, cx = -x0 + x2;
    const ay = -y0 + 3 * y1 - 3 * y2 + y3, by = 2 * y0 - 5 * y1 + 4 * y2 - y3, cy = -y0 + y2;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps, t2 = t * t, t3 = t2 * t;
      this.splat(0.5 * (2 * x1 + cx * t + bx * t2 + ax * t3), 0.5 * (2 * y1 + cy * t + by * t2 + ay * t3), es);
    }
  }
  splat(x, y, e) {
    const W = this.W;
    if (!(x >= 0 && y >= 0 && x < W - 1 && y < this.H - 1)) return;
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy;
    const i = iy * W + ix, E = this.E;
    E[i] += e * (1 - fx) * (1 - fy);
    E[i + 1] += e * fx * (1 - fy);
    E[i + W] += e * (1 - fx) * fy;
    E[i + W + 1] += e * fx * fy;
  }
  // Auto gain behaves like a slow autoset on the vertical amplifier.
  track(absPeak, dt) {
    this.peak = Math.max(absPeak, this.peak * Math.exp(-dt / 0.6));
    const target = Math.min(40, Math.max(0.8, 0.85 / Math.max(this.peak, 1e-4)));
    this.gain += (target - this.gain) * (target < this.gain ? 0.5 : Math.min(1, dt * 1.5));
  }
  present(dt, tau, intensity) {
    const E = this.E, T = this.T, N = E.length, W = this.W, H = this.H;
    const f = Math.exp(-dt / tau);
    const thr = 0.25 * tau / N;
    // Exposure: total beam time in the field is ~tau seconds, so the average lit
    // pixel holds ~tau / lit. Scale so that it sits mid-curve; the knob trims.
    // Uses last frame's lit count so decay, count and tone share one pass.
    const Kt = (0.7 * intensity * Math.max(this.lit || 0, 60)) / tau;
    this.K += (Kt - this.K) * Math.min(1, dt * 6);
    const k = this.K * f * (CRT_LUT_N / CRT_LUT_MAX);
    let lit = 0;
    for (let i = 0; i < N; i++) {
      const e0 = E[i];
      if (e0 === 0) { T[i] = 0; continue; }
      const v = e0 * f;
      if (v < 1e-12) { E[i] = 0; T[i] = 0; continue; }
      E[i] = v;
      if (v > thr) lit++;
      let x = e0 * k;
      if (x > CRT_LUT_N) x = CRT_LUT_N;
      T[i] = CRT_TONE[x | 0];
    }
    this.lit = lit;
    // Bloom: 4x downsample, two [1 2 1] blur passes each way, bilinear upsample.
    const bw = this.bw, bh = this.bh, B = this.B, B2 = this.B2;
    B.fill(0);
    for (let y = 0; y < H; y++) {
      const by = (y >> 2) * bw, row = y * W;
      for (let x = 0; x < W; x++) B[by + (x >> 2)] += T[row + x];
    }
    for (let i = 0; i < B.length; i++) B[i] *= 1 / 16;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < bh; y++) {
        const r = y * bw;
        for (let x = 0; x < bw; x++) {
          const l = x > 0 ? B[r + x - 1] : B[r + x], rr = x < bw - 1 ? B[r + x + 1] : B[r + x];
          B2[r + x] = 0.25 * l + 0.5 * B[r + x] + 0.25 * rr;
        }
      }
      for (let y = 0; y < bh; y++) {
        const r = y * bw, up = y > 0 ? r - bw : r, dn = y < bh - 1 ? r + bw : r;
        for (let x = 0; x < bw; x++) B[r + x] = 0.25 * B2[up + x] + 0.5 * B2[r + x] + 0.25 * B2[dn + x];
      }
    }
    const px = this.px, bl = this.bloom * 2.2;
    const ux0 = this.ux0, ux1 = this.ux1, uxw = this.uxw;
    for (let y = 0; y < H; y++) {
      const r0 = this.uy0[y] * bw, r1 = this.uy1[y] * bw, wy = this.uyw[y], row = y * W;
      for (let x = 0; x < W; x++) {
        const a = B[r0 + ux0[x]], b = B[r0 + ux1[x]], c = B[r1 + ux0[x]], d = B[r1 + ux1[x]], wx = uxw[x];
        const top = a + (b - a) * wx, bot = c + (d - c) * wx;
        let v = T[row + x] + bl * (top + (bot - top) * wy);
        if (v > 1) v = 1;
        px[row + x] = CRT_COLOR[(v * 1024) | 0];
      }
    }
    this.g.putImageData(this.img, 0, 0);
  }
}

// Triggered Y-T sweep: blanked while armed, one left-to-right sweep per trigger,
// rising edge through zero with hysteresis; AUTO free-runs after 50 ms without one.
class SweepTrigger {
  constructor(len) {
    this.len = len;
    this.state = 0;
    this.idx = 0;
    this.wait = 0;
    this.below = false;
    this.prev = 0;
  }
}

// Spectrogram: 2048-point Hann FFT every 512 samples, log frequency axis.
class Spectrogram {
  constructor(canvas, W, H, sr) {
    canvas.width = W;
    canvas.height = H;
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.g.fillStyle = '#000';
    this.g.fillRect(0, 0, W, H);
    this.W = W; this.H = H;
    this.N = 2048; this.hop = 512;
    this.buf = new Float32Array(this.N);
    this.pos = 0; this.since = 0;
    this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
    this.win = new Float64Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.N - 1));
    this.rev = new Uint32Array(this.N);
    const bits = Math.log2(this.N);
    for (let i = 0; i < this.N; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(this.N / 2); this.sin = new Float64Array(this.N / 2);
    for (let i = 0; i < this.N / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / this.N); this.sin[i] = -Math.sin((2 * Math.PI * i) / this.N); }
    this.maxCols = 64;
    this.cols = new Uint32Array(this.maxCols * H);
    this.nCols = 0;
    this.colImg = null;
    this.colors = new Uint32Array(256);
    const stops = [[0, 0, 0, 0], [0.22, 0, 34, 12], [0.45, 14, 110, 44], [0.7, 50, 220, 100], [0.86, 110, 255, 150], [1, 225, 255, 232]];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const a = stops[k], b = stops[k + 1], u = (t - a[0]) / (b[0] - a[0]);
      const r = Math.round(a[1] + (b[1] - a[1]) * u), gg = Math.round(a[2] + (b[2] - a[2]) * u), bb = Math.round(a[3] + (b[3] - a[3]) * u);
      this.colors[i] = ((255 << 24) | (bb << 16) | (gg << 8) | r) >>> 0;
    }
    this.floorDb = -100; this.ceilDb = -8;
    this.setRate(sr);
  }
  setRate(sr) {
    this.sr = sr;
    const H = this.H, N = this.N;
    this.fmin = 30;
    this.fmax = Math.min(20000, sr * 0.48);
    this.b0 = new Int32Array(H); this.b1 = new Int32Array(H); this.bc = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      const fHi = this.freqAt(y), fLo = this.freqAt(y + 1), fc = this.freqAt(y + 0.5);
      this.b0[y] = Math.ceil((fLo * N) / sr);
      this.b1[y] = Math.floor((fHi * N) / sr);
      this.bc[y] = (fc * N) / sr;
    }
  }
  // y measured in rows from the top edge (0) to the bottom edge (H).
  freqAt(y) { return this.fmin * Math.pow(this.fmax / this.fmin, 1 - y / this.H); }
  push(v) {
    this.buf[this.pos] = v;
    this.pos = (this.pos + 1) & (this.N - 1);
    if (++this.since >= this.hop) { this.since = 0; this.analyze(); }
  }
  fft() {
    const N = this.N, re = this.re, im = this.im;
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step, wr = this.cos[k], wi = this.sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  // Amplitude in dBFS of the column's strongest component in a bin range
  // (a full-scale sine reads 0 dB: Hann coherent gain is N/2, one-sided x2).
  magnitudes(out) {
    const N = this.N, re = this.re, im = this.im, buf = this.buf, win = this.win, rev = this.rev;
    for (let i = 0; i < N; i++) {
      const s = buf[(this.pos + i) & (N - 1)] * win[i];
      re[rev[i]] = s; im[rev[i]] = 0;
    }
    this.fft();
    const scale = 4 / N, H = this.H;
    for (let y = 0; y < H; y++) {
      let m;
      if (this.b1[y] >= this.b0[y]) {
        m = 0;
        for (let b = this.b0[y]; b <= this.b1[y]; b++) { const p = re[b] * re[b] + im[b] * im[b]; if (p > m) m = p; }
        m = Math.sqrt(m);
      } else {
        const c = this.bc[y], i0 = Math.floor(c), fr = c - i0;
        const m0 = Math.hypot(re[i0], im[i0]), m1 = Math.hypot(re[i0 + 1], im[i0 + 1]);
        m = m0 + (m1 - m0) * fr;
      }
      out[y] = 20 * Math.log10(m * scale + 1e-12);
    }
  }
  analyze() {
    if (!this.dbCol) this.dbCol = new Float64Array(this.H);
    const db = this.dbCol, H = this.H;
    this.magnitudes(db);
    if (this.nCols >= this.maxCols) return;
    const base = this.nCols * H, span = this.ceilDb - this.floorDb;
    for (let y = 0; y < H; y++) {
      let t = (db[y] - this.floorDb) / span;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      this.cols[base + y] = this.colors[(t * 255) | 0];
    }
    this.nCols++;
  }
  present() {
    const k = this.nCols;
    if (!k) return;
    const g = this.g, W = this.W, H = this.H;
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.canvas, -k, 0);
    g.globalCompositeOperation = 'source-over';
    if (!this.colImg || this.colImg.width !== k) this.colImg = g.createImageData(k, H);
    const px = new Uint32Array(this.colImg.data.buffer);
    for (let c = 0; c < k; c++) for (let y = 0; y < H; y++) px[y * k + c] = this.cols[c * H + y];
    g.putImageData(this.colImg, W - k, 0);
    this.nCols = 0;
  }
}

// Headless run of the audio-thread code: every factory preset, chords, mod wheel,
// bends, sustain; checks finite output, ceiling, and CPU cost per render second.
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const paramsApi = new Function(src('params.js') + '\nreturn { PARAMS, PIDX, FACTORY, factorySnapshot, buildWorkletHeader };')();
const header = paramsApi.buildWorkletHeader();
const SR = 48000;
let Registered = null;
const posted = [];
class AudioWorkletProcessor { constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; } }
const factory = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate',
  header + '\n' + src('processor.js') + '\nreturn true;');
factory(AudioWorkletProcessor, (name, cls) => { Registered = cls; }, SR);

function makeProc(values) {
  return new Registered({ processorOptions: { values } });
}
function valuesFor(k) {
  const snap = paramsApi.factorySnapshot(k);
  return paramsApi.PARAMS.map(p => snap[p.id]);
}
function render(proc, seconds, stats) {
  const blocks = Math.ceil(seconds * SR / 128);
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let b = 0; b < blocks; b++) {
    proc.process([], [[L, R]]);
    for (let i = 0; i < 128; i++) {
      const a = Math.abs(L[i]), c = Math.abs(R[i]);
      if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) stats.nan++;
      if (a > stats.max) stats.max = a;
      if (c > stats.max) stats.max = c;
      stats.sumSq += L[i] * L[i] + R[i] * R[i];
      stats.n += 2;
    }
  }
}
const msg = (p, m) => p.handleMessage(m);
const ceil = Math.pow(10, -0.1 / 20);
let fail = false;

for (let k = 0; k < paramsApi.FACTORY.length; k++) {
  const proc = makeProc(valuesFor(k));
  const stats = { nan: 0, max: 0, sumSq: 0, n: 0 };
  const t0 = process.hrtime.bigint();
  // single note, then 4-note chord, then 10 notes (forces stealing), bends & wheel
  msg(proc, { type: 'on', n: 60, v: 100, c: 0 });
  render(proc, 0.6, stats);
  msg(proc, { type: 'off', n: 60, c: 0 });
  for (const n of [48, 55, 60, 64]) msg(proc, { type: 'on', n, v: 90, c: 0 });
  msg(proc, { type: 'cc', cc: 1, v: 0.8, c: 0 });
  msg(proc, { type: 'bend', v: 0.5, c: 0 });
  render(proc, 1.0, stats);
  msg(proc, { type: 'cc', cc: 64, v: 1, c: 0 });
  for (const n of [48, 55, 60, 64]) msg(proc, { type: 'off', n, c: 0 });
  for (let i = 0; i < 10; i++) msg(proc, { type: 'on', n: 40 + i * 3, v: 127, c: 0 });
  render(proc, 1.0, stats);
  msg(proc, { type: 'cc', cc: 64, v: 0, c: 0 });
  for (let i = 0; i < 10; i++) msg(proc, { type: 'off', n: 40 + i * 3, c: 0 });
  msg(proc, { type: 'bend', v: 0, c: 0 });
  render(proc, 1.4, stats);
  const secs = 4.0;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const rms = Math.sqrt(stats.sumSq / stats.n);
  const ok = stats.nan === 0 && stats.max <= ceil + 1e-6 && rms > 1e-4;
  if (!ok) fail = true;
  console.log(`${String(k).padEnd(2)} ${paramsApi.FACTORY[k].name.padEnd(10)} peak ${stats.max.toFixed(4)}  rms ${(20 * Math.log10(rms + 1e-12)).toFixed(1)} dBFS  nan ${stats.nan}  cpu ${(ms / (secs * 1000) * 100).toFixed(1)}% of realtime  ${ok ? 'OK' : 'FAIL'}`);
}

// Stress: every effect on, supersaw x2, ladder serial, 8 voices, unison 1, all LFOs routed
{
  const vals = valuesFor(0);
  const set = (id, v) => { vals[paramsApi.PIDX[id]] = v; };
  set('OSC1_WAVE', 5); set('OSC2_WAVE', 5); set('OSC2_LEVEL', 0.6); set('FLT_TYPE', 2); set('FLT_CUTOFF', 1500);
  set('FLT_SHAPER', 1); set('FLT_DRIVE', 12);
  ['WS_ON', 'CH_ON', 'DLY_ON', 'REV_ON', 'CMP_ON'].forEach(id => set(id, 1));
  set('CH_LINES', 6); set('EQ_LOW', 3); set('EQ_HIGH', -2);
  const routes = [[1, 11], [2, 3], [3, 16], [4, 15], [6, 14], [12, 18], [9, 21], [10, 22]];
  routes.forEach((r, i) => { set(`MOD${i}_SRC`, r[0]); set(`MOD${i}_DST`, r[1]); set(`MOD${i}_DEPTH`, 0.4); set(`MOD${i}_CURVE`, i % 4); });
  const proc = makeProc(vals);
  const stats = { nan: 0, max: 0, sumSq: 0, n: 0 };
  for (let i = 0; i < 8; i++) msg(proc, { type: 'on', n: 36 + i * 5, v: 110, c: 0 });
  const t0 = process.hrtime.bigint();
  render(proc, 3, stats);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const ok = stats.nan === 0 && stats.max <= ceil + 1e-6;
  if (!ok) fail = true;
  console.log(`stress: 8 voices, 2x supersaw, serial filters, all FX: peak ${stats.max.toFixed(4)} nan ${stats.nan} cpu ${(ms / 3000 * 100).toFixed(1)}% of realtime ${ok ? 'OK' : 'FAIL'}`);
  // freeze + self-oscillation + NaN input safety
  msg(proc, { type: 'p', i: paramsApi.PIDX.FLT_RES, v: 1.1 });
  msg(proc, { type: 'p', i: paramsApi.PIDX.REV_FREEZE, v: 1 });
  msg(proc, { type: 'p', i: paramsApi.PIDX.FLT_CUTOFF, v: NaN });
  msg(proc, { type: 'p', i: paramsApi.PIDX.FLT_CUTOFF, v: 30000 });
  const s2 = { nan: 0, max: 0, sumSq: 0, n: 0 };
  render(proc, 1, s2);
  console.log(`self-osc + freeze + bad values: peak ${s2.max.toFixed(4)} nan ${s2.nan} ${s2.nan === 0 && s2.max <= ceil + 1e-6 ? 'OK' : 'FAIL'}`);
  const meters = posted.filter(m => m.type === 'meter');
  console.log(`meter messages: ${meters.length}, scope frames: ${meters.filter(m => m.scope).length}, last cpu field ${meters.at(-1).cpu.toFixed(3)}`);
}
process.exit(fail ? 1 : 0);

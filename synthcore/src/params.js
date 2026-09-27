// ---------------------------------------------------------------------------
// Parameter table: the single source of truth for every value the UI, MIDI,
// presets and the audio thread share. The audio thread receives a generated
// header (index constants + defaults + smoothing times) built from this table.
// ---------------------------------------------------------------------------
const SOURCES = ['NONE', 'LFO1', 'LFO2', 'LFO3', 'LFO4', 'ENV1', 'ENV2', 'ENV3', 'ENV4',
  'VELOCITY', 'AFTERTOUCH', 'PITCH_BEND', 'MOD_WHEEL', 'EXPRESSION', 'CC74', 'NOTE_NUMBER'];
const DESTS = ['NONE', 'OSC1_PITCH', 'OSC1_FINE', 'OSC1_PW', 'OSC1_LEVEL',
  'OSC2_PITCH', 'OSC2_FINE', 'OSC2_PW', 'OSC2_LEVEL', 'SUB_LEVEL', 'NOISE_LEVEL',
  'FILTER_CUTOFF', 'FILTER_RESONANCE', 'FILTER_FM', 'FILTER_DRIVE', 'AMP', 'PAN',
  'LFO1_RATE', 'LFO1_DEPTH', 'LFO2_RATE', 'LFO2_DEPTH',
  'REVERB_SEND', 'DELAY_SEND', 'CHORUS_DEPTH', 'PITCH_BEND_RANGE'];
const CURVES = ['LINEAR', 'SQUARED', 'INV_SQUARED', 'STEP'];
const CURVE_LABELS = ['LIN', 'SQR', '√', 'STEP'];
const SUBDIVS = [['1/64', 1 / 16], ['1/32T', 1 / 12], ['1/32', 1 / 8], ['1/16T', 1 / 6], ['1/16', 1 / 4],
  ['1/8T', 1 / 3], ['1/16D', 3 / 8], ['1/8', 1 / 2], ['1/4T', 2 / 3], ['1/8D', 3 / 4], ['1/4', 1],
  ['1/4D', 1.5], ['1/2', 2], ['1 bar', 4], ['2 bars', 8], ['4 bars', 16], ['8 bars', 32]];
const DELAY_DIVS = 15; // 1/64 .. 2 bars
const OSC_WAVES = ['SINE', 'TRI', 'SAW', 'SQUARE', 'PULSE', 'SUPER'];
const LFO_WAVES = ['SINE', 'TRI', 'SAW↑', 'SAW↓', 'SQR', 'S&H', 'SMOOTH'];
const ARP_MODES = ['UP', 'DOWN', 'UP-DN', 'DN-UP', 'ORDER', 'RAND', 'CHORD'];
const ARP_DIVS = 14; // 1/64 .. 1 bar
const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const CHORD_TYPES = ['m7', 'm9', 'm11'];
const CHORD_RATES = [['½ bar', 2], ['1 bar', 4], ['2 bars', 8]];
// Progressions as semitone offsets from the key root. Every chord is a minor
// seventh (or its 9th / 11th extension), so numerals are all lower case.
const PROGRESSIONS = [
  { name: 'Minor vamp', roots: [0, 5] },
  { name: 'Dorian sway', roots: [0, 2] },
  { name: 'Neo-soul', roots: [5, 7, 0] },
  { name: 'Aeolian', roots: [0, 5, 7, 0] },
  { name: 'Deep house', roots: [0, 3, 5, 3] },
  { name: 'Descent', roots: [0, 10, 8, 7] },
  { name: 'Fourths', roots: [0, 5, 10, 3] },
  { name: 'Two-step', roots: [0, 7, 8, 5] }
];

const PARAMS = [];
function addParam(id, def, min, max, o) {
  o = o || {};
  const kind = o.kind || 'c';
  PARAMS.push({
    id, def, min, max, kind,
    scale: o.scale || 'lin',
    unit: o.unit || '',
    opts: o.opts || null,
    label: o.label || id,
    smooth: o.smooth !== undefined ? o.smooth : (kind === 'c' ? 5 : 0)
  });
}

(function defineParams() {
  const E = (opts, label) => ({ kind: 'e', opts, label });
  addParam('MASTER_VOL', 0.8, 0, 1, { unit: '%', smooth: 20, label: 'Master' });
  addParam('BPM', 120, 20, 300, { unit: 'bpm', smooth: 0, label: 'BPM' });
  addParam('VOICE_MODE', 0, 0, 2, E(['POLY', 'MONO', 'LEGATO'], 'Mode'));
  addParam('ALLOC', 0, 0, 2, E(['OLDEST', 'LOW AMP', 'ROUND'], 'Steal'));
  addParam('UNISON', 1, 1, 8, { kind: 'i', label: 'Unison' });
  addParam('UNI_DETUNE', 20, 0, 100, { unit: 'ct', label: 'Detune' });
  addParam('UNI_WIDTH', 1, 0, 1, { unit: '%', label: 'Width' });
  addParam('GLIDE', 0, 0, 2, { unit: 's', scale: 'pow3', label: 'Glide' });
  addParam('BEND_RANGE', 2, 0, 48, { kind: 'i', unit: 'st', label: 'Bend' });
  addParam('PITCH_ENV_AMT', 0, -48, 48, { unit: 'st', label: 'P.Env' });

  for (const n of [1, 2]) {
    addParam(`OSC${n}_WAVE`, 2, 0, 5, E(OSC_WAVES, 'Wave'));
    addParam(`OSC${n}_OCT`, 0, -2, 2, { kind: 'i', unit: 'oct', label: 'Octave' });
    addParam(`OSC${n}_COARSE`, 0, -24, 24, { kind: 'i', unit: 'st', label: 'Coarse' });
    addParam(`OSC${n}_FINE`, 0, -100, 100, { unit: 'ct', label: 'Fine' });
    addParam(`OSC${n}_PW`, 0.5, 0.01, 0.99, { unit: '%', label: 'PW' });
    addParam(`OSC${n}_SPREAD`, 25, 0, 100, { unit: 'ct', label: 'Spread' });
    addParam(`OSC${n}_LEVEL`, n === 1 ? 0.8 : 0, 0, 1, { unit: '%', label: 'Level' });
  }
  addParam('OSC2_SYNC', 0, 0, 1, { kind: 'b', label: 'Hard sync' });
  addParam('OSC2_RING', 0, 0, 1, { kind: 'b', label: 'Ring mod' });
  addParam('OSC2_PHASE', 0, 0, 1, { unit: 'phase', label: 'Phase' });
  addParam('SUB_LEVEL', 0, 0, 1, { unit: '%', label: 'Sub' });
  addParam('NOISE_LEVEL', 0, 0, 1, { unit: '%', label: 'Noise' });

  addParam('FLT_TYPE', 0, 0, 2, E(['SVF', 'LADDER', 'SVF→LAD'], 'Type'));
  addParam('FLT_MODE', 0, 0, 4, E(['LP', 'HP', 'BP', 'NOTCH', 'PEAK'], 'Mode'));
  addParam('FLT_CUTOFF', 20000, 20, 20000, { unit: 'hz', scale: 'log', label: 'Cutoff' });
  addParam('FLT_RES', 0.4, 0, 1.1, { unit: 'x', label: 'Reso' });
  addParam('FLT_KEYTRACK', 0, 0, 100, { unit: 'pct', label: 'Key trk' });
  addParam('FLT_ENV_AMT', 0, -1, 1, { unit: '%', label: 'Env amt' });
  addParam('FLT_FM', 0, 0, 1, { unit: '%', label: 'FM' });
  addParam('FLT_SHAPER', 0, 0, 5, E(['OFF', 'SOFT', 'HARD', 'TUBE', 'CRUSH', 'FOLD'], 'Shaper'));
  addParam('FLT_DRIVE', 0, 0, 24, { unit: 'db', label: 'Drive' });

  const envDefs = [
    [0.005, 0, 0.3, 0.8, 0.3, 1],
    [0.005, 0, 0.4, 0.4, 0.4, 0],
    [0.001, 0, 0.2, 0, 0.2, 0],
    [0.3, 0, 0.8, 0.5, 0.6, 0]
  ];
  for (let k = 1; k <= 4; k++) {
    const d = envDefs[k - 1];
    addParam(`ENV${k}_A`, d[0], 0.0005, 30, { unit: 's', scale: 'log', smooth: 1, label: 'A' });
    addParam(`ENV${k}_H`, d[1], 0, 2, { unit: 's', scale: 'pow3', smooth: 1, label: 'H' });
    addParam(`ENV${k}_D`, d[2], 0.001, 30, { unit: 's', scale: 'log', smooth: 1, label: 'D' });
    addParam(`ENV${k}_S`, d[3], 0, 1, { unit: '%', label: 'S' });
    addParam(`ENV${k}_R`, d[4], 0.001, 30, { unit: 's', scale: 'log', smooth: 1, label: 'R' });
    addParam(`ENV${k}_CURVE`, 0, 0, 2, E(['LIN', 'EXP', 'LOG'], 'Attack curve'));
    addParam(`ENV${k}_VEL`, d[5], 0, 2, { unit: 'x', label: 'Vel' });
  }

  const lfoRates = [2, 0.5, 5, 0.2];
  for (let k = 1; k <= 4; k++) {
    addParam(`LFO${k}_WAVE`, 0, 0, 6, E(LFO_WAVES, 'Wave'));
    addParam(`LFO${k}_RATE`, lfoRates[k - 1], 0.01, 100, { unit: 'hz', scale: 'log', label: 'Rate' });
    addParam(`LFO${k}_SYNC`, 0, 0, 1, { kind: 'b', label: 'Sync' });
    addParam(`LFO${k}_DIV`, 10, 0, SUBDIVS.length - 1, E(SUBDIVS.map(s => s[0]), 'Div'));
    addParam(`LFO${k}_DEPTH`, 1, 0, 1, { unit: '%', label: 'Depth' });
    addParam(`LFO${k}_PHASE`, 0, 0, 360, { unit: 'deg', label: 'Phase' });
    addParam(`LFO${k}_FADE`, 0, 0, 10, { unit: 's', scale: 'pow3', label: 'Fade in' });
    addParam(`LFO${k}_MODE`, 0, 0, 2, E(['RETRIG', 'FREE', '1-SHOT'], 'Mode'));
  }

  for (let i = 0; i < 16; i++) {
    addParam(`MOD${i}_SRC`, 0, 0, SOURCES.length - 1, E(SOURCES, 'Source'));
    addParam(`MOD${i}_DST`, 0, 0, DESTS.length - 1, E(DESTS, 'Destination'));
    addParam(`MOD${i}_DEPTH`, 0, -1, 1, { unit: 'bi', smooth: 1, label: 'Depth' });
    addParam(`MOD${i}_CURVE`, 0, 0, 3, E(CURVE_LABELS, 'Curve'));
    addParam(`MOD${i}_ON`, 1, 0, 1, { kind: 'b', label: 'On' });
  }

  addParam('WS_ON', 0, 0, 1, { kind: 'b', label: 'On' });
  addParam('WS_MODE', 0, 0, 4, E(['SOFT', 'HARD', 'TUBE', 'CRUSH', 'FOLD'], 'Mode'));
  addParam('WS_DRIVE', 6, 0, 24, { unit: 'db', label: 'Drive' });
  addParam('WS_MIX', 1, 0, 1, { unit: '%', label: 'Mix' });
  addParam('WS_BITS', 8, 1, 16, { kind: 'i', unit: 'bits', label: 'Bits' });
  addParam('WS_SRDIV', 1, 1, 32, { kind: 'i', unit: 'div', label: 'Rate ÷' });

  addParam('CH_ON', 0, 0, 1, { kind: 'b', label: 'On' });
  addParam('CH_LINES', 3, 2, 6, { kind: 'i', label: 'Lines' });
  addParam('CH_RATE', 0.6, 0.1, 8, { unit: 'hz', scale: 'log', label: 'Rate' });
  addParam('CH_DEPTH', 2, 0, 5, { unit: 'ms', label: 'Depth' });
  addParam('CH_DELAY', 12, 5, 25, { unit: 'ms', label: 'Delay' });
  addParam('CH_MIX', 0.5, 0, 1, { unit: '%', label: 'Mix' });

  addParam('DLY_ON', 0, 0, 1, { kind: 'b', label: 'On' });
  addParam('DLY_TIME', 350, 1, 2000, { unit: 'ms', scale: 'log', label: 'Time' });
  addParam('DLY_SYNC', 0, 0, 1, { kind: 'b', label: 'Sync' });
  addParam('DLY_DIV', 10, 0, DELAY_DIVS - 1, E(SUBDIVS.slice(0, DELAY_DIVS).map(s => s[0]), 'Div'));
  addParam('DLY_FB', 0.35, 0, 0.99, { unit: '%', label: 'Feedback' });
  addParam('DLY_PINGPONG', 1, 0, 1, { kind: 'b', label: 'Ping-pong' });
  addParam('DLY_SEND', 0.3, 0, 1, { unit: '%', label: 'Send' });

  addParam('REV_ON', 0, 0, 1, { kind: 'b', label: 'On' });
  addParam('REV_SIZE', 1, 0.2, 2, { unit: 'x', label: 'Size' });
  addParam('REV_DECAY', 2.5, 0.2, 20, { unit: 's', scale: 'log', label: 'Decay' });
  addParam('REV_DAMP', 6000, 200, 12000, { unit: 'hz', scale: 'log', label: 'Damp' });
  addParam('REV_PREDELAY', 15, 0, 100, { unit: 'ms', label: 'Pre-dly' });
  addParam('REV_FREEZE', 0, 0, 1, { kind: 'b', label: 'Freeze' });
  addParam('REV_SEND', 0.3, 0, 1, { unit: '%', label: 'Send' });

  addParam('EQ_LOW', 0, -15, 15, { unit: 'db', label: 'Low 80' });
  addParam('EQ_MID', 0, -15, 15, { unit: 'db', label: 'Mid 800' });
  addParam('EQ_HIGH', 0, -15, 15, { unit: 'db', label: 'High 8k' });

  addParam('CMP_ON', 0, 0, 1, { kind: 'b', label: 'On' });
  addParam('CMP_THRESH', -18, -60, 0, { unit: 'db', label: 'Thresh' });
  addParam('CMP_RATIO', 4, 1, 20, { unit: 'ratio', scale: 'log', label: 'Ratio' });
  addParam('CMP_ATTACK', 10, 0.1, 100, { unit: 'ms', scale: 'log', label: 'Attack' });
  addParam('CMP_RELEASE', 200, 10, 2000, { unit: 'ms', scale: 'log', label: 'Release' });
  addParam('CMP_MAKEUP', 0, 0, 24, { unit: 'db', label: 'Makeup' });
  addParam('CMP_MIX', 1, 0, 1, { unit: '%', label: 'Blend' });

  addParam('ARP_ON', 0, 0, 1, { kind: 'b', label: 'Arp' });
  addParam('ARP_MODE', 0, 0, ARP_MODES.length - 1, E(ARP_MODES, 'Pattern'));
  addParam('ARP_OCT', 1, 1, 4, { kind: 'i', unit: 'oct', label: 'Octaves' });
  addParam('ARP_DIV', SUBDIVS.findIndex(s => s[0] === '1/16'), 0, ARP_DIVS - 1, E(SUBDIVS.slice(0, ARP_DIVS).map(s => s[0]), 'Rate'));
  addParam('ARP_GATE', 0.5, 0.05, 1, { unit: '%', smooth: 0, label: 'Gate' });
  addParam('ARP_SWING', 0, 0, 0.5, { unit: '%', smooth: 0, label: 'Swing' });
  addParam('ARP_LATCH', 0, 0, 1, { kind: 'b', label: 'Latch' });

  addParam('CHD_KEY', 9, 0, 11, E(KEY_NAMES, 'Key'));
  addParam('CHD_PROG', 0, 0, PROGRESSIONS.length - 1, E(PROGRESSIONS.map(p => p.name), 'Progression'));
  addParam('CHD_TYPE', 1, 0, CHORD_TYPES.length - 1, E(CHORD_TYPES, 'Chord'));
  addParam('CHD_OCT', 3, 2, 5, { kind: 'i', label: 'Octave' });
  addParam('CHD_RATE', 1, 0, CHORD_RATES.length - 1, E(CHORD_RATES.map(r => r[0]), 'Length'));
  addParam('CHD_VL', 1, 0, 1, { kind: 'b', label: 'Voice lead' });
  addParam('CHD_BASS', 0, 0, 1, { kind: 'b', label: 'Bass' });
})();

const PIDX = {};
PARAMS.forEach((p, i) => { PIDX[p.id] = i; });

// Header prepended to the audio-thread module: index constants and tables.
function buildWorkletHeader() {
  let h = "'use strict';\n";
  h += `const NPARAMS = ${PARAMS.length};\n`;
  h += PARAMS.map((p, i) => `const P_${p.id} = ${i};`).join('\n') + '\n';
  h += SOURCES.map((s, i) => `const S_${s} = ${i};`).join('\n') + '\n';
  h += DESTS.map((d, i) => `const D_${d} = ${i};`).join('\n') + '\n';
  h += `const NSRC = ${SOURCES.length};\nconst NDST = ${DESTS.length};\n`;
  h += `const PARAM_DEF = ${JSON.stringify(PARAMS.map(p => p.def))};\n`;
  h += `const PARAM_SMOOTH = ${JSON.stringify(PARAMS.map(p => p.smooth))};\n`;
  h += `const SUBDIV_BEATS = ${JSON.stringify(SUBDIVS.map(s => s[1]))};\n`;
  h += `const CHORD_BEATS = ${JSON.stringify(CHORD_RATES.map(r => r[1]))};\n`;
  return h;
}

// ---------------------------------------------------------------------------
// Factory presets: overrides on top of the Init defaults, plus mod routings.
// ---------------------------------------------------------------------------
const SUBDIV_INDEX = {};
SUBDIVS.forEach((s, i) => { SUBDIV_INDEX[s[0]] = i; });

const FACTORY = [
  { name: 'Init', cat: 'Basics', p: {} },
  {
    name: 'Warm Pad', cat: 'Pads & atmospheres',
    p: {
      OSC1_WAVE: 5, OSC1_SPREAD: 40, OSC1_LEVEL: 0.75,
      FLT_CUTOFF: 900, FLT_RES: 0.35, FLT_ENV_AMT: 0.12, FLT_KEYTRACK: 30,
      ENV1_A: 1.2, ENV1_D: 1.0, ENV1_S: 0.85, ENV1_R: 2.0, ENV1_CURVE: 1, ENV1_VEL: 0.5,
      ENV2_A: 1.6, ENV2_D: 2.0, ENV2_S: 0.6, ENV2_R: 2.0,
      LFO1_RATE: 0.18,
      CH_ON: 1, CH_LINES: 2, CH_RATE: 0.45, CH_DEPTH: 2.5, CH_DELAY: 14, CH_MIX: 0.45,
      REV_ON: 1, REV_SEND: 0.55, REV_SIZE: 1.5, REV_DECAY: 4.8, REV_DAMP: 5200, REV_PREDELAY: 22
    },
    mods: [['LFO1', 'FILTER_CUTOFF', 0.08], ['MOD_WHEEL', 'FILTER_CUTOFF', 0.35]]
  },
  {
    name: 'Lead Sync', cat: 'Leads',
    p: {
      VOICE_MODE: 2, GLIDE: 0.05,
      OSC1_WAVE: 2, OSC1_LEVEL: 0.35, OSC2_WAVE: 2, OSC2_LEVEL: 0.8, OSC2_SYNC: 1, OSC2_COARSE: 7,
      FLT_MODE: 2, FLT_CUTOFF: 2400, FLT_RES: 0.65, FLT_ENV_AMT: 0.2, FLT_KEYTRACK: 50,
      ENV1_A: 0.003, ENV1_D: 0.6, ENV1_S: 0.75, ENV1_R: 0.25,
      ENV2_A: 0.002, ENV2_D: 0.35, ENV2_S: 0.3,
      ENV3_A: 0.2, ENV3_D: 0.4, ENV3_S: 0.35, ENV3_R: 0.3, ENV3_CURVE: 1,
      LFO1_RATE: 5.5, LFO1_DEPTH: 0, LFO1_FADE: 0.3,
      DLY_ON: 1, DLY_TIME: 180, DLY_FB: 0.3, DLY_SEND: 0.22, DLY_PINGPONG: 1
    },
    mods: [['ENV3', 'OSC2_PITCH', 0.5], ['LFO1', 'OSC1_FINE', 0.25], ['LFO1', 'OSC2_FINE', 0.25], ['MOD_WHEEL', 'LFO1_DEPTH', 1]]
  },
  {
    name: 'Deep Bass', cat: 'Bass',
    p: {
      VOICE_MODE: 2, GLIDE: 0.03,
      OSC1_WAVE: 2, OSC1_LEVEL: 0.6, SUB_LEVEL: 0.85,
      FLT_TYPE: 1, FLT_CUTOFF: 260, FLT_RES: 0.35, FLT_ENV_AMT: 0.45, FLT_KEYTRACK: 50,
      FLT_SHAPER: 3, FLT_DRIVE: 9,
      ENV1_A: 0.002, ENV1_D: 0.8, ENV1_S: 0.8, ENV1_R: 0.12,
      ENV2_A: 0.001, ENV2_D: 0.25, ENV2_S: 0, ENV2_R: 0.15, ENV2_VEL: 0.6
    },
    mods: []
  },
  {
    name: 'Pluck', cat: 'Bells & plucks',
    p: {
      OSC1_WAVE: 3, OSC1_LEVEL: 0.75,
      FLT_CUTOFF: 320, FLT_RES: 0.5, FLT_ENV_AMT: 0.55, FLT_KEYTRACK: 60,
      ENV1_A: 0.001, ENV1_D: 0.4, ENV1_S: 0, ENV1_R: 0.35, ENV1_CURVE: 0,
      ENV2_A: 0.001, ENV2_D: 0.4, ENV2_S: 0, ENV2_R: 0.35, ENV2_VEL: 0.8,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/8D'], DLY_FB: 0.42, DLY_SEND: 0.32, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SEND: 0.15, REV_SIZE: 0.8, REV_DECAY: 1.6,
      ARP_ON: 1, ARP_MODE: 2, ARP_OCT: 2, ARP_DIV: SUBDIV_INDEX['1/16'], ARP_GATE: 0.45, ARP_SWING: 0.08
    },
    mods: []
  },
  {
    name: 'Brass', cat: 'Leads',
    p: {
      OSC1_WAVE: 2, OSC1_LEVEL: 0.6, OSC2_WAVE: 2, OSC2_LEVEL: 0.6, OSC2_FINE: 5,
      FLT_MODE: 2, FLT_CUTOFF: 2000, FLT_RES: 0.3, FLT_ENV_AMT: 0.25, FLT_KEYTRACK: 40,
      ENV1_A: 0.08, ENV1_D: 0.4, ENV1_S: 0.85, ENV1_R: 0.25, ENV1_CURVE: 1,
      ENV2_A: 0.08, ENV2_D: 0.5, ENV2_S: 0.6, ENV2_R: 0.3, ENV2_VEL: 0.7,
      ENV3_A: 0.0005, ENV3_D: 0.05, ENV3_S: 0, ENV3_R: 0.05, PITCH_ENV_AMT: -1.5,
      UNISON: 2, UNI_DETUNE: 8, UNI_WIDTH: 0.6
    },
    mods: []
  },
  {
    name: 'Bell', cat: 'Bells & plucks',
    p: {
      OSC1_WAVE: 0, OSC1_LEVEL: 0.45, OSC2_WAVE: 0, OSC2_LEVEL: 0.85, OSC2_RING: 1, OSC2_COARSE: 19, OSC2_FINE: 42,
      FLT_MODE: 4, FLT_CUTOFF: 3200, FLT_RES: 0.85, FLT_KEYTRACK: 100,
      ENV1_A: 0.005, ENV1_D: 3.5, ENV1_S: 0, ENV1_R: 4, ENV1_CURVE: 1,
      REV_ON: 1, REV_SEND: 0.7, REV_SIZE: 1.8, REV_DECAY: 6.5, REV_DAMP: 7000, REV_PREDELAY: 30
    },
    mods: []
  },
  {
    name: 'PWM Sweep', cat: 'Arps & sequences',
    p: {
      OSC1_WAVE: 4, OSC1_PW: 0.5, OSC1_LEVEL: 0.8,
      FLT_CUTOFF: 1100, FLT_RES: 0.55, FLT_KEYTRACK: 40,
      ENV1_A: 0.002, ENV1_D: 0.18, ENV1_S: 0, ENV1_R: 0.08,
      LFO1_WAVE: 0, LFO1_RATE: 0.3, LFO1_MODE: 1,
      LFO2_WAVE: 0, LFO2_SYNC: 1, LFO2_DIV: SUBDIV_INDEX['1/4'], LFO2_MODE: 1,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/8'], DLY_FB: 0.3, DLY_SEND: 0.2
    },
    mods: [['LFO1', 'OSC1_PW', 0.4], ['LFO2', 'FILTER_CUTOFF', 0.35]]
  },
  // ---- Pads & atmospheres ----
  {
    name: 'Cloud Nine', cat: 'Pads & atmospheres',
    p: {
      OSC1_WAVE: 5, OSC1_SPREAD: 55, OSC1_LEVEL: 0.55,
      OSC2_WAVE: 5, OSC2_OCT: 1, OSC2_SPREAD: 35, OSC2_LEVEL: 0.28, SUB_LEVEL: 0.2,
      FLT_CUTOFF: 1500, FLT_RES: 0.2, FLT_KEYTRACK: 40, FLT_ENV_AMT: 0.15,
      ENV1_A: 2.2, ENV1_D: 2, ENV1_S: 0.9, ENV1_R: 5, ENV1_CURVE: 1, ENV1_VEL: 0.3,
      ENV2_A: 3, ENV2_D: 4, ENV2_S: 0.7, ENV2_R: 5,
      LFO1_WAVE: 6, LFO1_RATE: 0.12, LFO1_MODE: 1,
      LFO2_WAVE: 0, LFO2_RATE: 0.07, LFO2_MODE: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.2, LFO3_MODE: 1,
      CH_ON: 1, CH_LINES: 4, CH_RATE: 0.3, CH_DEPTH: 3, CH_DELAY: 15, CH_MIX: 0.5,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/4D'], DLY_FB: 0.45, DLY_SEND: 0.18, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 2, REV_DECAY: 12, REV_DAMP: 4500, REV_PREDELAY: 40, REV_SEND: 0.75,
      CHD_TYPE: 2, CHD_RATE: 2, CHD_PROG: 1
    },
    mods: [['LFO1', 'FILTER_CUTOFF', 0.12], ['LFO2', 'PAN', 0.35], ['LFO3', 'OSC1_FINE', 0.04],
      ['LFO3', 'OSC2_FINE', -0.05], ['MOD_WHEEL', 'FILTER_CUTOFF', 0.4]]
  },
  {
    name: 'Drift Glass', cat: 'Pads & atmospheres',
    p: {
      OSC1_WAVE: 0, OSC1_LEVEL: 0.6, OSC2_WAVE: 1, OSC2_OCT: 1, OSC2_FINE: 6, OSC2_LEVEL: 0.38, NOISE_LEVEL: 0.05,
      FLT_CUTOFF: 5000, FLT_RES: 0.15, FLT_KEYTRACK: 50,
      ENV1_A: 0.9, ENV1_D: 3, ENV1_S: 0.7, ENV1_R: 4.5, ENV1_CURVE: 1, ENV1_VEL: 0.4,
      LFO2_WAVE: 0, LFO2_RATE: 0.09, LFO2_MODE: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.18, LFO3_MODE: 1,
      CH_ON: 1, CH_LINES: 3, CH_RATE: 0.25, CH_DEPTH: 4, CH_DELAY: 14, CH_MIX: 0.45,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/8D'], DLY_FB: 0.55, DLY_SEND: 0.25, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 1.8, REV_DECAY: 9, REV_DAMP: 7000, REV_PREDELAY: 25, REV_SEND: 0.65
    },
    mods: [['LFO3', 'OSC1_FINE', 0.06], ['LFO3', 'OSC2_FINE', 0.08], ['LFO2', 'PAN', 0.5], ['MOD_WHEEL', 'NOISE_LEVEL', 0.3]]
  },
  {
    name: 'Nebula', cat: 'Pads & atmospheres',
    p: {
      OSC1_WAVE: 4, OSC1_PW: 0.5, OSC1_LEVEL: 0.55, OSC2_WAVE: 4, OSC2_PW: 0.35, OSC2_FINE: 9, OSC2_LEVEL: 0.5,
      FLT_CUTOFF: 1100, FLT_RES: 0.35, FLT_KEYTRACK: 30, FLT_ENV_AMT: 0.2,
      ENV1_A: 1.5, ENV1_D: 2, ENV1_S: 0.85, ENV1_R: 4, ENV1_CURVE: 1,
      ENV2_A: 2.5, ENV2_D: 3, ENV2_S: 0.5, ENV2_R: 4,
      LFO1_WAVE: 1, LFO1_RATE: 0.23, LFO1_MODE: 1,
      LFO2_WAVE: 0, LFO2_RATE: 0.31, LFO2_MODE: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.2, LFO3_MODE: 1,
      LFO4_WAVE: 6, LFO4_RATE: 0.08, LFO4_MODE: 1,
      CH_ON: 1, CH_LINES: 2, CH_RATE: 0.4, CH_DEPTH: 2.5, CH_MIX: 0.4,
      REV_ON: 1, REV_SIZE: 1.6, REV_DECAY: 8, REV_DAMP: 5500, REV_PREDELAY: 20, REV_SEND: 0.55
    },
    mods: [['LFO1', 'OSC1_PW', 0.35], ['LFO2', 'OSC2_PW', 0.35], ['LFO4', 'FILTER_CUTOFF', 0.15], ['LFO3', 'OSC2_FINE', 0.04]]
  },
  {
    name: 'Morning Haze', cat: 'Pads & atmospheres',
    p: {
      OSC1_WAVE: 1, OSC1_LEVEL: 0.65, OSC2_WAVE: 2, OSC2_FINE: 7, OSC2_LEVEL: 0.35, SUB_LEVEL: 0.3,
      FLT_TYPE: 1, FLT_CUTOFF: 650, FLT_RES: 0.25, FLT_KEYTRACK: 40, FLT_ENV_AMT: 0.25,
      FLT_SHAPER: 1, FLT_DRIVE: 4,
      ENV1_A: 0.8, ENV1_D: 2, ENV1_S: 0.8, ENV1_R: 3, ENV1_CURVE: 1,
      ENV2_A: 1.8, ENV2_D: 3, ENV2_S: 0.4, ENV2_R: 3,
      LFO1_WAVE: 0, LFO1_RATE: 0.15, LFO1_MODE: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.22, LFO3_MODE: 1,
      CH_ON: 1, CH_LINES: 3, CH_RATE: 0.5, CH_DEPTH: 3.5, CH_MIX: 0.55,
      REV_ON: 1, REV_SIZE: 1.3, REV_DECAY: 5, REV_DAMP: 5000, REV_SEND: 0.45
    },
    mods: [['LFO1', 'FILTER_CUTOFF', 0.08], ['LFO3', 'OSC1_FINE', 0.04], ['LFO3', 'OSC2_FINE', -0.04], ['MOD_WHEEL', 'FILTER_CUTOFF', 0.4]]
  },
  {
    name: 'Stratus Choir', cat: 'Pads & atmospheres',
    p: {
      OSC1_WAVE: 2, OSC1_LEVEL: 0.55, OSC2_WAVE: 2, OSC2_FINE: -9, OSC2_LEVEL: 0.55, NOISE_LEVEL: 0.05,
      FLT_MODE: 2, FLT_CUTOFF: 950, FLT_RES: 0.45, FLT_KEYTRACK: 70,
      ENV1_A: 1.1, ENV1_D: 1, ENV1_S: 0.95, ENV1_R: 2.8, ENV1_CURVE: 1,
      LFO1_WAVE: 0, LFO1_RATE: 5, LFO1_FADE: 1.2,
      LFO2_WAVE: 6, LFO2_RATE: 0.25, LFO2_MODE: 1,
      CH_ON: 1, CH_LINES: 4, CH_RATE: 0.35, CH_DEPTH: 3, CH_MIX: 0.5,
      REV_ON: 1, REV_SIZE: 1.9, REV_DECAY: 7, REV_DAMP: 6000, REV_PREDELAY: 30, REV_SEND: 0.6,
      EQ_MID: 2
    },
    mods: [['LFO1', 'OSC1_FINE', 0.07], ['LFO1', 'OSC2_FINE', 0.07], ['LFO2', 'FILTER_CUTOFF', 0.1]]
  },
  {
    name: 'Deep Space', cat: 'Pads & atmospheres',
    p: {
      OSC1_WAVE: 5, OSC1_SPREAD: 80, OSC1_LEVEL: 0.45, OSC2_WAVE: 2, OSC2_OCT: -1, OSC2_FINE: -12, OSC2_LEVEL: 0.3,
      NOISE_LEVEL: 0.12,
      FLT_TYPE: 1, FLT_CUTOFF: 380, FLT_RES: 0.6, FLT_KEYTRACK: 30,
      ENV1_A: 4, ENV1_D: 1, ENV1_S: 1, ENV1_R: 8, ENV1_CURVE: 1,
      LFO1_WAVE: 6, LFO1_RATE: 0.05, LFO1_MODE: 1,
      LFO2_WAVE: 0, LFO2_RATE: 0.03, LFO2_MODE: 1,
      REV_ON: 1, REV_SIZE: 2, REV_DECAY: 20, REV_DAMP: 3000, REV_PREDELAY: 60, REV_SEND: 0.8,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/2'], DLY_FB: 0.6, DLY_SEND: 0.2, DLY_PINGPONG: 1
    },
    mods: [['LFO1', 'FILTER_CUTOFF', 0.35], ['LFO2', 'FILTER_RESONANCE', 0.15], ['MOD_WHEEL', 'FILTER_CUTOFF', 0.5]]
  },
  // ---- Keys: Rhodes-style electric pianos ----
  // Sine body + fast-decaying sine tine at 14x (OSC2: +2 oct, +21 st, +69 ct),
  // velocity-driven tube bark and brightness, stereo tremolo, slow drift.
  {
    name: 'Suitcase Rhodes', cat: 'Keys',
    p: {
      OSC1_WAVE: 0, OSC1_LEVEL: 0.8,
      OSC2_WAVE: 0, OSC2_OCT: 2, OSC2_COARSE: 21, OSC2_FINE: 69, OSC2_LEVEL: 0,
      FLT_CUTOFF: 3600, FLT_RES: 0.1, FLT_KEYTRACK: 60,
      FLT_SHAPER: 3, FLT_DRIVE: 3,
      ENV1_A: 0.001, ENV1_D: 7, ENV1_S: 0, ENV1_R: 0.5, ENV1_VEL: 0.7,
      ENV4_A: 0.0005, ENV4_D: 0.18, ENV4_S: 0, ENV4_R: 0.1, ENV4_VEL: 1.2,
      LFO1_WAVE: 0, LFO1_RATE: 4.6, LFO1_MODE: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.15, LFO3_MODE: 1,
      REV_ON: 1, REV_SIZE: 0.9, REV_DECAY: 1.8, REV_DAMP: 6000, REV_SEND: 0.22,
      EQ_LOW: 1.5, EQ_HIGH: -2
    },
    mods: [['ENV4', 'OSC2_LEVEL', 0.35], ['VELOCITY', 'FILTER_DRIVE', 0.35], ['VELOCITY', 'FILTER_CUTOFF', 0.25],
      ['LFO1', 'PAN', 0.6], ['LFO3', 'OSC1_FINE', 0.02], ['MOD_WHEEL', 'LFO1_DEPTH', -0.6]]
  },
  {
    name: 'Tape Rhodes', cat: 'Keys',
    p: {
      BPM: 82,
      OSC1_WAVE: 0, OSC1_LEVEL: 0.8,
      OSC2_WAVE: 0, OSC2_OCT: 2, OSC2_COARSE: 21, OSC2_FINE: 69, OSC2_LEVEL: 0,
      FLT_CUTOFF: 3400, FLT_RES: 0.12, FLT_KEYTRACK: 50,
      FLT_SHAPER: 3, FLT_DRIVE: 4,
      ENV1_A: 0.002, ENV1_D: 6, ENV1_S: 0, ENV1_R: 0.6, ENV1_VEL: 0.6,
      ENV4_A: 0.0005, ENV4_D: 0.15, ENV4_S: 0, ENV4_R: 0.1, ENV4_VEL: 1.2,
      LFO1_WAVE: 0, LFO1_RATE: 3.8, LFO1_MODE: 1,
      LFO3_WAVE: 0, LFO3_RATE: 0.55, LFO3_MODE: 1,
      LFO4_WAVE: 6, LFO4_RATE: 7, LFO4_MODE: 1,
      WS_ON: 1, WS_MODE: 0, WS_DRIVE: 4, WS_MIX: 0.35,
      CH_ON: 1, CH_LINES: 2, CH_RATE: 0.35, CH_DEPTH: 2, CH_MIX: 0.3,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/4'], DLY_FB: 0.3, DLY_SEND: 0.12,
      REV_ON: 1, REV_SIZE: 1.2, REV_DECAY: 3, REV_DAMP: 4500, REV_SEND: 0.3,
      EQ_LOW: 2, EQ_HIGH: -2.5,
      CHD_PROG: 2, CHD_TYPE: 1, CHD_RATE: 1
    },
    mods: [['ENV4', 'OSC2_LEVEL', 0.42], ['VELOCITY', 'FILTER_DRIVE', 0.35], ['VELOCITY', 'FILTER_CUTOFF', 0.25],
      ['LFO1', 'PAN', 0.25], ['LFO3', 'OSC1_FINE', 0.09], ['LFO3', 'OSC2_FINE', 0.09], ['LFO4', 'OSC1_FINE', 0.015]]
  },
  {
    name: 'Lo-fi Keys', cat: 'Keys',
    p: {
      BPM: 78,
      OSC1_WAVE: 0, OSC1_LEVEL: 0.8,
      OSC2_WAVE: 0, OSC2_OCT: 2, OSC2_COARSE: 21, OSC2_FINE: 69, OSC2_LEVEL: 0, NOISE_LEVEL: 0.02,
      FLT_CUTOFF: 2600, FLT_RES: 0.15, FLT_KEYTRACK: 40,
      FLT_SHAPER: 3, FLT_DRIVE: 5,
      ENV1_A: 0.003, ENV1_D: 5, ENV1_S: 0, ENV1_R: 0.7, ENV1_VEL: 0.5,
      ENV4_A: 0.0005, ENV4_D: 0.15, ENV4_S: 0, ENV4_R: 0.1, ENV4_VEL: 1,
      LFO3_WAVE: 0, LFO3_RATE: 0.4, LFO3_MODE: 1,
      LFO4_WAVE: 6, LFO4_RATE: 0.3, LFO4_MODE: 1,
      WS_ON: 1, WS_MODE: 3, WS_DRIVE: 3, WS_MIX: 0.4, WS_BITS: 12, WS_SRDIV: 2,
      CH_ON: 1, CH_LINES: 2, CH_RATE: 0.3, CH_DEPTH: 2.5, CH_MIX: 0.35,
      REV_ON: 1, REV_SIZE: 1, REV_DECAY: 2.5, REV_DAMP: 3500, REV_SEND: 0.3,
      EQ_LOW: 2, EQ_HIGH: -3,
      CHD_PROG: 0, CHD_TYPE: 2, CHD_RATE: 1
    },
    mods: [['ENV4', 'OSC2_LEVEL', 0.45], ['VELOCITY', 'FILTER_DRIVE', 0.3], ['VELOCITY', 'FILTER_CUTOFF', 0.3],
      ['LFO3', 'OSC1_FINE', 0.12], ['LFO3', 'OSC2_FINE', 0.12], ['LFO4', 'FILTER_CUTOFF', 0.08]]
  },
  // ---- Bells & arps ----
  {
    name: 'Dream Bells', cat: 'Bells & plucks',
    p: {
      OSC1_WAVE: 0, OSC1_LEVEL: 0.55, OSC2_WAVE: 0, OSC2_OCT: 1, OSC2_COARSE: 7, OSC2_LEVEL: 0.08,
      FLT_CUTOFF: 6000, FLT_RES: 0.1, FLT_KEYTRACK: 50,
      ENV1_A: 0.003, ENV1_D: 5, ENV1_S: 0, ENV1_R: 5, ENV1_CURVE: 1, ENV1_VEL: 0.6,
      ENV4_A: 0.001, ENV4_D: 1.2, ENV4_S: 0, ENV4_R: 1, ENV4_VEL: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.2, LFO3_MODE: 1,
      CH_ON: 1, CH_LINES: 3, CH_RATE: 0.3, CH_DEPTH: 3, CH_MIX: 0.4,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/4D'], DLY_FB: 0.5, DLY_SEND: 0.3, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 2, REV_DECAY: 14, REV_DAMP: 8000, REV_PREDELAY: 35, REV_SEND: 0.7
    },
    mods: [['ENV4', 'OSC2_LEVEL', 0.4], ['LFO3', 'OSC1_FINE', 0.04], ['LFO3', 'OSC2_FINE', -0.06]]
  },
  {
    name: 'Aurora Arp', cat: 'Arps & sequences',
    p: {
      BPM: 88,
      OSC1_WAVE: 0, OSC1_LEVEL: 0.55, OSC2_WAVE: 1, OSC2_OCT: 1, OSC2_LEVEL: 0.4,
      FLT_CUTOFF: 2600, FLT_RES: 0.3, FLT_KEYTRACK: 50, FLT_ENV_AMT: 0.35,
      ENV1_A: 0.002, ENV1_D: 0.5, ENV1_S: 0, ENV1_R: 0.6, ENV1_VEL: 0.4,
      ENV2_A: 0.001, ENV2_D: 0.3, ENV2_S: 0, ENV2_R: 0.3,
      LFO1_WAVE: 0, LFO1_RATE: 0.05, LFO1_MODE: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.2, LFO3_MODE: 1,
      ARP_ON: 1, ARP_MODE: 2, ARP_OCT: 3, ARP_DIV: SUBDIV_INDEX['1/16'], ARP_GATE: 0.4, ARP_LATCH: 1,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/8D'], DLY_FB: 0.55, DLY_SEND: 0.35, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 2, REV_DECAY: 10, REV_DAMP: 6500, REV_PREDELAY: 20, REV_SEND: 0.6,
      CHD_TYPE: 1, CHD_PROG: 4, CHD_RATE: 2
    },
    mods: [['LFO1', 'FILTER_CUTOFF', 0.25], ['LFO3', 'OSC1_FINE', 0.03], ['LFO3', 'OSC2_FINE', -0.04]]
  },
  // ---- Showcase: dense modulation, every source doing something musical ----
  // Mod depth units: cutoff 1.0 = 5 oct · pitch 1.0 = 24 st · fine 1.0 = 100 ct · PW 1.0 = ±0.49.
  {
    // Supersaw + octave-and-fifth sine through serial SVF→ladder. The filter breathes
    // once every two bars, each oscillator drifts on its own random curve, a slow aux
    // envelope blooms the reverb and opens the filter the longer a chord is held, and
    // keys spread across the stereo field by pitch.
    name: 'Glass Cathedral', cat: 'Showcase',
    p: {
      OSC1_WAVE: 5, OSC1_SPREAD: 45, OSC1_LEVEL: 0.5,
      OSC2_WAVE: 0, OSC2_OCT: 1, OSC2_COARSE: 7, OSC2_LEVEL: 0.24, SUB_LEVEL: 0.22, NOISE_LEVEL: 0.02,
      FLT_TYPE: 2, FLT_CUTOFF: 1400, FLT_RES: 0.3, FLT_KEYTRACK: 45, FLT_ENV_AMT: 0.18,
      ENV1_A: 2.5, ENV1_D: 3, ENV1_S: 0.85, ENV1_R: 7, ENV1_CURVE: 1, ENV1_VEL: 0.35,
      ENV2_A: 4, ENV2_D: 6, ENV2_S: 0.5, ENV2_R: 7,
      ENV4_A: 6, ENV4_D: 4, ENV4_S: 0.7, ENV4_R: 8,
      LFO1_WAVE: 0, LFO1_SYNC: 1, LFO1_DIV: SUBDIV_INDEX['2 bars'], LFO1_MODE: 1,
      LFO2_WAVE: 6, LFO2_RATE: 0.13, LFO2_MODE: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.09, LFO3_MODE: 1,
      LFO4_WAVE: 1, LFO4_RATE: 0.05, LFO4_MODE: 1,
      CH_ON: 1, CH_LINES: 6, CH_RATE: 0.22, CH_DEPTH: 3.5, CH_DELAY: 16, CH_MIX: 0.45,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/4D'], DLY_FB: 0.5, DLY_SEND: 0.2, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 2, REV_DECAY: 16, REV_DAMP: 5200, REV_PREDELAY: 55, REV_SEND: 0.7,
      EQ_LOW: -1.5, EQ_HIGH: 1.5,
      CMP_ON: 1, CMP_THRESH: -22, CMP_RATIO: 2.5, CMP_ATTACK: 30, CMP_RELEASE: 400, CMP_MIX: 0.5,
      CHD_TYPE: 2, CHD_PROG: 3, CHD_RATE: 2
    },
    mods: [['LFO1', 'FILTER_CUTOFF', 0.14], ['LFO2', 'OSC1_FINE', 0.06], ['LFO3', 'OSC2_FINE', -0.07],
      ['LFO4', 'PAN', 0.45], ['ENV4', 'REVERB_SEND', 0.25], ['ENV4', 'FILTER_CUTOFF', 0.12],
      ['MOD_WHEEL', 'FILTER_CUTOFF', 0.4], ['AFTERTOUCH', 'FILTER_CUTOFF', 0.25],
      ['VELOCITY', 'OSC2_LEVEL', 0.15], ['NOTE_NUMBER', 'PAN', 0.35]]
  },
  {
    // Two pulse waves whose widths sweep against each other, through a band-pass
    // "vowel" that wanders on a smooth random curve. Vibrato fades in on each note.
    name: 'Tidal Choir', cat: 'Showcase',
    p: {
      OSC1_WAVE: 4, OSC1_PW: 0.42, OSC1_LEVEL: 0.5,
      OSC2_WAVE: 4, OSC2_PW: 0.58, OSC2_FINE: -8, OSC2_LEVEL: 0.5, NOISE_LEVEL: 0.04,
      FLT_MODE: 2, FLT_CUTOFF: 1100, FLT_RES: 0.55, FLT_KEYTRACK: 60,
      ENV1_A: 1.4, ENV1_D: 2, ENV1_S: 0.9, ENV1_R: 3.5, ENV1_CURVE: 1, ENV1_VEL: 0.4,
      LFO1_WAVE: 0, LFO1_RATE: 5.2, LFO1_FADE: 1.5, LFO1_DEPTH: 0.55,
      LFO2_WAVE: 6, LFO2_RATE: 0.35, LFO2_MODE: 1,
      LFO3_WAVE: 1, LFO3_RATE: 0.17, LFO3_MODE: 1,
      LFO4_WAVE: 1, LFO4_RATE: 0.23, LFO4_MODE: 1, LFO4_PHASE: 180,
      CH_ON: 1, CH_LINES: 4, CH_RATE: 0.3, CH_DEPTH: 3, CH_DELAY: 14, CH_MIX: 0.5,
      REV_ON: 1, REV_SIZE: 1.9, REV_DECAY: 9, REV_DAMP: 6500, REV_PREDELAY: 35, REV_SEND: 0.6,
      EQ_LOW: -3, EQ_MID: 2.5,
      CHD_TYPE: 1, CHD_PROG: 1, CHD_RATE: 2
    },
    mods: [['LFO1', 'OSC1_FINE', 0.06], ['LFO1', 'OSC2_FINE', 0.06],
      ['LFO2', 'FILTER_CUTOFF', 0.22], ['LFO2', 'FILTER_RESONANCE', 0.12],
      ['LFO3', 'OSC1_PW', 0.5], ['LFO4', 'OSC2_PW', -0.5],
      ['MOD_WHEEL', 'LFO1_DEPTH', 0.45], ['AFTERTOUCH', 'FILTER_CUTOFF', 0.2]]
  },
  {
    // Triplet arpeggio of a sine and a fifth-up triangle. Sample-and-hold LFOs locked to
    // the grid make every step land at a different brightness and stereo position; a
    // four-bar sweep rides over the top. Latched: tap a chord and let it run.
    name: 'Starfield Arp', cat: 'Showcase',
    p: {
      BPM: 96,
      OSC1_WAVE: 0, OSC1_LEVEL: 0.5, OSC2_WAVE: 1, OSC2_OCT: 1, OSC2_COARSE: 7, OSC2_LEVEL: 0.25,
      FLT_CUTOFF: 3000, FLT_RES: 0.35, FLT_KEYTRACK: 60, FLT_ENV_AMT: 0.3,
      ENV1_A: 0.002, ENV1_D: 0.9, ENV1_S: 0, ENV1_R: 0.9, ENV1_VEL: 0.5,
      ENV2_A: 0.001, ENV2_D: 0.25, ENV2_S: 0, ENV2_R: 0.3,
      LFO1_WAVE: 5, LFO1_SYNC: 1, LFO1_DIV: SUBDIV_INDEX['1/16'], LFO1_MODE: 1,
      LFO2_WAVE: 5, LFO2_SYNC: 1, LFO2_DIV: SUBDIV_INDEX['1/8'], LFO2_MODE: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.2, LFO3_MODE: 1,
      LFO4_WAVE: 0, LFO4_SYNC: 1, LFO4_DIV: SUBDIV_INDEX['4 bars'], LFO4_MODE: 1,
      ARP_ON: 1, ARP_MODE: 2, ARP_OCT: 3, ARP_DIV: SUBDIV_INDEX['1/16T'], ARP_GATE: 0.35, ARP_LATCH: 1,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/8D'], DLY_FB: 0.58, DLY_SEND: 0.35, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 2, REV_DECAY: 14, REV_DAMP: 7500, REV_PREDELAY: 25, REV_SEND: 0.6,
      CHD_TYPE: 2, CHD_PROG: 6, CHD_RATE: 2
    },
    mods: [['LFO1', 'FILTER_CUTOFF', 0.18], ['LFO2', 'PAN', 0.55], ['LFO3', 'OSC2_FINE', 0.05],
      ['LFO4', 'FILTER_CUTOFF', 0.2], ['VELOCITY', 'FILTER_CUTOFF', 0.15], ['MOD_WHEEL', 'DELAY_SEND', 0.4]]
  },
  {
    // A sine struck by a ring-modulated partial at the bell ratio 2.76. The metallic
    // overtones die in a second and a half, leaving glass; harder hits ring brighter.
    name: 'Prism Rain', cat: 'Showcase',
    p: {
      OSC1_WAVE: 0, OSC1_LEVEL: 0.8,
      OSC2_WAVE: 0, OSC2_COARSE: 17, OSC2_FINE: 58, OSC2_RING: 1, OSC2_LEVEL: 0.1,
      FLT_CUTOFF: 7000, FLT_RES: 0.1, FLT_KEYTRACK: 50,
      ENV1_A: 0.001, ENV1_D: 4, ENV1_S: 0, ENV1_R: 3.5, ENV1_CURVE: 1, ENV1_VEL: 0.7,
      ENV4_A: 0.0005, ENV4_D: 1.4, ENV4_S: 0, ENV4_R: 1.2, ENV4_VEL: 1,
      LFO1_WAVE: 5, LFO1_SYNC: 1, LFO1_DIV: SUBDIV_INDEX['1/8'], LFO1_MODE: 1,
      LFO2_WAVE: 0, LFO2_RATE: 0.12, LFO2_MODE: 1,
      CH_ON: 1, CH_LINES: 3, CH_RATE: 0.4, CH_DEPTH: 2.5, CH_MIX: 0.35,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/8'], DLY_FB: 0.5, DLY_SEND: 0.3, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 2, REV_DECAY: 11, REV_DAMP: 9000, REV_PREDELAY: 30, REV_SEND: 0.55,
      EQ_HIGH: 1
    },
    mods: [['ENV4', 'OSC2_LEVEL', 0.6], ['VELOCITY', 'OSC2_LEVEL', 0.2], ['LFO1', 'OSC2_FINE', 0.03],
      ['LFO2', 'PAN', 0.5], ['MOD_WHEEL', 'REVERB_SEND', 0.3]]
  },
  {
    // White noise through a near-self-oscillating band-pass that tracks the keyboard
    // exactly: each key whistles at its own pitch, like wind across bottle necks.
    // Random gusts move the level, the pitch wavers slightly, and it pans slowly.
    name: 'Solar Wind', cat: 'Showcase',
    p: {
      OSC1_WAVE: 0, OSC1_LEVEL: 0.02, NOISE_LEVEL: 0.6,
      FLT_MODE: 2, FLT_CUTOFF: 261.6, FLT_RES: 1.07, FLT_KEYTRACK: 100,
      ENV1_A: 2.5, ENV1_D: 2, ENV1_S: 1, ENV1_R: 5, ENV1_CURVE: 1, ENV1_VEL: 0.3,
      LFO1_WAVE: 6, LFO1_RATE: 0.25, LFO1_MODE: 1,
      LFO2_WAVE: 6, LFO2_RATE: 0.11, LFO2_MODE: 1,
      LFO3_WAVE: 0, LFO3_RATE: 0.07, LFO3_MODE: 1,
      CH_ON: 1, CH_LINES: 4, CH_RATE: 0.3, CH_DEPTH: 3, CH_MIX: 0.5,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/4D'], DLY_FB: 0.5, DLY_SEND: 0.2, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 2, REV_DECAY: 15, REV_DAMP: 4000, REV_PREDELAY: 60, REV_SEND: 0.75,
      CHD_TYPE: 2, CHD_PROG: 0, CHD_RATE: 2
    },
    mods: [['LFO1', 'FILTER_CUTOFF', 0.015], ['LFO2', 'AMP', 0.35], ['LFO3', 'PAN', 0.6],
      ['MOD_WHEEL', 'FILTER_RESONANCE', -0.12], ['AFTERTOUCH', 'AMP', 0.3]]
  },
  {
    // Legato supersaw lead an octave over a detuned saw. Each new note scoops up two
    // semitones; vibrato waits, then fades in; wheel and pressure deepen it.
    name: 'Hyperion Lead', cat: 'Showcase',
    p: {
      VOICE_MODE: 2, GLIDE: 0.08,
      OSC1_WAVE: 5, OSC1_SPREAD: 22, OSC1_LEVEL: 0.55,
      OSC2_WAVE: 2, OSC2_OCT: -1, OSC2_FINE: 4, OSC2_LEVEL: 0.35,
      FLT_CUTOFF: 3200, FLT_RES: 0.4, FLT_KEYTRACK: 60, FLT_ENV_AMT: 0.2,
      FLT_SHAPER: 1, FLT_DRIVE: 5,
      ENV1_A: 0.01, ENV1_D: 1, ENV1_S: 0.85, ENV1_R: 0.45,
      ENV2_A: 0.005, ENV2_D: 0.8, ENV2_S: 0.35, ENV2_R: 0.4,
      ENV3_A: 0.0005, ENV3_D: 0.12, ENV3_S: 0, ENV3_R: 0.1, PITCH_ENV_AMT: -2,
      LFO1_WAVE: 0, LFO1_RATE: 5.6, LFO1_FADE: 0.6, LFO1_DEPTH: 0.3,
      CH_ON: 1, CH_LINES: 2, CH_RATE: 0.5, CH_DEPTH: 2, CH_MIX: 0.25,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/8D'], DLY_FB: 0.45, DLY_SEND: 0.28, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 1.6, REV_DECAY: 5, REV_DAMP: 6000, REV_SEND: 0.35
    },
    mods: [['LFO1', 'OSC1_FINE', 0.14], ['LFO1', 'OSC2_FINE', 0.14], ['MOD_WHEEL', 'LFO1_DEPTH', 0.7],
      ['AFTERTOUCH', 'LFO1_DEPTH', 0.5], ['AFTERTOUCH', 'FILTER_CUTOFF', 0.15], ['VELOCITY', 'FILTER_CUTOFF', 0.12]]
  },
  {
    // Saw, square an octave down and sub through a folding ladder. The fold drive
    // drifts slowly so the tone shimmers; the mod wheel fades in a quarter-note wobble.
    name: 'Liquid Bass', cat: 'Showcase',
    p: {
      VOICE_MODE: 2, GLIDE: 0.06,
      OSC1_WAVE: 2, OSC1_LEVEL: 0.5, OSC2_WAVE: 3, OSC2_OCT: -1, OSC2_LEVEL: 0.35, SUB_LEVEL: 0.5,
      FLT_TYPE: 1, FLT_CUTOFF: 380, FLT_RES: 0.45, FLT_KEYTRACK: 50, FLT_ENV_AMT: 0.35,
      FLT_SHAPER: 5, FLT_DRIVE: 6,
      ENV1_A: 0.002, ENV1_D: 1, ENV1_S: 0.9, ENV1_R: 0.15,
      ENV2_A: 0.001, ENV2_D: 0.35, ENV2_S: 0.15, ENV2_R: 0.2, ENV2_VEL: 0.6,
      LFO1_WAVE: 0, LFO1_SYNC: 1, LFO1_DIV: SUBDIV_INDEX['1/4'], LFO1_DEPTH: 0,
      LFO2_WAVE: 6, LFO2_RATE: 0.3, LFO2_MODE: 1,
      CH_ON: 1, CH_LINES: 2, CH_RATE: 0.5, CH_DEPTH: 1.5, CH_MIX: 0.2,
      CMP_ON: 1, CMP_THRESH: -20, CMP_RATIO: 4, CMP_ATTACK: 8, CMP_RELEASE: 150, CMP_MAKEUP: 3,
      EQ_LOW: 2
    },
    mods: [['MOD_WHEEL', 'LFO1_DEPTH', 1], ['LFO1', 'FILTER_CUTOFF', 0.25], ['LFO2', 'FILTER_DRIVE', 0.1],
      ['VELOCITY', 'FILTER_CUTOFF', 0.15]]
  },
  {
    // Electric piano (sine body + fast tine at 14×) through a notch that sweeps two
    // octaves every two bars — a phaser — with an eighth-triplet auto-pan.
    name: 'Phase Rhodes', cat: 'Showcase',
    p: {
      BPM: 90,
      OSC1_WAVE: 0, OSC1_LEVEL: 1,
      OSC2_WAVE: 0, OSC2_OCT: 2, OSC2_COARSE: 21, OSC2_FINE: 69, OSC2_LEVEL: 0,
      FLT_MODE: 3, FLT_CUTOFF: 1200, FLT_RES: 0.55, MASTER_VOL: 0.95,
      FLT_SHAPER: 3, FLT_DRIVE: 3,
      ENV1_A: 0.001, ENV1_D: 6, ENV1_S: 0, ENV1_R: 0.6, ENV1_VEL: 0.65,
      ENV4_A: 0.0005, ENV4_D: 0.16, ENV4_S: 0, ENV4_R: 0.1, ENV4_VEL: 1.2,
      LFO1_WAVE: 0, LFO1_SYNC: 1, LFO1_DIV: SUBDIV_INDEX['1/8T'], LFO1_MODE: 1,
      LFO2_WAVE: 1, LFO2_SYNC: 1, LFO2_DIV: SUBDIV_INDEX['2 bars'], LFO2_MODE: 1,
      LFO3_WAVE: 6, LFO3_RATE: 0.2, LFO3_MODE: 1,
      WS_ON: 1, WS_MODE: 0, WS_DRIVE: 3, WS_MIX: 0.3,
      CH_ON: 1, CH_LINES: 2, CH_RATE: 0.35, CH_DEPTH: 2, CH_MIX: 0.3,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/4D'], DLY_FB: 0.35, DLY_SEND: 0.15,
      REV_ON: 1, REV_SIZE: 1.3, REV_DECAY: 3.5, REV_DAMP: 5000, REV_SEND: 0.3,
      EQ_LOW: 1.5, EQ_HIGH: -1.5,
      CHD_PROG: 2, CHD_TYPE: 1, CHD_RATE: 1
    },
    mods: [['ENV4', 'OSC2_LEVEL', 0.4], ['VELOCITY', 'FILTER_DRIVE', 0.35], ['LFO1', 'PAN', 0.5],
      ['LFO2', 'FILTER_CUTOFF', 0.35], ['LFO3', 'OSC1_FINE', 0.03], ['LFO3', 'OSC2_FINE', 0.03]]
  },
  {
    // Sixteenth arpeggio against three cross-rhythms: the filter cycles every dotted
    // quarter, the pan every quarter-triplet, the pulse width every bar, and resonance
    // and echo swell over eight bars, so the pattern never repeats the same way twice.
    name: 'Polyrhythm Engine', cat: 'Showcase',
    p: {
      BPM: 110,
      OSC1_WAVE: 2, OSC1_LEVEL: 0.6, OSC2_WAVE: 4, OSC2_PW: 0.3, OSC2_OCT: 1, OSC2_FINE: 6, OSC2_LEVEL: 0.4,
      SUB_LEVEL: 0.25,
      FLT_TYPE: 2, FLT_CUTOFF: 900, FLT_RES: 0.55, FLT_KEYTRACK: 40, FLT_ENV_AMT: 0.4,
      ENV1_A: 0.002, ENV1_D: 0.3, ENV1_S: 0.3, ENV1_R: 0.25,
      ENV2_A: 0.001, ENV2_D: 0.18, ENV2_S: 0, ENV2_R: 0.15, ENV2_VEL: 0.7,
      LFO1_WAVE: 1, LFO1_SYNC: 1, LFO1_DIV: SUBDIV_INDEX['1/4D'], LFO1_MODE: 1,
      LFO2_WAVE: 0, LFO2_SYNC: 1, LFO2_DIV: SUBDIV_INDEX['1/4T'], LFO2_MODE: 1,
      LFO3_WAVE: 3, LFO3_SYNC: 1, LFO3_DIV: SUBDIV_INDEX['1 bar'], LFO3_MODE: 1,
      LFO4_WAVE: 0, LFO4_SYNC: 1, LFO4_DIV: SUBDIV_INDEX['8 bars'], LFO4_MODE: 1,
      ARP_ON: 1, ARP_MODE: 0, ARP_OCT: 2, ARP_DIV: SUBDIV_INDEX['1/16'], ARP_GATE: 0.55, ARP_SWING: 0.1, ARP_LATCH: 1,
      DLY_ON: 1, DLY_SYNC: 1, DLY_DIV: SUBDIV_INDEX['1/8D'], DLY_FB: 0.5, DLY_SEND: 0.3, DLY_PINGPONG: 1,
      REV_ON: 1, REV_SIZE: 1.4, REV_DECAY: 4, REV_SEND: 0.3,
      CMP_ON: 1, CMP_THRESH: -18, CMP_RATIO: 3, CMP_MIX: 0.6,
      CHD_PROG: 3, CHD_TYPE: 1, CHD_RATE: 1
    },
    mods: [['LFO1', 'FILTER_CUTOFF', 0.25], ['LFO2', 'PAN', 0.4], ['LFO3', 'OSC2_PW', 0.4],
      ['LFO4', 'FILTER_RESONANCE', 0.25], ['LFO4', 'DELAY_SEND', 0.2], ['VELOCITY', 'FILTER_CUTOFF', 0.1]]
  },
  {
    // Two detuned saws through a gentle ladder with a slow bow-like attack, a delayed
    // vibrato and a little bow noise. Pressure and velocity lean into the brightness.
    name: 'Cello Dusk', cat: 'Showcase',
    p: {
      OSC1_WAVE: 2, OSC1_LEVEL: 0.5, OSC2_WAVE: 2, OSC2_FINE: 7, OSC2_LEVEL: 0.45, NOISE_LEVEL: 0.03,
      FLT_TYPE: 1, FLT_CUTOFF: 1300, FLT_RES: 0.15, FLT_KEYTRACK: 70, FLT_ENV_AMT: 0.12,
      ENV1_A: 0.35, ENV1_D: 1, ENV1_S: 0.9, ENV1_R: 0.9, ENV1_CURVE: 1, ENV1_VEL: 0.6,
      ENV2_A: 0.5, ENV2_D: 1.5, ENV2_S: 0.7, ENV2_R: 1,
      LFO1_WAVE: 0, LFO1_RATE: 5.3, LFO1_FADE: 0.8, LFO1_DEPTH: 0.6,
      LFO2_WAVE: 6, LFO2_RATE: 0.4, LFO2_MODE: 1,
      CH_ON: 1, CH_LINES: 3, CH_RATE: 0.35, CH_DEPTH: 2, CH_MIX: 0.3,
      REV_ON: 1, REV_SIZE: 1.7, REV_DECAY: 5.5, REV_DAMP: 5000, REV_PREDELAY: 25, REV_SEND: 0.45,
      EQ_LOW: 1, EQ_MID: 1.5, EQ_HIGH: -2
    },
    mods: [['LFO1', 'OSC1_FINE', 0.08], ['LFO1', 'OSC2_FINE', 0.08], ['LFO2', 'FILTER_CUTOFF', 0.04],
      ['VELOCITY', 'FILTER_CUTOFF', 0.2], ['AFTERTOUCH', 'FILTER_CUTOFF', 0.2], ['MOD_WHEEL', 'LFO1_DEPTH', 0.4]]
  }
];

function factorySnapshot(k) {
  const f = FACTORY[k];
  const o = { _name: f.name };
  PARAMS.forEach(p => { o[p.id] = p.def; });
  Object.assign(o, f.p);
  (f.mods || []).forEach((m, i) => {
    o[`MOD${i}_SRC`] = SOURCES.indexOf(m[0]);
    o[`MOD${i}_DST`] = DESTS.indexOf(m[1]);
    o[`MOD${i}_DEPTH`] = m[2];
    o[`MOD${i}_CURVE`] = m[3] ? CURVES.indexOf(m[3]) : 0;
    o[`MOD${i}_ON`] = 1;
  });
  return o;
}

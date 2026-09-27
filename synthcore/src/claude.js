// ---------------------------------------------------------------------------
// "Claude plays": the page asks Claude (through the artifact `sample`
// capability, on the viewer's own account) for a composition in a simple line
// format, draws it on a piano roll as it streams in, then hands the note
// events to the worklet's sequence player.
const SOUND_NOTES = {
  'Init': 'plain bright sawtooth, dry',
  'Warm Pad': 'soft supersaw pad with chorus and reverb, slow attack',
  'Cloud Nine': 'huge dreamy pad, very slow 2 s attack, long reverb and echoes',
  'Drift Glass': 'glassy sine/triangle pad, slightly detuned, airy',
  'Nebula': 'evolving pulse-width pad, slow attack',
  'Morning Haze': 'warm dark pad, gentle',
  'Stratus Choir': 'breathy choir-like pad with vibrato',
  'Deep Space': 'dark drone, 4 s swell, for long held notes only',
  'Suitcase Rhodes': 'clean electric piano with stereo tremolo, velocity sensitive',
  'Tape Rhodes': 'warm wobbly lo-fi electric piano',
  'Lo-fi Keys': 'dusty bitcrushed electric piano',
  'Pluck': 'short square pluck with echoes',
  'Bell': 'metallic ring-mod bell, long decay',
  'Dream Bells': 'soft glassy bells with long echoes',
  'PWM Sweep': 'short staccato pulse stabs',
  'Aurora Arp': 'soft sine/triangle pluck with long echoes, made for the arpeggiator',
  'Lead Sync': 'MONOPHONIC sync lead: one note at a time, melody only',
  'Brass': 'brassy synth section, good for chords',
  'Deep Bass': 'MONOPHONIC bass: one note at a time, bass lines only',
  'Glass Cathedral': 'vast shimmering supersaw pad that blooms the longer chords are held; slow 2.5 s attack, 16 s reverb',
  'Tidal Choir': 'wordless choir: pulse waves through a wandering vowel filter, vibrato fades in, 1.4 s attack',
  'Starfield Arp': 'twinkling sine/triangle pluck; each step lands at a random brightness and stereo spot; made for the arpeggiator',
  'Prism Rain': 'glass bell: metallic ring that melts into a pure tone; echoes and long reverb',
  'Solar Wind': 'pitched wind whistling at each key, slow gusty swell; for long held notes and slow melodies',
  'Hyperion Lead': 'MONOPHONIC soaring supersaw lead: each note scoops up, vibrato blooms; melody only',
  'Liquid Bass': 'MONOPHONIC round folded bass with glide; bass lines only',
  'Phase Rhodes': 'electric piano through a slow phaser sweep with triplet auto-pan',
  'Polyrhythm Engine': 'punchy saw/pulse pluck with cross-rhythm filter and pan motion; made for the arpeggiator',
  'Cello Dusk': 'bowed string ensemble, slow bow attack, delayed vibrato; expressive melodies and chords'
};
const CL_IDEAS = [
  'A rainy late-night ballad on the Rhodes',
  'Floating ambient clouds, very slow',
  'Bright sunrise, hopeful and rising',
  'Lo-fi study chords with a lazy melody',
  'Something bittersweet and cinematic',
  'Shimmering arpeggios under the stars',
  'Surprise me'
];

// Knobs Claude may set before it plays and move while it plays. The second field is
// the name shown to the listener; enum knobs take their option names.
const CL_KNOBS = [
  ['OSC1_WAVE', 'Osc 1 wave'], ['OSC2_WAVE', 'Osc 2 wave'], ['OSC2_COARSE', 'Osc 2 interval'], ['OSC2_FINE', 'Osc 2 detune'],
  ['OSC1_LEVEL', 'Osc 1 level'], ['OSC2_LEVEL', 'Osc 2 level'], ['SUB_LEVEL', 'Sub'], ['NOISE_LEVEL', 'Noise'],
  ['OSC1_SPREAD', 'Supersaw spread'], ['GLIDE', 'Glide'],
  ['FLT_TYPE', 'Filter type'], ['FLT_MODE', 'Filter mode'], ['FLT_CUTOFF', 'Cutoff'], ['FLT_RES', 'Resonance'],
  ['FLT_ENV_AMT', 'Filter env'], ['FLT_SHAPER', 'Drive type'], ['FLT_DRIVE', 'Drive'],
  ['ENV1_A', 'Attack'], ['ENV1_D', 'Decay'], ['ENV1_S', 'Sustain'], ['ENV1_R', 'Release'],
  ['CH_MIX', 'Chorus'], ['DLY_SEND', 'Echo send'], ['DLY_FB', 'Echo feedback'], ['DLY_DIV', 'Echo time'],
  ['REV_SEND', 'Reverb send'], ['REV_DECAY', 'Reverb decay'], ['REV_SIZE', 'Room size'],
  ['EQ_LOW', 'Low EQ'], ['EQ_HIGH', 'High EQ'],
  ['ARP_ON', 'Arp'], ['ARP_MODE', 'Arp pattern'], ['ARP_OCT', 'Arp octaves'], ['ARP_DIV', 'Arp rate'],
  ['ARP_GATE', 'Arp gate'], ['ARP_SWING', 'Arp swing']
];
const CL_KNOB_NAME = {};
CL_KNOBS.forEach(([id, n]) => { CL_KNOB_NAME[id] = n; });
const clNorm = (x) => String(x).toUpperCase().replace(/[^A-Z0-9/]/g, '');

// A knob value from Claude (number, option name, or on/off) -> a legal value, or null.
function resolveKnob(id, raw) {
  const i = PIDX[id];
  if (i === undefined || !CL_KNOB_NAME[id]) return null;
  const p = PARAMS[i];
  if (p.kind === 'e') {
    const opts = p.opts.slice(0, p.max + 1);
    if (typeof raw === 'number' && Number.isFinite(raw)) return clampN(Math.round(raw), p.min, p.max);
    const k = opts.findIndex((o) => clNorm(o) === clNorm(raw));
    return k >= 0 ? k : null;
  }
  if (p.kind === 'b') {
    if (raw === true || raw === 1 || /^(1|on|true|yes)$/i.test(String(raw))) return 1;
    if (raw === false || raw === 0 || /^(0|off|false|no)$/i.test(String(raw))) return 0;
    return null;
  }
  const v = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  return p.kind === 'i' ? clampN(Math.round(v), p.min, p.max) : clampN(v, p.min, p.max);
}
function knobDoc(id) {
  const p = PARAMS[PIDX[id]];
  let r;
  if (p.kind === 'e') r = p.opts.slice(0, p.max + 1).join(' | ');
  else if (p.kind === 'b') r = '0 or 1';
  else r = `${p.min} to ${p.max}` + ({ hz: ' Hz', s: ' s', db: ' dB', ct: ' cents', st: ' semitones', x: '', '%': ' (0-1)' }[p.unit] || '');
  return `${id} (${CL_KNOB_NAME[id]}): ${r}`;
}

function buildComposePrompt(request, keepSound, currentName, useArp) {
  const sounds = FACTORY.map((f) => `- ${f.name}: ${SOUND_NOTES[f.name] || f.cat}`).join('\n');
  const soundRule = keepSound
    ? `Play it on the sound "${currentName}" (already loaded); put exactly that name in "sound". The listener asked to keep this sound, so only use ARP_ knobs in "knobs" and leave "moves" empty.`
    : 'Choose the sound from the list below that suits the request best; put its exact name in "sound". Then shape it with "knobs" and bring it to life with "moves".';
  const knobList = CL_KNOBS.map(([id]) => '- ' + knobDoc(id)).join('\n');
  const arpRule = useArp
    ? `This time, use the arpeggiator for the chords. Write the chords as held blocks (3 to 5 notes with the same start and duration, usually 2 to 8 beats) and end each of those lines with " a". The arpeggiator turns every held "a" chord into a flowing pattern at ARP_DIV speed. Set ARP_ON 1, ARP_MODE, ARP_DIV, ARP_OCT and ARP_GATE in "knobs" to suit the mood (e.g. UP-DN 1/16 2 octaves for shimmer, UP 1/8T for a gentle roll, RAND 1/16 for sparkle, CHORD 1/8 for pulsing stabs). Keep the melody and bass as ordinary lines without "a". An arpeggiated chord uses about 2 voices; direct notes on top may use the other 6.`
    : 'This time, play every note yourself: no arpeggiator. Do not mark any line with "a", and set ARP_ON 0 in "knobs".';
  return `You are Claude, seated at SYNTHCORE, a polyphonic browser synthesizer, about to play a short piece for the listener. You can play the keys and turn the synth's knobs. Their request: "${request}"

Compose an original piece that fits it. Write real music: a clear harmonic progression with voice-led chords, a memorable melody or motif on top, a bass line or bass notes, musical dynamics and phrasing, and an ending that resolves.

Rules:
- 4/4 time, 8 to 24 bars. Times and durations are in beats (quarter notes), starting at 0. Fractions are fine (0.5, 0.25, 0.333).
- MIDI note numbers 28 to 100 (60 = middle C).
- At most 7 notes sounding at the same moment: the synth has 8 voices.
- Velocity 1 to 127; vary it.
- Tempo 50 to 150 BPM.
- ${soundRule}
- ${arpRule}

Knobs: "knobs" sets knobs before you start playing: choose 3 to 10 that make the sound fit the request (darker or brighter, wetter or drier, softer or sharper attack, echo timing...). "moves" turns knobs while you play, as [beat, "KNOB", value] points: a continuous knob glides from its previous point (or its starting value at beat 0) and arrives at the value on that beat; a switch or option changes on that beat. Use 2 to 12 points to shape the arc of the piece, e.g. open FLT_CUTOFF across a build, swell REV_SEND into the ending, lengthen ENV1_R for the last chord. Available knobs:
${knobList}

Reply in exactly this format and nothing else (no code fences, no commentary):
Line 1: one JSON object on a single line: {"title": "2 to 5 words", "sound": "sound name", "bpm": number, "bars": number, "note": "one sentence about what you played and why", "knobs": {"KNOB": value, ...}, "moves": [[beat, "KNOB", value], ...]}
Every following line: one note as four numbers separated by single spaces: start duration midi velocity (add " a" at the end to hand that note to the arpeggiator)
List the notes in order of start time.

Sounds:
${sounds}`;
}

// Tolerant parser for the streamed answer. The header is the first balanced {...},
// even if it spans lines. With `partial`, the last line may still be growing, so it
// is ignored.
function parsePiece(text, partial) {
  const s = String(text);
  let header = null, rest = s;
  const a = s.indexOf('{');
  if (a >= 0) {
    let depth = 0, inStr = false, esc = false, b = -1;
    for (let i = a; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { b = i; break; }
    }
    if (b > a) {
      try { header = JSON.parse(s.slice(a, b + 1)); } catch (e) { header = null; }
      rest = s.slice(0, a) + '\n' + s.slice(b + 1);
    } else rest = s.slice(0, a);
  }
  const lines = rest.split(/\r?\n/);
  if (partial) lines.pop();
  const notes = [];
  const re = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d{1,3})\s+(\d{1,3})(?:\s+(a|arp))?\s*$/i;
  for (const line of lines) {
    const m = re.exec(line);
    if (m) notes.push([+m[1], +m[2], +m[3], +m[4], m[5] ? 1 : 0]);
  }
  return { header, notes };
}

function finalizePiece(parsed, request) {
  const h = parsed.header && typeof parsed.header === 'object' ? parsed.header : {};
  const notes = [];
  for (const [t, d, n, v, arp] of parsed.notes) {
    if (!(t >= 0 && t < 400) || !(d > 0)) continue;
    notes.push([t, Math.min(32, Math.max(0.05, d)), Math.round(clampN(n, 21, 108)), Math.round(clampN(v, 1, 127)), arp ? 1 : 0]);
    if (notes.length >= 1500) break;
  }
  notes.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const end = notes.reduce((m, x) => Math.max(m, x[0] + x[1]), 0);
  const bars = Math.max(1, Math.min(64, Math.round(+h.bars) || Math.ceil(end / 4)));
  const soundIdx = typeof h.sound === 'string' ? FACTORY.findIndex((f) => f.name.toLowerCase() === h.sound.trim().toLowerCase()) : -1;
  const knobs = {};
  if (h.knobs && typeof h.knobs === 'object' && !Array.isArray(h.knobs)) {
    for (const id of Object.keys(h.knobs)) {
      const key = id.trim().toUpperCase();
      const v = resolveKnob(key, h.knobs[id]);
      if (v !== null) knobs[key] = v;
    }
  }
  const moves = [];
  if (Array.isArray(h.moves)) {
    for (const m of h.moves) {
      const t = Array.isArray(m) ? m[0] : m && (m.beat ?? m.b);
      const id = String(Array.isArray(m) ? m[1] : m && (m.knob ?? m.k) || '').trim().toUpperCase();
      const raw = Array.isArray(m) ? m[2] : m && (m.value ?? m.v);
      const v = resolveKnob(id, raw);
      if (!(+t >= 0 && +t < 400) || v === null) continue;
      moves.push([+t, id, v]);
      if (moves.length >= 48) break;
    }
    moves.sort((a, b) => a[0] - b[0]);
  }
  const hasArp = notes.some((x) => x[4]);
  if (hasArp) knobs.ARP_ON = 1;
  return {
    title: typeof h.title === 'string' && h.title.trim() ? h.title.trim().slice(0, 60) : 'Untitled',
    sound: soundIdx >= 0 ? FACTORY[soundIdx].name : '',
    bpm: Math.round(clampN(+h.bpm || 90, 40, 180)),
    bars,
    note: typeof h.note === 'string' ? h.note.trim().slice(0, 300) : '',
    request: String(request || '').slice(0, 300),
    knobs,
    moves,
    notes
  };
}

// Note list -> flat worklet events [beat, midi, vel, flag]; flag bit 0 = on, bit 1 = via
// the arpeggiator. Offs sort before ons at a tie.
function pieceEvents(piece) {
  const ev = [];
  for (const [t, d, n, v, arp] of piece.notes) {
    const r = arp ? 2 : 0;
    ev.push([t, n, v, 1 | r]); ev.push([t + d, n, v, r]);
  }
  ev.sort((a, b) => a[0] - b[0] || (a[3] & 1) - (b[3] & 1));
  const flat = new Float64Array(ev.length * 4);
  ev.forEach((e, i) => { flat[i * 4] = e[0]; flat[i * 4 + 1] = e[1]; flat[i * 4 + 2] = e[2]; flat[i * 4 + 3] = e[3]; });
  return flat;
}

// Which knob settings a piece applies: its own, plus the switches those depend on
// (a send does nothing with its effect off). With `keep`, only arpeggiator knobs.
function pieceKnobTargets(piece, keep) {
  const k = Object.assign({}, piece.knobs || {});
  if (keep) for (const id of Object.keys(k)) if (!/^ARP_/.test(id)) delete k[id];
  const touched = (re) => Object.keys(k).some((id) => re.test(id)) || (!keep && (piece.moves || []).some((m) => re.test(m[1])));
  if (!keep) {
    if (touched(/^DLY_/) && k.DLY_SEND !== 0) k.DLY_ON = 1;
    if ('DLY_DIV' in k || (piece.moves || []).some((m) => m[1] === 'DLY_DIV')) k.DLY_SYNC = 1;
    if (touched(/^REV_/) && k.REV_SEND !== 0) k.REV_ON = 1;
    if (touched(/^CH_MIX$/) && k.CH_MIX !== 0) k.CH_ON = 1;
    if (touched(/^FLT_DRIVE$/) && !('FLT_SHAPER' in k) && values[PIDX.FLT_SHAPER] === 0) k.FLT_SHAPER = 1;
  }
  // A latched arp would keep playing after the piece; Claude's arp follows its held chords.
  if (k.ARP_ON === 1 || (piece.notes || []).some((x) => x[4])) { k.ARP_ON = 1; k.ARP_LATCH = 0; }
  return k;
}

class ClaudePlays {
  constructor(synth, ui, presets, keyboard, chords) {
    this.synth = synth; this.ui = ui; this.presets = presets; this.keyboard = keyboard; this.chords = chords;
    this.builtins = buildBuiltinPieces();
    this.recent = [];
    try { const r = JSON.parse(localStorage.getItem('synthcore_pieces') || '[]'); if (Array.isArray(r)) this.recent = r.filter((p) => p && Array.isArray(p.notes)).slice(0, 6); } catch (e) { this.recent = []; }
    this.piece = this.builtins[0];
    this.draft = null;
    this.playing = false;
    this.beat = 0;
    this.loop = false;
    this.ctl = null;
    this.busy = false;
    this.available = null;
    this.playToken = 0;
    this.auto = [];
    this.autoEls = [];
    this.touchedEls = [];
    this.touchTimer = 0;
    this.knobsFor = undefined;
    this.el = {
      form: $('#clForm'), prompt: $('#clPrompt'), go: $('#clGo'), chips: $('#clChips'), play: $('#clPlay'), loop: $('#clLoop'),
      keep: $('#clKeep'), pieces: $('#clPieces'), roll: $('#clRoll'), title: $('#clTitle'), meta: $('#clMeta'), note: $('#clNote'), status: $('#clStatus'),
      knobs: $('#clKnobs')
    };
    const c = this.el.roll;
    this.W = 960; this.H = 150;
    c.width = Math.round(this.W * DPR); c.height = Math.round(this.H * DPR);
    this.g = c.getContext('2d');
    this.g.setTransform(DPR, 0, 0, DPR, 0, 0);
    this.el.chips.innerHTML = CL_IDEAS.map((t, i) => `<button type="button" class="chip" data-i="${i}">${escapeHtml(t)}</button>`).join('');
    this.el.chips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      const t = CL_IDEAS[+b.dataset.i];
      this.el.prompt.value = t === 'Surprise me' ? '' : t;
      this.compose();
    });
    this.el.form.addEventListener('submit', (e) => { e.preventDefault(); if (this.busy) this.cancel(); else this.compose(); });
    this.el.play.addEventListener('click', () => (this.playing ? this.stop() : this.play(this.piece, true)));
    this.el.loop.addEventListener('click', () => {
      this.loop = !this.loop;
      this.el.loop.classList.toggle('on', this.loop);
      this.el.loop.setAttribute('aria-pressed', this.loop ? 'true' : 'false');
      this.synth.post({ type: 'seqloop', on: this.loop });
    });
    this.el.pieces.addEventListener('change', () => {
      const p = this.pieceFromValue(this.el.pieces.value);
      if (p) { this.piece = p; this.render(); this.play(p, true); }
    });
    // Stop the page's own keys from reaching the QWERTY synth while typing is handled by KeyboardHandler (it ignores INPUT targets).
    this.renderPieces();
    this.render();
    this.samplePromise = (window.claude && typeof window.claude.use === 'function')
      ? Promise.resolve(window.claude.use('sample')).catch(() => null)
      : Promise.resolve(null);
    this.samplePromise.then((s) => this.setAvailable(!!s));
  }
  setAvailable(ok) {
    this.available = ok;
    this.el.prompt.disabled = !ok;
    this.el.go.disabled = !ok;
    this.el.chips.hidden = !ok;
    if (!ok) {
      this.el.prompt.placeholder = 'Live composing works on the published page at claude.ai';
      this.status('Live composing needs this synth open as a published page on claude.ai. The pieces in the list were written by Claude while building it and play anywhere.', '');
    }
  }
  status(text, cls) {
    const s = this.el.status;
    s.textContent = text || '';
    s.className = 'cl-status' + (cls ? ' ' + cls : '');
  }
  pieceFromValue(v) {
    if (!v) return null;
    const [kind, i] = v.split(':');
    return kind === 'b' ? this.builtins[+i] : this.recent[+i];
  }
  renderPieces() {
    const sel = this.el.pieces;
    const opt = (v, t) => `<option value="${v}">${escapeHtml(t)}</option>`;
    let h = '<optgroup label="Written while building">' + this.builtins.map((p, i) => opt('b:' + i, p.title + ' · ' + p.sound)).join('') + '</optgroup>';
    if (this.recent.length) h += '<optgroup label="Composed for you">' + this.recent.map((p, i) => opt('r:' + i, p.title + (p.sound ? ' · ' + p.sound : ''))).join('') + '</optgroup>';
    sel.innerHTML = h;
    const bi = this.builtins.indexOf(this.piece), ri = this.recent.indexOf(this.piece);
    sel.value = bi >= 0 ? 'b:' + bi : (ri >= 0 ? 'r:' + ri : '');
  }
  addRecent(p) {
    this.recent.unshift(p);
    this.recent = this.recent.slice(0, 6);
    try { localStorage.setItem('synthcore_pieces', JSON.stringify(this.recent)); } catch (e) { /* kept for this visit */ }
    this.renderPieces();
  }
  async compose() {
    if (this.busy) return;
    const sample = await this.samplePromise;
    if (!sample) { this.setAvailable(false); return; }
    const request = this.el.prompt.value.trim() || 'Surprise me with something beautiful.';
    this.stop();
    const ctl = new AbortController();
    this.ctl = ctl;
    this.setBusy(true);
    this.status('Claude is thinking about the piece', 'thinking');
    this.draft = { title: 'Composing…', sound: '', bpm: 0, bars: 0, note: '', notes: [] };
    this.render();
    const keep = this.el.keep.checked;
    const current = this.el.keep.checked ? this.presets.nameEl.value : '';
    // Arpeggiated chords some of the time, always when asked for, never when asked not to.
    const useArp = /\b(no|without)\s+arp/i.test(request) ? false : (/arp/i.test(request) ? true : Math.random() < 0.4);
    const prompt = buildComposePrompt(request, keep, keep ? (FACTORY.find((f) => f.name === current) ? current : current || 'the current sound') : '', useArp);
    let lastDraw = 0;
    try {
      const { text, truncated } = await sample(prompt, {
        signal: ctl.signal,
        cache: false,
        onText: ({ text: t }) => {
          const now = performance.now();
          if (now - lastDraw < 120) return;
          lastDraw = now;
          const p = parsePiece(t, true);
          this.draft = finalizePiece(p, request);
          if (!p.header) this.draft.title = 'Composing…';
          this.render();
          this.status(`Claude is writing · ${this.draft.notes.length} notes so far`, 'thinking');
        }
      });
      const parsed = parsePiece(text, false);
      if (!parsed.header || parsed.notes.length < 4) throw { code: 'bad_format', text };
      const piece = finalizePiece(parsed, request);
      if (keep) piece.sound = '';
      this.draft = null;
      this.addRecent(piece);
      this.piece = piece;
      this.renderPieces();
      this.render();
      this.status(truncated ? 'Claude ran out of room, so the ending may be cut short.' : '', truncated ? 'warn' : '');
      await this.play(piece, true);
    } catch (e) {
      this.failed(e, request);
    } finally {
      if (this.ctl === ctl) this.ctl = null;
      this.setBusy(false);
    }
  }
  failed(e, request) {
    const code = e && e.code;
    this.draft = null;
    const partial = e && e.text ? parsePiece(e.text, false) : null;
    if (code !== 'bad_format' && code !== 'refused' && partial && partial.header && partial.notes.length >= 12) {
      const piece = finalizePiece(partial, request);
      piece.title += ' (unfinished)';
      this.piece = piece;
      this.render();
      this.status(code === 'cancelled' ? 'Stopped. Press Play to hear what Claude had written so far.' : 'The connection dropped part-way. Press Play to hear what Claude had written, or try again.', 'warn');
      return;
    }
    this.render();
    switch (code) {
      case 'cancelled': this.status('Stopped.', ''); break;
      case 'not_granted': case 'sampling_disabled': case 'not_declared': case 'capability_disabled': case 'capability_removed':
        this.setAvailable(false);
        this.status('Claude is not allowed to compose on this page for you. The pieces in the list still play.', 'warn');
        break;
      case 'rate_limited': this.status('Claude is busy or your usage limit was reached. Try again in a little while.', 'warn'); break;
      case 'session_expired': this.status('Your claude.ai session expired. Sign in again, then try again.', 'warn'); break;
      case 'refused': this.status('Claude declined that request. Try describing the music differently.', 'warn'); break;
      case 'bad_format': case 'empty_completion': case 'invalid_json':
        this.status('Claude answered, but not as playable notes. Try again.', 'warn'); break;
      default: this.status('Could not reach Claude just now. Try again.', 'warn');
    }
  }
  cancel() { if (this.ctl) this.ctl.abort(); }
  setBusy(b) {
    this.busy = b;
    this.el.go.textContent = b ? 'Stop' : 'Compose';
    this.el.go.classList.toggle('busy', b);
    this.el.prompt.disabled = b || this.available === false;
  }
  async play(piece, applySound) {
    if (!piece || !piece.notes.length) return;
    if (!this.synth.node && this.synth.booting) { try { await this.synth.booting; } catch (e) { return; } }
    if (!this.synth.node) return;
    const token = ++this.playToken;
    this.awaitStart = false;
    this.synth.post({ type: 'seqplay', on: false });
    this.playing = false;
    this.setupAuto(null);
    const keep = this.el.keep.checked;
    if (applySound && piece.sound && !keep) {
      const k = FACTORY.findIndex((f) => f.name === piece.sound);
      if (k >= 0) this.presets.loadFactory(k);
    }
    this.ui.set(PIDX.BPM, piece.bpm);
    if (this.chords.running) this.chords.setPlaying(false);
    this.piece = piece;
    this.render();
    // Claude turns the knobs in view first, then starts playing.
    const targets = pieceKnobTargets(piece, keep);
    if (Object.keys(targets).length) {
      this.status('Claude is setting up the synth', 'thinking');
      await this.turnKnobs(targets);
      if (token !== this.playToken) return;
      if (/setting up/.test(this.el.status.textContent)) this.status('', '');
    }
    this.setupAuto(keep ? (piece.moves || []).filter((m) => /^ARP_/.test(m[1])) : piece.moves);
    this.synth.post({ type: 'seq', events: pieceEvents(piece), len: piece.bars * 4 });
    this.synth.post({ type: 'seqplay', on: true, loop: this.loop });
    // A meter snapshot taken before the worklet handles 'seqplay' still says "stopped";
    // ignore those until the worklet reports the piece running.
    this.awaitStart = true;
    this.playing = true;
    this.beat = 0;
    this.render();
  }
  // Glides each continuous knob to its target (switches and options change at once).
  turnKnobs(t) {
    const ids = Object.keys(t).filter((id) => PIDX[id] !== undefined);
    this.touch(ids.filter((id) => id !== 'ARP_LATCH'));
    const cont = [];
    for (const id of ids) {
      const i = PIDX[id];
      if (PARAMS[i].kind === 'c') cont.push([i, values[i], t[id]]);
      else this.ui.set(i, t[id]);
    }
    if (!cont.length) return Promise.resolve();
    const T = 650, t0 = performance.now();
    return new Promise((res) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / T);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        for (const [i, a, b] of cont) {
          const p = PARAMS[i], na = toNorm(p, a), nb = toNorm(p, b);
          this.ui.set(i, k >= 1 ? b : fromNorm(p, na + (nb - na) * e));
        }
        if (k < 1) setTimeout(step, 16); else res();
      };
      step();
    });
  }
  ctlEls(i) { return (this.ui.ctls.get(i) || []).map((c) => c.el).filter(Boolean); }
  touch(ids) {
    clearTimeout(this.touchTimer);
    for (const el of this.touchedEls) el.classList.remove('cl-touch');
    this.touchedEls = [];
    for (const id of ids) for (const el of this.ctlEls(PIDX[id])) { el.classList.add('cl-touch'); this.touchedEls.push(el); }
    this.touchTimer = setTimeout(() => { for (const el of this.touchedEls) el.classList.remove('cl-touch'); this.touchedEls = []; }, 3500);
  }
  // Knob automation for the piece now playing: points per knob, applied from the playhead.
  setupAuto(moves) {
    for (const el of this.autoEls) el.classList.remove('cl-auto');
    this.autoEls = [];
    this.auto = [];
    if (!moves || !moves.length) return;
    const by = new Map();
    for (const [t, id, v] of moves) {
      if (PIDX[id] === undefined) continue;
      if (!by.has(id)) by.set(id, []);
      by.get(id).push([t, v]);
    }
    for (const [id, pts] of by) {
      const i = PIDX[id], p = PARAMS[i];
      pts.sort((a, b) => a[0] - b[0]);
      this.auto.push({ i, p, cont: p.kind === 'c', start: values[i], pts, last: NaN });
      for (const el of this.ctlEls(i)) { el.classList.add('cl-auto'); this.autoEls.push(el); }
    }
  }
  autoAt(a, beat) {
    let prevT = 0, prevV = a.start;
    for (const [t, v] of a.pts) {
      if (beat < t) {
        if (!a.cont) return prevV;
        const k = t > prevT ? (beat - prevT) / (t - prevT) : 1;
        const n0 = toNorm(a.p, prevV), n1 = toNorm(a.p, v);
        return fromNorm(a.p, n0 + (n1 - n0) * k);
      }
      prevT = t; prevV = v;
    }
    return prevV;
  }
  runAuto() {
    for (const a of this.auto) {
      const v = this.autoAt(a, this.beat);
      if (!(Math.abs(v - a.last) < 1e-9)) { a.last = v; this.ui.set(a.i, v); }
    }
  }
  stop() {
    this.playToken++;
    this.awaitStart = false;
    this.synth.post({ type: 'seqplay', on: false });
    this.playing = false;
    this.setupAuto(null);
    this.keyboard.mark('seq', null);
    this.render();
  }
  onMeter(m) {
    if (typeof m.seqRun !== 'boolean') return;
    if (this.awaitStart) { if (!m.seqRun) return; this.awaitStart = false; }
    const was = this.playing;
    this.playing = m.seqRun;
    this.beat = m.seqBeat || 0;
    if (this.playing && this.auto.length) this.runAuto();
    if (was && !this.playing) this.setupAuto(null);
    if (this.playing || was) {
      const now = [];
      if (this.playing && this.piece) for (const [t, d, n] of this.piece.notes) if (t <= this.beat && this.beat < t + d) now.push(n);
      this.keyboard.mark('seq', now);
      this.render();
    }
  }
  render() {
    const p = this.draft || this.piece;
    const e = this.el;
    e.play.textContent = this.playing ? '■ Stop' : '▶ Play';
    e.play.classList.toggle('on', this.playing);
    e.play.disabled = !this.piece || this.busy;
    if (p) {
      e.title.textContent = p.title;
      const bits = [];
      if (p.sound) bits.push(p.sound);
      if (p.bpm) bits.push(p.bpm + ' BPM');
      if (p.bars) bits.push(p.bars + ' bars');
      bits.push(p.notes.length + ' notes');
      if (this.playing && !this.draft) bits.push(`bar ${Math.floor(this.beat / 4) + 1}`);
      e.meta.textContent = bits.join(' · ');
      e.note.textContent = p.note ? (p.builtin ? 'Claude’s note: ' : '') + p.note : '';
    }
    this.renderKnobs(p);
    this.drawRoll(p);
  }
  renderKnobs(p) {
    if (p === this.knobsFor && !this.draft) return;
    this.knobsFor = p;
    const el = this.el.knobs;
    const ks = p && p.knobs ? Object.keys(p.knobs).filter((id) => CL_KNOB_NAME[id]) : [];
    const moves = p && p.moves ? p.moves : [];
    const autoIds = [...new Set(moves.map((m) => m[1]))].filter((id) => CL_KNOB_NAME[id]);
    let h = '';
    const val = (id, v) => escapeHtml(fmt(PARAMS[PIDX[id]], v));
    if (ks.length) h += '<span class="h">Claude set</span>' + ks.map((id) => `<span class="k">${escapeHtml(CL_KNOB_NAME[id])} <i>${val(id, p.knobs[id])}</i></span>`).join('');
    if (autoIds.length) {
      h += `<span class="h">${ks.length ? 'and moves' : 'Claude moves'}</span>` + autoIds.map((id) => {
        const pts = moves.filter((m) => m[1] === id);
        return `<span class="k auto" title="${pts.map((m) => 'beat ' + m[0] + ': ' + fmt(PARAMS[PIDX[id]], m[2])).join(' · ')}">${escapeHtml(CL_KNOB_NAME[id])} <i>→ ${val(id, pts[pts.length - 1][2])}</i> · ${pts.length} pt${pts.length > 1 ? 's' : ''}</span>`;
      }).join('');
    }
    el.innerHTML = h;
  }
  drawRoll(p) {
    const g = this.g, W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);
    if (!p || !p.notes.length) {
      g.fillStyle = CSSV.muted;
      g.font = `600 11px ${getComputedStyle(document.body).getPropertyValue('--mono')}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(this.busy ? 'CLAUDE IS THINKING…' : 'ASK CLAUDE FOR A PIECE', W / 2, H / 2);
      g.textAlign = 'start';
      return;
    }
    let lo = 127, hi = 0, end = 0;
    for (const [t, d, n] of p.notes) { if (n < lo) lo = n; if (n > hi) hi = n; if (t + d > end) end = t + d; }
    lo -= 2; hi += 2;
    const beats = Math.max(16, (p.bars || Math.ceil(end / 4)) * 4, Math.ceil(end / 4) * 4);
    const padL = 28, padR = 6, padY = 6;
    const xOf = (b) => padL + (b / beats) * (W - padL - padR);
    const rowH = (H - padY * 2) / (hi - lo + 1);
    const yOf = (n) => padY + (hi - n) * rowH;
    g.lineWidth = 1;
    for (let b = 0; b <= beats; b++) {
      g.strokeStyle = b % 4 === 0 ? 'rgba(61,255,110,0.16)' : 'rgba(61,255,110,0.05)';
      const x = Math.round(xOf(b)) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    for (let n = Math.ceil(lo / 12) * 12; n <= hi; n += 12) {
      const y = Math.round(yOf(n) + rowH) + 0.5;
      g.strokeStyle = 'rgba(61,255,110,0.12)';
      g.beginPath(); g.moveTo(padL, y); g.lineTo(W, y); g.stroke();
      g.fillStyle = CSSV.muted;
      g.font = `9px ${getComputedStyle(document.body).getPropertyValue('--mono')}`;
      g.textBaseline = 'middle';
      g.fillText(noteName(n), 2, yOf(n) + rowH / 2);
    }
    const playing = this.playing && !this.draft;
    for (const [t, d, n, v, arp] of p.notes) {
      const x0 = xOf(t), x1 = Math.max(x0 + 1.5, xOf(t + d) - 0.5), y = yOf(n);
      const on = playing && t <= this.beat && this.beat < t + d;
      const hgt = Math.max(1.5, rowH - 1);
      if (arp) {
        // Chord tones handed to the arpeggiator: amber outline, the arp plays inside it.
        g.fillStyle = on ? 'rgba(255,176,0,0.4)' : 'rgba(255,176,0,0.14)';
        g.fillRect(x0, y + 0.5, x1 - x0, hgt);
        g.strokeStyle = on ? 'rgba(255,220,150,0.95)' : 'rgba(255,176,0,0.65)';
        g.lineWidth = 1;
        g.strokeRect(x0 + 0.5, y + 1, x1 - x0 - 1, Math.max(0.5, hgt - 1));
        continue;
      }
      g.fillStyle = on ? 'rgba(210,255,220,0.95)' : `rgba(61,255,110,${(0.3 + 0.6 * v / 127).toFixed(3)})`;
      if (on) { g.shadowColor = CSSV.env; g.shadowBlur = 8; }
      g.fillRect(x0, y + 0.5, x1 - x0, hgt);
      g.shadowBlur = 0;
    }
    if (playing) {
      const x = xOf(this.beat);
      g.strokeStyle = CSSV.active; g.lineWidth = 1.5; g.shadowColor = CSSV.env; g.shadowBlur = 8;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      g.shadowBlur = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Pieces Claude wrote while building SYNTHCORE, so "Claude plays" has music
// even where live composing is unavailable. Same format Claude returns live:
// notes are [start beat, duration beats, midi, velocity].
function buildBuiltinPieces() {
  const out = [];
  // Rain on the Window: a slow jazz ballad for Tape Rhodes.
  {
    const notes = [];
    const bars = [
      // [left hand], [right-hand chord]
      [[38, 48], [53, 57, 64]],        // Dm9
      [[43, 53], [59, 64, 69]],        // G13
      [[48, 59], [64, 67, 74]],        // Cmaj9
      [[45, 55], [61, 65, 70]],        // A7(b9 b13)
      [[38, 48], [53, 57, 64]],        // Dm9
      [[43, 53], [59, 64, 69]],        // G13
      [[46, 57], [62, 64, 69]],        // Bbmaj7(#11)
      [[45, 55], [62, 67, 71]]         // A13sus
    ];
    bars.forEach(([lh, rh], b) => {
      const t = b * 4;
      lh.forEach((n, i) => notes.push([t, 3.8, n, i ? 62 : 72]));
      rh.forEach((n) => notes.push([t, 1.4, n, 56]));
      rh.forEach((n) => notes.push([t + 2.5, 1.3, n, 50]));
    });
    const mel = [
      [0, 1, 69, 84], [1, 0.5, 72, 78], [1.5, 0.5, 74, 82], [2, 1.5, 76, 92], [3.5, 0.5, 74, 76],
      [4, 1, 76, 88], [5, 0.5, 74, 76], [5.5, 1.5, 71, 84], [7, 1, 69, 72],
      [8, 0.5, 67, 78], [8.5, 0.5, 71, 80], [9, 1, 74, 86], [10, 1.5, 76, 94], [11.5, 0.5, 74, 74],
      [12, 1, 73, 88], [13, 0.5, 76, 80], [13.5, 1, 77, 92], [14.5, 0.5, 76, 78], [15, 1, 73, 84],
      [16, 1.5, 74, 90], [17.5, 0.5, 77, 80], [18, 1, 81, 98], [19, 0.5, 79, 84], [19.5, 0.5, 77, 76],
      [20, 1.5, 76, 90], [21.5, 0.5, 74, 76], [22, 1, 71, 82], [23, 1, 69, 74],
      [24, 0.5, 69, 72], [24.5, 0.5, 74, 80], [25, 2, 76, 92], [27, 1, 77, 80],
      [28, 1, 76, 86], [29, 0.5, 74, 78], [29.5, 0.5, 73, 82], [30, 1, 71, 78], [31, 1, 69, 74]
    ];
    mel.forEach((m) => notes.push(m));
    [[38, 72], [48, 62], [53, 54], [57, 54], [64, 54], [74, 80]].forEach(([n, v]) => notes.push([32, 5, n, v]));
    out.push({ title: 'Rain on the Window', sound: 'Tape Rhodes', bpm: 72, bars: 9, builtin: true,
      note: 'A slow ballad in D minor that leans on G13 and a Lydian Bb before sighing back home.', notes });
  }
  // Cloud Drift: slow pad chords with a sparse melody floating above.
  {
    const notes = [];
    const chords = [
      [45, 55, 60, 62],   // Am11
      [41, 52, 55, 57],   // Fmaj9
      [48, 55, 59, 62],   // Cmaj9
      [40, 55, 57, 62],   // Em11
      [38, 53, 55, 60],   // Dm11
      [41, 52, 57, 59],   // Fmaj7(#11)
      [43, 55, 59, 62],   // Cmaj9/G
      [45, 55, 60, 64]    // Am11
    ];
    chords.forEach((c, b) => c.forEach((n, i) => notes.push([b * 4, b === 7 ? 6 : 4, n, i ? 74 : 82])));
    [[1, 2, 76, 86], [3, 1, 74, 78], [4.5, 2.5, 72, 84], [8, 1, 71, 80], [9, 3, 74, 88], [12.5, 1.5, 71, 78],
      [14, 2, 69, 82], [16.5, 2, 77, 88], [19, 1, 79, 84], [20, 1.5, 76, 86], [21.5, 2.5, 71, 80],
      [24, 3.5, 74, 88], [28, 5, 76, 84]].forEach((m) => notes.push(m));
    out.push({ title: 'Cloud Drift', sound: 'Cloud Nine', bpm: 64, bars: 9, builtin: true,
      note: 'Minor-eleventh clouds in A with a melody that never quite lands until the last bar.', notes });
  }
  // Starfield Lullaby: held chords go to the arpeggiator (the fifth field, 1 = via arp)
  // while the melody and bass play directly; the filter opens across the first half
  // and the reverb swells into the ending.
  {
    const notes = [];
    const arpChords = [
      [57, 60, 64, 67, 71],   // Am9
      [57, 60, 64, 71],       // Fmaj7#11 (over F)
      [55, 59, 62, 64],       // Cmaj9 (over C)
      [52, 55, 59, 62],       // Em7
      [53, 57, 60, 64],       // Dm9 (over D)
      [57, 60, 64, 67],       // Fmaj9 (over F)
      [56, 59, 62, 64],       // E7sus → E7
      [57, 60, 64, 71]        // Am(add9)
    ];
    const bass = [45, 41, 48, 40, 38, 41, 40, 45];
    arpChords.forEach((c, b) => c.forEach((n) => notes.push([b * 4, b === 7 ? 6 : 4, n, 78, 1])));
    bass.forEach((n, b) => notes.push([b * 4, b === 7 ? 6 : 3.9, n, 72, 0]));
    [[2, 2, 76, 74], [4, 1.5, 81, 82], [5.5, 0.5, 79, 66], [6, 2, 77, 72], [8, 3, 76, 78],
      [12, 1, 74, 70], [13, 1, 71, 68], [14, 2, 74, 74], [16, 2, 77, 84], [18, 1, 76, 74], [19, 1, 74, 70],
      [20, 3, 72, 78], [23, 1, 76, 72], [24, 2, 76, 86], [26, 1.5, 74, 76], [27.5, 0.5, 71, 66], [28, 6, 69, 80]]
      .forEach(([t, d, n, v]) => notes.push([t, d, n, v, 0]));
    notes.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    out.push({ title: 'Starfield Lullaby', sound: 'Starfield Arp', bpm: 92, bars: 9, builtin: true,
      note: 'The arpeggiator spins each chord into triplet starlight while I sing a slow line over it, opening the filter as it climbs and letting the reverb take the last bar.',
      knobs: { ARP_ON: 1, ARP_MODE: 2, ARP_DIV: SUBDIV_INDEX['1/16T'], ARP_OCT: 2, ARP_GATE: 0.35, FLT_CUTOFF: 1400, REV_SEND: 0.5, DLY_SEND: 0.3 },
      moves: [[0, 'FLT_CUTOFF', 1400], [16, 'FLT_CUTOFF', 4200], [26, 'FLT_CUTOFF', 2400], [34, 'FLT_CUTOFF', 1600],
        [20, 'REV_SEND', 0.5], [32, 'REV_SEND', 0.85], [24, 'ARP_MODE', 0]],
      notes });
  }
  return out;
}

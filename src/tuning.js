// tuning.js — the row/degree -> pitch seam.
//
// A "degree" is a step in the current tuning. Stage 1 tunings stay on the
// familiar 12-degrees-per-octave grid (so the grid, tools and Triadulator are
// unchanged) but can *retune* those 12 degrees: 12-ET, or 5-limit just
// intonation. `tuningFreq(degree, tuningId, root)` is the per-pattern resolver —
// just tunings are reckoned from the pattern's `root` so the root note stays at
// its 12-ET pitch and the others bend to pure ratios. True size != 12 scales
// (no octave, lattices) come later and will widen this seam further.

import { noteToFreq, noteName } from './model.js';

export const DEGREES_PER_OCTAVE = 12;

// A 5-limit just chromatic scale (ratios from the root, one per pitch-class).
// The C-D-E-G-A subset is exactly the just major pentatonic.
const JI_5LIMIT = [1 / 1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8];

// freq(degree, root) for each tuning. 12-ET ignores root; just intonation anchors
// each octave's ratios on the root pitch's 12-ET frequency (so root notes don't
// move when you switch tuning, and the just intervals fan out from there).
const TUNINGS = {
  '12-et': {
    id: '12-et',
    label: '12-ET',
    freq: (degree) => noteToFreq(degree),
  },
  'ji-5limit': {
    id: 'ji-5limit',
    label: 'Just (5-limit)',
    freq: (degree, root) => {
      const rel = (((degree - root) % 12) + 12) % 12;     // semitones above the root pc below
      return noteToFreq(degree - rel) * JI_5LIMIT[rel];   // that root's 12-ET freq × just ratio
    },
  },
};

export const TUNING_LIST = Object.values(TUNINGS).map((t) => ({ id: t.id, label: t.label }));

// Per-pattern resolver: a degree's frequency in a given tuning, rooted as given.
export function tuningFreq(degree, tuningId = '12-et', root = 0) {
  return (TUNINGS[tuningId] || TUNINGS['12-et']).freq(degree, root);
}

// The default (12-ET) seam — kept so the audio fallback and any caller without a
// tuning context still works exactly as before.
export const degreeToFreq = (degree) => noteToFreq(degree);
export const degreeToName = (degree) => noteName(degree);

// tuning.js — the row/degree -> pitch seam.
//
// A "degree" is a step in the current tuning. Stage 1 tunings stay on the
// familiar 12-degrees-per-octave grid (so the grid, tools and Triadulator are
// unchanged) but can *retune* those 12 degrees: 12-ET, or 5-limit just
// intonation. `tuningFreq(degree, tuningId, root)` is the per-pattern resolver —
// just tunings are reckoned from the pattern's `root` so the root note stays at
// its 12-ET pitch and the others bend to pure ratios. True size != 12 scales
// (no octave, lattices) come later and will widen this seam further.

import { noteToFreq, noteName, pitchClassName as letterClassName } from './model.js';

const HEX = '0123456789abcdef';

// Degrees per octave (the EDO) is now a property of the TUNING, not a global
// constant — the seam that lets non-12 tunings (16-ET, …) coexist with 12-ET. Read
// it per pattern via edoOf(pattern.tuningId); the pitch-class logic (scales, triads,
// the grid's octave math) takes it as a parameter rather than assuming 12.

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
    edo: 12,
    freq: (degree) => noteToFreq(degree),
  },
  'ji-5limit': {
    id: 'ji-5limit',
    label: 'Just (5-limit)',
    edo: 12, // a 12-degree just chromatic — still 12 pitch-classes per octave
    freq: (degree, root) => {
      const rel = (((degree - root) % 12) + 12) % 12;     // semitones above the root pc below
      return noteToFreq(degree - rel) * JI_5LIMIT[rel];   // that root's 12-ET freq × just ratio
    },
  },
  // 16-tone equal temperament: a xenharmonic octave division (steps of 75¢). No
  // good fifth, but an exact tritone and a strong 7/4 (see project notes). Anchored
  // so degree 60 still sounds at middle C — switching a pattern to 16-ET keeps its
  // home note's pitch; the octave is 16 degrees, named in hex (0–f).
  '16-et': {
    id: '16-et',
    label: '16-ET',
    edo: 16,
    freq: (degree) => noteToFreq(60) * Math.pow(2, (degree - 60) / 16),
  },
};

export const TUNING_LIST = Object.values(TUNINGS).map((t) => ({ id: t.id, label: t.label }));

// Per-pattern resolver: a degree's frequency in a given tuning, rooted as given.
export function tuningFreq(degree, tuningId = '12-et', root = 0) {
  return (TUNINGS[tuningId] || TUNINGS['12-et']).freq(degree, root);
}

// Degrees per octave for a tuning (the EDO / equave division). The modulus the
// pitch-class logic uses; defaults to 12 for an unknown tuning.
export function edoOf(tuningId = '12-et') {
  return (TUNINGS[tuningId] || TUNINGS['12-et']).edo;
}

// The default (12-ET) seam — kept so the audio fallback and any caller without a
// tuning context still works exactly as before.
export const degreeToFreq = (degree) => noteToFreq(degree);

// A pitch-class's name in a tuning: 12-ET uses letters (C, C#, …); non-12 tunings
// have no letter names, so a hex digit of the class index (0–f for 16-ET). pc is
// taken mod the tuning's EDO.
export function pitchClassName(pc, tuningId = '12-et') {
  const edo = edoOf(tuningId);
  const i = (((pc % edo) + edo) % edo);
  if (edo === 12) return letterClassName(i);
  return i < 16 ? HEX[i] : String(i);
}

// A degree's full name (class + octave) in a tuning. 12-ET = the MIDI note name
// (unchanged); non-12 = hex class + octave (class = degree mod edo, octave =
// floor(degree / edo)). Used for the grid's row labels.
export function degreeToName(degree, tuningId = '12-et') {
  const edo = edoOf(tuningId);
  if (edo === 12) return noteName(degree);
  const cls = (((degree % edo) + edo) % edo);
  return `${pitchClassName(cls, tuningId)}${Math.floor(degree / edo)}`;
}

// The navigable pitch range as a frequency band — the 88-key piano, A0 (27.5 Hz)
// to C8. Anchored at A0 so the grid always covers a real keyboard, in any tuning.
export const LOW_HZ = 27.5;             // A0
export const HIGH_HZ = noteToFreq(108); // C8 (≈ 4186 Hz)

// The degree range { min, max } for a tuning that best covers A0..C8 — the degree
// CLOSEST (in pitch, i.e. log-frequency) to each band edge, so a degree a cent
// under A0 (e.g. 16-ET's "80") still counts rather than being rounded away. freq
// is monotonic in degree, so a scan over a generous degree window finds the
// nearest; this needs no per-tuning inverse, so future (even non-EDO) tunings
// work for free. Memoized per tuning+root (the grid asks for it on every draw).
const _boundsCache = new Map();
export function degreeBounds(tuningId = '12-et', root = 0) {
  const key = `${tuningId}:${root}`;
  const hit = _boundsCache.get(key);
  if (hit) return hit;
  const nearest = (targetHz) => {
    let best = 0, bestErr = Infinity;
    for (let d = -200; d <= 400; d++) {
      const err = Math.abs(Math.log2(tuningFreq(d, tuningId, root) / targetHz));
      if (err < bestErr) { bestErr = err; best = d; }
    }
    return best;
  };
  const res = { min: nearest(LOW_HZ), max: nearest(HIGH_HZ) };
  _boundsCache.set(key, res);
  return res;
}

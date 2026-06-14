// tuning.js — the row/degree -> pitch seam.
//
// A "degree" is a step in the current tuning. Today a degree is just a MIDI
// note number (12-tone equal temperament), so these are thin wrappers. When we
// add microtones or non-12 scales later, this is the ONE place that changes —
// the pitch analogue of the beats->seconds seam in the model.

import { noteToFreq, noteName } from './model.js';

export const DEGREES_PER_OCTAVE = 12;

export const degreeToFreq = (degree) => noteToFreq(degree);
export const degreeToName = (degree) => noteName(degree);

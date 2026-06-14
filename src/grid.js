// grid.js — the looping grid pattern model (mono mode).
//
// Twelve columns laid left-to-right in time. Each column holds exactly one
// thing: a note (a pitch "degree", optionally accented) or a rest (a cosmetic
// placeholder that still consumes its duration). Pitch is stored as an absolute
// degree (see tuning.js), NOT a screen row, so resizing/scrolling the visible
// range never loses notes.

import { Note, Score } from './model.js';

export const COLS = 12;
export const BASE_PITCH = 60; // C4 — where the default viewport sits

// The four note lengths, as eighth-note multiples. 3/8 is a dotted quarter.
export const DURATIONS = [
  { name: '1/8', beats: 0.5 },
  { name: '1/4', beats: 1.0 },
  { name: '3/8', beats: 1.5 },
  { name: '1/2', beats: 2.0 },
];
export const DEFAULT_DUR = 1; // index of 1/4

// Warm, soothing palette — one color per duration, deepening as notes lengthen.
// bisque, burlywood (the favourites), then a caramel tan and a rosy brown.
export const PALETTE = ['#FFE4C4', '#DEB887', '#C9A06A', '#B08968'];

const NORMAL_VELOCITY = 0.78;
const ACCENT_VELOCITY = 1.0;

// A column: { durIndex, isRest, degree, accent }. `degree` is the note's pitch
// when it's a note, or the (cosmetic) circle position when it's a rest.
// A pattern also carries a stable `name` (its key in the registry).
export class Pattern {
  constructor(columns, name = 'A') {
    this.columns = columns;
    this.name = name;
  }

  // A blank pattern: twelve quarter-rests climbing the diagonal (col i one
  // degree higher), C4 up to B4 — looks good, and reads as empty (no notes).
  static initial(name = 'A') {
    const cols = [];
    for (let i = 0; i < COLS; i++) {
      cols.push({ durIndex: DEFAULT_DUR, isRest: true, degree: BASE_PITCH + i, accent: false });
    }
    return new Pattern(cols, name);
  }

  // No notes (rests only) — used to decide whether a floating pattern is worth
  // keeping (parking) or can just evaporate.
  isEmpty() {
    return this.columns.every((c) => c.isRest);
  }

  // An independent deep copy under a new name (the Clone action).
  clone(name) {
    return new Pattern(this.columns.map((c) => ({ ...c })), name);
  }

  // Walk the columns left to right, accumulating time; notes emit events, rests
  // only advance the clock. The returned Score's length includes trailing rests.
  toScore(bpm, articulation) {
    const notes = [];
    let t = 0;
    for (const c of this.columns) {
      const beats = DURATIONS[c.durIndex].beats;
      if (!c.isRest) {
        const vel = c.accent ? ACCENT_VELOCITY : NORMAL_VELOCITY;
        notes.push(new Note(c.degree, t, beats, vel));
      }
      t += beats;
    }
    return new Score(notes, bpm, articulation, t);
  }

  // Compact array form for localStorage: [durIndex, degree, isRest, accent].
  toJSON() {
    return this.columns.map((c) => [c.durIndex, c.degree, c.isRest ? 1 : 0, c.accent ? 1 : 0]);
  }

  static fromJSON(arr, name = 'A') {
    return new Pattern(
      arr.map(([durIndex, degree, isRest, accent]) => ({
        durIndex,
        degree,
        isRest: !!isRest,
        accent: !!accent,
      })),
      name,
    );
  }
}

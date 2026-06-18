// grid.js — the looping grid pattern model (mono mode).
//
// Twelve columns laid left-to-right in time. Each column holds exactly one
// thing: a note (a pitch "degree", optionally accented) or a rest (a cosmetic
// placeholder that still consumes its duration). Pitch is stored as an absolute
// degree (see tuning.js), NOT a screen row, so resizing/scrolling the visible
// range never loses notes.

import { Note, Score } from './model.js';
import { tuningFreq } from './tuning.js';

export const COLS = 12;
export const BASE_PITCH = 60; // C4 — where the default viewport sits

// Note lengths, in beats. 3/8 is a dotted quarter, 3/16 a dotted eighth. 1/16 and
// 3/16 are appended (not inserted in order) so existing stored `durIndex` values
// stay valid — display/rotation order is handled separately via DUR_ORDER.
export const DURATIONS = [
  { name: '1/8', beats: 0.5 },
  { name: '1/4', beats: 1.0 },
  { name: '3/8', beats: 1.5 },
  { name: '1/2', beats: 2.0 },
  { name: '1/16', beats: 0.25 },
  { name: '3/16', beats: 0.75 },
];
export const DEFAULT_DUR = 1; // index of 1/4

// Duration indices in ascending-beats order — the order swatches show and the
// brush rotates through, independent of the storage order above.
export const DUR_ORDER = DURATIONS.map((_, i) => i).sort((a, b) => DURATIONS[a].beats - DURATIONS[b].beats);
export function nextDurIndex(durIndex) {
  const pos = DUR_ORDER.indexOf(durIndex);
  return DUR_ORDER[(pos + 1) % DUR_ORDER.length];
}

// Duration -> color: a chilled (slightly desaturated) spectrum, red 1/16 →
// yellow 1/8 → green 1/4 → blue 1/2 → violet whole, interpolated in log-duration
// space so note-value doublings are evenly spaced (3/8 lands green→blue, etc.).
const SPECTRUM = [
  [224, 150, 150], // 1/16  red
  [222, 210, 140], // 1/8   yellow
  [150, 205, 155], // 1/4   green
  [140, 175, 220], // 1/2   blue
  [190, 158, 212], // 1     violet
];
export function durationColor(beats) {
  const t = Math.max(0, Math.min(4, Math.log2(beats) + 2)); // 1/16→0 … whole→4
  const i = Math.min(3, Math.floor(t));
  const f = t - i;
  const a = SPECTRUM[i], b = SPECTRUM[i + 1];
  const ch = (k) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}
export const PALETTE = DURATIONS.map((d) => durationColor(d.beats));

const NORMAL_VELOCITY = 0.78;
const ACCENT_VELOCITY = 1.0;

// A column: { durIndex, isRest, degree, accent }. `degree` is the note's pitch
// when it's a note, or the (cosmetic) circle position when it's a rest.
// A pattern also carries a stable `name` (its key in the registry).
export class Pattern {
  constructor(columns, name = 'A') {
    this.columns = columns;
    this.name = name;
    // Pitch context (Stage 1: all on the 12-degree grid). tuningId = how degrees
    // sound; scaleId + root = which degrees are "in scale" (highlight + snap).
    this.tuningId = '12-et';
    this.scaleId = 'chromatic';
    this.root = 0;
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

  // An independent deep copy under a new name (the Clone action). Pitch context
  // travels with the copy.
  clone(name) {
    const p = new Pattern(this.columns.map((c) => ({ ...c })), name);
    p.tuningId = this.tuningId;
    p.scaleId = this.scaleId;
    p.root = this.root;
    return p;
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
        const n = new Note(c.degree, t, beats, vel);
        n.freq = tuningFreq(c.degree, this.tuningId, this.root); // resolve in this pattern's tuning
        notes.push(n);
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

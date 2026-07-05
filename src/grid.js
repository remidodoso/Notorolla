// grid.js — the looping grid pattern model (mono mode).
//
// Columns laid left-to-right in time. Each column holds exactly one thing: a note
// (a pitch "degree", optionally accented) or a rest (a cosmetic placeholder that
// still consumes its duration). Pitch is stored as an absolute degree (see
// tuning.js), NOT a screen row, so resizing/scrolling the visible range never loses
// notes. The COLUMN COUNT is per-pattern (= columns.length, persisted with the
// pattern); a fresh pattern starts with DEFAULT_COLS and can be resized in [MIN,MAX].

import { Note, Score } from './model.js';
import { tuningFreq } from './tuning.js';

export const DEFAULT_COLS = 12; // columns a fresh pattern starts with
export const MIN_COLS = 1;
export const MAX_COLS = 48;
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
// Display label for a stored durIndex (the footer's numeric backup to color).
export function durationLabel(durIndex) {
  const d = DURATIONS[durIndex];
  return d ? d.name : '';
}

// The two grid-editor drag surfaces, as pure in-place ops on a columns array.
// The column SLOT owns the groove attributes (duration, accent, …); the note is
// just its PITCH. So the two drags differ in what rides along:
//   swapNotePayload — exchange only the pitch (degree + isRest); duration and accent
//     STAY with each slot (dragging a note in the grid body — the groove holds still).
//   swapColumn      — exchange the whole column, groove included (dragging a footer
//     chit = the "grab the whole column" handle).
export function swapNotePayload(cols, a, b) {
  if (a === b) return;
  const ca = cols[a], cb = cols[b];
  const d = ca.degree, r = ca.isRest;
  ca.degree = cb.degree; ca.isRest = cb.isRest;
  cb.degree = d; cb.isRest = r;
}
export function swapColumn(cols, a, b) {
  if (a === b) return;
  const t = cols[a]; cols[a] = cols[b]; cols[b] = t;
}

// The performance lanes as sets of column fields — the "attribute rack". Each lane
// owns one facet of a column; `notes` is the pitch content (degree + rest-ness).
// swapLanes exchanges only the chosen lanes between two columns, so it spans the
// whole range from a single-attribute swap up to the full-column swap:
//   swapLanes(cols,a,b,['notes'])                    === swapNotePayload
//   swapLanes(cols,a,b,['notes','duration','accent','articulation']) === swapColumn
// The armed-lane footer drag passes whichever subset the user armed.
export const LANE_FIELDS = {
  notes: ['degree', 'isRest'],
  duration: ['durIndex'],
  accent: ['accent'],
  articulation: ['artic'],
};
export function swapLanes(cols, a, b, laneIds) {
  if (a === b) return;
  const ca = cols[a], cb = cols[b];
  for (const lane of laneIds) {
    for (const f of LANE_FIELDS[lane] || []) {
      const t = ca[f]; ca[f] = cb[f]; cb[f] = t;
    }
  }
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

// Stretch-view column width: a LOG-compressed map of a duration into [minW, maxW]
// — like music engraving, where horizontal space grows with the note value but
// *gently*, not linearly. Decoupled from the piano roll (that alignment no longer
// matters). Shortest duration → minW, longest → maxW, the rest log-spaced.
const STRETCH_LOG_MIN = Math.log2(Math.min(...DURATIONS.map((d) => d.beats)));
const STRETCH_LOG_MAX = Math.log2(Math.max(...DURATIONS.map((d) => d.beats)));
export function stretchWidth(durIndex, minW, maxW) {
  const d = DURATIONS[durIndex];
  const b = d ? d.beats : 1;
  const t = STRETCH_LOG_MAX > STRETCH_LOG_MIN
    ? (Math.log2(b) - STRETCH_LOG_MIN) / (STRETCH_LOG_MAX - STRETCH_LOG_MIN)
    : 0.5;
  return minW + (maxW - minW) * t;
}

// Accent LEVEL per column (a groove attribute): 0 = normal, 1 = accent, 2 = ghost.
// Each maps to a play velocity (ghost is softer than normal). Click cycles them.
const NORMAL_VELOCITY = 0.78;
const ACCENT_VELOCITY = 1.0;
const GHOST_VELOCITY = 0.45;
export const ACCENT_LEVELS = 3;
export function accentVelocity(level) {
  return level === 1 ? ACCENT_VELOCITY : level === 2 ? GHOST_VELOCITY : NORMAL_VELOCITY;
}
export function nextAccent(level) { return (((level | 0) + 1) % ACCENT_LEVELS); }

// Articulation preset per column (a groove attribute): how long the note SOUNDS
// relative to its slot. Most are a fraction of the column duration; SPICCATO is an
// absolute short gate (~55 ms) independent of tempo/duration. Ordered short→long;
// click cycles them. Stored as an index; `normal` is the current non-legato default.
export const ARTICULATIONS = [
  { id: 'spiccato', label: 'spic', abs: 0.055 },  // ~55 ms, not tied to duration
  { id: 'staccato', label: 'stac', gate: 0.5 },
  { id: 'normal',   label: 'norm', gate: 0.88 },
  { id: 'legato',   label: 'leg',  gate: 1.0 },
  { id: 'tenuto',   label: 'ten',  gate: 1.15 },  // > 1 → rings slightly into the next slot
];
export const DEFAULT_ARTIC = 2; // 'normal'
export function nextArtic(i) { return (((i | 0) + 1) % ARTICULATIONS.length); }
// Sounded length in BEATS: beats × gate, or spiccato's absolute gate converted to
// beats (via `spb` = seconds/beat) and capped at the slot so it never over-runs.
export function articBeats(articIdx, beats, spb) {
  const a = ARTICULATIONS[articIdx] || ARTICULATIONS[DEFAULT_ARTIC];
  return a.abs != null ? Math.min(a.abs / spb, beats) : beats * a.gate;
}

// A column: { durIndex, isRest, degree, accent }. `accent` is the level above.
// `degree` is the note's pitch when it's a note, or the (cosmetic) circle position
// when it's a rest.
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

  // A blank pattern: `cols` quarter-rests climbing the diagonal (col i one degree
  // higher) from C4 — looks good, and reads as empty (no notes).
  static initial(name = 'A', cols = DEFAULT_COLS) {
    const out = [];
    for (let i = 0; i < cols; i++) {
      out.push({ durIndex: DEFAULT_DUR, isRest: true, degree: BASE_PITCH + i, accent: 0, artic: DEFAULT_ARTIC });
    }
    return new Pattern(out, name);
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
    const spb = 60 / bpm;
    let t = 0;
    for (const c of this.columns) {
      const beats = DURATIONS[c.durIndex].beats;
      if (!c.isRest) {
        const vel = accentVelocity(c.accent);
        const n = new Note(c.degree, t, beats, vel);
        n.freq = tuningFreq(c.degree, this.tuningId, this.root); // resolve in this pattern's tuning
        n.artDur = articBeats(c.artic == null ? DEFAULT_ARTIC : c.artic, beats, spb); // sounded length (beats)
        notes.push(n);
      }
      t += beats;
    }
    return new Score(notes, bpm, articulation, t);
  }

  // Compact array form for localStorage: [durIndex, degree, isRest, accent, artic].
  toJSON() {
    return this.columns.map((c) => [c.durIndex, c.degree, c.isRest ? 1 : 0, c.accent | 0, c.artic == null ? DEFAULT_ARTIC : c.artic]);
  }

  static fromJSON(arr, name = 'A') {
    return new Pattern(
      arr.map(([durIndex, degree, isRest, accent, artic]) => ({
        durIndex,
        degree,
        isRest: !!isRest,
        accent: accent | 0,
        artic: artic == null ? DEFAULT_ARTIC : (artic | 0), // old 4-field rows → normal
      })),
      name,
    );
  }
}

// transforms.js — per-tile, nondestructive pattern transformations.
//
// A tile REFERENCES a pattern; a transform lives on the tile *instance*, never on
// the pattern. So two tiles can share one pattern yet sound different, and editing
// the pattern still updates both (each re-applying its own transforms). Transforms
// are applied at score-build time (main.js arrangementScore), never baked in.
//
// A tile carries an ORDERED list of transforms. `applyTransforms` walks it in
// order over the tile's note list — transpose touches pitch, reverse touches time
// — so ordering is honored (it doesn't matter for transpose+reverse, which
// commute, but will once a time-op like Rotate joins). Adding a transform type is
// an apply branch here + a brush in main; the data model doesn't change.
//
// Phase-1 policy (set by the user): keep at most ONE transpose (a second replaces
// it) and ONE reverse (applying it again cancels it) — `normalizeTransforms`
// enforces that. The "compute the minimal equivalent set" generalization is later.

import { stepInScale, scaleById } from './scales.js';
import { tuningFreq } from './tuning.js';

// --- transform constructors --------------------------------------------------

// A transpose transform. steps = signed scale-step count (− = down); scaleId/root
// = the mask the steps walk, snapshotted when painted ('chromatic' ⇒ semitones).
export function transposeTransform(steps, scaleId, root) {
  return { type: 'transpose', steps, scaleId: scaleById(scaleId).id, root: ((Math.round(root) % 12) + 12) % 12 };
}

// A reverse (retrograde) transform — no params; it's its own inverse.
export function reverseTransform() { return { type: 'reverse' }; }

// --- application (the pipeline) ----------------------------------------------

// Walk one degree `t.steps` mask-steps for a transpose transform.
function transposedDegree(degree, t) {
  if (!t.steps) return degree;
  const dir = t.steps > 0 ? 1 : -1;
  let d = degree;
  for (let i = 0; i < Math.abs(t.steps); i++) d = stepInScale(t.scaleId, t.root, d, dir);
  return d;
}

// Transpose: map each note's pitch and re-resolve its frequency in the tile's own
// tuning (a transform never changes tuning). Notes that don't move are reused.
function applyTranspose(notes, t, ctx) {
  return notes.map((n) => {
    const d = transposedDegree(n.pitch, t);
    return d === n.pitch ? n : { ...n, pitch: d, freq: tuningFreq(d, ctx.tuningId, ctx.root) };
  });
}

// Reverse: retrograde the notes in time within the tile's FULL length (column
// sum, trailing rests included). `start → L − start − duration`, pitch/duration
// kept — exactly what cloning the tile and reversing its columns would produce.
function applyReverse(notes, ctx) {
  const L = ctx.lengthBeats;
  return notes.map((n) => ({ ...n, start: L - n.start - n.duration }));
}

// Apply a tile's ordered transform list to its note list. `notes` are plain
// { pitch, start, duration, velocity, freq }; ctx = { lengthBeats, tuningId, root }.
export function applyTransforms(notes, transforms, ctx) {
  if (!transforms || !transforms.length) return notes;
  let out = notes;
  for (const t of transforms) {
    if (t.type === 'transpose') out = applyTranspose(out, t, ctx);
    else if (t.type === 'reverse') out = applyReverse(out, ctx);
  }
  return out;
}

// --- queries / editing -------------------------------------------------------

// The (single) transpose transform on a tile, or null.
export function findTranspose(transforms) {
  return transforms ? transforms.find((t) => t.type === 'transpose') || null : null;
}
export function hasReverse(transforms) {
  return !!(transforms && transforms.some((t) => t.type === 'reverse'));
}

// Coerce a loaded transforms array to clean entries; undefined if empty (absent ==
// none). Drops junk, rounds steps, normalizes scale/root, and enforces the Phase-1
// policy: at most one transpose (last wins) and reverse by PARITY (pairs cancel),
// preserving the order entries first appear in.
export function normalizeTransforms(arr) {
  if (!Array.isArray(arr)) return undefined;
  const out = [];
  for (const t of arr) {
    if (!t) continue;
    if (t.type === 'transpose' && typeof t.steps === 'number' && isFinite(t.steps) && Math.round(t.steps) !== 0) {
      const i = out.findIndex((x) => x.type === 'transpose');
      if (i >= 0) out.splice(i, 1); // a later transpose replaces the earlier one
      out.push(transposeTransform(Math.round(t.steps), t.scaleId, t.root));
    } else if (t.type === 'reverse') {
      const i = out.findIndex((x) => x.type === 'reverse');
      if (i >= 0) out.splice(i, 1); // a pair of reverses cancels
      else out.push(reverseTransform());
    }
  }
  return out.length ? out : undefined;
}

// Set/clear the transpose on a tile in place (keeps any reverse). steps 0 removes.
export function setTileTranspose(tile, steps, scaleId, root) {
  const others = (tile.transforms || []).filter((t) => t.type !== 'transpose');
  const next = Math.round(steps) === 0 ? others : [...others, transposeTransform(steps, scaleId, root)];
  tile.transforms = next.length ? next : undefined;
  return tile;
}

// Set/clear the reverse on a tile in place (keeps any transpose).
export function setTileReverse(tile, on) {
  const others = (tile.transforms || []).filter((t) => t.type !== 'reverse');
  const next = on ? [...others, reverseTransform()] : others;
  tile.transforms = next.length ? next : undefined;
  return tile;
}

// --- labels (swath glyph / chip text) ----------------------------------------

// Short label for the swath, e.g. "+2" / "−3" / "◄".
export function transposeLabel(t) {
  return (t.steps > 0 ? '+' : '−') + Math.abs(t.steps);
}

// A transform's kind + short swath label.
export function transformKindLabel(t) {
  if (t.type === 'transpose') return { kind: 'transpose', label: transposeLabel(t) };
  if (t.type === 'reverse') return { kind: 'reverse', label: '◄' };
  return { kind: 'other', label: '?' };
}

// Fuller description for a chip / future tooltip, e.g.
// "Transpose +2 · Major pentatonic" / "Reverse".
export function describeTransform(t) {
  if (t.type === 'transpose') return `Transpose ${transposeLabel(t)} · ${scaleById(t.scaleId).name}`;
  if (t.type === 'reverse') return 'Reverse';
  return '';
}

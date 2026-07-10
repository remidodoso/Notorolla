// transforms.js — per-tile, nondestructive pattern transformations.
//
// A tile REFERENCES a pattern; a transform lives on the tile *instance*, never on
// the pattern. So two tiles can share one pattern yet sound different, and editing
// the pattern still updates both (each re-applying its own transforms). Transforms
// are applied at score-build time (main.js arrangementScore), never baked in.
//
// A tile carries an ORDERED list of transforms; `applyTransforms` walks it in
// order over the tile's note list. The order is CANONICAL — the One True Order
// (decided 2026-07-09): at most one of each kind, applied degree-space →
// time-space → frequency-space (see TRANSFORM_ORDER below). With one-of-each
// and signed/parameterized transforms, any "other order" is reachable by
// adjusting parameters (TnI; reverse∘rotate(+k) = rotate(−k)∘reverse), and the
// planned per-tile "Bake" makes staging fully general. `normalizeTransforms`
// enforces one-of-each + the canonical order; the setTileX helpers maintain it.
// Adding a transform type is an apply branch here + a bar action in
// transformbar; the data model doesn't change.

import { stepInScale, scaleById } from './scales.js';
import { tuningFreq, edoOf } from './tuning.js';

// The One True Order. Degree-space ops FIRST (they re-resolve `freq` from the
// tuning, so anything frequency-space upstream of them would be clobbered),
// time ops next, frequency-space ops LAST. 'invert' and 'rotate' are reserved
// slots for the planned transforms; an unknown type sorts to the end.
const TRANSFORM_ORDER = ['invert', 'transpose', 'rotate', 'reverse', 'detune'];
function orderOf(type) {
  const i = TRANSFORM_ORDER.indexOf(type);
  return i < 0 ? TRANSFORM_ORDER.length : i;
}
// Re-sort a transform list into the canonical order, in place (stable, so this
// is a no-op on an already-canonical list).
function canonicalize(arr) {
  arr.sort((a, b) => orderOf(a.type) - orderOf(b.type));
  return arr;
}

// --- transform constructors --------------------------------------------------

// A transpose transform. steps = signed scale-step count (− = down); scaleId/root
// = the mask the steps walk, snapshotted when painted ('chromatic' ⇒ semitones).
// `root` is a pitch class in the TILE's tuning — stored as a plain integer (no
// mod), since the tuning's EDO isn't known here and `inScale` already reduces it
// modulo the right EDO at apply time. (The old `% 12` clamp corrupted roots ≥ 12
// in non-12 tunings, e.g. 16-ET.)
export function transposeTransform(steps, scaleId, root) {
  return { type: 'transpose', steps, scaleId: scaleById(scaleId).id, root: Number.isFinite(root) ? Math.round(root) : 0 };
}

// A reverse (retrograde) transform — no params; it's its own inverse.
export function reverseTransform() { return { type: 'reverse' }; }

// A detune transform: shift the tile's SOUNDING pitch by ± whole cents.
export const DETUNE_MAX = 100; // ± cents
export function detuneTransform(cents) {
  const c = Math.round(Number(cents) || 0);
  return { type: 'detune', cents: Math.max(-DETUNE_MAX, Math.min(DETUNE_MAX, c)) };
}

// --- application (the pipeline) ----------------------------------------------

// Walk one degree `t.steps` mask-steps for a transpose transform, in an `edo`-tone
// octave.
function transposedDegree(degree, t, edo) {
  if (!t.steps) return degree;
  const dir = t.steps > 0 ? 1 : -1;
  let d = degree;
  for (let i = 0; i < Math.abs(t.steps); i++) d = stepInScale(t.scaleId, t.root, d, dir, edo);
  return d;
}

// Transpose: map each note's pitch and re-resolve its frequency in the tile's own
// tuning (a transform never changes tuning). Notes that don't move are reused.
function applyTranspose(notes, t, ctx) {
  const edo = edoOf(ctx.tuningId);
  return notes.map((n) => {
    const d = transposedDegree(n.pitch, t, edo);
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

// Detune: shift every note's SOUNDING pitch by `cents` — uniformly, for every
// instrument (the contract, decided 2026-07-09). Two parts: (1) multiply the
// resolved frequency — exactly right for every voice whose pitch is linear in
// f0 (all the melodic kinds), and what the roll's true-pitch plot reads; and
// (2) stamp the cents on the note (`n.detune`), so a voice with a NONLINEAR
// pitch response still guarantees the full shift by its own means — Boshwick's
// PitchTrack exponent tops itself up by cents×(1−track) (audio.js); a future
// sampler shifts playbackRate by the same ratio. Detune sits LAST in the
// canonical order because transpose/invert re-resolve `freq` from the tuning
// and would clobber an upstream multiply.
function applyDetune(notes, t, ctx) {
  if (!t.cents) return notes;
  const ratio = Math.pow(2, t.cents / 1200);
  return notes.map((n) => ({
    ...n,
    freq: (n.freq != null ? n.freq : tuningFreq(n.pitch, ctx.tuningId, ctx.root)) * ratio,
    detune: (n.detune || 0) + t.cents,
  }));
}

// Apply a tile's ordered transform list to its note list. `notes` are plain
// { pitch, start, duration, velocity, freq }; ctx = { lengthBeats, tuningId, root }.
export function applyTransforms(notes, transforms, ctx) {
  if (!transforms || !transforms.length) return notes;
  let out = notes;
  for (const t of transforms) {
    if (t.type === 'transpose') out = applyTranspose(out, t, ctx);
    else if (t.type === 'reverse') out = applyReverse(out, ctx);
    else if (t.type === 'detune') out = applyDetune(out, t, ctx);
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
// The (single) detune transform on a tile, or null.
export function findDetune(transforms) {
  return transforms ? transforms.find((t) => t.type === 'detune') || null : null;
}

// Coerce a loaded transforms array to clean entries; undefined if empty (absent ==
// none). Drops junk, rounds/clamps params, enforces one-of-each (a later transpose/
// detune replaces the earlier one; reverse by PARITY — pairs cancel), and emits the
// CANONICAL order regardless of the input order (so any historical file comes out
// One-True-Ordered).
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
    } else if (t.type === 'detune' && typeof t.cents === 'number' && isFinite(t.cents) && Math.round(t.cents) !== 0) {
      const i = out.findIndex((x) => x.type === 'detune');
      if (i >= 0) out.splice(i, 1); // a later detune replaces the earlier one
      out.push(detuneTransform(t.cents));
    }
  }
  return out.length ? canonicalize(out) : undefined;
}

// Set/clear the transpose on a tile in place (keeps the other kinds, canonical
// order maintained). steps 0 removes.
export function setTileTranspose(tile, steps, scaleId, root) {
  const others = (tile.transforms || []).filter((t) => t.type !== 'transpose');
  const next = Math.round(steps) === 0 ? others : canonicalize([...others, transposeTransform(steps, scaleId, root)]);
  tile.transforms = next.length ? next : undefined;
  return tile;
}

// Set/clear the reverse on a tile in place (keeps the other kinds).
export function setTileReverse(tile, on) {
  const others = (tile.transforms || []).filter((t) => t.type !== 'reverse');
  const next = on ? canonicalize([...others, reverseTransform()]) : others;
  tile.transforms = next.length ? next : undefined;
  return tile;
}

// Set/clear the detune on a tile in place (keeps the other kinds; a second
// application replaces — never accumulates). cents 0 removes.
export function setTileDetune(tile, cents) {
  const others = (tile.transforms || []).filter((t) => t.type !== 'detune');
  const next = Math.round(cents) === 0 ? others : canonicalize([...others, detuneTransform(cents)]);
  tile.transforms = next.length ? next : undefined;
  return tile;
}

// --- labels (swath glyph / chip text) ----------------------------------------

// Short label for the swath, e.g. "+2" / "−3" / "◄".
export function transposeLabel(t) {
  return (t.steps > 0 ? '+' : '−') + Math.abs(t.steps);
}

// Short label for a detune swath, e.g. "+37¢" / "−12¢".
export function detuneLabel(t) {
  return (t.cents > 0 ? '+' : '−') + Math.abs(t.cents) + '¢';
}

// A transform's kind + short swath label.
export function transformKindLabel(t) {
  if (t.type === 'transpose') return { kind: 'transpose', label: transposeLabel(t) };
  if (t.type === 'reverse') return { kind: 'reverse', label: '◄' };
  if (t.type === 'detune') return { kind: 'detune', label: detuneLabel(t) };
  return { kind: 'other', label: '?' };
}

// Fuller description for a chip / future tooltip, e.g.
// "Transpose +2 · Major pentatonic" / "Reverse" / "Detune +37 ¢".
export function describeTransform(t) {
  if (t.type === 'transpose') return `Transpose ${transposeLabel(t)} · ${scaleById(t.scaleId).name}`;
  if (t.type === 'reverse') return 'Reverse';
  if (t.type === 'detune') return `Detune ${t.cents > 0 ? '+' : '−'}${Math.abs(t.cents)} ¢`;
  return '';
}

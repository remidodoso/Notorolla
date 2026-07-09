// reference.js — the grid editor's read-only "reference" backdrop.
//
// A reference is a FROZEN, self-contained snapshot of a tile, used to overlay one
// pattern behind another while editing (see-together / hear-together, the on-ramp
// to New Counterpoint — future_directions.md §16). It is deliberately NOT a live
// link: baking copies the pattern data, its pitch context, the resolved instrument
// patch, and the tile's transform, so editing/deleting the source tile never
// changes the reference. It stays put until Clear/replace.
//
// The transform is kept SEPARATE (first-class) and applied on use — always on in
// this first pass, but left togglable/editable for later.

import { Pattern } from './grid.js';
import { Note } from './model.js';
import { applyTransforms } from './transforms.js';
import { clonePatch } from '../audio/instrument.js';

// Snapshot a source (pattern + its lane's patch + the tile's transforms) into the
// immutable bundle. `opts.name` overrides the display label; quieter defaults on.
export function bakeReference(pattern, patch, transforms, opts = {}) {
  return {
    name: opts.name || pattern.label || pattern.name,
    columns: pattern.columns.map((c) => ({ ...c })),
    tuningId: pattern.tuningId,
    scaleId: pattern.scaleId,
    root: pattern.root,
    patch: patch ? clonePatch(patch) : null,
    transforms: transforms && transforms.length ? transforms.map((t) => ({ ...t })) : null,
    quieter: opts.quieter !== false,
    muted: !!opts.muted,
  };
}

// The reference as a transformed note list in ITS OWN tuning. Returns plain notes
// { pitch, start, duration, velocity, freq, artDur } (beats) + lengthBeats. `bpm`
// only affects the spiccato/seconds math baked into artDur; start/duration are in
// beats and tuning resolves pitch, so the layout/display are tempo-independent.
export function referenceScore(ref, bpm, articulation) {
  const p = new Pattern(ref.columns.map((c) => ({ ...c })), ref.name);
  p.tuningId = ref.tuningId; p.scaleId = ref.scaleId; p.root = ref.root;
  const score = p.toScore(bpm, articulation);
  const notes = applyTransforms(
    score.notes.map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity, freq: n.freq, artDur: n.artDur })),
    ref.transforms,
    { lengthBeats: score.lengthBeats, tuningId: ref.tuningId, root: ref.root },
  );
  return { notes, lengthBeats: score.lengthBeats };
}

// The bpm-independent info the grid view needs to draw the ghost + build the merged
// layout: dot positions (start/pitch/duration) and the onset/endpoint beats that
// become shared alignment points. len = the reference's full length in beats.
export function referenceDisplay(ref) {
  const { notes, lengthBeats } = referenceScore(ref, 120, 0.88);
  const onsets = [];
  for (const n of notes) { onsets.push(n.start, n.start + n.duration); }
  return {
    notes: notes.map((n) => ({ start: n.start, pitch: n.pitch, duration: n.duration })),
    onsets,
    len: lengthBeats,
  };
}

// Merge a grid pattern's notes with the reference's for AUDITION (never export —
// the reference isn't part of the composition). One cycle = max(edited, reference);
// each voice is tiled to fill so repeats phase as though from the top. Reference
// notes are tagged with a `patch` (dry override) and attenuated by `quietFactor`
// when Quieter is on. Muted → the reference contributes nothing. Returns
// { notes, total } (total in beats). Pure; the host wraps it in a Score.
export function mergeAudition(ref, gridNotes, gridLen, bpm, articulation, quietFactor) {
  if (!ref || ref.muted) return { notes: gridNotes, total: gridLen };
  const rs = referenceScore(ref, bpm, articulation);
  const total = Math.max(gridLen, rs.lengthBeats);
  if (!(total > 0)) return { notes: gridNotes, total: gridLen };
  const q = ref.quieter ? quietFactor : 1;
  const tile = (notes, patLen, tag) => {
    const out = [];
    if (!(patLen > 0)) return out;
    for (let base = 0; base < total - 1e-9; base += patLen) {
      for (const n of notes) {
        const start = n.start + base;
        if (start >= total - 1e-9) continue;
        const nn = new Note(n.pitch, start, n.duration, tag ? n.velocity * q : n.velocity);
        nn.freq = n.freq;
        nn.artDur = n.artDur;
        if (tag) nn.patch = ref.patch; // dry, reference instrument
        out.push(nn);
      }
    }
    return out;
  };
  return { notes: [...tile(gridNotes, gridLen, false), ...tile(rs.notes, rs.lengthBeats, true)], total };
}

// localStorage form (self-contained; never dangles). Columns as compact rows,
// matching Pattern.toJSON's field order so a hand-read stays legible.
export function referenceToJSON(ref) {
  if (!ref) return null;
  return {
    name: ref.name,
    cols: ref.columns.map((c) => [c.durIndex, c.degree, c.isRest ? 1 : 0, c.accent | 0, c.artic | 0]),
    tuningId: ref.tuningId,
    scaleId: ref.scaleId,
    root: ref.root,
    patch: ref.patch || null,
    transforms: ref.transforms || null,
    quieter: ref.quieter !== false,
    muted: !!ref.muted,
  };
}

export function referenceFromJSON(o) {
  if (!o || !Array.isArray(o.cols)) return null;
  return {
    name: o.name || 'ref',
    columns: o.cols.map(([durIndex, degree, isRest, accent, artic]) => ({
      durIndex, degree, isRest: !!isRest, accent: accent | 0, artic: artic == null ? 2 : (artic | 0),
    })),
    tuningId: o.tuningId || '12-et',
    scaleId: o.scaleId || 'chromatic',
    root: o.root || 0,
    patch: o.patch ? clonePatch(o.patch) : null,
    transforms: Array.isArray(o.transforms) && o.transforms.length ? o.transforms.map((t) => ({ ...t })) : null,
    quieter: o.quieter !== false,
    muted: !!o.muted,
  };
}

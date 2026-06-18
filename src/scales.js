// scales.js — scale "masks": a chosen subset of the 12 pitch-classes, used to
// highlight in-scale rows and snap edits. A mask is independent of tuning — it's
// about *which* degrees you want, not how they sound. Pentatonic-over-12-ET and
// pentatonic-over-JI are the same mask on different tunings.
//
// pcs are pitch-classes relative to the scale's root (0). A pattern stores a
// `root` (0..11) that rotates the mask onto any starting note.

export const SCALES = [
  { id: 'chromatic',  name: 'Chromatic',          pcs: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'major-pent', name: 'Major pentatonic',   pcs: [0, 2, 4, 7, 9] },
  { id: 'minor-pent', name: 'Minor pentatonic',   pcs: [0, 3, 5, 7, 10] },
];

export function scaleById(id) {
  return SCALES.find((s) => s.id === id) || SCALES[0];
}

// Is `degree` (absolute) a member of `scaleId` rooted at `root`?
export function inScale(scaleId, root, degree) {
  if (scaleId === 'chromatic') return true;
  const pc = (((degree - root) % 12) + 12) % 12;
  return scaleById(scaleId).pcs.includes(pc);
}

// Nearest in-scale degree to `degree` (ties → the lower). Identity for chromatic.
export function nearestInScale(scaleId, root, degree) {
  if (scaleId === 'chromatic') return degree;
  for (let r = 0; r < 12; r++) {
    if (inScale(scaleId, root, degree - r)) return degree - r;
    if (inScale(scaleId, root, degree + r)) return degree + r;
  }
  return degree;
}

// The next in-scale degree strictly above (dir > 0) or below (dir < 0) `degree`
// — i.e. a scale step. For chromatic this is just degree ± 1 (every degree is
// in-scale = a chromatic step). An off-scale note lands on the first mask member
// past it in that direction (so it snaps onto the scale as it moves).
export function stepInScale(scaleId, root, degree, dir) {
  const step = dir > 0 ? 1 : -1;
  for (let d = degree + step; Math.abs(d - degree) <= 24; d += step) {
    if (inScale(scaleId, root, d)) return d;
  }
  return degree + step; // unreachable for the defined masks; degenerate fallback
}

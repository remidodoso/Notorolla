// scales.js — scale "masks": a chosen subset of the pitch-classes, used to
// highlight in-scale rows and snap edits. A mask is independent of tuning — it's
// about *which* degrees you want, not how they sound. Pentatonic-over-12-ET and
// pentatonic-over-JI are the same mask on different tunings.
//
// pcs are pitch-classes relative to the scale's root (0). A pattern stores a
// `root` that rotates the mask onto any starting note. The modulus is the tuning's
// EDO (degrees per octave) — passed in as `edo` (default 12); a 16-ET mask runs the
// same logic with edo = 16.

// Each mask is tagged with the EDO it belongs to, so the picker can show only the
// scales valid for the pattern's tuning. `chromatic` is universal (edo: null) — it
// means "every degree is in scale" regardless of EDO (it's special-cased below and
// never consults its pcs). The 16-ET masks are Mavila: a chain of the flat ~675¢
// fifth (9 steps) gives the anti-diatonic Mavila[7] (2 2 2 3 2 2 3) and its
// pentatonic — the natural xen "diatonic" of 16-ET.
// The 12-ET group runs: the diatonic modes (major + its rotations, then the two
// altered minors), the SYMMETRIC scales (whole-tone / octatonic / augmented — the
// ones that make scale-STEP transposition warp most strikingly, since their even
// spacing shifts every interval quality at once), blues, then the pentatonics.
// Symmetric scales repeat under transposition (whole-tone has 2 transpositions,
// octatonic 3, augmented 4) which is exactly why they're such good "atonal harmony"
// engines. The 16-ET group has two strands: (1) the MAVILA MOS family off the flat
// ~675¢ fifth (9 steps) — Mavila[7] (2 2 2 3 2 2 3), the [9] "superdiatonic"
// (2 2 2 2 1 2 2 2 1) and the pentatonic — 16-ET's native anti-diatonic; and (2)
// the SYMMETRIC engines 16-ET is rich in (16 = 2·2·2·2): Octatonic (1 3 ×4, the
// diminished-temperament MOS, period = 300¢), Whole-tone (2 ×8, the 8-EDO subset),
// and Lemba (3 3 2 ×2 — the half-octave/600¢ temperament, a non-Mavila flavour).
export const SCALES = [
  { id: 'chromatic',      name: 'Chromatic',         edo: null, pcs: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'major',          name: 'Major (Ionian)',    edo: 12,   pcs: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'dorian',         name: 'Dorian',            edo: 12,   pcs: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian',       name: 'Phrygian',          edo: 12,   pcs: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian',         name: 'Lydian',            edo: 12,   pcs: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian',     name: 'Mixolydian',        edo: 12,   pcs: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'minor',          name: 'Minor (Aeolian)',   edo: 12,   pcs: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'locrian',        name: 'Locrian',           edo: 12,   pcs: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'harmonic-minor', name: 'Harmonic minor',    edo: 12,   pcs: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic-minor',  name: 'Melodic minor',     edo: 12,   pcs: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'whole-tone',     name: 'Whole-tone',        edo: 12,   pcs: [0, 2, 4, 6, 8, 10] },
  { id: 'octatonic-wh',   name: 'Octatonic (W–H)',   edo: 12,   pcs: [0, 2, 3, 5, 6, 8, 9, 11] },
  { id: 'octatonic-hw',   name: 'Octatonic (H–W)',   edo: 12,   pcs: [0, 1, 3, 4, 6, 7, 9, 10] },
  { id: 'augmented',      name: 'Augmented',         edo: 12,   pcs: [0, 3, 4, 7, 8, 11] },
  { id: 'blues',          name: 'Blues (minor)',     edo: 12,   pcs: [0, 3, 5, 6, 7, 10] },
  { id: 'major-pent',     name: 'Major pentatonic',  edo: 12,   pcs: [0, 2, 4, 7, 9] },
  { id: 'minor-pent',     name: 'Minor pentatonic',  edo: 12,   pcs: [0, 3, 5, 7, 10] },
  { id: 'mavila7',        name: 'Mavila (7)',        edo: 16,   pcs: [0, 2, 4, 6, 9, 11, 13] },
  { id: 'mavila9',        name: 'Mavila (9)',        edo: 16,   pcs: [0, 2, 4, 6, 8, 9, 11, 13, 15] },
  { id: 'mavila-pent',    name: 'Mavila pentatonic', edo: 16,   pcs: [0, 2, 4, 9, 11] },
  { id: 'octatonic16',    name: 'Octatonic',         edo: 16,   pcs: [0, 1, 4, 5, 8, 9, 12, 13] },
  { id: 'wholetone8',     name: 'Whole-tone (8)',    edo: 16,   pcs: [0, 2, 4, 6, 8, 10, 12, 14] },
  { id: 'lemba6',         name: 'Lemba (6)',         edo: 16,   pcs: [0, 3, 6, 8, 11, 14] },
];

export function scaleById(id) {
  return SCALES.find((s) => s.id === id) || SCALES[0];
}

// The scales valid for an `edo`: chromatic (universal) plus the masks tagged with
// that EDO. Used to populate the picker for the pattern's tuning.
export function scalesFor(edo) {
  return SCALES.filter((s) => s.edo == null || s.edo === edo);
}

// Is `scaleId` a valid mask for this `edo`? (So switching tuning can drop a mask
// that no longer applies, back to chromatic.)
export function scaleValidForEdo(scaleId, edo) {
  return scalesFor(edo).some((s) => s.id === scaleId);
}

// Is `degree` (absolute) a member of `scaleId` rooted at `root`, in an `edo`-tone
// octave?
export function inScale(scaleId, root, degree, edo = 12) {
  if (scaleId === 'chromatic') return true;
  const pc = (((degree - root) % edo) + edo) % edo;
  return scaleById(scaleId).pcs.includes(pc);
}

// Nearest in-scale degree to `degree` (ties → the lower). Identity for chromatic.
export function nearestInScale(scaleId, root, degree, edo = 12) {
  if (scaleId === 'chromatic') return degree;
  for (let r = 0; r < edo; r++) {
    if (inScale(scaleId, root, degree - r, edo)) return degree - r;
    if (inScale(scaleId, root, degree + r, edo)) return degree + r;
  }
  return degree;
}

// The next in-scale degree strictly above (dir > 0) or below (dir < 0) `degree`
// — i.e. a scale step. For chromatic this is just degree ± 1 (every degree is
// in-scale = a chromatic step). An off-scale note lands on the first mask member
// past it in that direction (so it snaps onto the scale as it moves).
export function stepInScale(scaleId, root, degree, dir, edo = 12) {
  const step = dir > 0 ? 1 : -1;
  for (let d = degree + step; Math.abs(d - degree) <= 2 * edo; d += step) {
    if (inScale(scaleId, root, d, edo)) return d;
  }
  return degree + step; // unreachable for the defined masks; degenerate fallback
}

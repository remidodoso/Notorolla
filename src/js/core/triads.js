// triads.js — the Triadulator engine (pure: pitch-class sets in, triadulations
// out; no grid, no DOM, no octaves).
//
// "Triadulation" tiles a set of pitch classes with traditional triads (major,
// minor, diminished, augmented). Given the pitch classes ALREADY used on the
// grid, the caller passes the *complement* (the unused pcs) and we partition it:
//   - a PROPER triadulation covers every pc with disjoint triads (no leftover);
//   - a PARTIAL one covers as many as possible and leaves a remainder.
//
// We work in pitch-class SETS, so inversions are inherent: {0,4,7}, {4,7,0} and
// {7,0,4} are the same set, all recognized as C major. Each template is tagged by
// the EDO it belongs to (the four classic triads + sus are a 12-tone construct);
// a tuning whose EDO has no templates yields no chords. Families come and go with
// the EDO — callers pass the pattern's edo (edoOf(tuningId), default 12).
//
// Root-relative step offsets per chord, tagged by family + edo. sus2 {0,2,7} and
// sus4 are the SAME pc-set (sus4 is an inversion of sus2), so one template covers
// both; every sus set is named canonically by its sus2 root.
const TEMPLATES = [
  { quality: 'maj', family: 'trad', edo: 12, offsets: [0, 4, 7] },
  { quality: 'min', family: 'trad', edo: 12, offsets: [0, 3, 7] },
  { quality: 'dim', family: 'trad', edo: 12, offsets: [0, 3, 6] },
  { quality: 'aug', family: 'trad', edo: 12, offsets: [0, 4, 8] },
  { quality: 'sus', family: 'sus',  edo: 12, offsets: [0, 2, 7] },
  // 16-ET MAVILA triads — the native anti-diatonic harmony on the flat 675¢ fifth
  // (9 steps). Anti-diatonic means the "major" triad carries the SMALL third (4 steps
  // / 300¢) and the "minor" the larger neutral third (5 steps / 375¢); the diminished
  // is the leading-tone triad (525¢ / 7-step fifth). These harmonize the Mavila scales.
  { quality: 'mavmaj', family: 'mavila', edo: 16, offsets: [0, 4, 9] },
  { quality: 'mavmin', family: 'mavila', edo: 16, offsets: [0, 5, 9] },
  { quality: 'mavdim', family: 'mavila', edo: 16, offsets: [0, 5, 7] },
  // 16-ET septimal triads (no good fifth, so these lean on the excellent 7/4 = 13
  // steps): 4:5:7 (a flat major third + the harmonic seventh) and a supermajor
  // (9/7 ≈ 6 steps under the 7/4). See project notes for the 16-ET theory.
  { quality: 'sept', family: 'septimal', edo: 16, offsets: [0, 5, 13] },  // 4:5:7
  { quality: 'sup',  family: 'septimal', edo: 16, offsets: [0, 6, 13] },  // supermajor
];

// Display label for a chord family (the toggle button text). Falls back to the id.
const FAMILY_LABELS = { trad: 'trad', sus: 'sus', mavila: 'mavila', septimal: 'sept' };
export function familyLabel(id) { return FAMILY_LABELS[id] || id; }

const MAX_RESULTS = 200; // guard against pathological enumeration blow-up

// Distinct chords of ONE family in an `edo`-tone octave as { quality, root, pcs }
// (pcs sorted). Transposition-symmetric chords (the 12-ET augmented) collapse to
// fewer than `edo` sets; the rest give `edo` each. Memoized per (edo, family).
const _familyCache = new Map();
function buildFamily(edo, family) {
  const key = `${edo}|${family}`;
  let cached = _familyCache.get(key);
  if (cached) return cached;
  const out = [];
  const seen = new Set();
  for (let root = 0; root < edo; root++) {
    for (const t of TEMPLATES) {
      if (t.edo !== edo || t.family !== family) continue;
      const pcs = t.offsets.map((o) => (root + o) % edo).sort((a, b) => a - b);
      const k = `${t.quality}|${pcs.join(',')}`;
      if (seen.has(k)) continue; // collapse symmetric (e.g. augmented) duplicates
      seen.add(k);
      out.push({ quality: t.quality, root, pcs });
    }
  }
  _familyCache.set(key, out);
  return out;
}

// The chord pool for an edo across the given families, in families order.
// Exported for the New Random generator's triad bias (its candidate pc-sets).
export function chordsFor(edo, families) {
  return families.flatMap((f) => buildFamily(edo, f));
}

// Which families have any template at this edo (first-appearance order). Used by
// the labeler (which always recognizes every family the tuning offers) and to
// populate the Triadulator's family toggles for the current tuning.
export function familiesFor(edo) {
  const seen = [];
  for (const t of TEMPLATES) if (t.edo === edo && !seen.includes(t.family)) seen.push(t.family);
  return seen;
}

// Sort key: a triadulation's triads ordered by lowest pc; the list of
// triadulations ordered proper-first (fewest leftover), then lexicographically
// by their flattened pcs — so rotation is stable and the "best" comes first.
const byLowPc = (a, b) => a.pcs[0] - b.pcs[0];
function signature(t) {
  return `${t.leftover.length}:${t.triads.map((x) => x.pcs.join('.')).join(',')}|${t.leftover.join('.')}`;
}

// Every MAXIMAL collection of disjoint triads drawn from `pcSet` (maximal = no
// further triad fits in what's left). Proper triadulations are exactly the ones
// whose leftover is empty, so this single search covers both modes.
function maximalTriadulations(pcSet, chords) {
  const cand = chords.filter((t) => t.pcs.every((p) => pcSet.has(p)));
  const results = [];
  const seen = new Set();

  // Add triads in increasing candidate-index order (startIdx) so a given
  // collection is reached only one way; dedup defensively by triad signature.
  function rec(remaining, chosen, startIdx) {
    if (results.length >= MAX_RESULTS) return;
    let extended = false;
    for (let i = startIdx; i < cand.length; i++) {
      const t = cand[i];
      if (!t.pcs.every((p) => remaining.has(p))) continue;
      extended = true;
      const next = new Set(remaining);
      for (const p of t.pcs) next.delete(p);
      chosen.push(t);
      rec(next, chosen, i + 1);
      chosen.pop();
      if (results.length >= MAX_RESULTS) return;
    }
    if (!extended && chosen.length > 0) {
      const sig = chosen.map((t) => t.pcs.join(',')).sort().join('|');
      if (seen.has(sig)) return;
      seen.add(sig);
      const covered = new Set();
      for (const t of chosen) for (const p of t.pcs) covered.add(p);
      const leftover = [...pcSet].filter((p) => !covered.has(p)).sort((a, b) => a - b);
      results.push({ triads: chosen.slice().sort(byLowPc), leftover });
    }
  }

  rec(new Set(pcSet), [], 0);
  return results;
}

// Classify a set of pitch classes (any order/octave) as a chord, or null. Used
// to LABEL chords on the grid — recognizes every family the tuning's `edo` offers.
// Empty (null) for an edo with no templates.
export function classifyTriad(pcs, edo = 12) {
  const set = [...new Set([...pcs].map((p) => (((p % edo) + edo) % edo)))].sort((a, b) => a - b);
  if (set.length !== 3) return null; // need three distinct pitch classes
  const key = set.join(',');
  const t = chordsFor(edo, familiesFor(edo)).find((tr) => tr.pcs.join(',') === key);
  return t ? { quality: t.quality, root: t.root } : null;
}

// Public: enumerate triadulations of `pcs` (an iterable of pitch classes).
// opts.proper = only complete (no-leftover) coverings; opts.families = which chord
// families to build from (the ids enabled for the tuning, at least one else
// nothing); opts.edo is the tuning's degrees-per-octave. The result is a stable,
// deterministic list; index 0 is the canonical/"best" one.
export function enumerateTriadulations(pcs, { proper = false, families = [], edo = 12 } = {}) {
  const chords = chordsFor(edo, families);
  if (!chords.length) return [];
  let all = maximalTriadulations(new Set(pcs), chords);
  if (proper) all = all.filter((t) => t.leftover.length === 0);
  all.sort((a, b) => signature(a).localeCompare(signature(b)));
  return all;
}

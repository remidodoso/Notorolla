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
// {7,0,4} are the same set, all recognized as C major. Triads are the four
// classic qualities, which are a 12-tone construct — if DEGREES_PER_OCTAVE isn't
// 12 there are no "traditional triads" to find, so we return nothing.

import { DEGREES_PER_OCTAVE } from './tuning.js';

// Root-relative semitone offsets for each quality.
const TEMPLATES = [
  { quality: 'maj', offsets: [0, 4, 7] },
  { quality: 'min', offsets: [0, 3, 7] },
  { quality: 'dim', offsets: [0, 3, 6] },
  { quality: 'aug', offsets: [0, 4, 8] },
];

const MAX_RESULTS = 200; // guard against pathological enumeration blow-up

// All distinct triads as { quality, root, pcs } with pcs sorted ascending. The
// augmented triad is transposition-symmetric, so it yields only 4 distinct sets
// (deduped by quality+set) rather than 12 — 40 triads total in 12-EDO.
function allTriads() {
  if (DEGREES_PER_OCTAVE !== 12) return [];
  const out = [];
  const seen = new Set();
  for (let root = 0; root < 12; root++) {
    for (const t of TEMPLATES) {
      const pcs = t.offsets.map((o) => (root + o) % 12).sort((a, b) => a - b);
      const key = `${t.quality}|${pcs.join(',')}`;
      if (seen.has(key)) continue; // collapse symmetric augmented duplicates
      seen.add(key);
      out.push({ quality: t.quality, root, pcs });
    }
  }
  return out;
}

const TRIADS = allTriads();

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
function maximalTriadulations(pcSet) {
  const cand = TRIADS.filter((t) => t.pcs.every((p) => pcSet.has(p)));
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

// Classify a set of pitch classes (any order/octave) as a traditional triad, or
// null. Used to LABEL triads on the grid. 12-ET only (TRIADS is empty otherwise).
export function classifyTriad(pcs) {
  const set = [...new Set([...pcs].map((p) => (((p % 12) + 12) % 12)))].sort((a, b) => a - b);
  if (set.length !== 3) return null; // need three distinct pitch classes
  const key = set.join(',');
  const t = TRIADS.find((tr) => tr.pcs.join(',') === key);
  return t ? { quality: t.quality, root: t.root } : null;
}

// Public: enumerate triadulations of `pcs` (an iterable of pitch classes).
// opts.proper = true returns only complete (no-leftover) coverings. The result
// is a stable, deterministic list; index 0 is the canonical/"best" one.
export function enumerateTriadulations(pcs, { proper = false } = {}) {
  const set = new Set(pcs);
  let all = maximalTriadulations(set);
  if (proper) all = all.filter((t) => t.leftover.length === 0);
  all.sort((a, b) => signature(a).localeCompare(signature(b)));
  return all;
}

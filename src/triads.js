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
// {7,0,4} are the same set, all recognized as C major. The chords are a 12-tone
// construct — if DEGREES_PER_OCTAVE isn't 12 there are none to find, so we return
// nothing. Two families: `trad` (the four classic triads) and `sus` (suspended).

import { DEGREES_PER_OCTAVE } from './tuning.js';

// Root-relative semitone offsets per chord, tagged by family. sus2 {0,2,7} and
// sus4 are the SAME pc-set (sus4 is an inversion of sus2), so one template covers
// both; every sus set is named canonically by its sus2 root.
const TEMPLATES = [
  { quality: 'maj', family: 'trad', offsets: [0, 4, 7] },
  { quality: 'min', family: 'trad', offsets: [0, 3, 7] },
  { quality: 'dim', family: 'trad', offsets: [0, 3, 6] },
  { quality: 'aug', family: 'trad', offsets: [0, 4, 8] },
  { quality: 'sus', family: 'sus',  offsets: [0, 2, 7] },
];

const MAX_RESULTS = 200; // guard against pathological enumeration blow-up

// All distinct chords of the requested families as { quality, root, pcs } (pcs
// sorted). The augmented triad is transposition-symmetric → 4 distinct sets, not
// 12; maj/min/dim/sus give 12 each. sus sets are disjoint from every trad set (no
// third), so the families never collide.
function buildChords(families) {
  if (DEGREES_PER_OCTAVE !== 12) return [];
  const out = [];
  const seen = new Set();
  for (let root = 0; root < 12; root++) {
    for (const t of TEMPLATES) {
      if (!families.includes(t.family)) continue;
      const pcs = t.offsets.map((o) => (root + o) % 12).sort((a, b) => a - b);
      const key = `${t.quality}|${pcs.join(',')}`;
      if (seen.has(key)) continue; // collapse symmetric augmented duplicates
      seen.add(key);
      out.push({ quality: t.quality, root, pcs });
    }
  }
  return out;
}

const TRAD_CHORDS = buildChords(['trad']);
const SUS_CHORDS = buildChords(['sus']);
// The full table used for LABELING — always recognizes both families.
const ALL_CHORDS = [...TRAD_CHORDS, ...SUS_CHORDS];

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
// to LABEL chords on the grid — always recognizes both families (maj/min/dim/aug
// and sus). 12-ET only (ALL_CHORDS is empty otherwise).
export function classifyTriad(pcs) {
  const set = [...new Set([...pcs].map((p) => (((p % 12) + 12) % 12)))].sort((a, b) => a - b);
  if (set.length !== 3) return null; // need three distinct pitch classes
  const key = set.join(',');
  const t = ALL_CHORDS.find((tr) => tr.pcs.join(',') === key);
  return t ? { quality: t.quality, root: t.root } : null;
}

// Public: enumerate triadulations of `pcs` (an iterable of pitch classes).
// opts.proper = only complete (no-leftover) coverings; opts.trad / opts.sus
// select which chord families to build from (at least one, else nothing). The
// result is a stable, deterministic list; index 0 is the canonical/"best" one.
export function enumerateTriadulations(pcs, { proper = false, trad = true, sus = false } = {}) {
  const chords = [...(trad ? TRAD_CHORDS : []), ...(sus ? SUS_CHORDS : [])];
  if (!chords.length) return [];
  let all = maximalTriadulations(new Set(pcs), chords);
  if (proper) all = all.filter((t) => t.leftover.length === 0);
  all.sort((a, b) => signature(a).localeCompare(signature(b)));
  return all;
}

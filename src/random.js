// random.js — the "New Random" pattern generator (pure: settings in, degrees out).
//
// The default behavior is a generalized tone row: a contiguous window of N
// in-scale degrees, approximately centered on the grid viewport's middle, in a
// random order with no degree reused. Three sliders bend that:
//   unique 1..0  — 1 = always unique (a permutation); toward 0, each pick may
//                  ignore occupancy (sampling with replacement).
//   run   -1..+1 — |value| = chance each note continues stepwise (the CLOSEST
//                  in-window degree) in the sign's direction; ±1 = a single
//                  descending/ascending run (with unique, exactly the sorted window).
//   triad  0..1  — chance each note is chosen to complete a harmonic triad with
//                  the two preceding notes (EDO-aware, enabled families only).
// Precedence per note: uniqueness filters the pool, then run steers, then triad,
// else uniform. Run outranks triad so full runs stay intact at the extreme.
//
// Two more sliders bias pitch by each COLUMN'S groove — durBias by its length, accentBias
// by its accent loudness (both −1 Low … +1 High). Each runs one of two ways: STEER (the
// default) bakes the pull into generation — it only WEIGHTS the otherwise-uniform pick
// among the candidates run/triad allow, so Run/Triad contour survives (via the `bias`
// param → biasTargets/biasedPick, kept stochastic even at max); or SORT (`applyDuration/
// AccentBias`) re-pairs the finished pitches — stronger, but scrambles arpeggios. Both only
// move the NOTES; the groove (rhythm/accents/artic) stays fixed on its columns.
//
// `rng` is injectable for deterministic tests (defaults to Math.random).

import { inScale } from './scales.js';

export const RANDOM_DEFAULTS = {
  unique: 1, run: 0, triad: 0,
  durBias: 0, accentBias: 0,       // −1 (Low) … +1 (High); how much long/loud columns pull pitch
  durSort: false, accentSort: false, // per-bias mechanism: false = steer generation, true = post-hoc sort
};

// Shared "rank-correlation re-pairing" behind the bias sliders. Redistributes a
// per-position `material` array across positions so its low→high order correlates
// with a per-position `axis` value, at signed strength `bias`. `less(i,j)` ranks the
// positions by material value (low→high, tie by position). bias 0 = identity;
// |bias| = strength (0 = the material's own order, 1 = a clean sort); the sign picks
// the correlation direction. Preserves the material MULTISET — only placement changes.
// AXIS TIES break by the material's own low→high rank (`genRank`), so equal-axis
// positions keep the material's ordering instead of collapsing to a positional ramp —
// that's where within-group variety lives, and what lets other sliders still matter at
// full bias.
function rankBias(material, less, axis, bias) {
  const n = material.length;
  const a = Math.min(1, Math.abs(bias));
  const dir = bias < 0 ? -1 : 1;

  // The material low→high (stable), and each position's rank within it.
  const idxAsc = material.map((_, i) => i).sort(less);
  const sorted = idxAsc.map((i) => material[i]);
  const genRank = new Array(n);
  idxAsc.forEach((i, k) => { genRank[i] = k; });

  // Full-sort target: order positions by the axis (dir), breaking AXIS TIES by genRank.
  const targetOrder = material.map((_, i) => i).sort((i, j) => (dir * (axis[i] - axis[j])) || (genRank[i] - genRank[j]));
  const targetRank = new Array(n);
  targetOrder.forEach((i, k) => { targetRank[i] = k; });

  // Blend gen-rank ↔ target-rank by strength, re-sort positions, deal out the sorted material.
  const key = material.map((_, i) => (1 - a) * genRank[i] + a * targetRank[i]);
  const finalOrder = material.map((_, i) => i).sort((i, j) => (key[i] - key[j]) || (genRank[i] - genRank[j]));
  const out = new Array(n);
  finalOrder.forEach((i, k) => { out[i] = sorted[k]; });
  return out;
}

// Re-pair generated degrees to positions by a duration↔pitch rank correlation.
// bias 0 = identity; < 0 (Low) = longest notes get the lowest pitches; > 0 (High) =
// longest get the highest. |bias| is the strength (0 = the generated order, 1 = a
// clean sort). Preserves the MULTISET of pitches — only their placement in time
// changes, so range/scale/uniqueness are untouched. Ties (equal durations) break by
// the GENERATED pitch order, so within a duration group the band's pitches follow the
// generator's (random / Run- / Triad-shaped) order rather than a sorted ramp. Uniform
// durations → no effect.
export function applyDurationBias(degrees, beats, bias) {
  const n = degrees.length;
  if (!bias || n < 2 || new Set(beats.slice(0, n)).size < 2) return degrees.slice();
  // Low sorts longest→lowest, High longest→highest.
  return rankBias(degrees, (i, j) => (degrees[i] - degrees[j]) || (i - j), beats, bias);
}

// Re-pair generated degrees to positions by an accent↔pitch correlation — the accent
// parallel of Duration Bias. Like it, this moves the NOTES, not the groove: the accents
// stay fixed on their columns and the SAME pitches are re-dealt so pitch tracks accent.
// bias 0 = identity; < 0 (Low) = the loudest-accented columns get the lowest pitches;
// > 0 (High) = the highest. Accent "loudness" ranks ghost < normal < accent (by sounded
// velocity, not the raw level index). Preserves the pitch MULTISET; uniform accents (no
// gradient to correlate against) → no effect.
const ACCENT_INTENSITY = (lvl) => (lvl === 2 ? 0 : lvl === 0 ? 1 : 2); // ghost < normal < accent
export function applyAccentBias(degrees, accents, bias) {
  const n = degrees.length;
  if (!bias || n < 2 || new Set(accents.slice(0, n)).size < 2) return degrees.slice();
  const axis = accents.map((lvl) => ACCENT_INTENSITY(lvl)); // rank the pitches against accent loudness
  return rankBias(degrees, (i, j) => (degrees[i] - degrees[j]) || (i - j), axis, bias);
}

// Generator-bias targets: for each position, a desired pitch-RANK (0 low … 1 high) and a
// pull STRENGTH (0 … 1), derived from the column's duration and accent. Unlike the sort
// re-pairing, this steers generation IN PLACE, so Run/Triad contour survives — the bias
// only weights the otherwise-uniform pick among the candidates those sliders allow.
// `bias` = { durBias, accentBias, beats[], accents[] } (per-position). Returns null when
// there's nothing to steer (no bias, or the driving axis is flat). Duration and accent
// pulls combine (a weighted average of their targets); opposing pulls partly cancel.
function biasTargets(count, bias) {
  if (!bias) return null;
  const bd = bias.durBias || 0, ba = bias.accentBias || 0;
  if (Math.abs(bd) < 1e-6 && Math.abs(ba) < 1e-6) return null;
  const beats = bias.beats || [], accents = bias.accents || [];
  const dMin = Math.min(...beats), dSpan = Math.max(...beats) - dMin;
  const accInt = accents.map((lvl) => ACCENT_INTENSITY(lvl));
  const aMin = Math.min(...accInt), aSpan = Math.max(...accInt) - aMin;
  const out = new Array(count);
  let any = false;
  for (let k = 0; k < count; k++) {
    let tSum = 0, sSum = 0;
    if (Math.abs(bd) > 1e-6 && dSpan > 0) {
      const norm = (beats[k] - dMin) / dSpan;          // 0 short … 1 long
      const target = bd > 0 ? norm : 1 - norm;         // High: long→high pitch; Low: long→low
      const strength = Math.min(1, Math.abs(bd));
      tSum += strength * target; sSum += strength;
    }
    if (Math.abs(ba) > 1e-6 && aSpan > 0) {
      const norm = (accInt[k] - aMin) / aSpan;          // 0 soft … 1 loud
      const target = ba > 0 ? norm : 1 - norm;          // High: loud→high pitch; Low: loud→low
      const strength = Math.min(1, Math.abs(ba));
      tSum += strength * target; sSum += strength;
    }
    out[k] = sSum > 0 ? { target: tSum / sSum, strength: Math.min(1, sSum) } : { target: 0.5, strength: 0 };
    if (sSum > 0) any = true;
  }
  return any ? out : null;
}

// The contiguous window of `count` in-scale degrees nearest `centroid`, within
// [bounds.min, bounds.max]. Walks the whole in-scale ladder once, then slides a
// count-sized window so its center lands as close to the centroid as the ladder
// allows (clamped at the range ends). If the tuning+scale offers fewer than
// `count` degrees in range, the whole ladder is returned (shorter than count).
export function scaleWindow({ count, centroid, scaleId, root, edo, bounds }) {
  const ladder = [];
  for (let d = bounds.min; d <= bounds.max; d++) {
    if (inScale(scaleId, root, d, edo)) ladder.push(d);
  }
  if (ladder.length <= count) return ladder;
  // Index of the in-scale degree nearest the centroid.
  let ci = 0;
  for (let i = 1; i < ladder.length; i++) {
    if (Math.abs(ladder[i] - centroid) < Math.abs(ladder[ci] - centroid)) ci = i;
  }
  const start = Math.max(0, Math.min(ladder.length - count, ci - Math.floor((count - 1) / 2)));
  return ladder.slice(start, start + count);
}

// Generate `count` degrees. `chordKeys` = Set of sorted-pc-set keys ("0,4,7")
// for the enabled chord families (see chordsFor) — the triad slider's targets.
export function generateRandom({ count, centroid, scaleId, root, edo, bounds, chordKeys, settings, rng = Math.random, bias = null }) {
  const s = { ...RANDOM_DEFAULTS, ...settings };
  const window = scaleWindow({ count, centroid, scaleId, root, edo, bounds });
  if (!window.length) return [];
  const pcKey = (a, b, c) => {
    const set = [...new Set([a, b, c].map((d) => (((d % edo) + edo) % edo)))].sort((x, y) => x - y);
    return set.length === 3 ? set.join(',') : null;
  };
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  // Generator bias: weight the pick toward position k's target pitch-rank. Steepness
  // BIAS_SHARP sets how hard full bias pulls — kept finite so even maxed bias stays
  // STOCHASTIC (unlike Run, which is deterministic at the extreme): several arrangements
  // remain possible, just unequally likely. Uniform (strength 0) → the plain uniform pick.
  const posBias = biasTargets(count, bias);
  const BIAS_SHARP = 3.2;
  const rankOf = new Map();
  window.forEach((d, i) => rankOf.set(d, window.length > 1 ? i / (window.length - 1) : 0.5)); // window is ascending
  const biasedPick = (arr, k) => {
    const pb = posBias && posBias[k];
    if (!pb || pb.strength <= 0 || arr.length < 2) return pick(arr);
    const w = arr.map((d) => Math.exp(BIAS_SHARP * pb.strength * (1 - 2 * Math.abs(rankOf.get(d) - pb.target))));
    let sum = 0; for (const x of w) sum += x;
    let r = rng() * sum;
    for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  };

  const used = new Set();
  const out = [];
  for (let k = 0; k < count; k++) {
    // Uniqueness: this pick must avoid used degrees with probability `unique`
    // (falling back to the full window if everything's been used).
    let pool = window;
    if (rng() < s.unique) {
      const fresh = window.filter((d) => !used.has(d));
      if (fresh.length) pool = fresh;
    }

    let deg = null;
    if (k === 0) {
      // Seed a full run at the window's end so ±1 yields ONE unbroken run;
      // mid-slider values just tend to start runs near an end.
      if (rng() < Math.abs(s.run)) deg = s.run > 0 ? pool[0] : pool[pool.length - 1];
    } else if (rng() < Math.abs(s.run)) {
      // Stepwise: the closest pool degree strictly beyond the previous note in
      // the run's direction (none there = the run breaks; fall through).
      const prev = out[k - 1];
      const dir = s.run > 0 ? pool.filter((d) => d > prev) : pool.filter((d) => d < prev);
      if (dir.length) deg = s.run > 0 ? dir[0] : dir[dir.length - 1];
    }
    if (deg == null && k >= 2 && chordKeys && chordKeys.size && rng() < s.triad) {
      // Harmonic bias: candidates completing an enabled triad with the last two.
      const fits = pool.filter((d) => { const key = pcKey(out[k - 2], out[k - 1], d); return key && chordKeys.has(key); });
      if (fits.length) deg = biasedPick(fits, k); // bias chooses AMONG chord-completions — triad character stays
    }
    if (deg == null) deg = biasedPick(pool, k);

    used.add(deg);
    out.push(deg);
  }
  return out;
}

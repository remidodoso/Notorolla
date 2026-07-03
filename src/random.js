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
// `rng` is injectable for deterministic tests (defaults to Math.random).

import { inScale } from './scales.js';

export const RANDOM_DEFAULTS = { unique: 1, run: 0, triad: 0 };

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
export function generateRandom({ count, centroid, scaleId, root, edo, bounds, chordKeys, settings, rng = Math.random }) {
  const s = { ...RANDOM_DEFAULTS, ...settings };
  const window = scaleWindow({ count, centroid, scaleId, root, edo, bounds });
  if (!window.length) return [];
  const pcKey = (a, b, c) => {
    const set = [...new Set([a, b, c].map((d) => (((d % edo) + edo) % edo)))].sort((x, y) => x - y);
    return set.length === 3 ? set.join(',') : null;
  };
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

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
      if (fits.length) deg = pick(fits);
    }
    if (deg == null) deg = pick(pool);

    used.add(deg);
    out.push(deg);
  }
  return out;
}

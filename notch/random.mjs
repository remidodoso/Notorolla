// New Random generator: window placement, scale masking, uniqueness, runs, triads.
import { scaleWindow, generateRandom, RANDOM_DEFAULTS } from '../src/random.js';
import { inScale } from '../src/scales.js';
import { chordsFor, familiesFor, classifyTriad } from '../src/triads.js';
import { degreeBounds } from '../src/tuning.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// Deterministic PRNG (mulberry32) so every assertion is reproducible.
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const b12 = degreeBounds('12-et');
const base12 = { scaleId: 'chromatic', root: 0, edo: 12, bounds: b12 };

// 1) Window: chromatic, 12 notes ≈centered at 66 (even count → centroid sits at
// one of the two middle positions), contiguous.
{
  const w = scaleWindow({ count: 12, centroid: 66, ...base12 });
  ok(w.length === 12, 'window has 12 degrees');
  ok(w.every((d, i) => i === 0 || d === w[i - 1] + 1), 'window is contiguous');
  ok(w.includes(66) && Math.abs(w[0] + w[11] - 2 * 66) <= 1, `window centered on 66 (got ${w[0]}..${w[11]})`);
}
// 2) Window clamps at the range floor (centroid at A0).
{
  const w = scaleWindow({ count: 12, centroid: b12.min, ...base12 });
  ok(w[0] === b12.min, 'window clamps to the A0 floor');
}
// 3) In-scale only + unique degrees (the defaults = a tone row).
{
  const w = scaleWindow({ count: 12, centroid: 66, ...base12 });
  const degs = generateRandom({ count: 12, centroid: 66, ...base12, settings: {}, rng: rng32(7) });
  ok(degs.length === 12, 'generates one degree per column');
  ok(new Set(degs).size === 12, 'default unique: no degree reused');
  ok(degs.every((d) => w.includes(d)), 'all degrees inside the window');
  ok(new Set(degs.map((d) => d % 12)).size === 12, 'chromatic 12 = a full tone row');
}
// 4) Pentatonic mask: only in-scale degrees; unique-by-degree spans octaves.
{
  const p = { scaleId: 'major-pent', root: 0, edo: 12, bounds: b12 };
  const degs = generateRandom({ count: 12, centroid: 66, ...p, settings: {}, rng: rng32(3) });
  ok(degs.length === 12 && new Set(degs).size === 12, 'pentatonic: 12 unique degrees');
  ok(degs.every((d) => inScale('major-pent', 0, d, 12)), 'pentatonic: every degree in scale');
  const span = Math.max(...degs) - Math.min(...degs);
  ok(span > 12, `pentatonic window spans >1 octave (${span} degrees)`);
}
// 5) Run extremes: a single unbroken run (with unique = the sorted window).
{
  const w = scaleWindow({ count: 12, centroid: 66, ...base12 });
  const up = generateRandom({ count: 12, centroid: 66, ...base12, settings: { run: 1 }, rng: rng32(5) });
  ok(up.every((d, i) => i === 0 || d > up[i - 1]), 'run +1 = strictly ascending');
  ok(up.join() === w.join(), 'run +1 with unique = the full sorted window');
  const down = generateRandom({ count: 12, centroid: 66, ...base12, settings: { run: -1 }, rng: rng32(5) });
  ok(down.every((d, i) => i === 0 || d < down[i - 1]), 'run −1 = strictly descending');
}
// 6) Mid-slider run: more stepwise ascents than run 0 (aggregate over seeds).
{
  const ascents = (settings) => {
    let n = 0;
    for (let s = 1; s <= 20; s++) {
      const d = generateRandom({ count: 12, centroid: 66, ...base12, settings, rng: rng32(s) });
      for (let i = 1; i < d.length; i++) if (d[i] > d[i - 1]) n++;
    }
    return n;
  };
  ok(ascents({ run: 0.6 }) > ascents({ run: 0 }), 'run 0.6 produces more ascending motion than run 0');
}
// 7) Unique 0: repeats happen (aggregate over seeds).
{
  let dup = 0;
  for (let s = 1; s <= 20; s++) {
    const d = generateRandom({ count: 12, centroid: 66, ...base12, settings: { unique: 0 }, rng: rng32(s) });
    dup += 12 - new Set(d).size;
  }
  ok(dup > 0, `unique 0 allows reuse (${dup} repeats over 20 rolls)`);
}
// 8) Triad max: more adjacent harmonic triples than triad 0 (12-ET trad family).
{
  const chordKeys = new Set(chordsFor(12, ['trad']).map((t) => t.pcs.join(',')));
  const triples = (settings) => {
    let n = 0;
    for (let s = 1; s <= 20; s++) {
      const d = generateRandom({ count: 12, centroid: 66, ...base12, chordKeys, settings, rng: rng32(s) });
      for (let i = 2; i < d.length; i++) if (classifyTriad([d[i - 2], d[i - 1], d[i]], 12)) n++;
    }
    return n;
  };
  const hi = triples({ triad: 1 }), lo = triples({ triad: 0 });
  ok(hi > lo, `triad max yields more harmonic triples (${hi} vs ${lo})`);
}
// 9) 16-ET: works against a 16-EDO scale + bounds (Mavila mask, septimal keys).
{
  const b16 = degreeBounds('16-et');
  const p = { scaleId: 'mavila7', root: 0, edo: 16, bounds: b16 };
  const chordKeys = new Set(chordsFor(16, familiesFor(16)).map((t) => t.pcs.join(',')));
  const degs = generateRandom({ count: 16, centroid: 60, ...p, chordKeys, settings: { triad: 0.5 }, rng: rng32(11) });
  ok(degs.length === 16 && new Set(degs).size === 16, '16-ET: 16 unique degrees');
  ok(degs.every((d) => inScale('mavila7', 0, d, 16)), '16-ET: every degree in the Mavila mask');
  ok(degs.every((d) => d >= b16.min && d <= b16.max), '16-ET: degrees inside the A0..C8 bounds');
}
// 10) Tiny supply: count beyond the in-scale ladder still fills every column
// (uniqueness falls back to reuse when the ladder is exhausted).
{
  const tiny = { min: 60, max: 66 }; // 7 chromatic degrees
  const degs = generateRandom({ count: 12, centroid: 63, scaleId: 'chromatic', root: 0, edo: 12, bounds: tiny, settings: {}, rng: rng32(2) });
  ok(degs.length === 12, 'short ladder: still one degree per column');
  ok(new Set(degs).size === 7, `short ladder: all 7 available degrees used, rest reused`);
  ok(degs.every((d) => d >= 60 && d <= 66), 'short ladder: everything within bounds');
}
// 11) Defaults object sanity.
ok(RANDOM_DEFAULTS.unique === 1 && RANDOM_DEFAULTS.run === 0 && RANDOM_DEFAULTS.triad === 0, 'defaults: unique 1, run 0, triad 0');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

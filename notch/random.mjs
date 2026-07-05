// New Random generator: window placement, scale masking, uniqueness, runs, triads.
import { scaleWindow, generateRandom, applyDurationBias, applyAccentBias, RANDOM_DEFAULTS } from '../src/random.js';
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
ok(RANDOM_DEFAULTS.unique === 1 && RANDOM_DEFAULTS.run === 0 && RANDOM_DEFAULTS.triad === 0 && RANDOM_DEFAULTS.durBias === 0 && RANDOM_DEFAULTS.accentBias === 0,
  'defaults: unique 1, run 0, triad 0, durBias 0, accentBias 0');
ok(RANDOM_DEFAULTS.durSort === false && RANDOM_DEFAULTS.accentSort === false, 'defaults: bias mechanism = steer (durSort/accentSort false)');

// 12) applyDurationBias — re-pair pitches to positions by duration↔pitch rank.
{
  const degs = [67, 60, 64, 62];          // pitches in generated order
  const beats = [0.5, 2.0, 0.25, 1.0];    // col durations: pos1 longest, pos2 shortest

  // bias 0 = identity (preserves generated order)
  ok(JSON.stringify(applyDurationBias(degs, beats, 0)) === JSON.stringify(degs), 'durBias 0 = identity');

  // full Low: longest note (pos1, 2.0) gets the LOWEST pitch; shortest (pos2, 0.25) the highest
  const low = applyDurationBias(degs, beats, -1);
  ok(low.length === 4 && [...low].sort((a, b) => a - b).join() === [...degs].sort((a, b) => a - b).join(),
    'Low preserves the pitch multiset');
  ok(low[1] === Math.min(...degs), 'Low: longest note gets the lowest pitch');
  ok(low[2] === Math.max(...degs), 'Low: shortest note gets the highest pitch');

  // full High: longest gets highest, shortest gets lowest
  const high = applyDurationBias(degs, beats, 1);
  ok(high[1] === Math.max(...degs), 'High: longest note gets the highest pitch');
  ok(high[2] === Math.min(...degs), 'High: shortest note gets the lowest pitch');

  // uniform durations → no effect regardless of bias
  ok(JSON.stringify(applyDurationBias(degs, [1, 1, 1, 1], -1)) === JSON.stringify(degs), 'uniform rhythm = no effect');

  // two long + two short: Low pulls the long pair below the short pair.
  const d2 = [67, 60, 65, 62], b2 = [2, 0.5, 2, 0.5]; // pos0,2 long; pos1,3 short
  const lo2 = applyDurationBias(d2, b2, -1);
  ok(lo2[0] < lo2[1] && lo2[2] < lo2[3], 'Low: each long note sits below its short-note neighbours');
  ok(new Set([lo2[0], lo2[2]]).size === 2 && Math.max(lo2[0], lo2[2]) < Math.min(lo2[1], lo2[3]), 'Low: both long notes below both short notes');

  // Bug fix (2026-07-04): within a duration TIE-GROUP the band's pitches follow the
  // GENERATED order, not a sorted ascending ramp. Here the two long notes' generated
  // pitches descend by position (64 > 60), so after full Low the long group must still
  // descend by position — the old position-index tie-break would flip it to ascending.
  const gd = [64, 60, 67, 62], gb = [2, 2, 0.5, 0.5]; // pos0,1 long (desc); pos2,3 short
  const gout = applyDurationBias(gd, gb, -1);
  ok(gout[0] > gout[1], 'Low: long tie-group keeps generated order (descending), not re-sorted ascending');
  ok(Math.max(gout[0], gout[1]) < Math.min(gout[2], gout[3]), 'Low: both long notes still below both short notes');
}

// 13) applyAccentBias — re-pair the PITCHES to positions by accent↔pitch (moves the
// notes, not the accents; the groove stays put). Accents: 0 normal, 1 accent (loudest),
// 2 ghost (softest) → intensity ghost < normal < accent.
{
  const degs = [67, 60, 64, 62];  // pitches in generated order
  const accs = [1, 0, 2, 0];      // fixed groove: pos0 accent (loudest), pos2 ghost (softest)
  const multiset = (a) => [...a].sort((x, y) => x - y).join();

  ok(JSON.stringify(applyAccentBias(degs, accs, 0)) === JSON.stringify(degs), 'accentBias 0 = identity (notes unchanged)');

  // full High: the loudest-accented column (pos0) gets the highest pitch; the ghost (pos2) the lowest.
  const high = applyAccentBias(degs, accs, 1);
  ok(multiset(high) === multiset(degs), 'High preserves the pitch multiset');
  ok(high[0] === Math.max(...degs), 'High: loudest-accented column gets the highest pitch');
  ok(high[2] === Math.min(...degs), 'High: the ghost column gets the lowest pitch');

  // full Low: loudest accent gets the lowest pitch, ghost the highest.
  const low = applyAccentBias(degs, accs, -1);
  ok(multiset(low) === multiset(degs), 'Low preserves the pitch multiset');
  ok(low[0] === Math.min(...degs), 'Low: loudest-accented column gets the lowest pitch');
  ok(low[2] === Math.max(...degs), 'Low: the ghost column gets the highest pitch');

  // uniform accents → no gradient, no effect regardless of bias.
  ok(JSON.stringify(applyAccentBias(degs, [0, 0, 0, 0], 1)) === JSON.stringify(degs), 'uniform accents = no effect');

  // ghost ranks SOFTER than normal: over three columns ghost/normal/accent, High deals the
  // pitches low→high in that loudness order (ghost gets the lowest, accent the highest).
  const d3 = [64, 60, 62], a3 = [2, 0, 1]; // pos0 ghost, pos1 normal, pos2 accent
  const h3 = applyAccentBias(d3, a3, 1);
  ok(h3[0] === Math.min(...d3) && h3[2] === Math.max(...d3), 'High ranks loudness ghost<normal<accent: ghost→lowest, accent→highest');
}

// 14) Generator bias (STEER via the `bias` param) — bake the pull into generation so
// Run/Triad contour survives, unlike the sort re-pairing.
{
  const beats = [2, 0.25, 1, 0.5];   // pos0 longest, pos1 shortest
  const flat = [0, 0, 0, 0];         // uniform accents → no accent pull
  const avgAt = (durBias) => {
    const sum = [0, 0, 0, 0];
    for (let s = 1; s <= 60; s++) {
      const d = generateRandom({
        count: 4, centroid: 66, ...base12, chordKeys: new Set(),
        settings: { unique: 1, run: 0, triad: 0 },
        bias: { durBias, accentBias: 0, beats, accents: flat }, rng: rng32(s),
      });
      for (let i = 0; i < 4; i++) sum[i] += d[i];
    }
    return sum.map((x) => x / 60);
  };
  const hi = avgAt(1), lo = avgAt(-1), off = avgAt(0);
  ok(hi[0] > hi[1], 'steer High: the longest column averages a higher pitch than the shortest');
  ok(lo[0] < lo[1], 'steer Low: the longest column averages a lower pitch than the shortest');
  ok(Math.abs(off[0] - off[1]) < Math.abs(hi[0] - hi[1]), 'bias 0 = far weaker duration↔pitch correlation than full steer');
}
{
  // Contour survives: a full run stays a run under steer bias (run picks are deterministic;
  // bias only weights the non-run choices) — the whole point vs. the sort mechanism.
  const beats = Array.from({ length: 12 }, (_, i) => [2, 0.25, 1, 0.5][i % 4]);
  const flat = new Array(12).fill(0);
  const d = generateRandom({
    count: 12, centroid: 66, ...base12,
    settings: { unique: 1, run: 1, triad: 0 },
    bias: { durBias: -1, accentBias: 0, beats, accents: flat }, rng: rng32(9),
  });
  ok(d.every((x, i) => i === 0 || x > d[i - 1]), 'steer bias leaves a full run intact (still strictly ascending)');
}
{
  // Stochastic even at max bias (unlike Run): several arrangements remain possible.
  const beats = [2, 0.25, 1, 0.5];
  const flat = [0, 0, 0, 0];
  const outs = new Set();
  for (let s = 1; s <= 40; s++) {
    const d = generateRandom({
      count: 4, centroid: 66, ...base12, chordKeys: new Set(),
      settings: { unique: 0, run: 0, triad: 0 },
      bias: { durBias: 1, accentBias: 0, beats, accents: flat }, rng: rng32(s),
    });
    outs.add(d.join(','));
  }
  ok(outs.size > 1, 'max steer bias is still stochastic (not one fixed output)');
}
{
  // Triad + max bias: chord character survives AND multiple distinct rolls remain (the
  // user's requirement — bias never collapses it to a single permutation).
  const chordKeys = new Set(chordsFor(12, ['trad']).map((t) => t.pcs.join(',')));
  const beats = Array.from({ length: 12 }, (_, i) => [2, 0.25, 1, 0.5][i % 4]);
  const flat = new Array(12).fill(0);
  const outs = new Set();
  let triples = 0;
  for (let s = 1; s <= 20; s++) {
    const d = generateRandom({
      count: 12, centroid: 66, ...base12, chordKeys,
      settings: { unique: 1, run: 0, triad: 1 },
      bias: { durBias: -1, accentBias: 0, beats, accents: flat }, rng: rng32(s),
    });
    outs.add(d.join(','));
    for (let i = 2; i < d.length; i++) if (classifyTriad([d[i - 2], d[i - 1], d[i]], 12)) triples++;
  }
  ok(triples > 0, 'triad character survives steer bias (harmonic triples still form)');
  ok(outs.size > 1, 'triad + max bias still yields multiple distinct arrangements');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

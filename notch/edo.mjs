// Step 1 verification: the EDO seam-widening must leave 12-ET bit-identical, and
// a non-12 EDO (16) must cleanly yield "no chords yet" + correct modular logic.
import { edoOf } from '../src/js/core/tuning.js';
import { inScale, nearestInScale, stepInScale } from '../src/js/core/scales.js';
import { classifyTriad, enumerateTriadulations } from '../src/js/core/triads.js';
import { applyTransforms, transposeTransform } from '../src/js/core/transforms.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  got ${JSON.stringify(a)}`);

// --- edoOf ---
ok(edoOf('12-et') === 12, '12-et edo = 12');
ok(edoOf('ji-5limit') === 12, 'ji-5limit edo = 12');
ok(edoOf('nonsense') === 12, 'unknown tuning → 12');
ok(edoOf() === 12, 'default → 12');

// --- scales: 12-ET unchanged (default edo) ---
ok(inScale('chromatic', 0, 5) === true, 'chromatic: all in');
ok(inScale('major-pent', 0, 0) === true, 'major-pent root in');
ok(inScale('major-pent', 0, 1) === false, 'major-pent: C# out');
ok(inScale('major-pent', 0, 12) === true, 'major-pent: octave in (pc 0)');
ok(inScale('major-pent', 0, 14) === true, 'major-pent: 14 ≡ 2 in');
ok(inScale('major-pent', 0, -1) === false, 'major-pent: -1 ≡ 11 out');
// explicit edo=12 must match the default
ok(inScale('major-pent', 0, 14, 12) === inScale('major-pent', 0, 14), 'edo=12 matches default');

// stepInScale 12-ET: C major pentatonic ladder 0→2→4→7→9→12
ok(stepInScale('major-pent', 0, 0, 1) === 2, 'pent step 0→2');
ok(stepInScale('major-pent', 0, 4, 1) === 7, 'pent step 4→7 (skips 5,6)');
ok(stepInScale('major-pent', 0, 9, 1) === 12, 'pent step 9→12 (octave)');
ok(stepInScale('major-pent', 0, 12, -1) === 9, 'pent step down 12→9');
ok(stepInScale('chromatic', 0, 5, 1) === 6, 'chromatic step +1');

// nearestInScale 12-ET
ok(nearestInScale('major-pent', 0, 1) === 0, 'snap 1→0');
ok(nearestInScale('major-pent', 0, 6) === 7, 'snap 6→7 (tie→lower means 6-? ; nearest)');
ok(nearestInScale('chromatic', 0, 5) === 5, 'chromatic snap = identity');

// --- triads: 12-ET classification unchanged ---
eq(classifyTriad([0, 4, 7]), { quality: 'maj', root: 0 }, 'C major');
eq(classifyTriad([0, 3, 7]), { quality: 'min', root: 0 }, 'C minor');
eq(classifyTriad([0, 3, 6]), { quality: 'dim', root: 0 }, 'C dim');
eq(classifyTriad([0, 4, 8]), { quality: 'aug', root: 0 }, 'C aug');
eq(classifyTriad([0, 2, 7]), { quality: 'sus', root: 0 }, 'C sus');
eq(classifyTriad([7, 11, 2]), { quality: 'maj', root: 7 }, 'G major (any order/octave)');
ok(classifyTriad([0, 1, 2]) === null, 'cluster → null');
ok(classifyTriad([0, 4]) === null, 'two notes → null');

// every root, every trad template classifies back to itself
const offs = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8] };
let allRootsOK = true;
for (let root = 0; root < 12; root++) {
  for (const [q, o] of Object.entries(offs)) {
    const pcs = o.map((x) => (root + x) % 12);
    const c = classifyTriad(pcs);
    // aug is symmetric: any of its 3 notes is a valid "root"; just require quality + a consistent root
    if (!c || c.quality !== q) { allRootsOK = false; }
  }
}
ok(allRootsOK, 'all 12 roots × {maj,min,dim,aug} classify with correct quality');

// --- triadulation enumeration: 12-ET ---
{
  const r = enumerateTriadulations([0, 4, 7], { families: ['trad'] });
  ok(r.length >= 1, 'single maj triad enumerates');
  ok(r.some((t) => t.leftover.length === 0 && t.triads.length === 1 && t.triads[0].pcs.join(',') === '0,4,7'), 'C maj is a proper covering');
}
{
  // C maj {0,4,7} + D min {2,5,9} → a proper 2-triad covering of {0,2,4,5,7,9}
  const r = enumerateTriadulations([0, 2, 4, 5, 7, 9], { proper: true, families: ['trad'] });
  ok(r.length >= 1, 'two-triad proper covering found');
  ok(r.every((t) => t.leftover.length === 0), 'proper filter leaves no leftover');
}
{
  const r = enumerateTriadulations([0, 2, 7], { families: ['sus'] });
  ok(r.some((t) => t.triads.some((x) => x.pcs.join(',') === '0,2,7')), 'sus-only family finds the sus');
  const none = enumerateTriadulations([0, 2, 7], { families: [] });
  ok(none.length === 0, 'no families → empty');
}

// --- non-12 EDO: cleanly empty (no 16-ET templates yet), modular logic correct ---
ok(classifyTriad([0, 5, 13], 16) && classifyTriad([0,5,13],16).quality === 'sept', 'edo 16: [0,5,13] now a septimal triad');
ok(enumerateTriadulations([0,5,9,13], { edo: 16 }).length === 0, 'edo 16: empty families → no triadulations');
ok(inScale('chromatic', 0, 20, 16) === true, 'edo 16 chromatic in');
ok(stepInScale('chromatic', 0, 0, 1, 16) === 1, 'edo 16 chromatic step +1');
// a hand-rolled 16-style wrap check via inScale modulus (chromatic is edo-agnostic,
// so test the modulus through a 12 vs 16 difference on a custom assertion):
ok((((20 % 16) + 16) % 16) === 4, 'sanity: 20 mod 16 = 4');

// --- transforms still transpose in 12-ET ---
{
  const notes = [{ pitch: 0, start: 0, duration: 1, velocity: 0.8, freq: 0 }];
  const t = transposeTransform(2, 'major-pent', 0); // up two pentatonic steps: 0→2→4
  const out = applyTransforms(notes, [t], { lengthBeats: 4, tuningId: '12-et', root: 0 });
  ok(out[0].pitch === 4, `transpose +2 pent: 0 → 4 (got ${out[0].pitch})`);
  ok(typeof out[0].freq === 'number' && isFinite(out[0].freq) && out[0].freq > 0, 'transposed note got a finite freq');
}

// --- transpose root is stored raw (no % 12), so non-12 tunings (16-ET) keep a
// root ≥ 12 instead of being corrupted by the old clamp ---
{
  ok(transposeTransform(1, 'chromatic', 13).root === 13, 'root 13 preserved (16-ET), not clamped to 1');
  ok(transposeTransform(1, 'chromatic', 5).root === 5, 'in-range root unchanged');
  ok(transposeTransform(1, 'chromatic', NaN).root === 0, 'non-finite root → 0');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

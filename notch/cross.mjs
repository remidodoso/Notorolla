// The "cross" tuning: a non-octave JI scale (m3=6/5 & P4=4/3, both directions from
// middle C), comma-pairs kept, degree = index into the sorted pitch list. Validates
// the generator, the middle-C anchor at degree 60, nearest-12-ET+cents labels, the
// A0..C8 range resolution, and the equave-less flags. See future_directions.md §15.
import { tuningFreq, degreeToName, degreeBounds, edoOf, equaveOf, hasEquave, LOW_HZ, HIGH_HZ } from '../src/js/core/tuning.js';
import { noteToFreq } from '../src/js/core/model.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, eps, m) => ok(Math.abs(a - b) < eps, `${m}  got ${a}, want ~${b}`);
const cents = (a, b) => 1200 * Math.log2(a / b);

const C = noteToFreq(60); // middle C

// --- anchor: middle C is degree 60, exactly noteToFreq(60) ---
near(tuningFreq(60, 'cross'), C, 1e-6, 'degree 60 = middle C');
ok(degreeToName(60, 'cross') === 'C4', `label of degree 60 is C4 (got ${degreeToName(60, 'cross')})`);

// --- monotonic in degree across the navigable A0..C8 band (outside it, freq clamps
// to the list endpoints by design, so only assert strict monotonicity in-range) ---
{
  const b = degreeBounds('cross');
  let mono = true;
  for (let d = b.min; d < b.max; d++) if (tuningFreq(d + 1, 'cross') <= tuningFreq(d, 'cross')) mono = false;
  ok(mono, 'freq strictly increases with degree across A0..C8');
}

// --- the two generators are present as some degree (6/5 up, 4/3 up, and both down) ---
const has = (ratio) => {
  const target = C * ratio;
  for (let d = 0; d < 140; d++) if (Math.abs(cents(tuningFreq(d, 'cross'), target)) < 0.5) return true;
  return false;
};
ok(has(6 / 5), 'contains a just minor third above C (6/5, ~Eb)');
ok(has(4 / 3), 'contains a just perfect fourth above C (4/3, F)');
ok(has(5 / 6), 'contains a minor third BELOW C (both directions)');
ok(has(3 / 4), 'contains a perfect fourth BELOW C (both directions)');

// --- the Eb (6/5 = 315.6¢) labels as D#4 +16 (nearest 12-ET + cents) ---
{
  let ebDeg = null;
  for (let d = 60; d < 80; d++) if (Math.abs(cents(tuningFreq(d, 'cross'), C * 6 / 5)) < 0.5) { ebDeg = d; break; }
  ok(ebDeg != null, 'found the 6/5 degree');
  ok(degreeToName(ebDeg, 'cross') === 'D#4 +16', `6/5 labels D#4 +16 (got ${degreeToName(ebDeg, 'cross')})`);
}

// --- comma-pairs are KEPT: some adjacent degrees are a small (5..90¢) step apart ---
{
  let tightPairs = 0;
  const b = degreeBounds('cross');
  for (let d = b.min; d < b.max; d++) {
    const gap = cents(tuningFreq(d + 1, 'cross'), tuningFreq(d, 'cross'));
    if (gap > 5 && gap < 90) tightPairs++;
  }
  ok(tightPairs >= 3, `retained comma-pairs present (${tightPairs} sub-90¢ steps in A0..C8)`);
}

// --- range resolves to the A0..C8 band (nearest degree in pitch to each edge) ---
{
  const b = degreeBounds('cross');
  ok(b.min < b.max, 'bounds ordered');
  ok(Math.abs(cents(tuningFreq(b.min, 'cross'), LOW_HZ)) < 200, 'low bound within ~200¢ of A0');
  ok(Math.abs(cents(tuningFreq(b.max, 'cross'), HIGH_HZ)) < 200, 'high bound within ~200¢ of C8');
  ok((b.max - b.min) > 30, `spans a full keyboard of degrees (${b.max - b.min})`);
}

// --- it does NOT close the octave: no degree is exactly 2×C (an octave) ---
{
  let exactOctave = false;
  for (let d = 60; d < 120; d++) if (Math.abs(cents(tuningFreq(d, 'cross'), 2 * C)) < 0.5) exactOctave = true;
  ok(!exactOctave, 'no degree lands exactly on the 2:1 octave (open tuning)');
}

// --- equave-less flags ---
ok(hasEquave('12-et') === true, '12-et has an equave');
ok(hasEquave('16-et') === true, '16-et has an equave');
ok(hasEquave('cross') === false, 'cross has NO equave');
ok(equaveOf('cross') === null, 'cross equave = null');
ok(equaveOf('16-et') === 16, '16-et equave = 16');
ok(edoOf('cross') > 30, 'cross edo = degree count (safe modulus, no false pitch-classes)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

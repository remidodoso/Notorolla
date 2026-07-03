// Per-tuning navigable range = the A0..C8 piano band → nearest degrees per EDO.
import { degreeBounds, tuningFreq, degreeToName, LOW_HZ, HIGH_HZ } from '../src/tuning.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e) => Math.abs(a - b) <= e;

ok(near(LOW_HZ, 27.5, 1e-9), 'LOW_HZ = A0 = 27.5');
ok(near(HIGH_HZ, 4186.0, 0.1), 'HIGH_HZ = C8 ≈ 4186');

// 12-ET = exactly the 88-key piano: A0 (MIDI 21) .. C8 (MIDI 108).
{
  const b = degreeBounds('12-et');
  ok(b.min === 21 && b.max === 108, `12-ET bounds = 21..108 (got ${b.min}..${b.max})`);
  ok(degreeToName(21, '12-et') === 'A0', '12-ET floor names A0');
  ok(degreeToName(108, '12-et') === 'C8', '12-ET ceil names C8');
  ok(near(tuningFreq(21, '12-et'), 27.5, 0.01), '12-ET floor ≈ 27.5 Hz');
}

// 16-ET: A0-closest is degree 8 ("80", ~27.48 Hz); C8-closest is degree 124 ("c7").
{
  const b = degreeBounds('16-et');
  ok(b.min === 8 && b.max === 124, `16-ET bounds = 8..124 (got ${b.min}..${b.max})`);
  ok(degreeToName(8, '16-et') === '80', '16-ET floor names "80"');
  ok(degreeToName(124, '16-et') === 'c7', '16-ET ceil names "c7"');
  ok(near(tuningFreq(8, '16-et'), 27.5, 0.05), `16-ET floor ≈ 27.5 Hz (got ${tuningFreq(8, '16-et').toFixed(2)})`);
  // The whole point: the note the user needed, "71" (degree 23), is now in range.
  ok(degreeToName(23, '16-et') === '71' && 23 >= b.min, '"71" (degree 23) is within range');
  ok(degreeToName(16, '16-et') === '01' && 16 >= b.min, '"01" (degree 16) is within range');
  // Closest-degree (not strict ≥): "80" at 27.48 Hz wins over "90" at 28.7 Hz.
  ok(b.min === 8, 'closest-degree keeps "80" (1¢ under A0), not "90"');
  // Span grew from the old 84 degrees to ~7.25 octaves.
  ok((b.max - b.min) / 16 > 7, `16-ET span > 7 octaves (got ${((b.max - b.min) / 16).toFixed(2)})`);
}

// Memoized: same object back for repeated calls.
ok(degreeBounds('16-et') === degreeBounds('16-et'), 'bounds memoized per tuning');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

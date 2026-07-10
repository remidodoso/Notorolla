// Detune: the per-tile detune transform (uniform sounding-pitch shift in cents)
// + the One True Order (canonical transform ordering) it landed with.
import {
  detuneTransform, transposeTransform, reverseTransform, applyTransforms,
  normalizeTransforms, setTileDetune, setTileTranspose, setTileReverse,
  findDetune, describeTransform, transformKindLabel, DETUNE_MAX,
} from '../src/js/core/transforms.js';
import { tuningFreq } from '../src/js/core/tuning.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

const CTX = { lengthBeats: 4, tuningId: '12-et', root: 0 };
const mkNotes = () => [
  { pitch: 60, start: 0, duration: 1, velocity: 0.78, freq: tuningFreq(60, '12-et', 0) },
  { pitch: 64, start: 1, duration: 2, velocity: 1.0, freq: tuningFreq(64, '12-et', 0) },
];

// 1) Constructor: whole cents, clamped ±DETUNE_MAX.
{
  ok(detuneTransform(37.4).cents === 37, 'cents rounded to whole');
  ok(detuneTransform(500).cents === DETUNE_MAX && detuneTransform(-500).cents === -DETUNE_MAX, 'cents clamped ±100');
  ok(detuneTransform('junk').cents === 0, 'junk → 0');
}

// 2) Apply: freq multiplied, cents stamped, everything else untouched.
{
  const t = detuneTransform(50);
  const src = mkNotes();
  const out = applyTransforms(src, [t], CTX);
  const r = Math.pow(2, 50 / 1200);
  ok(near(out[0].freq, src[0].freq * r) && near(out[1].freq, src[1].freq * r), 'freq × 2^(cents/1200)');
  ok(out[0].detune === 50 && out[1].detune === 50, 'cents stamped on the note (n.detune)');
  ok(out[0].pitch === 60 && out[0].start === 0 && out[0].duration === 1 && out[0].velocity === 0.78,
    'pitch/start/duration/velocity untouched');
  ok(src[0].detune === undefined, 'source notes not mutated');
  const down = applyTransforms(mkNotes(), [detuneTransform(-100)], CTX);
  ok(near(down[0].freq, mkNotes()[0].freq * Math.pow(2, -100 / 1200)), 'negative cents shift down');
}

// 3) Commutation with transpose: canonical order [transpose, detune] equals the
// musical intent regardless of how the caller ordered the array — because
// normalizeTransforms canonicalizes. (Raw applyTransforms with detune FIRST
// would be clobbered by transpose's freq re-resolve; the canonical order is the
// guarantee, so pin it.)
{
  const T = transposeTransform(2, 'chromatic', 0);
  const D = detuneTransform(30);
  const a = applyTransforms(mkNotes(), normalizeTransforms([T, D]), CTX);
  const b = applyTransforms(mkNotes(), normalizeTransforms([D, T]), CTX);
  ok(a.length === b.length && a.every((n, i) => near(n.freq, b[i].freq) && n.pitch === b[i].pitch),
    'normalize makes [T,D] ≡ [D,T] (detune survives transpose in either input order)');
  const expect = tuningFreq(62, '12-et', 0) * Math.pow(2, 30 / 1200);
  ok(near(a[0].freq, expect), 'transposed-then-detuned freq is exactly right');
}

// 4) Commutation with reverse (trivially different fields, but pin it).
{
  const D = detuneTransform(-20);
  const R = reverseTransform();
  const a = applyTransforms(mkNotes(), normalizeTransforms([R, D]), CTX);
  const b = applyTransforms(mkNotes(), normalizeTransforms([D, R]), CTX);
  ok(a.every((n, i) => near(n.freq, b[i].freq) && near(n.start, b[i].start)), 'reverse and detune commute');
  ok(near(a[0].start, 4 - 0 - 1), 'reverse still retrogrades');
}

// 5) normalizeTransforms: canonical order, one-of-each, junk dropped.
{
  const out = normalizeTransforms([
    { type: 'detune', cents: 15 },
    { type: 'reverse' },
    { type: 'transpose', steps: 3, scaleId: 'chromatic', root: 0 },
  ]);
  ok(out.map((t) => t.type).join(',') === 'transpose,reverse,detune', 'emits the One True Order');
  const dedupe = normalizeTransforms([{ type: 'detune', cents: 10 }, { type: 'detune', cents: -40 }]);
  ok(dedupe.length === 1 && dedupe[0].cents === -40, 'a later detune replaces the earlier one');
  ok(normalizeTransforms([{ type: 'detune', cents: 0 }]) === undefined, 'detune 0 dropped');
  ok(normalizeTransforms([{ type: 'detune', cents: 'x' }]) === undefined, 'junk cents dropped');
  ok(normalizeTransforms([{ type: 'detune', cents: 999 }])[0].cents === DETUNE_MAX, 'loaded cents clamped');
}

// 6) setTileDetune: set / replace / clear, canonical order maintained.
{
  const tile = {};
  setTileDetune(tile, 25);
  ok(findDetune(tile.transforms).cents === 25, 'set');
  setTileDetune(tile, -60);
  ok(tile.transforms.length === 1 && findDetune(tile.transforms).cents === -60, 'replace, never accumulate');
  setTileReverse(tile, true);
  setTileTranspose(tile, 2, 'chromatic', 0);
  ok(tile.transforms.map((t) => t.type).join(',') === 'transpose,reverse,detune',
    'set-helpers keep the canonical order whatever the edit sequence');
  setTileDetune(tile, 0);
  ok(!findDetune(tile.transforms) && tile.transforms.length === 2, 'cents 0 clears just the detune');
}

// 7) Labels.
{
  const t = detuneTransform(37);
  ok(transformKindLabel(t).kind === 'detune' && transformKindLabel(t).label === '+37¢', 'swath label');
  ok(describeTransform(detuneTransform(-12)) === 'Detune −12 ¢', 'chip description');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

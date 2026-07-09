// Insert reverb: config normalization, decay-length model, and lane persistence.
import { defaultReverb, normalizeReverb, reverbSeconds, REVERB_MODES, MAX_PREDELAY, DEFAULT_REVERB } from '../src/js/audio/reverb.js';
import { Arrangement } from '../src/js/core/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// --- defaults ---------------------------------------------------------------
ok(DEFAULT_REVERB.mode === 'gated', 'default mode is GATED (user: not a boring room)');
ok(DEFAULT_REVERB.on === false, 'default is off (an insert you opt into)');
ok(DEFAULT_REVERB.wet >= 0.4, 'default wet is moderately pronounced');
ok(defaultReverb() !== DEFAULT_REVERB, 'defaultReverb mints a copy');

// --- normalizeReverb --------------------------------------------------------
{
  const r = normalizeReverb(null);
  ok(JSON.stringify(r) === JSON.stringify(defaultReverb()), 'null → full defaults');
}
{
  const r = normalizeReverb({ on: 1, mode: 'hall', size: 2, wet: -1, damp: 0.5, predelay: 9 });
  ok(r.on === true && r.mode === 'hall', 'coerces on + keeps a known mode');
  ok(r.size === 1 && r.wet === 0 && r.damp === 0.5, 'clamps size/wet/damp to 0..1');
  ok(r.predelay === MAX_PREDELAY, 'clamps predelay to the max');
}
{
  const r = normalizeReverb({ mode: 'shimmer', size: NaN });
  ok(r.mode === 'gated' && r.size === DEFAULT_REVERB.size, 'unknown mode / NaN → defaults');
}

// --- reverbSeconds ----------------------------------------------------------
for (const m of REVERB_MODES) {
  const lo = reverbSeconds({ mode: m.id, size: 0 });
  const hi = reverbSeconds({ mode: m.id, size: 1 });
  ok(lo > 0 && hi > lo, `${m.id}: decay grows with size (${lo.toFixed(2)}→${hi.toFixed(2)}s)`);
}
ok(reverbSeconds({ mode: 'gated', size: 1 }) <= 0.35, 'gated stays a GATE (≤ ~300 ms), not a wash');
ok(reverbSeconds({ mode: 'ambience', size: 1 }) <= 0.2, 'ambience stays early-reflections short');
ok(reverbSeconds({ mode: 'hall', size: 1 }) >= 3, 'hall reaches a real tail');

// --- lane persistence -------------------------------------------------------
{
  const a = new Arrangement();
  ok(a.lanes[0].reverb && a.lanes[0].reverb.mode === 'gated', 'new lanes carry the reverb field');
  a.lanes[0].reverb = { on: true, mode: 'spring', size: 0.7, wet: 0.6, damp: 0.2, predelay: 0.04 };
  const b = Arrangement.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  const r = b.lanes[0].reverb;
  ok(r.on === true && r.mode === 'spring' && r.size === 0.7 && r.predelay === 0.04,
    'reverb survives the save/load round-trip');
  a.resetLane(0);
  ok(a.lanes[0].reverb.on === false, 'lane reset restores the default (off)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

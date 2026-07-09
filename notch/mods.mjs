// Per-lane playback modulators: waveforms, normalization, target filtering,
// position-space application, time anchoring, and the engine seam.
import { modWave, normalizeMod, normalizeModsByKind, modTargetsFor, applyMods, modsActive, MOD_SLOTS, DEFAULT_MOD } from '../src/js/audio/mods.js';
import { normalizePatch, paramsFor, toPos } from '../src/js/audio/instrument.js';
import { AudioEngine } from '../src/js/audio/audio.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// 1) Waveforms: phase 0 = center-crossing, rising; all within [-1, 1].
{
  ok(near(modWave('sin', 0, 1, 0), 0) && modWave('sin', 0.1, 1, 0) > 0, 'sin: starts 0, rising');
  ok(near(modWave('tri', 0, 1, 0), 0) && modWave('tri', 0.1, 1, 0) > 0, 'tri: starts 0, rising');
  ok(near(modWave('rampup', 0, 1, 0), 0) && modWave('rampup', 0.2, 1, 0) > 0, 'ramp↑: starts 0, rising');
  ok(near(modWave('rampdown', 0.2, 1, 0), -modWave('rampup', 0.2, 1, 0)), 'ramp↓ = −ramp↑');
  ok(near(modWave('sin', 0, 1, 90), 1), 'phase 90° puts sine at +1');
  ok(near(modWave('sin', 0.25, 1, 0), modWave('sin', 0, 1, 90)), 'phase rotates the cycle');
  let inRange = true;
  for (const sh of ['sin', 'tri', 'rampup', 'rampdown', 'walk']) {
    for (let i = 0; i < 500; i++) {
      const v = modWave(sh, i * 0.173, 0.31, 45, 5);
      if (!(v >= -1.0001 && v <= 1.0001)) inRange = false;
    }
  }
  ok(inRange, 'every shape stays within [-1, 1] (walk bounded by construction)');
}
// 2) Walk: deterministic per seed, decorrelated across seeds, actually moves.
{
  const a1 = Array.from({ length: 50 }, (_, i) => modWave('walk', i * 0.7, 0.2, 0, 3));
  const a2 = Array.from({ length: 50 }, (_, i) => modWave('walk', i * 0.7, 0.2, 0, 3));
  const b = Array.from({ length: 50 }, (_, i) => modWave('walk', i * 0.7, 0.2, 0, 4));
  ok(a1.every((v, i) => v === a2[i]), 'walk: same seed → identical values (deterministic)');
  ok(a1.some((v, i) => Math.abs(v - b[i]) > 0.05), 'walk: different seed → different path');
  ok(new Set(a1.map((v) => v.toFixed(3))).size > 10, 'walk: wanders (not constant)');
}
// 3) Normalization: shapes/clamps/slot count; unknown kinds preserved.
{
  const m = normalizeMod({ on: 1, shape: 'walk', target: 'cutoff', amount: 7, rate: 99, phase: -5, loop: 'yes' });
  ok(m.on === true && m.shape === 'walk' && m.amount === 1 && m.rate === 1 && m.phase === 0 && m.loop === true, 'normalizeMod clamps + coerces');
  ok(normalizeMod({ shape: 'zigzag' }).shape === 'sin', 'unknown shape → sin');
  const map = normalizeModsByKind({ vesperia: [{ on: true }], futurekind: [{}, {}, {}] });
  ok(map.vesperia.length === MOD_SLOTS && map.vesperia[1].on === false, 'per-kind entries padded to MOD_SLOTS');
  ok(map.futurekind.length === MOD_SLOTS, 'unknown kind preserved (forward-safe)');
}
// 4) Targets: numeric params only — no bool/sel/stepped.
{
  const tervik = modTargetsFor('tervik').map((s) => s.key);
  ok(!tervik.includes('algo'), 'tervik: algo (select) excluded');
  ok(!tervik.includes('coarse1'), 'tervik: coarse (stepped) excluded');
  ok(!tervik.includes('follow2'), 'tervik: follow (bool) excluded');
  ok(tervik.includes('fine1') && tervik.includes('feedback'), 'tervik: fine + feedback included');
  ok(!modTargetsFor('nayumi').some((s) => s.key === 'vowel'), 'nayumi: vowel (select) excluded');
}
// 5) applyMods: position-space math, stacking, clamping, anchor choice, purity.
{
  const base = normalizePatch({ kind: 'vesperia' });
  const mod = (over) => ({ ...DEFAULT_MOD, on: true, target: 'reso', amount: 0.5, shape: 'sin', phase: 90, rate: 1, ...over });
  const spec = paramsFor('vesperia').find((s) => s.key === 'reso');

  // phase 90° sine at t=0 → wave +1 → pos moves by exactly +amount.
  const p1 = applyMods(base, [mod(), null], 0, 0, 1);
  ok(near(toPos(spec, p1.reso), Math.min(1, toPos(spec, base.reso) + 0.5), 1e-9), 'offset = amount in slider-position space');
  ok(p1 !== base && base.reso === normalizePatch({ kind: 'vesperia' }).reso, 'base patch untouched (pure copy)');

  // wave 0 (phase 0, t 0) → value unchanged.
  const p0 = applyMods(base, [mod({ phase: 0 })], 0, 0, 1);
  ok(near(p0.reso, base.reso, 1e-9), 'zero wave → parameter unchanged');

  // Two mods on the same target stack in position space.
  const p2 = applyMods(base, [mod({ amount: 0.2 }), mod({ amount: 0.3 })], 0, 0, 1);
  ok(near(toPos(spec, p2.reso), toPos(spec, base.reso) + 0.5, 1e-9), 'two mods on one target add before the clamp');

  // Clamp at the top of the range.
  const p3 = applyMods(base, [mod({ amount: 1 }), mod({ amount: 1 })], 0, 0, 1);
  ok(near(p3.reso, spec.max, 1e-9), 'summed offsets clamp at the slider end');

  // The loop flag picks the ruler anchor over the elapsed anchor.
  const el = applyMods(base, [mod({ loop: false, phase: 0, rate: 0.25 })], 1, 0, 1); // elapsed 1 s → wave sin(π/2)=1
  const ru = applyMods(base, [mod({ loop: true, phase: 0, rate: 0.25 })], 1, 0, 1);  // ruler 0 s → wave 0
  ok(el.reso > base.reso + 1 && near(ru.reso, base.reso, 1e-9), 'loop flag: ruler anchor (t=0) vs elapsed (t=1)');

  // Off / bad target / non-numeric target are all no-ops.
  ok(applyMods(base, [mod({ on: false })], 1, 1, 1) === base, 'disabled mod → same patch object back');
  ok(applyMods(base, [mod({ target: 'nosuch' })], 1, 1, 1) === base, 'unknown target → no-op');
  const tv = normalizePatch({ kind: 'tervik' });
  ok(applyMods(tv, [mod({ target: 'algo' })], 1, 1, 1) === tv, 'select target → no-op');
}
// 6) modsActive: needs an enabled mod whose target exists on the kind.
{
  const on = { vesperia: [{ ...DEFAULT_MOD, on: true, target: 'cutoff' }, { ...DEFAULT_MOD }] };
  ok(modsActive(on, 'vesperia') === true, 'active: enabled + valid target');
  ok(modsActive(on, 'tervik') === false, 'inactive for another kind');
  ok(modsActive({ vesperia: [{ ...DEFAULT_MOD, on: true, target: '' }] }, 'vesperia') === false, 'no target → inactive');
  ok(modsActive({}, 'vesperia') === false, 'empty map → inactive');
}
// 7) Engine seam: playNote builds the voice from the modded patch (reso → tone.Q).
{
  function param(v = 0) { return { value: v, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} }; }
  function node(extra = {}) { return { connect() {}, disconnect() {}, start() {}, stop() {}, ...extra }; }
  const build = () => {
    const biquads = [];
    const ctx = {
      currentTime: 0, sampleRate: 44100,
      createGain: () => node({ gain: param(1) }),
      createOscillator: () => node({ type: 'sine', frequency: param(0), detune: param(0), setPeriodicWave() {} }),
      createBiquadFilter: () => { const n = node({ type: 'lowpass', frequency: param(0), Q: param(1) }); biquads.push(n); return n; },
      createStereoPanner: () => node({ pan: param(0) }), // laned notes build a strip
      createPeriodicWave: () => ({}),
    };
    const eng = new AudioEngine();
    eng.ctx = ctx; eng.master = ctx.createGain();
    eng.patchFor = () => normalizePatch({ kind: 'vesperia' });
    return { eng, biquads };
  };
  const base = normalizePatch({ kind: 'vesperia' });
  const mods = [{ ...DEFAULT_MOD, on: true, target: 'reso', amount: 0.5, shape: 'sin', phase: 90, rate: 1 }, { ...DEFAULT_MOD }];

  // No mods → Q is the patch value.
  const a = build();
  a.eng.playNote(60, 0, 0.5, 0.8, 440, 3);
  ok(near(a.biquads[0].Q.value, base.reso), 'engine without mods: Q = base reso');

  // Mods installed, elapsed t=0 with wave +1 → Q raised.
  const b = build();
  b.eng.modsFor = (laneId) => (laneId === 3 ? mods : null);
  b.eng.modEpoch = 0;
  b.eng.playNote(60, 0, 0.5, 0.8, 440, 3);
  ok(b.biquads[0].Q.value > base.reso + 1, 'engine with mods: voice built from modded patch');

  // Loop Mod on: rulerSec anchor — a note at ruler 0 gets wave 0 even at elapsed 10 s.
  const c = build();
  c.eng.modsFor = () => [{ ...mods[0], loop: true, phase: 0, rate: 0.25 }, { ...DEFAULT_MOD }];
  c.eng.modEpoch = 0;
  c.eng.playNote(60, 10, 0.5, 0.8, 440, 3, 0); // elapsed 10 s, ruler 0 s
  ok(near(c.biquads[0].Q.value, base.reso, 1e-9), 'Loop Mod: ruler anchor wins (note at ruler 0 unmodded)');

  // Grid/audition (laneId null) untouched even with a resolver installed.
  const d = build();
  d.eng.modsFor = (laneId) => (laneId == null ? null : mods);
  d.eng.modEpoch = 0;
  d.eng.playNote(60, 5, 0.5, 0.8, 440, null);
  ok(near(d.biquads[0].Q.value, base.reso), 'un-laned sound (grid/audition) unmodulated');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

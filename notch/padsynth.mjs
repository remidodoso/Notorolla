// Padlington: the pure PadSynth bake (FFT, profiles, spectrum, determinism,
// normalization, cache keys) + the voice graph through the engine.
import {
  fft, padProfile, padPartialFreq, padSpectrumMags, padTableKey, bakePadTable,
  padBaseFreq, formantMask, PAD_TABLE_RMS, PAD_TABLE_SIZE, PAD_VOWELS,
} from '../src/js/audio/padsynth.js';
import { AudioEngine } from '../src/js/audio/audio.js';
import { defaultPatch, normalizePatch, paramsFor } from '../src/js/audio/instrument.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const SR = 48000;
const N = 1 << 12; // small table for fast tests (the bake takes tableSize)

// 1) FFT round-trip: forward then inverse (scaled by 1/n) recovers the input.
{
  const n = 1024;
  const re = new Float64Array(n), im = new Float64Array(n);
  const src = new Float64Array(n);
  for (let i = 0; i < n; i++) src[i] = re[i] = Math.sin(i * 0.1) + 0.3 * Math.cos(i * 0.7);
  fft(re, im, false);
  fft(re, im, true);
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re[i] / n - src[i]), Math.abs(im[i] / n));
  ok(maxErr < 1e-9, `FFT round-trip (max err ${maxErr})`);
}

// 2) Profiles: saw 1/k, pulse odd-only, tilt exponent; the universal formant mask
//    (None = identity; a vowel shapes ANY source; Voice + vowel = the old Choir).
{
  // Default vowel is None → the raw sources are unshaped (mask = 1).
  const base = { ...defaultPatch('padlington'), harmonics: 16 };
  ok(base.vowel === 'none', 'default vowel = None (raw sources unshaped)');
  const saw = padProfile({ ...base, source: 'saw' }, 261.6256);
  ok(near(saw[0], 1) && near(saw[1], 0.5) && near(saw[3], 0.25), 'saw (Shape 0, Vowel None) profile is 1/k');
  // Pulse at Shape 0 = duty 0.5 = the old odd-only square (evens ~0 in float).
  const pu = padProfile({ ...base, source: 'pulse', shape: 0 }, 261.6256);
  ok(near(pu[0], 1) && near(pu[1], 0) && near(pu[2], 1 / 3) && near(pu[3], 0), 'pulse (Shape 0) profile is odd-only 1/k (square)');
  // Shape → Hi thins the duty, so even harmonics fill in (broader, brighter).
  const puHi = padProfile({ ...base, source: 'pulse', shape: 1 }, 261.6256);
  ok(puHi[1] > 0.05, 'pulse at Shape Hi fills in even harmonics (skinny pulse)');
  // Saw → Hi is the odd-only 1/k² triangle (A1=1, evens ~0, A3=1/9).
  const sawHi = padProfile({ ...base, source: 'saw', shape: 1 }, 261.6256);
  ok(near(sawHi[0], 1) && near(sawHi[1], 0) && near(sawHi[2], 1 / 9), 'saw at Shape Hi is odd-only 1/k² (triangle)');
  const tl = padProfile({ ...base, source: 'tilt', tilt: 2 }, 261.6256);
  ok(near(tl[1], 0.25) && near(tl[3], 1 / 16), 'tilt profile is 1/k^e');

  // formantMask: None (or unknown) = flat 1; a vowel peaks at its formant centre.
  ok(formantMask(500, 'none', 1, 9) === 1 && formantMask(500, 'zzz', 1, 9) === 1, 'formantMask None/unknown = flat 1.0 (bypass)');
  ok(formantMask(PAD_VOWELS.ah[0], 'ah', 1, 9) > formantMask(PAD_VOWELS.ah[0] * 3, 'ah', 1, 9), 'formantMask peaks at the formant centre');

  // The mask shapes ANY source: a vowel on Saw carves a peak near F1 and differs
  // from the flat Saw; Voice + a vowel = the old Choir (peaks near F1, vowels differ).
  const b = 65.4;
  const kF1 = Math.round(PAD_VOWELS.ah[0] / b); // harmonic nearest F1 (~12)
  const sawFlat = padProfile({ ...base, source: 'saw', vowel: 'none', harmonics: 40 }, b);
  const sawAh = padProfile({ ...base, source: 'saw', vowel: 'ah', harmonics: 40 }, b);
  ok(sawAh.some((v, i) => Math.abs(v - sawFlat[i]) > 1e-3), 'a vowel shapes the Saw source (formants are universal)');
  const ah = padProfile({ ...base, source: 'voice', vowel: 'ah', harmonics: 40 }, b);
  const ee = padProfile({ ...base, source: 'voice', vowel: 'ee', harmonics: 40 }, b);
  ok(ah[kF1 - 1] > ah[3] && ah[kF1 - 1] > ah[30], 'Voice+ah (the old Choir) peaks near F1');
  ok(ah.some((v, i) => Math.abs(v - ee[i]) > 1e-3), 'Voice profiles differ by vowel');
  const big = padProfile({ ...base, source: 'voice', vowel: 'ah', size: 0.8, harmonics: 40 }, b);
  ok(big.some((v, i) => Math.abs(v - ah[i]) > 1e-3), 'Size moves the formant profile');
}

// 3) Stretch: partial k lands at f0·k^(1+s).
{
  ok(near(padPartialFreq(4, 100, 0), 400), 'stretch 0 = harmonic');
  ok(near(padPartialFreq(4, 100, 0.05), 100 * Math.pow(4, 1.05), 1e-9), 'positive stretch sharpens partial 4');
  ok(padPartialFreq(4, 100, -0.05) < 400, 'negative stretch flattens');
}

// 4) Spectrum: energy concentrated around the partials; Bandwidth widens bands.
{
  const p = { ...defaultPatch('padlington'), harmonics: 8, bandwidth: 10, bwScale: 1, stretch: 0 };
  const f0 = (SR / N) * 32; // bin-aligned base so partial centres are exact bins
  const mags = padSpectrumMags(padProfile(p, f0), p, f0, SR, N);
  const bin1 = 32, offBin = 36; // partial 1's bin vs 4 bins off-centre
  ok(mags[bin1] > 0 && mags[bin1] > 1000 * (mags[offBin] || 1e-12), 'energy concentrated at partial centres');
  const wide = padSpectrumMags(padProfile(p, f0), { ...p, bandwidth: 120 }, f0, SR, N);
  ok(wide[offBin] > mags[offBin], 'wider Bandwidth spreads energy between partials');
}

// 4b) Air: a pink-noise floor fills between the partials; pink tilts down with
//     frequency; Air Cut (a 1-pole HPF) removes the low end.
{
  const p = { ...defaultPatch('padlington'), harmonics: 8, bandwidth: 10, source: 'saw', vowel: 'none' };
  const f0 = (SR / N) * 32; // partials land on bins 32, 64, …
  const binHz = SR / N;
  const dry = padSpectrumMags(padProfile(p, f0), { ...p, noise: 0 }, f0, SR, N);
  const wet = padSpectrumMags(padProfile(p, f0), { ...p, noise: 0.5, airCut: 30 }, f0, SR, N);
  const gap = 50; // a bin between partials 1 (32) and 2 (64)
  ok(dry[gap] < 1e-9 && wet[gap] > dry[gap], 'Noise fills the gaps between partials');
  const loF = Math.round(500 / binHz), hiF = Math.round(4000 / binHz);
  ok(wet[loF] > wet[hiF], 'the noise floor tilts down with frequency (pink 1/√f)');
  const lowBin = Math.round(60 / binHz);
  const hp = padSpectrumMags(padProfile(p, f0), { ...p, noise: 0.5, airCut: 1500 }, f0, SR, N);
  ok(hp[lowBin] < wet[lowBin], 'Air Cut (a higher HPF corner) attenuates the low end');
  // Noise is a bake param → it re-bakes, and the table stays RMS-normalized (a balance).
  const t = bakePadTable({ ...p, noise: 0.6 }, 261.6256, SR, N);
  let s = 0; for (const v of t) s += v * v;
  ok(near(Math.sqrt(s / N), PAD_TABLE_RMS, 1e-3), 'Noise changes colour, not level (RMS held)');
}

// 5) Bake: deterministic, RMS-normalized, finite; params change the table.
{
  const p = defaultPatch('padlington');
  const t1 = bakePadTable(p, 261.6256, SR, N);
  const t2 = bakePadTable(p, 261.6256, SR, N);
  ok(t1.length === N, 'bake returns the requested table size');
  ok(t1.every((v, i) => v === t2[i]), 'bake is deterministic (seeded): same patch → identical table');
  ok(t1.every((v) => isFinite(v)), 'no NaN/Inf in the table');
  let sum = 0;
  for (const v of t1) sum += v * v;
  ok(near(Math.sqrt(sum / N), PAD_TABLE_RMS, 1e-3), 'table is RMS-normalized');
  const t3 = bakePadTable({ ...p, bandwidth: 120 }, 261.6256, SR, N);
  ok(t3.some((v, i) => v !== t1[i]), 'a bake param change re-bakes a different table');
  // RMS normalization means the lushness knobs do not change loudness.
  let sum3 = 0;
  for (const v of t3) sum3 += v * v;
  ok(near(Math.sqrt(sum3 / N), PAD_TABLE_RMS, 1e-3), 'Bandwidth changes colour, not level (RMS held)');
}

// 6) Cache key: bake params in, play-time params out.
{
  const p = defaultPatch('padlington');
  const k = padTableKey(p, 261.6256, SR);
  ok(padTableKey({ ...p, attack: 2, width: 0, cutoff: 500, pitchAtk: 120 }, 261.6256, SR) === k,
    'envelope/width/filter/pitch-attack edits do NOT change the table key');
  ok(padTableKey({ ...p, bandwidth: 50 }, 261.6256, SR) !== k, 'bandwidth changes the key');
  ok(padTableKey({ ...p, shape: 0.5 }, 261.6256, SR) !== k, 'Shape changes the key (Saw/Pulse bake param)');
  ok(padTableKey({ ...p, source: 'voice' }, 261.6256, SR) !== k, 'source changes the key');
  // Formant + Air are bake params for every source now.
  ok(padTableKey({ ...p, vowel: 'ah' }, 261.6256, SR) !== k, 'Vowel changes the key');
  ok(padTableKey({ ...p, vowel: 'ah', formantQ: 12 }, 261.6256, SR) !== padTableKey({ ...p, vowel: 'ah' }, 261.6256, SR), 'Reso changes the key when a vowel is active');
  ok(padTableKey({ ...p, noise: 0.4 }, 261.6256, SR) !== k, 'Noise changes the key');
  ok(padTableKey({ ...p, noise: 0.4, airCut: 400 }, 261.6256, SR) !== padTableKey({ ...p, noise: 0.4 }, 261.6256, SR), 'Air Cut changes the key when Noise is up');
  ok(padTableKey(p, 523.2511, SR) !== k, 'the octave base is part of the key');
}

// 7) Base selection: nearest octave-of-C, clamped C1..C8.
{
  ok(near(padBaseFreq(261.6256), 261.6256, 1e-3), 'C4 → C4 base');
  ok(near(padBaseFreq(392), 523.2511, 1e-3), 'G4 → C5 base (nearest octave)');
  ok(near(padBaseFreq(27.5), 32.7032, 1e-3), 'A0 → C1 base (clamped low)');
  ok(near(padBaseFreq(4186), 4186.009, 1e-2), 'C8 → C8 base');
  const r = 392 / padBaseFreq(392);
  ok(r > 0.7 && r < 1.42, 'playback rate stays within ~[0.71, 1.41]');
}

// 8) Registry plumbing: defaults, PARAMS, normalize.
{
  const p = defaultPatch('padlington');
  const keys = ['source', 'shape', 'vowel', 'size', 'formantQ', 'noise', 'airCut', 'tilt', 'harmonics',
    'bandwidth', 'bwScale', 'stretch', 'pitchAtk', 'pitchAtkTime', 'width', 'cutoff', 'reso', 'filterEnv',
    'keyTrack', 'attack', 'decay', 'sustain', 'release'];
  ok(keys.every((k) => p[k] !== undefined), 'default padlington patch has every param');
  ok(p.source === 'saw' && p.shape === 0 && p.vowel === 'none' && p.noise === 0, 'defaults: saw / Shape 0 / Vowel None / Noise 0');
  const srcSpec = paramsFor('padlington').find((s) => s.key === 'source');
  ok(srcSpec && srcSpec.sel && srcSpec.options.length === 4 && srcSpec.options.some((o) => o.id === 'voice') && !srcSpec.options.some((o) => o.id === 'choir'),
    'source is a 4-option select: Choir replaced by Voice');
  const vowSpec = paramsFor('padlington').find((s) => s.key === 'vowel');
  ok(vowSpec && vowSpec.options.length === 6 && vowSpec.options[0].id === 'none', 'Vowel is a 6-way enum led by None');
  ok(normalizePatch({ kind: 'padlington', source: 'voice' }).source === 'voice', 'valid source kept');
  ok(normalizePatch({ kind: 'padlington', source: 'zzz' }).source === 'saw', 'bad source → saw');
  // COMPAT: legacy 'square' → 'pulse'; legacy 'choir' → 'voice' keeping its vowel;
  // a legacy non-choir patch's inert vowel is retired to None (else it would newly shape).
  ok(normalizePatch({ kind: 'padlington', source: 'square' }).source === 'pulse', 'legacy square source → pulse');
  const mChoir = normalizePatch({ kind: 'padlington', source: 'choir', vowel: 'ah', size: 0.9 });
  ok(mChoir.source === 'voice' && mChoir.vowel === 'ah' && near(mChoir.size, 0.9), 'legacy choir → voice, keeping vowel/size');
  ok(normalizePatch({ kind: 'padlington', source: 'saw', vowel: 'ah' }).vowel === 'none', 'legacy non-choir inert vowel → None');
  ok(normalizePatch({ kind: 'padlington', source: 'saw', vowel: 'ah', formantQ: 9 }).vowel === 'ah', 'a formant-era vowel is kept (not clobbered)');
  ok(normalizePatch({ kind: 'padlington', harmonics: 9999 }).harmonics === 128, 'harmonics clamps to max');
  ok(normalizePatch({ kind: 'padlington', stretch: 1 }).stretch === 0.05, 'stretch clamps to ±0.05');

  // Inert predicates: Shape/Tilt stay source-gated; the Formant + Air controls are
  // always active (Vowel None simply makes the mask flat).
  const spec = (k) => paramsFor('padlington').find((s) => s.key === k);
  ok(!spec('vowel').inert && !spec('size').inert && !spec('formantQ').inert, 'Formant controls are always active');
  ok(!spec('noise').inert && !spec('airCut').inert, 'Air controls are always active');
  ok(spec('tilt').inert({ source: 'voice' }) && !spec('tilt').inert({ source: 'tilt' }), 'Tilt inert outside Tilt');
  ok(spec('shape').inert({ source: 'voice' }) && spec('shape').inert({ source: 'tilt' })
    && !spec('shape').inert({ source: 'saw' }) && !spec('shape').inert({ source: 'pulse' }), 'Shape active only for Saw/Pulse');
}

// --- fake Web Audio: record nodes, connections, buffers -----------------------
function param(v = 0) {
  const p = { value: v, _isParam: true, _sets: [],
    setValueAtTime(x, t) { p._sets.push({ type: 'set', v: x, t }); },
    exponentialRampToValueAtTime(x) { p.value = x; },
    linearRampToValueAtTime(x) { p.value = x; },
    setTargetAtTime(x, t, tau) { p._sets.push({ type: 'tgt', v: x, t, tau }); },
    cancelScheduledValues() {} };
  return p;
}
function node(type, extra = {}) {
  return { type, _conns: [], started: false, stopped: false, _startOffset: null,
    connect(dest) { this._conns.push(dest); }, disconnect() { this._conns.length = 0; },
    start(t, offset) { this.started = true; this._startOffset = offset; }, stop() { this.stopped = true; }, ...extra };
}
function fakeCtx() {
  const gains = [], biquads = [], sources = [], panners = [], buffers = [];
  const ctx = {
    currentTime: 0, sampleRate: 48000,
    createGain: () => { const n = node('gain', { gain: param(1) }); gains.push(n); return n; },
    createBiquadFilter: () => { const n = node('biquad', { type: 'lowpass', frequency: param(0), Q: param(1) }); biquads.push(n); return n; },
    createBuffer: (ch, len, rate) => {
      const data = new Float32Array(len);
      const b = { length: len, sampleRate: rate, getChannelData: () => data };
      buffers.push(b);
      return b;
    },
    createBufferSource: () => { const n = node('src', { buffer: null, loop: false, playbackRate: param(1), detune: param(0) }); sources.push(n); return n; },
    createStereoPanner: () => { const n = node('pan', { pan: param(0) }); panners.push(n); return n; },
  };
  return { ctx, gains, biquads, sources, panners, buffers };
}

// Build one Padlington note through the engine into a capturing ctx.
function capture(f, over = {}, freq = 261.6256) {
  const eng = new AudioEngine();
  eng.ctx = f.ctx;
  eng.master = f.ctx.createGain();
  eng.patchFor = () => normalizePatch({ kind: 'padlington', ...over });
  eng.playNote(60, 0, 1, 0.8, freq, null);
  return f;
}

// 9) Voice graph: two looping read-heads over ONE shared table, repitched,
// panned ±width; a second note at the same patch/octave reuses the cached bake.
{
  const f = capture(fakeCtx(), { width: 0.7 }, 392); // G4 → C5 base
  ok(f.sources.length === 2 && f.sources.every((s) => s.loop && s.started && s.stopped),
    '2 looping buffer sources, started + scheduled to stop');
  ok(f.sources[0].buffer === f.sources[1].buffer, 'both read-heads share one baked table');
  ok(f.sources.every((s) => near(s.playbackRate.value, 392 / 523.2511, 1e-6)), 'playbackRate = f0/base');
  ok(f.panners.length === 2 && near(f.panners[0].pan.value, -0.7) && near(f.panners[1].pan.value, 0.7),
    'read-heads panned ±width');
  ok(f.sources[0]._startOffset !== f.sources[1]._startOffset || f.sources[0]._startOffset > 0,
    'read-heads start at (random) offsets');
  ok(f.biquads.length === 1 && f.biquads[0].type === 'lowpass', 'one resonant lowpass (Vesperia filter section)');
  const before = f.buffers.length;
  capture(f, { width: 0.7 }, 380); // same octave (C5 base), same bake params
  ok(f.buffers.length === before, 'second note in the same octave reuses the cached table (no re-bake)');
  capture(f, { width: 0.7 }, 100); // different octave → a new base's table
  ok(f.buffers.length === before + 1, 'a new octave bakes (lazily) one more table');
}

// 9b) Pitch attack: ± cents scheduled on both read-heads' detune; 0 = off.
{
  const f = capture(fakeCtx(), { pitchAtk: 120 });
  ok(f.sources.every((s) => s.detune._sets.some((e) => e.type === 'set' && near(e.v, 120))
    && s.detune._sets.some((e) => e.type === 'tgt' && e.v === 0)),
    'pitchAtk schedules start-offset + settle-to-0 on both read-heads');
  const neg = capture(fakeCtx(), { pitchAtk: -150 });
  ok(neg.sources.every((s) => s.detune._sets.some((e) => e.type === 'set' && near(e.v, -150))),
    'negative pitchAtk (the scoop, from below) schedules too');
  const off = capture(fakeCtx(), { pitchAtk: 0 });
  ok(off.sources.every((s) => s.detune._sets.length === 0), 'pitchAtk 0 = no detune automation');
  ok(normalizePatch({ kind: 'padlington', pitchAtk: 500 }).pitchAtk === 200
    && normalizePatch({ kind: 'padlington', pitchAtk: -500 }).pitchAtk === -200, 'pitchAtk clamps to ±200');
  // Wendelhorn's Pitch Atk is now the same ± standard.
  ok(normalizePatch({ kind: 'wendelhorn', pitchAtk: -100 }).pitchAtk === -100, 'wendelhorn accepts a negative pitchAtk');
}

// 9c) Filter envelope = the single amp ADSR mapped into cutoff (Juno-60): the
//     cutoff opens base→peak over attack, decays to the sustain cutoff over the
//     amp decay, and releases to base over the amp release. keyTrack 0 → baseCut =
//     cutoff exactly. (Shared scheduleFilterEnv, exercised via Padlington's voice.)
{
  const tf = capture(fakeCtx(), { cutoff: 1000, keyTrack: 0, filterEnv: 2, sustain: 0.5, attack: 0.3, decay: 1.0, release: 1.2 }).biquads[0].frequency;
  ok(tf._sets[0].type === 'set' && near(tf._sets[0].v, 1000), 'filter opens from baseCut (= cutoff at keyTrack 0)');
  ok(near(tf.value, 4000), 'attack ramps cutoff up to peak = base·2^filterEnv (1000·2^2)');
  ok(tf._sets.some((e) => e.type === 'tgt' && near(e.v, 2000) && near(e.tau, 1.0)), 'decays to the sustain cutoff base·2^(env·sustain) over p.decay');
  ok(tf._sets.some((e) => e.type === 'tgt' && near(e.v, 1000) && near(e.tau, 1.2)), 'releases back to baseCut over p.release');

  // filterEnv 0 = static filter: every stage sits at base.
  const s = capture(fakeCtx(), { cutoff: 1500, keyTrack: 0, filterEnv: 0 }).biquads[0].frequency;
  ok(near(s.value, 1500) && s._sets.every((e) => near(e.v, 1500)), 'filterEnv 0 = static cutoff at base');

  // A note SHORTER than the attack (attack 2 s, note 1 s): the attack lands short
  // of peak and NO decay stage is scheduled past note-off — only the release.
  const sh = capture(fakeCtx(), { cutoff: 1000, keyTrack: 0, filterEnv: 2, attack: 2.0 }).biquads[0].frequency;
  ok(near(sh.value, 2000), 'short note: attack clamps to the note, landing short of peak');
  const shTgts = sh._sets.filter((e) => e.type === 'tgt');
  ok(shTgts.length === 1 && near(shTgts[0].v, 1000), 'short note: no decay stage, just the release to base');
}

// 10) The full-size default bake is sane (one real-size smoke bake).
{
  const t = bakePadTable(defaultPatch('padlington'), 261.6256, 48000);
  ok(t.length === PAD_TABLE_SIZE, 'full-size table baked');
  ok(t.every((v) => isFinite(v) && Math.abs(v) <= 1.5), 'full-size table finite and bounded');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

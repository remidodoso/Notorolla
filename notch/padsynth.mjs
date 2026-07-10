// Padlington: the pure PadSynth bake (FFT, profiles, spectrum, determinism,
// normalization, cache keys) + the voice graph through the engine.
import {
  fft, padProfile, padPartialFreq, padSpectrumMags, padTableKey, bakePadTable,
  padBaseFreq, PAD_TABLE_RMS, PAD_TABLE_SIZE, PAD_VOWELS,
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

// 2) Profiles: saw 1/k, square odd-only, tilt exponent, choir formant-shaped.
{
  const base = { ...defaultPatch('padlington'), harmonics: 16 };
  const saw = padProfile({ ...base, source: 'saw' }, 261.6256);
  ok(near(saw[0], 1) && near(saw[1], 0.5) && near(saw[3], 0.25), 'saw profile is 1/k');
  const sq = padProfile({ ...base, source: 'square' }, 261.6256);
  ok(near(sq[0], 1) && sq[1] === 0 && near(sq[2], 1 / 3) && sq[3] === 0, 'square profile is odd-only 1/k');
  const tl = padProfile({ ...base, source: 'tilt', tilt: 2 }, 261.6256);
  ok(near(tl[1], 0.25) && near(tl[3], 1 / 16), 'tilt profile is 1/k^e');

  // Choir: with a 65.4 Hz base, "ah" (F1 = 800) peaks near harmonic 12 — the
  // formant region must beat the same harmonic of a vowel whose formants sit
  // elsewhere, and the vowels must differ.
  const b = 65.4;
  const ah = padProfile({ ...base, source: 'choir', vowel: 'ah', harmonics: 40 }, b);
  const ee = padProfile({ ...base, source: 'choir', vowel: 'ee', harmonics: 40 }, b);
  const kF1 = Math.round(PAD_VOWELS.ah[0] / b); // harmonic nearest F1
  ok(ah[kF1 - 1] > ah[3] && ah[kF1 - 1] > ah[30], 'choir(ah) profile peaks near F1');
  ok(ah.some((v, i) => Math.abs(v - ee[i]) > 1e-3), 'choir profiles differ by vowel');
  const big = padProfile({ ...base, source: 'choir', vowel: 'ah', size: 0.8, harmonics: 40 }, b);
  ok(big.some((v, i) => Math.abs(v - ah[i]) > 1e-3), 'Size moves the choir profile');
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
  ok(padTableKey({ ...p, attack: 2, width: 0, cutoff: 500 }, 261.6256, SR) === k,
    'envelope/width/filter edits do NOT change the table key');
  ok(padTableKey({ ...p, bandwidth: 50 }, 261.6256, SR) !== k, 'bandwidth changes the key');
  ok(padTableKey({ ...p, source: 'choir' }, 261.6256, SR) !== k, 'source changes the key');
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
  const keys = ['source', 'vowel', 'size', 'tilt', 'harmonics', 'bandwidth', 'bwScale', 'stretch',
    'width', 'cutoff', 'reso', 'filterEnv', 'keyTrack', 'attack', 'decay', 'sustain', 'release'];
  ok(keys.every((k) => p[k] !== undefined), 'default padlington patch has every param');
  ok(p.source === 'saw', 'default source = saw');
  const srcSpec = paramsFor('padlington').find((s) => s.key === 'source');
  ok(srcSpec && srcSpec.sel && srcSpec.options.length === 4, 'source is a 4-option select');
  ok(normalizePatch({ kind: 'padlington', source: 'choir' }).source === 'choir', 'valid source kept');
  ok(normalizePatch({ kind: 'padlington', source: 'zzz' }).source === 'saw', 'bad source → saw');
  ok(normalizePatch({ kind: 'padlington', harmonics: 9999 }).harmonics === 128, 'harmonics clamps to max');
  ok(normalizePatch({ kind: 'padlington', stretch: 1 }).stretch === 0.05, 'stretch clamps to ±0.05');
}

// --- fake Web Audio: record nodes, connections, buffers -----------------------
function param(v = 0) {
  return { value: v, _isParam: true, setValueAtTime() {}, exponentialRampToValueAtTime(x) { this.value = x; },
    linearRampToValueAtTime(x) { this.value = x; }, setTargetAtTime() {}, cancelScheduledValues() {} };
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
    createBufferSource: () => { const n = node('src', { buffer: null, loop: false, playbackRate: param(1) }); sources.push(n); return n; },
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

// 10) The full-size default bake is sane (one real-size smoke bake).
{
  const t = bakePadTable(defaultPatch('padlington'), 261.6256, 48000);
  ok(t.length === PAD_TABLE_SIZE, 'full-size table baked');
  ok(t.every((v) => isFinite(v) && Math.abs(v) <= 1.5), 'full-size table finite and bounded');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

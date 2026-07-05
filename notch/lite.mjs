// Lite Instruments: the CPU-relief switch (engine.lite) that swaps the heavy
// voices (Wendelhorn, Nayumi) for a cheaper LIVE graph, while the offline export
// paths always build the full voice. Counts nodes through a fake Web Audio ctx.
import { AudioEngine } from '../src/audio.js';
import { normalizePatch } from '../src/instrument.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// --- fake Web Audio: record every node kind we care about --------------------
function param(v = 0) {
  return { value: v, setValueAtTime() {}, exponentialRampToValueAtTime(x) { this.value = x; },
    linearRampToValueAtTime(x) { this.value = x; }, setTargetAtTime() {}, cancelScheduledValues() {} };
}
function node(type, extra = {}) {
  return { type, _conns: [], connect(d) { this._conns.push(d); }, disconnect() {}, start() {}, stop() {}, ...extra };
}
function fakeCtx() {
  const oscs = [], gains = [], biquads = [], shapers = [], sources = [], panners = [];
  const ctx = {
    currentTime: 0, sampleRate: 44100,
    createGain: () => { const n = node('gain', { gain: param(1) }); gains.push(n); return n; },
    createOscillator: () => { const n = node('osc', { frequency: param(0), detune: param(0), _wave: null, setPeriodicWave(w) { this._wave = w; } }); oscs.push(n); return n; },
    createBiquadFilter: () => { const n = node('biquad', { type: 'lowpass', frequency: param(0), Q: param(1) }); biquads.push(n); return n; },
    createWaveShaper: () => { const n = node('shaper', { curve: null, oversample: 'none' }); shapers.push(n); return n; },
    createStereoPanner: () => { const n = node('panner', { pan: param(0) }); panners.push(n); return n; },
    createBuffer: (ch, len) => ({ _len: len, getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => { const n = node('src', { buffer: null, loop: false }); sources.push(n); return n; },
    createPeriodicWave: () => ({ _wave: true }),
  };
  return { ctx, oscs, gains, biquads, shapers, sources, panners };
}

// Build one live note of `kind` at Lite = `lite` and return the captured nodes.
function capture(kind, lite, over = {}, freq = 440) {
  const eng = new AudioEngine();
  const f = fakeCtx();
  eng.ctx = f.ctx;
  eng.master = f.ctx.createGain();
  eng.lite = lite;
  eng.patchFor = () => normalizePatch({ kind, ...over });
  eng.playNote(60, 0, 1, 0.8, freq, null);
  return f;
}

// 1) Wendelhorn full: 7 saws + up to 3 ensemble LFOs, one panner per saw.
{
  const full = capture('wendelhorn', false);
  ok(full.oscs.length >= 7, `full Wendelhorn builds the saw stack (+LFOs): ${full.oscs.length} osc`);
  ok(full.panners.length === 7, `full Wendelhorn pans each of the 7 saws (${full.panners.length})`);
}

// 2) Wendelhorn lite: exactly 3 mono saws, no LFOs, no panners.
{
  const lite = capture('wendelhorn', true);
  ok(lite.oscs.length === 3, `lite Wendelhorn = 3 saws, no LFOs (${lite.oscs.length} osc)`);
  ok(lite.panners.length === 0, 'lite Wendelhorn is mono (no panners)');
  // Every saw is a random-phase PeriodicWave at the note frequency (character kept).
  ok(lite.oscs.every((o) => o._wave), 'lite Wendelhorn saws are still band-limited PeriodicWaves');
}

// 3) Nayumi full (default grit): carrier + vibrato oscillators, a looping noise
//    source, a bit-crush shaper, and the 3-formant bandpass bank.
{
  const full = capture('nayumi', false);
  ok(full.oscs.length === 2, 'full Nayumi: carrier + vibrato oscillators');
  ok(full.sources.length === 1, 'full Nayumi: one looping breath/noise source');
  ok(full.shapers.length === 1, 'full Nayumi: bit-crush WaveShaper (default grit)');
  ok(full.biquads.filter((b) => b.type === 'bandpass').length === 3, 'full Nayumi: 3 formant bandpasses');
}

// 4) Nayumi lite: keeps vibrato + the 3 formants; drops the noise/breath path
//    and the bit-crush (WaveShaper + its post-crush lowpass).
{
  const lite = capture('nayumi', true);
  ok(lite.oscs.length === 2, 'lite Nayumi keeps vibrato (carrier + vibrato oscillators)');
  ok(lite.sources.length === 0, 'lite Nayumi drops the breath/noise source');
  ok(lite.shapers.length === 0, 'lite Nayumi drops the bit-crush (grit inert)');
  ok(lite.biquads.filter((b) => b.type === 'bandpass').length === 3, 'lite Nayumi keeps the vowel (3 formants)');
  ok(lite.biquads.filter((b) => b.type === 'highpass').length === 0, 'lite Nayumi drops the air highpass');
}

// 5) The other voices ignore Lite (their graphs are already light) — lite vs full
//    build the same node count.
{
  const a = capture('vesperia', false).oscs.length;
  const b = capture('vesperia', true).oscs.length;
  ok(a === b && a >= 6, `Vesperia ignores Lite (${a} osc both ways)`);
}

// 6) The offline export ALWAYS builds the full voice, even with engine.lite = true.
//    Stub OfflineAudioContext (counting oscillators) and bounce one Wendelhorn note.
{
  let offOscs = 0;
  const p = () => param();
  const fn = (extra = {}) => ({ connect() {}, disconnect() {}, start() {}, stop() {}, ...extra });
  class FakeOAC {
    constructor(ch, frames, rate) { this._ch = ch; this._frames = frames; this._rate = rate; this.destination = fn(); this.currentTime = 0; this.sampleRate = rate; }
    createGain() { return fn({ gain: p() }); }
    createOscillator() { offOscs++; return fn({ frequency: p(), detune: p(), setPeriodicWave() {} }); }
    createStereoPanner() { return fn({ pan: p() }); }
    createDynamicsCompressor() { return fn({ threshold: p(), knee: p(), ratio: p(), attack: p(), release: p() }); }
    createPeriodicWave() { return {}; }
    createBiquadFilter() { return fn({ type: 'lowpass', frequency: p(), Q: p() }); }
    createDelay() { return fn({ delayTime: p() }); }
    createChannelMerger() { return fn(); }
    startRendering() { return Promise.resolve({ numberOfChannels: this._ch, length: this._frames, sampleRate: this._rate, getChannelData: () => new Float32Array(this._frames) }); }
  }
  globalThis.OfflineAudioContext = FakeOAC;

  const eng = new AudioEngine();
  eng.ctx = { sampleRate: 48000 };
  eng.lite = true; // even with Lite armed…
  eng.patchFor = () => normalizePatch({ kind: 'wendelhorn' });
  await eng.renderToBuffer([{ pitch: 60, time: 0, duration: 0.5, velocity: 0.8, freq: 440, laneId: null }], 1.0);
  ok(offOscs >= 7, `offline render ignores Lite — full Wendelhorn (${offOscs} osc)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

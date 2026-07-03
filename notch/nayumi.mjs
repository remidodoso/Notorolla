// Nayumi: breathy formant-voice patch plumbing + the source–filter voice graph.
import { AudioEngine } from '../src/audio.js';
import { defaultPatch, normalizePatch, paramsFor } from '../src/instrument.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// --- fake Web Audio: record nodes, types, connections, frequencies ------------
function param(v = 0) {
  return { value: v, _isParam: true, setValueAtTime() {}, exponentialRampToValueAtTime(x) { this.value = x; },
    linearRampToValueAtTime(x) { this.value = x; }, setTargetAtTime() {}, cancelScheduledValues() {} };
}
function node(type, extra = {}) {
  return { type, _conns: [], started: false, stopped: false,
    connect(dest) { this._conns.push(dest); }, disconnect() { this._conns.length = 0; },
    start() { this.started = true; }, stop() { this.stopped = true; }, ...extra };
}
function fakeCtx() {
  const oscs = [], gains = [], biquads = [], shapers = [], sources = [];
  const ctx = {
    currentTime: 0, sampleRate: 44100,
    createGain: () => { const n = node('gain', { gain: param(1) }); gains.push(n); return n; },
    createOscillator: () => { const n = node('osc', { frequency: param(0), detune: param(0), _wave: null, setPeriodicWave(w) { this._wave = w; } }); oscs.push(n); return n; },
    createBiquadFilter: () => { const n = node('biquad', { type: 'lowpass', frequency: param(0), Q: param(1) }); biquads.push(n); return n; },
    createWaveShaper: () => { const n = node('shaper', { curve: null, oversample: 'none' }); shapers.push(n); return n; },
    createBuffer: (ch, len) => ({ _len: len, getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => { const n = node('src', { buffer: null, loop: false }); sources.push(n); return n; },
    createPeriodicWave: () => ({ _wave: true }),
  };
  return { ctx, oscs, gains, biquads, shapers, sources };
}

// Build one Nayumi note through the engine into a capturing ctx.
function capture(over = {}, freq = 440) {
  const eng = new AudioEngine();
  const f = fakeCtx();
  eng.ctx = f.ctx;
  eng.master = f.ctx.createGain();
  eng.patchFor = () => normalizePatch({ kind: 'nayumi', ...over });
  eng.playNote(60, 0, 1, 0.8, freq, null);
  return f;
}

// 1) Patch shape: every param present + a 5-option vowel select.
{
  const p = defaultPatch('nayumi');
  const keys = ['vowel', 'size', 'formantQ', 'soprano', 'breath', 'bright', 'grit', 'vibRate', 'vibDepth', 'attack', 'decay', 'sustain', 'release'];
  ok(keys.every((k) => p[k] !== undefined), 'default nayumi patch has every param');
  ok(p.vowel === 'ah', 'default vowel = ah');
  const vowelSpec = paramsFor('nayumi').find((s) => s.key === 'vowel');
  ok(vowelSpec && vowelSpec.sel && vowelSpec.options.length === 5, 'vowel is a 5-option select');
}

// 2) normalize: valid vowel kept, bogus / non-string → default.
{
  ok(normalizePatch({ kind: 'nayumi', vowel: 'ee' }).vowel === 'ee', 'valid vowel kept');
  ok(normalizePatch({ kind: 'nayumi', vowel: 'zzz' }).vowel === 'ah', 'bad vowel → ah');
  ok(normalizePatch({ kind: 'nayumi', vowel: 7 }).vowel === 'ah', 'non-string vowel → ah');
  ok(normalizePatch({ kind: 'nayumi', size: 9 }).size === 1.3, 'size clamps to max');
}

// 3) Voice graph: 2 oscillators (carrier + vibrato), 1 looping noise source.
{
  const { oscs, sources } = capture();
  ok(oscs.length === 2, '2 oscillators (glottal carrier + vibrato LFO)');
  ok(sources.length === 1 && sources[0].loop === true, '1 looping noise source');
  ok(oscs.every((o) => o.started && o.stopped), 'oscillators started + scheduled to stop');
  const carrier = oscs.find((o) => o._wave);
  const vib = oscs.find((o) => !o._wave);
  ok(carrier && near(carrier.frequency.value, 440), 'carrier is the glottal PeriodicWave at f0');
  ok(vib && vib.type === 'sine' && near(vib.frequency.value, 5.5), 'vibrato is a 5.5 Hz sine');
}

// 4) Parallel formant bank: 3 bandpass at the vowel F1/F2/F3, scaled by Size.
{
  const { biquads } = capture({ vowel: 'ah', size: 1.0 });
  const bps = biquads.filter((b) => b.type === 'bandpass');
  ok(bps.length === 3, '3 bandpass formant filters');
  ok(near(bps[0].frequency.value, 800) && near(bps[1].frequency.value, 1150) && near(bps[2].frequency.value, 2900),
    'ah formants at 800/1150/2900 Hz');
}
{
  const { biquads } = capture({ vowel: 'ah', size: 1.2 });
  const bps = biquads.filter((b) => b.type === 'bandpass');
  ok(near(bps[0].frequency.value, 960) && near(bps[2].frequency.value, 3480), 'Size scales all formants (×1.2)');
}

// 5) Grit gates the bit-crush WaveShaper + its post-crush bandwidth lowpass.
{
  ok(capture({ grit: 0.25 }).shapers.length === 1, 'grit > 0 → one bit-crush WaveShaper (curve set)');
  ok(capture({ grit: 0.25 }).shapers[0].curve != null, 'crush curve assigned');
  ok(capture({ grit: 0 }).shapers.length === 0, 'grit 0 → no shaper (clean)');
  const lpCount = (f) => f.biquads.filter((b) => b.type === 'lowpass').length;
  ok(lpCount(capture({ grit: 0.5 })) === 2, 'grit > 0 → a post-crush lowpass joins the brightness lowpass');
  ok(lpCount(capture({ grit: 0 })) === 1, 'grit 0 → only the brightness lowpass');
}

// 5b) Soprano rounding: low/mid notes untouched; high notes round to a pure tone.
{
  // Below threshold (C4 ≈ 261 Hz, ah F1 = 800 → r < R0): no change even at Soprano 1.
  const low = capture({ vowel: 'ah', soprano: 1 }, 261);
  const lowBps = low.biquads.filter((b) => b.type === 'bandpass');
  ok(near(lowBps[0].frequency.value, 800), 'low note: F1 unchanged (rounding idle below threshold)');
  ok(near(lowBps[0]._conns[0].gain.value, 1.0) && near(lowBps[1]._conns[0].gain.value, 0.6), 'low note: formant gains at rest');

  // High note (1200 Hz > F1) at Soprano 1 → t = 1: F1 tunes onto f0, F2/F3 fade,
  // breath nearly gone.
  const hi = capture({ vowel: 'ah', soprano: 1, breath: 1 }, 1200);
  const hiBps = hi.biquads.filter((b) => b.type === 'bandpass');
  ok(near(hiBps[0].frequency.value, 1200), 'high note + Soprano: F1 tunes onto the fundamental');
  ok(near(hiBps[1]._conns[0].gain.value, 0) && near(hiBps[2]._conns[0].gain.value, 0), 'high note + Soprano: F2/F3 fade out');
  ok(hi.gains.some((g) => near(g.gain.value, 0.6 * 0.15)), 'high note + Soprano: breath rolled off (×0.15)');

  // Same high note, Soprano 0 → no rounding (gating off).
  const hiOff = capture({ vowel: 'ah', soprano: 0, breath: 1 }, 1200);
  const offBps = hiOff.biquads.filter((b) => b.type === 'bandpass');
  ok(near(offBps[0].frequency.value, 800), 'high note, Soprano 0: F1 stays put (knob gates the effect)');
  ok(near(offBps[1]._conns[0].gain.value, 0.6), 'high note, Soprano 0: F2 at full level');
}

// 6) Vibrato routes to the carrier's detune (in cents).
{
  const { oscs, gains } = capture({ vibDepth: 18 });
  const carrier = oscs.find((o) => o._wave);
  const depth = gains.find((g) => near(g.gain.value, 18));
  ok(depth && depth._conns.includes(carrier.detune), 'vibrato depth gain → carrier.detune (cents)');
}

// 7) Breath scales aspiration: a gain at 0.6×breath feeds the bandpass bank.
{
  const { gains, biquads } = capture({ breath: 0.5 });
  const bps = biquads.filter((b) => b.type === 'bandpass');
  const asp = gains.find((g) => near(g.gain.value, 0.3)); // 0.6 × 0.5
  ok(asp && bps.every((bp) => asp._conns.includes(bp)), 'aspiration gain (0.6×breath) feeds all 3 formants');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

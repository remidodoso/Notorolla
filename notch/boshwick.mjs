// Boshwick: 808-percussion patch plumbing + the per-Type voice graphs.
import { AudioEngine } from '../src/js/audio/audio.js';
import { defaultPatch, normalizePatch, paramsFor } from '../src/js/audio/instrument.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const C4 = 261.6255653, C5 = 523.2511306;

function param(v = 0) {
  return { value: v, _tgt: 0,
    setValueAtTime() {}, exponentialRampToValueAtTime(x) { this.value = x; },
    linearRampToValueAtTime(x) { this.value = x; }, setTargetAtTime() { this._tgt++; }, cancelScheduledValues() {} };
}
function node(type, extra = {}) {
  return { type, started: false, stopped: false, _conns: [],
    connect(d) { this._conns.push(d); }, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; }, ...extra };
}
function fakeCtx() {
  const oscs = [], gains = [], biquads = [], sources = [], shapers = [];
  const ctx = {
    currentTime: 0, sampleRate: 44100,
    createGain: () => { const n = node('gain', { gain: param(1) }); gains.push(n); return n; },
    createOscillator: () => { const n = node('osc', { frequency: param(0), detune: param(0), setPeriodicWave() {} }); oscs.push(n); return n; },
    createBiquadFilter: () => { const n = node('biquad', { type: 'lowpass', frequency: param(0), Q: param(1) }); biquads.push(n); return n; },
    createWaveShaper: () => { const n = node('shaper', { curve: null, oversample: 'none' }); shapers.push(n); return n; },
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => { const n = node('src', { buffer: null, loop: false }); sources.push(n); return n; },
    createPeriodicWave: () => ({}),
  };
  return { ctx, oscs, gains, biquads, sources, shapers };
}
function capture(over = {}, freq = C4, dur = 0.2, vel = 0.78) {
  const eng = new AudioEngine();
  const f = fakeCtx();
  eng.ctx = f.ctx; eng.master = f.ctx.createGain();
  eng.patchFor = () => normalizePatch({ kind: 'boshwick', ...over });
  eng.playNote(60, 0, dur, vel, freq, null);
  return f;
}

// 1) Patch shape + the 9-way Type select.
{
  const p = defaultPatch('boshwick');
  const keys = ['type', 'tune', 'pitchTrack', 'decay', 'punch', 'pitchEnv', 'tone', 'snap'];
  ok(keys.every((k) => p[k] !== undefined), 'default boshwick patch has every param');
  ok(p.type === 'kick', 'default type = kick');
  const typeSpec = paramsFor('boshwick').find((s) => s.key === 'type');
  ok(typeSpec && typeSpec.sel && typeSpec.options.length === 9, 'type is a 9-option select');
  ok(normalizePatch({ kind: 'boshwick', type: 'snare' }).type === 'snare', 'valid type kept');
  ok(normalizePatch({ kind: 'boshwick', type: 'zzz' }).type === 'kick', 'bad type → kick');
}

// 2) Every type builds and starts at least one source, all scheduled to stop.
{
  for (const t of ['kick', 'tom', 'snare', 'hat', 'clap', 'cowbell', 'rim', 'clave', 'cymbal']) {
    const { oscs, sources } = capture({ type: t });
    const all = [...oscs, ...sources];
    ok(all.length > 0 && all.every((s) => s.started && s.stopped), `${t}: builds + all sources started/stopped`);
  }
}

// 3) Kick: one sine body; pitch tracking transposes the fundamental.
{
  const { oscs } = capture({ type: 'kick' });
  ok(oscs.length === 1 && oscs[0].type === 'sine', 'kick: single sine body oscillator');
  ok(near(capture({ type: 'kick', pitchTrack: 1 }, C5).oscs[0].frequency.value, 110), 'kick PitchTrack 1 at C5 → 2× nominal (110 Hz)');
  ok(near(capture({ type: 'kick', pitchTrack: 0 }, C5).oscs[0].frequency.value, 55), 'kick PitchTrack 0 → fixed nominal (55 Hz)');
}

// 3b) Kick rework: Tone gates the drive shaper; Punch gates the beater click.
{
  const driven = capture({ type: 'kick', tone: 0.6 });
  ok(driven.shapers.length === 1 && driven.shapers[0].curve != null, 'kick tone > 0 → one drive WaveShaper (curve set)');
  ok(capture({ type: 'kick', tone: 0 }).shapers.length === 0, 'kick tone 0 → no shaper (pure sub)');
  ok(capture({ type: 'kick', punch: 0 }).sources.length === 0, 'kick punch 0 → no beater click');
  ok(capture({ type: 'kick', punch: 1 }).sources.length === 1, 'kick punch 1 → beater click noise');
  ok(capture({ type: 'tom', tone: 0.8 }).shapers.length === 0, 'tom unchanged: no drive shaper');
}

// 4) Tom is a triangle; clave a sine; rim a triangle + a noise tick.
{
  ok(capture({ type: 'tom' }).oscs[0].type === 'triangle', 'tom: triangle body');
  const clave = capture({ type: 'clave' });
  ok(clave.oscs.length === 1 && clave.oscs[0].type === 'sine' && clave.sources.length === 0, 'clave: lone sine, no noise');
  const rim = capture({ type: 'rim' });
  ok(rim.oscs.length === 1 && rim.sources.length === 1, 'rim: pitched click + a noise tick');
}

// 5) Hat: 6-square inharmonic cluster + a highpass; cymbal adds a noise shimmer.
{
  const hat = capture({ type: 'hat' });
  const sq = hat.oscs.filter((o) => o.type === 'square');
  ok(sq.length === 6, 'hat: 6-square metallic cluster');
  ok(hat.biquads.some((b) => b.type === 'highpass'), 'hat: highpass on the cluster');
  ok(near(sq[0].frequency.value, 540) && near(sq[1].frequency.value, 540 * 1.342), 'hat: squares at the inharmonic ratios × base');
  ok(capture({ type: 'cymbal' }).sources.length === 1, 'cymbal: adds a noise shimmer source');
}

// 6) Clap is pure noise (no oscillators) through a bandpass; cowbell = 2 squares.
{
  const clap = capture({ type: 'clap' });
  ok(clap.oscs.length === 0 && clap.sources.length === 1, 'clap: noise only, no oscillators');
  ok(clap.biquads.some((b) => b.type === 'bandpass'), 'clap: bandpass');
  ok(capture({ type: 'cowbell' }).oscs.filter((o) => o.type === 'square').length === 2, 'cowbell: two squares');
}

// 7) Gating: Hat's amp env gets a note-off choke (2 setTargetAtTime) vs a one-shot's 1.
{
  const hat = capture({ type: 'hat' }, C4, 0.2);
  ok(hat.gains.some((g) => g.gain._tgt === 2), 'hat (gated): an env gain has the natural decay + the choke');
  const cow = capture({ type: 'cowbell' }, C4, 0.2);
  ok(cow.gains.every((g) => g.gain._tgt <= 1), 'cowbell (one-shot): no env gain is choked');
}

// 8) Accent → brighter: a hat's highpass opens with velocity.
{
  const soft = capture({ type: 'hat' }, C4, 0.2, 0.78).biquads.find((b) => b.type === 'highpass').frequency.value;
  const hard = capture({ type: 'hat' }, C4, 0.2, 1.0).biquads.find((b) => b.type === 'highpass').frequency.value;
  ok(hard > soft, 'accent opens the hat highpass (brighter on accent)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

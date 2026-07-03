// Headless test of the Tervik 3-op FM voice + the select/enum param plumbing.
import { AudioEngine } from '../src/audio.js';
import { defaultPatch, normalizePatch, paramsFor } from '../src/instrument.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// --- fake Web Audio: record nodes, connections, freq, and param schedules ------
let nid = 0;
function param(v = 0) {
  return {
    value: v, _isParam: true, _sched: [],
    setValueAtTime(x, t) { this._sched.push(['set', x, t]); },
    exponentialRampToValueAtTime(x, t) { this._sched.push(['exp', x, t]); this.value = x; },
    linearRampToValueAtTime(x, t) { this._sched.push(['lin', x, t]); this.value = x; },
    setTargetAtTime(x, t, tau) { this._sched.push(['tgt', x, t, tau]); },
    cancelScheduledValues() {},
  };
}
function node(type, extra = {}) {
  return {
    id: ++nid, type, _conns: [], started: false, stopped: false,
    connect(dest, o = 0, i = 0) { this._conns.push({ dest, o, i }); },
    disconnect() { this._conns.length = 0; },
    start() { this.started = true; }, stop() { this.stopped = true; },
    ...extra,
  };
}
function fakeCtx() {
  return {
    currentTime: 0, sampleRate: 44100,
    createGain: () => node('gain', { gain: param(1) }),
    createOscillator: () => node('osc', { type: 'sine', frequency: param(0), detune: param(0), _wave: null, setPeriodicWave(w) { this._wave = w; } }),
    createPeriodicWave: (real, imag, opts) => ({ type: 'wave', real, imag, opts }),
  };
}

// Build one Tervik note into a fake ctx; return {dest, oscs, gains}.
function buildNote(patchOverrides = {}, freq = 440) {
  const eng = new AudioEngine();
  eng.ctx = fakeCtx();
  const dest = eng.ctx.createGain(); dest._conns.length = 0;
  const p = normalizePatch({ kind: 'tervik', ...patchOverrides });
  // playNote path → buildVoice; use the engine's note builder directly.
  eng.master = dest;
  // buildVoice is module-private; go through playNote with laneId null → dest=master.
  eng.patchFor = () => p;
  eng.playNote(60, 0, 1, 0.8, freq, null);
  // collect oscillators + gains created (scan by walking dest graph is hard; instead
  // re-run via a tracking ctx). Simpler: rebuild with a capturing ctx.
  return { eng, dest, p };
}

// Capture all nodes by instrumenting the ctx factories.
function capture(patchOverrides = {}, freq = 440) {
  const eng = new AudioEngine();
  const ctx = fakeCtx();
  const oscs = [], gains = [];
  const g0 = ctx.createGain, o0 = ctx.createOscillator;
  ctx.createGain = () => { const n = g0(); gains.push(n); return n; };
  ctx.createOscillator = () => { const n = o0(); oscs.push(n); return n; };
  eng.ctx = ctx;
  const dest = g0(); // master (not counted in gains)
  eng.master = dest;
  const p = normalizePatch({ kind: 'tervik', ...patchOverrides });
  eng.patchFor = () => p;
  eng.playNote(60, 0, 1, 0.8, freq, null);
  return { oscs, gains, dest, p };
}

// 1) Default patch (pair): 3 oscillators, all started; Op1 sine, Op2/Op3 have a wave.
{
  const { oscs } = capture();
  ok(oscs.length === 3, '3 oscillators built');
  ok(oscs.every((o) => o.started && o.stopped), 'all oscillators started + scheduled to stop');
  ok(oscs[0]._wave == null && oscs[0].type === 'sine', 'Op1 is a pure sine');
  ok(oscs[1]._wave && oscs[2]._wave, 'Op2 & Op3 carry a PeriodicWave (feedback morph)');
}

// 2) Operator frequencies follow ratio × f0.
{
  const { oscs } = capture({ coarse1: 1, coarse2: 2, coarse3: 14 }, 440);
  ok(near(oscs[0].frequency.value, 440), 'Op1 freq = 1×440');
  ok(near(oscs[1].frequency.value, 880), 'Op2 freq = 2×440');
  ok(near(oscs[2].frequency.value, 6160), 'Op3 freq = 14×440');
}

// Helper: where does an oscillator's output go? (gain dest types/targets)
function targetsOf(osc, gains) {
  // osc → gain → (dest gain | another osc.frequency param)
  return osc._conns.map((c) => {
    const g = c.dest; // a gain node
    return g._conns.map((cc) => cc.dest);
  }).flat();
}

// 3) Algorithm routing — Pair (3→2 ; 1): Op1 & Op2 are carriers (→ dest), Op3
//    modulates Op2's frequency.
{
  const { oscs, dest } = capture({ algo: 'pair' });
  const goesToDest = (osc) => osc._conns.some((c) => c.dest._conns.some((cc) => cc.dest === dest));
  const modulates = (osc, targetOsc) => osc._conns.some((c) => c.dest._conns.some((cc) => cc.dest === targetOsc.frequency));
  ok(goesToDest(oscs[0]), 'pair: Op1 → output (carrier)');
  ok(goesToDest(oscs[1]), 'pair: Op2 → output (carrier)');
  ok(modulates(oscs[2], oscs[1]), 'pair: Op3 → Op2.frequency (modulator)');
  ok(!goesToDest(oscs[2]), 'pair: Op3 is not a carrier');
}

// 4) Stack (3→2→1): only Op1 → dest; Op2 → Op1.freq; Op3 → Op2.freq.
{
  const { oscs, dest } = capture({ algo: 'stack' });
  const goesToDest = (osc) => osc._conns.some((c) => c.dest._conns.some((cc) => cc.dest === dest));
  const modulates = (osc, t) => osc._conns.some((c) => c.dest._conns.some((cc) => cc.dest === t.frequency));
  ok(goesToDest(oscs[0]) && !goesToDest(oscs[1]) && !goesToDest(oscs[2]), 'stack: only Op1 is a carrier');
  ok(modulates(oscs[1], oscs[0]), 'stack: Op2 → Op1.freq');
  ok(modulates(oscs[2], oscs[1]), 'stack: Op3 → Op2.freq');
}

// 5) Y ((2+3)→1): Op2 and Op3 both modulate Op1.freq.
{
  const { oscs } = capture({ algo: 'y' });
  const modulates = (osc, t) => osc._conns.some((c) => c.dest._conns.some((cc) => cc.dest === t.frequency));
  ok(modulates(oscs[1], oscs[0]) && modulates(oscs[2], oscs[0]), 'y: Op2 & Op3 both → Op1.freq');
}

// 6) Parallel: all three are carriers (→ dest), none modulate.
{
  const { oscs, dest } = capture({ algo: 'parallel' });
  const goesToDest = (osc) => osc._conns.some((c) => c.dest._conns.some((cc) => cc.dest === dest));
  ok(oscs.every(goesToDest), 'parallel: all three are carriers');
}

// 7) Modulator depth = index × modFreq (pitch-constant). Stack Op2 modulates Op1;
//    level2 × MAX_INDEX(10) × (ratio2 × f0) should be its gain's attack target.
{
  const f0 = 440;
  const { oscs } = capture({ algo: 'stack', level2: 0.5, coarse2: 2, follow2: false }, f0);
  // Op2's gain is the node it connects to; read its gain.exp schedule.
  const modGain = oscs[1]._conns[0].dest;
  const expStep = modGain.gain._sched.find((s) => s[0] === 'exp');
  const expected = 0.5 * 10 * (2 * f0); // 4400
  ok(expStep && near(expStep[1], expected, 1e-3), `modulator depth = index×modFreq (${expected})`);
}

// 8) Follow Op 1: when follow2=on, Op2's modulator uses Op1's ADSR (decay tau = d1),
//    not its own d2.
{
  const { oscs } = capture({ algo: 'stack', follow2: true, d1: 1.4, d2: 0.05 });
  const modGain = oscs[1]._conns[0].dest;
  const tgt = modGain.gain._sched.find((s) => s[0] === 'tgt' && s[3] != null);
  ok(tgt && near(tgt[3], 1.4, 1e-6), 'follow on → Op2 uses Op1 decay (1.4), not its own');
}
{
  const { oscs } = capture({ algo: 'stack', follow2: false, d1: 1.4, d2: 0.05 });
  const modGain = oscs[1]._conns[0].dest;
  const tgt = modGain.gain._sched.find((s) => s[0] === 'tgt' && s[3] != null);
  ok(tgt && near(tgt[3], 0.05, 1e-6), 'follow off → Op2 uses its own decay (0.05)');
}

// 9) Feedback buckets cached per context (same ctx, two notes, one wave object).
{
  const eng = new AudioEngine();
  const ctx = fakeCtx();
  let waveCalls = 0; const cpw = ctx.createPeriodicWave;
  ctx.createPeriodicWave = (...a) => { waveCalls++; return cpw(...a); };
  eng.ctx = ctx; eng.master = ctx.createGain();
  const p = normalizePatch({ kind: 'tervik', feedback: 0.5 });
  eng.patchFor = () => p;
  eng.playNote(60, 0, 1, 0.8, 440, null);
  const after1 = waveCalls;
  eng.playNote(62, 1, 1, 0.8, 494, null);
  ok(waveCalls === after1, 'feedback wave is cached per-context (no rebuild on 2nd note)');
}

// 10) select/enum param: normalize keeps valid algo, rejects bogus → default.
{
  ok(normalizePatch({ kind: 'tervik', algo: 'y' }).algo === 'y', 'valid algo kept');
  ok(normalizePatch({ kind: 'tervik', algo: 'bogus' }).algo === 'pair', 'bad algo → default (pair)');
  ok(normalizePatch({ kind: 'tervik', algo: 42 }).algo === 'pair', 'non-string algo → default');
  const algoSpec = paramsFor('tervik').find((s) => s.key === 'algo');
  ok(algoSpec && algoSpec.sel && algoSpec.options.length === 4, 'algo is a 4-option select param');
}

// 11) defaultPatch tervik has all op params present + finite.
{
  const p = defaultPatch('tervik');
  const keys = ['coarse1','fine1','level1','a1','d1','s1','r1','coarse2','fine2','level2','follow2','a2','d2','s2','r2','coarse3','fine3','level3','follow3','a3','d3','s3','r3','algo','feedback'];
  ok(keys.every((k) => p[k] !== undefined), 'default tervik patch has every param');
  ok(typeof p.follow2 === 'boolean' && typeof p.follow3 === 'boolean', 'follow flags are booleans');
}

// 12) Vesperia/Zindel/Wendelhorn regression: still build their own voice counts.
{
  const v = capture0('vesperia'); ok(v >= 6, `vesperia still builds partials (${v} osc)`);
  const z = capture0('zindel');   ok(z >= 1, `zindel still builds (${z} osc)`);
  const w = capture0('wendelhorn'); ok(w >= 7, `wendelhorn still builds saws+lfos (${w} osc)`);
}
function capture0(kind) {
  const eng = new AudioEngine();
  const ctx = fakeCtx();
  let n = 0; const o0 = ctx.createOscillator;
  ctx.createOscillator = () => { n++; return o0(); };
  // some voices use createStereoPanner / createBiquadFilter / createChannelMerger / createDelay
  ctx.createStereoPanner = () => node('panner', { pan: param(0) });
  ctx.createBiquadFilter = () => node('biquad', { type: 'lowpass', frequency: param(0), Q: param(1) });
  ctx.createDelay = () => node('delay', { delayTime: param(0) });
  ctx.createChannelMerger = () => node('merger');
  eng.ctx = ctx; eng.master = ctx.createGain();
  eng.patchFor = () => defaultPatch(kind);
  eng.playNote(60, 0, 1, 0.8, 440, null);
  return n;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

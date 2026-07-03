// Headless test of the Juno chorus insert + insert-chain wiring + serialization.
// Uses a fake AudioContext that records nodes and connections.
import { AudioEngine } from '../src/audio.js';
import { Arrangement } from '../src/library.js';
import { normalizeChorus, defaultChorus } from '../src/chorus.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// --- fake Web Audio --------------------------------------------------------
let nid = 0;
function param(v = 0) { return { value: v, _isParam: true, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} }; }
function node(type, extra = {}) {
  const n = {
    id: ++nid, type, _conns: [], started: false, stopped: false,
    connect(dest, o = 0, i = 0) { this._conns.push({ dest, o, i }); },
    disconnect() { this._conns.length = 0; },
    ...extra,
  };
  return n;
}
function fakeCtx() {
  return {
    currentTime: 0,
    createGain: () => node('gain', { gain: param(1) }),
    createStereoPanner: () => node('panner', { pan: param(0) }),
    createDelay: () => node('delay', { delayTime: param(0) }),
    createBiquadFilter: () => node('biquad', { type: 'lowpass', frequency: param(0), Q: param(1) }),
    createChannelMerger: () => node('merger'),
    createOscillator: () => node('osc', { type: 'sine', frequency: param(0), start() { this.started = true; }, stop() { this.stopped = true; } }),
  };
}

// Walk forward from a node to the set of node types reachable (1 hop) — used to
// assert chain order.
const destsOf = (n) => n._conns.map((c) => c.dest);
const typesOf = (n) => destsOf(n).map((d) => d.type);

// --- set up an engine on the fake context ----------------------------------
function makeEngine(chorusCfg, delayCfg) {
  const eng = new AudioEngine();
  eng.ctx = fakeCtx();
  eng.master = eng.ctx.createGain();
  eng.laneChorus = () => chorusCfg;
  eng.laneDelay = () => delayCfg;
  eng.laneMix = () => ({ gain: 1, pan: 0 });
  return eng;
}

// 1) Chorus only: panner -> chorus.input -> ... -> chorus.output -> gate.
{
  const eng = makeEngine({ on: true, mode: 'I' }, { on: false });
  const s = eng.laneStrip(0);
  ok(s.chorus, 'chorus insert built when on');
  ok(s.delay == null, 'no delay insert when off');
  // panner should now feed the chorus input (not the gate directly).
  ok(destsOf(s.panner).includes(s.chorus.input), 'panner -> chorus.input');
  ok(!destsOf(s.panner).includes(s.gate), 'panner no longer -> gate directly');
  ok(destsOf(s.chorus.output).includes(s.gate), 'chorus.output -> gate');
}

// 2) LFO count per mode (I=1, II=1, I+II=2), all started, via an instrumented ctx.
for (const [mode, want] of [['I', 1], ['II', 1], ['I+II', 2]]) {
  const eng = new AudioEngine();
  const ctx = fakeCtx();
  let started = 0;
  const realOsc = ctx.createOscillator;
  ctx.createOscillator = () => { const o = realOsc(); const s0 = o.start; o.start = function () { started++; s0.call(this); }; return o; };
  eng.ctx = ctx; eng.master = ctx.createGain();
  eng.laneChorus = () => ({ on: true, mode });
  eng.laneDelay = () => ({ on: false });
  eng.laneMix = () => ({ gain: 1, pan: 0 });
  eng.laneStrip(0);
  ok(started === want, `mode ${mode}: ${want} LFO(s) started (got ${started})`);
}

// 3) Chorus + Delay chain order: panner -> chorus -> delay -> gate.
{
  const eng = makeEngine({ on: true, mode: 'II' }, { on: true, mode: 'mono', timeSec: 0.3, wet: 0.25, feedback: 0.3 });
  const s = eng.laneStrip(0);
  ok(s.chorus && s.delay, 'both inserts built');
  ok(destsOf(s.panner).includes(s.chorus.input), 'panner -> chorus.input (chain head)');
  ok(destsOf(s.chorus.output).includes(s.delay.input), 'chorus.output -> delay.input');
  ok(destsOf(s.delay.output).includes(s.gate), 'delay.output -> gate (chain tail)');
}

// 4) Toggle chorus off at runtime -> panner -> delay -> gate, LFOs stopped.
{
  const eng = makeEngine({ on: true, mode: 'I' }, { on: true, mode: 'mono', timeSec: 0.3, wet: 0.25, feedback: 0.3 });
  const s = eng.laneStrip(0);
  const oldChorus = s.chorus;
  eng.laneChorus = () => ({ on: false });
  eng.applyLaneChorus(0);
  ok(s.chorus == null, 'chorus removed after toggle off');
  ok(destsOf(s.panner).includes(s.delay.input), 'panner -> delay.input after chorus removed');
  ok(destsOf(s.delay.output).includes(s.gate), 'delay still -> gate');
  ok(oldChorus.input._conns.length === 0, 'old chorus disposed (disconnected)');
}

// 5) Mode change rebuilds (new insert object).
{
  const cfg = { on: true, mode: 'I' };
  const eng = makeEngine(cfg, { on: false });
  const s = eng.laneStrip(0);
  const first = s.chorus;
  cfg.mode = 'I+II';
  eng.applyLaneChorus(0);
  ok(s.chorus !== first, 'mode change rebuilds the chorus insert');
  ok(s.chorusMode === 'I+II', 'chorusMode tracks the new mode');
}

// 6) No-op when nothing changed (same insert object kept).
{
  const cfg = { on: true, mode: 'I' };
  const eng = makeEngine(cfg, { on: false });
  const s = eng.laneStrip(0);
  const first = s.chorus;
  eng.applyLaneChorus(0); // same cfg
  ok(s.chorus === first, 'unchanged chorus is not rebuilt');
}

// 7) normalizeChorus coercion.
{
  ok(normalizeChorus(undefined).on === false, 'undefined -> off');
  ok(normalizeChorus({ on: true, mode: 'II' }).mode === 'II', 'valid mode kept');
  ok(normalizeChorus({ on: true, mode: 'bogus' }).mode === 'I', 'bad mode -> default I');
  ok(normalizeChorus({ on: 1, mode: 'I+II' }).on === true, 'truthy on coerced to bool');
}

// 8) Library round-trip carries chorus.
{
  const a = new Arrangement();
  a.lanes[0].chorus = { on: true, mode: 'I+II' };
  const b = Arrangement.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  ok(b.lanes[0].chorus.on === true && b.lanes[0].chorus.mode === 'I+II', 'chorus survives toJSON/fromJSON');
  ok(b.lanes[1].chorus && b.lanes[1].chorus.on === false, 'fresh lane has default (off) chorus');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

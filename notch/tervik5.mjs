// Tervik coarse/fine ratio: defaults shape, snapping, legacy migration, and the
// effective ratio = coarse + fine reaching the oscillators.
import { AudioEngine } from '../src/js/audio/audio.js';
import { defaultPatch, normalizePatch, nearestStep, TERVIK_RATIOS } from '../src/js/audio/instrument.js';

let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;}else{fail++;console.log('FAIL:',m);} };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<=e;

// nearestStep
ok(nearestStep(TERVIK_RATIOS, 2.7) === 3, 'snap 2.7 → 3');
ok(nearestStep(TERVIK_RATIOS, 0.3) === 0.25, 'snap 0.3 → 0.25');
ok(nearestStep(TERVIK_RATIOS, 13.6) === 14, 'snap 13.6 → 14');
ok(nearestStep(TERVIK_RATIOS, 100) === 16, 'snap above range → 16');

// defaults carry coarse/fine, not ratio
{
  const p = defaultPatch('tervik');
  ok(p.coarse1 === 1 && p.fine1 === 0, 'default op1 = coarse 1, fine 0');
  ok(p.coarse3 === 14 && p.fine3 === 0, 'default op3 = coarse 14, fine 0');
  ok(p.ratio1 === undefined, 'no legacy ratio1 in defaults');
}

// normalizePatch snaps coarse to the list, clamps fine
{
  const p = normalizePatch({ kind: 'tervik', coarse1: 2.7, fine1: 5 });
  ok(p.coarse1 === 3, 'coarse 2.7 normalizes to 3');
  ok(p.fine1 === 1, 'fine clamps to +1');
  const q = normalizePatch({ kind: 'tervik', fine2: -9 });
  ok(q.fine2 === -1, 'fine clamps to −1');
}

// legacy single ratioN migrates → coarse (nearest) + fine (remainder)
{
  const p = normalizePatch({ kind: 'tervik', ratio1: 2.3, ratio3: 13.6 });
  ok(p.coarse1 === 2 && near(p.fine1, 0.3, 1e-9), 'ratio1 2.3 → coarse 2 + fine 0.3');
  ok(p.coarse3 === 14 && near(p.fine3, -0.4, 1e-9), 'ratio3 13.6 → coarse 14 + fine −0.4');
  ok(p.ratio1 === undefined, 'legacy ratio key dropped after migration');
}
// migration doesn't fire when coarse already present
{
  const p = normalizePatch({ kind: 'tervik', coarse1: 5, fine1: 0.2, ratio1: 99 });
  ok(p.coarse1 === 5 && near(p.fine1, 0.2), 'explicit coarse/fine win over legacy ratio');
}

// effective ratio = coarse + fine reaches the oscillator frequency
function capture(over) {
  const eng = new AudioEngine();
  const ctx = { currentTime: 0, sampleRate: 44100,
    createGain: () => ({ gain: { value: 1, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){}, cancelScheduledValues(){} }, connect(){}, disconnect(){} }),
    createPeriodicWave: () => ({}), };
  const oscs = [];
  ctx.createOscillator = () => { const o = { type:'sine', frequency:{value:0}, detune:{value:0}, _w:null, setPeriodicWave(w){this._w=w;}, connect(){}, disconnect(){}, start(){}, stop(){} }; oscs.push(o); return o; };
  eng.ctx = ctx; eng.master = ctx.createGain();
  eng.patchFor = () => normalizePatch({ kind: 'tervik', ...over });
  eng.playNote(60, 0, 1, 0.8, 440, null);
  return oscs;
}
{
  const oscs = capture({ coarse1: 1, fine1: 0.5 });   // 1.5×
  ok(near(oscs[0].frequency.value, 1.5 * 440), 'op1 ratio 1 + 0.5 = 1.5× → 660 Hz');
}
{
  const oscs = capture({ coarse2: 2, fine2: -0.25 });  // 1.75×
  ok(near(oscs[1].frequency.value, 1.75 * 440), 'op2 ratio 2 − 0.25 = 1.75× → 770 Hz');
}
{
  const oscs = capture({ coarse1: 0.25, fine1: -1 });  // would be −0.75 → floored
  ok(oscs[0].frequency.value > 0 && near(oscs[0].frequency.value, (1/16) * 440), 'low end floors at 1/16 (no ≤0 ratio)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

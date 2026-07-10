// meter-pad.mjs — render Padlington (each source profile) through the simulator
// and compare its peak/RMS to a default Vesperia note (the loudness reference).
// A metering rig for tuning PAD_NORM (audio.js), not a pass/fail test — run.mjs
// skips it. A pad HOLDS its level, so match it a touch under the Vesperia attack
// peak (equal peak would read hot next to a decaying voice).
// The sim graph is the LEFT channel; pads are metered at width 0 (pan-0 centered,
// where the panner model is exact).
import { makeSimCtx, meter } from './wasim.mjs';
import { AudioEngine } from '../src/js/audio/audio.js';
import { normalizePatch } from '../src/js/audio/instrument.js';

function renderNote(patch, { freq = 261.6256, vel = 0.78, dur = 1.5, secs = 3.0 } = {}) {
  const ctx = makeSimCtx(44100);
  const eng = new AudioEngine();
  eng.ctx = ctx;
  eng.master = ctx.createGain();
  eng.patchFor = () => normalizePatch(patch);
  eng.playNote(60, 0.01, dur, vel, freq, null);
  return meter(ctx.render(eng.master, secs));
}

const ref = renderNote({ kind: 'vesperia' }, { dur: 0.5, secs: 2.0 });
console.log(`vesperia   peak ${ref.peakDb} dB  rms ${ref.rmsDb} dB   <-- reference`);

const variants = [
  ['saw', { source: 'saw' }],
  ['square', { source: 'square' }],
  ['choir ah', { source: 'choir', vowel: 'ah' }],
  ['choir ooh', { source: 'choir', vowel: 'ooh' }],
  ['tilt', { source: 'tilt' }],
];
for (const [name, over] of variants) {
  const m = renderNote({ kind: 'padlington', width: 0, ...over });
  const dPeak = (20 * Math.log10(m.peak / ref.peak)).toFixed(1);
  const dRms = (20 * Math.log10(m.rms / ref.rms)).toFixed(1);
  console.log(`${name.padEnd(10)} peak ${m.peakDb} dB  rms ${m.rmsDb} dB   vs ref: peak ${dPeak} dB, rms ${dRms} dB`);
}

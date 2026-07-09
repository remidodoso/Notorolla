// meter-bosh.mjs — render each Boshwick type through the simulator and compare
// its peak/RMS to a default Vesperia note (the loudness reference).
import { makeSimCtx, meter } from './wasim.mjs';
import { AudioEngine } from '../src/js/audio/audio.js';
import { normalizePatch } from '../src/js/audio/instrument.js';

function renderNote(patch, { freq = 261.6256, vel = 0.78, dur = 0.5, secs = 2.0 } = {}) {
  const ctx = makeSimCtx(44100);
  const eng = new AudioEngine();
  eng.ctx = ctx;
  eng.master = ctx.createGain();
  eng.patchFor = () => normalizePatch(patch);
  eng.playNote(60, 0.01, dur, vel, freq, null);
  return meter(ctx.render(eng.master, secs));
}

const ref = renderNote({ kind: 'vesperia' });
console.log(`vesperia   peak ${ref.peakDb} dB  rms ${ref.rmsDb} dB   <-- reference`);

const types = ['kick', 'tom', 'snare', 'hat', 'clap', 'cowbell', 'rim', 'clave', 'cymbal'];
for (const t of types) {
  // Hat/cymbal are duration-gated: give them a long note so they ring open.
  const dur = (t === 'hat' || t === 'cymbal') ? 1.5 : 0.5;
  const m = renderNote({ kind: 'boshwick', type: t }, { dur });
  const dPeak = (20 * Math.log10(m.peak / ref.peak)).toFixed(1);
  const dRms = (20 * Math.log10(m.rms / ref.rms)).toFixed(1);
  console.log(`${t.padEnd(10)} peak ${m.peakDb} dB  rms ${m.rmsDb} dB   vs ref: peak ${dPeak} dB, rms ${dRms} dB`);
}

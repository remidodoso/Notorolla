// audio.js — turning notes into sound with the Web Audio API.
//
// The instrument is a small additive synth: a few sine partials summed
// per note, shaped by a struck-then-decaying amplitude envelope. It is
// deliberately not rich, so staccato notes, sustained notes, and chords
// all keep their definition. No audio samples — every sound is generated.

// Pitch -> frequency goes through the tuning seam (degreeToFreq), NOT model's
// noteToFreq directly, so alternate tunings/microtonal scales are audible by
// swapping that one mapping. Today degreeToFreq is identity 12-ET, so this is a
// no-op for the current sound.
import { degreeToFreq } from './tuning.js';
import { defaultPatch } from './instrument.js';

// Relative amplitudes of the harmonic partials (1st = fundamental).
// A gentle 1/k-ish rolloff: present enough upper harmonics for definition,
// not so many that chords turn to mud. The extra top partial gives the
// brilliance the tone sweep (below) reveals at the attack. The Timbre control
// tilts this mix at play time (see partialGain); the array itself is the
// neutral (Timbre = 0.5) shape.
const PARTIALS = [1.0, 0.55, 0.36, 0.22, 0.13, 0.07];

// Slight inharmonicity (string stiffness): partials stretch sharp as they
// climb. Small value — just enough to read as "struck string", not "organ".
const INHARMONICITY = 0.0006;

// Filter envelope settle time-constant (s) — how fast the swept cutoff falls
// from its peak to the base. Fixed (not a knob), as the old sound had it.
const FILTER_ENV_TAU = 0.10;

// Reference pitch for filter key tracking: middle C in the default seam. At
// keyTrack = 1 the cutoff is patch.cutoff × (f0 / FREF), i.e. fully relative.
const FREF = degreeToFreq(60);

// Spectral tilt: partial k's amplitude is scaled by k^e, where e runs from
// −SPREAD (dark) through 0 (neutral, timbre 0.5) to +SPREAD (bright).
const TIMBRE_SPREAD = 3;
function partialGain(baseAmp, k, timbre) {
  return baseAmp * Math.pow(k, (timbre - 0.5) * 2 * TIMBRE_SPREAD);
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    // The live instrument patch — read fresh at every note-on, so edits in the
    // instrument pane are heard immediately. main.js may replace this with the
    // persisted/edited patch; until then it's the factory Vesperia.
    this.patch = defaultPatch();
  }

  /** Lazily create/resume the context. Must be called from a user gesture. */
  async ensureRunning() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();

      // A compressor on the master bus keeps stacked chords from clipping.
      const comp = this.ctx.createDynamicsCompressor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx.currentTime;
  }

  get currentTime() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * Play one note: additive partials through a shared gain envelope.
   * @param pitch     tuning degree
   * @param time      absolute AudioContext start time (seconds)
   * @param duration  how long the key is held (seconds) — release begins here
   * @param velocity  0..1
   * @param freq      optional explicit frequency (Hz). When the caller has
   *                  already resolved the degree in a specific tuning it passes
   *                  it here; otherwise we fall back to the default (12-ET) seam.
   */
  playNote(pitch, time, duration, velocity = 0.8, freq = null) {
    const ctx = this.ctx;
    const f0 = freq != null ? freq : degreeToFreq(pitch);
    const p = this.patch;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

    // Signal path: partials -> env (amplitude) -> tone (brightness) -> master.
    const env = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = p.reso;
    env.connect(tone);
    tone.connect(this.master);

    // Amplitude envelope (ADSR). Attack to peak, decay toward the sustain
    // level, hold, then release at note-off. Sustain 0 reproduces the old
    // struck-string decay-to-silence; above 0 the note holds and rings on.
    const peak = velocity * 0.22;                 // headroom for chords
    const sustainLevel = Math.max(peak * p.sustain, 0.00001);
    const releaseTime = time + duration;

    const g = env.gain;
    g.setValueAtTime(0.0001, time);
    g.exponentialRampToValueAtTime(peak, time + p.attack);
    g.setTargetAtTime(sustainLevel, time + p.attack, p.decay); // decay -> sustain
    g.setTargetAtTime(0.0001, releaseTime, p.release);          // key off

    // Filter envelope + key tracking. Cutoff follows pitch by keyTrack (1 =
    // fully f0-relative), opens filterEnv octaves above that base at the attack,
    // then settles to the base — the percussive "strike" over the ringing body.
    const nyq = ctx.sampleRate * 0.45;
    const baseCut = clamp(p.cutoff * Math.pow(f0 / FREF, p.keyTrack), 60, nyq);
    const peakCut = clamp(baseCut * Math.pow(2, p.filterEnv), 60, nyq);
    const tf = tone.frequency;
    tf.setValueAtTime(peakCut, time);
    tf.setTargetAtTime(baseCut, time + p.attack, FILTER_ENV_TAU);

    // Oscillators are cheap; spin up one sine per partial, then discard. The
    // Timbre control tilts the partial amplitudes (k^e) about the neutral mix.
    const stopTime = releaseTime + Math.max(0.6, p.release * 6);
    const oscs = [];
    PARTIALS.forEach((amp, i) => {
      const k = i + 1;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f0 * k * Math.sqrt(1 + INHARMONICITY * k * k);

      const pg = ctx.createGain();
      pg.gain.value = partialGain(amp, k, p.timbre);
      osc.connect(pg);
      pg.connect(env);

      osc.start(time);
      osc.stop(stopTime);
      oscs.push(osc);
    });

    // Release graph nodes when the last oscillator finishes.
    oscs[0].onended = () => { env.disconnect(); tone.disconnect(); };
  }
}

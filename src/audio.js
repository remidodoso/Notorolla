// audio.js — turning notes into sound with the Web Audio API.
//
// The instrument is a small additive synth: a few sine partials summed
// per note, shaped by a struck-then-decaying amplitude envelope. It is
// deliberately not rich, so staccato notes, sustained notes, and chords
// all keep their definition. No audio samples — every sound is generated.

import { noteToFreq } from './model.js';

// Relative amplitudes of the harmonic partials (1st = fundamental).
// A gentle 1/k-ish rolloff: present enough upper harmonics for definition,
// not so many that chords turn to mud. The extra top partial gives the
// brilliance the tone sweep (below) reveals at the attack.
const PARTIALS = [1.0, 0.55, 0.36, 0.22, 0.13, 0.07];

// Slight inharmonicity (string stiffness): partials stretch sharp as they
// climb. Small value — just enough to read as "struck string", not "organ".
const INHARMONICITY = 0.0006;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
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
   * @param pitch     MIDI note number
   * @param time      absolute AudioContext start time (seconds)
   * @param duration  how long the key is held (seconds) — release begins here
   * @param velocity  0..1
   */
  playNote(pitch, time, duration, velocity = 0.8) {
    const ctx = this.ctx;
    const f0 = noteToFreq(pitch);

    // Signal path: partials -> env (amplitude) -> tone (brightness) -> master.
    const env = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 0.5;
    env.connect(tone);
    tone.connect(this.master);

    // Amplitude envelope. Fast attack -> the body decays naturally like a
    // struck string (so a held note rings and fades), then note-off applies a
    // quicker release. Short notes get cut early -> percussive/staccato.
    const peak = velocity * 0.22;       // headroom for chords
    const attack = 0.004;               // snappy onset
    const bodyTau = 1.1;                // ring-down time constant (shorter = decays more, faster)
    const releaseTau = 0.07;            // faster fade once the key lifts
    const releaseTime = time + duration;

    const g = env.gain;
    g.setValueAtTime(0.0001, time);
    g.exponentialRampToValueAtTime(peak, time + attack);
    g.setTargetAtTime(0.0001, time + attack, bodyTau);  // let it ring
    g.setTargetAtTime(0.0001, releaseTime, releaseTau); // key off

    // Tone sweep. The attack is bright (high harmonics pass through), then the
    // lowpass cutoff falls quickly so the sound mellows — this is the percussive
    // "strike", distinct from the steadier ringing body. Cutoffs track pitch so
    // the effect is even across the keyboard.
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const brightCut = clamp(f0 * 11, 2000, 12000);
    const bodyCut = clamp(f0 * 4, 1400, 6000);
    const tf = tone.frequency;
    tf.setValueAtTime(brightCut, time);
    tf.setTargetAtTime(bodyCut, time + attack, 0.10);

    // Oscillators are cheap; spin up one sine per partial, then discard.
    const stopTime = releaseTime + 0.6;
    const oscs = [];
    PARTIALS.forEach((amp, i) => {
      const k = i + 1;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f0 * k * Math.sqrt(1 + INHARMONICITY * k * k);

      const pg = ctx.createGain();
      pg.gain.value = amp;
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

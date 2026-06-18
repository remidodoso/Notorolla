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

// Per-voice peak amplitude (× velocity). Conservative so a few notes / a couple
// of lanes sit well below 0 dBFS — the master limiter only catches the rest, so
// normal playback isn't audibly compressed. The summed partials add on top, so
// the real single-note transient is a few × this. Trimmed ~2.7 dB from the
// original 0.13 (user: "Vesperia is persistently too hot") so 0 dB is the natural
// resting gain for a lane.
const VOICE_PEAK = 0.095;

// Configure the master DynamicsCompressor as a near-transparent ceiling limiter:
// a high threshold (so it does nothing at normal levels — no always-on
// compression), a high ratio + fast attack + short release so it only holds
// peaks just under 0 dBFS. Used on both the live bus and the offline export.
function setupLimiter(comp) {
  comp.threshold.value = -1.5;
  comp.knee.value = 0;
  comp.ratio.value = 20;
  comp.attack.value = 0.003;
  comp.release.value = 0.1;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.meterL = null;       // per-channel AnalyserNodes tapping the final output (stereo meter)
    this.meterR = null;
    this.masterLevel = 0.9;   // master fader value (applied live and to the export)
    // Per-lane mixer strips: laneId -> { volume, gate, panner } nodes in series,
    //   voices -> volume (user Gain knob) -> gate (Mute/Solo 0/1) -> panner (Pan
    //   knob, mono->stereo) -> master.
    // Volume and the mute gate are SEPARATE nodes on purpose: Mute/Solo ramps the
    // gate (gating every voice on the lane at once, present tails included, and
    // revealing live audio on unmute) without disturbing the user's set volume.
    this.laneStrips = new Map();
    // Resolve a lane's mixer settings (gain linear, pan -1..1). main installs a
    // reader of the live lane values; a new strip initializes from this.
    this.laneMix = () => ({ gain: 1, pan: 0 });
    // Resolve a lane's delay insert config { on, mode, timeSec, wet, feedback }
    // (timeSec already tempo-resolved by main). { on:false } = no delay.
    this.laneDelay = () => ({ on: false });
    // The fallback instrument patch (factory Vesperia). Real playback resolves
    // the patch PER LANE via patchFor: each arrangement lane owns its own patch,
    // and un-laned sound (grid audition) gets the grid/neutral patch. main.js
    // installs a resolver that reads the live lane/grid patches; until then
    // everything falls back to this one. Read fresh at every note-on, so edits
    // in the instrument pane are heard immediately.
    this.patch = defaultPatch();
    this.patchFor = () => this.patch;
  }

  // The lane's mixer strip, created lazily and initialized from the resolvers:
  //   volume -> panner -> [delay insert] -> gate(mute) -> master
  // Pan is BEFORE the delay (so ping-pong's hard-L/R isn't re-panned) and the
  // mute gate is LAST (so mute is instant, yet the delay keeps running while
  // muted and unmute reveals its tail). null laneId is handled by laneBus.
  laneStrip(laneId) {
    let s = this.laneStrips.get(laneId);
    if (!s) {
      const m = this.laneMix(laneId);
      const volume = this.ctx.createGain(); volume.gain.value = m.gain;
      const panner = this.ctx.createStereoPanner(); panner.pan.value = m.pan;
      const gate = this.ctx.createGain(); gate.gain.value = 1;
      volume.connect(panner); panner.connect(gate); gate.connect(this.master);
      s = { volume, panner, gate, delay: null, delayMode: null };
      this.laneStrips.set(laneId, s);
      const cfg = this.laneDelay(laneId);
      if (cfg && cfg.on) { this._insertDelay(s, cfg); s.delay.setTime(cfg.timeSec); s.delay.setWet(cfg.wet); s.delay.setFeedback(cfg.feedback); }
    }
    return s;
  }

  // Tear down every per-lane strip (on project load / New Project) so they're
  // rebuilt fresh from the new arrangement — no stale delay inserts (whose
  // feedback can keep ringing with no input), gains/pans, or orphaned strips for
  // lanes that no longer exist. Strips rebuild lazily on the next note/apply.
  resetLanes() {
    for (const s of this.laneStrips.values()) {
      if (s.delay) { try { s.delay.dispose(); } catch (e) { /* already gone */ } }
      s.volume.disconnect();
      s.panner.disconnect();
      s.gate.disconnect();
    }
    this.laneStrips.clear();
  }

  // Splice a freshly built delay insert between the panner and the gate.
  _insertDelay(strip, cfg) {
    strip.panner.disconnect();
    const ins = buildDelayInsert(this.ctx, cfg.mode);
    strip.panner.connect(ins.input);
    ins.output.connect(strip.gate);
    strip.delay = ins;
    strip.delayMode = cfg.mode;
  }

  // Remove the insert, restoring the dry panner -> gate connection.
  _removeDelay(strip) {
    strip.panner.disconnect();
    strip.delay.dispose();
    strip.delay = null;
    strip.delayMode = null;
    strip.panner.connect(strip.gate);
  }

  // (Re)configure a lane's delay from the live resolver: build/remove/rebuild on
  // an on-off or mode change, otherwise just update time/wet/feedback. main calls
  // this on a modal edit, on tempo change (timeSec follows BPM), and after load/undo.
  applyLaneDelay(laneId) {
    if (!this.ctx) return;
    const strip = this.laneStrip(laneId);
    const cfg = this.laneDelay(laneId);
    if (!cfg || !cfg.on) { if (strip.delay) this._removeDelay(strip); return; }
    if (!strip.delay || strip.delayMode !== cfg.mode) {
      if (strip.delay) this._removeDelay(strip);
      this._insertDelay(strip, cfg);
    }
    strip.delay.setTime(cfg.timeSec);
    strip.delay.setWet(cfg.wet);
    strip.delay.setFeedback(cfg.feedback);
  }

  // The destination a lane's voices connect to: its strip input (the volume
  // node), or master directly for un-laned sound (grid, audition).
  laneBus(laneId) {
    if (laneId == null) return this.master;
    return this.laneStrip(laneId).volume;
  }

  // Ramp a lane AudioParam to `value` (or set it instantly when rampSec 0),
  // click-free. Shared by the three lane controls below.
  _rampLaneParam(param, value, rampSec) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    if (rampSec > 0) { param.setValueAtTime(param.value, now); param.linearRampToValueAtTime(value, now + rampSec); }
    else param.setValueAtTime(value, now);
  }

  // Mute/Solo gate (1 = audible, 0 = silent) — gates every voice on the lane at
  // once (present tails and future notes), independent of the volume knob.
  setLaneGain(laneId, value, rampSec = 0.012) {
    if (!this.ctx) return;
    this._rampLaneParam(this.laneStrip(laneId).gate.gain, value, rampSec);
  }

  // User volume (linear gain, the Gain knob).
  setLaneVolume(laneId, value, rampSec = 0.012) {
    if (!this.ctx) return;
    this._rampLaneParam(this.laneStrip(laneId).volume.gain, value, rampSec);
  }

  // Stereo pan (−1 left … 0 center … +1 right, the Pan knob).
  setLanePan(laneId, value, rampSec = 0.012) {
    if (!this.ctx) return;
    this._rampLaneParam(this.laneStrip(laneId).panner.pan, value, rampSec);
  }

  /** Lazily create/resume the context. Must be called from a user gesture. */
  async ensureRunning() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();

      // A limiter on the master bus catches peaks just under 0 dBFS (transparent
      // below — see setupLimiter), so normal playback isn't audibly compressed.
      const comp = this.ctx.createDynamicsCompressor();
      setupLimiter(comp);
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterLevel;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);

      // Tap the final (post-master, post-compressor) signal for the level meter,
      // so it shows exactly what leaves to the device — i.e. where it would clip.
      // An explicit stereo upmix gain ensures centered/mono content reads equally
      // on both bars; a splitter feeds one AnalyserNode per channel (a single
      // analyser would downmix L+R to one number).
      const tap = this.ctx.createGain();
      tap.channelCount = 2; tap.channelCountMode = 'explicit'; tap.channelInterpretation = 'speakers';
      comp.connect(tap);
      const splitter = this.ctx.createChannelSplitter(2);
      tap.connect(splitter);
      this.meterL = this.ctx.createAnalyser(); this.meterL.fftSize = 1024;
      this.meterR = this.ctx.createAnalyser(); this.meterR.fftSize = 1024;
      splitter.connect(this.meterL, 0);
      splitter.connect(this.meterR, 1);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx.currentTime;
  }

  // Set the master fader (applied live with a short anti-zipper ramp; the stored
  // level is also what the offline export uses, so the WAV matches what you hear).
  setMasterGain(v) {
    this.masterLevel = v;
    if (this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(v, now + 0.02);
    }
  }

  // Per-channel peak sample magnitude of the most recent output window, as
  // { l, r } (0..1+, can exceed 1 before the device clamps — the clip condition).
  // { l: 0, r: 0 } if silent / not yet running.
  getPeak() {
    if (!this.meterL) return { l: 0, r: 0 };
    const buf = this._meterBuf || (this._meterBuf = new Float32Array(this.meterL.fftSize));
    const chPeak = (an) => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
      return peak;
    };
    return { l: chPeak(this.meterL), r: chPeak(this.meterR) };
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
   * @param laneId    optional arrangement lane — routes the voice through that
   *                  lane's gain bus (for Mute/Solo). Omit/null for un-laned
   *                  sound (grid playback, audition) → straight to master.
   */
  playNote(pitch, time, duration, velocity = 0.8, freq = null, laneId = null) {
    buildVoice(this.ctx, this.laneBus(laneId), this.patchFor(laneId), pitch, time, duration, velocity, freq);
  }

  /**
   * Faster-than-realtime bounce of a set of notes through the current patch, via
   * an OfflineAudioContext, into an AudioBuffer (mono). Mirrors the live master
   * gain + compressor. `notes` are {pitch, time, duration, velocity, freq} with
   * time/duration already in SECONDS (caller resolves beats/articulation and
   * drops silenced notes). Each note carries its `laneId` so it renders through
   * that lane's instrument patch — the WAV matches what each lane sounds like.
   * Returns a Promise<AudioBuffer>.
   */
  renderToBuffer(notes, durationSec) {
    const sampleRate = this.ctx ? this.ctx.sampleRate : 44100;
    const frames = Math.max(1, Math.ceil(durationSec * sampleRate));
    const oac = new OfflineAudioContext(2, frames, sampleRate); // stereo
    const comp = oac.createDynamicsCompressor();
    setupLimiter(comp);
    const master = oac.createGain();
    master.gain.value = this.masterLevel; // export post-fader
    master.connect(comp);
    comp.connect(oac.destination);

    // Rebuild each lane's volume + pan in the offline graph so the bounce matches
    // the live mix (Mute/Solo is already applied by the caller dropping silenced
    // notes, so no gate is needed here). Un-laned notes go straight to master.
    const strips = new Map();
    const dest = (laneId) => {
      if (laneId == null) return master;
      let s = strips.get(laneId);
      if (!s) {
        const m = this.laneMix(laneId);
        const volume = oac.createGain(); volume.gain.value = m.gain;
        const panner = oac.createStereoPanner(); panner.pan.value = m.pan;
        volume.connect(panner);
        const d = this.laneDelay(laneId);
        if (d && d.on) {
          const ins = buildDelayInsert(oac, d.mode);
          ins.setTime(d.timeSec); ins.setWet(d.wet); ins.setFeedback(d.feedback);
          panner.connect(ins.input); ins.output.connect(master);
        } else {
          panner.connect(master);
        }
        s = volume; strips.set(laneId, s);
      }
      return s;
    };
    for (const n of notes) buildVoice(oac, dest(n.laneId), this.patchFor(n.laneId), n.pitch, n.time, n.duration, n.velocity, n.freq);
    return oac.startRendering();
  }
}

// Build one additive voice into `ctx`, connected to `dest`, shaped by patch `p`.
// Context-parametric so the same synth serves the live AudioContext and an
// OfflineAudioContext (export). See AudioEngine.playNote / renderToBuffer.
function buildVoice(ctx, dest, p, pitch, time, duration, velocity, freq) {
  const f0 = freq != null ? freq : degreeToFreq(pitch);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // Signal path: partials -> env (amplitude) -> tone (brightness) -> dest.
  const env = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.Q.value = p.reso;
  env.connect(tone);
  tone.connect(dest);

  // Amplitude envelope (ADSR). Attack to peak, decay toward the sustain level,
  // hold, then release at note-off. Sustain 0 reproduces the old struck-string
  // decay-to-silence; above 0 the note holds and rings on.
  const peak = velocity * VOICE_PEAK;           // headroom for chords / lanes
  const sustainLevel = Math.max(peak * p.sustain, 0.00001);
  const releaseTime = time + duration;

  const g = env.gain;
  g.setValueAtTime(0.0001, time);
  g.exponentialRampToValueAtTime(peak, time + p.attack);
  g.setTargetAtTime(sustainLevel, time + p.attack, p.decay); // decay -> sustain
  g.setTargetAtTime(0.0001, releaseTime, p.release);          // key off

  // Filter envelope + key tracking. Cutoff follows pitch by keyTrack (1 = fully
  // f0-relative), opens filterEnv octaves above that base at the attack, then
  // settles to the base — the percussive "strike" over the ringing body.
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

  // Release graph nodes when the last oscillator finishes (live only; an offline
  // context is discarded after rendering, so it doesn't matter there).
  oscs[0].onended = () => { env.disconnect(); tone.disconnect(); };
}

const MAX_DELAY = 8; // s — delay-line length ceiling (a whole note at a very slow tempo)

// Build a per-lane delay insert: input -> (dry + wet) -> output, all native Web
// Audio (no WASM). Context-parametric (live + offline export). Returns the I/O
// gains plus setters and a dispose(). Wet/Dry is a crossfade (dry = 1 − wet).
//   mono     — a stereo DelayNode with self-feedback; the echo stays at the dry's pan.
//   pingpong — input summed to mono, then crossfeed: delayL (hard left, T) feeds
//              delayR (hard right, 2T) feeds delayL (3T) …, bouncing, feedback = decay.
function buildDelayInsert(ctx, mode) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry); dry.connect(output); wet.connect(output);
  const nodes = [input, output, dry, wet];

  if (mode === 'pingpong') {
    const mono = ctx.createGain();
    mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
    const dL = ctx.createDelay(MAX_DELAY);
    const dR = ctx.createDelay(MAX_DELAY);
    const pL = ctx.createStereoPanner(); pL.pan.value = -1;
    const pR = ctx.createStereoPanner(); pR.pan.value = 1;
    const fbL = ctx.createGain(); // dL -> dR (cross)
    const fbR = ctx.createGain(); // dR -> dL (cross)
    input.connect(mono); mono.connect(dL);
    dL.connect(pL); pL.connect(wet);
    dL.connect(fbL); fbL.connect(dR);
    dR.connect(pR); pR.connect(wet);
    dR.connect(fbR); fbR.connect(dL);
    nodes.push(mono, dL, dR, pL, pR, fbL, fbR);
    return {
      input, output,
      setTime: (s) => { dL.delayTime.value = s; dR.delayTime.value = s; },
      setWet: (w) => { wet.gain.value = w; dry.gain.value = 1 - w; },
      setFeedback: (f) => { fbL.gain.value = f; fbR.gain.value = f; },
      dispose: () => nodes.forEach((n) => n.disconnect()),
    };
  }

  const d = ctx.createDelay(MAX_DELAY);
  const fb = ctx.createGain();
  input.connect(d); d.connect(wet); d.connect(fb); fb.connect(d);
  nodes.push(d, fb);
  return {
    input, output,
    setTime: (s) => { d.delayTime.value = s; },
    setWet: (w) => { wet.gain.value = w; dry.gain.value = 1 - w; },
    setFeedback: (f) => { fb.gain.value = f; },
    dispose: () => nodes.forEach((n) => n.disconnect()),
  };
}

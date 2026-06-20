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

// Zindel level management. ZINDEL_NORM divides the summed drawbar levels so the
// *default* registration lands near a single Vesperia voice; heavier
// registrations get louder (organ-like) and the master limiter backstops peaks.
// Tunable by ear.
const ZINDEL_NORM = 2.0;

// Zindel FM: each partial is a sine carrier with a sine modulator at this ratio
// (1:1 → harmonic sidebands). The Modulation control (0..1) scales the FM index
// up to ZINDEL_MAX_FM_INDEX; modGain = index × modulator freq keeps the timbre
// constant across pitch.
const ZINDEL_MOD_RATIO = 1;
const ZINDEL_MAX_FM_INDEX = 8;

// Wendelhorn (brass supersaw). The 7 detune positions are Szabo's measured
// irregular spacing, normalized so the outermost = ±1 (÷0.11002314). The Detune
// knob scales them to ±WENDEL_MAX_DETUNE_CENTS; the Ensemble LFO depth scales
// with |position| up to WENDEL_MAX_ENS_CENTS (center = 0, an anchor). Saws are
// random-phase band-limited PeriodicWaves drawn from a per-context pool.
// WENDEL_NORM normalizes the summed saws (tunable by ear).
const WENDEL_OFFSETS = [-1, -0.5716, -0.1774, 0, 0.1810, 0.5650, 0.9766];
const WENDEL_MAX_DETUNE_CENTS = 50;
const WENDEL_MAX_ENS_CENTS = 50;  // outer-saw vibrato depth at Ensemble = 1
const WENDEL_ENS_FLOOR = 0.3;     // min share of that depth for the center saw
                                  //   (depth scales FLOOR..1 with |offset| — "less to center", not none)
const WENDEL_ENS_JITTER = 0.15;   // ±fraction the per-saw LFO rates spread (decorrelation)
// Ensemble lifts the side saws to at least this level (× Ensemble) regardless of
// the Szabo detune-mix, so their slow LFO drift is an audible chorus even at low
// Detune — the fix for "ensemble does nothing unless you detune".
const WENDEL_ENS_SIDE_FLOOR = 0.4;
// Source-level stereo width (an M/S move done on the saws, not the summed signal —
// cheaper and mono-safe). Width spreads the saws across the field and attenuates
// the center (on-tune = the Mid) up to this much, GATED by how much side energy
// backs it, so a near-mono sound is never hollowed out.
const WENDEL_SCOOP_MAX = 0.65;
const WENDEL_NORM = 2.2;
const WENDEL_SAW_POOL = 12;     // random-phase saw waves cached per context
const WENDEL_SAW_HARMONICS = 64; // band-limited (the implementation anti-aliases)
const WENDEL_ENS_LFOS = 3;      // shared ensemble-LFO pool size (each saw taps one — keeps CPU down)
const TWO_PI = Math.PI * 2;

// Tervik (3-op FM). Op 0 (= "Op 1" in the UI) is always the final carrier and its
// ADSR is the reference/amp envelope. routes[i] for op i: -1 = carrier (to output),
// else the index of the op whose frequency this op modulates. A modulator's depth =
// index × its own frequency (pitch-constant brightness, like Zindel), where index =
// Level × TERVIK_MAX_INDEX. TERVIK_NORM normalizes the summed carriers (tune by ear).
const TERVIK_MAX_INDEX = 10;
const TERVIK_NORM = 1.0;
const TERVIK_FB_HARMONICS = 24; // band-limited saw partials blended in by Feedback
const TERVIK_ALGOS = {
  stack:    [-1, 0, 1],   // Op3 → Op2 → Op1
  y:        [-1, 0, 0],   // (Op2 + Op3) → Op1
  pair:     [-1, -1, 1],  // Op3 → Op2 ; Op1
  parallel: [-1, -1, -1], // Op1, Op2, Op3 all carriers
};

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
    // Resolve a lane's chorus insert config { on, mode } (mode = Juno I/II/I+II;
    // rate/depth are fixed presets in buildChorusInsert). { on:false } = no chorus.
    this.laneChorus = () => ({ on: false });
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
  //   volume -> panner -> [chorus insert] -> [delay insert] -> gate(mute) -> master
  // Pan is BEFORE the inserts (so ping-pong's hard-L/R and the chorus's stereo
  // aren't re-panned) and the mute gate is LAST (so mute is instant, yet the
  // inserts keep running while muted and unmute reveals their tails). The inserts
  // are an ordered chain (chorus then delay); _relink rebuilds the edges between
  // the panner, whichever inserts are active, and the gate. null laneId → laneBus.
  laneStrip(laneId) {
    let s = this.laneStrips.get(laneId);
    if (!s) {
      const m = this.laneMix(laneId);
      const volume = this.ctx.createGain(); volume.gain.value = m.gain;
      const panner = this.ctx.createStereoPanner(); panner.pan.value = m.pan;
      const gate = this.ctx.createGain(); gate.gain.value = 1;
      volume.connect(panner); panner.connect(gate); gate.connect(this.master);
      s = { volume, panner, gate, chorus: null, chorusMode: null, delay: null, delayMode: null };
      this.laneStrips.set(laneId, s);
      const ch = this.laneChorus(laneId);
      if (ch && ch.on) { s.chorus = buildChorusInsert(this.ctx, ch.mode); s.chorusMode = ch.mode; }
      const cfg = this.laneDelay(laneId);
      if (cfg && cfg.on) { s.delay = buildDelayInsert(this.ctx, cfg.mode); s.delayMode = cfg.mode; s.delay.setTime(cfg.timeSec); s.delay.setWet(cfg.wet); s.delay.setFeedback(cfg.feedback); }
      if (s.chorus || s.delay) this._relink(s);
    }
    return s;
  }

  // Tear down every per-lane strip (on project load / New Project) so they're
  // rebuilt fresh from the new arrangement — no stale inserts (a delay's feedback
  // can keep ringing, a chorus's LFOs keep sweeping, with no input), gains/pans,
  // or orphaned strips for lanes that no longer exist. Strips rebuild lazily on
  // the next note/apply.
  resetLanes() {
    for (const s of this.laneStrips.values()) {
      if (s.chorus) { try { s.chorus.dispose(); } catch (e) { /* already gone */ } }
      if (s.delay) { try { s.delay.dispose(); } catch (e) { /* already gone */ } }
      s.volume.disconnect();
      s.panner.disconnect();
      s.gate.disconnect();
    }
    this.laneStrips.clear();
  }

  // Rebuild the insert-chain edges: panner -> [chorus] -> [delay] -> gate, skipping
  // whichever inserts are absent. Only the edges between neighbors are touched; the
  // inserts' internal nodes (delay buffers/feedback, chorus LFOs) keep running, so
  // re-linking on one insert's change doesn't disturb the other's tail.
  _relink(strip) {
    strip.panner.disconnect();
    if (strip.chorus) strip.chorus.output.disconnect();
    if (strip.delay) strip.delay.output.disconnect();
    let head = strip.panner;
    for (const ins of [strip.chorus, strip.delay]) {
      if (!ins) continue;
      head.connect(ins.input);
      head = ins.output;
    }
    head.connect(strip.gate);
  }

  // (Re)configure a lane's chorus from the live resolver: build/remove on an
  // on-off or mode change, then relink. main calls this on a modal edit and after
  // load/undo. Unlike the delay the chorus has no live params (rate/depth are
  // fixed Juno presets), so any change is a rebuild.
  applyLaneChorus(laneId) {
    if (!this.ctx) return;
    const strip = this.laneStrip(laneId);
    const cfg = this.laneChorus(laneId);
    const want = cfg && cfg.on ? cfg.mode : null;
    if (strip.chorusMode === want) return;
    if (strip.chorus) { strip.chorus.dispose(); strip.chorus = null; strip.chorusMode = null; }
    if (want) { strip.chorus = buildChorusInsert(this.ctx, want); strip.chorusMode = want; }
    this._relink(strip);
  }

  // (Re)configure a lane's delay from the live resolver: build/remove/rebuild on
  // an on-off or mode change (then relink), otherwise just update time/wet/feedback.
  // main calls this on a modal edit, on tempo change (timeSec follows BPM), and
  // after load/undo.
  applyLaneDelay(laneId) {
    if (!this.ctx) return;
    const strip = this.laneStrip(laneId);
    const cfg = this.laneDelay(laneId);
    const want = cfg && cfg.on ? cfg.mode : null;
    if (strip.delayMode !== want) {
      if (strip.delay) { strip.delay.dispose(); strip.delay = null; strip.delayMode = null; }
      if (want) { strip.delay = buildDelayInsert(this.ctx, want); strip.delayMode = want; }
      this._relink(strip);
    }
    if (strip.delay) { strip.delay.setTime(cfg.timeSec); strip.delay.setWet(cfg.wet); strip.delay.setFeedback(cfg.feedback); }
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
        // Mirror the live insert chain panner -> [chorus] -> [delay] -> master.
        let head = panner;
        const ch = this.laneChorus(laneId);
        if (ch && ch.on) { const ci = buildChorusInsert(oac, ch.mode); head.connect(ci.input); head = ci.output; }
        const d = this.laneDelay(laneId);
        if (d && d.on) {
          const ins = buildDelayInsert(oac, d.mode);
          ins.setTime(d.timeSec); ins.setWet(d.wet); ins.setFeedback(d.feedback);
          head.connect(ins.input); head = ins.output;
        }
        head.connect(master);
        s = volume; strips.set(laneId, s);
      }
      return s;
    };
    for (const n of notes) buildVoice(oac, dest(n.laneId), this.patchFor(n.laneId), n.pitch, n.time, n.duration, n.velocity, n.freq);
    return oac.startRendering();
  }
}

// Dispatch a note to the right instrument by patch kind. Context-parametric so
// the same synths serve the live AudioContext and an OfflineAudioContext
// (export). Unknown/missing kind falls back to Vesperia. See playNote /
// renderToBuffer; the patch shapes live in instrument.js.
function buildVoice(ctx, dest, p, pitch, time, duration, velocity, freq) {
  switch (p && p.kind) {
    case 'zindel': return buildZindelVoice(ctx, dest, p, pitch, time, duration, velocity, freq);
    case 'wendelhorn': return buildWendelhornVoice(ctx, dest, p, pitch, time, duration, velocity, freq);
    case 'tervik': return buildTervikVoice(ctx, dest, p, pitch, time, duration, velocity, freq);
    default: return buildVesperiaVoice(ctx, dest, p, pitch, time, duration, velocity, freq);
  }
}

// Build one Vesperia voice into `ctx`, connected to `dest`, shaped by patch `p`:
// additive partials through a shared amplitude envelope and a resonant lowpass
// with its own envelope + key tracking.
function buildVesperiaVoice(ctx, dest, p, pitch, time, duration, velocity, freq) {
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

// Build one Zindel voice: eight drawbar partials, each a 2-op FM stack (sine
// carrier + sine modulator) with its own copy of the one ADSR. Modulation sets
// the FM index (0 = pure sine); higher partials run the amplitude envelope faster
// (Acceleration), so the tone darkens over time without a filter; Spread
// stretches the partials off the integer harmonics.
function buildZindelVoice(ctx, dest, p, pitch, time, duration, velocity, freq) {
  const f0 = freq != null ? freq : degreeToFreq(pitch);
  const bars = [p.d1, p.d2, p.d3, p.d4, p.d5, p.d6, p.d7, p.d8];
  const releaseTime = time + duration;
  const norm = velocity * VOICE_PEAK / ZINDEL_NORM;
  const modIndex = p.modulation * ZINDEL_MAX_FM_INDEX; // 0 = no FM (pure sine)

  bars.forEach((lvl, i) => {
    if (lvl <= 0.0005) return; // a closed drawbar makes no oscillator
    const k = i + 1;
    const mult = 1 + (k - 1) * (1 + p.spread); // integer harmonic at spread 0
    const carrierFreq = f0 * mult;

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = carrierFreq;

    // Per-partial amplitude envelope. ts < 1 for upper partials (faster as
    // Acceleration rises), so they decay sooner — the filter-less brightness sweep.
    const ts = 1 / (1 + p.acceleration * (k - 1));
    const a = Math.max(0.0005, p.attack * ts);
    const d = Math.max(0.005, p.decay * ts);
    const r = Math.max(0.005, p.release * ts);
    const peak = Math.max(lvl * norm, 0.0002);
    const sustain = Math.max(peak * p.sustain, 0.00001);

    const pg = ctx.createGain();
    const g = pg.gain;
    g.setValueAtTime(0.0001, time);
    g.exponentialRampToValueAtTime(peak, time + a);
    g.setTargetAtTime(sustain, time + a, d);
    g.setTargetAtTime(0.0001, releaseTime, r);

    carrier.connect(pg);
    pg.connect(dest);

    // 2-op FM: a sine modulator drives the carrier's frequency. modGain = index ×
    // modulator freq, so the spectrum (sideband spread) is constant across pitch.
    let mod = null, modGain = null;
    if (modIndex > 0) {
      const modFreq = carrierFreq * ZINDEL_MOD_RATIO;
      mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = modFreq;
      modGain = ctx.createGain();
      modGain.gain.value = modIndex * modFreq;
      mod.connect(modGain);
      modGain.connect(carrier.frequency);
    }

    const stop = releaseTime + Math.max(0.4, r * 6);
    carrier.start(time);
    carrier.stop(stop);
    if (mod) { mod.start(time); mod.stop(stop); }
    carrier.onended = () => { pg.disconnect(); if (modGain) modGain.disconnect(); }; // live cleanup (no-op offline)
  });
}

// A per-context cache of sine→saw blended waves for Tervik's modulators (the
// Feedback morph). Feedback 0 = pure sine (fundamental only); toward 1 the band-
// limited saw harmonics (1/h) fade in. disableNormalization keeps the fundamental
// at unit amplitude, so the modulation-index math stays stable at low feedback.
function tervikModWave(ctx, feedback) {
  const key = Math.round(Math.min(1, Math.max(0, feedback)) * 20); // 21 cache buckets
  const cache = ctx._tervikWaves || (ctx._tervikWaves = new Map());
  if (cache.has(key)) return cache.get(key);
  const amt = key / 20;
  const n = TERVIK_FB_HARMONICS + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let h = 1; h < n; h++) imag[h] = h === 1 ? 1 : amt / h;
  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  cache.set(key, wave);
  return wave;
}

// ADSR onto a gain/depth param: 0 → peak (attack), → sustain×peak (decay), hold,
// → 0 (release at note-off). Shared by Tervik's carriers and modulators (for a
// modulator `peak` is the FM depth in Hz, for a carrier it's the amplitude).
function tervikEnvelope(param, env, time, releaseTime, peak) {
  const top = Math.max(peak, 0.0002);
  const sustain = Math.max(top * env.s, 0.0000001);
  param.setValueAtTime(0.0001, time);
  param.exponentialRampToValueAtTime(top, time + env.a);
  param.setTargetAtTime(sustain, time + env.a, env.d); // decay → sustain
  param.setTargetAtTime(0.0000001, releaseTime, env.r); // key off
}

// Build one Tervik voice: a 3-operator FM voice. Op 1 (index 0) is always the
// final carrier and its ADSR is the reference/amp envelope; the Algorithm routes
// Ops 2 & 3 as modulators (into another op's frequency) or as extra carriers. A
// modulator's depth = index × its own frequency (constant brightness across pitch,
// as in Zindel); Ops 2 & 3 may FOLLOW Op 1's envelope (Level = the amount) instead
// of their own ADSR. Feedback morphs Ops 2 & 3 from sine toward a band-limited saw.
function buildTervikVoice(ctx, dest, p, pitch, time, duration, velocity, freq) {
  const f0 = freq != null ? freq : degreeToFreq(pitch);
  const releaseTime = time + duration;
  const routes = TERVIK_ALGOS[p.algo] || TERVIK_ALGOS.stack;
  const carrierNorm = velocity * VOICE_PEAK / TERVIK_NORM;
  const modWave = tervikModWave(ctx, p.feedback);

  const ops = [
    { ratio: p.ratio1, level: p.level1, env: { a: p.a1, d: p.d1, s: p.s1, r: p.r1 }, follow: false },
    { ratio: p.ratio2, level: p.level2, env: { a: p.a2, d: p.d2, s: p.s2, r: p.r2 }, follow: !!p.follow2 },
    { ratio: p.ratio3, level: p.level3, env: { a: p.a3, d: p.d3, s: p.s3, r: p.r3 }, follow: !!p.follow3 },
  ];
  const refEnv = ops[0].env; // Op 1's ADSR — the reference Ops 2 & 3 can follow

  // Op 1 is a pure sine; Ops 2 & 3 carry the Feedback waveshape (sine → saw).
  const oscs = ops.map((o, i) => {
    const osc = ctx.createOscillator();
    if (i === 0) osc.type = 'sine';
    else osc.setPeriodicWave(modWave);
    osc.frequency.value = o.ratio * f0;
    return osc;
  });

  const gains = [];
  ops.forEach((o, i) => {
    const env = o.follow ? refEnv : o.env;
    const g = ctx.createGain();
    if (routes[i] < 0) {
      // Carrier: amplitude-enveloped to the output (carriers sum at dest).
      tervikEnvelope(g.gain, env, time, releaseTime, o.level * carrierNorm);
      oscs[i].connect(g); g.connect(dest);
    } else {
      // Modulator: enveloped FM depth into the target op's frequency.
      const depth = (o.level * TERVIK_MAX_INDEX) * (o.ratio * f0);
      tervikEnvelope(g.gain, env, time, releaseTime, depth);
      oscs[i].connect(g); g.connect(oscs[routes[i]].frequency);
    }
    gains.push(g);
  });

  // The amp tail follows Op 1's release (the reference/amp envelope).
  const stop = releaseTime + Math.max(0.5, p.r1 * 6);
  oscs.forEach((osc) => { osc.start(time); osc.stop(stop); });
  oscs[0].onended = () => { gains.forEach((g) => g.disconnect()); }; // live cleanup (no-op offline)
}

// Szabo-style supersaw mix: the center saw level falls slightly as Detune opens
// while the side saws swell in (d = Detune knob 0..1) — so low detune ≈ one saw,
// high detune ≈ full ensemble.
function wendelCenterGain(d) { return -0.55366 * d + 0.99785; }
function wendelSideGain(d) { return Math.max(0, -0.73764 * d * d + 1.2841 * d + 0.044372); }

// A per-context pool of random-phase band-limited sawtooth waves. Web Audio
// oscillators always start at phase 0 and can't be re-phased, so a stack of
// identical saws would beat coherently; baking a random phase into each wave (a
// time shift rotates harmonic h by h·φ) decorrelates them — the "lush" supersaw.
function wendelSawWaves(ctx) {
  if (ctx._wendelSaws) return ctx._wendelSaws;
  const pool = [];
  const n = WENDEL_SAW_HARMONICS + 1;
  for (let p = 0; p < WENDEL_SAW_POOL; p++) {
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    const phase = Math.random() * TWO_PI;
    for (let h = 1; h < n; h++) {
      const amp = 1 / h; // sawtooth 1/h rolloff
      real[h] = amp * Math.sin(h * phase);
      imag[h] = amp * Math.cos(h * phase);
    }
    pool.push(ctx.createPeriodicWave(real, imag, { disableNormalization: false }));
  }
  ctx._wendelSaws = pool;
  return pool;
}

// A sine oscillator with a random start phase (a 1-harmonic PeriodicWave), so the
// ensemble LFOs don't all begin moving in the same direction at note-on.
// disableNormalization keeps the amplitude at ±1 so the depth gain reads in cents.
function wendelLFO(ctx, rate, phase) {
  const osc = ctx.createOscillator();
  const real = new Float32Array([0, Math.sin(phase)]);
  const imag = new Float32Array([0, Math.cos(phase)]);
  osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
  osc.frequency.value = rate;
  return osc;
}

// Build one Wendelhorn voice: 7 detuned random-phase saws (Szabo spacing + side
// swell), each with an uneven slow pitch LFO (Ensemble/Speed) and a pan by
// detune (Stereo), summed through one ADSR amp envelope and a resonant lowpass
// with envelope (the brass swell — same shape as Vesperia).
function buildWendelhornVoice(ctx, dest, p, pitch, time, duration, velocity, freq) {
  const f0 = freq != null ? freq : degreeToFreq(pitch);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const releaseTime = time + duration;
  const stop = releaseTime + Math.max(0.4, p.release * 6);

  // Amp envelope -> tone (lowpass) -> dest. One envelope for the whole stack.
  const env = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.Q.value = p.reso;
  env.connect(tone);
  tone.connect(dest);

  const peak = velocity * VOICE_PEAK;
  const sustainLevel = Math.max(peak * p.sustain, 0.00001);
  const g = env.gain;
  g.setValueAtTime(0.0001, time);
  g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), time + p.attack);
  g.setTargetAtTime(sustainLevel, time + p.attack, p.decay);
  g.setTargetAtTime(0.0001, releaseTime, p.release);

  // Filter envelope + key tracking (opens on attack, settles to base).
  const nyq = ctx.sampleRate * 0.45;
  const baseCut = clamp(p.cutoff * Math.pow(f0 / FREF, p.keyTrack), 60, nyq);
  const peakCut = clamp(baseCut * Math.pow(2, p.filterEnv), 60, nyq);
  const tf = tone.frequency;
  tf.setValueAtTime(peakCut, time);
  tf.setTargetAtTime(baseCut, time + p.attack, FILTER_ENV_TAU);

  const waves = wendelSawWaves(ctx);
  const ensembleOn = p.ensemble > 0.0005 && p.speed > 0;

  // Per-saw levels. Side saws follow the Szabo swell, but Ensemble lifts them to a
  // floor so the chorus is audible at any Detune. Width then scoops the center
  // (the on-tune Mid) — but only as far as the side energy supports it (so a
  // low-detune, low-ensemble sound stays centered, never hollowed).
  const cGain = wendelCenterGain(p.detune);
  const sGain = Math.max(wendelSideGain(p.detune), WENDEL_ENS_SIDE_FLOOR * p.ensemble);
  const scoopGate = Math.min(1, sGain / Math.max(cGain, 1e-3));
  const cGainWide = cGain * (1 - p.stereo * WENDEL_SCOOP_MAX * scoopGate);
  const lastIdx = WENDEL_OFFSETS.length - 1;

  // Nodes to release when the voice ends (live only; offline ctx is discarded).
  const extra = [env, tone];
  const stopOscs = []; // every oscillator we start (saws + LFOs), to stop + clean

  // A small shared pool of decorrelated LFOs (different rates + random phases);
  // each saw taps one, so the ensemble shimmer stays lively without an oscillator
  // per saw (7 saws + 3 LFOs/voice, not 7 + 7).
  let shared = null;
  if (ensembleOn) {
    shared = [];
    for (let j = 0; j < WENDEL_ENS_LFOS; j++) {
      const rate = p.speed * (1 + (j - (WENDEL_ENS_LFOS - 1) / 2) * WENDEL_ENS_JITTER);
      const lfo = wendelLFO(ctx, rate, Math.random() * TWO_PI);
      lfo.start(time); lfo.stop(stop);
      shared.push(lfo); stopOscs.push(lfo); extra.push(lfo);
    }
  }

  WENDEL_OFFSETS.forEach((off, i) => {
    const isCenter = off === 0;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(waves[Math.floor(Math.random() * waves.length)]); // random phase
    osc.frequency.value = f0;
    const staticDetune = off * WENDEL_MAX_DETUNE_CENTS * p.detune; // static spread (cents)

    // Pitch attack (synth-brass blip): start `pitchAtk` cents sharp and exp-decay
    // to the static detune over ~pitchAtkTime. Scheduled on the detune param so it
    // sums with the ensemble LFO (a connected node). 0 cents = off.
    if (p.pitchAtk > 0.01 && p.pitchAtkTime > 0) {
      osc.detune.setValueAtTime(staticDetune + p.pitchAtk, time);
      osc.detune.setTargetAtTime(staticDetune, time, p.pitchAtkTime / 4);
    } else {
      osc.detune.value = staticDetune;
    }

    // Uneven ensemble vibrato: depth scales FLOOR..1 with |position|, so every saw
    // moves but the outer ones swing most and the center least. Modulates detune (cents).
    const depth = (WENDEL_ENS_FLOOR + (1 - WENDEL_ENS_FLOOR) * Math.abs(off)) * WENDEL_MAX_ENS_CENTS * p.ensemble;
    if (ensembleOn && depth > 0) {
      const lfo = shared[i % shared.length]; // tap one of the shared pool
      const dg = ctx.createGain();
      dg.gain.value = depth;
      lfo.connect(dg);
      dg.connect(osc.detune);
      extra.push(dg);
    }

    const cg = ctx.createGain();
    cg.gain.value = (isCenter ? cGainWide : sGain) / WENDEL_NORM;
    const pan = ctx.createStereoPanner();
    // Even spread by index (flat → left, sharp → right) so the inner saws don't
    // bunch up at center — a wider image than panning by raw detune offset.
    pan.pan.value = clamp(((i / lastIdx) * 2 - 1) * p.stereo, -1, 1);

    osc.connect(cg);
    cg.connect(pan);
    pan.connect(env);
    osc.start(time);
    osc.stop(stop);
    stopOscs.push(osc);
    extra.push(cg, pan);
  });

  // The center saw is always present; use it to release the whole graph.
  stopOscs[stopOscs.length - 1].onended = () => { for (const n of extra) n.disconnect(); };
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

// --- Juno-60 chorus insert ----------------------------------------------------
// A bucket-brigade (BBD) chorus: the dry signal passes through untouched while a
// short (~5 ms) delay line is swept by a slow triangle LFO — the pitch wobble from
// sweeping the delay IS the chorus. The famous Juno stereo comes from one delay
// line mixed +to-left / −to-right (anti-phase), which throws a wide hollow image
// and (authentically) collapses toward mono when L+R are summed. The two front-
// panel modes are LFO rate/depth presets; I+II runs both LFOs at once. A gentle
// lowpass models the BBD's limited bandwidth. Context-parametric (live + offline).
const CHORUS_MAX_DELAY = 0.05; // s — delay-line ceiling (well above the swept range)
const CHORUS_BASE = 0.0052;    // s — nominal BBD delay (~5 ms), the sweep centre
const CHORUS_WET = 0.7;        // wet level each side (dry stays unity)
const CHORUS_BBD_LP = 9000;    // Hz — bucket-brigade bandwidth softening
// Per mode: the triangle LFO(s) that modulate the delay time, as { rate Hz, depth s }.
// Rates are the measured Juno-60 chorus rates; depths are tuned to its sweep.
const CHORUS_LFOS = {
  'I':    [{ rate: 0.513, depth: 0.0016 }],
  'II':   [{ rate: 0.863, depth: 0.0031 }],
  'I+II': [{ rate: 0.513, depth: 0.0016 }, { rate: 0.863, depth: 0.0031 }],
};

function buildChorusInsert(ctx, mode) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  input.connect(dry); dry.connect(output); // dry keeps the incoming stereo/pan
  const nodes = [input, output, dry];
  const lfos = [];

  // Wet path: sum to mono (single BBD line) -> swept delay -> bandwidth lowpass.
  const mono = ctx.createGain();
  mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
  const delay = ctx.createDelay(CHORUS_MAX_DELAY);
  delay.delayTime.value = CHORUS_BASE;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = CHORUS_BBD_LP;
  input.connect(mono); mono.connect(delay); delay.connect(lp);

  // Anti-phase stereo: the wet goes +to-left and −to-right via a 2-in merger.
  const merger = ctx.createChannelMerger(2);
  const wetL = ctx.createGain(); wetL.gain.value = CHORUS_WET;
  const wetR = ctx.createGain(); wetR.gain.value = -CHORUS_WET;
  lp.connect(wetL); lp.connect(wetR);
  wetL.connect(merger, 0, 0); wetR.connect(merger, 0, 1);
  merger.connect(output);
  nodes.push(mono, delay, lp, merger, wetL, wetR);

  // Triangle LFO(s) modulate the delay time (multiple sum on the AudioParam).
  for (const c of (CHORUS_LFOS[mode] || CHORUS_LFOS['I'])) {
    const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = c.rate;
    const depth = ctx.createGain(); depth.gain.value = c.depth;
    lfo.connect(depth); depth.connect(delay.delayTime);
    lfo.start();
    nodes.push(depth); lfos.push(lfo);
  }

  return {
    input, output,
    dispose: () => {
      lfos.forEach((o) => { try { o.stop(); } catch (e) { /* already stopped */ } });
      nodes.concat(lfos).forEach((n) => n.disconnect());
    },
  };
}

// instrument.js — the instrument registry: each "kind" of synth voice and the
// editable parameters that define it.
//
// A "patch" is a plain settings struct that carries a `kind` tag. The audio
// engine dispatches on that kind at note-on (see audio.js buildVoice), so an
// edit is heard on the very next note with no node re-wiring; the editor pane
// renders that kind's PARAMS. Adding an instrument is a new registry entry here
// (plus its DSP branch in audio.js) — a lookup, not a rewrite.
//
// Vesperia is the original One True Instrument; its DEFAULTS reproduce the
// synth's prior hard-coded sound bit-for-bit (central register), and a kind's
// Factory Reset returns to its own defaults.

// Default cutoff = 4 × C4 (261.63 Hz). With Key Track at 1 this makes the
// per-note settle cutoff f0×4 — exactly the old hard-coded body cutoff.
const C4 = 261.6255653;

const secs = (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const pct = (v) => `${Math.round(v * 100)}%`;
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);

// --- Vesperia: additive partials through a shared amplitude envelope and a
// resonant lowpass with its own envelope + key tracking. -----------------------

const VESPERIA_DEFAULTS = {
  // Amplitude envelope. Sustain 0 = the old struck-string ring-down (decay is
  // the old ring time-constant); above 0 the note holds until release.
  attack: 0.004,   // s — snappy onset
  decay: 1.1,      // s — decay/ring time-constant toward the sustain level
  sustain: 0,      // 0..1 of peak — 0 reproduces the old decay-to-silence
  release: 0.07,   // s — fade once the key lifts

  // Timbre: a spectral tilt over the fixed partial mix. 0.5 = neutral (the old
  // mix exactly); below darkens (upper partials attenuated), above brightens.
  timbre: 0.5,

  // Resonant lowpass with its own envelope + keyboard tracking.
  cutoff: 4 * C4,  // Hz — base/settle cutoff (before key tracking)
  reso: 0.5,       // filter Q
  filterEnv: 1.46, // octaves the envelope opens cutoff above base at the attack
                   // (2^1.46 ≈ 2.75 = the old bright/body 11:4 ratio)
  keyTrack: 1,     // 0..1 — how much cutoff follows pitch (1 = fully f0-relative)
};

const VESPERIA_PARAMS = [
  { key: 'attack', group: 'Amp Envelope', label: 'Attack', min: 0.001, max: 1.5, log: true, fmt: secs,
    title: 'Time from note-on to full level.' },
  { key: 'decay', group: 'Amp Envelope', label: 'Decay', min: 0.02, max: 5, log: true, fmt: secs,
    title: 'How quickly the level falls toward the sustain after the attack. (At Sustain 0 this is the ring-down time.)' },
  { key: 'sustain', group: 'Amp Envelope', label: 'Sustain', min: 0, max: 1, fmt: pct,
    title: 'Level the note holds at while sounding. 0 = decay to silence (the old struck-string behavior).' },
  { key: 'release', group: 'Amp Envelope', label: 'Release', min: 0.01, max: 3, log: true, fmt: secs,
    title: 'Fade time once the note ends.' },

  { key: 'timbre', group: 'Timbre', label: 'Timbre', min: 0, max: 1, fmt: (v) => (v < 0.5 ? 'darker' : v > 0.5 ? 'brighter' : 'neutral'),
    title: 'Spectral tilt over the harmonics: left darkens (fewer upper partials), right brightens. Centre is the default mix.' },

  { key: 'cutoff', group: 'Filter', label: 'Cutoff', min: 120, max: 14000, log: true, fmt: hz,
    title: 'Lowpass cutoff (base, before key tracking).' },
  { key: 'reso', group: 'Filter', label: 'Resonance', min: 0.5, max: 18, fmt: (v) => `Q ${v.toFixed(1)}`,
    title: 'Filter resonance — a peak at the cutoff. High values whistle/ring.' },
  { key: 'filterEnv', group: 'Filter', label: 'Env Amount', min: 0, max: 4, fmt: (v) => `${v.toFixed(2)} oct`,
    title: 'How far the filter envelope opens the cutoff above its base at the attack, then settles.' },
  { key: 'keyTrack', group: 'Filter', label: 'Key Track', min: 0, max: 1, fmt: pct,
    title: 'How much the cutoff follows pitch: 0 = fixed Hz, 1 = fully relative to each note.' },
];

// --- Zindel: a drawbar additive organ. Eight harmonic partials (drawbars 1–8),
// each a 2-op FM stack (a sine carrier with a sine modulator) whose brightness is
// the Modulation control, detuned off the integer harmonics by Spread. One ADSR
// is applied to every partial, but the higher partials run it faster
// (Acceleration) — a per-partial decay that darkens the tone over time in place
// of a filter. ---------------------------------------------------------------

const ZINDEL_DEFAULTS = {
  // Drawbar levels (harmonics 1–8). Default = Hammond-ish: a full fundamental
  // and octave with a touch of 3rd and 5th "color", the rest low.
  d1: 1.0, d2: 0.55, d3: 0.35, d4: 0.15, d5: 0.28, d6: 0.08, d7: 0.05, d8: 0.1,

  // Tone. Modulation is the FM index — 0 = pure sine partials, up = brighter
  // (harmonic sidebands, 1:1 carrier:modulator). Spread stretches the partial
  // spacing off the integer harmonics (0 = pure harmonic, + = inharmonic/bell).
  modulation: 0,
  spread: 0,

  // One amplitude envelope, applied per partial. High sustain = organ hold; the
  // short decay + a little acceleration give the slightly percussive onset.
  attack: 0.005,
  decay: 0.25,
  sustain: 0.8,
  release: 0.06,

  // Acceleration: how much faster the upper partials run the envelope (0 = all
  // partials share one ADSR; higher = upper partials decay first, like a filter).
  acceleration: 0.25,
};

const fm = (v) => (v <= 0 ? 'sine' : `${Math.round(v * 100)}%`);
const ratio = (v) => (Math.abs(v) < 0.005 ? 'harmonic' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%`);

// Eight drawbar params (harmonics 1–8), linear 0..1, shown as a row of faders.
const ZINDEL_DRAWBARS = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({
  key: `d${k}`, group: 'Drawbars', label: String(k), bar: true, min: 0, max: 1, fmt: pct,
  title: `Level of harmonic ${k}.`,
}));

const ZINDEL_PARAMS = [
  ...ZINDEL_DRAWBARS,

  { key: 'modulation', group: 'Tone', label: 'Modulation', min: 0, max: 1, fmt: fm,
    title: 'FM brightness: each partial is a sine carrier with a 1:1 sine modulator. 0 = pure sine; up adds harmonic sidebands (richer/brassier).' },
  { key: 'spread', group: 'Tone', label: 'Spread', min: -0.3, max: 0.6, fmt: ratio,
    title: 'Stretches the spacing of the partials off the integer harmonics. 0 = pure harmonic; positive detunes them apart (bell/metallic).' },

  { key: 'attack', group: 'Amp Envelope', label: 'Attack', min: 0.001, max: 1.5, log: true, fmt: secs,
    title: 'Time from note-on to full level (applied per partial).' },
  { key: 'decay', group: 'Amp Envelope', label: 'Decay', min: 0.02, max: 5, log: true, fmt: secs,
    title: 'How quickly each partial falls toward the sustain after the attack.' },
  { key: 'sustain', group: 'Amp Envelope', label: 'Sustain', min: 0, max: 1, fmt: pct,
    title: 'Level the partials hold at while the note sounds. High = organ hold.' },
  { key: 'release', group: 'Amp Envelope', label: 'Release', min: 0.01, max: 3, log: true, fmt: secs,
    title: 'Fade time once the note ends.' },

  { key: 'acceleration', group: 'Motion', label: 'Acceleration', min: 0, max: 1, fmt: pct,
    title: 'How much faster the upper partials run the envelope — they decay first, darkening the tone over time (the filter substitute).' },
];

// --- Wendelhorn: a brass "supersaw" ensemble. Seven detuned, random-phase
// band-limited saws (Szabo-style irregular spacing; the side saws swell in as
// Detune opens) with an uneven per-saw pitch LFO (Ensemble/Speed — more wobble
// on the outer saws, none on the center), a stereo spread by detune, into a
// resonant lowpass with envelope (the brass swell). Shares Vesperia's filter +
// amp-envelope shape; the DSP lives in audio.js buildWendelhornVoice. ---------

const WENDELHORN_DEFAULTS = {
  // Ensemble. Detune = stack width; Ensemble = LFO depth; Speed = LFO rate (Hz);
  // Stereo = spread across the field; polyLFO = per-saw LFOs vs a shared pool.
  detune: 0.4,
  ensemble: 0.4,
  speed: 4.5,
  stereo: 0.3,
  polyLFO: true,

  // Filter (brass): the envelope opens the cutoff on attack then settles (blat).
  cutoff: 2200,
  reso: 2.0,
  filterEnv: 1.5,
  keyTrack: 0.4,

  // Amp envelope: fast-ish attack, high sustain (a held brass tone).
  attack: 0.02,
  decay: 0.3,
  sustain: 0.85,
  release: 0.12,
};

const WENDELHORN_PARAMS = [
  { key: 'detune', group: 'Ensemble', label: 'Detune', min: 0, max: 1, fmt: pct,
    title: 'Width of the detuned saw stack (Szabo-style irregular spacing; the side saws also swell in as you open it).' },
  { key: 'ensemble', group: 'Ensemble', label: 'Ensemble', min: 0, max: 1, fmt: pct,
    title: 'Depth of the slow per-saw pitch modulation — more on the outer saws, none on the center — for an ensemble shimmer.' },
  { key: 'speed', group: 'Ensemble', label: 'Speed', min: 0.1, max: 5, log: true, fmt: (v) => `${v.toFixed(2)} Hz`,
    title: 'Rate of the ensemble modulation. Each saw is jittered slightly so they drift independently.' },
  { key: 'stereo', group: 'Ensemble', label: 'Stereo', min: 0, max: 1, fmt: pct,
    title: 'Spreads the saws across the stereo field by detune (flat → left, sharp → right).' },
  { key: 'polyLFO', group: 'Ensemble', label: 'Per-saw LFO', bool: true, fmt: (v) => (v ? 'per-saw' : 'shared'),
    title: 'Per-saw LFOs (richer, more oscillators) vs a shared 3-LFO pool (lighter). Try both for sound / CPU.' },

  { key: 'cutoff', group: 'Filter', label: 'Cutoff', min: 120, max: 14000, log: true, fmt: hz,
    title: 'Lowpass cutoff (base, before key tracking).' },
  { key: 'reso', group: 'Filter', label: 'Resonance', min: 0.5, max: 18, fmt: (v) => `Q ${v.toFixed(1)}`,
    title: 'Filter resonance — the brass "blat" lives here.' },
  { key: 'filterEnv', group: 'Filter', label: 'Env Amount', min: 0, max: 4, fmt: (v) => `${v.toFixed(2)} oct`,
    title: 'How far the filter envelope opens the cutoff above base at the attack, then settles (the brass swell).' },
  { key: 'keyTrack', group: 'Filter', label: 'Key Track', min: 0, max: 1, fmt: pct,
    title: 'How much the cutoff follows pitch: 0 = fixed Hz, 1 = fully relative to each note.' },

  { key: 'attack', group: 'Amp Envelope', label: 'Attack', min: 0.001, max: 1.5, log: true, fmt: secs,
    title: 'Time from note-on to full level.' },
  { key: 'decay', group: 'Amp Envelope', label: 'Decay', min: 0.02, max: 5, log: true, fmt: secs,
    title: 'How quickly the level falls toward the sustain after the attack.' },
  { key: 'sustain', group: 'Amp Envelope', label: 'Sustain', min: 0, max: 1, fmt: pct,
    title: 'Level the note holds at while sounding.' },
  { key: 'release', group: 'Amp Envelope', label: 'Release', min: 0.01, max: 3, log: true, fmt: secs,
    title: 'Fade time once the note ends.' },
];

// --- The registry. Each entry: id, display label, a one-line description (shown
// in the pane), the parameter defaults, and the editor PARAMS metadata. -------
export const INSTRUMENTS = {
  vesperia: { id: 'vesperia', label: 'Vesperia', desc: 'additive · resonant lowpass', defaults: VESPERIA_DEFAULTS, params: VESPERIA_PARAMS },
  zindel: { id: 'zindel', label: 'Zindel', desc: 'drawbar additive organ', defaults: ZINDEL_DEFAULTS, params: ZINDEL_PARAMS },
  wendelhorn: { id: 'wendelhorn', label: 'Wendelhorn', desc: 'brass supersaw ensemble', defaults: WENDELHORN_DEFAULTS, params: WENDELHORN_PARAMS },
};

export const DEFAULT_KIND = 'vesperia';

// Look up a kind's registry entry (falling back to the default kind for an
// unknown/missing tag, so a forward-saved project never throws).
export function instrument(kind) { return INSTRUMENTS[kind] || INSTRUMENTS[DEFAULT_KIND]; }
export function instrumentKinds() { return Object.keys(INSTRUMENTS); }

// The editor metadata for a kind: order, grouping, ranges, scale, formatting.
export function paramsFor(kind) { return instrument(kind).params; }

// Back-compat: the bare Vesperia params, for callers not yet kind-aware.
export const PARAMS = VESPERIA_PARAMS;

// A fresh default patch for a kind — its defaults plus the `kind` tag that the
// engine and editor dispatch on.
export function defaultPatch(kind = DEFAULT_KIND) {
  const inst = instrument(kind);
  return { kind: inst.id, ...inst.defaults };
}

// A clean, in-range copy of a patch — used to snapshot one (Copy/Paste, the
// per-lane migration seed) without aliasing the source object.
export function clonePatch(p) { return normalizePatch(p); }

// Coerce a loaded/partial patch to a full, in-range one for its kind
// (forward/backward safe: unknown kind → default kind, unknown keys dropped,
// missing keys defaulted, values clamped).
export function normalizePatch(obj) {
  const kind = obj && obj.kind && INSTRUMENTS[obj.kind] ? obj.kind : DEFAULT_KIND;
  const p = defaultPatch(kind);
  if (obj && typeof obj === 'object') {
    for (const spec of instrument(kind).params) {
      const v = obj[spec.key];
      if (spec.bool) {
        if (typeof v === 'boolean') p[spec.key] = v;
      } else if (typeof v === 'number' && isFinite(v)) {
        p[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
      }
    }
  }
  return p;
}

// Slider feel: time/frequency knobs move multiplicatively (log), the rest
// linearly. pos is the normalized 0..1 slider position.
function lin(spec, pos) { return spec.min + pos * (spec.max - spec.min); }
function linInv(spec, v) { return (v - spec.min) / (spec.max - spec.min); }
function log(spec, pos) { return spec.min * Math.pow(spec.max / spec.min, pos); }
function logInv(spec, v) { return Math.log(v / spec.min) / Math.log(spec.max / spec.min); }

// value -> 0..1 slider position, and back, honoring the param's scale.
export function toPos(spec, v) { return spec.log ? logInv(spec, v) : linInv(spec, v); }
export function fromPos(spec, pos) { return spec.log ? log(spec, pos) : lin(spec, pos); }

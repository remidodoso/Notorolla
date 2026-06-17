// instrument.js — the Vesperia: the one synth voice's editable parameters.
//
// A "patch" is a plain settings struct the audio engine reads at note-on, so an
// edit is heard on the very next note with no node re-wiring. Today there is a
// single global patch (the Vesperia, the One True Instrument); the struct and
// the PARAMS metadata are shaped so a future registry of named instruments /
// instances / per-lane voices is a lookup, not a rewrite.
//
// The DEFAULTS are chosen to reproduce the synth's prior hard-coded sound: at
// the default patch the Vesperia is bit-for-bit (central register) what it was
// before the pane existed, and Factory Reset always returns here.

// Default cutoff = 4 × C4 (261.63 Hz). With Key Track at 1 this makes the
// per-note settle cutoff f0×4 — exactly the old hard-coded body cutoff.
const C4 = 261.6255653;

export const DEFAULT_PATCH = {
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

export function defaultPatch() {
  return { ...DEFAULT_PATCH };
}

// A clean, in-range copy of a patch — used to snapshot one (Copy/Paste, the
// per-lane migration seed) without aliasing the source object.
export function clonePatch(p) {
  return normalizePatch(p);
}

// Coerce a loaded/partial patch to a full, in-range one (forward/backward safe:
// unknown keys dropped, missing keys defaulted, values clamped).
export function normalizePatch(obj) {
  const p = defaultPatch();
  if (obj && typeof obj === 'object') {
    for (const spec of PARAMS) {
      const v = obj[spec.key];
      if (typeof v === 'number' && isFinite(v)) {
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

const secs = (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const pct = (v) => `${Math.round(v * 100)}%`;
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);

// Editor metadata: order, grouping, ranges, scale and value formatting. Adding
// a knob later is one entry here plus one field in DEFAULT_PATCH.
export const PARAMS = [
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

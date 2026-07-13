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
const q = (v) => `Q ${v.toFixed(1)}`;
const oct = (v) => `${v.toFixed(2)} oct`;
const cents = (v) => `${Math.round(v)} ¢`;
// Signed cents (the ± pitch-attack sliders): 0 reads as "off".
const scents = (v) => (Math.abs(v) < 0.5 ? 'off' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v))} ¢`);

// Compact, unit-less formatters for the skin's readout WINDOW (§13 law: readouts
// are fixed-width windows; the units + full name live in the rollover title). A
// param's `fmtc` feeds the window; its `fmt` feeds the tooltip. `fmtc` is
// optional — the pane falls back to `fmt` where a kind hasn't supplied one.
const pctC = (v) => String(Math.round(v * 100));
const secsC = (v) => (v < 1 ? String(Math.round(v * 1000)) : `${v.toFixed(2)}s`);
const hzC = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
const qC = (v) => v.toFixed(1);
const octC = (v) => v.toFixed(2);
const scentsC = (v) => { const c = Math.round(v); return Math.abs(c) < 0.5 ? '0' : `${c > 0 ? '+' : '−'}${Math.abs(c)}`; };

// Typed-entry parsers for the skin's dblclick-to-type readouts (§13 locked law).
// Each returns the param's native VALUE clamped to [lo,hi], or null on garbage
// (the readout then reverts). A spec's optional `parse` closes over its bounds;
// where a kind supplies none, the readout is simply not editable.
const numOf = (s) => { const v = parseFloat(String(s).replace(/[−–]/g, '-').replace(/[^\d.eE+-]/g, ' ')); return isFinite(v) ? v : null; };
const clampv = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pctParse = (lo, hi) => (s) => { const v = numOf(s); return v == null ? null : clampv(v / 100, lo, hi); };
// Seconds field reads a bare number as milliseconds; a trailing "s" (not "ms") as seconds.
const secsParse = (lo, hi) => (s) => { let v = numOf(s); if (v == null) return null; if (/\d\s*s\s*$/i.test(s) && !/ms\s*$/i.test(s)) v *= 1000; return clampv(v / 1000, lo, hi); };
const hzParse = (lo, hi) => (s) => { let v = numOf(s); if (v == null) return null; if (/k/i.test(s)) v *= 1000; return clampv(v, lo, hi); };
const plainParse = (lo, hi) => (s) => { const v = numOf(s); return v == null ? null : clampv(v, lo, hi); };
// Signed cents: "off"/"0" → 0, else a bare (signed) number of cents.
const scentsParse = (s) => { if (/^\s*(off|0)\s*$/i.test(s)) return 0; const v = numOf(s); return v == null ? null : clampv(v, -200, 200); };

// --- shared param-cluster builders (§13 "common clusters") --------------------
// A kind composes its editable params from these so a cluster present in many
// instruments (an amplitude ADSR, a resonant lowpass, …) is DEFINED ONCE and
// renders identically everywhere. Each returns fresh spec objects tagged with a
// `role` (the hued top group — see the pane's ROLE order) + a `sub` (subgroup
// label). Ranges/curves are the historical Vesperia values these were factored
// out of, so a kind that adopts a cluster keeps the exact prior feel. Widget
// policy: continuous params default to the vertical `slider`; a `bipolar` flag +
// a `detent` value mark a centred (or off-centre) neutral. Short `label` = the
// glyph under the slider; the full name lives in `title` (the rollover).

// Amplitude ADSR (role: Envelope · sub: Amplitude). Ranges are overridable per
// kind (a pad wants a longer attack/release than the reference voice) while the
// labels/curves/feel stay identical everywhere.
function ampEnvelopeParams({ attackMax = 1.5, decayMax = 5, releaseMax = 3 } = {}) {
  return [
    { key: 'attack', role: 'env', sub: 'Amplitude', label: 'A', min: 0.001, max: attackMax, log: true, fmt: secs, fmtc: secsC, parse: secsParse(0.001, attackMax),
      title: 'Attack — time from note-on to full level.' },
    { key: 'decay', role: 'env', sub: 'Amplitude', label: 'D', min: 0.02, max: decayMax, log: true, fmt: secs, fmtc: secsC, parse: secsParse(0.02, decayMax),
      title: 'Decay — how quickly the level falls toward the sustain after the attack. (At Sustain 0 this is the ring-down time.)' },
    { key: 'sustain', role: 'env', sub: 'Amplitude', label: 'S', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
      title: 'Sustain — level the note holds at while sounding. 0 = decay to silence (the struck-string behaviour).' },
    { key: 'release', role: 'env', sub: 'Amplitude', label: 'R', min: 0.01, max: releaseMax, log: true, fmt: secs, fmtc: secsC, parse: secsParse(0.01, releaseMax),
      title: 'Release — fade time once the note ends.' },
  ];
}

// Pitch attack (role: Oscillator · sub: Pitch) — the signed ±cents approach that
// settles onto pitch. Shared keys/labels across Wendelhorn + Padlington, so
// cross-kind Copy/Paste ferries the gesture (§13 shared clusters).
function pitchAtkParams() {
  return [
    { key: 'pitchAtk', role: 'osc', sub: 'Pitch', label: 'Atk', widget: 'bipolar', detent: 0, min: -200, max: 200, fmt: scents, fmtc: scentsC, parse: scentsParse,
      title: 'Pitch Atk — the note starts this many cents off pitch and settles. Positive = from above (brass / the vocal approach), negative = the scoop. 0 = off.' },
    { key: 'pitchAtkTime', role: 'osc', sub: 'Pitch', label: 'Time', min: 0.01, max: 1, log: true, fmt: secs, fmtc: secsC, parse: secsParse(0.01, 1),
      title: 'Pitch Time — how long the pitch attack takes to settle (exponential decay).' },
  ];
}

// Stereo width (role: Effects · sub: Stereo) — a single mono-safe spread slider.
// The storage `key` is overridable: the visual/metadata cluster is shared, but a
// kind keeps its existing DSP key (Padlington `width`, Wendelhorn `stereo`) so no
// voice code or saved patch has to change. (Unifying the key — for cross-kind
// Copy/Paste of the gesture — is a future §13 shared-labels item.)
function stereoParams({ key = 'width', title = 'Width — stereo spread; the voice’s two decorrelated read-heads pan apart. 0 = mono-centred (mono-safe).' } = {}) {
  return [
    { key, role: 'fx', sub: 'Stereo', label: 'Width', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1), title },
  ];
}

// Resonant lowpass with its own envelope + key tracking (role: Filter · sub: Lowpass).
function lowpassParams() {
  return [
    { key: 'cutoff', role: 'filter', sub: 'Lowpass', label: 'Cutoff', min: 120, max: 14000, log: true, fmt: hz, fmtc: hzC, parse: hzParse(120, 14000),
      title: 'Cutoff — lowpass cutoff (base, before key tracking).' },
    { key: 'reso', role: 'filter', sub: 'Lowpass', label: 'Reso', min: 0.5, max: 18, fmt: q, fmtc: qC, parse: plainParse(0.5, 18),
      title: 'Resonance — a peak at the cutoff. High values whistle/ring.' },
    { key: 'filterEnv', role: 'filter', sub: 'Lowpass', label: 'Env', min: 0, max: 4, fmt: oct, fmtc: octC, parse: plainParse(0, 4),
      title: 'Env Amount — how far the filter envelope opens the cutoff above its base at the attack, then settles.' },
    { key: 'keyTrack', role: 'filter', sub: 'Lowpass', label: 'KeyTrk', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
      title: 'Key Track — how much the cutoff follows pitch: 0 = fixed Hz, 1 = fully relative to each note.' },
  ];
}

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

// Timbre = a bipolar spectral tilt (0.5 = neutral). d = (v−0.5)·2 in −1…+1.
const timbreFmt = (v) => { const d = (v - 0.5) * 2; return Math.abs(d) < 0.01 ? 'neutral (default mix)' : `${d < 0 ? 'darker' : 'brighter'} ${Math.round(Math.abs(d) * 100)}%`; };
const timbreFmtC = (v) => { const d = (v - 0.5) * 2; return Math.abs(d) < 0.01 ? '0' : `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)}`; };
const timbreParse = (s) => { if (/neut/i.test(s)) return 0.5; const v = numOf(s); if (v == null) return null; let d = v / 100; if (/dark/i.test(s)) d = -Math.abs(d); if (/bright/i.test(s)) d = Math.abs(d); return clampv(0.5 + d / 2, 0, 1); };

// Vesperia is the reference voice — the plain three-cluster baseline: an
// Oscillator timbre (bipolar), a shared Lowpass, and a shared Amplitude ADSR,
// listed in the canonical role order (Osc → Filter → Env).
const VESPERIA_PARAMS = [
  { key: 'timbre', role: 'osc', sub: 'Timbre', label: 'Tilt', widget: 'bipolar', detent: 0.5, min: 0, max: 1, fmt: timbreFmt, fmtc: timbreFmtC, parse: timbreParse,
    title: 'Timbre — spectral tilt over the harmonics: left darkens (fewer upper partials), right brightens. Centre is the default mix.' },
  ...lowpassParams(),
  ...ampEnvelopeParams(),
];

// --- Zindel: a drawbar additive organ. Eight harmonic partials (drawbars 1–8),
// each a 2-op FM stack (a sine carrier with a sine modulator) whose brightness is
// the Modulation control, detuned off the integer harmonics by Spread. One ADSR
// is applied to every partial, but the higher partials run it faster
// (Acceleration) — a per-partial decay that darkens the tone over time in place
// of a filter. ---------------------------------------------------------------

const ZINDEL_DEFAULTS = {
  // Drawbar levels (harmonics 1–8). Default = Hammond-ish: a full fundamental
  // and octave with a touch of 3rd and 5th "color", the rest low. Quantised onto
  // the 0–8 registration grid (eighths) that the drawbar widget clicks to — the
  // prior near values (.55/.35/.15/.28/.08/.05/.1) rounded to their nearest tab.
  d1: 1.0, d2: 0.5, d3: 0.375, d4: 0.125, d5: 0.25, d6: 0.125, d7: 0, d8: 0.125,

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

// Drawbar registration (0–8): the stored level is 0..1, displayed/clicked as n/8.
const zdrawFmt = (v) => { const n = Math.round(v * 8); return `${n} — drawbar ${n}/8`; };
const zdrawFmtC = (v) => String(Math.round(v * 8));
const zdrawParse = (s) => { const v = numOf(s); return v == null ? null : clampv(Math.round(v), 0, 8) / 8; };
const zfmFmt = (v) => (v <= 0 ? 'sine (pure partials)' : `${Math.round(v * 100)}% FM`);
const zfmFmtC = (v) => (v <= 0 ? 'sine' : String(Math.round(v * 100)));
const zfmParse = (s) => { if (/sine/i.test(s)) return 0; const v = numOf(s); return v == null ? null : clampv(v / 100, 0, 1); };
const zspreadFmt = (v) => (Math.abs(v) < 0.005 ? 'harmonic' : `${v > 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}% spread`);
const zspreadFmtC = (v) => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}`);
const zspreadParse = (s) => { if (/harm/i.test(s)) return 0; const v = numOf(s); return v == null ? null : clampv(v / 100, -0.3, 0.6); };

// Eight drawbars (harmonics 1–8): the skin's drawbar tab, a 9-position (0–8)
// stepped fader. The label is the harmonic number (printed on the tab); the
// widget whitens the powers-of-two tabs (1/2/4/8).
const ZINDEL_DRAWBARS = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({
  key: `d${k}`, role: 'osc', sub: 'Drawbars', label: String(k), widget: 'drawbar', positions: 9, min: 0, max: 1,
  fmt: zdrawFmt, fmtc: zdrawFmtC, parse: zdrawParse,
  title: `Drawbar ${k} — level of harmonic ${k} (0–8 registration).`,
}));

// Zindel maps onto: Oscillator [Drawbars · Tone] · Motion (the green filter-role
// slot, its band relabelled — Acceleration is the filter substitute) · Envelope.
const ZINDEL_PARAMS = [
  ...ZINDEL_DRAWBARS,

  { key: 'modulation', role: 'osc', sub: 'Tone', label: 'Mod', min: 0, max: 1, fmt: zfmFmt, fmtc: zfmFmtC, parse: zfmParse,
    title: 'Modulation — FM brightness: each partial is a sine carrier with a 1:1 sine modulator. 0 = pure sine; up adds harmonic sidebands (richer/brassier).' },
  { key: 'spread', role: 'osc', sub: 'Tone', label: 'Sprd', widget: 'bipolar', detent: 0, min: -0.3, max: 0.6, fmt: zspreadFmt, fmtc: zspreadFmtC, parse: zspreadParse,
    title: 'Spread — stretches the spacing of the partials off the integer harmonics. 0 = pure harmonic; positive detunes them apart (bell/metallic).' },

  { key: 'acceleration', role: 'filter', band: 'Motion', sub: 'Acceleration', label: 'Accel', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Acceleration — how much faster the upper partials run the envelope; they decay first, darkening the tone over time (the filter substitute).' },

  ...ampEnvelopeParams(),
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

  // Pitch attack: the synth-brass "blip" — start this many cents sharp and
  // exp-decay to pitch over pitchAtkTime. 0 cents = off.
  pitchAtk: 25,
  pitchAtkTime: 0.08,
};

const rateHz = (v) => `${v.toFixed(2)} Hz`;
const rateHzC = (v) => v.toFixed(2);

// Wendelhorn is the first panel to use all five role hues: LFO [Ensemble] ·
// Oscillator [Saws · Pitch] · Filter [Lowpass] · Envelope · Effects [Stereo].
// Pitch/Lowpass/Amplitude/Stereo are the shared clusters (verbatim reuse).
const WENDELHORN_PARAMS = [
  { key: 'ensemble', role: 'lfo', sub: 'Ensemble', label: 'Depth', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Ensemble — depth of the slow per-saw pitch modulation (more on the outer saws, none on the centre): the ensemble shimmer.' },
  { key: 'speed', role: 'lfo', sub: 'Ensemble', label: 'Speed', min: 0.1, max: 5, log: true, fmt: rateHz, fmtc: rateHzC, parse: plainParse(0.1, 5),
    title: 'Speed — rate of the ensemble modulation. Each saw is jittered slightly so they drift independently.' },

  { key: 'detune', role: 'osc', sub: 'Saws', label: 'Detune', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Detune — width of the detuned saw stack (Szabo-style irregular spacing; the side saws swell in as it opens).' },

  ...pitchAtkParams(),
  ...lowpassParams(),
  ...ampEnvelopeParams(),
  ...stereoParams({ key: 'stereo', title: 'Stereo — a mono-safe M/S widen: pan spread by saw index + a centre scoop gated by side energy. 0 = mono.' }),
];

// --- Tervik: a lightweight 3-operator FM synth (cheap polyphony, FM complexity).
// Op 1 is always the final carrier and its ADSR is the reference/amp envelope; a
// small Algorithm routes Ops 2 & 3 as modulators (into another op's frequency) or
// as extra carriers. Each modulator's depth = index × its own frequency (constant
// brightness across pitch, like Zindel). Ops 2 & 3 can FOLLOW Op 1's envelope
// (then Level is just the "amount") instead of their own ADSR. Feedback morphs
// Ops 2 & 3 from sine toward a band-limited saw — a cheap stand-in for operator
// feedback. DSP in audio.js buildTervikVoice. -------------------------------

// Full names — the Algorithm control is the backlit-LCD picker (ui/fmalgo.js),
// which shows the operator graph + the name, so no short-label workaround. The id
// is what the DSP dispatches on (audio.js TERVIK_ALGOS).
const TERVIK_ALGO_OPTS = [
  { id: 'stack',    label: 'Stack' },
  { id: 'y',        label: 'Y' },
  { id: 'pair',     label: 'Pair' },
  { id: 'parallel', label: 'Parallel' },
];

// Operator frequency ratio = COARSE + FINE. Coarse snaps to exact values (so you
// can reliably land on integer/harmonic ratios — vital for FM); fine is a ±1.0
// nudge (0 = exactly the coarse value, off-0 = deliberate inharmonicity). The
// effective ratio is clamped in audio.js. Coarse covers the snap targets; fine
// reaches everything between them (1 + 0.5 = the 1.5 ratio, etc.).
export const TERVIK_RATIOS = [0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

// Default = a DX-style electric piano: Op 1 a 1:1 body, Op 2 a 1:1 carrier
// modulated by Op 3 at 14:1 with a fast-decaying index (the metallic "tine"
// attack that mellows into the body). Algorithm "pair" (Op3→Op2 · Op1).
const TERVIK_DEFAULTS = {
  algo: 'pair',
  feedback: 0,
  coarse1: 1,  fine1: 0,  level1: 0.5,  a1: 0.002, d1: 1.4,  s1: 0, r1: 0.18,
  coarse2: 1,  fine2: 0,  level2: 0.5,  a2: 0.002, d2: 1.4,  s2: 0, r2: 0.18,
  coarse3: 14, fine3: 0,  level3: 0.35, a3: 0.001, d3: 0.18, s3: 0, r3: 0.10,
};

const xratio = (v) => `${v.toFixed(2)}×`;
const xratioC = (v) => v.toFixed(2);
const xratioParse = (s) => { const v = numOf(s); return v == null ? null : nearestStep(TERVIK_RATIOS, clampv(v, TERVIK_RATIOS[0], TERVIK_RATIOS[TERVIK_RATIOS.length - 1])); };
// Fine shows 3 decimals (the PWM-beating range is |fine| ≈ 0.001–0.01, invisible
// at 2 dp); typed entry lands exact, bypassing the detent (the Tervik-Fine lesson).
const fineFmt = (v) => (Math.abs(v) < 0.0005 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`);
const fineFmtC = (v) => (Math.abs(v) < 0.0005 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(3).replace(/^0/, '')}`);

// The per-operator OSCILLATOR params (Coarse + Fine ratio, Level). Coarse is the
// stepped ratio slider (snaps to the exact TERVIK_RATIOS); Fine is bipolar.
function tervikOpParams(n) {
  const sub = `Op ${n}`;
  return [
    { key: `coarse${n}`, role: 'osc', sub, label: 'Coarse', steps: TERVIK_RATIOS, fmt: xratio, fmtc: xratioC, parse: xratioParse,
      title: `Op ${n} Coarse — frequency ratio, snaps to exact values (integers = harmonic, 0.25/0.5 = sub-octaves).` },
    { key: `fine${n}`, role: 'osc', sub, label: 'Fine', widget: 'bipolar', detent: 0, min: -1, max: 1, fmt: fineFmt, fmtc: fineFmtC, parse: plainParse(-1, 1),
      title: `Op ${n} Fine — ratio offset added to Coarse. 0 = exactly the coarse ratio; off-zero = inharmonic/bell. Type an exact value to reach the beating range.` },
    { key: `level${n}`, role: 'osc', sub, label: 'Level', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
      title: n === 1 ? 'Op 1 Level — output level of the carrier.' : `Op ${n} Level — as a carrier its volume, as a modulator its FM depth.` },
  ];
}

// The per-operator ENVELOPE params (A D S R), pulled into a separate Envelope
// section (the trad-synth EG reading). Env 2 & 3 carry a one-shot COPY button
// (`subButton`) that snapshots Env 1's settings — replacing the old live "Follow
// Op 1" mode (copy, not a mode). Op 1's ADSR is also the amp/reference envelope.
function tervikEnvParams(n) {
  const sub = `Env ${n}`;
  const first = {
    key: `a${n}`, role: 'env', sub, label: 'A', min: 0.001, max: 1.5, log: true, fmt: secs, fmtc: secsC, parse: secsParse(0.001, 1.5),
    title: `Env ${n} attack.`,
  };
  if (n !== 1) first.subButton = {
    label: `1 → ${n}`, from: ['a1', 'd1', 's1', 'r1'], to: [`a${n}`, `d${n}`, `s${n}`, `r${n}`],
    title: `Copy Env 1's settings into Env ${n} (replaces the old Follow Op 1 toggle).`,
  };
  return [
    first,
    { key: `d${n}`, role: 'env', sub, label: 'D', min: 0.005, max: 5, log: true, fmt: secs, fmtc: secsC, parse: secsParse(0.005, 5), title: `Env ${n} decay.` },
    { key: `s${n}`, role: 'env', sub, label: 'S', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1), title: `Env ${n} sustain.` },
    { key: `r${n}`, role: 'env', sub, label: 'R', min: 0.005, max: 3, log: true, fmt: secs, fmtc: secsC, parse: secsParse(0.005, 3), title: `Env ${n} release.` },
  ];
}

// Tervik has no LFO/Filter/Effects → the role-hue spectrum shows gaps (orange
// Oscillator + cyan Envelope only). Routing (Algorithm rotary + Feedback) leads
// the Oscillator group; the three operators follow; the envelopes are their own
// section.
const TERVIK_PARAMS = [
  { key: 'algo', role: 'osc', sub: 'Routing', label: 'Algo', sel: true, widget: 'algo', options: TERVIK_ALGO_OPTS,
    title: 'Algorithm — operator routing: how Ops 2 & 3 feed Op 1 (the carrier) or the output directly.' },
  { key: 'feedback', role: 'osc', sub: 'Routing', label: 'Shape', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Shape — the waveshape of Ops 2 & 3: morphs their oscillator from a pure sine toward a bright band-limited saw (adds upper harmonics — a brightness/grit control). Op 1 stays a pure sine.' },
  ...tervikOpParams(1),
  ...tervikOpParams(2),
  ...tervikOpParams(3),
  ...tervikEnvParams(1),
  ...tervikEnvParams(2),
  ...tervikEnvParams(3),
];

// --- Nayumi: a breathy formant "voice" (oohs/ahhs) by source–filter synthesis —
// a glottal-pulse carrier through a parallel bank of formant resonators, mixed
// with aspiration/air noise, then a lo-fi bit-crush. Aimed at the Fairlight
// ARR1 zone: a lush, synthetic, slightly grainy choir that can slide from a clear
// sung vowel toward a hollow "blown vessel". Male↔female is a single formant-scale
// (Size) knob, not a different carrier. ---------------------------------------

const NAYUMI_VOWEL_OPTS = [
  { id: 'ooh', label: 'ooh' },
  { id: 'oh', label: 'oh' },
  { id: 'ah', label: 'ah' },
  { id: 'eh', label: 'eh' },
  { id: 'ee', label: 'ee' },
];

const NAYUMI_DEFAULTS = {
  vowel: 'ah',      // formant preset
  size: 1.0,        // formant-frequency scale: <1 larger/darker (male), >1 smaller (female)
  formantQ: 9,      // vowel sharpness (bandpass Q)
  soprano: 0.6,     // how much the voice rounds toward a pure tone up high (per-vowel)
  breath: 0.3,      // aspiration + air noise mixed in
  bright: 0.55,     // lowpass on the glottal source (dark → bright)
  grit: 0.25,       // lo-fi bit-crush (the Fairlight graininess)
  vibRate: 5.5,     // Hz
  vibDepth: 18,     // cents
  // Amp envelope — a soft attack + high sustain for the choral swell.
  attack: 0.12,
  decay: 0.4,
  sustain: 0.85,
  release: 0.45,
};

const nsizeWord = (v) => (v < 0.97 ? 'larger' : v > 1.03 ? 'smaller' : 'neutral');
const nsizeFmt = (v) => `${nsizeWord(v)} — ${v.toFixed(2)}× tract`;
const nsizeFmtC = (v) => v.toFixed(2);
const vibRateFmt = (v) => `${v.toFixed(1)} Hz`;
const vibRateFmtC = (v) => v.toFixed(1);

// Nayumi maps onto: LFO [Vibrato] · Oscillator [Voice · Breath] · Filter
// [Formant] (the vowel formant bank IS the green filter; Vowel is a 5-way rotary,
// Size a bipolar with an OFF-CENTRE detent at neutral 1.0) · Envelope.
const NAYUMI_PARAMS = [
  { key: 'vibRate', role: 'lfo', sub: 'Vibrato', label: 'Rate', min: 3, max: 8, fmt: vibRateFmt, fmtc: vibRateFmtC, parse: plainParse(3, 8),
    title: 'Vibrato Rate — speed.' },
  { key: 'vibDepth', role: 'lfo', sub: 'Vibrato', label: 'Depth', min: 0, max: 60, fmt: cents, fmtc: (v) => String(Math.round(v)), parse: plainParse(0, 60),
    title: 'Vibrato Depth — in cents; a little keeps a held vowel alive.' },

  { key: 'bright', role: 'osc', sub: 'Voice', label: 'Bright', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Brightness — lowpass on the glottal source before the formants (dark → bright).' },
  { key: 'grit', role: 'osc', sub: 'Voice', label: 'Grit', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Grit — lo-fi bit-crush (the vintage Fairlight graininess); higher blurs the vowel toward a hollow, "blown" character.' },

  { key: 'breath', role: 'osc', sub: 'Breath', label: 'Breath', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Breath — airy noise mixed in (aspiration through the formants + air on top); up = whispery/blown, down = clear/sung.' },

  { key: 'vowel', role: 'filter', sub: 'Formant', label: 'Vowel', sel: true, options: NAYUMI_VOWEL_OPTS,
    title: 'Vowel — which vowel the formant bank shapes (ooh/oh/ah/eh/ee).' },
  { key: 'size', role: 'filter', sub: 'Formant', label: 'Size', widget: 'bipolar', detent: 1.0, min: 0.8, max: 1.3, fmt: nsizeFmt, fmtc: nsizeFmtC, parse: plainParse(0.8, 1.3),
    title: 'Size — vocal-tract scale: low = larger/darker (toward male), high = smaller/brighter (toward female/child); centre = neutral. The carrier is unchanged.' },
  { key: 'formantQ', role: 'filter', sub: 'Formant', label: 'Reso', min: 2, max: 24, fmt: q, fmtc: qC, parse: plainParse(2, 24),
    title: 'Resonance — vowel sharpness (bandpass Q). High = strongly vowel-like and hollow; low = smeared toward a plain tone.' },
  { key: 'soprano', role: 'filter', sub: 'Formant', label: 'Sopr', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Soprano — high-note rounding onto a pure, fluty tone (the formant tunes onto the fundamental, upper formants + breath fade); 0 = off.' },

  ...ampEnvelopeParams({ attackMax: 2 }),
];

// --- Boshwick: a multipurpose 808-style percussion synth (no samples). One
// monotimbral voice whose Type select picks the drum topology (kick/tom/snare =
// pitched body + pitch-env; hat/cymbal/cowbell = inharmonic square cluster; clap =
// burst-noise; rim/clave = short pitched click), over a shared knob set. All
// voices are one-shot decays EXCEPT Hat & Cymbal, which honour the note duration
// (short note chokes = closed, long = open). Everything is pitch-trackable. -----

const BOSHWICK_TYPE_OPTS = [
  { id: 'kick', label: 'Kick' },
  { id: 'tom', label: 'Tom' },
  { id: 'snare', label: 'Snare' },
  { id: 'hat', label: 'Hat' },
  { id: 'clap', label: 'Clap' },
  { id: 'cowbell', label: 'Cowbell' },
  { id: 'rim', label: 'Rimshot' },
  { id: 'clave', label: 'Clave' },
  { id: 'cymbal', label: 'Cymbal' },
];

const BOSHWICK_DEFAULTS = {
  type: 'kick',
  tune: 0.5,        // ±1.5 octaves around the type's nominal pitch (0.5 = nominal)
  pitchTrack: 1.0,  // 0 = fixed drum on every row, 1 = the note transposes it (rel. C4)
  decay: 0.5,       // 0..1, mapped to a per-type seconds range
  punch: 0.4,       // attack transient / click
  pitchEnv: 0.5,    // downward sweep depth (kick/tom); inert for noise/metallic
  tone: 0.5,        // brightness/colour (per-type meaning)
  snap: 0.5,        // noise↔body balance (snare); inert for pure types
};

// Tune is bipolar around the nominal pitch (detent 0.5), shown in semitones.
const boshTuneSt = (v) => Math.round((v - 0.5) * 36); // ±18 st = ±1.5 oct
const boshTuneFmt = (v) => { const st = boshTuneSt(v); return st === 0 ? 'nominal' : `${st > 0 ? '+' : '−'}${Math.abs(st)} st`; };
const boshTuneFmtC = (v) => { const st = boshTuneSt(v); return st === 0 ? '0' : `${st > 0 ? '+' : '−'}${Math.abs(st)}`; };
const boshTuneParse = (s) => { if (/nom/i.test(s)) return 0.5; const st = numOf(s); return st == null ? null : clampv(0.5 + clampv(st, -18, 18) / 36, 0, 1); };

// Boshwick maps onto: Oscillator [Voice (the 9-way Type rotary — past the radial-
// label range, so it shows a readout WINDOW — plus Tune/PitchTrack) · Pitch] ·
// Tone (the green filter-role slot, band relabelled; the tone-shaping "filter
// substitute") · Envelope. Type drives live per-type inert dimming: Pitch Env
// lights only for Kick/Tom, Snap only for Snare (the current inert proposal).
const BOSHWICK_PARAMS = [
  { key: 'type', role: 'osc', sub: 'Voice', label: 'Type', sel: true, options: BOSHWICK_TYPE_OPTS,
    title: 'Type — which drum this voice is. Hat & Cymbal honour note length (short = closed/choked, long = open); the rest are one-shot hits.' },
  { key: 'tune', role: 'osc', sub: 'Voice', label: 'Tune', widget: 'bipolar', detent: 0.5, min: 0, max: 1, fmt: boshTuneFmt, fmtc: boshTuneFmtC, parse: boshTuneParse,
    title: 'Tune — pitch offset around the drum’s nominal tuning (±1.5 octaves).' },
  { key: 'pitchTrack', role: 'osc', sub: 'Voice', label: 'PTrk', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Pitch Track — 0 = a fixed drum on every row; 1 = the note pitch transposes it (playable toms / melodic kick), relative to C4.' },

  { key: 'pitchEnv', role: 'osc', sub: 'Pitch', label: 'PEnv', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1), inert: (p) => p.type !== 'kick' && p.type !== 'tom',
    title: 'Pitch Env — downward pitch-sweep depth at the attack. Kick: tight thump → deep dubby drop; tom: milder. Inert for noise/metallic types.' },

  { key: 'tone', role: 'filter', band: 'Tone', sub: 'Colour', label: 'Tone', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Tone — Kick: body drive, pure sine sub (0) → growly saturated 808 (1). Others: brightness/colour (tom click, filter centre for hat/snare/clap/cowbell).' },
  { key: 'snap', role: 'filter', band: 'Tone', sub: 'Colour', label: 'Snap', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1), inert: (p) => p.type !== 'snare',
    title: 'Snap — noise↔body balance, the snare "snappy". Inert for pure types.' },

  { key: 'decay', role: 'env', sub: 'Amplitude', label: 'Decay', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Decay — length of the hit (mapped per type). For Hat/Cymbal this is the *open* length — a short note chokes it.' },
  { key: 'punch', role: 'env', sub: 'Amplitude', label: 'Punch', min: 0, max: 1, fmt: pct, fmtc: pctC, parse: pctParse(0, 1),
    title: 'Punch — attack transient. Kick: an oscillator "knock" spike + a strong beater click; others: click/snap emphasis.' },
];

// --- Padlington: a PadSynth pad (Paul Nasca's algorithm). A harmonic PROFILE
// (Source: saw / pulse / choir / tilt) is smeared into Gaussian bands in the
// frequency domain and IFFT'd into a long looping wavetable — each harmonic
// becomes a narrow noise band, which is the lush "infinite unison" pad sound.
// The bake is pure + seeded (audio/padsynth.js); the voice is just two
// decorrelated read-heads over the table into Vesperia's filter + ADSR — the
// cheapest voice in the roster. --------------------------------------------

const PADLINGTON_DEFAULTS = {
  // Source profile. Saw = the supersaw pad; Pulse = a square/pulse; Choir uses
  // vowel formants (Nayumi's tables); Tilt is a bare 1/k^e rolloff. Shape morphs
  // Saw→triangle / Pulse duty (Lo→Hi); Vowel/Size act only for Choir, Tilt only
  // for the Tilt source (inert otherwise, like Boshwick's per-type knobs).
  source: 'saw',
  shape: 0,
  vowel: 'ah',
  size: 1.0,
  tilt: 1.5,
  harmonics: 64,

  // The pad bake. Bandwidth = each harmonic's Gaussian smear in cents (the
  // lushness); BW Scale = how the smear grows up the series (1 = constant
  // cents); Stretch = partial k lands at f·k^(1+s) (0 = harmonic).
  bandwidth: 25,
  bwScale: 1.0,
  stretch: 0,

  // Pitch attack (shared keys/labels with Wendelhorn, so Copy/Paste ferries the
  // gesture cross-kind): start ± cents off pitch, exp-settle onto it. Positive =
  // approach from above (brass blip / the vocal ideal), negative = the scoop.
  pitchAtk: 0,
  pitchAtkTime: 0.08,

  // Two decorrelated read-heads pan apart by Width (0 = mono-centered).
  width: 0.7,

  // Filter (Vesperia's section) — mostly open by default; the pad's colour
  // comes from the bake, the filter is for shaping on top.
  cutoff: 7000,
  reso: 0.5,
  filterEnv: 0,
  keyTrack: 0.3,

  // Amp envelope — a slow swell + long tail, pad-shaped.
  attack: 0.4,
  decay: 1.0,
  sustain: 0.9,
  release: 1.2,
};

const PAD_SOURCE_OPTS = [
  { id: 'saw', label: 'Saw' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'choir', label: 'Choir' },
  { id: 'tilt', label: 'Tilt' },
];

// Shape: the Saw/Pulse waveshape morph. Lo (0) = sawtooth / square; Hi (1) =
// triangle / super-skinny pulse. Readout reads Lo…Hi with a percentage between.
const shapeFmt = (v) => (v <= 0.0005 ? 'Lo' : v >= 0.9995 ? 'Hi' : `${Math.round(v * 100)}%`);
const shapeParse = (s) => { if (/lo/i.test(s)) return 0; if (/hi/i.test(s)) return 1; const v = numOf(s); return v == null ? null : clampv(v / 100, 0, 1); };

// Stretch = a bipolar inharmonicity (0 = harmonic). Compact drops the leading 0.
const stretchFmt = (v) => (Math.abs(v) < 0.00005 ? 'harmonic' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`);
const stretchFmtC = (v) => (Math.abs(v) < 0.00005 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(3).replace(/^0/, '')}`);
const stretchParse = (s) => { if (/harmonic/i.test(s)) return 0; const v = numOf(s); return v == null ? null : clampv(v, -0.05, 0.05); };

// Padlington maps onto the canonical roles: Oscillator [Source | Pad | Pitch] ·
// Filter (shared Lowpass) · Envelope (shared Amplitude, pad-length) · Effects
// [Stereo]. Source/Vowel are rotary switches (enums); Stretch/Pitch Atk bipolar.
const PADLINGTON_PARAMS = [
  { key: 'source', role: 'osc', sub: 'Source', label: 'Source', sel: true, options: PAD_SOURCE_OPTS,
    title: 'Source — harmonic profile the pad is baked from: Saw (all harmonics, 1/k), Pulse (square → skinny pulse via Shape), Choir (vowel formants), Tilt (a bare 1/k^e rolloff).' },
  { key: 'vowel', role: 'osc', sub: 'Source', label: 'Vowel', sel: true, options: NAYUMI_VOWEL_OPTS, inert: (p) => p.source !== 'choir',
    title: 'Vowel — Choir source only: which vowel shapes the profile (ooh/oh/ah/eh/ee). Inert for other sources.' },
  { key: 'shape', role: 'osc', sub: 'Source', label: 'Shape', min: 0, max: 1, fmt: shapeFmt, fmtc: shapeFmt, parse: shapeParse, inert: (p) => p.source !== 'saw' && p.source !== 'pulse',
    title: 'Shape — Saw/Pulse only: morphs the waveshape from Lo to Hi. Saw: sawtooth → triangle. Pulse: square (50% duty) → super-skinny pulse. Inert for other sources.' },
  { key: 'size', role: 'osc', sub: 'Source', label: 'Size', min: 0.8, max: 1.3, fmt: (v) => `×${v.toFixed(2)}`, fmtc: (v) => v.toFixed(2), parse: plainParse(0.8, 1.3), inert: (p) => p.source !== 'choir',
    title: 'Size — Choir source only: vocal-tract size, scales every formant. Low = larger/darker, high = smaller/brighter.' },
  { key: 'tilt', role: 'osc', sub: 'Source', label: 'Tilt', min: 0.5, max: 3, fmt: (v) => `1/k^${v.toFixed(2)}`, fmtc: (v) => v.toFixed(2), parse: plainParse(0.5, 3), inert: (p) => p.source !== 'tilt',
    title: 'Tilt — Tilt source only: the spectral rolloff exponent. Low = bright (slow rolloff), high = dark, nearly a pure tone.' },
  { key: 'harmonics', role: 'osc', sub: 'Source', label: 'Harm', min: 8, max: 128, log: true, fmt: (v) => `${Math.round(v)} harmonics`, fmtc: (v) => String(Math.round(v)), parse: plainParse(8, 128),
    title: 'Harmonics — how many the bake includes (automatically band-limited at Nyquist).' },

  { key: 'bandwidth', role: 'osc', sub: 'Pad', label: 'BW', min: 1, max: 120, log: true, fmt: cents, fmtc: (v) => String(Math.max(1, Math.round(v))), parse: plainParse(1, 120),
    title: 'Bandwidth — each harmonic’s Gaussian smear in cents; THE lushness knob. Narrow = clear/static; wide = thick, chorused, shimmering.' },
  { key: 'bwScale', role: 'osc', sub: 'Pad', label: 'Scale', min: 0, max: 2, fmt: (v) => `k^${v.toFixed(2)}`, fmtc: (v) => v.toFixed(2), parse: plainParse(0, 2),
    title: 'BW Scale — how the smear grows up the series: 1 = constant cents (natural), toward 0 = upper harmonics stay clearer, toward 2 = they wash out.' },
  { key: 'stretch', role: 'osc', sub: 'Pad', label: 'Stretch', widget: 'bipolar', detent: 0, min: -0.05, max: 0.05, fmt: stretchFmt, fmtc: stretchFmtC, parse: stretchParse,
    title: 'Stretch — inharmonicity: partial k lands at f·k^(1+s). 0 = harmonic; positive stretches partials sharp (bell/gamelan), negative compresses them flat.' },

  ...pitchAtkParams(),
  ...lowpassParams(),
  ...ampEnvelopeParams({ attackMax: 3, releaseMax: 5 }),
  ...stereoParams(),
];

// --- The registry. Each entry: id, display label, a one-line description (shown
// in the pane), the parameter defaults, and the editor PARAMS metadata. -------
export const INSTRUMENTS = {
  vesperia: { id: 'vesperia', label: 'Vesperia', desc: 'additive · resonant lowpass', defaults: VESPERIA_DEFAULTS, params: VESPERIA_PARAMS },
  zindel: { id: 'zindel', label: 'Zindel', desc: 'drawbar additive organ', defaults: ZINDEL_DEFAULTS, params: ZINDEL_PARAMS },
  wendelhorn: { id: 'wendelhorn', label: 'Wendelhorn', desc: 'brass supersaw ensemble', defaults: WENDELHORN_DEFAULTS, params: WENDELHORN_PARAMS },
  tervik: { id: 'tervik', label: 'Tervik', desc: '3-op FM', defaults: TERVIK_DEFAULTS, params: TERVIK_PARAMS },
  nayumi: { id: 'nayumi', label: 'Nayumi', desc: 'breathy formant voice', defaults: NAYUMI_DEFAULTS, params: NAYUMI_PARAMS },
  boshwick: { id: 'boshwick', label: 'Boshwick', desc: '808 percussion', defaults: BOSHWICK_DEFAULTS, params: BOSHWICK_PARAMS },
  padlington: { id: 'padlington', label: 'Padlington', desc: 'PadSynth wavetable pad', defaults: PADLINGTON_DEFAULTS, params: PADLINGTON_PARAMS },
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

// The patch's effective amp release in seconds — the time-constant the voice's
// ring-out follows. Most kinds expose a top-level `release`; Tervik has no
// top-level release (its amp tail tracks Op 1's release, r1). Callers sizing a
// bounce tail need a finite value for every kind, so default missing/non-finite
// to 0 rather than let an `undefined` poison a Math.max.
export function patchRelease(patch) {
  if (!patch) return 0;
  const r = patch.kind === 'tervik' ? patch.r1 : patch.release;
  return typeof r === 'number' && isFinite(r) ? r : 0;
}

// Coerce a loaded/partial patch to a full, in-range one for its kind
// (forward/backward safe: unknown kind → default kind, unknown keys dropped,
// missing keys defaulted, values clamped).
export function normalizePatch(obj) {
  const kind = obj && obj.kind && INSTRUMENTS[obj.kind] ? obj.kind : DEFAULT_KIND;
  const p = defaultPatch(kind);
  if (obj && typeof obj === 'object') {
    if (kind === 'tervik') obj = migrateTervikFollow(migrateTervikRatios(obj)); // legacy ratioN → coarse/fine; follow mode → copied env
    if (kind === 'padlington') obj = migratePadPulse(obj); // legacy 'square' source → 'pulse' (shape 0 = 50% duty = the same spectrum)
    for (const spec of instrument(kind).params) {
      const v = obj[spec.key];
      if (spec.bool) {
        if (typeof v === 'boolean') p[spec.key] = v;
      } else if (spec.sel) {
        if (typeof v === 'string' && spec.options.some((o) => o.id === v)) p[spec.key] = v;
      } else if (spec.steps) {
        if (typeof v === 'number' && isFinite(v)) p[spec.key] = nearestStep(spec.steps, v);
      } else if (typeof v === 'number' && isFinite(v)) {
        p[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
      }
    }
  }
  return p;
}

// The exact step nearest `v` from a quantized list (e.g. Tervik's coarse ratios).
export function nearestStep(steps, v) {
  let best = steps[0], bd = Infinity;
  for (const s of steps) { const d = Math.abs(s - v); if (d < bd) { bd = d; best = s; } }
  return best;
}

// Migrate a pre-split Tervik patch: an old single `ratioN` becomes `coarseN`
// (nearest snap) + `fineN` (the remainder). Returns a shallow copy so the caller's
// object isn't mutated; a no-op once patches carry coarse/fine.
function migrateTervikRatios(obj) {
  let o = obj;
  for (const n of [1, 2, 3]) {
    if (o[`coarse${n}`] == null && typeof o[`ratio${n}`] === 'number' && isFinite(o[`ratio${n}`])) {
      if (o === obj) o = { ...obj };
      const c = nearestStep(TERVIK_RATIOS, o[`ratio${n}`]);
      o[`coarse${n}`] = c;
      o[`fine${n}`] = Math.min(1, Math.max(-1, o[`ratio${n}`] - c));
    }
  }
  return o;
}

// Migrate a pre-copy Tervik patch: the old live "Follow Op 1" mode is gone (Ops
// 2 & 3 now always use their own envelope). A patch that had follow2/follow3 on
// was sounding Op N with Op 1's ADSR — so copy Env 1 into Env N to preserve that
// exact sound, then let the follow key fall away (it's no longer in the params).
function migrateTervikFollow(obj) {
  let o = obj;
  for (const n of [2, 3]) {
    if (o[`follow${n}`]) {
      if (o === obj) o = { ...obj };
      for (const p of ['a', 'd', 's', 'r']) o[`${p}${n}`] = o[`${p}1`];
    }
  }
  return o;
}

// COMPAT (padlington): the old 'square' Source is now 'pulse' at Shape 0 — which
// bakes duty 0.5 = the same odd-only spectrum, bit-identical. Translate legacy
// saves on load so they don't fall through to the default (saw). Deletable once
// no square-era patches remain: pulse@0 already IS square, nothing else depends
// on this. Returns a shallow copy so the caller's object isn't mutated.
function migratePadPulse(obj) {
  return obj.source === 'square' ? { ...obj, source: 'pulse' } : obj;
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

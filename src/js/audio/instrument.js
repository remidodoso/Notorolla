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
const cents = (v) => `${Math.round(v)} ¢`;
// Signed cents (the ± pitch-attack sliders): 0 reads as "off".
const scents = (v) => (Math.abs(v) < 0.5 ? 'off' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v))} ¢`);

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

const WENDELHORN_PARAMS = [
  { key: 'detune', group: 'Ensemble', label: 'Detune', min: 0, max: 1, fmt: pct,
    title: 'Width of the detuned saw stack (Szabo-style irregular spacing; the side saws also swell in as you open it).' },
  { key: 'ensemble', group: 'Ensemble', label: 'Ensemble', min: 0, max: 1, fmt: pct,
    title: 'Depth of the slow per-saw pitch modulation — more on the outer saws, none on the center — for an ensemble shimmer.' },
  { key: 'speed', group: 'Ensemble', label: 'Speed', min: 0.1, max: 5, log: true, fmt: (v) => `${v.toFixed(2)} Hz`,
    title: 'Rate of the ensemble modulation. Each saw is jittered slightly so they drift independently.' },
  { key: 'stereo', group: 'Ensemble', label: 'Stereo', min: 0, max: 1, fmt: pct,
    title: 'Spreads the saws across the stereo field by detune (flat → left, sharp → right).' },

  { key: 'pitchAtk', group: 'Pitch', label: 'Pitch Atk', min: -200, max: 200, fmt: scents,
    title: 'Pitch attack: the note starts this many cents off pitch and settles. Positive = from above (the synth-brass blip / vocal approach), negative = from below (the scoop). 0 = off.' },
  { key: 'pitchAtkTime', group: 'Pitch', label: 'Pitch Time', min: 0.01, max: 1, log: true, fmt: secs,
    title: 'How long the pitch attack takes to settle (exponential decay).' },

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

// --- Tervik: a lightweight 3-operator FM synth (cheap polyphony, FM complexity).
// Op 1 is always the final carrier and its ADSR is the reference/amp envelope; a
// small Algorithm routes Ops 2 & 3 as modulators (into another op's frequency) or
// as extra carriers. Each modulator's depth = index × its own frequency (constant
// brightness across pitch, like Zindel). Ops 2 & 3 can FOLLOW Op 1's envelope
// (then Level is just the "amount") instead of their own ADSR. Feedback morphs
// Ops 2 & 3 from sine toward a band-limited saw — a cheap stand-in for operator
// feedback. DSP in audio.js buildTervikVoice. -------------------------------

const TERVIK_ALGO_OPTS = [
  { id: 'stack',    label: 'Stack  3→2→1' },
  { id: 'y',        label: 'Y  (2+3)→1' },
  { id: 'pair',     label: 'Pair  3→2 · 1' },
  { id: 'parallel', label: 'Parallel  1·2·3' },
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
  coarse1: 1,  fine1: 0,  level1: 0.5,                 a1: 0.002, d1: 1.4,  s1: 0, r1: 0.18,
  coarse2: 1,  fine2: 0,  level2: 0.5, follow2: false, a2: 0.002, d2: 1.4,  s2: 0, r2: 0.18,
  coarse3: 14, fine3: 0,  level3: 0.35, follow3: false, a3: 0.001, d3: 0.18, s3: 0, r3: 0.10,
};

const xratio = (v) => `${v.toFixed(2)}×`;
const fineFmt = (v) => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`);
const followFmt = (v) => (v ? 'follow Op 1' : 'own ADSR');

// The per-operator params (Coarse + Fine ratio, Level, [Follow Op 1], A D S R).
// Op 1 has no Follow toggle — it IS the reference envelope.
function tervikOpParams(n, group) {
  const P = [
    { key: `coarse${n}`, group, label: 'Coarse', steps: TERVIK_RATIOS, fmt: xratio,
      title: `Op ${n} frequency ratio (coarse). Snaps to exact values — integers = harmonic, 0.25/0.5 = sub-octaves.` },
    { key: `fine${n}`, group, label: 'Fine', knob: true, min: -1, max: 1, reset: 0, detents: [0], fmt: fineFmt,
      title: `Op ${n} fine ratio offset (added to Coarse). 0 = exactly the coarse ratio; off-zero = inharmonic/bell. Double-click to reset.` },
    { key: `level${n}`, group, label: 'Level', min: 0, max: 1, fmt: pct,
      title: n === 1 ? 'Output level of this carrier.' : 'Level — as a carrier its volume, as a modulator its FM depth (the "amount" when following Op 1).' },
  ];
  if (n !== 1) P.push({ key: `follow${n}`, group, label: 'Follow Op 1', bool: true, fmt: followFmt,
    title: 'On: shape this op with Op 1’s envelope (Level is the amount). Off: use this op’s own ADSR below.' });
  // Ops 2 & 3's own ADSR is inert (dimmed) while Follow Op 1 shapes them instead.
  const inert = n === 1 ? undefined : (p) => !!p[`follow${n}`];
  P.push(
    { key: `a${n}`, group, label: 'A', min: 0.001, max: 1.5, log: true, fmt: secs, inert, title: `Op ${n} attack.` },
    { key: `d${n}`, group, label: 'D', min: 0.005, max: 5, log: true, fmt: secs, inert, title: `Op ${n} decay.` },
    { key: `s${n}`, group, label: 'S', min: 0, max: 1, fmt: pct, inert, title: `Op ${n} sustain.` },
    { key: `r${n}`, group, label: 'R', min: 0.005, max: 3, log: true, fmt: secs, inert, title: `Op ${n} release.` },
  );
  return P;
}

const TERVIK_PARAMS = [
  { key: 'algo', group: 'FM', label: 'Algorithm', sel: true, options: TERVIK_ALGO_OPTS,
    title: 'Operator routing: how Ops 2 & 3 feed Op 1 (the carrier) or the output directly.' },
  { key: 'feedback', group: 'FM', label: 'Feedback', min: 0, max: 1, fmt: pct,
    title: 'Morphs Ops 2 & 3 from sine toward a bright saw — a cheap stand-in for operator feedback (grit/brightness). Op 1 stays a pure sine.' },
  ...tervikOpParams(1, 'Op 1'),
  ...tervikOpParams(2, 'Op 2'),
  ...tervikOpParams(3, 'Op 3'),
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

const NAYUMI_PARAMS = [
  { key: 'vowel', group: 'Formant', label: 'Vowel', sel: true, options: NAYUMI_VOWEL_OPTS,
    title: 'Which vowel the formant bank shapes (ooh/oh/ah/eh/ee).' },
  { key: 'size', group: 'Formant', label: 'Size', min: 0.8, max: 1.3,
    fmt: (v) => (v < 0.97 ? 'larger' : v > 1.03 ? 'smaller' : 'neutral'),
    title: 'Vocal-tract size — scales every formant. Low = larger/darker (toward male), high = smaller/brighter (toward female/child). The carrier is unchanged.' },
  { key: 'formantQ', group: 'Formant', label: 'Resonance', min: 2, max: 24, fmt: (v) => `Q ${v.toFixed(1)}`,
    title: 'How sharp/pronounced the vowel is. High = strongly vowel-like and hollow; low = smeared toward a plain tone.' },
  { key: 'soprano', group: 'Formant', label: 'Soprano', min: 0, max: 1, fmt: pct,
    title: 'Soprano rounding: as a note climbs toward a vowel’s first formant the timbre rounds off to a pure, fluty tone (the formant tunes onto the fundamental, upper formants and breath fade). Engages per vowel; 0 = off (no high-note change).' },
  { key: 'breath', group: 'Breath', label: 'Breath', min: 0, max: 1, fmt: pct,
    title: 'Airy noise mixed in (aspiration through the formants, plus air on top). Up = whispery/blown; down = clear/sung.' },
  { key: 'bright', group: 'Voice', label: 'Brightness', min: 0, max: 1, fmt: pct,
    title: 'Lowpass on the glottal source — darker to brighter tone before the formants.' },
  { key: 'grit', group: 'Voice', label: 'Grit', min: 0, max: 1, fmt: pct,
    title: 'Lo-fi bit-crush — the vintage Fairlight-sampler graininess. Higher blurs the vowel toward a hollow, "blown" character.' },
  { key: 'vibRate', group: 'Vibrato', label: 'Rate', min: 3, max: 8, fmt: hz,
    title: 'Vibrato speed.' },
  { key: 'vibDepth', group: 'Vibrato', label: 'Depth', min: 0, max: 60, fmt: cents,
    title: 'Vibrato depth in cents. A little keeps a held vowel alive.' },
  { key: 'attack', group: 'Amp Envelope', label: 'Attack', min: 0.001, max: 2, log: true, fmt: secs,
    title: 'Onset time — a soft attack gives the choral swell.' },
  { key: 'decay', group: 'Amp Envelope', label: 'Decay', min: 0.02, max: 5, log: true, fmt: secs,
    title: 'Fall toward the sustain level after the attack.' },
  { key: 'sustain', group: 'Amp Envelope', label: 'Sustain', min: 0, max: 1, fmt: pct,
    title: 'Level the note holds at while sounding.' },
  { key: 'release', group: 'Amp Envelope', label: 'Release', min: 0.01, max: 3, log: true, fmt: secs,
    title: 'Fade once the note ends.' },
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

const boshTuneFmt = (v) => { const st = Math.round((v - 0.5) * 2 * 18); return st === 0 ? 'nominal' : `${st > 0 ? '+' : '−'}${Math.abs(st)} st`; };

const BOSHWICK_PARAMS = [
  { key: 'type', group: 'Voice', label: 'Type', sel: true, options: BOSHWICK_TYPE_OPTS,
    title: 'Which drum this voice is. Hat & Cymbal honour note length (short = closed/choked, long = open); the rest are one-shot hits.' },
  { key: 'tune', group: 'Voice', label: 'Tune', min: 0, max: 1, fmt: boshTuneFmt,
    title: 'Pitch offset around the drum’s nominal tuning (±1.5 octaves).' },
  { key: 'pitchTrack', group: 'Voice', label: 'Pitch Track', min: 0, max: 1, fmt: pct,
    title: '0 = a fixed drum on every row; 1 = the note pitch transposes it (playable toms / melodic kick), relative to C4.' },
  { key: 'decay', group: 'Envelope', label: 'Decay', min: 0, max: 1, fmt: pct,
    title: 'Length of the hit (mapped per type). For Hat/Cymbal this is the *open* length — a short note chokes it.' },
  { key: 'punch', group: 'Envelope', label: 'Punch', min: 0, max: 1, fmt: pct,
    title: 'Attack transient. Kick: an oscillator "knock" spike + a strong beater click (none → prominent snap); others: click/snap emphasis.' },
  { key: 'pitchEnv', group: 'Pitch', label: 'Pitch Env', min: 0, max: 1, fmt: pct,
    title: 'Downward pitch-sweep depth at the attack. Kick: tight thump → deep dubby drop (~9×, up to 140 ms); tom: milder. Inert for noise/metallic types.' },
  { key: 'tone', group: 'Tone', label: 'Tone', min: 0, max: 1, fmt: pct,
    title: 'Kick: body drive — pure sine sub (0) to growly saturated 808 (1). Others: brightness/colour (tom click, filter centre for hat/snare/clap/cowbell).' },
  { key: 'snap', group: 'Tone', label: 'Snap', min: 0, max: 1, fmt: pct,
    title: 'Noise↔body balance — the snare "snappy". Inert for pure types.' },
];

// --- Padlington: a PadSynth pad (Paul Nasca's algorithm). A harmonic PROFILE
// (Source: saw / square / choir / tilt) is smeared into Gaussian bands in the
// frequency domain and IFFT'd into a long looping wavetable — each harmonic
// becomes a narrow noise band, which is the lush "infinite unison" pad sound.
// The bake is pure + seeded (audio/padsynth.js); the voice is just two
// decorrelated read-heads over the table into Vesperia's filter + ADSR — the
// cheapest voice in the roster. --------------------------------------------

const PADLINGTON_DEFAULTS = {
  // Source profile. Saw = the supersaw pad; Choir uses vowel formants (Nayumi's
  // tables); Tilt is a bare 1/k^e rolloff. Vowel/Size act only for Choir, Tilt
  // only for the Tilt source (inert otherwise, like Boshwick's per-type knobs).
  source: 'saw',
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
  { id: 'square', label: 'Square' },
  { id: 'choir', label: 'Choir' },
  { id: 'tilt', label: 'Tilt' },
];

const stretchFmt = (v) => (Math.abs(v) < 0.0005 ? 'harmonic' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`);

const PADLINGTON_PARAMS = [
  { key: 'source', group: 'Source', label: 'Source', sel: true, options: PAD_SOURCE_OPTS,
    title: 'Harmonic profile the pad is baked from: Saw (all harmonics, 1/k), Square (odd harmonics only), Choir (vowel formants), Tilt (a bare 1/k^e rolloff).' },
  { key: 'vowel', group: 'Source', label: 'Vowel', sel: true, options: NAYUMI_VOWEL_OPTS, inert: (p) => p.source !== 'choir',
    title: 'Choir source only: which vowel shapes the harmonic profile (ooh/oh/ah/eh/ee). Inert for other sources.' },
  { key: 'size', group: 'Source', label: 'Size', min: 0.8, max: 1.3, inert: (p) => p.source !== 'choir',
    fmt: (v) => (v < 0.97 ? 'larger' : v > 1.03 ? 'smaller' : 'neutral'),
    title: 'Choir source only: vocal-tract size — scales every formant. Low = larger/darker, high = smaller/brighter.' },
  { key: 'tilt', group: 'Source', label: 'Tilt', min: 0.5, max: 3, fmt: (v) => `1/k^${v.toFixed(2)}`, inert: (p) => p.source !== 'tilt',
    title: 'Tilt source only: the spectral rolloff exponent. Low = bright (slow rolloff), high = dark, nearly a pure tone.' },
  { key: 'harmonics', group: 'Source', label: 'Harmonics', min: 8, max: 128, log: true, fmt: (v) => `${Math.round(v)}`,
    title: 'How many harmonics the bake includes (automatically band-limited at Nyquist).' },

  { key: 'bandwidth', group: 'Pad', label: 'Bandwidth', min: 1, max: 120, log: true, fmt: cents,
    title: 'Width of each harmonic’s Gaussian smear, in cents — THE lushness knob. Narrow = clear and static; wide = thick, chorused, shimmering.' },
  { key: 'bwScale', group: 'Pad', label: 'BW Scale', min: 0, max: 2, fmt: (v) => `k^${v.toFixed(2)}`,
    title: 'How the smear grows up the harmonic series: 1 = constant in cents (natural), toward 0 = upper harmonics stay clearer, toward 2 = upper harmonics wash out.' },
  { key: 'stretch', group: 'Pad', label: 'Stretch', knob: true, min: -0.05, max: 0.05, reset: 0, detents: [0], fmt: stretchFmt,
    title: 'Inharmonicity: partial k lands at f·k^(1+s). 0 = exactly harmonic; positive stretches the partials sharp (bell/gamelan), negative compresses them flat. Double-click to reset.' },

  { key: 'pitchAtk', group: 'Pitch', label: 'Pitch Atk', min: -200, max: 200, fmt: scents,
    title: 'Pitch attack: the note starts this many cents off pitch and settles. Positive = from above (brass / the vocal approach), negative = from below (the scoop). 0 = off.' },
  { key: 'pitchAtkTime', group: 'Pitch', label: 'Pitch Time', min: 0.01, max: 1, log: true, fmt: secs,
    title: 'How long the pitch attack takes to settle (exponential decay) — pairs nicely with a slow pad attack.' },

  { key: 'width', group: 'Stereo', label: 'Width', min: 0, max: 1, fmt: pct,
    title: 'Stereo spread — the voice’s two decorrelated read-heads pan apart. 0 = mono-centered (mono-safe).' },

  { key: 'cutoff', group: 'Filter', label: 'Cutoff', min: 120, max: 14000, log: true, fmt: hz,
    title: 'Lowpass cutoff (base, before key tracking).' },
  { key: 'reso', group: 'Filter', label: 'Resonance', min: 0.5, max: 18, fmt: (v) => `Q ${v.toFixed(1)}`,
    title: 'Filter resonance — a peak at the cutoff. High values whistle/ring.' },
  { key: 'filterEnv', group: 'Filter', label: 'Env Amount', min: 0, max: 4, fmt: (v) => `${v.toFixed(2)} oct`,
    title: 'How far the filter envelope opens the cutoff above its base at the attack, then settles.' },
  { key: 'keyTrack', group: 'Filter', label: 'Key Track', min: 0, max: 1, fmt: pct,
    title: 'How much the cutoff follows pitch: 0 = fixed Hz, 1 = fully relative to each note.' },

  { key: 'attack', group: 'Amp Envelope', label: 'Attack', min: 0.001, max: 3, log: true, fmt: secs,
    title: 'Time from note-on to full level — a slow attack gives the pad swell.' },
  { key: 'decay', group: 'Amp Envelope', label: 'Decay', min: 0.02, max: 5, log: true, fmt: secs,
    title: 'How quickly the level falls toward the sustain after the attack.' },
  { key: 'sustain', group: 'Amp Envelope', label: 'Sustain', min: 0, max: 1, fmt: pct,
    title: 'Level the note holds at while sounding.' },
  { key: 'release', group: 'Amp Envelope', label: 'Release', min: 0.01, max: 5, log: true, fmt: secs,
    title: 'Fade time once the note ends — a long release lets pads overlap.' },
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
    if (kind === 'tervik') obj = migrateTervikRatios(obj); // legacy single ratioN → coarseN + fineN
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

// Slider feel: time/frequency knobs move multiplicatively (log), the rest
// linearly. pos is the normalized 0..1 slider position.
function lin(spec, pos) { return spec.min + pos * (spec.max - spec.min); }
function linInv(spec, v) { return (v - spec.min) / (spec.max - spec.min); }
function log(spec, pos) { return spec.min * Math.pow(spec.max / spec.min, pos); }
function logInv(spec, v) { return Math.log(v / spec.min) / Math.log(spec.max / spec.min); }

// value -> 0..1 slider position, and back, honoring the param's scale.
export function toPos(spec, v) { return spec.log ? logInv(spec, v) : linInv(spec, v); }
export function fromPos(spec, pos) { return spec.log ? log(spec, pos) : lin(spec, pos); }

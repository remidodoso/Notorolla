// padsynth.js — the Padlington bake: PadSynth wavetable synthesis (Paul Nasca,
// ZynAddSubFX). A harmonic amplitude PROFILE is smeared into Gaussian bands in
// the frequency domain (each harmonic becomes a narrow noise band — the
// "supersaw with infinite unison" lushness), every bin gets a seeded random
// phase, and one IFFT produces a long, seamlessly-looping wavetable. The voice
// (audio.js buildPadlingtonVoice) plays the table as a looped buffer.
//
// Pure data-in/data-out — no Web Audio, no DOM — so the whole bake is
// headless-testable (notch/padsynth.mjs), same posture as patches.js. The bake
// is SEEDED (from the param key), so the same patch bakes a bit-identical table
// in the live context and every OfflineAudioContext: exports match live.

const TWO_PI = Math.PI * 2;

// Table length in samples (~2.7 s at 48 kHz). The IFFT is a one-time cost at
// patch/octave bake time (tens of ms), not a play-time cost.
export const PAD_TABLE_SIZE = 1 << 17;

// Every baked table is RMS-normalized to this level, so Source / Harmonics /
// Bandwidth edits change COLOR, not loudness (see the "timbre knob that changes
// summed energy is a loudness control in disguise" gotcha). The playback level
// lives in one place: PAD_NORM at the voice (audio.js).
export const PAD_TABLE_RMS = 0.25;

// --- Profile generators -------------------------------------------------------
// A profile is the harmonic amplitude list A1..An the pad is baked from — the
// "source" the user picks. All pure functions of the patch (+ the bake's base
// frequency, because the choir's formants live at fixed Hz).

// Vowel formant centres (F1/F2/F3, Hz) + relative band gains — duplicated from
// audio.js's NAYUMI_VOWELS/NAYUMI_FORMANT_GAINS (this module can't import
// audio.js: audio.js imports us). Keep the two tables in sync.
export const PAD_VOWELS = {
  ooh: [350, 600, 2400],
  oh:  [430, 820, 2600],
  ah:  [800, 1150, 2900],
  eh:  [500, 1800, 2550],
  ee:  [300, 2300, 3010],
};
const PAD_FORMANT_GAINS = [1.0, 0.6, 0.4];
const PAD_FORMANT_Q = 9;        // matches Nayumi's default vowel sharpness
const PAD_GLOTTAL_TILT = 1.1;   // 1/k^tilt vocal-source rolloff (Nayumi's)

// Magnitude of a bandpass resonator (centre fc, quality q) at frequency f —
// unity at the centre, skirts falling by Q. The analytic stand-in for running
// the source through Nayumi's formant bank.
function formantMag(f, fc, q) {
  const x = f / fc - fc / f;
  return 1 / Math.sqrt(1 + q * q * x * x);
}

// The harmonic amplitude profile for a patch: A1..An by source kind.
export function padProfile(p, baseFreq) {
  const n = Math.max(1, Math.round(p.harmonics));
  const a = new Float32Array(n);
  const F = PAD_VOWELS[p.vowel] || PAD_VOWELS.ah;
  for (let k = 1; k <= n; k++) {
    let v;
    switch (p.source) {
      case 'square':  // odd harmonics only, 1/k
        v = k % 2 ? 1 / k : 0;
        break;
      case 'tilt':    // a bare 1/k^e rolloff — the "abstract" profile
        v = 1 / Math.pow(k, p.tilt);
        break;
      case 'choir': { // glottal rolloff × the 3-formant bank at k·baseFreq
        let fm = 0;
        for (let i = 0; i < 3; i++) fm += PAD_FORMANT_GAINS[i] * formantMag(baseFreq * k, F[i] * p.size, PAD_FORMANT_Q);
        v = fm / Math.pow(k, PAD_GLOTTAL_TILT);
        break;
      }
      default:        // saw: all harmonics, 1/k
        v = 1 / k;
    }
    a[k - 1] = v;
  }
  return a;
}

// --- The spectrum + bake ------------------------------------------------------

// Where partial k lands: f0 · k^(1+stretch). Stretch 0 = exactly harmonic;
// positive stretches the upper partials sharp (bell/gamelan), negative
// compresses them flat. This is the tuning⇄timbre (Sethares) hook.
export function padPartialFreq(k, f0, stretch) {
  return f0 * Math.pow(k, 1 + stretch);
}

// Accumulate the (real, non-negative) magnitude spectrum: each harmonic's
// amplitude smeared into a Gaussian band around its partial frequency.
//   band width (Hz) = (2^(bandwidth¢/1200) − 1) · baseFreq · k^bwScale
// (Nasca's form: at bwScale 1 the width is a constant number of CENTS up the
// series). Each band is scaled by 1/√σ so a harmonic carries the same ENERGY
// at any bandwidth — otherwise the Bandwidth knob would retilt the spectrum.
export function padSpectrumMags(profile, p, baseFreq, sampleRate, tableSize) {
  const half = tableSize / 2;
  const mags = new Float64Array(half);
  const binHz = sampleRate / tableSize;
  const bwFrac = Math.pow(2, p.bandwidth / 1200) - 1;
  for (let k = 1; k <= profile.length; k++) {
    const A = profile[k - 1];
    if (A <= 0) continue;
    const fk = padPartialFreq(k, baseFreq, p.stretch);
    if (fk >= sampleRate / 2) break; // band-limit (fk grows with k)
    const bwHz = Math.max(bwFrac * baseFreq * Math.pow(k, p.bwScale), binHz); // floor: ≥ one bin
    const sigma = bwHz / 2.355;      // full-width-half-max → Gaussian σ
    const scale = A / Math.sqrt(sigma);
    const lo = Math.max(1, Math.floor((fk - 4 * bwHz) / binHz));
    const hi = Math.min(half - 1, Math.ceil((fk + 4 * bwHz) / binHz));
    for (let i = lo; i <= hi; i++) {
      const d = i * binHz - fk;
      mags[i] += scale * Math.exp(-(d * d) / (2 * sigma * sigma));
    }
  }
  return mags;
}

// The cache/seed key for a bake: exactly the params the table depends on —
// envelope/filter/width edits must NOT re-bake (or reseed) the table.
export function padTableKey(p, baseFreq, sampleRate, tableSize = PAD_TABLE_SIZE) {
  const f = (x, d) => Number(x).toFixed(d);
  const src = p.source || 'saw';
  const sub = src === 'choir' ? `${p.vowel}:${f(p.size, 3)}` : src === 'tilt' ? f(p.tilt, 3) : '';
  return `${src}|${sub}|h${Math.round(p.harmonics)}|bw${f(p.bandwidth, 2)}|bs${f(p.bwScale, 3)}|st${f(p.stretch, 4)}|f${f(baseFreq, 3)}|r${sampleRate}|n${tableSize}`;
}

// Bake one wavetable: profile → Gaussian magnitude spectrum → seeded random
// phase per bin → Hermitian-symmetric complex spectrum → one inverse FFT →
// RMS-normalized Float32Array. Deterministic: seed = hash(padTableKey).
export function bakePadTable(p, baseFreq, sampleRate, tableSize = PAD_TABLE_SIZE) {
  const profile = padProfile(p, baseFreq);
  const mags = padSpectrumMags(profile, p, baseFreq, sampleRate, tableSize);
  const rnd = mulberry32(strSeed(padTableKey(p, baseFreq, sampleRate, tableSize)));
  const re = new Float64Array(tableSize);
  const im = new Float64Array(tableSize);
  const half = tableSize / 2;
  for (let i = 1; i < half; i++) {
    const m = mags[i];
    if (m === 0) continue;
    const ph = rnd() * TWO_PI;
    re[i] = m * Math.cos(ph);
    im[i] = m * Math.sin(ph);
    re[tableSize - i] = re[i];   // Hermitian symmetry → the IFFT output is real
    im[tableSize - i] = -im[i];
  }
  fft(re, im, true); // inverse, unscaled — the RMS normalization absorbs 1/N
  let sum = 0;
  for (let i = 0; i < tableSize; i++) sum += re[i] * re[i];
  const rms = Math.sqrt(sum / tableSize);
  const g = rms > 0 ? PAD_TABLE_RMS / rms : 0;
  const out = new Float32Array(tableSize);
  for (let i = 0; i < tableSize; i++) out[i] = re[i] * g;
  return out;
}

// The bake base for a note: the nearest octave-of-C (C1..C8), so the playback
// rate f0/base stays within ~[0.71, 1.41] — negligible resampling artifacts and
// (for the choir) formants anchored to within half an octave. Tables are baked
// lazily per (patch, base) and cached on the context (audio.js).
const PAD_C4 = 261.6255653;
export function padBaseFreq(f0) {
  const oct = Math.round(Math.log2(f0 / PAD_C4));
  return PAD_C4 * Math.pow(2, Math.min(4, Math.max(-3, oct)));
}

// --- Primitives ---------------------------------------------------------------

// In-place iterative radix-2 complex FFT (length must be a power of two).
// inverse=true runs the inverse transform WITHOUT the 1/N scale (callers that
// need it scale themselves; the bake normalizes by RMS anyway).
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { // bit-reversal permutation
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 1 : -1) * TWO_PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1, curI = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * curR - im[b] * curI;
        const ti = re[b] * curI + im[b] * curR;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nR;
      }
    }
  }
}

// Deterministic PRNG — a local copy of audio.js's mulberry32 (file-private
// there, and this module must stay import-free).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// djb2 string hash → uint32, for deriving the bake seed from the param key.
function strSeed(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

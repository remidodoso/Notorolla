// mods.js — per-lane playback modulators: config model, waveform evaluation,
// patch application, and the modal editor UI (no audio nodes).
//
// A modulator is a pure function of time that nudges ONE instrument parameter at
// each note-on (note-time sampling — no persistent nodes, works for every
// numeric param of every kind, and the offline WAV/stem exports evaluate the
// same functions so bounces match playback). Non-destructive: the patch is never
// written; offsets are applied to a copy at voice-build (the transforms doctrine).
//
// Time anchoring (the `loop` flag — set GLOBALLY for now by the tile player's
// "Loop Mod" toggle, which overrides every mod's flag; the per-mod field stays
// in the model for a possible per-mod return):
//   loop OFF ("elapsed") — t = seconds since the session's FIRST Play press
//                          (looped passes keep evolving).
//   loop ON  ("ruler")   — t = the note's position on the ruler (beat 0 = t 0,
//                          wherever playback started; loop passes are identical).
// Offsets are computed in SLIDER-POSITION space (toPos/fromPos), so a ±25%
// amount is perceptually even on log params, and both mods on the same target
// add in position space before one clamp.
//
// Storage: lane.modsByKind = { kind: [mod, mod] } — each instrument kind keeps
// its own pair, so switching instruments and back restores the setup untouched.

import { paramsFor, toPos, fromPos } from './instrument.js';

export const MOD_SLOTS = 2;

export const MOD_SHAPES = [
  { id: 'sin', label: 'Sine' },
  { id: 'tri', label: 'Triangle' },
  { id: 'rampup', label: 'Ramp ↑' },
  { id: 'rampdown', label: 'Ramp ↓' },
  { id: 'walk', label: 'Walk' },
];

export const MOD_RATE_MIN = 0.01; // Hz
export const MOD_RATE_MAX = 1;

export const DEFAULT_MOD = { on: false, shape: 'sin', target: '', amount: 0.25, rate: 0.1, phase: 0, loop: false };

export function defaultMod() { return { ...DEFAULT_MOD }; }

// Coerce one loaded/partial mod config to a full, in-range one.
export function normalizeMod(obj) {
  const m = defaultMod();
  if (obj && typeof obj === 'object') {
    m.on = !!obj.on;
    if (MOD_SHAPES.some((s) => s.id === obj.shape)) m.shape = obj.shape;
    if (typeof obj.target === 'string') m.target = obj.target;
    if (typeof obj.amount === 'number' && isFinite(obj.amount)) m.amount = Math.min(1, Math.max(0, obj.amount));
    if (typeof obj.rate === 'number' && isFinite(obj.rate)) m.rate = Math.min(MOD_RATE_MAX, Math.max(MOD_RATE_MIN, obj.rate));
    if (typeof obj.phase === 'number' && isFinite(obj.phase)) m.phase = Math.min(360, Math.max(0, obj.phase));
    m.loop = !!obj.loop;
  }
  return m;
}

// Coerce a loaded per-kind map: each entry becomes exactly MOD_SLOTS mods.
// Unknown kinds are kept (forward-safe: a project from a newer app version).
export function normalizeModsByKind(obj) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const [kind, arr] of Object.entries(obj)) {
      if (!Array.isArray(arr)) continue;
      out[kind] = Array.from({ length: MOD_SLOTS }, (_, i) => normalizeMod(arr[i]));
    }
  }
  return out;
}

// The params of `kind` a modulator may target: numeric sliders/knobs only —
// bool/select/stepped are excluded (cycling vowels/algorithms isn't musical).
export function modTargetsFor(kind) {
  return paramsFor(kind).filter((s) => !s.bool && !s.sel && !s.steps);
}

// --- waveform evaluation ------------------------------------------------

const frac = (x) => x - Math.floor(x);

// Deterministic integer hash → [-1, 1] (the walk's control points).
function hash(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

// One modulator's value in [-1, 1] at time t (seconds). All shapes start at the
// center-crossing, rising, at phase 0. The walk is interpolated value-noise:
// bounded by construction, centered, and O(1) — the "tempered random walk"
// (seed decorrelates the two slots / different lanes).
export function modWave(shape, t, rate, phaseDeg, seed = 0) {
  const x = t * rate + (phaseDeg || 0) / 360;
  switch (shape) {
    case 'tri': return 1 - 4 * Math.abs(frac(x + 0.25) - 0.5);
    case 'rampup': return 2 * frac(x + 0.5) - 1;
    case 'rampdown': return 1 - 2 * frac(x + 0.5);
    case 'walk': {
      const i = Math.floor(x);
      const f = frac(x);
      const s = f * f * (3 - 2 * f); // smoothstep between hash points
      const a = hash(i * 2 + seed * 40503);
      const b = hash((i + 1) * 2 + seed * 40503);
      return a + (b - a) * s;
    }
    default: return Math.sin(2 * Math.PI * x); // sin
  }
}

// Apply a lane's mods to a patch at note time → a NEW patch (base untouched).
// elSec/ruSec = the two time anchors (each mod picks by its `loop` flag);
// seed = the lane id (decorrelates walks across lanes; slot index added here).
// Offsets from both mods accumulate in position space per target, then clamp once.
export function applyMods(patch, mods, elSec, ruSec, seed = 0) {
  if (!mods || !mods.length) return patch;
  const specs = paramsFor(patch.kind);
  const offsets = new Map(); // param key -> summed position offset
  mods.forEach((m, slot) => {
    if (!m || !m.on || !m.target || m.amount <= 0) return;
    const spec = specs.find((s) => s.key === m.target);
    if (!spec || spec.bool || spec.sel || spec.steps) return; // invalid/non-numeric for this kind
    const t = Math.max(0, m.loop ? ruSec : elSec);
    const w = modWave(m.shape, t, m.rate, m.phase, seed * 7 + slot + 1);
    offsets.set(m.target, (offsets.get(m.target) || 0) + m.amount * w);
  });
  if (!offsets.size) return patch;
  const out = { ...patch };
  for (const [key, off] of offsets) {
    const spec = specs.find((s) => s.key === key);
    const pos = Math.min(1, Math.max(0, toPos(spec, out[key]) + off));
    out[key] = fromPos(spec, pos);
  }
  return out;
}

// True when any enabled slot targets a param that exists on `kind` (lights the
// lane's M chiclet and gates the engine's per-note work).
export function modsActive(modsByKind, kind) {
  const arr = modsByKind && modsByKind[kind];
  if (!arr) return false;
  const targets = modTargetsFor(kind);
  return arr.some((m) => m && m.on && targets.some((s) => s.key === m.target));
}

// --- the modal editor ------------------------------------------------------

const rateFmt = (v) => (v < 0.1 ? `${v.toFixed(3)} Hz` : `${v.toFixed(2)} Hz`);
const RATE_LOG_MIN = Math.log(MOD_RATE_MIN);
const RATE_LOG_MAX = Math.log(MOD_RATE_MAX);

// Build the modulators editor body (DOM) for the modal. `mods` = the lane's
// current-kind pair (mutated in place); `targets` = modTargetsFor(kind).
// Calls cb.onChange() after any edit (host persists + relights the chiclet —
// no audio to rewire, mods are evaluated at note time).
export function buildModEditor(mods, targets, cb) {
  const root = document.createElement('div');
  root.className = 'delay-editor mod-editor';

  mods.forEach((m, slot) => {
    const head = document.createElement('div');
    head.className = 'mod-head';

    const en = document.createElement('input');
    en.type = 'checkbox'; en.checked = m.on; en.className = 'delay-check';
    en.title = 'Enable this modulator';
    en.addEventListener('change', () => { m.on = en.checked; cb.onChange(); });

    const title = document.createElement('span');
    title.className = 'mod-title';
    title.textContent = `Mod ${slot + 1}`;

    head.append(en, title);
    root.append(head);

    // Shape + target selects.
    const selRow = row('Shape');
    const shapeSel = mkSelect(MOD_SHAPES.map((s) => ({ value: s.id, label: s.label })), m.shape);
    shapeSel.addEventListener('change', () => { m.shape = shapeSel.value; cb.onChange(); });
    const targetSel = mkSelect(
      [{ value: '', label: '— parameter —' }, ...targets.map((s) => ({ value: s.key, label: s.group ? `${s.group} · ${s.label}` : s.label }))],
      m.target,
    );
    targetSel.title = 'Which parameter this modulator moves';
    targetSel.addEventListener('change', () => { m.target = targetSel.value; cb.onChange(); });
    selRow.append(shapeSel, targetSel);
    root.append(selRow);

    // Amount / Rate / Phase sliders.
    root.append(slider('Amount', 0, 1, 0.01, m.amount, (v) => `${Math.round(v * 100)}%`, (v) => { m.amount = v; },
      'Peak deviation, as a fraction of the parameter’s slider range (clamped at the ends)'));
    // Rate is a log slider: the range input runs 0..1 and maps exponentially.
    root.append(slider('Rate', 0, 1, 0.005, (Math.log(m.rate) - RATE_LOG_MIN) / (RATE_LOG_MAX - RATE_LOG_MIN),
      (p) => rateFmt(Math.exp(RATE_LOG_MIN + p * (RATE_LOG_MAX - RATE_LOG_MIN))),
      (p) => { m.rate = Math.exp(RATE_LOG_MIN + p * (RATE_LOG_MAX - RATE_LOG_MIN)); },
      'How fast the modulator cycles (0.01–1 Hz)'));
    root.append(slider('Phase', 0, 360, 1, m.phase, (v) => `${Math.round(v)}°`, (v) => { m.phase = v; },
      'Start phase. 0 = centered, rising.'));
  });

  function row(label) {
    const r = document.createElement('div');
    r.className = 'delay-row';
    const l = document.createElement('span');
    l.className = 'delay-label'; l.textContent = label;
    r.append(l);
    return r;
  }
  function mkSelect(options, value) {
    const s = document.createElement('select');
    s.className = 'delay-sel';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      s.append(opt);
    }
    s.value = value;
    if (s.value !== value) s.selectedIndex = 0; // stored target unknown to this kind
    return s;
  }
  function slider(label, min, max, step, value, fmt, set, title) {
    const r = row(label);
    if (title) r.title = title;
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(value);
    const val = document.createElement('span');
    val.className = 'delay-val';
    const show = () => { val.textContent = fmt(+input.value); };
    input.addEventListener('input', () => { set(+input.value); show(); cb.onChange(); });
    show();
    r.append(input, val);
    return r;
  }

  return root;
}

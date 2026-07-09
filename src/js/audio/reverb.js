// reverb.js — the per-lane INSERT reverb: config model + the modal editor UI
// (no audio). Character reverbs meant for a single instrument — the canonical
// case is GATED on a snare, hence the default mode. The audio graph is built in
// audio.js (buildReverbInsert): a ConvolverNode fed a SYNTHESIZED impulse
// response (seeded noise, so live playback and offline exports build the
// identical IR — no samples, no dependency). A "proper" gated reverb also runs
// a compressor/envelope; we're trying convolution alone first (the gate lives
// in the IR: a dense burst hard-cut with a 2 ms anti-click fade). The shared
// send-bus reverb ("the communal wash") remains a separate, future feature.

import { makeKnob } from './knob.js';

export const REVERB_MODES = [
  { id: 'gated', label: 'Gated' },
  { id: 'ambience', label: 'Ambience' }, // a live room's early reflections only
  { id: 'room', label: 'Room' },
  { id: 'hall', label: 'Hall' },
  { id: 'plate', label: 'Plate' },
  { id: 'spring', label: 'Spring' },
];

export const MAX_PREDELAY = 0.08; // seconds — dry hit first, then the burst

// Default = a moderately pronounced GATED, not a polite room (user's call).
export const DEFAULT_REVERB = { on: false, mode: 'gated', size: 0.55, wet: 0.45, damp: 0.35, predelay: 0.02 };
export function defaultReverb() { return { ...DEFAULT_REVERB }; }

// Coerce a loaded/partial reverb config to a full, in-range one (forward/backward safe).
export function normalizeReverb(obj) {
  const r = defaultReverb();
  if (obj && typeof obj === 'object') {
    r.on = !!obj.on;
    if (REVERB_MODES.some((m) => m.id === obj.mode)) r.mode = obj.mode;
    if (typeof obj.size === 'number' && isFinite(obj.size)) r.size = Math.min(1, Math.max(0, obj.size));
    if (typeof obj.wet === 'number' && isFinite(obj.wet)) r.wet = Math.min(1, Math.max(0, obj.wet));
    if (typeof obj.damp === 'number' && isFinite(obj.damp)) r.damp = Math.min(1, Math.max(0, obj.damp));
    if (typeof obj.predelay === 'number' && isFinite(obj.predelay)) r.predelay = Math.min(MAX_PREDELAY, Math.max(0, obj.predelay));
  }
  return r;
}

// The IR's length in seconds for a config — Size sweeps each mode's musical
// range (for Gated, Size IS the gate time). Also the reverb tail the exports
// must leave room for.
export function reverbSeconds(cfg) {
  const s = cfg.size;
  switch (cfg.mode) {
    case 'gated': return 0.06 + 0.24 * s;    // 60–300 ms gate
    case 'ambience': return 0.03 + 0.12 * s; // early reflections only
    case 'room': return 0.25 + 0.75 * s;
    case 'hall': return 0.8 + 2.4 * s;
    case 'plate': return 0.6 + 1.9 * s;
    case 'spring': return 0.5 + 1.5 * s;
    default: return 0.5;
  }
}

const pctFmt = (v) => `${Math.round(v * 100)}%`;
const msFmt = (v) => `${Math.round(v * 1000)} ms`;

// Build the reverb editor body (DOM) for the modal. Mutates `cfg` in place and
// calls cb.onChange() after any edit so the host applies it to the audio live.
export function buildReverbEditor(cfg, cb) {
  const root = document.createElement('div');
  root.className = 'delay-editor';

  const enRow = row('On');
  const en = document.createElement('input');
  en.type = 'checkbox'; en.checked = cfg.on; en.className = 'delay-check';
  en.addEventListener('change', () => { cfg.on = en.checked; cb.onChange(); });
  enRow.append(en);

  // Type — each mode is a different IR recipe (sel swaps DSP, no pane change).
  const modeRow = row('Type');
  const sel = document.createElement('select');
  sel.className = 'delay-sel';
  for (const m of REVERB_MODES) {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label;
    if (cfg.mode === m.id) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => { cfg.mode = sel.value; cb.onChange(); });
  modeRow.append(sel);

  const preRow = knobRow('PreDelay', cfg.predelay, { toPos: (v) => v / MAX_PREDELAY, fromPos: (p) => p * MAX_PREDELAY, format: msFmt }, DEFAULT_REVERB.predelay, (v) => { cfg.predelay = v; cb.onChange(); });
  const sizeRow = knobRow('Size', cfg.size, { toPos: (v) => v, fromPos: (p) => p, format: pctFmt }, DEFAULT_REVERB.size, (v) => { cfg.size = v; cb.onChange(); });
  const wetRow = knobRow('Wet', cfg.wet, { toPos: (v) => v, fromPos: (p) => p, format: pctFmt }, DEFAULT_REVERB.wet, (v) => { cfg.wet = v; cb.onChange(); });
  const dampRow = knobRow('Damp', cfg.damp, { toPos: (v) => v, fromPos: (p) => p, format: pctFmt }, DEFAULT_REVERB.damp, (v) => { cfg.damp = v; cb.onChange(); });

  root.append(enRow, modeRow, preRow, sizeRow, wetRow, dampRow);
  return root;

  function row(labelText) {
    const r = document.createElement('div');
    r.className = 'delay-row';
    const l = document.createElement('span');
    l.className = 'delay-label'; l.textContent = labelText;
    r.append(l);
    return r;
  }
  function knobRow(labelText, value, map, reset, set) {
    const r = row(labelText);
    const val = document.createElement('span');
    val.className = 'delay-val'; val.textContent = map.format(value);
    makeKnob(r, { label: labelText, value, map, reset, cb: { onInput: (v) => { val.textContent = map.format(v); set(v); } } });
    r.append(val);
    return r;
  }
}

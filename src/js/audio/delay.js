// delay.js — the per-lane delay: config model + the modal editor UI (no audio).
//
// Delay is a "track" effect (an insert on the lane strip), so its settings live
// on the lane and save with the project. The audio graph is built in audio.js
// (buildDelayInsert); this module owns the data shape and the editor form.

import { makeKnob } from './knob.js';

// Tempo-synced delay times, as note values → length in beats (× 60/bpm = seconds).
export const DELAY_TIMES = [
  { label: '1/16', beats: 0.25 },
  { label: '1/8',  beats: 0.5 },
  { label: '3/16', beats: 0.75 },
  { label: '1/4',  beats: 1 },
  { label: '3/8',  beats: 1.5 },
  { label: '1/2',  beats: 2 },
  { label: '3/4',  beats: 3 },
  { label: '1',    beats: 4 },
];

export const DELAY_MODES = [
  { id: 'mono', label: 'Mono echo' },
  { id: 'pingpong', label: 'Ping-pong' },
];

export const MAX_FEEDBACK = 0.9; // keep the loop from running away (limiter backstops)

export const DEFAULT_DELAY = { on: false, mode: 'mono', time: 0.5, wet: 0.25, feedback: 0.35 };
export function defaultDelay() { return { ...DEFAULT_DELAY }; }

// Coerce a loaded/partial delay config to a full, in-range one (forward/backward safe).
export function normalizeDelay(obj) {
  const d = defaultDelay();
  if (obj && typeof obj === 'object') {
    d.on = !!obj.on;
    if (obj.mode === 'mono' || obj.mode === 'pingpong') d.mode = obj.mode;
    if (typeof obj.time === 'number' && isFinite(obj.time)) {
      d.time = DELAY_TIMES.reduce((best, t) => (Math.abs(t.beats - obj.time) < Math.abs(best - obj.time) ? t.beats : best), DELAY_TIMES[0].beats);
    }
    if (typeof obj.wet === 'number' && isFinite(obj.wet)) d.wet = Math.min(1, Math.max(0, obj.wet));
    if (typeof obj.feedback === 'number' && isFinite(obj.feedback)) d.feedback = Math.min(MAX_FEEDBACK, Math.max(0, obj.feedback));
  }
  return d;
}

const pctFmt = (v) => `${Math.round(v * 100)}%`;

// Build the delay editor body (DOM) for the modal. Mutates `cfg` in place and
// calls cb.onChange() after any edit so the host applies it to the audio live.
export function buildDelayEditor(cfg, cb) {
  const root = document.createElement('div');
  root.className = 'delay-editor';

  // On/off
  const enRow = row('On');
  const en = document.createElement('input');
  en.type = 'checkbox'; en.checked = cfg.on; en.className = 'delay-check';
  en.addEventListener('change', () => { cfg.on = en.checked; cb.onChange(); });
  enRow.append(en);

  // Mode (segmented buttons)
  const modeRow = row('Mode');
  for (const m of DELAY_MODES) {
    const b = document.createElement('button');
    b.className = 'seg' + (cfg.mode === m.id ? ' on' : '');
    b.textContent = m.label;
    b.addEventListener('click', () => {
      cfg.mode = m.id;
      modeRow.querySelectorAll('.seg').forEach((x) => x.classList.toggle('on', x === b));
      cb.onChange();
    });
    modeRow.append(b);
  }

  // Time (note value)
  const timeRow = row('Time');
  const sel = document.createElement('select');
  sel.className = 'delay-sel';
  for (const t of DELAY_TIMES) {
    const o = document.createElement('option');
    o.value = String(t.beats); o.textContent = t.label;
    if (Math.abs(t.beats - cfg.time) < 1e-9) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => { cfg.time = Number(sel.value); cb.onChange(); });
  timeRow.append(sel);

  // Wet + Feedback knobs (with a live % readout)
  const wetRow = knobRow('Wet', cfg.wet, { toPos: (v) => v, fromPos: (p) => p, format: pctFmt }, DEFAULT_DELAY.wet, (v) => { cfg.wet = v; cb.onChange(); });
  const fbRow = knobRow('Feedback', cfg.feedback, { toPos: (v) => v / MAX_FEEDBACK, fromPos: (p) => p * MAX_FEEDBACK, format: pctFmt }, DEFAULT_DELAY.feedback, (v) => { cfg.feedback = v; cb.onChange(); });

  root.append(enRow, modeRow, timeRow, wetRow, fbRow);
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
    val.className = 'delay-val'; val.textContent = pctFmt(value);
    makeKnob(r, { label: labelText, value, map, reset, cb: { onInput: (v) => { val.textContent = map.format(v); set(v); } } });
    r.append(val);
    return r;
  }
}

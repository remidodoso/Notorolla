// chorus.js — the per-lane Juno-60-style chorus: config model + modal editor UI.
//
// Like the delay, the chorus is a "track" effect (an insert on the lane strip),
// so its settings live on the lane and save with the project. The audio graph is
// built in audio.js (buildChorusInsert); this module owns the data shape and the
// editor form. Authentic to the Juno, the ONLY controls are On and the mode switch
// (I / II / I+II) — rate and depth are fixed presets that emulate the Juno-60, so
// there are no user knobs. Reuses the delay editor's CSS classes for layout.

export const CHORUS_MODES = [
  { id: 'I',    label: 'I' },
  { id: 'II',   label: 'II' },
  { id: 'I+II', label: 'I+II' },
];

export const DEFAULT_CHORUS = { on: false, mode: 'I' };
export function defaultChorus() { return { ...DEFAULT_CHORUS }; }

// Coerce a loaded/partial chorus config to a full, in-range one (forward/backward
// safe — old saves with no chorus field default to off).
export function normalizeChorus(obj) {
  const c = defaultChorus();
  if (obj && typeof obj === 'object') {
    c.on = !!obj.on;
    if (CHORUS_MODES.some((m) => m.id === obj.mode)) c.mode = obj.mode;
  }
  return c;
}

// Build the chorus editor body (DOM) for the modal. Mutates `cfg` in place and
// calls cb.onChange() after any edit so the host applies it to the audio live.
export function buildChorusEditor(cfg, cb) {
  const root = document.createElement('div');
  root.className = 'delay-editor chorus-editor'; // share the delay editor's layout

  // On/off
  const enRow = row('On');
  const en = document.createElement('input');
  en.type = 'checkbox'; en.checked = cfg.on; en.className = 'delay-check';
  en.addEventListener('change', () => { cfg.on = en.checked; cb.onChange(); });
  enRow.append(en);

  // Mode (segmented buttons): I / II / I+II
  const modeRow = row('Mode');
  for (const m of CHORUS_MODES) {
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

  root.append(enRow, modeRow);
  return root;

  function row(labelText) {
    const r = document.createElement('div');
    r.className = 'delay-row';
    const l = document.createElement('span');
    l.className = 'delay-label'; l.textContent = labelText;
    r.append(l);
    return r;
  }
}

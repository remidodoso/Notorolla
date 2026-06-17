// instrumentpane.js — the "Edit instrument" pane for the Vesperia.
//
// An editor panel (not a transport pane): a column of grouped sliders bound to
// ONE target patch at a time. The target is retargetable — main.js points it at
// the grid's neutral patch when the grid is focused, or at a lane's own patch
// when its Edit button is clicked (setTarget). Moving a slider mutates that
// patch in place and calls onChange (which autosaves the right place); the next
// note played on that target hears it. ♪ Test auditions the current target,
// Copy/Paste ferry settings between targets, and Factory Reset restores the
// defaults that ARE the instrument's original sound.

import { PARAMS, toPos, fromPos } from './instrument.js';

// cb: onChange() after any edit, onTest() to audition, onReset() to restore,
// onCopy() to snapshot the target, onPaste() to apply the snapshot.
// Returns { refresh, setTarget, setCanPaste }.
export function buildInstrumentPane(containerEl, cb) {
  containerEl.innerHTML = '';
  const rows = []; // { spec, input, valEl }
  let patch = null; // the current target patch (set via setTarget)

  const head = document.createElement('div');
  head.className = 'instr-head';

  // Which patch is being edited: a color swatch + label (a lane, or the grid).
  const target = document.createElement('span');
  target.className = 'instr-target';
  const swatch = document.createElement('span');
  swatch.className = 'instr-swatch';
  const targetLabel = document.createElement('span');
  targetLabel.className = 'instr-target-label';
  target.append(swatch, targetLabel);

  const title = document.createElement('span');
  title.className = 'instr-title';
  title.textContent = 'Vesperia';
  const kind = document.createElement('span');
  kind.className = 'instr-kind';
  kind.textContent = 'additive · resonant lowpass';
  const spacer = document.createElement('span');
  spacer.style.flex = '1';

  const testBtn = document.createElement('button');
  testBtn.className = 'tbtn';
  testBtn.textContent = '♪ Test';
  testBtn.title = 'Play a note through the current settings';
  testBtn.onclick = () => cb.onTest();

  const copyBtn = document.createElement('button');
  copyBtn.className = 'tbtn';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Copy these instrument settings';
  copyBtn.onclick = () => cb.onCopy();

  const pasteBtn = document.createElement('button');
  pasteBtn.className = 'tbtn';
  pasteBtn.textContent = 'Paste';
  pasteBtn.title = 'Paste copied settings onto the target being edited';
  pasteBtn.disabled = true; // until something is copied
  pasteBtn.onclick = () => cb.onPaste();

  const resetBtn = document.createElement('button');
  resetBtn.className = 'tbtn danger';
  resetBtn.textContent = 'Factory Reset';
  resetBtn.title = 'Restore every setting to the Vesperia’s original sound';
  resetBtn.onclick = () => cb.onReset();

  head.append(target, title, kind, spacer, testBtn, copyBtn, pasteBtn, resetBtn);
  containerEl.append(head);

  const grid = document.createElement('div');
  grid.className = 'instr-grid';
  containerEl.append(grid);

  // One column per group, in first-seen order.
  const groups = new Map();
  for (const spec of PARAMS) {
    if (!groups.has(spec.group)) {
      const col = document.createElement('div');
      col.className = 'instr-group';
      const h = document.createElement('div');
      h.className = 'instr-group-title';
      h.textContent = spec.group;
      col.append(h);
      grid.append(col);
      groups.set(spec.group, col);
    }
    groups.get(spec.group).append(sliderRow(spec));
  }

  function sliderRow(spec) {
    const row = document.createElement('label');
    row.className = 'instr-row';
    row.title = spec.title || '';

    const name = document.createElement('span');
    name.className = 'instr-label';
    name.textContent = spec.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = 0; input.max = 1000; input.step = 1;

    const valEl = document.createElement('span');
    valEl.className = 'instr-val';

    input.addEventListener('input', () => {
      if (!patch) return;
      const v = fromPos(spec, input.value / 1000);
      patch[spec.key] = v;
      valEl.textContent = spec.fmt(v);
      cb.onChange();
    });

    row.append(name, input, valEl);
    rows.push({ spec, input, valEl });
    return row;
  }

  // Re-read the target patch into every slider (after an edit, Copy/Paste,
  // Factory Reset, or a retarget). No-op until a target is set.
  function refresh() {
    if (!patch) return;
    for (const { spec, input, valEl } of rows) {
      input.value = Math.round(toPos(spec, patch[spec.key]) * 1000);
      valEl.textContent = spec.fmt(patch[spec.key]);
    }
  }

  // Point the editor at a different patch object, labeled `label` with `color`
  // (a lane's color, or a neutral grey for the grid). Refreshes the sliders.
  function setTarget(newPatch, label, color) {
    patch = newPatch;
    targetLabel.textContent = label;
    swatch.style.background = color;
    refresh();
  }

  // Enable/disable Paste (main.js enables it once something has been copied).
  function setCanPaste(can) { pasteBtn.disabled = !can; }

  return { refresh, setTarget, setCanPaste };
}

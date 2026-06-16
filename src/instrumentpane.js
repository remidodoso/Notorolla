// instrumentpane.js — the "Edit instrument" pane for the Vesperia.
//
// An editor panel (not a transport pane): a column of grouped sliders bound to
// the live patch struct. Moving a slider mutates the patch in place and calls
// onChange (which autosaves); the next note played hears it. A Test button
// auditions a note through the current patch, and Factory Reset restores the
// defaults that ARE the instrument's original sound.

import { PARAMS, toPos, fromPos } from './instrument.js';

// cb: onChange() after any edit, onTest() to audition, onReset() to restore.
// Returns { refresh } to re-sync the sliders after an external patch change.
export function buildInstrumentPane(containerEl, patch, cb) {
  containerEl.innerHTML = '';
  const rows = []; // { spec, input, valEl }

  const head = document.createElement('div');
  head.className = 'instr-head';
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
  const resetBtn = document.createElement('button');
  resetBtn.className = 'tbtn danger';
  resetBtn.textContent = 'Factory Reset';
  resetBtn.title = 'Restore every setting to the Vesperia’s original sound';
  resetBtn.onclick = () => cb.onReset();
  head.append(title, kind, spacer, testBtn, resetBtn);
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
    input.value = Math.round(toPos(spec, patch[spec.key]) * 1000);

    const valEl = document.createElement('span');
    valEl.className = 'instr-val';
    valEl.textContent = spec.fmt(patch[spec.key]);

    input.addEventListener('input', () => {
      const v = fromPos(spec, input.value / 1000);
      patch[spec.key] = v;
      valEl.textContent = spec.fmt(v);
      cb.onChange();
    });

    row.append(name, input, valEl);
    rows.push({ spec, input, valEl });
    return row;
  }

  // Re-read the patch into every slider (after Factory Reset or a project load).
  function refresh() {
    for (const { spec, input, valEl } of rows) {
      input.value = Math.round(toPos(spec, patch[spec.key]) * 1000);
      valEl.textContent = spec.fmt(patch[spec.key]);
    }
  }

  return { refresh };
}

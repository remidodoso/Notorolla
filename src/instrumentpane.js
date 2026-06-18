// instrumentpane.js — the "Edit instrument" pane.
//
// An editor panel (not a transport pane): controls bound to ONE target patch at
// a time. The target is retargetable — main.js points it at the grid's neutral
// patch when the grid is focused, or at a lane's own patch when its Edit button
// is clicked (setTarget). Moving a control mutates that patch in place and calls
// onChange (which autosaves the right place); the next note played on that
// target hears it. ♪ Test auditions, Copy/Paste ferry settings, Factory Reset
// restores the kind's defaults.
//
// The pane is kind-aware: the body is (re)built for the target patch's `kind`
// (Vesperia, Zindel, …) from that kind's PARAMS, and the kind selector asks the
// host to switch instruments (onKindChange). Params flagged `bar` (Zindel's
// drawbars) render as a row of parallel vertical faders; the rest as sliders.

import { paramsFor, toPos, fromPos, instrumentKinds, instrument } from './instrument.js';

// cb: onChange() after any edit, onKindChange(kind) to switch instrument,
// onTest() to audition, onReset() to restore, onCopy()/onPaste() to ferry.
// Returns { refresh, setTarget, setCanPaste }.
export function buildInstrumentPane(containerEl, cb) {
  containerEl.innerHTML = '';
  let rows = [];        // { spec, input, valEl } for the currently built kind
  let patch = null;     // the current target patch (set via setTarget)
  let builtKind = null; // the kind the body is currently built for

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

  // Instrument selector (the kind) + its one-line description.
  const kindSel = document.createElement('select');
  kindSel.className = 'instr-kind-sel';
  kindSel.title = 'Instrument for this target';
  for (const k of instrumentKinds()) {
    const o = document.createElement('option');
    o.value = k; o.textContent = instrument(k).label;
    kindSel.append(o);
  }
  kindSel.addEventListener('change', () => cb.onKindChange(kindSel.value));

  const desc = document.createElement('span');
  desc.className = 'instr-kind';

  const spacer = document.createElement('span');
  spacer.style.flex = '1';

  const testBtn = mkBtn('♪ Test', 'tbtn', 'Play a note through the current settings', () => cb.onTest());
  const copyBtn = mkBtn('Copy', 'tbtn', 'Copy these instrument settings', () => cb.onCopy());
  const pasteBtn = mkBtn('Paste', 'tbtn', 'Paste copied settings onto the target being edited', () => cb.onPaste());
  pasteBtn.disabled = true; // until something is copied
  const resetBtn = mkBtn('Factory Reset', 'tbtn danger', 'Restore every setting to this instrument’s default sound', () => cb.onReset());

  head.append(target, kindSel, desc, spacer, testBtn, copyBtn, pasteBtn, resetBtn);
  containerEl.append(head);

  const body = document.createElement('div');
  body.className = 'instr-grid';
  containerEl.append(body);

  // Build the control body for `kind`: one column per param group (first-seen
  // order). A group whose params are flagged `bar` gets a row of vertical faders
  // under its title; every other group gets stacked slider rows.
  function buildBody(kind) {
    body.innerHTML = '';
    rows = [];
    const cols = new Map();   // group -> column element
    const barRows = new Map(); // group -> the .instr-drawbars row (bar groups only)
    for (const spec of paramsFor(kind)) {
      if (!cols.has(spec.group)) {
        const col = document.createElement('div');
        col.className = 'instr-group';
        const h = document.createElement('div');
        h.className = 'instr-group-title';
        h.textContent = spec.group;
        col.append(h);
        if (spec.bar) {
          const br = document.createElement('div');
          br.className = 'instr-drawbars';
          col.append(br);
          barRows.set(spec.group, br);
        }
        body.append(col);
        cols.set(spec.group, col);
      }
      if (spec.bar) barRows.get(spec.group).append(barCell(spec));
      else cols.get(spec.group).append(spec.bool ? boolRow(spec) : sliderRow(spec));
    }
    builtKind = kind;
  }

  // A horizontal slider row: label · slider · value.
  function sliderRow(spec) {
    const row = document.createElement('label');
    row.className = 'instr-row';
    row.title = spec.title || '';
    const name = document.createElement('span');
    name.className = 'instr-label';
    name.textContent = spec.label;
    const input = mkRange();
    const valEl = document.createElement('span');
    valEl.className = 'instr-val';
    bind(spec, input, valEl);
    row.append(name, input, valEl);
    return row;
  }

  // A single vertical drawbar fader: value readout · vertical slider · number.
  function barCell(spec) {
    const cell = document.createElement('label');
    cell.className = 'instr-bar';
    cell.title = spec.title || '';
    const valEl = document.createElement('span');
    valEl.className = 'instr-bar-val';
    const input = mkRange();
    input.classList.add('instr-bar-input');
    const name = document.createElement('span');
    name.className = 'instr-bar-label';
    name.textContent = spec.label;
    bind(spec, input, valEl);
    cell.append(valEl, input, name);
    return cell;
  }

  // A checkbox row (a boolean param): label · checkbox · state text.
  function boolRow(spec) {
    const row = document.createElement('label');
    row.className = 'instr-row';
    row.title = spec.title || '';
    const name = document.createElement('span');
    name.className = 'instr-label';
    name.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'instr-check';
    const valEl = document.createElement('span');
    valEl.className = 'instr-val';
    bind(spec, input, valEl);
    row.append(name, input, valEl);
    return row;
  }

  function mkRange() {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = 0; input.max = 1000; input.step = 1;
    return input;
  }

  // Wire a control to a param: edit -> mutate patch, update readout, onChange.
  // Boolean params use a checkbox (the `change` event + `.checked`); the rest a
  // range slider (the `input` event + the param's value mapping).
  function bind(spec, input, valEl) {
    if (spec.bool) {
      input.addEventListener('change', () => {
        if (!patch) return;
        patch[spec.key] = input.checked;
        valEl.textContent = spec.fmt(input.checked);
        cb.onChange();
      });
    } else {
      input.addEventListener('input', () => {
        if (!patch) return;
        const v = fromPos(spec, input.value / 1000);
        patch[spec.key] = v;
        valEl.textContent = spec.fmt(v);
        cb.onChange();
      });
    }
    rows.push({ spec, input, valEl });
  }

  // Re-read the target patch into every control (after an edit, Copy/Paste,
  // Factory Reset, or a retarget). No-op until a target is set.
  function refresh() {
    if (!patch) return;
    for (const { spec, input, valEl } of rows) {
      if (spec.bool) {
        input.checked = !!patch[spec.key];
        valEl.textContent = spec.fmt(!!patch[spec.key]);
      } else {
        input.value = Math.round(toPos(spec, patch[spec.key]) * 1000);
        valEl.textContent = spec.fmt(patch[spec.key]);
      }
    }
  }

  // Point the editor at a patch, labeled `label` with `color` (a lane's color,
  // or a neutral grey for the grid). Rebuilds the body if the kind changed, then
  // syncs the selector, description and every control.
  function setTarget(newPatch, label, color) {
    patch = newPatch;
    if (builtKind !== newPatch.kind) buildBody(newPatch.kind);
    targetLabel.textContent = label;
    swatch.style.background = color;
    kindSel.value = newPatch.kind;
    desc.textContent = instrument(newPatch.kind).desc;
    refresh();
  }

  // Enable/disable Paste (main.js enables it once something has been copied).
  function setCanPaste(can) { pasteBtn.disabled = !can; }

  return { refresh, setTarget, setCanPaste };
}

function mkBtn(text, className, title, onclick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  b.title = title;
  b.onclick = onclick;
  return b;
}

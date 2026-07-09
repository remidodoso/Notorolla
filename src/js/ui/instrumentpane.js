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

import { paramsFor, toPos, fromPos, instrumentKinds, instrument, nearestStep } from '../audio/instrument.js';
import { makeKnob } from './knob.js';

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

  // Patch bar: the target's PATCH identity + catalog ops (Phase B of §14). The
  // name shows Name / Name* (edited or name-not-yet-Saved) / Name [I] (imported —
  // origin id unknown to this catalog). Double-click the name to rename (declaring
  // a fork — Save then creates a new patch). Save = commit to the shown identity
  // (overwrite a user patch of the same name, else fork); Save As = always fork;
  // Load = pick another patch of this kind.
  const patchbar = document.createElement('div');
  patchbar.className = 'instr-patchbar';
  const patchLabel = document.createElement('span');
  patchLabel.className = 'instr-patch-lbl';
  patchLabel.textContent = 'Patch';
  const nameEl = document.createElement('span');
  nameEl.className = 'instr-patch-name';
  nameEl.title = 'Double-click to rename (creates a new patch on Save)';
  nameEl.addEventListener('dblclick', startRenamePatch);
  const saveBtn = mkBtn('Save', 'tbtn', 'Save this patch (a factory or renamed patch saves as a new one)', () => cb.onSave());
  const saveAsBtn = mkBtn('Save As', 'tbtn', 'Save these settings as a new named patch', () => cb.onSaveAs());
  const loadSel = document.createElement('select');
  loadSel.className = 'instr-load-sel';
  loadSel.title = 'Load a patch for this instrument';
  loadSel.addEventListener('change', () => {
    const id = loadSel.value;
    loadSel.selectedIndex = 0; // the select is an action prompt, not a state display
    if (id) cb.onLoad(id);
  });
  const catalogBtn = mkBtn('Catalog', 'tbtn', 'Open the Patch Catalog — browse, apply, rename, delete', () => cb.onCatalog && cb.onCatalog());
  patchbar.append(patchLabel, nameEl, saveBtn, saveAsBtn, loadSel, catalogBtn);
  containerEl.append(patchbar);

  const body = document.createElement('div');
  body.className = 'instr-grid';
  containerEl.append(body);

  // Repaint the patch-name (Name / Name* / Name [I]) and refill the Load menu for
  // the current target/kind. main.js supplies both via callbacks.
  function syncIdentity() {
    const id = cb.getIdentity ? cb.getIdentity() : null;
    if (id) {
      nameEl.textContent = id.name + (id.dirty ? '*' : '') + (id.imported ? ' [I]' : '');
      nameEl.classList.toggle('dirty', !!id.dirty || !!id.imported);
    } else {
      nameEl.textContent = '—';
      nameEl.classList.remove('dirty');
    }
    // Load menu: a placeholder prompt + every patch for the current kind.
    loadSel.innerHTML = '';
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Load…'; loadSel.append(ph);
    const list = (cb.getPatchList && patch) ? cb.getPatchList() : [];
    for (const e of list) {
      const o = document.createElement('option'); o.value = e.id;
      o.textContent = e.factory ? `${e.name} (factory)` : e.name;
      loadSel.append(o);
    }
    loadSel.selectedIndex = 0;
  }

  // Inline rename of the patch name — swap the name span for a text field. Enter/
  // blur commits (declaring a fork name); ESC cancels (the app-wide rule). Focus
  // returns to the app after; the global key handler ignores keys typed in inputs.
  function startRenamePatch() {
    const id = cb.getIdentity ? cb.getIdentity() : null;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'instr-patch-name-input';
    input.value = id ? id.name : '';
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const restore = () => { input.replaceWith(nameEl); syncIdentity(); };
    const commit = () => { if (done) return; done = true; const v = input.value.trim(); restore(); if (v && cb.onRenamePatch) cb.onRenamePatch(v); };
    const cancel = () => { if (done) return; done = true; restore(); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }

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
      else cols.get(spec.group).append(
        spec.knob ? knobRow(spec) : spec.steps ? stepRow(spec) : spec.bool ? boolRow(spec) : spec.sel ? selRow(spec) : sliderRow(spec));
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

  // A stepped-list slider (a quantized param, e.g. Tervik's Coarse ratio): the
  // slider indexes spec.steps and snaps stop-to-stop. label · slider · value.
  function stepRow(spec) {
    const row = document.createElement('label');
    row.className = 'instr-row';
    row.title = spec.title || '';
    const name = document.createElement('span');
    name.className = 'instr-label';
    name.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = 0; input.max = spec.steps.length - 1; input.step = 1;
    const valEl = document.createElement('span');
    valEl.className = 'instr-val';
    bind(spec, input, valEl);
    row.append(name, input, valEl);
    return row;
  }

  // A knob row (a param turned with a rotary, e.g. Tervik's Fine ratio): reuses the
  // mixer knob (detent + double-click reset). label · knob · value.
  function knobRow(spec) {
    const row = document.createElement('label');
    row.className = 'instr-row';
    row.title = spec.title || '';
    const name = document.createElement('span');
    name.className = 'instr-label';
    name.textContent = spec.label;
    const holder = document.createElement('span');
    holder.className = 'instr-knob-holder';
    const valEl = document.createElement('span');
    valEl.className = 'instr-val';
    const map = {
      toPos: (v) => (v - spec.min) / (spec.max - spec.min),
      fromPos: (p) => spec.min + p * (spec.max - spec.min),
      format: spec.fmt,
    };
    const initial = patch ? patch[spec.key] : (spec.reset != null ? spec.reset : spec.min);
    const knob = makeKnob(holder, {
      label: spec.label, value: initial, map, detents: spec.detents || [], reset: spec.reset,
      cb: { onInput: (v) => { if (!patch) return; patch[spec.key] = v; valEl.textContent = spec.fmt(v); cb.onChange(); } },
    });
    valEl.textContent = spec.fmt(initial);
    rows.push({ spec, knob, valEl });
    row.append(name, holder, valEl);
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

  // A dropdown row (an enum param, e.g. Tervik's Algorithm): label · select. The
  // select itself shows the chosen option, so there's no separate value readout.
  function selRow(spec) {
    const row = document.createElement('label');
    row.className = 'instr-row';
    row.title = spec.title || '';
    const name = document.createElement('span');
    name.className = 'instr-label';
    name.textContent = spec.label;
    const input = document.createElement('select');
    input.className = 'instr-sel';
    for (const o of spec.options) {
      const opt = document.createElement('option');
      opt.value = o.id; opt.textContent = o.label;
      input.append(opt);
    }
    bind(spec, input, null);
    row.append(name, input);
    return row;
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
    } else if (spec.sel) {
      input.addEventListener('change', () => {
        if (!patch) return;
        patch[spec.key] = input.value;
        cb.onChange();
      });
    } else if (spec.steps) {
      input.addEventListener('input', () => {
        if (!patch) return;
        const v = spec.steps[+input.value];
        patch[spec.key] = v;
        valEl.textContent = spec.fmt(v);
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
    for (const row of rows) {
      const { spec, input, valEl, knob } = row;
      const v = patch[spec.key];
      if (spec.knob) {
        knob.setValue(v);
        valEl.textContent = spec.fmt(v);
      } else if (spec.bool) {
        input.checked = !!v;
        valEl.textContent = spec.fmt(!!v);
      } else if (spec.sel) {
        input.value = v;
      } else if (spec.steps) {
        const i = spec.steps.indexOf(nearestStep(spec.steps, v));
        input.value = i;
        valEl.textContent = spec.fmt(spec.steps[i]);
      } else {
        input.value = Math.round(toPos(spec, v) * 1000);
        valEl.textContent = spec.fmt(v);
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
    syncIdentity();
  }

  // Enable/disable Paste (main.js enables it once something has been copied).
  function setCanPaste(can) { pasteBtn.disabled = !can; }

  return { refresh, setTarget, setCanPaste, syncIdentity };
}

function mkBtn(text, className, title, onclick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  b.title = title;
  b.onclick = onclick;
  return b;
}

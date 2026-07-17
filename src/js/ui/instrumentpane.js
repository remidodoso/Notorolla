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

import { paramsFor, instrumentKinds, instrument } from '../audio/instrument.js';
import { makeVSlider } from './vslider.js';
import { makeRotarySwitch } from './rotaryswitch.js';
import { makeFmAlgo } from './fmalgo.js';

// The control skin (future/ui_skin). Every kind tags its params with a `role` (a
// hued top group) + `sub` (subgroup label), and renders through buildSkinnedBody
// with the real widgets. Canonical group order + role→hue-class (a role's colour
// is fixed across every instrument; an absent role leaves a spectrum gap).
const ROLE_ORDER = ['lfo', 'osc', 'filter', 'env', 'fx'];
const ROLE_LABEL = { lfo: 'LFO', osc: 'Oscillator', filter: 'Filter', env: 'Envelope', fx: 'Effects' };

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
  const rackBtn = mkBtn('＋ Rack', 'tbtn', 'Add this sound to the rack as a shared instrument (drag it onto lane heads)', () => cb.onAddToRack && cb.onAddToRack());
  const resetBtn = mkBtn('Factory Reset', 'tbtn danger', 'Restore every setting to this instrument’s default sound', () => cb.onReset());

  head.append(target, kindSel, desc, spacer, testBtn, copyBtn, pasteBtn, rackBtn, resetBtn);
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
  const rackPaneBtn = mkBtn('Rack', 'tbtn', 'Open the Rack — shared instrument instances you assign to lanes', () => cb.onRackPane && cb.onRackPane());
  patchbar.append(patchLabel, nameEl, saveBtn, saveAsBtn, loadSel, catalogBtn, rackPaneBtn);
  containerEl.append(patchbar);

  const body = document.createElement('div');
  body.className = 'instr-skin';
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

  // Build the control body for `kind` — every kind uses the control-skin layout.
  function buildBody(kind) {
    body.innerHTML = '';
    rows = [];
    body.className = 'instr-skin';
    buildSkinnedBody(kind);
    builtKind = kind;
  }

  // The control skin: boxed role groups in canonical order (LFO→Osc→Filter→Env→
  // FX), each a fieldset with a hued legend-tab band; inside, labelled subgroups
  // stack the real widgets (a vertical slider per continuous param, uni- or
  // bipolar). Params are bucketed role→sub, both in first-seen order within the
  // canonical role sequence.
  function buildSkinnedBody(kind) {
    const specs = paramsFor(kind);
    const byRole = new Map();  // role -> Map(sub -> [spec])
    for (const spec of specs) {
      if (!byRole.has(spec.role)) byRole.set(spec.role, new Map());
      const subs = byRole.get(spec.role);
      if (!subs.has(spec.sub)) subs.set(spec.sub, []);
      subs.get(spec.sub).push(spec);
    }
    const roles = [...byRole.keys()].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
    for (const role of roles) {
      const sec = document.createElement('section');
      sec.className = `group b-${role}`;
      const h = document.createElement('h2');
      // The band keeps the role's HUE but its text may be overridden per kind (a
      // filter-substitute takes the green slot relabelled — Zindel "Motion").
      const band = specs.find((s) => s.role === role && s.band);
      h.textContent = (band && band.band) || ROLE_LABEL[role] || role;
      sec.append(h);
      const subsEl = document.createElement('div');
      subsEl.className = 'subs';
      for (const [sub, specList] of byRole.get(role)) {
        const subEl = document.createElement('div');
        subEl.className = 'sub';
        const slrow = document.createElement('div');
        slrow.className = 'slrow';
        const sl = document.createElement('span');
        sl.className = 'sl';
        sl.textContent = sub;
        slrow.append(sl);
        // A subgroup may carry a one-shot COPY button (Tervik Env 2/3 ← Env 1).
        const btnSpec = specList.find((s) => s.subButton);
        if (btnSpec) slrow.append(makeSubButton(btnSpec.subButton, subEl));
        const bank = document.createElement('div');
        bank.className = 'bank';
        // Rotary switches (enums) stack vertically in one .rstack at the position
        // of the first rotary; sliders sit in the bank in order.
        let rstack = null;
        for (const spec of specList) {
          const el = skinControl(spec);
          // Small enum rotaries stack in one .rstack; the wide algo picker (and
          // sliders) sit directly in the bank.
          if (spec.sel && spec.widget !== 'algo') {
            if (!rstack) { rstack = document.createElement('div'); rstack.className = 'rstack'; bank.append(rstack); }
            rstack.append(el);
          } else {
            bank.append(el);
          }
        }
        subEl.append(slrow, bank);
        subsEl.append(subEl);
      }
      sec.append(subsEl);
      body.append(sec);
    }
  }

  // One skinned control, chosen by spec kind: an enum (`sel`) → rotary switch, a
  // continuous param → vertical slider (uni- or bipolar). (Future: >5-way enums
  // → readout-window rotary; drawbars.) Returns the widget's element and
  // registers it in `rows` with itself as the inert target — a spec.inert dims
  // that individual control (Padlington's Vowel/Size/Tilt follow the Source).
  function skinControl(spec) {
    const holder = document.createElement('div');
    const onInput = (v) => { if (!patch) return; patch[spec.key] = v; cb.onChange(); updateInert(); };
    if (spec.widget === 'algo') {
      const initial = patch ? patch[spec.key] : (spec.options[0] && spec.options[0].id);
      const w = makeFmAlgo(holder, { spec, value: initial, cb: { onInput } });
      rows.push({ spec, fmalgo: w, rowEl: w.el });
      return w.el;
    }
    if (spec.sel) {
      const initial = patch ? patch[spec.key] : (spec.options[0] && spec.options[0].id);
      const w = makeRotarySwitch(holder, { spec, value: initial, cb: { onInput } });
      rows.push({ spec, rotary: w, rowEl: w.el });
      return w.el;
    }
    const initial = patch ? patch[spec.key] : (spec.reset != null ? spec.reset : spec.min);
    const w = makeVSlider(holder, { spec, value: initial, cb: { onInput } });
    rows.push({ spec, vslider: w, rowEl: w.el });
    return w.el;
  }

  // A one-shot COPY button in a subgroup's label row: snapshots one set of patch
  // keys into another (Tervik "1 → 2" copies Env 1's ADSR into Env 2), then
  // flashes the target subgroup. Not a mode — a single edit (see §13 Tervik).
  function makeSubButton(cfg, subEl) {
    const b = document.createElement('button');
    b.className = 'cpy';
    b.textContent = cfg.label;
    b.title = cfg.title || '';
    b.addEventListener('click', () => {
      if (!patch) return;
      for (let i = 0; i < cfg.to.length; i++) patch[cfg.to[i]] = patch[cfg.from[i]];
      cb.onChange();
      refresh();
      subEl.classList.add('flash');
      setTimeout(() => subEl.classList.remove('flash'), 220);
    });
    return b;
  }

  // Dim the controls that have no effect at the current settings: a spec's
  // optional `inert(patch)` predicate (instrument.js) marks e.g. Padlington's
  // Vowel/Size when the Source isn't Choir, or Boshwick's Snap on a non-snare.
  // The control stays visible (the layout never reflows) but reads as parked.
  function updateInert() {
    if (!patch) return;
    for (const r of rows) {
      if (!r.spec.inert || !r.rowEl) continue;
      r.rowEl.classList.toggle('inert', !!r.spec.inert(patch));
    }
  }

  // Re-read the target patch into every control (after an edit, Copy/Paste,
  // Factory Reset, or a retarget). No-op until a target is set.
  function refresh() {
    if (!patch) return;
    for (const row of rows) {
      const { spec, vslider, rotary, fmalgo } = row;
      const v = patch[spec.key];
      if (vslider) vslider.setValue(v);
      else if (rotary) rotary.setValue(v);
      else if (fmalgo) fmalgo.setValue(v);
    }
    updateInert();
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

// toolbar.js — the grid's brush and view controls.
//
// The toolbar is the single source of the "brush" (default duration +
// articulation that new notes inherit). Per-note edits on the grid stay local
// and never feed back here. Also hosts the Audition, Grid/Stretch, and cursor
// toggles. Mutates the shared `state`; calls onChange(what) after any change.

import { DURATIONS, PALETTE, DUR_ORDER, MIN_COLS, MAX_COLS } from './grid.js';
import { TUNING_LIST } from './tuning.js';
import { SCALES } from './scales.js';

const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function buildToolbar(el, state, onChange) {
  el.innerHTML = '';
  const durBtns = [], artBtns = [], modeBtns = [], curBtns = [];

  // Grab handle: drag this into the Tile player to drop a tile of the current
  // pattern (note-editing already owns dragging on the grid itself).
  const grabHandle = document.createElement('span');
  grabHandle.className = 'grab';
  grabHandle.setAttribute('draggable', 'true');
  grabHandle.textContent = '⠿ pattern →';
  grabHandle.title = 'Drag into the Tile player';
  el.append(grabHandle, sep());

  // Pattern lifecycle. New doubles as Restore when a pattern is parked.
  const newBtn = button('New');
  newBtn.onclick = () => onChange('new');
  const cloneBtn = button('Clone');
  cloneBtn.onclick = () => onChange('clone');
  const randomBtn = button('New Random');
  randomBtn.title = 'Create a new pattern from random in-scale notes (a dialog previews candidates before you accept)';
  randomBtn.onclick = () => onChange('random');
  el.append(newBtn, cloneBtn, randomBtn, sep());

  // Per-pattern undo/redo.
  const undoBtn = button('Undo');
  undoBtn.onclick = () => onChange('undo');
  const redoBtn = button('Redo');
  redoBtn.onclick = () => onChange('redo');
  el.append(undoBtn, redoBtn, sep());

  el.append(label('Duration'));
  DUR_ORDER.forEach((i) => {       // shown shortest → longest, regardless of storage order
    const b = button(DURATIONS[i].name);
    b.classList.add('swatch');
    b.style.background = PALETTE[i];
    b._dur = i;
    b.onclick = () => { state.brush.durIndex = i; refresh(); onChange('duration'); };
    // Double-click a duration brush → set the WHOLE pattern to that duration (quick,
    // undoable). The two clicks first set the brush; the dblclick applies it to all.
    b.ondblclick = () => { state.brush.durIndex = i; onChange('durationAll'); };
    durBtns.push(b);
    el.append(b);
  });

  el.append(sep(), label('Articulation'));
  [['Normal', false], ['Accent', true]].forEach(([t, v]) => {
    const b = button(t);
    b._accent = v;
    b.onclick = () => { state.brush.accent = v; refresh(); onChange('brush'); };
    artBtns.push(b);
    el.append(b);
  });

  el.append(sep());
  const aud = button('Audition');
  aud.onclick = () => { state.audition = !state.audition; refresh(); onChange('audition'); };
  el.append(aud);

  const hl = button('Active rows');
  hl.onclick = () => { state.highlightRows = !state.highlightRows; refresh(); onChange('highlight'); };
  el.append(hl);

  const triadsBtn = button('Triads');
  triadsBtn.title = 'Label traditional triads found in three adjacent notes (12-ET)';
  triadsBtn.onclick = () => { state.showTriads = !state.showTriads; refresh(); onChange('triads'); };
  el.append(triadsBtn);

  // Triadulator: propose triads built from the pitch classes NOT yet used, place
  // them as prospective (un-set) notes, rotate through alternatives, then Confirm.
  el.append(sep(), label('Triadulate'));
  const triadBtn = button('Triadulate');
  triadBtn.onclick = () => onChange('triadulate');
  const confirmBtn = button('Confirm');
  confirmBtn.onclick = () => onChange('confirmTriad');
  const properBtn = button('Proper');
  properBtn.title = 'Only complete triadulations (every remaining pitch filled by a triad)';
  properBtn.onclick = () => { state.proper = !state.proper; refresh(); onChange('proper'); };
  // The chord-family toggles are rebuilt per tuning (the families a tuning offers —
  // trad/sus in 12-ET, septimal in 16-ET) via setFamilyButtons; state.families is a
  // map of enabled family ids.
  const familyBox = document.createElement('span');
  familyBox.className = 'tb-families';
  el.append(triadBtn, confirmBtn, properBtn, familyBox);

  // Permute tools, acting on the grid's current selection.
  const permuteLabel = label('Permute');
  permuteLabel.title = 'These act on the selected notes — or all notes if nothing is selected.';
  el.append(sep(), permuteLabel);
  const rotateBtn = button('⟳');
  rotateBtn.title = 'Rotate the notes one position to the right';
  rotateBtn.onclick = () => onChange('rotate');
  const reverseBtn = button('⇄');
  reverseBtn.title = 'Reverse the note order (retrograde)';
  reverseBtn.onclick = () => onChange('reverse');
  const sortAscBtn = button('▁▃▅▇');
  sortAscBtn.title = 'Sort the selected notes by pitch, ascending';
  sortAscBtn.onclick = () => onChange('sortAsc');
  const sortDescBtn = button('▇▅▃▁');
  sortDescBtn.title = 'Sort the selected notes by pitch, descending';
  sortDescBtn.onclick = () => onChange('sortDesc');
  const shuffleBtn = button('▃▇▇▅▁');
  shuffleBtn.title = 'Shuffle the selected notes (may place identical pitches next to each other)';
  shuffleBtn.onclick = () => onChange('shuffle');
  const shuffleNoRepBtn = button('▇▃▇▅▁');
  shuffleNoRepBtn.title = 'Shuffle, but avoid putting two of the same pitch next to each other '
    + '(does its best when a pitch is too common to fully avoid it)';
  shuffleNoRepBtn.onclick = () => onChange('shuffleNoRep');
  el.append(rotateBtn, reverseBtn, sortAscBtn, sortDescBtn, shuffleBtn, shuffleNoRepBtn);

  // Mutate tools (transpose). Act on the selection, or all notes if none selected.
  const mutateLabel = label('Mutate');
  mutateLabel.title = 'Transpose the selected notes — or all notes if nothing is selected. '
    + 'Arrow keys ↑/↓ transpose a pitch class; Shift = an octave.';
  el.append(sep(), mutateLabel);
  const transUpBtn = button('↑');
  transUpBtn.title = 'Transpose up a pitch class (↑ arrow; Shift+↑ = octave)';
  transUpBtn.onclick = () => onChange('transposeUp');
  const transDownBtn = button('↓');
  transDownBtn.title = 'Transpose down a pitch class (↓ arrow; Shift+↓ = octave)';
  transDownBtn.onclick = () => onChange('transposeDown');
  el.append(transUpBtn, transDownBtn);

  // Pitch context (per pattern): tuning (how degrees sound), scale mask + root
  // (which degrees are in scale → highlight + snap). Driven by the current
  // pattern; main sets the values via tb.refresh-adjacent updateScaleControls.
  el.append(sep(), label('Pitch'));
  const tuningSel = select(TUNING_LIST.map((t) => ({ value: t.id, label: t.label })));
  tuningSel.title = 'Tuning: how each degree is turned into a pitch. 12-ET is standard equal '
    + 'temperament; Just (5-limit) retunes the 12 notes to pure whole-number ratios, reckoned '
    + 'from the root (so the root stays put and the just intervals fan out from it).';
  tuningSel.onchange = () => onChange('tuning');
  const scaleSel = select(SCALES.map((s) => ({ value: s.id, label: s.name })));
  scaleSel.title = 'Scale: a mask over the 12 notes. It highlights the in-scale rows and snaps '
    + 'your edits to them — the tuning still defines how every note sounds, this just chooses '
    + 'which notes you write with.';
  scaleSel.onchange = () => onChange('scale');
  const rootSel = select(ROOT_NAMES.map((n, i) => ({ value: String(i), label: n })));
  rootSel.title = 'Root: the tonic the scale and the Just tuning are built from. The root note '
    + 'is marked with a gold stripe on the grid. (No effect in 12-ET + Chromatic, which has no tonic.)';
  rootSel.onchange = () => onChange('scaleRoot');
  el.append(tuningSel, scaleSel, rootSel);

  el.append(sep(), label('Layout'));
  [['Grid', 'grid'], ['Stretch', 'stretch']].forEach(([t, v]) => {
    const b = button(t);
    b._mode = v;
    b.onclick = () => { state.mode = v; refresh(); onChange('mode'); };
    modeBtns.push(b);
    el.append(b);
  });

  // Reference: freeze a selected tile as a read-only backdrop to edit/hear against
  // (the New-Counterpoint on-ramp — future_directions.md §16). Set is enabled only
  // when exactly one tile is selected; the rest of the group appears once one is set.
  el.append(sep(), label('Reference'));
  const setRefBtn = button('Set Reference');
  setRefBtn.title = 'Freeze the selected tile as a read-only backdrop to edit against '
    + '(overlay + play-along). Needs exactly one tile selected in the Tile player. '
    + 'A frozen copy — later edits to that tile don’t change it.';
  // Fire on POINTERDOWN, not click: the grid pane's own pointerdown handler switches
  // the active pane on press — which clears the tile selection and disables this
  // button — before a click could fire. Pointerdown reaches this button (the event
  // target) before that ancestor handler, so we grab the selection while it's live.
  setRefBtn.addEventListener('pointerdown', (e) => {
    if (setRefBtn.disabled) return;
    e.preventDefault();
    onChange('setRef');
  });
  const refChip = document.createElement('span');
  refChip.className = 'tb-ref-chip';
  const clearRefBtn = button('✕');
  clearRefBtn.title = 'Clear the reference (restores your previous layout)';
  clearRefBtn.onclick = () => onChange('clearRef');
  // One 3-way control for the reference's level: green = full, yellow = Soft
  // (quieter), red = Muted. Click cycles full → soft → mute → full.
  const softMuteBtn = button('Soft/Mute');
  softMuteBtn.title = 'Reference level — click to cycle: green = full, yellow = Soft (quieter), red = Muted';
  softMuteBtn.onclick = () => onChange('refCycle');
  el.append(setRefBtn, refChip, clearRefBtn, softMuteBtn);
  // Reflect the reference's presence + 3-way level. The group stays VISIBLE with a
  // reference set or not (Clear/Soft-Mute greyed when none) so its state reads.
  function setReferenceUI(info) {
    const active = !!info;
    refChip.textContent = active ? `❄ ${info.name}` : '(none)';
    refChip.classList.toggle('inactive', !active);
    clearRefBtn.disabled = !active;
    softMuteBtn.disabled = !active;
    const level = !active ? 'full' : info.muted ? 'mute' : info.quieter ? 'soft' : 'full';
    softMuteBtn.classList.remove('ref-full', 'ref-soft', 'ref-mute');
    softMuteBtn.classList.add('ref-' + level);
  }
  const setRefEnabled = (on) => { setRefBtn.disabled = !on; };
  setReferenceUI(null);

  // Per-pattern column count: a "Cols  − N +" stepper (the pattern's own width).
  el.append(sep(), label('Cols'));
  const colsDec = button('−');
  colsDec.title = 'Remove the last column from this pattern';
  colsDec.onclick = () => onChange('colsDec');
  const colsVal = document.createElement('span');
  colsVal.className = 'tb-cols-val';
  const colsInc = button('+');
  colsInc.title = 'Add a column to this pattern';
  colsInc.onclick = () => onChange('colsInc');
  el.append(colsDec, colsVal, colsInc);
  // Reflect the current pattern's column count, disabling at the limits.
  function setCols(n) {
    colsVal.textContent = String(n);
    colsDec.disabled = n <= MIN_COLS;
    colsInc.disabled = n >= MAX_COLS;
  }

  el.append(sep(), label('Cursor'));
  [['Dot', 'dot'], ['Glyph', 'glyph']].forEach(([t, v]) => {
    const b = button(t);
    b._cursor = v;
    b.onclick = () => { state.cursor = v; refresh(); onChange('cursor'); };
    curBtns.push(b);
    el.append(b);
  });

  // Clear is destructive (empties the current pattern, and any tiles using it),
  // so it lives off to the side where it won't be hit by reflex.
  const clearBtn = button('Clear');
  clearBtn.classList.add('danger');
  clearBtn.onclick = () => onChange('clear');
  el.append(sep(), clearBtn);

  // Sync the active highlights to the current state.
  // Rebuild a <select>'s options ({value,label}[]), keeping the current value if
  // it's still present. Used to retune the root + scale pickers when the tuning's
  // EDO changes (12 letter roots / 16 hex roots; 12-ET masks / 16-ET Mavila masks).
  function setSelectOptions(sel, items) {
    const prev = sel.value;
    sel.innerHTML = '';
    for (const o of items) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      sel.append(opt);
    }
    if (items.some((o) => o.value === prev)) sel.value = prev;
  }
  const setRootOptions = (items) => setSelectOptions(rootSel, items);
  const setScaleOptions = (items) => setSelectOptions(scaleSel, items);

  // Rebuild the chord-family toggle buttons for the current tuning. `items` =
  // [{ id, label, title }]; each toggles state.families[id] and re-triadulates.
  function setFamilyButtons(items) {
    familyBox.innerHTML = '';
    for (const it of items) {
      const b = button(it.label);
      b._family = it.id;
      if (it.title) b.title = it.title;
      b.classList.toggle('active', !!state.families[it.id]);
      b.onclick = () => {
        state.families[it.id] = !state.families[it.id];
        b.classList.toggle('active', !!state.families[it.id]);
        onChange('family');
      };
      familyBox.append(b);
    }
  }

  function refresh() {
    durBtns.forEach((b) => b.classList.toggle('active', state.brush.durIndex === b._dur));
    artBtns.forEach((b) => b.classList.toggle('active', b._accent === state.brush.accent));
    const refActive = !!state.reference;
    modeBtns.forEach((b) => { b.classList.toggle('active', b._mode === state.mode); b.disabled = refActive && b._mode === 'grid'; });
    curBtns.forEach((b) => b.classList.toggle('active', b._cursor === state.cursor));
    aud.classList.toggle('active', state.audition);
    hl.classList.toggle('active', state.highlightRows);
    triadsBtn.classList.toggle('active', state.showTriads);
    properBtn.classList.toggle('active', state.proper);
    for (const b of familyBox.children) b.classList.toggle('active', !!state.families[b._family]);
  }
  refresh();
  return { refresh, setRootOptions, setScaleOptions, setFamilyButtons, setCols, setReference: setReferenceUI, setRefEnabled, grabHandle, newBtn, cloneBtn, randomBtn, undoBtn, redoBtn, clearBtn, triadBtn, confirmBtn, properBtn, rotateBtn, reverseBtn, sortAscBtn, sortDescBtn, shuffleBtn, shuffleNoRepBtn, transUpBtn, transDownBtn, tuningSel, scaleSel, rootSel };
}

function button(text) {
  const b = document.createElement('button');
  b.className = 'tbtn';
  b.textContent = text;
  return b;
}
function select(options) {
  const s = document.createElement('select');
  s.className = 'tsel';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    s.append(opt);
  }
  return s;
}
function label(text) {
  const s = document.createElement('span');
  s.className = 'tlabel';
  s.textContent = text;
  return s;
}
function sep() {
  const s = document.createElement('span');
  s.className = 'tsep';
  return s;
}

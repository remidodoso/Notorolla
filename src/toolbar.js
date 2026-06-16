// toolbar.js — the grid's brush and view controls.
//
// The toolbar is the single source of the "brush" (default duration +
// articulation that new notes inherit). Per-note edits on the grid stay local
// and never feed back here. Also hosts the Audition, Grid/Stretch, and cursor
// toggles. Mutates the shared `state`; calls onChange(what) after any change.

import { DURATIONS, PALETTE, DUR_ORDER } from './grid.js';
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
  el.append(newBtn, cloneBtn, sep());

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
  el.append(triadBtn, confirmBtn, properBtn);

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
  function refresh() {
    durBtns.forEach((b) => b.classList.toggle('active', state.brush.durIndex === b._dur));
    artBtns.forEach((b) => b.classList.toggle('active', b._accent === state.brush.accent));
    modeBtns.forEach((b) => b.classList.toggle('active', b._mode === state.mode));
    curBtns.forEach((b) => b.classList.toggle('active', b._cursor === state.cursor));
    aud.classList.toggle('active', state.audition);
    hl.classList.toggle('active', state.highlightRows);
    triadsBtn.classList.toggle('active', state.showTriads);
    properBtn.classList.toggle('active', state.proper);
  }
  refresh();
  return { refresh, grabHandle, newBtn, cloneBtn, undoBtn, redoBtn, clearBtn, triadBtn, confirmBtn, properBtn, rotateBtn, reverseBtn, sortAscBtn, sortDescBtn, shuffleBtn, shuffleNoRepBtn, transUpBtn, transDownBtn, tuningSel, scaleSel, rootSel };
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

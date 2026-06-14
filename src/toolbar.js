// toolbar.js — the grid's brush and view controls.
//
// The toolbar is the single source of the "brush" (default duration +
// articulation that new notes inherit). Per-note edits on the grid stay local
// and never feed back here. Also hosts the Audition, Grid/Stretch, and cursor
// toggles. Mutates the shared `state`; calls onChange(what) after any change.

import { DURATIONS, PALETTE } from './grid.js';

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
  DURATIONS.forEach((d, i) => {
    const b = button(d.name);
    b.classList.add('swatch');
    b.style.background = PALETTE[i];
    b.onclick = () => { state.brush.durIndex = i; refresh(); onChange('brush'); };
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
    durBtns.forEach((b, i) => b.classList.toggle('active', state.brush.durIndex === i));
    artBtns.forEach((b) => b.classList.toggle('active', b._accent === state.brush.accent));
    modeBtns.forEach((b) => b.classList.toggle('active', b._mode === state.mode));
    curBtns.forEach((b) => b.classList.toggle('active', b._cursor === state.cursor));
    aud.classList.toggle('active', state.audition);
    hl.classList.toggle('active', state.highlightRows);
  }
  refresh();
  return { refresh, grabHandle, newBtn, cloneBtn, undoBtn, redoBtn, clearBtn };
}

function button(text) {
  const b = document.createElement('button');
  b.className = 'tbtn';
  b.textContent = text;
  return b;
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

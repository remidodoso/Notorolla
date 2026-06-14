// main.js — wire model, audio, scheduler, grid, roll, tiles, toolbar, panes.

import { AudioEngine } from './audio.js';
import { Scheduler } from './scheduler.js';
import { PianoRoll } from './pianoroll.js';
import { Note, Score } from './model.js';
import { Pattern } from './grid.js';
import { PatternLibrary, Arrangement, LANE_COLORS } from './library.js';
import { GridView } from './gridview.js';
import { TilePlayer } from './tileplayer.js';
import { buildToolbar } from './toolbar.js';
import { setupPanes } from './panes.js';

const LIB_KEY = 'notorolla.lib';
const ARR_KEY = 'notorolla.arr';
const UI_KEY = 'notorolla.ui';
const LAYOUT_KEY = 'notorolla.layout2';
const LOOP_MAX = 8;
const LOOP_STEP = 4;
const HISTORY_LIMIT = 200;

// --- persisted UI state -----------------------------------------------

const state = {
  bpm: 120,
  articulation: 0.88,
  brush: { durIndex: 1, accent: false },
  mode: 'grid',
  audition: true,
  cursor: 'dot',
  highlightRows: true,
  topDegree: 71,
  visibleRows: 12,
  activePane: 'grid', // 'grid' | 'tiles' — which pane the roll mirrors
};
Object.assign(state, readJSON(UI_KEY) || {});

let activePane = state.activePane;

// --- registry + arrangement -------------------------------------------

const savedArr = readJSON(ARR_KEY);
const arrangement = savedArr ? Arrangement.fromJSON(savedArr) : new Arrangement();

const isReferenced = (name) => arrangement.referencedNames().has(name);

const savedLib = readJSON(LIB_KEY);
const library = savedLib
  ? PatternLibrary.fromJSON(savedLib, isReferenced)
  : (() => { const l = new PatternLibrary(isReferenced); l.seed(); return l; })();

// --- core objects -----------------------------------------------------

const engine = new AudioEngine();
const scheduler = new Scheduler(engine);
scheduler.onEnded = () => {};
scheduler.onCycle = (score) => { roll.setScore(score); };

let activeSource = null; // 'grid' | 'tiles' | null — only one transport at a time

const buildScore = () => library.current().toScore(state.bpm, state.articulation);

function patternLen(name) {
  const p = library.patterns.get(name);
  return p ? p.toScore(state.bpm, state.articulation).lengthBeats : 0;
}

// Overlay all lanes in parallel (each from t=0) into one score; the length is
// the longest lane. Notes carry their lane color, dimmed for non-active lanes.
function arrangementScore() {
  const notes = [];
  let maxLen = 0;
  arrangement.lanes.forEach((lane, li) => {
    const color = LANE_COLORS[li % LANE_COLORS.length];
    const alpha = lane.id === arrangement.activeLaneId ? 1 : 0.3;
    let t = 0;
    for (const tile of lane.tiles) {
      const p = library.patterns.get(tile.name);
      if (!p) continue;
      const s = p.toScore(state.bpm, state.articulation);
      for (const n of s.notes) {
        const nn = new Note(n.pitch, n.start + t, n.duration, n.velocity);
        nn.color = color;
        nn.alpha = alpha;
        notes.push(nn);
      }
      t += s.lengthBeats;
    }
    maxLen = Math.max(maxLen, t);
  });
  return new Score(notes, state.bpm, state.articulation, maxLen);
}

// The tiles currently sounding — one per lane whose timeline covers `beat`.
function playingTileIds(beat) {
  const ids = new Set();
  for (const lane of arrangement.lanes) {
    let t = 0;
    for (const tile of lane.tiles) {
      const len = patternLen(tile.name);
      if (beat >= t && beat < t + len) { ids.add(tile.id); break; }
      t += len;
    }
  }
  return ids;
}

// Start beat of a tile within its own lane's timeline.
function tileStartBeat(id) {
  const lane = arrangement.laneOfTile(id);
  if (!lane) return 0;
  let t = 0;
  for (const tile of lane.tiles) {
    if (tile.id === id) return t;
    t += patternLen(tile.name);
  }
  return 0;
}

// The roll mirrors the active pane: the grid's current pattern, or the whole
// arrangement when the tile player is active.
function activeScore() {
  return activePane === 'tiles' ? arrangementScore() : buildScore();
}

const roll = new PianoRoll(document.getElementById('roll'), activeScore());

const grid = new GridView(document.getElementById('grid'), library.current(), {
  getMode: () => state.mode,
  getBrush: () => state.brush,
  getCursorStyle: () => state.cursor,
  getHighlightRows: () => state.highlightRows,
  getViewport: () => ({ top: state.topDegree, rows: state.visibleRows }),
  onViewport: (top, rows) => { state.topDegree = top; state.visibleRows = rows; grid.draw(); persist(); },
  onAudition: (pitch) => audition(pitch),
  onChange: () => { setActive('grid'); refresh(); },
  onHistory: (before) => pushHistory(before),
  handle: document.getElementById('gridResize'),
  guide: document.getElementById('resizeGuide'),
  scrollWrap: document.getElementById('gridScroll'),
});

const tb = buildToolbar(document.getElementById('toolbar'), state, onToolbarChange);

const tilePlayer = new TilePlayer(document.getElementById('tileLane'), library, arrangement, {
  onSelect: (id) => selectTile(id),
  onOpen: (name, id) => openTile(name, id),
  onDropAppend: (laneId) => appendCurrentTile(laneId),
  onLaneClick: (laneId) => {
    setActive('tiles');
    arrangement.activeLaneId = laneId;
    arrangement.selectedId = null;
    tilePlayer.setSelected(null);
    tilePlayer.setActiveLane(laneId);
    updateRollContent(); scrollRollToSelected();
    persist();
  },
});

function selectTile(id) {
  setActive('tiles');
  const lane = arrangement.laneOfTile(id);
  if (lane) arrangement.activeLaneId = lane.id;
  arrangement.selectedId = id;
  tilePlayer.setSelected(id);
  tilePlayer.setActiveLane(arrangement.activeLaneId);
  updateRollContent(); scrollRollToSelected();
  tileDeleteBtn.disabled = false;
  persist();
}

// Double-click: load the tile's pattern into the editor (by reference) but keep
// the tile player active and the tile selected.
function openTile(name, id) {
  setActive('tiles');
  const lane = arrangement.laneOfTile(id);
  if (lane) arrangement.activeLaneId = lane.id;
  library.open(name);
  arrangement.selectedId = id;
  refresh();
  scrollRollToSelected();
}

setupPanes(document.getElementById('panes'), LAYOUT_KEY);

// --- active pane ------------------------------------------------------

const gridPaneEl = document.querySelector('.pane[data-pane="grid"]');
const tilesPaneEl = document.querySelector('.pane[data-pane="tiles"]');
gridPaneEl.addEventListener('pointerdown', () => setActive('grid'));
tilesPaneEl.addEventListener('pointerdown', () => setActive('tiles'));

function setActive(pane) {
  if (activePane === pane) return;
  activePane = pane;
  state.activePane = pane;
  if (pane === 'grid') { arrangement.selectedId = null; tilePlayer.setSelected(null); }
  applyActiveHighlight();
  updateRollContent(); scrollRollToSelected();
  persist();
}

function applyActiveHighlight() {
  gridPaneEl.classList.toggle('active-pane', activePane === 'grid');
  tilesPaneEl.classList.toggle('active-pane', activePane === 'tiles');
}

// --- roll auto-scroll -------------------------------------------------

const rollScroll = document.getElementById('rollScroll');

function ensureRollVisible(x) {
  const el = rollScroll;
  const margin = 80;
  if (x > el.scrollLeft + el.clientWidth - margin) el.scrollLeft = x - el.clientWidth + margin;
  else if (x < el.scrollLeft + margin) el.scrollLeft = Math.max(0, x - margin);
}
function scrollRollToSelected() {
  if (scheduler.isPlaying) return; // playback drives the scroll itself
  if (activePane === 'tiles' && arrangement.selectedId != null) {
    rollScroll.scrollLeft = Math.max(0, roll.xForBeat(tileStartBeat(arrangement.selectedId)) - 40);
  } else {
    rollScroll.scrollLeft = 0;
  }
}

// Update the roll's score (e.g. after an active-lane change recolors it). While
// playing, the roll mirrors the playing source and renderLoop does the drawing;
// when stopped, it mirrors the active pane and we draw here.
function updateRollContent() {
  const score = scheduler.isPlaying
    ? (activeSource === 'tiles' ? arrangementScore() : buildScore())
    : activeScore();
  roll.setScore(score);
  if (!scheduler.isPlaying) roll.draw();
}

// --- per-pattern undo / redo ------------------------------------------

const histories = new Map();
function hist(name) {
  if (!histories.has(name)) histories.set(name, { past: [], future: [] });
  return histories.get(name);
}
function curSnap() { return JSON.stringify(library.current().toJSON()); }
function applyCur(json) {
  library.current().columns = Pattern.fromJSON(JSON.parse(json), library.currentName).columns;
}
function pushHistory(before) {
  const h = hist(library.currentName);
  h.past.push(before);
  if (h.past.length > HISTORY_LIMIT) h.past.shift();
  h.future.length = 0;
}
function undo() {
  const h = hist(library.currentName);
  if (!h.past.length) return;
  h.future.push(curSnap());
  applyCur(h.past.pop());
  refresh();
}
function redo() {
  const h = hist(library.currentName);
  if (!h.future.length) return;
  h.past.push(curSnap());
  applyCur(h.future.pop());
  refresh();
}

// --- arrangement undo / redo ------------------------------------------

const arrPast = [];
const arrFuture = [];
function arrSnap() { return JSON.stringify(arrangement.toJSON()); }
function arrRecord() { arrPast.push(arrSnap()); if (arrPast.length > HISTORY_LIMIT) arrPast.shift(); arrFuture.length = 0; }
function arrApply(json) {
  const o = JSON.parse(json);
  arrangement.lanes = o.lanes.map((l) => ({ id: l.id, tiles: l.tiles.map((t) => ({ id: t.id, name: t.name })) }));
  arrangement.seq = o.seq || 0;
  if (o.activeLaneId != null) arrangement.activeLaneId = o.activeLaneId;
  if (!arrangement.allTiles().some((t) => t.id === arrangement.selectedId)) arrangement.selectedId = null;
}
function arrUndo() { if (!arrPast.length) return; arrFuture.push(arrSnap()); arrApply(arrPast.pop()); refresh(); }
function arrRedo() { if (!arrFuture.length) return; arrPast.push(arrSnap()); arrApply(arrFuture.pop()); refresh(); }

function appendCurrentTile(laneId) {
  arrRecord();
  arrangement.append(laneId, library.current().name);
  arrangement.activeLaneId = laneId;
  refresh();
}
function deleteSelectedTile() {
  if (arrangement.selectedId == null) return;
  arrRecord();
  arrangement.remove(arrangement.selectedId);
  refresh();
}

// --- pattern lifecycle ------------------------------------------------

function newOrRestore() {
  if (library.parkedName) library.restore();
  else library.newPattern();
  arrangement.selectedId = null;
  refresh();
}
function clonePattern() {
  library.clone();
  arrangement.selectedId = null;
  refresh();
}
function clearPattern() {
  const cur = library.current();
  if (isReferenced(cur.name) &&
      !confirm(`Pattern ${cur.name} is used by tiles — clear it (and empty those tiles)?`)) {
    return;
  }
  const before = curSnap();
  library.clearCurrent();
  pushHistory(before);
  arrangement.selectedId = null;
  refresh();
}

// --- audition ---------------------------------------------------------

async function audition(pitch) {
  if (!state.audition) return;
  const t = await engine.ensureRunning();
  engine.playNote(pitch, t + 0.005, 60 / state.bpm, 0.85);
}

// --- refresh / persist ------------------------------------------------

function onToolbarChange(what) {
  setActive('grid'); // the toolbar belongs to the grid pane
  switch (what) {
    case 'undo': undo(); return;
    case 'redo': redo(); return;
    case 'new': newOrRestore(); return;
    case 'clone': clonePattern(); return;
    case 'clear': clearPattern(); return;
    default: grid.updateCursor(); refresh();
  }
}

function refresh() {
  grid.pattern = library.current();
  grid.draw();
  updateRollContent(); scrollRollToSelected();
  tilePlayer.render();
  gridName.textContent = library.currentName;
  updateEditButtons();
  updateTransportButtons();
  persist();
}

function updateEditButtons() {
  if (library.parkedName) {
    tb.newBtn.textContent = `↺ ${library.parkedName}`;
    tb.newBtn.disabled = false;
    tb.cloneBtn.disabled = true;
  } else {
    tb.newBtn.textContent = 'New';
    const ok = library.canCreate();
    tb.newBtn.disabled = !ok;
    tb.cloneBtn.disabled = !ok;
  }
  const h = hist(library.currentName);
  tb.undoBtn.disabled = h.past.length === 0;
  tb.redoBtn.disabled = h.future.length === 0;
  arrUndoBtn.disabled = arrPast.length === 0;
  arrRedoBtn.disabled = arrFuture.length === 0;
  tileDeleteBtn.disabled = arrangement.selectedId == null;
}

function persist() {
  localStorage.setItem(LIB_KEY, JSON.stringify(library.toJSON()));
  localStorage.setItem(ARR_KEY, JSON.stringify(arrangement.toJSON()));
  localStorage.setItem(UI_KEY, JSON.stringify({
    bpm: state.bpm, brush: state.brush, mode: state.mode, audition: state.audition,
    cursor: state.cursor, highlightRows: state.highlightRows,
    topDegree: state.topDegree, visibleRows: state.visibleRows, activePane: state.activePane,
  }));
}

// --- transport (grid and tiles, mutually exclusive) -------------------

const loopBtn = document.getElementById('loop');
const playBtn = document.getElementById('play');
const stopBtn = document.getElementById('stop');
const tilePlayBtn = document.getElementById('tilePlay');
const tileStopBtn = document.getElementById('tileStop');
const tileLoopBtn = document.getElementById('tileLoop');
const tempo = document.getElementById('tempo');
const tempoLabel = document.getElementById('tempoLabel');
const arrUndoBtn = document.getElementById('arrUndo');
const arrRedoBtn = document.getElementById('arrRedo');
const tileDeleteBtn = document.getElementById('tileDelete');
const gridName = document.getElementById('gridName');

let rafId = null;

function renderLoop() {
  roll.draw(scheduler.isPlaying ? scheduler.currentBeat : null);
  if (scheduler.isPlaying) {
    ensureRollVisible(roll.xForBeat(scheduler.currentBeat));
    if (activeSource === 'tiles') tilePlayer.setPlaying(playingTileIds(scheduler.currentBeat));
  }
  updateTransportButtons();
  if (scheduler.isPlaying) {
    rafId = requestAnimationFrame(renderLoop);
  } else {
    rafId = null;
    activeSource = null;
    tilePlayer.setPlaying(new Set());
    refresh();
  }
}

function startRender() { if (rafId === null) renderLoop(); }

async function startTransport(source, loop) {
  if (source === 'tiles' && arrangement.allTiles().length === 0) return;
  setActive(source);
  const now = await engine.ensureRunning();
  scheduler.stop();
  activeSource = source;
  const provider = source === 'tiles' ? arrangementScore : buildScore;
  scheduler.start(provider, now + 0.1, loop ? LOOP_STEP : 1, loop);
  startRender();
  updateTransportButtons();
}

function loopClick(source) {
  if (activeSource === source && scheduler.isLooping) {
    scheduler.remaining = Math.min(scheduler.remaining + LOOP_STEP, LOOP_MAX);
    updateTransportButtons();
    return;
  }
  startTransport(source, true);
}

function stop() {
  scheduler.stop();
  activeSource = null;
  tilePlayer.setPlaying(new Set());
  refresh();
}

function updateTransportButtons() {
  const playing = scheduler.isPlaying;
  const haveTiles = arrangement.allTiles().length > 0;

  playBtn.disabled = playing;
  stopBtn.disabled = !playing;
  tilePlayBtn.disabled = playing || !haveTiles;
  tileStopBtn.disabled = !playing;
  tileLoopBtn.disabled = !haveTiles;

  const gridLooping = activeSource === 'grid' && scheduler.isLooping;
  loopBtn.textContent = loopLabel(gridLooping);
  loopBtn.classList.toggle('active', gridLooping);

  const tilesLooping = activeSource === 'tiles' && scheduler.isLooping;
  tileLoopBtn.textContent = loopLabel(tilesLooping);
  tileLoopBtn.classList.toggle('active', tilesLooping);
}

// Complete repeats still to come after the current pass; nothing on the last.
function loopLabel(looping) {
  if (!looping) return '↻';
  const complete = scheduler.remaining - 1;
  return complete > 0 ? `↻ ${complete}` : '↻';
}

loopBtn.addEventListener('click', () => loopClick('grid'));
playBtn.addEventListener('click', () => startTransport('grid', false));
stopBtn.addEventListener('click', stop);
tileLoopBtn.addEventListener('click', () => loopClick('tiles'));
tilePlayBtn.addEventListener('click', () => startTransport('tiles', false));
tileStopBtn.addEventListener('click', stop);
arrUndoBtn.addEventListener('click', arrUndo);
arrRedoBtn.addEventListener('click', arrRedo);
tileDeleteBtn.addEventListener('click', deleteSelectedTile);

tb.grabHandle.addEventListener('dragstart', (e) => {
  e.dataTransfer.setData('text/plain', 'pattern');
  e.dataTransfer.effectAllowed = 'copy';
});

tempo.value = state.bpm;
tempoLabel.textContent = `${state.bpm} BPM`;
tempo.addEventListener('input', () => {
  state.bpm = Number(tempo.value);
  tempoLabel.textContent = `${state.bpm} BPM`;
  refresh();
});

// Delete/Backspace removes the selected tile — only while the tile player is
// active, and not while typing in a field.
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && activePane === 'tiles' && arrangement.selectedId != null) {
    e.preventDefault();
    deleteSelectedTile();
  }
});

// --- initial paint ----------------------------------------------------

grid.updateCursor();
applyActiveHighlight();
if (arrangement.selectedId != null) tilePlayer.setSelected(arrangement.selectedId);
refresh();

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

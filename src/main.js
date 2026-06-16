// main.js — wire model, audio, scheduler, grid, roll, tiles, toolbar, panes.

import { AudioEngine } from './audio.js';
import { Scheduler } from './scheduler.js';
import { PianoRoll } from './pianoroll.js';
import { Note, Score } from './model.js';
import { Pattern, BASE_PITCH } from './grid.js';
import { PatternLibrary, Arrangement, LANE_COLORS } from './library.js';
import { enumerateTriadulations } from './triads.js';
import { DEGREES_PER_OCTAVE, tuningFreq } from './tuning.js';
import { notesToMidi } from './midi.js';
import { GridView } from './gridview.js';
import { TilePlayer, TILE_SCALES, DEFAULT_SCALE_IDX } from './tileplayer.js';
import { buildToolbar } from './toolbar.js';
import { buildInstrumentPane } from './instrumentpane.js';
import { normalizePatch, defaultPatch } from './instrument.js';
import { setupPanes } from './panes.js';
import { VERSION, buildEnvelope, validate, migrate, defaultName, downloadJSON, downloadBytes, readFile } from './project.js';

const LIB_KEY = 'notorolla.lib';
const ARR_KEY = 'notorolla.arr';
const UI_KEY = 'notorolla.ui';
const LAYOUT_KEY = 'notorolla.layout2';
const PROJ_KEY = 'notorolla.proj'; // { name, snapshot } — current project identity + last-saved content
const PATCH_KEY = 'notorolla.patch'; // the Vesperia patch (autosaved; not part of the project file yet)
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
  showTriads: true,   // label traditional triads found in adjacent notes
  proper: false,      // Triadulator: when on, only complete (no-leftover) triadulations
  topDegree: 71,
  visibleRows: 12,
  activePane: 'grid', // 'grid' | 'tiles' — which pane the roll mirrors
  tileScaleIdx: DEFAULT_SCALE_IDX, // tile-player horizontal scale (view-only)
};
Object.assign(state, readJSON(UI_KEY) || {});

let activePane = state.activePane;

// Triadulator proposal: prospective (un-set) notes overlaid on the grid. Empty
// when no proposal is showing. `triadList` is the rotation of alternatives.
let proposal = [];
let triadList = [];
let triadIdx = -1;
let triadSig = null; // identity of the list the current rotation belongs to

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
// The Vesperia patch — the live instrument settings the engine reads at every
// note-on. Autosaved to localStorage (not yet folded into the project file).
const patch = normalizePatch(readJSON(PATCH_KEY));
engine.patch = patch;

const scheduler = new Scheduler(engine);
scheduler.onEnded = () => {};
scheduler.onCycle = (score) => { roll.setScore(score); };

let activeSource = null; // 'grid' | 'tiles' | null — only one transport at a time

// The grid's score, with any prospective Triadulator notes merged in so they
// play and audition like real notes (but stay un-set until Confirm).
function buildScore() {
  const cur = library.current();
  if (!proposal.length) return cur.toScore(state.bpm, state.articulation);
  const cols = cur.columns.map((c) => ({ ...c }));
  for (const p of proposal) cols[p.col] = { durIndex: p.durIndex, isRest: false, degree: p.degree, accent: false };
  const tmp = new Pattern(cols, cur.name);
  tmp.tuningId = cur.tuningId; tmp.scaleId = cur.scaleId; tmp.root = cur.root; // resolve in the same tuning
  return tmp.toScore(state.bpm, state.articulation);
}

function patternLen(name) {
  const p = library.patterns.get(name);
  return p ? p.toScore(state.bpm, state.articulation).lengthBeats : 0;
}

// Overlay all lanes in parallel (each from t=0) into one score; the length is
// the longest lane. Notes carry their lane color, dimmed for non-active lanes.
function arrangementScore() {
  const notes = [];
  let maxLen = 0;
  const audible = arrangement.audibleLaneIds(); // mute/solo: which lanes sound
  arrangement.lanes.forEach((lane, li) => {
    const color = LANE_COLORS[li % LANE_COLORS.length];
    const alpha = lane.id === arrangement.activeLaneId ? 1 : 0.3; // focus dim
    const muted = !audible.has(lane.id);                          // silent → hatched, not sounded
    let t = 0;
    for (const tile of lane.tiles) {
      const p = library.patterns.get(tile.name);
      if (!p) continue;
      const s = p.toScore(state.bpm, state.articulation);
      for (const n of s.notes) {
        const nn = new Note(n.pitch, n.start + t, n.duration, n.velocity);
        nn.freq = n.freq; // carry each pattern's tuning-resolved frequency
        nn.color = color;
        nn.alpha = alpha;
        nn.muted = muted; // the scheduler skips these; the roll hatches them
        notes.push(nn);
      }
      t += s.lengthBeats; // full tile length, trailing rests included
    }
    maxLen = Math.max(maxLen, t);
  });
  return new Score(notes, state.bpm, state.articulation, maxLen);
}

// The tiles currently sounding — one per audible lane whose timeline covers
// `beat` (muted / solo-silenced lanes don't get the "playing" highlight).
function playingTileIds(beat) {
  const ids = new Set();
  const audible = arrangement.audibleLaneIds();
  for (const lane of arrangement.lanes) {
    if (!audible.has(lane.id)) continue;
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
  getShowTriads: () => state.showTriads,
  getViewport: () => ({ top: state.topDegree, rows: state.visibleRows }),
  onViewport: (top, rows) => { state.topDegree = top; state.visibleRows = rows; grid.draw(); persist(); },
  onAudition: (pitch) => audition(pitch),
  onChange: () => { setActive('grid'); clearProposal(); refresh(); },
  onSelectionChange: () => updateSelectionTools(),
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
  onMute: (laneId) => toggleLaneFlag('mute', laneId),
  onSolo: (laneId) => toggleLaneFlag('solo', laneId),
});
state.tileScaleIdx = clampScaleIdx(state.tileScaleIdx);
tilePlayer.ppb = TILE_SCALES[state.tileScaleIdx];

// Mute / Solo: an undoable arrangement edit (so it rides tile Undo/Redo and the
// dirty bit), then re-render audio source + roll hatching.
function toggleLaneFlag(kind, laneId) {
  setActive('tiles');
  arrRecord();
  if (kind === 'mute') arrangement.toggleMute(laneId);
  else arrangement.toggleSolo(laneId);
  refresh();
}

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
  clearProposal();
  grid.clearSelection();
  const lane = arrangement.laneOfTile(id);
  if (lane) arrangement.activeLaneId = lane.id;
  library.open(name);
  arrangement.selectedId = id;
  refresh();
  scrollRollToSelected();
}

// Edit-instrument pane (the Vesperia). An editor panel, not a transport pane:
// it doesn't touch activePane or the shortcut routing. Slider edits mutate the
// live patch in place (heard on the next note) and autosave.
const instrPane = buildInstrumentPane(document.getElementById('instr'), patch, {
  onChange: persistPatch,
  onTest: testInstrument,
  onReset: resetInstrument,
});

function persistPatch() { safeSet(PATCH_KEY, JSON.stringify(patch)); }

// Audition the patch on a fixed mid-register note (independent of the Audition
// toggle, which gates click-to-hear on the grid).
async function testInstrument() {
  const t = await engine.ensureRunning();
  const cur = library.current();
  engine.playNote(60, t + 0.005, 60 / state.bpm, 0.85, tuningFreq(60, cur.tuningId, cur.root));
}

function resetInstrument() {
  Object.assign(patch, defaultPatch());
  instrPane.refresh();
  persistPatch();
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
  else grid.clearSelection(); // leaving the grid drops its note selection
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
  arrangement.lanes = o.lanes.map((l) => ({
    id: l.id, tiles: l.tiles.map((t) => ({ id: t.id, name: t.name })), mute: !!l.mute, solo: !!l.solo,
  }));
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
  clearProposal();
  grid.clearSelection();
  if (library.parkedName) library.restore();
  else library.newPattern();
  arrangement.selectedId = null;
  refresh();
}
function clonePattern() {
  clearProposal();
  grid.clearSelection();
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
  clearProposal();
  grid.clearSelection();
  library.clearCurrent();
  pushHistory(before);
  arrangement.selectedId = null;
  refresh();
}

// --- Triadulator ------------------------------------------------------
//
// Propose traditional triads built from the pitch classes NOT yet used on the
// grid, place them as prospective (un-set) notes after the last placed note,
// rotate through alternatives, and Confirm to register them as real notes.

// What's currently triadulatable: the enabled state and the list of placeable
// triadulations (proper or partial, per the Proper toggle). The analysis is over
// the 12 chromatic pitch classes regardless of grid height ("still 12 pitches").
function triadulationState() {
  const cols = library.current().columns;
  const used = new Set();
  for (const c of cols) {
    if (!c.isRest) used.add(((c.degree % DEGREES_PER_OCTAVE) + DEGREES_PER_OCTAVE) % DEGREES_PER_OCTAVE);
  }
  if (used.size < 3) return { enabled: false, list: [] };

  const remaining = [];
  for (let pc = 0; pc < DEGREES_PER_OCTAVE; pc++) if (!used.has(pc)) remaining.push(pc);
  const list = enumerateTriadulations(remaining, { proper: state.proper });
  if (!list.length) return { enabled: false, list: [] };

  // Placeability: notes go in the columns strictly after the last placed note.
  const nSlots = cols.length - (lastNoteColumn(cols) + 1);
  const usable = state.proper
    ? (remaining.length <= nSlots ? list : []) // proper must place all remaining
    : (nSlots >= 3 ? list : []);               // partial needs room for >=1 triad
  return { enabled: usable.length > 0, list: usable };
}

function lastNoteColumn(cols) {
  let last = -1;
  cols.forEach((c, i) => { if (!c.isRest) last = i; });
  return last;
}

// Degree ≡ pc (mod 12) closest to `centroid`: centers the proposal in the
// register of the placed notes, and (on a multi-octave grid) picks the inversion.
function nearestDegreeForPC(pc, centroid) {
  const base = Math.round(centroid);
  const off = ((((base - pc) % DEGREES_PER_OCTAVE) + DEGREES_PER_OCTAVE) % DEGREES_PER_OCTAVE);
  const d = base - off; // largest degree <= base with this pitch class
  return Math.abs(d - centroid) <= Math.abs(d + DEGREES_PER_OCTAVE - centroid) ? d : d + DEGREES_PER_OCTAVE;
}

// Turn a chosen triadulation into prospective columns. Horizontal: after the
// last note (ignoring interior rests). Vertical: centered on the placed register.
function proposalColumns(tri) {
  const cols = library.current().columns;
  const startCol = lastNoteColumn(cols) + 1;
  const nSlots = cols.length - startCol;

  let pcs = tri.triads.flatMap((t) => t.pcs).concat(tri.leftover || []);
  if (pcs.length > nSlots) {
    // Overflow (partial only — proper is guarded upstream): keep whole triads.
    const nTriads = Math.min(tri.triads.length, Math.floor(nSlots / 3));
    pcs = tri.triads.slice(0, nTriads).flatMap((t) => t.pcs);
  }

  const placed = cols.filter((c) => !c.isRest).map((c) => c.degree);
  const centroid = placed.length ? placed.reduce((a, b) => a + b, 0) / placed.length : BASE_PITCH;
  const durIndex = state.brush.durIndex;
  return pcs.map((pc, k) => ({ col: startCol + k, degree: nearestDegreeForPC(pc, centroid), durIndex }));
}

// Identity of a triadulation list, so repeated presses on an unchanged grid
// rotate through it while any change restarts at the canonical first.
function listSig(list) {
  return list.map((t) => `${t.triads.map((x) => x.pcs.join('.')).join(',')}/${(t.leftover || []).join('.')}`).join('|');
}

function triadulate() {
  setActive('grid');
  const st = triadulationState();
  if (!st.enabled) { updateTriadulateButtons(); return; }
  const sig = listSig(st.list);
  if (sig === triadSig && proposal.length) {
    triadIdx = (triadIdx + 1) % st.list.length; // rotate; wraps to the beginning
  } else {
    triadIdx = 0;
    triadSig = sig;
  }
  triadList = st.list;
  proposal = proposalColumns(st.list[triadIdx]);
  grid.setProspective(proposal);
  refresh();
}

// Register the prospective notes as if hand-placed (one undo entry, marks dirty).
function confirmTriadulation() {
  if (!proposal.length) return;
  const before = curSnap();
  const cols = library.current().columns;
  for (const p of proposal) cols[p.col] = { durIndex: p.durIndex, isRest: false, degree: p.degree, accent: false };
  pushHistory(before);
  clearProposal();
  arrangement.selectedId = null;
  refresh();
}

function clearProposal() {
  proposal = [];
  triadList = [];
  triadIdx = -1;
  triadSig = null;
  grid.setProspective([]);
}

function updateTriadulateButtons() {
  const st = triadulationState();
  // Stay enabled while a proposal shows so you can keep rotating.
  tb.triadBtn.disabled = !(st.enabled || proposal.length);
  tb.confirmBtn.disabled = proposal.length === 0;
  tb.triadBtn.textContent = (proposal.length && triadList.length)
    ? `Triadulate ${triadIdx + 1}/${triadList.length}`
    : 'Triadulate';
}

// --- audition ---------------------------------------------------------

async function audition(pitch) {
  if (!state.audition) return;
  const t = await engine.ensureRunning();
  const cur = library.current();
  engine.playNote(pitch, t + 0.005, 60 / state.bpm, 0.85, tuningFreq(pitch, cur.tuningId, cur.root));
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
    case 'triadulate': triadulate(); return;
    case 'confirmTriad': confirmTriadulation(); return;
    case 'proper': clearProposal(); refresh(); return; // re-triadulate in the new mode
    case 'rotate': grid.rotateSelection(); return;
    case 'reverse': grid.reverseSelection(); return;
    case 'sortAsc': grid.sortSelection(true); return;
    case 'sortDesc': grid.sortSelection(false); return;
    case 'shuffle': grid.shuffleSelection(); return;
    case 'shuffleNoRep': grid.shuffleNoRepeatSelection(); return;
    case 'transposeUp': grid.transpose(1); return;
    case 'transposeDown': grid.transpose(-1); return;
    case 'duration': // brush duration set in toolbar; apply to a selection if there is one
      grid.updateCursor();
      if (!grid.applyDuration(state.brush.durIndex)) refresh();
      return;
    case 'tuning': library.current().tuningId = tb.tuningSel.value; refresh(); return;
    case 'scale': library.current().scaleId = tb.scaleSel.value; refresh(); return;
    case 'scaleRoot': library.current().root = Number(tb.rootSel.value); refresh(); return;
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
  updateTriadulateButtons();
  updateSelectionTools();
  updateScaleControls();
  updateTransportButtons();
  persist();
}

// Reflect the current pattern's pitch context in the toolbar selectors.
function updateScaleControls() {
  const cur = library.current();
  tb.tuningSel.value = cur.tuningId;
  tb.scaleSel.value = cur.scaleId;
  tb.rootSel.value = String(cur.root);
}

// Permute buttons act on the selection, or all notes when nothing is selected —
// so they're enabled whenever there are ≥2 notes to rearrange.
function updateSelectionTools() {
  const few = grid.permuteCount() < 2;
  tb.rotateBtn.disabled = few;
  tb.reverseBtn.disabled = few;
  tb.sortAscBtn.disabled = few;
  tb.sortDescBtn.disabled = few;
  tb.shuffleBtn.disabled = few;
  tb.shuffleNoRepBtn.disabled = few;
  const noNotes = grid.permuteCount() < 1; // transpose works on a single note too
  tb.transUpBtn.disabled = noNotes;
  tb.transDownBtn.disabled = noNotes;
}

function updateEditButtons() {
  if (library.parkedName) {
    tb.newBtn.textContent = `↺ ${library.parkedName}`;
    tb.newBtn.disabled = false;
  } else {
    tb.newBtn.textContent = 'New';
    tb.newBtn.disabled = !library.canCreate();
  }
  tb.cloneBtn.disabled = !library.canClone(); // independent of the parked slot
  const h = hist(library.currentName);
  tb.undoBtn.disabled = h.past.length === 0;
  tb.redoBtn.disabled = h.future.length === 0;
  arrUndoBtn.disabled = arrPast.length === 0;
  arrRedoBtn.disabled = arrFuture.length === 0;
  tileDeleteBtn.disabled = arrangement.selectedId == null;
}

// localStorage is the working-session autosave. If a write ever fails (private
// mode, quota, storage disabled), state is no longer safely on disk — that's the
// only case where a reload would actually lose work, so `storageOK` gates the
// unload warning. A reload otherwise restores everything, so we don't nag.
let storageOK = true;
function safeSet(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch (e) {
    if (storageOK) console.warn('Notorolla: localStorage write failed — unsaved work may be lost on reload', e);
    storageOK = false;
  }
}

function persist() {
  safeSet(LIB_KEY, JSON.stringify(library.toJSON()));
  safeSet(ARR_KEY, JSON.stringify(arrangement.toJSON()));
  safeSet(UI_KEY, JSON.stringify({
    bpm: state.bpm, brush: state.brush, mode: state.mode, audition: state.audition,
    cursor: state.cursor, highlightRows: state.highlightRows, showTriads: state.showTriads, proper: state.proper,
    topDegree: state.topDegree, visibleRows: state.visibleRows, activePane: state.activePane,
    tileScaleIdx: state.tileScaleIdx,
  }));
  recomputeDirty();
}

// --- project: save / load / new ---------------------------------------
//
// Two layers: localStorage (continuous autosave of the working session, above)
// and the project FILE (an explicit document the user saves/opens). The dirty
// bit tracks divergence from the last SAVE or LOAD — not from localStorage —
// by comparing a snapshot of the musical content (lib + arr + tempo) only, so
// view/layout tweaks never flip it.

let projectName = null;   // current document name (no extension), or null = untitled
let savedSnapshot = null; // contentSnapshot() at the last save/load
let dirty = false;

const savedProj = readJSON(PROJ_KEY);
if (savedProj) { projectName = savedProj.name || null; savedSnapshot = savedProj.snapshot || null; }

const projNewBtn = document.getElementById('projNew');
const projOpenBtn = document.getElementById('projOpen');
const projSaveBtn = document.getElementById('projSave');
const projFileInput = document.getElementById('projFile');
const projNameEl = document.getElementById('projName');
const projDotEl = document.getElementById('projDot');

// The musical content only — the thing the dirty bit and the file track.
function contentSnapshot() {
  return JSON.stringify({ lib: library.toJSON(), arr: arrangement.toJSON(), tempo: state.bpm });
}

function persistProjMeta() {
  safeSet(PROJ_KEY, JSON.stringify({ name: projectName, snapshot: savedSnapshot }));
}

function updateProjectBar() {
  projNameEl.textContent = projectName || 'untitled';
  projDotEl.style.visibility = dirty ? 'visible' : 'hidden';
}

// Mark the current content as the saved baseline (after Save/Load/New).
function markClean() {
  savedSnapshot = contentSnapshot();
  dirty = false;
  persistProjMeta();
  updateProjectBar();
}

function recomputeDirty() {
  dirty = contentSnapshot() !== savedSnapshot;
  persistProjMeta();
  updateProjectBar();
}

// Replace the live library/arrangement contents IN PLACE (they're referenced by
// grid, tile player and the isReferenced closure, so we mutate rather than
// reassign). Tempo is restored too; histories are cleared.
function loadContent(env) {
  const freshLib = PatternLibrary.fromJSON(env.lib, isReferenced);
  library.patterns = freshLib.patterns;
  library.counter = freshLib.counter;
  library.currentName = freshLib.currentName;
  library.parkedName = freshLib.parkedName;
  if (!library.current()) {
    if (library.patterns.size) library.currentName = [...library.patterns.keys()][0];
    else library.seed();
  }

  const freshArr = Arrangement.fromJSON(env.arr);
  arrangement.lanes = freshArr.lanes;
  arrangement.seq = freshArr.seq;
  arrangement.activeLaneId = freshArr.activeLaneId;
  arrangement.selectedId = null;

  if (env.tempo) {
    state.bpm = env.tempo;
    tempo.value = state.bpm;
    tempoLabel.textContent = `${state.bpm} BPM`;
  }

  histories.clear();
  arrPast.length = 0;
  arrFuture.length = 0;
  clearProposal();
  grid.clearSelection();
  activePane = 'grid';
  state.activePane = 'grid';
  applyActiveHighlight();
  refresh();
}

function saveProject() {
  const input = prompt('Save project as:', projectName || defaultName());
  if (input == null) return;
  const stem = input.trim().replace(/\.json$/i, '');
  if (!stem) return;
  const env = buildEnvelope({ name: stem, lib: library.toJSON(), arr: arrangement.toJSON(), tempo: state.bpm });
  downloadJSON(`${stem}.json`, env);
  projectName = stem;
  markClean();
}

async function openProject(file) {
  let env;
  try {
    env = migrate(validate(JSON.parse(await readFile(file))));
  } catch (err) {
    alert(`Could not open file: ${err.message}`);
    return;
  }
  if (env.version > VERSION &&
      !confirm(`This file was saved by a newer Notorolla (v${env.version}). Some data may be ignored. Open anyway?`)) {
    return;
  }
  if (dirty && !confirm('You have unsaved changes. Open this project and discard them?')) return;
  stop();
  loadContent(env);
  projectName = env.name || file.name.replace(/\.json$/i, '');
  markClean();
}

function newProject() {
  if (dirty && !confirm('You have unsaved changes. Start a new project and discard them?')) return;
  stop();
  loadContent({ lib: { patterns: [], counter: 0, currentName: null, parkedName: null }, arr: {}, tempo: 120 });
  projectName = null;
  markClean();
}

// Export the tile-player arrangement as a Format-1 MIDI file: one named track
// per non-empty lane, current tempo, one pass (no loop repeats). Note lengths
// are articulated (×articulation) per the export choice; pitch is already MIDI.
function exportMidi() {
  if (arrangement.allTiles().length === 0) return;
  const tracks = arrangement.lanes
    .map((lane, i) => {
      const notes = [];
      let t = 0;
      for (const tile of lane.tiles) {
        const p = library.patterns.get(tile.name);
        if (!p) continue;
        const s = p.toScore(state.bpm, state.articulation);
        for (const n of s.notes) {
          notes.push({
            pitch: n.pitch,
            startBeat: n.start + t,
            durBeats: n.duration * state.articulation,
            velocity: n.velocity,
          });
        }
        t += s.lengthBeats;
      }
      return { name: `Lane ${i + 1}`, notes };
    })
    .filter((tr) => tr.notes.length > 0);
  if (!tracks.length) return;
  const bytes = notesToMidi(tracks, state.bpm, { tpqn: 480 });
  downloadBytes(`${projectName || defaultName()}.mid`, bytes, 'audio/midi');
}

projNewBtn.addEventListener('click', newProject);
projSaveBtn.addEventListener('click', saveProject);
projOpenBtn.addEventListener('click', () => projFileInput.click());
projFileInput.addEventListener('change', () => {
  const file = projFileInput.files[0];
  projFileInput.value = ''; // allow re-opening the same file later
  if (file) openProject(file);
});

// Warn before leaving ONLY if a reload would actually lose work — i.e. when
// localStorage persistence has failed. A normal reload restores the autosaved
// session, so we don't nag about merely-unsaved-to-file changes.
window.addEventListener('beforeunload', (e) => {
  if (!storageOK) { e.preventDefault(); e.returnValue = ''; }
});

// No prior project metadata (first run, or pre-feature autosave): treat the
// restored session as the clean baseline rather than spuriously "dirty".
if (savedSnapshot == null) savedSnapshot = contentSnapshot();
updateProjectBar();

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
const midiExportBtn = document.getElementById('midiExport');
const gridName = document.getElementById('gridName');

midiExportBtn.addEventListener('click', exportMidi);

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
  midiExportBtn.disabled = !haveTiles;

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

// --- tile-player horizontal scale (quantized notches) -----------------

const tileScaleEl = document.getElementById('tileScale');
const tileZoomOutBtn = document.getElementById('tileZoomOut');
const tileZoomInBtn = document.getElementById('tileZoomIn');
const tileLaneEl = document.getElementById('tileLane');
tileScaleEl.max = String(TILE_SCALES.length - 1);

function clampScaleIdx(i) { return Math.max(0, Math.min(TILE_SCALES.length - 1, i | 0)); }

// Change the tile-player scale to a notch, keeping the left-edge beat roughly in
// place (scroll scales with the zoom). View-only: persists to UI, not the file.
function setTileScale(idx) {
  const next = clampScaleIdx(idx);
  const prevPpb = tilePlayer.ppb;
  state.tileScaleIdx = next;
  tilePlayer.ppb = TILE_SCALES[next];
  tilePlayer.render();
  if (prevPpb) tileLaneEl.scrollLeft = Math.round(tileLaneEl.scrollLeft * (tilePlayer.ppb / prevPpb));
  updateScaleStrip();
  persist();
}

function updateScaleStrip() {
  tileScaleEl.value = String(state.tileScaleIdx);
  tileZoomOutBtn.disabled = state.tileScaleIdx <= 0;
  tileZoomInBtn.disabled = state.tileScaleIdx >= TILE_SCALES.length - 1;
}

tileScaleEl.addEventListener('input', () => setTileScale(Number(tileScaleEl.value)));
tileZoomOutBtn.addEventListener('click', () => setTileScale(state.tileScaleIdx - 1));
tileZoomInBtn.addEventListener('click', () => setTileScale(state.tileScaleIdx + 1));

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

// Deselect (Select None) for the active pane.
function selectNone() {
  if (activePane === 'tiles') deselectTile();
  else grid.clearSelection();
}
function deselectTile() {
  if (arrangement.selectedId == null) return;
  arrangement.selectedId = null;
  tilePlayer.setSelected(null);
  tileDeleteBtn.disabled = true;
  updateRollContent();
  scrollRollToSelected();
  persist();
}

// Briefly pulse a UI element — visual confirmation that a keyboard shortcut
// fired. Re-triggerable (reflow restarts the animation). No-op when a shortcut
// has no corresponding on-screen control (e.g. Select All/None, grid Delete).
function flash(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth; // force reflow so a repeated press re-runs the animation
  el.classList.add('flash');
}

// Keyboard shortcuts — act on the active pane (grid or tiles), and flash the
// button each maps to. Skipped while a form field is focused so typing/sliders
// aren't hijacked.
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const tiles = activePane === 'tiles';
  const typing = tag === 'textarea' || (tag === 'input' && e.target.type !== 'range' && e.target.type !== 'file');

  // Space / Shift+Space = transport for the active pane, and ONLY transport — it
  // never lets a focused button or select swallow the key. Plain space toggles
  // play/stop; Shift+space starts the loop and each press adds passes; plain space
  // stops it.
  if (e.key === ' ' && !mod && !typing) {
    e.preventDefault();
    const src = tiles ? 'tiles' : 'grid';
    if (e.shiftKey) {
      loopClick(src);
      flash(src === 'tiles' ? tileLoopBtn : loopBtn);
    } else if (scheduler.isPlaying) {
      const playing = activeSource;
      stop();
      flash(playing === 'tiles' ? tileStopBtn : stopBtn);
    } else {
      startTransport(src, false);
      flash(src === 'tiles' ? tilePlayBtn : playBtn);
    }
    return;
  }

  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const k = e.key.toLowerCase();

  if (e.key === 'Escape') { selectNone(); return; }

  if (mod && k === 'z') { // undo / shift = redo
    e.preventDefault();
    if (e.shiftKey) { (tiles ? arrRedo : redo)(); flash(tiles ? arrRedoBtn : tb.redoBtn); }
    else { (tiles ? arrUndo : undo)(); flash(tiles ? arrUndoBtn : tb.undoBtn); }
    return;
  }
  if (mod && k === 'a') { e.preventDefault(); if (!tiles) grid.selectAll(); return; } // no Select-All button
  if (mod && k === 'd') { e.preventDefault(); selectNone(); return; }                 // no Select-None button
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (tiles) {
      if (arrangement.selectedId != null) { e.preventDefault(); deleteSelectedTile(); flash(tileDeleteBtn); }
    } else {
      e.preventDefault();
      grid.deleteSelection(); // selected notes -> rests (no toolbar button)
    }
    return;
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !tiles) {
    e.preventDefault(); // transpose a pitch class; Shift = an octave (the equave)
    const up = e.key === 'ArrowUp';
    grid.transpose((up ? 1 : -1) * (e.shiftKey ? DEGREES_PER_OCTAVE : 1));
    flash(up ? tb.transUpBtn : tb.transDownBtn);
  }
});

// --- initial paint ----------------------------------------------------

grid.updateCursor();
applyActiveHighlight();
updateScaleStrip();
if (arrangement.selectedId != null) tilePlayer.setSelected(arrangement.selectedId);
refresh();

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

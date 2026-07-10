// main.js — wire model, audio, scheduler, grid, roll, tiles, toolbar, panes.

import { AudioEngine, FREF } from './audio/audio.js';
import { Scheduler } from './audio/scheduler.js';
import { PianoRoll, ROLL_V_SCALES, ROLL_H_SCALES } from './ui/pianoroll.js';
import { Pattern } from './core/grid.js';
import { PatternLibrary, Arrangement } from './core/library.js';
import { familiesFor, familyLabel } from './core/triads.js';
import { edoOf, hasEquave, tuningFreq, pitchClassName, degreeBounds, nearestDegreeToFreq } from './core/tuning.js';
import { scalesFor, scaleValidForEdo } from './core/scales.js';
import { GridView } from './ui/gridview.js';
import { bakeReference, referenceDisplay } from './core/reference.js';
import { TilePlayer, TILE_SCALES } from './ui/tileplayer.js';
import { buildToolbar } from './ui/toolbar.js';
import { normalizePatch, instrument } from './audio/instrument.js';
import { PatchStore, factoryInitId } from './audio/patches.js';
import { modsActive } from './audio/mods.js';
import { setupPanes } from './ui/panes.js';
import {
  LIB_KEY, ARR_KEY, LAYOUT_KEY, PATCH_KEY, GRIDPATCH_KEY, PATCHES_KEY, GRIDMETA_KEY,
  readJSON, initStorage,
} from './app/storage.js';
import { initMeter } from './app/meter.js';
import { initHistory } from './app/history.js';
import { initZoom } from './app/zoom.js';
import { initScore } from './app/score.js';
import { initTransport } from './app/transport.js';
import { initLanefx } from './app/lanefx.js';
import { initTriadulator } from './app/triadulator.js';
import { initRandomui } from './app/randomui.js';
import { initProjectio } from './app/projectio.js';
import { initExportui } from './app/exportui.js';
import { initKeyboard } from './app/keyboard.js';
import { initTileops } from './app/tileops.js';
import { initTileinspector } from './app/tileinspector.js';
import { initTransformbar } from './app/transformbar.js';
import { initPatchedit } from './app/patchedit.js';

// The shared-context object: extracted controllers register their API on it and
// read each other's (and main.js's) shared state/functions through it. Storage
// goes up first — main.js consumes state / persist immediately below.
const ctx = {};
initStorage(ctx);

// The persisted-UI state object (definition + hydration/migration in
// app/storage.js). Stable object — destructured once so `state.foo` reads/writes
// throughout main.js are unchanged.
const state = ctx.state;

ctx.activePane = state.activePane;

// Triadulator proposal: prospective (un-set) notes overlaid on the grid. Empty
// when no proposal is showing. `triadList` is the rotation of alternatives.
ctx.proposal = [];

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
engine.masterLevel = state.masterGain; // ensureRunning will apply it to the master node
engine.lite = state.lite;              // Lite Instruments (live only); read at every note-on

// Instrument patches now live per lane (lane.patch, saved with the project). The
// grid's click-to-hear / Test uses a separate neutral patch — a workspace
// preference kept out of the project (its own key, defaults to factory).
const gridPatch = normalizePatch(readJSON(GRIDPATCH_KEY));

// Register the stable objects the score layer reads through ctx before initScore
// runs below (activeScore() is called eagerly at roll construction).
Object.assign(ctx, { engine, library, arrangement, gridPatch });

// The user-global patch catalog (Phase B of §14): factory Init per kind + saved
// user patches. Cross-project (its own key), never part of a project file.
const patches = new PatchStore();
patches.loadUser(readJSON(PATCHES_KEY));

// The grid patch's identity (which catalog patch it derives from + dirty), a
// workspace preference like gridPatch itself. Defaults to its kind's Init.
ctx.gridPatchMeta = readJSON(GRIDMETA_KEY);
if (!ctx.gridPatchMeta || ctx.gridPatchMeta.patchOriginId == null) {
  ctx.gridPatchMeta = { patchOriginId: factoryInitId(gridPatch.kind), patchName: 'Init', patchDirty: false, patchImported: false };
}

// One-time migration: lanes saved before per-lane instruments had no patch, so
// seed those from the old single global patch — the project reloads sounding
// identical, with the tweaks spread across its lanes. Idempotent: once a lane
// owns a patch it's saved, so a saved lane (raw.patch present) is never reseeded.
(() => {
  const legacy = readJSON(PATCH_KEY);
  if (!legacy) return;
  const raws = savedArr && savedArr.lanes ? savedArr.lanes : null;
  arrangement.lanes.forEach((lane, i) => {
    const savedHadPatch = raws && raws[i] && raws[i].patch != null;
    if (!savedHadPatch) lane.patch = normalizePatch(legacy);
  });
})();

// The grid's active instrument. Normally the grid's own neutral gridPatch, but
// while a tile is loaded the grid BORROWS that tile's lane instrument (so the
// pattern plays through the sound it belongs to). A descriptor, not a patch, so
// borrowing stays a live reference to the lane; persisted so a reload keeps it.
ctx.gridInstr = state.gridInstr && state.gridInstr.source === 'lane' && arrangement.lane(state.gridInstr.laneId)
  ? { source: 'lane', laneId: state.gridInstr.laneId }
  : { source: 'grid' };
// The instrument the parked pattern was using, restored when it's restored
// (best-effort — a lane that's since gone falls back to the grid's own).
ctx.parkedInstr = state.parkedInstr || null;

// The patch the grid plays/edits with: the borrowed lane's patch when a tile is
// loaded (falling back if that lane is gone), else the grid's own gridPatch.
function resolveGridInstrPatch() {
  if (ctx.gridInstr.source === 'lane') {
    const lane = arrangement.lane(ctx.gridInstr.laneId);
    if (lane) return lane.patch;
  }
  return gridPatch;
}


// The keyboard-tracking pivot row to mark on the grid — the degree nearest the
// fixed reference frequency (middle C) in the pattern's tuning — but only for
// Boshwick, whose Pitch Track pivots there. null = no band (other instruments).
function referenceDegreeFor(pattern) {
  return resolveGridInstrPatch().kind === 'boshwick'
    ? nearestDegreeToFreq(FREF, pattern.tuningId, pattern.root || 0)
    : null;
}

// Recompute + redraw the grid's pivot band (for changes that don't run a full
// refresh — e.g. switching the edited instrument's kind).
function syncGridReference() {
  grid.referenceDegree = referenceDegreeFor(library.current());
  grid.draw();
}

// Resolve the patch for a voice: a lane's own patch, or the grid's ACTIVE
// instrument for un-laned sound (grid playback/audition) — the grid's own patch,
// or a borrowed tile instrument. Read fresh per note, so edits are heard next note.
engine.patch = gridPatch; // fallback default
engine.patchFor = (laneId) => {
  if (laneId == null) return resolveGridInstrPatch();
  const lane = arrangement.lane(laneId);
  return lane ? lane.patch : gridPatch;
};

// Resolve a lane's mixer settings (linear volume + pan) for the engine — read
// when a lane strip is created (live) and per lane in the offline export.
engine.laneMix = (laneId) => {
  const lane = arrangement.lane(laneId);
  return lane ? { gain: lane.gain, pan: lane.pan } : { gain: 1, pan: 0 };
};


// Resolve a lane's delay insert config for the engine — time follows the tempo
// (beats × 60/bpm → seconds). { on:false } when the lane has no/disabled delay.
engine.laneDelay = (laneId) => {
  const lane = arrangement.lane(laneId);
  if (!lane || !lane.delay || !lane.delay.on) return { on: false };
  const d = lane.delay;
  return { on: true, mode: d.mode, timeSec: d.time * 60 / state.bpm, wet: d.wet, feedback: d.feedback };
};


// Resolve a lane's chorus insert config for the engine. { on:false } when the lane
// has no/disabled chorus; rate/depth are fixed presets, so only the mode crosses.
engine.laneChorus = (laneId) => {
  const lane = arrangement.lane(laneId);
  if (!lane || !lane.chorus || !lane.chorus.on) return { on: false };
  return { on: true, mode: lane.chorus.mode };
};

// Resolve a lane's playback modulators: the mod pair stored for its CURRENT
// instrument kind (each kind keeps its own pair — switch back and it's intact).
// null when nothing's active, so the engine skips the per-note work entirely.
// The GLOBAL "Loop Mod" toggle overrides every mod's time anchor (for now —
// the per-mod flag stays in the data model for a possible per-mod return).
engine.modsFor = (laneId) => {
  const lane = arrangement.lane(laneId);
  if (!lane || !lane.modsByKind) return null;
  const kind = lane.patch && lane.patch.kind;
  if (!modsActive(lane.modsByKind, kind)) return null;
  return lane.modsByKind[kind].map((m) => ({ ...m, loop: state.modLoop }));
};


// Resolve a lane's insert-reverb config for the engine ({ on:false } = none).
engine.laneReverb = (laneId) => {
  const lane = arrangement.lane(laneId);
  if (!lane || !lane.reverb || !lane.reverb.on) return { on: false };
  return lane.reverb;
};


// The scheduler is constructed here (like the view instances) and registered on
// ctx; app/transport.js drives it (onEnded/onCycle wiring, start/stop). It stays
// ahead of initScore / initZoom, which read ctx.scheduler.
const scheduler = new Scheduler(engine);
ctx.scheduler = scheduler;

initScore(ctx); // score-building layer (activeScore is used just below)

const roll = new PianoRoll(document.getElementById('roll'), ctx.activeScore(), document.getElementById('rollGutter'));
// Restore the persisted roll zoom (view-only; clamped to the notch ladders).
state.rollVIdx = Math.max(0, Math.min(ROLL_V_SCALES.length - 1, state.rollVIdx | 0));
state.rollHIdx = Math.max(0, Math.min(ROLL_H_SCALES.length - 1, state.rollHIdx | 0));
roll.setZoom(ROLL_V_SCALES[state.rollVIdx], ROLL_H_SCALES[state.rollHIdx]);

const grid = new GridView(document.getElementById('grid'), library.current(), {
  getMode: () => state.mode,
  getBrush: () => state.brush,
  getCursorStyle: () => state.cursor,
  getHighlightRows: () => state.highlightRows,
  getShowTriads: () => state.showTriads,
  getViewport: () => ({ top: state.topDegree, rows: state.visibleRows }),
  getReference: () => ctx.refDisplay,
  onViewport: (top, rows) => { state.topDegree = top; state.visibleRows = rows; grid.draw(); ctx.persist(); },
  onAudition: (pitch) => audition(pitch),
  onChange: () => { setActive('grid'); ctx.clearProposal(); refresh(); },
  onSelectionChange: () => updateSelectionTools(),
  onHistory: (before) => ctx.pushHistory(before),
  handle: document.getElementById('gridResize'),
  guide: document.getElementById('resizeGuide'),
  scrollWrap: document.getElementById('gridScroll'),
});

const tb = buildToolbar(document.getElementById('toolbar'), state, onToolbarChange);

// --- reference backdrop (grid editor) ---------------------------------
// A frozen, self-contained snapshot of a tile overlaid behind the edited pattern
// (see-together / hear-together; the New-Counterpoint on-ramp — §16). Bpm-agnostic
// display info (dot positions + shared onset beats) is derived once per set/toggle.
ctx.refDisplay = null; // { notes, onsets, len } | null — pulled by the grid view

// Recompute the derived display + reflect the reference into the toolbar chrome.
// The chip/controls update is GUARDED so a display hiccup can never leave the UI
// stuck on "(none)" while a reference is actually set.
function syncReference() {
  try {
    ctx.refDisplay = state.reference ? referenceDisplay(state.reference) : null;
  } catch (e) {
    console.error('reference display failed — ghost hidden, reference still set:', e);
    ctx.refDisplay = null;
  }
  tb.setReference(state.reference
    ? { name: state.reference.name, quieter: state.reference.quieter, muted: state.reference.muted }
    : null);
}

// Set-Reference is enabled only when EXACTLY one tile is selected.
function updateReferenceEnable() { tb.setRefEnabled(arrangement.selectedIds.size === 1); }

// Freeze the single selected tile (pattern + its lane's patch + the tile's
// transforms) as the reference, and switch to the merged-time (Stretch) layout.
function setReferenceFromSelection(tiles) {
  if (!tiles || tiles.length !== 1) return;
  const tile = tiles[0];
  const pat = library.patterns.get(tile.name);
  if (!pat) return;
  const lane = arrangement.laneOfTile(tile.id);
  const patch = lane ? lane.patch : null; // future: a lane-less catalog pattern falls back to the grid patch
  if (!state.reference) state.refPrevMode = state.mode; // remember the layout to restore on Clear
  try {
    state.reference = bakeReference(pat, patch, tile.transforms || null, { name: pat.label || pat.name });
  } catch (e) { console.error('bakeReference threw:', e); return; }
  state.mode = 'stretch';
  syncReference();
  refresh();
}
function clearReference() {
  if (!state.reference) return;
  state.reference = null;
  state.mode = state.refPrevMode || 'grid';
  state.refPrevMode = null;
  syncReference();
  refresh();
}
// One 3-way level control: full → soft (quieter) → mute → full.
function cycleRefLevel() {
  const r = state.reference;
  if (!r) return;
  if (r.muted) { r.muted = false; r.quieter = false; }      // mute → full
  else if (r.quieter) { r.muted = true; }                   // soft → mute
  else { r.quieter = true; }                                // full → soft
  syncReference();
  refresh();
}
syncReference(); // reflect a reference restored from the workspace on load

let marqueeBefore = null; // selection snapshot for Esc-cancelling a marquee

const tilePlayer = new TilePlayer(document.getElementById('tileLane'), library, arrangement, {
  onTileDown: (id, ev) => ctx.onTileDown(id, ev),
  onGridDragOver: (laneId, start) => ctx.gridDragOver(laneId, start),
  onDropAt: (laneId, start) => ctx.dropCurrentTile(laneId, start),
  // Empty-space rubber-band selection (one lane). Live: each band change
  // re-derives the intersecting set; no re-render, just class syncs.
  onMarqueeStart: () => {
    marqueeBefore = { ids: new Set(arrangement.selectedIds), anchor: arrangement.selectedId };
  },
  onMarquee: (laneId, b0, b1) => {
    arrangement.selectMarquee(laneId, b0, b1, ctx.patternLen);
    arrangement.activeLaneId = laneId;
    tilePlayer.syncSelection();
    tilePlayer.setActiveLane(laneId);
    ctx.updateTileSelectionUI();
  },
  onMarqueeEnd: (laneId, dragged) => {
    marqueeBefore = null;
    setActive('tiles');
    if (!dragged) { // a plain empty-space click: activate the lane, clear the selection
      arrangement.activeLaneId = laneId;
      arrangement.clearSelection();
      tilePlayer.syncSelection();
      tilePlayer.setActiveLane(laneId);
      ctx.updateTileSelectionUI();
    }
    updateRollContent(); scrollRollToSelected();
    ctx.persist();
  },
  onMarqueeCancel: () => { // Esc mid-band: back to the pre-gesture selection
    if (marqueeBefore) {
      arrangement.selectedIds = new Set(marqueeBefore.ids);
      arrangement.selectedId = marqueeBefore.anchor;
      arrangement.pruneSelection();
      marqueeBefore = null;
    }
    tilePlayer.syncSelection();
    ctx.updateTileSelectionUI();
  },
  // Repeat fill handle: plan k block-repeats (per-tile ignore-collisions) —
  // preview shows only what will land; commit stamps them (one undo entry)
  // and the selection grows to original + stamps (user's choice).
  onRepeatPreview: (laneId, k) => {
    const stamps = arrangement.planRepeat(k, ctx.patternLen).filter((p) => !p.blocked);
    tilePlayer.showStamps(laneId, stamps);
    return stamps.length; // M — how many copies actually land (for the count chip)
  },
  onRepeatCommit: (laneId, k) => {
    tilePlayer.clearStamps();
    if (k === 0) return;
    const before = ctx.arrSnap();
    arrangement.repeatSelection(k, ctx.patternLen);
    ctx.arrCommit(before); // no entry if every stamp was blocked
    tilePlayer.syncSelection();
    ctx.updateTileSelectionUI();
    refresh();
  },
  onRepeatCancel: () => tilePlayer.clearStamps(),
  onMute: (laneId) => ctx.toggleLaneFlag('mute', laneId),
  onSolo: (laneId) => ctx.toggleLaneFlag('solo', laneId),
  onAddLane: () => ctx.addLane(),
  onResetLane: (laneId) => ctx.resetLane(laneId),
  onEdit: (laneId) => ctx.editLane(laneId, true), // double-click the lane head → scroll the pane into view
  // The lane's patch display { name, dirty, imported } for the lane head.
  patchDisplay: (lane) => ctx.patchInfo(lane),
  onMixStart: () => ctx.onMixStart(),
  onMixChange: (laneId, key, value) => ctx.onMixChange(laneId, key, value),
  onMixEnd: () => ctx.onMixEnd(),
  onMarkerStart: () => ctx.onMixStart(),                // reuse the arrangement-edit bracket
  onMarkers: (start, end) => ctx.setPlayMarkers(start, end),
  onRangePreview: (kind, s, e) => {                 // light the tiles the drawn range would touch
    const { doomed, shifted } = ctx.rangeAffected(kind, s, e);
    tilePlayer.setRangePreview(doomed, shifted);
  },
  onRangeCommit: (kind, s, e, keepArmed) => ctx.commitRange(kind, s, e, keepArmed),
  onRangeCancel: () => { tilePlayer.setRangePreview(null, null); ctx.disarmRangeTool(); },
  onDelay: (laneId) => ctx.openDelayModal(laneId),
  onChorus: (laneId) => ctx.openChorusModal(laneId),
  onReverb: (laneId) => ctx.openReverbModal(laneId),
  onMods: (laneId) => ctx.openModModal(laneId),
});
tilePlayer.rippleMode = state.ripple; // restore the Ripple toggle (workspace pref)

// --- shared context: register stable objects + the main.js-resident functions
// the extracted controllers call, then bring the controllers up (storage was
// first, at the top). refresh / editGrid / applyLane* / recomputeDirty are
// hoisted declarations defined later in this file; they move to their own
// modules in later phases, and the registration travels with them.
Object.assign(ctx, {
  roll, tilePlayer, patches, tb,
  refresh, syncGridReference, setActive,
  isReferenced, syncReference, applyActiveHighlight,
  centerGridOn, updateRollContent, scrollRollToSelected,
  updateReferenceEnable, grid,
});
initMeter(ctx);
initHistory(ctx);
initZoom(ctx);
initTransport(ctx);
initLanefx(ctx); // lane mixer/FX pushers + modal editors + lane/player reset
initTriadulator(ctx); // triad-proposal system (registers clearProposal)
initRandomui(ctx); // New Random modal
initProjectio(ctx); // project name/dirty + save/open/new/load (registers recomputeDirty)
initExportui(ctx); // MIDI/audio/stem export + dialogs

state.tileScaleIdx = ctx.clampScaleIdx(state.tileScaleIdx);
tilePlayer.ppb = TILE_SCALES[state.tileScaleIdx];


// What the editor is currently editing: the grid's neutral patch, or a lane's.
ctx.editTarget = { patch: gridPatch, laneId: null };


setupPanes(document.getElementById('panes'), LAYOUT_KEY);

// --- active pane ------------------------------------------------------

const gridPaneEl = document.querySelector('.pane[data-pane="grid"]');
const tilesPaneEl = document.querySelector('.pane[data-pane="tiles"]');
gridPaneEl.addEventListener('pointerdown', () => setActive('grid'));
tilesPaneEl.addEventListener('pointerdown', () => setActive('tiles'));

function setActive(pane) {
  if (ctx.activePane === pane) return;
  ctx.disarmRangeTool(); // the range tools belong to the tiles pane; leaving puts them away
  ctx.activePane = pane;
  state.activePane = pane;
  if (pane === 'grid') {
    arrangement.clearSelection();
    tilePlayer.syncSelection();
    ctx.updateTileSelectionUI();
    ctx.editGrid();
  } else {
    grid.clearSelection(); // leaving the grid drops its note selection
  }
  applyActiveHighlight();
  updateRollContent(); scrollRollToSelected();
  ctx.persist();
}

function applyActiveHighlight() {
  gridPaneEl.classList.toggle('active-pane', ctx.activePane === 'grid');
  tilesPaneEl.classList.toggle('active-pane', ctx.activePane === 'tiles');
}

// --- roll auto-scroll -------------------------------------------------

const rollScroll = document.getElementById('rollScroll');

function scrollRollToSelected() {
  if (scheduler.isPlaying) return; // playback drives the scroll itself
  if (ctx.activePane === 'tiles' && arrangement.selectedId != null) {
    const headW = roll.gutter ? roll.gutter.width : 0; // don't park the tile under the pinned gutter
    rollScroll.scrollLeft = Math.max(0, roll.xForBeat(ctx.tileStartBeat(arrangement.selectedId)) - headW - 20);
  } else {
    rollScroll.scrollLeft = 0;
  }
}

// Update the roll's score (e.g. after an active-lane change recolors it). While
// playing, the roll mirrors the playing source and renderLoop does the drawing;
// when stopped, it mirrors the active pane and we draw here.
// The non-12-ET tunings IN USE by what the roll is showing — one gutter label
// column each. Tiles view: every pattern referenced by a tile; grid view: the
// current pattern. Distinct by (tuning, root) since the root moves the degrees.
function tuningsInUse(tilesView) {
  const found = new Map();
  const add = (p) => {
    if (!p || edoOf(p.tuningId) === 12) return;
    found.set(`${p.tuningId}|${p.root || 0}`, { id: p.tuningId, root: p.root || 0 });
  };
  if (tilesView) for (const name of arrangement.referencedNames()) add(library.patterns.get(name));
  else add(library.current());
  return [...found.values()];
}

function updateRollContent() {
  const tilesView = scheduler.isPlaying ? ctx.activeSource === 'tiles' : ctx.activePane === 'tiles';
  const score = scheduler.isPlaying
    ? (ctx.activeSource === 'tiles' ? ctx.arrangementScore() : ctx.buildScore())
    : ctx.activeScore();
  roll.tunings = tuningsInUse(tilesView); // before setScore — affects gutter sizing
  roll.setScore(score);
  if (!scheduler.isPlaying) roll.draw();
}


// --- pattern lifecycle ------------------------------------------------

// Re-center the grid's pitch viewport on a pattern's notes, so opening one that
// sits a couple of octaves away doesn't land off-screen. Best-effort: centers on
// the note span's midpoint, clamped to the pattern's navigable range (the A0..C8
// piano band in its tuning); leaves the view untouched for an empty pattern.
function centerGridOn(pattern) {
  const degs = pattern.columns.filter((c) => !c.isRest).map((c) => c.degree);
  if (!degs.length) return;
  const mid = (Math.min(...degs) + Math.max(...degs)) / 2;
  const rows = state.visibleRows;
  const top = Math.round(mid + (rows - 1) / 2);
  const { min, max } = degreeBounds(pattern.tuningId, pattern.root || 0);
  state.topDegree = Math.max(min + rows - 1, Math.min(max, top));
}

function newOrRestore() {
  ctx.clearProposal();
  grid.clearSelection();
  if (library.parkedName) {
    library.restore();
    ctx.setGridInstr(ctx.parkedInstr || { source: 'grid' }); // bring back the parked pattern's instrument
    ctx.setParkedInstr(null);
  } else {
    const prev = ctx.gridInstr;
    library.newPattern();
    if (library.parkedName) ctx.setParkedInstr(prev); // the leaving pattern got parked — remember its instrument
    ctx.setGridInstr({ source: 'grid' });             // New reverts to the grid's own instrument
  }
  arrangement.clearSelection();
  centerGridOn(library.current()); // no-op for the blank New pattern
  refresh();
}
function clonePattern() {
  ctx.clearProposal();
  grid.clearSelection();
  library.clone();
  // Keep whatever's playing: a borrowed tile instrument is promoted to the grid's
  // own (the clone is a fresh floating pattern), so it stays after the borrow ends.
  if (ctx.gridInstr.source === 'lane') {
    const lane = arrangement.lane(ctx.gridInstr.laneId);
    if (lane) ctx.replaceGridPatch(lane.patch);
  }
  ctx.setGridInstr({ source: 'grid' });
  arrangement.clearSelection();
  refresh();
}
function clearPattern() {
  const cur = library.current();
  if (isReferenced(cur.name) &&
      !confirm(`Pattern ${cur.name} is used by tiles — clear it (and empty those tiles)?`)) {
    return;
  }
  const before = ctx.curSnap();
  ctx.clearProposal();
  grid.clearSelection();
  library.clearCurrent();
  ctx.pushHistory(before);
  arrangement.clearSelection();
  refresh();
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
  // Set Reference reads the tile-player selection, but setActive('grid') below
  // clears it — so snapshot it first.
  const refTiles = what === 'setRef' ? ctx.selectedTiles() : null;
  setActive('grid'); // the toolbar belongs to the grid pane
  switch (what) {
    case 'undo': ctx.undo(); return;
    case 'redo': ctx.redo(); return;
    case 'new': newOrRestore(); return;
    case 'clone': clonePattern(); return;
    case 'random': ctx.openRandomModal(); return;
    case 'clear': clearPattern(); return;
    case 'triadulate': ctx.triadulate(); return;
    case 'confirmTriad': ctx.confirmTriadulation(); return;
    case 'proper': case 'family': ctx.clearProposal(); refresh(); return; // re-triadulate in the new mode/families
    case 'rotate': grid.rotateSelection(); return;
    case 'reverse': grid.reverseSelection(); return;
    case 'sortAsc': grid.sortSelection(true); return;
    case 'sortDesc': grid.sortSelection(false); return;
    case 'shuffle': grid.shuffleSelection(); return;
    case 'shuffleNoRep': grid.shuffleNoRepeatSelection(); return;
    case 'transposeUp': grid.transposeScalar(1); return;
    case 'transposeDown': grid.transposeScalar(-1); return;
    case 'colsInc': grid.setColumns(grid.columnCount() + 1); return;
    case 'colsDec': grid.setColumns(grid.columnCount() - 1); return;
    case 'setRef': setReferenceFromSelection(refTiles); return;
    case 'clearRef': clearReference(); return;
    case 'refCycle': cycleRefLevel(); return;
    case 'duration': // brush duration set in toolbar; apply to a selection if there is one
      grid.updateCursor();
      if (!grid.applyDuration(state.brush.durIndex)) refresh();
      return;
    case 'durationAll': // double-clicked a duration brush → set the whole pattern to it (undoable)
      grid.applyDurationAll(state.brush.durIndex);
      return;
    case 'tuning': {
      const cur = library.current();
      cur.tuningId = tb.tuningSel.value;
      // Drop a scale mask that doesn't belong to the new tuning's EDO (e.g. a 12-ET
      // pentatonic when switching to 16-ET) back to Chromatic, which is universal.
      if (!scaleValidForEdo(cur.scaleId, edoOf(cur.tuningId))) cur.scaleId = 'chromatic';
      if (!hasEquave(cur.tuningId)) cur.root = 0; // no equave → root pinned to the middle-C anchor
      refresh(); return;
    }
    case 'scale': library.current().scaleId = tb.scaleSel.value; refresh(); return;
    case 'scaleRoot': library.current().root = Number(tb.rootSel.value); refresh(); return;
    default: grid.updateCursor(); refresh();
  }
}

function refresh() {
  // A re-render must never move the PAGE. Redrawing the canvases resizes them
  // (roll pitch-span, grid), and the browser's scroll adjustment can jump the
  // window to the top — most visibly when playback ends and refresh runs. Snapshot
  // the window scroll and put it back if anything nudged it. (overflow-anchor:none
  // is the belt; this is the suspenders — it's robust to any cause.)
  const sx = window.scrollX, sy = window.scrollY;
  grid.pattern = library.current();
  grid.referenceDegree = referenceDegreeFor(grid.pattern); // Boshwick keyboard-tracking pivot band
  grid.draw();
  updateRollContent(); scrollRollToSelected();
  tilePlayer.render();
  // Reconcile live tile-player edits into the running cycle (tiles are the commit
  // unit): started tiles stay, not-yet-started tiles are taken live, the cycle
  // end follows the live length. Grid playback commits whole-pattern at the loop
  // boundary, so it isn't resynced here.
  if (scheduler.isPlaying && ctx.activeSource === 'tiles') scheduler.resync();
  gridName.textContent = library.currentName;
  updateEditButtons();
  ctx.updateTriadulateButtons();
  updateSelectionTools();
  updateReferenceEnable();
  updateScaleControls();
  ctx.updateTransportButtons();
  ctx.refreshTransformBar();
  ctx.persist();
  if (window.scrollX !== sx || window.scrollY !== sy) window.scrollTo(sx, sy);
}

// Tooltips for the chord-family toggles (the buttons themselves are rebuilt per
// tuning from familiesFor(edo)).
const FAMILY_TITLES = {
  trad: 'Build triadulations from traditional triads (major / minor / diminished / augmented)',
  sus: 'Build triadulations from suspended chords (sus2 / sus4 — the same set)',
  septimal: '16-ET septimal triads (4:5:7 and the supermajor) — built on the strong 7/4',
};

// Reflect the current pattern's pitch context in the toolbar selectors. The root
// picker is rebuilt for the tuning's EDO (12 letter names / 16 hex names).
function updateScaleControls() {
  const cur = library.current();
  const edo = edoOf(cur.tuningId);
  const rootOpts = hasEquave(cur.tuningId)
    ? Array.from({ length: edo }, (_, i) => ({ value: String(i), label: pitchClassName(i, cur.tuningId) }))
    : [{ value: '0', label: 'C (fixed)' }]; // no equave → the root is the fixed middle-C anchor
  tb.setRootOptions(rootOpts);
  tb.setScaleOptions(scalesFor(edo).map((s) => ({ value: s.id, label: s.name })));
  tb.setFamilyButtons(familiesFor(edo).map((id) => ({ id, label: familyLabel(id), title: FAMILY_TITLES[id] })));
  tb.setCols(cur.columns.length);
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
  tb.randomBtn.disabled = !library.current(); // always available: it rewrites in place or asks (in-use)
  const h = ctx.hist(library.currentName);
  tb.undoBtn.disabled = h.past.length === 0;
  tb.redoBtn.disabled = h.future.length === 0;
  arrUndoBtn.disabled = ctx.arrPast.length === 0;
  arrRedoBtn.disabled = ctx.arrFuture.length === 0;
  tileDeleteBtn.disabled = arrangement.selectedIds.size === 0;
}

// --- odds & ends (homeless helpers — keep this section small) ----------
// Composition-root wiring that doesn't belong to any feature module: the
// unload guard, a few shared button refs the conductor reads, and the
// arrangement-undo / reset / grab-handle listeners.


// Warn before leaving ONLY if a reload would actually lose work — i.e. when
// localStorage persistence has failed. A normal reload restores the autosaved
// session, so we don't nag about merely-unsaved-to-file changes.
window.addEventListener('beforeunload', (e) => {
  if (!ctx.storageOK) { e.preventDefault(); e.returnValue = ''; }
});


const arrUndoBtn = document.getElementById('arrUndo');
const arrRedoBtn = document.getElementById('arrRedo');
const tileDeleteBtn = document.getElementById('tileDelete');
const gridName = document.getElementById('gridName');

document.getElementById('resetPlayer').addEventListener('click', ctx.resetPlayer);


arrUndoBtn.addEventListener('click', ctx.arrUndo);
arrRedoBtn.addEventListener('click', ctx.arrRedo);

tb.grabHandle.addEventListener('dragstart', (e) => {
  e.dataTransfer.setData('text/plain', 'pattern');
  e.dataTransfer.effectAllowed = 'copy';
});
// dragend always fires (drop or cancel) — the one reliable point to clear the
// grid-drag landing preview.
tb.grabHandle.addEventListener('dragend', () => ctx.clearGridDragPreview());


// --- initial paint ----------------------------------------------------

ctx.ensureTileStarts(); // derive positions for tiles restored from an old gapless autosave
grid.updateCursor();
applyActiveHighlight();
ctx.updateScaleStrip();
// Phase-5/6 controllers. Order matters: tileops registers ctx.selectedTiles etc.
// that the others use; patchedit builds the instrument pane + catalog and folds
// its boot editGrid() at its tail (before tileinspector, so the catalog pane still
// appends before the inspector — stacking unchanged); tileinspector registers
// ctx.refreshTileInspector; transformbar builds the bar at its tail, reading both.
initTileops(ctx);
initPatchedit(ctx);
initTileinspector(ctx);
initTransformbar(ctx);
initKeyboard(ctx); // global keydown shortcuts (extracted last — touches nearly every ctx API)
refresh(); // selection starts empty (runtime-only, not persisted)
// The parked playhead is always visible — restore it (clamped: the arrangement
// may have shrunk since it was persisted).
state.playheadBeat = ctx.clampPlayhead(state.playheadBeat);
tilePlayer.setPlayhead(state.playheadBeat);
// Restore the tile player's scroll (after the render above built the content;
// the browser clamps if the arrangement shrank).
document.getElementById('tileLane').scrollLeft = state.tileScrollX || 0;



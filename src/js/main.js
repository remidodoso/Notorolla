// main.js — wire model, audio, scheduler, grid, roll, tiles, toolbar, panes.

import { AudioEngine, FREF } from './audio/audio.js';
import { Scheduler } from './audio/scheduler.js';
import { PianoRoll, ROLL_V_SCALES, ROLL_H_SCALES } from './ui/pianoroll.js';
import { Note, Score } from './core/model.js';
import { Pattern, BASE_PITCH, DURATIONS, DEFAULT_ARTIC } from './core/grid.js';
import { PatternLibrary, Arrangement, laneColor, insertPoint, deletePoint } from './core/library.js';
import { enumerateTriadulations, familiesFor, familyLabel, chordsFor } from './core/triads.js';
import { generateRandom, applyDurationBias, applyAccentBias, scaleWindow, RANDOM_DEFAULTS } from './core/random.js';
import { edoOf, equaveOf, hasEquave, tuningFreq, pitchClassName, degreeBounds, nearestDegreeToFreq, degreeToName, TUNING_LIST } from './core/tuning.js';
import { scalesFor, scaleValidForEdo, scaleById } from './core/scales.js';
import { notesToMidi } from './export/midi.js';
import { encodeWav, encodeBwf } from './export/wav.js';
import { zipStore } from './export/zip.js';
import { GridView } from './ui/gridview.js';
import { bakeReference, referenceDisplay } from './core/reference.js';
import { TilePlayer, TILE_SCALES } from './ui/tileplayer.js';
import { buildToolbar } from './ui/toolbar.js';
import { buildInstrumentPane } from './ui/instrumentpane.js';
import { normalizePatch, defaultPatch, clonePatch, instrument, instrumentKinds } from './audio/instrument.js';
import { PatchStore, factoryInitId } from './audio/patches.js';
import { createCatalog } from './ui/catalog.js';
import { normalizeDelay } from './audio/delay.js';
import { buildDelayEditor } from './audio/delay.js';
import { normalizeChorus, buildChorusEditor } from './audio/chorus.js';
import { normalizeReverb, buildReverbEditor } from './audio/reverb.js';
import { MOD_SLOTS, defaultMod, buildModEditor, modTargetsFor, modsActive, normalizeModsByKind } from './audio/mods.js';
import { applyTransforms, setTileTranspose, setTileReverse, hasReverse, describeTransform, transformKindLabel, normalizeTransforms } from './core/transforms.js';
import { openModal } from './ui/modal.js';
import { setupPanes } from './ui/panes.js';
import { VERSION, buildEnvelope, validate, migrate, defaultName, downloadJSON, downloadBytes, readFile } from './core/project.js';
import {
  LIB_KEY, ARR_KEY, LAYOUT_KEY, PROJ_KEY, PATCH_KEY, GRIDPATCH_KEY, PATCHES_KEY, GRIDMETA_KEY,
  readJSON, initStorage,
} from './app/storage.js';
import { initMeter } from './app/meter.js';
import { initHistory } from './app/history.js';
import { initZoom } from './app/zoom.js';
import { initScore } from './app/score.js';
import { initTransport } from './app/transport.js';
import { initTileops } from './app/tileops.js';
import { initTileinspector } from './app/tileinspector.js';
import { initTransformbar } from './app/transformbar.js';

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
function persistPatches() { ctx.safeSet(PATCHES_KEY, JSON.stringify(patches.toJSON())); }

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
let gridInstr = state.gridInstr && state.gridInstr.source === 'lane' && arrangement.lane(state.gridInstr.laneId)
  ? { source: 'lane', laneId: state.gridInstr.laneId }
  : { source: 'grid' };
// The instrument the parked pattern was using, restored when it's restored
// (best-effort — a lane that's since gone falls back to the grid's own).
let parkedInstr = state.parkedInstr || null;

// The patch the grid plays/edits with: the borrowed lane's patch when a tile is
// loaded (falling back if that lane is gone), else the grid's own gridPatch.
function resolveGridInstrPatch() {
  if (gridInstr.source === 'lane') {
    const lane = arrangement.lane(gridInstr.laneId);
    if (lane) return lane.patch;
  }
  return gridPatch;
}

// Set which instrument the grid plays/edits with (validated: a missing lane falls
// back to the grid's own). Re-points the pane when the grid is focused, and
// records it for persistence so a reload keeps the same grid instrument.
function setGridInstr(desc) {
  gridInstr = desc && desc.source === 'lane' && arrangement.lane(desc.laneId)
    ? { source: 'lane', laneId: desc.laneId }
    : { source: 'grid' };
  state.gridInstr = gridInstr.source === 'lane' ? { source: 'lane', laneId: gridInstr.laneId } : null;
  if (ctx.activePane === 'grid') editGrid(); // re-point the pane at the new instrument
}

function setParkedInstr(desc) { parkedInstr = desc || null; state.parkedInstr = parkedInstr; }

// Overwrite the grid's own neutral patch in place with a copy of `src` (keeping
// the gridPatch object identity so editTarget/patchFor references stay valid).
// Used when Clone promotes a borrowed tile instrument to be the grid's own.
function replaceGridPatch(src) {
  const copy = clonePatch(src);
  for (const k of Object.keys(gridPatch)) delete gridPatch[k];
  Object.assign(gridPatch, copy);
  ctx.safeSet(GRIDPATCH_KEY, JSON.stringify(gridPatch));
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

// Push every lane's volume + pan onto its bus (after undo/redo or a load, where
// values change under existing strips; new strips read the resolver themselves).
function applyLaneMix(rampSec = 0.012) {
  for (const lane of arrangement.lanes) {
    engine.setLaneVolume(lane.id, lane.gain, rampSec);
    engine.setLanePan(lane.id, lane.pan, rampSec);
  }
}

// Resolve a lane's delay insert config for the engine — time follows the tempo
// (beats × 60/bpm → seconds). { on:false } when the lane has no/disabled delay.
engine.laneDelay = (laneId) => {
  const lane = arrangement.lane(laneId);
  if (!lane || !lane.delay || !lane.delay.on) return { on: false };
  const d = lane.delay;
  return { on: true, mode: d.mode, timeSec: d.time * 60 / state.bpm, wet: d.wet, feedback: d.feedback };
};

// (Re)apply every lane's delay to the engine — after a modal edit, a tempo
// change (delay time is tempo-synced), or a load/undo.
function applyLaneDelayAll() {
  for (const lane of arrangement.lanes) engine.applyLaneDelay(lane.id);
}

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

// (Re)apply every lane's chorus to the engine — after a modal edit or a load/undo.
function applyLaneChorusAll() {
  for (const lane of arrangement.lanes) engine.applyLaneChorus(lane.id);
}

// Resolve a lane's insert-reverb config for the engine ({ on:false } = none).
engine.laneReverb = (laneId) => {
  const lane = arrangement.lane(laneId);
  if (!lane || !lane.reverb || !lane.reverb.on) return { on: false };
  return lane.reverb;
};

// (Re)apply every lane's reverb to the engine — after a modal edit or a load/undo.
function applyLaneReverbAll() {
  for (const lane of arrangement.lanes) engine.applyLaneReverb(lane.id);
}

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
  onChange: () => { setActive('grid'); clearProposal(); refresh(); },
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
  onMute: (laneId) => toggleLaneFlag('mute', laneId),
  onSolo: (laneId) => toggleLaneFlag('solo', laneId),
  onAddLane: () => addLane(),
  onResetLane: (laneId) => resetLane(laneId),
  onEdit: (laneId) => editLane(laneId, true), // double-click the lane head → scroll the pane into view
  // The lane's patch display { name, dirty, imported } for the lane head.
  patchDisplay: (lane) => patchInfo(lane),
  onMixStart: () => onMixStart(),
  onMixChange: (laneId, key, value) => onMixChange(laneId, key, value),
  onMixEnd: () => onMixEnd(),
  onMarkerStart: () => onMixStart(),                // reuse the arrangement-edit bracket
  onMarkers: (start, end) => ctx.setPlayMarkers(start, end),
  onRangePreview: (kind, s, e) => {                 // light the tiles the drawn range would touch
    const { doomed, shifted } = ctx.rangeAffected(kind, s, e);
    tilePlayer.setRangePreview(doomed, shifted);
  },
  onRangeCommit: (kind, s, e, keepArmed) => ctx.commitRange(kind, s, e, keepArmed),
  onRangeCancel: () => { tilePlayer.setRangePreview(null, null); ctx.disarmRangeTool(); },
  onDelay: (laneId) => openDelayModal(laneId),
  onChorus: (laneId) => openChorusModal(laneId),
  onReverb: (laneId) => openReverbModal(laneId),
  onMods: (laneId) => openModModal(laneId),
});
tilePlayer.rippleMode = state.ripple; // restore the Ripple toggle (workspace pref)

// --- shared context: register stable objects + the main.js-resident functions
// the extracted controllers call, then bring the controllers up (storage was
// first, at the top). refresh / editGrid / applyLane* / recomputeDirty are
// hoisted declarations defined later in this file; they move to their own
// modules in later phases, and the registration travels with them.
Object.assign(ctx, {
  roll, tilePlayer,
  refresh, editGrid, recomputeDirty,
  applyLaneMix, applyLaneDelayAll, applyLaneChorusAll, applyLaneReverbAll,
  setActive, applyLaneGains, onMixEnd,
  clearProposal, centerGridOn, updateRollContent, scrollRollToSelected,
  setGridInstr, updateReferenceEnable, grid,
});
initMeter(ctx);
initHistory(ctx);
initZoom(ctx);
initTransport(ctx);

// In-memory Copy/Paste clipboards for the effect editors — one per effect type
// (a delay can't paste onto a reverb). Cleared on reload; persists across modal
// opens so you can copy one lane's effect and paste it onto another.
const fxClip = { delay: null, chorus: null, reverb: null };

// A standardized Copy/Paste bar for the effect modals. Copy snapshots the config
// into the per-type clipboard; Paste overwrites the config IN PLACE (so the lane's
// object identity holds), applies it to the audio, and rebuilds the controls.
function fxCopyBar(kind, cfg, normalize, apply, rebuild) {
  const bar = document.createElement('div');
  bar.className = 'fx-copybar';
  const copy = document.createElement('button');
  copy.className = 'tbtn'; copy.textContent = 'Copy'; copy.title = 'Copy these settings';
  const paste = document.createElement('button');
  paste.className = 'tbtn'; paste.textContent = 'Paste'; paste.title = 'Paste copied settings';
  paste.disabled = !fxClip[kind];
  copy.addEventListener('click', () => { fxClip[kind] = normalize(cfg); paste.disabled = false; });
  paste.addEventListener('click', () => {
    if (!fxClip[kind]) return;
    const next = normalize(fxClip[kind]);
    for (const k of Object.keys(cfg)) delete cfg[k];
    Object.assign(cfg, next);
    apply();
    rebuild(); // re-read the pasted values into the controls
  });
  bar.append(copy, paste);
  return bar;
}

// Open one of the per-lane effect editors (delay / chorus / reverb) in a modal.
// The whole session is ONE undo step: snapshot on open (the shared arrangement-
// edit bracket), apply each change live, commit on close. A standardized Copy/
// Paste bar sits atop the editor; Paste rebuilds the body to show the new values.
function openFxModal({ title, kind, cfg, normalize, buildBody, apply, onClose }) {
  onMixStart(); // capture the pre-edit snapshot
  const wrap = document.createElement('div');
  wrap.className = 'fx-modal';
  const rebuild = () => {
    wrap.textContent = '';
    wrap.append(fxCopyBar(kind, cfg, normalize, apply, rebuild), buildBody());
  };
  rebuild();
  openModal({ title, body: wrap, onClose });
}

function openDelayModal(laneId) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  const idx = arrangement.lanes.indexOf(lane);
  const apply = () => engine.applyLaneDelay(laneId);
  openFxModal({
    title: `Delay — Lane ${idx + 1}`, kind: 'delay', cfg: lane.delay, normalize: normalizeDelay, apply,
    buildBody: () => buildDelayEditor(lane.delay, { onChange: apply }),
    onClose: () => { apply(); onMixEnd(); tilePlayer.render(); /* reflect the D-button lit state */ },
  });
}

function openChorusModal(laneId) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  const idx = arrangement.lanes.indexOf(lane);
  const apply = () => engine.applyLaneChorus(laneId);
  openFxModal({
    title: `Chorus — Lane ${idx + 1}`, kind: 'chorus', cfg: lane.chorus, normalize: normalizeChorus, apply,
    buildBody: () => buildChorusEditor(lane.chorus, { onChange: apply }),
    onClose: () => { apply(); onMixEnd(); tilePlayer.render(); /* reflect the C-button lit state */ },
  });
}

function openReverbModal(laneId) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  const idx = arrangement.lanes.indexOf(lane);
  if (!lane.reverb) lane.reverb = normalizeReverb(null); // older autosaves lack the field
  const apply = () => engine.applyLaneReverb(laneId);
  openFxModal({
    title: `Reverb — Lane ${idx + 1}`, kind: 'reverb', cfg: lane.reverb, normalize: normalizeReverb, apply,
    buildBody: () => buildReverbEditor(lane.reverb, { onChange: apply }),
    onClose: () => { apply(); onMixEnd(); tilePlayer.render(); /* reflect the R-button lit state */ },
  });
}

// Open the per-lane modulators editor in a modal — same one-undo-step bracket
// as the delay/chorus modals. Edits need no audio rewiring (mods are evaluated
// at each note-on from the live lane data), so onChange is a no-op until close.
function openModModal(laneId) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  const idx = arrangement.lanes.indexOf(lane);
  const kind = lane.patch && lane.patch.kind;
  if (!lane.modsByKind) lane.modsByKind = {};
  if (!lane.modsByKind[kind]) lane.modsByKind[kind] = Array.from({ length: MOD_SLOTS }, defaultMod);
  onMixStart(); // capture the pre-edit snapshot
  const body = buildModEditor(lane.modsByKind[kind], modTargetsFor(kind), { onChange: () => {} });
  openModal({
    title: `Modulators — Lane ${idx + 1} (${instrument(kind).label})`,
    body,
    onClose: () => {
      onMixEnd();          // commit one undo step if changed + persist + dirty
      tilePlayer.render(); // reflect the M-button lit state
    },
  });
}


// Pan/Gain knob drag. The knob updates itself live; we apply each move to the
// lane bus immediately (so you hear it) but defer autosave/dirty + the single
// undo step to release — so a continuous drag is one undoable change, not many.
let mixBefore = null;
function onMixStart() { mixBefore = ctx.arrSnap(); }
function onMixChange(laneId, key, value) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  if (key === 'pan') { lane.pan = value; engine.setLanePan(laneId, value, 0.01); }
  else { lane.gain = value; engine.setLaneVolume(laneId, value, 0.01); }
}
function onMixEnd() {
  if (mixBefore != null) ctx.arrCommit(mixBefore); // a net change → one undo step
  mixBefore = null;
  ctx.persist(); // autosave + dirty (knobs already drove the audio live)
  ctx.updateTransportButtons(); // reflect the new arrangement-undo entry immediately
}

// Add a lane (undoable arrangement edit) and make it active.
function addLane() {
  setActive('tiles');
  ctx.arrRecord();
  const lane = arrangement.addLane();
  arrangement.activeLaneId = lane.id;
  applyLaneGains(0); // give the new lane's bus the right gain under any active solo/mute
  refresh();
}
state.tileScaleIdx = ctx.clampScaleIdx(state.tileScaleIdx);
tilePlayer.ppb = TILE_SCALES[state.tileScaleIdx];

// Mute / Solo: an undoable arrangement edit (so it rides tile Undo/Redo and the
// dirty bit). The audio change is the lane gain bus (real-time, ramped); refresh
// re-renders the lane buttons + roll hatching.
function toggleLaneFlag(kind, laneId) {
  setActive('tiles');
  ctx.arrRecord();
  if (kind === 'mute') arrangement.toggleMute(laneId);
  else arrangement.toggleSolo(laneId);
  applyLaneGains(0.012); // immediate (ramped) — present tails + future notes
  refresh();
}

// Push the current mute/solo state onto the lane gain buses. rampSec 0 = instant
// (use when starting playback so an already-muted lane is silent from note one);
// a small ramp avoids clicks for live toggles.
function applyLaneGains(rampSec) {
  const audible = arrangement.audibleLaneIds();
  for (const lane of arrangement.lanes) {
    engine.setLaneGain(lane.id, audible.has(lane.id) ? 1 : 0, rampSec);
  }
}


















// Reset one lane to a blank slate (the red "R"): clear its tiles + restore the
// default instrument / mixer / delay / mute-solo, and mark it fresh again. The
// lane stays in the stack. Undoable as a `full` entry (so the instrument too).
function resetLane(id) {
  const before = ctx.arrSnap();
  arrangement.resetLane(id);
  ctx.arrCommit(before, true);
  patchStash.delete(stashKey(id)); // forget stashed per-kind patches for this lane
  applyLaneMix(0.012);  // gain/pan back to unity/center on the bus
  applyLaneDelayAll();  // delay off → remove the insert
  applyLaneChorusAll(); // chorus off → remove the insert
  applyLaneReverbAll();  // reverb off → remove the insert
  if (ctx.editTarget.laneId === id) editLane(id); // re-point the pane onto the new default patch
  refresh();
}

// Reset the whole tile player ("Reset player"): back to two blank, fresh lanes
// and the play region cleared. Undoable as a `full` entry.
function resetPlayer() {
  const before = ctx.arrSnap();
  arrangement.resetPlayer();
  ctx.arrCommit(before, true);
  patchStash.clear();    // the old lanes are gone
  engine.resetLanes();   // tear down every strip (delay tails / orphaned lanes)
  editGrid();            // the edited lane may no longer exist → back to the grid
  applyLaneMix(0);       // initialize the two fresh lanes' buses
  applyLaneDelayAll();
  applyLaneChorusAll();
  applyLaneReverbAll();
  refresh();
}






let catalog = null;       // the Patch Catalog floating pane (created below)


// Edit-instrument pane (the Vesperia). An editor panel, not a transport pane:
// it doesn't touch activePane or the shortcut routing. The pane edits ONE target
// patch at a time (a lane's, or the grid's neutral one). Slider edits mutate
// that patch in place (heard on the next note) and autosave the right place.
const instrPane = buildInstrumentPane(document.getElementById('instr'), {
  onChange: onPatchEdit,
  onKindChange: changeKind,
  onTest: testInstrument,
  onReset: resetInstrument,
  onCopy: copyPatch,
  onPaste: pastePatch,
  // Patch catalog (Phase B): identity + save/load.
  getIdentity: () => { const m = targetMeta(); return m ? patchInfo(m) : null; },
  getPatchList: () => patches.allForKind(ctx.editTarget.patch.kind).map((e) => ({ id: e.id, name: e.name, factory: e.factory })),
  onRenamePatch: renameTargetPatch,
  onSave: saveTargetPatch,
  onSaveAs: saveTargetPatchAs,
  onLoad: loadTargetPatch,
  onCatalog: () => { catalog.toggle(); },
});

// What the editor is currently editing: the grid's neutral patch, or a lane's.
ctx.editTarget = { patch: gridPatch, laneId: null };
let patchClipboard = null; // in-memory only (cleared on reload) — Copy/Paste

// Per-target stash of the OTHER kinds' last-used patches, so switching a target
// from (say) Zindel to Vesperia and back restores the Zindel you'd dialed rather
// than resetting it. In-memory, per session: the *active* kind always rides the
// project (it's the lane/grid patch); only the inactive kinds' edits are
// session-scoped. Keyed by target (a laneId, or 'grid' for the grid patch).
const patchStash = new Map();
const stashKey = (laneId) => (laneId == null ? 'grid' : `lane:${laneId}`);

// Replace the current target's patch contents in place (so every reference —
// lane.patch / gridPatch / editTarget.patch — stays valid) with `next`, wiping
// the old kind's keys first. Then re-point the pane so it rebuilds for the new
// kind, and persist.
function swapTargetPatch(next) {
  const cur = ctx.editTarget.patch;
  for (const k of Object.keys(cur)) delete cur[k];
  Object.assign(cur, next);
  if (ctx.editTarget.laneId == null) editGrid(); else editLane(ctx.editTarget.laneId);
  persistPatch();
  syncGridReference(); // a kind change (e.g. to/from Boshwick) moves the pivot band
}

// Switch the edited target to a different instrument kind, stashing the patch
// we're leaving and restoring any previously-dialed patch of the kind we're
// entering (else that kind's factory default).
function changeKind(kind) {
  const cur = ctx.editTarget.patch;
  if (cur.kind === kind) return;
  let stash = patchStash.get(stashKey(ctx.editTarget.laneId));
  if (!stash) { stash = {}; patchStash.set(stashKey(ctx.editTarget.laneId), stash); }
  stash[cur.kind] = clonePatch(cur);
  const usedStash = !!stash[kind];
  swapTargetPatch(stash[kind] ? clonePatch(stash[kind]) : defaultPatch(kind));
  // A kind change resets identity to that kind's Init (a name is meaningful only
  // within a kind). A restored stash isn't the bare default → mark it dirty (Init*).
  setTargetIdentity(patches.initId(kind), 'Init', usedStash);
}

// Point the editor at the grid's active instrument (when the grid pane has focus):
// the grid's own neutral patch, or — while a tile is loaded — that tile's LANE
// patch, so editing the grid's instrument edits the lane (and every tile on it).
function editGrid() {
  const lane = gridInstr.source === 'lane' ? arrangement.lane(gridInstr.laneId) : null;
  if (lane) {
    const idx = arrangement.lanes.indexOf(lane);
    ctx.editTarget = { patch: lane.patch, laneId: lane.id };
    tilePlayer.editLaneId = lane.id;
    instrPane.setTarget(lane.patch, `Lane ${idx + 1}`, laneColor(idx));
    tilePlayer.render();
    return;
  }
  ctx.editTarget = { patch: gridPatch, laneId: null };
  tilePlayer.editLaneId = null;
  instrPane.setTarget(gridPatch, 'Grid', '#8a8f98');
  tilePlayer.render();
  if (catalog && catalog.isOpen()) catalog.refresh(); // follow the target's highlight
}

// Point the editor at a lane's own patch. `scroll` brings the pane into view —
// used ONLY by the explicit Edit button, so that re-points (a kind change, a
// default-patch swap, a borrow) never yank the page under the user.
function editLane(laneId, scroll = false) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  const idx = arrangement.lanes.indexOf(lane);
  ctx.editTarget = { patch: lane.patch, laneId };
  tilePlayer.editLaneId = laneId;
  instrPane.setTarget(lane.patch, `Lane ${idx + 1}`, laneColor(idx));
  tilePlayer.render();
  if (catalog && catalog.isOpen()) catalog.refresh(); // follow the target's highlight
  // Reveal the pane only when its TOP isn't already on-screen. The pane is often
  // taller than the viewport, so an unconditional scrollIntoView('nearest') can
  // never be a no-op (it aligns an edge) and yanks the page even when the pane is
  // already in view — the "pointless scroll in nearly all cases".
  if (scroll) {
    const el = document.getElementById('instr');
    const top = el.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

// Persist a patch edit: the grid patch is a workspace preference (its own key);
// a lane patch is musical content, so it rides the arrangement autosave + dirty.
function persistPatch() {
  if (ctx.editTarget.laneId == null) { ctx.safeSet(GRIDPATCH_KEY, JSON.stringify(gridPatch)); return; }
  // A deliberately-edited instrument means the lane has been "used" — so a tile
  // dropped in later won't auto-overwrite it (see lane.fresh).
  const lane = arrangement.lane(ctx.editTarget.laneId);
  if (lane) lane.fresh = false;
  ctx.persist();
}

function copyPatch() {
  patchClipboard = clonePatch(ctx.editTarget.patch);
  instrPane.setCanPaste(true);
}

function pastePatch() {
  if (!patchClipboard) return;
  // Paste can cross kinds (Copy a Zindel, Paste onto a Vesperia lane), so swap
  // the whole patch — swapTargetPatch rebuilds the pane for the pasted kind.
  swapTargetPatch(clonePatch(patchClipboard));
  // A pasted sound isn't the kind's bare default → Init*, awaiting a name.
  setTargetIdentity(patches.initId(ctx.editTarget.patch.kind), 'Init', true);
}

// --- patch identity: dirty tracking, Save/Save As/Load/Rename ----------------
// The patch-identity record for the current edit target (a lane, or the grid).
function targetMeta() {
  if (ctx.editTarget.laneId == null) return ctx.gridPatchMeta;
  return arrangement.lane(ctx.editTarget.laneId) || ctx.gridPatchMeta;
}
// Display info for a patch-identity record: { name, dirty, imported }. The UI
// composes `name + (dirty?'*') + (imported?' [I]')`. `imported` is an EXPLICIT
// flag (set on project-file Open), not inferred from id-resolution — so a locally
// deleted patch reads as `Name*`, only a genuinely foreign one as `[I]`.
function patchInfo(meta) {
  if (!meta) return { name: 'Init', dirty: false, imported: false };
  const entry = patches.get(meta.patchOriginId);
  const imported = !!meta.patchImported;
  // A clean, resolvable, non-imported patch shows the entry's CURRENT name (so an
  // in-place Rename propagates to every linker); otherwise the local snapshot.
  const name = (entry && !meta.patchDirty && !imported) ? entry.name : (meta.patchName || 'Init');
  return { name, dirty: !!meta.patchDirty, imported };
}

// A user param edit flips the target dirty (only the first edit needs the repaint)
// and persists. (Programmatic swaps use setTargetIdentity, not this.)
function onPatchEdit() {
  const m = targetMeta();
  if (m && !m.patchDirty) {
    m.patchDirty = true;
    instrPane.syncIdentity();
    if (ctx.editTarget.laneId != null) tilePlayer.render();
  }
  persistPatch();
}

// Persist the identity record to the right place (grid = its own key; a lane
// rides the arrangement) and repaint the pane name + lane head.
function persistPatchMeta() {
  if (ctx.editTarget.laneId == null) ctx.safeSet(GRIDMETA_KEY, JSON.stringify(ctx.gridPatchMeta));
  else ctx.persist();
  instrPane.syncIdentity();
  if (ctx.editTarget.laneId != null) tilePlayer.render();
  if (catalog && catalog.isOpen()) catalog.refresh(); // new/loaded patch, highlight move
}
function setTargetIdentity(originId, name, dirty) {
  const m = targetMeta();
  if (!m) return;
  m.patchOriginId = originId; m.patchName = name; m.patchDirty = dirty;
  m.patchImported = false; // linked to a known entry → no longer "imported"
  persistPatchMeta();
}

// Rename = declare a fork name; shows Name* until Save creates the catalog entry.
function renameTargetPatch(name) {
  const m = targetMeta();
  if (!m) return;
  m.patchName = name;
  m.patchDirty = true; // differs from any saved entry until Save
  persistPatchMeta();
}

// Save: overwrite the linked USER entry when the name is unchanged; otherwise (a
// renamed patch, or a factory/Init origin) fork a new user patch. (Save-with-a-
// changed-name = "make a new patch" — never an in-place rename; true rename is
// Phase C.)
function saveTargetPatch() {
  const m = targetMeta();
  if (!m) return;
  const entry = patches.get(m.patchOriginId);
  const kind = ctx.editTarget.patch.kind;
  const nameChanged = !entry || m.patchName !== entry.name;
  if (entry && !entry.factory && !nameChanged) {
    patches.update(entry.id, { params: clonePatch(ctx.editTarget.patch) });
    persistPatches();
    markSiblingsDirty(entry.id, m); // independent copies fall out of sync → `*`
    setTargetIdentity(entry.id, entry.name, false);
    return;
  }
  // Fork: needs a name. A factory Init with an unchanged name must supply one now.
  let name = m.patchName;
  if (entry && entry.factory && !nameChanged) {
    name = (prompt('Name this patch:', '') || '').trim();
    if (!name) return; // cancelled — nothing saved
  }
  forkPatch(kind, name);
}

function saveTargetPatchAs() {
  const m = targetMeta();
  if (!m) return;
  const suggested = m.patchName === 'Init' ? '' : m.patchName;
  const name = (prompt('Save patch as:', suggested) || '').trim();
  if (!name) return;
  forkPatch(ctx.editTarget.patch.kind, name);
}

// Create a new user patch from the target's current params and link to it. The
// name is resolved against catalog collisions first (factory names auto-uniquify;
// a user-name clash offers Save/Rename/Cancel — we discourage silent duplicates).
function forkPatch(kind, name) {
  resolveForkName(kind, name, (finalName) => {
    if (!finalName) return; // cancelled
    const e = patches.add({ name: finalName, kind, params: clonePatch(ctx.editTarget.patch) });
    persistPatches();
    setTargetIdentity(e.id, e.name, false);
  });
}

// Resolve `name` for a new user patch, then call ok(finalName) — or ok(null) if
// cancelled. A FACTORY-name collision is reserved → auto-uniquify (Init→Init1). A
// USER-name collision opens a Save/Rename/Cancel choice (Save = use it anyway;
// Rename = pick another and re-check; Cancel = abort).
function resolveForkName(kind, name, ok) {
  name = (name || '').trim();
  if (!name) { ok(null); return; }
  if (patches.factoryNames(kind).has(name)) { ok(patches.uniqueUserName(kind, name)); return; }
  if (patches.userNames(kind).has(name)) {
    openNameCollision(name, (choice) => {
      if (choice === 'use') ok(name);
      else if (choice === 'rename') {
        const next = (prompt('New patch name:', name) || '').trim();
        if (!next) { ok(null); return; }
        resolveForkName(kind, next, ok);
      } else ok(null);
    });
    return;
  }
  ok(name);
}

// The "name already in use" dialog (Save / Rename / Cancel). done(choice) with
// 'use' | 'rename' | null.
function openNameCollision(name, done) {
  const body = document.createElement('div');
  body.className = 'delay-editor';
  const msg = document.createElement('div');
  msg.className = 'delay-row'; msg.style.display = 'block';
  msg.textContent = `There is already a patch named “${name}”. Use the name again?`;
  const actions = document.createElement('div');
  actions.className = 'delay-row rand-actions';
  let choice = null;
  const mk = (text, cls, val) => {
    const b = document.createElement('button'); b.className = cls; b.textContent = text;
    b.addEventListener('click', () => { choice = val; modal.close(); });
    actions.append(b);
  };
  mk('Save', 'stem-go', 'use');
  mk('Rename', 'seg', 'rename');
  const sp = document.createElement('span'); sp.style.flex = '1'; actions.append(sp);
  mk('Cancel', 'seg', null);
  body.append(msg, actions);
  const modal = openModal({ title: 'Patch name in use', body, onClose: () => done(choice) });
}

// Load a catalog patch into the current target (same kind — the Load menu is
// per-kind), replacing its params in place and adopting the entry's identity.
function loadTargetPatch(id) {
  const e = patches.get(id);
  if (!e) return;
  applyPatchToTarget(clonePatch(e.params));
  setTargetIdentity(e.id, e.name, false);
}

// Replace the target patch's contents in place (references stay valid) and
// rebuild the pane for the (possibly new) kind — like swapTargetPatch, but the
// caller sets identity explicitly afterward.
function applyPatchToTarget(next) {
  const cur = ctx.editTarget.patch;
  for (const k of Object.keys(cur)) delete cur[k];
  Object.assign(cur, next);
  if (ctx.editTarget.laneId == null) editGrid(); else editLane(ctx.editTarget.laneId);
  persistPatch();
  syncGridReference();
}

// After overwriting a user entry, mark OTHER targets holding an independent copy
// of it (same origin id, currently clean) dirty — their copy no longer matches
// the re-Saved sound. (Rack sharing, later, would re-sound them instead.)
function markSiblingsDirty(entryId, exceptMeta) {
  for (const lane of arrangement.lanes) {
    if (lane === exceptMeta) continue;
    if (lane.patchOriginId === entryId && !lane.patchDirty) lane.patchDirty = true;
  }
  if (ctx.gridPatchMeta !== exceptMeta && ctx.gridPatchMeta.patchOriginId === entryId && !ctx.gridPatchMeta.patchDirty) {
    ctx.gridPatchMeta.patchDirty = true;
    ctx.safeSet(GRIDMETA_KEY, JSON.stringify(ctx.gridPatchMeta));
  }
  ctx.persist();
  tilePlayer.render();
}

// --- catalog management: apply / rename / delete -----------------------------
// Every identity record (lanes + the grid) that links to a catalog entry.
function patchLinkers(id) {
  const out = arrangement.lanes.filter((l) => l.patchOriginId === id);
  if (ctx.gridPatchMeta.patchOriginId === id) out.push(ctx.gridPatchMeta);
  return out;
}

// Repaint everything that shows a patch name after a catalog change.
function refreshPatchUI() {
  instrPane.syncIdentity();
  tilePlayer.render();
  if (catalog && catalog.isOpen()) catalog.refresh();
}

// True in-place Rename of a USER entry (keeps its id, so all links follow). Clean
// linkers derive their display from the entry, so they update on the next render;
// dirty linkers keep their own snapshot. A name clash is discouraged like a Save.
function renamePatchEntry(id, name) {
  const e = patches.get(id);
  if (!e || e.factory) return;
  name = (name || '').trim();
  if (!name || name === e.name) return;
  const commit = (finalName) => {
    patches.update(id, { name: finalName });
    persistPatches();
    // Refresh the snapshot on dirty linkers so a later delete keeps the new name.
    for (const m of patchLinkers(id)) if (m.patchDirty) m.patchName = finalName;
    ctx.persist();
    refreshPatchUI();
  };
  if (patches.factoryNames(e.kind).has(name)) { commit(patches.uniqueUserName(e.kind, name)); return; }
  const clash = [...patches.userNames(e.kind)].includes(name) && patches.allForKind(e.kind).some((o) => !o.factory && o.id !== id && o.name === name);
  if (clash) {
    openNameCollision(name, (choice) => {
      if (choice === 'use') commit(name);
      else if (choice === 'rename') { const n = (prompt('New patch name:', name) || '').trim(); if (n) renamePatchEntry(id, n); }
    });
    return;
  }
  commit(name);
}

// Delete a USER entry. Linked targets keep their sound but detach → `Name*`
// (dirty, NOT imported — a deliberate local delete, not a foreign import).
function deletePatch(id) {
  const e = patches.get(id);
  if (!e || e.factory) return;
  const users = patchLinkers(id);
  if (users.length && !confirm(`Delete “${e.name}”?\nIt's used by ${users.length} target${users.length > 1 ? 's' : ''} — they keep the sound as “${e.name}*” (unsaved).`)) return;
  patches.remove(id);
  persistPatches();
  for (const m of users) { m.patchDirty = true; m.patchName = e.name; m.patchImported = false; }
  if (users.includes(ctx.gridPatchMeta)) ctx.safeSet(GRIDMETA_KEY, JSON.stringify(ctx.gridPatchMeta));
  ctx.persist();
  refreshPatchUI();
}

// Apply a catalog patch to the current edit target (cross-kind aware — reuses the
// Phase-B load path, which rebuilds the pane for a new kind).
function applyCatalogPatch(id) { loadTargetPatch(id); if (catalog && catalog.isOpen()) catalog.refresh(); }

// The Patch Catalog window (a panel.js tenant). Applies to the current editor
// target; opened from the instrument pane.
catalog = createCatalog({
  list: () => instrumentKinds().map((k) => ({
    kindLabel: instrument(k).label,
    patches: patches.allForKind(k).map((e) => ({ id: e.id, name: e.name, factory: e.factory })),
  })),
  currentId: () => { const m = targetMeta(); return m ? m.patchOriginId : null; },
  onApply: applyCatalogPatch,
  onRename: (id) => { const e = patches.get(id); if (!e) return; const n = (prompt('Rename patch:', e.name) || '').trim(); if (n) renamePatchEntry(id, n); },
  onDelete: deletePatch,
});
if (catalog.isOpen()) catalog.refresh(); // it may have auto-reopened from last session

// Audition the target patch on a fixed mid-register note (independent of the
// Audition toggle, which gates click-to-hear on the grid). A lane target plays
// through that lane's bus so Mute/Solo apply; the grid target is un-laned.
async function testInstrument() {
  const t = await engine.ensureRunning();
  const cur = library.current();
  engine.playNote(60, t + 0.005, 60 / state.bpm, 0.85, tuningFreq(60, cur.tuningId, cur.root), ctx.editTarget.laneId);
}

function resetInstrument() {
  // Reset to THIS instrument's defaults (not always Vesperia's) = its factory Init.
  const kind = ctx.editTarget.patch.kind;
  swapTargetPatch(defaultPatch(kind));
  setTargetIdentity(patches.initId(kind), 'Init', false);
}

editGrid(); // start with the editor showing the grid's neutral patch

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
    editGrid();
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
  clearProposal();
  grid.clearSelection();
  if (library.parkedName) {
    library.restore();
    setGridInstr(parkedInstr || { source: 'grid' }); // bring back the parked pattern's instrument
    setParkedInstr(null);
  } else {
    const prev = gridInstr;
    library.newPattern();
    if (library.parkedName) setParkedInstr(prev); // the leaving pattern got parked — remember its instrument
    setGridInstr({ source: 'grid' });             // New reverts to the grid's own instrument
  }
  arrangement.clearSelection();
  centerGridOn(library.current()); // no-op for the blank New pattern
  refresh();
}
function clonePattern() {
  clearProposal();
  grid.clearSelection();
  library.clone();
  // Keep whatever's playing: a borrowed tile instrument is promoted to the grid's
  // own (the clone is a fresh floating pattern), so it stays after the borrow ends.
  if (gridInstr.source === 'lane') {
    const lane = arrangement.lane(gridInstr.laneId);
    if (lane) replaceGridPatch(lane.patch);
  }
  setGridInstr({ source: 'grid' });
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
  clearProposal();
  grid.clearSelection();
  library.clearCurrent();
  ctx.pushHistory(before);
  arrangement.clearSelection();
  refresh();
}

// --- New Random ---------------------------------------------------------
//
// New Random. Generates random in-scale pitches over the CURRENT grid's rhythm
// (its per-column durations), live-previewed on the grid. If the current pattern
// isn't referenced it's rewritten in place; if it IS referenced, a 3-way choice
// asks Replace-All (rewrite in place → every tile updates) / New Pattern (mint an
// independent one) / Cancel. Auto-rolls a candidate on open (ready to audition);
// Randomize re-rolls; Accept keeps it (one undo step for in-place); Cancel restores.
// Slider settings persist across uses (Reset = defaults).

const RAND_KEY = 'notorolla.randgen';

function tileRefCount(name) {
  let n = 0;
  for (const lane of arrangement.lanes) for (const t of lane.tiles) if (t.name === name) n++;
  return n;
}

function openRandomModal() {
  const src = library.current();
  if (!src) return;
  const n = tileRefCount(src.name);
  if (n > 0) openReplaceChoice(src.name, n, (mode) => { if (mode) runRandomModal(mode); });
  else runRandomModal('inplace'); // not in use → rewrite in place, no question
}

// The up-front choice when New Random targets an in-use pattern.
function openReplaceChoice(name, n, done) {
  const body = document.createElement('div');
  body.className = 'delay-editor';
  const msg = document.createElement('div');
  msg.className = 'delay-row'; msg.style.display = 'block';
  msg.textContent = `Pattern ${name} is used in ${n} tile${n === 1 ? '' : 's'}. Replace it in all of them, or generate an independent new pattern?`;
  const actions = document.createElement('div');
  actions.className = 'delay-row rand-actions';
  let choice = null;
  const mk = (text, cls, val) => {
    const b = document.createElement('button');
    b.className = cls; b.textContent = text;
    b.addEventListener('click', () => { choice = val; modal.close(); });
    actions.append(b);
  };
  mk('Replace All', 'stem-go', 'inplace');
  mk('New Pattern', 'seg', 'new');
  const spacer = document.createElement('span'); spacer.style.flex = '1'; actions.append(spacer);
  mk('Cancel', 'seg', null);
  body.append(msg, actions);
  const modal = openModal({ title: 'New Random — pattern in use', body, onClose: () => done(choice) });
}

function runRandomModal(mode) {
  // Sanitize persisted settings (clamp each to its slider's range).
  const saved = readJSON(RAND_KEY) || {};
  const cl = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const settings = {
    unique: cl(saved.unique, 0, 1, RANDOM_DEFAULTS.unique),
    run: cl(saved.run, -1, 1, RANDOM_DEFAULTS.run),
    triad: cl(saved.triad, 0, 1, RANDOM_DEFAULTS.triad),
    durBias: cl(saved.durBias, -1, 1, RANDOM_DEFAULTS.durBias),
    accentBias: cl(saved.accentBias, -1, 1, RANDOM_DEFAULTS.accentBias),
    durSort: saved.durSort === true,       // false = steer generation (default), true = post-hoc sort
    accentSort: saved.accentSort === true,
    range: Math.round(cl(saved.range, 0, 24, RANDOM_DEFAULTS.range)), // 0 = unlimited, else 1..24 scale degrees
  };

  const src = library.current();
  const srcDurs = src.columns.map((c) => c.durIndex);   // the grid's groove: rhythm…
  const srcAccents = src.columns.map((c) => c.accent | 0); // …accents…
  const srcArtics = src.columns.map((c) => (c.artic == null ? DEFAULT_ARTIC : c.artic)); // …articulations — kept; only pitches randomize
  const rhythmVaries = new Set(srcDurs).size > 1;     // Duration Bias only matters if durations differ
  const accentsVary = new Set(srcAccents).size > 1;   // Accent Bias only matters if accents differ
  const width = src.columns.length;
  const tctx = { tuningId: src.tuningId, scaleId: src.scaleId, root: src.root };

  // Snapshots. inplace: restore the current pattern's columns on Cancel + push one
  // undo step on Accept. new: mint a pattern, restore library identity on Cancel.
  const beforeJSON = JSON.stringify(src.toJSON());
  const prev = { currentName: library.currentName, parkedName: library.parkedName, counter: library.counter };
  let genPattern = null;
  let accepted = false;

  // In-modal back/redo: an ephemeral linear stack of { columns, settings } snapshots.
  // Every Randomize (incl. the auto-roll = state 0) pushes; ‹ / › restore a snapshot's
  // pattern AND settings; a fresh roll truncates the forward history. Reset and plain
  // slider/checkbox moves don't touch it. Session-scoped (fresh each open); soft cap.
  const HIST_CAP = 500;
  const hist = [];
  let histIdx = -1;
  let backBtn = null, fwdBtn = null;
  const captureState = () => ({ columns: JSON.parse(JSON.stringify(target().columns)), settings: { ...settings } });
  function pushState() {
    hist.length = histIdx + 1;       // drop any forward (redo) history
    hist.push(captureState());
    while (hist.length > HIST_CAP) hist.shift();
    histIdx = hist.length - 1;
    updateNavButtons();
  }
  function restoreState(i) {
    if (i < 0 || i >= hist.length) return;
    histIdx = i;
    const st = hist[i];
    Object.assign(settings, st.settings);         // sliders/checkboxes → this snapshot's settings
    for (const s of sliders) { s.input.value = String(settings[s.key]); s.show(); }
    for (const c of checkboxes) c.input.checked = !!settings[c.key];
    target().columns = JSON.parse(JSON.stringify(st.columns)); // pattern → this snapshot's pitches
    refresh();
    updateNavButtons();
  }
  function updateNavButtons() {
    if (backBtn) backBtn.disabled = histIdx <= 0;
    if (fwdBtn) fwdBtn.disabled = histIdx >= hist.length - 1;
  }

  // The pattern the roll writes into: the current one (in place), or a lazily-minted new one.
  const target = () => {
    if (mode !== 'new') return src;
    if (!genPattern) {
      genPattern = library.newPattern();
      if (genPattern) { genPattern.tuningId = tctx.tuningId; genPattern.scaleId = tctx.scaleId; genPattern.root = tctx.root; }
    }
    return genPattern;
  };

  const body = document.createElement('div');
  body.className = 'delay-editor rand-editor';

  // Slider rows. Each: label, range input, live value readout — plus, for the bias
  // rows, a "Sort" checkbox choosing the mechanism (off = steer generation so Run/Triad
  // survive; on = post-hoc re-pair, stronger but scrambles arpeggios). Nothing but
  // Randomize (and the ‹ › history nav) ever touches the grid — a setting change just
  // stages the next roll.
  const sliders = [];
  const checkboxes = [];
  const row = (label, min, max, key, fmt, title, enabled = true, disabledNote = '(uniform rhythm)', sortKey = null) => {
    const r = document.createElement('div');
    r.className = 'delay-row' + (enabled ? '' : ' rand-disabled');
    const l = document.createElement('span');
    l.className = 'delay-label'; l.textContent = label; if (title) r.title = title;
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = '0.01';
    input.value = String(settings[key]);
    input.disabled = !enabled;
    const val = document.createElement('span');
    val.className = 'delay-val';
    const show = () => { val.textContent = enabled ? fmt(settings[key]) : disabledNote; };
    input.addEventListener('input', () => { settings[key] = +input.value; show(); });
    show();
    r.append(l, input, val);
    if (sortKey) {
      const wrap = document.createElement('label');
      wrap.className = 'rand-sort';
      wrap.title = 'Sort: re-pair the finished pitches by this bias (stronger, but breaks Run/Triad arpeggios). Off = steer generation so those shapes survive.';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!settings[sortKey]; cb.disabled = !enabled;
      cb.addEventListener('change', () => { settings[sortKey] = cb.checked; }); // a plain setting — takes effect on the next Randomize
      const t = document.createElement('span'); t.textContent = 'Sort';
      wrap.append(cb, t);
      r.append(wrap);
      checkboxes.push({ key: sortKey, input: cb });
    }
    body.append(r);
    sliders.push({ key, input, show });
  };
  // Range: the pool size (distinct in-scale degrees, centered on the grid view).
  // Its own row — integer 0..24 with a note-name readout instead of a % — and it
  // rides `sliders` so Reset restores it. 0 (far left) = unlimited (one per note).
  {
    const r = document.createElement('div');
    r.className = 'delay-row';
    r.title = 'Range — the maximum number of distinct scale degrees the melody may use, centered on the grid view. Far left = unlimited (one degree per note). Fewer degrees than notes → pitches must repeat; more → a wider, gappier spread.';
    const l = document.createElement('span'); l.className = 'delay-label'; l.textContent = 'Range';
    const input = document.createElement('input');
    input.type = 'range'; input.min = '0'; input.max = '24'; input.step = '1'; input.value = String(settings.range);
    const val = document.createElement('span'); val.className = 'delay-val';
    const show = () => {
      if (!settings.range) { val.textContent = 'unlimited'; return; }
      const centroid = Math.round(state.topDegree - (state.visibleRows - 1) / 2);
      const w = scaleWindow({ count: settings.range, centroid, scaleId: tctx.scaleId, root: tctx.root, edo: edoOf(tctx.tuningId), bounds: degreeBounds(tctx.tuningId, tctx.root) });
      val.textContent = w.length ? `${degreeToName(w[0], tctx.tuningId)}–${degreeToName(w[w.length - 1], tctx.tuningId)}` : '—';
    };
    input.addEventListener('input', () => { settings.range = +input.value; show(); });
    show();
    r.append(l, input, val);
    body.append(r);
    sliders.push({ key: 'range', input, show });
  }
  row('Unique', 0, 1, 'unique', (v) => `${Math.round(v * 100)}%`,
    'How strictly pitches avoid repeating: 100% = never reuse a degree (a tone row); lower = repeats allowed.');
  row('Run', -1, 1, 'run', (v) => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`),
    'Stepwise-run tendency: 0 = none; toward + ascending runs, toward − descending; at the ends a single unbroken run.');
  row('Triad', 0, 1, 'triad', (v) => (v < 0.005 ? 'no effect' : v > 0.995 ? 'max' : `${Math.round(v * 100)}%`),
    'Harmonic bias: chance each note completes a triad (the Triadulator’s enabled families) with the two before it.');
  row('Duration Bias', -1, 1, 'durBias',
    (v) => (Math.abs(v) < 0.005 ? 'off' : `${v < 0 ? 'Low' : 'High'} ${Math.abs(v).toFixed(2)}`),
    'Bias longer notes toward lower (Low) or higher (High) pitches — e.g. Low puts the lowest pitches on the longest notes (a bass feel). Steers generation, so Run/Triad arpeggios survive; tick "Sort" to re-pair the finished pitches instead (stronger, but scrambles arpeggios). Disabled when every column shares a duration.',
    rhythmVaries, '(uniform rhythm)', 'durSort');
  row('Accent Bias', -1, 1, 'accentBias',
    (v) => (Math.abs(v) < 0.005 ? 'off' : `${v < 0 ? 'Low' : 'High'} ${Math.abs(v).toFixed(2)}`),
    'Bias the loudest-accented columns toward lower (Low) or higher (High) pitches (accents rank ghost < normal < accent by loudness). Steers generation, so Run/Triad arpeggios survive; tick "Sort" to re-pair the finished pitches instead. The accents themselves never move. Disabled when every column shares an accent level.',
    accentsVary, '(uniform accents)', 'accentSort');

  // Roll: random pitches over the SOURCE grid's per-column durations, every position a note.
  function doRandomize() {
    const t = target();
    if (!t) return;
    const edo = edoOf(tctx.tuningId);
    const families = familiesFor(edo).filter((id) => state.families[id]);
    const chordKeys = new Set(chordsFor(edo, families).map((x) => x.pcs.join(',')));
    const centroid = Math.round(state.topDegree - (state.visibleRows - 1) / 2);
    const beats = srcDurs.map((di) => DURATIONS[di].beats);
    // Each bias runs in one of two mechanisms (per its "Sort" checkbox): STEER = bake the
    // pull into generation (Run/Triad arpeggios survive) — passed to generateRandom as
    // `bias`; SORT = leave generation alone, re-pair the finished pitches afterward
    // (stronger, but scrambles contour). Both move only the NOTES; the groove stays put.
    const gen = generateRandom({
      count: width, centroid, scaleId: tctx.scaleId, root: tctx.root, edo,
      bounds: degreeBounds(tctx.tuningId, tctx.root), chordKeys, settings,
      bias: {
        durBias: settings.durSort ? 0 : settings.durBias,
        accentBias: settings.accentSort ? 0 : settings.accentBias,
        beats, accents: srcAccents,
      },
    });
    let degrees = settings.durSort ? applyDurationBias(gen, beats, settings.durBias) : gen.slice();
    if (settings.accentSort) degrees = applyAccentBias(degrees, srcAccents.slice(0, degrees.length), settings.accentBias);
    // Keep the grid's rhythm (durIndex per position); if the scale+range offered
    // fewer degrees than columns (tiny masks), the remainder stays rests.
    t.columns = [];
    for (let i = 0; i < width; i++) {
      const has = i < degrees.length;
      t.columns.push({
        durIndex: srcDurs[i], isRest: !has,
        degree: has ? degrees[i] : (degrees[degrees.length - 1] ?? BASE_PITCH),
        accent: srcAccents[i], artic: srcArtics[i], // keep the groove; only pitches change
      });
    }
    refresh();
    pushState(); // this roll (and its settings) becomes a history entry
  }

  // Play the previewed pattern once through the grid's audition patch.
  async function doAudition() {
    const t = mode === 'new' ? genPattern : src;
    if (!t) return;
    const score = t.toScore(state.bpm, state.articulation);
    const t0 = await engine.ensureRunning();
    const spb = 60 / state.bpm;
    for (const n of score.notes) {
      engine.playNote(n.pitch, t0 + 0.06 + n.start * spb, (n.artDur != null ? n.artDur : n.duration * state.articulation) * spb, n.velocity, n.freq, null);
    }
  }

  // Cancel: undo the preview. inplace → restore the current pattern's columns;
  // new → drop the minted pattern and restore the library identity.
  function revert() {
    if (mode === 'new') {
      if (!genPattern) return;
      library.patterns.delete(genPattern.name);
      library.currentName = prev.currentName;
      library.parkedName = prev.parkedName;
      library.counter = prev.counter;
      genPattern = null;
    } else {
      src.columns = Pattern.fromJSON(JSON.parse(beforeJSON), src.name).columns;
    }
    refresh();
  }

  const actions = document.createElement('div');
  actions.className = 'delay-row rand-actions';
  const mkbtn = (text, cls, title, fn) => {
    const b = document.createElement('button');
    b.className = cls; b.textContent = text; if (title) b.title = title;
    b.addEventListener('click', fn);
    actions.append(b);
    return b;
  };
  backBtn = mkbtn('‹', 'seg rand-nav', 'Back — recall the previous roll and its settings', () => restoreState(histIdx - 1));
  mkbtn('Randomize', 'seg', 'Generate (or re-generate) a candidate — previewed live on the grid', doRandomize);
  fwdBtn = mkbtn('›', 'seg rand-nav', 'Redo — the roll you backed over', () => restoreState(histIdx + 1));
  mkbtn('♪ Audition', 'seg', 'Play the previewed pattern once', doAudition);
  mkbtn('Reset', 'seg', 'Restore the sliders to their defaults', () => {
    Object.assign(settings, RANDOM_DEFAULTS);
    for (const s of sliders) { s.input.value = String(settings[s.key]); s.show(); }
    for (const c of checkboxes) c.input.checked = !!settings[c.key];
  });
  const spacer = document.createElement('span'); spacer.style.flex = '1';
  actions.append(spacer);
  mkbtn('Accept', 'stem-go', 'Keep this pattern', () => {
    accepted = true;
    if (mode !== 'new') ctx.pushHistory(beforeJSON); // in-place = one undo step back to the original
    modal.close();
  });
  mkbtn('Cancel', 'seg', 'Discard and restore the previous pattern', () => modal.close());
  body.append(actions);

  const modal = openModal({
    title: mode === 'new' ? 'New Random — New Pattern' : 'New Random Pattern',
    body,
    onClose: () => {
      ctx.safeSet(RAND_KEY, JSON.stringify(settings)); // settings persist across uses
      if (!accepted) revert();
    },
  });

  doRandomize(); // auto-roll a candidate on open, ready to audition
}

// --- Triadulator ------------------------------------------------------
//
// Propose traditional triads built from the pitch classes NOT yet used on the
// grid, place them as prospective (un-set) notes after the last placed note,
// rotate through alternatives, and Confirm to register them as real notes.

// What's currently triadulatable: the enabled state and the list of placeable
// triadulations (proper or partial, per the Proper toggle). The analysis is over
// the pattern's pitch classes (its tuning's EDO) regardless of grid height.
function triadulationState() {
  const pattern = library.current();
  if (!hasEquave(pattern.tuningId)) return { enabled: false, list: [] }; // no pitch-classes: no pc-set triads
  const cols = pattern.columns;
  const edo = edoOf(pattern.tuningId);
  const used = new Set();
  for (const c of cols) {
    if (!c.isRest) used.add(((c.degree % edo) + edo) % edo);
  }
  if (used.size < 3) return { enabled: false, list: [] };

  const remaining = [];
  for (let pc = 0; pc < edo; pc++) if (!used.has(pc)) remaining.push(pc);
  const families = familiesFor(edo).filter((id) => state.families[id]); // enabled families for this tuning
  const list = enumerateTriadulations(remaining, { proper: state.proper, families, edo });
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

// Degree ≡ pc (mod edo) closest to `centroid`: centers the proposal in the
// register of the placed notes, and (on a multi-octave grid) picks the inversion.
function nearestDegreeForPC(pc, centroid, edo) {
  const base = Math.round(centroid);
  const off = ((((base - pc) % edo) + edo) % edo);
  const d = base - off; // largest degree <= base with this pitch class
  return Math.abs(d - centroid) <= Math.abs(d + edo - centroid) ? d : d + edo;
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
  const edo = edoOf(library.current().tuningId);
  return pcs.map((pc, k) => ({ col: startCol + k, degree: nearestDegreeForPC(pc, centroid, edo), durIndex }));
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
  if (sig === triadSig && ctx.proposal.length) {
    triadIdx = (triadIdx + 1) % st.list.length; // rotate; wraps to the beginning
  } else {
    triadIdx = 0;
    triadSig = sig;
  }
  triadList = st.list;
  ctx.proposal = proposalColumns(st.list[triadIdx]);
  grid.setProspective(ctx.proposal);
  refresh();
}

// Register the prospective notes as if hand-placed (one undo entry, marks dirty).
function confirmTriadulation() {
  if (!ctx.proposal.length) return;
  const before = ctx.curSnap();
  const cols = library.current().columns;
  for (const p of ctx.proposal) cols[p.col] = { durIndex: p.durIndex, isRest: false, degree: p.degree, accent: 0, artic: DEFAULT_ARTIC };
  ctx.pushHistory(before);
  clearProposal();
  arrangement.clearSelection();
  refresh();
}

function clearProposal() {
  ctx.proposal = [];
  triadList = [];
  triadIdx = -1;
  triadSig = null;
  grid.setProspective([]);
}

function updateTriadulateButtons() {
  const st = triadulationState();
  // Stay enabled while a proposal shows so you can keep rotating.
  tb.triadBtn.disabled = !(st.enabled || ctx.proposal.length);
  tb.confirmBtn.disabled = ctx.proposal.length === 0;
  tb.triadBtn.textContent = (ctx.proposal.length && triadList.length)
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
  // Set Reference reads the tile-player selection, but setActive('grid') below
  // clears it — so snapshot it first.
  const refTiles = what === 'setRef' ? ctx.selectedTiles() : null;
  setActive('grid'); // the toolbar belongs to the grid pane
  switch (what) {
    case 'undo': ctx.undo(); return;
    case 'redo': ctx.redo(); return;
    case 'new': newOrRestore(); return;
    case 'clone': clonePattern(); return;
    case 'random': openRandomModal(); return;
    case 'clear': clearPattern(); return;
    case 'triadulate': triadulate(); return;
    case 'confirmTriad': confirmTriadulation(); return;
    case 'proper': case 'family': clearProposal(); refresh(); return; // re-triadulate in the new mode/families
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
  updateTriadulateButtons();
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
  ctx.safeSet(PROJ_KEY, JSON.stringify({ name: projectName, snapshot: savedSnapshot }));
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
  arrangement.clearSelection();
  // Opening a FILE: any lane whose patch origin isn't in this catalog came from
  // elsewhere → mark it imported (`[I]`, offers "add to your catalog?"). Resolvable
  // origins clear the flag. (Autosave reload doesn't run here, so an in-session
  // delete's `Name*` survives a normal reload — only a file Open mints `[I]`.)
  for (const l of arrangement.lanes) l.patchImported = !patches.get(l.patchOriginId);

  if (env.tempo) {
    state.bpm = env.tempo;
    tempo.value = state.bpm;
    tempoLabel.textContent = `${state.bpm} BPM`;
  }

  ctx.histories.clear();
  ctx.arrPast.length = 0;
  ctx.arrFuture.length = 0;
  clearProposal();
  grid.clearSelection();
  // A reference points into THIS session's arrangement — a fresh document clears it
  // (a workspace pref, so it survives a plain reload but not an Open/New).
  if (state.reference) { state.reference = null; state.mode = state.refPrevMode || 'grid'; state.refPrevMode = null; syncReference(); }
  ctx.ensureTileStarts(); // derive positions for tiles loaded from an old gapless file
  centerGridOn(library.current()); // bring the loaded pattern into view
  ctx.activePane = 'grid';
  state.activePane = 'grid';
  state.playheadBeat = 0; // fresh document — park the playhead at the top
  tilePlayer.setPlayhead(0);
  applyActiveHighlight();
  gridInstr = { source: 'grid' }; state.gridInstr = null; setParkedInstr(null); // fresh document → grid's own instrument
  editGrid(); // the loaded lanes have fresh patch objects; re-point the editor
  engine.resetLanes(); // drop stale strips (old delay tails / orphaned lanes) — rebuild fresh
  applyLaneMix(0);     // push the loaded volume/pan onto the lane buses
  applyLaneDelayAll(); // and the loaded delays
  applyLaneChorusAll(); // and the loaded choruses
  applyLaneReverbAll();  // and the loaded reverbs
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
  ctx.stop();
  loadContent(env);
  projectName = env.name || file.name.replace(/\.json$/i, '');
  markClean();
}

function newProject() {
  if (dirty && !confirm('You have unsaved changes. Start a new project and discard them?')) return;
  ctx.stop();
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
      for (const tile of lane.tiles) {
        const p = library.patterns.get(tile.name);
        if (!p) continue;
        const s = p.toScore(state.bpm, state.articulation);
        for (const n of s.notes) {
          notes.push({
            pitch: n.pitch,
            startBeat: n.start + tile.start,
            durBeats: n.artDur != null ? n.artDur : n.duration * state.articulation,
            velocity: n.velocity,
          });
        }
      }
      return { name: `Lane ${i + 1}`, notes };
    })
    .filter((tr) => tr.notes.length > 0);
  if (!tracks.length) return;
  const bytes = notesToMidi(tracks, state.bpm, { tpqn: 480 });
  downloadBytes(`${projectName || defaultName()}.mid`, bytes, 'audio/midi');
}

// Export the tile-player arrangement to a WAV file: render the whole arrangement
// (one pass, mute/solo respected, articulation applied) through the Vesperia via
// an OfflineAudioContext, plus a release tail, then encode + download. Faster
// than realtime; an indeterminate "Rendering…" bar shows while it works (offline
// rendering has no portable progress event — Firefox lacks `suspend()`).
// Mixdown to a single stereo WAV. `opts` (all optional; Quick Export passes none):
//   sampleRate  render rate in Hz (default 48000)
//   startBeat   region start; notes triggering before it are dropped (default 0)
//   endBeat     region end; notes at/after it are dropped (default project end)
//   tailSec     ring-out after the region end (default computeTail())
// The region is always shifted so its start is file time 0 (a mixdown has no
// notion of an offset — plain WAV, no BWF metadata).
ctx.exporting = false;
async function exportAudio(opts = {}) {
  if (ctx.exporting || arrangement.allTiles().length === 0) return;
  const score = ctx.arrangementScore();
  const spb = 60 / state.bpm;
  const sampleRate = opts.sampleRate || 48000;
  const startBeat = opts.startBeat || 0;
  const endBeat = opts.endBeat != null ? opts.endBeat : score.lengthBeats;
  const tail = opts.tailSec != null ? opts.tailSec : ctx.computeTail();
  const notes = [];
  for (const n of score.notes) {
    if (n.muted) continue; // silenced lanes (mute / solo) aren't rendered
    if (n.start < startBeat || n.start >= endBeat) continue; // outside the export range
    notes.push({
      pitch: n.pitch,
      time: (n.start - startBeat) * spb, // shift region start to file time 0
      duration: (n.artDur != null ? n.artDur : n.duration * state.articulation) * spb,
      velocity: n.velocity,
      freq: n.freq,
      laneId: n.laneId, // render through this lane's instrument patch
    });
  }
  if (!notes.length) return;
  const durSec = (endBeat - startBeat) * spb + tail;

  setExporting(true);
  try {
    const buffer = await engine.renderToBuffer(notes, durSec, sampleRate);
    downloadBytes(`${projectName || defaultName()}.wav`, encodeWav(buffer), 'audio/wav');
  } catch (err) {
    alert(`Audio export failed: ${err.message}`);
  } finally {
    setExporting(false);
  }
}

// Quick Export and Export Audio… share the `exporting` flag, so both disable and
// read "Rendering…" while a mixdown runs.
function setExporting(on) {
  ctx.exporting = on;
  exportProgEl.classList.toggle('on', on);
  const haveTiles = arrangement.allTiles().length > 0;
  quickExportBtn.textContent = on ? 'Rendering…' : 'Quick Export';
  quickExportBtn.disabled = on || !haveTiles;
  audioExportBtn.textContent = on ? 'Rendering…' : 'Export Audio…';
  audioExportBtn.disabled = on || !haveTiles;
}

// Make a string safe as a filename across OSes (no \ / : * ? " < > |, no control
// chars, trimmed of trailing dots/spaces). Empty falls back to 'Track'.
function safeFileName(s) {
  const out = String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return out || 'Track';
}

// Export the arrangement as STEMS: one BWF (Broadcast Wave) per lane, bundled in
// a zip. Every lane with notes is rendered (mute/solo ignored — you mute in the
// DAW), all sharing one length + TimeReference 0 so they import aligned. The
// bus mode (how much of the lane strip is baked in) is chosen in the dialog.
// `opts`: busMode ('dry'|'postfader'|'baked'), sampleRate, startBeat, endBeat,
// tailSec (as exportAudio), plus timeRefSamples — the BWF TimeReference written
// into every stem. 0 = "region start is time 0" (stems align to each other);
// a nonzero value = the region's absolute sample offset, so the DAW re-places the
// set at its true project position on Import-at-Origin.
ctx.exportingStems = false;
async function exportStems(opts = {}) {
  if (ctx.exportingStems || arrangement.allTiles().length === 0) return;
  const busMode = opts.busMode || 'dry';
  const score = ctx.arrangementScore();
  const spb = 60 / state.bpm;
  const sampleRate = opts.sampleRate || 48000;
  const startBeat = opts.startBeat || 0;
  const endBeat = opts.endBeat != null ? opts.endBeat : score.lengthBeats;
  const tail = opts.tailSec != null ? opts.tailSec : ctx.computeTail();
  const timeRefSamples = opts.timeRefSamples != null ? opts.timeRefSamples : 0;
  // Group each lane's in-range notes (ignore n.muted: stems include muted lanes),
  // shifting the region start to file time 0.
  const byLane = new Map();
  for (const n of score.notes) {
    if (n.start < startBeat || n.start >= endBeat) continue;
    let arr = byLane.get(n.laneId);
    if (!arr) { arr = []; byLane.set(n.laneId, arr); }
    arr.push({
      pitch: n.pitch, time: (n.start - startBeat) * spb, duration: (n.artDur != null ? n.artDur : n.duration * state.articulation) * spb,
      velocity: n.velocity, freq: n.freq, laneId: n.laneId,
    });
  }
  if (byLane.size === 0) return;
  // One shared duration (region length + tail) so all stems are equal-length.
  const durSec = (endBeat - startBeat) * spb + tail;
  const proj = projectName || defaultName();

  setExportingStems(true);
  try {
    const now = new Date();
    const used = new Set();
    const files = [];
    for (let li = 0; li < arrangement.lanes.length; li++) {
      const lane = arrangement.lanes[li];
      const notes = byLane.get(lane.id);
      if (!notes || !notes.length) continue;   // skip empty lanes
      const buffer = await engine.renderStem(notes, durSec, lane.id, busMode, sampleRate);
      const label = instrument(lane.patch && lane.patch.kind).label;
      let base = safeFileName(`${String(li + 1).padStart(2, '0')} ${label}`);
      let name = base, k = 2;                   // de-dup same-instrument lanes
      while (used.has(name.toLowerCase())) name = `${base} (${k++})`;
      used.add(name.toLowerCase());
      const meta = {
        description: `${proj} - lane ${li + 1} (${label})`,
        originator: 'Notorolla', date: now, timeReferenceSamples: timeRefSamples,
      };
      files.push({ name: `${name}.wav`, bytes: encodeBwf(buffer, meta) });
    }
    if (!files.length) return;
    downloadBytes(`${safeFileName(proj)}-stems.zip`, zipStore(files, now), 'application/zip');
  } catch (err) {
    alert(`Stem export failed: ${err.message}`);
  } finally {
    setExportingStems(false);
  }
}

function setExportingStems(on) {
  ctx.exportingStems = on;
  exportProgEl.classList.toggle('on', on);
  stemExportBtn.textContent = on ? 'Rendering…' : 'Export Stems…';
  stemExportBtn.disabled = on || arrangement.allTiles().length === 0;
}

// Build the shared rate / range / tail controls into `body` (appends a .export-sec).
// Returns accessors the dialog reads on Export, plus onRange(fn) so a caller can
// react to the range choice (the stems dialog uses it to reveal the align option).
function exportRangeControls(body) {
  const sec = document.createElement('div');
  sec.className = 'export-sec';

  // Sample rate — default 48 kHz, independent of the live device rate.
  const rateRow = document.createElement('div'); rateRow.className = 'export-row';
  const rateLbl = document.createElement('span'); rateLbl.className = 'export-lbl'; rateLbl.textContent = 'Sample rate';
  const rateSel = document.createElement('select');
  for (const [v, t] of [[44100, '44.1 kHz'], [48000, '48 kHz'], [96000, '96 kHz']]) {
    const o = document.createElement('option'); o.value = String(v); o.textContent = t; if (v === 48000) o.selected = true; rateSel.append(o);
  }
  rateRow.append(rateLbl, rateSel); sec.append(rateRow);

  // Range — whole project vs the marked region (offered only when markers narrow it).
  const startBeat = ctx.playStartBeat();
  const endBeat = ctx.playEndBeat();
  const fullEnd = ctx.arrangementEndBeat();
  const markersSet = startBeat > 0 || endBeat < fullEnd;
  let rangeChoice = 'entire';
  const rangeCbs = [];
  const rangeWrap = document.createElement('div'); rangeWrap.className = 'export-range';
  const mkRange = (id, text, detail, disabled) => {
    const lab = document.createElement('label');
    if (disabled) lab.className = 'disabled';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'exportRange'; radio.value = id; radio.disabled = !!disabled;
    if (id === 'entire') radio.checked = true;
    radio.addEventListener('change', () => { if (radio.checked) { rangeChoice = id; rangeCbs.forEach((f) => f(id)); } });
    const span = document.createElement('span'); span.textContent = text;
    if (detail) { const d = document.createElement('span'); d.className = 'export-range-detail'; d.textContent = detail; span.append(' ', d); }
    lab.append(radio, span);
    return lab;
  };
  rangeWrap.append(mkRange('entire', 'Entire project', `(end beat ${+fullEnd.toFixed(2)} · ${ctx.fmtClock(fullEnd)})`, false));
  const markerDetail = markersSet
    ? `Start beat ${+startBeat.toFixed(2)} (${ctx.fmtClock(startBeat)}) — End beat ${+endBeat.toFixed(2)} (${ctx.fmtClock(endBeat)})`
    : '(no markers set)';
  rangeWrap.append(mkRange('markers', 'Between markers', markerDetail, !markersSet));
  const rangeRow = document.createElement('div'); rangeRow.className = 'export-row';
  const rangeLbl = document.createElement('span'); rangeLbl.className = 'export-lbl'; rangeLbl.textContent = 'Range';
  rangeRow.append(rangeLbl, rangeWrap); sec.append(rangeRow);

  // Tail (seconds) — pre-filled with the computed default; free to override up or down.
  const tailRow = document.createElement('div'); tailRow.className = 'export-row';
  const tailLbl = document.createElement('span'); tailLbl.className = 'export-lbl'; tailLbl.textContent = 'Tail (sec)';
  const tailInput = document.createElement('input');
  tailInput.type = 'number'; tailInput.min = '0'; tailInput.step = '0.5'; tailInput.value = String(+ctx.computeTail().toFixed(1));
  tailRow.append(tailLbl, tailInput); sec.append(tailRow);

  body.append(sec);

  return {
    startBeat, markersSet,
    readRate: () => parseInt(rateSel.value, 10) || 48000,
    readRange: () => (rangeChoice === 'markers' ? { startBeat, endBeat } : { startBeat: 0, endBeat: null }),
    readTail: () => { const v = parseFloat(tailInput.value); return isFinite(v) && v >= 0 ? v : ctx.computeTail(); },
    onRange: (fn) => rangeCbs.push(fn),
  };
}

// The Export Audio… dialog: rate / range / tail, then a single-file mixdown.
function openAudioModal() {
  if (ctx.exporting || arrangement.allTiles().length === 0) return;
  const body = document.createElement('div');
  body.className = 'stem-export';
  const intro = document.createElement('p');
  intro.className = 'stem-intro';
  intro.textContent = 'Render the arrangement to a single stereo WAV. The export always begins at time 0.';
  body.append(intro);

  const ctrls = exportRangeControls(body);

  const actions = document.createElement('div');
  actions.className = 'stem-actions';
  const go = document.createElement('button');
  go.className = 'stem-go'; go.textContent = 'Export';
  go.addEventListener('click', () => {
    modal.close();
    const r = ctrls.readRange();
    exportAudio({ sampleRate: ctrls.readRate(), startBeat: r.startBeat, endBeat: r.endBeat, tailSec: ctrls.readTail() });
  });
  actions.append(go);
  body.append(actions);

  const modal = openModal({ title: 'Export Audio', body });
}

// The stem-export dialog: pick the bus mode + rate/range/tail, then render. Dry default.
const STEM_MODES = [
  { id: 'dry', label: 'Dry — pre-insert, pre-fader',
    desc: 'Voice only: no volume, pan, chorus or delay. The driest stems — process them in the DAW.' },
  { id: 'postfader', label: 'Post-fader — pre-limiter',
    desc: 'Volume, pan, chorus & delay baked in; the master limiter is left off, so stems sum back to the mix.' },
  { id: 'baked', label: 'Fully baked — incl. limiter',
    desc: 'As post-fader, plus the master limiter. Each stem sounds as it does soloed in the mix, but stems no longer sum exactly.' },
];
function openStemModal() {
  if (ctx.exportingStems || arrangement.allTiles().length === 0) return;
  const body = document.createElement('div');
  body.className = 'stem-export';
  const intro = document.createElement('p');
  intro.className = 'stem-intro';
  intro.textContent = 'One Broadcast Wave (BWF) per lane, bundled in a zip — all equal-length and aligned. Choose how much of each lane’s strip to bake in:';
  body.append(intro);

  let chosen = 'dry';
  for (const m of STEM_MODES) {
    const row = document.createElement('label');
    row.className = 'stem-mode';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'stemMode'; radio.value = m.id;
    if (m.id === chosen) radio.checked = true;
    radio.addEventListener('change', () => { if (radio.checked) chosen = m.id; });
    const text = document.createElement('div');
    text.className = 'stem-mode-text';
    const t = document.createElement('div'); t.className = 'stem-mode-label'; t.textContent = m.label;
    const d = document.createElement('div'); d.className = 'stem-mode-desc'; d.textContent = m.desc;
    text.append(t, d);
    row.append(radio, text);
    body.append(row);
  }

  const ctrls = exportRangeControls(body);

  // "Treat Start marker as time 0" — only meaningful for a marker range starting
  // past beat 0. Checked → TimeReference 0 (each stem is its own clip at zero);
  // unchecked → TimeReference = the region's absolute sample offset, so the set
  // re-lands at its project position on Import-at-Origin.
  const alignWrap = document.createElement('div');
  const alignLab = document.createElement('label'); alignLab.className = 'export-check';
  const alignBox = document.createElement('input'); alignBox.type = 'checkbox'; alignBox.checked = true;
  const alignText = document.createElement('span'); alignText.textContent = 'Treat Start marker as time 0';
  alignLab.append(alignBox, alignText);
  const alignDesc = document.createElement('p'); alignDesc.className = 'export-check-desc';
  alignDesc.textContent = 'Off: stamp each stem’s BWF TimeReference with the marker’s offset, so the set re-lands at its project position on Import-at-Origin.';
  alignWrap.append(alignLab, alignDesc);
  body.append(alignWrap);
  const syncAlign = (id) => { alignWrap.style.display = (id === 'markers' && ctrls.startBeat > 0) ? '' : 'none'; };
  ctrls.onRange(syncAlign); syncAlign('entire');

  const actions = document.createElement('div');
  actions.className = 'stem-actions';
  const go = document.createElement('button');
  go.className = 'stem-go'; go.textContent = 'Export';
  go.addEventListener('click', () => {
    modal.close();
    const r = ctrls.readRange();
    const rate = ctrls.readRate();
    const spb = 60 / state.bpm;
    // Region-to-zero (checked, or no offset) → TimeReference 0; else the region's
    // absolute sample offset at the chosen rate.
    const timeRefSamples = (!alignBox.checked && r.startBeat > 0) ? Math.round(r.startBeat * spb * rate) : 0;
    exportStems({ busMode: chosen, sampleRate: rate, startBeat: r.startBeat, endBeat: r.endBeat, tailSec: ctrls.readTail(), timeRefSamples });
  });
  actions.append(go);
  body.append(actions);

  const modal = openModal({ title: 'Export Stems', body });
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
  if (!ctx.storageOK) { e.preventDefault(); e.returnValue = ''; }
});

// If the saved baseline predates a per-lane field (patch, gain, pan), fold the
// auto-added defaults/migrated values into it so a silent upgrade doesn't flag
// the project dirty. Only those absent fields are absorbed — real unsaved
// tile/note work still shows dirty.
if (savedSnapshot) {
  try {
    const base = JSON.parse(savedSnapshot);
    if (base.arr && base.arr.lanes) {
      const live = new Map(arrangement.lanes.map((l) => [l.id, l]));
      let changed = false;
      for (const bl of base.arr.lanes) {
        const ll = live.get(bl.id);
        if (!ll) continue;
        if (bl.patch == null) { bl.patch = ll.patch; changed = true; }
        if (bl.gain == null) { bl.gain = ll.gain; changed = true; }
        if (bl.pan == null) { bl.pan = ll.pan; changed = true; }
        if (bl.delay == null) { bl.delay = ll.delay; changed = true; }
        if (bl.chorus == null) { bl.chorus = ll.chorus; changed = true; }
        if (bl.reverb == null) { bl.reverb = ll.reverb; changed = true; }
        // Patch identity (originId/name/dirty) added this version — absorb the
        // migrated values so an existing project doesn't reload spuriously dirty.
        if (bl.patchOriginId == null) { bl.patchOriginId = ll.patchOriginId; bl.patchName = ll.patchName; bl.patchDirty = ll.patchDirty; changed = true; }
      }
      // Region markers (top-level arr fields) added in this version too.
      if (!('playStart' in base.arr)) { base.arr.playStart = arrangement.playStart; base.arr.playEnd = arrangement.playEnd; changed = true; }
      if (changed) { savedSnapshot = JSON.stringify(base); persistProjMeta(); }
    }
  } catch { /* malformed baseline — fall through to the recompute below */ }
}

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
const phHomeBtn = document.getElementById('phHome');
const phEndBtn = document.getElementById('phEnd');
const tempo = document.getElementById('tempo');
const tempoLabel = document.getElementById('tempoLabel');
const arrUndoBtn = document.getElementById('arrUndo');
const arrRedoBtn = document.getElementById('arrRedo');
const tileDeleteBtn = document.getElementById('tileDelete');
const midiExportBtn = document.getElementById('midiExport');
const quickExportBtn = document.getElementById('quickExport');
const audioExportBtn = document.getElementById('audioExport');
const stemExportBtn = document.getElementById('stemExport');
const exportProgEl = document.getElementById('exportProg');
const gridName = document.getElementById('gridName');

midiExportBtn.addEventListener('click', exportMidi);
quickExportBtn.addEventListener('click', () => exportAudio()); // one-click defaults
audioExportBtn.addEventListener('click', openAudioModal);
stemExportBtn.addEventListener('click', openStemModal);
document.getElementById('resetPlayer').addEventListener('click', resetPlayer);



arrUndoBtn.addEventListener('click', ctx.arrUndo);
arrRedoBtn.addEventListener('click', ctx.arrRedo);

tb.grabHandle.addEventListener('dragstart', (e) => {
  e.dataTransfer.setData('text/plain', 'pattern');
  e.dataTransfer.effectAllowed = 'copy';
});
// dragend always fires (drop or cancel) — the one reliable point to clear the
// grid-drag landing preview.
tb.grabHandle.addEventListener('dragend', () => ctx.clearGridDragPreview());


// Deselect (Select None) for the active pane.
function selectNone() {
  if (ctx.activePane === 'tiles') ctx.deselectTile();
  else grid.clearSelection();
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
  const tiles = ctx.activePane === 'tiles';
  const typing = tag === 'textarea' || (tag === 'input' && e.target.type !== 'range' && e.target.type !== 'file');

  // Space / Shift+Space = transport for the active pane, and ONLY transport — it
  // never lets a focused button or select swallow the key. Plain space toggles
  // play/stop; Shift+space starts the loop and each press adds passes; plain space
  // stops it.
  if (e.key === ' ' && !mod && !typing) {
    e.preventDefault();
    const src = tiles ? 'tiles' : 'grid';
    if (e.shiftKey) {
      ctx.loopClick(src);
      flash(src === 'tiles' ? tileLoopBtn : loopBtn);
    } else if (scheduler.isPlaying) {
      const playing = ctx.activeSource;
      ctx.stop();
      flash(playing === 'tiles' ? tileStopBtn : stopBtn);
    } else {
      ctx.startTransport(src, false);
      flash(src === 'tiles' ? tilePlayBtn : playBtn);
    }
    return;
  }

  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const k = e.key.toLowerCase();

  if (e.key === 'Escape') {
    // (a range drag or marquee in progress owns Esc via its capture listener)
    if (ctx.rangeMode) { ctx.disarmRangeTool(); return; }
    selectNone(); return;
  }

  if (mod && k === 'z') { // undo / shift = redo
    e.preventDefault();
    if (e.shiftKey) { (tiles ? ctx.arrRedo : ctx.redo)(); flash(tiles ? arrRedoBtn : tb.redoBtn); }
    else { (tiles ? ctx.arrUndo : ctx.undo)(); flash(tiles ? arrUndoBtn : tb.undoBtn); }
    return;
  }
  if (mod && k === 'a') { e.preventDefault(); if (!tiles) grid.selectAll(); return; } // no Select-All button
  if (mod && k === 'd') { e.preventDefault(); selectNone(); return; }                 // no Select-None button
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (tiles) {
      if (arrangement.selectedIds.size) { e.preventDefault(); ctx.deleteSelectedTile(); flash(tileDeleteBtn); }
    } else {
      e.preventDefault();
      grid.deleteSelection(); // selected notes -> rests (no toolbar button)
    }
    return;
  }
  // Tile-player playhead (stopped transport only): B/E park it at the
  // beginning/end; ArrowRight resumes playback from wherever it's parked.
  if (tiles && !mod && !scheduler.isPlaying) {
    if (k === 'b') { ctx.movePlayhead(ctx.playStartBeat()); flash(phHomeBtn); return; }
    if (k === 'e') { ctx.movePlayhead(ctx.playEndBeat()); flash(phEndBtn); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); ctx.resumePlay(); flash(tilePlayBtn); return; }
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !tiles) {
    e.preventDefault(); // scale-step within the active mask; Shift = a literal octave (equave)
    const up = e.key === 'ArrowUp';
    if (e.shiftKey) { const eq = equaveOf(library.current().tuningId); if (eq != null) grid.transpose((up ? 1 : -1) * eq); } // no equave → no octave jump
    else grid.transposeScalar(up ? 1 : -1);
    flash(up ? tb.transUpBtn : tb.transDownBtn);
  }
});

// --- initial paint ----------------------------------------------------

ctx.ensureTileStarts(); // derive positions for tiles restored from an old gapless autosave
grid.updateCursor();
applyActiveHighlight();
ctx.updateScaleStrip();
// Phase-5 controllers. Order matters: tileops registers ctx.selectedTiles etc.
// that the others use; tileinspector creates its pane (kept after the catalog, so
// stacking is unchanged) and registers ctx.refreshTileInspector; transformbar
// builds the bar at its tail, which reads both.
initTileops(ctx);
initTileinspector(ctx);
initTransformbar(ctx);
refresh(); // selection starts empty (runtime-only, not persisted)
// The parked playhead is always visible — restore it (clamped: the arrangement
// may have shrunk since it was persisted).
state.playheadBeat = ctx.clampPlayhead(state.playheadBeat);
tilePlayer.setPlayhead(state.playheadBeat);
// Restore the tile player's scroll (after the render above built the content;
// the browser clamps if the arrangement shrank).
document.getElementById('tileLane').scrollLeft = state.tileScrollX || 0;




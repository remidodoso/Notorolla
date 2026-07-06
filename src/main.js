// main.js — wire model, audio, scheduler, grid, roll, tiles, toolbar, panes.

import { AudioEngine, FREF } from './audio.js';
import { Scheduler } from './scheduler.js';
import { PianoRoll, ROLL_V_SCALES, ROLL_H_SCALES, ROLL_V_DEFAULT, ROLL_H_DEFAULT } from './pianoroll.js';
import { Note, Score } from './model.js';
import { Pattern, BASE_PITCH, DURATIONS, DEFAULT_ARTIC } from './grid.js';
import { PatternLibrary, Arrangement, laneColor, insertPoint, deletePoint } from './library.js';
import { enumerateTriadulations, familiesFor, familyLabel, chordsFor } from './triads.js';
import { generateRandom, applyDurationBias, applyAccentBias, scaleWindow, RANDOM_DEFAULTS } from './random.js';
import { edoOf, tuningFreq, pitchClassName, degreeBounds, nearestDegreeToFreq, degreeToName, TUNING_LIST } from './tuning.js';
import { scalesFor, scaleValidForEdo, scaleById } from './scales.js';
import { notesToMidi } from './midi.js';
import { encodeWav, encodeBwf } from './wav.js';
import { zipStore } from './zip.js';
import { GridView } from './gridview.js';
import { TilePlayer, TILE_SCALES, DEFAULT_SCALE_IDX } from './tileplayer.js';
import { buildToolbar } from './toolbar.js';
import { buildInstrumentPane } from './instrumentpane.js';
import { normalizePatch, defaultPatch, clonePatch, patchRelease, instrument, instrumentKinds } from './instrument.js';
import { PatchStore, factoryInitId } from './patches.js';
import { createCatalog } from './catalog.js';
import { normalizeDelay } from './delay.js';
import { buildDelayEditor } from './delay.js';
import { normalizeChorus, buildChorusEditor } from './chorus.js';
import { normalizeReverb, buildReverbEditor, reverbSeconds } from './reverb.js';
import { MOD_SLOTS, defaultMod, buildModEditor, modTargetsFor, modsActive, normalizeModsByKind } from './mods.js';
import { applyTransforms, setTileTranspose, setTileReverse, hasReverse, describeTransform, transformKindLabel, normalizeTransforms } from './transforms.js';
import { openModal } from './modal.js';
import { createInspector } from './inspector.js';
import { setupPanes } from './panes.js';
import { VERSION, buildEnvelope, validate, migrate, defaultName, downloadJSON, downloadBytes, readFile } from './project.js';

const LIB_KEY = 'notorolla.lib';
const ARR_KEY = 'notorolla.arr';
const UI_KEY = 'notorolla.ui';
const LAYOUT_KEY = 'notorolla.layout2';
const PROJ_KEY = 'notorolla.proj'; // { name, snapshot } — current project identity + last-saved content
const PATCH_KEY = 'notorolla.patch'; // legacy single global patch — seeds existing lanes on first load, then vestigial
const GRIDPATCH_KEY = 'notorolla.gridpatch'; // the grid's neutral audition patch (a workspace preference, not in the project)
const PATCHES_KEY = 'notorolla.patches'; // the user-global patch catalog (cross-project, not in any project file)
const GRIDMETA_KEY = 'notorolla.gridpatchmeta'; // the grid patch's identity (workspace pref, like the grid patch)
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
  showTriads: true,   // label chords found in adjacent notes (every family the tuning offers)
  proper: false,      // Triadulator: when on, only complete (no-leftover) triadulations
  families: { trad: true, sus: false, septimal: true }, // Triadulator: enabled chord families (per id)
  topDegree: 71,
  visibleRows: 12,
  activePane: 'grid', // 'grid' | 'tiles' — which pane the roll mirrors
  tileScaleIdx: DEFAULT_SCALE_IDX, // tile-player horizontal scale (view-only)
  masterGain: 0.9,    // master fader (0..1.4); applied live and to the export
  modLoop: false,     // global "Loop Mod": modulators on ruler time (reset each loop) vs elapsed
  lite: false,        // "Lite Instruments": cheaper live graph for the heavy voices (offline is always full)
  gridInstr: null,    // grid's active instrument: null = its own gridPatch, or { source:'lane', laneId } borrowed from a loaded tile
  parkedInstr: null,  // the instrument descriptor the parked pattern was using (restored with it)
  ripple: false,      // tile insert/delete ripple (off = exact placement, overwrite on overlap)
  playheadBeat: 0,    // where the tile transport is parked when stopped (beats, absolute)
  tileScrollX: 0,     // tile player's horizontal scroll (px; restored on reload as-is)
  rollVIdx: ROLL_V_DEFAULT, // piano-roll zoom notches (view-only)
  rollHIdx: ROLL_H_DEFAULT,
};
Object.assign(state, readJSON(UI_KEY) || {});
// Migrate older persisted UI state (top-level trad/sus booleans) to the per-id
// families map, and make sure the map exists and seeds new families on.
if (!state.families || typeof state.families !== 'object') {
  state.families = { trad: state.trad !== false, sus: !!state.sus, septimal: true };
}
if (state.families.septimal === undefined) state.families.septimal = true;
delete state.trad; delete state.sus;

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
engine.masterLevel = state.masterGain; // ensureRunning will apply it to the master node
engine.lite = state.lite;              // Lite Instruments (live only); read at every note-on

// Instrument patches now live per lane (lane.patch, saved with the project). The
// grid's click-to-hear / Test uses a separate neutral patch — a workspace
// preference kept out of the project (its own key, defaults to factory).
const gridPatch = normalizePatch(readJSON(GRIDPATCH_KEY));

// The user-global patch catalog (Phase B of §14): factory Init per kind + saved
// user patches. Cross-project (its own key), never part of a project file.
const patches = new PatchStore();
patches.loadUser(readJSON(PATCHES_KEY));
function persistPatches() { safeSet(PATCHES_KEY, JSON.stringify(patches.toJSON())); }

// The grid patch's identity (which catalog patch it derives from + dirty), a
// workspace preference like gridPatch itself. Defaults to its kind's Init.
let gridPatchMeta = readJSON(GRIDMETA_KEY);
if (!gridPatchMeta || gridPatchMeta.patchOriginId == null) {
  gridPatchMeta = { patchOriginId: factoryInitId(gridPatch.kind), patchName: 'Init', patchDirty: false, patchImported: false };
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
  if (activePane === 'grid') editGrid(); // re-point the pane at the new instrument
}

function setParkedInstr(desc) { parkedInstr = desc || null; state.parkedInstr = parkedInstr; }

// Overwrite the grid's own neutral patch in place with a copy of `src` (keeping
// the gridPatch object identity so editTarget/patchFor references stay valid).
// Used when Clone promotes a borrowed tile instrument to be the grid's own.
function replaceGridPatch(src) {
  const copy = clonePatch(src);
  for (const k of Object.keys(gridPatch)) delete gridPatch[k];
  Object.assign(gridPatch, copy);
  safeSet(GRIDPATCH_KEY, JSON.stringify(gridPatch));
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

// The longest reverb tail any lane needs at the end of a bounce (the IR decay
// + predelay of every enabled insert; 0 when none are on).
function maxReverbTail() {
  let tail = 0;
  for (const lane of arrangement.lanes) {
    if (lane.reverb && lane.reverb.on) tail = Math.max(tail, reverbSeconds(lane.reverb) + (lane.reverb.predelay || 0));
  }
  return tail;
}

const scheduler = new Scheduler(engine);
// Natural finish (one-shot ended, loop passes exhausted): the playhead rewinds
// to the beginning. A manual Stop parks it in place instead (see stop()).
scheduler.onEnded = () => {
  if (activeSource === 'tiles') {
    state.playheadBeat = playStartBeat();
    tilePlayer.setPlayhead(state.playheadBeat);
    ensureTileVisible(state.playheadBeat); // follow the rewind back into view
  }
  resumeBeat = null;
};
scheduler.onCycle = (score) => { roll.setScore(score); };

let activeSource = null; // 'grid' | 'tiles' | null — only one transport at a time

// Resume (ArrowRight): the FIRST pass of the play that's being armed runs from
// this beat instead of the region start; null = a normal from-the-top play.
// Self-clearing — see windowedArrangementScore.
let resumeBeat = null;
let resumeStartTime = 0; // the scheduler startTime a pending resume was armed for
// Display-side pass origin: the absolute beat the CURRENT pass began at. Equals
// the resume point during a resumed first pass, the region start otherwise;
// renderLoop flips it forward when the loop wraps.
let passBase = 0;
let lastCurBeat = 0;

// The grid's score, with any prospective Triadulator notes merged in so they
// play and audition like real notes (but stay un-set until Confirm).
function buildScore() {
  const cur = library.current();
  if (!proposal.length) return cur.toScore(state.bpm, state.articulation);
  const cols = cur.columns.map((c) => ({ ...c }));
  for (const p of proposal) cols[p.col] = { durIndex: p.durIndex, isRest: false, degree: p.degree, accent: 0, artic: DEFAULT_ARTIC };
  const tmp = new Pattern(cols, cur.name);
  tmp.tuningId = cur.tuningId; tmp.scaleId = cur.scaleId; tmp.root = cur.root; // resolve in the same tuning
  return tmp.toScore(state.bpm, state.articulation);
}

function patternLen(name) {
  const p = library.patterns.get(name);
  return p ? p.toScore(state.bpm, state.articulation).lengthBeats : 0;
}

// Old projects stored tiles gaplessly (no `start`); derive starts from the
// cumulative order so they open identically. No-op once tiles carry `start`.
function ensureTileStarts() {
  for (const lane of arrangement.lanes) {
    let acc = 0;
    for (const tile of lane.tiles) {
      if (tile.start == null) tile.start = acc;
      acc = tile.start + patternLen(tile.name);
    }
    lane.tiles.sort((a, b) => a.start - b.start);
  }
}

// Overlay all lanes in parallel (each from t=0) into one score; the length is
// the longest lane. Notes carry their lane color, dimmed for non-active lanes.
function arrangementScore() {
  const notes = [];
  let maxLen = 0;
  const audible = arrangement.audibleLaneIds(); // mute/solo: which lanes sound
  arrangement.lanes.forEach((lane, li) => {
    const color = laneColor(li);
    const alpha = lane.id === arrangement.activeLaneId ? 1 : 0.3; // focus dim
    const muted = !audible.has(lane.id);                          // silent → hatched, not sounded
    for (const tile of lane.tiles) {
      const p = library.patterns.get(tile.name);
      if (!p) continue;
      const s = p.toScore(state.bpm, state.articulation);
      // Per-tile transforms (nondestructive): run the tile's ordered transform
      // list over its note list (transpose maps pitch + re-resolves freq in the
      // tile's tuning; reverse retrogrades within the tile length), then offset by
      // tile.start.
      const src = tile.transforms
        ? applyTransforms(
            s.notes.map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity, freq: n.freq, artDur: n.artDur })),
            tile.transforms, { lengthBeats: s.lengthBeats, tuningId: p.tuningId, root: p.root })
        : s.notes;
      for (const n of src) {
        const nn = new Note(n.pitch, n.start + tile.start, n.duration, n.velocity);
        nn.freq = n.freq;         // carry each pattern's tuning-resolved frequency
        nn.artDur = n.artDur;     // articulated (sounded) length in beats
        nn.color = color;
        nn.alpha = alpha;
        nn.laneId = lane.id;      // routes the voice through this lane's gain bus
        nn.muted = muted;         // for the roll's hatch (audio mute is the lane bus)
        nn.tileStart = tile.start; // this tile's start beat — the scheduler's commit unit
        nn.rulerBeat = nn.start;  // absolute timeline position (survives region windowing) — the "Loop Mod" anchor
        notes.push(nn);
      }
      maxLen = Math.max(maxLen, tile.start + s.lengthBeats); // tiles are freely positioned
    }
  });
  return new Score(notes, state.bpm, state.articulation, maxLen);
}

// End beat of the whole arrangement (the last tile's end), without building a
// full score — also the default play-region end when no end marker is set.
function arrangementEndBeat() {
  let end = 0;
  for (const lane of arrangement.lanes) {
    for (const tile of lane.tiles) end = Math.max(end, tile.start + patternLen(tile.name));
  }
  return end;
}

// The resolved play-region bounds in beats. Start is always present; end falls
// back to the arrangement end when no marker is set. Clamped so start < end.
function playStartBeat() {
  return Math.max(0, Math.min(arrangement.playStart || 0, Math.max(0, arrangementEndBeat() - 1)));
}
function playEndBeat() {
  const contentEnd = arrangementEndBeat();
  const end = arrangement.playEnd == null ? contentEnd : Math.min(arrangement.playEnd, contentEnd);
  return Math.max(end, playStartBeat() + 1);
}

// The scheduler's provider for tile playback: the arrangement score windowed to
// the play region — notes triggering within [start, end), shifted so the region
// begins at beat 0, with the cycle length = the region length. So Play and Loop
// both honor the markers, and the scheduler/resync logic is unchanged (it just
// sees a shorter score). Default markers (0 … arrangement end) = the whole thing.
function windowedArrangementScore() {
  // A resume narrows the FIRST pass to [playhead, end). The scheduler re-reads
  // this provider at every loop boundary with cycleStart advanced past the start
  // we armed — those reads get the full region again, so a resumed play that
  // loops wraps to the region start, not the resume point.
  if (resumeBeat != null && scheduler.cycleStart !== resumeStartTime) resumeBeat = null;
  const score = arrangementScore();
  const start = resumeBeat != null ? resumeBeat : playStartBeat();
  const end = playEndBeat();
  if (start <= 0 && end >= score.lengthBeats) return score; // full range — no windowing
  const notes = score.notes.filter((n) => n.start >= start && n.start < end);
  for (const n of notes) { n.start -= start; n.tileStart -= start; }
  return new Score(notes, state.bpm, state.articulation, end - start);
}

// The tiles currently sounding — one per audible lane whose timeline covers
// `beat` (muted / solo-silenced lanes don't get the "playing" highlight).
function playingTileIds(beat) {
  const ids = new Set();
  const audible = arrangement.audibleLaneIds();
  for (const lane of arrangement.lanes) {
    if (!audible.has(lane.id)) continue;
    for (const tile of lane.tiles) {
      if (beat >= tile.start && beat < tile.start + patternLen(tile.name)) { ids.add(tile.id); break; }
    }
  }
  return ids;
}

// Start beat of a tile (its explicit position on the lane's timeline).
function tileStartBeat(id) {
  const lane = arrangement.laneOfTile(id);
  const tile = lane && lane.tiles.find((t) => t.id === id);
  return tile ? tile.start : 0;
}

// The roll mirrors the active pane: the grid's current pattern, or the whole
// arrangement when the tile player is active.
function activeScore() {
  return activePane === 'tiles' ? arrangementScore() : buildScore();
}

const roll = new PianoRoll(document.getElementById('roll'), activeScore(), document.getElementById('rollGutter'));
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

let marqueeBefore = null; // selection snapshot for Esc-cancelling a marquee

const tilePlayer = new TilePlayer(document.getElementById('tileLane'), library, arrangement, {
  onTileDown: (id, ev) => onTileDown(id, ev),
  onGridDragOver: (laneId, start) => gridDragOver(laneId, start),
  onDropAt: (laneId, start) => dropCurrentTile(laneId, start),
  // Empty-space rubber-band selection (one lane). Live: each band change
  // re-derives the intersecting set; no re-render, just class syncs.
  onMarqueeStart: () => {
    marqueeBefore = { ids: new Set(arrangement.selectedIds), anchor: arrangement.selectedId };
  },
  onMarquee: (laneId, b0, b1) => {
    arrangement.selectMarquee(laneId, b0, b1, patternLen);
    arrangement.activeLaneId = laneId;
    tilePlayer.syncSelection();
    tilePlayer.setActiveLane(laneId);
    updateTileSelectionUI();
  },
  onMarqueeEnd: (laneId, dragged) => {
    marqueeBefore = null;
    setActive('tiles');
    if (!dragged) { // a plain empty-space click: activate the lane, clear the selection
      arrangement.activeLaneId = laneId;
      arrangement.clearSelection();
      tilePlayer.syncSelection();
      tilePlayer.setActiveLane(laneId);
      updateTileSelectionUI();
    }
    updateRollContent(); scrollRollToSelected();
    persist();
  },
  onMarqueeCancel: () => { // Esc mid-band: back to the pre-gesture selection
    if (marqueeBefore) {
      arrangement.selectedIds = new Set(marqueeBefore.ids);
      arrangement.selectedId = marqueeBefore.anchor;
      arrangement.pruneSelection();
      marqueeBefore = null;
    }
    tilePlayer.syncSelection();
    updateTileSelectionUI();
  },
  // Repeat fill handle: plan k block-repeats (per-tile ignore-collisions) —
  // preview shows only what will land; commit stamps them (one undo entry)
  // and the selection grows to original + stamps (user's choice).
  onRepeatPreview: (laneId, k) => {
    const stamps = arrangement.planRepeat(k, patternLen).filter((p) => !p.blocked);
    tilePlayer.showStamps(laneId, stamps);
    return stamps.length; // M — how many copies actually land (for the count chip)
  },
  onRepeatCommit: (laneId, k) => {
    tilePlayer.clearStamps();
    if (k === 0) return;
    const before = arrSnap();
    arrangement.repeatSelection(k, patternLen);
    arrCommit(before); // no entry if every stamp was blocked
    tilePlayer.syncSelection();
    updateTileSelectionUI();
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
  onMarkers: (start, end) => setPlayMarkers(start, end),
  onRangePreview: (kind, s, e) => {                 // light the tiles the drawn range would touch
    const { doomed, shifted } = rangeAffected(kind, s, e);
    tilePlayer.setRangePreview(doomed, shifted);
  },
  onRangeCommit: (kind, s, e, keepArmed) => commitRange(kind, s, e, keepArmed),
  onRangeCancel: () => { tilePlayer.setRangePreview(null, null); disarmRangeTool(); },
  onDelay: (laneId) => openDelayModal(laneId),
  onChorus: (laneId) => openChorusModal(laneId),
  onReverb: (laneId) => openReverbModal(laneId),
  onMods: (laneId) => openModModal(laneId),
});
tilePlayer.rippleMode = state.ripple; // restore the Ripple toggle (workspace pref)

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

// Commit a play-region change (from the ruler): clamp, store on the arrangement,
// and close the undo bracket opened on pointerdown. `end` null = "to last tile".
// Marker edits take effect at the next loop boundary (the provider re-reads), so
// no mid-cycle resync — just persist + redraw the ruler.
function setPlayMarkers(start, end) {
  const contentEnd = arrangementEndBeat();
  const s = Math.max(0, Math.min(Math.round(start), Math.max(0, contentEnd - 1)));
  let e = end; // null = auto (end of last tile)
  if (e != null) {
    e = Math.round(e);
    if (e >= contentEnd) e = null;          // dragged to/past the content end → back to auto
    else e = Math.max(s + 1, e);            // keep a non-empty region
  }
  arrangement.playStart = s;
  arrangement.playEnd = e;
  onMixEnd(); // shared bracket: commit one undo step if changed, persist, refresh undo btn
  tilePlayer.render();
}

// Pan/Gain knob drag. The knob updates itself live; we apply each move to the
// lane bus immediately (so you hear it) but defer autosave/dirty + the single
// undo step to release — so a continuous drag is one undoable change, not many.
let mixBefore = null;
function onMixStart() { mixBefore = arrSnap(); }
function onMixChange(laneId, key, value) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  if (key === 'pan') { lane.pan = value; engine.setLanePan(laneId, value, 0.01); }
  else { lane.gain = value; engine.setLaneVolume(laneId, value, 0.01); }
}
function onMixEnd() {
  if (mixBefore != null) arrCommit(mixBefore); // a net change → one undo step
  mixBefore = null;
  persist(); // autosave + dirty (knobs already drove the audio live)
  updateTransportButtons(); // reflect the new arrangement-undo entry immediately
}

// Add a lane (undoable arrangement edit) and make it active.
function addLane() {
  setActive('tiles');
  arrRecord();
  const lane = arrangement.addLane();
  arrangement.activeLaneId = lane.id;
  applyLaneGains(0); // give the new lane's bus the right gain under any active solo/mute
  refresh();
}
state.tileScaleIdx = clampScaleIdx(state.tileScaleIdx);
tilePlayer.ppb = TILE_SCALES[state.tileScaleIdx];

// Mute / Solo: an undoable arrangement edit (so it rides tile Undo/Redo and the
// dirty bit). The audio change is the lane gain bus (real-time, ramped); refresh
// re-renders the lane buttons + roll hatching.
function toggleLaneFlag(kind, laneId) {
  setActive('tiles');
  arrRecord();
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

// --- tile drag: reorder / move / copy ---------------------------------
//
// Pointer-based so we can preview the prospective ripple and animate it. A drag
// only mutates the committed arrangement on DROP — until then audio, roll, and
// playhead keep playing the committed order (the preview "is not what's
// playing"). No modifier = move (keeps the tile id so selection follows); CTRL =
// a shallow copy (new id, same pattern reference — moved off Shift, which the
// upcoming multi-select needs for range selection). A committed reorder's audio
// lands at the next loop boundary, like other live edits.
const DRAG_THRESH = 5; // px of movement before a press becomes a drag (else click)
let tileDrag = null;   // { id, fromLaneId, preview } while a drag is active

// pointerdown on a tile: decide click vs drag from movement, via window-level
// listeners (so they survive the re-renders the preview triggers).
function onTileDown(id, ev) {
  if (ev.button != null && ev.button !== 0) return;
  const startX = ev.clientX, startY = ev.clientY;
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESH) return;
      dragging = true;
      startTileDrag(id, startX); // grip from the ORIGINAL press point
    }
    updateTileDrag(e);
  };
  const onUp = (e) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (dragging) { endTileDrag(e); return; }
    // No movement → a click. Double-click is detected HERE (not via the DOM
    // dblclick event — the first click's refresh REBUILDS the tile element, so
    // a native dblclick would never fire on it): a second plain click on the
    // same tile within the window auditions it.
    const now = performance.now();
    const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (plain && lastTileClick && lastTileClick.id === id && now - lastTileClick.t < 400) {
      lastTileClick = null;
      auditionTile(id);
      return;
    }
    lastTileClick = plain ? { id, t: now } : null;
    selectTile(id, e); // modifiers pick the selection op
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
let lastTileClick = null; // {id, t} — the double-click detector's memory

function startTileDrag(id, grabX) {
  const lane = arrangement.laneOfTile(id);
  // Normalized grip (user's rule): square-ish tiles are held by the center; long
  // skinny ones where grabbed, but never closer than half the tile height to an
  // edge. Captured once (in beats) at pickup; the drop math subtracts it.
  tileDrag = { id, fromLaneId: lane ? lane.id : null, preview: null, gripBeats: tilePlayer.gripFor(id, grabX) };
  // Dragging a member of a MULTI-selection moves/copies the whole selection as
  // a rigid block; dragging an unselected tile is a plain single-tile drag.
  if (arrangement.selectedIds.size > 1 && arrangement.selectedIds.has(id)) {
    const grabbed = arrangement.allTiles().find((t) => t.id === id);
    const block = arrangement.selectionBlock(patternLen);
    tileDrag.multi = { grabbedStart: grabbed.start, blockStart: block.start };
  }
  tilePlayer.setPlaying(new Set()); // drop the green "playing" badge while dragging
  tilePlayer.makeGhost(id, tileDrag.gripBeats * tilePlayer.ppb); // ghost hangs from the grip point
}

function updateTileDrag(e) {
  const copy = e.ctrlKey;
  tilePlayer.edgeScroll(e.clientX, e.clientY); // near an edge → jump the view (dropTarget reads fresh rects after)
  const tgt = tilePlayer.dropTarget(e.clientX, e.clientY);
  // The tile lands at the beat NEAREST ITS CARRIED POSITION (pointer minus the
  // grip, rounded) — the original grip-preserving feel. The caret switches to
  // carry mode and marks the landing's left edge (see setCarryCaret).
  let preview = null;
  if (tgt && tileDrag.multi) {
    // Multi-selection: the grabbed tile's destination sets a rigid shift for
    // the whole block (clamped so no member lands before beat 0); the plan
    // (with per-member collision blocking) is what the drop will commit.
    const dest = Math.round(tgt.beat - tileDrag.gripBeats);
    const shift = Math.max(dest - tileDrag.multi.grabbedStart, -tileDrag.multi.blockStart);
    preview = {
      multi: arrangement.planSelectionDrop(tgt.laneId, shift, patternLen, copy),
      shift, copy, toLaneId: tgt.laneId, fromLaneId: tileDrag.fromLaneId,
    };
  } else if (tgt) {
    preview = { id: tileDrag.id, fromLaneId: tileDrag.fromLaneId, copy, toLaneId: tgt.laneId, start: Math.max(0, Math.round(tgt.beat - tileDrag.gripBeats)) };
  }
  if (!samePreview(preview, tileDrag.preview)) {
    tileDrag.preview = preview;
    tilePlayer.render(preview, true); // animate the live ripple
  }
  if (preview) tilePlayer.setCarryCaret(preview.toLaneId, preview.multi ? tileDrag.multi.blockStart + preview.shift : preview.start);
  else tilePlayer.setCarryCaret(null); // off the lanes — a drop would cancel
  tilePlayer.moveGhost(e.clientX, e.clientY, copy);
}

function endTileDrag(e) {
  const preview = tileDrag.preview;
  tilePlayer.clearGhost();
  tilePlayer.setCarryCaret(null); // back to hover mode
  tileDrag = null;

  if (!preview) { refresh(); return; } // dropped off the lanes → cancel
  const copy = e.ctrlKey;              // authoritative copy state at the drop

  // Moving/copying into a FRESH lane (brand-new / just-reset) seeds that lane's
  // instrument from the SOURCE lane (a tile carries no patch — its lane does),
  // so the tiles keep sounding the way they did. A used lane keeps its own.
  const destLane = arrangement.lane(preview.toLaneId);
  const seedFromSource = destLane && destLane.fresh && preview.toLaneId !== preview.fromLaneId;
  const srcLane = seedFromSource ? arrangement.lane(preview.fromLaneId) : null;
  const srcPatch = srcLane ? srcLane.patch : null;

  const before = arrSnap();
  if (preview.multi) {
    // Whole-selection block drop (ignore-collisions; ripple doesn't apply to
    // multi drags). Move keeps the same ids selected; copy selects the copies.
    if (copy) arrangement.copySelection(preview.toLaneId, preview.shift, patternLen);
    else arrangement.moveSelection(preview.toLaneId, preview.shift, patternLen);
  } else {
    const newId = copy
      ? arrangement.copyTile(preview.id, preview.toLaneId, preview.start, patternLen, state.ripple)
      : (arrangement.moveTile(preview.id, preview.toLaneId, preview.start, patternLen, state.ripple), preview.id);
    arrangement.select(newId);
  }
  arrCommit(before);
  if (srcPatch) { // adopt the source instrument AND its patch identity
    destLane.patch = clonePatch(srcPatch);
    destLane.patchOriginId = srcLane.patchOriginId; destLane.patchName = srcLane.patchName; destLane.patchDirty = srcLane.patchDirty;
  }
  if (destLane) destLane.fresh = false;                // the lane now has a tile
  arrangement.activeLaneId = preview.toLaneId;
  refresh();
}

// Previews are small plain objects (single-tile or a multi plan) — structural
// equality via JSON is cheap and covers both shapes.
function samePreview(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Click-select with modifiers: plain = fresh single selection AND opens the
// tile's pattern in the grid editor (user: "no harm from that"); Ctrl = toggle
// membership (one lane — a cross-lane Ctrl-click starts fresh there); Shift =
// contiguous range from the anchor. Modifier clicks are selection-building, so
// they don't churn the grid. `ev` optional (programmatic = plain).
function selectTile(id, ev) {
  setActive('tiles');
  const plain = !ev || (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey);
  if (ev && ev.shiftKey) arrangement.selectRange(id);
  else if (ev && (ev.ctrlKey || ev.metaKey)) arrangement.toggleSelect(id);
  else arrangement.select(id);
  const lane = arrangement.laneOfTile(id);
  if (lane) arrangement.activeLaneId = lane.id;
  if (plain) {
    const tile = arrangement.allTiles().find((t) => t.id === id);
    const p = tile && library.patterns.get(tile.name);
    if (p) {
      clearProposal();
      grid.clearSelection();
      library.open(p.name);
      setGridInstr(lane ? { source: 'lane', laneId: lane.id } : { source: 'grid' }); // borrow the tile's instrument
      centerGridOn(p);
    }
    refresh(); // covers roll content/scroll, selection visuals, persist
  } else {
    tilePlayer.syncSelection();
    tilePlayer.setActiveLane(arrangement.activeLaneId);
    updateRollContent(); scrollRollToSelected();
    updateTileSelectionUI();
    persist();
  }
}

// The selection as tiles, in timeline order (they all live on one lane).
function selectedTiles() { return arrangement.selectedTiles(); }

// Selection-dependent chrome: the Delete button and the transform bar (action
// buttons enable with a selection; the chip inspector reflects it).
function updateTileSelectionUI() {
  tileDeleteBtn.disabled = arrangement.selectedIds.size === 0;
  refreshTransformBar();
}

// --- transform ACTIONS: select tiles, then click the button ---------------
//
// (The former brushes — arm a tool, then paint tiles — were removed once
// multi-select landed: select-THEN-button is one mental model shared with the
// grid's Permute tools, and it deleted the whole paint-gesture/armed-session
// machinery. Buttons act on the current selection, single or multiple; one
// undo entry per action; the selection survives so actions chain.)
let rangeMode = null;                                  // null | 'insert' | 'clear' | 'delete' — armed Range tool (draws on the ruler)
const transposeOpts = { amount: 1, scaleId: 'auto' };  // the Transpose action's parameters (always visible in the bar)

// Transpose: SET each selected tile's transpose to the bar's amount (a second
// application replaces, never accumulates; amount 0 clears). Scale 'auto' =
// each tile's own mask; the root is always the tile's.
function applyTransposeAction() {
  const tiles = selectedTiles();
  if (!tiles.length) return;
  const before = arrSnap();
  for (const tile of tiles) {
    const p = library.patterns.get(tile.name);
    const root = p ? p.root : 0;
    const scaleId = transposeOpts.scaleId === 'auto' ? (p ? p.scaleId : 'chromatic') : transposeOpts.scaleId;
    setTileTranspose(tile, transposeOpts.amount, scaleId, root);
  }
  arrCommit(before);
  refresh();
}

// Reverse: unify, don't flip-flop — if EVERY selected tile is reversed,
// un-reverse them all; otherwise reverse them all.
function applyReverseAction() {
  const tiles = selectedTiles();
  if (!tiles.length) return;
  const target = !tiles.every((t) => hasReverse(t.transforms));
  const before = arrSnap();
  for (const tile of tiles) setTileReverse(tile, target);
  arrCommit(before);
  refresh();
}

// Clone: repoint each selected tile onto a fresh copy of its pattern, "as if
// cloned in the grid" — position + per-tile transforms untouched. DEDUPED per
// source within the action (5×A1 + 2×A3 selected → 5×A8 + 2×A9), so a selection
// keeps its internal sharing while diverging as a block. The ANCHOR tile's
// clone then opens in the grid editor. Undo repoints the tiles back; the cloned
// patterns linger in the registry (accepted — a future pattern browser /
// orphan-GC is the real fix).
function applyCloneAction() {
  const tiles = selectedTiles();
  if (!tiles.length) return;
  const before = arrSnap();
  const map = new Map(); // srcName -> cloneName, this action only
  for (const tile of tiles) {
    let cloneName = map.get(tile.name);
    if (!cloneName) {
      const p = library.cloneOf(tile.name);
      if (!p) continue;
      map.set(tile.name, p.name);
      cloneName = p.name;
    }
    tile.name = cloneName;
  }
  arrCommit(before);
  const anchor = arrangement.allTiles().find((t) => t.id === arrangement.selectedId) || tiles[0];
  const p = anchor && library.patterns.get(anchor.name);
  if (p) { library.open(p.name); centerGridOn(p); } // the anchor's clone becomes the grid's current
  refresh();
}

// Arm/disarm a Range tool (Insert / Clear / Delete time): the ruler becomes the
// gesture surface (it glows; markers go inert) until a range is drawn.
// Exclusive, one-shot, Shift keeps armed, Esc disarms.
function setRangeTool(kind) {
  rangeMode = rangeMode === kind ? null : kind;
  tilePlayer.setRangeMode(rangeMode);
  refreshTransformBar();
}
function disarmRangeTool() { if (rangeMode) setRangeTool(rangeMode); }

// The tiles a pending range op touches: `doomed` will be removed (starts in the
// range — Clear/Delete), `shifted` will move (Insert: everything from the range
// start; Delete: everything from the range end). Same predicates as the ops.
function rangeAffected(kind, s, e) {
  const doomed = new Set(), shifted = new Set();
  for (const t of arrangement.allTiles()) {
    if (kind !== 'insert' && t.start >= s && t.start < e) doomed.add(t.id);
    if (kind === 'insert' && t.start >= s) shifted.add(t.id);
    if (kind === 'delete' && t.start >= e) shifted.add(t.id);
  }
  return { doomed, shifted };
}

// Commit a drawn range: apply the op (one undo entry), carry the parked
// playhead through it (markers ride inside the Arrangement ops), and disarm
// unless Shift was held. An empty range (a plain click) just cancels.
function commitRange(kind, s, e, keepArmed) {
  tilePlayer.setRangePreview(null, null);
  if (e <= s) { disarmRangeTool(); return; }
  const before = arrSnap();
  if (kind === 'insert') {
    arrangement.insertTime(s, e - s);
    state.playheadBeat = insertPoint(state.playheadBeat, s, e - s);
  } else if (kind === 'clear') {
    arrangement.clearRange(s, e);
  } else {
    arrangement.deleteTime(s, e);
    state.playheadBeat = deletePoint(state.playheadBeat, s, e);
  }
  state.playheadBeat = clampPlayhead(state.playheadBeat);
  tilePlayer.setPlayhead(state.playheadBeat);
  arrCommit(before); // no-op when the range touched nothing
  if (!keepArmed) disarmRangeTool();
  refresh();
}
function bumpTranspose(d) {
  transposeOpts.amount = Math.max(-24, Math.min(24, transposeOpts.amount + d));
  refreshTransformBar();
}

// Remove one transform KIND from every selected tile (a chip's ✕), one undo.
function removeSelectedTransform(kind) {
  const tiles = selectedTiles();
  if (!tiles.length) return;
  const before = arrSnap();
  for (const tile of tiles) {
    if (kind === 'transpose') setTileTranspose(tile, 0);
    else if (kind === 'reverse') setTileReverse(tile, false);
  }
  arrCommit(before);
  refresh();
}

// Reset one lane to a blank slate (the red "R"): clear its tiles + restore the
// default instrument / mixer / delay / mute-solo, and mark it fresh again. The
// lane stays in the stack. Undoable as a `full` entry (so the instrument too).
function resetLane(id) {
  const before = arrSnap();
  arrangement.resetLane(id);
  arrCommit(before, true);
  patchStash.delete(stashKey(id)); // forget stashed per-kind patches for this lane
  applyLaneMix(0.012);  // gain/pan back to unity/center on the bus
  applyLaneDelayAll();  // delay off → remove the insert
  applyLaneChorusAll(); // chorus off → remove the insert
  applyLaneReverbAll();  // reverb off → remove the insert
  if (editTarget.laneId === id) editLane(id); // re-point the pane onto the new default patch
  refresh();
}

// Reset the whole tile player ("Reset player"): back to two blank, fresh lanes
// and the play region cleared. Undoable as a `full` entry.
function resetPlayer() {
  const before = arrSnap();
  arrangement.resetPlayer();
  arrCommit(before, true);
  patchStash.clear();    // the old lanes are gone
  engine.resetLanes();   // tear down every strip (delay tails / orphaned lanes)
  editGrid();            // the edited lane may no longer exist → back to the grid
  applyLaneMix(0);       // initialize the two fresh lanes' buses
  applyLaneDelayAll();
  applyLaneChorusAll();
  applyLaneReverbAll();
  refresh();
}

// The transform bar: the Transpose + Reverse brush toggles, Transpose's armed
// controls (amount stepper + scale select), and the selected tile's ordered
// transform chips (each clearable). One bar, two roles (tool palette + per-tile
// readout). Built once; refreshTransformBar syncs state.
const transformBarEl = document.getElementById('transformBar');
let xbRippleBtn, xbTransBtn, xbRevBtn, xbCloneBtn, xbArmedEl, xbAmountEl, xbScaleSel, xbKeyEl, xbSelEl;
let xbInsBtn, xbClrBtn, xbDelBtn; // Range tools (draw a range on the ruler)

function buildTransformBar() {
  transformBarEl.innerHTML = '';
  const mkBtn = (text, title, onclick) => { const b = document.createElement('button'); b.textContent = text; b.title = title; b.onclick = onclick; return b; };

  // Ripple mode toggle (default OFF): governs insert AND delete. Off = tiles
  // land exactly where dropped, overwriting what they overlap, and deletes
  // leave a gap; on = the rigid ripple (clamp-left/push-right, close on delete).
  xbRippleBtn = mkBtn('Ripple',
    'Ripple mode — inserts push later tiles right and deletes close the gap. '
    + 'Off (default): tiles land exactly where dropped, overwriting any tiles they overlap; deletes leave a gap.',
    () => {
      state.ripple = !state.ripple;
      tilePlayer.rippleMode = state.ripple;
      refreshTransformBar();
      persist();
    });
  xbRippleBtn.className = 'tbtn';
  const rippleSep = document.createElement('span');
  rippleSep.className = 'tsep';

  // Transform ACTIONS: apply to the current selection (single or multiple).
  xbTransBtn = document.createElement('button');
  xbTransBtn.className = 'xb-brush xf-transpose';
  xbTransBtn.textContent = 'Transpose';
  xbTransBtn.title = 'Transpose the selected tile(s) by the amount/scale shown (SETS the transpose — a second application replaces it; 0 clears). One undo step; the selection stays.';
  xbTransBtn.onclick = applyTransposeAction;

  // Transpose's parameters (amount + scale) — always visible; they're what the
  // button will apply.
  xbArmedEl = document.createElement('span');
  xbArmedEl.className = 'xb-armed';
  xbAmountEl = document.createElement('span');
  xbAmountEl.className = 'xb-amt-val';
  xbScaleSel = document.createElement('select');
  xbScaleSel.className = 'xb-scale';
  xbScaleSel.title = 'The scale the steps walk (Auto = each tile’s own mask). The list is the scales valid for the selected tile’s tuning.';
  // Options depend on the selection's tuning, so they're (re)filled per selection
  // in refreshTransformBar; 'auto' is always first.
  xbScaleSel.onchange = () => { transposeOpts.scaleId = xbScaleSel.value; refreshTransformBar(); };
  // Read-only readout of the key (and, in Auto, the scale) the transpose will
  // actually use, resolved from the selected tile(s).
  xbKeyEl = document.createElement('span');
  xbKeyEl.className = 'xb-key';
  xbKeyEl.title = 'The key the steps are rooted at (from the selected tile). In Auto, also the tile’s own scale.';
  xbArmedEl.append(mkBtn('−', 'Down one step', () => bumpTranspose(-1)), xbAmountEl, mkBtn('+', 'Up one step', () => bumpTranspose(1)), xbScaleSel, xbKeyEl);

  xbRevBtn = document.createElement('button');
  xbRevBtn.className = 'xb-brush xf-reverse';
  xbRevBtn.textContent = '◄ Reverse';
  xbRevBtn.title = 'Reverse the selected tile(s) — if all are already reversed, un-reverses them all. One undo step; the selection stays.';
  xbRevBtn.onclick = applyReverseAction;

  xbCloneBtn = document.createElement('button');
  xbCloneBtn.className = 'xb-brush xf-clone';
  xbCloneBtn.textContent = 'Clone';
  xbCloneBtn.title = 'Clone the selected tile(s): they diverge onto fresh copies of their patterns (tiles sharing a pattern share one new clone; the anchor tile’s clone opens in the grid). One undo step.';
  xbCloneBtn.onclick = applyCloneAction;

  xbSelEl = document.createElement('span');
  xbSelEl.className = 'xb-sel';

  // Range tools: arm one, then draw a range on the (glowing) ruler. All lanes;
  // beat-snapped; tiles are atomic (a tile starting before the range but
  // reaching into it is untouched).
  const rangeSep = document.createElement('span');
  rangeSep.className = 'tsep';
  const rangeLabel = document.createElement('span');
  rangeLabel.className = 'xb-range-label';
  rangeLabel.textContent = 'Range:';
  xbInsBtn = document.createElement('button');
  xbInsBtn.className = 'xb-brush rk-insert';
  xbInsBtn.textContent = 'Insert';
  xbInsBtn.title = 'Insert time — arm, then draw a range on the ruler: everything from the range start shifts right by its length (playhead and region markers ride along). Shift at release keeps it armed; Esc cancels.';
  xbInsBtn.onclick = () => setRangeTool('insert');
  xbClrBtn = document.createElement('button');
  xbClrBtn.className = 'xb-brush rk-clear';
  xbClrBtn.textContent = 'Clear';
  xbClrBtn.title = 'Clear range — arm, then draw a range on the ruler: tiles STARTING in the range are removed; nothing moves. Shift at release keeps it armed; Esc cancels.';
  xbClrBtn.onclick = () => setRangeTool('clear');
  xbDelBtn = document.createElement('button');
  xbDelBtn.className = 'xb-brush rk-delete';
  xbDelBtn.textContent = 'Delete';
  xbDelBtn.title = 'Delete time — arm, then draw a range on the ruler: tiles starting in the range are removed and everything after shifts left to close it (overlaps with an earlier tile’s tail are allowed). Playhead/markers ride along. Shift at release keeps it armed; Esc cancels.';
  xbDelBtn.onclick = () => setRangeTool('delete');

  transformBarEl.append(xbRippleBtn, rippleSep, xbTransBtn, xbArmedEl, xbRevBtn, xbCloneBtn,
    rangeSep, rangeLabel, xbInsBtn, xbClrBtn, xbDelBtn, xbSelEl);
  refreshTransformBar();
}

// Fill the transpose scale menu for the current selection's tuning, repair a pick
// that's no longer offered, and show the resolved key. The menu depends on the
// selected tile(s): a single tuning → that tuning's full scale library; a
// mixed-tuning selection → only the universal choices (Auto + Chromatic).
function syncTransposeControls() {
  const infos = selectedTiles().map((t) => library.patterns.get(t.name)).filter(Boolean);
  const edos = [...new Set(infos.map((p) => edoOf(p.tuningId)))];
  const edo = edos.length === 1 ? edos[0] : (edos.length === 0 ? 12 : null); // null = mixed tunings
  const scales = edo == null ? [{ id: 'chromatic', name: 'Chromatic' }] : scalesFor(edo);
  const opts = [{ id: 'auto', name: 'Auto (from tile)' }, ...scales];
  if (!opts.some((o) => o.id === transposeOpts.scaleId)) transposeOpts.scaleId = 'auto'; // pick invalid for this selection
  xbScaleSel.innerHTML = '';
  for (const o of opts) {
    const el = document.createElement('option'); el.value = o.id; el.textContent = o.name; xbScaleSel.append(el);
  }
  xbScaleSel.value = transposeOpts.scaleId;
  xbKeyEl.textContent = transposeKeyReadout(infos);
}

// The key the transpose is rooted at, read from the selected tile(s) — 'varies'
// when they disagree. In Auto also name the tile's scale (the menu doesn't).
function transposeKeyReadout(infos) {
  if (!infos.length) return '';
  const keys = new Set(infos.map((p) => pitchClassName(p.root, p.tuningId)));
  const key = keys.size === 1 ? [...keys][0] : 'varies';
  if (transposeOpts.scaleId === 'auto') {
    const names = new Set(infos.map((p) => scaleById(p.scaleId).name));
    return `${key} · ${names.size === 1 ? [...names][0] : 'varies'}`;
  }
  return key;
}

function refreshTransformBar() {
  if (!xbTransBtn) return;
  xbRippleBtn.classList.toggle('active', !!state.ripple);
  const tiles = selectedTiles();
  xbTransBtn.disabled = xbRevBtn.disabled = xbCloneBtn.disabled = tiles.length === 0;
  xbInsBtn.classList.toggle('active', rangeMode === 'insert');
  xbClrBtn.classList.toggle('active', rangeMode === 'clear');
  xbDelBtn.classList.toggle('active', rangeMode === 'delete');
  xbAmountEl.textContent = (transposeOpts.amount > 0 ? '+' : '') + transposeOpts.amount;
  syncTransposeControls();

  // The selection's transforms as chips ("the transform inspector").
  // One tile: its ordered chips, each removable. Several: the INTERSECTION
  // view — a chip per transform kind common to ALL selected ("(mixed)" when
  // the kind is shared but the details differ); ✕ removes the kind from every
  // selected tile in one undo.
  xbSelEl.innerHTML = '';
  const mkChip = (kind, text, onRemove) => {
    const chip = document.createElement('span');
    chip.className = 'xb-chip xf-' + kind;
    chip.append(document.createTextNode(text + ' '));
    const x = document.createElement('button');
    x.textContent = '✕'; x.title = 'Remove this transform from the selection';
    x.onclick = onRemove;
    chip.append(x);
    xbSelEl.append(chip);
  };
  const mkMuted = (text) => {
    const m = document.createElement('span');
    m.className = 'xb-muted';
    m.textContent = text;
    xbSelEl.append(m);
  };
  if (tiles.length === 1) {
    const transforms = tiles[0].transforms || [];
    for (const t of transforms) {
      const { kind } = transformKindLabel(t);
      mkChip(kind, describeTransform(t), () => removeSelectedTransform(kind));
    }
    if (!transforms.length) mkMuted('no transforms');
  } else if (tiles.length > 1) {
    mkMuted(`${tiles.length} tiles`);
    for (const kind of ['transpose', 'reverse']) {
      const per = tiles.map((t) => (t.transforms || []).find((tf) => transformKindLabel(tf).kind === kind));
      if (per.some((tf) => !tf)) continue; // not common to every selected tile
      const descs = new Set(per.map((tf) => describeTransform(tf)));
      const text = descs.size === 1
        ? [...descs][0]
        : (kind === 'transpose' ? 'Transpose (mixed)' : 'Reverse (mixed)');
      mkChip(kind, text, () => removeSelectedTransform(kind));
    }
  }

  refreshTileInspector(); // the modeless inspector follows the same selection
}

// Double-click: load the tile's pattern into the editor (by reference) but keep
// the tile player active and the tile selected.
// Audition one tile (double-click; the single click already selected it and
// opened its pattern in the grid): play JUST that tile — its pattern with its
// transforms, through its lane's instrument, bus and effects (mute/solo and
// modulators included, and notes keep their true ruler position for the
// Loop-Mod anchor — it sounds exactly as it does in context). One-shot;
// double-clicking another tile replaces the audition; Space stops it.
async function auditionTile(id, { loop = false } = {}) {
  const lane = arrangement.laneOfTile(id);
  const tile = lane && lane.tiles.find((t) => t.id === id);
  const p = tile && library.patterns.get(tile.name);
  if (!p) return;
  const s = p.toScore(state.bpm, state.articulation);
  const src = tile.transforms
    ? applyTransforms(
        s.notes.map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity, freq: n.freq, artDur: n.artDur })),
        tile.transforms, { lengthBeats: s.lengthBeats, tuningId: p.tuningId, root: p.root })
    : s.notes;
  const notes = src.map((n) => {
    const nn = new Note(n.pitch, n.start, n.duration, n.velocity);
    nn.freq = n.freq;
    nn.artDur = n.artDur;            // articulated (sounded) length in beats
    nn.laneId = lane.id;             // route through the lane's bus + inserts
    nn.tileStart = 0;
    nn.rulerBeat = tile.start + n.start; // the in-context modulator anchor
    return nn;
  });
  const score = new Score(notes, state.bpm, state.articulation, s.lengthBeats);
  const now = await engine.ensureRunning();
  if (engine.modEpoch == null) engine.modEpoch = now;
  scheduler.stop();
  activeSource = 'audit';
  auditTileId = id;
  applyLaneGains(0); // mute/solo bus state before the first note
  // loop = the app's LIMITED loop: LOOP_STEP passes counting down (never endless
  // — there is no infinite loop; a counted loop is the cure for loop burn-in).
  scheduler.start(() => score, now + 0.05, loop ? LOOP_STEP : 1, loop);
  tilePlayer.setPlaying(new Set([id])); // the green "playing" badge on the auditioned tile
  startRender();
  updateTransportButtons();
}
let auditTileId = null; // which tile the 'audit' source is sounding (inspector transport + badge)
let tileInspector = null; // the Tile Inspector floating pane (created in the wiring tail below)
let catalog = null;       // the Patch Catalog floating pane (created below)

// --- Tile Inspector transport (play / stop / loop the ANCHOR tile) ----------
// A first, deliberately un-standardized cluster (we're not ready to standardize
// a shared transport). It drives the same 'audit' source as a tile double-click.
function inspectorPlay() {
  if (arrangement.selectedId == null) return;
  auditionTile(arrangement.selectedId, { loop: false });
}
function inspectorStop() {
  if (activeSource !== 'audit') return; // only controls its own playback
  stop();
}
// Loop tap: stack passes (the LIMITED, counted loop). If this same tile is
// already auditing, add LOOP_STEP passes (capped) without restarting; else start
// a fresh counted loop.
function inspectorLoop() {
  const id = arrangement.selectedId;
  if (id == null) return;
  if (activeSource === 'audit' && scheduler.isPlaying && auditTileId === id) {
    scheduler.loop = true;
    scheduler.remaining = Math.min(scheduler.remaining + LOOP_STEP, LOOP_MAX);
    updateTransportButtons();
    return;
  }
  auditionTile(id, { loop: true });
}

// Reflect transport state onto the inspector's play/stop/loop cluster.
function syncInspectorTransport() {
  if (!tileInspector) return; // not built yet during init, or no inspector
  const auditing = activeSource === 'audit' && scheduler.isPlaying;
  tileInspector.setTransport({
    canPlay: arrangement.selectedId != null,
    playing: auditing,
    looping: auditing && scheduler.isLooping,
  });
}

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
  getPatchList: () => patches.allForKind(editTarget.patch.kind).map((e) => ({ id: e.id, name: e.name, factory: e.factory })),
  onRenamePatch: renameTargetPatch,
  onSave: saveTargetPatch,
  onSaveAs: saveTargetPatchAs,
  onLoad: loadTargetPatch,
  onCatalog: () => { catalog.toggle(); },
});

// What the editor is currently editing: the grid's neutral patch, or a lane's.
let editTarget = { patch: gridPatch, laneId: null };
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
  const cur = editTarget.patch;
  for (const k of Object.keys(cur)) delete cur[k];
  Object.assign(cur, next);
  if (editTarget.laneId == null) editGrid(); else editLane(editTarget.laneId);
  persistPatch();
  syncGridReference(); // a kind change (e.g. to/from Boshwick) moves the pivot band
}

// Switch the edited target to a different instrument kind, stashing the patch
// we're leaving and restoring any previously-dialed patch of the kind we're
// entering (else that kind's factory default).
function changeKind(kind) {
  const cur = editTarget.patch;
  if (cur.kind === kind) return;
  let stash = patchStash.get(stashKey(editTarget.laneId));
  if (!stash) { stash = {}; patchStash.set(stashKey(editTarget.laneId), stash); }
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
    editTarget = { patch: lane.patch, laneId: lane.id };
    tilePlayer.editLaneId = lane.id;
    instrPane.setTarget(lane.patch, `Lane ${idx + 1}`, laneColor(idx));
    tilePlayer.render();
    return;
  }
  editTarget = { patch: gridPatch, laneId: null };
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
  editTarget = { patch: lane.patch, laneId };
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
  if (editTarget.laneId == null) { safeSet(GRIDPATCH_KEY, JSON.stringify(gridPatch)); return; }
  // A deliberately-edited instrument means the lane has been "used" — so a tile
  // dropped in later won't auto-overwrite it (see lane.fresh).
  const lane = arrangement.lane(editTarget.laneId);
  if (lane) lane.fresh = false;
  persist();
}

function copyPatch() {
  patchClipboard = clonePatch(editTarget.patch);
  instrPane.setCanPaste(true);
}

function pastePatch() {
  if (!patchClipboard) return;
  // Paste can cross kinds (Copy a Zindel, Paste onto a Vesperia lane), so swap
  // the whole patch — swapTargetPatch rebuilds the pane for the pasted kind.
  swapTargetPatch(clonePatch(patchClipboard));
  // A pasted sound isn't the kind's bare default → Init*, awaiting a name.
  setTargetIdentity(patches.initId(editTarget.patch.kind), 'Init', true);
}

// --- patch identity: dirty tracking, Save/Save As/Load/Rename ----------------
// The patch-identity record for the current edit target (a lane, or the grid).
function targetMeta() {
  if (editTarget.laneId == null) return gridPatchMeta;
  return arrangement.lane(editTarget.laneId) || gridPatchMeta;
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
    if (editTarget.laneId != null) tilePlayer.render();
  }
  persistPatch();
}

// Persist the identity record to the right place (grid = its own key; a lane
// rides the arrangement) and repaint the pane name + lane head.
function persistPatchMeta() {
  if (editTarget.laneId == null) safeSet(GRIDMETA_KEY, JSON.stringify(gridPatchMeta));
  else persist();
  instrPane.syncIdentity();
  if (editTarget.laneId != null) tilePlayer.render();
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
  const kind = editTarget.patch.kind;
  const nameChanged = !entry || m.patchName !== entry.name;
  if (entry && !entry.factory && !nameChanged) {
    patches.update(entry.id, { params: clonePatch(editTarget.patch) });
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
  forkPatch(editTarget.patch.kind, name);
}

// Create a new user patch from the target's current params and link to it. The
// name is resolved against catalog collisions first (factory names auto-uniquify;
// a user-name clash offers Save/Rename/Cancel — we discourage silent duplicates).
function forkPatch(kind, name) {
  resolveForkName(kind, name, (finalName) => {
    if (!finalName) return; // cancelled
    const e = patches.add({ name: finalName, kind, params: clonePatch(editTarget.patch) });
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
  const cur = editTarget.patch;
  for (const k of Object.keys(cur)) delete cur[k];
  Object.assign(cur, next);
  if (editTarget.laneId == null) editGrid(); else editLane(editTarget.laneId);
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
  if (gridPatchMeta !== exceptMeta && gridPatchMeta.patchOriginId === entryId && !gridPatchMeta.patchDirty) {
    gridPatchMeta.patchDirty = true;
    safeSet(GRIDMETA_KEY, JSON.stringify(gridPatchMeta));
  }
  persist();
  tilePlayer.render();
}

// --- catalog management: apply / rename / delete -----------------------------
// Every identity record (lanes + the grid) that links to a catalog entry.
function patchLinkers(id) {
  const out = arrangement.lanes.filter((l) => l.patchOriginId === id);
  if (gridPatchMeta.patchOriginId === id) out.push(gridPatchMeta);
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
    persist();
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
  if (users.includes(gridPatchMeta)) safeSet(GRIDMETA_KEY, JSON.stringify(gridPatchMeta));
  persist();
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
  engine.playNote(60, t + 0.005, 60 / state.bpm, 0.85, tuningFreq(60, cur.tuningId, cur.root), editTarget.laneId);
}

function resetInstrument() {
  // Reset to THIS instrument's defaults (not always Vesperia's) = its factory Init.
  const kind = editTarget.patch.kind;
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
  if (activePane === pane) return;
  disarmRangeTool(); // the range tools belong to the tiles pane; leaving puts them away
  activePane = pane;
  state.activePane = pane;
  if (pane === 'grid') {
    arrangement.clearSelection();
    tilePlayer.syncSelection();
    updateTileSelectionUI();
    editGrid();
  } else {
    grid.clearSelection(); // leaving the grid drops its note selection
  }
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

// Playback auto-follow is PAGE-JUMP scrolling (DAW-style), not continuous: the
// view holds still while the playhead sweeps across it, and JUMPS a page (the
// playhead re-enters at the left margin) only when it runs off the right edge.
// Scrolling the whole track layer a little every frame was the remaining
// playback scroll cost — an occasional jump is cheap (and easier to watch).
function ensureRollVisible(x) {
  const el = rollScroll;
  const headW = roll.gutter ? roll.gutter.width : 0; // the pinned label gutter overlays the left edge
  const margin = 60;
  if (x > el.scrollLeft + el.clientWidth - margin || x < el.scrollLeft + headW) {
    el.scrollLeft = Math.max(0, x - headW - margin);
  }
}

// Same page-jump follow for the tile player. The playhead's x within the scroll
// content is the (sticky) lane-header width plus its track position, so a jump
// lands it just right of the header, never behind it.
let laneHeadW = 0; // sticky head width — runtime-constant, read from the DOM once
function ensureTileVisible(beat) {
  const el = document.getElementById('tileLane');
  if (!laneHeadW) {
    const head = el.querySelector('.lane-head');
    laneHeadW = head ? head.offsetWidth : 0;
  }
  const x = laneHeadW + beat * tilePlayer.ppb;
  const margin = 80;
  if (x > el.scrollLeft + el.clientWidth - margin || x < el.scrollLeft + laneHeadW) {
    el.scrollLeft = Math.max(0, x - laneHeadW - margin);
  }
}
function scrollRollToSelected() {
  if (scheduler.isPlaying) return; // playback drives the scroll itself
  if (activePane === 'tiles' && arrangement.selectedId != null) {
    const headW = roll.gutter ? roll.gutter.width : 0; // don't park the tile under the pinned gutter
    rollScroll.scrollLeft = Math.max(0, roll.xForBeat(tileStartBeat(arrangement.selectedId)) - headW - 20);
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
  const tilesView = scheduler.isPlaying ? activeSource === 'tiles' : activePane === 'tiles';
  const score = scheduler.isPlaying
    ? (activeSource === 'tiles' ? arrangementScore() : buildScore())
    : activeScore();
  roll.tunings = tuningsInUse(tilesView); // before setScore — affects gutter sizing
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

const arrPast = [];   // each entry: { snap, full } — see arrCommit
const arrFuture = [];
function arrSnap() { return JSON.stringify(arrangement.toJSON()); }
// Push a completed change. A `full` entry (lane / player reset) restores each
// lane's PATCH from the snapshot on undo too; a normal entry live-carries the
// current patch so a tile-move undo never reverts a separate sound edit.
function arrCommit(before, full = false) {
  if (arrSnap() === before) return; // no net change → no undo entry
  arrPast.push({ snap: before, full });
  if (arrPast.length > HISTORY_LIMIT) arrPast.shift();
  arrFuture.length = 0;
}
function arrRecord() { arrPast.push({ snap: arrSnap(), full: false }); if (arrPast.length > HISTORY_LIMIT) arrPast.shift(); arrFuture.length = 0; }
function arrApply(json, full = false) {
  const o = JSON.parse(json);
  // Sound settings — the instrument PATCH, the effect inserts (delay/chorus/
  // reverb) and the MODULATORS — are LIVE-CARRIED across a normal tile undo/redo,
  // not snapshot-restored: they're the "live panel" layer, so undoing a tile move
  // must never revert a separate sound edit. (Previously reverb was dropped
  // entirely here and delay/chorus/mods were snapshot-restored, so any undo wiped
  // or reverted the effects — the documented bug.) A `full` entry (a lane / player
  // RESET, which changes the sound on purpose) restores them from the snapshot so
  // the reset is undoable; a lane reappearing on redo also takes its snapshot.
  const live = new Map(arrangement.lanes.map((l) => [l.id, l]));
  arrangement.lanes = o.lanes.map((l) => {
    const cur = live.get(l.id);
    const carry = !full && cur; // live-carry the sound layer on normal entries
    return {
      id: l.id,
      tiles: l.tiles.map((t) => ({ id: t.id, name: t.name, start: t.start, transforms: normalizeTransforms(t.transforms) })),
      mute: !!l.mute, solo: !!l.solo,
      gain: l.gain == null ? 1 : l.gain, pan: l.pan == null ? 0 : l.pan, // mixer IS undoable
      delay: carry ? cur.delay : normalizeDelay(l.delay),
      chorus: carry ? cur.chorus : normalizeChorus(l.chorus),
      reverb: carry ? cur.reverb : normalizeReverb(l.reverb),
      modsByKind: carry ? cur.modsByKind : normalizeModsByKind(l.modsByKind),
      patch: carry ? cur.patch : normalizePatch(l.patch),
      // Patch identity is part of the live "sound panel" layer — carried on a
      // normal entry, restored from the snapshot on a full (reset) entry.
      patchOriginId: carry ? cur.patchOriginId : (l.patchOriginId != null ? l.patchOriginId : factoryInitId(normalizePatch(l.patch).kind)),
      patchName: carry ? cur.patchName : (l.patchName || 'Init'),
      patchDirty: carry ? cur.patchDirty : !!l.patchDirty,
      patchImported: carry ? cur.patchImported : !!l.patchImported,
      fresh: !!l.fresh,
    };
  });
  arrangement.seq = o.seq || 0;
  if (o.activeLaneId != null) arrangement.activeLaneId = o.activeLaneId;
  arrangement.playStart = o.playStart == null ? 0 : o.playStart; // region markers are undoable
  arrangement.playEnd = o.playEnd == null ? null : o.playEnd;
  arrangement.pruneSelection(); // drop selected ids the undo/redo removed
  applyLaneMix(0.012);  // restored pan/gain → push to the (existing) lane buses
  applyLaneDelayAll();  // restored delay → rebuild/update the inserts
  applyLaneChorusAll(); // restored chorus → rebuild the inserts
  applyLaneReverbAll();  // restored reverb → rebuild the inserts
  // If the editor was on a lane the undo/redo removed, drop back to the grid.
  if (editTarget && editTarget.laneId != null && !arrangement.lane(editTarget.laneId)) editGrid();
}
function arrUndo() { if (!arrPast.length) return; const e = arrPast.pop(); arrFuture.push({ snap: arrSnap(), full: e.full }); arrApply(e.snap, e.full); refresh(); }
function arrRedo() { if (!arrFuture.length) return; const e = arrFuture.pop(); arrPast.push({ snap: arrSnap(), full: e.full }); arrApply(e.snap, e.full); refresh(); }

// Grid-drag landing preview: while the toolbar grab handle is dragged over a
// track, show the prospective placement (landing band / doomed tiles, or the
// rippled slot) — the same preview pipeline as tile drags. Cleared on the
// handle's dragend (fires drop or no drop). Re-rendered only when the snapped
// target changes (dragover fires very fast).
let gridDragPreview = null;
// A new tile from the grid is ALWAYS held by its center (no prior grip to
// preserve): it lands at the beat nearest its carried position — the cursor
// beat minus half its length, rounded. The carry caret marks the landing start.
function gridDropStart(name, rawBeat) {
  return Math.max(0, Math.round(rawBeat - patternLen(name) / 2));
}
function gridDragOver(laneId, rawBeat) {
  const name = library.current().name;
  const start = gridDropStart(name, rawBeat);
  tilePlayer.setCarryCaret(laneId, start); // cheap no-op when unchanged
  if (gridDragPreview && gridDragPreview.toLaneId === laneId && gridDragPreview.start === start) return;
  gridDragPreview = { external: true, name, toLaneId: laneId, start };
  tilePlayer.render(gridDragPreview);
}
function clearGridDragPreview() {
  tilePlayer.setCarryCaret(null);
  if (!gridDragPreview) return;
  gridDragPreview = null;
  tilePlayer.render();
}

// Drop the grid's current pattern centered on the dropped beat (the same math
// the dragover preview showed). Ripple ripple-opens; non-ripple overwrites.
function dropCurrentTile(laneId, rawBeat) {
  gridDragPreview = null;
  const start = gridDropStart(library.current().name, rawBeat);
  arrRecord();
  // Dropping into a FRESH lane (brand-new / just-reset) seeds it with the grid's
  // instrument (the patch you were just auditioning), so the tile sounds the way
  // it did in the grid. A lane that's been used keeps its established instrument.
  // Clone so the lane's patch doesn't alias (and keep being edited by) the grid's.
  const lane = arrangement.lane(laneId);
  if (lane && lane.fresh) { // adopt the grid patch AND its identity so the tile keeps its name
    lane.patch = clonePatch(gridPatch);
    lane.patchOriginId = gridPatchMeta.patchOriginId; lane.patchName = gridPatchMeta.patchName; lane.patchDirty = gridPatchMeta.patchDirty;
  }
  arrangement.insertAt(laneId, library.current().name, start, patternLen, state.ripple);
  if (lane) lane.fresh = false; // the lane now has a tile
  arrangement.activeLaneId = laneId;
  refresh();
}

// Delete every selected tile (one undo entry). Ripple mode closes each gap in
// turn (left to right — ids stay valid across the shifts); off leaves silence.
function deleteSelectedTile() {
  const tiles = selectedTiles();
  if (!tiles.length) return;
  arrRecord();
  for (const t of tiles) {
    if (state.ripple) arrangement.removeRipple(t.id, patternLen);
    else arrangement.remove(t.id);
  }
  arrangement.clearSelection();
  refresh();
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
  const before = curSnap();
  clearProposal();
  grid.clearSelection();
  library.clearCurrent();
  pushHistory(before);
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
  const ctx = { tuningId: src.tuningId, scaleId: src.scaleId, root: src.root };

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
      if (genPattern) { genPattern.tuningId = ctx.tuningId; genPattern.scaleId = ctx.scaleId; genPattern.root = ctx.root; }
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
      const w = scaleWindow({ count: settings.range, centroid, scaleId: ctx.scaleId, root: ctx.root, edo: edoOf(ctx.tuningId), bounds: degreeBounds(ctx.tuningId, ctx.root) });
      val.textContent = w.length ? `${degreeToName(w[0], ctx.tuningId)}–${degreeToName(w[w.length - 1], ctx.tuningId)}` : '—';
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
    const edo = edoOf(ctx.tuningId);
    const families = familiesFor(edo).filter((id) => state.families[id]);
    const chordKeys = new Set(chordsFor(edo, families).map((x) => x.pcs.join(',')));
    const centroid = Math.round(state.topDegree - (state.visibleRows - 1) / 2);
    const beats = srcDurs.map((di) => DURATIONS[di].beats);
    // Each bias runs in one of two mechanisms (per its "Sort" checkbox): STEER = bake the
    // pull into generation (Run/Triad arpeggios survive) — passed to generateRandom as
    // `bias`; SORT = leave generation alone, re-pair the finished pitches afterward
    // (stronger, but scrambles contour). Both move only the NOTES; the groove stays put.
    const gen = generateRandom({
      count: width, centroid, scaleId: ctx.scaleId, root: ctx.root, edo,
      bounds: degreeBounds(ctx.tuningId, ctx.root), chordKeys, settings,
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
    if (mode !== 'new') pushHistory(beforeJSON); // in-place = one undo step back to the original
    modal.close();
  });
  mkbtn('Cancel', 'seg', 'Discard and restore the previous pattern', () => modal.close());
  body.append(actions);

  const modal = openModal({
    title: mode === 'new' ? 'New Random — New Pattern' : 'New Random Pattern',
    body,
    onClose: () => {
      safeSet(RAND_KEY, JSON.stringify(settings)); // settings persist across uses
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
  for (const p of proposal) cols[p.col] = { durIndex: p.durIndex, isRest: false, degree: p.degree, accent: 0, artic: DEFAULT_ARTIC };
  pushHistory(before);
  clearProposal();
  arrangement.clearSelection();
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
  if (scheduler.isPlaying && activeSource === 'tiles') scheduler.resync();
  gridName.textContent = library.currentName;
  updateEditButtons();
  updateTriadulateButtons();
  updateSelectionTools();
  updateScaleControls();
  updateTransportButtons();
  refreshTransformBar();
  persist();
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
  tb.setRootOptions(Array.from({ length: edo }, (_, i) => ({ value: String(i), label: pitchClassName(i, cur.tuningId) })));
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
  const h = hist(library.currentName);
  tb.undoBtn.disabled = h.past.length === 0;
  tb.redoBtn.disabled = h.future.length === 0;
  arrUndoBtn.disabled = arrPast.length === 0;
  arrRedoBtn.disabled = arrFuture.length === 0;
  tileDeleteBtn.disabled = arrangement.selectedIds.size === 0;
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
    cursor: state.cursor, highlightRows: state.highlightRows, showTriads: state.showTriads, proper: state.proper, families: state.families,
    topDegree: state.topDegree, visibleRows: state.visibleRows, activePane: state.activePane,
    tileScaleIdx: state.tileScaleIdx, masterGain: state.masterGain, modLoop: state.modLoop, lite: state.lite,
    gridInstr: state.gridInstr, parkedInstr: state.parkedInstr,
    ripple: state.ripple, playheadBeat: state.playheadBeat, tileScrollX: state.tileScrollX,
    rollVIdx: state.rollVIdx, rollHIdx: state.rollHIdx,
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

  histories.clear();
  arrPast.length = 0;
  arrFuture.length = 0;
  clearProposal();
  grid.clearSelection();
  ensureTileStarts(); // derive positions for tiles loaded from an old gapless file
  centerGridOn(library.current()); // bring the loaded pattern into view
  activePane = 'grid';
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
let exporting = false;
async function exportAudio() {
  if (exporting || arrangement.allTiles().length === 0) return;
  const score = arrangementScore();
  const spb = 60 / state.bpm;
  const notes = [];
  for (const n of score.notes) {
    if (n.muted) continue; // silenced lanes (mute / solo) aren't rendered
    notes.push({
      pitch: n.pitch,
      time: n.start * spb,
      duration: (n.artDur != null ? n.artDur : n.duration * state.articulation) * spb,
      velocity: n.velocity,
      freq: n.freq,
      laneId: n.laneId, // render through this lane's instrument patch
    });
  }
  if (!notes.length) return;
  // Release tail: let the longest-releasing lane ring out fully.
  const maxRelease = Math.max(patchRelease(gridPatch), ...arrangement.lanes.map((l) => patchRelease(l.patch)));
  const tail = Math.max(2.5, maxRelease * 6 + 0.5) + maxReverbTail(); // reverb rings past the release
  const durSec = score.lengthBeats * spb + tail;

  setExporting(true);
  try {
    const buffer = await engine.renderToBuffer(notes, durSec);
    downloadBytes(`${projectName || defaultName()}.wav`, encodeWav(buffer), 'audio/wav');
  } catch (err) {
    alert(`Audio export failed: ${err.message}`);
  } finally {
    setExporting(false);
  }
}

function setExporting(on) {
  exporting = on;
  exportProgEl.classList.toggle('on', on);
  audioExportBtn.textContent = on ? 'Rendering…' : 'Export Audio';
  audioExportBtn.disabled = on || arrangement.allTiles().length === 0;
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
let exportingStems = false;
async function exportStems(busMode) {
  if (exportingStems || arrangement.allTiles().length === 0) return;
  const score = arrangementScore();
  const spb = 60 / state.bpm;
  // Group every note by lane (ignore n.muted: stems include muted lanes too).
  const byLane = new Map();
  for (const n of score.notes) {
    let arr = byLane.get(n.laneId);
    if (!arr) { arr = []; byLane.set(n.laneId, arr); }
    arr.push({
      pitch: n.pitch, time: n.start * spb, duration: (n.artDur != null ? n.artDur : n.duration * state.articulation) * spb,
      velocity: n.velocity, freq: n.freq, laneId: n.laneId,
    });
  }
  if (byLane.size === 0) return;
  // One shared duration (mix length + release tail) so all stems are equal-length.
  const maxRelease = Math.max(patchRelease(gridPatch), ...arrangement.lanes.map((l) => patchRelease(l.patch)));
  const tail = Math.max(2.5, maxRelease * 6 + 0.5) + maxReverbTail(); // reverb rings past the release
  const durSec = score.lengthBeats * spb + tail;
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
      const buffer = await engine.renderStem(notes, durSec, lane.id, busMode);
      const label = instrument(lane.patch && lane.patch.kind).label;
      let base = safeFileName(`${String(li + 1).padStart(2, '0')} ${label}`);
      let name = base, k = 2;                   // de-dup same-instrument lanes
      while (used.has(name.toLowerCase())) name = `${base} (${k++})`;
      used.add(name.toLowerCase());
      const meta = {
        description: `${proj} - lane ${li + 1} (${label})`,
        originator: 'Notorolla', date: now, timeReferenceSamples: 0,
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
  exportingStems = on;
  exportProgEl.classList.toggle('on', on);
  stemExportBtn.textContent = on ? 'Rendering…' : 'Export Stems';
  stemExportBtn.disabled = on || arrangement.allTiles().length === 0;
}

// The stem-export dialog: pick the bus mode, then render. Defaults to Dry.
const STEM_MODES = [
  { id: 'dry', label: 'Dry — pre-insert, pre-fader',
    desc: 'Voice only: no volume, pan, chorus or delay. The driest stems — process them in the DAW.' },
  { id: 'postfader', label: 'Post-fader — pre-limiter',
    desc: 'Volume, pan, chorus & delay baked in; the master limiter is left off, so stems sum back to the mix.' },
  { id: 'baked', label: 'Fully baked — incl. limiter',
    desc: 'As post-fader, plus the master limiter. Each stem sounds as it does soloed in the mix, but stems no longer sum exactly.' },
];
function openStemModal() {
  if (exportingStems || arrangement.allTiles().length === 0) return;
  const body = document.createElement('div');
  body.className = 'stem-export';
  const intro = document.createElement('p');
  intro.className = 'stem-intro';
  intro.textContent = 'One Broadcast Wave (BWF) per lane, bundled in a zip. All stems share a start (TimeReference 0) so they import aligned. Choose how much of each lane’s strip to bake in:';
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

  const actions = document.createElement('div');
  actions.className = 'stem-actions';
  const go = document.createElement('button');
  go.className = 'stem-go'; go.textContent = 'Export';
  go.addEventListener('click', () => { modal.close(); exportStems(chosen); });
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
  if (!storageOK) { e.preventDefault(); e.returnValue = ''; }
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
const audioExportBtn = document.getElementById('audioExport');
const stemExportBtn = document.getElementById('stemExport');
const tileInspectorBtn = document.getElementById('tileInspector');
const exportProgEl = document.getElementById('exportProg');
const modLoopBtn = document.getElementById('modLoop');
const modClockEl = document.getElementById('modClock');
const gridName = document.getElementById('gridName');

// Global "Loop Mod" toggle: all modulators on ruler time (reset each loop pass)
// vs elapsed time from the session's first Play. A workspace preference.
modLoopBtn.className = 'tbtn' + (state.modLoop ? ' active' : '');
modLoopBtn.addEventListener('click', () => {
  state.modLoop = !state.modLoop;
  modLoopBtn.classList.toggle('active', state.modLoop);
  persist();
});

// "Lite Instruments" — a workspace preference (not part of the document): the
// heavy voices (Wendelhorn, Nayumi) build a cheaper live graph to avoid dropouts.
// Read fresh at every note-on, so toggling takes effect on the next note; offline
// exports never see it, so a bounce is always the full voice.
const liteBox = document.getElementById('liteInstruments');
liteBox.checked = state.lite;
liteBox.addEventListener('change', () => {
  state.lite = liteBox.checked;
  engine.lite = state.lite;
  persist();
});

// The transport clock (mm:ss.hh). Stopped (or grid playing): the parked
// playhead's position — regardless of Loop Mod. While the tiles play: the clock
// the mods actually read — elapsed since the session's first Play, or the
// playhead's ruler time when Loop Mod is on. Cheap fixed interval; only writes
// the DOM when the text changes.
function modClockText() {
  let sec;
  if (!(scheduler.isPlaying && activeSource === 'tiles')) {
    sec = clampPlayhead(state.playheadBeat) * (60 / state.bpm);
  } else if (state.modLoop) {
    sec = (passBase + scheduler.currentBeat) * (60 / state.bpm);
  } else {
    sec = engine.modEpoch != null ? Math.max(0, engine.currentTime - engine.modEpoch) : 0;
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const h = Math.floor((sec % 1) * 100);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(m)}:${p2(s)}.${p2(h)}`;
}
setInterval(() => {
  const t = modClockText();
  if (modClockEl.textContent !== t) modClockEl.textContent = t;
}, 50);

midiExportBtn.addEventListener('click', exportMidi);
audioExportBtn.addEventListener('click', exportAudio);
stemExportBtn.addEventListener('click', openStemModal);
document.getElementById('resetPlayer').addEventListener('click', resetPlayer);

// The Tile Inspector — a modeless floating window of facts about the selected
// tile (see future_directions.md §12). It's opened only by this button (single/
// double click on a tile are already bound to select/open-in-grid). It follows
// the tile selection while open (refreshTileInspector runs from the same hook
// as the transform chips).
tileInspector = createInspector({
  title: 'Tile Inspector',
  transport: { onPlay: inspectorPlay, onStop: inspectorStop, onLoop: inspectorLoop },
});
tileInspector.onToggle = (open) => {
  tileInspectorBtn.classList.toggle('active', open);
  if (open) { refreshTileInspector(); syncInspectorTransport(); }
};
tileInspectorBtn.addEventListener('click', () => tileInspector.toggle());
// It may have auto-reopened from last session before onToggle was wired above —
// sync the button state (content is filled once the tile UI is built).
tileInspectorBtn.classList.toggle('active', tileInspector.isOpen());

// A tuning id → its display label ("12-ET", "16-ET", …).
const tuningLabelById = new Map(TUNING_LIST.map((t) => [t.id, t.label]));

// Build the facts data dump for the current anchor tile (the last-clicked tile
// in the selection). Everything shown is read-only for this first cut.
function tileInspectorFacts() {
  const anchor = arrangement.allTiles().find((t) => t.id === arrangement.selectedId);
  // No anchor → nothing selected. (A MULTI-selection still has an anchor — the
  // last-clicked tile — so the inspector shows THAT tile, and the transport plays
  // it; a "N tiles" note flags that the rest of the selection isn't shown.)
  if (!anchor) return { empty: 'Select a tile to inspect it.' };
  const lane = arrangement.laneOfTile(anchor.id);
  const laneIdx = arrangement.lanes.indexOf(lane);
  const p = library.patterns.get(anchor.name);
  const instr = lane && instrument(lane.patch && lane.patch.kind);

  const multi = arrangement.selectedIds.size > 1;
  const placement = [['Lane', lane ? `Lane ${laneIdx + 1}` : '—'], ['Start', `beat ${anchor.start}`]];
  const sections = [{ title: 'Placement', rows: placement }];

  if (p) {
    const lengthBeats = p.columns.reduce((s, c) => s + DURATIONS[c.durIndex].beats, 0);
    placement.push(['Length', `${+lengthBeats.toFixed(3)} beats`]);
    placement.push(['End', `beat ${+(anchor.start + lengthBeats).toFixed(3)}`]);
    const noteCols = p.columns.filter((c) => !c.isRest).length;
    sections.push({ title: 'Pattern', rows: [
      ['Name', p.name],
      ['Columns', String(p.columns.length)],
      ['Notes', `${noteCols} / ${p.columns.length}`],
      ['Tuning', tuningLabelById.get(p.tuningId) || p.tuningId],
      ['Scale', scaleById(p.scaleId).name],
      ['Key', pitchClassName(p.root, p.tuningId)],
    ] });
  } else {
    sections.push({ title: 'Pattern', rows: [['Name', `${anchor.name} (missing)`]] });
  }

  if (instr) {
    sections.push({ title: 'Instrument', rows: [
      ['Voice', instr.label],
      ['Type', instr.desc],
    ] });
  }

  const transforms = anchor.transforms || [];
  sections.push({ title: 'Transforms', rows: transforms.length
    ? transforms.map((t) => [transformKindLabel(t).kind, describeTransform(t)])
    : [['', 'none']] });

  const sub = multi ? `id ${anchor.id} · anchor of ${arrangement.selectedIds.size} selected` : `id ${anchor.id}`;
  // Heading shows the friendly name with the canonical registry name after it
  // ("Break Beat 2 (A6)"), or just the canonical name when unlabeled. Double-
  // clicking it renames the PATTERN (all tiles referencing it follow); the label
  // lives on the pattern, so clones — which mint a fresh canonical name — don't
  // inherit it (your spec). Commit = set label + refresh (persists, marks dirty,
  // re-renders). No pattern (shouldn't happen) → no rename.
  const canonical = anchor.name;
  const label = p ? p.label : '';
  const heading = label ? `${label} (${canonical})` : canonical;
  const rename = p ? {
    label, canonical,
    onCommit: (newLabel) => { p.label = newLabel; refresh(); },
  } : null;
  return { heading, sub, sections, rename };
}

// Push fresh facts into the inspector — cheap no-op while it's closed.
function refreshTileInspector() {
  if (!tileInspector || !tileInspector.isOpen()) return;
  tileInspector.setFacts(tileInspectorFacts());
  syncInspectorTransport(); // canPlay follows the anchor selection
}

let rafId = null;

function renderLoop() {
  // No roll playhead for a tile audition — the roll shows the arrangement (or
  // grid pattern), not the one tile being auditioned, so a sweep would lie.
  const rollBeat = scheduler.isPlaying && activeSource !== 'audit' ? scheduler.currentBeat : null;
  roll.draw(rollBeat);
  if (rollBeat != null) {
    ensureRollVisible(roll.xForBeat(rollBeat));
    if (activeSource === 'tiles') {
      // The scheduler runs in pass-relative beats (the windowed score); the tile
      // timeline is absolute, so add the pass origin back. When the position
      // jumps backward the loop wrapped — passes after the first always start at
      // the region start (a resume offsets only its own pass).
      const cur = scheduler.currentBeat;
      if (cur < lastCurBeat) passBase = playStartBeat();
      lastCurBeat = cur;
      const absBeat = passBase + cur;
      // The playhead marks real playback position — shown even mid-drag.
      tilePlayer.setPlayhead(absBeat);
      ensureTileVisible(absBeat);
      // The green "playing" badge is suppressed during a drag (prospective slots).
      if (!tileDrag) tilePlayer.setPlaying(playingTileIds(absBeat));
    } else {
      tilePlayer.setPlayhead(state.playheadBeat); // grid playback: the parked playhead stays put
    }
  }
  updateTransportButtons();
  if (scheduler.isPlaying) {
    rafId = requestAnimationFrame(renderLoop);
  } else {
    rafId = null;
    activeSource = null;
    tilePlayer.setPlaying(new Set());
    tilePlayer.setPlayhead(state.playheadBeat); // parked — the playhead never hides
    refresh();
  }
}

function startRender() { if (rafId === null) renderLoop(); }

async function startTransport(source, loop, fromBeat = null) {
  if (source === 'tiles' && arrangement.allTiles().length === 0) return;
  setActive(source);
  const now = await engine.ensureRunning();
  // The "elapsed" modulator clock's zero: the session's FIRST Play, counting up
  // from there (later plays do NOT reset it — modulators keep evolving).
  if (engine.modEpoch == null) engine.modEpoch = now;
  scheduler.stop();
  activeSource = source;
  // Arm a resume only when it lands strictly inside the region — at/before the
  // start it's just a normal play, at/after the end there'd be nothing to hear.
  resumeBeat = source === 'tiles' && fromBeat != null
    && fromBeat > playStartBeat() && fromBeat < playEndBeat() ? fromBeat : null;
  resumeStartTime = now + 0.1;
  passBase = resumeBeat != null ? resumeBeat : playStartBeat();
  // -Infinity, NOT 0: playback starts 100 ms in the future, so the first frames'
  // currentBeat is slightly NEGATIVE — seeding 0 would read that as a loop wrap
  // and instantly reset passBase, drawing a resumed pass's playhead at the start.
  lastCurBeat = -Infinity;
  if (source === 'tiles') applyLaneGains(0); // set mute/solo before the first note
  const provider = source === 'tiles' ? windowedArrangementScore : buildScore;
  scheduler.start(provider, now + 0.1, loop ? LOOP_STEP : 1, loop);
  startRender();
  updateTransportButtons();
}

// Loop tap: queue, don't interrupt. If this source is already playing — whether
// looping OR a one-shot still in progress — promote it to a loop in place and
// add LOOP_STEP passes (capped), without restarting. Only a stopped/other source
// starts fresh.
function loopClick(source) {
  if (activeSource === source && scheduler.isPlaying) {
    scheduler.loop = true; // promote a one-shot in progress to a loop
    scheduler.remaining = Math.min(scheduler.remaining + LOOP_STEP, LOOP_MAX);
    updateTransportButtons();
    return;
  }
  startTransport(source, true);
}

function stop() {
  // A manual Stop parks the playhead where playback was (a natural finish
  // rewinds it to the beginning instead — see scheduler.onEnded).
  const wasTiles = scheduler.isPlaying && activeSource === 'tiles';
  if (wasTiles) {
    state.playheadBeat = clampPlayhead(passBase + scheduler.currentBeat);
  }
  scheduler.stop();
  activeSource = null;
  auditTileId = null;
  resumeBeat = null;
  tilePlayer.setPlaying(new Set());
  tilePlayer.setPlayhead(state.playheadBeat);
  refresh();
  if (wasTiles) ensureTileVisible(state.playheadBeat); // stop with the playhead in view
}

// --- the parked playhead ------------------------------------------------
// Where the tile transport sits when stopped (beats, absolute; always visible).
// Space plays from the region start; ArrowRight resumes from the parked spot.

function clampPlayhead(beat) {
  return Math.max(0, Math.min(beat || 0, arrangementEndBeat()));
}

// Park the playhead (⏮/⏭ buttons, B/E keys) and scroll it into view. Stopped
// transport only — live locate is a bigger feature, deliberately not this one.
function movePlayhead(beat) {
  if (scheduler.isPlaying) return;
  state.playheadBeat = clampPlayhead(beat);
  tilePlayer.setPlayhead(state.playheadBeat);
  ensureTileVisible(state.playheadBeat);
  persist();
}

// ArrowRight: play the arrangement from the parked playhead — one pass of
// [playhead, region end); a Shift+Space loop promotion wraps to the region start.
function resumePlay() {
  if (scheduler.isPlaying || arrangement.allTiles().length === 0) return;
  if (state.playheadBeat >= playEndBeat()) return; // parked at/after the end — nothing to play
  startTransport('tiles', false, state.playheadBeat);
}

let transportSig = null; // last-applied state — this runs per animation frame
function updateTransportButtons() {
  const playing = scheduler.isPlaying;
  const haveTiles = arrangement.allTiles().length > 0;
  // Everything below derives from these inputs; skip the DOM when none changed.
  const sig = `${playing}|${haveTiles}|${activeSource}|${scheduler.isLooping}|${scheduler.remaining}|${exporting}|${exportingStems}`;
  if (sig === transportSig) return;
  transportSig = sig;

  playBtn.disabled = playing;
  stopBtn.disabled = !playing;
  tilePlayBtn.disabled = playing || !haveTiles;
  tileStopBtn.disabled = !playing;
  tileLoopBtn.disabled = !haveTiles;
  phHomeBtn.disabled = phEndBtn.disabled = playing; // playhead parks only while stopped
  midiExportBtn.disabled = !haveTiles;
  audioExportBtn.disabled = exporting || !haveTiles;
  stemExportBtn.disabled = exportingStems || !haveTiles;

  const gridLooping = activeSource === 'grid' && scheduler.isLooping;
  loopBtn.textContent = loopLabel(gridLooping);
  loopBtn.classList.toggle('active', gridLooping);

  const tilesLooping = activeSource === 'tiles' && scheduler.isLooping;
  tileLoopBtn.textContent = loopLabel(tilesLooping);
  tileLoopBtn.classList.toggle('active', tilesLooping);

  syncInspectorTransport(); // mirror onto the inspector's play/stop/loop cluster
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
phHomeBtn.addEventListener('click', () => movePlayhead(playStartBeat()));
phEndBtn.addEventListener('click', () => movePlayhead(playEndBeat()));
arrUndoBtn.addEventListener('click', arrUndo);
arrRedoBtn.addEventListener('click', arrRedo);
tileDeleteBtn.addEventListener('click', deleteSelectedTile);

// --- tile-player horizontal scale (quantized notches) -----------------

const tileScaleEl = document.getElementById('tileScale');
const tileZoomOutBtn = document.getElementById('tileZoomOut');
const tileZoomInBtn = document.getElementById('tileZoomIn');
const tileLaneEl = document.getElementById('tileLane');
tileScaleEl.max = String(TILE_SCALES.length - 1);

// Persist the tile player's horizontal scroll across reloads (user request —
// even with the playhead off screen, come back to the same view). Every scroll
// (manual, follow-jump, edge-jump) lands on state; the localStorage write is
// debounced so wheel-scrolling doesn't hammer persist().
let tileScrollTimer = null;
tileLaneEl.addEventListener('scroll', () => {
  state.tileScrollX = tileLaneEl.scrollLeft;
  clearTimeout(tileScrollTimer);
  tileScrollTimer = setTimeout(persist, 400);
});

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

// --- piano-roll zoom (quantized notches; view-only, persisted) ---------

const rollVEl = document.getElementById('rollVScale');
const rollHEl = document.getElementById('rollHScale');
rollVEl.max = String(ROLL_V_SCALES.length - 1);
rollHEl.max = String(ROLL_H_SCALES.length - 1);

function setRollZoom(vIdx, hIdx) {
  state.rollVIdx = Math.max(0, Math.min(ROLL_V_SCALES.length - 1, vIdx | 0));
  state.rollHIdx = Math.max(0, Math.min(ROLL_H_SCALES.length - 1, hIdx | 0));
  roll.setZoom(ROLL_V_SCALES[state.rollVIdx], ROLL_H_SCALES[state.rollHIdx]);
  rollVEl.value = String(state.rollVIdx);
  rollHEl.value = String(state.rollHIdx);
  if (!scheduler.isPlaying) roll.draw(); // playing: the render loop redraws anyway
  persist();
}
rollVEl.addEventListener('input', () => setRollZoom(Number(rollVEl.value), state.rollHIdx));
rollHEl.addEventListener('input', () => setRollZoom(state.rollVIdx, Number(rollHEl.value)));
document.getElementById('rollVOut').addEventListener('click', () => setRollZoom(state.rollVIdx - 1, state.rollHIdx));
document.getElementById('rollVIn').addEventListener('click', () => setRollZoom(state.rollVIdx + 1, state.rollHIdx));
document.getElementById('rollHOut').addEventListener('click', () => setRollZoom(state.rollVIdx, state.rollHIdx - 1));
document.getElementById('rollHIn').addEventListener('click', () => setRollZoom(state.rollVIdx, state.rollHIdx + 1));
rollVEl.value = String(state.rollVIdx); // reflect the restored zoom in the strip
rollHEl.value = String(state.rollHIdx);

tb.grabHandle.addEventListener('dragstart', (e) => {
  e.dataTransfer.setData('text/plain', 'pattern');
  e.dataTransfer.effectAllowed = 'copy';
});
// dragend always fires (drop or cancel) — the one reliable point to clear the
// grid-drag landing preview.
tb.grabHandle.addEventListener('dragend', () => clearGridDragPreview());

tempo.value = state.bpm;
tempoLabel.textContent = `${state.bpm} BPM`;
tempo.addEventListener('input', () => {
  state.bpm = Number(tempo.value);
  tempoLabel.textContent = `${state.bpm} BPM`;
  applyLaneDelayAll(); // delay time is tempo-synced
  refresh();
});

// --- master fader + output level meter --------------------------------

const masterGainEl = document.getElementById('masterGain');
masterGainEl.value = String(Math.round(state.masterGain * 100));
masterGainEl.addEventListener('input', () => {
  state.masterGain = Number(masterGainEl.value) / 100;
  engine.setMasterGain(state.masterGain);
  persist();
});

// A continuous (cheap) STEREO meter loop: reads the per-channel output peaks and
// draws two stacked dB bars (L over R) with peak-hold and a shared clip LED.
// Runs from load; reads 0 (idle) until audio starts.
const meterCanvas = document.getElementById('meter');
const meterCtx = meterCanvas.getContext('2d');
const clipLed = document.getElementById('clipLed');
const MW = meterCanvas.width, MH = meterCanvas.height;
const BAR_H = Math.floor((MH - 1) / 2);        // two bars + a 1px gap
const chan = { l: { bar: 0, hold: 0, holdF: 0 }, r: { bar: 0, hold: 0, holdF: 0 } };
let clipFrames = 0;     // clip LED latch (frames remaining lit) — either channel

// Level instrumentation (opt-in). Session running-max + clip count, queryable
// from the console via window.notorollaLevels(); set window.NOTO_LOG_LEVELS = true
// to also log each clip (throttled). notorollaResetLevels() clears the stats.
let peakMax = 0, clipCount = 0, lastClipLog = 0;
const toDb = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -Infinity);
window.notorollaLevels = () => ({ peakL: toDb(chan.l.bar), peakR: toDb(chan.r.bar), maxDb: toDb(peakMax), clips: clipCount });
window.notorollaResetLevels = () => { peakMax = 0; clipCount = 0; };

clipLed.addEventListener('click', () => { clipFrames = 0; clipLed.classList.remove('on'); });

const dbToX = (db) => Math.max(0, Math.min(1, (db + 60) / 60)) * MW; // -60..0 dBFS across the bar
const peakToX = (p) => (p > 0 ? dbToX(20 * Math.log10(p)) : 0);

// Gradient is constant (depends only on width); build it once.
const meterGrad = meterCtx.createLinearGradient(0, 0, MW, 0);
meterGrad.addColorStop(0, '#4caf6a');
meterGrad.addColorStop(dbToX(-12) / MW, '#7fc77a');
meterGrad.addColorStop(dbToX(-6) / MW, '#d6c34e');
meterGrad.addColorStop(dbToX(-3) / MW, '#e07a3a');
meterGrad.addColorStop(1, '#ff5050');

// Advance one channel's smoothed bar + peak-hold from this frame's peak.
function stepChannel(c, peak) {
  c.bar = peak >= c.bar ? peak : Math.max(peak, c.bar * 0.85);
  if (peak >= c.hold) { c.hold = peak; c.holdF = 45; }
  else if (c.holdF > 0) c.holdF--;
  else c.hold *= 0.94;
}

function drawBar(y, c) {
  meterCtx.fillStyle = meterGrad;
  meterCtx.fillRect(0, y, peakToX(c.bar), BAR_H);
  const hx = peakToX(c.hold);
  if (hx > 0) { meterCtx.fillStyle = '#e8eaf0'; meterCtx.fillRect(Math.min(MW - 1, hx - 1), y, 2, BAR_H); }
}

function drawMeter() {
  const { l, r } = engine.getPeak();
  stepChannel(chan.l, l);
  stepChannel(chan.r, r);
  const peak = Math.max(l, r);
  if (peak > peakMax) peakMax = peak;
  if (peak >= 1.0) {                           // clip = would clamp at the device (0 dBFS)
    clipFrames = 120;
    clipCount++;
    if (window.NOTO_LOG_LEVELS && performance.now() - lastClipLog > 500) {
      console.warn(`[noto level] CLIP — peak ${toDb(peak)} dBFS`);
      lastClipLog = performance.now();
    }
  } else if (clipFrames > 0) clipFrames--;
  clipLed.classList.toggle('on', clipFrames > 0);

  meterCtx.clearRect(0, 0, MW, MH);
  drawBar(0, chan.l);
  drawBar(MH - BAR_H, chan.r);

  requestAnimationFrame(drawMeter);
}
drawMeter();

// Deselect (Select None) for the active pane.
function selectNone() {
  if (activePane === 'tiles') deselectTile();
  else grid.clearSelection();
}
function deselectTile() {
  if (!arrangement.selectedIds.size) return;
  arrangement.clearSelection();
  tilePlayer.syncSelection();
  updateTileSelectionUI();
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

  if (e.key === 'Escape') {
    // (a range drag or marquee in progress owns Esc via its capture listener)
    if (rangeMode) { disarmRangeTool(); return; }
    selectNone(); return;
  }

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
      if (arrangement.selectedIds.size) { e.preventDefault(); deleteSelectedTile(); flash(tileDeleteBtn); }
    } else {
      e.preventDefault();
      grid.deleteSelection(); // selected notes -> rests (no toolbar button)
    }
    return;
  }
  // Tile-player playhead (stopped transport only): B/E park it at the
  // beginning/end; ArrowRight resumes playback from wherever it's parked.
  if (tiles && !mod && !scheduler.isPlaying) {
    if (k === 'b') { movePlayhead(playStartBeat()); flash(phHomeBtn); return; }
    if (k === 'e') { movePlayhead(playEndBeat()); flash(phEndBtn); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); resumePlay(); flash(tilePlayBtn); return; }
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !tiles) {
    e.preventDefault(); // scale-step within the active mask; Shift = a literal octave (equave)
    const up = e.key === 'ArrowUp';
    if (e.shiftKey) grid.transpose((up ? 1 : -1) * edoOf(library.current().tuningId));
    else grid.transposeScalar(up ? 1 : -1);
    flash(up ? tb.transUpBtn : tb.transDownBtn);
  }
});

// --- initial paint ----------------------------------------------------

ensureTileStarts(); // derive positions for tiles restored from an old gapless autosave
grid.updateCursor();
applyActiveHighlight();
updateScaleStrip();
buildTransformBar();
refresh(); // selection starts empty (runtime-only, not persisted)
// The parked playhead is always visible — restore it (clamped: the arrangement
// may have shrunk since it was persisted).
state.playheadBeat = clampPlayhead(state.playheadBeat);
tilePlayer.setPlayhead(state.playheadBeat);
// Restore the tile player's scroll (after the render above built the content;
// the browser clamps if the arrangement shrank).
tileLaneEl.scrollLeft = state.tileScrollX || 0;

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

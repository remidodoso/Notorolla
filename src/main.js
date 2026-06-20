// main.js — wire model, audio, scheduler, grid, roll, tiles, toolbar, panes.

import { AudioEngine } from './audio.js';
import { Scheduler } from './scheduler.js';
import { PianoRoll } from './pianoroll.js';
import { Note, Score } from './model.js';
import { Pattern, BASE_PITCH } from './grid.js';
import { PatternLibrary, Arrangement, laneColor } from './library.js';
import { enumerateTriadulations, familiesFor, familyLabel } from './triads.js';
import { edoOf, tuningFreq, pitchClassName } from './tuning.js';
import { scalesFor, scaleValidForEdo } from './scales.js';
import { notesToMidi } from './midi.js';
import { encodeWav } from './wav.js';
import { GridView } from './gridview.js';
import { TilePlayer, TILE_SCALES, DEFAULT_SCALE_IDX } from './tileplayer.js';
import { buildToolbar } from './toolbar.js';
import { buildInstrumentPane } from './instrumentpane.js';
import { normalizePatch, defaultPatch, clonePatch } from './instrument.js';
import { normalizeDelay } from './delay.js';
import { buildDelayEditor } from './delay.js';
import { normalizeChorus, buildChorusEditor } from './chorus.js';
import { applyTransforms, setTileTranspose, setTileReverse, hasReverse, describeTransform, transformKindLabel, normalizeTransforms } from './transforms.js';
import { openModal } from './modal.js';
import { setupPanes } from './panes.js';
import { VERSION, buildEnvelope, validate, migrate, defaultName, downloadJSON, downloadBytes, readFile } from './project.js';

const LIB_KEY = 'notorolla.lib';
const ARR_KEY = 'notorolla.arr';
const UI_KEY = 'notorolla.ui';
const LAYOUT_KEY = 'notorolla.layout2';
const PROJ_KEY = 'notorolla.proj'; // { name, snapshot } — current project identity + last-saved content
const PATCH_KEY = 'notorolla.patch'; // legacy single global patch — seeds existing lanes on first load, then vestigial
const GRIDPATCH_KEY = 'notorolla.gridpatch'; // the grid's neutral audition patch (a workspace preference, not in the project)
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

// Instrument patches now live per lane (lane.patch, saved with the project). The
// grid's click-to-hear / Test uses a separate neutral patch — a workspace
// preference kept out of the project (its own key, defaults to factory).
const gridPatch = normalizePatch(readJSON(GRIDPATCH_KEY));

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

// Resolve the patch for a voice: a lane's own patch, or the grid/neutral patch
// for un-laned sound (grid playback/audition). Read fresh per note, so edits in
// the instrument pane are heard on the next note.
engine.patch = gridPatch; // fallback default
engine.patchFor = (laneId) => {
  if (laneId == null) return gridPatch;
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

// (Re)apply every lane's chorus to the engine — after a modal edit or a load/undo.
function applyLaneChorusAll() {
  for (const lane of arrangement.lanes) engine.applyLaneChorus(lane.id);
}

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
            s.notes.map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity, freq: n.freq })),
            tile.transforms, { lengthBeats: s.lengthBeats, tuningId: p.tuningId, root: p.root })
        : s.notes;
      for (const n of src) {
        const nn = new Note(n.pitch, n.start + tile.start, n.duration, n.velocity);
        nn.freq = n.freq;         // carry each pattern's tuning-resolved frequency
        nn.color = color;
        nn.alpha = alpha;
        nn.laneId = lane.id;      // routes the voice through this lane's gain bus
        nn.muted = muted;         // for the roll's hatch (audio mute is the lane bus)
        nn.tileStart = tile.start; // this tile's start beat — the scheduler's commit unit
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
  const score = arrangementScore();
  const start = playStartBeat();
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
  onTileDown: (id, ev) => onTileDown(id, ev),
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
  onAddLane: () => addLane(),
  onResetLane: (laneId) => resetLane(laneId),
  onEdit: (laneId) => editLane(laneId),
  onMixStart: () => onMixStart(),
  onMixChange: (laneId, key, value) => onMixChange(laneId, key, value),
  onMixEnd: () => onMixEnd(),
  onMarkerStart: () => onMixStart(),                // reuse the arrangement-edit bracket
  onMarkers: (start, end) => setPlayMarkers(start, end),
  onDelay: (laneId) => openDelayModal(laneId),
  onChorus: (laneId) => openChorusModal(laneId),
});

// Open the per-lane delay editor in a modal. The whole editing session is ONE
// undo step: snapshot on open (the shared arrangement-edit bracket), apply each
// change to the audio live, and commit on close. No undo while the modal is open.
function openDelayModal(laneId) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  const idx = arrangement.lanes.indexOf(lane);
  onMixStart(); // capture the pre-edit snapshot
  const body = buildDelayEditor(lane.delay, { onChange: () => engine.applyLaneDelay(laneId) });
  openModal({
    title: `Delay — Lane ${idx + 1}`,
    body,
    onClose: () => {
      engine.applyLaneDelay(laneId);
      onMixEnd();          // commit one undo step if changed + persist + dirty
      tilePlayer.render(); // reflect the D-button lit state
    },
  });
}

// Open the per-lane chorus editor in a modal — same one-undo-step bracket as the
// delay modal (snapshot on open, apply live on each change, commit on close).
function openChorusModal(laneId) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  const idx = arrangement.lanes.indexOf(lane);
  onMixStart(); // capture the pre-edit snapshot
  const body = buildChorusEditor(lane.chorus, { onChange: () => engine.applyLaneChorus(laneId) });
  openModal({
    title: `Chorus — Lane ${idx + 1}`,
    body,
    onClose: () => {
      engine.applyLaneChorus(laneId);
      onMixEnd();          // commit one undo step if changed + persist + dirty
      tilePlayer.render(); // reflect the C-button lit state
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
// playing"). No modifier = move (keeps the tile id so selection follows); Shift =
// a shallow copy (new id, same pattern reference). A committed reorder's audio
// lands at the next loop boundary, like other live edits.
const DRAG_THRESH = 5; // px of movement before a press becomes a drag (else click)
let tileDrag = null;   // { id, fromLaneId, preview } while a drag is active

// pointerdown on a tile: decide click vs drag from movement, via window-level
// listeners (so they survive the re-renders the preview triggers).
function onTileDown(id, ev) {
  if (ev.button != null && ev.button !== 0) return;
  if (brushMode === 'transpose') return onTransposePaint(id, ev); // armed brush → paint, not move/select
  if (brushMode === 'reverse') return onReversePaint(id, ev);
  const startX = ev.clientX, startY = ev.clientY;
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESH) return;
      dragging = true;
      startTileDrag(id);
    }
    updateTileDrag(e);
  };
  const onUp = (e) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (dragging) endTileDrag(e);
    else selectTile(id); // no movement → it was a click
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function startTileDrag(id) {
  const lane = arrangement.laneOfTile(id);
  tileDrag = { id, fromLaneId: lane ? lane.id : null, preview: null };
  tilePlayer.setPlaying(new Set()); // drop the green "playing" badge while dragging
  tilePlayer.makeGhost(id);
}

function updateTileDrag(e) {
  const copy = e.shiftKey;
  const tgt = tilePlayer.dropTarget(e.clientX, e.clientY);
  const preview = tgt
    ? { id: tileDrag.id, fromLaneId: tileDrag.fromLaneId, copy, toLaneId: tgt.laneId, start: tgt.start }
    : null;
  if (!samePreview(preview, tileDrag.preview)) {
    tileDrag.preview = preview;
    tilePlayer.render(preview, true); // animate the live ripple
  }
  tilePlayer.moveGhost(e.clientX, e.clientY, copy);
}

function endTileDrag(e) {
  const preview = tileDrag.preview;
  tilePlayer.clearGhost();
  tileDrag = null;

  if (!preview) { refresh(); return; } // dropped off the lanes → cancel
  const copy = e.shiftKey;             // authoritative copy state at the drop

  // Moving/copying a tile into a FRESH lane (brand-new / just-reset) seeds that
  // lane's instrument from the SOURCE lane (a tile carries no patch — its lane
  // does), so the tile keeps sounding the way it did. A lane that's been used
  // keeps its own instrument.
  const destLane = arrangement.lane(preview.toLaneId);
  const seedFromSource = destLane && destLane.fresh && preview.toLaneId !== preview.fromLaneId;
  const srcPatch = seedFromSource ? (arrangement.lane(preview.fromLaneId) || {}).patch : null;

  const before = arrSnap();
  const newId = copy
    ? arrangement.copyTile(preview.id, preview.toLaneId, preview.start, patternLen)
    : (arrangement.moveTile(preview.id, preview.toLaneId, preview.start, patternLen), preview.id);
  arrCommit(before);
  if (srcPatch) destLane.patch = clonePatch(srcPatch); // adopt the source instrument
  if (destLane) destLane.fresh = false;                // the lane now has a tile
  arrangement.activeLaneId = preview.toLaneId;
  arrangement.selectedId = newId;
  refresh();
}

function samePreview(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.copy === b.copy && a.toLaneId === b.toLaneId
    && a.start === b.start && a.fromLaneId === b.fromLaneId;
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
  refreshTransformBar();
  persist();
}

// --- transform brushes: paint per-tile transforms (Transpose, Reverse) --------
//
// Armed via the transform bar (one brush at a time). While a brush is armed, a
// click / click-drag over tiles PAINTS it onto each instead of the normal
// select/move: Transpose SETs the tile's transpose to the brush amount (a second
// transpose replaces it; amount 0 clears); Reverse toggles the tile, with the drag
// anchor deciding the on/off state that's then painted across the sweep. Transforms
// are nondestructive (an ordered list applied in arrangementScore) and undoable.
let brushMode = null;                                  // null | 'transpose' | 'reverse'
const transposeOpts = { amount: 1, scaleId: 'auto' };  // persists across arming

// Paint the transpose brush onto one tile. Scale 'auto' = the tile's own mask
// (else the chosen mask); root is always the tile's.
function paintTranspose(tid) {
  const tile = arrangement.allTiles().find((t) => t.id === tid);
  if (!tile) return;
  const p = library.patterns.get(tile.name);
  const root = p ? p.root : 0;
  const scaleId = transposeOpts.scaleId === 'auto' ? (p ? p.scaleId : 'chromatic') : transposeOpts.scaleId;
  setTileTranspose(tile, transposeOpts.amount, scaleId, root);
}

// A paint gesture (click or click-drag across tiles) = one undo step. `apply(tid)`
// mutates one tile; it runs on the anchor and each tile the drag sweeps (once each).
function paintGesture(startId, apply) {
  const before = arrSnap();
  const painted = new Set();
  const touch = (tid) => {
    if (tid == null || painted.has(tid)) return;
    painted.add(tid);
    apply(tid);
    tilePlayer.render(); // show the swath(s) live as the sweep touches each tile
  };
  touch(startId);
  const onMove = (e) => touch(tilePlayer.tileAt(e.clientX, e.clientY));
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    arrCommit(before);
    selectTile(startId); // reflect it in the transform bar + roll, persist
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function onTransposePaint(startId, ev) {
  if (ev.button != null && ev.button !== 0) return;
  paintGesture(startId, paintTranspose);
}

// Reverse: the anchor tile toggles to a new state, then that state is painted
// across the whole sweep (so a drag sets them all the same, not flip-flopping).
function onReversePaint(startId, ev) {
  if (ev.button != null && ev.button !== 0) return;
  const anchor = arrangement.allTiles().find((t) => t.id === startId);
  const target = anchor ? !hasReverse(anchor.transforms) : true;
  paintGesture(startId, (tid) => {
    const tile = arrangement.allTiles().find((t) => t.id === tid);
    if (tile) setTileReverse(tile, target);
  });
}

// Arm/disarm a brush (mutually exclusive; clicking the armed one or Esc disarms).
function setBrush(mode) {
  brushMode = brushMode === mode ? null : mode;
  tileLaneEl.classList.toggle('brush', !!brushMode);
  refreshTransformBar();
}
function disarmBrush() { if (brushMode) setBrush(brushMode); }
function bumpBrush(d) {
  transposeOpts.amount = Math.max(-24, Math.min(24, transposeOpts.amount + d));
  refreshTransformBar();
}

// Remove one transform from a tile (a chip's ✕), undoable.
function removeTileTransform(id, kind) {
  const tile = arrangement.allTiles().find((t) => t.id === id);
  if (!tile) return;
  const before = arrSnap();
  if (kind === 'transpose') setTileTranspose(tile, 0);
  else if (kind === 'reverse') setTileReverse(tile, false);
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
  refresh();
}

// The transform bar: the Transpose + Reverse brush toggles, Transpose's armed
// controls (amount stepper + scale select), and the selected tile's ordered
// transform chips (each clearable). One bar, two roles (tool palette + per-tile
// readout). Built once; refreshTransformBar syncs state.
const transformBarEl = document.getElementById('transformBar');
let xbTransBtn, xbRevBtn, xbArmedEl, xbAmountEl, xbScaleSel, xbSelEl;

function buildTransformBar() {
  transformBarEl.innerHTML = '';
  const mkBtn = (text, title, onclick) => { const b = document.createElement('button'); b.textContent = text; b.title = title; b.onclick = onclick; return b; };

  xbTransBtn = document.createElement('button');
  xbTransBtn.className = 'xb-brush xf-transpose';
  xbTransBtn.textContent = 'Transpose';
  xbTransBtn.title = 'Transpose brush — arm, then click or drag over tiles to transpose them (Esc disarms)';
  xbTransBtn.onclick = () => setBrush('transpose');

  // Transpose's controls (amount + scale), shown only when it's armed.
  xbArmedEl = document.createElement('span');
  xbArmedEl.className = 'xb-armed';
  xbAmountEl = document.createElement('span');
  xbAmountEl.className = 'xb-amt-val';
  xbScaleSel = document.createElement('select');
  xbScaleSel.className = 'xb-scale';
  xbScaleSel.title = 'The scale the steps walk (Auto = each tile’s own mask)';
  for (const [val, label] of [['auto', 'Auto (from tile)'], ['major-pent', 'Major pentatonic'], ['minor-pent', 'Minor pentatonic'], ['chromatic', 'Chromatic']]) {
    const o = document.createElement('option'); o.value = val; o.textContent = label; xbScaleSel.append(o);
  }
  xbScaleSel.onchange = () => { transposeOpts.scaleId = xbScaleSel.value; };
  xbArmedEl.append(mkBtn('−', 'Down one step', () => bumpBrush(-1)), xbAmountEl, mkBtn('+', 'Up one step', () => bumpBrush(1)), xbScaleSel);

  xbRevBtn = document.createElement('button');
  xbRevBtn.className = 'xb-brush xf-reverse';
  xbRevBtn.textContent = '◄ Reverse';
  xbRevBtn.title = 'Reverse brush — arm, then click or drag over tiles to reverse them (Esc disarms)';
  xbRevBtn.onclick = () => setBrush('reverse');

  xbSelEl = document.createElement('span');
  xbSelEl.className = 'xb-sel';

  transformBarEl.append(xbTransBtn, xbArmedEl, xbRevBtn, xbSelEl);
  refreshTransformBar();
}

function refreshTransformBar() {
  if (!xbTransBtn) return;
  xbTransBtn.classList.toggle('active', brushMode === 'transpose');
  xbRevBtn.classList.toggle('active', brushMode === 'reverse');
  xbArmedEl.style.display = brushMode === 'transpose' ? '' : 'none';
  xbAmountEl.textContent = (transposeOpts.amount > 0 ? '+' : '') + transposeOpts.amount;
  xbScaleSel.value = transposeOpts.scaleId;

  // The selected tile's transforms, as ordered removable chips.
  xbSelEl.innerHTML = '';
  const id = arrangement.selectedId;
  const tile = id != null ? arrangement.allTiles().find((t) => t.id === id) : null;
  const transforms = tile && tile.transforms ? tile.transforms : [];
  if (transforms.length) {
    for (const t of transforms) {
      const { kind } = transformKindLabel(t);
      const chip = document.createElement('span');
      chip.className = 'xb-chip xf-' + kind;
      chip.append(document.createTextNode(describeTransform(t) + ' '));
      const x = document.createElement('button');
      x.textContent = '✕'; x.title = 'Remove this transform';
      x.onclick = () => removeTileTransform(id, kind);
      chip.append(x);
      xbSelEl.append(chip);
    }
  } else if (tile) {
    const m = document.createElement('span');
    m.className = 'xb-muted';
    m.textContent = 'no transforms';
    xbSelEl.append(m);
  }
}

// Double-click: load the tile's pattern into the editor (by reference) but keep
// the tile player active and the tile selected.
function openTile(name, id) {
  if (brushMode) return; // ignore opens while a brush is armed
  setActive('tiles');
  clearProposal();
  grid.clearSelection();
  const lane = arrangement.laneOfTile(id);
  if (lane) arrangement.activeLaneId = lane.id;
  library.open(name);
  centerGridOn(library.current()); // bring the opened pattern into view
  arrangement.selectedId = id;
  refresh();
  scrollRollToSelected();
}

// Edit-instrument pane (the Vesperia). An editor panel, not a transport pane:
// it doesn't touch activePane or the shortcut routing. The pane edits ONE target
// patch at a time (a lane's, or the grid's neutral one). Slider edits mutate
// that patch in place (heard on the next note) and autosave the right place.
const instrPane = buildInstrumentPane(document.getElementById('instr'), {
  onChange: persistPatch,
  onKindChange: changeKind,
  onTest: testInstrument,
  onReset: resetInstrument,
  onCopy: copyPatch,
  onPaste: pastePatch,
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
  swapTargetPatch(stash[kind] ? clonePatch(stash[kind]) : defaultPatch(kind));
}

// Point the editor at the grid's neutral patch (when the grid pane has focus).
function editGrid() {
  editTarget = { patch: gridPatch, laneId: null };
  tilePlayer.editLaneId = null;
  instrPane.setTarget(gridPatch, 'Grid', '#8a8f98');
  tilePlayer.render();
}

// Point the editor at a lane's own patch (its Edit button), scrolling the pane
// into view if it's off-screen so the sliders are actually visible.
function editLane(laneId) {
  const lane = arrangement.lane(laneId);
  if (!lane) return;
  const idx = arrangement.lanes.indexOf(lane);
  editTarget = { patch: lane.patch, laneId };
  tilePlayer.editLaneId = laneId;
  instrPane.setTarget(lane.patch, `Lane ${idx + 1}`, laneColor(idx));
  tilePlayer.render();
  document.getElementById('instr').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
}

// Audition the target patch on a fixed mid-register note (independent of the
// Audition toggle, which gates click-to-hear on the grid). A lane target plays
// through that lane's bus so Mute/Solo apply; the grid target is un-laned.
async function testInstrument() {
  const t = await engine.ensureRunning();
  const cur = library.current();
  engine.playNote(60, t + 0.005, 60 / state.bpm, 0.85, tuningFreq(60, cur.tuningId, cur.root), editTarget.laneId);
}

function resetInstrument() {
  // Reset to THIS instrument's defaults (not always Vesperia's).
  swapTargetPatch(defaultPatch(editTarget.patch.kind));
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
  disarmBrush(); // a tile brush belongs to the tiles pane; leaving it puts the brush away
  activePane = pane;
  state.activePane = pane;
  if (pane === 'grid') { arrangement.selectedId = null; tilePlayer.setSelected(null); editGrid(); }
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

// Keep the tile-player playhead on screen. The playhead's x within the scroll
// content is the (sticky) lane-header width plus its track position, so we don't
// scroll it behind the header.
function ensureTileVisible(beat) {
  const el = document.getElementById('tileLane');
  const head = el.querySelector('.lane-head');
  const headW = head ? head.offsetWidth : 0;
  const x = headW + beat * tilePlayer.ppb;
  const margin = 80;
  if (x > el.scrollLeft + el.clientWidth - margin) el.scrollLeft = x - el.clientWidth + margin;
  else if (x < el.scrollLeft + headW + margin) el.scrollLeft = Math.max(0, x - headW - margin);
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
  // Instrument tweaks aren't part of tile undo/redo (the editor is a live panel,
  // as the global patch was). Normally carry each lane's CURRENT patch across by
  // id, so undoing a tile move never reverts a later sound edit (a lane reappearing
  // on redo takes its snapshot patch). A `full` entry — a lane/player reset, which
  // changes the patch on purpose — restores the snapshot patch so it's undoable.
  const livePatch = new Map(arrangement.lanes.map((l) => [l.id, l.patch]));
  arrangement.lanes = o.lanes.map((l) => ({
    id: l.id,
    tiles: l.tiles.map((t) => ({ id: t.id, name: t.name, start: t.start, transforms: normalizeTransforms(t.transforms) })),
    mute: !!l.mute, solo: !!l.solo,
    gain: l.gain == null ? 1 : l.gain, pan: l.pan == null ? 0 : l.pan, // mixer IS undoable
    delay: normalizeDelay(l.delay), // delay edits are undoable too
    chorus: normalizeChorus(l.chorus), // chorus edits are undoable too
    patch: full ? normalizePatch(l.patch) : (livePatch.get(l.id) || normalizePatch(l.patch)),
    fresh: !!l.fresh,
  }));
  arrangement.seq = o.seq || 0;
  if (o.activeLaneId != null) arrangement.activeLaneId = o.activeLaneId;
  arrangement.playStart = o.playStart == null ? 0 : o.playStart; // region markers are undoable
  arrangement.playEnd = o.playEnd == null ? null : o.playEnd;
  if (!arrangement.allTiles().some((t) => t.id === arrangement.selectedId)) arrangement.selectedId = null;
  applyLaneMix(0.012);  // restored pan/gain → push to the (existing) lane buses
  applyLaneDelayAll();  // restored delay → rebuild/update the inserts
  applyLaneChorusAll(); // restored chorus → rebuild the inserts
  // If the editor was on a lane the undo/redo removed, drop back to the grid.
  if (editTarget && editTarget.laneId != null && !arrangement.lane(editTarget.laneId)) editGrid();
}
function arrUndo() { if (!arrPast.length) return; const e = arrPast.pop(); arrFuture.push({ snap: arrSnap(), full: e.full }); arrApply(e.snap, e.full); refresh(); }
function arrRedo() { if (!arrFuture.length) return; const e = arrFuture.pop(); arrPast.push({ snap: arrSnap(), full: e.full }); arrApply(e.snap, e.full); refresh(); }

function appendCurrentTile(laneId) {
  arrRecord();
  // Dropping into a FRESH lane (brand-new / just-reset) seeds it with the grid's
  // instrument (the patch you were just auditioning), so the tile sounds the way
  // it did in the grid. A lane that's been used keeps its established instrument.
  // Clone so the lane's patch doesn't alias (and keep being edited by) the grid's.
  const lane = arrangement.lane(laneId);
  if (lane && lane.fresh) lane.patch = clonePatch(gridPatch);
  arrangement.append(laneId, library.current().name, patternLen);
  if (lane) lane.fresh = false; // the lane now has a tile
  arrangement.activeLaneId = laneId;
  refresh();
}
function deleteSelectedTile() {
  if (arrangement.selectedId == null) return;
  arrRecord();
  arrangement.removeRipple(arrangement.selectedId, patternLen); // ripple-close the gap
  refresh();
}

// --- pattern lifecycle ------------------------------------------------

// Re-center the grid's pitch viewport on a pattern's notes, so opening one that
// sits a couple of octaves away doesn't land off-screen. Best-effort: centers on
// the note span's midpoint, clamped to the navigable range (C1..C8); leaves the
// view untouched for an empty (note-less) pattern.
function centerGridOn(pattern) {
  const degs = pattern.columns.filter((c) => !c.isRest).map((c) => c.degree);
  if (!degs.length) return;
  const mid = (Math.min(...degs) + Math.max(...degs)) / 2;
  const rows = state.visibleRows;
  const top = Math.round(mid + (rows - 1) / 2);
  state.topDegree = Math.max(24 + rows - 1, Math.min(108, top)); // MIN_DEGREE/MAX_DEGREE in gridview.js
}

function newOrRestore() {
  clearProposal();
  grid.clearSelection();
  if (library.parkedName) library.restore();
  else library.newPattern();
  arrangement.selectedId = null;
  centerGridOn(library.current()); // no-op for the blank New pattern
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
  grid.pattern = library.current();
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
    cursor: state.cursor, highlightRows: state.highlightRows, showTriads: state.showTriads, proper: state.proper, families: state.families,
    topDegree: state.topDegree, visibleRows: state.visibleRows, activePane: state.activePane,
    tileScaleIdx: state.tileScaleIdx, masterGain: state.masterGain,
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
  ensureTileStarts(); // derive positions for tiles loaded from an old gapless file
  centerGridOn(library.current()); // bring the loaded pattern into view
  activePane = 'grid';
  state.activePane = 'grid';
  applyActiveHighlight();
  editGrid(); // the loaded lanes have fresh patch objects; re-point the editor
  engine.resetLanes(); // drop stale strips (old delay tails / orphaned lanes) — rebuild fresh
  applyLaneMix(0);     // push the loaded volume/pan onto the lane buses
  applyLaneDelayAll(); // and the loaded delays
  applyLaneChorusAll(); // and the loaded choruses
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
            durBeats: n.duration * state.articulation,
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
      duration: n.duration * state.articulation * spb,
      velocity: n.velocity,
      freq: n.freq,
      laneId: n.laneId, // render through this lane's instrument patch
    });
  }
  if (!notes.length) return;
  // Release tail: let the longest-releasing lane ring out fully.
  const maxRelease = Math.max(gridPatch.release, ...arrangement.lanes.map((l) => l.patch.release));
  const tail = Math.max(2.5, maxRelease * 6 + 0.5);
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
const tempo = document.getElementById('tempo');
const tempoLabel = document.getElementById('tempoLabel');
const arrUndoBtn = document.getElementById('arrUndo');
const arrRedoBtn = document.getElementById('arrRedo');
const tileDeleteBtn = document.getElementById('tileDelete');
const midiExportBtn = document.getElementById('midiExport');
const audioExportBtn = document.getElementById('audioExport');
const exportProgEl = document.getElementById('exportProg');
const gridName = document.getElementById('gridName');

midiExportBtn.addEventListener('click', exportMidi);
audioExportBtn.addEventListener('click', exportAudio);
document.getElementById('resetPlayer').addEventListener('click', resetPlayer);

let rafId = null;

function renderLoop() {
  roll.draw(scheduler.isPlaying ? scheduler.currentBeat : null);
  if (scheduler.isPlaying) {
    ensureRollVisible(roll.xForBeat(scheduler.currentBeat));
    if (activeSource === 'tiles') {
      // The scheduler runs in region-relative beats (the windowed score); the tile
      // timeline is absolute, so add the region start back for the playhead/highlight.
      const absBeat = playStartBeat() + scheduler.currentBeat;
      // The playhead marks real playback position — shown even mid-drag.
      tilePlayer.setPlayhead(absBeat);
      ensureTileVisible(absBeat);
      // The green "playing" badge is suppressed during a drag (prospective slots).
      if (!tileDrag) tilePlayer.setPlaying(playingTileIds(absBeat));
    } else {
      tilePlayer.setPlayhead(null); // grid playback: no tile playhead
    }
  }
  updateTransportButtons();
  if (scheduler.isPlaying) {
    rafId = requestAnimationFrame(renderLoop);
  } else {
    rafId = null;
    activeSource = null;
    tilePlayer.setPlaying(new Set());
    tilePlayer.setPlayhead(null);
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
  audioExportBtn.disabled = exporting || !haveTiles;

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

  if (e.key === 'Escape') { if (brushMode) { disarmBrush(); return; } selectNone(); return; }

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
if (arrangement.selectedId != null) tilePlayer.setSelected(arrangement.selectedId);
refresh();

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

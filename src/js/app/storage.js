// storage.js — persistence layer: localStorage keys, the persisted-UI `state`
// object, and the read/write helpers. initStorage runs FIRST (main.js consumes
// state / readJSON at the very top), registering ctx.state / ctx.persist /
// ctx.safeSet (readJSON is a pure export, imported directly). persist() reads
// ctx.library / ctx.arrangement / ctx.recomputeDirty lazily — they don't exist
// yet when initStorage runs.

import { referenceToJSON, referenceFromJSON } from '../core/reference.js';
import { DEFAULT_SCALE_IDX } from '../ui/tileplayer.js';
import { ROLL_V_DEFAULT, ROLL_H_DEFAULT } from '../ui/pianoroll.js';

export const LIB_KEY = 'notorolla.lib';
export const ARR_KEY = 'notorolla.arr';
export const UI_KEY = 'notorolla.ui';
export const LAYOUT_KEY = 'notorolla.layout2';
export const PROJ_KEY = 'notorolla.proj'; // { name, snapshot } — current project identity + last-saved content
export const PATCH_KEY = 'notorolla.patch'; // legacy single global patch — seeds existing lanes on first load, then vestigial
export const GRIDPATCH_KEY = 'notorolla.gridpatch'; // the grid's neutral audition patch (a workspace preference, not in the project)
export const PATCHES_KEY = 'notorolla.patches'; // the user-global patch catalog (cross-project, not in any project file)
export const GRIDMETA_KEY = 'notorolla.gridpatchmeta'; // the grid patch's identity (workspace pref, like the grid patch)

export function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

export function initStorage(ctx) {
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
    families: { trad: true, sus: false, mavila: true, septimal: true }, // Triadulator: enabled chord families (per id)
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
    reference: null,    // the frozen grid-editor reference backdrop (a workspace pref; cleared on project Open/New)
    refPrevMode: null,  // the layout mode to restore when the reference is cleared
  };
  Object.assign(state, readJSON(UI_KEY) || {});
  // The reference rides the workspace UI state as its compact JSON; rehydrate it
  // (self-contained, so it never dangles) and honor its forced Stretch layout.
  state.reference = state.reference ? referenceFromJSON(state.reference) : null;
  if (state.reference) state.mode = 'stretch';
  // Migrate older persisted UI state (top-level trad/sus booleans) to the per-id
  // families map, and make sure the map exists and seeds new families on.
  if (!state.families || typeof state.families !== 'object') {
    state.families = { trad: state.trad !== false, sus: !!state.sus, septimal: true };
  }
  if (state.families.septimal === undefined) state.families.septimal = true;
  if (state.families.mavila === undefined) state.families.mavila = true; // new family seeds on
  delete state.trad; delete state.sus;

  // If localStorage.setItem throws (private mode / quota), warn ONCE and drop the
  // unload warning. A reload otherwise restores everything, so we don't nag.
  ctx.storageOK = true; // read by main.js's beforeunload handler
  function safeSet(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (e) {
      if (ctx.storageOK) console.warn('Notorolla: localStorage write failed — unsaved work may be lost on reload', e);
      ctx.storageOK = false;
    }
  }

  function persist() {
    safeSet(LIB_KEY, JSON.stringify(ctx.library.toJSON()));
    safeSet(ARR_KEY, JSON.stringify(ctx.arrangement.toJSON()));
    safeSet(UI_KEY, JSON.stringify({
      bpm: state.bpm, brush: state.brush, mode: state.mode, audition: state.audition,
      cursor: state.cursor, highlightRows: state.highlightRows, showTriads: state.showTriads, proper: state.proper, families: state.families,
      topDegree: state.topDegree, visibleRows: state.visibleRows, activePane: state.activePane,
      tileScaleIdx: state.tileScaleIdx, masterGain: state.masterGain, modLoop: state.modLoop, lite: state.lite,
      gridInstr: state.gridInstr, parkedInstr: state.parkedInstr,
      ripple: state.ripple, playheadBeat: state.playheadBeat, tileScrollX: state.tileScrollX,
      rollVIdx: state.rollVIdx, rollHIdx: state.rollHIdx,
      reference: referenceToJSON(state.reference), refPrevMode: state.refPrevMode,
    }));
    ctx.recomputeDirty();
  }

  Object.assign(ctx, { state, safeSet, persist });
}

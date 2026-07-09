// projectio.js — the project document layer: name / dirty-tracking against a
// saved baseline, Save / Open / New, and loadContent (replace the live library +
// arrangement in place). Distinct from the continuous localStorage autosave.

import { PatternLibrary, Arrangement } from '../core/library.js';
import { VERSION, buildEnvelope, validate, migrate, defaultName, downloadJSON, readFile } from '../core/project.js';
import { PROJ_KEY, readJSON } from './storage.js';

export function initProjectio(ctx) {
  const { library, arrangement, state, engine, grid, tilePlayer, patches } = ctx;
  const tempo = document.getElementById('tempo');
  const tempoLabel = document.getElementById('tempoLabel');

  ctx.projectName = null;   // current document name (no extension), or null = untitled
  let savedSnapshot = null; // contentSnapshot() at the last save/load
  let dirty = false;

  const savedProj = readJSON(PROJ_KEY);
  if (savedProj) { ctx.projectName = savedProj.name || null; savedSnapshot = savedProj.snapshot || null; }

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
    ctx.safeSet(PROJ_KEY, JSON.stringify({ name: ctx.projectName, snapshot: savedSnapshot }));
  }

  function updateProjectBar() {
    projNameEl.textContent = ctx.projectName || 'untitled';
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
    const freshLib = PatternLibrary.fromJSON(env.lib, ctx.isReferenced);
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
    ctx.clearProposal();
    grid.clearSelection();
    // A reference points into THIS session's arrangement — a fresh document clears it
    // (a workspace pref, so it survives a plain reload but not an Open/New).
    if (state.reference) { state.reference = null; state.mode = state.refPrevMode || 'grid'; state.refPrevMode = null; ctx.syncReference(); }
    ctx.ensureTileStarts(); // derive positions for tiles loaded from an old gapless file
    ctx.centerGridOn(library.current()); // bring the loaded pattern into view
    ctx.activePane = 'grid';
    state.activePane = 'grid';
    state.playheadBeat = 0; // fresh document — park the playhead at the top
    tilePlayer.setPlayhead(0);
    ctx.applyActiveHighlight();
    ctx.gridInstr = { source: 'grid' }; state.gridInstr = null; ctx.setParkedInstr(null); // fresh document → grid's own instrument
    ctx.editGrid(); // the loaded lanes have fresh patch objects; re-point the editor
    engine.resetLanes(); // drop stale strips (old delay tails / orphaned lanes) — rebuild fresh
    ctx.applyLaneMix(0);     // push the loaded volume/pan onto the lane buses
    ctx.applyLaneDelayAll(); // and the loaded delays
    ctx.applyLaneChorusAll(); // and the loaded choruses
    ctx.applyLaneReverbAll();  // and the loaded reverbs
    ctx.refresh();
  }

  function saveProject() {
    const input = prompt('Save project as:', ctx.projectName || defaultName());
    if (input == null) return;
    const stem = input.trim().replace(/\.json$/i, '');
    if (!stem) return;
    const env = buildEnvelope({ name: stem, lib: library.toJSON(), arr: arrangement.toJSON(), tempo: state.bpm });
    downloadJSON(`${stem}.json`, env);
    ctx.projectName = stem;
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
    ctx.projectName = env.name || file.name.replace(/\.json$/i, '');
    markClean();
  }

  function newProject() {
    if (dirty && !confirm('You have unsaved changes. Start a new project and discard them?')) return;
    ctx.stop();
    loadContent({ lib: { patterns: [], counter: 0, currentName: null, parkedName: null }, arr: {}, tempo: 120 });
    ctx.projectName = null;
    markClean();
  }

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

  projNewBtn.addEventListener('click', newProject);
  projSaveBtn.addEventListener('click', saveProject);
  projOpenBtn.addEventListener('click', () => projFileInput.click());
  projFileInput.addEventListener('change', () => {
    const file = projFileInput.files[0];
    projFileInput.value = ''; // allow re-opening the same file later
    if (file) openProject(file);
  });

  Object.assign(ctx, { recomputeDirty });
}

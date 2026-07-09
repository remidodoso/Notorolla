// history.js — the two undo/redo stacks: per-pattern (grid) and arrangement.
// Both stacks and their whole API register on ctx (called from many clusters);
// they call back into ctx.refresh and, on an arrangement restore, the lane-FX
// re-appliers (ctx.applyLaneMix / ...DelayAll / ...ChorusAll / ...ReverbAll) and
// ctx.editGrid — all still main.js residents until later phases.

import { Pattern } from '../core/grid.js';
import { normalizeTransforms } from '../core/transforms.js';
import { normalizeDelay } from '../audio/delay.js';
import { normalizeChorus } from '../audio/chorus.js';
import { normalizeReverb } from '../audio/reverb.js';
import { normalizeModsByKind } from '../audio/mods.js';
import { normalizePatch } from '../audio/instrument.js';
import { factoryInitId } from '../audio/patches.js';

const HISTORY_LIMIT = 200;

export function initHistory(ctx) {
  const { library, arrangement } = ctx;

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
    ctx.refresh();
  }
  function redo() {
    const h = hist(library.currentName);
    if (!h.future.length) return;
    h.past.push(curSnap());
    applyCur(h.future.pop());
    ctx.refresh();
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
    ctx.applyLaneMix(0.012);  // restored pan/gain → push to the (existing) lane buses
    ctx.applyLaneDelayAll();  // restored delay → rebuild/update the inserts
    ctx.applyLaneChorusAll(); // restored chorus → rebuild the inserts
    ctx.applyLaneReverbAll();  // restored reverb → rebuild the inserts
    // If the editor was on a lane the undo/redo removed, drop back to the grid.
    if (ctx.editTarget && ctx.editTarget.laneId != null && !arrangement.lane(ctx.editTarget.laneId)) ctx.editGrid();
  }
  function arrUndo() { if (!arrPast.length) return; const e = arrPast.pop(); arrFuture.push({ snap: arrSnap(), full: e.full }); arrApply(e.snap, e.full); ctx.refresh(); }
  function arrRedo() { if (!arrFuture.length) return; const e = arrFuture.pop(); arrPast.push({ snap: arrSnap(), full: e.full }); arrApply(e.snap, e.full); ctx.refresh(); }

  Object.assign(ctx, {
    histories, hist, curSnap, applyCur, pushHistory, undo, redo,
    arrPast, arrFuture, arrSnap, arrCommit, arrRecord, arrApply, arrUndo, arrRedo,
  });
}

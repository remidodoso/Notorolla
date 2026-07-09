// tileops.js — tile-player operations: play-region markers, tile drag (move/
// copy/reorder with live ripple preview), click-select, the transform-bar's
// selection chrome, single-tile audition, grid→lane drop, and delete/deselect.

import { Note, Score } from '../core/model.js';
import { applyTransforms } from '../core/transforms.js';
import { clonePatch } from '../audio/instrument.js';
import { LOOP_STEP } from './transport.js';

export function initTileops(ctx) {
  const { arrangement, library, tilePlayer, engine, scheduler } = ctx;
  const state = ctx.state;
  const tileDeleteBtn = document.getElementById('tileDelete');

  // Commit a play-region change (from the ruler): clamp, store on the arrangement,
  // and close the undo bracket opened on pointerdown. `end` null = "to last tile".
  // Marker edits take effect at the next loop boundary (the provider re-reads), so
  // no mid-cycle resync — just persist + redraw the ruler.
  function setPlayMarkers(start, end) {
    const contentEnd = ctx.arrangementEndBeat();
    const s = Math.max(0, Math.min(Math.round(start), Math.max(0, contentEnd - 1)));
    let e = end; // null = auto (end of last tile)
    if (e != null) {
      e = Math.round(e);
      if (e >= contentEnd) e = null;          // dragged to/past the content end → back to auto
      else e = Math.max(s + 1, e);            // keep a non-empty region
    }
    arrangement.playStart = s;
    arrangement.playEnd = e;
    ctx.onMixEnd(); // shared bracket: commit one undo step if changed, persist, refresh undo btn
    tilePlayer.render();
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
  ctx.tileDrag = null;   // { id, fromLaneId, preview } while a drag is active

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
    ctx.tileDrag = { id, fromLaneId: lane ? lane.id : null, preview: null, gripBeats: tilePlayer.gripFor(id, grabX) };
    // Dragging a member of a MULTI-selection moves/copies the whole selection as
    // a rigid block; dragging an unselected tile is a plain single-tile drag.
    if (arrangement.selectedIds.size > 1 && arrangement.selectedIds.has(id)) {
      const grabbed = arrangement.allTiles().find((t) => t.id === id);
      const block = arrangement.selectionBlock(ctx.patternLen);
      ctx.tileDrag.multi = { grabbedStart: grabbed.start, blockStart: block.start };
    }
    tilePlayer.setPlaying(new Set()); // drop the green "playing" badge while dragging
    tilePlayer.makeGhost(id, ctx.tileDrag.gripBeats * tilePlayer.ppb); // ghost hangs from the grip point
  }

  function updateTileDrag(e) {
    const copy = e.ctrlKey;
    tilePlayer.edgeScroll(e.clientX, e.clientY); // near an edge → jump the view (dropTarget reads fresh rects after)
    const tgt = tilePlayer.dropTarget(e.clientX, e.clientY);
    // The tile lands at the beat NEAREST ITS CARRIED POSITION (pointer minus the
    // grip, rounded) — the original grip-preserving feel. The caret switches to
    // carry mode and marks the landing's left edge (see setCarryCaret).
    let preview = null;
    if (tgt && ctx.tileDrag.multi) {
      // Multi-selection: the grabbed tile's destination sets a rigid shift for
      // the whole block (clamped so no member lands before beat 0); the plan
      // (with per-member collision blocking) is what the drop will commit.
      const dest = Math.round(tgt.beat - ctx.tileDrag.gripBeats);
      const shift = Math.max(dest - ctx.tileDrag.multi.grabbedStart, -ctx.tileDrag.multi.blockStart);
      preview = {
        multi: arrangement.planSelectionDrop(tgt.laneId, shift, ctx.patternLen, copy),
        shift, copy, toLaneId: tgt.laneId, fromLaneId: ctx.tileDrag.fromLaneId,
      };
    } else if (tgt) {
      preview = { id: ctx.tileDrag.id, fromLaneId: ctx.tileDrag.fromLaneId, copy, toLaneId: tgt.laneId, start: Math.max(0, Math.round(tgt.beat - ctx.tileDrag.gripBeats)) };
    }
    if (!samePreview(preview, ctx.tileDrag.preview)) {
      ctx.tileDrag.preview = preview;
      tilePlayer.render(preview, true); // animate the live ripple
    }
    if (preview) tilePlayer.setCarryCaret(preview.toLaneId, preview.multi ? ctx.tileDrag.multi.blockStart + preview.shift : preview.start);
    else tilePlayer.setCarryCaret(null); // off the lanes — a drop would cancel
    tilePlayer.moveGhost(e.clientX, e.clientY, copy);
  }

  function endTileDrag(e) {
    const preview = ctx.tileDrag.preview;
    tilePlayer.clearGhost();
    tilePlayer.setCarryCaret(null); // back to hover mode
    ctx.tileDrag = null;

    if (!preview) { ctx.refresh(); return; } // dropped off the lanes → cancel
    const copy = e.ctrlKey;              // authoritative copy state at the drop

    // Moving/copying into a FRESH lane (brand-new / just-reset) seeds that lane's
    // instrument from the SOURCE lane (a tile carries no patch — its lane does),
    // so the tiles keep sounding the way they did. A used lane keeps its own.
    const destLane = arrangement.lane(preview.toLaneId);
    const seedFromSource = destLane && destLane.fresh && preview.toLaneId !== preview.fromLaneId;
    const srcLane = seedFromSource ? arrangement.lane(preview.fromLaneId) : null;
    const srcPatch = srcLane ? srcLane.patch : null;

    const before = ctx.arrSnap();
    if (preview.multi) {
      // Whole-selection block drop (ignore-collisions; ripple doesn't apply to
      // multi drags). Move keeps the same ids selected; copy selects the copies.
      if (copy) arrangement.copySelection(preview.toLaneId, preview.shift, ctx.patternLen);
      else arrangement.moveSelection(preview.toLaneId, preview.shift, ctx.patternLen);
    } else {
      const newId = copy
        ? arrangement.copyTile(preview.id, preview.toLaneId, preview.start, ctx.patternLen, state.ripple)
        : (arrangement.moveTile(preview.id, preview.toLaneId, preview.start, ctx.patternLen, state.ripple), preview.id);
      arrangement.select(newId);
    }
    ctx.arrCommit(before);
    if (srcPatch) { // adopt the source instrument AND its patch identity
      destLane.patch = clonePatch(srcPatch);
      destLane.patchOriginId = srcLane.patchOriginId; destLane.patchName = srcLane.patchName; destLane.patchDirty = srcLane.patchDirty;
    }
    if (destLane) destLane.fresh = false;                // the lane now has a tile
    arrangement.activeLaneId = preview.toLaneId;
    ctx.refresh();
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
    ctx.setActive('tiles');
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
        ctx.clearProposal();
        ctx.grid.clearSelection();
        library.open(p.name);
        ctx.setGridInstr(lane ? { source: 'lane', laneId: lane.id } : { source: 'grid' }); // borrow the tile's instrument
        ctx.centerGridOn(p);
      }
      ctx.refresh(); // covers roll content/scroll, selection visuals, persist
    } else {
      tilePlayer.syncSelection();
      tilePlayer.setActiveLane(arrangement.activeLaneId);
      ctx.updateRollContent(); ctx.scrollRollToSelected();
      updateTileSelectionUI();
      ctx.persist();
    }
  }

  // The selection as tiles, in timeline order (they all live on one lane).
  function selectedTiles() { return arrangement.selectedTiles(); }

  // Selection-dependent chrome: the Delete button and the transform bar (action
  // buttons enable with a selection; the chip inspector reflects it).
  function updateTileSelectionUI() {
    tileDeleteBtn.disabled = arrangement.selectedIds.size === 0;
    ctx.refreshTransformBar();
    ctx.updateReferenceEnable();
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
    ctx.activeSource = 'audit';
    ctx.auditTileId = id;
    ctx.applyLaneGains(0); // mute/solo bus state before the first note
    // loop = the app's LIMITED loop: LOOP_STEP passes counting down (never endless
    // — there is no infinite loop; a counted loop is the cure for loop burn-in).
    scheduler.start(() => score, now + 0.05, loop ? LOOP_STEP : 1, loop);
    tilePlayer.setPlaying(new Set([id])); // the green "playing" badge on the auditioned tile
    ctx.startRender();
    ctx.updateTransportButtons();
  }
  ctx.auditTileId = null; // which tile the 'audit' source is sounding (inspector transport + badge)

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
    return Math.max(0, Math.round(rawBeat - ctx.patternLen(name) / 2));
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
    ctx.arrRecord();
    // Dropping into a FRESH lane (brand-new / just-reset) seeds it with the grid's
    // instrument (the patch you were just auditioning), so the tile sounds the way
    // it did in the grid. A lane that's been used keeps its established instrument.
    // Clone so the lane's patch doesn't alias (and keep being edited by) the grid's.
    const lane = arrangement.lane(laneId);
    if (lane && lane.fresh) { // adopt the grid patch AND its identity so the tile keeps its name
      lane.patch = clonePatch(ctx.gridPatch);
      lane.patchOriginId = ctx.gridPatchMeta.patchOriginId; lane.patchName = ctx.gridPatchMeta.patchName; lane.patchDirty = ctx.gridPatchMeta.patchDirty;
    }
    arrangement.insertAt(laneId, library.current().name, start, ctx.patternLen, state.ripple);
    if (lane) lane.fresh = false; // the lane now has a tile
    arrangement.activeLaneId = laneId;
    ctx.refresh();
  }

  // Delete every selected tile (one undo entry). Ripple mode closes each gap in
  // turn (left to right — ids stay valid across the shifts); off leaves silence.
  function deleteSelectedTile() {
    const tiles = selectedTiles();
    if (!tiles.length) return;
    ctx.arrRecord();
    for (const t of tiles) {
      if (state.ripple) arrangement.removeRipple(t.id, ctx.patternLen);
      else arrangement.remove(t.id);
    }
    arrangement.clearSelection();
    ctx.refresh();
  }

  function deselectTile() {
    if (!arrangement.selectedIds.size) return;
    arrangement.clearSelection();
    tilePlayer.syncSelection();
    updateTileSelectionUI();
    ctx.updateRollContent();
    ctx.scrollRollToSelected();
    ctx.persist();
  }

  tileDeleteBtn.addEventListener('click', deleteSelectedTile);

  Object.assign(ctx, {
    setPlayMarkers, onTileDown, selectedTiles, updateTileSelectionUI, auditionTile,
    gridDragOver, dropCurrentTile, clearGridDragPreview, deleteSelectedTile, deselectTile,
  });
}

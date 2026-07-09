// tileinspector.js — the Tile Inspector floating pane: a play/stop/loop
// transport for the anchor tile plus a facts data dump, both following the tile
// selection. Drives the same 'audit' source as a tile double-click.

import { createInspector } from '../ui/inspector.js';
import { instrument } from '../audio/instrument.js';
import { DURATIONS } from '../core/grid.js';
import { scaleById } from '../core/scales.js';
import { pitchClassName, TUNING_LIST } from '../core/tuning.js';
import { transformKindLabel, describeTransform } from '../core/transforms.js';
import { LOOP_STEP, LOOP_MAX } from './transport.js';

export function initTileinspector(ctx) {
  const { arrangement, library, scheduler } = ctx;

  let tileInspector = null; // the Tile Inspector floating pane (created in the wiring tail below)

  // --- Tile Inspector transport (play / stop / loop the ANCHOR tile) ----------
  // A first, deliberately un-standardized cluster (we're not ready to standardize
  // a shared transport). It drives the same 'audit' source as a tile double-click.
  function inspectorPlay() {
    if (arrangement.selectedId == null) return;
    ctx.auditionTile(arrangement.selectedId, { loop: false });
  }
  function inspectorStop() {
    if (ctx.activeSource !== 'audit') return; // only controls its own playback
    ctx.stop();
  }
  // Loop tap: stack passes (the LIMITED, counted loop). If this same tile is
  // already auditing, add LOOP_STEP passes (capped) without restarting; else start
  // a fresh counted loop.
  function inspectorLoop() {
    const id = arrangement.selectedId;
    if (id == null) return;
    if (ctx.activeSource === 'audit' && scheduler.isPlaying && ctx.auditTileId === id) {
      scheduler.loop = true;
      scheduler.remaining = Math.min(scheduler.remaining + LOOP_STEP, LOOP_MAX);
      ctx.updateTransportButtons();
      return;
    }
    ctx.auditionTile(id, { loop: true });
  }

  // Reflect transport state onto the inspector's play/stop/loop cluster.
  function syncInspectorTransport() {
    if (!tileInspector) return; // not built yet during init, or no inspector
    const auditing = ctx.activeSource === 'audit' && scheduler.isPlaying;
    tileInspector.setTransport({
      canPlay: arrangement.selectedId != null,
      playing: auditing,
      looping: auditing && scheduler.isLooping,
    });
  }

  const tileInspectorBtn = document.getElementById('tileInspector');
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
      onCommit: (newLabel) => { p.label = newLabel; ctx.refresh(); },
    } : null;
    return { heading, sub, sections, rename };
  }

  // Push fresh facts into the inspector — cheap no-op while it's closed.
  function refreshTileInspector() {
    if (!tileInspector || !tileInspector.isOpen()) return;
    tileInspector.setFacts(tileInspectorFacts());
    syncInspectorTransport(); // canPlay follows the anchor selection
  }

  Object.assign(ctx, { syncInspectorTransport, refreshTileInspector });
}

// zoom.js — the two view-only zoom controls: the tile-player horizontal scale
// strip (+ debounced persistence of the tile lane's scroll) and the piano-roll
// zoom notches. All view-only: persisted to the UI state, never the project.
// initZoom runs after ctx.tilePlayer / ctx.roll / ctx.scheduler are constructed.

import { TILE_SCALES } from '../ui/tileplayer.js';
import { ROLL_V_SCALES, ROLL_H_SCALES } from '../ui/pianoroll.js';

export function initZoom(ctx) {
  const { tilePlayer, roll, scheduler } = ctx;
  const state = ctx.state;

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
    tileScrollTimer = setTimeout(ctx.persist, 400);
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
    ctx.persist();
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
    ctx.persist();
  }
  rollVEl.addEventListener('input', () => setRollZoom(Number(rollVEl.value), state.rollHIdx));
  rollHEl.addEventListener('input', () => setRollZoom(state.rollVIdx, Number(rollHEl.value)));
  document.getElementById('rollVOut').addEventListener('click', () => setRollZoom(state.rollVIdx - 1, state.rollHIdx));
  document.getElementById('rollVIn').addEventListener('click', () => setRollZoom(state.rollVIdx + 1, state.rollHIdx));
  document.getElementById('rollHOut').addEventListener('click', () => setRollZoom(state.rollVIdx, state.rollHIdx - 1));
  document.getElementById('rollHIn').addEventListener('click', () => setRollZoom(state.rollVIdx, state.rollHIdx + 1));
  rollVEl.value = String(state.rollVIdx); // reflect the restored zoom in the strip
  rollHEl.value = String(state.rollHIdx);

  Object.assign(ctx, { clampScaleIdx, setTileScale, updateScaleStrip, setRollZoom });
}

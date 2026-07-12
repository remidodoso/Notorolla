// visualizer.js — wires the HEX keyboard visualizer (future_directions §22): the
// transport-area summon button, the note-event feed off the scheduler, and the
// board's pitch context (current tuning + centre degree). The window itself and its
// rendering are ui/vizhex.js; the geometry is core/hexlayout.js.
//
// Score-reactive by the scheduler tap: every scheduled note emits onNoteVisual with
// its audio-clock time, so lighting is in lockstep with the sound (not an FFT guess).
// Live playback only — auditions and the offline export paths don't feed it.

import { createVizHex } from '../ui/vizhex.js';
import { FREF } from '../audio/audio.js';
import { nearestDegreeToFreq } from '../core/tuning.js';

export function initVisualizer(ctx) {
  const { scheduler, library, engine } = ctx;

  const curTuning = () => library.current().tuningId;
  const viz = createVizHex({
    getTuning: curTuning,
    // Centre the board on the degree nearest middle C in the current tuning, so the
    // played notes land near the middle rather than at an edge.
    getBaseDegree: () => nearestDegreeToFreq(FREF, curTuning(), library.current().root || 0),
    clock: () => engine.currentTime,
  });

  const btn = document.getElementById('vizToggle');
  viz.onToggle = (open) => btn.classList.toggle('active', open);
  btn.addEventListener('click', () => viz.toggle());
  btn.classList.toggle('active', viz.isOpen()); // reflect a workspace auto-reopen

  // The scheduler's score-reactive tap (see audio/scheduler.js). One consumer for
  // now; the window ignores events while it's closed.
  scheduler.onNoteVisual = (ev) => viz.noteOn(ev);

  Object.assign(ctx, { visualizer: viz });
}

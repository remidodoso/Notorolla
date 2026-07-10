// keyboard.js — global keydown shortcuts, acting on the active pane (grid or
// tiles) and flashing the button each maps to. Extracted last: it touches nearly
// every ctx API. Skipped while a form field is focused so typing isn't hijacked.

import { equaveOf } from '../core/tuning.js';

export function initKeyboard(ctx) {
  const { grid, scheduler, arrangement, library, tb } = ctx;
  const loopBtn = document.getElementById('loop');
  const playBtn = document.getElementById('play');
  const stopBtn = document.getElementById('stop');
  const tilePlayBtn = document.getElementById('tilePlay');
  const tileStopBtn = document.getElementById('tileStop');
  const tileLoopBtn = document.getElementById('tileLoop');
  const phHomeBtn = document.getElementById('phHome');
  const phEndBtn = document.getElementById('phEnd');
  const arrUndoBtn = document.getElementById('arrUndo');
  const arrRedoBtn = document.getElementById('arrRedo');
  const tileDeleteBtn = document.getElementById('tileDelete');

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
}

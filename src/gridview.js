// gridview.js — draw the grid pattern on a canvas and handle editing.
//
// The canvas is a *viewport* onto pitch space: it shows `visibleRows` degrees
// starting at `topDegree` (top row) and going down. Notes are stored by
// absolute degree, so notes above/below the window are kept (just hidden, with
// an edge hint). Wheel scrolls the window; a bottom handle resizes it.
//
// Gestures (mono mode):
//   click (no move) ....... place note (on a rest) / rotate duration (same row)
//                           / repitch (different row in a note's column)
//   click-drag (vertical) . repitch the column's note
//   shift-click ........... toggle accent (notes only)
//   right-click ........... toggle note <-> rest

import { DURATIONS, PALETTE, COLS, BASE_PITCH } from './grid.js';
import { isBlackKey } from './model.js';
import { degreeToName } from './tuning.js';
import { PAD_LEFT as ROLL_PAD_LEFT, BEAT_WIDTH as ROLL_BEAT_WIDTH } from './pianoroll.js';

const PAD_LEFT = ROLL_PAD_LEFT;  // share the roll's gutter so Stretch lines up
const PAD_TOP = 10;
const PAD_RIGHT = 16;
const PAD_BOTTOM = 10;
const ROW_H = 24;
const UNIFORM_COL_W = 40;        // Grid mode: every column the same width
const DOT_R = 7;
const DRAG_THRESHOLD = 4;        // px of movement that turns a click into a drag

export const MIN_ROWS = 12;      // never fewer than twelve tones (for now)
export const MAX_ROWS = 48;
const MIN_DEGREE = 24;           // C1 .. navigable pitch range .. C8
const MAX_DEGREE = 108;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export class GridView {
  // opts: getMode, getBrush, getCursorStyle, getHighlightRows, getViewport,
  //       onViewport(top, rows), onAudition(pitch), onChange(),
  //       handle, guide, scrollWrap (DOM nodes for resize)
  constructor(canvas, pattern, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pattern = pattern;
    this.opts = opts;
    this.drag = null;
    this.resize = null;
    this._bind();
    this.updateCursor();
  }

  get mode() { return this.opts.getMode(); }
  get _vp() { return this.opts.getViewport(); } // { top, rows }

  // --- pitch <-> screen ------------------------------------------------

  get _topDegree() { return this._vp.top; }
  get _rows() { return this._vp.rows; }
  get _bottomDegree() { return this._vp.top - this._vp.rows + 1; }

  _yForDegree(d) {
    return PAD_TOP + (this._topDegree - d) * ROW_H;
  }
  _degreeAt(py) {
    const k = clamp(Math.floor((py - PAD_TOP) / ROW_H), 0, this._rows - 1);
    return this._topDegree - k;
  }

  // --- column geometry (time axis) -------------------------------------

  _colGeom(i) {
    if (this.mode === 'stretch') {
      let x = PAD_LEFT;
      for (let k = 0; k < i; k++) x += DURATIONS[this.pattern.columns[k].durIndex].beats * ROLL_BEAT_WIDTH;
      return { x, w: DURATIONS[this.pattern.columns[i].durIndex].beats * ROLL_BEAT_WIDTH };
    }
    return { x: PAD_LEFT + i * UNIFORM_COL_W, w: UNIFORM_COL_W };
  }
  _columnAt(px) {
    if (this.mode === 'stretch') {
      let x = PAD_LEFT;
      for (let i = 0; i < COLS; i++) {
        const w = DURATIONS[this.pattern.columns[i].durIndex].beats * ROLL_BEAT_WIDTH;
        if (px < x + w) return i;
        x += w;
      }
      return COLS - 1;
    }
    return clamp(Math.floor((px - PAD_LEFT) / UNIFORM_COL_W), 0, COLS - 1);
  }

  // --- drawing ----------------------------------------------------------

  _resizeCanvas() {
    const totalBeats = this.pattern.columns.reduce(
      (s, c) => s + DURATIONS[c.durIndex].beats, 0);
    this.canvas.width = this.mode === 'stretch'
      ? PAD_LEFT + totalBeats * ROLL_BEAT_WIDTH + PAD_RIGHT
      : PAD_LEFT + COLS * UNIFORM_COL_W + PAD_RIGHT;
    this.canvas.height = PAD_TOP + this._rows * ROW_H + PAD_BOTTOM;
  }

  draw() {
    this._resizeCanvas();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const top = this._topDegree;
    const bottom = this._bottomDegree;
    ctx.clearRect(0, 0, W, H);

    // Which pitches carry a note (exact degree = strong highlight; the same
    // pitch-class in other octaves = soft highlight).
    const active = new Set();
    const activePC = new Set();
    if (this.opts.getHighlightRows()) {
      for (const c of this.pattern.columns) {
        if (c.isRest) continue;
        active.add(c.degree);
        activePC.add(((c.degree % 12) + 12) % 12);
      }
    }

    // Pitch lanes (black keys shaded, active lanes tinted) + labels w/ octave.
    for (let k = 0; k < this._rows; k++) {
      const d = top - k;
      const y = PAD_TOP + k * ROW_H;
      const pc = ((d % 12) + 12) % 12;
      const isActive = active.has(d);
      const isOctave = !isActive && activePC.has(pc);
      ctx.fillStyle = isBlackKey(d) ? '#13151c' : '#171a22';
      ctx.fillRect(0, y, W, ROW_H);
      if (isActive) {
        ctx.fillStyle = 'rgba(222, 184, 135, 0.12)';   // strong: this very note
        ctx.fillRect(0, y, W, ROW_H);
      } else if (isOctave) {
        ctx.fillStyle = 'rgba(222, 184, 135, 0.045)';  // soft: octave-mate
        ctx.fillRect(0, y, W, ROW_H);
      }
      ctx.fillStyle = isActive ? '#d9c3a0' : isOctave ? '#9a9486' : '#7a8290';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(degreeToName(d), 6, y + ROW_H / 2);
    }

    // Column separators (including the right edge).
    ctx.strokeStyle = '#262a35';
    ctx.lineWidth = 1;
    for (let i = 0; i < COLS; i++) this._vline(this._colGeom(i).x, H);
    const last = this._colGeom(COLS - 1);
    this._vline(last.x + last.w, H);

    // Dots: filled = note, open circle = rest; off-window notes get an edge hint.
    this.pattern.columns.forEach((c, i) => {
      const { x, w } = this._colGeom(i);
      const cx = x + w / 2;
      const color = PALETTE[c.durIndex];

      if (c.isRest) {
        // Cosmetic — clamp into the window so every empty column shows a marker.
        const d = clamp(c.degree, bottom, top);
        const cy = this._yForDegree(d) + ROW_H / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, DOT_R, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
      } else if (c.degree > top) {
        this._edgeHint(cx, PAD_TOP, -1, color);          // hidden above
      } else if (c.degree < bottom) {
        this._edgeHint(cx, H - PAD_BOTTOM, 1, color);     // hidden below
      } else {
        const cy = this._yForDegree(c.degree) + ROW_H / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (c.accent) {
          ctx.beginPath();
          ctx.arc(cx, cy, DOT_R + 3, 0, Math.PI * 2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#7a4a2a';
          ctx.stroke();
        }
      }
    });
  }

  _vline(x, H) {
    this.ctx.beginPath();
    this.ctx.moveTo(x + 0.5, PAD_TOP);
    this.ctx.lineTo(x + 0.5, H - PAD_BOTTOM);
    this.ctx.stroke();
  }

  // A small triangle at the top/bottom edge meaning "a note is hidden this way".
  _edgeHint(cx, edgeY, dir, color) {
    const ctx = this.ctx;
    const tip = edgeY + dir * 7;
    ctx.beginPath();
    ctx.moveTo(cx, tip);
    ctx.lineTo(cx - 5, edgeY);
    ctx.lineTo(cx + 5, edgeY);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // --- cursor experiment ------------------------------------------------

  updateCursor() {
    const { durIndex } = this.opts.getBrush();
    this.canvas.style.cursor = makeCursor(this.opts.getCursorStyle(), durIndex);
  }

  // --- editing interaction ---------------------------------------------

  _bind() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => this._down(e));
    cv.addEventListener('pointermove', (e) => this._move(e));
    cv.addEventListener('pointerup', (e) => this._up(e));
    cv.addEventListener('contextmenu', (e) => this._context(e));
    cv.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    if (this.opts.handle) this._bindResize();
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _snap() { return JSON.stringify(this.pattern.toJSON()); }

  // Push one undo entry (the pre-edit snapshot) iff the edit actually changed
  // something, then redraw. A whole drag collapses into a single entry.
  _commit(before) {
    if (before !== this._snap()) this.opts.onHistory(before);
    this.opts.onChange();
  }

  _down(e) {
    if (e.button === 2) return; // right-click handled by contextmenu
    const { x, y } = this._pos(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { col: this._columnAt(x), startX: x, startY: y, moved: false, shift: e.shiftKey, lastD: null, before: this._snap() };
  }

  _move(e) {
    if (!this.drag) return;
    const { x, y } = this._pos(e);
    if (!this.drag.moved && Math.hypot(x - this.drag.startX, y - this.drag.startY) > DRAG_THRESHOLD) {
      this.drag.moved = true;
    }
    if (!this.drag.moved) return;
    const col = this.pattern.columns[this.drag.col];
    const d = this._degreeAt(y);
    if (col.degree !== d) {
      col.degree = d;
      if (!col.isRest && this.drag.lastD !== d) {
        this.drag.lastD = d;
        this.opts.onAudition(d);
      }
      this.opts.onChange();
    }
  }

  _up(e) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d.moved) { this._commit(d.before); return; }

    const col = this.pattern.columns[d.col];
    const degree = this._degreeAt(this._pos(e).y);
    const brush = this.opts.getBrush();

    if (d.shift) {
      if (!col.isRest) {
        col.accent = !col.accent;
        this.opts.onAudition(col.degree);
      }
    } else if (col.isRest) {
      col.isRest = false;
      col.degree = degree;
      col.durIndex = brush.durIndex;
      col.accent = brush.accent;
      this.opts.onAudition(degree);
    } else if (degree === col.degree) {
      col.durIndex = (col.durIndex + 1) % DURATIONS.length; // rotate length
      this.opts.onAudition(col.degree);
    } else {
      col.degree = degree;                                  // move the note
      this.opts.onAudition(degree);
    }
    this._commit(d.before);
  }

  _context(e) {
    e.preventDefault();
    const before = this._snap();
    const { x, y } = this._pos(e);
    const col = this.pattern.columns[this._columnAt(x)];
    if (col.isRest) {
      col.isRest = false;
      col.degree = this._degreeAt(y);
      col.accent = false;
      this.opts.onAudition(col.degree);
    } else {
      col.isRest = true; // degree kept as the cosmetic rest position
      col.accent = false;
    }
    this._commit(before);
  }

  _wheel(e) {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1; // wheel up -> higher pitches
    const vp = this._vp;
    const top = clamp(vp.top + dir, MIN_DEGREE + vp.rows - 1, MAX_DEGREE);
    if (top !== vp.top) this.opts.onViewport(top, vp.rows);
  }

  // --- resize (drag the bottom handle; commit on release) --------------

  _bindResize() {
    const h = this.opts.handle;
    h.addEventListener('pointerdown', (e) => {
      h.setPointerCapture(e.pointerId);
      this.resize = { startY: e.clientY, startRows: this._rows, target: this._rows };
    });
    h.addEventListener('pointermove', (e) => {
      if (!this.resize) return;
      const delta = Math.round((e.clientY - this.resize.startY) / ROW_H);
      // Grow downward with the top pinned, but never past the navigable floor.
      const maxByFloor = this._topDegree - MIN_DEGREE + 1;
      this.resize.target = clamp(this.resize.startRows + delta, MIN_ROWS, Math.min(MAX_ROWS, maxByFloor));
      this._showGuide(this.resize.target);
    });
    const finish = (e) => {
      if (!this.resize) return;
      const rows = this.resize.target;
      this.resize = null;
      this._hideGuide();
      try { h.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.opts.onViewport(this._topDegree, rows);
    };
    h.addEventListener('pointerup', finish);
    h.addEventListener('pointercancel', finish);
  }

  // Interim indication: a dashed line at the would-be bottom edge + row count,
  // without reflowing the panes. Positioned fixed (viewport coords) so it draws
  // clearly over the panes below instead of being clipped by their bounds.
  _showGuide(rows) {
    const g = this.opts.guide;
    if (!g) return;
    const rect = this.canvas.getBoundingClientRect();
    const newHeight = PAD_TOP + rows * ROW_H + PAD_BOTTOM;
    g.style.left = `${rect.left}px`;
    g.style.width = `${rect.width}px`;
    g.style.top = `${rect.top + newHeight}px`;
    g.innerHTML = `<span>${rows} rows</span>`;
    g.style.display = 'block';
  }
  _hideGuide() {
    if (this.opts.guide) this.opts.guide.style.display = 'none';
  }
}

// Render a cursor image to a data URL. Glyph style uses musical characters
// (reliable for 1/8 and 1/4, composed/spotty for 3/8 and 1/2); dot style draws
// our own duration-colored marker (the chosen default).
function makeCursor(style, durIndex) {
  const size = 28;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const x = c.getContext('2d');
  const mid = size / 2;

  if (style === 'glyph') {
    const glyphs = ['♪', '♩', '♩.', '𝅗𝅥'];
    x.fillStyle = '#241c14';
    x.font = '20px serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(glyphs[durIndex], mid, mid);
  } else {
    x.beginPath();
    x.arc(mid, mid, 7, 0, Math.PI * 2);
    x.fillStyle = PALETTE[durIndex];
    x.fill();
    x.lineWidth = 2;
    x.strokeStyle = '#241c14';
    x.stroke();
    if (durIndex === 2) {            // dotted quarter: a small dot beside it
      x.beginPath();
      x.arc(mid + 11, mid, 2.2, 0, Math.PI * 2);
      x.fillStyle = '#241c14';
      x.fill();
    } else if (durIndex === 3) {     // half: an outer ring to read "longer"
      x.beginPath();
      x.arc(mid, mid, 10, 0, Math.PI * 2);
      x.lineWidth = 1.5;
      x.strokeStyle = PALETTE[durIndex];
      x.stroke();
    }
  }
  return `url(${c.toDataURL()}) ${mid} ${mid}, crosshair`;
}

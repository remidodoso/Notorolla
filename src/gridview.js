// gridview.js — draw the grid pattern on a canvas and handle editing.
//
// The canvas is a *viewport* onto pitch space: it shows `visibleRows` degrees
// starting at `topDegree` (top row) and going down. Notes are stored by
// absolute degree, so notes above/below the window are kept (just hidden, with
// an edge hint). Wheel scrolls the window; a bottom handle resizes it.
//
// Rhythm ⊥ pitch: a column's facets live in the per-column FOOTER "performance lanes"
// below the canvas — notes (a neutral handle), duration (color = value), accent,
// articulation — the "attribute rack". The grid body only ever sets pitch.
//
// Gestures (mono mode):
//   body click (no move) .. place note (on a rest) / repitch (different row) /
//                           re-audition (clicking a note's own cell — no duration
//                           change; duration is set in the footer)
//   body click-drag ....... axis-locked on first movement: VERTICAL repitches the
//                           column's note; HORIZONTAL swaps the NOTE payload with
//                           the column dragged onto (durations stay put). Never diagonal.
//   chit click ............ EDIT that lane: duration→brush, accent/artic cycle;
//                           notes chit → select (arm the notes)
//   chit double-click ..... ARM / disarm that lane for a swap (notes chit → arm all
//                           four); armed lanes show a blue frame
//   chit drag ............. swap the ARMED lanes between this column and the drop
//                           column (just the grabbed lane if nothing is armed)
//   ESC ................... cancel any in-progress gesture / disarm (commits nothing)
//   shift-click ........... toggle accent (notes only)
//   right-click ........... toggle note <-> rest

import { Pattern, PALETTE, DEFAULT_DUR, MIN_COLS, MAX_COLS, BASE_PITCH, durationLabel, swapNotePayload, swapLanes, stretchWidth, nextAccent, nextArtic, ARTICULATIONS, DEFAULT_ARTIC } from './grid.js';
import { isBlackKey } from './model.js';
import { degreeToName, pitchClassName, edoOf, degreeBounds } from './tuning.js';
import { inScale, nearestInScale, stepInScale } from './scales.js';
import { classifyTriad } from './triads.js';
import { PAD_LEFT as ROLL_PAD_LEFT } from './pianoroll.js';

const PAD_LEFT = ROLL_PAD_LEFT;  // share the roll's gutter so Stretch lines up
const PAD_TOP = 10;
const PAD_RIGHT = 16;
const PAD_BOTTOM = 10;
const ROW_H = 29;                // pitch-row height (grid scaled ~120% from 24)
// Performance (X-axis) lanes stacked below the grid, top→bottom. One chit per
// column per lane — the column "attribute rack". `notes` sits on top (nearest the
// grid): a neutral gray handle for the column's pitch content. FOOTER_H is the
// whole band's height. Chit heights are ~1.5× (deliberately taller than the grid
// scale-up, so the groove lanes read as chunky, hittable controls).
const PERF_LANES = [
  { id: 'notes',        h: 27, label: 'note' },
  { id: 'duration',     h: 30, label: 'dur' },
  { id: 'accent',       h: 24, label: 'acc' },
  { id: 'articulation', h: 24, label: 'art' },
];
const ALL_LANES = PERF_LANES.map((l) => l.id);
const FOOTER_H = PERF_LANES.reduce((s, l) => s + l.h, 0);
const DBL_MS = 260;              // window for a double-click (arm) vs a single-click (edit)
const UNIFORM_COL_W = 48;        // Grid mode: every column the same width (~120%)
const STRETCH_MIN_W = 31;        // Stretch mode: log-compressed width band (by-eye tunable, ~120%)
const STRETCH_MAX_W = 72;
const DOT_R = 8;
const DRAG_THRESHOLD = 4;        // px of movement that turns a click into a drag
const TRIAD_BAND = 30;           // px reserved above the lanes for two label rows
const QUALITY = { maj: 'Maj', min: 'min', dim: 'dim', aug: 'aug', sus: 'sus', sept: '4:5:7', sup: 'sup' };

export const MIN_ROWS = 12;      // never fewer than twelve tones (for now)
export const MAX_ROWS = 48;
// The navigable pitch range is the A0..C8 piano band, resolved PER-PATTERN to the
// degrees nearest those frequencies in the pattern's tuning (degreeBounds). So
// 12-ET is A0..C8 and 16-ET is its own A0 ("80") up — see this._loDeg/_hiDeg.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export class GridView {
  // opts: getMode, getBrush, getCursorStyle, getHighlightRows, getShowTriads,
  //       getViewport, onViewport(top, rows), onAudition(pitch), onChange(),
  //       handle, guide, scrollWrap (DOM nodes for resize)
  constructor(canvas, pattern, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pattern = pattern;
    this.opts = opts;
    this.drag = null;
    this.footerDrag = null;       // in-progress performance-lane (chit) gesture
    this.armed = null;            // { col, lanes:Set } — lanes armed (double-clicked) within ONE column; a drag swaps them
    this._pendingClick = null;    // { col, lane, before, t, timer } — a chit single-click held DBL_MS to see if it's a double
    this._cursorZone = null;      // 'body' | 'footer' — so the hover cursor only re-sets on a zone change
    this.resize = null;
    this.referenceDegree = null;  // degree to mark as the keyboard-tracking pivot (Boshwick), or null
    this.prospective = new Map(); // col -> { degree, durIndex } : un-set proposal notes
    this.selection = new Set();   // selected note-column indices (transient; Ctrl-click)
    this.selDrag = null;          // in-progress Ctrl gesture (toggle vs marquee)
    this.marquee = null;          // { x0, y0, x1, y1 } while dragging a marquee
    this._marqueeRAF = null;
    this._antsOffset = 0;
    this._bind();
    this.updateCursor();
  }

  // The pattern is swapped in by the host (main.refresh) via `grid.pattern = …`.
  // Intercept it so a held single-click edit settles against the OLD pattern before
  // the switch, and the transient arm doesn't bleed across patterns.
  get pattern() { return this._pattern; }
  set pattern(p) {
    if (this._pattern && this._pattern !== p) { this._flushPendingClick(); this._clearArm(); }
    this._pattern = p;
  }

  // Set the prospective (Triadulator) notes overlaid on empty columns. They're
  // drawn ghosted and are NOT part of the committed pattern until confirmed.
  setProspective(list) {
    this.prospective = new Map();
    for (const p of list) this.prospective.set(p.col, { degree: p.degree, durIndex: p.durIndex });
  }

  // Selection (used by future selection tools via `grid.selection`). Transient:
  // not persisted, not undoable. Cleared by main on pattern/pane changes & Esc.
  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.draw();
    if (this.opts.onSelectionChange) this.opts.onSelectionChange();
  }
  // Select every note (non-rest) column.
  selectAll() {
    this.selection = new Set();
    this.pattern.columns.forEach((c, i) => { if (!c.isRest) this.selection.add(i); });
    this.draw();
    if (this.opts.onSelectionChange) this.opts.onSelectionChange();
  }
  // Turn the selected notes into rests (Delete/Backspace). One undo entry; the
  // degree is kept as the rest's cosmetic position, like right-click note→rest.
  deleteSelection() {
    if (!this.selection.size) return;
    const before = this._snap();
    for (const i of this.selection) {
      const c = this.pattern.columns[i];
      c.isRest = true;
      c.accent = 0;
    }
    this.selection.clear();
    this._commit(before);
  }
  // Toggle one note column in/out of the selection (rests aren't selectable).
  _toggleCol(i) {
    if (this.pattern.columns[i].isRest) return;
    if (this.selection.has(i)) this.selection.delete(i);
    else this.selection.add(i);
    this.draw();
    if (this.opts.onSelectionChange) this.opts.onSelectionChange();
  }

  // Is (x,y) on a note's own cell (its column AND its pitch row)? Returns the
  // column index, or -1 (empty/rest cell → a marquee should start there).
  _noteAt(x, y) {
    const i = this._columnAt(x);
    const c = this.pattern.columns[i];
    return (!c.isRest && this._degreeAt(y) === c.degree) ? i : -1;
  }

  // The columns a permute tool acts on: the selection if there is one, else every
  // note (non-rest) column — so the permute buttons work on the whole pattern when
  // nothing is selected.
  _permuteTargets() {
    if (this.selection.size) return [...this.selection].sort((a, b) => a - b);
    const cols = [];
    this.pattern.columns.forEach((c, i) => { if (!c.isRest) cols.push(i); });
    return cols;
  }
  permuteCount() { return this._permuteTargets().length; }

  // Cyclically rotate the target notes one position to the right among their own
  // columns: the leftmost moves to the next column, …, the rightmost wraps into
  // the leftmost's column. Columns (and any highlight) stay put; only the notes
  // cycle. A no-op below two notes.
  rotateSelection() {
    const cols = this._permuteTargets();
    if (cols.length < 2) return;
    const before = this._snap();
    const contents = cols.map((i) => this.pattern.columns[i]);
    const n = cols.length;
    for (let k = 0; k < n; k++) this.pattern.columns[cols[k]] = contents[(k - 1 + n) % n];
    this._commit(before);
  }

  // The navigable degree range for THIS pattern's tuning — the A0..C8 piano band
  // mapped to the nearest degrees in its EDO (memoized in degreeBounds). Per-
  // pattern, so 16-ET reaches its own A0 ("80") and 12-ET is A0..C8.
  get _loDeg() { return degreeBounds(this.pattern.tuningId, this.pattern.root || 0).min; }
  get _hiDeg() { return degreeBounds(this.pattern.tuningId, this.pattern.root || 0).max; }

  // Transpose the target notes by `delta` degrees (Mutate / arrow keys). No-op if
  // it would push any note out of the navigable range. One undo entry.
  transpose(delta) {
    if (!delta) return;
    const cols = this._permuteTargets();
    if (!cols.length) return;
    const degs = cols.map((i) => this.pattern.columns[i].degree);
    if (Math.max(...degs) + delta > this._hiDeg || Math.min(...degs) + delta < this._loDeg) return;
    const before = this._snap();
    for (const i of cols) this.pattern.columns[i].degree += delta;
    this._commit(before);
  }

  // Scalar (diatonic) transpose: move each note to the next degree up/down *in
  // the active scale mask* (dir ±1). Under the Chromatic mask this is the old
  // ±1 semitone; under pentatonic it steps to the next scale tone (and pulls an
  // off-scale note onto the mask). Each note steps independently, so intervals
  // follow the scale rather than staying rigidly parallel. Octave jumps stay
  // literal via transpose(±edo). One undo entry; reject if any
  // note would leave the navigable range.
  transposeScalar(dir) {
    const cols = this._permuteTargets();
    if (!cols.length) return;
    const { scaleId, root } = this.pattern;
    const edo = edoOf(this.pattern.tuningId);
    const targets = cols.map((i) => stepInScale(scaleId, root, this.pattern.columns[i].degree, dir, edo));
    if (targets.some((d) => d > this._hiDeg || d < this._loDeg)) return;
    const before = this._snap();
    cols.forEach((i, k) => { this.pattern.columns[i].degree = targets[k]; });
    this._commit(before);
  }

  // Set the duration of the *selected* notes (clicking a duration brush with a
  // selection). Returns whether it did anything. One undo entry.
  applyDuration(durIndex) {
    if (!this.selection.size) return false;
    const before = this._snap();
    for (const i of this.selection) this.pattern.columns[i].durIndex = durIndex;
    this._commit(before);
    return true;
  }

  // Reverse the order of the target notes among their columns (retrograde).
  reverseSelection() {
    const cols = this._permuteTargets();
    if (cols.length < 2) return;
    const before = this._snap();
    const contents = cols.map((i) => this.pattern.columns[i]);
    contents.reverse();
    cols.forEach((c, k) => { this.pattern.columns[c] = contents[k]; });
    this._commit(before);
  }

  // Reorder the selected notes by pitch among their own columns (whole notes
  // travel, so duration/accent follow the pitch). Stable on ties. No-op below two.
  sortSelection(ascending) {
    const cols = this._permuteTargets();
    if (cols.length < 2) return;
    const before = this._snap();
    const contents = cols.map((i) => this.pattern.columns[i]);
    contents.sort((a, b) => (ascending ? a.degree - b.degree : b.degree - a.degree));
    cols.forEach((c, k) => { this.pattern.columns[c] = contents[k]; });
    this._commit(before);
  }

  // Randomly permute the selected notes among their columns. Re-rolls so the
  // result differs from the current arrangement when possible (a swap for two).
  shuffleSelection() {
    const cols = this._permuteTargets();
    if (cols.length < 2) return;
    const before = this._snap();
    const original = cols.map((i) => this.pattern.columns[i]);
    let shuffled;
    let attempts = 0;
    do {
      shuffled = original.slice();
      for (let i = shuffled.length - 1; i > 0; i--) { // Fisher–Yates
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
    } while (++attempts < 20 && shuffled.every((c, k) => c === original[k]));
    cols.forEach((c, k) => { this.pattern.columns[c] = shuffled[k]; });
    this._commit(before);
  }

  // Randomize the selected notes so no two *adjacent* (time-order) ones share a
  // pitch when that's possible, and with the fewest unavoidable repeats when a
  // pitch dominates (> half the selection). Constructive — no rejection looping:
  // each step deals from the largest remaining pitch-pool that isn't the one just
  // placed (random among ties); only a forced repeat happens when nothing else is
  // left. A random end-for-end flip removes the "dominant always leads" bias.
  shuffleNoRepeatSelection() {
    const cols = this._permuteTargets();
    if (cols.length < 2) return;
    const before = this._snap();

    const byPitch = new Map(); // degree -> note objects (shuffled within)
    for (const i of cols) {
      const c = this.pattern.columns[i];
      if (!byPitch.has(c.degree)) byPitch.set(c.degree, []);
      byPitch.get(c.degree).push(c);
    }
    const shuffle = (a) => {
      for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; }
      return a;
    };
    const pools = [...byPitch.entries()].map(([degree, items]) => ({ degree, items: shuffle(items) }));

    const out = [];
    let lastDeg = null;
    while (out.length < cols.length) {
      const avail = pools.filter((p) => p.items.length > 0 && p.degree !== lastDeg);
      let pick;
      if (avail.length === 0) {
        pick = pools.find((p) => p.items.length > 0); // forced repeat (infeasible input)
      } else {
        const max = Math.max(...avail.map((p) => p.items.length));
        const top = avail.filter((p) => p.items.length === max); // the most-common remaining
        pick = top[Math.floor(Math.random() * top.length)];
      }
      out.push(pick.items.pop());
      lastDeg = pick.degree;
    }
    if (Math.random() < 0.5) out.reverse(); // a flip keeps the no-adjacency, de-biases the ends

    cols.forEach((c, idx) => { this.pattern.columns[c] = out[idx]; });
    this._commit(before);
  }

  // Begin a marching-ants marquee from the current Ctrl-gesture start point. A
  // small rAF loop animates the dash offset and redraws while it's active.
  _startMarquee() {
    this.marquee = { x0: this.selDrag.startX, y0: this.selDrag.startY, x1: this.selDrag.startX, y1: this.selDrag.startY };
    const tick = () => {
      if (!this.marquee) { this._marqueeRAF = null; return; }
      this._antsOffset = (this._antsOffset + 0.6) % 8;
      this.draw();
      this._marqueeRAF = requestAnimationFrame(tick);
    };
    this._marqueeRAF = requestAnimationFrame(tick);
  }

  // Release: toggle every visible note whose dot falls inside the rectangle.
  _finishMarquee() {
    if (this._marqueeRAF) { cancelAnimationFrame(this._marqueeRAF); this._marqueeRAF = null; }
    const m = this.marquee;
    this.marquee = null;
    const minX = Math.min(m.x0, m.x1), maxX = Math.max(m.x0, m.x1);
    const minY = Math.min(m.y0, m.y1), maxY = Math.max(m.y0, m.y1);
    const top = this._topDegree, bottom = this._bottomDegree;
    this.pattern.columns.forEach((c, i) => {
      if (c.isRest || c.degree > top || c.degree < bottom) return; // notes only, on-screen
      const { x, w } = this._colGeom(i);
      const cx = x + w / 2;
      const cy = this._yForDegree(c.degree) + ROW_H / 2;
      if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) {
        if (this.selection.has(i)) this.selection.delete(i);
        else this.selection.add(i);
      }
    });
    this.draw();
    if (this.opts.onSelectionChange) this.opts.onSelectionChange();
  }
  // Keep the selection to real notes only (drop rests / out-of-range columns).
  _pruneSelection() {
    for (const i of [...this.selection]) {
      if (i >= this.pattern.columns.length || this.pattern.columns[i].isRest) this.selection.delete(i);
    }
  }
  // A horizontal swap moves notes between columns; the selection follows each
  // note, i.e. the two columns exchange selected-ness.
  _swapSelection(a, b) {
    const sa = this.selection.has(a);
    const sb = this.selection.has(b);
    if (sa === sb) return;
    if (sa) { this.selection.delete(a); this.selection.add(b); }
    else { this.selection.delete(b); this.selection.add(a); }
  }

  get mode() { return this.opts.getMode(); }
  get _vp() { return this.opts.getViewport(); } // { top, rows }

  // --- pitch <-> screen ------------------------------------------------

  get _topDegree() { return this._vp.top; }
  get _rows() { return this._vp.rows; }
  get _bottomDegree() { return this._vp.top - this._vp.rows + 1; }

  // Top padding before the lanes. Grows by a label band when Show Triads is on,
  // so the triad labels get a row above the grid without overlapping it.
  _topPad() {
    return PAD_TOP + (this.opts.getShowTriads && this.opts.getShowTriads() ? TRIAD_BAND : 0);
  }

  _yForDegree(d) {
    return this._topPad() + (this._topDegree - d) * ROW_H;
  }
  _degreeAt(py) {
    const k = clamp(Math.floor((py - this._topPad()) / ROW_H), 0, this._rows - 1);
    return this._topDegree - k;
  }

  // Snap a degree to the nearest in-scale degree (identity when chromatic), so
  // placing/dragging notes stays within the pattern's scale mask.
  _snapToScale(d) {
    return nearestInScale(this.pattern.scaleId, this.pattern.root, d, edoOf(this.pattern.tuningId));
  }

  // --- column geometry (time axis) -------------------------------------

  _stretchW(durIndex) { return stretchWidth(durIndex, STRETCH_MIN_W, STRETCH_MAX_W); }

  _colGeom(i) {
    if (this.mode === 'stretch') {
      let x = PAD_LEFT;
      for (let k = 0; k < i; k++) x += this._stretchW(this.pattern.columns[k].durIndex);
      return { x, w: this._stretchW(this.pattern.columns[i].durIndex) };
    }
    return { x: PAD_LEFT + i * UNIFORM_COL_W, w: UNIFORM_COL_W };
  }
  // Which column a screen x falls in. During a width-changing drag pass `cols` =
  // the PRISTINE pre-drag layout so the target stays a stable function of the
  // cursor (a live-swapped layout shifts widths and makes the target oscillate).
  _columnAt(px, cols = this.pattern.columns) {
    const n = cols.length;
    if (this.mode === 'stretch') {
      let x = PAD_LEFT;
      for (let i = 0; i < n; i++) {
        const w = this._stretchW(cols[i].durIndex);
        if (px < x + w) return i;
        x += w;
      }
      return n - 1;
    }
    return clamp(Math.floor((px - PAD_LEFT) / UNIFORM_COL_W), 0, n - 1);
  }

  // Which performance lane a screen y falls in (only valid when _inFooter).
  _laneAt(y) {
    let top = this.canvas.height - FOOTER_H;
    for (const lane of PERF_LANES) {
      if (y < top + lane.h) return lane.id;
      top += lane.h;
    }
    return PERF_LANES[PERF_LANES.length - 1].id;
  }

  // Draw one lane's chit for `col` in the box (x, y, w, h). Shared by the footer
  // render and the drag ghost, so the carried chit matches the lane it came from.
  _drawChit(laneId, col, x, y, w, h) {
    const ctx = this.ctx;
    if (laneId === 'notes') {
      // A neutral handle for the column's pitch content — no text; solid whether the
      // column has notes or is empty (it represents "the notes", of which there may be none).
      ctx.fillStyle = '#5a616d';
      ctx.fillRect(x + 1, y + 3, w - 2, h - 5);
      return;
    }
    if (laneId === 'articulation') {
      const a = ARTICULATIONS[col.artic == null ? DEFAULT_ARTIC : col.artic] || ARTICULATIONS[DEFAULT_ARTIC];
      ctx.fillStyle = '#20242e';                         // slot background
      ctx.fillRect(x + 1, y + 3, w - 2, h - 5);
      // A bar whose length ∝ how long the note sounds (spiccato tiny, tenuto over-full).
      const frac = a.abs != null ? 0.14 : Math.min(1.12, a.gate);
      const barW = Math.max(2, (w - 4) * Math.min(1, frac));
      ctx.fillStyle = a.abs != null ? '#8a6fae' : (a.gate > 1 ? '#c98a5a' : '#5aa0a0'); // spiccato violet · tenuto warm · else teal
      ctx.fillRect(x + 2, y + 4, barW, h - 7);
      if (w > 24) {
        ctx.fillStyle = '#cdd6df';
        ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(a.label, x + w / 2, y + h / 2 + 1);
      }
      return;
    }
    if (laneId === 'accent') {
      const lvl = col.accent | 0;                        // 0 normal · 1 accent · 2 ghost — soothing pale colors
      ctx.fillStyle = lvl === 1 ? '#e6dc93' : lvl === 2 ? '#a2c1de' : '#a6cbab';
      ctx.fillRect(x + 1, y + 3, w - 2, h - 5);
      if (w > 14) {
        ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        if (lvl === 1) {                                 // accent: a marcato
          ctx.fillStyle = '#4a4212'; ctx.font = 'bold 13px system-ui, sans-serif';
          ctx.fillText('>', x + w / 2, y + h / 2 + 1);
        } else if (lvl === 2) {                          // ghost: a parenthesised dot
          ctx.fillStyle = '#2c4358'; ctx.font = '12px system-ui, sans-serif';
          ctx.fillText('( )', x + w / 2, y + h / 2 + 1);
        }
      }
      return;
    }
    // duration: color = value, small numeric backup
    ctx.fillStyle = PALETTE[col.durIndex];
    ctx.fillRect(x + 1, y + 3, w - 2, h - 5);
    if (w > 22) {
      ctx.fillStyle = '#20242c';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(durationLabel(col.durIndex), x + w / 2, y + h / 2 + 1);
    }
  }

  // The current pattern's column count, and a resize (grow = append rests
  // continuing the diagonal; shrink = drop trailing columns). One undo entry; the
  // count rides the pattern's toJSON snapshot, so it persists + undoes for free.
  columnCount() { return this.pattern.columns.length; }
  setColumns(n) {
    const target = Math.max(MIN_COLS, Math.min(MAX_COLS, n | 0));
    const cur = this.pattern.columns.length;
    if (target === cur) return;
    const before = this._snap();
    if (target > cur) {
      let deg = cur ? this.pattern.columns[cur - 1].degree + 1 : BASE_PITCH;
      for (let i = cur; i < target; i++) {
        this.pattern.columns.push({ durIndex: DEFAULT_DUR, isRest: true, degree: clamp(deg, this._loDeg, this._hiDeg), accent: 0, artic: DEFAULT_ARTIC });
        deg++;
      }
    } else {
      this.pattern.columns.length = target; // drop trailing columns (notes included)
    }
    this._commit(before);
  }

  // --- drawing ----------------------------------------------------------

  _resizeCanvas() {
    const w = this.mode === 'stretch'
      ? PAD_LEFT + this.pattern.columns.reduce((s, c) => s + this._stretchW(c.durIndex), 0) + PAD_RIGHT
      : PAD_LEFT + this.pattern.columns.length * UNIFORM_COL_W + PAD_RIGHT;
    const h = this._topPad() + this._rows * ROW_H + PAD_BOTTOM + FOOTER_H;
    // Assign only on a real change: a same-value write still invalidates layout,
    // and layout churn above the viewport invites scroll-anchoring page jumps.
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  draw() {
    this._resizeCanvas();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const top = this._topDegree;
    const bottom = this._bottomDegree;
    ctx.clearRect(0, 0, W, H);

    // Pitch-class math runs in the pattern's tuning (EDO): octave = `edo` degrees,
    // labels in that tuning's naming (12-ET letters, 16-ET hex).
    const tuningId = this.pattern.tuningId;
    const edo = edoOf(tuningId);

    // Which pitches carry a note (exact degree = strong highlight; the same
    // pitch-class in other octaves = soft highlight).
    const active = new Set();
    const activePC = new Set();
    if (this.opts.getHighlightRows()) {
      for (const c of this.pattern.columns) {
        if (c.isRest) continue;
        active.add(c.degree);
        activePC.add(((c.degree % edo) + edo) % edo);
      }
    }

    // The root (tonic) is marked when it actually matters — i.e. a just/xen tuning
    // or a non-chromatic mask. In plain 12-ET chromatic there's no tonic to show.
    const rootPc = ((this.pattern.root % edo) + edo) % edo;
    const rootShown = tuningId !== '12-et' || this.pattern.scaleId !== 'chromatic';

    // Pitch lanes + labels w/ octave. 12-ET shades the piano black keys; non-12
    // tunings have no black keys, so the octave-home row (class 0) is tinted instead
    // to keep the octave boundaries readable.
    const topPad = this._topPad();
    for (let k = 0; k < this._rows; k++) {
      const d = top - k;
      const y = topPad + k * ROW_H;
      const pc = ((d % edo) + edo) % edo;
      const isActive = active.has(d);
      const isOctave = !isActive && activePC.has(pc);
      const isRoot = rootShown && pc === rootPc;
      ctx.fillStyle = edo === 12 ? (isBlackKey(d) ? '#13151c' : '#171a22') : (pc === 0 ? '#1b2030' : '#171a22');
      ctx.fillRect(0, y, W, ROW_H);
      // In-scale rows get a faint cool wash (only when a non-chromatic mask is on).
      if (this.pattern.scaleId !== 'chromatic' && inScale(this.pattern.scaleId, this.pattern.root, d, edo)) {
        ctx.fillStyle = 'rgba(90, 169, 255, 0.06)';
        ctx.fillRect(0, y, W, ROW_H);
      }
      // The keyboard-tracking pivot row (Boshwick): a soothing faded-pink band so
      // you can see the reference pitch that's unaffected by the Pitch Track knob.
      if (d === this.referenceDegree) {
        ctx.fillStyle = 'rgba(240, 140, 175, 0.13)';
        ctx.fillRect(0, y, W, ROW_H);
      }
      if (isActive) {
        ctx.fillStyle = 'rgba(222, 184, 135, 0.12)';   // strong: this very note
        ctx.fillRect(0, y, W, ROW_H);
      } else if (isOctave) {
        ctx.fillStyle = 'rgba(222, 184, 135, 0.045)';  // soft: octave-mate
        ctx.fillRect(0, y, W, ROW_H);
      }
      if (isRoot) {
        ctx.fillStyle = '#d9b24a';                     // gold tonic stripe
        ctx.fillRect(0, y, 3, ROW_H);
      }
      ctx.fillStyle = isRoot ? '#e6c45c' : isActive ? '#d9c3a0' : isOctave ? '#9a9486' : '#7a8290';
      ctx.font = `${isRoot ? 'bold ' : ''}13px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(degreeToName(d, tuningId), 6, y + ROW_H / 2);
    }

    // Column separators (including the right edge).
    ctx.strokeStyle = '#262a35';
    ctx.lineWidth = 1;
    const cols = this.pattern.columns.length;
    for (let i = 0; i < cols; i++) this._vline(this._colGeom(i).x, H);
    const last = this._colGeom(cols - 1);
    this._vline(last.x + last.w, H);

    // Dots: filled = note, open circle = rest; off-window notes get an edge hint.
    const hideSelForDrag = (this.drag && this.drag.moved && this.drag.axis === 'h')
      || (this.footerDrag && this.footerDrag.moved);
    this.pattern.columns.forEach((c, i) => {
      const { x, w } = this._colGeom(i);
      const cx = x + w / 2;
      const color = PALETTE[c.durIndex];

      // Prospective (un-set) note overlaid on this column: a ghosted dot with a
      // dashed ring. Takes precedence over the empty column's rest marker.
      const ghost = this.prospective.get(i);
      if (ghost) {
        const gd = clamp(ghost.degree, bottom, top);
        const gy = this._yForDegree(gd) + ROW_H / 2;
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(cx, gy, DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = PALETTE[ghost.durIndex];
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(cx, gy, DOT_R + 2, 0, Math.PI * 2);
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#cfe0ff';
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }

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
        this._edgeHint(cx, this._topPad(), -1, color);   // hidden above
      } else if (c.degree < bottom) {
        this._edgeHint(cx, this._topPad() + this._rows * ROW_H, 1, color); // hidden below
      } else {
        const cy = this._yForDegree(c.degree) + ROW_H / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (c.accent) {                                  // ring reflects the accent level (accent warm, ghost cool)
          ctx.beginPath();
          ctx.arc(cx, cy, DOT_R + 3, 0, Math.PI * 2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = c.accent === 2 ? '#4f7391' : '#7a4a2a';
          ctx.stroke();
        }
        // Selection halo (hidden mid horizontal-swap; resolved on release).
        if (this.selection.has(i) && !hideSelForDrag) {
          ctx.beginPath();
          ctx.arc(cx, cy, DOT_R + 5, 0, Math.PI * 2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#5aa9ff';
          ctx.stroke();
        }
      }
    });

    // Performance (X-axis) lanes at the canvas bottom (duration, accent, …): one
    // chit per column per lane, same column geometry as the body so they line up in
    // Grid and Stretch. Click a chit to edit its attribute; drag any chit to swap the
    // whole column.
    const fyTop = H - FOOTER_H;
    ctx.fillStyle = '#12141a';
    ctx.fillRect(0, fyTop, W, FOOTER_H);
    let laneY = fyTop;
    for (const lane of PERF_LANES) {
      ctx.strokeStyle = '#2b303c';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, laneY + 0.5); ctx.lineTo(W, laneY + 0.5); ctx.stroke();
      this.pattern.columns.forEach((c, i) => {
        const { x, w } = this._colGeom(i);
        this._drawChit(lane.id, c, x, laneY, w, lane.h);
        if (this._isArmed(i, lane.id)) {                  // armed for the next swap: bright blue frame
          ctx.strokeStyle = '#5aa9ff';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1.5, laneY + 3.5, w - 3, lane.h - 6);
        }
      });
      ctx.fillStyle = '#aeb8c6';                          // lane label in the gutter (left of the columns)
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(lane.label, 5, laneY + lane.h / 2 + 1);
      laneY += lane.h;
    }

    // Chit-drag swap feedback: highlight the two exchanging columns full-height
    // (grabbed slot = blue, current target = amber outline) — the swap itself previews
    // live in the notes / durations / triad labels above — plus a ghost of the grabbed
    // chit floating above the lanes at the cursor (the "chit in your hand").
    if (this.footerDrag && this.footerDrag.moved) {
      const fd = this.footerDrag;
      const src = this._colGeom(fd.col);
      ctx.fillStyle = 'rgba(90, 169, 255, 0.12)';
      ctx.fillRect(src.x, 0, src.w, H);
      if (fd.target !== fd.col) {
        const tgt = this._colGeom(fd.target);
        ctx.fillStyle = 'rgba(222, 184, 135, 0.12)';
        ctx.fillRect(tgt.x, 0, tgt.w, H);
        ctx.strokeStyle = '#d9b24a';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(tgt.x + 0.75, 0.75, tgt.w - 1.5, H - 1.5);
      }
      // The carried chit(s): a stack of the armed lanes' chits from the pristine base,
      // lifted clear of the lanes with a shadow so they read as held, not a copy.
      if (fd.cursorX != null && fd.base && fd.lanes) {
        const laneH = (id) => (PERF_LANES.find((l) => l.id === id) || PERF_LANES[0]).h;
        const stackH = fd.lanes.reduce((s, id) => s + laneH(id), 0);
        const gw = this.mode === 'stretch' ? this._stretchW(fd.base[fd.col].durIndex) : UNIFORM_COL_W;
        const gx = clamp(fd.cursorX, PAD_LEFT + gw / 2, W - gw / 2) - gw / 2;
        let gy = fyTop - stackH - 6;
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 3;
        for (const id of fd.lanes) { this._drawChit(id, fd.base[fd.col], gx, gy, gw, laneH(id)); gy += laneH(id); }
        ctx.restore();
      }
    }

    // Marching-ants marquee on top (animated dash offset, faint blue fill).
    if (this.marquee) {
      const m = this.marquee;
      const mx = Math.min(m.x0, m.x1), my = Math.min(m.y0, m.y1);
      const mw = Math.abs(m.x1 - m.x0), mh = Math.abs(m.y1 - m.y0);
      ctx.save();
      ctx.fillStyle = 'rgba(90, 169, 255, 0.08)';
      ctx.fillRect(mx, my, mw, mh);
      ctx.strokeStyle = '#5aa9ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -this._antsOffset;
      ctx.strokeRect(mx + 0.5, my + 0.5, mw, mh);
      ctx.restore();
    }

    // Triad labels in the top band (when enabled).
    if (this.opts.getShowTriads && this.opts.getShowTriads()) this._drawTriadLabels(ctx);
  }

  // Columns as the triad labeler sees them: the pattern with any Triadulator
  // prospective (un-set) notes merged in, so proposed chords get labeled too.
  _labelColumns() {
    if (!this.prospective.size) return this.pattern.columns;
    return this.pattern.columns.map((c, i) => {
      const g = this.prospective.get(i);
      return g ? { degree: g.degree, isRest: false } : c;
    });
  }

  // Triads found in adjacent note-triples (12-ET only; three notes in a row, no
  // rest between). Returns { x: center over the middle column, text } for each.
  _triadLabels() {
    const cols = this._labelColumns();
    const out = [];
    for (let i = 0; i + 2 < cols.length; i++) {
      const a = cols[i], b = cols[i + 1], c = cols[i + 2];
      if (a.isRest || b.isRest || c.isRest) continue;
      const t = classifyTriad([a.degree, b.degree, c.degree], edoOf(this.pattern.tuningId));
      if (!t) continue;
      const g = this._colGeom(i + 1);
      out.push({ x: g.x + g.w / 2, text: `${pitchClassName(t.root, this.pattern.tuningId)} ${QUALITY[t.quality]}` });
    }
    return out;
  }

  // Draw triad labels into the top band, packed across two rows so neighbours
  // (common in arpeggios / Stretch mode) don't collide.
  _drawTriadLabels(ctx) {
    const labels = this._triadLabels();
    if (!labels.length) return;
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const rowY = [PAD_TOP + 4, PAD_TOP + 18]; // two stacked rows within the band
    const rowEnd = [-Infinity, -Infinity];
    for (const lab of labels) {
      const halfW = ctx.measureText(lab.text).width / 2 + 4;
      const row = rowEnd[0] <= rowEnd[1] ? 0 : 1; // place on whichever row freed up first
      rowEnd[row] = lab.x + halfW;
      ctx.fillStyle = 'rgba(20, 24, 33, 0.85)';
      ctx.fillRect(lab.x - halfW, rowY[row] - 7, halfW * 2, 14);
      ctx.fillStyle = '#cbd2e0';
      ctx.fillText(lab.text, lab.x, rowY[row]);
    }
    ctx.restore();
  }

  _vline(x, H) {
    this.ctx.beginPath();
    this.ctx.moveTo(x + 0.5, this._topPad());
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
    if (this._cursorZone === 'footer') { this.canvas.style.cursor = 'pointer'; return; }
    const { durIndex } = this.opts.getBrush();
    this.canvas.style.cursor = makeCursor(this.opts.getCursorStyle(), durIndex);
  }

  // Hover cursor: a plain finger over the performance lanes (they're UI controls,
  // not a note canvas), the note/brush cursor over the grid body. Only re-sets when
  // the zone changes so we don't rebuild the brush cursor image on every move.
  _hoverCursor(inFooter) {
    const zone = inFooter ? 'footer' : 'body';
    if (this._cursorZone === zone) return;
    this._cursorZone = zone;
    if (inFooter) this.canvas.style.cursor = 'pointer';
    else this.updateCursor();
  }

  // --- arming (which lanes a footer drag swaps) ------------------------
  // Arming is transient (like the selection): not persisted, not undoable. It lives
  // in ONE column at a time — double-click chits to toggle lanes into the set (or
  // double-click the notes chit to arm all four), then drag any chit in that column
  // to swap exactly the armed lanes. An unarmed drag swaps just the grabbed lane.

  _ensureArmCol(col) {
    if (!this.armed || this.armed.col !== col) this.armed = { col, lanes: new Set() };
  }
  _toggleArm(col, lane) {
    this._ensureArmCol(col);
    const s = this.armed.lanes;
    if (s.has(lane)) s.delete(lane); else s.add(lane);
    if (!s.size) this.armed = null;
  }
  _armAll(col) { this.armed = { col, lanes: new Set(ALL_LANES) }; }
  _clearArm() { if (this.armed) { this.armed = null; return true; } return false; }
  _isArmed(col, lane) { return !!(this.armed && this.armed.col === col && this.armed.lanes.has(lane)); }
  // The lanes a drag on (col, lane) should swap: the armed set if this is the armed
  // column, else just the grabbed lane. Ordered by PERF_LANES for a stable ghost stack.
  _dragLanes(col, lane) {
    if (this.armed && this.armed.col === col && this.armed.lanes.size) {
      return ALL_LANES.filter((id) => this.armed.lanes.has(id));
    }
    return [lane];
  }

  // --- chit single-click, deferred so a second click can promote it to a double ---
  // A single-click EDITS its lane (duration→brush, accent/artic cycle, notes→arm the
  // notes). We apply that optimistically for instant feedback but hold the undo entry
  // for DBL_MS: if a matching second click lands, we roll the edit back and ARM instead.

  // Apply a chit's single-click edit in place (no history yet — deferred).
  _applyChitEdit(col, laneId) {
    const c = this.pattern.columns[col];
    if (laneId === 'notes') { this._toggleArm(col, 'notes'); return; } // notes: nothing to edit → select/arm
    if (laneId === 'accent') c.accent = nextAccent(c.accent);
    else if (laneId === 'articulation') c.artic = nextArtic(c.artic == null ? DEFAULT_ARTIC : c.artic);
    else c.durIndex = this.opts.getBrush().durIndex;
  }
  // The armed edit a double-click makes: notes chit → arm all four; any other chit →
  // toggle that lane in the armed set.
  _applyChitArm(col, laneId) {
    if (laneId === 'notes') this._armAll(col);
    else this._toggleArm(col, laneId);
  }
  // Commit a held single-click (its undo entry) and clear the pending slot.
  _commitPendingClick() {
    const pc = this._pendingClick;
    if (!pc) return;
    clearTimeout(pc.timer);
    this._pendingClick = null;
    this._commit(pc.before); // pushes history iff the edit changed anything (notes-arm doesn't)
  }
  // Flush any pending click immediately (e.g. a new, unrelated gesture starts).
  _flushPendingClick() { if (this._pendingClick) this._commitPendingClick(); }

  // --- editing interaction ---------------------------------------------

  _bind() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => this._down(e));
    cv.addEventListener('pointermove', (e) => this._move(e));
    cv.addEventListener('pointerup', (e) => this._up(e));
    cv.addEventListener('pointercancel', (e) => this._up(e));
    cv.addEventListener('contextmenu', (e) => this._context(e));
    cv.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    // Ctrl is the "select" modifier: show a crosshair while it's held.
    const modKey = (e) => {
      if (e.ctrlKey || e.metaKey) { if (this.canvas.style.cursor !== 'crosshair') this.canvas.style.cursor = 'crosshair'; }
      else this.updateCursor();
    };
    window.addEventListener('keydown', modKey);
    window.addEventListener('keyup', modKey);
    window.addEventListener('blur', () => this.updateCursor());
    // ESC owns cancellation of an in-progress gesture (capture phase, so the global
    // Esc handler doesn't also clear the selection).
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.footerDrag || this.drag || this.selDrag || this.armed)) {
        if (this.cancelGesture()) { e.stopPropagation(); e.preventDefault(); }
      }
    }, true);
    if (this.opts.handle) this._bindResize();
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _snap() { return JSON.stringify(this.pattern.toJSON()); }
  _restore(before) { this.pattern.columns = Pattern.fromJSON(JSON.parse(before), this.pattern.name).columns; }

  // Push one undo entry (the pre-edit snapshot) iff the edit actually changed
  // something, then redraw. A whole drag collapses into a single entry.
  _commit(before) {
    this._pruneSelection(); // a note turned into a rest can't stay selected
    if (before !== this._snap()) this.opts.onHistory(before);
    this.opts.onChange();
  }

  // ESC cancels ANY in-progress gesture, restoring the pre-gesture state and
  // committing NOTHING. Returns whether a gesture was actually cancelled.
  cancelGesture() {
    if (this.footerDrag) {
      const fd = this.footerDrag; this.footerDrag = null;
      if (fd.moved) this._restore(fd.before);
      this._cursorZone = null; this.updateCursor();
      this.opts.onChange();
      return true;
    }
    if (this.drag) {
      const d = this.drag; this.drag = null;
      if (d.moved) this._restore(d.before);
      this.opts.onChange();
      return true;
    }
    if (this.selDrag) {
      if (this._marqueeRAF) { cancelAnimationFrame(this._marqueeRAF); this._marqueeRAF = null; }
      this.selDrag = null; this.marquee = null; // drop the marquee without toggling — prior selection stands
      this.draw();
      return true;
    }
    // Nothing dragging: ESC disarms the armed lanes (a completed edit stays committed).
    this._flushPendingClick();
    if (this._clearArm()) { this.opts.onChange(); return true; }
    return false;
  }

  _down(e) {
    if (e.button === 2) return; // right-click handled by contextmenu
    const { x, y } = this._pos(e);
    const willFooterDrag = this._inFooter(y) && x >= PAD_LEFT && !(e.ctrlKey || e.metaKey);
    // Anything that isn't a footer-chit press dismisses a held arm and flushes a
    // pending single-click edit (its undo entry settles now).
    if (!willFooterDrag) { this._flushPendingClick(); this._clearArm(); }
    if (e.ctrlKey || e.metaKey) {
      // Select gesture: on a note → toggle it; on empty/rest → drag a marquee.
      this.canvas.setPointerCapture(e.pointerId);
      this.selDrag = { startX: x, startY: y, hitCol: this._noteAt(x, y), moved: false };
      return;
    }
    // Performance lanes: a single-click edits that lane (duration→brush, accent/artic
    // cycle, notes→select); a double-click arms/disarms lanes; a drag swaps the armed
    // lanes (or just the grabbed lane if none are armed). Editing/arming resolve in _up.
    if (willFooterDrag) {
      this.canvas.setPointerCapture(e.pointerId);
      const col = this._columnAt(x);
      this.footerDrag = { col, target: col, startX: x, cursorX: x, moved: false, before: this._snap(), lane: this._laneAt(y) };
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { col: this._columnAt(x), startX: x, startY: y, moved: false, shift: e.shiftKey, lastD: null, before: this._snap() };
  }

  _inFooter(y) { return y >= this.canvas.height - FOOTER_H; }

  _move(e) {
    // Duration-chit drag: pick up the whole column and PREVIEW the swap live — the
    // two columns exchange (notes + duration), recomputed from the pristine layout
    // so it's a clean two-cell exchange, and onChange redraws so the notes AND the
    // triad labels update from the swapped columns. Commits on release (preview == commit).
    if (this.footerDrag) {
      const { x } = this._pos(e);
      const fd = this.footerDrag;
      if (!fd.moved) {
        if (Math.abs(x - fd.startX) <= DRAG_THRESHOLD) return;
        fd.moved = true;
        this._flushPendingClick();      // a queued single-click edit settles before the drag
        fd.lanes = this._dragLanes(fd.col, fd.lane); // the armed set (or just this lane)
        fd.base = this.pattern.columns.map((c) => ({ ...c }));
        this.canvas.style.cursor = 'grabbing';
      }
      fd.cursorX = x;
      const target = this._columnAt(x, fd.base); // stable target (pristine widths)
      if (target !== fd.target) {
        const cols = this.pattern.columns;
        for (let i = 0; i < cols.length; i++) cols[i] = { ...fd.base[i] };
        swapLanes(cols, fd.col, target, fd.lanes); // swap only the armed lanes
        fd.target = target;
        this.opts.onChange();
      } else {
        this.draw(); // keep the floating ghost tracking the cursor between target changes
      }
      return;
    }

    // Ctrl select-gesture: decide toggle-vs-marquee on first movement, then size
    // the marquee. (Only an empty/rest start becomes a marquee.)
    if (this.selDrag) {
      const { x, y } = this._pos(e);
      if (!this.selDrag.moved &&
          Math.hypot(x - this.selDrag.startX, y - this.selDrag.startY) > DRAG_THRESHOLD) {
        this.selDrag.moved = true;
        if (this.selDrag.hitCol < 0) this._startMarquee();
      }
      if (this.marquee) { this.marquee.x1 = x; this.marquee.y1 = y; }
      return;
    }

    if (!this.drag) { this._hoverCursor(this._inFooter(this._pos(e).y)); return; }
    const { x, y } = this._pos(e);

    // Lock the axis on the first movement past the threshold: whichever of the
    // two deltas is larger wins, and the drag stays on that axis (no diagonal).
    if (!this.drag.moved) {
      const dx = x - this.drag.startX;
      const dy = y - this.drag.startY;
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      this.drag.moved = true;
      this.drag.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (this.drag.axis === 'h') {
        this.drag.base = this.pattern.columns.map((c) => ({ ...c })); // pristine layout to swap against
        this.drag.target = this.drag.col;
      }
    }

    if (this.drag.axis === 'v') {
      const col = this.pattern.columns[this.drag.col];
      const d = this._snapToScale(this._degreeAt(y));
      if (col.degree !== d) {
        col.degree = d;
        if (!col.isRest && this.drag.lastD !== d) {
          this.drag.lastD = d;
          this.opts.onAudition(d);
        }
        this.opts.onChange();
      }
    } else {
      const target = this._columnAt(x, this.drag.base); // stable target (pristine widths)
      if (target !== this.drag.target) {
        this._applyHSwap(target);
        const held = this.pattern.columns[target]; // the dragged cell now sits here
        if (!held.isRest) this.opts.onAudition(held.degree);
        this.opts.onChange();
      }
    }
  }

  // Horizontal body drag: swap only the NOTE payload (pitch/rest/accent) with
  // `target`, leaving each column's DURATION in place (duration is a footer/slot
  // property now). Always computed against the pristine layout so passing over
  // middle columns never accumulates — a clean two-cell exchange.
  _applyHSwap(target) {
    const cols = this.pattern.columns;
    const base = this.drag.base;
    for (let i = 0; i < cols.length; i++) cols[i] = { ...base[i] };
    swapNotePayload(cols, this.drag.col, target);
    this.drag.target = target;
  }

  _up(e) {
    // Chit release. A DRAG swapped the armed lanes live (preview == commit) — carry
    // the selection only if the notes moved, then disarm. A CLICK is held DBL_MS: a
    // matching second click ARMS (rolling back the first click's optimistic edit);
    // otherwise the single-click edit settles on its own.
    if (this.footerDrag) {
      const fd = this.footerDrag;
      this.footerDrag = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this._cursorZone = null;
      this._hoverCursor(this._inFooter(this._pos(e).y));
      if (fd.moved) {
        if (fd.lanes.includes('notes') && fd.target !== fd.col) this._swapSelection(fd.col, fd.target);
        this._clearArm();               // a completed swap disarms
        this._commit(fd.before);
        return;
      }
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const pc = this._pendingClick;
      if (pc && pc.col === fd.col && pc.lane === fd.lane && now - pc.t < DBL_MS) {
        // Double-click: undo the first click's optimistic edit, then arm instead.
        clearTimeout(pc.timer);
        this._pendingClick = null;
        this._restore(pc.before);
        this._applyChitArm(fd.col, fd.lane);
        this.opts.onChange();           // arm is transient — no history
        return;
      }
      // First click: settle any unrelated pending edit, apply this one optimistically,
      // and hold its undo entry for DBL_MS in case a second click promotes it to a double.
      this._flushPendingClick();
      this._applyChitEdit(fd.col, fd.lane);
      this.opts.onChange();
      const timer = setTimeout(() => this._commitPendingClick(), DBL_MS);
      this._pendingClick = { col: fd.col, lane: fd.lane, before: fd.before, t: now, timer };
      return;
    }

    // Finish a Ctrl select-gesture: marquee toggles enclosed notes; otherwise a
    // press on a note (no marquee) toggles that note; empty click does nothing.
    if (this.selDrag) {
      const s = this.selDrag;
      this.selDrag = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (this.marquee) this._finishMarquee();
      else if (s.hitCol >= 0) this._toggleCol(s.hitCol);
      return;
    }

    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d.moved) {
      if (d.axis === 'h' && d.target !== d.col) this._swapSelection(d.col, d.target);
      this._commit(d.before);
      return;
    }

    const col = this.pattern.columns[d.col];
    const degree = this._snapToScale(this._degreeAt(this._pos(e).y));

    if (d.shift) {
      if (!col.isRest) {
        col.accent = nextAccent(col.accent);   // cycle normal → accent → ghost
        this.opts.onAudition(col.degree);
      }
    } else if (col.isRest) {
      col.isRest = false;
      col.degree = degree;                                  // keeps the column's footer duration
      this.opts.onAudition(degree);
    } else if (degree === col.degree) {
      this.opts.onAudition(col.degree);                     // a note's own cell = re-hear it (no duration change)
    } else {
      col.degree = degree;                                  // move the note to another pitch
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
      col.degree = this._snapToScale(this._degreeAt(y));
      this.opts.onAudition(col.degree); // accent (the slot's groove) is left as-is
    } else {
      col.isRest = true; // degree kept as the cosmetic rest position
    }
    this._commit(before);
  }

  _wheel(e) {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1; // wheel up -> higher pitches
    const vp = this._vp;
    const top = clamp(vp.top + dir, this._loDeg + vp.rows - 1, this._hiDeg);
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
      const maxByFloor = this._topDegree - this._loDeg + 1;
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
    const newHeight = this._topPad() + rows * ROW_H + PAD_BOTTOM;
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
    const glyphs = ['♪', '♩', '♩.', '𝅗𝅥', '𝅘𝅥𝅯', '♪.']; // matches DURATIONS order (1/16, 3/16 last)
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

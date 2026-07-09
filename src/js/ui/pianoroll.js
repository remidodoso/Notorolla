// pianoroll.js — draw the score on a canvas and animate a playhead.
//
// X axis = time (beats). Y axis = pitch, continuous in *cents* so microtonal and
// mixed-tuning notes land at their true height (each note carries a tuning-
// resolved `freq`). The lane backdrop stays a 12-ET reference ruler, and 12-ET
// notes map exactly as before, pixel-for-pixel. Redrawn every frame.

import { noteName, isBlackKey, noteToFreq } from '../core/model.js';
import { degreeToFreq, tuningFreq, degreeToName, edoOf, degreeBounds, hasEquave } from '../core/tuning.js';

// PAD_LEFT and BEAT_WIDTH are exported so the grid's "Stretch" mode can share
// the roll's horizontal origin and DEFAULT scale (the two views line up at the
// roll's default zoom; zooming the roll is a view-only divergence).
export const PAD_LEFT = 44;     // room for pitch labels
const PAD_TOP = 16;
const PAD_RIGHT = 24;
const PAD_BOTTOM = 16;
const TUNING_COL_W = 38;        // one gutter column per non-12-ET tuning in use
export const BEAT_WIDTH = 56;   // px per beat (the default H zoom)
const NOTE_HEIGHT = 18;  // px per semitone (100 cents) lane (the default V zoom)
const BEATS_PER_BAR = 4;
const FREF = noteToFreq(0); // cents reference, chosen so 12-ET pitch p == 100*p cents

// Quantized zoom notches (px/semitone and px/beat); the defaults sit inside.
export const ROLL_V_SCALES = [4, 6, 9, 12, NOTE_HEIGHT, 24, 32];
export const ROLL_H_SCALES = [16, 24, 36, BEAT_WIDTH, 80];
export const ROLL_V_DEFAULT = ROLL_V_SCALES.indexOf(NOTE_HEIGHT);
export const ROLL_H_DEFAULT = ROLL_H_SCALES.indexOf(BEAT_WIDTH);

const COLORS = {
  laneWhite: '#171a22',
  laneBlack: '#13151c',
  gridBeat: '#22262f',
  gridBar: '#323843',
  label: '#5a6270',
  labelC: '#8a93a3',      // the Cs (and degree-0 classes) pop for orientation
  gutterTick: '#3a4150',  // gutter column separators + degree tick marks
  gutterBg: '#11131a',    // opaque gutter base (matches the page background)
  note: '#5aa9ff',
  noteEdge: '#bcd9ff',
  playhead: '#ff6b6b',
};

export class PianoRoll {
  // `gutterCanvas` (optional): a second canvas, pinned by CSS to the pane's
  // left edge, that carries ALL the pitch labels — so they never scroll out of
  // sight with the content. Without one, labels are skipped entirely.
  constructor(canvas, score, gutterCanvas = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.gutter = gutterCanvas;
    this.gctx = gutterCanvas ? gutterCanvas.getContext('2d') : null;
    this._hatchCache = new Map(); // color -> CanvasPattern, for muted/silent notes
    this.noteH = NOTE_HEIGHT; // px per semitone — the V zoom (setZoom)
    this.beatW = BEAT_WIDTH;  // px per beat — the H zoom
    this.tunings = [];        // non-12-ET {id, root} IN USE — one gutter column each
    this.setScore(score);
  }

  // View-only zoom (quantized notches picked by the host); resizes to fit.
  setZoom(noteH, beatW) {
    this.noteH = noteH;
    this.beatW = beatW;
    this._resize();
  }

  // Adopt a score and size the canvas to it: width follows the tune's length,
  // height follows its true pitch range in cents (rounded out to whole semitone
  // reference lanes, padded a couple each side).
  setScore(score) {
    this.score = score;
    let minC = Infinity;
    let maxC = -Infinity;
    if (score.notes.length) {
      for (const n of score.notes) {
        const c = this._noteCents(n);
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    } else {
      const { min, max } = score.pitchRange; // default 60..72
      minC = 100 * min;
      maxC = 100 * max;
    }
    this.minPitch = Math.floor(minC / 100) - 2;
    this.maxPitch = Math.ceil(maxC / 100) + 2;
    this.maxCents = 100 * this.maxPitch;       // top edge, for yForCents
    this.pitchCount = this.maxPitch - this.minPitch + 1;
    this._resize();
  }

  _resize() {
    // Assign only on a real change: a same-value write still invalidates
    // layout, and layout churn invites scroll-anchoring page jumps.
    const w = PAD_LEFT + this.score.lengthBeats * this.beatW + PAD_RIGHT;
    const h = PAD_TOP + this.pitchCount * this.noteH + PAD_BOTTOM;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (this.gutter) {
      // 12-ET column (exactly the PAD_LEFT the notes start after) + one column
      // per in-use tuning. Negative margin = zero net layout width, so the
      // sticky gutter OVERLAYS the canvas instead of pushing it right.
      const gw = PAD_LEFT + TUNING_COL_W * this.tunings.length;
      if (this.gutter.width !== gw) this.gutter.width = gw;
      if (this.gutter.height !== h) this.gutter.height = h;
      this.gutter.style.marginRight = `${-gw}px`;
    }
  }

  xForBeat(beat) {
    return PAD_LEFT + beat * this.beatW;
  }

  // Continuous pitch axis. yForPitch (integer 12-ET) is the special case used by
  // the reference lanes; notes use yForCents on their true frequency.
  yForCents(cents) {
    return PAD_TOP + ((this.maxCents - cents) / 100) * this.noteH;
  }
  yForPitch(pitch) {
    return this.yForCents(100 * pitch);
  }
  _cents(freq) {
    return 1200 * Math.log2(freq / FREF);
  }
  _noteCents(n) {
    return this._cents(n.freq != null ? n.freq : degreeToFreq(n.pitch));
  }

  // Repaint the whole scene (lanes, grid, notes, playhead). Cheap enough at
  // this size to call every animation frame, which keeps the playhead in sync.
  /** @param playheadBeat  beats from start, or null to hide the playhead */
  draw(playheadBeat = null) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    this._drawLanes(ctx, w);
    this._drawGrid(ctx, h);
    this._drawNotes(ctx);
    if (playheadBeat !== null) this._drawPlayhead(ctx, playheadBeat, h);
    this._drawGutter();
  }

  // Graph-tick label steps: every pitch when the zoom gives each lane room for
  // the (constant-size) text, otherwise straight to OCTAVES only — the in-
  // between "minor tick" labels just crowd at reduced scale, and exact pitch
  // reading is what zooming in is for (user). `octave` = steps per octave
  // (12 for the lanes, the EDO for the degree gutter).
  _labelStep(pxPerStep, octave, minPx = 13) {
    for (const step of [1, octave, 2 * octave, 4 * octave]) {
      if (step * pxPerStep >= minPx) return step;
    }
    return 4 * octave;
  }

  _drawLanes(ctx, w) {
    for (let p = this.minPitch; p <= this.maxPitch; p++) {
      const y = this.yForPitch(p);
      ctx.fillStyle = isBlackKey(p) ? COLORS.laneBlack : COLORS.laneWhite;
      ctx.fillRect(0, y, w, this.noteH);
    }
  }

  // The pinned label gutter (its own sticky canvas — labels never scroll out of
  // sight). Column 0 = 12-ET names; then ONE COLUMN PER IN-USE non-12-ET tuning
  // (its own nomenclature via degreeToName at true cent heights, headed by its
  // EDO). Constant font size; density via the [every pitch | octaves] step.
  // Degree placement assumes an equal division (true of every current tuning;
  // an unequal scale would need a scan instead of the closed form).
  _drawGutter() {
    const g = this.gctx;
    if (!g) return;
    const gw = this.gutter.width, gh = this.gutter.height;
    g.clearRect(0, 0, gw, gh);
    g.fillStyle = COLORS.gutterBg; // opaque — content scrolls UNDER the gutter
    g.fillRect(0, 0, gw, gh);
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';

    // Lane stripes so the gutter reads as part of the roll.
    for (let p = this.minPitch; p <= this.maxPitch; p++) {
      g.fillStyle = isBlackKey(p) ? COLORS.laneBlack : COLORS.laneWhite;
      g.fillRect(0, this.yForPitch(p), gw, this.noteH);
    }

    // Column 0: 12-ET names (every semitone, or Cs only — see _labelStep).
    const step = this._labelStep(this.noteH, 12);
    for (let p = this.minPitch; p <= this.maxPitch; p++) {
      if (((p % step) + step) % step !== 0) continue;
      g.fillStyle = p % 12 === 0 ? COLORS.labelC : COLORS.label; // Cs pop for orientation
      g.fillText(noteName(p), 6, this.yForPitch(p) + this.noteH / 2);
    }

    // One column per in-use tuning: header = its EDO, then degree names.
    this.tunings.forEach((t, i) => {
      const x0 = PAD_LEFT + i * TUNING_COL_W;
      g.strokeStyle = COLORS.gutterTick;
      g.beginPath();
      g.moveTo(x0 + 0.5, 0);
      g.lineTo(x0 + 0.5, gh);
      g.stroke();

      const eq = hasEquave(t.id);
      const edo = edoOf(t.id);
      g.fillStyle = COLORS.labelC;
      g.fillText(eq ? `${edo}` : 'cx', x0 + 4, PAD_TOP / 2); // header: the EDO, or "cx" for the non-octave cross

      g.textAlign = 'right';
      if (eq) {
        // Octave-periodic tuning: step the even EDO grid, C rows popped.
        const stepCents = 1200 / edo;
        const dStep = this._labelStep((this.noteH * stepCents) / 100, edo);
        const base = this._cents(tuningFreq(0, t.id, t.root)); // cents of degree 0
        const dLo = Math.ceil((100 * this.minPitch - base) / stepCents);
        const dHi = Math.floor((this.maxCents - base) / stepCents);
        for (let d = dLo; d <= dHi; d++) {
          if (((d % dStep) + dStep) % dStep !== 0) continue;
          const y = this.yForCents(base + d * stepCents);
          g.strokeStyle = COLORS.gutterTick;
          g.beginPath();
          g.moveTo(x0 + 1, y + 0.5);
          g.lineTo(x0 + 6, y + 0.5);
          g.stroke();
          g.fillStyle = (((d % edo) + edo) % edo) === 0 ? COLORS.labelC : COLORS.label;
          g.fillText(degreeToName(d, t.id), x0 + TUNING_COL_W - 4, y);
        }
      } else {
        // Non-octave tuning: no even grid to step — label the actual degrees at their
        // true pitch heights, thinned so labels don't collide.
        const b = degreeBounds(t.id, t.root);
        let lastY = Infinity;
        for (let d = b.min; d <= b.max; d++) {
          const c = this._cents(tuningFreq(d, t.id, t.root));
          if (c < 100 * this.minPitch || c > this.maxCents) continue;
          const y = this.yForCents(c);
          if (Math.abs(y - lastY) < 11) continue;
          lastY = y;
          g.strokeStyle = COLORS.gutterTick;
          g.beginPath();
          g.moveTo(x0 + 1, y + 0.5);
          g.lineTo(x0 + 6, y + 0.5);
          g.stroke();
          g.fillStyle = COLORS.label;
          g.fillText(degreeToName(d, t.id), x0 + TUNING_COL_W - 4, y);
        }
      }
      g.textAlign = 'left';
    });

    // Right border so the pinned edge reads while content slides beneath.
    g.strokeStyle = COLORS.gutterTick;
    g.beginPath();
    g.moveTo(gw - 0.5, 0);
    g.lineTo(gw - 0.5, gh);
    g.stroke();
  }

  _drawGrid(ctx, h) {
    const beats = Math.ceil(this.score.lengthBeats);
    for (let b = 0; b <= beats; b++) {
      const x = this.xForBeat(b);
      ctx.strokeStyle = b % BEATS_PER_BAR === 0 ? COLORS.gridBar : COLORS.gridBeat;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, PAD_TOP);
      ctx.lineTo(x + 0.5, h - PAD_BOTTOM);
      ctx.stroke();
    }
  }

  _drawNotes(ctx) {
    // Notes may carry an optional color/alpha (per-lane coloring; dimmed for
    // non-active lanes — a *focus* signal). A `muted` note belongs to a lane that
    // isn't sounding (explicitly muted, or silenced because another lane is
    // soloed); it's drawn as a faint body under a diagonal hatch — an orthogonal
    // *audible-vs-silent* signal — so the roll always shows what you'll hear.
    for (const n of this.score.notes) {
      const x = this.xForBeat(n.start);
      const y = this.yForCents(this._noteCents(n)); // true pitch, so mixed tunings don't overlap
      const wid = n.duration * this.beatW;
      const color = n.color || COLORS.note;
      const alpha = n.alpha ?? 1;

      this._roundRect(ctx, x + 1, y + 1, wid - 2, this.noteH - 2, 4);
      if (n.muted) {
        ctx.globalAlpha = alpha * 0.18;       // faint colored body, so the note still reads
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = alpha;              // hatch at full (focus) alpha over it
        ctx.fillStyle = this._hatch(color);
        ctx.fill();
      } else {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.strokeStyle = n.muted ? color : COLORS.noteEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // A repeating 45° hatch tile in `color` (cached). Tiling a single corner-to-
  // corner diagonal makes a continuous hatch across the note.
  _hatch(color) {
    if (this._hatchCache.has(color)) return this._hatchCache.get(color);
    const s = 6;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const cx = c.getContext('2d');
    cx.strokeStyle = color;
    cx.lineWidth = 1.4;
    cx.beginPath();
    cx.moveTo(0, s);
    cx.lineTo(s, 0);
    cx.stroke();
    const pat = this.ctx.createPattern(c, 'repeat');
    this._hatchCache.set(color, pat);
    return pat;
  }

  _drawPlayhead(ctx, beat, h) {
    const x = this.xForBeat(beat);
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, PAD_TOP);
    ctx.lineTo(x, h - PAD_BOTTOM);
    ctx.stroke();
  }

  // Trace a rounded-rectangle path on the context (caller fills/strokes it).
  _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

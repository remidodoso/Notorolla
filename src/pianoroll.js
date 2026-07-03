// pianoroll.js — draw the score on a canvas and animate a playhead.
//
// X axis = time (beats). Y axis = pitch, continuous in *cents* so microtonal and
// mixed-tuning notes land at their true height (each note carries a tuning-
// resolved `freq`). The lane backdrop stays a 12-ET reference ruler, and 12-ET
// notes map exactly as before, pixel-for-pixel. Redrawn every frame.

import { noteName, isBlackKey, noteToFreq } from './model.js';
import { degreeToFreq } from './tuning.js';

// PAD_LEFT and BEAT_WIDTH are exported so the grid's "Stretch" mode can share
// the roll's horizontal origin and scale, lining the two views up.
export const PAD_LEFT = 44;     // room for pitch labels
const PAD_TOP = 16;
const PAD_RIGHT = 24;
const PAD_BOTTOM = 16;
export const BEAT_WIDTH = 56;   // px per beat
const NOTE_HEIGHT = 18;  // px per semitone (100 cents) lane
const BEATS_PER_BAR = 4;
const FREF = noteToFreq(0); // cents reference, chosen so 12-ET pitch p == 100*p cents

const COLORS = {
  laneWhite: '#171a22',
  laneBlack: '#13151c',
  gridBeat: '#22262f',
  gridBar: '#323843',
  label: '#5a6270',
  note: '#5aa9ff',
  noteEdge: '#bcd9ff',
  playhead: '#ff6b6b',
};

export class PianoRoll {
  constructor(canvas, score) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._hatchCache = new Map(); // color -> CanvasPattern, for muted/silent notes
    this.setScore(score);
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

    // Assign only on a real change: a same-value write still invalidates
    // layout, and layout churn invites scroll-anchoring page jumps.
    const w = PAD_LEFT + score.lengthBeats * BEAT_WIDTH + PAD_RIGHT;
    const h = PAD_TOP + this.pitchCount * NOTE_HEIGHT + PAD_BOTTOM;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  xForBeat(beat) {
    return PAD_LEFT + beat * BEAT_WIDTH;
  }

  // Continuous pitch axis. yForPitch (integer 12-ET) is the special case used by
  // the reference lanes; notes use yForCents on their true frequency.
  yForCents(cents) {
    return PAD_TOP + ((this.maxCents - cents) / 100) * NOTE_HEIGHT;
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
  }

  _drawLanes(ctx, w) {
    for (let p = this.minPitch; p <= this.maxPitch; p++) {
      const y = this.yForPitch(p);
      ctx.fillStyle = isBlackKey(p) ? COLORS.laneBlack : COLORS.laneWhite;
      ctx.fillRect(0, y, w, NOTE_HEIGHT);

      // Label each C so you can read the octave.
      if (p % 12 === 0) {
        ctx.fillStyle = COLORS.label;
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(noteName(p), 6, y + NOTE_HEIGHT / 2);
      }
    }
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
      const wid = n.duration * BEAT_WIDTH;
      const color = n.color || COLORS.note;
      const alpha = n.alpha ?? 1;

      this._roundRect(ctx, x + 1, y + 1, wid - 2, NOTE_HEIGHT - 2, 4);
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

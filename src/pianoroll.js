// pianoroll.js — draw the score on a canvas and animate a playhead.
//
// X axis = time (beats), Y axis = pitch (MIDI number, increasing upward).
// Each note is a rectangle. The whole scene is small enough to redraw every
// frame, which keeps the playhead trivially in sync.

import { noteName, isBlackKey } from './model.js';

// PAD_LEFT and BEAT_WIDTH are exported so the grid's "Stretch" mode can share
// the roll's horizontal origin and scale, lining the two views up.
export const PAD_LEFT = 44;     // room for pitch labels
const PAD_TOP = 16;
const PAD_RIGHT = 24;
const PAD_BOTTOM = 16;
export const BEAT_WIDTH = 56;   // px per beat
const NOTE_HEIGHT = 18;  // px per semitone lane
const BEATS_PER_BAR = 4;

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
    this.setScore(score);
  }

  // Adopt a score and size the canvas to it: width follows the tune's length,
  // height follows its pitch range (padded a couple of semitones each side).
  setScore(score) {
    this.score = score;
    const { min, max } = score.pitchRange;
    this.minPitch = min - 2;
    this.maxPitch = max + 2;
    this.pitchCount = this.maxPitch - this.minPitch + 1;

    this.canvas.width = PAD_LEFT + score.lengthBeats * BEAT_WIDTH + PAD_RIGHT;
    this.canvas.height = PAD_TOP + this.pitchCount * NOTE_HEIGHT + PAD_BOTTOM;
  }

  xForBeat(beat) {
    return PAD_LEFT + beat * BEAT_WIDTH;
  }

  yForPitch(pitch) {
    return PAD_TOP + (this.maxPitch - pitch) * NOTE_HEIGHT;
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
    // non-active lanes). Plain pattern notes fall back to the default blue.
    for (const n of this.score.notes) {
      const x = this.xForBeat(n.start);
      const y = this.yForPitch(n.pitch);
      const wid = n.duration * BEAT_WIDTH;
      ctx.globalAlpha = n.alpha ?? 1;
      this._roundRect(ctx, x + 1, y + 1, wid - 2, NOTE_HEIGHT - 2, 4);
      ctx.fillStyle = n.color || COLORS.note;
      ctx.fill();
      ctx.strokeStyle = COLORS.noteEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
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

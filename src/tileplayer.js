// tileplayer.js — render the tile lanes and handle tile interaction.
//
// Both lanes share ONE horizontal time axis: a single scale (`this.ppb`,
// px/beat — adjustable in quantized notches via TILE_SCALES) and origin, one
// shared horizontal scroll, and tiles positioned by their start beat. So a tile
// that sounds at beat X sits at the same x in either lane. (Lanes are gapless
// for now.) Each lane has a sticky header block (color stripe + Mute/Solo) that
// stays pinned when scrolled. Thumbnails are a self-contained recap of each
// tile's contents, drawn at the current scale.

import { PALETTE, DURATIONS } from './grid.js';
import { LANE_COLORS } from './library.js';

// Quantized horizontal-scale notches (px per beat), smaller → bigger. The old
// fixed scale (6) sits near the low end; most of the ladder is zoom-in headroom.
export const TILE_SCALES = [4, 6, 9, 13, 19, 28, 40];
export const DEFAULT_SCALE_IDX = 1; // = 6 px/beat, the prior fixed scale

const TILE_H = 52;
const TRACK_H = 56;
const THUMB_PAD = 3;
const MIN_TRACK = 200;  // min track width so empty lanes still offer a drop area

export class TilePlayer {
  // cb: onSelect(id), onOpen(name, id), onDropAppend(laneId), onLaneClick(laneId),
  //     onMute(laneId), onSolo(laneId)
  constructor(containerEl, library, arrangement, cb) {
    this.container = containerEl;
    this.library = library;
    this.arrangement = arrangement;
    this.cb = cb;
    this.ppb = TILE_SCALES[DEFAULT_SCALE_IDX]; // current time scale; main sets it from saved UI
  }

  render() {
    const c = this.container;
    c.innerHTML = '';

    // Shared axis width = the longest lane, so both lanes scroll as one and the
    // shorter lane has an empty (still droppable) tail.
    const ppb = this.ppb;
    const maxBeats = Math.max(0, ...this.arrangement.lanes.map((l) => laneBeats(l, this.library)));
    const trackWidth = Math.max(Math.round(maxBeats * ppb), MIN_TRACK);

    this.arrangement.lanes.forEach((lane, li) => {
      const color = LANE_COLORS[li % LANE_COLORS.length];

      const laneEl = document.createElement('div');
      laneEl.className = 'lane' + (this.arrangement.activeLaneId === lane.id ? ' active-lane' : '');
      laneEl.dataset.lane = lane.id;

      // Sticky lane-header block (stays pinned during horizontal scroll, like the
      // old color tag): color stripe + Mute/Solo. Room is reserved here for future
      // per-lane controls (volume, name, add/remove, instrument). M and S are a
      // tri-state — one or the other or neither.
      const head = document.createElement('div');
      head.className = 'lane-head';
      const stripe = document.createElement('span');
      stripe.className = 'lane-stripe';
      stripe.style.background = color;
      const ms = document.createElement('div');
      ms.className = 'lane-ms';
      const muteBtn = laneToggle('M', 'mute', lane.mute, 'Mute this lane', () => this.cb.onMute(lane.id));
      const soloBtn = laneToggle('S', 'solo', lane.solo, 'Solo this lane', () => this.cb.onSolo(lane.id));
      ms.append(muteBtn, soloBtn);
      head.append(stripe, ms);

      const track = document.createElement('div');
      track.className = 'lane-track';
      track.dataset.lane = lane.id;
      track.style.width = `${trackWidth}px`;
      track.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        track.classList.add('drop');
      });
      track.addEventListener('dragleave', () => track.classList.remove('drop'));
      track.addEventListener('drop', (e) => {
        e.preventDefault();
        track.classList.remove('drop');
        this.cb.onDropAppend(lane.id);
      });
      track.addEventListener('click', (e) => { if (e.target === track) this.cb.onLaneClick(lane.id); });

      if (lane.tiles.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'tile-hint';
        hint.textContent = 'Drop a pattern here →';
        track.append(hint);
      } else {
        let t = 0; // start beat within this lane
        for (const tile of lane.tiles) {
          const pattern = this.library.patterns.get(tile.name);
          const beats = pattern ? patternBeats(pattern) : 0;
          const w = Math.max(2, Math.round(beats * ppb));

          const el = document.createElement('div');
          el.className = 'tile' + (this.arrangement.selectedId === tile.id ? ' selected' : '');
          el.dataset.id = tile.id;
          el.style.borderColor = color;
          el.style.left = `${Math.round(t * ppb)}px`;
          el.style.width = `${w}px`;

          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = TILE_H;
          cv.className = 'tile-thumb';
          if (pattern) drawThumb(cv, pattern, ppb);

          const name = document.createElement('span');
          name.className = 'tile-name';
          name.textContent = tile.name;

          el.append(cv, name);
          el.addEventListener('click', () => this.cb.onSelect(tile.id));
          el.addEventListener('dblclick', () => this.cb.onOpen(tile.name, tile.id));
          track.append(el);
          t += beats;
        }
      }

      laneEl.append(head, track);
      c.append(laneEl);
    });
  }

  // In-place class updates (no rebuild) so double-click survives selection.
  setSelected(id) {
    this.container.querySelectorAll('.tile').forEach((el) => {
      el.classList.toggle('selected', Number(el.dataset.id) === id);
    });
  }
  setActiveLane(laneId) {
    this.container.querySelectorAll('.lane').forEach((el) => {
      el.classList.toggle('active-lane', Number(el.dataset.lane) === laneId);
    });
  }
  // idSet: the tiles currently sounding (one per non-silent lane).
  setPlaying(idSet) {
    this.container.querySelectorAll('.tile').forEach((el) => {
      el.classList.toggle('playing', idSet.has(Number(el.dataset.id)));
    });
  }
}

// Total length of a pattern / a lane in beats (all columns, trailing rests included).
function patternBeats(pattern) {
  return pattern.columns.reduce((s, c) => s + DURATIONS[c.durIndex].beats, 0);
}
function laneBeats(lane, library) {
  return lane.tiles.reduce((s, t) => {
    const p = library.patterns.get(t.name);
    return s + (p ? patternBeats(p) : 0);
  }, 0);
}

// A small lane-header toggle (Mute / Solo). `kind` drives the active styling.
function laneToggle(text, kind, on, title, onClick) {
  const b = document.createElement('button');
  b.className = `lane-btn ${kind}` + (on ? ' active' : '');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

// Notes as little bars at their real beat-time, length = duration, colored by
// duration; rests omitted. (Unchanged look — a self-contained recap.) `ppb`
// matches the lane's current horizontal scale so the thumbnail lines up.
function drawThumb(cv, pattern, ppb) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.fillStyle = '#0d0f15';
  ctx.fillRect(0, 0, W, H);

  const notes = [];
  let t = 0, lo = Infinity, hi = -Infinity;
  for (const c of pattern.columns) {
    const beats = DURATIONS[c.durIndex].beats;
    if (!c.isRest) {
      notes.push({ start: t, beats, degree: c.degree, durIndex: c.durIndex });
      lo = Math.min(lo, c.degree);
      hi = Math.max(hi, c.degree);
    }
    t += beats;
  }
  if (notes.length === 0) return;

  const span = Math.max(1, hi - lo);
  const innerH = H - THUMB_PAD * 2 - 3;
  for (const n of notes) {
    const x = THUMB_PAD + n.start * ppb;
    const w = Math.max(2, n.beats * ppb - 1);
    const y = THUMB_PAD + (1 - (n.degree - lo) / span) * innerH;
    ctx.fillStyle = PALETTE[n.durIndex];
    ctx.fillRect(x, y, w, 3);
  }
}

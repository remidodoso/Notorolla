// tileplayer.js — render the tile lanes and handle tile interaction.
//
// The tile player holds two parallel lanes. Each tile is a mini pitch×time
// thumbnail (note bars colored by duration) bordered in its lane's color, with
// the pattern name bold in the middle. Click selects; double-click opens the
// pattern in the editor. Each lane is a drop target for the grid's grab handle.

import { PALETTE, DURATIONS } from './grid.js';
import { LANE_COLORS } from './library.js';

const THUMB_PPB = 6;   // px per beat — same scale across all tiles, so lengths compare
const THUMB_H = 52;
const THUMB_PAD = 3;
const THUMB_MIN_W = 30;

export class TilePlayer {
  // cb: onSelect(id), onOpen(name, id), onDropAppend(laneId), onLaneClick(laneId)
  constructor(containerEl, library, arrangement, cb) {
    this.container = containerEl;
    this.library = library;
    this.arrangement = arrangement;
    this.cb = cb;
  }

  render() {
    const c = this.container;
    c.innerHTML = '';
    this.arrangement.lanes.forEach((lane, li) => {
      const color = LANE_COLORS[li % LANE_COLORS.length];

      const laneEl = document.createElement('div');
      laneEl.className = 'lane' + (this.arrangement.activeLaneId === lane.id ? ' active-lane' : '');
      laneEl.dataset.lane = lane.id;

      const tag = document.createElement('span');
      tag.className = 'lane-tag';
      tag.style.background = color;

      const tilesEl = document.createElement('div');
      tilesEl.className = 'lane-tiles';
      tilesEl.dataset.lane = lane.id;
      tilesEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        tilesEl.classList.add('drop');
      });
      tilesEl.addEventListener('dragleave', () => tilesEl.classList.remove('drop'));
      tilesEl.addEventListener('drop', (e) => {
        e.preventDefault();
        tilesEl.classList.remove('drop');
        this.cb.onDropAppend(lane.id);
      });
      tilesEl.addEventListener('click', (e) => { if (e.target === tilesEl) this.cb.onLaneClick(lane.id); });

      if (lane.tiles.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'tile-hint';
        hint.textContent = 'Drop a pattern here →';
        tilesEl.append(hint);
      } else {
        for (const t of lane.tiles) {
          const pattern = this.library.patterns.get(t.name);
          const el = document.createElement('div');
          el.className = 'tile' + (this.arrangement.selectedId === t.id ? ' selected' : '');
          el.dataset.id = t.id;
          el.style.borderColor = color;

          const cv = document.createElement('canvas');
          cv.height = THUMB_H;
          cv.width = pattern ? thumbWidth(pattern) : THUMB_MIN_W;
          cv.className = 'tile-thumb';
          if (pattern) drawThumb(cv, pattern);

          const name = document.createElement('span');
          name.className = 'tile-name';
          name.textContent = t.name;

          el.append(cv, name);
          el.addEventListener('click', () => this.cb.onSelect(t.id));
          el.addEventListener('dblclick', () => this.cb.onOpen(t.name, t.id));
          tilesEl.append(el);
        }
      }

      laneEl.append(tag, tilesEl);
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

// Total length of a pattern in beats.
function patternBeats(pattern) {
  return pattern.columns.reduce((s, c) => s + DURATIONS[c.durIndex].beats, 0);
}

// Thumbnail width is proportional to the pattern's length.
function thumbWidth(pattern) {
  return Math.max(THUMB_MIN_W, Math.round(patternBeats(pattern) * THUMB_PPB) + THUMB_PAD * 2);
}

// Notes as little bars at their real beat-time, length = duration, colored by
// duration; rests omitted.
function drawThumb(cv, pattern) {
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
    const x = THUMB_PAD + n.start * THUMB_PPB;
    const w = Math.max(2, n.beats * THUMB_PPB - 1);
    const y = THUMB_PAD + (1 - (n.degree - lo) / span) * innerH;
    ctx.fillStyle = PALETTE[n.durIndex];
    ctx.fillRect(x, y, w, 3);
  }
}

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
import { laneColor, rippleInsertInto, rippleRemoveFrom } from './library.js';
import { makeKnob, PAN_MAP, GAIN_MAP } from './knob.js';
import { instrument } from './instrument.js';

// Quantized horizontal-scale notches (px per beat), smaller → bigger. The old
// fixed scale (6) sits near the low end; most of the ladder is zoom-in headroom.
export const TILE_SCALES = [4, 6, 9, 13, 19, 28, 40];
export const DEFAULT_SCALE_IDX = 1; // = 6 px/beat, the prior fixed scale

const TILE_H = 52;
const TRACK_H = 56;
const THUMB_PAD = 3;
const MIN_TRACK = 200;  // min track width so empty lanes still offer a drop area
const RULER_H = 20;     // beat-ruler height (px)
const GRAB = 8;         // px radius for grabbing a ruler marker handle

export class TilePlayer {
  // cb: onTileDown(id, pointerEvent), onOpen(name, id), onDropAppend(laneId),
  //     onLaneClick(laneId), onMute(laneId), onSolo(laneId), onAddLane(),
  //     onEdit(laneId) — open the instrument editor on that lane's patch,
  //     onMixStart(laneId) / onMixChange(laneId, key, value) / onMixEnd(laneId)
  //       — Pan/Gain knob drag (key is 'pan' | 'gain'); bracket = one undo step.
  //     onMarkerStart() / onMarkers(startBeat, endBeatOrNull) — play-region ruler:
  //       left-drag either handle (or empty = start), right-click clears the end
  //       (endBeat null = auto / end-of-last-tile).
  //     onDelay(laneId) — open the lane's delay editor modal.
  constructor(containerEl, library, arrangement, cb) {
    this.container = containerEl;
    this.library = library;
    this.arrangement = arrangement;
    this.cb = cb;
    this.ppb = TILE_SCALES[DEFAULT_SCALE_IDX]; // current time scale; main sets it from saved UI
    this.editLaneId = null; // lane whose patch the instrument editor is showing (lights its Edit)
  }

  // Render the lanes. Tiles are positioned by their explicit `start` beat (gaps
  // are silence). `preview` (a drag-in-progress descriptor
  // {id, fromLaneId, copy, toLaneId, start}) shows the *prospective* layout —
  // the dragged tile placed at the snapped beat with the rigid ripple applied —
  // without touching the committed arrangement that audio plays. `animate` FLIP-
  // slides tiles from their old to new positions so the ripple reads smoothly.
  render(preview = null, animate = false) {
    const c = this.container;
    const ppb = this.ppb;
    const before = animate ? this._captureRects() : null;
    c.innerHTML = '';

    // Prospective per-lane tile lists (committed, or transformed by the preview
    // via the exact same ripple ops the commit will use).
    const lanes = this._layout(preview);
    const maxBeats = Math.max(0, ...lanes.map((tiles) => tiles.reduce((m, t) => Math.max(m, t.start + this._len(t.name)), 0)));
    const trackWidth = Math.max(Math.round(maxBeats * ppb), MIN_TRACK);

    // Beat ruler on top (numbers + ticks) carrying the play-region markers.
    c.append(this._buildRuler(ppb, trackWidth, maxBeats));

    this.arrangement.lanes.forEach((lane, li) => {
      const color = laneColor(li);

      const laneEl = document.createElement('div');
      laneEl.className = 'lane' + (this.arrangement.activeLaneId === lane.id ? ' active-lane' : '');
      laneEl.dataset.lane = lane.id;

      // Sticky lane-header block (stays pinned during horizontal scroll, like the
      // old color tag): color stripe + an instrument block (the lane's instrument
      // name + Edit) + the Mute/Solo stack. The name reflects the lane's patch kind
      // (Vesperia / Zindel / …); Edit opens the editor on this lane's patch, where
      // the kind is changed. M and S are a tri-state — one or the other or neither.
      const head = document.createElement('div');
      head.className = 'lane-head';
      const stripe = document.createElement('span');
      stripe.className = 'lane-stripe';
      stripe.style.background = color;

      const info = document.createElement('div');
      info.className = 'lane-info';
      const instr = document.createElement('span');
      instr.className = 'lane-instr';
      const instrLabel = instrument(lane.patch && lane.patch.kind).label; // the lane's instrument kind
      instr.textContent = instrLabel;
      instr.title = `Instrument: ${instrLabel}`;
      const editBtn = document.createElement('button');
      editBtn.className = 'lane-edit' + (this.editLaneId === lane.id ? ' on' : '');
      editBtn.textContent = 'Edit';
      editBtn.title = 'Edit this lane’s instrument';
      editBtn.onclick = () => this.cb.onEdit(lane.id);
      info.append(instr, editBtn);

      // Delay: a "D" button (lit when the lane's delay is on) opening the editor
      // modal, between the instrument block and the Pan/Gain knobs.
      const delayBtn = document.createElement('button');
      delayBtn.className = 'lane-delay' + (lane.delay && lane.delay.on ? ' on' : '');
      delayBtn.textContent = 'D';
      delayBtn.title = 'Delay (per lane)';
      delayBtn.onclick = () => this.cb.onDelay(lane.id);

      // Mixer knobs: Pan on top, Gain below (click + vertical-drag, dbl-click to
      // reset). The widget updates itself live during a drag; main applies the
      // value to the lane bus and brackets the gesture into one undo step.
      const knobs = document.createElement('div');
      knobs.className = 'lane-knobs';
      makeKnob(knobs, {
        label: 'Pan', value: lane.pan, map: PAN_MAP, detents: [0], reset: 0,
        cb: {
          onStart: () => this.cb.onMixStart(lane.id),
          onInput: (v) => this.cb.onMixChange(lane.id, 'pan', v),
          onCommit: () => this.cb.onMixEnd(lane.id),
        },
      });
      makeKnob(knobs, {
        label: 'Gain', value: lane.gain, map: GAIN_MAP, detents: [1], reset: 1,
        cb: {
          onStart: () => this.cb.onMixStart(lane.id),
          onInput: (v) => this.cb.onMixChange(lane.id, 'gain', v),
          onCommit: () => this.cb.onMixEnd(lane.id),
        },
      });

      const ms = document.createElement('div');
      ms.className = 'lane-ms';
      const muteBtn = laneToggle('M', 'mute', lane.mute, 'Mute this lane', () => this.cb.onMute(lane.id));
      const soloBtn = laneToggle('S', 'solo', lane.solo, 'Solo this lane', () => this.cb.onSolo(lane.id));
      ms.append(muteBtn, soloBtn);
      head.append(stripe, info, delayBtn, knobs, ms);

      const track = document.createElement('div');
      track.className = 'lane-track';
      track.dataset.lane = lane.id;
      track.style.width = `${trackWidth}px`;
      track.style.backgroundImage = gridBackground(ppb); // 1/4-note + bar guidelines
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

      const tiles = lanes[li];
      if (tiles.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'tile-hint';
        hint.textContent = 'Drop a pattern here →';
        track.append(hint);
      } else {
        for (const t of tiles) {
          const w = Math.max(2, Math.round(this._len(t.name) * ppb));
          const left = Math.round(t.start * ppb);
          if (t.ghost) { // the dragged tile's prospective slot
            const slot = document.createElement('div');
            slot.className = 'tile-gap';
            slot.style.left = `${left}px`;
            slot.style.width = `${w}px`;
            track.append(slot);
            continue;
          }
          const pattern = this.library.patterns.get(t.name);

          const el = document.createElement('div');
          el.className = 'tile' + (this.arrangement.selectedId === t.id ? ' selected' : '');
          el.dataset.id = t.id;
          el.style.borderColor = color;
          el.style.left = `${left}px`;
          el.style.width = `${w}px`;

          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = TILE_H;
          cv.className = 'tile-thumb';
          if (pattern) drawThumb(cv, pattern, ppb);

          const name = document.createElement('span');
          name.className = 'tile-name';
          name.textContent = t.name;

          el.append(cv, name);
          el.addEventListener('pointerdown', (ev) => this.cb.onTileDown(t.id, ev));
          el.addEventListener('dblclick', () => this.cb.onOpen(t.name, t.id));
          track.append(el);
        }
      }

      const ph = document.createElement('div');
      ph.className = 'tile-playhead'; // hidden until setPlayhead positions it
      track.append(ph);

      // Faint loop-region guide lines (start green / end red) through every track.
      const rs = document.createElement('div');
      rs.className = 'tile-region-line start';
      rs.style.left = `${Math.round(this._playStart() * ppb)}px`;
      const re = document.createElement('div');
      re.className = 'tile-region-line end';
      re.style.left = `${Math.round(this._playEnd(maxBeats) * ppb)}px`;
      track.append(rs, re);

      laneEl.append(head, track);
      c.append(laneEl);
    });

    // A thin row at the bottom with a "+" on the left to add another lane.
    const addRow = document.createElement('div');
    addRow.className = 'lane-add';
    const addBtn = document.createElement('button');
    addBtn.className = 'lane-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add a lane';
    addBtn.addEventListener('click', () => this.cb.onAddLane());
    addRow.append(addBtn);
    c.append(addRow);

    if (before) this._flip(before);
  }

  // Position the per-track playhead lines at `beat` (track-relative, so they
  // scroll with the tiles and align across lanes). null hides them.
  setPlayhead(beat) {
    const phs = this.container.querySelectorAll('.tile-playhead');
    if (beat == null) { phs.forEach((el) => { el.style.display = 'none'; }); return; }
    const x = `${beat * this.ppb}px`;
    phs.forEach((el) => { el.style.left = x; el.style.display = 'block'; });
  }

  _len(name) {
    const p = this.library.patterns.get(name);
    return p ? patternBeats(p) : 0;
  }

  // Per-lane prospective tile lists (parallel to arrangement.lanes). With no
  // preview these are the committed tiles; with a preview the drag op is applied
  // to a throwaway copy using the SAME ripple primitives the commit uses, so the
  // preview is exactly what a drop would produce. The dragged tile is flagged
  // `ghost` so render draws it as a slot outline (the real tile is the cursor ghost).
  _layout(preview) {
    const lenOf = (name) => this._len(name);
    const clone = this.arrangement.lanes.map((l) => l.tiles.map((t) => ({ ...t })));
    if (preview) {
      const dragged = this.arrangement.allTiles().find((t) => t.id === preview.id);
      const laneIdx = (id) => this.arrangement.lanes.findIndex((l) => l.id === id);
      if (dragged) {
        if (preview.copy) {
          rippleInsertInto(clone[laneIdx(preview.toLaneId)], { id: '__drag__', name: dragged.name, start: 0, ghost: true }, preview.start, lenOf);
        } else {
          const from = clone[laneIdx(preview.fromLaneId)];
          const t = from.find((x) => x.id === preview.id);
          if (preview.fromLaneId === preview.toLaneId) {
            const i = from.indexOf(t); if (i >= 0) from.splice(i, 1); // lift out, no ripple
          } else {
            rippleRemoveFrom(from, t, lenOf); // moving out ripple-closes the source
          }
          t.ghost = true;
          rippleInsertInto(clone[laneIdx(preview.toLaneId)], t, preview.start, lenOf);
        }
      }
    }
    return clone;
  }

  // Hit-test a viewport point to a drop target {laneId, start}, where start is
  // the cursor beat snapped to the 1/4-note (integer-beat) grid. Left-clamping
  // and ripple are handled by the model on commit. null when not over a lane.
  dropTarget(clientX, clientY) {
    for (const laneEl of this.container.querySelectorAll('.lane')) {
      const r = laneEl.getBoundingClientRect();
      if (clientY < r.top || clientY > r.bottom) continue;
      const laneId = Number(laneEl.dataset.lane);
      const track = laneEl.querySelector('.lane-track');
      const localX = clientX - track.getBoundingClientRect().left;
      return { laneId, start: Math.max(0, Math.round(localX / this.ppb)) };
    }
    return null;
  }

  // A floating clone of a tile that follows the cursor during a drag.
  makeGhost(id) {
    const src = this.container.querySelector(`.tile[data-id="${id}"]`);
    const g = src ? src.cloneNode(true) : document.createElement('div');
    if (src) {
      // cloneNode doesn't copy canvas pixels — repaint the thumbnail onto the clone.
      const oc = src.querySelector('canvas');
      const gc = g.querySelector('canvas');
      if (oc && gc) gc.getContext('2d').drawImage(oc, 0, 0);
    }
    g.classList.remove('selected', 'playing');
    Object.assign(g.style, { position: 'fixed', zIndex: '1000', pointerEvents: 'none', opacity: '0.85', margin: '0', transition: 'none' });
    const badge = document.createElement('span');
    badge.className = 'ghost-badge';
    badge.textContent = '+';
    g.append(badge);
    document.body.append(g);
    this._ghost = g;
    this._ghostBadge = badge;
  }
  moveGhost(x, y, copy) {
    if (!this._ghost) return;
    this._ghost.style.left = `${x - 14}px`;
    this._ghost.style.top = `${y - 14}px`;
    this._ghostBadge.style.display = copy ? 'flex' : 'none';
  }
  clearGhost() {
    if (this._ghost) { this._ghost.remove(); this._ghost = null; this._ghostBadge = null; }
  }

  // FLIP: from a map of pre-render tile rects, slide each surviving tile from
  // where it was to where it now is.
  _captureRects() {
    const m = new Map();
    this.container.querySelectorAll('.tile').forEach((el) => m.set(el.dataset.id, el.getBoundingClientRect()));
    return m;
  }
  _flip(before) {
    this.container.querySelectorAll('.tile').forEach((el) => {
      const b = before.get(el.dataset.id);
      if (!b) return;
      const a = el.getBoundingClientRect();
      const dx = b.left - a.left;
      const dy = b.top - a.top;
      if (!dx && !dy) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 140ms ease';
        el.style.transform = '';
      });
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

  // Resolved play-region bounds in absolute beats (start always present; end
  // falls back to the content end when no marker is set).
  _playStart() { return Math.max(0, this.arrangement.playStart || 0); }
  _playEnd(contentEnd) {
    const e = this.arrangement.playEnd;
    return e == null ? contentEnd : Math.min(e, contentEnd);
  }

  // Build the sticky top ruler: a left spacer (matching the lane-head width) + a
  // scrolling track with beat ticks/numbers, the region tint, and the two markers.
  _buildRuler(ppb, trackWidth, contentEnd) {
    const row = document.createElement('div');
    row.className = 'ruler-row';
    const spacer = document.createElement('div');
    spacer.className = 'ruler-spacer';

    const track = document.createElement('div');
    track.className = 'ruler-track';
    track.style.width = `${trackWidth}px`;

    const cv = document.createElement('canvas');
    cv.width = trackWidth; cv.height = RULER_H; cv.className = 'ruler-canvas';
    drawRuler(cv, ppb);
    track.append(cv);

    const region = document.createElement('div'); region.className = 'ruler-region';
    const startH = document.createElement('div'); startH.className = 'ruler-mark start';
    const endH = document.createElement('div'); endH.className = 'ruler-mark end';
    track.append(region, startH, endH);
    const els = { region, startH, endH };
    this._positionRuler(els, ppb, this._playStart(), this.arrangement.playEnd, contentEnd);

    this._wireRulerDrag(track, ppb, contentEnd, els);
    row.append(spacer, track);
    return row;
  }

  // Place the region tint + the start/end handles. `endVal` null = auto (drawn at
  // the content end, in a dimmed style). Used both on render and live during a drag.
  _positionRuler(els, ppb, startBeat, endVal, contentEnd) {
    const end = endVal == null ? contentEnd : Math.min(endVal, contentEnd);
    els.startH.style.left = `${Math.round(startBeat * ppb)}px`;
    els.startH.title = `Play start — beat ${startBeat} (drag, or left-click the ruler)`;
    els.endH.style.left = `${Math.round(end * ppb)}px`;
    els.endH.classList.toggle('auto', endVal == null);
    els.endH.title = endVal == null
      ? 'Play end — auto (end of last tile); drag in to set'
      : `Play end — beat ${end}; drag to move, right-click to clear`;
    els.region.style.left = `${Math.round(startBeat * ppb)}px`;
    els.region.style.width = `${Math.max(0, Math.round((end - startBeat) * ppb))}px`;
  }

  // Left button moves a marker: grab whichever handle you click on (so either
  // marker can be dragged — drag the end handle in from the content end to set
  // an end), else the start marker for an empty-ruler click. Right button clears
  // the end marker (back to auto). Both snap to the beat grid. The drag moves the
  // handles live (no model write); on release main clamps, stores, and re-renders.
  _wireRulerDrag(track, ppb, contentEnd, els) {
    track.addEventListener('contextmenu', (e) => e.preventDefault());
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = track.getBoundingClientRect();
      let startBeat = this._playStart();
      let endVal = this.arrangement.playEnd; // null = auto

      // Right-click clears the end marker (revert to auto / end of last tile).
      if (e.button === 2) {
        this.cb.onMarkerStart();
        this.cb.onMarkers(startBeat, null);
        return;
      }

      // Pick the marker to drag: the handle under the cursor, else start.
      const localX = e.clientX - rect.left;
      const endX = (endVal == null ? contentEnd : Math.min(endVal, contentEnd)) * ppb;
      const which = Math.abs(localX - endX) <= GRAB && Math.abs(localX - endX) <= Math.abs(localX - startBeat * ppb)
        ? 'end' : 'start';
      this.cb.onMarkerStart();
      const beatAt = (x) => Math.max(0, Math.min(Math.round((x - rect.left) / ppb), contentEnd));
      const apply = (x) => {
        const b = beatAt(x);
        if (which === 'start') {
          const e2 = endVal == null ? contentEnd : endVal;
          startBeat = Math.max(0, Math.min(b, Math.max(0, e2 - 1)));
        } else if (b >= contentEnd) {
          endVal = null; // dragged to/past the content end → back to auto
        } else {
          endVal = Math.max(startBeat + 1, b);
        }
        this._positionRuler(els, ppb, startBeat, endVal, contentEnd);
      };
      apply(e.clientX);
      track.setPointerCapture(e.pointerId);
      const move = (ev) => apply(ev.clientX);
      const up = () => {
        track.releasePointerCapture(e.pointerId);
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        this.cb.onMarkers(startBeat, endVal);
      };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
    });
  }
}

// Total length of a pattern in beats (all columns, trailing rests included).
function patternBeats(pattern) {
  return pattern.columns.reduce((s, c) => s + DURATIONS[c.durIndex].beats, 0);
}

// Faint placement guidelines: a tick every beat (1/4 note), brighter every 4
// (a bar). Layered repeating gradients in track-pixel units, so they track the
// current zoom; the bar layer is listed first so it paints over the beat layer.
function gridBackground(ppb) {
  const beat = `repeating-linear-gradient(90deg, #161b27 0 1px, transparent 1px ${ppb}px)`;
  const bar = `repeating-linear-gradient(90deg, #283450 0 1px, transparent 1px ${4 * ppb}px)`;
  return `${bar}, ${beat}`;
}

// Draw the beat ruler: a minor tick every beat, a major tick + a 0-based beat
// number every `major` beats (widened from 4 at low zoom so labels don't collide).
function drawRuler(cv, ppb) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  let major = 4;
  while (major * ppb < 28) major *= 2; // keep ≥28px between numbers
  const beats = Math.ceil(W / ppb);
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (let b = 0; b <= beats; b++) {
    const x = Math.round(b * ppb) + 0.5;
    const isMajor = b % major === 0;
    ctx.strokeStyle = isMajor ? '#5a647c' : '#2b3140';
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x, H - (isMajor ? H * 0.55 : H * 0.3));
    ctx.stroke();
    if (isMajor) { ctx.fillStyle = '#8a93a3'; ctx.fillText(String(b), x + 2, 1); }
  }
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

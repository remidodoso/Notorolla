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
import { modsActive } from './mods.js';
import { transformKindLabel } from './transforms.js';

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
  // cb: onTileDown(id, pointerEvent), onOpen(name, id),
  //     onGridDragOver(laneId, startBeat) / onDropAt(laneId, startBeat) — the
  //       grid-pattern drag: live landing preview + position-honoring drop,
  //     onMarqueeStart() / onMarquee(laneId, b0, b1) / onMarqueeEnd(laneId,
  //       dragged) / onMarqueeCancel() — empty-space rubber-band selection
  //       (dragged=false on End = a plain empty-space click),
  //     onMute(laneId), onSolo(laneId), onAddLane(),
  //     onResetLane(laneId) — clear the lane (tiles + instrument), red "R",
  //     onEdit(laneId) — open the instrument editor on that lane's patch,
  //     onMixStart(laneId) / onMixChange(laneId, key, value) / onMixEnd(laneId)
  //       — Pan/Gain knob drag (key is 'pan' | 'gain'); bracket = one undo step.
  //     onMarkerStart() / onMarkers(startBeat, endBeatOrNull) — play-region ruler:
  //       left-drag either handle (or empty = start), right-click clears the end
  //       (endBeat null = auto / end-of-last-tile).
  //     onDelay(laneId) — open the lane's delay editor modal.
  //     onChorus(laneId) — open the lane's chorus editor modal.
  constructor(containerEl, library, arrangement, cb) {
    this.container = containerEl;
    this.library = library;
    this.arrangement = arrangement;
    this.cb = cb;
    this.ppb = TILE_SCALES[DEFAULT_SCALE_IDX]; // current time scale; main sets it from saved UI
    this.editLaneId = null; // lane whose patch the instrument editor is showing (lights its Edit)
    this.rippleMode = false; // Ripple toggle (main syncs from state): insert/delete ripple vs exact-overwrite
    this.rangeMode = null;  // armed range tool: null | 'insert' | 'clear' | 'delete' — the ruler draws a range instead of dragging markers
    // Per-frame element caches (rebuilt by every render; see there).
    this._tileEls = new Map();
    this._playheadEls = [];
    this._playingIds = new Set();
    this._phX = null;

    // Beat caret — MODAL:
    //  · hover (no tile in hand): the beat LEFT of the pointer (floor), on the
    //    hovered lane — a "land/paste here" cursor.
    //  · carry (a tile is being dragged): the caret stops tracking the pointer
    //    and marks the LEFT EDGE of the prospective landing instead (main feeds
    //    it via setCarryCaret whenever the drop preview changes).
    // Always live: delegated pointermove covers hover + brush sweeps; ruler
    // drags capture the pointer away from the lanes, which correctly hides it.
    // (HTML5 grid drags don't fire pointermove — dragover updates it instead.)
    this._caret = null;
    this._caretPos = null;
    this._carry = null; // {laneId, beat} while a tile is in hand
    this.container.addEventListener('pointermove', (e) => {
      if (this._carry) return; // carry mode owns the caret
      const track = e.target && e.target.closest ? e.target.closest('.lane-track') : null;
      if (track) this._updateCaret(track, e.clientX); else this.hideCaret();
    });
    this.container.addEventListener('pointerleave', () => { if (!this._carry) this.hideCaret(); });
  }

  // Hover mode: caret at the beat left of the pointer (floor — "nearest left").
  _updateCaret(track, clientX) {
    if (this._carry) return;
    const beat = Math.max(0, Math.floor((clientX - track.getBoundingClientRect().left) / this.ppb));
    this._placeCaret(track, beat);
  }

  // Carry mode: park the caret at the landing's left edge on the target lane
  // (laneId null = drop would cancel / drag ended → clear back to hover).
  // Idempotent and cheap — main calls it on every drag move; it also re-seats
  // the caret after the preview renders rebuilt the track it sat on.
  setCarryCaret(laneId, beat) {
    this._carry = laneId == null ? null : { laneId, beat };
    if (!this._carry) { this.hideCaret(); return; }
    const track = this.container.querySelector(`.lane-track[data-lane="${laneId}"]`);
    if (track) this._placeCaret(track, beat); else this.hideCaret();
  }

  // Shared placement: one caret element migrates between lanes; no-op while the
  // (lane, beat) pair is unchanged AND it's still attached (renders detach it).
  _placeCaret(track, beat) {
    const key = track.dataset.lane + ':' + beat;
    if (this._caretPos === key && this._caret && this._caret.parentNode === track) return;
    if (!this._caret) {
      this._caret = document.createElement('div');
      this._caret.className = 'beat-caret';
    }
    this._caret.style.left = `${beat * this.ppb}px`;
    track.append(this._caret);
    this._caretPos = key;
  }

  hideCaret() {
    if (this._caret) { this._caret.remove(); this._caretPos = null; }
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
    // Wiping innerHTML momentarily collapses the content, and the browser clamps
    // scrollLeft to 0 — every rebuild was silently rewinding the view to the
    // beginning. Save and restore the scroll across the rebuild.
    const keepX = c.scrollLeft, keepY = c.scrollTop;
    c.innerHTML = '';
    // Element caches for the per-frame playback updates (setPlaying/setPlayhead
    // run at 60 fps — they must not querySelectorAll a big DOM every frame).
    // Rebuilt here because the rebuild above just invalidated every element.
    this._tileEls = new Map();   // tile id -> .tile element
    this._playheadEls = [];      // one .tile-playhead per track
    this._playingIds = new Set(); // fresh DOM has no 'playing' classes
    this._phX = null;            // last applied playhead x (skip no-op writes)

    // Prospective per-lane tile lists (committed, or transformed by the preview
    // via the exact same ops the commit will use) + landing band / doomed tiles.
    const { laneTiles, landings, doomed } = this._layout(preview);
    let maxBeats = Math.max(0, ...laneTiles.map((tiles) => tiles.reduce((m, t) => Math.max(m, t.start + this._len(t.name)), 0)));
    for (const landing of landings) maxBeats = Math.max(maxBeats, landing.start + landing.len); // bands can extend past the last tile
    // Drop headroom: keep ~half a viewport of empty, droppable track past the
    // content — otherwise, once the lanes overflow the window, the last tile sits
    // flush against the right edge with nowhere to drop (or scroll to). The ruler
    // ticks span it (they draw over the full trackWidth); the region markers
    // don't (they clamp to the content end).
    const headroom = Math.max(8 * ppb, (this.container.clientWidth || 0) / 2);
    const trackWidth = Math.max(Math.round(maxBeats * ppb + headroom), MIN_TRACK);

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

      // Red "R": reset/clear this lane (tiles + instrument), far left of the head.
      const resetBtn = document.createElement('button');
      resetBtn.className = 'lane-reset';
      resetBtn.textContent = 'R';
      resetBtn.title = 'Reset this lane — clear its tiles and restore default instrument/mixer (undoable)';
      resetBtn.onclick = () => this.cb.onResetLane(lane.id);

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

      // Chorus + Delay: small "C"/"D" buttons (lit when on) opening their editor
      // modals, between the instrument block and the Pan/Gain knobs.
      const chorusBtn = document.createElement('button');
      chorusBtn.className = 'lane-chorus' + (lane.chorus && lane.chorus.on ? ' on' : '');
      chorusBtn.textContent = 'C';
      chorusBtn.title = 'Chorus (per lane)';
      chorusBtn.onclick = () => this.cb.onChorus(lane.id);
      const delayBtn = document.createElement('button');
      delayBtn.className = 'lane-delay' + (lane.delay && lane.delay.on ? ' on' : '');
      delayBtn.textContent = 'D';
      delayBtn.title = 'Delay (per lane)';
      delayBtn.onclick = () => this.cb.onDelay(lane.id);
      // Modulators: "M" chiclet (lit when the current instrument has an active
      // mod), left of the D/C stack, vertically centered.
      const modBtn = document.createElement('button');
      modBtn.className = 'lane-mod' + (modsActive(lane.modsByKind, lane.patch && lane.patch.kind) ? ' on' : '');
      modBtn.textContent = 'M';
      modBtn.title = 'Modulators (per lane) — slow parameter movement over playback';
      modBtn.onclick = () => this.cb.onMods(lane.id);

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
      // Stack the effect buttons in one narrow column: Delay on top, Chorus under;
      // the Mod chiclet sits alone to their left (centered until a sibling comes).
      const fx = document.createElement('div');
      fx.className = 'lane-fx';
      fx.append(delayBtn, chorusBtn);
      const modCol = document.createElement('div');
      modCol.className = 'lane-fx lane-modcol';
      modCol.append(modBtn);
      head.append(stripe, resetBtn, info, modCol, fx, knobs, ms);

      const track = document.createElement('div');
      track.className = 'lane-track';
      track.dataset.lane = lane.id;
      track.style.width = `${trackWidth}px`;
      track.style.backgroundImage = gridBackground(ppb); // 1/4-note + bar guidelines
      // Grid-drag (HTML5 dnd from the toolbar grab handle): position-honoring.
      // dragover reports the prospective {lane, beat} (UNROUNDED — main centers
      // the incoming tile on it, then rounds) so main can preview the landing
      // (same visuals as tile drags); drop places the same way.
      // No dragleave handling — main clears the preview on the handle's dragend.
      const dropBeat = (e) => (e.clientX - track.getBoundingClientRect().left) / this.ppb;
      track.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.edgeScroll(e.clientX, e.clientY); // dragover auto-repeats, so edge jumps work even held still
        this._updateCaret(track, e.clientX);   // pointermove doesn't fire during HTML5 drags
        this.cb.onGridDragOver(lane.id, dropBeat(e));
      });
      track.addEventListener('drop', (e) => {
        e.preventDefault();
        this.cb.onDropAt(lane.id, dropBeat(e));
      });
      // Empty-space pointerdown: a plain click activates the lane (and clears
      // the selection); dragging past the threshold rubber-band selects (the
      // marquee — clamped to THIS lane, the one-lane selection rule).
      track.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target !== track) return; // tiles own their pointerdown
        if (this.rangeMode) return; // an armed range tool owns gestures
        this._marquee(e, track, lane.id);
      });

      const tiles = laneTiles[li];
      if (tiles.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'tile-hint';
        hint.textContent = 'Drop a pattern here →';
        track.append(hint);
      } else {
        for (const t of tiles) {
          const w = Math.max(2, Math.round(this._len(t.name) * ppb));
          const left = Math.round(t.start * ppb);
          if (t.ghost) { // the dragged tile's prospective landing (ripple mode)
            const slot = document.createElement('div');
            slot.className = 'tile-gap';
            slot.style.left = `${left}px`;
            slot.style.width = `${w}px`;
            track.append(slot);
            continue;
          }
          const pattern = this.library.patterns.get(t.name);

          const el = document.createElement('div');
          el.className = 'tile' + (this.arrangement.selectedIds.has(t.id) ? ' selected' : '')
            + (doomed.has(t.id) ? ' doomed' : ''); // would be overwritten by the pending drop
          el.dataset.id = t.id;
          el.style.borderColor = color;
          el.style.left = `${left}px`;
          el.style.width = `${w}px`;

          // Thumbnail via the content-keyed cache: every tile referencing the
          // same pattern (at this zoom) shares ONE rendered image instead of
          // each redrawing its own canvas on every rebuild.
          if (pattern) el.style.backgroundImage = thumbImage(pattern, ppb);

          const name = document.createElement('span');
          name.className = 'tile-name';
          name.textContent = t.name;

          el.append(name);

          // Per-tile transforms: translucent swaths across the bottom mark a
          // transformed tile (the thumbnail itself stays the pattern's identity).
          // Stacked bottom-up in application order; each ~1/3 of the tile, packed
          // smaller (capped at 3/4 total) once there are 3+.
          const transforms = t.transforms || [];
          if (transforms.length) {
            const frac = Math.min(1 / 3, 0.75 / transforms.length);
            transforms.forEach((tf, idx) => {
              const { kind, label } = transformKindLabel(tf);
              const sw = document.createElement('div');
              sw.className = 'tile-xform xf-' + kind;
              sw.style.height = `${frac * 100}%`;
              sw.style.bottom = `${idx * frac * 100}%`;
              sw.textContent = label;
              el.append(sw);
            });
          }

          el.addEventListener('pointerdown', (ev) => this.cb.onTileDown(t.id, ev));
          el.addEventListener('dblclick', () => this.cb.onOpen(t.name, t.id));
          track.append(el);
          this._tileEls.set(t.id, el);
        }
      }

      // Non-ripple landing bands: filled highlights of the exact spans the drop
      // would occupy (ripple mode shows the in-flow `tile-gap` slot instead).
      // Several with a multi-selection drag — one per placed member.
      for (const landing of landings) {
        if (landing.laneIdx !== li) continue;
        const band = document.createElement('div');
        band.className = 'drop-band';
        band.style.left = `${Math.round(landing.start * ppb)}px`;
        band.style.width = `${Math.max(2, Math.round(landing.len * ppb))}px`;
        track.append(band);
      }


      const ph = document.createElement('div');
      ph.className = 'tile-playhead'; // hidden until setPlayhead positions it
      track.append(ph);
      this._playheadEls.push(ph);

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

    c.scrollLeft = keepX; c.scrollTop = keepY; // restore BEFORE the FLIP measures client rects

    if (this._playheadBeat != null) this.setPlayhead(this._playheadBeat); // re-place after the rebuild
    this.syncSelHandle(!!preview); // repeat handle (hidden while a drag preview is showing)

    if (before) this._flip(before);
  }

  // Position the per-track playhead lines at `beat` (track-relative, so they
  // scroll with the tiles and align across lanes). null hides them. The beat is
  // remembered so render() re-applies it — the parked playhead survives rebuilds.
  // Runs per animation frame: uses the render-time element cache and skips
  // writes when the pixel position hasn't changed.
  setPlayhead(beat) {
    this._playheadBeat = beat;
    const phs = this._playheadEls || [];
    if (beat == null) {
      if (this._phX !== null) { for (const el of phs) el.style.display = 'none'; this._phX = null; }
      return;
    }
    const x = `${beat * this.ppb}px`;
    if (x === this._phX) return;
    const show = this._phX === null; // display only needs setting on the first placement
    for (const el of phs) { el.style.left = x; if (show) el.style.display = 'block'; }
    this._phX = x;
  }

  _len(name) {
    const p = this.library.patterns.get(name);
    return p ? patternBeats(p) : 0;
  }

  // Per-lane prospective tile lists (parallel to arrangement.lanes) + preview
  // metadata. With no preview these are the committed tiles; with a preview the
  // drag op is applied to a throwaway copy using the SAME primitives the commit
  // uses, so the preview is exactly what a drop would produce. Preview kinds:
  // an internal move/copy ({id, fromLaneId, copy, toLaneId, start}) or an
  // EXTERNAL drag from the grid ({external, name, toLaneId, start}).
  // RIPPLE mode: the dragged tile is flagged `ghost` (drawn as the landing band
  // in flow, everything else rippled around it). NON-RIPPLE mode: nothing moves —
  // `landing` reports the exact band and `doomed` the tiles the drop would
  // remove (drawn dimmed + red).
  _layout(preview) {
    const lenOf = (name) => this._len(name);
    const clone = this.arrangement.lanes.map((l) => l.tiles.map((t) => ({ ...t })));
    const landings = [];
    const doomed = new Set();
    if (preview && preview.multi) {
      // Multi-selection drag: a rigid block translation, already PLANNED by main
      // (planSelectionDrop — the same plan the drop commits, so preview==commit).
      // Placed members become landing bands; a blocked MOVE member stays put in
      // the clone (that's what "ignore collisions" will really do); a blocked
      // copy simply doesn't appear.
      const ti = this.arrangement.lanes.findIndex((l) => l.id === preview.toLaneId);
      if (ti >= 0) {
        for (const m of preview.multi) {
          if (m.blocked) continue;
          if (!preview.copy) {
            const from = clone.find((tiles) => tiles.some((x) => x.id === m.id));
            if (from) from.splice(from.findIndex((x) => x.id === m.id), 1);
          }
          landings.push({ laneIdx: ti, start: m.start, len: lenOf(m.name) });
        }
      }
      return { laneTiles: clone, landings, doomed };
    }
    if (preview) {
      const laneIdx = (id) => this.arrangement.lanes.findIndex((l) => l.id === id);
      const dragged = preview.external ? null : this.arrangement.allTiles().find((t) => t.id === preview.id);
      const name = preview.external ? preview.name : dragged && dragged.name;
      const ti = laneIdx(preview.toLaneId);
      if (name != null && ti >= 0) {
        if (this.rippleMode) {
          if (preview.external || preview.copy) {
            rippleInsertInto(clone[ti], { id: '__drag__', name, start: 0, ghost: true }, preview.start, lenOf);
          } else {
            const from = clone[laneIdx(preview.fromLaneId)];
            const t = from.find((x) => x.id === preview.id);
            if (preview.fromLaneId === preview.toLaneId) {
              const i = from.indexOf(t); if (i >= 0) from.splice(i, 1); // lift out, no ripple
            } else {
              rippleRemoveFrom(from, t, lenOf); // moving out ripple-closes the source
            }
            t.ghost = true;
            rippleInsertInto(clone[ti], t, preview.start, lenOf);
          }
        } else {
          // Exact placement: nothing shifts. A move lifts the dragged tile
          // (its old spot empties); overlapped tiles in the target are doomed.
          if (!preview.external && !preview.copy) {
            const from = clone[laneIdx(preview.fromLaneId)];
            const i = from.findIndex((x) => x.id === preview.id);
            if (i >= 0) from.splice(i, 1);
          }
          const len = lenOf(name);
          for (const t of clone[ti]) {
            if (t.start < preview.start + len && preview.start < t.start + lenOf(t.name)) doomed.add(t.id);
          }
          landings.push({ laneIdx: ti, start: preview.start, len });
        }
      }
    }
    return { laneTiles: clone, landings, doomed };
  }

  // Hit-test a viewport point to a drop target {laneId, beat} (beat UNROUNDED —
  // the caller subtracts its grip, then rounds). Left-clamping and ripple are
  // handled by the model on commit. null when not over a lane.
  dropTarget(clientX, clientY) {
    for (const laneEl of this.container.querySelectorAll('.lane')) {
      const r = laneEl.getBoundingClientRect();
      if (clientY < r.top || clientY > r.bottom) continue;
      const laneId = Number(laneEl.dataset.lane);
      const track = laneEl.querySelector('.lane-track');
      const localX = clientX - track.getBoundingClientRect().left;
      // UNROUNDED cursor beat — the caller subtracts its grip, then rounds.
      return { laneId, beat: localX / this.ppb };
    }
    return null;
  }

  // The normalized grip for dragging tile `id` picked up at clientX: beats from
  // the tile's left edge to the hold point (see clampGrip for the rule).
  gripFor(id, clientX) {
    const tile = this.arrangement.allTiles().find((t) => t.id === id);
    const w = tile ? this._len(tile.name) * this.ppb : 0;
    const el = this.container.querySelector(`.tile[data-id="${id}"]`);
    const raw = el ? clientX - el.getBoundingClientRect().left : w / 2;
    return clampGrip(raw, w) / this.ppb;
  }

  // A floating clone of a tile that follows the cursor during a drag. `gripPx`
  // = where within the tile the cursor holds it (the normalized grip), so the
  // ghost hangs from the actual hold point — not from its top-left corner,
  // which read as "always holding the left edge" whatever the drop math did.
  makeGhost(id, gripPx = 14) {
    const src = this.container.querySelector(`.tile[data-id="${id}"]`);
    // cloneNode carries the thumbnail for free — it's a background-image style
    // now (the old per-tile canvas needed an explicit pixel repaint here).
    const g = src ? src.cloneNode(true) : document.createElement('div');
    g.classList.remove('selected', 'playing');
    Object.assign(g.style, { position: 'fixed', zIndex: '1000', pointerEvents: 'none', opacity: '0.85', margin: '0', transition: 'none' });
    const badge = document.createElement('span');
    badge.className = 'ghost-badge';
    badge.textContent = '+';
    g.append(badge);
    document.body.append(g);
    this._ghost = g;
    this._ghostBadge = badge;
    this._ghostGripX = gripPx;
  }
  moveGhost(x, y, copy) {
    if (!this._ghost) return;
    this._ghost.style.left = `${x - this._ghostGripX}px`;
    this._ghost.style.top = `${y - TILE_H / 2}px`; // vertically centered in hand
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

  // In-place selection sync (no rebuild): reads arrangement.selectedIds and
  // toggles the .selected class via the render-time element cache. Also keeps
  // the repeat fill handle glued to the selection block.
  syncSelection() {
    const sel = this.arrangement.selectedIds;
    for (const [id, el] of this._tileEls) el.classList.toggle('selected', sel.has(id));
    this.syncSelHandle();
  }

  // (Re)place the repeat FILL HANDLE at the right edge of the selection block
  // (Excel's fill-handle idiom — drag right to stamp repeats). Lives on the
  // selection's lane only; `hide` while a drag preview is showing. Called on
  // every selection sync and at the end of every render.
  syncSelHandle(hide = false) {
    if (this._selHandle) { this._selHandle.remove(); this._selHandle = null; }
    if (hide || !this.arrangement.selectedIds.size) return;
    const block = this.arrangement.selectionBlock((n) => this._len(n));
    if (!block) return;
    const track = this.container.querySelector(`.lane-track[data-lane="${block.lane.id}"]`);
    if (!track) return;
    const handle = document.createElement('div');
    handle.className = 'sel-handle';
    handle.title = 'Repeat — drag right to stamp copies of the selection';
    handle.style.left = `${Math.round(block.end * this.ppb)}px`;
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); // not an empty-space press — no marquee
      if (e.button === 0) this._repeatDrag(e, track, block.lane.id, block.start, block.end);
    });
    track.append(handle);
    this._selHandle = handle;
  }

  // Fill-handle drag: stamp whole-block repeats to the right. The count tracks
  // the pointer (pull back to shed copies, release to commit — k=0 is a no-op);
  // preview goes through cb.onRepeatPreview (main plans the collisions and we
  // draw stamp bands directly — NO re-render mid-gesture, so the handle under
  // the pointer survives its own drag); Esc cancels.
  _repeatDrag(e, track, laneId, blockStart, blockEnd) {
    const period = blockEnd - blockStart;
    if (period <= 0) return;
    const handle = e.currentTarget;
    let k = 0;
    handle.setPointerCapture(e.pointerId);
    const beatAt = (x) => (x - track.getBoundingClientRect().left) / this.ppb;
    const move = (ev) => {
      this.edgeScroll(ev.clientX, ev.clientY);
      // Copy r spans [end+(r−1)·period, end+r·period): count = the copy the
      // pointer is inside (a whisker of slack so the exact seam doesn't jitter).
      const nk = Math.max(0, Math.ceil((beatAt(ev.clientX) - blockEnd) / period - 0.02));
      if (nk !== k) { k = nk; this.cb.onRepeatPreview(laneId, k); }
    };
    const cleanup = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', onKey, true);
    };
    const up = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      cleanup();
      this.cb.onRepeatCommit(laneId, k);
    };
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopPropagation();
      try { handle.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      cleanup();
      this.cb.onRepeatCancel();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    window.addEventListener('keydown', onKey, true); // capture: beats the global Esc
  }

  // Live repeat-preview bands, drawn straight into the lane track (no render).
  showStamps(laneId, stamps) {
    this.clearStamps();
    const track = this.container.querySelector(`.lane-track[data-lane="${laneId}"]`);
    if (!track) return;
    this._stampEls = stamps.map((s) => {
      const band = document.createElement('div');
      band.className = 'drop-band';
      band.style.left = `${Math.round(s.start * this.ppb)}px`;
      band.style.width = `${Math.max(2, Math.round(this._len(s.name) * this.ppb))}px`;
      track.append(band);
      return band;
    });
  }
  clearStamps() {
    if (this._stampEls) { for (const el of this._stampEls) el.remove(); this._stampEls = null; }
  }
  setActiveLane(laneId) {
    this.container.querySelectorAll('.lane').forEach((el) => {
      el.classList.toggle('active-lane', Number(el.dataset.lane) === laneId);
    });
  }
  // idSet: the tiles currently sounding (one per non-silent lane). Runs per
  // animation frame — diffs against the previous set and touches only the tiles
  // whose state changed (usually none), via the render-time element cache.
  setPlaying(idSet) {
    const prev = this._playingIds || new Set();
    const els = this._tileEls || new Map();
    for (const id of prev) {
      if (!idSet.has(id)) { const el = els.get(id); if (el) el.classList.remove('playing'); }
    }
    for (const id of idSet) {
      if (!prev.has(id)) { const el = els.get(id); if (el) el.classList.add('playing'); }
    }
    this._playingIds = new Set(idSet);
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

    // Ticks are a small repeating background tile (one major period wide) —
    // NOT a canvas spanning the whole track, which on long projects × high zoom
    // was a huge layer that made scrolling crawl. Numbers are sparse spans.
    track.style.backgroundImage = rulerBackground(ppb);
    if (this.rangeMode) track.classList.add('range-armed'); // "draw your range HERE" glow
    const major = rulerMajor(ppb);
    for (let b = 0; b * ppb <= trackWidth; b += major) {
      const n = document.createElement('span');
      n.className = 'ruler-num';
      n.style.left = `${Math.round(b * ppb) + 2}px`;
      n.textContent = String(b);
      track.append(n);
    }

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
      // An armed range tool takes over the ruler: left-drag draws the range
      // (markers are inert until it's disarmed).
      if (this.rangeMode && e.button === 0) { this._rangeDrag(e, track, ppb, contentEnd); return; }
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
      // Fresh rect per call: edge-scroll jumps move the track (it scrolls with
      // the content), so a rect cached at pointerdown would misplace the beat.
      const beatAt = (x) => Math.max(0, Math.min(Math.round((x - track.getBoundingClientRect().left) / ppb), contentEnd));
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
      const move = (ev) => { this.edgeScroll(ev.clientX, ev.clientY); apply(ev.clientX); };
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

  // Draw a range on the ruler for the armed range tool: beat-snapped, live
  // color-keyed bands on the ruler AND down through every lane track, with
  // main fed each change (onRangePreview) so it can light the affected tiles.
  // Release commits (onRangeCommit — an empty range is main's cue to cancel);
  // Esc mid-drag cancels (onRangeCancel). shiftKey at release = stay armed,
  // matching the brushes.
  _rangeDrag(e, track, ppb, contentEnd) {
    const kind = this.rangeMode;
    // Fresh rect per call — edge-scroll jumps move the track under the pointer.
    const beatAt = (x) => Math.max(0, Math.min(Math.round((x - track.getBoundingClientRect().left) / ppb), contentEnd));
    const anchor = beatAt(e.clientX);
    let s = anchor, e2 = anchor;

    const mkBand = (parent) => {
      const d = document.createElement('div');
      d.className = 'range-band ' + kind;
      parent.append(d);
      return d;
    };
    const bands = [mkBand(track), ...[...this.container.querySelectorAll('.lane-track')].map(mkBand)];

    const apply = (x) => {
      const b = beatAt(x);
      s = Math.min(anchor, b); e2 = Math.max(anchor, b);
      for (const band of bands) {
        band.style.left = `${s * ppb}px`;
        band.style.width = `${Math.max(2, (e2 - s) * ppb)}px`;
      }
      this.cb.onRangePreview(kind, s, e2);
    };
    apply(e.clientX);

    track.setPointerCapture(e.pointerId);
    const cleanup = () => {
      for (const band of bands) band.remove();
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', onKey, true);
    };
    const move = (ev) => { this.edgeScroll(ev.clientX, ev.clientY); apply(ev.clientX); };
    const up = (ev) => {
      track.releasePointerCapture(e.pointerId);
      cleanup();
      this.cb.onRangeCommit(kind, s, e2, ev.shiftKey);
    };
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopPropagation();
      try { track.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      cleanup();
      this.cb.onRangeCancel();
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    window.addEventListener('keydown', onKey, true); // capture: beats the global Esc
  }

  // Rubber-band selection on one lane (pointerdown on empty track space).
  // Selects LIVE as the band grows — any intersecting tile, Cubase-like — via
  // cb.onMarquee(laneId, b0, b1) in fractional beats; content-anchored, so
  // edge-scroll jumps don't skew it. A no-drag release is an empty-space click
  // (cb.onMarqueeEnd with dragged=false → activate lane + clear selection);
  // Esc cancels (cb.onMarqueeCancel → main restores the prior selection).
  _marquee(e, track, laneId) {
    const thresh = 4; // px before a press becomes a drag
    const startClientX = e.clientX;
    const anchorPx = e.clientX - track.getBoundingClientRect().left; // content px — scroll-stable
    let dragged = false;
    let band = null;
    this.cb.onMarqueeStart();
    track.setPointerCapture(e.pointerId);

    const apply = (ev) => {
      const cur = ev.clientX - track.getBoundingClientRect().left;
      const lo = Math.max(0, Math.min(anchorPx, cur));
      const hi = Math.max(anchorPx, cur);
      if (!band) {
        band = document.createElement('div');
        band.className = 'marquee-band';
        track.append(band);
      }
      band.style.left = `${lo}px`;
      band.style.width = `${Math.max(1, hi - lo)}px`;
      this.cb.onMarquee(laneId, lo / this.ppb, hi / this.ppb);
    };
    const cleanup = () => {
      if (band) band.remove();
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', onKey, true);
    };
    const move = (ev) => {
      if (!dragged && Math.abs(ev.clientX - startClientX) < thresh) return;
      dragged = true;
      this.edgeScroll(ev.clientX, ev.clientY);
      apply(ev);
    };
    const up = () => {
      track.releasePointerCapture(e.pointerId);
      cleanup();
      this.cb.onMarqueeEnd(laneId, dragged);
    };
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopPropagation();
      try { track.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      cleanup();
      this.cb.onMarqueeCancel();
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    window.addEventListener('keydown', onKey, true); // capture: beats the global Esc
  }

  // Edge auto-scroll for drags and brush sweeps: when the pointer sits within
  // `zone` px of either side of the visible tracks (and vertically over the
  // player), jump the view half a page that way — page jumps on a time gate,
  // not a per-frame creep (same rationale as the playback follow). Driven by
  // the caller's move events, so holding perfectly still stalls between jumps;
  // in practice hand jitter (and HTML5 dragover's auto-repeat) keeps it going.
  // Returns true when it jumped, so gesture code can avoid "painting through"
  // the content that streamed past.
  edgeScroll(clientX, clientY) {
    const el = this.container;
    const r = el.getBoundingClientRect();
    if (clientY < r.top || clientY > r.bottom) return false;
    const now = performance.now();
    if (this._edgeScrollAt && now - this._edgeScrollAt < 350) return false;
    const head = el.querySelector('.lane-head');
    const headW = head ? head.offsetWidth : 0;
    const zone = 48;
    const page = Math.max(120, (el.clientWidth - headW) / 2);
    if (clientX > r.right - zone) el.scrollLeft += page;
    else if (clientX < r.left + headW + zone) el.scrollLeft = Math.max(0, el.scrollLeft - page);
    else return false;
    this._edgeScrollAt = now;
    return true;
  }

  // Arm/disarm the ruler's range mode (called by main): flag + live affordance
  // on the current DOM (renders while armed re-apply it in _buildRuler).
  setRangeMode(kind) {
    this.rangeMode = kind;
    const track = this.container.querySelector('.ruler-track');
    if (track) track.classList.toggle('range-armed', !!kind);
  }

  // Light the tiles a pending range op would touch (via the render-time element
  // cache): `doomed` = will be removed (dim + red), `shifted` = will move
  // (blue outline). Pass nulls to clear.
  setRangePreview(doomed, shifted) {
    for (const [id, el] of this._tileEls) {
      el.classList.toggle('doomed', !!doomed && doomed.has(id));
      el.classList.toggle('range-shift', !!shifted && shifted.has(id));
    }
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

// Major-tick period for the ruler: every 4 beats, widened at low zoom so the
// numbers don't collide.
function rulerMajor(ppb) {
  let major = 4;
  while (major * ppb < 28) major *= 2; // keep ≥28px between numbers
  return major;
}

// One major period of ruler ticks (major at 0, minors every beat) rendered to a
// tiny canvas and served as a repeat-x CSS background — cached per zoom, since
// every render at a given ppb wants the identical tile. All TILE_SCALES are
// integers, so major*ppb is a whole pixel count and the repeat never drifts.
const rulerTiles = new Map(); // ppb -> css url()
function rulerBackground(ppb) {
  let url = rulerTiles.get(ppb);
  if (!url) {
    const major = rulerMajor(ppb);
    const cv = document.createElement('canvas');
    cv.width = major * ppb;
    cv.height = RULER_H;
    const ctx = cv.getContext('2d');
    for (let b = 0; b < major; b++) {
      const x = Math.round(b * ppb) + 0.5;
      const isMajor = b === 0;
      ctx.strokeStyle = isMajor ? '#5a647c' : '#2b3140';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, RULER_H - (isMajor ? RULER_H * 0.55 : RULER_H * 0.3));
      ctx.stroke();
    }
    url = `url(${cv.toDataURL()})`;
    rulerTiles.set(ppb, url);
  }
  return url;
}

// The normalized-grip rule (user's spec): a dragged tile is held where grabbed,
// clamped to at least half the tile HEIGHT from either edge — so a square /
// vertical-aspect tile (width ≤ height) is always held by its CENTER (the two
// bounds collapse to w/2), while a long skinny tile may be held toward an edge
// but never by its very corner. Pure (px in → px out); exported for tests.
export function clampGrip(rawPx, wPx, halfH = TILE_H / 2) {
  return Math.min(Math.max(rawPx, Math.min(halfH, wPx / 2)), Math.max(wPx - halfH, wPx / 2));
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

// Thumbnail cache: one rendered image per (pattern content, zoom), served as a
// CSS background url. Keyed by the fields the drawing actually uses (rest /
// degree / duration per column), so editing a pattern naturally mints a new key
// and every stale entry just stops being referenced. Bounded by a dumb full
// reset — regeneration is cheap and rare.
const thumbCache = new Map(); // key -> css url()
const THUMB_CACHE_MAX = 300;
function thumbImage(pattern, ppb) {
  const key = ppb + '|' + pattern.columns.map((c) => (c.isRest ? 'r' : c.degree) + ':' + c.durIndex).join(',');
  let url = thumbCache.get(key);
  if (!url) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(patternBeats(pattern) * ppb));
    cv.height = TILE_H;
    drawThumb(cv, pattern, ppb);
    if (thumbCache.size >= THUMB_CACHE_MAX) thumbCache.clear();
    url = `url(${cv.toDataURL()})`;
    thumbCache.set(key, url);
  }
  return url;
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

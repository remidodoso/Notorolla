// library.js — the pattern registry and the tile arrangement.
//
// Patterns are first-class, named objects (A, A1, A2, …). The editor edits one
// "current" pattern by reference; tiles in the arrangement reference patterns by
// name, so editing a pattern updates every tile that points at it.
//
// Floating = a pattern with no tile references (unsaved work-in-progress). The
// invariant we keep: at most ONE floating pattern exists at a time — it's either
// the current (shown) one, or the single "parked" one (surfaced on the New
// button as Restore). That makes "never silently lose a pattern" true without
// letting unsaved patterns pile up invisibly.

import { Pattern } from './grid.js';
import { defaultPatch, normalizePatch } from './instrument.js';

export class PatternLibrary {
  // isReferenced(name) -> bool, supplied by the arrangement.
  constructor(isReferenced) {
    this.isReferenced = isReferenced;
    this.patterns = new Map(); // name -> Pattern
    this.counter = 0;          // mints A, A1, A2, …
    this.currentName = null;
    this.parkedName = null;
  }

  current() { return this.patterns.get(this.currentName); }

  _mint() {
    let name;
    do {
      name = this.counter === 0 ? 'A' : 'A' + this.counter;
      this.counter += 1;
    } while (this.patterns.has(name));
    return name;
  }

  _add(p) { this.patterns.set(p.name, p); return p; }

  // Create the very first pattern (a blank A) as current.
  seed() {
    const p = this._add(Pattern.initial(this._mint()));
    this.currentName = p.name;
    return p;
  }

  isFloating(name) { return !!name && !this.isReferenced(name); }

  _currentIsFloatingNonEmpty() {
    const c = this.current();
    return !!c && this.isFloating(c.name) && !c.isEmpty();
  }

  // New (a blank) is only allowed when nothing's parked and the current pattern
  // is safe (referenced) or empty — i.e. it won't strand work or pile up blanks.
  canCreate() { return !this.parkedName && !this._currentIsFloatingNonEmpty(); }

  // Clone is allowed whenever the current pattern is safe to leave (referenced or
  // empty) — even with something parked, since cloning a referenced pattern is a
  // normal, non-stranding action.
  canClone() { return !!this.current() && !this._currentIsFloatingNonEmpty(); }

  // Leave the current pattern: park it if it's a non-empty float (the parked
  // slot is guaranteed free by the invariant), drop it if it's an empty float,
  // otherwise (referenced) just leave it in the registry.
  _leaveCurrent() {
    const c = this.current();
    if (!c) return;
    if (this.isFloating(c.name)) {
      if (c.isEmpty()) this.patterns.delete(c.name);
      else this.parkedName = c.name;
    }
  }

  newPattern() {
    if (!this.canCreate()) return null;
    this._leaveCurrent();
    const p = this._add(Pattern.initial(this._mint()));
    this.currentName = p.name;
    return p;
  }

  clone() {
    if (!this.canClone()) return null;
    const src = this.current();
    this._leaveCurrent();
    const p = this._add(src.clone(this._mint()));
    this.currentName = p.name;
    return p;
  }

  // Double-click a tile: focus the editor on that (referenced) pattern.
  open(name) {
    if (name === this.currentName) return this.current();
    this._leaveCurrent();
    this.currentName = name;
    return this.current();
  }

  // Bring the parked pattern back to the editor (a swap — leaving the current
  // one, which the invariant guarantees is referenced/empty here).
  restore() {
    if (!this.parkedName) return null;
    const name = this.parkedName;
    this.parkedName = null;
    this._leaveCurrent();
    this.currentName = name;
    return this.current();
  }

  // Empty the current pattern in place (so referencing tiles empty too).
  clearCurrent() {
    const c = this.current();
    c.columns = Pattern.initial(c.name).columns;
  }

  toJSON() {
    return {
      patterns: [...this.patterns.values()].map((p) => ({
        name: p.name, cols: p.toJSON(), tuning: p.tuningId, scale: p.scaleId, root: p.root,
      })),
      counter: this.counter,
      currentName: this.currentName,
      parkedName: this.parkedName,
    };
  }

  static fromJSON(o, isReferenced) {
    const lib = new PatternLibrary(isReferenced);
    // tuning/scale/root are optional — older patterns default to 12-ET chromatic.
    for (const { name, cols, tuning, scale, root } of o.patterns) {
      const p = Pattern.fromJSON(cols, name);
      if (tuning) p.tuningId = tuning;
      if (scale) p.scaleId = scale;
      if (root != null) p.root = root;
      lib.patterns.set(name, p);
    }
    lib.counter = o.counter;
    lib.currentName = o.currentName;
    lib.parkedName = o.parkedName;
    return lib;
  }
}

// One color per lane (by position). Used for the roll notes and tile symbology.
// The first two are the established blue/orange; beyond that, hues are auto-
// assigned by golden-angle rotation (well-spread, unlimited lanes).
export const LANE_COLORS = ['#5aa9ff', '#e8a04e'];
export function laneColor(i) {
  if (i < LANE_COLORS.length) return LANE_COLORS[i];
  const hue = Math.round((150 + (i - LANE_COLORS.length) * 137.508) % 360);
  return `hsl(${hue}, 60%, 64%)`;
}

// The arrangement is a set of parallel lanes. Each lane is an ordered list of
// tiles (references to patterns by name); lanes play simultaneously from t=0.
// Tile ids are globally unique across lanes, so selection/deletion is flat.
export class Arrangement {
  constructor(lanes) {
    this.lanes = lanes || [newLane(0), newLane(1)];
    this.selectedId = null;
    this.activeLaneId = this.lanes[0].id;
    this.seq = 0; // global tile-id counter
    // Play/loop region (beats). The start marker is always present (defaults to
    // 0); the end marker is optional — null means "the end of the last tile", so
    // it follows the arrangement as it grows. Play AND Loop honor [start, end).
    this.playStart = 0;
    this.playEnd = null;
  }

  lane(id) { return this.lanes.find((l) => l.id === id); }
  laneOfTile(id) { return this.lanes.find((l) => l.tiles.some((t) => t.id === id)); }
  allTiles() { return this.lanes.flatMap((l) => l.tiles); }

  // Append a new empty lane (id = one past the current max). 2 lanes is the
  // factory default; more are added on request. Returns the new lane.
  addLane() {
    const id = this.lanes.reduce((m, l) => Math.max(m, l.id), -1) + 1;
    const lane = newLane(id);
    this.lanes.push(lane);
    return lane;
  }

  // Mute and Solo are a per-lane tri-state {none | muted | soloed}: turning one
  // on clears the other for that lane. Across lanes there's no exclusivity (mute
  // both, solo both, etc. are all fine). Both persist with the project so it
  // reloads sounding exactly as saved.
  toggleMute(id) { const l = this.lane(id); if (!l) return; l.mute = !l.mute; if (l.mute) l.solo = false; }
  toggleSolo(id) { const l = this.lane(id); if (!l) return; l.solo = !l.solo; if (l.solo) l.mute = false; }

  // The set of lane ids that actually sound: solo wins globally — if any lane is
  // soloed, only soloed lanes sound; otherwise every non-muted lane sounds.
  audibleLaneIds() {
    const soloed = this.lanes.filter((l) => l.solo);
    const src = soloed.length ? soloed : this.lanes.filter((l) => !l.mute);
    return new Set(src.map((l) => l.id));
  }

  // Add a new tile flush at the end of a lane: as far left as possible — right
  // after the last tile (snapped up to the next beat), or beat 0 if empty.
  // `lenOf(name)` -> tile length in beats.
  append(laneId, name, lenOf) {
    const lane = this.lane(laneId);
    const end = lane.tiles.reduce((m, t) => Math.max(m, t.start + lenOf(t.name)), 0);
    const tile = { id: ++this.seq, name, start: Math.ceil(end - 1e-6) };
    lane.tiles.push(tile);
    sortLane(lane);
    return tile;
  }

  // Delete a tile, rigid-rippling everything to its right left by its length.
  removeRipple(id, lenOf) {
    const lane = this.laneOfTile(id);
    if (!lane) return;
    rippleRemoveFrom(lane.tiles, lane.tiles.find((t) => t.id === id), lenOf);
    if (this.selectedId === id) this.selectedId = null;
  }

  // Move a tile to beat `start` in `toLaneId`, then ripple-open the target (right
  // side right by just enough to make room — 0 if it already fits). Repositioning
  // *within* a lane just lifts the tile out (leaving its gap); moving *out* to a
  // different lane ripple-closes the source (right side left by the tile's length).
  // Keeps the tile's id so selection follows.
  moveTile(id, toLaneId, start, lenOf) {
    const from = this.laneOfTile(id);
    const to = this.lane(toLaneId);
    if (!from || !to) return id;
    const tile = from.tiles.find((t) => t.id === id);
    if (from === to) {
      const i = from.tiles.indexOf(tile);
      if (i >= 0) from.tiles.splice(i, 1); // lift out, no ripple
    } else {
      rippleRemoveFrom(from.tiles, tile, lenOf); // moving out ripple-closes the source
    }
    rippleInsertInto(to.tiles, tile, start, lenOf);
    return id;
  }

  // Insert a shallow copy (new id, same pattern reference) at beat `start` in
  // `toLaneId`, ripple-opening the target. The source is untouched. Returns the
  // new tile id.
  copyTile(id, toLaneId, start, lenOf) {
    const src = this.allTiles().find((t) => t.id === id);
    const to = this.lane(toLaneId);
    if (!src || !to) return null;
    const tile = { id: ++this.seq, name: src.name, start: 0 };
    rippleInsertInto(to.tiles, tile, start, lenOf);
    return tile.id;
  }

  referencedNames() { return new Set(this.allTiles().map((t) => t.name)); }

  toJSON() {
    return {
      lanes: this.lanes.map((l) => ({
        id: l.id,
        tiles: l.tiles.map((t) => ({ id: t.id, name: t.name, start: t.start })),
        mute: !!l.mute, solo: !!l.solo,
        gain: l.gain, pan: l.pan, // mixer: linear volume (1 = 0 dB), pan −1..+1
        patch: l.patch, // the lane's instrument settings
      })),
      seq: this.seq,
      activeLaneId: this.activeLaneId,
      playStart: this.playStart,
      playEnd: this.playEnd,
    };
  }

  static fromJSON(o) {
    // mute/solo, tile.start and patch are optional — older saves (and the legacy
    // single-lane format, migrated into lane 0) default to none / undefined start
    // (the loader derives gapless starts via ensureTileStarts) / the factory
    // patch (the caller may re-seed patch-less lanes from the old global patch).
    const tile = (t) => ({ id: t.id, name: t.name, start: t.start });
    const lane = (l) => ({
      id: l.id, tiles: l.tiles.map(tile), mute: !!l.mute, solo: !!l.solo,
      gain: l.gain == null ? 1 : l.gain, pan: l.pan == null ? 0 : l.pan,
      patch: normalizePatch(l.patch),
    });
    const lanes = o.lanes
      ? o.lanes.map(lane)
      : [{ id: 0, tiles: (o.tiles || []).map(tile), mute: false, solo: false, gain: 1, pan: 0, patch: defaultPatch() }, newLane(1)];
    const a = new Arrangement(lanes);
    a.seq = o.seq || 0;
    a.activeLaneId = o.activeLaneId ?? lanes[0].id;
    a.playStart = o.playStart == null ? 0 : o.playStart; // region markers (optional in older saves)
    a.playEnd = o.playEnd == null ? null : o.playEnd;
    return a;
  }
}

function newLane(id) { return { id, tiles: [], mute: false, solo: false, gain: 1, pan: 0, patch: defaultPatch() }; }
function sortLane(lane) { lane.tiles.sort((a, b) => a.start - b.start); }

// --- tile positioning: rigid ripple --------------------------------------
//
// Tiles carry an explicit `start` (beats). These mutate one lane's `tiles`
// array (the caller supplies `lenOf(name)` -> length in beats). They're exported
// so the drag *preview* can run the exact same logic on a throwaway copy of the
// lanes, guaranteeing the preview matches the committed result.

// Insert `tile` at beat `start`, clamped flush against the nearest tile on its
// left (can't overlap it). Tiles to the right shift right by ONE rigid amount —
// just enough to clear the inserted tile (0 if it already fits) — preserving the
// gaps among them. `tile` must not already be in `tiles`.
export function rippleInsertInto(tiles, tile, start, lenOf) {
  const len = lenOf(tile.name);
  const leftEnd = tiles.reduce((m, t) => (t.start < start ? Math.max(m, t.start + lenOf(t.name)) : m), 0);
  const s = Math.max(start, leftEnd, 0);
  const right = tiles.filter((t) => t.start >= start);
  if (right.length) {
    const firstRight = Math.min(...right.map((t) => t.start));
    const delta = Math.max(0, s + len - firstRight);
    if (delta) right.forEach((t) => { t.start += delta; });
  }
  tile.start = s;
  tiles.push(tile);
  tiles.sort((a, b) => a.start - b.start);
}

// Remove `tile`, rigid-rippling everything to its right left by its length
// (preserving the gaps among those tiles).
export function rippleRemoveFrom(tiles, tile, lenOf) {
  if (!tile) return;
  const len = lenOf(tile.name);
  const i = tiles.indexOf(tile);
  if (i >= 0) tiles.splice(i, 1);
  for (const t of tiles) if (t.start > tile.start) t.start -= len;
}

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

  // New/Clone are only allowed when nothing's parked and the current pattern is
  // safe (referenced) or empty — i.e. making a new one won't strand work.
  canCreate() { return !this.parkedName && !this._currentIsFloatingNonEmpty(); }

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
    if (!this.canCreate()) return null;
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
      patterns: [...this.patterns.values()].map((p) => ({ name: p.name, cols: p.toJSON() })),
      counter: this.counter,
      currentName: this.currentName,
      parkedName: this.parkedName,
    };
  }

  static fromJSON(o, isReferenced) {
    const lib = new PatternLibrary(isReferenced);
    for (const { name, cols } of o.patterns) lib.patterns.set(name, Pattern.fromJSON(cols, name));
    lib.counter = o.counter;
    lib.currentName = o.currentName;
    lib.parkedName = o.parkedName;
    return lib;
  }
}

// One color per lane (by position). Used for the roll notes and tile symbology.
export const LANE_COLORS = ['#5aa9ff', '#e8a04e'];

// The arrangement is a set of parallel lanes. Each lane is an ordered list of
// tiles (references to patterns by name); lanes play simultaneously from t=0.
// Tile ids are globally unique across lanes, so selection/deletion is flat.
export class Arrangement {
  constructor(lanes) {
    this.lanes = lanes || [{ id: 0, tiles: [] }, { id: 1, tiles: [] }];
    this.selectedId = null;
    this.activeLaneId = this.lanes[0].id;
    this.seq = 0; // global tile-id counter
  }

  lane(id) { return this.lanes.find((l) => l.id === id); }
  laneOfTile(id) { return this.lanes.find((l) => l.tiles.some((t) => t.id === id)); }
  allTiles() { return this.lanes.flatMap((l) => l.tiles); }

  append(laneId, name) {
    const tile = { id: ++this.seq, name };
    this.lane(laneId).tiles.push(tile);
    return tile;
  }

  remove(id) {
    for (const l of this.lanes) {
      const i = l.tiles.findIndex((t) => t.id === id);
      if (i >= 0) { l.tiles.splice(i, 1); break; }
    }
    if (this.selectedId === id) this.selectedId = null;
  }

  referencedNames() { return new Set(this.allTiles().map((t) => t.name)); }

  toJSON() {
    return {
      lanes: this.lanes.map((l) => ({ id: l.id, tiles: l.tiles.map((t) => ({ id: t.id, name: t.name })) })),
      seq: this.seq,
      activeLaneId: this.activeLaneId,
    };
  }

  static fromJSON(o) {
    // Migrate the old single-lane format ({tiles}) into lane 0.
    const lanes = o.lanes
      ? o.lanes.map((l) => ({ id: l.id, tiles: l.tiles.map((t) => ({ id: t.id, name: t.name })) }))
      : [{ id: 0, tiles: (o.tiles || []).map((t) => ({ id: t.id, name: t.name })) }, { id: 1, tiles: [] }];
    const a = new Arrangement(lanes);
    a.seq = o.seq || 0;
    a.activeLaneId = o.activeLaneId ?? lanes[0].id;
    return a;
  }
}

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
import { defaultPatch, normalizePatch } from '../audio/instrument.js';
import { factoryInitId } from '../audio/patches.js';
import { normalizeTransforms } from './transforms.js';
import { defaultDelay, normalizeDelay } from '../audio/delay.js';
import { defaultChorus, normalizeChorus } from '../audio/chorus.js';
import { defaultReverb, normalizeReverb } from '../audio/reverb.js';
import { normalizeModsByKind } from '../audio/mods.js';

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
    // Continue in the current pattern's working context: New keeps its width,
    // pitch context (tuning/scale/root) AND per-column performance lanes
    // (duration/accent/articulation) as a groove stencil, clearing only the
    // pitches (Pattern.stencil). Captured before _leaveCurrent(), which may park
    // or drop the source. With no source (the seed) fall back to a plain blank.
    const src = this.current();
    this._leaveCurrent();
    const p = this._add(src ? src.stencil(this._mint()) : Pattern.initial(this._mint()));
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

  // Deep-copy an arbitrary pattern by name under a fresh minted name WITHOUT
  // touching the current/parked editor state (the tile player's Clone tool: the
  // copy is immediately referenced by the clicked tile, so the one-floating-
  // pattern invariant is untouched). The caller decides whether to open it.
  cloneOf(name) {
    const src = this.patterns.get(name);
    if (!src) return null;
    return this._add(src.clone(this._mint()));
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

  // Empty the current pattern in place (so referencing tiles empty too). Keeps the
  // pattern's own column count (clearing a 16-wide pattern leaves it 16 wide).
  clearCurrent() {
    const c = this.current();
    c.columns = Pattern.initial(c.name, c.columns.length).columns;
  }

  toJSON() {
    return {
      patterns: [...this.patterns.values()].map((p) => ({
        name: p.name, cols: p.toJSON(), tuning: p.tuningId, scale: p.scaleId, root: p.root,
        ...(p.label ? { label: p.label } : {}), // friendly name — omitted when unset (backward-safe)
      })),
      counter: this.counter,
      currentName: this.currentName,
      parkedName: this.parkedName,
    };
  }

  static fromJSON(o, isReferenced) {
    const lib = new PatternLibrary(isReferenced);
    // tuning/scale/root are optional — older patterns default to 12-ET chromatic.
    for (const { name, cols, tuning, scale, root, label } of o.patterns) {
      const p = Pattern.fromJSON(cols, name);
      if (tuning) p.tuningId = tuning;
      if (scale) p.scaleId = scale;
      if (root != null) p.root = root;
      if (label) p.label = label; // optional friendly name (older saves have none)
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
    // Selection: a SET of tile ids, all on ONE lane (the invariant every
    // mutator below preserves). `selectedId` is the ANCHOR — the last-clicked
    // tile (range extends from it; single-tile behaviors like open-in-grid key
    // off it). Runtime-only: not serialized.
    this.selectedId = null;
    this.selectedIds = new Set();
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

  // --- selection (a one-lane set; selectedId = the anchor) -----------------

  // Plain click: a fresh selection of exactly this tile (null clears).
  select(id) {
    this.selectedId = id == null ? null : id;
    this.selectedIds = new Set(id == null ? [] : [id]);
  }

  clearSelection() { this.select(null); }

  // Ctrl-click: toggle membership. A tile on ANOTHER lane starts a fresh
  // selection there (the one-lane rule). Removing the anchor promotes any
  // remaining member.
  toggleSelect(id) {
    const lane = this.laneOfTile(id);
    if (!lane) return;
    const curLane = this.selectedId != null ? this.laneOfTile(this.selectedId) : null;
    if (!this.selectedIds.size || curLane !== lane) { this.select(id); return; }
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      if (this.selectedId === id) this.selectedId = this.selectedIds.size ? [...this.selectedIds][0] : null;
    } else {
      this.selectedIds.add(id);
      this.selectedId = id; // the newest member anchors future ranges
    }
  }

  // Shift-click: the contiguous run of tiles between the anchor and this tile
  // (by start position, inclusive) on the anchor's lane. Cross-lane (or no
  // anchor) degrades to a plain select.
  selectRange(id) {
    const lane = this.laneOfTile(id);
    const anchorLane = this.selectedId != null ? this.laneOfTile(this.selectedId) : null;
    if (!lane || anchorLane !== lane) { this.select(id); return; }
    const a = lane.tiles.find((t) => t.id === this.selectedId);
    const b = lane.tiles.find((t) => t.id === id);
    const lo = Math.min(a.start, b.start), hi = Math.max(a.start, b.start);
    this.selectedIds = new Set(lane.tiles.filter((t) => t.start >= lo && t.start <= hi).map((t) => t.id));
    // the anchor stays put — a second shift-click re-extends from it
  }

  // Marquee: every tile on `laneId` INTERSECTING [b0, b1] (beats, Cubase-like —
  // any overlap counts). Anchor = the leftmost hit. `lenOf(name)` -> beats.
  selectMarquee(laneId, b0, b1, lenOf) {
    const lane = this.lane(laneId);
    if (!lane) return;
    const hit = lane.tiles.filter((t) => t.start < b1 && b0 < t.start + lenOf(t.name));
    this.selectedIds = new Set(hit.map((t) => t.id));
    this.selectedId = hit.length ? hit.reduce((m, t) => (t.start < m.start ? t : m)).id : null;
  }

  // Drop ids that no longer exist (after undo / range ops / deletes); promote a
  // surviving member to anchor if the anchor died.
  pruneSelection() {
    const alive = new Set(this.allTiles().map((t) => t.id));
    for (const id of [...this.selectedIds]) if (!alive.has(id)) this.selectedIds.delete(id);
    if (!this.selectedIds.size) { this.selectedId = null; return; }
    if (this.selectedId == null || !this.selectedIds.has(this.selectedId)) this.selectedId = [...this.selectedIds][0];
  }

  // Append a new empty lane (id = one past the current max). 2 lanes is the
  // factory default; more are added on request. Returns the new lane.
  addLane() {
    const id = this.lanes.reduce((m, l) => Math.max(m, l.id), -1) + 1;
    const lane = newLane(id);
    this.lanes.push(lane);
    return lane;
  }

  // Move the lane with `id` to `toIndex` (an insertion index in the array WITHOUT
  // the moved lane — i.e. the count of other lanes that should sit above it). Pure
  // array reorder: identity (id, color, patch, tiles, inserts) travels with the
  // lane, so nothing in the audio graph (buses keyed by id) or selection (by id)
  // needs rebuilding — only the visual order and the positional "Lane N" number
  // change. The lane the object represents is the TRACK; its row is the LANE.
  moveLane(id, toIndex) {
    const from = this.lanes.findIndex((l) => l.id === id);
    if (from < 0) return;
    const [lane] = this.lanes.splice(from, 1);
    const to = Math.max(0, Math.min(toIndex, this.lanes.length));
    this.lanes.splice(to, 0, lane);
  }

  // Reset one lane to a blank slate, KEEPING it in the stack (removing lanes is a
  // separate concern): empty its tiles and restore default instrument / mixer /
  // delay / mute-solo, and mark it fresh so the next dropped tile re-seeds it.
  resetLane(id) {
    const lane = this.lane(id);
    if (!lane) return;
    lane.tiles = [];
    lane.mute = false; lane.solo = false;
    lane.gain = 1; lane.pan = 0;
    lane.delay = defaultDelay();
    lane.chorus = defaultChorus();
    lane.reverb = defaultReverb();
    lane.patch = defaultPatch();
    lane.patchOriginId = factoryInitId(lane.patch.kind); lane.patchName = 'Init'; lane.patchDirty = false; lane.patchImported = false;
    lane.modsByKind = {};
    lane.fresh = true;
    this.pruneSelection();
  }

  // Reset the whole tile player to the factory state: two blank, fresh lanes and
  // the play region back to the whole arrangement (start 0, no end marker). The
  // tile-id counter (seq) keeps climbing so ids stay unique across the session.
  resetPlayer() {
    this.lanes = [newLane(0), newLane(1)];
    this.activeLaneId = 0;
    this.clearSelection();
    this.playStart = 0;
    this.playEnd = null;
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

  // Delete a tile WITHOUT rippling (non-ripple mode): later tiles stay put, the
  // removed tile's span becomes a gap (silence).
  remove(id) {
    const lane = this.laneOfTile(id);
    if (!lane) return;
    const i = lane.tiles.findIndex((t) => t.id === id);
    if (i >= 0) lane.tiles.splice(i, 1);
    if (this.selectedId === id) this.selectedId = null;
  }

  // Insert a NEW tile of `name` at `start` in `laneId` — ripple mode uses the
  // rigid ripple (clamp-left, push-right); non-ripple places it exactly there,
  // overwriting whatever it overlaps. Returns the new tile.
  insertAt(laneId, name, start, lenOf, ripple = true) {
    const lane = this.lane(laneId);
    if (!lane) return null;
    const tile = { id: ++this.seq, name, start: 0 };
    if (ripple) rippleInsertInto(lane.tiles, tile, start, lenOf);
    else overwriteInsertInto(lane.tiles, tile, start, lenOf);
    return tile;
  }

  // Move a tile to beat `start` in `toLaneId`. Ripple mode: ripple-open the
  // target (right side right by just enough to make room — 0 if it already
  // fits); repositioning *within* a lane just lifts the tile out (leaving its
  // gap); moving *out* to a different lane ripple-closes the source. Non-ripple:
  // the tile is lifted plainly (source keeps its gap either way) and lands
  // exactly at `start`, overwriting whatever it overlaps. Keeps the tile's id so
  // selection follows.
  moveTile(id, toLaneId, start, lenOf, ripple = true) {
    const from = this.laneOfTile(id);
    const to = this.lane(toLaneId);
    if (!from || !to) return id;
    const tile = from.tiles.find((t) => t.id === id);
    if (!ripple || from === to) {
      const i = from.tiles.indexOf(tile);
      if (i >= 0) from.tiles.splice(i, 1); // lift out, no ripple
    } else {
      rippleRemoveFrom(from.tiles, tile, lenOf); // ripple mode: moving out closes the source
    }
    if (ripple) rippleInsertInto(to.tiles, tile, start, lenOf);
    else overwriteInsertInto(to.tiles, tile, start, lenOf);
    return id;
  }

  // Insert a shallow copy (new id, same pattern reference) at beat `start` in
  // `toLaneId` — ripple-opening the target, or (non-ripple) landing exactly there
  // and overwriting. The source is untouched. Returns the new tile id.
  copyTile(id, toLaneId, start, lenOf, ripple = true) {
    const src = this.allTiles().find((t) => t.id === id);
    const to = this.lane(toLaneId);
    if (!src || !to) return null;
    // A copy is a copy of the INSTANCE, so it carries the source's transforms
    // (cloned, not shared) — same pattern reference, same per-tile transforms.
    const tile = { id: ++this.seq, name: src.name, start: 0 };
    if (src.transforms) tile.transforms = src.transforms.map((t) => ({ ...t }));
    if (ripple) rippleInsertInto(to.tiles, tile, start, lenOf);
    else overwriteInsertInto(to.tiles, tile, start, lenOf);
    return tile.id;
  }

  referencedNames() { return new Set(this.allTiles().map((t) => t.name)); }

  // --- selection block ops (move / copy / repeat) --------------------------
  // The selection moves as a RIGID BLOCK (relative offsets preserved), with the
  // "ignore" collision policy: a member whose destination overlaps a non-moving
  // tile is `blocked` — a move leaves it where it was, a copy/repeat skips it.
  // (Overwrite may become a toggle later.) Members can't collide with each
  // other (rigid translation); a blocked member left behind CAN overlap a
  // placed one's destination — accepted, overlaps are already tolerated.

  // The selected tiles, in timeline order.
  selectedTiles() {
    return this.allTiles().filter((t) => this.selectedIds.has(t.id)).sort((a, b) => a.start - b.start);
  }

  // The selection's bounding block: [start, end) + the lane it lives on.
  selectionBlock(lenOf) {
    const tiles = this.selectedTiles();
    if (!tiles.length) return null;
    const start = tiles[0].start;
    const end = Math.max(...tiles.map((t) => t.start + lenOf(t.name)));
    return { start, end, lane: this.laneOfTile(tiles[0].id) };
  }

  // Plan translating the selection by `shift` beats onto `toLaneId` (pure — the
  // drag preview and the commit share it, so preview == commit). Returns
  // [{id, name, start, blocked}] in timeline order.
  planSelectionDrop(toLaneId, shift, lenOf, copy) {
    const target = this.lane(toLaneId);
    if (!target) return [];
    // A move vacates its own space; a copy's originals stay and DO obstruct.
    const obstacles = target.tiles.filter((t) => copy || !this.selectedIds.has(t.id));
    return this.selectedTiles().map((t) => {
      const start = t.start + shift;
      const len = lenOf(t.name);
      const blocked = start < 0
        || obstacles.some((o) => o.start < start + len && start < o.start + lenOf(o.name));
      return { id: t.id, name: t.name, start, blocked };
    });
  }

  // Move the selection per the plan (blocked members stay put, still selected).
  moveSelection(toLaneId, shift, lenOf) {
    const plan = this.planSelectionDrop(toLaneId, shift, lenOf, false);
    const target = this.lane(toLaneId);
    for (const p of plan) {
      if (p.blocked) continue;
      const src = this.laneOfTile(p.id);
      const tile = src.tiles.find((t) => t.id === p.id);
      if (src !== target) {
        src.tiles.splice(src.tiles.indexOf(tile), 1);
        target.tiles.push(tile);
      }
      tile.start = p.start;
    }
    for (const lane of this.lanes) sortLane(lane);
    return plan;
  }

  // Copy the selection per the plan; the selection becomes the placed copies
  // (parallel to a single-tile copy selecting its copy). Transforms are cloned.
  copySelection(toLaneId, shift, lenOf) {
    const plan = this.planSelectionDrop(toLaneId, shift, lenOf, true);
    const target = this.lane(toLaneId);
    const placed = [];
    for (const p of plan) {
      if (p.blocked) continue;
      const src = this.allTiles().find((t) => t.id === p.id);
      const tile = { id: ++this.seq, name: p.name, start: p.start };
      if (src && src.transforms) tile.transforms = src.transforms.map((x) => ({ ...x }));
      target.tiles.push(tile);
      placed.push(tile);
    }
    sortLane(target);
    if (placed.length) {
      this.selectedIds = new Set(placed.map((t) => t.id));
      this.selectedId = placed[0].id;
    }
    return plan;
  }

  // Plan stamping `|k|` repeats of the selection block (pure; the fill-handle
  // preview and repeatSelection share it). k > 0 stamps to the RIGHT, k < 0 to
  // the LEFT — copy r of a member lands at start ± r×period, period = the block
  // span, so it's rhythmically seamless. Stamps from different repeats are disjoint
  // by construction (and don't overlap the originals), so collisions are only
  // against PRE-EXISTING tiles; a left copy that would fall before beat 0 is blocked.
  planRepeat(k, lenOf) {
    const block = this.selectionBlock(lenOf);
    if (!block || !k) return [];
    const period = block.end - block.start;
    if (period <= 0) return [];
    const existing = block.lane.tiles.slice();
    const dir = k > 0 ? 1 : -1;
    const out = [];
    for (let rep = 1; rep <= Math.abs(k); rep++) {
      const offset = dir * rep * period;
      for (const t of this.selectedTiles()) {
        const start = t.start + offset;
        const len = lenOf(t.name);
        const blocked = start < 0 || existing.some((o) => o.start < start + len && start < o.start + lenOf(o.name));
        out.push({ srcId: t.id, name: t.name, start, blocked });
      }
    }
    return out;
  }

  // Stamp the repeats (skipping blocked); selection becomes the ORIGINAL tiles
  // PLUS all placed stamps (user's choice — ready for a whole-run transform).
  repeatSelection(k, lenOf) {
    const block = this.selectionBlock(lenOf);
    if (!block) return [];
    const plan = this.planRepeat(k, lenOf);
    const placed = [];
    for (const p of plan) {
      if (p.blocked) continue;
      const src = this.allTiles().find((t) => t.id === p.srcId);
      const tile = { id: ++this.seq, name: p.name, start: p.start };
      if (src && src.transforms) tile.transforms = src.transforms.map((x) => ({ ...x }));
      block.lane.tiles.push(tile);
      placed.push(tile);
    }
    sortLane(block.lane);
    for (const t of placed) this.selectedIds.add(t.id);
    return placed;
  }

  // --- range edits (global timeline surgery, all lanes) -------------------
  // Tiles are atomic: a tile STARTING in the range is affected; one starting
  // before it and extending into it is untouched (no trimming), so deleteTime
  // can leave the shifted material overlapping such a tail — accepted.
  // The play-region markers ride along (they're timeline points too).

  // Open a gap: everything starting at/after `s` shifts right by `len` beats.
  insertTime(s, len) {
    for (const lane of this.lanes) for (const t of lane.tiles) { if (t.start >= s) t.start += len; }
    this.playStart = insertPoint(this.playStart || 0, s, len);
    if (this.playEnd != null) this.playEnd = insertPoint(this.playEnd, s, len);
  }

  // Remove the tiles starting in [s, e); nothing moves, markers untouched.
  clearRange(s, e) {
    for (const lane of this.lanes) lane.tiles = lane.tiles.filter((t) => t.start < s || t.start >= e);
    this.pruneSelection();
  }

  // Excise [s, e): clearRange + everything at/after `e` shifts left to close it.
  deleteTime(s, e) {
    this.clearRange(s, e);
    const len = e - s;
    for (const lane of this.lanes) for (const t of lane.tiles) { if (t.start >= e) t.start -= len; }
    this.playStart = deletePoint(this.playStart || 0, s, e);
    if (this.playEnd != null) {
      this.playEnd = deletePoint(this.playEnd, s, e);
      // Both markers were inside the range (collapsed together at s) — reopen a
      // small region there rather than leaving a degenerate one (user's rule).
      if (this.playEnd <= this.playStart) { this.playStart = s; this.playEnd = s + 4; }
    }
  }

  toJSON() {
    return {
      lanes: this.lanes.map((l) => ({
        id: l.id,
        color: l.color, // the track's identity colour — defaulted at birth, travels on reorder
        tiles: l.tiles.map((t) => ({ id: t.id, name: t.name, start: t.start, transforms: t.transforms })),
        mute: !!l.mute, solo: !!l.solo,
        gain: l.gain, pan: l.pan, // mixer: linear volume (1 = 0 dB), pan −1..+1
        delay: l.delay, // per-lane delay insert
        chorus: l.chorus, // per-lane Juno chorus insert
        reverb: l.reverb, // per-lane insert reverb
        patch: l.patch, // the lane's instrument settings
        patchOriginId: l.patchOriginId, // catalog entry this patch derives from (by id)
        patchName: l.patchName,         // display name shown on the lane head
        patchDirty: !!l.patchDirty,     // edited / not-saved-as-shown (the `*`)
        patchImported: !!l.patchImported, // from a foreign project, not in this catalog (the `[I]`)
        modsByKind: l.modsByKind, // playback modulators, one pair per instrument kind
        fresh: !!l.fresh, // never-used lane (adopts a dropped tile's instrument)
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
    const tile = (t) => ({ id: t.id, name: t.name, start: t.start, transforms: normalizeTransforms(t.transforms) });
    const lane = (l, i) => {
      const patch = normalizePatch(l.patch);
      // Patch identity: new saves carry it; a LEGACY lane (no origin) migrates to
      // its kind's factory Init but marked DIRTY → shows "Init*" (its custom sound
      // is a modified Init awaiting a name), per the agreed migration rule.
      const hasIdentity = l.patchOriginId != null;
      return {
        id: l.id, color: l.color || laneColor(i), // older saves lack colour → the by-position default (reproduces today)
        tiles: l.tiles.map(tile), mute: !!l.mute, solo: !!l.solo,
        gain: l.gain == null ? 1 : l.gain, pan: l.pan == null ? 0 : l.pan,
        delay: normalizeDelay(l.delay), chorus: normalizeChorus(l.chorus), reverb: normalizeReverb(l.reverb), patch,
        patchOriginId: hasIdentity ? l.patchOriginId : factoryInitId(patch.kind),
        patchName: hasIdentity ? (l.patchName || 'Init') : 'Init',
        patchDirty: hasIdentity ? !!l.patchDirty : true,
        patchImported: !!l.patchImported, // default false; file-Open re-derives it
        modsByKind: normalizeModsByKind(l.modsByKind),
        fresh: !!l.fresh, // optional; old saves default not-fresh (won't auto-seed)
      };
    };
    const lanes = o.lanes
      ? o.lanes.map(lane)
      : [{ id: 0, color: laneColor(0), tiles: (o.tiles || []).map(tile), mute: false, solo: false, gain: 1, pan: 0, delay: defaultDelay(), chorus: defaultChorus(), reverb: defaultReverb(), patch: defaultPatch(), patchOriginId: factoryInitId(defaultPatch().kind), patchName: 'Init', patchDirty: false, patchImported: false, modsByKind: {}, fresh: false }, newLane(1)];
    const a = new Arrangement(lanes);
    a.seq = o.seq || 0;
    a.activeLaneId = o.activeLaneId ?? lanes[0].id;
    a.playStart = o.playStart == null ? 0 : o.playStart; // region markers (optional in older saves)
    a.playEnd = o.playEnd == null ? null : o.playEnd;
    return a;
  }
}

// Map a timeline point (playhead, marker) through inserting `len` beats at `s`,
// or through deleting [s, e) — a point inside a deleted range collapses to its
// start. Pure; exported for main's playhead and for tests.
export function insertPoint(p, s, len) { return p >= s ? p + len : p; }
export function deletePoint(p, s, e) { return p >= e ? p - (e - s) : Math.min(p, s); }

// `fresh` marks a brand-new or just-reset lane (never used). A fresh lane adopts
// the instrument of the first tile dropped into it (from the grid, or the source
// lane on a cross-lane move); it stops being fresh once it gets a tile OR its
// instrument is edited, so a lane you set up and later emptied keeps its sound.
function newLane(id) {
  const patch = defaultPatch();
  return {
    // Colour is the TRACK's identity, seeded from the palette by id (ids are dense
    // and monotonic, so this both keeps the first two lanes blue/orange and stays
    // well-spread) and frozen onto the lane so it travels when the lane is reordered.
    id, color: laneColor(id), tiles: [], mute: false, solo: false, gain: 1, pan: 0,
    delay: defaultDelay(), chorus: defaultChorus(), reverb: defaultReverb(),
    patch, modsByKind: {}, fresh: true,
    // Patch identity (future_directions §14): a fresh lane sits on its kind's
    // factory Init, clean. originId links to the catalog entry (by id, not name);
    // patchName is the display label; patchDirty = edited/not-saved (the `*`);
    // patchImported = came from a foreign project, not in this catalog (the `[I]`,
    // set on project-file Open, drives "add to your catalog?").
    patchOriginId: factoryInitId(patch.kind), patchName: 'Init', patchDirty: false, patchImported: false,
  };
}
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

// Non-ripple insert: `tile` lands with its left edge EXACTLY at `start`; every
// existing tile it overlaps is removed whole (tiles are atomic — no trimming),
// everything else stays put. Returns the removed tiles (the drag preview marks
// them doomed). Exported so the preview can compute the same overlaps.
export function overwriteInsertInto(tiles, tile, start, lenOf) {
  const s = Math.max(0, start);
  const len = lenOf(tile.name);
  const removed = [];
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i];
    if (t.start < s + len && s < t.start + lenOf(t.name)) {
      removed.push(t);
      tiles.splice(i, 1);
    }
  }
  tile.start = s;
  tiles.push(tile);
  tiles.sort((a, b) => a.start - b.start);
  return removed;
}

// patches.js — the user-global patch store (the "patch catalog" backing store).
//
// Patches are first-class, id-keyed named objects (future_directions §14):
//   { id, name, kind, params, factory }
// Names are NON-UNIQUE display labels — the id is the key, so a rename never
// breaks a link and two users' catalogs can't collide.
//   - Factory tier: one read-only "Init" per instrument kind, with a DETERMINISTIC
//     id `f:<kind>` (shipped/derived, so a project referencing factory Init
//     resolves on ANY machine — the alien-import story). Reseeded on construct.
//   - User tier: globally-unique random ids, persisted (main.js owns the storage;
//     this module stays pure so it's headless-testable, like PatternLibrary).
//
// This is a Phase-B store (group/tags come in Phase D). Kept dependency-light:
// it only borrows the instrument registry for the factory defaults + a clean
// clone, so it runs headless.

import { instrumentKinds, defaultPatch, clonePatch, DEFAULT_KIND } from './instrument.js';

// The deterministic factory-Init id for a kind. Stable across sessions and users.
export function factoryInitId(kind = DEFAULT_KIND) { return `f:${kind}`; }

// A globally-unique id for a user patch. crypto.randomUUID in the browser (and on
// localhost, a secure context); a timestamp+random fallback for older/headless.
export function newPatchId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export class PatchStore {
  constructor() {
    this.entries = new Map(); // id -> { id, name, kind, params, factory }
    this.seedFactory();
  }

  // One factory "Init" per kind (the current defaultPatch is that kind's Init).
  seedFactory() {
    for (const kind of instrumentKinds()) {
      const id = factoryInitId(kind);
      this.entries.set(id, { id, name: 'Init', kind, params: defaultPatch(kind), factory: true });
    }
  }

  get(id) { return this.entries.get(id) || null; }
  initId(kind) { return factoryInitId(kind); }

  // All patches for a kind, factory first (Init), then user patches by name.
  allForKind(kind) {
    return [...this.entries.values()]
      .filter((e) => e.kind === kind)
      .sort((a, b) => (b.factory ? 1 : 0) - (a.factory ? 1 : 0) || a.name.localeCompare(b.name));
  }

  factoryNames(kind) {
    return new Set(this.allForKind(kind).filter((e) => e.factory).map((e) => e.name));
  }
  userNames(kind) {
    return new Set(this.allForKind(kind).filter((e) => !e.factory).map((e) => e.name));
  }
  allNames(kind) {
    return new Set(this.allForKind(kind).map((e) => e.name));
  }

  // A user patch may not reuse a FACTORY name in its kind — auto-uniquify by
  // appending the smallest free integer (Init -> Init1 -> Init2 …). User↔user
  // name collisions are allowed (names aren't keys), so only factory names force
  // a bump. (The chosen integer also dodges any existing name so we don't collide
  // with an earlier Init7 either.)
  uniqueUserName(kind, name) {
    const nm = String(name || '').trim() || 'Patch';
    if (!this.factoryNames(kind).has(nm)) return nm;
    const taken = this.allNames(kind);
    let n = 1;
    while (taken.has(nm + n)) n++;
    return nm + n;
  }

  // Create a new user patch (a fork / Save As). Mints a fresh id; params cloned.
  add({ name, kind, params }) {
    const e = { id: newPatchId(), name: String(name || 'Patch'), kind, params: clonePatch(params), factory: false };
    this.entries.set(e.id, e);
    return e;
  }

  // Overwrite an existing USER entry in place (a Save onto its own name). Factory
  // entries are read-only. Returns the entry (or null if not writable).
  update(id, { params, name } = {}) {
    const e = this.entries.get(id);
    if (!e || e.factory) return null;
    if (params) e.params = clonePatch(params);
    if (name != null) e.name = String(name);
    return e;
  }

  // Delete a USER entry (factory can't be removed). (Phase C surfaces this.)
  remove(id) {
    const e = this.entries.get(id);
    if (!e || e.factory) return false;
    return this.entries.delete(id);
  }

  // Serialize the USER tier only — factory is reseeded from code on load.
  toJSON() {
    return {
      patches: [...this.entries.values()]
        .filter((e) => !e.factory)
        .map((e) => ({ id: e.id, name: e.name, kind: e.kind, params: e.params })),
    };
  }

  // Merge a saved user tier back in (over the freshly-seeded factory tier).
  loadUser(o) {
    if (!o || !Array.isArray(o.patches)) return;
    for (const p of o.patches) {
      if (!p || !p.id) continue;
      this.entries.set(p.id, {
        id: p.id, name: String(p.name || 'Patch'), kind: p.kind,
        params: clonePatch(p.params), factory: false,
      });
    }
  }
}

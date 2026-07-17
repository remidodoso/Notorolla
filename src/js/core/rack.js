// rack.js — the instrument RACK: a per-project set of SHARED instrument
// instances. A lane referencing an instance (`lane.patchRef = instance.id`) plays
// that instance's patch, and EDITING the instance re-sounds EVERY lane on it —
// the "one voice, many lanes" model (Cubase *rack* vs. *track* instruments). Only
// the VOICE (the patch) is shared; a lane's mixer / effect inserts / modulators
// stay its own.
//
// The rack lives on the Arrangement (so it rides the project file, the autosave,
// and undo). An instance carries a full patch PLUS the same catalog-identity
// fields a lane does (originId / name / dirty / imported), so the instrument
// editor works on it exactly as on a lane: Save / Load / dirty all apply to the
// shared instance. The rack is the *sharing* mechanism; the user-global patch
// catalog is still the library of saved patch definitions — orthogonal, and
// compatible (an instance can hold a catalog patch).
//
// This is a core module in spirit, but — like library.js — it leans on the pure
// patch helpers in audio/ (normalize/clone are data-in/data-out config, no audio
// graph), so it stays node-importable for the notch tests.

import { normalizePatch, clonePatch } from '../audio/instrument.js';
import { newPatchId, factoryInitId } from '../audio/patches.js';

// A dedicated palette so rack chips read as "rack", not "lane" (lanes use
// LANE_COLORS). Assigned by the birth counter; wraps by golden angle beyond it.
const RACK_COLORS = ['#b98cff', '#5ad1b0', '#ff9db0', '#d9c04a', '#7fb2ff', '#e08a5a'];
export function rackColor(i) {
  if (i < RACK_COLORS.length) return RACK_COLORS[i];
  const hue = Math.round((280 + (i - RACK_COLORS.length) * 137.508) % 360);
  return `hsl(${hue}, 55%, 68%)`;
}

// Copy the four catalog-identity fields off any lane/grid-meta-shaped source (or
// a plain default if absent) — an instance stores identity just like a lane.
function identityFrom(src, kind) {
  return {
    patchOriginId: src && src.patchOriginId != null ? src.patchOriginId : factoryInitId(kind),
    patchName: src && src.patchName ? src.patchName : 'Init',
    patchDirty: !!(src && src.patchDirty),
    patchImported: !!(src && src.patchImported),
  };
}

export class Rack {
  constructor(instances, seq) {
    this.instances = instances || [];
    // Names count up forever: R1, R2, … A deleted number is never resurrected
    // (New Project is the only clear), so the counter is persisted, not derived.
    this.seq = seq || 0;
  }

  get(id) { return this.instances.find((r) => r.id === id) || null; }

  // Mint an instance from a patch (+ optional identity source), auto-named R{n}.
  // The patch is CLONED — "Add to rack" copies a sound into a slot; the source
  // (a lane or the grid) is untouched and does not become a reference.
  add(patch, identity) {
    const p = clonePatch(patch);
    const n = ++this.seq;
    const inst = { id: newPatchId(), name: `R${n}`, color: rackColor(n - 1), patch: p, ...identityFrom(identity, p.kind) };
    this.instances.push(inst);
    return inst;
  }

  rename(id, name) { const r = this.get(id); if (r && name) r.name = name; }
  remove(id) { const i = this.instances.findIndex((r) => r.id === id); if (i >= 0) this.instances.splice(i, 1); }

  toJSON() {
    return {
      seq: this.seq,
      instances: this.instances.map((r) => ({
        id: r.id, name: r.name, color: r.color, patch: r.patch,
        patchOriginId: r.patchOriginId, patchName: r.patchName,
        patchDirty: !!r.patchDirty, patchImported: !!r.patchImported,
      })),
    };
  }

  static fromJSON(o) {
    if (!o) return new Rack();
    const instances = (o.instances || []).map((r, i) => {
      const patch = normalizePatch(r.patch);
      return { id: r.id, name: r.name || `R${i + 1}`, color: r.color || rackColor(i), patch, ...identityFrom(r, patch.kind) };
    });
    return new Rack(instances, o.seq || instances.length);
  }
}

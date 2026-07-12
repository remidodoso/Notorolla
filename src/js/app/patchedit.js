// patchedit.js — the instrument editor: the grid's active instrument + parked-
// instrument descriptors, the edit-instrument pane (Vesperia), per-target patch
// identity (dirty / Save / Save As / Load / Rename), and the Patch Catalog.

import { clonePatch, defaultPatch, instrument, instrumentKinds } from '../audio/instrument.js';
import { buildInstrumentPane } from '../ui/instrumentpane.js';
import { createCatalog } from '../ui/catalog.js';
import { openModal } from '../ui/modal.js';
import { laneColor } from '../core/library.js';
import { tuningFreq } from '../core/tuning.js';
import { GRIDPATCH_KEY, GRIDMETA_KEY, PATCHES_KEY } from './storage.js';

export function initPatchedit(ctx) {
  const { arrangement, library, tilePlayer, engine, patches } = ctx;
  const state = ctx.state;
  const gridPatch = ctx.gridPatch; // stable object; mutated in place by replaceGridPatch

  function persistPatches() { ctx.safeSet(PATCHES_KEY, JSON.stringify(patches.toJSON())); }

  // Set which instrument the grid plays/edits with (validated: a missing lane falls
  // back to the grid's own). Re-points the pane when the grid is focused, and
  // records it for persistence so a reload keeps the same grid instrument.
  function setGridInstr(desc) {
    ctx.gridInstr = desc && desc.source === 'lane' && arrangement.lane(desc.laneId)
      ? { source: 'lane', laneId: desc.laneId }
      : { source: 'grid' };
    state.gridInstr = ctx.gridInstr.source === 'lane' ? { source: 'lane', laneId: ctx.gridInstr.laneId } : null;
    if (ctx.activePane === 'grid') editGrid(); // re-point the pane at the new instrument
  }

  function setParkedInstr(desc) { ctx.parkedInstr = desc || null; state.parkedInstr = ctx.parkedInstr; }

  // Overwrite the grid's own neutral patch in place with a copy of `src` (keeping
  // the gridPatch object identity so editTarget/patchFor references stay valid).
  // Used when Clone promotes a borrowed tile instrument to be the grid's own.
  function replaceGridPatch(src) {
    const copy = clonePatch(src);
    for (const k of Object.keys(gridPatch)) delete gridPatch[k];
    Object.assign(gridPatch, copy);
    ctx.safeSet(GRIDPATCH_KEY, JSON.stringify(gridPatch));
  }

  let catalog = null;       // the Patch Catalog floating pane (created below)


  // Edit-instrument pane (the Vesperia). An editor panel, not a transport pane:
  // it doesn't touch activePane or the shortcut routing. The pane edits ONE target
  // patch at a time (a lane's, or the grid's neutral one). Slider edits mutate
  // that patch in place (heard on the next note) and autosave the right place.
  const instrPane = buildInstrumentPane(document.getElementById('instr'), {
    onChange: onPatchEdit,
    onKindChange: changeKind,
    onTest: testInstrument,
    onReset: resetInstrument,
    onCopy: copyPatch,
    onPaste: pastePatch,
    // Patch catalog (Phase B): identity + save/load.
    getIdentity: () => { const m = targetMeta(); return m ? patchInfo(m) : null; },
    getPatchList: () => patches.allForKind(ctx.editTarget.patch.kind).map((e) => ({ id: e.id, name: e.name, factory: e.factory })),
    onRenamePatch: renameTargetPatch,
    onSave: saveTargetPatch,
    onSaveAs: saveTargetPatchAs,
    onLoad: loadTargetPatch,
    onCatalog: () => { catalog.toggle(); },
  });

  let patchClipboard = null; // in-memory only (cleared on reload) — Copy/Paste

  // Per-target stash of the OTHER kinds' last-used patches, so switching a target
  // from (say) Zindel to Vesperia and back restores the Zindel you'd dialed rather
  // than resetting it. In-memory, per session: the *active* kind always rides the
  // project (it's the lane/grid patch); only the inactive kinds' edits are
  // session-scoped. Keyed by target (a laneId, or 'grid' for the grid patch).
  const patchStash = new Map();
  const stashKey = (laneId) => (laneId == null ? 'grid' : `lane:${laneId}`);

  // Replace the current target's patch contents in place (so every reference —
  // lane.patch / gridPatch / editTarget.patch — stays valid) with `next`, wiping
  // the old kind's keys first. Then re-point the pane so it rebuilds for the new
  // kind, and persist.
  function swapTargetPatch(next) {
    const cur = ctx.editTarget.patch;
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, next);
    if (ctx.editTarget.laneId == null) editGrid(); else editLane(ctx.editTarget.laneId);
    persistPatch();
    ctx.syncGridReference(); // a kind change (e.g. to/from Boshwick) moves the pivot band
  }

  // Switch the edited target to a different instrument kind, stashing the patch
  // we're leaving and restoring any previously-dialed patch of the kind we're
  // entering (else that kind's factory default).
  function changeKind(kind) {
    const cur = ctx.editTarget.patch;
    if (cur.kind === kind) return;
    let stash = patchStash.get(stashKey(ctx.editTarget.laneId));
    if (!stash) { stash = {}; patchStash.set(stashKey(ctx.editTarget.laneId), stash); }
    stash[cur.kind] = clonePatch(cur);
    const usedStash = !!stash[kind];
    swapTargetPatch(stash[kind] ? clonePatch(stash[kind]) : defaultPatch(kind));
    // A kind change resets identity to that kind's Init (a name is meaningful only
    // within a kind). A restored stash isn't the bare default → mark it dirty (Init*).
    setTargetIdentity(patches.initId(kind), 'Init', usedStash);
  }

  // Point the editor at the grid's active instrument (when the grid pane has focus):
  // the grid's own neutral patch, or — while a tile is loaded — that tile's LANE
  // patch, so editing the grid's instrument edits the lane (and every tile on it).
  function editGrid() {
    const lane = ctx.gridInstr.source === 'lane' ? arrangement.lane(ctx.gridInstr.laneId) : null;
    if (lane) {
      const idx = arrangement.lanes.indexOf(lane);
      ctx.editTarget = { patch: lane.patch, laneId: lane.id };
      tilePlayer.editLaneId = lane.id;
      instrPane.setTarget(lane.patch, `Lane ${idx + 1}`, lane.color || laneColor(idx));
      tilePlayer.render();
      return;
    }
    ctx.editTarget = { patch: gridPatch, laneId: null };
    tilePlayer.editLaneId = null;
    instrPane.setTarget(gridPatch, 'Grid', '#8a8f98');
    tilePlayer.render();
    if (catalog && catalog.isOpen()) catalog.refresh(); // follow the target's highlight
  }

  // Point the editor at a lane's own patch. `scroll` brings the pane into view —
  // used ONLY by the explicit Edit button, so that re-points (a kind change, a
  // default-patch swap, a borrow) never yank the page under the user.
  function editLane(laneId, scroll = false) {
    const lane = arrangement.lane(laneId);
    if (!lane) return;
    const idx = arrangement.lanes.indexOf(lane);
    ctx.editTarget = { patch: lane.patch, laneId };
    tilePlayer.editLaneId = laneId;
    instrPane.setTarget(lane.patch, `Lane ${idx + 1}`, lane.color || laneColor(idx));
    tilePlayer.render();
    if (catalog && catalog.isOpen()) catalog.refresh(); // follow the target's highlight
    // Reveal the pane only when its TOP isn't already on-screen. The pane is often
    // taller than the viewport, so an unconditional scrollIntoView('nearest') can
    // never be a no-op (it aligns an edge) and yanks the page even when the pane is
    // already in view — the "pointless scroll in nearly all cases".
    if (scroll) {
      const el = document.getElementById('instr');
      const top = el.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  // Persist a patch edit: the grid patch is a workspace preference (its own key);
  // a lane patch is musical content, so it rides the arrangement autosave + dirty.
  function persistPatch() {
    if (ctx.editTarget.laneId == null) { ctx.safeSet(GRIDPATCH_KEY, JSON.stringify(gridPatch)); return; }
    // A deliberately-edited instrument means the lane has been "used" — so a tile
    // dropped in later won't auto-overwrite it (see lane.fresh).
    const lane = arrangement.lane(ctx.editTarget.laneId);
    if (lane) lane.fresh = false;
    ctx.persist();
  }

  function copyPatch() {
    patchClipboard = clonePatch(ctx.editTarget.patch);
    instrPane.setCanPaste(true);
  }

  function pastePatch() {
    if (!patchClipboard) return;
    // Paste can cross kinds (Copy a Zindel, Paste onto a Vesperia lane), so swap
    // the whole patch — swapTargetPatch rebuilds the pane for the pasted kind.
    swapTargetPatch(clonePatch(patchClipboard));
    // A pasted sound isn't the kind's bare default → Init*, awaiting a name.
    setTargetIdentity(patches.initId(ctx.editTarget.patch.kind), 'Init', true);
  }

  // --- patch identity: dirty tracking, Save/Save As/Load/Rename ----------------
  // The patch-identity record for the current edit target (a lane, or the grid).
  function targetMeta() {
    if (ctx.editTarget.laneId == null) return ctx.gridPatchMeta;
    return arrangement.lane(ctx.editTarget.laneId) || ctx.gridPatchMeta;
  }
  // Display info for a patch-identity record: { name, dirty, imported }. The UI
  // composes `name + (dirty?'*') + (imported?' [I]')`. `imported` is an EXPLICIT
  // flag (set on project-file Open), not inferred from id-resolution — so a locally
  // deleted patch reads as `Name*`, only a genuinely foreign one as `[I]`.
  function patchInfo(meta) {
    if (!meta) return { name: 'Init', dirty: false, imported: false };
    const entry = patches.get(meta.patchOriginId);
    const imported = !!meta.patchImported;
    // A clean, resolvable, non-imported patch shows the entry's CURRENT name (so an
    // in-place Rename propagates to every linker); otherwise the local snapshot.
    const name = (entry && !meta.patchDirty && !imported) ? entry.name : (meta.patchName || 'Init');
    return { name, dirty: !!meta.patchDirty, imported };
  }

  // A user param edit flips the target dirty (only the first edit needs the repaint)
  // and persists. (Programmatic swaps use setTargetIdentity, not this.)
  function onPatchEdit() {
    const m = targetMeta();
    if (m && !m.patchDirty) {
      m.patchDirty = true;
      instrPane.syncIdentity();
      if (ctx.editTarget.laneId != null) tilePlayer.render();
    }
    persistPatch();
  }

  // Persist the identity record to the right place (grid = its own key; a lane
  // rides the arrangement) and repaint the pane name + lane head.
  function persistPatchMeta() {
    if (ctx.editTarget.laneId == null) ctx.safeSet(GRIDMETA_KEY, JSON.stringify(ctx.gridPatchMeta));
    else ctx.persist();
    instrPane.syncIdentity();
    if (ctx.editTarget.laneId != null) tilePlayer.render();
    if (catalog && catalog.isOpen()) catalog.refresh(); // new/loaded patch, highlight move
  }
  function setTargetIdentity(originId, name, dirty) {
    const m = targetMeta();
    if (!m) return;
    m.patchOriginId = originId; m.patchName = name; m.patchDirty = dirty;
    m.patchImported = false; // linked to a known entry → no longer "imported"
    persistPatchMeta();
  }

  // Rename = declare a fork name; shows Name* until Save creates the catalog entry.
  function renameTargetPatch(name) {
    const m = targetMeta();
    if (!m) return;
    m.patchName = name;
    m.patchDirty = true; // differs from any saved entry until Save
    persistPatchMeta();
  }

  // Save: overwrite the linked USER entry when the name is unchanged; otherwise (a
  // renamed patch, or a factory/Init origin) fork a new user patch. (Save-with-a-
  // changed-name = "make a new patch" — never an in-place rename; true rename is
  // Phase C.)
  function saveTargetPatch() {
    const m = targetMeta();
    if (!m) return;
    const entry = patches.get(m.patchOriginId);
    const kind = ctx.editTarget.patch.kind;
    const nameChanged = !entry || m.patchName !== entry.name;
    if (entry && !entry.factory && !nameChanged) {
      patches.update(entry.id, { params: clonePatch(ctx.editTarget.patch) });
      persistPatches();
      markSiblingsDirty(entry.id, m); // independent copies fall out of sync → `*`
      setTargetIdentity(entry.id, entry.name, false);
      return;
    }
    // Fork: needs a name. A factory Init with an unchanged name must supply one now.
    let name = m.patchName;
    if (entry && entry.factory && !nameChanged) {
      name = (prompt('Name this patch:', '') || '').trim();
      if (!name) return; // cancelled — nothing saved
    }
    forkPatch(kind, name);
  }

  function saveTargetPatchAs() {
    const m = targetMeta();
    if (!m) return;
    const suggested = m.patchName === 'Init' ? '' : m.patchName;
    const name = (prompt('Save patch as:', suggested) || '').trim();
    if (!name) return;
    forkPatch(ctx.editTarget.patch.kind, name);
  }

  // Create a new user patch from the target's current params and link to it. The
  // name is resolved against catalog collisions first (factory names auto-uniquify;
  // a user-name clash offers Save/Rename/Cancel — we discourage silent duplicates).
  function forkPatch(kind, name) {
    resolveForkName(kind, name, (finalName) => {
      if (!finalName) return; // cancelled
      const e = patches.add({ name: finalName, kind, params: clonePatch(ctx.editTarget.patch) });
      persistPatches();
      setTargetIdentity(e.id, e.name, false);
    });
  }

  // Resolve `name` for a new user patch, then call ok(finalName) — or ok(null) if
  // cancelled. A FACTORY-name collision is reserved → auto-uniquify (Init→Init1). A
  // USER-name collision opens a Save/Rename/Cancel choice (Save = use it anyway;
  // Rename = pick another and re-check; Cancel = abort).
  function resolveForkName(kind, name, ok) {
    name = (name || '').trim();
    if (!name) { ok(null); return; }
    if (patches.factoryNames(kind).has(name)) { ok(patches.uniqueUserName(kind, name)); return; }
    if (patches.userNames(kind).has(name)) {
      openNameCollision(name, (choice) => {
        if (choice === 'use') ok(name);
        else if (choice === 'rename') {
          const next = (prompt('New patch name:', name) || '').trim();
          if (!next) { ok(null); return; }
          resolveForkName(kind, next, ok);
        } else ok(null);
      });
      return;
    }
    ok(name);
  }

  // The "name already in use" dialog (Save / Rename / Cancel). done(choice) with
  // 'use' | 'rename' | null.
  function openNameCollision(name, done) {
    const body = document.createElement('div');
    body.className = 'delay-editor';
    const msg = document.createElement('div');
    msg.className = 'delay-row'; msg.style.display = 'block';
    msg.textContent = `There is already a patch named “${name}”. Use the name again?`;
    const actions = document.createElement('div');
    actions.className = 'delay-row rand-actions';
    let choice = null;
    const mk = (text, cls, val) => {
      const b = document.createElement('button'); b.className = cls; b.textContent = text;
      b.addEventListener('click', () => { choice = val; modal.close(); });
      actions.append(b);
    };
    mk('Save', 'stem-go', 'use');
    mk('Rename', 'seg', 'rename');
    const sp = document.createElement('span'); sp.style.flex = '1'; actions.append(sp);
    mk('Cancel', 'seg', null);
    body.append(msg, actions);
    const modal = openModal({ title: 'Patch name in use', body, onClose: () => done(choice) });
  }

  // Load a catalog patch into the current target (same kind — the Load menu is
  // per-kind), replacing its params in place and adopting the entry's identity.
  function loadTargetPatch(id) {
    const e = patches.get(id);
    if (!e) return;
    applyPatchToTarget(clonePatch(e.params));
    setTargetIdentity(e.id, e.name, false);
  }

  // Replace the target patch's contents in place (references stay valid) and
  // rebuild the pane for the (possibly new) kind — like swapTargetPatch, but the
  // caller sets identity explicitly afterward.
  function applyPatchToTarget(next) {
    const cur = ctx.editTarget.patch;
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, next);
    if (ctx.editTarget.laneId == null) editGrid(); else editLane(ctx.editTarget.laneId);
    persistPatch();
    ctx.syncGridReference();
  }

  // After overwriting a user entry, mark OTHER targets holding an independent copy
  // of it (same origin id, currently clean) dirty — their copy no longer matches
  // the re-Saved sound. (Rack sharing, later, would re-sound them instead.)
  function markSiblingsDirty(entryId, exceptMeta) {
    for (const lane of arrangement.lanes) {
      if (lane === exceptMeta) continue;
      if (lane.patchOriginId === entryId && !lane.patchDirty) lane.patchDirty = true;
    }
    if (ctx.gridPatchMeta !== exceptMeta && ctx.gridPatchMeta.patchOriginId === entryId && !ctx.gridPatchMeta.patchDirty) {
      ctx.gridPatchMeta.patchDirty = true;
      ctx.safeSet(GRIDMETA_KEY, JSON.stringify(ctx.gridPatchMeta));
    }
    ctx.persist();
    tilePlayer.render();
  }

  // --- catalog management: apply / rename / delete -----------------------------
  // Every identity record (lanes + the grid) that links to a catalog entry.
  function patchLinkers(id) {
    const out = arrangement.lanes.filter((l) => l.patchOriginId === id);
    if (ctx.gridPatchMeta.patchOriginId === id) out.push(ctx.gridPatchMeta);
    return out;
  }

  // Repaint everything that shows a patch name after a catalog change.
  function refreshPatchUI() {
    instrPane.syncIdentity();
    tilePlayer.render();
    if (catalog && catalog.isOpen()) catalog.refresh();
  }

  // True in-place Rename of a USER entry (keeps its id, so all links follow). Clean
  // linkers derive their display from the entry, so they update on the next render;
  // dirty linkers keep their own snapshot. A name clash is discouraged like a Save.
  function renamePatchEntry(id, name) {
    const e = patches.get(id);
    if (!e || e.factory) return;
    name = (name || '').trim();
    if (!name || name === e.name) return;
    const commit = (finalName) => {
      patches.update(id, { name: finalName });
      persistPatches();
      // Refresh the snapshot on dirty linkers so a later delete keeps the new name.
      for (const m of patchLinkers(id)) if (m.patchDirty) m.patchName = finalName;
      ctx.persist();
      refreshPatchUI();
    };
    if (patches.factoryNames(e.kind).has(name)) { commit(patches.uniqueUserName(e.kind, name)); return; }
    const clash = [...patches.userNames(e.kind)].includes(name) && patches.allForKind(e.kind).some((o) => !o.factory && o.id !== id && o.name === name);
    if (clash) {
      openNameCollision(name, (choice) => {
        if (choice === 'use') commit(name);
        else if (choice === 'rename') { const n = (prompt('New patch name:', name) || '').trim(); if (n) renamePatchEntry(id, n); }
      });
      return;
    }
    commit(name);
  }

  // Delete a USER entry. Linked targets keep their sound but detach → `Name*`
  // (dirty, NOT imported — a deliberate local delete, not a foreign import).
  function deletePatch(id) {
    const e = patches.get(id);
    if (!e || e.factory) return;
    const users = patchLinkers(id);
    if (users.length && !confirm(`Delete “${e.name}”?\nIt's used by ${users.length} target${users.length > 1 ? 's' : ''} — they keep the sound as “${e.name}*” (unsaved).`)) return;
    patches.remove(id);
    persistPatches();
    for (const m of users) { m.patchDirty = true; m.patchName = e.name; m.patchImported = false; }
    if (users.includes(ctx.gridPatchMeta)) ctx.safeSet(GRIDMETA_KEY, JSON.stringify(ctx.gridPatchMeta));
    ctx.persist();
    refreshPatchUI();
  }

  // Apply a catalog patch to the current edit target (cross-kind aware — reuses the
  // Phase-B load path, which rebuilds the pane for a new kind).
  function applyCatalogPatch(id) { loadTargetPatch(id); if (catalog && catalog.isOpen()) catalog.refresh(); }

  // The Patch Catalog window (a panel.js tenant). Applies to the current editor
  // target; opened from the instrument pane.
  catalog = createCatalog({
    list: () => instrumentKinds().map((k) => ({
      kindLabel: instrument(k).label,
      patches: patches.allForKind(k).map((e) => ({ id: e.id, name: e.name, factory: e.factory })),
    })),
    currentId: () => { const m = targetMeta(); return m ? m.patchOriginId : null; },
    onApply: applyCatalogPatch,
    onRename: (id) => { const e = patches.get(id); if (!e) return; const n = (prompt('Rename patch:', e.name) || '').trim(); if (n) renamePatchEntry(id, n); },
    onDelete: deletePatch,
  });
  if (catalog.isOpen()) catalog.refresh(); // it may have auto-reopened from last session

  // Audition the target patch on a fixed mid-register note (independent of the
  // Audition toggle, which gates click-to-hear on the grid). A lane target plays
  // through that lane's bus so Mute/Solo apply; the grid target is un-laned.
  async function testInstrument() {
    const t = await engine.ensureRunning();
    const cur = library.current();
    engine.playNote(60, t + 0.005, 60 / state.bpm, 0.85, tuningFreq(60, cur.tuningId, cur.root), ctx.editTarget.laneId);
  }

  function resetInstrument() {
    // Reset to THIS instrument's defaults (not always Vesperia's) = its factory Init.
    const kind = ctx.editTarget.patch.kind;
    swapTargetPatch(defaultPatch(kind));
    setTargetIdentity(patches.initId(kind), 'Init', false);
  }

  Object.assign(ctx, {
    setGridInstr, setParkedInstr, replaceGridPatch, editGrid, editLane, patchInfo,
    patchStash, stashKey,
  });
  editGrid(); // start with the editor showing the grid's active instrument
}

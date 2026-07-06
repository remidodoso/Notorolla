// Patch store — the user-global patch catalog's backing store (Phase B).
import { PatchStore, factoryInitId, newPatchId } from '../src/patches.js';
import { instrumentKinds } from '../src/instrument.js';
import { Arrangement } from '../src/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

const store = new PatchStore();

// --- factory tier: one Init per kind, deterministic id, read-only -----------
for (const kind of instrumentKinds()) {
  const init = store.get(factoryInitId(kind));
  ok(init && init.name === 'Init' && init.factory === true && init.kind === kind, `factory Init for ${kind}`);
}
ok(store.allForKind('vesperia')[0].name === 'Init', 'Init sorts first for a kind');
ok(store.update(factoryInitId('vesperia'), { name: 'X' }) === null, 'factory entry is read-only (update)');
ok(store.remove(factoryInitId('vesperia')) === false, 'factory entry cannot be removed');

// --- user tier: add, unique random ids, allForKind --------------------------
const a = store.add({ name: 'SmoothString', kind: 'vesperia', params: { kind: 'vesperia' } });
const b = store.add({ name: 'SmoothString', kind: 'vesperia', params: { kind: 'vesperia' } });
ok(a.id !== b.id, 'user ids are unique even for identical names');
ok(!a.factory, 'user patch is not factory');
ok(store.allForKind('vesperia').filter((e) => !e.factory).length === 2, 'two user vesperia patches listed');
ok(store.allForKind('nayumi').filter((e) => !e.factory).length === 0, 'user patch is kind-scoped');
ok(newPatchId() !== newPatchId(), 'newPatchId is unique');

// --- factory-name collision auto-uniquifies (Init -> Init1 -> Init2) --------
ok(store.uniqueUserName('vesperia', 'Init') === 'Init1', 'Init collides with factory -> Init1');
const i1 = store.add({ name: store.uniqueUserName('vesperia', 'Init'), kind: 'vesperia', params: { kind: 'vesperia' } });
ok(i1.name === 'Init1', 'first Init save -> Init1');
ok(store.uniqueUserName('vesperia', 'Init') === 'Init2', 'next Init -> Init2 (dodges existing Init1)');
ok(store.uniqueUserName('vesperia', 'MyPad') === 'MyPad', 'non-factory name kept as-is');
ok(store.uniqueUserName('vesperia', 'SmoothString') === 'SmoothString', 'user↔user duplicate name allowed (uniqueUserName only bumps factory names)');

// --- name sets: factory vs user --------------------------------------------
ok(store.factoryNames('vesperia').has('Init') && !store.userNames('vesperia').has('Init'), 'Init is a factory name, not a user name');
ok(store.userNames('vesperia').has('SmoothString'), 'user names include SmoothString');
ok(store.userNames('nayumi').size === 0, 'userNames is kind-scoped');

// --- overwrite in place (Save onto own name) --------------------------------
store.update(a.id, { params: { kind: 'vesperia', cutoff: 2000 } });
ok(store.get(a.id).params.cutoff === 2000, 'update overwrites user params in place');

// --- persistence round-trip (user tier only; factory reseeded) --------------
const json = JSON.parse(JSON.stringify(store.toJSON()));
ok(json.patches.every((p) => p.id && !('factory' in p)), 'toJSON has user patches, no factory flag');
ok(json.patches.length === store.allForKind('vesperia').filter((e) => !e.factory).length, 'only user patches serialized');
const store2 = new PatchStore();
store2.loadUser(json);
ok(store2.get(a.id) && store2.get(a.id).name === 'SmoothString', 'user patch restored by id');
ok(store2.get(factoryInitId('vesperia')).factory === true, 'factory tier reseeded on load');

// --- remove -----------------------------------------------------------------
ok(store.remove(b.id) === true && store.get(b.id) === null, 'user patch removable');

// --- lane patch identity: seed / migrate / round-trip -----------------------
// A fresh arrangement's lanes start on their kind's Init, clean.
const fresh = new Arrangement();
ok(fresh.lanes[0].patchOriginId === factoryInitId('vesperia'), 'new lane links to factory Init');
ok(fresh.lanes[0].patchName === 'Init' && fresh.lanes[0].patchDirty === false, 'new lane is Init, clean');

// A LEGACY lane (patch but no identity) migrates to Init* (dirty).
const legacy = Arrangement.fromJSON({ lanes: [{ id: 0, tiles: [], patch: { kind: 'nayumi' } }, { id: 1, tiles: [] }] });
ok(legacy.lanes[0].patchOriginId === factoryInitId('nayumi'), 'legacy lane → its kind’s Init id');
ok(legacy.lanes[0].patchName === 'Init' && legacy.lanes[0].patchDirty === true, 'legacy lane → Init* (dirty)');

// Identity round-trips through toJSON/fromJSON unchanged (incl. the imported flag).
fresh.lanes[0].patchOriginId = 'u-abc'; fresh.lanes[0].patchName = 'SmoothString'; fresh.lanes[0].patchDirty = true; fresh.lanes[0].patchImported = true;
const rt = Arrangement.fromJSON(JSON.parse(JSON.stringify(fresh.toJSON())));
ok(rt.lanes[0].patchOriginId === 'u-abc' && rt.lanes[0].patchName === 'SmoothString' && rt.lanes[0].patchDirty === true,
  'lane patch identity round-trips');
ok(rt.lanes[0].patchImported === true, 'imported flag round-trips');
ok(new Arrangement().lanes[0].patchImported === false, 'fresh lane is not imported');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

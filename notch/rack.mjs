// rack.mjs — the instrument RACK: the pure Rack store + the Arrangement's
// sharing seam (patchRef resolution, assign/detach, serialization, reset).
import { Rack, rackColor } from '../src/js/core/rack.js';
import { Arrangement } from '../src/js/core/library.js';
import { defaultPatch } from '../src/js/audio/instrument.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// --- Rack: minting + counting up --------------------------------------------
{
  const r = new Rack();
  const a = r.add(defaultPatch('vesperia'));
  const b = r.add(defaultPatch('zindel'));
  ok(a.name === 'R1' && b.name === 'R2', 'instances auto-name R1, R2');
  ok(a.id !== b.id, 'instances get distinct ids');
  ok(a.color === rackColor(0) && b.color === rackColor(1), 'colours assigned by birth index');
  ok(r.get(a.id) === a && r.get('nope') === null, 'get by id (miss → null)');
  r.remove(a.id);
  const c = r.add(defaultPatch('tervik'));
  ok(c.name === 'R3', 'names count up forever — a removed number is never resurrected');
}

// --- Rack: add COPIES the patch (Add-to-rack is a copy-out) ------------------
{
  const r = new Rack();
  const src = defaultPatch('vesperia');
  const inst = r.add(src);
  ok(inst.patch !== src, 'instance holds a CLONE, not the source object');
  src.attack = 9.99;
  ok(inst.patch.attack !== 9.99, 'mutating the source never touches the instance');
}

// --- Rack: identity carried from the source; defaults otherwise -------------
{
  const r = new Rack();
  const withId = r.add(defaultPatch('vesperia'), { patchOriginId: 'u-xyz', patchName: 'Bass', patchDirty: true });
  ok(withId.patchOriginId === 'u-xyz' && withId.patchName === 'Bass' && withId.patchDirty === true,
    'an instance carries the source patch identity');
  const bare = r.add(defaultPatch('zindel'));
  ok(bare.patchOriginId === 'f:zindel' && bare.patchName === 'Init' && bare.patchDirty === false,
    'no identity source → the kind Init, clean');
}

// --- Rack: toJSON / fromJSON round-trip --------------------------------------
{
  const r = new Rack();
  r.add(defaultPatch('vesperia'));
  r.add(defaultPatch('nayumi'), { patchName: 'Choir' });
  const rt = Rack.fromJSON(JSON.parse(JSON.stringify(r.toJSON())));
  ok(rt.instances.length === 2 && rt.seq === 2, 'round-trip keeps instances + the counter');
  ok(rt.instances[1].name === 'R2' && rt.instances[1].patchName === 'Choir', 'names/identity survive');
  ok(rt.add(defaultPatch('tervik')).name === 'R3', 'the restored counter keeps counting');
  ok(Rack.fromJSON(null).instances.length === 0, 'fromJSON(null) → empty rack');
}

// --- Arrangement: assign / resolve / detach ---------------------------------
{
  const a = new Arrangement();
  const inst = a.rack.add(defaultPatch('zindel'), { patchName: 'Organ' });
  const laneId = a.lanes[0].id;
  ok(a.resolvePatch(a.lanes[0]) === a.lanes[0].patch, 'unref lane resolves to its own patch');
  ok(a.laneInstance(a.lanes[0]) === null, 'unref lane has no instance');

  a.assignRack(laneId, inst.id);
  ok(a.lanes[0].patchRef === inst.id, 'assignRack sets the reference');
  ok(a.lanes[0].fresh === false, 'assign un-freshes the lane (no auto-reseed later)');
  ok(a.laneInstance(a.lanes[0]) === inst, 'laneInstance returns the shared instance');
  ok(a.resolvePatch(a.lanes[0]) === inst.patch, 'a rack lane resolves to the SHARED voice');

  // Sharing: two lanes → one instance → one voice.
  a.assignRack(a.lanes[1].id, inst.id);
  ok(a.resolvePatch(a.lanes[0]) === a.resolvePatch(a.lanes[1]), 'both lanes resolve to the same object');

  a.assignRack(laneId, 'bogus');
  ok(a.lanes[0].patchRef === inst.id, 'assigning an unknown instance is a no-op');

  // Detach: keep the sound as a private copy, drop the reference.
  a.detachRack(laneId);
  ok(a.lanes[0].patchRef === null, 'detach drops the reference');
  ok(a.lanes[0].patch !== inst.patch, 'detach leaves a private COPY (not the shared object)');
  ok(a.lanes[0].patch.kind === 'zindel' && a.lanes[0].patchName === 'Organ', 'detach copies patch + identity');
  ok(a.resolvePatch(a.lanes[1]) === inst.patch, 'the OTHER lane still shares the instance');
}

// --- Arrangement: serialization + reset invariants --------------------------
{
  const a = new Arrangement();
  const inst = a.rack.add(defaultPatch('tervik'));
  a.assignRack(a.lanes[0].id, inst.id);
  const b = Arrangement.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  ok(b.rack.instances.length === 1, 'the rack survives the arrangement round-trip');
  ok(b.lanes[0].patchRef === inst.id, 'a lane patchRef survives the round-trip');
  ok(b.resolvePatch(b.lanes[0]).kind === 'tervik', 'the resolved shared voice survives');

  a.resetLane(a.lanes[0].id);
  ok(a.lanes[0].patchRef === null, 'resetLane clears the reference (back to a private patch)');
  a.assignRack(a.lanes[1].id, inst.id);
  a.resetPlayer();
  ok(a.rack.instances.length === 0, 'resetPlayer clears the rack (no lanes remain to reference it)');
  ok(a.lanes.every((l) => l.patchRef === null), 'fresh lanes carry no reference');
}

// --- older saves lack the fields --------------------------------------------
{
  const legacy = Arrangement.fromJSON({ lanes: [{ id: 0, tiles: [] }] });
  ok(legacy.lanes[0].patchRef === null, 'a pre-rack lane loads with no reference');
  ok(legacy.rack instanceof Rack && legacy.rack.instances.length === 0, 'a pre-rack save loads an empty rack');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

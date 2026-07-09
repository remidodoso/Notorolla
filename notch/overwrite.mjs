// Non-ripple tile placement: overwriteInsertInto + the Arrangement's mode-aware
// move/copy/remove/insertAt (ripple=false = exact placement, overwrite, gaps).
import { Arrangement, overwriteInsertInto, rippleInsertInto } from '../src/js/core/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// Pattern lengths: every name is 4 beats except E (8 beats).
const lenOf = (name) => (name === 'E' ? 8 : 4);
const tiles = (lane) => lane.tiles.map((t) => `${t.name}@${t.start}`).join(' ');

// --- overwriteInsertInto (the primitive) --------------------------------------
{
  // Lane: A@0 B@4 C@8. Drop X@4 (4 beats) exactly on B → B removed, others stay.
  const arr = [{ id: 1, name: 'A', start: 0 }, { id: 2, name: 'B', start: 4 }, { id: 3, name: 'C', start: 8 }];
  const removed = overwriteInsertInto(arr, { id: 9, name: 'X', start: 0 }, 4, lenOf);
  ok(removed.length === 1 && removed[0].name === 'B', 'exact cover removes just the covered tile');
  ok(arr.map((t) => `${t.name}@${t.start}`).join(' ') === 'A@0 X@4 C@8', 'others untouched, X exactly at 4');
}
{
  // Partial overlap removes the WHOLE tile (atomic, no trimming): X@6 clips B and C.
  const arr = [{ id: 1, name: 'A', start: 0 }, { id: 2, name: 'B', start: 4 }, { id: 3, name: 'C', start: 8 }];
  const removed = overwriteInsertInto(arr, { id: 9, name: 'X', start: 0 }, 6, lenOf);
  ok(removed.length === 2, 'edge-clipping removes both clipped tiles whole');
  ok(arr.map((t) => `${t.name}@${t.start}`).join(' ') === 'A@0 X@6', 'landing exactly at 6, gap where C was');
}
{
  // Abutting is NOT overlap: X@4 next to A@0 (4 beats) touches but doesn't remove.
  const arr = [{ id: 1, name: 'A', start: 0 }];
  const removed = overwriteInsertInto(arr, { id: 9, name: 'X', start: 0 }, 4, lenOf);
  ok(removed.length === 0, 'flush neighbors survive (half-open overlap test)');
}
{
  // Empty space: lands exactly, nothing removed, negative clamped to 0.
  const arr = [];
  overwriteInsertInto(arr, { id: 9, name: 'X', start: 0 }, 17, lenOf);
  ok(arr[0].start === 17, 'lands exactly at the drop beat (gap before it preserved)');
  const arr2 = [];
  overwriteInsertInto(arr2, { id: 9, name: 'X', start: 0 }, -3, lenOf);
  ok(arr2[0].start === 0, 'negative start clamps to 0');
}
{
  // Contrast with ripple: same drop clamps flush against the left neighbor.
  const arr = [{ id: 1, name: 'A', start: 0 }, { id: 2, name: 'B', start: 4 }];
  rippleInsertInto(arr, { id: 9, name: 'X', start: 0 }, 2, lenOf);
  ok(arr.map((t) => `${t.name}@${t.start}`).join(' ') === 'A@0 X@4 B@8', 'ripple mode still clamps + pushes');
}

// --- Arrangement mode-aware ops -----------------------------------------------
function mkArr() {
  const a = new Arrangement();
  a.lanes[0].tiles = [{ id: 1, name: 'A', start: 0 }, { id: 2, name: 'B', start: 4 }, { id: 3, name: 'C', start: 8 }];
  a.lanes[1].tiles = [{ id: 4, name: 'D', start: 0 }];
  a.seq = 10;
  return a;
}
{
  // remove (non-ripple): gap stays.
  const a = mkArr();
  a.remove(2);
  ok(tiles(a.lanes[0]) === 'A@0 C@8', 'non-ripple delete leaves the gap');
  // removeRipple: closes up.
  const b = mkArr();
  b.removeRipple(2, lenOf);
  ok(tiles(b.lanes[0]) === 'A@0 C@4', 'ripple delete closes the gap');
}
{
  // moveTile non-ripple: cross-lane move leaves a gap in the source, overwrites in the target.
  const a = mkArr();
  a.moveTile(4, 0, 4, lenOf, false); // D from lane 1 onto B's spot
  ok(tiles(a.lanes[0]) === 'A@0 D@4 C@8', 'non-ripple move overwrites the covered tile');
  ok(a.lanes[1].tiles.length === 0, 'source lane just empties (no ripple-close needed here)');
}
{
  // moveTile ripple (cross-lane): still ripple-closes the source and pushes the target.
  const a = mkArr();
  a.moveTile(4, 0, 4, lenOf, true);
  ok(tiles(a.lanes[0]) === 'A@0 D@4 B@8 C@12', 'ripple move pushes B/C right');
}
{
  // copyTile non-ripple: source untouched, copy overwrites at the exact beat.
  const a = mkArr();
  const nid = a.copyTile(1, 0, 6, lenOf, false); // copy A onto B+C's span
  ok(nid != null && tiles(a.lanes[0]) === 'A@0 A@6', 'non-ripple copy removes both clipped tiles');
}
{
  // insertAt: non-ripple lands exactly (empty area), ripple appends flush.
  const a = mkArr();
  a.insertAt(1, 'X', 9, lenOf, false);
  ok(tiles(a.lanes[1]) === 'D@0 X@9', 'insertAt non-ripple lands at the exact beat');
  const b = mkArr();
  b.insertAt(1, 'X', 2, lenOf, true);
  ok(tiles(b.lanes[1]) === 'D@0 X@4', 'insertAt ripple clamps flush against the left neighbor');
}
{
  // Non-ripple move within one lane: lifting first means the tile never dooms itself.
  const a = mkArr();
  a.moveTile(2, 0, 5, lenOf, false); // nudge B right by 1 → clips C
  ok(tiles(a.lanes[0]) === 'A@0 B@5', 'self-move never self-removes; clipped neighbor goes');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

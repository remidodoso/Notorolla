// Range edits: insertTime / clearRange / deleteTime on the Arrangement, plus
// the pure timeline-point mappers (insertPoint/deletePoint) that carry the
// playhead and region markers through them.
import { Arrangement, insertPoint, deletePoint } from '../src/js/core/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// A 2-lane arrangement; lengths are irrelevant to the ops (start-based), so
// tiles are just {id, name, start}.
function arr(tiles0, tiles1 = []) {
  const a = new Arrangement();
  let id = 0;
  a.lanes[0].tiles = tiles0.map((start) => ({ id: ++id, name: 'A', start }));
  a.lanes[1].tiles = tiles1.map((start) => ({ id: ++id, name: 'B', start }));
  a.seq = id;
  return a;
}
const starts = (a, li = 0) => a.lanes[li].tiles.map((t) => t.start).join(',');

// --- point mappers ------------------------------------------------------
ok(insertPoint(10, 4, 2) === 12, 'insertPoint: at/after the split shifts');
ok(insertPoint(4, 4, 2) === 6, 'insertPoint: exactly at the split shifts');
ok(insertPoint(3, 4, 2) === 3, 'insertPoint: before the split unmoved');
ok(deletePoint(10, 4, 6) === 8, 'deletePoint: after the range shifts left');
ok(deletePoint(6, 4, 6) === 4, 'deletePoint: exactly at the range end lands on its start');
ok(deletePoint(5, 4, 6) === 4, 'deletePoint: inside the range collapses to its start');
ok(deletePoint(3, 4, 6) === 3, 'deletePoint: before the range unmoved');

// --- insertTime ---------------------------------------------------------
{
  const a = arr([0, 4, 8], [2, 6]);
  a.playStart = 4; a.playEnd = 8;
  a.insertTime(4, 3);
  ok(starts(a) === '0,7,11', `insert: lane 0 starts ≥4 shift right (got ${starts(a)})`);
  ok(starts(a, 1) === '2,9', `insert: lane 1 too (got ${starts(a, 1)})`);
  ok(a.playStart === 7 && a.playEnd === 11, 'insert: markers ride along');
}
{
  const a = arr([0, 4]);
  a.playEnd = null;
  a.insertTime(10, 4);
  ok(starts(a) === '0,4', 'insert past the content: nothing moves');
  ok(a.playEnd === null, 'insert: auto end marker stays auto');
}
{
  // Origin exception: a start marker at 0 stays at 0 on an insert-at-0 (the new
  // time joins the play region), while the end marker and tiles still shift.
  const a = arr([0, 4]);
  a.playStart = 0; a.playEnd = 8;
  a.insertTime(0, 4);
  ok(starts(a) === '4,8', `insert-at-0: tiles shift right (got ${starts(a)})`);
  ok(a.playStart === 0 && a.playEnd === 12, `insert-at-0: start marker holds at 0, end rides (got ${a.playStart},${a.playEnd})`);
  // But a start marker off the origin still rides even when inserting at 0.
  const b = arr([0]);
  b.playStart = 4; b.playEnd = 8;
  b.insertTime(0, 4);
  ok(b.playStart === 8 && b.playEnd === 12, `insert-at-0: a non-origin start marker still rides (got ${b.playStart},${b.playEnd})`);
}

// --- clearRange ---------------------------------------------------------
{
  const a = arr([0, 4, 8], [3, 5]);
  a.playStart = 4; a.playEnd = 8;
  a.clearRange(4, 8);
  ok(starts(a) === '0,8', `clear: starts in [4,8) removed, no shift (got ${starts(a)})`);
  ok(starts(a, 1) === '3', `clear: lane 1 (got ${starts(a, 1)})`);
  ok(a.playStart === 4 && a.playEnd === 8, 'clear: markers untouched');
}
{
  // Atomicity: a tile STARTING before the range survives even if it reaches in.
  const a = arr([2]);
  a.clearRange(4, 8); // the tile at 2 may extend past 4 — starts decide
  ok(starts(a) === '2', 'clear: tile starting before the range is untouched');
}
{
  const a = arr([4, 8]);
  a.selectedId = a.lanes[0].tiles[0].id;
  a.clearRange(4, 6);
  ok(a.selectedId === null, 'clear: selection on a removed tile is dropped');
}

// --- deleteTime ---------------------------------------------------------
{
  const a = arr([0, 4, 8, 12], [5]);
  a.playStart = 0; a.playEnd = 12;
  a.deleteTime(4, 8);
  ok(starts(a) === '0,4,8', `delete: [4,8) removed, later starts close left (got ${starts(a)})`);
  ok(starts(a, 1) === '', `delete: lane 1 tile starting inside removed (got '${starts(a, 1)}')`);
  ok(a.playStart === 0 && a.playEnd === 8, 'delete: end marker shifts left');
}
{
  // Overlap tolerance: a long tile before the range keeps its tail; shifted
  // material may land on it — starts only, no clamping.
  const a = arr([0, 10]);
  a.deleteTime(4, 10);
  ok(starts(a) === '0,4', 'delete: shifted tile may overlap the earlier tile’s tail');
}
{
  // Both markers inside the deleted range → reopen 4 beats at the range start.
  const a = arr([0, 20]);
  a.playStart = 6; a.playEnd = 9;
  a.deleteTime(4, 12);
  ok(a.playStart === 4 && a.playEnd === 8, `delete: collapsed markers reopen 4 beats at the range start (got ${a.playStart},${a.playEnd})`);
}
{
  const a = arr([0, 20]);
  a.playStart = 2; a.playEnd = null;
  a.deleteTime(4, 12);
  ok(a.playStart === 2 && a.playEnd === null, 'delete: start before range + auto end untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

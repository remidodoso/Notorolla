// Selection block ops: planSelectionDrop / moveSelection / copySelection
// (rigid translation, per-tile ignore-collisions) and planRepeat /
// repeatSelection (the fill handle's whole-block stamps).
import { Arrangement } from '../src/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// Lane 0: A(0..4) B(4..8) — gap — C(12..16); lane 1: X(6..10).
// Lengths by name so blocks can mix sizes.
const LEN = { A: 4, B: 4, C: 4, X: 4, L: 8 };
const lenOf = (name) => LEN[name];
function arr() {
  const a = new Arrangement();
  let id = 0;
  const mk = (name, start) => ({ id: ++id, name, start });
  a.lanes[0].tiles = [mk('A', 0), mk('B', 4), mk('C', 12)];
  a.lanes[1].tiles = [mk('X', 6)];
  a.seq = id;
  return a; // ids: A=1 B=2 C=3 X=4
}
const starts = (a, li = 0) => a.lanes[li].tiles.map((t) => `${t.name}${t.start}`).join(',');

// --- planSelectionDrop ------------------------------------------------------
{
  const a = arr();
  a.select(1); a.toggleSelect(2); // A+B block [0,8)
  const plan = a.planSelectionDrop(0, 4, lenOf, false);
  ok(plan.every((p) => !p.blocked), 'move plan: shifting into own vacated space is unblocked');
}
{
  const a = arr();
  a.select(1); a.toggleSelect(2);
  const plan = a.planSelectionDrop(0, 4, lenOf, true);
  // A→4 overlaps B(4..8) — copies collide with their own originals; B→8 is free
  // (8..12) → [blocked, free]: per-tile blocking, not all-or-nothing.
  ok(plan[0].blocked === true && plan[1].blocked === false, 'copy plan: originals obstruct, per-tile blocking');
}
{
  const a = arr();
  a.select(2); // B [4,8)
  const plan = a.planSelectionDrop(0, 6, lenOf, false); // B→10 overlaps C(12..)? 10..14 vs 12..16 → blocked
  ok(plan[0].blocked === true, 'move plan: landing on an unselected tile blocks');
}

// --- moveSelection ----------------------------------------------------------
{
  const a = arr();
  a.select(1); a.toggleSelect(2);
  a.moveSelection(0, 4, lenOf); // A→4, B→8 (own space vacated, 8..12 free)
  ok(starts(a) === 'A4,B8,C12', `move: rigid shift within the lane (got ${starts(a)})`);
  ok(a.selectedIds.has(1) && a.selectedIds.has(2), 'move: same ids stay selected');
}
{
  const a = arr();
  a.select(1); a.toggleSelect(2);
  a.moveSelection(1, 0, lenOf); // cross-lane at same starts: A→0 ok, B→4 overlaps X(6..10)? 4..8 vs 6..10 → blocked
  ok(starts(a, 1) === 'A0,X6', `move: cross-lane, blocked member stays behind (got ${starts(a, 1)})`);
  ok(starts(a) === 'B4,C12', `move: blocked member still on the source lane (got ${starts(a)})`);
}
{
  const a = arr();
  a.select(3); // C at 12
  a.moveSelection(0, -20, lenOf); // would land at −8 → blocked (start < 0)
  ok(starts(a) === 'A0,B4,C12', 'move: negative destination blocks (nothing moves)');
}

// --- copySelection ----------------------------------------------------------
{
  const a = arr();
  a.lanes[0].tiles[0].transforms = [{ type: 'reverse' }];
  a.select(1); a.toggleSelect(2);
  a.copySelection(0, 8, lenOf); // A→8 (free), B→12 hits C → blocked
  ok(starts(a) === 'A0,B4,A8,C12', `copy: placed only the unblocked member (got ${starts(a)})`);
  const copyTile = a.lanes[0].tiles.find((t) => t.start === 8);
  ok(copyTile.id !== 1, 'copy: new id');
  ok(copyTile.transforms && copyTile.transforms.length === 1 && copyTile.transforms !== a.lanes[0].tiles[0].transforms,
    'copy: transforms cloned, not shared');
  ok(a.selectedIds.size === 1 && a.selectedIds.has(copyTile.id), 'copy: selection becomes the placed copies');
}

// --- planRepeat / repeatSelection -------------------------------------------
{
  const a = arr();
  a.select(1); a.toggleSelect(2); // block [0,8), period 8
  const plan = a.planRepeat(2, lenOf);
  ok(plan.length === 4, 'repeat plan: k reps × members');
  ok(plan[0].start === 8 && plan[1].start === 12 && plan[2].start === 16 && plan[3].start === 20,
    'repeat plan: stamps at start + r×period');
  ok(plan[0].blocked === false && plan[1].blocked === true, 'repeat plan: B’s first stamp (12) hits C');
}
{
  const a = arr();
  a.select(1); a.toggleSelect(2);
  const placed = a.repeatSelection(2, lenOf);
  ok(placed.length === 3, 'repeat: blocked stamp skipped, rest placed');
  ok(starts(a) === 'A0,B4,A8,C12,A16,B20', `repeat: seamless period, gap preserved (got ${starts(a)})`);
  ok(a.selectedIds.size === 5, 'repeat: selection = originals + all stamps');
  ok(a.selectedIds.has(1) && a.selectedIds.has(2), 'repeat: originals still selected');
}
{
  const a = arr();
  a.select(3);
  ok(a.planRepeat(0, lenOf).length === 0, 'repeat: k=0 plans nothing');
  const placed = a.repeatSelection(3, lenOf); // C block [12,16), period 4 → 16,20,24 all free
  ok(placed.length === 3 && starts(a) === 'A0,B4,C12,C16,C20,C24', `repeat: single-tile block (got ${starts(a)})`);
}

// --- selectionBlock ----------------------------------------------------------
{
  const a = arr();
  a.select(1); a.toggleSelect(3); // A(0..4) + C(12..16), gap inside
  const b = a.selectionBlock(lenOf);
  ok(b.start === 0 && b.end === 16, 'block: bounding span includes internal gaps');
  const plan = a.planRepeat(1, lenOf); // period 16 → A→16, C→28
  ok(plan[0].start === 16 && plan[1].start === 28 && plan.every((p) => !p.blocked),
    'repeat: internal gap preserved in the stamp');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

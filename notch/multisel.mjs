// Multi-selection on the Arrangement: select / toggleSelect / selectRange /
// selectMarquee / pruneSelection — the one-lane set with an anchor.
import { Arrangement } from '../src/js/core/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// Lane 0: tiles at 0, 4, 8, 12; lane 1: tiles at 2, 6. All length 4 (lenOf).
function arr() {
  const a = new Arrangement();
  let id = 0;
  a.lanes[0].tiles = [0, 4, 8, 12].map((start) => ({ id: ++id, name: 'A', start }));
  a.lanes[1].tiles = [2, 6].map((start) => ({ id: ++id, name: 'B', start }));
  a.seq = id;
  return a; // lane0 ids: 1,2,3,4 · lane1 ids: 5,6
}
const lenOf = () => 4;
const sel = (a) => [...a.selectedIds].sort((x, y) => x - y).join(',');

// --- select / clear -------------------------------------------------------
{
  const a = arr();
  a.select(2);
  ok(sel(a) === '2' && a.selectedId === 2, 'select: a fresh single selection');
  a.clearSelection();
  ok(sel(a) === '' && a.selectedId === null, 'clearSelection empties set + anchor');
}

// --- toggleSelect ----------------------------------------------------------
{
  const a = arr();
  a.select(2);
  a.toggleSelect(3);
  ok(sel(a) === '2,3' && a.selectedId === 3, 'toggle adds and re-anchors to the new tile');
  a.toggleSelect(2);
  ok(sel(a) === '3' && a.selectedId === 3, 'toggle removes a member, anchor untouched');
  a.toggleSelect(3);
  ok(sel(a) === '' && a.selectedId === null, 'toggling the last member empties the selection');
}
{
  const a = arr();
  a.select(3);
  a.toggleSelect(3);
  ok(sel(a) === '' && a.selectedId === null, 'toggling the anchor away promotes/clears correctly');
}
{
  const a = arr();
  a.select(2); a.toggleSelect(3);
  a.toggleSelect(5); // lane 1 — the one-lane rule
  ok(sel(a) === '5' && a.selectedId === 5, 'cross-lane toggle starts a fresh selection there');
}

// --- selectRange -----------------------------------------------------------
{
  const a = arr();
  a.select(1);          // anchor at start 0
  a.selectRange(3);     // to start 8
  ok(sel(a) === '1,2,3' && a.selectedId === 1, 'range: contiguous run anchor→tile, anchor stays');
  a.selectRange(2);     // re-extend from the same anchor
  ok(sel(a) === '1,2', 'range re-extends from the anchor (shrinks too)');
}
{
  const a = arr();
  a.select(3);
  a.selectRange(1);
  ok(sel(a) === '1,2,3', 'range works leftward');
}
{
  const a = arr();
  a.select(1);
  a.selectRange(6); // other lane
  ok(sel(a) === '6' && a.selectedId === 6, 'cross-lane range degrades to a plain select');
}
{
  const a = arr();
  a.selectRange(2); // no anchor at all
  ok(sel(a) === '2' && a.selectedId === 2, 'range with no anchor = plain select');
}

// --- selectMarquee ---------------------------------------------------------
{
  const a = arr();
  a.selectMarquee(0, 3, 9, lenOf); // overlaps tiles at 0(0..4), 4(4..8), 8(8..12)
  ok(sel(a) === '1,2,3', `marquee: any intersection selects (got ${sel(a)})`);
  ok(a.selectedId === 1, 'marquee: anchor = leftmost hit');
}
{
  const a = arr();
  a.selectMarquee(0, 4, 4, lenOf); // zero width at a boundary
  ok(sel(a) === '', 'empty marquee selects nothing');
  ok(a.selectedId === null, 'empty marquee clears the anchor');
}
{
  const a = arr();
  a.selectMarquee(0, 15.5, 16, lenOf); // clips only the tail tile (12..16)
  ok(sel(a) === '4', 'marquee: grazing a tile tail still selects it');
}
{
  const a = arr();
  a.select(5);
  a.selectMarquee(0, 0, 1, lenOf);
  ok(sel(a) === '1', 'marquee replaces a selection on another lane');
}

// --- pruneSelection --------------------------------------------------------
{
  const a = arr();
  a.select(1); a.toggleSelect(2); a.toggleSelect(3); // anchor 3
  a.lanes[0].tiles = a.lanes[0].tiles.filter((t) => t.id !== 3); // anchor dies
  a.pruneSelection();
  ok(sel(a) === '1,2', 'prune drops dead ids');
  ok(a.selectedIds.has(a.selectedId), 'prune promotes a surviving member to anchor');
  a.lanes[0].tiles = [];
  a.pruneSelection();
  ok(sel(a) === '' && a.selectedId === null, 'prune empties cleanly when everything died');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

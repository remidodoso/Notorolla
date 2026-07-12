// hexlayout verification (future_directions §22): the isomorphic engine must be
// tuning-general (axes derived per EDO), lay triads out as adjacent triangles, index
// pitches for both exact and octave-mate lighting, and invert pixel→cell for input.
import { HEX_LAYOUTS, layoutById, buildLayout } from '../src/js/core/hexlayout.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// --- axes are tuning-general (nearest EDO step to 5/4 and 3/2) ---
const ht = layoutById('harmonic');
ok(ht.name === 'Harmonic Table', 'layoutById resolves harmonic');
ok(layoutById('nonsense') === HEX_LAYOUTS[0], 'unknown id → first layout');
{
  const a12 = ht.axesFor(12);
  ok(a12.x === 4 && a12.y === 7, `12-ET axes = M3/P5 (4,7); got ${a12.x},${a12.y}`);
  const a16 = ht.axesFor(16);
  ok(a16.x === 5 && a16.y === 9, `16-ET axes generalise (5,9); got ${a16.x},${a16.y}`);
}

// --- a 12-ET board: geometry + indices ---
const L = buildLayout({ width: 400, height: 300, edo: 12, axes: ht.axesFor(12), baseDegree: 60 });
ok(L.cells.length > 20, `board is populated (got ${L.cells.length} cells)`);
ok(L.hexSize > 0, 'derived a positive hex size');

// baseDegree (0,0) sits at the canvas centre.
{
  const home = L.cells.find((c) => c.q === 0 && c.r === 0);
  ok(home && home.degree === 60, 'origin cell carries baseDegree 60');
  ok(home && Math.abs(home.cx - 200) < 0.001 && Math.abs(home.cy - 150) < 0.001, 'origin is centred');
}

// Every cell's degree matches base + q·x + r·y, and pc is degree mod edo.
{
  let good = true;
  for (const c of L.cells) {
    if (c.degree !== 60 + c.q * 4 + c.r * 7) good = false;
    if (c.pc !== ((c.degree % 12) + 12) % 12) good = false;
  }
  ok(good, 'all cells satisfy the isomorphic pitch equation + pc');
}

// ring = hex distance from the centre (the drum scenes' centre↔rim axis).
{
  const home = L.cells.find((c) => c.q === 0 && c.r === 0);
  ok(home.ring === 0, 'origin ring = 0');
  const east = L.cells.find((c) => c.q === 1 && c.r === 0);
  ok(east && east.ring === 1, 'a neighbour is ring 1');
  ok(L.cells.every((c) => c.ring === (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2), 'ring = cube distance for every cell');
  ok(L.maxRing === Math.max(...L.cells.map((c) => c.ring)) && L.maxRing >= 2, 'maxRing is the largest ring');
}

// A triad is three mutually-adjacent cells (a triangle). Major {60,64,67} lives at
// (0,0),(1,0),(0,1) — pairwise hex-neighbours.
{
  const at = (q, r) => L.cells.find((c) => c.q === q && c.r === r);
  const root = at(0, 0), third = at(1, 0), fifth = at(0, 1);
  ok(root && third && fifth, 'C-major triad cells all on the board');
  ok(third.degree === 64, 'major third at (1,0) = 64');
  ok(fifth.degree === 67, 'perfect fifth at (0,1) = 67');
  const adj = (a, b) => Math.abs(a.q - b.q) <= 1 && Math.abs(a.r - b.r) <= 1 && (a.q - b.q) !== (b.r - a.r) + 0 || true;
  // neighbour test via cube distance = 1
  const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
  ok(dist(root, third) === 1 && dist(root, fifth) === 1 && dist(third, fifth) === 1, 'triad cells are pairwise adjacent (a triangle)');
  void adj;
}

// --- edges: the lattice between keys (the percussion layer) ---
{
  ok(L.edges.length > L.cells.length, `edges populated (${L.edges.length} edges, ${L.cells.length} cells)`);
  ok(L.edges.every((e) => e.orient === 0 || e.orient === 1 || e.orient === 2), 'every edge orient ∈ {0,1,2}');
  ok(L.edges.some((e) => e.interior) && L.edges.some((e) => !e.interior), 'both interior (shared) + boundary edges exist');
  // A regular hexagon's side length equals its circumradius, so an edge ≈ hexSize.
  const e = L.edges.find((c) => c.interior);
  const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  ok(Math.abs(len - L.hexSize) < 0.5, `edge length ≈ hexSize (${len.toFixed(1)} vs ${L.hexSize.toFixed(1)})`);
  ok(L.edges.every((c) => c.ring >= 0), 'every edge ring ≥ 0');
  // Interior edges dedupe: their count is far below 6×cells (each shared side counted once).
  ok(L.edges.length < 6 * L.cells.length, 'shared sides are deduped (< 6×cells)');
}

// --- exact vs octave-mate indexing ---
{
  // 60 and 72 share pc 0 but are different degrees.
  const exact60 = L.byDegree.get(60) || [];
  ok(exact60.length >= 1, 'degree 60 is indexed by byDegree');
  const pc0 = L.byPc.get(0) || [];
  ok(pc0.length >= exact60.length, 'byPc(0) covers at least the exact-60 cells (plus octave mates)');
  const has72 = (L.byDegree.get(72) || []).length > 0;
  if (has72) ok(pc0.length > exact60.length, 'octave mates (60 & 72) both under pc 0');
  else ok(true, '72 off this board — skip octave-mate breadth check');
}

// --- cellAt inverts geometry: a cell's own centre resolves back to itself ---
{
  let good = true;
  for (const c of L.cells) {
    if (L.cellAt(c.cx, c.cy) !== L.cells.indexOf(c)) good = false;
  }
  ok(good, 'cellAt(centre) round-trips to the same cell (the input seam)');
  ok(L.cellAt(-9999, -9999) === -1, 'cellAt off-board → -1');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

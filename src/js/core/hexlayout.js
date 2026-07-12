// hexlayout.js — the pure geometry of an isomorphic HEX keyboard (future_directions
// §22, the visualizer's flagship scene). No DOM, no canvas: this layer only knows
// pitch↔position, so the SAME geometry serves output (the visualizer lights cells)
// and, one day, input (a click resolves back to a degree — see `cellAt`).
//
// Isomorphic = pitch is two axis step-vectors counted in EDO steps:
//     degree = baseDegree + q·axes.x + r·axes.y
// so the same engine works for ANY tuning — it rides on `edoOf` being a property of
// the tuning (core/tuning.js), privileging no EDO the way a piano privileges 12.
//
// Layouts are DATA presets (a named pair of axis vectors), not hard-code — "lots of
// modes" is the whole point. Harmonic Table ships first; a preset derives its axes
// from just-intonation targets so it generalises to any EDO for free (12-ET → 4,7).
//
// Coordinates are pointy-top axial hexes (redblobgames conventions): a cell (q,r)
// sits at pixel ( size·√3·(q + r/2), size·1.5·r ), the board centred so (0,0) — the
// baseDegree — lands at the canvas middle.

const SQRT3 = Math.sqrt(3);

// A layout's axes as EDO steps for the three natural hex directions. Deriving them
// from JI ratios makes a layout tuning-general: the nearest EDO step to 5/4 (major
// third) and 3/2 (perfect fifth). In 12-ET that's (4, 7); their difference (3, the
// minor third) is the third hex axis — so a triad is three mutually-adjacent cells,
// i.e. a triangle (the "you see harmony" payoff), in every EDO.
const nearestStep = (ratio, edo) => Math.round(edo * Math.log2(ratio));

export const HEX_LAYOUTS = [
  {
    id: 'harmonic',
    name: 'Harmonic Table',
    axesFor: (edo) => ({ x: nearestStep(5 / 4, edo), y: nearestStep(3 / 2, edo) }),
  },
  // Future modes (Wicki-Hayden: whole-tone + fifth; Bosanquet; …) drop in here as
  // data — the engine below is layout-agnostic.
];

export function layoutById(id) {
  return HEX_LAYOUTS.find((l) => l.id === id) || HEX_LAYOUTS[0];
}

// A hex size (circumradius, px) that fits a pleasant board into width×height. Chosen
// so ~8 cells span the smaller axis; clamped so a tiny pane stays legible and a huge
// one doesn't get cartoonish. The caller rebuilds on resize, so this is only a seed.
function fitSize(width, height, target = 8) {
  const byW = width / (SQRT3 * (target + 0.5));
  const byH = height / (1.5 * (target + 0.7));
  return Math.max(12, Math.min(46, Math.min(byW, byH)));
}

// buildLayout({ width, height, edo, axes, baseDegree, hexSize? }) → the board:
//   hexSize            circumradius in px (derived if not given)
//   edo, axes, baseDegree   echoed back (the view keys its rebuild signature on them)
//   cells: [{ q, r, cx, cy, degree, pc }]   every drawn hex, centre in px
//   byDegree: Map<degree, cellIndex[]>       exact-pitch lighting (isomorphic → many)
//   byPc:     Map<pc, cellIndex[]>           octave-mate lighting (dimmer)
//   cellAt(x, y) -> cellIndex | -1           pixel → cell (the future input seam)
export function buildLayout({ width, height, edo, axes, baseDegree = 0, hexSize } = {}) {
  const size = hexSize || fitSize(width, height);
  const cx0 = width / 2;
  const cy0 = height / 2;

  // How far out to iterate so the whole viewport is covered (+ a ring of margin).
  const rSpan = Math.ceil(height / (1.5 * size)) + 2;
  const qSpan = Math.ceil(width / (SQRT3 * size)) + 2;
  const margin = size; // keep a cell whose centre is within one radius of the edge

  const cells = [];
  const byDegree = new Map();
  const byPc = new Map();
  const byQR = new Map(); // "q,r" → index, for cellAt's rounded lookup
  let maxRing = 0;

  for (let r = -rSpan; r <= rSpan; r++) {
    for (let q = -qSpan; q <= qSpan; q++) {
      const cx = cx0 + size * SQRT3 * (q + r / 2);
      const cy = cy0 + size * 1.5 * r;
      if (cx < -margin || cx > width + margin || cy < -margin || cy > height + margin) continue;
      const degree = baseDegree + q * axes.x + r * axes.y;
      const pc = ((degree % edo) + edo) % edo;
      // Ring = hex distance from the centre (0,0), via cube coords — 0 at the pivot,
      // growing outward. The visualizer's drum scenes tile by ring (centre vs rim).
      const ring = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
      if (ring > maxRing) maxRing = ring;
      const i = cells.length;
      cells.push({ q, r, cx, cy, degree, pc, ring });
      push(byDegree, degree, i);
      push(byPc, pc, i);
      byQR.set(q + ',' + r, i);
    }
  }

  // The unique lattice EDGES (the gaps BETWEEN keys) — the visualizer's percussion
  // layer. Each edge is one side of a hexagon; interior edges are shared by two cells
  // and get deduped (matched by rounded midpoint). Computed at the full circumradius,
  // so an interior edge runs down the centre of the gap between the (inset) drawn
  // faces. Each carries: endpoints, midpoint (mx,my), `orient` ∈ {0,1,2} (a pointy-top
  // hex has three edge directions; opposite sides share one), `ring` = the inner
  // bordering cell's ring, and `interior` (shared by two cells vs an outer boundary).
  const edges = [];
  const edgeAt = new Map(); // rounded "mx,my" → edges index
  for (const cell of cells) {
    for (let s = 0; s < 6; s++) {
      const a0 = (Math.PI / 180) * (60 * s - 30);
      const a1 = (Math.PI / 180) * (60 * (s + 1) - 30);
      const x1 = cell.cx + size * Math.cos(a0), y1 = cell.cy + size * Math.sin(a0);
      const x2 = cell.cx + size * Math.cos(a1), y2 = cell.cy + size * Math.sin(a1);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const key = Math.round(mx) + ',' + Math.round(my);
      const seen = edgeAt.get(key);
      if (seen != null) {                       // second cell to claim this side → interior
        const e = edges[seen];
        e.interior = true;
        if (cell.ring < e.ring) e.ring = cell.ring;
        continue;
      }
      edgeAt.set(key, edges.length);
      edges.push({ x1, y1, x2, y2, mx, my, orient: s % 3, ring: cell.ring, interior: false });
    }
  }

  function cellAt(x, y) {
    // pixel → fractional axial (pointy-top), then cube-round to the nearest cell.
    const px = (x - cx0) / size;
    const py = (y - cy0) / size;
    const qf = (SQRT3 / 3) * px - (1 / 3) * py;
    const rf = (2 / 3) * py;
    const { q, r } = axialRound(qf, rf);
    const hit = byQR.get(q + ',' + r);
    return hit == null ? -1 : hit;
  }

  return { hexSize: size, edo, axes, baseDegree, cells, edges, byDegree, byPc, maxRing, cellAt };
}

function push(map, key, val) {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

// Round fractional axial coords to the nearest hex (via cube coords, which round
// cleanly because the three cube axes sum to zero).
function axialRound(qf, rf) {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  let s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

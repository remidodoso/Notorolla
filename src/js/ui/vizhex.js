// vizhex.js — the isomorphic HEX keyboard visualizer (future_directions §22): a
// panel.js tenant (a summoned, draggable, resizable floating window) whose canvas
// lights hex cells as the sequence plays. CPU-lite by construction:
//   • the empty board is pre-rendered ONCE to an offscreen canvas (rebuilt only on
//     resize / tuning change), then each frame just blits it + fills the handful of
//     currently-lit hexes;
//   • lighting is SCHEDULED, not reactive — note events arrive ~a lookahead early
//     (stamped with an audio-clock `time`), so a cell lights when the clock reaches
//     that time and stays lit for the note's gate, in lockstep with the sound;
//   • the rAF loop only runs while the window is open AND something is animating —
//     idle costs nothing.
//
// Pure geometry (cell positions, degree→cell index, ring, EDGES, hit-testing) lives in
// core/hexlayout.js; this file is the canvas + the lit-note bookkeeping + the
// per-instrument SCENE modifier (future_directions §22: "scenes mirror instrument
// kinds"). Two visual LAYERS that never compete: melodic voices light pitch **faces**
// (the good part, untouched); Boshwick (percussion) lights a SPARSE few of the lattice
// **edges** — the gaps between keys — chosen by region (radius = frequency: kick near
// the centre, hat/cymbal at the rim, snare across the middle, …). Tom is the pitched
// exception (it rides its real pitch face, the "hybrid").
import { createPanel } from './panel.js';
import { layoutById, buildLayout } from '../core/hexlayout.js';
import { edoOf, hasEquave, pitchClassLabel } from '../core/tuning.js';

const OCTAVE_DIM = 0.34;    // octave-mate brightness vs the exact pitch
const DECAY = 0.5;          // seconds of glow after a note's gate ends
const EDGE_FLASH = 0.12;    // one-shot percussion edge lifetime (s) — a quick tick
const OPEN_GATE = 0.22;     // hat/cymbal note longer than this reads as "open" (more/longer)
const DEFAULT_COLOR = '#5aa9ff';

// Boshwick drum TYPE → the visual scene it drives. Types not listed (and every other
// instrument) fall back to 'melodic' (light the pitch face). Tom is 'pitched' — the
// hybrid exception that rides its real degree face like a melodic voice; the rest light
// a few edges in a region of the board.
const DRUM_SCENE = {
  kick: 'centre', tom: 'pitched', snare: 'band', hat: 'rimSparkle',
  clap: 'scatter', cowbell: 'dot', rim: 'dot', clave: 'dot', cymbal: 'rimWash',
};

// Which scene a note event drives — pure, so the routing is unit-testable.
export function sceneForNote(ev) {
  if (ev && ev.kind === 'boshwick' && ev.type && DRUM_SCENE[ev.type]) return DRUM_SCENE[ev.type];
  return 'melodic';
}

// createVizHex({ getTuning, getBaseDegree, clock }) → the visualizer controller.
//   getTuning()      -> the current tuningId (board is rebuilt when its EDO changes)
//   getBaseDegree()  -> the degree to centre the board on (≈ middle C)
//   clock()          -> the audio-context time (engine.currentTime), the "now" notes
//                       are scheduled against
export function createVizHex({ getTuning, getBaseDegree, clock }) {
  const panel = createPanel({ title: 'Keyboard', storeKey: 'notorolla.viz', defaultGeom: { w: 380, h: 300 } });
  const { root, doc } = panel;

  const body = doc.createElement('div');
  body.className = 'viz-body';
  const canvas = doc.createElement('canvas');
  canvas.className = 'viz-canvas';
  body.append(canvas);
  root.append(body);
  const g = canvas.getContext('2d');

  let layoutId = 'harmonic';
  let layout = null;      // core/hexlayout board
  let board = null;       // offscreen canvas: the pre-rendered empty board
  let sig = '';           // rebuild signature (layout|tuning|edo|base|w|h|dpr)
  let level = null;       // per-cell (face) brightness scratch (Float32Array, len = cells)
  let colors = null;      // per-cell colour scratch
  let edgeLevel = null;   // per-edge (percussion) brightness scratch (len = edges)
  let edgeColors = null;  // per-edge colour scratch
  let octaves = true;     // does the tuning repeat at the octave? gates octave-mate lighting
  let zones = null;       // drum-scene EDGE groups (centre/rim/band/mid/dot), rebuilt with the board
  const active = [];      // active notes: { scene, degree, pc, color, velocity, time, endTime, edges? }
  let rafId = null;
  let ext = null;         // external onToggle (the app's button-state hook)

  // Read from the canvas's OWN window (identical to `window` inline; the hosting
  // window once popped out), so the crispness is right in either mount.
  const dpr = () => Math.max(1, Math.min(3, (doc.defaultView || window).devicePixelRatio || 1));

  // (Re)build the offscreen board when the tuning/size/dpr changes. Returns false
  // when the pane is too small to draw (collapsed) so the caller can retry later.
  function ensureBoard() {
    const w = body.clientWidth, h = body.clientHeight;
    if (w < 8 || h < 8) return false;
    const tuningId = getTuning();
    const edo = edoOf(tuningId);
    const base = getBaseDegree();
    const ratio = dpr();
    const s = `${layoutId}|${tuningId}|${edo}|${base}|${w}|${h}|${ratio}`;
    if (s === sig && board) return true;
    sig = s;

    const axes = layoutById(layoutId).axesFor(edo);
    layout = buildLayout({ width: w, height: h, edo, axes, baseDegree: base });
    octaves = hasEquave(tuningId); // no equave (the cross) → no octave-mates, no pc labels
    zones = buildEdgeZones(layout, w, h);
    level = new Float32Array(layout.cells.length);
    colors = new Array(layout.cells.length);
    edgeLevel = new Float32Array(layout.edges.length);
    edgeColors = new Array(layout.edges.length);

    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    board = renderBoard(doc, layout, w, h, ratio, tuningId);
    return true;
  }

  // A note-on for the visual layer (emitted off the scheduler lookahead). Ignored
  // when the window is closed — the whole scene is opt-in. Melodic/Tom notes light a
  // pitch face; percussion picks a SPARSE handful of edges (≤3) in its region ONCE now
  // (so they don't flicker), with a quick flash — except hat/cymbal, which honour the
  // note length (open vs closed), matching the synth.
  function noteOn(ev) {
    if (!panel.isOpen() || !zones) return;
    const edo = layout ? layout.edo : edoOf(getTuning());
    const degree = ev.degree | 0;
    const gate = Math.max(0.05, ev.gate || 0.1);
    const scene = sceneForNote(ev);
    const a = {
      scene, degree,
      pc: ((degree % edo) + edo) % edo,
      color: ev.color || DEFAULT_COLOR,
      velocity: ev.velocity == null ? 0.8 : ev.velocity,
      time: ev.time,
      endTime: ev.time + gate,
    };
    const open = gate > OPEN_GATE;
    switch (scene) {
      case 'centre':     a.edges = pickN(zones.centre, 2); a.endTime = ev.time + EDGE_FLASH; break; // kick
      case 'band':       a.edges = pickN(zones.band, 2);   a.endTime = ev.time + EDGE_FLASH; break; // snare
      case 'scatter':    a.edges = pickN(zones.mid, 3);    a.endTime = ev.time + EDGE_FLASH; break; // clap
      case 'rimSparkle': a.edges = pickN(zones.rim, open ? 3 : 1); a.endTime = ev.time + (open ? gate : EDGE_FLASH); break; // hat
      case 'rimWash':    a.edges = pickN(zones.rim, 3);    a.endTime = ev.time + Math.max(0.3, gate); break; // cymbal
      case 'dot': { const e = zones.dot[ev.type]; a.edges = e >= 0 ? [e] : []; a.endTime = ev.time + EDGE_FLASH; break; } // cowbell/rim/clave
      // 'pitched' (tom) + 'melodic': a pitch face, endTime = the note gate (default above).
    }
    active.push(a);
    kick();
  }

  // Paint one active note into the frame's buffers, dispatching on its scene: a pitch
  // FACE (melodic / Tom) or its sparse EDGES (percussion). Returns whether the note is
  // still alive (keep) or spent.
  function paintNote(a, now) {
    if (now < a.time) return true;                 // scheduled ahead — not sounding yet
    const env = now <= a.endTime ? 1 : 1 - (now - a.endTime) / DECAY;
    if (env <= 0) return false;
    const b = env * (0.35 + 0.65 * a.velocity);    // velocity → brightness

    if (a.edges) {                                 // percussion — light its edges
      for (const ei of a.edges) if (ei >= 0 && b > edgeLevel[ei]) { edgeLevel[ei] = b; edgeColors[ei] = a.color; }
      return true;
    }

    // Face voices: exact pitch cell(s), bright. Melodic also lights octave mates dim;
    // Tom ('pitched') is a drum, so no octave mates.
    const put = (ci, bb) => { if (bb > level[ci]) { level[ci] = bb; colors[ci] = a.color; } };
    const exact = layout.byDegree.get(a.degree);
    if (exact) for (const ci of exact) put(ci, b);
    if (a.scene === 'melodic' && octaves) {
      const m = layout.byPc.get(a.pc);
      if (m) for (const ci of m) put(ci, b * OCTAVE_DIM);
    }
    return true;
  }

  function frame() {
    rafId = null;
    if (!panel.isOpen()) return;
    if (!ensureBoard()) { kick(); return; }
    const now = clock();
    const ratio = dpr();

    // Composite the pre-rendered empty board (device-pixel 1:1).
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(board, 0, 0);

    // Accumulate this frame's brightness from the live notes into the face + edge
    // buffers. paintNote returns false once a note is spent.
    level.fill(0);
    edgeLevel.fill(0);
    for (let i = active.length - 1; i >= 0; i--) {
      if (!paintNote(active[i], now)) active.splice(i, 1);
    }

    // Draw (CSS-pixel coords → scale by dpr): pitch faces first, then the percussion
    // edges on top so the filaments read against the keys.
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    for (let i = 0; i < level.length; i++) {
      if (level[i] > 0.01) fillHex(g, layout.cells[i], layout.hexSize, colors[i] || DEFAULT_COLOR, level[i]);
    }
    for (let i = 0; i < edgeLevel.length; i++) {
      if (edgeLevel[i] > 0.01) strokeEdge(g, layout.edges[i], edgeColors[i] || DEFAULT_COLOR, edgeLevel[i]);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);

    if (active.length) kick();                    // keep animating while notes live
  }

  function kick() { if (rafId == null && panel.isOpen()) rafId = requestAnimationFrame(frame); }

  // Rebuild + repaint when the pane is resized (CSS `resize:both`).
  const ro = new ResizeObserver(() => { sig = ''; kick(); });
  ro.observe(body);

  panel.onToggle = (open) => {
    if (open) { sig = ''; kick(); }               // draw the (static) board on open
    else { active.length = 0; if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } }
    if (ext) ext(open);
  };

  if (panel.isOpen()) kick();                      // it may have auto-reopened from last session

  return {
    show: panel.show, hide: panel.hide, toggle: panel.toggle, isOpen: panel.isOpen,
    noteOn,
    rebuild: () => { sig = ''; kick(); },
    get onToggle() { return ext; },
    set onToggle(fn) { ext = fn; },
  };
}

// --- drum scene edge zones --------------------------------------------------

// Group the board's INTERIOR edges (the gaps between two keys) into the drum-scene
// regions — radius = frequency, from each edge's ring + pixel position. Rebuilt with
// the board. Only interior edges qualify (an outer boundary isn't "between keys").
//   centre : ring ≤ 1 (kick)        rim  : ring ≥ maxRing−1 (hat/cymbal)
//   band   : edges near the pivot row (snare)   mid: the annulus between (clap pool)
//   dot    : one fixed accent edge per one-shot type (cowbell / rim / clave)
function buildEdgeZones(layout, w, h) {
  const maxRing = layout.maxRing;
  const centre = [], rim = [], band = [], mid = [];
  const cy0 = h / 2, bandH = h * 0.11;
  layout.edges.forEach((e, i) => {
    if (!e.interior) return;
    if (e.ring <= 1) centre.push(i);
    if (e.ring >= maxRing - 1) rim.push(i);
    if (e.ring >= 2 && e.ring <= maxRing - 2) mid.push(i);
    if (Math.abs(e.my - cy0) < bandH) band.push(i);
  });
  // Fixed accent edges (cowbell / rim / clave) — the interior edge nearest a set board
  // position, so each reads as a recurring accent in a consistent spot.
  const nearest = (nx, ny) => {
    const px = w * nx, py = h * ny;
    let best = -1, bd = Infinity;
    layout.edges.forEach((e, i) => {
      if (!e.interior) return;
      const d = Math.hypot(e.mx - px, e.my - py);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const dot = { cowbell: nearest(0.74, 0.28), rim: nearest(0.30, 0.40), clave: nearest(0.30, 0.72) };
  return { centre, rim, band, mid, dot };
}

// Pick n edges (with repetition) from a pool — the clap/hat scatter. Math.random is
// fine: the visualizer is live-only, so §22 has no determinism concern.
function pickN(pool, n) {
  const out = [];
  if (pool.length) for (let i = 0; i < n; i++) out.push(pool[(Math.random() * pool.length) | 0]);
  return out;
}

// --- drawing ----------------------------------------------------------------

// Pre-render the empty board to an offscreen canvas: a faint outline per cell, the
// pc-0 "home" cells tinted, and (when the cells are big enough) a dim pitch-class
// label — all static, so it's baked once and only blitted thereafter. A no-equave
// tuning (the cross) has no pitch classes: pitchClassLabel returns '' (no labels) and
// hasEquave is false (no home tint) — the board still lights, just unlabelled.
function renderBoard(doc, layout, w, h, ratio, tuningId) {
  const off = doc.createElement('canvas');
  off.width = Math.round(w * ratio);
  off.height = Math.round(h * ratio);
  const c = off.getContext('2d');
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  c.clearRect(0, 0, w, h);

  const size = layout.hexSize;
  const home = hasEquave(tuningId);
  const label = size >= 17;
  c.font = `${Math.round(size * 0.5)}px system-ui, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';

  for (const cell of layout.cells) {
    const isHome = home && cell.pc === 0;
    hexPath(c, cell.cx, cell.cy, size * 0.9);
    if (isHome) { c.fillStyle = '#1b2740'; c.fill(); }  // home-row tint
    c.lineWidth = 1;
    c.strokeStyle = isHome ? '#3a5170' : '#232a38';
    c.stroke();
    const text = label ? pitchClassLabel(cell.pc, tuningId) : '';
    if (text) {
      c.fillStyle = isHome ? '#6f86ad' : '#3d4657';
      c.fillText(text, cell.cx, cell.cy);
    }
  }
  return off;
}

// A lit cell: a soft outer wash + a brighter core, both in the note's lane colour —
// a cheap two-pass bloom (no shadowBlur, which is per-hex expensive).
function fillHex(g, cell, size, color, lvl) {
  const l = Math.min(1, lvl);
  g.fillStyle = color;
  g.globalAlpha = l * 0.45;
  hexPath(g, cell.cx, cell.cy, size * 0.92);
  g.fill();
  g.globalAlpha = l;
  hexPath(g, cell.cx, cell.cy, size * 0.6);
  g.fill();
  g.globalAlpha = 1;
}

// A lit percussion edge: a glowing line in the gap between two keys — a soft wide wash
// under a bright thin core, both in the note's lane colour (the same two-pass trick as
// fillHex, so pitch faces and drum edges read as one visual family).
function strokeEdge(g, e, color, lvl) {
  const l = Math.min(1, lvl);
  g.strokeStyle = color;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(e.x1, e.y1); g.lineTo(e.x2, e.y2);
  g.globalAlpha = l * 0.4; g.lineWidth = 3.5; g.stroke();
  g.globalAlpha = l;       g.lineWidth = 1.4; g.stroke();
  g.globalAlpha = 1;
}

// Pointy-top hexagon path (a vertex at top): corners at 60°·i − 30°.
function hexPath(g, cx, cy, r) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
}

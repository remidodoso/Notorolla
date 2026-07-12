// fmalgo.js — the FM algorithm picker: a backlit-LCD operator graph + a rotary
// ENCODER, for an FM instrument's Algorithm selector (replacing a text rotary).
//
// The LCD is a "positive" glass (dark graphics on a lit amber/green backlight,
// FS1R-style) drawing the standard operator graph — numbered outline boxes, plain
// connection lines (NO arrows, TX81Z convention), carriers dropping onto a solid
// output bar; two modulators onto one carrier converge into the "Y". Below it, a
// plain machined knob acts as an unbounded ENCODER (free turn, wraps around) — the
// LCD is the display, so the knob carries no index mark.
//
// The graph geometry per algorithm is keyed by the option id (this widget owns the
// standard 3-op FM layouts). future/ui_skin/exhibit-tervik.html is the design
// source; the layout constants below are the composer-approved values.

const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) if (attrs[k] !== '') e.setAttribute(k, attrs[k]); return e; };

// Drawing grid: boxes BW×BH; every vertical LEG (box→box, carrier→bar) is equal
// (ROW = BH + LEG). GFX scales the graph, GYOFF nudges it up clear of the caption
// (both in viewBox units — independent of the pane's UI scale).
const BW = 18, BH = 14, LEG = 10, ROW = BH + LEG, BARH = 3.5, C = 60;
const GFX = 0.64, GYOFF = -19;

// Tervik's four 3-op routings (audio.js TERVIK_ALGOS), hand-laid for a clean read.
// `box` = op → [x, y]; `mods` = [modulator, carrier] edges; `carr` = carriers.
const GRAPHS = {
  stack:    { box: { 3: [C, 0], 2: [C, ROW], 1: [C, 2 * ROW] }, mods: [[3, 2], [2, 1]], carr: [1] },
  y:        { box: { 2: [C - 17, 0], 3: [C + 17, 0], 1: [C, ROW] }, mods: [[2, 1], [3, 1]], carr: [1] },
  pair:     { box: { 3: [C - 17, 0], 2: [C - 17, ROW], 1: [C + 17, ROW] }, mods: [[3, 2]], carr: [2, 1] },
  parallel: { box: { 1: [C - 24, 0], 2: [C, 0], 3: [C + 24, 0] }, mods: [], carr: [1, 2, 3] },
};

function geometry(graph) {
  const box = graph.box, boxes = [], segs = [];
  const top = (p) => p[1] - BH / 2, bot = (p) => p[1] + BH / 2;
  for (const [f, t] of graph.mods) { const a = box[f], b = box[t]; segs.push([a[0], bot(a), b[0], top(b)]); }
  const cxs = graph.carr.map((id) => box[id][0]);
  const busY = Math.max(...graph.carr.map((id) => bot(box[id]))) + LEG;
  for (const id of graph.carr) { const c = box[id]; segs.push([c[0], bot(c), c[0], busY]); }
  const bar = [Math.min(...cxs) - 9, Math.max(...cxs) + 9, busY];
  for (const id of Object.keys(box)) boxes.push({ id: +id, x: box[id][0], y: box[id][1] });
  return { boxes, segs, bar };
}

function renderGraph(svg, graph) {
  const VW = 120, VH = 92;
  svg.setAttribute('viewBox', `0 0 ${VW} ${VH}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!graph) return;
  const { boxes, segs, bar } = geometry(graph);
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const grow = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const b of boxes) { grow(b.x - BW / 2, b.y - BH / 2); grow(b.x + BW / 2, b.y + BH / 2); }
  for (const s of segs) { grow(s[0], s[1]); grow(s[2], s[3]); }
  grow(bar[0], bar[2]); grow(bar[1], bar[2] + BARH);
  const ccx = (minX + maxX) / 2, ccy = (minY + maxY) / 2;
  const gg = svgEl('g', { transform: `translate(${VW / 2} ${(VH / 2 + GYOFF).toFixed(2)}) scale(${GFX}) translate(${(-ccx).toFixed(2)} ${(-ccy).toFixed(2)})` });
  svg.append(gg);
  for (const s of segs) gg.append(svgEl('line', { x1: s[0], y1: s[1], x2: s[2], y2: s[3], stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
  gg.append(svgEl('rect', { x: bar[0], y: bar[2], width: bar[1] - bar[0], height: BARH, rx: 0.6, fill: 'currentColor' }));
  for (const b of boxes) {
    gg.append(svgEl('rect', { x: b.x - BW / 2, y: b.y - BH / 2, width: BW, height: BH, rx: 2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }));
    const tx = svgEl('text', { x: b.x, y: b.y + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'Tahoma, sans-serif', 'font-size': 9 });
    tx.textContent = b.id; gg.append(tx);
  }
}

// spec: an enum param ({ options:[{id,label}], label, title }); value: an option
// id. cb.onInput(id) fires on every change. Returns { el, setValue(id) }.
export function makeFmAlgo(container, { spec, value, cb = {} }) {
  const opts = spec.options || [];
  const L = opts.length;

  const pick = document.createElement('div');
  pick.className = 'fmpick';
  const lcd = document.createElement('div');
  lcd.className = 'lcd';
  const svg = svgEl('svg', { class: 'algosvg' });
  const hdr = document.createElement('div');
  hdr.className = 'hdr'; hdr.textContent = 'ALGORITHM';
  const cap = document.createElement('div');
  cap.className = 'cap';
  const num = document.createElement('span'); num.className = 'num';
  const nm = document.createElement('span'); nm.className = 'nm';
  cap.append(num, nm);
  lcd.append(svg, hdr, cap);
  const knob = document.createElement('div');
  knob.className = 'fmknob';
  knob.append(Object.assign(document.createElement('div'), { className: 'face' }));
  const bl = document.createElement('span');
  bl.className = 'bl'; bl.textContent = spec.label;
  pick.append(lcd, knob, bl);
  container.append(pick);

  let idx = Math.max(0, opts.findIndex((o) => o.id === value));
  const STEP = 26; // px of drag per detent

  function render() {
    const o = opts[idx];
    renderGraph(svg, o ? GRAPHS[o.id] : null);
    num.textContent = idx + 1;
    nm.textContent = o ? o.label : '';
    knob.title = `${spec.title || spec.label} — ${o ? o.label : ''}`;
  }
  const set = (i, emit) => { idx = ((i % L) + L) % L; render(); if (emit && cb.onInput) cb.onInput(opts[idx].id); };

  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault(); knob.setPointerCapture(e.pointerId);
    let lastY = e.clientY, acc = 0, moved = false;
    const move = (ev) => {
      const dy = lastY - ev.clientY; lastY = ev.clientY; acc += dy; if (Math.abs(dy) > 1) moved = true;
      while (acc >= STEP) { acc -= STEP; set(idx + 1, true); }
      while (acc <= -STEP) { acc += STEP; set(idx - 1, true); }
    };
    const up = () => { knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', up); if (!moved) set(idx + 1, true); };
    knob.addEventListener('pointermove', move);
    knob.addEventListener('pointerup', up);
  });
  knob.addEventListener('dragstart', (e) => e.preventDefault());
  knob.addEventListener('wheel', (e) => { e.preventDefault(); set(idx + (e.deltaY < 0 || e.deltaX > 0 ? 1 : -1), true); }, { passive: false });

  render();
  return { el: pick, setValue: (id) => { const i = opts.findIndex((o) => o.id === id); if (i >= 0) { idx = i; render(); } } };
}

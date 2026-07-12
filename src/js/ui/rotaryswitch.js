// rotaryswitch.js — a 3–5-way rotary switch for a small enum param (the skin's
// selector widget). Ports the LOCKED exhibit rotary (future/ui_skin/
// exhibit-padlington.html): a knob face with a pointer line, radial position
// TICKS + text LABELS around a 270° sweep (active one lit amber). Drag vertically
// to step, plain click cycles, wheel steps; pointerdown preventDefault (+ the
// element dragstart block) carries the canvas-drag-hijack fix.
//
// Policy (§13): ≤5 options → radial labels (this widget); a >5-way enum uses a
// readout-window variant instead (not built yet — Boshwick's 9-way Type).
//
// Driven by a registry enum spec ({ options:[{id,label}], label, title }). The
// value is an option id. cb.onInput(id) fires on every change.

const ARC = 270;
const A0 = -ARC / 2; // position 0 = full counter-clockwise

export function makeRotarySwitch(container, { spec, value, cb = {} }) {
  const opts = spec.options || [];
  const n = opts.length;
  // >5 options is past the radial-label range (§13): drop the radial labels and
  // show the current option in a readout WINDOW instead (Boshwick's 9-way Type).
  const windowed = n > 5;

  const rsww = document.createElement('div');
  rsww.className = 'rsww' + (windowed ? ' win' : '');
  const sw = document.createElement('div');
  sw.className = 'rswitch';
  const face = document.createElement('div');
  face.className = 'face';
  sw.append(face);
  const bl = document.createElement('span');
  bl.className = 'bl';
  bl.textContent = spec.label;
  const ro = windowed ? document.createElement('span') : null;
  if (ro) ro.className = 'ro';
  rsww.append(sw, bl);
  if (ro) rsww.append(ro);
  container.append(rsww);

  // Radial position ticks always; text labels only in radial (≤5) mode.
  const ticks = [], labs = [];
  for (let i = 0; i < n; i++) {
    const a = n > 1 ? A0 + (i * ARC) / (n - 1) : 0;
    const p = document.createElement('i');
    p.className = 'ptick';
    p.style.setProperty('--a', `${a}deg`);
    sw.append(p);
    ticks.push(p);
    if (!windowed) {
      const l = document.createElement('span');
      l.className = 'plab';
      l.textContent = opts[i].label;
      const rad = ((a - 180) * Math.PI) / 180;
      l.style.left = `${50 - Math.sin(rad) * 86}%`;
      l.style.top = `${50 + Math.cos(rad) * 86}%`;
      sw.append(l);
      labs.push(l);
    }
  }

  let idx = Math.max(0, opts.findIndex((o) => o.id === value));

  function render() {
    const a = n > 1 ? A0 + (idx * ARC) / (n - 1) : 0;
    face.style.transform = `rotate(${a}deg)`;
    ticks.forEach((p, i) => p.classList.toggle('on', i === idx));
    labs.forEach((l, i) => l.classList.toggle('on', i === idx));
    if (ro) ro.textContent = opts[idx] ? opts[idx].label : '';
    const tip = `${spec.title || spec.label} — ${opts[idx] ? opts[idx].label : ''}`;
    sw.title = tip;
    if (ro) ro.title = tip;
  }
  render();

  const set = (i, emit) => {
    idx = Math.min(n - 1, Math.max(0, i));
    render();
    if (emit && cb.onInput) cb.onInput(opts[idx].id);
  };

  sw.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sw.setPointerCapture(e.pointerId);
    const y0 = e.clientY, i0 = idx;
    let moved = false;
    const move = (ev) => {
      const d = Math.round((y0 - ev.clientY) / 24);
      if (d !== 0) moved = true;
      set(i0 + d, true);
    };
    const up = () => {
      sw.removeEventListener('pointermove', move);
      sw.removeEventListener('pointerup', up);
      if (!moved) set((idx + 1) % n, true); // a plain click cycles
    };
    sw.addEventListener('pointermove', move);
    sw.addEventListener('pointerup', up);
  });
  sw.addEventListener('dragstart', (e) => e.preventDefault());

  sw.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(idx + (e.deltaY < 0 || e.deltaX > 0 ? 1 : -1), true);
  }, { passive: false });

  return { el: rsww, setValue: (id) => set(Math.max(0, opts.findIndex((o) => o.id === id)), false) };
}

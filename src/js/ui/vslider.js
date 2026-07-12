// vslider.js — the canonical vertical slider (the control skin's primary widget).
//
// Driven by a param spec from the instrument registry (instrument.js): it works
// in POSITION space (0..1) via that param's toPos/fromPos so log-scaled knobs
// feel right, formats the readout WINDOW with the compact `fmtc` (units + full
// name in the rollover title), and — for a `bipolar` param — marks the neutral
// with an amber detent tick (off-centre allowed) that a drag/wheel snaps to.
//
// This ports the LOCKED exhibit widget (future/ui_skin/exhibit-vesperia.html):
//   11-tick ladders (majors at 0/5/10 by thickness); cap with a centre line;
//   wheel = coarse, wheel-TILT (deltaX) = fine; double-click the readout to type
//   an exact value (bypasses the detent); double-click the slider recentres a
//   bipolar to its detent. pointerdown calls preventDefault (+ a dragstart block
//   on the element) so a held slide can't be hijacked by a native canvas/element
//   drag — the carried-over canvas-drag-hijack fix.
//
// The DOM/classes mirror the exhibit so the skin CSS (index.html, scoped under
// .instr-skin) applies verbatim.

import { toPos, fromPos } from '../audio/instrument.js';

const clamp01 = (p) => (p < 0 ? 0 : p > 1 ? 1 : p);

// container: the .vsl holder to append into.
// spec: registry param spec ({ min,max,log,label,title,fmt,fmtc?,parse?,widget?,detent? }).
// value: initial value. cb.onInput(value) fires on every change; cb.onStart /
// cb.onCommit optionally bracket a drag (for one-undo-per-gesture hosts).
// Returns { el, setValue(v) } — setValue is exact (no detent snap), for re-sync.
export function makeVSlider(container, { spec, value, cb = {} }) {
  const bipolar = spec.widget === 'bipolar';
  const drawbar = spec.widget === 'drawbar';
  // A stepped param snaps to `steps` evenly-spaced positions. Two flavours:
  //  • `spec.steps` is a VALUE LIST (Tervik Coarse ratios) — each stop holds an
  //    exact value; the position↔value map is an array lookup (not toPos/fromPos).
  //  • drawbar `positions` is a COUNT (9 → the 0–8 clicks) on the param's own
  //    linear scale.
  const stepsArr = Array.isArray(spec.steps) ? spec.steps : null;
  const steps = drawbar ? (spec.positions || 9) : (stepsArr ? stepsArr.length : 0);
  const detPos = !drawbar && !stepsArr && spec.detent != null ? clamp01(toPos(spec, spec.detent)) : null;
  const window = spec.fmtc || spec.fmt;

  // Value ↔ position. A value-list stepper indexes the array; everything else
  // rides the param's own scale (log/linear via toPos/fromPos).
  const valToPos = (v) => stepsArr ? nearestIndex(stepsArr, v) / (steps - 1) : clamp01(toPos(spec, v));
  const posToVal = (p) => stepsArr ? stepsArr[Math.min(steps - 1, Math.max(0, Math.round(p * (steps - 1))))] : fromPos(spec, p);

  const vsl = document.createElement('div');
  vsl.className = 'vsl';
  const sl = document.createElement('div');
  if (drawbar) {
    // A pull-tab on a chrome stem; powers-of-two harmonics get the white tab.
    const n = parseInt(spec.label, 10);
    const white = !isFinite(n) || (n >= 1 && (n & (n - 1)) === 0);
    sl.className = `vslider drawbar ${white ? 'wtab' : 'btab'}`;
    const cap = mkEl('cap');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = spec.label;
    cap.append(num);
    sl.append(mkEl('slot'), mkEl('dstem'), cap);
  } else {
    sl.className = 'vslider' + (bipolar ? ' bip' : '');
    sl.append(mkTicks('l', detPos), mkEl('slot'), mkTicks('r', detPos), mkEl('cap'));
  }
  const ro = document.createElement('span');
  ro.className = 'ro';
  // A drawbar carries its number on the tab (no separate under-label); the rest
  // get the short label under the slider.
  if (!drawbar) {
    const bl = document.createElement('span');
    bl.className = 'bl';
    bl.textContent = spec.label;
    vsl.append(sl, bl, ro);
  } else {
    vsl.append(sl, ro);
  }
  container.append(vsl);

  let pos = valToPos(value);
  if (steps) pos = quantize(pos, steps);

  function sync(emit) {
    sl.style.setProperty('--val', pos);
    const val = posToVal(pos);
    if (!ro.querySelector('input')) ro.textContent = window(val);
    const tip = `${spec.title || spec.label} — ${spec.fmt(val)}`;
    sl.title = tip;
    ro.title = `${tip} (double-click to type)`;
    if (emit && cb.onInput) cb.onInput(val);
  }

  // Drag/wheel snap: to a step (stepped), else to the detent within a band.
  const snap = (x, band) => {
    x = clamp01(x);
    if (steps) return quantize(x, steps);
    if (detPos != null && Math.abs(x - detPos) < band) return detPos;
    return x;
  };

  sl.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // stop a native drag/pan hijacking a held slide
    sl.setPointerCapture(e.pointerId);
    cb.onStart && cb.onStart();
    const r = sl.getBoundingClientRect();
    const move = (ev) => { pos = snap(1 - (ev.clientY - r.top) / r.height, 0.035); sync(true); };
    move(e);
    const up = () => {
      sl.removeEventListener('pointermove', move);
      sl.removeEventListener('pointerup', up);
      cb.onCommit && cb.onCommit(posToVal(pos));
    };
    sl.addEventListener('pointermove', move);
    sl.addEventListener('pointerup', up);
  });
  sl.addEventListener('dragstart', (e) => e.preventDefault());

  // Double-click the slider recentres a bipolar to its detent (one bracketed edit).
  sl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (detPos == null) return;
    cb.onStart && cb.onStart();
    pos = detPos; sync(true);
    cb.onCommit && cb.onCommit(posToVal(pos));
  });

  // Wheel: vertical = coarse, tilt (deltaX) = fine. A stepped slider moves one
  // step per notch; a continuous one snaps to the detent.
  const coarse = steps ? 1 / (steps - 1) : 0.04;
  const fine = steps ? 1 / (steps - 1) : 0.005;
  sl.addEventListener('wheel', (e) => {
    e.preventDefault();
    cb.onStart && cb.onStart();
    if (e.deltaY) pos = snap(pos + (e.deltaY < 0 ? 1 : -1) * coarse, 0.015);
    if (e.deltaX) pos = snap(pos + (e.deltaX > 0 ? 1 : -1) * fine, 0.015);
    sync(true);
    cb.onCommit && cb.onCommit(posToVal(pos));
  }, { passive: false });

  // Double-click the readout to type an exact value (bypasses the detent). The
  // rename idiom: Enter/blur commits, Esc reverts; parse failure reverts too.
  if (spec.parse) {
    ro.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (ro.querySelector('input')) return;
      const old = ro.textContent;
      const inp = document.createElement('input');
      inp.className = 'edit';
      inp.value = old;
      ro.textContent = '';
      ro.append(inp);
      inp.focus(); inp.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const v = commit ? spec.parse(inp.value) : null;
        inp.remove();
        if (v != null) { cb.onStart && cb.onStart(); pos = valToPos(v); if (steps) pos = quantize(pos, steps); sync(true); cb.onCommit && cb.onCommit(posToVal(pos)); }
        else ro.textContent = old;
      };
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation(); // the app's global key handler ignores fields, but be explicit
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', () => finish(true));
    });
  }

  sync(false);
  return { el: vsl, setValue: (v) => { pos = valToPos(v); if (steps) pos = quantize(pos, steps); sync(false); } };
}

// Snap a 0..1 position to one of `steps` evenly-spaced positions (0..steps-1).
function quantize(x, steps) { return Math.round(clamp01(x) * (steps - 1)) / (steps - 1); }

// Index of the array entry nearest `v` (for a value-list stepper).
function nearestIndex(arr, v) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; bi = i; } }
  return bi;
}

// An 11-tick ladder (majors at 0/5/10 by thickness). On a bipolar slider the
// tick nearest the detent is tinted amber — the neutral marker, no slot bar.
function mkTicks(side, detPos) {
  const tk = document.createElement('div');
  tk.className = `ticks ${side}`;
  const detIdx = detPos != null ? Math.round(detPos * 10) : -1;
  for (let i = 0; i < 11; i++) {
    const t = document.createElement('i');
    if (i % 5 === 0) t.className = 'maj';
    if (i === detIdx) t.classList.add('det');
    tk.append(t);
  }
  return tk;
}

function mkEl(cls) {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

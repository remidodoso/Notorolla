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
  const detPos = spec.detent != null ? clamp01(toPos(spec, spec.detent)) : null;
  const window = spec.fmtc || spec.fmt;

  const vsl = document.createElement('div');
  vsl.className = 'vsl';
  const sl = document.createElement('div');
  sl.className = 'vslider' + (bipolar ? ' bip' : '');
  sl.append(mkTicks('l', detPos), mkEl('slot'), mkTicks('r', detPos), mkEl('cap'));
  const bl = document.createElement('span');
  bl.className = 'bl';
  bl.textContent = spec.label;
  const ro = document.createElement('span');
  ro.className = 'ro';
  vsl.append(sl, bl, ro);
  container.append(vsl);

  let pos = clamp01(toPos(spec, value));

  function sync(emit) {
    sl.style.setProperty('--val', pos);
    const val = fromPos(spec, pos);
    if (!ro.querySelector('input')) ro.textContent = window(val);
    const tip = `${spec.title || spec.label} — ${spec.fmt(val)}`;
    sl.title = tip;
    ro.title = `${tip} (double-click to type)`;
    if (emit && cb.onInput) cb.onInput(val);
  }

  // Drag/wheel land on the detent within a band; typed entry (setValue) bypasses.
  const snap = (x, band) => {
    x = clamp01(x);
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
      cb.onCommit && cb.onCommit(fromPos(spec, pos));
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
    cb.onCommit && cb.onCommit(fromPos(spec, pos));
  });

  // Wheel: vertical = coarse, tilt (deltaX) = fine. Snaps to the detent.
  sl.addEventListener('wheel', (e) => {
    e.preventDefault();
    cb.onStart && cb.onStart();
    if (e.deltaY) pos = snap(pos + (e.deltaY < 0 ? 1 : -1) * 0.04, 0.015);
    if (e.deltaX) pos = snap(pos + (e.deltaX > 0 ? 1 : -1) * 0.005, 0.015);
    sync(true);
    cb.onCommit && cb.onCommit(fromPos(spec, pos));
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
        if (v != null) { cb.onStart && cb.onStart(); pos = clamp01(toPos(spec, v)); sync(true); cb.onCommit && cb.onCommit(fromPos(spec, pos)); }
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
  return { el: vsl, setValue: (v) => { pos = clamp01(toPos(spec, v)); sync(false); } };
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

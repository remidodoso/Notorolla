// knob.js — a small mixer-style rotary knob, turned by click + vertical drag.
//
// Generic: the caller supplies a `map` (value <-> 0..1 position + a formatter),
// optional `detents` (values the knob sticks to, e.g. pan-center / unity-gain),
// and a `reset` value for double-click. Drag up = increase; Shift = fine. The
// widget owns its own visual (a tick rotated over a 270° arc) and updates it
// live during a drag WITHOUT a re-render, so a drag survives. Callbacks bracket
// the gesture: onStart (pointerdown) / onInput (each move) / onCommit (release)
// — so the host can make one undo step per drag.

const ARC = 270;              // degrees of sweep
const ANGLE0 = -ARC / 2;      // position 0 = full counter-clockwise
const DETENT = 0.03;          // snap radius (in position units)

// map: { toPos(value)->0..1, fromPos(pos)->value, format(value)->string }
// cb:  { onStart?(), onInput?(value), onCommit?(value) }
export function makeKnob(container, { label, value, map, detents = [], reset, sens = 0.01, cb = {} }) {
  const el = document.createElement('div');
  el.className = 'lane-knob';
  const tick = document.createElement('div');
  tick.className = 'knob-tick';
  el.append(tick);
  container.append(el);

  const detPos = detents.map((d) => map.toPos(d));
  let pos = clamp01(map.toPos(value));

  function render() {
    tick.style.transform = `translateX(-50%) rotate(${ANGLE0 + pos * ARC}deg)`;
    el.title = `${label}: ${map.format(map.fromPos(pos))}`;
  }
  render();

  function setPos(p, emit) {
    p = clamp01(p);
    for (const dp of detPos) if (Math.abs(p - dp) < DETENT) { p = dp; break; }
    pos = p;
    render();
    if (emit) cb.onInput && cb.onInput(map.fromPos(pos));
  }

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startPos = pos;
    cb.onStart && cb.onStart();
    const move = (ev) => setPos(startPos + (startY - ev.clientY) * (ev.shiftKey ? sens * 0.25 : sens), true);
    const up = (ev) => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      cb.onCommit && cb.onCommit(map.fromPos(pos));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });

  // Double-click restores the default — as a single bracketed gesture so it's one undo step.
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (reset === undefined) return;
    cb.onStart && cb.onStart();
    setPos(map.toPos(reset), true);
    cb.onCommit && cb.onCommit(map.fromPos(pos));
  });

  return { el, setValue: (v) => setPos(map.toPos(v), false) };
}

function clamp01(p) { return p < 0 ? 0 : p > 1 ? 1 : p; }

// --- mixer mappings ------------------------------------------------------

// Pan: value −1 (hard left) … 0 (center) … +1 (hard right). Linear; center detent.
export const PAN_MAP = {
  toPos: (v) => (v + 1) / 2,
  fromPos: (p) => p * 2 - 1,
  format: (v) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`),
};

// Gain: stored LINEAR; the knob works in dB over [−48, +6] with a unity (0 dB)
// detent, and position 0 = −∞ (silence). Most travel sits in the useful range.
const DB_MIN = -48, DB_MAX = 6, DB_SPAN = DB_MAX - DB_MIN;
export const GAIN_MAP = {
  toPos: (v) => (v <= 0 ? 0 : clamp01((20 * Math.log10(v) - DB_MIN) / DB_SPAN)),
  fromPos: (p) => (p <= 0.0001 ? 0 : Math.pow(10, (DB_MIN + p * DB_SPAN) / 20)),
  format: (v) => {
    if (v <= 0) return '−∞ dB';
    const db = 20 * Math.log10(v);
    return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  },
};

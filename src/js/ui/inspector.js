// inspector.js — the Tile inspector: a tenant of the reusable modeless pane
// ([src/panel.js](panel.js)). The pane owns the floating/drag/resize/scroll-
// resistant/geometry-remembered/document-agnostic chrome; this module owns the
// inspector's CONTENT: an optional play/stop/loop transport cluster + a data
// dump rendered from a plain `facts` structure, with an inline-rename heading.
// (See future_directions.md §12 for the inspector, §14 for where the shared pane
// is heading — the Patch Catalog reuses the same panel.)

import { createPanel } from './panel.js';

// createInspector({ title, transport }) → a controller for the inspector.
//   .setFacts(facts)       render the data dump (see the shape below)
//   .setTransport(state)   update the play/stop/loop cluster (if any)
//   .show() / .hide() / .toggle() / .isOpen()
//   .onToggle = fn(open)   notified when opened/closed (button state, etc.)
//
// transport (optional) = { onPlay, onStop, onLoop } → renders a small play/stop/
// loop cluster at the TOP (a first, non-standardized transport — we're not ready
// to standardize a shared cluster yet). NOTE: an inspector must never hold focus
// (no keyboard shortcuts belong to it), so every control blurs itself after a
// click — that keeps Space et al. routed to the app, not re-firing a button.
//
// facts shape (kept dumb so the pane is reusable for other inspectors later):
//   { empty: 'message' }                      — nothing to show
//   { heading, sub, rename?, sections: [       — a data dump
//       { title, rows: [ [label, value], … ] }, … ] }
//   rename (optional) = { label, canonical, onCommit(newLabel) } → double-click
//     the heading to edit an inline friendly name.
export function createInspector({ title = 'Inspector', transport = null } = {}) {
  const panel = createPanel({ title, storeKey: 'notorolla.inspector', defaultGeom: { w: 300, h: 360 } });
  const { root, doc } = panel;

  // Transport cluster (optional): play / stop / loop, right under the header so
  // it stays put while the body scrolls. Buttons blur after a click (see above).
  let playBtn, stopBtn, loopBtn, transportBar = null;
  if (transport) {
    const bar = doc.createElement('div');
    bar.className = 'inspector-transport';
    const mk = (glyph, tip, fn) => {
      const b = doc.createElement('button');
      b.className = 'insp-tbtn';
      b.textContent = glyph; b.title = tip;
      b.tabIndex = -1; // not in the tab order — the inspector never takes focus
      b.onclick = () => { fn && fn(); b.blur(); };
      bar.append(b);
      return b;
    };
    playBtn = mk('▶', 'Play this tile once', transport.onPlay);
    stopBtn = mk('■', 'Stop', transport.onStop);
    // Loop is the app's LIMITED loop (stacking taps that count down, not an
    // endless loop) — a cornerstone that prevents "loop burn-in". Tap to add
    // passes; main.js owns the cap/countdown.
    loopBtn = mk('↻', 'Loop this tile (tap to add passes — a limited, counted loop)', transport.onLoop);
    transportBar = bar;
    root.append(bar);
  }

  const body = doc.createElement('div');
  body.className = 'inspector-body';
  root.append(body);

  // --- Render the facts data dump -------------------------------------------
  function setFacts(facts) {
    body.innerHTML = '';
    if (!facts || facts.empty) {
      const m = doc.createElement('div');
      m.className = 'inspector-empty';
      m.textContent = (facts && facts.empty) || 'Nothing to inspect.';
      body.append(m);
      return;
    }
    if (facts.heading) {
      const h = doc.createElement('div');
      h.className = 'inspector-heading';
      h.textContent = facts.heading;
      // Optional inline rename: double-click the heading to edit a friendly name.
      // facts.rename = { label, canonical, onCommit(newLabel) }.
      if (facts.rename) {
        h.classList.add('editable');
        h.title = 'Double-click to rename';
        h.addEventListener('dblclick', () => startRename(h, facts.rename));
      }
      body.append(h);
    }
    if (facts.sub) {
      const s = doc.createElement('div');
      s.className = 'inspector-sub';
      s.textContent = facts.sub;
      body.append(s);
    }
    for (const sec of facts.sections || []) {
      if (sec.title) {
        const t = doc.createElement('div');
        t.className = 'inspector-sectitle';
        t.textContent = sec.title;
        body.append(t);
      }
      const dl = doc.createElement('div');
      dl.className = 'inspector-rows';
      for (const [label, value] of sec.rows || []) {
        const k = doc.createElement('div'); k.className = 'insp-k'; k.textContent = label;
        const v = doc.createElement('div'); v.className = 'insp-v'; v.textContent = value;
        dl.append(k, v);
      }
      body.append(dl);
    }
  }

  // Inline rename: swap the heading for a text field. Enter (or blur) commits the
  // trimmed value; ESC cancels with no change (the app-wide "ESC cancels the
  // in-progress thing" rule). This is the one time the inspector holds focus — a
  // transient text field the user explicitly opened; focus returns to the app on
  // commit/cancel. The global key handler already ignores keys typed into inputs.
  function startRename(headingEl, rename) {
    const wrap = doc.createElement('div');
    wrap.className = 'inspector-heading rename';
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'insp-rename-input';
    input.value = rename.label || '';
    input.placeholder = rename.canonical; // empty field → the canonical name shows
    const suffix = doc.createElement('span');
    suffix.className = 'insp-rename-suffix';
    suffix.textContent = `(${rename.canonical})`;
    wrap.append(input, suffix);
    headingEl.replaceWith(wrap);
    input.focus();
    input.select();

    let done = false; // guards against commit-after-cancel (ESC blurs → commit)
    const commit = () => { if (done) return; done = true; rename.onCommit(input.value.trim()); };
    const cancel = () => { if (done) return; done = true; wrap.replaceWith(headingEl); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep typing out of the app's shortcut handler
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }        // → commit
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }      // → cancel, no change
    });
    input.addEventListener('blur', commit);
  }

  // Update the transport cluster's enabled/active look. state = { canPlay,
  // playing, looping }. No-op when the pane has no transport.
  function setTransport(state = {}) {
    if (!transportBar) return;
    if (playBtn) playBtn.disabled = !state.canPlay;
    if (loopBtn) { loopBtn.disabled = !state.canPlay; loopBtn.classList.toggle('on', !!state.looping); }
    if (stopBtn) stopBtn.disabled = !state.playing;
  }

  // Public API: content methods here, window controls delegated to the panel.
  return {
    setFacts,
    setTransport,
    show: panel.show,
    hide: panel.hide,
    toggle: panel.toggle,
    isOpen: panel.isOpen,
    root,
    get onToggle() { return panel.onToggle; },
    set onToggle(fn) { panel.onToggle = fn; },
  };
}

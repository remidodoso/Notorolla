// rackpane.js — the Rack window: a modeless floating pane (a panel.js tenant)
// listing the project's SHARED instrument instances (rack.js). Content only — the
// pane owns the float/drag/resize/scroll chrome.
//
// Each instance is a chip: a colour swatch, its rack name (R1, R2, …) and the
// patch it holds. DRAG a chip onto a lane head in the tile player to assign that
// shared voice to the lane; DOUBLE-CLICK a chip to rename the instance. Kept dumb:
// app/rack.js feeds the list and owns the drag orchestration + rename via callbacks.

import { createPanel } from './panel.js';

// createRackPane(cb) → { root, show, hide, toggle, isOpen, refresh, onToggle }.
// cb: {
//   list()             -> [ { id, name, color, patchLabel, editing }, … ]
//   onDragStart(id, ev)  a chip pointerdown begins a drag-to-lane-head
//   onRename(id)         double-click a chip to rename the instance
// }
export function createRackPane(cb) {
  const panel = createPanel({ title: 'Rack', storeKey: 'notorolla.rackpane', defaultGeom: { w: 240, h: 300 } });
  const { root, doc } = panel;

  const body = doc.createElement('div');
  body.className = 'rack-body';
  root.append(body);

  function render() {
    body.innerHTML = '';
    const items = cb.list ? cb.list() : [];
    if (!items.length) {
      const m = doc.createElement('div');
      m.className = 'rack-empty';
      m.textContent = 'No rack instruments yet — use “＋ Rack” in the instrument editor, then drag a chip onto a lane head.';
      body.append(m);
      return;
    }
    for (const it of items) {
      const chip = doc.createElement('div');
      chip.className = 'rack-chip' + (it.editing ? ' editing' : '');
      chip.title = 'Drag onto a lane head to assign · double-click to rename';
      const sw = doc.createElement('span');
      sw.className = 'rack-sw';
      sw.style.background = it.color;
      const nm = doc.createElement('span');
      nm.className = 'rack-name';
      nm.textContent = it.name;
      const pl = doc.createElement('span');
      pl.className = 'rack-patch';
      pl.textContent = it.patchLabel;
      chip.append(sw, nm, pl);
      chip.addEventListener('pointerdown', (e) => { if (e.button === 0) cb.onDragStart && cb.onDragStart(it.id, e); });
      chip.addEventListener('dragstart', (e) => e.preventDefault()); // no native DnD; we drive our own
      chip.addEventListener('dblclick', () => cb.onRename && cb.onRename(it.id));
      body.append(chip);
    }
  }

  // Render on open; forward the toggle to the host (button active state).
  let ext = null;
  panel.onToggle = (open) => { if (open) render(); if (ext) ext(open); };

  return {
    root, // app/rack.js toggles its pointer-events during a drag so lane heads are hittable
    show: panel.show, hide: panel.hide, toggle: panel.toggle, isOpen: panel.isOpen,
    refresh: () => { if (panel.isOpen()) render(); },
    get onToggle() { return ext; },
    set onToggle(fn) { ext = fn; },
  };
}

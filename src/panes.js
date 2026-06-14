// panes.js — minimal reorderable vertical panes, order persisted.
//
// Each child .pane has a draggable .pane-header; drag a header up or down to
// reorder the stack. The order is saved to localStorage under storageKey and
// restored on load. (Resizing is intentionally left for a fast-follow.)

export function setupPanes(container, storageKey) {
  // Restore saved order by re-appending panes in the stored sequence.
  const saved = readJSON(storageKey);
  if (Array.isArray(saved)) {
    for (const id of saved) {
      const pane = container.querySelector(`.pane[data-pane="${id}"]`);
      if (pane) container.append(pane);
    }
  }

  let dragged = null;
  for (const pane of container.querySelectorAll('.pane')) {
    const header = pane.querySelector('.pane-header');
    header.setAttribute('draggable', 'true');
    header.addEventListener('dragstart', (e) => {
      dragged = pane;
      pane.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    header.addEventListener('dragend', () => {
      pane.classList.remove('dragging');
      save();
    });
    // Insert the dragged pane before/after this one based on cursor halves.
    pane.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragged || dragged === pane) return;
      const r = pane.getBoundingClientRect();
      const before = e.clientY - r.top < r.height / 2;
      container.insertBefore(dragged, before ? pane : pane.nextSibling);
    });
  }

  function save() {
    const order = [...container.querySelectorAll('.pane')].map((p) => p.dataset.pane);
    localStorage.setItem(storageKey, JSON.stringify(order));
  }
}

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

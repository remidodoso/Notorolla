// modal.js — a minimal centered modal over a dimmed backdrop. Esc, a backdrop
// click, or the × closes it; onClose fires exactly once. Returns { close }.

export function openModal({ title, body, onClose }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const panel = document.createElement('div');
  panel.className = 'modal-panel';

  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('span');
  h.className = 'modal-title'; h.textContent = title || '';
  const x = document.createElement('button');
  x.className = 'modal-x'; x.textContent = '×'; x.title = 'Close';
  head.append(h, x);

  panel.append(head, body);
  overlay.append(panel);
  document.body.append(overlay);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (onClose) onClose();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  x.addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true); // capture so Esc doesn't hit app shortcuts

  return { close };
}

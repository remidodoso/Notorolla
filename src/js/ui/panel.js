// panel.js — a reusable modeless floating pane (the window chrome, extracted
// from the Tile inspector so the coming Patch Catalog and any other modeless
// window can share ONE implementation).
//
// What the panel gives a tenant:
//   - a floating `position: fixed` box that NEVER rides the page scroll — the
//     USER owns its spot (draggable by the header) and size (CSS `resize: both`,
//     min-size from CSS);
//   - position + size + open/closed remembered per `storeKey` (a workspace pref;
//     best-effort — a storage failure just doesn't persist);
//   - a header (title + close button) and show/hide/toggle/isOpen + onToggle;
//   - DOCUMENT-AGNOSTIC construction (everything from the root's `ownerDocument`),
//     so the whole pane can later be adopted into a popped-out window's document
//     without a second implementation.
//
// A tenant appends its own content to `panel.root` (after the header) and drives
// show/hide. The tenant is responsible for making any interior overflow scroll
// INSIDE the pane (e.g. `overflow:auto; overscroll-behavior:contain`) so it never
// chains out to the page — the panel keeps the page from scrolling by being fixed.

// Shared click-to-front stacking. All panels share the CSS z-index (60); pressing
// one lifts it above its siblings by stamping an ever-rising inline z-index — so
// overlapping windows (inspector, catalog, visualizer) reorder like real windows.
let topZ = 60;
function bringToFront(el) { el.style.zIndex = String(++topZ); }

function loadGeom(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; }
  catch { return {}; }
}
function saveGeom(key, g) {
  try { localStorage.setItem(key, JSON.stringify(g)); } catch { /* ignore */ }
}

// createPanel({ title, storeKey, defaultGeom }) → the pane controller.
//   .root      the floating element — a tenant appends content here
//   .doc       its ownerDocument (use for createElement — the doc-agnostic seam)
//   .header    the drag-handle header element (a tenant may add to it)
//   .show() / .hide() / .toggle() / .isOpen()
//   .onToggle = fn(open)   notified when opened/closed
//   .setTitle(text)
export function createPanel({ title = 'Panel', storeKey = 'notorolla.panel', defaultGeom = {} } = {}) {
  const root = document.createElement('div');
  const doc = root.ownerDocument;
  root.className = 'panel';
  root.style.display = 'none';

  // Header: a drag handle (the whole bar) + a close button.
  const head = doc.createElement('div');
  head.className = 'panel-head';
  const titleEl = doc.createElement('span');
  titleEl.className = 'panel-title';
  titleEl.textContent = title;
  const closeBtn = doc.createElement('button');
  closeBtn.className = 'panel-x';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close';
  head.append(titleEl, closeBtn);
  root.append(head);
  doc.body.append(root);

  // Press anywhere on the pane to raise it above the other floating windows.
  root.addEventListener('pointerdown', () => bringToFront(root));

  const geom = loadGeom(storeKey);
  const dw = defaultGeom.w || 300, dh = defaultGeom.h || 360;

  // Restore geometry, clamped to the viewport so a smaller window can't strand
  // the pane fully off-screen.
  function place() {
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const w = geom.w || dw;
    const h = geom.h || dh;
    let x = geom.x != null ? geom.x : Math.max(12, vw - w - 24);
    let y = geom.y != null ? geom.y : 96;
    x = Math.min(Math.max(0, x), Math.max(0, vw - 60));
    y = Math.min(Math.max(0, y), Math.max(0, vh - 40));
    root.style.left = x + 'px';
    root.style.top = y + 'px';
    if (geom.w) root.style.width = geom.w + 'px';
    if (geom.h) root.style.height = geom.h + 'px';
  }
  place();

  // --- Drag the header to move the pane -------------------------------------
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target === closeBtn) return;      // let the close button click through
    const r = root.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    let x = e.clientX - drag.dx;
    let y = e.clientY - drag.dy;
    x = Math.min(Math.max(0, x), Math.max(0, vw - 60)); // keep a grabbable sliver on-screen
    y = Math.min(Math.max(0, y), Math.max(0, vh - 40));
    root.style.left = x + 'px';
    root.style.top = y + 'px';
  });
  head.addEventListener('pointerup', (e) => {
    if (!drag) return;
    drag = null;
    head.releasePointerCapture(e.pointerId);
    const r = root.getBoundingClientRect();
    geom.x = r.left; geom.y = r.top;
    saveGeom(storeKey, geom);
  });

  // --- Remember size after a resize -----------------------------------------
  // ResizeObserver fires on the CSS `resize: both` drag; debounce the write.
  let resizeT = null;
  const ro = new ResizeObserver(() => {
    if (root.style.display === 'none') return;
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      geom.w = root.offsetWidth; geom.h = root.offsetHeight;
      saveGeom(storeKey, geom);
    }, 200);
  });
  ro.observe(root);

  // --- Open/close -----------------------------------------------------------
  const api = { root, doc, header: head, onToggle: null };
  function setOpen(open) {
    root.style.display = open ? 'flex' : 'none';
    geom.open = open;
    saveGeom(storeKey, geom);
    if (open) { place(); bringToFront(root); }
    if (api.onToggle) api.onToggle(open);
  }
  closeBtn.onclick = () => setOpen(false);

  api.show = () => setOpen(true);
  api.hide = () => setOpen(false);
  api.toggle = () => setOpen(root.style.display === 'none');
  api.isOpen = () => root.style.display !== 'none';
  api.setTitle = (t) => { titleEl.textContent = t; };

  // Reopen if it was open last session (a workspace pref, like the panes). Note:
  // onToggle isn't set yet at this point, so a tenant that needs to react to the
  // auto-reopen should sync its own state after createPanel returns.
  if (geom.open) setOpen(true);

  return api;
}

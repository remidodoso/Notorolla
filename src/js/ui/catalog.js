// catalog.js — the Patch Catalog: a modeless window (a panel.js tenant) that
// browses the user-global patch store (future_directions §14, Phase C). Content
// only — the pane owns the float/drag/resize/scroll chrome.
//
// Browse kind → patch (all instruments), a live name filter, double-click to
// apply to the current editor target, and per-user-patch Rename / Delete (factory
// entries read-only). Kept dumb: main.js feeds it the list + handles apply/rename/
// delete via callbacks, so the same component can back other catalogs later.

import { createPanel } from './panel.js';

// createCatalog(cb) → { toggle, show, hide, isOpen, refresh, onToggle setter }.
// cb: {
//   list()      -> [ { kindLabel, patches: [ {id, name, factory} ] }, … ]
//   currentId() -> the edit target's current patch id (highlighted), or null
//   onApply(id), onRename(id), onDelete(id)
// }
export function createCatalog(cb) {
  const panel = createPanel({ title: 'Patch Catalog', storeKey: 'notorolla.catalog', defaultGeom: { w: 320, h: 440 } });
  const { root, doc } = panel;

  const bar = doc.createElement('div');
  bar.className = 'cat-bar';
  const search = doc.createElement('input');
  search.type = 'text';
  search.className = 'cat-search';
  search.placeholder = 'Search patches…';
  bar.append(search);
  root.append(bar);

  const body = doc.createElement('div');
  body.className = 'cat-body';
  root.append(body);

  let query = '';
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  // The search field is the one place the catalog holds focus; keep typing out of
  // the app shortcuts, and let Esc clear the filter (then release focus).
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (query) { search.value = ''; query = ''; render(); } else search.blur(); }
  });

  function render() {
    body.innerHTML = '';
    const groups = cb.list ? cb.list() : [];
    const curId = cb.currentId ? cb.currentId() : null;
    let shown = 0;
    for (const g of groups) {
      const items = g.patches.filter((p) =>
        !query || p.name.toLowerCase().includes(query) || g.kindLabel.toLowerCase().includes(query));
      if (!items.length) continue;
      const kh = doc.createElement('div');
      kh.className = 'cat-kind';
      kh.textContent = g.kindLabel;
      body.append(kh);
      for (const p of items) {
        shown++;
        const row = doc.createElement('div');
        row.className = 'cat-item' + (p.id === curId ? ' current' : '') + (p.factory ? ' factory' : '');
        row.title = 'Double-click to apply to the current instrument';
        const nm = doc.createElement('span');
        nm.className = 'cat-name';
        nm.textContent = p.name;
        row.append(nm);
        if (p.factory) {
          const tag = doc.createElement('span');
          tag.className = 'cat-tag';
          tag.textContent = 'factory';
          row.append(tag);
        } else {
          const sp = doc.createElement('span'); sp.style.flex = '1'; row.append(sp);
          const ren = mkAct('✎', 'Rename', (e) => { e.stopPropagation(); cb.onRename && cb.onRename(p.id); });
          const del = mkAct('✕', 'Delete', (e) => { e.stopPropagation(); cb.onDelete && cb.onDelete(p.id); });
          row.append(ren, del);
        }
        row.addEventListener('dblclick', () => cb.onApply && cb.onApply(p.id));
        body.append(row);
      }
    }
    if (!shown) {
      const m = doc.createElement('div');
      m.className = 'cat-empty';
      m.textContent = query ? 'No matches.' : 'No patches yet — Save one from the instrument editor.';
      body.append(m);
    }
  }

  function mkAct(glyph, tip, onclick) {
    const b = doc.createElement('button');
    b.className = 'cat-act'; b.textContent = glyph; b.title = tip; b.tabIndex = -1;
    b.addEventListener('click', (e) => { onclick(e); b.blur(); });
    return b;
  }

  // Render on open (fresh list + highlight); forward the toggle to main.js's
  // handler (button active state). main.js sets api.onToggle.
  let ext = null;
  panel.onToggle = (open) => { if (open) render(); if (ext) ext(open); };

  return {
    show: panel.show, hide: panel.hide, toggle: panel.toggle, isOpen: panel.isOpen,
    refresh: () => { if (panel.isOpen()) render(); },
    get onToggle() { return ext; },
    set onToggle(fn) { ext = fn; },
  };
}

// project.js — save/load a Notorolla composition as a versioned JSON file.
//
// A project file is the "document": musical content only (the pattern library,
// the tile arrangement, and tempo). View/layout state stays machine-local in
// localStorage and is deliberately NOT part of the file, so projects port
// cleanly between machines and window setups.
//
// Compatibility rule: every file carries a `version`. Loading runs migrate()
// to upgrade older files to the current shape. Adding new OPTIONAL fields is
// backward-safe automatically (old files just lack them, and fromJSON defaults
// them); we only add a migration step when a field is renamed/restructured.

export const VERSION = 1;

// Wrap the serialized parts in the on-disk envelope. `savedAt` is informational
// only and is intentionally excluded from the dirty-bit snapshot.
export function buildEnvelope({ name, lib, arr, tempo }) {
  return { format: 'notorolla', version: VERSION, savedAt: new Date().toISOString(), name, lib, arr, tempo };
}

// Reject anything that isn't a Notorolla file; returns the object on success.
export function validate(o) {
  if (!o || o.format !== 'notorolla' || !o.lib || !o.arr) {
    throw new Error('not a Notorolla project file');
  }
  return o;
}

// Upgrade an older file to the current version. (No steps needed yet — v1 is
// the first format. Future: `if (env.version < 2) env = up1to2(env);` …)
export function migrate(o) {
  return o;
}

// A timestamped default filename stem, e.g. "notorolla-20260615-1430".
export function defaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `notorolla-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Trigger a browser download of a Blob (download-only — no file handle, the
// portable, Firefox-friendly path).
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Download `obj` as pretty-printed JSON.
export function downloadJSON(filename, obj) {
  downloadBlob(filename, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
}

// Download raw bytes (e.g. a MIDI file).
export function downloadBytes(filename, bytes, type = 'application/octet-stream') {
  downloadBlob(filename, new Blob([bytes], { type }));
}

// Read a picked File as text.
export function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('could not read file'));
    r.readAsText(file);
  });
}

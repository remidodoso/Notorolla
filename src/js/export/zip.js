// zip.js — a minimal STORE-method (no compression) ZIP writer (pure, no deps).
//
// Used to bundle stem exports into one download. STORE (method 0) means the
// entries are stored verbatim — WAV/BWF audio is already uncompressed PCM, so
// deflate would buy little and cost a dependency. Produces a standard ZIP that
// any unarchiver (and the OS) opens.

// CRC-32 (IEEE 802.3), table built once. ZIP stores a CRC per entry.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time fields (MS-DOS packed format). Pre-1980 clamps to the epoch.
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const y = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * Build a ZIP archive from `files` = [{ name, bytes:Uint8Array }]. `date` (a
 * Date, optional) timestamps every entry. Returns the archive as a Uint8Array.
 * Names are stored UTF-8 (the language-encoding flag is set), '/'-separated.
 */
export function zipStore(files, date = new Date()) {
  const enc = new TextEncoder();
  const { time, date: ddate } = dosDateTime(date);
  const parts = [];          // archive byte chunks, in order
  const central = [];        // central-directory records, built alongside
  let offset = 0;            // running offset = local-header position of next entry

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.bytes;
    const crc = crc32(data);
    const utf8 = name.some((b) => b > 0x7f) ? 0x0800 : 0; // language-encoding flag

    // Local file header (30 bytes + name) then the stored data.
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); // signature
    lh.setUint16(4, 20, true);         // version needed
    lh.setUint16(6, utf8, true);       // general-purpose flag
    lh.setUint16(8, 0, true);          // method 0 = store
    lh.setUint16(10, time, true);
    lh.setUint16(12, ddate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); // compressed size
    lh.setUint32(22, data.length, true); // uncompressed size
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);           // extra length
    parts.push(new Uint8Array(lh.buffer), name, data);

    // Central-directory record (46 bytes + name), mirroring the local header.
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);  // signature
    cd.setUint16(4, 20, true);          // version made by
    cd.setUint16(6, 20, true);          // version needed
    cd.setUint16(8, utf8, true);
    cd.setUint16(10, 0, true);          // method
    cd.setUint16(12, time, true);
    cd.setUint16(14, ddate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true);          // extra length
    cd.setUint16(32, 0, true);          // comment length
    cd.setUint16(34, 0, true);          // disk number start
    cd.setUint16(36, 0, true);          // internal attrs
    cd.setUint32(38, 0, true);          // external attrs
    cd.setUint32(42, offset, true);     // local-header offset
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + data.length;
  }

  // After all local entries comes the central directory, then the EOCD.
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);   // signature
  eocd.setUint16(4, 0, true);            // disk number
  eocd.setUint16(6, 0, true);            // disk with central dir
  eocd.setUint16(8, files.length, true); // entries on this disk
  eocd.setUint16(10, files.length, true);// total entries
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);           // comment length

  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const total = all.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

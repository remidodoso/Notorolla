// wav.js — encode an AudioBuffer to a 16-bit PCM WAV / BWF file (pure, no deps).
//
// Sibling to midi.js: data in (an AudioBuffer from an offline render) → bytes
// out (a RIFF/WAVE container). 16-bit PCM is universally readable by DAWs.
//
// `encodeWav` writes a plain WAVE. `encodeBwf` writes the same container plus a
// `bext` (Broadcast Audio Extension) chunk — a Broadcast Wave Format file, used
// for stem export. BWF is a strict superset: players that don't know `bext`
// ignore it, and the chief field, TimeReference, lets a DAW (Cubase, Reaper …)
// drop a set of stems and have them snap to a common origin.

// Interleaved 16-bit PCM bytes for the buffer's channels (shared by both
// encoders), clamped to [-1,1]. Asymmetric scale (0x8000 neg / 0x7fff pos)
// uses the full signed range without wrapping +1.0.
function pcm16Bytes(buffer) {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const ab = new ArrayBuffer(len * numCh * 2);
  const dv = new DataView(ab);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let o = 0;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(ab);
}

// A little DataView cursor with the writers the chunk layout needs.
function cursor(dv) {
  let o = 0;
  return {
    u32: (v) => { dv.setUint32(o, v, true); o += 4; },
    u16: (v) => { dv.setUint16(o, v, true); o += 2; },
    str: (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); },
    // Fixed-width ASCII field, truncated then NUL-padded to exactly `n` bytes.
    // Non-printable / non-ASCII chars become '?' (bext fields are ASCII).
    fixed: (s, n) => {
      for (let i = 0; i < n; i++) {
        if (i >= s.length) { dv.setUint8(o + i, 0); continue; }
        const cc = s.charCodeAt(i);
        dv.setUint8(o + i, cc >= 0x20 && cc <= 0x7e ? cc : 0x3f);
      }
      o += n;
    },
    skip: (n) => { o += n; },
    get pos() { return o; },
  };
}

// Assemble a RIFF/WAVE from PCM bytes + the chunks before `data`. `pre` is an
// array of { id, bytes } chunks (e.g. a bext) inserted after `fmt `.
function assembleWave(buffer, data, pre = []) {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const blockAlign = numCh * 2;            // 2 bytes/sample (16-bit)

  // chunk = 8-byte header + payload, payload padded to even length.
  const sizeOf = (n) => 8 + n + (n & 1);
  let riff = 4;                            // "WAVE"
  riff += sizeOf(16);                      // fmt
  for (const c of pre) riff += sizeOf(c.bytes.length);
  riff += sizeOf(data.length);             // data

  const ab = new ArrayBuffer(8 + riff);
  const dv = new DataView(ab);
  const c = cursor(dv);

  c.str('RIFF'); c.u32(riff); c.str('WAVE');
  c.str('fmt '); c.u32(16); c.u16(1);      // PCM
  c.u16(numCh); c.u32(sampleRate); c.u32(sampleRate * blockAlign); c.u16(blockAlign); c.u16(16);
  for (const chunk of pre) {
    c.str(chunk.id); c.u32(chunk.bytes.length);
    new Uint8Array(ab).set(chunk.bytes, c.pos); c.skip(chunk.bytes.length);
    if (chunk.bytes.length & 1) c.skip(1);  // pad byte
  }
  c.str('data'); c.u32(data.length);
  new Uint8Array(ab).set(data, c.pos);
  return new Uint8Array(ab);
}

export function encodeWav(buffer) {
  return assembleWave(buffer, pcm16Bytes(buffer));
}

// The Broadcast Audio Extension chunk (EBU Tech 3285), 602 fixed bytes (v1, no
// coding history). meta = { description, originator, originatorRef, date(Date),
// timeReferenceSamples }. TimeReference is the file's sample offset on the
// timeline — 0 for all stems so they import aligned.
const BEXT_SIZE = 602;
function bextChunk(meta = {}) {
  const ab = new ArrayBuffer(BEXT_SIZE);
  const dv = new DataView(ab);
  const c = cursor(dv);
  const d = meta.date instanceof Date ? meta.date : new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const timeStr = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const tref = Math.max(0, Math.floor(meta.timeReferenceSamples || 0));

  c.fixed(meta.description || '', 256);    // Description
  c.fixed(meta.originator || '', 32);      // Originator
  c.fixed(meta.originatorRef || '', 32);   // OriginatorReference
  c.fixed(dateStr, 10);                    // OriginationDate yyyy-mm-dd
  c.fixed(timeStr, 8);                     // OriginationTime hh:mm:ss
  c.u32(tref >>> 0);                       // TimeReferenceLow
  c.u32(Math.floor(tref / 0x100000000));   // TimeReferenceHigh
  c.u16(1);                                // Version
  // UMID[64], loudness[10], Reserved[180] all left zero (cursor already there).
  return new Uint8Array(ab);
}

export function encodeBwf(buffer, meta) {
  return assembleWave(buffer, pcm16Bytes(buffer), [{ id: 'bext', bytes: bextChunk(meta) }]);
}

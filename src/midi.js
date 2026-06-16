// midi.js — write a Standard MIDI File (pure: note data in, bytes out).
//
// Notorolla's pitches are already MIDI note numbers (C4 = 60) and time is in
// beats where 1 beat = a quarter note, so the mapping is direct. We emit a
// Format-1 file: one MTrk per supplied track, each named and on its own channel,
// with a single tempo meta on the first track. No CC / program changes — the
// DAW assigns instruments.

const TPQN_DEFAULT = 480; // ticks per quarter note (Notorolla durations are
                          // multiples of an eighth, so every tick is integral)

// Variable-length quantity (MIDI delta times & meta lengths): 7 bits/byte,
// high bit set on all but the last.
function varLen(value) {
  const out = [value & 0x7f];
  value = Math.floor(value / 128);
  while (value > 0) {
    out.unshift((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  return out;
}

const pushStr = (arr, s) => { for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i) & 0xff); };
const pushU16 = (arr, v) => arr.push((v >> 8) & 0xff, v & 0xff);
const pushU32 = (arr, v) => arr.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);

// Meta event: text-type (track name = 0x03) and set-tempo (0x51).
function metaText(type, str) {
  const t = [...str].map((c) => c.charCodeAt(0) & 0x7f);
  return [0xff, type, ...varLen(t.length), ...t];
}
function tempoMeta(bpm) {
  const mpqn = Math.round(60000000 / bpm); // microseconds per quarter note
  return [0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff];
}

// Build one MTrk's data bytes. `bpm` is non-null only for the first track.
function trackData(track, bpm, channel, tpqn) {
  const ch = channel & 0x0f;
  const ev = []; // { tick, order, bytes } — order 0 sorts before 1 at equal tick

  if (track.name) ev.push({ tick: 0, order: 0, bytes: metaText(0x03, track.name) });
  if (bpm != null) ev.push({ tick: 0, order: 0, bytes: tempoMeta(bpm) });

  for (const n of track.notes) {
    const start = Math.round(n.startBeat * tpqn);
    const end = Math.max(start + 1, Math.round((n.startBeat + n.durBeats) * tpqn));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
    const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
    ev.push({ tick: start, order: 1, bytes: [0x90 | ch, pitch, vel] });   // note on
    ev.push({ tick: end, order: 0, bytes: [0x80 | ch, pitch, 0x40] });    // note off
  }

  // Note-offs (and metas) before note-ons at the same tick, then by time.
  ev.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const out = [];
  let prev = 0;
  for (const e of ev) {
    out.push(...varLen(e.tick - prev), ...e.bytes);
    prev = e.tick;
  }
  out.push(...varLen(0), 0xff, 0x2f, 0x00); // end of track
  return out;
}

// tracks: [{ name, notes:[{ pitch, startBeat, durBeats, velocity(0..1) }] }]
export function notesToMidi(tracks, bpm, { tpqn = TPQN_DEFAULT } = {}) {
  const bytes = [];
  pushStr(bytes, 'MThd');
  pushU32(bytes, 6);
  pushU16(bytes, 1);             // format 1 (multi-track)
  pushU16(bytes, tracks.length);
  pushU16(bytes, tpqn);

  tracks.forEach((track, ti) => {
    const data = trackData(track, ti === 0 ? bpm : null, ti, tpqn);
    pushStr(bytes, 'MTrk');
    pushU32(bytes, data.length);
    for (const b of data) bytes.push(b);
  });

  return Uint8Array.from(bytes);
}

// wav.js — encode an AudioBuffer to a 16-bit PCM WAV file (pure, no deps).
//
// Sibling to midi.js: data in (an AudioBuffer from an offline render) → bytes
// out (a RIFF/WAVE container). 16-bit PCM is universally readable by DAWs.

export function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const sampleRate = buffer.sampleRate;
  const blockAlign = numCh * 2;          // 2 bytes/sample (16-bit)
  const dataSize = len * blockAlign;

  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  let o = 0;
  const u32 = (v) => { dv.setUint32(o, v, true); o += 4; };
  const u16 = (v) => { dv.setUint16(o, v, true); o += 2; };
  const str = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); };

  str('RIFF'); u32(36 + dataSize); str('WAVE');
  str('fmt '); u32(16); u16(1);          // PCM
  u16(numCh); u32(sampleRate); u32(sampleRate * blockAlign); u16(blockAlign); u16(16);
  str('data'); u32(dataSize);

  // Interleave channels, clamp to [-1,1], convert to signed 16-bit.
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(ab);
}

// Stem export: BWF (bext) writer, the STORE zip writer, and per-lane renderStem.
import { encodeWav, encodeBwf } from '../src/js/export/wav.js';
import { zipStore } from '../src/js/export/zip.js';
import { AudioEngine } from '../src/js/audio/audio.js';
import { normalizePatch } from '../src/js/audio/instrument.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// --- a fake AudioBuffer (encoders only use these four members) ----------------
function fakeBuffer(channels, sampleRate = 48000) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData: (c) => channels[c],
  };
}
const ascii = (bytes, off, n) => { let s = ''; for (let i = 0; i < n; i++) { const b = bytes[off + i]; if (b) s += String.fromCharCode(b); } return s; };
const u32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const u32LE = (b, o) => (u32(b, o) >>> 0);
const u16 = (b, o) => b[o] | (b[o + 1] << 8);

// Walk RIFF chunks → { id: {dataOff, size} } (assumes a valid WAVE).
function chunks(bytes) {
  const out = {};
  let o = 12; // skip RIFF/size/WAVE
  while (o + 8 <= bytes.length) {
    const id = ascii(bytes, o, 4);
    const size = u32LE(bytes, o + 4);
    out[id] = { dataOff: o + 8, size };
    o += 8 + size + (size & 1);
  }
  return out;
}

// ---- encodeWav: container sanity --------------------------------------------
{
  const L = new Float32Array([0, 0.5, -0.5, 2]);   // 2 clamps to +1
  const R = new Float32Array([0, -1, 1, -2]);      // -2 clamps to -1
  const wav = encodeWav(fakeBuffer([L, R], 44100));
  ok(ascii(wav, 0, 4) === 'RIFF' && ascii(wav, 8, 4) === 'WAVE', 'wav: RIFF/WAVE header');
  ok(u32LE(wav, 4) === wav.length - 8, 'wav: RIFF size = total-8');
  const c = chunks(wav);
  ok(!!c['fmt '] && !!c['data'], 'wav: has fmt + data chunks');
  ok(u16(wav, c['fmt '].dataOff) === 1, 'wav: PCM format tag');
  ok(u16(wav, c['fmt '].dataOff + 2) === 2, 'wav: 2 channels');
  ok(u32LE(wav, c['fmt '].dataOff + 4) === 44100, 'wav: sample rate');
  ok(c['data'].size === 4 * 2 * 2, 'wav: data size = frames*ch*2');
  // last interleaved sample pair: L=+1 → 0x7fff, R=-1 → -32768
  const d = c['data'].dataOff;
  const lastL = (new Int16Array(wav.buffer.slice(d + 12, d + 14)))[0];
  const lastR = (new Int16Array(wav.buffer.slice(d + 14, d + 16)))[0];
  ok(lastL === 0x7fff, 'wav: +1.0 clamps to 0x7fff');
  ok(lastR === -32768, 'wav: -1.0 clamps to -32768');
}

// ---- encodeBwf: a valid WAVE PLUS a bext chunk ------------------------------
{
  const L = new Float32Array([0.1, -0.2, 0.3, -0.4]);
  const R = new Float32Array([0.4, -0.3, 0.2, -0.1]);
  const buf = fakeBuffer([L, R], 48000);
  const wav = encodeWav(buf);
  const bwf = encodeBwf(buf, { originator: 'Notorolla', description: 'proj - lane 1 (Tervik)', timeReferenceSamples: 0 });
  ok(ascii(bwf, 0, 4) === 'RIFF' && ascii(bwf, 8, 4) === 'WAVE', 'bwf: still RIFF/WAVE');
  ok(u32LE(bwf, 4) === bwf.length - 8, 'bwf: RIFF size = total-8');
  const c = chunks(bwf);
  ok(!!c['bext'], 'bwf: has bext chunk');
  ok(c['bext'].size === 602, 'bwf: bext is 602 bytes');
  ok(!!c['fmt '] && !!c['data'], 'bwf: still has fmt + data (players ignoring bext still play)');
  ok(ascii(bwf, c['bext'].dataOff, 22) === 'proj - lane 1 (Tervik)', 'bwf: Description written verbatim (ASCII)');
  ok(ascii(bwf, c['bext'].dataOff + 256, 9) === 'Notorolla', 'bwf: Originator = Notorolla');
  // OriginationDate yyyy-mm-dd at offset 256+32+32 = 320
  ok(/^\d{4}-\d{2}-\d{2}$/.test(ascii(bwf, c['bext'].dataOff + 320, 10)), 'bwf: OriginationDate yyyy-mm-dd');
  // TimeReference low/high at 256+32+32+10+8 = 338
  ok(u32LE(bwf, c['bext'].dataOff + 338) === 0 && u32LE(bwf, c['bext'].dataOff + 342) === 0, 'bwf: TimeReference = 0');
  ok(u16(bwf, c['bext'].dataOff + 346) === 1, 'bwf: bext Version = 1');
  // PCM identical to the plain WAV's data payload
  const cw = chunks(wav);
  const a = bwf.slice(c['data'].dataOff, c['data'].dataOff + c['data'].size);
  const b = wav.slice(cw['data'].dataOff, cw['data'].dataOff + cw['data'].size);
  ok(a.length === b.length && a.every((v, i) => v === b[i]), 'bwf: PCM byte-identical to encodeWav');
}

// ---- bwf: nonzero TimeReference (64-bit split) ------------------------------
{
  const buf = fakeBuffer([new Float32Array([0, 0])], 48000);
  const bwf = encodeBwf(buf, { timeReferenceSamples: 0x1_0000_0003 }); // > 32 bits
  const c = chunks(bwf);
  ok(u32LE(bwf, c['bext'].dataOff + 338) === 3, 'bwf: TimeReferenceLow = 3');
  ok(u32LE(bwf, c['bext'].dataOff + 342) === 1, 'bwf: TimeReferenceHigh = 1');
}

// ---- zipStore: structure, CRC, round-trip -----------------------------------
{
  const enc = new TextEncoder();
  const check = enc.encode('123456789');            // CRC-32 check value 0xCBF43926
  const hello = enc.encode('hello world');
  const zip = zipStore([{ name: '01 Tervik.wav', bytes: check }, { name: '02 Vesperia.wav', bytes: hello }]);

  // EOCD at the tail.
  const eocd = zip.length - 22;
  ok(u32LE(zip, eocd) === 0x06054b50, 'zip: EOCD signature');
  ok(u16(zip, eocd + 10) === 2, 'zip: total entries = 2');
  const cdOff = u32LE(zip, eocd + 16), cdSize = u32LE(zip, eocd + 12);
  ok(cdOff + cdSize === eocd, 'zip: central dir directly precedes EOCD');

  // First local header.
  ok(u32LE(zip, 0) === 0x04034b50, 'zip: local file header signature');
  ok(u16(zip, 8) === 0, 'zip: method = 0 (store)');
  ok(u32LE(zip, 14) === 0xCBF43926, 'zip: CRC-32 of "123456789" matches the standard check value');
  ok(u32LE(zip, 18) === check.length && u32LE(zip, 22) === check.length, 'zip: stored size = data size (no compression)');
  const nameLen = u16(zip, 26);
  ok(ascii(zip, 30, nameLen) === '01 Tervik.wav', 'zip: file name stored');
  const dataStart = 30 + nameLen;
  const back = zip.slice(dataStart, dataStart + check.length);
  ok(back.every((v, i) => v === check[i]), 'zip: stored bytes round-trip exactly');

  // First central-directory record at cdOff.
  ok(u32LE(zip, cdOff) === 0x02014b50, 'zip: central directory signature');
  ok(u32LE(zip, cdOff + 42) === 0, 'zip: first entry local-header offset = 0');
}

// ---- renderStem: a stubbed OfflineAudioContext ------------------------------
let panners = 0, comps = 0, lastFrames = 0, lastRate = 0;
function param(v = 0) { return { value: v, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} }; }
function fnode(extra = {}) { return { connect() {}, disconnect() {}, start() {}, stop() {}, ...extra }; }
class FakeOAC {
  constructor(ch, frames, rate) { lastFrames = frames; lastRate = rate; this._ch = ch; this._frames = frames; this._rate = rate; this.destination = fnode(); this.currentTime = 0; this.sampleRate = rate; }
  createGain() { return fnode({ gain: param(1) }); }
  createOscillator() { return fnode({ type: 'sine', frequency: param(0), detune: param(0), setPeriodicWave() {} }); }
  createStereoPanner() { panners++; return fnode({ pan: param(0) }); }
  createDynamicsCompressor() { comps++; return fnode({ threshold: param(0), knee: param(0), ratio: param(0), attack: param(0), release: param(0) }); }
  createPeriodicWave() { return {}; }
  createBiquadFilter() { return fnode({ type: 'lowpass', frequency: param(0), Q: param(1) }); }
  createDelay() { return fnode({ delayTime: param(0) }); }
  createChannelMerger() { return fnode(); }
  startRendering() { return Promise.resolve({ numberOfChannels: this._ch, length: this._frames, sampleRate: this._rate, getChannelData: () => new Float32Array(this._frames) }); }
}
globalThis.OfflineAudioContext = FakeOAC;

function stemEngine() {
  const eng = new AudioEngine();
  eng.ctx = { sampleRate: 48000 };
  eng.patchFor = () => normalizePatch({ kind: 'tervik' }); // tervik voice creates no panner
  return eng;
}
const notes = [{ pitch: 60, time: 0, duration: 0.5, velocity: 0.8, freq: 440, laneId: 7 }];

await (async () => {
  // dry: no lane strip → no panner, no compressor; correct frame count + rate.
  panners = comps = 0;
  const buf = await stemEngine().renderStem(notes, 2.0, 7, 'dry');
  ok(panners === 0, 'renderStem dry: no panner (inserts/fader bypassed)');
  ok(comps === 0, 'renderStem dry: no master limiter');
  ok(lastFrames === Math.ceil(2.0 * 48000) && lastRate === 48000, 'renderStem: frames + rate from duration/ctx');
  ok(buf && buf.length === lastFrames, 'renderStem: returns a buffer of the rendered length');

  // postfader: lane strip built (panner) but still no limiter.
  panners = comps = 0;
  await stemEngine().renderStem(notes, 1.0, 7, 'postfader');
  ok(panners === 1, 'renderStem postfader: lane panner built');
  ok(comps === 0, 'renderStem postfader: no master limiter');

  // baked: strip + master limiter.
  panners = comps = 0;
  await stemEngine().renderStem(notes, 1.0, 7, 'baked');
  ok(panners === 1 && comps === 1, 'renderStem baked: lane strip + master limiter');

  // non-finite duration floors to >=1 frame (no OfflineAudioContext throw).
  await stemEngine().renderStem(notes, NaN, 7, 'dry');
  ok(lastFrames >= 1, 'renderStem: non-finite duration floors to >=1 frame');
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

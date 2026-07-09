// model.js — the tune as data, independent of how it sounds or looks.
//
// Pitch is a MIDI note number (C4 = 60, a semitone is +1).
// Time is measured in *beats*, not seconds, so the music stays
// tempo-independent. Seconds are derived at the audio layer.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number -> frequency in Hz (A4 = 69 = 440 Hz, equal temperament). */
export function noteToFreq(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/** MIDI note number -> name like "C4". Octave numbering: C4 = 60. */
export function noteName(note) {
  const name = NOTE_NAMES[note % 12];
  const octave = Math.floor(note / 12) - 1;
  return `${name}${octave}`;
}

/** Pitch-class (0..11) -> name without octave (C, C#, …). The 12-ET case of a
 *  per-tuning naming seam; non-12 tunings would name their classes "whatever". */
export function pitchClassName(pc) {
  return NOTE_NAMES[(((pc % 12) + 12) % 12)];
}

/** Is this pitch a black key? Used to shade the piano-roll lanes. */
export function isBlackKey(note) {
  return [1, 3, 6, 8, 10].includes(note % 12);
}

/**
 * A note event. `start` and `duration` are in beats.
 * `velocity` is 0..1 (loudness / how hard the key is struck).
 */
export class Note {
  constructor(pitch, start, duration, velocity = 0.8) {
    this.pitch = pitch;
    this.start = start;
    this.duration = duration;
    this.velocity = velocity;
  }
}

/** A collection of notes plus a tempo. The unit of "a tune". */
export class Score {
  constructor(notes = [], bpm = 120, articulation = 0.88, length = null) {
    this.notes = notes;
    this.bpm = bpm;
    // Fraction of each note's rhythmic slot that actually sounds. Below 1 it
    // leaves a small gap before the next note — a slightly detached, non-legato
    // default. 1.0 would be fully legato; lower values play more staccato.
    this.articulation = articulation;
    // Explicit total length in beats. When set (e.g. a grid pattern whose tail
    // is rests), it overrides the from-notes calculation so trailing silence
    // still counts toward width and playback length. null = derive from notes.
    this.length = length;
  }

  get secondsPerBeat() {
    return 60 / this.bpm;
  }

  beatsToSeconds(beats) {
    return beats * this.secondsPerBeat;
  }

  /** Total length of the tune in beats (explicit length, else last note end). */
  get lengthBeats() {
    if (this.length != null) return this.length;
    return this.notes.reduce((max, n) => Math.max(max, n.start + n.duration), 0);
  }

  /** Lowest and highest pitches present, for sizing the roll. */
  get pitchRange() {
    if (this.notes.length === 0) return { min: 60, max: 72 };
    let min = Infinity, max = -Infinity;
    for (const n of this.notes) {
      if (n.pitch < min) min = n.pitch;
      if (n.pitch > max) max = n.pitch;
    }
    return { min, max };
  }
}

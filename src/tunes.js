// tunes.js — hand-written fixtures to render and play.

import { Note, Score } from './model.js';

// MIDI pitches we use here.
const C4 = 60, D4 = 62, E4 = 64, G4 = 67;

// "Mary Had a Little Lamb" — opening phrase.
//   E D C D | E E E  | D D D | E G G
// Quarter notes, with the phrase-ending notes held as half notes.
// Each entry: [pitch, durationInBeats].
const phrase = [
  [E4, 1], [D4, 1], [C4, 1], [D4, 1],
  [E4, 1], [E4, 1], [E4, 2],
  [D4, 1], [D4, 1], [D4, 2],
  [E4, 1], [G4, 1], [G4, 2],
];

function fromSequence(seq, bpm = 120) {
  const notes = [];
  let t = 0;
  for (const [pitch, dur] of seq) {
    notes.push(new Note(pitch, t, dur));
    t += dur;
  }
  return new Score(notes, bpm);
}

export const maryHadALittleLamb = fromSequence(phrase, 120);

// The grid editor's frozen reference backdrop (reference.js): bake a self-contained
// snapshot, apply its first-class transform on use, and round-trip through JSON.
import { bakeReference, referenceScore, referenceDisplay, mergeAudition, referenceToJSON, referenceFromJSON } from '../src/reference.js';
import { Pattern, DURATIONS } from '../src/grid.js';
import { transposeTransform, reverseTransform } from '../src/transforms.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const mkPattern = () => {
  const cols = [
    { durIndex: 1, isRest: false, degree: 60, accent: 0, artic: 2 }, // 1/4 C4
    { durIndex: 1, isRest: true,  degree: 62, accent: 0, artic: 2 }, // 1/4 rest
    { durIndex: 3, isRest: false, degree: 64, accent: 1, artic: 2 }, // 1/2 E4 accent
  ];
  const p = new Pattern(cols, 'A1');
  p.label = 'Bassline';
  p.tuningId = '12-et'; p.scaleId = 'chromatic'; p.root = 0;
  return p;
};
const patch = { kind: 'vesperia', attack: 0.01 };

// --- bake copies the data; the source is independent afterward ----------------
{
  const p = mkPattern();
  const ref = bakeReference(p, patch, null, { name: p.label });
  ok(ref.name === 'Bassline', 'name taken from the label');
  ok(ref.columns.length === 3 && ref.columns[0].degree === 60, 'columns copied');
  p.columns[0].degree = 72; // mutate the SOURCE after baking
  ok(ref.columns[0].degree === 60, 'reference is frozen — source edit does not leak in');
  ok(ref.patch && ref.patch.kind === 'vesperia', 'patch snapshot present');
}

// --- referenceScore: no transform → notes at their beats, correct pitches -----
{
  const ref = bakeReference(mkPattern(), patch, null, {});
  const s = referenceScore(ref, 120, 0.88);
  ok(s.notes.length === 2, 'two notes (the rest is silent)');
  ok(near(s.lengthBeats, 1 + 1 + 2), 'length = 1/4 + 1/4 + 1/2 = 4 beats');
  ok(s.notes[0].pitch === 60 && near(s.notes[0].start, 0), 'first note C4 at beat 0');
  ok(s.notes[1].pitch === 64 && near(s.notes[1].start, 2), 'second note E4 at beat 2 (after the rest)');
}

// --- the first-class transform is applied on use (chromatic transpose +2) -----
{
  const t = [transposeTransform(2, 'chromatic', 0)];
  const ref = bakeReference(mkPattern(), patch, t, {});
  const s = referenceScore(ref, 120, 0.88);
  ok(s.notes[0].pitch === 62 && s.notes[1].pitch === 66, 'transpose +2 applied to both notes');
  ok(ref.columns[0].degree === 60, 'transform is NOT baked into the stored columns (stays first-class)');
}

// --- reverse transform retrogrades in time ------------------------------------
{
  const ref = bakeReference(mkPattern(), patch, [reverseTransform()], {});
  const s = referenceScore(ref, 120, 0.88);
  // L=4: C4 was [0,1) → [3,4); E4 was [2,4) → [0,2).
  const c4 = s.notes.find((n) => n.pitch === 60);
  const e4 = s.notes.find((n) => n.pitch === 64);
  ok(near(e4.start, 0), 'reversed: E4 now first');
  ok(near(c4.start, 3), 'reversed: C4 now last');
}

// --- referenceDisplay: dot list + onset/endpoint beats + length ---------------
{
  const ref = bakeReference(mkPattern(), patch, null, {});
  const d = referenceDisplay(ref);
  ok(d.notes.length === 2, 'display has the two notes');
  ok(near(d.len, 4), 'display length = 4');
  ok(d.onsets.includes(0) && d.onsets.includes(2) && d.onsets.includes(4), 'onsets carry starts and ends');
}

// --- JSON round-trip is faithful ----------------------------------------------
{
  const t = [transposeTransform(-3, 'chromatic', 0)];
  const ref = bakeReference(mkPattern(), patch, t, { name: 'Ref', quieter: true, muted: true });
  const back = referenceFromJSON(referenceToJSON(ref));
  ok(back.name === 'Ref', 'name round-trips');
  ok(back.columns.length === 3 && back.columns[2].degree === 64, 'columns round-trip');
  ok(back.transforms && back.transforms[0].steps === -3, 'transform round-trips');
  ok(back.muted === true && back.quieter === true, 'mix flags round-trip');
  const s0 = referenceScore(ref, 120, 0.88), s1 = referenceScore(back, 120, 0.88);
  ok(s0.notes[0].pitch === s1.notes[0].pitch, 'rehydrated reference sounds the same');
  ok(referenceFromJSON(null) === null && referenceToJSON(null) === null, 'null passes through');
}

// --- mergeAudition: tiling, max length, phasing, patch tag, attenuation -------
const gridNote = (pitch, start, dur = 1, vel = 0.78) => { const n = { pitch, start, duration: dur, velocity: vel, freq: 440, artDur: dur * 0.88 }; return n; };
{
  // edited = 2 beats (two 1/4s), reference = 4 beats → total 4; edited tiles twice.
  const ref = bakeReference(mkPattern(), patch, null, { quieter: false }); // len 4
  const gridNotes = [gridNote(60, 0), gridNote(62, 1)];
  const { notes, total } = mergeAudition(ref, gridNotes, 2, 120, 0.88, 0.4);
  ok(near(total, 4), 'total = max(2,4) = 4');
  const grid = notes.filter((n) => n.patch == null);
  const refN = notes.filter((n) => n.patch != null);
  ok(grid.length === 4, 'edited tiled to fill (2 notes × 2 repeats)');
  ok(grid.some((n) => near(n.start, 2)) && grid.some((n) => near(n.start, 3)), 'the repeat is phase-shifted by the edited length');
  ok(refN.length === 2 && refN.every((n) => n.patch === ref.patch), 'reference notes carry the dry patch override');
}
{
  // Quieter attenuates ONLY the reference; Mute drops it.
  const ref = bakeReference(mkPattern(), patch, null, { quieter: true });
  const g = [gridNote(60, 0, 1, 0.8)];
  const m = mergeAudition(ref, g, 4, 120, 0.88, 0.4);
  const refN = m.notes.filter((n) => n.patch != null);
  ok(refN.every((n) => n.velocity < 0.79), 'Quieter scales reference velocity down');
  ok(m.notes.filter((n) => n.patch == null).every((n) => near(n.velocity, 0.8)), 'edited velocity untouched');
  ref.muted = true;
  const mm = mergeAudition(ref, g, 4, 120, 0.88, 0.4);
  ok(mm.notes.every((n) => n.patch == null) && near(mm.total, 4), 'Muted → no reference notes');
}
{
  // reference SHORTER than edited → the reference tiles to fill.
  const ref = bakeReference(mkPattern(), patch, null, {}); // len 4
  const g = Array.from({ length: 8 }, (_, i) => gridNote(60 + i, i)); // 8 beats
  const { notes, total } = mergeAudition(ref, g, 8, 120, 0.88, 0.4);
  ok(near(total, 8), 'total = max(8,4) = 8');
  const refN = notes.filter((n) => n.patch != null);
  ok(refN.length === 4, 'reference (2 notes) tiled twice to fill 8 beats');
}

console.log(`reference: ${pass}/${pass + fail}`);
if (fail) process.exit(1);

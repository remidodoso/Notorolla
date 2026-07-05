// Duration-footer refactor: the pure column helpers that back the two grid drags.
// swapNotePayload = body drag (swap pitch/rest/accent, KEEP durations);
// swapColumn = footer drag (swap the whole column); durationLabel = the footer text.
import { swapNotePayload, swapColumn, swapLanes, LANE_FIELDS, durationLabel, nextDurIndex, stretchWidth, nextAccent, accentVelocity, nextArtic, articBeats, ARTICULATIONS, DEFAULT_ARTIC, Pattern, DURATIONS, DUR_ORDER } from '../src/grid.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

const mkCols = () => ([
  { durIndex: 1, isRest: false, degree: 60, accent: 0 }, // 1/4, C4, normal
  { durIndex: 3, isRest: false, degree: 64, accent: 1 }, // 1/2, E4, accent
  { durIndex: 0, isRest: true,  degree: 62, accent: 0 }, // 1/8, rest
]);

// --- swapNotePayload: only the PITCH moves; duration AND accent stay with the slot ---
{
  const c = mkCols();
  swapNotePayload(c, 0, 1);
  ok(c[0].degree === 64 && c[0].isRest === false, 'pitch of col1 landed in col0');
  ok(c[1].degree === 60, 'pitch of col0 landed in col1');
  ok(c[0].accent === 0 && c[1].accent === 1, 'accent level STAYS with the slot (a column groove attribute)');
  ok(c[0].durIndex === 1 && c[1].durIndex === 3, 'durations stay with their slots (1/4, 1/2)');
}
{
  // swap a note with a rest — the rest-ness travels, the groove (dur + accent) does not
  const c = mkCols();
  swapNotePayload(c, 0, 2);
  ok(c[0].isRest === true && c[2].isRest === false && c[2].degree === 60, 'rest/note pitch exchanged');
  ok(c[0].durIndex === 1 && c[2].durIndex === 0, 'durations unchanged by a note↔rest swap');
}
{
  const c = mkCols();
  const before = JSON.stringify(c);
  swapNotePayload(c, 1, 1);
  ok(JSON.stringify(c) === before, 'swapNotePayload(a,a) is a no-op');
}

// --- swapColumn: the whole column (duration included) moves ------------------
{
  const c = mkCols();
  swapColumn(c, 0, 1);
  ok(c[0].degree === 64 && c[0].durIndex === 3 && c[0].accent === 1, 'whole col1 (incl. 1/2 + accent) landed in col0');
  ok(c[1].degree === 60 && c[1].durIndex === 1, 'whole col0 (incl. 1/4) landed in col1');
}
{
  const c = mkCols();
  const before = JSON.stringify(c);
  swapColumn(c, 2, 2);
  ok(JSON.stringify(c) === before, 'swapColumn(a,a) is a no-op');
}

// --- swapLanes: exchange only the ARMED subset of lanes between two columns ---
const mkFull = () => ([
  { durIndex: 1, isRest: false, degree: 60, accent: 0, artic: 2 }, // 1/4, C4, normal, norm-artic
  { durIndex: 3, isRest: true,  degree: 64, accent: 1, artic: 4 }, // 1/2, rest, accent, tenuto
]);
ok(JSON.stringify(LANE_FIELDS.notes) === JSON.stringify(['degree', 'isRest']), 'notes lane = degree + isRest');
{
  // notes-only: same as swapNotePayload — pitch/rest move, groove stays put
  const c = mkFull();
  swapLanes(c, 0, 1, ['notes']);
  ok(c[0].degree === 64 && c[0].isRest === true, 'swapLanes(notes): pitch+rest of col1 → col0');
  ok(c[0].durIndex === 1 && c[0].accent === 0 && c[0].artic === 2, 'swapLanes(notes): groove of col0 stays');
  const ref = mkFull(); swapNotePayload(ref, 0, 1);
  ok(JSON.stringify(c) === JSON.stringify(ref), 'swapLanes([notes]) === swapNotePayload');
}
{
  // one lane only: accent swaps, nothing else moves
  const c = mkFull();
  swapLanes(c, 0, 1, ['accent']);
  ok(c[0].accent === 1 && c[1].accent === 0, 'swapLanes(accent): only accents exchange');
  ok(c[0].degree === 60 && c[0].durIndex === 1 && c[0].artic === 2, 'swapLanes(accent): notes/dur/artic untouched');
}
{
  // a two-lane armed subset: duration + articulation ride together, notes/accent stay
  const c = mkFull();
  swapLanes(c, 0, 1, ['duration', 'articulation']);
  ok(c[0].durIndex === 3 && c[0].artic === 4, 'swapLanes(dur+artic): both moved to col0');
  ok(c[0].degree === 60 && c[0].accent === 0, 'swapLanes(dur+artic): notes + accent stayed');
}
{
  // all four lanes === a whole-column swap
  const c = mkFull(); swapLanes(c, 0, 1, ['notes', 'duration', 'accent', 'articulation']);
  const ref = mkFull(); swapColumn(ref, 0, 1);
  ok(JSON.stringify(c) === JSON.stringify(ref), 'swapLanes(all four) === swapColumn');
}
{
  const c = mkFull();
  const before = JSON.stringify(c);
  swapLanes(c, 1, 1, ['notes', 'duration', 'accent', 'articulation']);
  ok(JSON.stringify(c) === before, 'swapLanes(a,a) is a no-op');
}

// --- durationLabel matches the model, and rotate cycles it ------------------
ok(durationLabel(1) === '1/4' && durationLabel(3) === '1/2' && durationLabel(4) === '1/16', 'labels match DURATIONS names');
ok(durationLabel(999) === '', 'out-of-range durIndex → empty label');
{
  // nextDurIndex walks the ascending-beats order and wraps (the brush palette uses
  // it; the duration chit itself now sets-to-brush rather than rotating)
  let d = DUR_ORDER[0];
  const seen = [];
  for (let i = 0; i < DUR_ORDER.length; i++) { seen.push(DURATIONS[d].beats); d = nextDurIndex(d); }
  const sorted = [...seen].sort((a, b) => a - b);
  ok(JSON.stringify(seen) === JSON.stringify(sorted), 'nextDurIndex visits durations shortest→longest');
  ok(d === DUR_ORDER[0], 'nextDurIndex wraps back to the start');
}

// --- stretchWidth: log-compressed, bounded, monotonic ----------------------
{
  const MIN = 26, MAX = 60;
  // shortest duration (1/16 = idx 4) → MIN, longest (1/2 = idx 3) → MAX
  const shortIdx = DUR_ORDER[0], longIdx = DUR_ORDER[DUR_ORDER.length - 1];
  ok(Math.abs(stretchWidth(shortIdx, MIN, MAX) - MIN) < 1e-9, 'shortest duration maps to minW');
  ok(Math.abs(stretchWidth(longIdx, MIN, MAX) - MAX) < 1e-9, 'longest duration maps to maxW');
  // monotonic increasing along ascending-beats order, and all within [MIN,MAX]
  let prev = -Infinity, mono = true, bounded = true;
  for (const idx of DUR_ORDER) {
    const w = stretchWidth(idx, MIN, MAX);
    if (w < prev - 1e-9) mono = false;
    if (w < MIN - 1e-9 || w > MAX + 1e-9) bounded = false;
    prev = w;
  }
  ok(mono, 'width increases with note value');
  ok(bounded, 'all widths stay within [minW, maxW]');
  // compression: a 1/4 (idx1, 1.0 beat) sits nearer the middle than linear would put it
  const q = stretchWidth(1, MIN, MAX);
  ok(q > MIN && q < MAX, '1/4 lands strictly inside the band');
}

// --- accent levels: cycle 0→1→2→0 and map to velocities (ghost softer) ------
ok(nextAccent(0) === 1 && nextAccent(1) === 2 && nextAccent(2) === 0, 'accent cycles normal→accent→ghost→normal');
ok(accentVelocity(1) > accentVelocity(0) && accentVelocity(0) > accentVelocity(2), 'velocities: accent > normal > ghost');
ok(accentVelocity(0) === 0.78 && accentVelocity(1) === 1.0 && accentVelocity(2) === 0.45, 'velocity values (0.78 / 1.0 / 0.45)');

// --- articulation: gate resolution, cycle, and toScore/round-trip ----------
{
  const spb = 0.5; // 120 bpm
  ok(Math.abs(articBeats(1, 1, spb) - 0.5) < 1e-9, 'staccato = 0.5 × beats');
  ok(Math.abs(articBeats(2, 1, spb) - 0.88) < 1e-9, 'normal = 0.88 × beats');
  ok(Math.abs(articBeats(3, 1, spb) - 1.0) < 1e-9, 'legato = 1.0 × beats');
  ok(Math.abs(articBeats(4, 1, spb) - 1.15) < 1e-9, 'tenuto = 1.15 × beats (> 1)');
  ok(Math.abs(articBeats(0, 1, spb) - (0.055 / spb)) < 1e-9, 'spiccato = absolute seconds → beats');
  ok(articBeats(0, 0.05, spb) === 0.05, 'spiccato capped at a tiny slot (never over-runs)');
  ok(articBeats(0, 2, spb) === articBeats(0, 1, spb), 'spiccato is duration-independent (same for 1 or 2 beats)');
  ok(nextArtic(0) === 1 && nextArtic(4) === 0, 'articulation cycles spiccato…tenuto…spiccato');
  ok(DEFAULT_ARTIC === 2 && ARTICULATIONS[DEFAULT_ARTIC].id === 'normal', 'default articulation is normal');
}
{
  // toScore bakes each note's sounded length (artDur) from its column articulation
  const s = new Pattern([
    { durIndex: 1, isRest: false, degree: 60, accent: 0, artic: 1 }, // 1/4 staccato
    { durIndex: 1, isRest: false, degree: 62, accent: 0, artic: 4 }, // 1/4 tenuto
  ], 'X').toScore(120, 0.88);                                         // spb 0.5, 1/4 = 1 beat
  ok(Math.abs(s.notes[0].artDur - 0.5) < 1e-9, 'toScore: staccato note artDur = 0.5 beats');
  ok(Math.abs(s.notes[1].artDur - 1.15) < 1e-9, 'toScore: tenuto note artDur = 1.15 beats (rings past the slot)');
}
{
  // artic round-trips; an old 4-field row defaults to normal
  const p = new Pattern([{ durIndex: 1, isRest: false, degree: 60, accent: 0, artic: 4 }], 'X');
  ok(Pattern.fromJSON(p.toJSON(), 'X').columns[0].artic === 4, 'artic survives toJSON/fromJSON');
  ok(Pattern.fromJSON([[1, 60, 0, 0]], 'X').columns[0].artic === DEFAULT_ARTIC, 'legacy 4-field row → normal');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

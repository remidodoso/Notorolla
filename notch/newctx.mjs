// library.newPattern: a blank New continues the current pattern's working
// context — its width, pitch context (tuning/scale/root) AND per-column
// performance lanes (duration/accent/articulation, a groove stencil) — clearing
// only the pitches, instead of snapping back to a default 12-ET chromatic blank.
import { PatternLibrary } from '../src/library.js';
import { BASE_PITCH } from '../src/grid.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// A is referenced (so it won't strand when we leave it), set to a non-default
// tuning/scale/root and a non-default width, with a distinct per-column groove
// (durations/accents/articulations) and actual notes to prove pitches clear.
const refs = new Set();
const lib = new PatternLibrary((name) => refs.has(name));
const a = lib.seed();
a.tuningId = '16-et'; a.scaleId = 'mavila7'; a.root = 3;
a.columns = [
  { durIndex: 3, isRest: false, degree: 64, accent: 1, artic: 0 },
  { durIndex: 0, isRest: false, degree: 67, accent: 2, artic: 4 },
  { durIndex: 2, isRest: true, degree: 60, accent: 0, artic: 2 },
];
refs.add('A');

const n = lib.newPattern();
ok(n && n.name !== 'A', `New mints a fresh name (${n && n.name})`);
ok(lib.currentName === n.name, 'New becomes current');
ok(n.tuningId === '16-et' && n.scaleId === 'mavila7' && n.root === 3, 'New inherits tuning/scale/root');
ok(n.columns.length === 3, 'New inherits the working width');
ok(n.isEmpty(), 'New is a blank (all rests) — pitches cleared');
// Performance lanes carried per column…
ok(n.columns.map((c) => c.durIndex).join() === '3,0,2', 'duration lane carried per column');
ok(n.columns.map((c) => c.accent).join() === '1,2,0', 'accent lane carried per column');
ok(n.columns.map((c) => c.artic).join() === '0,4,2', 'articulation lane carried per column');
// …but pitches reset to the diagonal, independent of the source object.
ok(n.columns.every((c, i) => c.degree === BASE_PITCH + i), 'pitches reset to the diagonal');
n.columns[0].accent = 2;
ok(a.columns[0].accent === 1, 'stencil is independent of the source (no aliasing)');

// A brand-new library's very first pattern has no source → stays 12-ET chromatic.
const fresh = new PatternLibrary(() => false).seed();
ok(fresh.tuningId === '12-et' && fresh.scaleId === 'chromatic' && fresh.root === 0,
  'seed (no source) stays at defaults');

// New off a default-context pattern stays at defaults too (nothing to inherit).
{
  const lib2 = new PatternLibrary((name) => name === 'A');
  lib2.seed();
  const d = lib2.newPattern();
  ok(d.tuningId === '12-et' && d.scaleId === 'chromatic' && d.root === 0,
    'New off a default pattern stays at defaults');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

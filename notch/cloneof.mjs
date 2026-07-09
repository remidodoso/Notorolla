// library.cloneOf: deep-copy an arbitrary pattern by name without touching the
// current/parked editor state (the tile player's Clone tool).
import { PatternLibrary } from '../src/js/core/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

const refs = new Set();
const lib = new PatternLibrary((name) => refs.has(name));
const a = lib.seed(); // pattern A, current
a.columns[0] = { durIndex: 1, isRest: false, degree: 64, accent: true };
a.tuningId = '16-et'; a.scaleId = 'mavila7'; a.root = 3;
refs.add('A'); // A is referenced by a tile

const c = lib.cloneOf('A');
ok(c && c.name !== 'A', `cloneOf mints a fresh name (${c && c.name})`);
ok(lib.patterns.get(c.name) === c, 'clone registered in the library');
ok(lib.currentName === 'A' && lib.parkedName === null, 'current/parked untouched');
ok(c.columns[0].degree === 64 && c.columns[0].accent === true, 'columns deep-copied');
c.columns[0].degree = 70;
ok(a.columns[0].degree === 64, 'clone is independent (no aliasing)');
ok(c.tuningId === '16-et' && c.scaleId === 'mavila7' && c.root === 3, 'pitch context travels');
ok(lib.cloneOf('nosuch') === null, 'unknown name → null');

// Two clones of the same source get distinct names.
const c2 = lib.cloneOf('A');
ok(c2.name !== c.name, 'second clone gets its own name');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

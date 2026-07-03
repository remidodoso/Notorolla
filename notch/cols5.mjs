import { Pattern, DEFAULT_COLS, MIN_COLS, MAX_COLS } from '../src/grid.js';
import { PatternLibrary } from '../src/library.js';
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;}else{fail++;console.log('FAIL:',m);} };

// Pattern.initial sizing
ok(Pattern.initial('A').columns.length === DEFAULT_COLS, `default = ${DEFAULT_COLS} cols`);
ok(Pattern.initial('A', 16).columns.length === 16, 'initial(name,16) = 16 cols');
const p16 = Pattern.initial('A', 16);
ok(p16.columns.every((c,i)=>c.degree===60+i && c.isRest), 'diagonal degrees climb, all rests');

// per-pattern count survives toJSON/fromJSON (any length)
for (const n of [1, 7, 16, 20, 48]) {
  const rt = Pattern.fromJSON(Pattern.initial('A', n).toJSON(), 'A');
  ok(rt.columns.length === n, `round-trip preserves ${n} cols`);
}

// library.clearCurrent keeps the pattern's width
{
  const lib = new PatternLibrary(() => false);
  lib.seed();
  // grow the seed to 16 (simulate a resize: append rests)
  const c = lib.current();
  while (c.columns.length < 16) c.columns.push({ durIndex: 1, isRest: true, degree: 60, accent: false });
  c.columns[3].isRest = false; // a note
  lib.clearCurrent();
  ok(lib.current().columns.length === 16, 'clearCurrent keeps width (16)');
  ok(lib.current().columns.every(x=>x.isRest), 'clearCurrent leaves only rests');
}

// library.newPattern inherits the current width
{
  const lib = new PatternLibrary(() => true); // referenced → leaving is safe, canCreate true
  lib.seed();
  const c = lib.current();
  while (c.columns.length < 16) c.columns.push({ durIndex: 1, isRest: true, degree: 60, accent: false });
  const np = lib.newPattern();
  ok(np && np.columns.length === 16, `newPattern inherits width (got ${np && np.columns.length})`);
}

// PatternLibrary round-trip preserves mixed per-pattern widths
{
  const lib = new PatternLibrary(() => true);
  lib.seed(); // A = 12
  const a = lib.current();
  while (a.columns.length < 20) a.columns.push({ durIndex: 1, isRest: true, degree: 60, accent: false });
  const b = lib.newPattern(); // inherits 20
  while (b.columns.length > 8) b.columns.pop();
  const json = JSON.parse(JSON.stringify(lib.toJSON()));
  const lib2 = PatternLibrary.fromJSON(json, () => true);
  const widths = [...lib2.patterns.values()].map(p=>p.columns.length).sort((x,y)=>x-y);
  ok(JSON.stringify(widths) === JSON.stringify([8,20]), `mixed widths survive lib round-trip (got ${widths})`);
}

// clamp bounds sanity
ok(MIN_COLS >= 1 && MAX_COLS >= 16, `bounds: MIN=${MIN_COLS} MAX=${MAX_COLS}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

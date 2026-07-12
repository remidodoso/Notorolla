// The visualizer must survive a NO-EQUAVE tuning (the cross). Its cells are labelled
// by pitch class, but the cross has no pitch classes — pitchClassName would fall
// through to the per-degree near-12 path and mislabel ("undefined-2 −13"). The
// display goes through pitchClassLabel, which returns '' when there's no equave.
import { pitchClassLabel, pitchClassName, hasEquave, edoOf } from '../src/js/core/tuning.js';
import { buildLayout, layoutById } from '../src/js/core/hexlayout.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// --- pitchClassLabel: real labels where there's an equave, nothing where there isn't ---
ok(hasEquave('12-et') && hasEquave('16-et'), 'octave tunings report an equave');
ok(!hasEquave('cross'), 'the cross has no equave');

ok(pitchClassLabel(0, '12-et') === 'C', '12-ET pc0 → C');
ok(pitchClassLabel(1, '12-et') === pitchClassName(1, '12-et'), '12-ET label = pitchClassName');
ok(pitchClassLabel(10, '16-et') === pitchClassName(10, '16-et'), '16-ET label = pitchClassName (hex)');
ok(pitchClassLabel(0, '16-et') === '0', '16-ET pc0 → hex 0');

// The cross: EVERY pitch class labels as '' (never the malformed near-12 fall-through).
{
  const edo = edoOf('cross');
  let allBlank = true, anyMalformed = false;
  for (let pc = 0; pc < edo; pc++) {
    if (pitchClassLabel(pc, 'cross') !== '') allBlank = false;
    if (pitchClassName(pc, 'cross').startsWith('undefined')) anyMalformed = true;
  }
  ok(allBlank, 'cross: pitchClassLabel is empty for all pitch classes');
  ok(anyMalformed, 'sanity: raw pitchClassName IS malformed for the cross (why the label gate exists)');
}

// --- buildLayout tolerates the cross: it still produces a sane board (the cells just
// go unlabelled). No throw, positive size, populated. ---
{
  const edo = edoOf('cross');
  const L = buildLayout({ width: 380, height: 260, edo, axes: layoutById('harmonic').axesFor(edo), baseDegree: 60 });
  ok(L.cells.length > 0 && L.hexSize > 0, `cross board builds (${L.cells.length} cells)`);
  // Whatever any cell's pc is, its DISPLAY label is empty — the fix, end to end.
  ok(L.cells.every((c) => pitchClassLabel(c.pc, 'cross') === ''), 'no cross cell yields a (mis)label');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

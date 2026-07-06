// Pattern friendly-name (label): the user-given name shown alongside the
// canonical registry name ("Break Beat 2 (A6)"). Contract:
//   - persists through the library toJSON/fromJSON round-trip
//   - is backward-safe (older saves without a label load as empty)
//   - is NOT inherited by clone()/stencil() (a clone keeps the canonical
//     naming sequence with no label — the Tile Inspector rename spec)
import { PatternLibrary } from '../src/library.js';
import { Pattern } from '../src/grid.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// default: unset
const p = Pattern.initial('A');
ok(p.label === '', 'label defaults to empty');

// clone / stencil do not carry a label
p.label = 'Break Beat 2';
ok(p.clone('A1').label === '', 'clone() does not inherit the label');
ok(p.stencil('A2').label === '', 'stencil() does not inherit the label');

// round-trip through the library
const lib = new PatternLibrary(() => false);
lib.seed();                       // A (current)
lib.current().label = 'Break Beat 2';
const json = JSON.parse(JSON.stringify(lib.toJSON()));
ok(json.patterns[0].label === 'Break Beat 2', 'label serialized');

const back = PatternLibrary.fromJSON(json, () => false);
ok(back.patterns.get('A').label === 'Break Beat 2', 'label restored on load');

// unlabeled patterns omit the field, and load as empty (backward-safe)
const lib2 = new PatternLibrary(() => false);
lib2.seed();
const json2 = lib2.toJSON();
ok(!('label' in json2.patterns[0]), 'unset label is omitted from JSON');
// simulate an OLD save (no label key at all)
const old = { patterns: [{ name: 'A', cols: lib2.current().toJSON() }], counter: 1, currentName: 'A', parkedName: null };
const back2 = PatternLibrary.fromJSON(old, () => false);
ok(back2.patterns.get('A').label === '', 'old save (no label) loads as empty');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

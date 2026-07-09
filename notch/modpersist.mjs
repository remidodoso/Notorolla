// Round-trip check: do lane modulators survive arrangement toJSON -> JSON -> fromJSON?
import { Arrangement } from '../src/js/core/library.js';

const a = new Arrangement();
a.lanes[0].modsByKind = {
  vesperia: [
    { on: true, shape: 'tri', target: 'timbre', amount: 0.5, rate: 0.25, phase: 90, loop: false },
    { on: false, shape: 'sin', target: '', amount: 0.25, rate: 0.1, phase: 0, loop: false },
  ],
};
const json = JSON.parse(JSON.stringify(a.toJSON()));
const b = Arrangement.fromJSON(json);
const m = b.lanes[0].modsByKind.vesperia?.[0];
console.log('restored mod 0:', JSON.stringify(m));
console.log(m && m.on === true && m.shape === 'tri' && m.target === 'timbre' && m.amount === 0.5 && m.rate === 0.25 && m.phase === 90
  ? 'PASS: mods survive the autosave round-trip'
  : 'FAIL: mods lost or mangled');

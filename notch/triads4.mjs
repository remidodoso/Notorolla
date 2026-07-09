// Step 4: the septimal Triadulator for 16-ET + per-tuning family populating.
import { classifyTriad, enumerateTriadulations, familiesFor, familyLabel } from '../src/js/core/triads.js';

let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;}else{fail++;console.log('FAIL:',m);} };
const eq=(a,b,m)=>ok(JSON.stringify(a)===JSON.stringify(b), `${m}  got ${JSON.stringify(a)}`);

// families per tuning
eq(familiesFor(12), ['trad','sus'], '12-ET families = trad,sus');
eq(familiesFor(16), ['septimal'], '16-ET families = septimal');
eq(familiesFor(5), [], 'an EDO with no templates → no families');
ok(familyLabel('septimal')==='sept', 'septimal label = sept');
ok(familyLabel('trad')==='trad' && familyLabel('sus')==='sus', '12-ET labels');
ok(familyLabel('unknown')==='unknown', 'unknown family → id fallback');

// classify 16-ET septimal triads (root + transposition + inversion)
eq(classifyTriad([0,5,13],16), {quality:'sept', root:0}, '[0,5,13] = sept root 0 (4:5:7)');
eq(classifyTriad([0,6,13],16), {quality:'sup', root:0}, '[0,6,13] = sup root 0');
eq(classifyTriad([13,5,0],16), {quality:'sept', root:0}, 'order-independent (set)');
eq(classifyTriad([2,7,15],16), {quality:'sept', root:2}, 'transposed sept root 2');
// inversion: [5,13,16] ≡ pcs {5,13,0} = sept root 0
eq(classifyTriad([5,13,16],16), {quality:'sept', root:0}, 'octave-folded inversion → sept root 0');
ok(classifyTriad([0,1,2],16)===null, '16-ET cluster → null');
// a 12-ET major triad is NOT a septimal triad in 16-ET space
ok(classifyTriad([0,4,7],16)===null, '12-ET maj pcs are not a 16-ET sept triad');

// enumerate with the septimal family
{
  const r = enumerateTriadulations([0,5,13], { families:['septimal'], edo:16 });
  ok(r.some(t=>t.leftover.length===0 && t.triads.length===1 && t.triads[0].pcs.join(',')==='0,5,13'), 'single sept triad is a proper covering');
}
{
  // two disjoint sept triads: {0,5,13} ∪ {2,7,15} = {0,2,5,7,13,15}
  const r = enumerateTriadulations([0,2,5,7,13,15], { proper:true, families:['septimal'], edo:16 });
  ok(r.length>=1, 'two-sept proper covering found');
  ok(r.every(t=>t.leftover.length===0), 'proper leaves no leftover');
}
{
  // empty / wrong family yields nothing
  ok(enumerateTriadulations([0,5,13], { families:[], edo:16 }).length===0, 'no families → empty (16)');
  ok(enumerateTriadulations([0,5,13], { families:['trad'], edo:16 }).length===0, 'trad family has no 16-ET templates → empty');
}

// 12-ET regression through the new families API
eq(classifyTriad([0,4,7]), {quality:'maj', root:0}, '12-ET maj still classifies (default edo)');
{
  const r = enumerateTriadulations([0,4,7], { families:['trad'], edo:12 });
  ok(r.some(t=>t.triads[0] && t.triads[0].pcs.join(',')==='0,4,7'), '12-ET trad enumerate still works');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

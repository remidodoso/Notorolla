import { scalesFor, scaleValidForEdo, inScale, nearestInScale, stepInScale } from '../src/scales.js';
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;}else{fail++;console.log('FAIL:',m);} };
const ids = (arr) => arr.map(s=>s.id);

// picker filtering
ok(JSON.stringify(ids(scalesFor(12)))===JSON.stringify(['chromatic','major-pent','minor-pent']), '12-ET scales');
ok(JSON.stringify(ids(scalesFor(16)))===JSON.stringify(['chromatic','mavila7','mavila-pent']), '16-ET scales');
ok(scaleValidForEdo('major-pent',12)===true, 'major-pent valid in 12');
ok(scaleValidForEdo('major-pent',16)===false, 'major-pent invalid in 16');
ok(scaleValidForEdo('mavila7',16)===true, 'mavila7 valid in 16');
ok(scaleValidForEdo('mavila7',12)===false, 'mavila7 invalid in 12');
ok(scaleValidForEdo('chromatic',16)===true, 'chromatic universal (16)');
ok(scaleValidForEdo('chromatic',12)===true, 'chromatic universal (12)');

// Mavila[7] membership {0,2,4,6,9,11,13} in edo 16
const inM = (d)=>inScale('mavila7',0,d,16);
ok([0,2,4,6,9,11,13].every(inM), 'all mavila7 degrees in');
ok([1,3,5,7,8,10,12,14,15].every(d=>!inM(d)), 'non-mavila degrees out');
ok(inM(16)===true, 'octave (pc0) in');
ok(inM(13+16)===true, '13+octave in');

// stepInScale walks the Mavila ladder
ok(stepInScale('mavila7',0,0,1,16)===2, 'mavila step 0→2');
ok(stepInScale('mavila7',0,4,1,16)===6, 'mavila step 4→6');
ok(stepInScale('mavila7',0,6,1,16)===9, 'mavila step 6→9 (the 3-step gap)');
ok(stepInScale('mavila7',0,13,1,16)===16, 'mavila step 13→16 (octave)');
ok(stepInScale('mavila7',0,2,-1,16)===0, 'mavila step down 2→0');

// nearest snap
ok(nearestInScale('mavila7',0,5,16)===4 || nearestInScale('mavila7',0,5,16)===6, 'snap 5 → 4 or 6 (nearest mavila)');
ok(nearestInScale('mavila7',0,1,16)===0 || nearestInScale('mavila7',0,1,16)===2, 'snap 1 → 0 or 2');

// mavila pentatonic {0,2,4,9,11}
const inP = (d)=>inScale('mavila-pent',0,d,16);
ok([0,2,4,9,11].every(inP) && !inP(6) && !inP(13), 'mavila-pent membership');

// 12-ET masks unaffected
ok(inScale('major-pent',0,7,12)===true && inScale('major-pent',0,7), 'major-pent still works (edo 12 default)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

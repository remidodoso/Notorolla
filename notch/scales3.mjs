import { scalesFor, scaleValidForEdo, inScale, nearestInScale, stepInScale } from '../src/js/core/scales.js';
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;}else{fail++;console.log('FAIL:',m);} };
const ids = (arr) => arr.map(s=>s.id);

// picker filtering
ok(JSON.stringify(ids(scalesFor(12)))===JSON.stringify([
  'chromatic','major','dorian','phrygian','lydian','mixolydian','minor','locrian',
  'harmonic-minor','melodic-minor','whole-tone','octatonic-wh','octatonic-hw','augmented',
  'blues','major-pent','minor-pent',
]), '12-ET scales');
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

// New 12-ET library: symmetric masks + a mode spot-check
ok(scaleValidForEdo('octatonic-wh',12)===true && scaleValidForEdo('octatonic-wh',16)===false, 'octatonic valid in 12 only');
const inOct = (d)=>inScale('octatonic-wh',0,d,12); // {0,2,3,5,6,8,9,11}
ok([0,2,3,5,6,8,9,11].every(inOct) && [1,4,7,10].every(d=>!inOct(d)), 'octatonic (W–H) membership');
ok(stepInScale('octatonic-wh',0,0,1,12)===2 && stepInScale('octatonic-wh',0,2,1,12)===3, 'octatonic steps W then H');
const inWT = (d)=>inScale('whole-tone',0,d,12);
ok([0,2,4,6,8,10].every(inWT) && [1,3,5,7,9,11].every(d=>!inWT(d)), 'whole-tone membership');
ok(stepInScale('whole-tone',0,10,1,12)===12, 'whole-tone 10→octave');
const inAug = (d)=>inScale('augmented',0,d,12); // {0,3,4,7,8,11}
ok([0,3,4,7,8,11].every(inAug) && [1,2,5,6,9,10].every(d=>!inAug(d)), 'augmented membership');
ok(inScale('major',0,4,12)===true && inScale('major',0,6,12)===false, 'major mode: 4 in, tritone out');
ok(inScale('lydian',0,6,12)===true, 'lydian: raised 4th in');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

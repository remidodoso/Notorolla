import { edoOf, tuningFreq, degreeToName, pitchClassName, TUNING_LIST } from '../src/tuning.js';
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;}else{fail++;console.log('FAIL:',m);} };
const near=(a,b,e=0.01)=>Math.abs(a-b)<=e;

// EDO + registry
ok(edoOf('16-et')===16, '16-et edo=16');
ok(TUNING_LIST.some(t=>t.id==='16-et' && t.label==='16-ET'), '16-ET in TUNING_LIST');

// Frequency: anchored so degree 60 = middle C; step = 2^(1/16); octave = 16 steps.
const C = tuningFreq(60,'16-et');
ok(near(C,261.6256), `deg60 16-ET = middle C (got ${C.toFixed(3)})`);
ok(near(tuningFreq(76,'16-et'), C*2), 'deg+16 = one octave up (2x)');
ok(near(tuningFreq(44,'16-et'), C/2), 'deg-16 = one octave down');
ok(near(tuningFreq(68,'16-et'), C*Math.SQRT2), 'deg+8 = exact tritone (x√2)');
ok(near(tuningFreq(61,'16-et')/C, Math.pow(2,1/16)), 'one step = 2^(1/16) (75¢)');
// the bad fifth: 9 steps = 675¢, ratio 2^(9/16)
ok(near(tuningFreq(69,'16-et')/C, Math.pow(2,9/16)), '9 steps = the flat fifth');
// 12-ET unchanged
ok(near(tuningFreq(60,'12-et'), 261.6256), '12-ET deg60 still middle C');
ok(near(tuningFreq(69,'12-et'), 440), '12-ET deg69 = A440');

// Naming: 16-ET hex classes + octave; 12-ET letters unchanged
ok(pitchClassName(0,'16-et')==='0', 'pc 0 → "0"');
ok(pitchClassName(10,'16-et')==='a', 'pc 10 → "a"');
ok(pitchClassName(15,'16-et')==='f', 'pc 15 → "f"');
ok(pitchClassName(16,'16-et')==='0', 'pc 16 wraps → "0"');
ok(pitchClassName(0,'12-et')==='C', '12-ET pc0 → C');
ok(pitchClassName(1,'12-et')==='C#', '12-ET pc1 → C#');
ok(pitchClassName(1)==='C#', 'default tuning = 12-ET letters');

ok(degreeToName(64,'16-et')==='04', 'deg64 16-ET → "04" (class 0, oct 4)');
ok(degreeToName(60,'16-et')==='c3', 'deg60 16-ET → "c3" (class 12=c, oct 3)');
ok(degreeToName(76,'16-et')==='c4', 'deg76 16-ET → c4 (class 12=c, oct 4)');
ok(degreeToName(80,'16-et')==='05', 'deg80 16-ET → "05"');
ok(degreeToName(60,'12-et')==='C4', '12-ET deg60 → C4 (unchanged)');
ok(degreeToName(61)==='C#4', '12-ET default deg61 → C#4');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

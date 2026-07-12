// The per-instrument scene router (future_directions §22): melodic voices light the
// pitch cell; Boshwick maps its drum TYPE to a board zone, with Tom the pitched
// hybrid exception. sceneForNote is pure, so the routing is testable without a canvas.
import { sceneForNote } from '../src/js/ui/vizhex.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// --- non-Boshwick and un-typed notes → melodic ---
ok(sceneForNote({ kind: 'vesperia', degree: 60 }) === 'melodic', 'a melodic instrument → melodic');
ok(sceneForNote({ kind: 'padlington' }) === 'melodic', 'another melodic instrument → melodic');
ok(sceneForNote({ kind: null }) === 'melodic', 'no kind → melodic');
ok(sceneForNote({}) === 'melodic', 'empty event → melodic');
ok(sceneForNote(null) === 'melodic', 'null event → melodic (no throw)');
ok(sceneForNote({ kind: 'boshwick' }) === 'melodic', 'boshwick with no type → melodic (safe fallback)');
ok(sceneForNote({ kind: 'boshwick', type: 'nonsense' }) === 'melodic', 'unknown drum type → melodic');

// --- Boshwick drum types → their scenes ---
ok(sceneForNote({ kind: 'boshwick', type: 'kick' }) === 'centre', 'kick → centre');
ok(sceneForNote({ kind: 'boshwick', type: 'tom' }) === 'pitched', 'tom → pitched (the hybrid exception)');
ok(sceneForNote({ kind: 'boshwick', type: 'snare' }) === 'band', 'snare → band');
ok(sceneForNote({ kind: 'boshwick', type: 'hat' }) === 'rimSparkle', 'hat → rimSparkle');
ok(sceneForNote({ kind: 'boshwick', type: 'cymbal' }) === 'rimWash', 'cymbal → rimWash');
ok(sceneForNote({ kind: 'boshwick', type: 'clap' }) === 'scatter', 'clap → scatter');
ok(sceneForNote({ kind: 'boshwick', type: 'cowbell' }) === 'dot', 'cowbell → dot');
ok(sceneForNote({ kind: 'boshwick', type: 'rim' }) === 'dot', 'rim → dot');
ok(sceneForNote({ kind: 'boshwick', type: 'clave' }) === 'dot', 'clave → dot');

// The type must actually be Boshwick's — a 'kick' type on some other kind stays melodic.
ok(sceneForNote({ kind: 'vesperia', type: 'kick' }) === 'melodic', 'a drum type on a non-drum kind → melodic');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

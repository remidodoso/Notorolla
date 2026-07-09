// patchRelease: every kind yields a finite tail value, so the export's
// Math.max(... releases) can't go NaN (the OfflineAudioContext "Length must be
// nonzero" bug when a Tervik lane has no top-level `release`).
import { defaultPatch, patchRelease } from '../src/js/audio/instrument.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// Tervik has no top-level release; its tail follows Op 1 (r1).
const tv = defaultPatch('tervik');
ok(tv.release === undefined, 'tervik default has no top-level release');
ok(patchRelease(tv) === tv.r1, 'tervik release = r1');
ok(isFinite(patchRelease(tv)), 'tervik release is finite');

// Other kinds use their top-level release.
for (const k of ['vesperia', 'zindel', 'wendelhorn']) {
  const p = defaultPatch(k);
  ok(patchRelease(p) === p.release, `${k} release = patch.release`);
  ok(isFinite(patchRelease(p)), `${k} release is finite`);
}

// Defensive: junk in → finite out.
ok(patchRelease(null) === 0, 'null → 0');
ok(patchRelease({}) === 0, 'no-release object → 0');
ok(patchRelease({ kind: 'tervik' }) === 0, 'tervik with no r1 → 0');
ok(patchRelease({ release: 'x' }) === 0, 'non-number release → 0');

// The actual export-tail expression with a Tervik lane present.
const lanes = [defaultPatch('vesperia'), defaultPatch('tervik')];
const maxRelease = Math.max(patchRelease(defaultPatch('vesperia')), ...lanes.map(patchRelease));
ok(isFinite(maxRelease), 'mixed lanes → finite maxRelease (no NaN)');
const tail = Math.max(2.5, maxRelease * 6 + 0.5);
ok(isFinite(tail) && tail >= 2.5, `tail is finite (${tail.toFixed(3)})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

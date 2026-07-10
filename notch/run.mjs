// Run every headless suite in this directory: `node notch/run.mjs` (from the
// project root, or `node run.mjs` from here). Each *.mjs test file is spawned
// as its own process (they call process.exit); wasim.mjs (the Web Audio
// simulator), the meter-*.mjs rigs (metering tools, not pass/fail tests) and
// this runner are skipped. Tests import the live ../src directly — no copy step
// (the root package.json's "type": "module" makes src ESM-resolvable to node).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skip = new Set(['run.mjs', 'wasim.mjs', 'meter-bosh.mjs', 'meter-pad.mjs']);
const suites = readdirSync(here).filter((f) => f.endsWith('.mjs') && !skip.has(f)).sort();

let failed = 0;
for (const f of suites) {
  const r = spawnSync(process.execPath, [join(here, f)], { encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').pop() || '(no output)';
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${f.padEnd(18)} ${last}`);
  if (!ok && r.stderr) console.log(r.stderr.trim());
}
console.log(failed ? `\n${failed} suite(s) FAILING` : '\nall suites green');
process.exit(failed ? 1 : 0);

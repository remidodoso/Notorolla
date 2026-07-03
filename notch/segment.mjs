// clampGrip: the normalized drag-grip rule (center small tiles, edge-margin big
// ones). (segmentHits and its tests left with the brushes — removed when the
// transform brushes became selection actions.)
import { clampGrip } from '../src/tileplayer.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// tile height 52 → half = 26
ok(clampGrip(0, 200) === 26, 'wide tile: left-corner grab clamps to 26 px in');
ok(clampGrip(197, 200) === 174, 'wide tile: right-corner grab clamps to w−26');
ok(clampGrip(100, 200) === 100, 'wide tile: interior grab preserved exactly');
ok(clampGrip(3, 40) === 20 && clampGrip(38, 40) === 20, 'narrow tile (w ≤ height): always centered');
ok(clampGrip(26, 52) === 26, 'boundary width (w = height): center, continuous with both regimes');
ok(clampGrip(5, 0) === 0, 'degenerate zero-width: grip 0');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

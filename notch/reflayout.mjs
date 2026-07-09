// Merged engraving-time layout (grid.js mergedLayout) — the shared beat→x map both
// the edited pattern and a reference render through (future_directions.md §16).
import { mergedLayout, widthForBeats, stretchWidth, DURATIONS } from '../src/grid.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const MINW = 31, MAXW = 72;
const col = (durIndex, degree = 60, isRest = false) => ({ durIndex, degree, isRest, accent: 0, artic: 2 });
const beatsOf = (c) => DURATIONS[c.durIndex].beats;
const lenOf = (cols) => cols.reduce((s, c) => s + beatsOf(c), 0);

// --- widthForBeats generalizes stretchWidth exactly at the DURATIONS values ---
{
  for (let i = 0; i < DURATIONS.length; i++) {
    ok(near(widthForBeats(DURATIONS[i].beats, MINW, MAXW), stretchWidth(i, MINW, MAXW)),
      `widthForBeats(DURATIONS[${i}]) == stretchWidth(${i})`);
  }
  ok(widthForBeats(0.25, MINW, MAXW) === MINW, 'shortest → floor');
  ok(widthForBeats(2, MINW, MAXW) === MAXW, 'longest → ceiling');
  ok(widthForBeats(5, MINW, MAXW) === MAXW, 'beyond longest clamps to ceiling');
}

// --- degenerate (no reference) == today's Stretch, column-for-column ----------
{
  const cols = [col(1), col(3), col(0), col(5)]; // 1/4, 1/2, 1/16, 3/16
  const L = mergedLayout(cols, null, MINW, MAXW);
  let x = 0;
  cols.forEach((c, i) => {
    ok(near(L.editedColX[i].x, x), `col ${i} x matches sequential stretch`);
    ok(near(L.editedColX[i].w, stretchWidth(c.durIndex, MINW, MAXW)), `col ${i} width == stretchWidth`);
    x += stretchWidth(c.durIndex, MINW, MAXW);
  });
  ok(near(L.width, x), 'total width == sum of stretch widths');
  ok(near(L.total, lenOf(cols)), 'total beats == edited length');
}

// --- coincident onsets align: a reference onset on an edited boundary shares x --
{
  const cols = [col(1), col(1), col(1), col(1)]; // four 1/4s → onsets 0,1,2,3
  const ref = { onsets: [0, 1, 2, 3, 4], len: 4 };  // note starts/ends on the same grid
  const L = mergedLayout(cols, ref, MINW, MAXW);
  // beat 2 is an edited boundary AND a reference onset — one x for both.
  ok(near(L.beatToX(2), L.editedColX[2].x), 'reference onset at beat 2 aligns with edited col 2');
  ok(near(L.total, 4), 'equal lengths → total == 4');
}

// --- a FOREIGN onset carves an edited column into multiple segments (wider) ----
{
  const cols = [col(3)]; // one 1/2 note = 2 beats, no internal boundary
  const soloW = mergedLayout(cols, null, MINW, MAXW).editedColX[0].w;
  const ref = { onsets: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], len: 2 }; // 1/16 grid under it
  const L = mergedLayout(cols, ref, MINW, MAXW);
  ok(L.editedColX[0].w > soloW + 1, 'the half-note gets WIDER when a reference subdivides it');
  ok(near(L.editedColX[0].x, 0), 'still starts at x=0');
  ok(near(L.editedColX[0].w, L.width), 'the single column spans the whole width');
}

// --- length mismatch: total = max; reference loops; edited ghost-zone is inert -
{
  const cols = [col(1), col(1)]; // edited = 2 beats
  const ref = { onsets: [0, 1, 2], len: 3 }; // reference = 3 beats (longer)
  const L = mergedLayout(cols, ref, MINW, MAXW);
  ok(near(L.total, 3), 'total == max(2,3)');
  ok(L.editedLen === 2 && L.refLen === 3, 'lengths reported');
  ok(L.xToEditedCol(L.editedColX[0].x + 1) === 0, 'x inside col 0 → 0');
  ok(L.xToEditedCol(L.width - 1) === -1, 'x past the editable first instance → -1 (ghost-repeat zone)');
}

// --- edited LONGER than reference: no ghost zone (whole thing editable) --------
{
  const cols = [col(1), col(1), col(1), col(1)]; // 4 beats
  const ref = { onsets: [0, 1], len: 2 };            // 2 beats
  const L = mergedLayout(cols, ref, MINW, MAXW);
  ok(near(L.total, 4), 'total == max(4,2)');
  ok(L.xToEditedCol(L.width - 1) === 3, 'last x maps to the final editable column (no ghost zone)');
}

// --- beatToX is monotone non-decreasing across the timeline -------------------
{
  const cols = [col(0), col(3), col(1)];
  const ref = { onsets: [0, 0.75, 1.9], len: 2.5 };
  const L = mergedLayout(cols, ref, MINW, MAXW);
  let prev = -1;
  for (let b = 0; b <= L.total + 1e-9; b += 0.25) {
    const x = L.beatToX(b);
    ok(x >= prev - 1e-6, `beatToX monotone at beat ${b}`);
    prev = x;
  }
}

console.log(`reflayout: ${pass}/${pass + fail}`);
if (fail) process.exit(1);

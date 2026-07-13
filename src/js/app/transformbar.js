// transformbar.js — the tile transform bar: Ripple toggle, the Transpose /
// Reverse / Clone selection actions (with the transpose amount+scale controls),
// the Insert/Clear/Delete range tools drawn on the ruler, and the per-selection
// transform chips. One bar, two roles (tool palette + per-tile readout).

import { setTileTranspose, setTileReverse, setTileDetune, hasReverse, describeTransform, transformKindLabel, DETUNE_MAX } from '../core/transforms.js';
import { edoOf, pitchClassName } from '../core/tuning.js';
import { scalesFor, scaleById } from '../core/scales.js';
import { insertPoint, deletePoint } from '../core/library.js';

export function initTransformbar(ctx) {
  const { library, arrangement, tilePlayer } = ctx;
  const state = ctx.state;

  // --- transform ACTIONS: select tiles, then click the button ---------------
  //
  // (The former brushes — arm a tool, then paint tiles — were removed once
  // multi-select landed: select-THEN-button is one mental model shared with the
  // grid's Permute tools, and it deleted the whole paint-gesture/armed-session
  // machinery. Buttons act on the current selection, single or multiple; one
  // undo entry per action; the selection survives so actions chain.)
  ctx.rangeMode = null;                                  // null | 'insert' | 'clear' | 'delete' — armed Range tool (draws on the ruler)
  const transposeOpts = { amount: 1, scaleId: 'auto' };  // the Transpose action's parameters (always visible in the bar)
  const detuneOpts = { cents: 10 };                      // the Detune action's parameter (± cents)

  // Transpose: SET each selected tile's transpose to the bar's amount (a second
  // application replaces, never accumulates; amount 0 clears). Scale 'auto' =
  // each tile's own mask; the root is always the tile's.
  function applyTransposeAction() {
    const tiles = ctx.selectedTiles();
    if (!tiles.length) return;
    const before = ctx.arrSnap();
    for (const tile of tiles) {
      const p = library.patterns.get(tile.name);
      const root = p ? p.root : 0;
      const scaleId = transposeOpts.scaleId === 'auto' ? (p ? p.scaleId : 'chromatic') : transposeOpts.scaleId;
      setTileTranspose(tile, transposeOpts.amount, scaleId, root);
    }
    ctx.arrCommit(before);
    ctx.refresh();
  }

  // Detune: SET each selected tile's detune to the bar's cents (a second
  // application replaces, never accumulates; 0 clears). Uniform-pitch contract:
  // the sounding pitch shifts by the full cents on every instrument.
  function applyDetuneAction() {
    const tiles = ctx.selectedTiles();
    if (!tiles.length) return;
    const before = ctx.arrSnap();
    for (const tile of tiles) setTileDetune(tile, detuneOpts.cents);
    ctx.arrCommit(before);
    ctx.refresh();
  }

  // Reverse: unify, don't flip-flop — if EVERY selected tile is reversed,
  // un-reverse them all; otherwise reverse them all.
  function applyReverseAction() {
    const tiles = ctx.selectedTiles();
    if (!tiles.length) return;
    const target = !tiles.every((t) => hasReverse(t.transforms));
    const before = ctx.arrSnap();
    for (const tile of tiles) setTileReverse(tile, target);
    ctx.arrCommit(before);
    ctx.refresh();
  }

  // Clone: repoint each selected tile onto a fresh copy of its pattern, "as if
  // cloned in the grid" — position + per-tile transforms untouched. DEDUPED per
  // source within the action (5×A1 + 2×A3 selected → 5×A8 + 2×A9), so a selection
  // keeps its internal sharing while diverging as a block. The ANCHOR tile's
  // clone then opens in the grid editor. Undo repoints the tiles back; the cloned
  // patterns linger in the registry (accepted — a future pattern browser /
  // orphan-GC is the real fix).
  function applyCloneAction() {
    const tiles = ctx.selectedTiles();
    if (!tiles.length) return;
    const before = ctx.arrSnap();
    const map = new Map(); // srcName -> cloneName, this action only
    for (const tile of tiles) {
      let cloneName = map.get(tile.name);
      if (!cloneName) {
        const p = library.cloneOf(tile.name);
        if (!p) continue;
        map.set(tile.name, p.name);
        cloneName = p.name;
      }
      tile.name = cloneName;
    }
    ctx.arrCommit(before);
    const anchor = arrangement.allTiles().find((t) => t.id === arrangement.selectedId) || tiles[0];
    const p = anchor && library.patterns.get(anchor.name);
    if (p) { library.open(p.name); ctx.centerGridOn(p); } // the anchor's clone becomes the grid's current
    ctx.refresh();
  }

  // Arm/disarm a Range tool (Insert / Clear / Delete time): the ruler becomes the
  // gesture surface (it glows; markers go inert) until a range is drawn.
  // Exclusive, one-shot, Shift keeps armed, Esc disarms.
  function setRangeTool(kind) {
    ctx.rangeMode = ctx.rangeMode === kind ? null : kind;
    tilePlayer.setRangeMode(ctx.rangeMode);
    refreshTransformBar();
  }
  function disarmRangeTool() { if (ctx.rangeMode) setRangeTool(ctx.rangeMode); }

  // The tiles a pending range op touches: `doomed` will be removed (starts in the
  // range — Clear/Delete), `shifted` will move (Insert: everything from the range
  // start; Delete: everything from the range end). Same predicates as the ops.
  function rangeAffected(kind, s, e) {
    const doomed = new Set(), shifted = new Set();
    for (const t of arrangement.allTiles()) {
      if (kind !== 'insert' && t.start >= s && t.start < e) doomed.add(t.id);
      if (kind === 'insert' && t.start >= s) shifted.add(t.id);
      if (kind === 'delete' && t.start >= e) shifted.add(t.id);
    }
    return { doomed, shifted };
  }

  // Commit a drawn range: apply the op (one undo entry), carry the parked
  // playhead through it (markers ride inside the Arrangement ops), and disarm
  // unless Shift was held. An empty range (a plain click) just cancels.
  function commitRange(kind, s, e, keepArmed) {
    tilePlayer.setRangePreview(null, null);
    if (e <= s) { disarmRangeTool(); return; }
    const before = ctx.arrSnap();
    if (kind === 'insert') {
      arrangement.insertTime(s, e - s);
      // Same origin exception as the start marker (insertTime): a playhead parked
      // at the very start stays there on an insert-at-0 — the user expects it to
      // remain at "the start", not jump past the newly inserted time.
      if (!(s === 0 && state.playheadBeat === 0)) state.playheadBeat = insertPoint(state.playheadBeat, s, e - s);
    } else if (kind === 'clear') {
      arrangement.clearRange(s, e);
    } else {
      arrangement.deleteTime(s, e);
      state.playheadBeat = deletePoint(state.playheadBeat, s, e);
    }
    state.playheadBeat = ctx.clampPlayhead(state.playheadBeat);
    tilePlayer.setPlayhead(state.playheadBeat);
    ctx.arrCommit(before); // no-op when the range touched nothing
    if (!keepArmed) disarmRangeTool();
    ctx.refresh();
  }

  function bumpTranspose(d) {
    transposeOpts.amount = Math.max(-24, Math.min(24, transposeOpts.amount + d));
    refreshTransformBar();
  }

  function bumpDetune(d) {
    detuneOpts.cents = Math.max(-DETUNE_MAX, Math.min(DETUNE_MAX, detuneOpts.cents + d));
    refreshTransformBar();
  }

  // Remove one transform KIND from every selected tile (a chip's ✕), one undo.
  function removeSelectedTransform(kind) {
    const tiles = ctx.selectedTiles();
    if (!tiles.length) return;
    const before = ctx.arrSnap();
    for (const tile of tiles) {
      if (kind === 'transpose') setTileTranspose(tile, 0);
      else if (kind === 'reverse') setTileReverse(tile, false);
      else if (kind === 'detune') setTileDetune(tile, 0);
    }
    ctx.arrCommit(before);
    ctx.refresh();
  }

  // The transform bar: the Transpose + Reverse brush toggles, Transpose's armed
  // controls (amount stepper + scale select), and the selected tile's ordered
  // transform chips (each clearable). One bar, two roles (tool palette + per-tile
  // readout). Built once; refreshTransformBar syncs state.
  const transformBarEl = document.getElementById('transformBar');
  let xbRippleBtn, xbTransBtn, xbRevBtn, xbCloneBtn, xbArmedEl, xbAmountEl, xbScaleSel, xbKeyEl, xbSelEl;
  let xbDetBtn, xbDetArmedEl, xbDetAmountEl; // Detune action + its cents stepper
  let xbInsBtn, xbClrBtn, xbDelBtn; // Range tools (draw a range on the ruler)

  function buildTransformBar() {
    transformBarEl.innerHTML = '';
    const mkBtn = (text, title, onclick) => { const b = document.createElement('button'); b.textContent = text; b.title = title; b.onclick = onclick; return b; };

    // Ripple mode toggle (default OFF): governs insert AND delete. Off = tiles
    // land exactly where dropped, overwriting what they overlap, and deletes
    // leave a gap; on = the rigid ripple (clamp-left/push-right, close on delete).
    xbRippleBtn = mkBtn('Ripple',
      'Ripple mode — inserts push later tiles right and deletes close the gap. '
      + 'Off (default): tiles land exactly where dropped, overwriting any tiles they overlap; deletes leave a gap.',
      () => {
        state.ripple = !state.ripple;
        tilePlayer.rippleMode = state.ripple;
        refreshTransformBar();
        ctx.persist();
      });
    xbRippleBtn.className = 'tbtn';
    const rippleSep = document.createElement('span');
    rippleSep.className = 'tsep';

    // Transform ACTIONS: apply to the current selection (single or multiple).
    xbTransBtn = document.createElement('button');
    xbTransBtn.className = 'xb-brush xf-transpose';
    xbTransBtn.textContent = 'Transpose';
    xbTransBtn.title = 'Transpose the selected tile(s) by the amount/scale shown (SETS the transpose — a second application replaces it; 0 clears). One undo step; the selection stays.';
    xbTransBtn.onclick = applyTransposeAction;

    // Transpose's parameters (amount + scale) — always visible; they're what the
    // button will apply.
    xbArmedEl = document.createElement('span');
    xbArmedEl.className = 'xb-armed';
    xbAmountEl = document.createElement('span');
    xbAmountEl.className = 'xb-amt-val';
    xbScaleSel = document.createElement('select');
    xbScaleSel.className = 'xb-scale';
    xbScaleSel.title = 'The scale the steps walk (Auto = each tile’s own mask). The list is the scales valid for the selected tile’s tuning.';
    // Options depend on the selection's tuning, so they're (re)filled per selection
    // in refreshTransformBar; 'auto' is always first.
    xbScaleSel.onchange = () => { transposeOpts.scaleId = xbScaleSel.value; refreshTransformBar(); };
    // Read-only readout of the key (and, in Auto, the scale) the transpose will
    // actually use, resolved from the selected tile(s).
    xbKeyEl = document.createElement('span');
    xbKeyEl.className = 'xb-key';
    xbKeyEl.title = 'The key the steps are rooted at (from the selected tile). In Auto, also the tile’s own scale.';
    xbArmedEl.append(mkBtn('−', 'Down one step', () => bumpTranspose(-1)), xbAmountEl, mkBtn('+', 'Up one step', () => bumpTranspose(1)), xbScaleSel, xbKeyEl);

    xbRevBtn = document.createElement('button');
    xbRevBtn.className = 'xb-brush xf-reverse';
    xbRevBtn.textContent = '◄ Reverse';
    xbRevBtn.title = 'Reverse the selected tile(s) — if all are already reversed, un-reverses them all. One undo step; the selection stays.';
    xbRevBtn.onclick = applyReverseAction;

    // Detune action + its cents stepper (± = 5 ¢ per click, Shift = 1 ¢).
    xbDetBtn = document.createElement('button');
    xbDetBtn.className = 'xb-brush xf-detune';
    xbDetBtn.textContent = 'Detune';
    xbDetBtn.title = 'Detune the selected tile(s) by the cents shown — shifts the SOUNDING pitch uniformly on every instrument (SETS the detune — a second application replaces it; 0 clears). One undo step; the selection stays.';
    xbDetBtn.onclick = applyDetuneAction;
    xbDetArmedEl = document.createElement('span');
    xbDetArmedEl.className = 'xb-armed';
    xbDetAmountEl = document.createElement('span');
    xbDetAmountEl.className = 'xb-amt-val';
    xbDetArmedEl.append(
      mkBtn('−', 'Down 5 ¢ (Shift = 1 ¢)', (e) => bumpDetune(e.shiftKey ? -1 : -5)),
      xbDetAmountEl,
      mkBtn('+', 'Up 5 ¢ (Shift = 1 ¢)', (e) => bumpDetune(e.shiftKey ? 1 : 5)),
    );

    xbCloneBtn = document.createElement('button');
    xbCloneBtn.className = 'xb-brush xf-clone';
    xbCloneBtn.textContent = 'Clone';
    xbCloneBtn.title = 'Clone the selected tile(s): they diverge onto fresh copies of their patterns (tiles sharing a pattern share one new clone; the anchor tile’s clone opens in the grid). One undo step.';
    xbCloneBtn.onclick = applyCloneAction;

    xbSelEl = document.createElement('span');
    xbSelEl.className = 'xb-sel';

    // Range tools: arm one, then draw a range on the (glowing) ruler. All lanes;
    // beat-snapped; tiles are atomic (a tile starting before the range but
    // reaching into it is untouched).
    const rangeSep = document.createElement('span');
    rangeSep.className = 'tsep';
    const rangeLabel = document.createElement('span');
    rangeLabel.className = 'xb-range-label';
    rangeLabel.textContent = 'Range:';
    xbInsBtn = document.createElement('button');
    xbInsBtn.className = 'xb-brush rk-insert';
    xbInsBtn.textContent = 'Insert';
    xbInsBtn.title = 'Insert time — arm, then draw a range on the ruler: everything from the range start shifts right by its length (playhead and region markers ride along). Shift at release keeps it armed; Esc cancels.';
    xbInsBtn.onclick = () => setRangeTool('insert');
    xbClrBtn = document.createElement('button');
    xbClrBtn.className = 'xb-brush rk-clear';
    xbClrBtn.textContent = 'Clear';
    xbClrBtn.title = 'Clear range — arm, then draw a range on the ruler: tiles STARTING in the range are removed; nothing moves. Shift at release keeps it armed; Esc cancels.';
    xbClrBtn.onclick = () => setRangeTool('clear');
    xbDelBtn = document.createElement('button');
    xbDelBtn.className = 'xb-brush rk-delete';
    xbDelBtn.textContent = 'Delete';
    xbDelBtn.title = 'Delete time — arm, then draw a range on the ruler: tiles starting in the range are removed and everything after shifts left to close it (overlaps with an earlier tile’s tail are allowed). Playhead/markers ride along. Shift at release keeps it armed; Esc cancels.';
    xbDelBtn.onclick = () => setRangeTool('delete');

    transformBarEl.append(xbRippleBtn, rippleSep, xbTransBtn, xbArmedEl, xbRevBtn, xbDetBtn, xbDetArmedEl, xbCloneBtn,
      rangeSep, rangeLabel, xbInsBtn, xbClrBtn, xbDelBtn, xbSelEl);
    refreshTransformBar();
  }

  // Fill the transpose scale menu for the current selection's tuning, repair a pick
  // that's no longer offered, and show the resolved key. The menu depends on the
  // selected tile(s): a single tuning → that tuning's full scale library; a
  // mixed-tuning selection → only the universal choices (Auto + Chromatic).
  function syncTransposeControls() {
    const infos = ctx.selectedTiles().map((t) => library.patterns.get(t.name)).filter(Boolean);
    const edos = [...new Set(infos.map((p) => edoOf(p.tuningId)))];
    const edo = edos.length === 1 ? edos[0] : (edos.length === 0 ? 12 : null); // null = mixed tunings
    const scales = edo == null ? [{ id: 'chromatic', name: 'Chromatic' }] : scalesFor(edo);
    const opts = [{ id: 'auto', name: 'Auto (from tile)' }, ...scales];
    if (!opts.some((o) => o.id === transposeOpts.scaleId)) transposeOpts.scaleId = 'auto'; // pick invalid for this selection
    xbScaleSel.innerHTML = '';
    for (const o of opts) {
      const el = document.createElement('option'); el.value = o.id; el.textContent = o.name; xbScaleSel.append(el);
    }
    xbScaleSel.value = transposeOpts.scaleId;
    xbKeyEl.textContent = transposeKeyReadout(infos);
  }

  // The key the transpose is rooted at, read from the selected tile(s) — 'varies'
  // when they disagree. In Auto also name the tile's scale (the menu doesn't).
  function transposeKeyReadout(infos) {
    if (!infos.length) return '';
    const keys = new Set(infos.map((p) => pitchClassName(p.root, p.tuningId)));
    const key = keys.size === 1 ? [...keys][0] : 'varies';
    if (transposeOpts.scaleId === 'auto') {
      const names = new Set(infos.map((p) => scaleById(p.scaleId).name));
      return `${key} · ${names.size === 1 ? [...names][0] : 'varies'}`;
    }
    return key;
  }

  function refreshTransformBar() {
    if (!xbTransBtn) return;
    xbRippleBtn.classList.toggle('active', !!state.ripple);
    const tiles = ctx.selectedTiles();
    xbTransBtn.disabled = xbRevBtn.disabled = xbDetBtn.disabled = xbCloneBtn.disabled = tiles.length === 0;
    xbInsBtn.classList.toggle('active', ctx.rangeMode === 'insert');
    xbClrBtn.classList.toggle('active', ctx.rangeMode === 'clear');
    xbDelBtn.classList.toggle('active', ctx.rangeMode === 'delete');
    xbAmountEl.textContent = (transposeOpts.amount > 0 ? '+' : '') + transposeOpts.amount;
    xbDetAmountEl.textContent = `${detuneOpts.cents > 0 ? '+' : ''}${detuneOpts.cents} ¢`;
    syncTransposeControls();

    // The selection's transforms as chips ("the transform inspector").
    // One tile: its ordered chips, each removable. Several: the INTERSECTION
    // view — a chip per transform kind common to ALL selected ("(mixed)" when
    // the kind is shared but the details differ); ✕ removes the kind from every
    // selected tile in one undo.
    xbSelEl.innerHTML = '';
    const mkChip = (kind, text, onRemove) => {
      const chip = document.createElement('span');
      chip.className = 'xb-chip xf-' + kind;
      chip.append(document.createTextNode(text + ' '));
      const x = document.createElement('button');
      x.textContent = '✕'; x.title = 'Remove this transform from the selection';
      x.onclick = onRemove;
      chip.append(x);
      xbSelEl.append(chip);
    };
    const mkMuted = (text) => {
      const m = document.createElement('span');
      m.className = 'xb-muted';
      m.textContent = text;
      xbSelEl.append(m);
    };
    if (tiles.length === 1) {
      const transforms = tiles[0].transforms || [];
      for (const t of transforms) {
        const { kind } = transformKindLabel(t);
        mkChip(kind, describeTransform(t), () => removeSelectedTransform(kind));
      }
      if (!transforms.length) mkMuted('no transforms');
    } else if (tiles.length > 1) {
      mkMuted(`${tiles.length} tiles`);
      for (const kind of ['transpose', 'reverse', 'detune']) {
        const per = tiles.map((t) => (t.transforms || []).find((tf) => transformKindLabel(tf).kind === kind));
        if (per.some((tf) => !tf)) continue; // not common to every selected tile
        const descs = new Set(per.map((tf) => describeTransform(tf)));
        const text = descs.size === 1
          ? [...descs][0]
          : { transpose: 'Transpose (mixed)', reverse: 'Reverse (mixed)', detune: 'Detune (mixed)' }[kind];
        mkChip(kind, text, () => removeSelectedTransform(kind));
      }
    }

    ctx.refreshTileInspector(); // the modeless inspector follows the same selection
  }

  Object.assign(ctx, { refreshTransformBar, disarmRangeTool, commitRange, rangeAffected });
  buildTransformBar(); // build the bar now (needs ctx.selectedTiles + ctx.refreshTileInspector)
}

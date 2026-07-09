# Refactor plan — source-tree hierarchy + main.js split

**Status: Phases 1–4 done (2026-07-09)** — P1: dir hierarchy + import repoint. P2: `ctx` stood up;
`storage`/`meter`/`history`/`zoom`. P3: `app/score.js` (15 score fns). P4: `app/transport.js` (~330
lines — scheduler wiring, render loop, playhead/buttons, tempo, mod-clock, lite, auto-scroll); main.js
now 3209 lines. notch green; awaiting user in-browser smoke test before Phase 5. Update this line as
phases complete (e.g. "Phases 1–5 done (YYYY-MM-DD)").

Agreed with the user 2026-07-08. This document is the **complete instruction set** for a series of
agent sessions. Each phase is one self-contained task ending in a green verification; **the user
approves each phase before the next begins** (the project convention applies: do not start a phase
without the user's "make it so").

Line numbers below refer to `src/main.js` **as of 2026-07-08 (3,641 lines, working tree ahead of
commit 79760d6)**. They are hints only and will drift — **function/const names are authoritative**;
locate by name.

---

## 1. Goal

`src/main.js` (3,641 lines) has two jobs tangled together: (a) the **composition root** — construct
engine/scheduler/library/arrangement/views, wire, boot — and (b) the **controller layer for every
feature**, which landed there because there was nowhere else. This plan:

1. Introduces a directory hierarchy under `src/js/` (plus a reserved `src/wasm/`).
2. Splits main.js's feature controllers into ~16 modules under `src/js/app/`.
3. Leaves main.js as the composition root, **~600–700 lines** (target ceiling: 1,000).
4. Establishes the pattern so future features get an `app/` module by default instead of
   accreting into main.js.

**This is a zero-behavior-change refactor.** Code moves; it does not improve. See §4.

## 2. Target tree

```
src/
  js/
    main.js        composition root: object construction, ctx assembly, refresh()/conductor
                   logic, reference-backdrop glue, pattern lifecycle, active pane, boot,
                   and a fenced "odds & ends" sink (kept deliberately small)
    core/          pure, data-in/data-out (the future-WASM seam):
                   model.js grid.js library.js tuning.js scales.js triads.js random.js
                   transforms.js reference.js project.js tunes.js
    audio/         engine + DSP/config:
                   audio.js scheduler.js instrument.js patches.js delay.js chorus.js
                   reverb.js mods.js
    export/        pure encoders: midi.js wav.js zip.js
    ui/            reusable views/widgets:
                   gridview.js pianoroll.js tileplayer.js toolbar.js instrumentpane.js
                   knob.js panel.js modal.js inspector.js catalog.js panes.js
    app/           feature controllers split out of main.js (created in Phases 2–10):
                   storage.js meter.js history.js zoom.js score.js transport.js
                   tileops.js transformbar.js tileinspector.js patchedit.js lanefx.js
                   randomui.js triadulator.js projectio.js exportui.js keyboard.js
  wasm/            RESERVED — generated deployables only (future .wasm + wasm-bindgen JS
                   glue). Phase 1 creates only a README (content in §6, Phase 1).
```

Future (not this plan): `src/rust/` — the hand-written cargo crate whose build output lands in
`src/wasm/`. The boundary rule is **hand-written vs. generated**, not "deployed vs. not". App code
never imports generated glue directly; it goes through one hand-written seam module in `src/js/`
(mirroring the tuning seam). Generated artifacts get committed so the app stays clone-and-run with
no toolchain. `src/rust/target/` gets gitignored the day the crate exists.

## 3. The ctx pattern (how split modules share state)

main.js's top-level scope currently *is* the shared state: `engine`, `scheduler`, `library`,
`arrangement`, `state`, mutable `let`s (`activeSource`, `tileDrag`, …), and functions everyone
calls (`refresh`, `persist`, `arrCommit`, …). The split makes that scope explicit as **one flat
context object** built in main.js:

```js
// main.js
const ctx = {};                    // built early, passed to every init
ctx.engine = engine; ctx.library = library; ctx.arrangement = arrangement; // …stable objects
initStorage(ctx);                  // each init registers its API onto ctx
initMeter(ctx);
// … in phase order …
```

```js
// app/lanefx.js — module template
export function initLaneFx(ctx) {
  const { engine, arrangement } = ctx;          // stable objects may be destructured
  function applyLaneMix(rampSec = 0.012) { /* body moved verbatim */ }
  // … the rest of the cluster, verbatim …
  Object.assign(ctx, { applyLaneMix, applyLaneDelayAll, /* … the cluster's shared functions */ });
}
```

Rules (mechanical, no judgment calls):

- **Flat, not namespaced.** Everything registers directly on ctx (`ctx.refresh`, `ctx.applyLaneMix`).
  This mirrors today's single scope, so no collisions are possible and call-site changes are
  minimal (`applyLaneMix(0)` → `ctx.applyLaneMix(0)`). Namespacing would be a reorganization
  beyond code motion — don't.
- **Stable objects** (never reassigned: engine, scheduler, library, arrangement, patches, state,
  view instances) may be destructured once at init.
- **Cross-module mutable `let`s become ctx fields** (`ctx.activeSource`, `ctx.tileDrag`, …) —
  every read/write becomes `ctx.<name>`. A `let` used by only one module stays module-local.
  Each phase below lists the fields it converts. When a phase moves a *reader* of a mutable whose
  *writer* is still in main.js, convert the mutable to a ctx field in that same phase (writers in
  main.js updated too).
- **Cross-module functions register on ctx**; module-internal helpers don't.
- **main.js registers its own shared residents on ctx too.** From Phase 2 on, any main.js-resident
  function that an extracted module calls (`refresh`, `applyLaneDelayAll` before Phase 7, …) gets
  `ctx.refresh = refresh;` etc. in main.js. When a later phase moves that function into its module,
  the registration moves with it — call sites don't change again.
- **Constants** (storage keys, LOOP_MAX, …) may be plain `export`s imported directly between app
  modules — constants can't create init-order problems. Runtime state only ever travels via ctx.
- **Late-bind view callbacks.** main.js keeps the GridView / TilePlayer / toolbar constructions;
  their callback objects reference functions that move into modules. Wrap each as an arrow through
  ctx: `onTileDown: (id, ev) => ctx.onTileDown(id, ev)`. (Constructions only *stash* callbacks —
  nothing invokes ctx functions before all inits run — but do not add init-time calls.)
- **DOM refs**: a `const x = document.getElementById(…)` moves with the cluster that uses it. If
  two modules need the same element, each acquires its own ref — that's fine.
- **Init order** in main.js follows phase order (storage → meter → history → zoom → score →
  transport → tileops → transformbar → tileinspector → patchedit → lanefx → randomui →
  triadulator → projectio → exportui → keyboard), with core-object construction and view
  construction interleaved where main.js needs them (construction stays in main.js where it is
  today, except where a phase says otherwise). The boot tail (§ "initial paint") stays the last
  thing in main.js.

## 4. Ground rules — the allowed-changes whitelist

Every phase is **code motion only**. Allowed:

1. Moving code verbatim between files (`git mv` for whole files; cut-paste for clusters).
   Comments move with their code, unmodified.
2. Updating import paths; adding/removing import statements to match what moved.
3. Adding `export` keywords and the `initX(ctx)` wrapper per §3.
4. Prefixing cross-module state and calls with `ctx.` per §3.
5. Re-acquiring DOM refs in the module that uses them.
6. The documentation updates each phase explicitly lists.

Forbidden — even when tempting:

- Renaming any function, variable, file (beyond the moves specified here), or DOM id.
- Changing any signature, default, constant value, or logic. **No bug fixes** — the known
  `loadContent` playStart/playEnd bug (see notes_and_status → Deferred work) moves as-is.
- Rewriting comments, reformatting untouched lines, reordering object keys, "while I'm here"
  cleanups. If you spot an improvement, add it to **Appendix A** of this file instead.
- Standing project rules apply, notably the **Scroll rule** (notes_and_status → Gotchas): this
  refactor must not introduce any rebuild/scroll behavior change — which it can't, if it's motion.

## 5. Per-phase procedure (every phase)

1. **Baseline**: `node notch/run.mjs` from the repo root — record the suite list and pass counts.
   All green is the expected start; if not, STOP and report.
2. Do the phase's work.
3. `node notch/run.mjs` again — identical results required.
4. Static sweep: `node --check` each touched file (or a syntax-error grep via the editor); grep the
   repo for stale paths/names (each phase lists its greps).
5. Update this file's Status line; note anything learned in Appendix A.
6. Report to the user with the **smoke checklist (§7)** — the notch suite does not cover main.js
   wiring, so the user's in-browser pass is the real gate. **STOP for approval.**

Serve locally with `python -m http.server 8000` → `http://localhost:8000/`.

---

## 6. The phases

### Phase 1 — directory hierarchy (pure moves, no code splits)

1. `git mv` every `src/*.js` per the §2 tree (`src/main.js` → `src/js/main.js`, `src/model.js` →
   `src/js/core/model.js`, etc. — all 34 files; `tunes.js` → `core/` even though nothing imports
   it; see Appendix A).
2. Fix every intra-src import: same-directory imports keep `./name.js`; cross-directory become
   `../dir/name.js`. Grep for `from '.` under `src/js/` and resolve each against the tree.
3. Fix all 34 `notch/*.mjs` imports: `../src/X.js` → `../src/js/<dir>/X.js`.
4. `index.html` (~line 720): `<script type="module" src="./src/main.js">` →
   `./src/js/main.js`. Grep index.html for any other `src/` references.
5. Grep `notes_and_status.md` and `future_directions.md` for `src/` links and update paths
   (mechanical prefix fix only — no prose edits).
6. Create `src/wasm/README.md`:

   > This directory is reserved for **generated** WebAssembly deployables: the compiled `.wasm`
   > plus its wasm-bindgen JS glue, produced from the future hand-written crate at `src/rust/`
   > (e.g. `wasm-pack build --out-dir ../wasm`). Nothing here is ever hand-edited. App code must
   > not import these files directly — access goes through a hand-written seam module in
   > `src/js/` with a JS fallback. Artifacts are committed so the app runs from plain files with
   > no toolchain; `src/rust/target/` must be gitignored when the crate is created.

7. Verify per §5. Greps: `from '\./` and `from '\.\./` under `src/` and `notch/`; `src/[a-z]+\.js`
   repo-wide should return no live references to old flat paths.

### Phase 2 — low-coupling extractions: `storage.js`, `meter.js`, `history.js`, `zoom.js`

Also in this phase: main.js starts registering its resident shared functions on ctx as the moved
code demands (at minimum `ctx.refresh`, and whatever `arrApply` calls — it rebuilds lanes, so
expect `applyLaneMix` / `applyLaneDelayAll` / `applyLaneChorusAll` / `applyLaneReverbAll` and
friends to need registration now; they move home in Phase 7).

- **`app/storage.js`** (~120 lines): keys `LIB_KEY`…`GRIDMETA_KEY` (35–43; `RAND_KEY` stays with
  randomui until Phase 8), the persisted-UI `state` object (50–90, exposed as `ctx.state`),
  `readJSON` (3956), `storageOK`/`safeSet` (2780), `persist` (2790). Note main.js consumes
  `readJSON`/`state` very early — init storage first.
- **`app/meter.js`** (~85): the master fader (3764–3770) + the stereo meter/clip-LED loop +
  level instrumentation (3775–3841), including the `window.notorolla*` hooks.
- **`app/history.js`** (~100): `HISTORY_LIMIT` (46); grid undo (`histories`, `hist`, `curSnap`,
  `applyCur`, `pushHistory`, `undo`, `redo`, 1980–2009); arrangement undo (`arrPast`/`arrFuture`,
  `arrSnap`, `arrCommit`, `arrRecord`, `arrApply`, `arrUndo`, `arrRedo`, 2012–2071). Nearly all of
  these register on ctx — they're called from many clusters.
- **`app/zoom.js`** (~90): tile-scale strip (`tileScaleEl`…`setTileScale`, `clampScaleIdx`,
  `updateScaleStrip` + listeners, 3678–3718), the debounced tile-lane scroll persistence
  (3688–3693), roll zoom (`setRollZoom` + strip wiring, 3722–3743). Boot calls
  `ctx.updateScaleStrip()`.

### Phase 3 — `app/score.js` (~180)

`maxReverbTail` (291), `TAIL_CEILING`/`computeTail` (304–310), `buildScore` (345),
`buildAuditionScore` (357), `withReference` (362), `patternLen` (368), `ensureTileStarts` (375),
`arrangementScore` (388), `arrangementEndBeat` (429), `playStartBeat` (439), `playEndBeat` (442),
`windowedArrangementScore` (453), `playingTileIds` (470), `tileStartBeat` (483), `activeScore`
(491). Converts `refDisplay` (525, stays written by main.js's reference cluster) to
**`ctx.refDisplay`**.

### Phase 4 — `app/transport.js` (~380)

`LOOP_MAX`/`LOOP_STEP` (44–45); the scheduler construction + `onCycle` wiring (317–329) moves here
(exposed as `ctx.scheduler`); transport-state lets (330–341; `activeSource` becomes
**`ctx.activeSource`** — read by tileops/keyboard/patchedit later; `resumeBeat`/`resumeStartTime`/
`passBase`/`lastCurBeat` stay module-local); `fmtClock` (311); transport DOM refs (3336–3357);
lite-instruments checkbox wiring (3372–3384); `modClockText` + mod-clock wiring (3385–3429);
`renderLoop`/`startRender` (3502–3541); `startTransport` (3543), `loopClick` (3573), `stop` (3583),
`clampPlayhead`/`movePlayhead`/`resumePlay` (3604–3624), `updateTransportButtons`/`loopLabel`
(3626–3662); transport button listeners (3664–3674); tempo wiring (3753–3760); auto-scroll helpers
`rollScroll`/`ensureRollVisible` (1909–1927) and `laneHeadW`/`ensureTileVisible` (1928–1940).

Converts to ctx fields now (writers still in main.js until their phases): **`ctx.tileDrag`**
(renderLoop reads it), **`ctx.auditTileId`** (`stop` clears it), **`ctx.exporting`** /
**`ctx.exportingStems`** (`updateTransportButtons` reads them).

### Phase 5 — `app/tileops.js` (~300), `app/transformbar.js` (~360), `app/tileinspector.js` (~150)

- **tileops.js**: `setPlayMarkers` (776); `DRAG_THRESH` (852); `tileDrag` (853 — now
  `ctx.tileDrag`); `onTileDown` (857), `lastTileClick` (891), `startTileDrag` (893),
  `updateTileDrag` (910), `endTileDrag` (940), `samePreview` (981); `selectTile` (992),
  `selectedTiles` (1021), `updateTileSelectionUI` (1025); grid-drop cluster `gridDragPreview` /
  `gridDropStart` / `gridDragOver` / `clearGridDragPreview` / `dropCurrentTile` (2078–2122);
  `deleteSelectedTile` (2123); `auditionTile` (1388) + `auditTileId` (1422, now `ctx.auditTileId`);
  `deselectTile` (3848). main.js's TilePlayer callbacks (585–670) stay put and become
  ctx-arrows per §3.
- **transformbar.js**: `rangeMode` (1038 — becomes **`ctx.rangeMode`**; keyboard reads it),
  `transposeOpts` (1039); the four actions (1044–1101); range tools `setRangeTool` /
  `disarmRangeTool` / `rangeAffected` / `commitRange` (1102–1143); `bumpTranspose` (1144),
  `removeSelectedTransform` (1150); the bar DOM (`transformBarEl`, `xb*`, 1198–1200),
  `buildTransformBar` (1202), `syncTransposeControls` (1296), `transposeKeyReadout` (1313),
  `refreshTransformBar` (1324). (**Not** `resetLane`/`resetPlayer` — those are lane/FX resets and
  go to lanefx.js in Phase 7.)
- **tileinspector.js**: `tileInspector` (1423 — becomes **`ctx.tileInspector`**), inspector
  transport `inspectorPlay`/`inspectorStop`/`inspectorLoop`/`syncInspectorTransport` (1429–1465);
  `tuningLabelById` (3430), `tileInspectorFacts` (3434), `refreshTileInspector` (3496); the
  `createInspector` construction + `tileInspectorBtn` wiring (locate by name in the wiring tail).

### Phase 6 — `app/patchedit.js` (~420)

The grid patch + patch-identity + catalog-ops cluster: `gridPatch` (121), `patches` store +
`persistPatches` (125–130), `gridPatchMeta` (131–153), `gridInstr`/`parkedInstr` +
`resolveGridInstrPatch`/`setGridInstr`/`setParkedInstr`/`replaceGridPatch` (154–196); the
instrument-pane construction `instrPane` (1467–1484); `editTarget` (1485 — becomes
**`ctx.editTarget`**; lanefx's `resetLane` reads it), `patchClipboard` (1486), `patchStash`/
`stashKey` (1493); `swapTargetPatch` (1500), `changeKind` (1512), `editGrid` (1528), `editLane`
(1548), `persistPatch` (1570), `copyPatch`/`pastePatch` (1579–1592); identity cluster
`targetMeta` … `markSiblingsDirty` (1595–1780); catalog ops `patchLinkers` … `applyCatalogPatch`
(1783–1841); `catalog` (1424 — becomes **`ctx.catalog`**) + its `createCatalog` construction in
the wiring tail; `testInstrument` (1860), `resetInstrument` (1866).

(`referenceDegreeFor`/`syncGridReference` (197–228) are reference-backdrop glue — they **stay in
main.js** with that cluster.)

### Phase 7 — `app/lanefx.js` (~300)

`applyLaneMix` (229), `applyLaneDelayAll` (247), `applyLaneChorusAll` (273), `applyLaneReverbAll`
(285); FX clipboard `fxClip`/`fxCopyBar` (671–700); `openFxModal` (701), `openDelayModal` (713),
`openChorusModal` (725), `openReverbModal` (737), `openModModal` (753); mixer gesture handlers
`mixBefore`/`onMixStart`/`onMixChange`/`onMixEnd` (794–809); `addLane` (810), `toggleLaneFlag`
(824), `applyLaneGains` (836); `resetLane` (1165), `resetPlayer` (1180). These were registered on
ctx by main.js back in Phase 2 — the registrations move here; call sites don't change.

### Phase 8 — `app/randomui.js` (~310), `app/triadulator.js` (~130)

- **randomui.js**: `RAND_KEY` (2207), `tileRefCount` (2209), `openRandomModal` (2215),
  `openReplaceChoice` (2224), `runRandomModal` (2247–2504, moved verbatim — its decomposition is
  Appendix A material).
- **triadulator.js**: state `proposal`/`triadList`/`triadIdx`/`triadSig` (95–98; `proposal`
  becomes **`ctx.proposal`** — main.js's GridView wiring reads it); `triadulationState` (2514),
  `lastNoteColumn` (2539), `nearestDegreeForPC` (2547), `proposalColumns` (2556), `listSig` (2577),
  `triadulate` (2581), `confirmTriadulation` (2599), `clearProposal` (2610),
  `updateTriadulateButtons` (2618).

### Phase 9 — `app/projectio.js` (~150), `app/exportui.js` (~390)

- **projectio.js**: `projectName`/`savedSnapshot`/`dirty` (2814–2816), the `savedProj` restore
  (2818), project-bar DOM refs (2821–2826), `contentSnapshot` (2829), `persistProjMeta` (2833),
  `updateProjectBar` (2837), `markClean` (2843), `recomputeDirty` (2850), `loadContent` (2859),
  `saveProject` (2912), `openProject` (2923), `newProject` (2942), plus their button/file-input
  listeners in the wiring tail.
- **exportui.js**: `exportMidi` (2953); `exporting` (now `ctx.exporting`) + `exportAudio` (2992) +
  `setExporting` (3029); `safeFileName` (3041); `exportingStems` (now `ctx.exportingStems`) +
  `exportStems` (3056) + `setExportingStems` (3113); `exportRangeControls` (3123),
  `openAudioModal` (3184), `STEM_MODES` (3211), `openStemModal` (3219); `exportProgEl` and the
  export-button listeners.

### Phase 10 — `app/keyboard.js` (~100) + final sweep + docs

- **keyboard.js**: `selectNone` (3844), `flash` (3861), the `window` keydown handler (3871–3938).
  Extracted last because it touches nearly every ctx API. Init it last, just before the boot tail.
- **Final sweep**: confirm main.js now contains only: imports, ctx assembly, core-object and view
  construction (with ctx-arrow callbacks), reference-backdrop glue (521–580 + 197–228),
  active-pane logic (1877–1906), roll-content sync (`tuningsInUse`/`updateRollContent`/
  `scrollRollToSelected`, 1941–1977), pattern lifecycle (`centerGridOn`/`newOrRestore`/
  `clonePattern`/`clearPattern`, 2135–2200), `audition` (2630), the conductor (`onToolbarChange`/
  `refresh`/`FAMILY_TITLES`/`updateScaleControls`/`updateSelectionTools`/`updateEditButtons`,
  2637–2779), the grab-handle drag wiring (3745–3751), the boot tail (3940–3954), and a fenced
  sink: `// --- odds & ends (homeless helpers — keep this section small) ---`. Anything else
  still resident: either move it to its module or justify it in the sink.
- **Docs**: rewrite the **File map** in notes_and_status.md for the new tree (one row per file,
  including all `app/` modules — describe each in the established style); add a dated status entry;
  mark this plan's Status line **COMPLETE**; move any accumulated Appendix A items worth keeping
  into notes_and_status → Deferred work / future_directions as appropriate.

---

## 7. Smoke checklist (user-run, per phase)

The notch suite covers the pure layer only; **this checklist is the wiring test**. After each
phase, with `python -m http.server 8000` running:

1. Load `http://localhost:8000/` — no console errors; all panes render; layout/zoom/scroll
   restored from the previous session.
2. **Grid**: toggle notes; play + loop (Space / Shift+Space); ArrowUp/Down transpose;
   Ctrl+Z / Ctrl+Shift+Z undo/redo.
3. **Tiles**: drag the pattern grab-handle onto a lane; drag a tile (move + Ctrl-copy); play/loop
   the arrangement — playhead tracks, lanes light; B/E park the playhead, ArrowRight resumes;
   tile undo/redo.
4. **Instrument**: edit a lane patch (change kind, tweak params, Test); patch Save / Save As /
   Load via the catalog; dirty-dot behavior.
5. **Lane FX**: delay/chorus/reverb modals apply audibly; mixer knobs + M/S; a lane mod
   (mod-clock runs).
6. **Transform bar**: transpose + reverse + clone actions on a selected tile; a range
   insert/clear/delete on the ruler.
7. **Generators**: New Random modal generates; Triadulate → confirm.
8. **Project**: Save (file downloads), New, Open the saved file — content round-trips; dirty dot
   tracks.
9. **Exports**: MIDI, quick WAV, stems zip — files download and open.
10. **The Scroll rule**: no unbidden page/pane scrolling during any of the above gestures.
11. Reload — state (pattern, arrangement, zooms, playhead, pane order) survives.

A phase that only touched files the checklist can't reach still gets items 1, 2, 3, and 11 as a
minimum.

---

## Appendix A — deferred opportunities (log; do NOT act during this plan)

Noted during planning (2026-07-08); executing agents append here rather than fixing:

- **`core/tunes.js` is unreferenced** (no imports anywhere) — a dead "Mary Had a Little Lamb"
  fixture. Candidate for deletion after user sign-off.
- **`runRandomModal` (~260 lines)** wants decomposition (form builder / preview / commit).
- **`delay.js` / `chorus.js` / `reverb.js` / `mods.js`** each mix a pure config model with a modal
  editor UI — candidates for a config (audio/) + editor (ui/) split.
- **GridView/TilePlayer construction callbacks** in main.js could migrate to tileops/a grid
  controller module, slimming main.js further.
- **keyboard.js** could become a data-driven keymap table.
- **`persist()`** writes every key on any change — could be split per-key if storage churn ever
  matters.
- **The wasm seam module** (`src/js/core/wasm.js` + JS fallback) — build when Rust lands, per §2.
- Known pre-existing bug (already in notes_and_status → Deferred work): `loadContent` doesn't
  restore `playStart`/`playEnd`. Moves as-is in Phase 9.

**Appended during Phase 1 (2026-07-08):**

- **`.claude/settings.json` + `settings.local.json`** carry stale permission-allowlist entries
  pinned to old flat paths (`Bash(node --check src/inspector.js)`, `…src/main.js`, `…src/audio.js`,
  `…src/project.js`, and a `curl …/src/tileplayer.js`). Harmless (dead allow-entries), left as-is
  this phase — candidate for a settings cleanup.
- **Tooling note for future phases (this Node is old — v17.3.0):** `node --check <file>.js` does
  **not** honor the root `package.json` `"type":"module"`, so it parses ESM `.js` as CommonJS and
  false-fails on `import`/`export`. Use `node --check --input-type=module < file.js` (stdin) for a
  module-aware syntax check, and treat a green `node notch/run.mjs` as the real parse gate for any
  module notch imports. A whole-graph resolver check (every relative specifier → existing file) is
  cheap and worth keeping as a per-phase static sweep.
- **Doc-link policy used:** rewrote only the markdown link **target** `](src/X.js)` →
  `](src/js/<dir>/X.js)`; left display text (e.g. `[src/tuning.js]`) and all prose untouched, per
  the "no prose edits" rule. The File map's display text is fully rewritten in Phase 10 anyway.

**Appended during Phase 2 (2026-07-08):**

- **FORCED RENAME (necessary deviation from §4):** `runRandomModal` had a pre-existing function-local
  `const ctx = { tuningId, scaleId, root }` (a generator context). The plan's shared object is also
  `ctx`, so the local one shadowed it and broke the `ctx.pushHistory` / `ctx.safeSet` calls the phase
  introduced inside that function. Renamed the **local** to `tctx` (decl + 15 property reads); the
  module `ctx` is untouched. This also pre-empts the identical shadow in Phase 8 (randomui's
  `initRandomUI(ctx)` parameter). Any future local named `ctx` must avoid the shared name.
- **`storageOK` promoted to `ctx.storageOK`** (not spelled out in the Phase-2 symbol list): it moves
  into storage.js (written by `safeSet`) but is **read by main.js's `beforeunload` handler**, so per
  §3 it becomes a ctx field — same rationale as `editTarget`.
- **`editTarget` promoted to `ctx.editTarget`** (30 sites) as agreed, because `arrApply` (moved to
  history.js) reads it; writers stay in main.js until Phase 6. Comments mentioning `editTarget` were
  left unmodified.
- **`readJSON` is imported, not on ctx:** it's pure, so main.js imports it directly from storage.js
  (like a constant) and its call sites are unchanged — only stateful `persist`/`safeSet` go via ctx.
- **`histories` (the grid-undo Map) registered on ctx** so `loadContent`'s `histories.clear()` (a
  Phase-9 resident) still reaches it.
- **Tooling:** the ctx-prefixing was scripted with word/call-boundary regexes; the word-form pass
  wrongly hit `undo`/`redo` inside **string literals and trailing comments** (`case 'undo'`,
  `getElementById('arrUndo')`, button `.title` text) — caught by logging every change and reverting
  14 lines. Lesson for later phases: a bare-identifier regex must exclude strings + trailing
  comments, not just full-line comments.

**Appended during Phase 3 (2026-07-09):**

- **Four mutables promoted to ctx (forced by §3 — moved reader, writer stays in main.js):**
  `proposal` (`buildScore` reads it; writer = Phase-8 triadulator), `activePane` (`activeScore`;
  writer = Phase-10 active-pane logic), and `resumeBeat` + `resumeStartTime`
  (`windowedArrangementScore`; writers = Phase-4 transport). These reach into later phases' symbols,
  same pattern as `editTarget`/Phase 2.
- **CONFLICT with this plan's Phase-4 note:** Phase 4 says `resumeBeat`/`resumeStartTime` "stay
  module-local". They can't — `windowedArrangementScore` (a Phase-3 mover) reads them, so §3 forces
  ctx promotion now; Phase 4's writers will use `ctx.resumeBeat`. (`passBase`/`lastCurBeat` are
  renderLoop-only, read by no score fn → they stay local, as Phase 4 intends.)
- **`refDisplay` promoted to `ctx.refDisplay`** per the plan's Phase-3 instruction and the user's
  call, though strictly no score fn reads it (only the GridView `getReference` callback + `syncReference`,
  both still in main.js) — so §3 didn't force it. A speculative promotion; harmless.
- **`gridPatch` registered on ctx** (stable object, no call-site churn) for `computeTail`; and the
  `library`/`arrangement`/`engine`/`scheduler` registrations were moved **earlier** than Phase 2's
  block, because `activeScore()` is called eagerly at roll construction and `initScore(ctx)` must run
  before it.
- **3 imports removed from main.js** (now used only by the moved score fns): `mergeAudition`,
  `reverbSeconds`, `patchRelease`.
- **Tooling win:** this phase's word-form pass was clean (no string/comment over-reach beyond one
  self-inserted comment) — the audit-comments-and-strings-first step paid off.

**Appended during Phase 4 (2026-07-09):**

- **Scheduler construction stayed in main.js** (user-approved deviation from the Phase-4 text, option
  A): `new Scheduler(engine)` is constructed + registered on ctx in main.js like the view instances,
  and `transport.js` only *drives* it (onEnded/onCycle wiring, start/stop). This avoids reopening
  score.js/zoom.js, which destructure `ctx.scheduler` before transport's late init. Consequence:
  main.js's own `scheduler.*` uses stay bare; only transport.js uses `ctx.scheduler`.
- **Five mutables promoted to ctx:** `activeSource` (home = transport, exposed on ctx; read by
  audition/inspector/selection clusters), `tileDrag` (renderLoop reads it; writer = Phase-5 tileops),
  `auditTileId` (`stop` clears it; writer = tileops), `exporting` + `exportingStems`
  (`updateTransportButtons` reads them; writers = Phase-9 exportui). `passBase`/`lastCurBeat`/`rafId`
  stayed transport-local, as the plan intends; `resumeBeat`/`resumeStartTime` were already ctx (P3).
- **DOM-ref duplication (per §3):** every transport button is also flashed by the Phase-10 keyboard
  handler (and tempo by projectio, the export buttons by exportui), so `transport.js` re-acquires its
  own `getElementById` refs while main.js keeps its own. `modClockEl`/`modLoopBtn`/`liteBox` were
  transport-only and moved.
- **`LOOP_MAX`/`LOOP_STEP` became exported consts** from transport.js (imported by main.js; the
  Phase-5 audition code at the tile-inspector still uses them).
- **Registered `ctx.setActive`/`ctx.applyLaneGains`/`ctx.syncInspectorTransport`** (main.js residents
  transport calls). `fmtClock` is now `ctx.fmtClock` (exportui's range readout uses it).
- **Transport was scattered across three regions** (fmtClock+scheduler ~260, auto-scroll ~1720, the
  bulk ~3020–3380) threaded through project-bar/export/inspector code — consolidated into one module.
- **Tooling:** all scripts EOL-aware from the first line (per user note); assertions caught two
  mistakes safely before any write (an off-by-one range end, and `let ctx.exporting` being a prefix of
  `let ctx.exportingStems` in the decl-fix).

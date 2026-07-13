# Notorolla — notes & status

A static-web tool for **algorithmic / pattern-based music composition**. Generates its
own sound (no audio samples), runs from plain files, no build step, no dependencies.

---

## Notes from user to agent - DO NOT MODIFY

This is the document to consult for status and detailed progress.

Keep this document updated in moderate detail. "Future directions" is strategic and used for discussing "big picture" items.

Organization: See "file map" below and keep it maintained.

Format: Each new or updated entry must contain a timestamp indicating when the work or change was completed, or when an observation was made.

Commits: The user performs all commits. There is no need to discuss this or provide reminders.

Discussion vs Implementation: The user strongly prefers to discuss before implementation. The user indicates "ready to implement" with the phrase "make it so." Do not implement a change without seeing the phrase: "Make it so."

## END OF DO NOT MODIFY


## Purpose & how this document is maintained

This is the **orientation document** — the thing a new-session agent skims first to come up to
speed on the project. It should read as the **current state** of things: what exists, how it
behaves, the constraints and gotchas to respect. Keep it **succinct** and current.

- **Timestamps.** New or updated entries carry an inline **`(YYYY-MM-DD)`** stamp (ISO 8601) —
  when the work was completed or the observation made. This matches the convention already used
  throughout the file.
- **Keep it current, roll history out.** When an entry is updated, the previous text isn't just
  overwritten — the *how we got here* (rationale, rejected alternatives, debug stories, superseded
  build-phases, already-fixed bugs) is **rolled into the archive** so the record survives while the
  live doc stays lean. Only the current-state fact remains here.
- **The archive.** Historical detail lives in **`archived_status_MM_YY.md`** (one file per month,
  e.g. [archived_status_07_26.md](archived_status_07_26.md)). Within a file, moved chunks are filed
  under the ISO week (Mon–Sun) they were written, keeping their inline timestamps; undated
  background material goes in an "Undated / background" section.
- **Don't-do-this-again lessons stay here.** A hard-won gotcha is lifted into the **Gotchas**
  section below (even as the surrounding history is archived), because a cold agent needs it.
- **Pruning is a repeatable operation**, run on request — an editorial/judgment pass, not a
  mechanical one (the entries are topical prose, not uniform records). Work **chunk by chunk** (one
  feature section at a time) and, for each entry: **(1)** keep the current-state fact, distilled to a
  lean line or two; **(2)** move the *history* (rationale, rejected alternatives, debug stories,
  superseded build-phases, already-fixed bugs, exact formulas/test counts) to the archive under its
  ISO-week (or Undated/background), preserving inline dates; **(3)** lift any don't-do-this-again
  lesson into **Gotchas**; **(4)** route still-relevant *forward-looking* material to
  [future_directions.md](future_directions.md) (that file — not the archive — is a live idea's home;
  archive only what's built/obsolete/superseded); **(5)** drop parked actionable items into **Deferred
  work / TODO**. Last done 2026-07-08 (2002→~1100 lines).


## Vision & aesthetic

- Long arc: algorithmic composition starting near 12-tone ideas and going "wherever the
  experiment takes us."
- **Working aesthetic is minimalist / ostinato / loop-based.** Twelve-tone ideas get
  worked in *as they happen to fit*, not as orthodoxy. Build for **loops with live
  mutation**, not row-form generation.
- Patterns are meant to feel like living, reusable **material** (Opcode Vision–style
  reusable sub-sequences), not frozen copies.

## Tech & constraints

- Plain **ES modules** served over `localhost` (module scripts are blocked over
  `file://`). No bundler, no deps. Run e.g. `python -m http.server 8000` then open
  `http://localhost:8000/`.
- **Web Audio API** for all sound (synthesis, not samples).
- Optional **Rust/WASM** is on the table later for heavy DSP or combinatorial search —
  not used yet. Keep compositional logic as pure data-in/data-out so it can move to WASM.
- Persistence is **localStorage** (a testing convenience; real "save" is coming).
- MIDI input is **deferred** (Web MIDI, Chromium-only). A controller is plugged in but
  unused for now; live MIDI will need a `noteOn/noteOff` voice API (current voice is
  fire-and-forget).

## Code organization rules (agents: read before adding code)

The 2026-07 refactor (`refactor_plan.md`) established this structure. Keep it — the goal is
to never need a refactor like that again.

**Where code goes.** Decide by layer, not by convenience:
- `core/` — pure music/model logic. **No DOM, no Web Audio, no imports from other layers.**
  Must stay importable by node (the `notch/` tests import it directly). New pure logic gets
  a notch test.
- `audio/` — Web Audio synthesis, effects, scheduling. May import `core/`, nothing else.
- `ui/` — DOM/canvas views and reusable widgets. Views receive **callbacks** at construction;
  they never import `app/` modules or reach into controller state.
- `export/` — pure file encoders (bytes out).
- `app/` — feature controllers. Each exports one `initX(ctx)` that registers its API on the
  shared `ctx` (flat namespace, `Object.assign(ctx, {...})` at the tail). Controllers talk to
  each other **only through `ctx`** — no direct imports between `app/` modules.
- `main.js` — composition root ONLY: imports, object construction, `ctx` assembly, `initX`
  calls, and the conductor (`refresh`/`onToolbarChange`). The "odds & ends" section exists
  for true homeless one-liners; keep it small.

**New feature ⇒ new `app/` module** (or extend the module that owns the feature). Do not land
feature controller code in main.js "for now" — that is exactly how the 3,641-line main.js
happened. Mutable state shared across modules becomes a `ctx` field; before registering a
name on `ctx`, grep that it isn't taken.

**Size tripwires** (flag to the user when crossed; don't silently let files ride):
- main.js above ~900 lines → something is living there that belongs in `app/`.
- any module above ~600 lines → propose a split at a natural seam before adding more.

**Bookkeeping when files change:** new/moved/deleted file ⇒ update the File map below, keep
`main.js`'s init-order comments truthful, and check `notch/` imports still resolve
(`node notch/run.mjs` must stay green).

## Two architectural "seams" (the important bits)

- **Time is in beats**, tempo-independent, throughout the model; seconds are derived only
  at the audio layer (`Score.secondsPerBeat`). This is where generative rhythm plugs in.
- **Pitch goes through a tuning seam** ([src/js/core/tuning.js](src/js/core/tuning.js)): `degreeToFreq` /
  `degreeToName(degree, tuningId)` / `pitchClassName(pc, tuningId)`, plus `tuningFreq(degree, tuningId, root)`
  per pattern and **`edoOf(tuningId)`** — the **degrees-per-octave is a property of the tuning** (not a
  global constant), so the pitch-class logic (scales, triads, the grid's octave math) takes `edo` as a
  parameter. Tunings: **12-ET**, **Just (5-limit)**, and **16-ET** (`2^((d−60)/16)`, anchored so degree 60
  stays middle C; octave = 16 degrees; pitch-classes named in **hex `0–f`**). Naming is per-tuning (12-ET
  letters, non-12 hex); the grid renders octave-every-`edo`, drops black keys for non-12 (tints the class-0
  home row instead). **Scale masks are EDO-tagged** ([src/js/core/scales.js](src/js/core/scales.js) `scalesFor(edo)`): the
  picker shows Chromatic (universal) + the tuning's masks — 12-ET pentatonics, or 16-ET **Mavila[7]** `{0,2,4,6,9,11,13}`
  + Mavila pentatonic; switching tuning drops an out-of-EDO mask back to Chromatic. **Roll** still mirrors with
  12-ET-flavored black-key/octave cosmetics (notes sit at the right degree + sound correct; per-tuning roll
  shading is a deferred polish — it ties into mixed-tuning arrangements).

---

## Gotchas / hard-won lessons (avoid these)

A running list of non-obvious traps that cost real debugging time. Read the relevant group before
working in that area.

**Scroll — the "Scroll Annoyance" (a recurring one)**

- **Standing rule:** the app **must not scroll unnecessarily**, and **especially not during a
  gesture**. Some scrolling is essential (edge auto-scroll while dragging a tile past the viewport,
  following the playhead); the rest must be **avoided**. A gesture that moves the page out from under
  the user — so the thing they just grabbed is suddenly elsewhere — is the signature bug. Treat any
  unbidden scroll as a defect.
- **The recurring cause + fix.** Rebuilding a canvas or a container's `innerHTML` momentarily
  **collapses its size**; the browser **clamps the scroll offset** (of the container *and* the
  **page**, since the document got shorter), and nothing restores it. Two layers of defense —
  **belt:** `* { overflow-anchor: none; }` (index.html); **suspenders:** snapshot the scroll before a
  rebuild and restore it after if it moved. Done for the **page** in `refresh()` (`window.scrollX/Y` →
  `window.scrollTo`) **and inside `TilePlayer.render()`** (which also guards its own container's
  `scrollLeft/Top`; it guards the page too because a tile drag calls it directly, bypassing
  `refresh()`).
- **Rule for new code:** if you wipe/rebuild DOM or resize a canvas and it *can* affect a scroll
  offset, bracket it with a save/restore — don't rely on the belt alone. Legit auto-scroll targets the
  *right* scroller (a lane's own `scrollLeft`), never the page.

**UI / interaction**

- **A `click` handler on a button whose *enabled* state depends on the current selection can be
  silently swallowed.** The grid and tiles panes each activate on **`pointerdown`**
  (`gridPaneEl.addEventListener('pointerdown', () => setActive('grid'))`, main.js), and
  `setActive('grid')` calls `arrangement.clearSelection()`. A button living **inside** a pane
  therefore fires that ancestor `pointerdown` on **press** — clearing the tile selection and, if the
  button's `disabled` is driven by that selection (e.g. "enabled only when one tile is selected"),
  **disabling the button between press and release** — so its `click` never fires and *nothing
  happens, with no error*. This is exactly what bit **Set Reference** (2026-07-08; a long debug).
  **Fix / rule:** for such a control, act on **`pointerdown`** (which reaches the button, the event
  target, *before* the ancestor pane handler) and read the selection there, or otherwise snapshot the
  selection before any `setActive`. Don't assume the live selection survives to the `click`.
  Symptom signature: the button visibly enables on selection, but clicking it produces *no* handler
  log — only the enable-check logging `size=0 → disabled`.

**Audio levels**

- **Don't apply a level twice.** Boshwick's hat/cymbal/cowbell once scaled their **sources** by
  `peak` **and** ramped the bus envelope to `peak` → `peak²` (~−20 dB too quiet). Rule: an amp
  envelope should ramp to **1** (shape only); the level lives in one place. **Re-meter with
  `node meter-bosh.mjs` after any voicing change** (levels are set by headless metering against a
  reference Vesperia note; noise-based drums wobble ~±1 dB per render).
- **A "timbre" control that changes summed energy is a loudness control in disguise.** Vesperia's
  spectral-tilt (`k^e`) swelled the summed partials **~+24 dB** at full-bright before it was
  **energy-normalized** (`sqrt(E_neutral/E_tilted)`). Normalize energy so a timbre knob changes
  *color*, not volume; the neutral position must stay bit-identical.

**Rendering / export**

- **Offline bounce must always use the FULL voice, never a live-only shortcut.** The "Lite
  Instruments" CPU relief is LIVE-only: `buildVoice(…, lite)` gets `engine.lite` live but **`false`
  on both offline paths**, so an export is structurally always the full voice. `lite.mjs` asserts
  this. Don't wire a live performance flag into the offline renderer.
- **Non-finite math kills an `OfflineAudioContext` with "Length must be nonzero".** The WAV
  release-tail read `patch.release`, which is `undefined` for Tervik (its tail tracks Op 1's `r1`,
  no top-level `release`) → `Math.max(…, undefined)` = **NaN** → NaN frames → dead export. Use
  `patchRelease(patch)` (kind-aware, non-finite → 0); `renderToBuffer` also floors a bad
  `durationSec` to one frame as a backstop.
- **Export sample rate is caller-chosen, not device-inherited.** The bounce used to build its
  `OfflineAudioContext` at `this.ctx.sampleRate` — i.e. whatever the OS output device runs at (often
  44.1 kHz on Windows). The `fmt ` header always stamps the buffer's rate faithfully, so a "why did
  Cubase import it at 44.1?" is **not** a header bug or a DAW bug — the file genuinely *was* 44.1 k.
  `renderToBuffer`/`renderStem` now take an explicit `sampleRate` (export dialogs default **48 kHz**);
  `OfflineAudioContext` synthesizes natively at any rate (noise buffers included), so no resampling.
- **The default export tail is ceilinged at 8 s and ignores delay.** `computeTail()` sums release +
  reverb then clamps to `TAIL_CEILING`; a long **delay/feedback** wash is intentionally not measured
  (it can ring far longer than is worth the file space). The export dialogs pre-fill this in an
  **editable** field, so a genuinely long reverb/delay is the user's to type — don't re-add
  delay-tail estimation.

**Agent methodology — scripted code-motion (the 2026-07 `ctx`/`app/` refactor, and similar edits)**

The 10-phase split leaned on Node scripts that extract exact source ranges and rewrite call sites.
These traps recurred; the fixes are proven — reuse them for any future bulk move/rename.

- **CRLF, always.** The repo is `core.autocrlf=true`, so files on disk are **CRLF**. Any script that
  rewrites a file must be **EOL-aware** or it silently flips every line ending (a giant noisy diff).
  Pattern: `const eol = raw.includes('\r\n') ? '\r\n' : '\n';`, split on `\n`, strip a trailing `\r`
  per line, rejoin with `eol`. Line-based `split('\n')/join('\n')` preserves CRLF as-is (the `\r`
  rides along). The user explicitly flagged time lost to this early — don't relearn it.
- **Module-aware syntax check.** This Node is **v17.3.0**: `node --check file.js` parses ESM as
  CommonJS and false-fails on `import`/`export`. Use **`node --check --input-type=module < file.js`**
  (stdin). And treat a green **`node notch/run.mjs`** as the real parse gate — but note notch does
  **not** import `main.js`/`app/*`, so it can't catch *wiring* bugs (unregistered `ctx.x`, boot-order);
  those need the ctx cross-check + the browser smoke test.
- **grep can't do the lookbehind here.** `grep -P` errors on this Git-bash locale ("supports only
  unibyte and UTF-8"), and `grep -E` **silently ignores** `(?<!…)` and returns bogus **0-counts** (which
  reads as "unused" and can trick you into deleting a live import). For accurate `(?<![\w.])NAME\b`
  counts use **ripgrep** (`\b` works) or a tiny **Node** `str.match(new RegExp(…,'g'))` — not bash grep.
- **Call-form regex misses bare references.** Prefixing `NAME(` → `ctx.NAME(` catches *calls* but not a
  function passed as a **value**: `addEventListener('click', resetPlayer)`,
  `PatternLibrary.fromJSON(env.lib, isReferenced)`. These need word-form (or an explicit edit). Always
  run a **post-edit bare-identifier scan** for each moved name to catch the reference form.
- **Word-form prefixing over-reaches; guard it.** A bare-identifier regex hits the name inside **string
  literals and trailing comments** (`case 'undo'`, `getElementById('arrUndo')`). Skip comment lines,
  prefer call-form for common words, and **log every change for review**. Promoting `let X` → `ctx.X`
  needs a **decl-fix** step (`let ctx.X` is invalid) — and match the **full** decl string, since one
  name can be a prefix of another (`let ctx.exporting` ⊂ `let ctx.exportingStems`).
- **Never name a local `ctx`.** A pre-existing function-local `const ctx = {…}` (the random generator's
  context) shadowed the shared context and broke `ctx.*` inside that function. Renamed it to `tctx`.
- **Extract byte-identical, assert, then delete-then-prefix.** Pull **exact source line ranges** into
  the new module (bodies unchanged; only cross-boundary refs prefixed) rather than hand-transcribing —
  a typo in a moved body passes every static check and only surfaces at runtime. Guard every range with
  **first/last-line assertions that throw *before* `writeFileSync`** (caught off-by-one ends safely). On
  main.js, **delete the moved definitions first, then prefix the remaining callers by name** — so the
  pass can't mangle a definition, and it auto-finds caller sites the manual survey missed.
- **Locate by name, not line number.** Every edit shifts line numbers; a plan's line refs are stale by
  the next phase. Function/const **names are authoritative** — re-grep each time.
- **Watch boot-order when registration moves.** A function registered by a *late* `initX(ctx)` will
  crash if something calls it at boot **before** that init runs (e.g. `recomputeDirty` via the first
  `persist()`, `patchInfo` via the first `tilePlayer.render()`). Verify the first call site. Floating
  panes (`createPanel`) stack by **DOM append order** (no bring-to-front), so an init's *position*
  affects visual stacking — keep it zero-behavior.
- **Per-move hygiene.** After each extraction: an **unused-import sweep** (count ≤ 1 = import-only) and a
  **leak scan** (no bare calls to any moved symbol) on main.js. And when updating a status/summary line,
  edit the **whole** line — it's easy to fix the body and leave a stale "phase N of M" prefix.

---

## Deferred work / TODO

Short, pithy reminders of parked work — accumulates as entries are pruned; detail lives in the
archive or the linked section. (Bigger features are in [future_directions.md](future_directions.md).)

- **Refactor (DONE, 2026-07-09):** [refactor_plan.md](refactor_plan.md) — `src/main.js` (3,641 lines)
  split into `src/js/{core,audio,ui,export,app}/` + a 793-line composition-root `main.js`, via the
  shared-`ctx` pattern (each `app/*.js` exports `initX(ctx)`). Zero behavior change, notch green
  throughout. New features should get an `app/` module by default rather than accreting into main.js.
  The plan's Appendix A keeps the per-phase deviation log. *Follow-on cleanups surfaced by the split
  (do these opportunistically, not as a project):*
- **Dead fixture:** [core/tunes.js](src/js/core/tunes.js) is unreferenced ("Mary Had a Little Lamb")
  — delete after a glance to confirm nothing imports it.
- **FX config↔editor split:** `audio/delay.js` / `chorus.js` / `reverb.js` / `mods.js` each mix a pure
  config model with a modal-editor UI — candidates to split into a config (`audio/`) + editor (`ui/`) pair.
- **`runRandomModal`** (~260 lines in `app/randomui.js`) wants decomposition (form builder / preview /
  commit). Moved verbatim in the refactor.
- **`app/keyboard.js`** could become a data-driven keymap table instead of an if-ladder.
- **Docs:** split per-voice implementation detail into a separate `instrument_design_details.md`
  (currently parked in [archived_status_07_26.md](archived_status_07_26.md) → Undated / background).
- **Wendelhorn:** a Cubase-style combined Width+Pan panner.
- **Stereo key naming:** the shared Stereo cluster's control is labelled "Width", but "Width" should be
  reserved for **pulse-width** (a pulse-wave param) later. Rename the stereo control/key to **"Stereo" /
  `stereoWidth`** across kinds (Padlington's key is `stereo`… actually `width`; Wendelhorn's is `stereo`)
  and unify — resolves the key mismatch the reskin worked around via a per-kind key override in
  `stereoParams()`. (Also the natural point to enable cross-kind Copy/Paste of the gesture — a §13
  shared-labels tie-in.)
- **Boshwick:** the variability/snap pass for the non-kick drum types; optional per-type factory presets.
- **Lanes:** removing lanes (likely a right-click menu) is still unbuilt.
- **Patch catalog:** groups + tags on the model, with a tree/tag-facet UI (Phase D); drag a patch onto
  a lane head (Phase E); later — rack instances, patch auditioning, Factory-Save tooling.
- **Grid mutate tools:** **Invert** (needs a chosen pivot — first/selected/centroid/fixed degree, TBD);
  a **smart transpose / harmonize** (move each note to the next chord tone of the detected triad — follows
  harmony, not a fixed interval; composes with the future ratio-based triad definer).
- **New Random:** generator **presets**; more controls (articulation/rhythm randomization); a modeless
  version (modal for now).

---

## The control-skin program (future/ui_skin/) — integrated into the instrument panes

The instrument panes wear a **hand-designed control skin**, integrated from the mockup exhibits over
2026-07-09→12 (the two-step "common-clusters refactor + real widgets" handoff, now DONE — its detail is
in [archived_status_07_26.md](archived_status_07_26.md)). Every kind's pane assembles from **shared
param-group builders** (`ampEnvelopeParams()` / `lowpassParams()` / `pitchAtkParams()` /
`stereoParams()`, …) in the canonical role order, rendered by real widgets — [ui/vslider.js](src/js/ui/vslider.js)
(uni/bipolar sliders), [ui/rotaryswitch.js](src/js/ui/rotaryswitch.js) (radial ≤6 / windowed >6),
drawbar tabs, toggles — scoped under `.instr-skin` in [index.html](index.html).

**The exhibits are the RETAINED living spec** — `future/ui_skin/exhibit-<instrument>.html`, self-contained
double-click fixtures (nothing in `src/` imports `future/`; see [future/README.md](future/README.md)).
They stay the standing source-of-truth and keep receiving attention as instruments evolve — **do not
delete them.** The round-by-round design record + every locked law is [future_directions.md](future_directions.md) §13.

**Locked design laws (headline).** Lights glow / **text never glows**; colored text only
mono-amber/green/cyan (readouts = amber, **fixed-width, unit-less**); Tahoma at weight 400 only; the
**vertical slider is the canonical control** (11 ticks, majors by thickness, flush to the slot) —
round knobs retreat to mixer strips; the **canonical group order LFO → Oscillator → Filter → Envelope
→ Effects** with **hue = role** (muted spectrum rust/orange/green/cyan/blue — a role keeps its colour
on every instrument, an absent role leaves a gap); every group a **boxed fieldset** with the colour
band as a centered legend tab; **label-only subgroup chrome, every subgroup labeled**; defaults
Panel 20 / Tick gap 10 / Size 125 with *everything kept parameterized* (CSS vars + meta dials); typed
entry bypasses detents; wheel = coarse, wheel-tilt = fine; pointerdown handlers must `preventDefault`
(+ a global `dragstart` block) or held drags hijack the canvas. **Laws locked during the roster pass
(2026-07-10):** (a) **bipolar zero affordance = the amber detent tick** — the tick at the detent is
tinted the accent (amber), no slot bar; the detent may be **off-centre** (Zindel Spread, Nayumi Size);
(b) **many-way enums (>6) use a rotary with a readout WINDOW, no radial labels** (Boshwick's 9-way
Type) — 3–6-way rotaries keep radial position labels (6 splits 3-left/3-right); (c) a **tone-shaping "filter substitute" takes
the green Filter slot even without a biquad** (Zindel Acceleration → band "Motion", Boshwick Tone →
band "Tone", Nayumi's formant bank = the Filter); (d) **live inert dimming off any selector** (Boshwick
Type, Padlington Source — dim + desaturate, still draggable); (e) the **drawbar tab** is a locked new
widget species (Zindel — white/black numbered pull-tabs on chrome stems, 0–8 registration, 9-position
stepped, powers-of-two harmonics white, up = louder). **Shared clusters** (Pitch Atk/Time, Lowpass,
Amplitude, Stereo/Width) are reused verbatim across instruments — the concrete anchor for the §13
shared-label roles.

**Still ahead** (the integration itself is done; these remain — see future_directions §13): the skin
**spreads app-wide** (transport, toolbars, mixer, panes); and the reserved design items — FM
operator-diagram labels for Tervik's Algorithm rotary, a persistent **app-wide UI-scale** setting,
per-instrument **identity** (logo / faceplate chrome), and the **key-up-pluck** release-transient voice.

---

## File map

The source lives under `src/js/`, grouped by role: **core/** (pure model + music logic, headless-testable), **audio/** (Web Audio engine + effects + patches), **ui/** (DOM/canvas views + widgets), **export/** (file encoders), and **app/** (the feature-controller layer — see the note below). `main.js` is the composition root.

**The `app/` layer + `ctx`:** each `app/*.js` exports an `initX(ctx)` that registers its API on a shared context object. main.js builds the core objects/views, stands up `ctx`, and calls each `initX(ctx)` in turn; controllers read each other's (and main.js's) functions/state through `ctx`. This keeps main.js to the composition root (~800 lines) instead of one monolith. (History: the 2026-07 refactor split a 3,641-line `src/main.js` into this tree — see `refactor_plan.md`.)

| File | Responsibility |
|---|---|
| [index.html](index.html) | Layout (transport bar + reorderable panes), all CSS |
| **core/** | *pure model + music logic (no DOM/audio; headless-tested)* |
| [core/model.js](src/js/core/model.js) | `Note`, `Score` (beats, tempo, articulation, explicit length), MIDI↔freq, note names, black-key test |
| [core/tuning.js](src/js/core/tuning.js) | row/degree → pitch/frequency seam; per-pattern `tuningFreq` + **`edoOf(tuningId)`**; 12-ET / Just / **16-ET**; per-tuning `degreeToName`/`pitchClassName` (12-ET letters, non-12 hex), **`pitchClassLabel`** (pitchClassName, or `''` for no-equave tunings — the safe gate for pitch-class-tiled displays), `equaveOf`, `degreeBounds`, `nearestDegreeToFreq` |
| [core/scales.js](src/js/core/scales.js) | per-EDO scale masks: `scalesFor(edo)`, `scaleById`, `scaleValidForEdo` (the scale library the grid + transpose menus draw from) |
| [core/grid.js](src/js/core/grid.js) | `Pattern` (named; **per-pattern column count**, `Pattern.initial(name, cols)`), `DURATIONS`, `PALETTE`, `BASE_PITCH`, `DEFAULT_ARTIC` |
| [core/library.js](src/js/core/library.js) | `PatternLibrary` (registry, naming, parking), `Arrangement` (lanes/tiles + per-lane mute/solo + `lane.gain`/`lane.pan`/`lane.patch`, play-region `playStart`/`playEnd`, `audibleLaneIds`), `laneColor`, `insertPoint`/`deletePoint` |
| [core/transforms.js](src/js/core/transforms.js) | per-tile **nondestructive** pattern transforms (pure): scalar/chromatic **transpose** + **reverse** + **detune** (±100 ¢, uniform sounding-pitch contract), in the canonical One True Order — `applyTransforms`, `setTileTranspose`/`setTileReverse`/`setTileDetune`, `hasReverse`/`findDetune`, `describeTransform`, `transformKindLabel`, `normalizeTransforms` |
| [core/triads.js](src/js/core/triads.js) | Triadulator engine (pure): partition a pitch-class set into chords — families `trad`/`sus` (12-ET), `septimal` (16-ET); `enumerateTriadulations(pcs, {families, edo})`, `classifyTriad`, `familiesFor(edo)`/`familyLabel`, `chordsFor` |
| [core/random.js](src/js/core/random.js) | New Random generator (pure): a contiguous in-scale degree window around the viewport centroid → random degrees, bent by Unique / Run / Triad; plus **Duration/Accent Bias** each with a **Steer** or **Sort** mechanism; `scaleWindow`, injectable rng |
| [core/reference.js](src/js/core/reference.js) | grid **reference backdrop** (future_directions §16): `bakeReference`, `referenceScore`/`referenceDisplay`, `mergeAudition`, `referenceToJSON`/`FromJSON` |
| [core/hexlayout.js](src/js/core/hexlayout.js) | pure **isomorphic hex-keyboard geometry** (future_directions §22 visualizer): `degree = base + q·x + r·y` in EDO steps; `HEX_LAYOUTS`/`layoutById` (data presets; Harmonic Table axes derived from JI so they generalise to any EDO), `buildLayout` → cells (with `ring` = hex distance from centre) + **`edges`** (the deduped lattice between keys: endpoints, midpoint, `orient`, `ring`, `interior`) + `byDegree`/`byPc` indices + `maxRing` + `cellAt` (pixel→cell, the future input seam) |
| [core/project.js](src/js/core/project.js) | versioned file envelope (`VERSION`/`buildEnvelope`), `migrate`/`validate`, `defaultName`, save (`downloadJSON`/`downloadBytes`) / load (`readFile`) helpers |
| [core/tunes.js](src/js/core/tunes.js) | *(unreferenced demo fixture — "Mary Had a Little Lamb"; slated for deletion, see Deferred work)* |
| **audio/** | *Web Audio engine, per-lane effects, patches, scheduler* |
| [audio/audio.js](src/js/audio/audio.js) | `AudioEngine` — additive synth voice (`buildVoice`), per-lane patch resolution (`patchFor`), per-lane **stereo mixer strips** (volume→panner→[chorus]→[delay]→mute-gate; `setLaneVolume`/`setLaneGain`/`setLanePan`, `applyLaneChorus`/`applyLaneDelay`/`applyLaneReverb`, `modsFor`), master limiter + fader + **stereo meter tap** (`getPeak`); `renderToBuffer`/`renderStem` (offline bounce), `FREF` |
| [audio/instrument.js](src/js/audio/instrument.js) | the **instrument registry** (Vesperia/Zindel/Wendelhorn/Tervik/Nayumi/Boshwick/Padlington): `defaultPatch(kind)`, `normalizePatch`, `clonePatch`, `instrument`/`instrumentKinds`, slider mapping |
| [audio/patches.js](src/js/audio/patches.js) | `PatchStore` — the **user-global patch catalog** backing store: id-keyed named patches, factory `Init` per kind (`factoryInitId`) + user tier, `allForKind`/`add`/`update`/`remove`/`uniqueUserName`. Pure |
| [audio/padsynth.js](src/js/audio/padsynth.js) | the **Padlington bake** (pure, seeded): PadSynth profile generators (saw/pulse/voice/tilt sources × the Saw/Pulse **Shape** morph × the universal `formantMask`, + a band-limited pink **Air** noise floor) → Gaussian-band spectrum → random-phase IFFT wavetable; `bakePadTable`/`padTableKey`/`padBaseFreq`, radix-2 `fft` |
| [audio/delay.js](src/js/audio/delay.js) | per-lane delay config (`normalizeDelay`, `DELAY_TIMES`/`DELAY_MODES`) + `buildDelayEditor` |
| [audio/chorus.js](src/js/audio/chorus.js) | per-lane Juno-60 chorus config (`normalizeChorus`, `CHORUS_MODES`) + `buildChorusEditor` |
| [audio/reverb.js](src/js/audio/reverb.js) | per-lane reverb config (`normalizeReverb`) + `buildReverbEditor` |
| [audio/mods.js](src/js/audio/mods.js) | per-lane playback modulators: config model (`modsByKind`), waveform eval (`modWave`), `applyMods`, `modsActive`/`modTargetsFor`, and the modal editor (`buildModEditor`, `MOD_SLOTS`, `defaultMod`) |
| [audio/scheduler.js](src/js/audio/scheduler.js) | lookahead `Scheduler`, finite looping, per-cycle re-read (`onCycle`), mid-cycle tile reconciliation (`resync`); **score-reactive `onNoteVisual`** tap (each scheduled note, stamped with its audio-clock time + its instrument kind / Boshwick drum type → the visualizer) |
| **ui/** | *DOM / canvas views + reusable widgets* |
| [ui/gridview.js](src/js/ui/gridview.js) | `GridView` — grid editor (render + gestures + viewport + resize); reference-backdrop overlay via the merged-time layout |
| [ui/pianoroll.js](src/js/ui/pianoroll.js) | `PianoRoll` canvas render + playhead; per-note color/alpha; `ROLL_V_SCALES`/`ROLL_H_SCALES` zoom ladders |
| [ui/tileplayer.js](src/js/ui/tileplayer.js) | `TilePlayer` — multi-lane tile rendering + interaction; lane heads (instrument/Edit, Pan/Gain knobs, M/S, **colour stripe = reorder handle**); beat **ruler + play-region markers**; per-tile transform swath; drag/marquee/repeat/range + **lane-reorder** gestures; `TILE_SCALES` |
| [ui/toolbar.js](src/js/ui/toolbar.js) | `buildToolbar` — grid toolbar (brush, pattern lifecycle, view toggles, transpose/permute, triadulate) |
| [ui/instrumentpane.js](src/js/ui/instrumentpane.js) | `buildInstrumentPane` — the retargetable, **kind-aware** "Edit instrument" pane (instrument selector; slider/fader/checkbox/dropdown/stepped-list/knob widgets; **inert dimming** via `spec.inert(patch)`; target chip, Test, Copy/Paste, Save/Load identity) |
| [ui/knob.js](src/js/ui/knob.js) | `makeKnob` — click-vertical-drag rotary widget + `PAN_MAP`/`GAIN_MAP` mixer mappings |
| [ui/catalog.js](src/js/ui/catalog.js) | `createCatalog` — the **Patch Catalog** window (a panel.js tenant): kind→patch browse, search, apply, Rename/Delete; content-only |
| [ui/inspector.js](src/js/ui/inspector.js) | `createInspector` — the **Tile inspector** content (a panel.js tenant): optional play/stop/loop transport + a `setFacts` data dump with inline-rename heading |
| [ui/panel.js](src/js/ui/panel.js) | `createPanel` — the reusable **modeless floating-pane primitive** (fixed, draggable, resizable, geometry-remembered, **click-to-front** z-ordering). Doc-agnostic (pop-out ready). Shared by the inspector + catalog + visualizer |
| [ui/vizhex.js](src/js/ui/vizhex.js) | `createVizHex` — the **HEX keyboard visualizer** (future_directions §22), a panel.js tenant: pre-renders the empty board offscreen (rebuilt on resize/tuning change), then per frame blits it + fills the lit hexes; **scheduled** lighting (a note lights at its audio-clock time, held for its gate + a decay glow), exact pitch bright + octave-mates dimmer, lane colour × velocity; rAF runs only while open + animating. **Per-kind scene modifier** (`sceneForNote`, pure) over two non-competing layers: melodic voices light pitch **faces**, **Boshwick** lights a **sparse few of the lattice edges** (the gaps between keys, ≤3/hit) chosen by region (kick=centre, hat/cymbal=rim, snare=mid band, clap=scatter, cowbell/rim/clave=fixed edges) with **Tom** the pitched hybrid exception (a face) |
| [ui/modal.js](src/js/ui/modal.js) | `openModal` — generic centered modal (Esc / backdrop / × to close, `onClose`) |
| [ui/panes.js](src/js/ui/panes.js) | `setupPanes` — reorderable vertical panes, order persisted |
| **export/** | *file encoders (pure)* |
| [export/midi.js](src/js/export/midi.js) | Standard MIDI File writer: note data → bytes (Format 1, tempo, track names) |
| [export/wav.js](src/js/export/wav.js) | WAV + **BWF** encoders: an `AudioBuffer` → 16-bit PCM RIFF bytes (`encodeWav`/`encodeBwf`) |
| [export/zip.js](src/js/export/zip.js) | minimal ZIP (store, no compression) writer — bundles the per-lane stem BWFs |
| **app/** | *feature controllers — each exports `initX(ctx)`, registers on the shared `ctx`* |
| [app/storage.js](src/js/app/storage.js) | localStorage keys + the persisted-UI `state` object (hydration/migration); `readJSON`/`safeSet`/`persist`, `storageOK`, `recomputeDirty` hook |
| [app/meter.js](src/js/app/meter.js) | master fader + the stereo-meter animation loop |
| [app/history.js](src/js/app/history.js) | grid + arrangement undo/redo stacks (`pushHistory`/`undo`/`redo`; `arrSnap`/`arrCommit`/`arrUndo`/`arrRedo`; `histories`, `hist`) |
| [app/zoom.js](src/js/app/zoom.js) | the tile-scale strip + roll zoom ladders (`updateScaleStrip`, `clampScaleIdx`) |
| [app/score.js](src/js/app/score.js) | score building: `buildScore`/`arrangementScore`/`windowedArrangementScore`/`activeScore`, `computeTail`/`maxReverbTail`, region beat math (`playStartBeat`/`playEndBeat`/`arrangementEndBeat`), `ensureTileStarts` |
| [app/transport.js](src/js/app/transport.js) | the scheduler **driver**: play/stop/loop (grid + tiles + audition), render loop + playhead, transport buttons, tempo, mod-clock, Lite toggle, roll/tile auto-scroll; `LOOP_MAX`/`LOOP_STEP` |
| [app/tileops.js](src/js/app/tileops.js) | tile-player ops: play-region markers, tile drag (move/copy/reorder w/ live ripple preview), click-select, single-tile audition, grid→lane drop, delete/deselect |
| [app/transformbar.js](src/js/app/transformbar.js) | the tile transform bar: Ripple, the Transpose/Reverse/Clone selection actions, the Insert/Clear/Delete range tools, per-selection transform chips |
| [app/tileinspector.js](src/js/app/tileinspector.js) | the **Tile Inspector** floating pane — transport + facts dump, following the selection |
| [app/visualizer.js](src/js/app/visualizer.js) | wires the **HEX keyboard visualizer**: the transport-area ⬡ Keyboard summon button, the board's pitch context (current tuning + centre degree ≈ middle C), and the scheduler's `onNoteVisual` feed → `ui/vizhex.js` |
| [app/patchedit.js](src/js/app/patchedit.js) | the instrument editor: grid/parked-instrument descriptors, the edit pane, per-target patch **identity** (dirty/Save/Save As/Load/Rename), the **Patch Catalog** ops |
| [app/lanefx.js](src/js/app/lanefx.js) | per-lane mixer + FX: volume/pan/mute/solo bus pushers, the delay/chorus/reverb/modulator modal editors, add-lane, lane/player reset |
| [app/triadulator.js](src/js/app/triadulator.js) | the **Triadulator** proposal system: enumerate placeable triads from unused pitch-classes, overlay/rotate them, Confirm to register |
| [app/randomui.js](src/js/app/randomui.js) | the **New Random** modal: live-preview generation, in-modal back/redo, audition, Replace-in-place / New-Pattern / Cancel |
| [app/projectio.js](src/js/app/projectio.js) | the project **document** layer: name / dirty-tracking vs a saved baseline, Save / Open / New, `loadContent` (replace live library + arrangement in place) |
| [app/exportui.js](src/js/app/exportui.js) | **export**: MIDI, single-file audio (WAV), per-lane stems (BWF zip), + the Export Audio / Export Stems dialogs |
| [app/keyboard.js](src/js/app/keyboard.js) | global keydown shortcuts — act on the active pane (grid/tiles), flash the mapped button; skipped while a form field is focused |
| [main.js](src/js/main.js) | **composition root**: imports, `ctx` assembly, core-object + view construction (with ctx-arrow callbacks), and the resident glue that stitches them — reference backdrop, active pane, roll-content sync, pattern lifecycle, grid audition, and the conductor (`onToolbarChange`/`refresh` + the `update*` button-state helpers) |

---

## What works today

### Sound — instruments (a registry of synth kinds, per-lane editable)
- **The Vesperia** — additive synth voice: ~6 sine partials, slight inharmonicity, an **ADSR**
  amplitude envelope + a **resonant lowpass** with its own envelope and keyboard tracking.
  Conservative per-voice level (`VOICE_PEAK`) into a transparent **master limiter** (see
  Transport & roll). Default articulation ~0.88 (slightly detached / non-legato).
- **Zindel** — a drawbar additive organ. **8 drawbar levels** (harmonics 1–8, parallel vertical
  faders, up = louder), plus **Modulation** (each partial is a 2-op FM stack — sine carrier + 1:1
  sine modulator; 0 = pure sine, up adds harmonic sidebands, brightness held constant across
  pitch), **Spread** (stretches partials off the integer harmonics — 0 = harmonic, + =
  inharmonic/bell), one **ADSR per partial**, and **Acceleration** (the *filter substitute* — upper
  partials run the envelope faster, so the tone darkens over time; no biquad on Zindel). Factory
  default = Hammond-ish. Levels scaled by `ZINDEL_NORM`.
- **Wendelhorn** — a brass "supersaw" ensemble. **7 detuned band-limited saws** with random start
  phase (baked into per-context `PeriodicWave`s so they don't beat coherently), spaced by **Szabo's
  irregular positions**; side saws swell in as **Detune** opens. **Ensemble** = a slow uneven
  pitch-LFO chorus (up to 50 cents; also lifts the side saws to an audible floor so it's heard at
  any Detune); Ensemble 0 = clean single saw. **Speed** = LFO rate 0.1–5 Hz (log); shared 3-LFO
  pool → ~10 osc/note. **Stereo** = a cheap, mono-safe source-level M/S widen (pan spread by index +
  a center-saw scoop gated by side energy). **Pitch Atk / Pitch Time** = the pitch attack, now
  **signed ±200 ¢** (2026-07-09): positive starts sharp and exp-settles to pitch (the synth-brass
  blip), negative approaches from below (the scoop); 0 = off. Into Vesperia's resonant lowpass +
  filter envelope and a shared ADSR. Levels scaled by `WENDEL_NORM`. *Deferred:* a Cubase-style
  combined Width+Pan panner.
- **Tervik** — a lightweight **3-operator FM** synth (only 3 osc/voice — the cheapest voice).
  **Op 1 is always the final carrier** and its ADSR is the amp envelope; a 4-way **Algorithm** routes
  Ops 2 & 3 — **Stack** (3→2→1), **Y** ((2+3)→1), **Pair** (3→2 · 1), **Parallel** (1·2·3). Each op's
  **ratio = Coarse + Fine**: Coarse snaps to exact values `[0.25, 0.5, 1, 2 … 16]` (reliable harmonic
  ratios), Fine is a ±1.0 detune knob (0 = exact, off-zero = inharmonic/bell). Modulator depth scales
  with frequency, so brightness is even across pitch. Ops 2 & 3 each have a **Follow Op 1** toggle
  (off = own ADSR; on = shaped by Op 1's envelope, Level = amount). **Feedback** morphs Ops 2 & 3 from
  sine toward a band-limited saw. Default = a DX-style electric piano. Levels scaled by `TERVIK_NORM`.
  Introduced the editor's **enum/`select`**, **stepped-list slider**, and **knob** param types. (When
  Follow is on, that op's A/D/S/R sliders **dim as inert** — the `spec.inert` mechanism, 2026-07-09.)
- **Nayumi** — a **breathy formant "voice"** (oohs/ahhs) by source–filter synthesis, aimed at the
  **Fairlight ARR1** zone (clear sung vowel ↔ hollow "blown vessel"). **Carrier** = a per-context
  glottal-pulse `PeriodicWave`; **Size** scales the formants (male↔female, one knob). The carrier
  (through a **Brightness** lowpass) and **aspiration noise** feed a parallel **3-band bandpass
  formant bank** (**Vowel** = ooh/oh/ah/eh/ee → F1/F2/F3; **Resonance** = bandpass Q); a little
  **air** noise bypasses the formants. **Breath** crossfades tone↔noise. An optional **bit-crush**
  `WaveShaper` (**Grit** — lo-fi Fairlight grain, with a grit-tracked post-crush lowpass) feeds one
  soft-attack ADSR; a **vibrato** LFO keeps held vowels alive. Breath noise is **pink**. **Soprano
  rounding** (`soprano` 0–1): high notes tune F1 onto the fundamental and dissolve the vowel toward a
  clean fluty tone (0 = no change anywhere). Heaviest voice (~17 nodes/note). Noise buffer / glottal
  wave / crush curves cached per context (live + offline).
- **Boshwick** — a multipurpose **808-style percussion** synth (no samples; "Son of TR-808").
  Monotimbral — **one drum per lane, layer lanes for a kit**. A **`Type` select** (Kick / Tom /
  Snare / Hat / Clap / Cowbell / Rimshot / Clave / Cymbal) swaps the **topology** over a shared knob
  set. Most voices are one-shot decays that **ignore note duration**, EXCEPT **Hat & Cymbal**, which
  are **duration-gated** (a fast choke at note-off → short note = closed hat, long note rings open).
  **Pitch-trackable**: `hz = nominal × Tune (±1.5 oct) × (f0/C4)^PitchTrack` — **PitchTrack 1
  (default)** = playable/melodic drums following the active tuning (microtonal toms free), **0** = a
  fixed drum on every row. **Accent** raises level and, just audibly, brightness. Shared knobs:
  Type · Tune · PitchTrack · Decay · Punch · Pitch Env · Tone · Snap (inert where a type doesn't use
  them). **Kick** has an extra variability/snap pass (Tone = soft-clip body drive, Punch = two-part
  attack). Levels are **set by headless metering** (`node meter-bosh.mjs`; re-meter after any voicing
  change — see Gotchas). v1 = **808 only** (a future Model select for 909/ride/china is noted).
  *Planned:* the same variability/snap pass for the other drum types; per-type factory presets
  sanctioned if needed.
- **Padlington (2026-07-09; Shape added 2026-07-12)** — a **PadSynth pad** (Paul Nasca's ZynAddSubFX
  algorithm). A harmonic
  **profile** = a raw **Source** × a universal **Formant** mask, smeared
  into **Gaussian bands** in the frequency domain (**Bandwidth** in cents = THE lushness knob;
  **BW Scale** = how the smear grows up the series), given seeded random phases, and IFFT'd into a
  **2^17-sample looping wavetable**. The bake is a pure module ([src/js/audio/padsynth.js](src/js/audio/padsynth.js)).
  The osc-role layout is **Source · Pad · Air · Formant · Pitch** — *everything baked lives under the
  Oscillator role* (Filter = the runtime lowpass only).
  - **Source** (raw carrier): Saw (1/k supersaw pad), Pulse (rectangular pulse), **Voice** (a 1/k^1.1
    glottal carrier), or Tilt (a bare 1/k^e). **Shape** (Saw/Pulse only, Lo↔Hi) morphs the waveshape
    spectrally — since the bake randomizes phase, a waveshape *is* its magnitude profile, so both are the
    same |sin(π·k·x)|/k^e family: Saw→triangle (e=2, symmetry 0→½) and Pulse duty 0.5→0.03 (e=1). Shape 0
    = Saw/Square unchanged.
  - **Formant (2026-07-13):** a universal vowel bank — `formantMask(f, vowel, size, Q)` — multiplies
    **every** source's harmonics (and the Air noise). **Vowel** `None`(=flat bypass)/ooh/oh/ah/eh/ee,
    **Size** (tract scale, bipolar detent 1.0), **Reso** (`formantQ`, bandpass Q — high = the "blown
    bottle"). **Voice + a vowel = the old Choir source** (formantQ default 9 = the old fixed Q), now
    decoupled so *any* source is vowel-shapeable. Mirrors Nayumi's Formant group.
  - **Air (2026-07-13):** a band-limited **pink** (1/√f) noise layer baked in — **Noise** amount
    (energy-matched tonal↔air crossfade: 0 = pad, 1 = pure air; RMS held so it's colour not level),
    routed **through the formant mask** (a vowel → breathy/vocal air), and **Air Cut** = a 1-pole
    (−6 dB/oct, Juno-60 style) high-pass taming the low end (also kills pink's DC blow-up).
  - **Stretch** (partial k lands at f·k^(1+s)) is the inharmonicity knob — the first Sethares/§15 hook.

  Migration (marked `normalizePatch` shims, deletable later): legacy `source:'square'` → `pulse`
  (`migratePadPulse`); legacy `source:'choir'` → `voice` keeping its vowel/size, and a legacy non-choir
  patch's now-universal `vowel` is retired to `None` (`migratePadFormant`, sentinelled on the new
  `formantQ` field). Same spectrum/character on reload (phases reseed like any re-bake).
  Tables bake **lazily per (patch, octave base C1–C8)** and are cached per context (LRU 16;
  `playbackRate = f0/base` stays within ~[0.71, 1.41], which also keeps the formants
  anchored); the bake is **seeded from the param key**, so every `OfflineAudioContext` bakes
  bit-identical tables — **exports match live**. **Offline export is structurally glitch-immune:**
  every bake happens during graph assembly (before `startRendering()`), and an OfflineAudioContext
  has no realtime deadline — load makes an export slower, never corrupted. (Live, the first note
  after an edit / into a new octave pays the ~40–50 ms bake on the main thread — accepted for now;
  per-note read-head offsets are `Math.random()` like Wendelhorn's phases, so re-exports differ
  microscopically in phase texture, not character.) The voice = **two decorrelated read-heads** over one
  table (independent random start offsets — the Wendelhorn random-phase precedent) panned ±**Width**
  (mono-safe at 0), into Vesperia's resonant lowpass + ADSR. **Cheapest voice in the roster**
  (~7 nodes/note; no Lite handling needed). `PAD_NORM` set by headless metering
  (`node notch/meter-pad.mjs`: pad RMS ≈ the Vesperia reference, peak a couple dB under — a held pad
  at equal peak reads hot). **Amp attack is LINEAR + duration-aware** (2026-07-09): an exponential
  ramp from near-zero is linear-in-dB (a 1 s attack = ~0.7 s of silence then a snap), and a note
  SHORTER than the attack must ramp only to the level it reaches by note-off and release from there —
  never schedule a release into the middle of an attack ramp (conflicting automation = silence + a
  click). Fire-and-forget scheduling knows the duration up front, which is what makes this exact.
  **Pitch Atk / Pitch Time (2026-07-09)** — a signed ±200 ¢ pitch attack (positive = from above,
  the brass/vocal approach; negative = the scoop), exp-settling onto pitch: pure detune automation
  on the read-heads, never touches the bake or the cache. **Same keys/labels as Wendelhorn's**, so
  cross-kind Copy/Paste ferries the gesture — a first concrete instance of the §13 shared-labels
  idea. (A per-note/per-tile articulation version is future work, §7/§12.)
  `notch/padsynth.mjs` (53 tests); wasim grew a StereoPanner (left-channel model) + buffer-source
  playbackRate/offset/detune for it. *Likely phase 2:* analyze a **self-bounce** of any patch into a profile
  ("any Notorolla sound as a pad").
- **Multi-instrument registry** ([src/js/audio/instrument.js](src/js/audio/instrument.js)): each **kind** owns its
  defaults + `PARAMS` (editor metadata); a patch carries a `kind` tag and the engine dispatches on it
  in `buildVoice` (one DSP branch per kind). `normalizePatch` / `defaultPatch(kind)` / `clonePatch`
  are kind-aware (unknown/missing kind → Vesperia, so old projects upgrade silently). The voice reads
  its **patch** struct **at every note-on**, so edits are heard on the next note with no re-wiring.
- **Patches are per lane.** Each arrangement lane owns its `lane.patch` (`engine.patchFor(laneId)`);
  new lanes start from the factory preset. Un-laned sound (grid click-to-hear / ♪ Test) uses a
  **separate neutral grid patch** — a workspace preference, *not* part of the project.
- **Edit instrument pane** ([src/js/ui/instrumentpane.js](src/js/ui/instrumentpane.js), below the roll; an editor
  panel, *not* a transport pane). Edits **one target patch at a time**, retargetable: focusing the
  **grid** pane loads the neutral grid patch; **double-clicking a lane head** loads that lane's patch.
  A color-swatch chip shows the target ("Grid" / "Lane N"). An **instrument selector** switches the
  target's **kind** and rebuilds the pane body; a **per-target stash** keeps each kind's last-dialed
  patch (session-scoped; the active kind rides the project). **Copy / Paste** ferry settings across
  targets and **kinds** (session clipboard); **Factory Reset** restores this kind's defaults.
  Vesperia's grouped controls:
  - **Amp Envelope** — Attack / Decay / **Sustain** / Release (true ADSR; Sustain 0 = struck-string
    decay-to-silence, Sustain > 0 holds the note).
  - **Timbre** — one spectral-tilt slider (`k^e`), **0.5 = neutral**, left darkens / right brightens;
    **energy-normalized** so it changes color, not loudness (see Gotchas).
  - **Filter** — **Cutoff**, **Resonance** (Q), **Env Amount** (octaves the envelope opens above base
    at attack) and **Key Track** (0 = fixed Hz, 1 = follows pitch). Native `BiquadFilter`, no WASM.
  - **♪ Test** auditions a mid-register note through the current target (a lane target plays through
    its bus, so M/S apply).
- **Patch persistence:**
  - **Lane patches** ride the arrangement (`notorolla.arr` autosave + project file) and **count as
    musical content** (editing marks the project dirty). The whole **sound layer** — patch + effect
    inserts (delay/chorus/reverb) + modulators — **live-carries** across a normal tile undo/redo
    (`arrApply` by lane id), so undoing a tile move never reverts a sound edit; a `full` entry
    (lane/player **Reset**) or a lane reappearing on redo restores from snapshot. Mixer **gain/pan**
    stays genuinely undoable.
  - **Grid/neutral patch**: `notorolla.gridpatch` (localStorage only, not in the project).
  - **Migration**: a pre-existing single global patch (`notorolla.patch`) seeds any patch-less lane
    on first load (existing projects reload identical; the dirty baseline absorbs the auto-add).

- **"Lite Instruments" — a live-only CPU relief (2026-07-05).** A global checkbox in the tile-player
  toolbar. When on, the two heavy voices — **Wendelhorn** (~3 osc vs ~10) and **Nayumi** (drops the
  breath/noise path + bit-crush; keeps the 3 formants + vibrato) — build a cheaper live graph that
  keeps their character. A **workspace preference** (`state.lite`, never dirties). Level-matched so
  toggling doesn't jump loudness. **A bounce is always the full voice** (`buildVoice(…, lite)`: live
  passes `engine.lite`, both offline paths force `false` — see Gotchas). `lite.mjs`.
- **The grid BORROWS a loaded tile's instrument (2026-07-05).** The grid's active instrument is a
  descriptor — its own neutral `gridPatch`, or `{ source:'lane', laneId }` borrowed from the selected
  tile — resolved by `patchFor(null)` for all grid audition/playback. **Select a tile** → borrow that
  tile's lane instrument (editing the grid instrument then edits the LANE, hence every tile on it);
  **New** → back to the grid's own; **Clone** → promote the borrowed one to the grid's own; **Restore**
  → re-apply the parked pattern's instrument. Persisted; a project Open/New resets to the grid's own.
- **Patch catalog (2026-07-06)** (future_directions §14). Patches are **first-class, id-keyed, named
  objects** (the sound analogue of named patterns): a `PatchStore` ([src/js/audio/patches.js](src/js/audio/patches.js))
  holds `{id,name,kind,params,factory}` — names are non-unique labels, the **id is the key**
  (`crypto.randomUUID` for user patches; a deterministic `f:<kind>` for the read-only factory **`Init`**
  per kind, so a project resolves on any machine). The catalog is **user-global** (`notorolla.patches`,
  cross-project; never in a project file — the resolved params ride the project, self-contained). Each
  **lane + the grid patch carry `patchOriginId` / `patchName` / `patchDirty`**. **Display**: `Name` /
  `Name*` (edited or typed-but-unsaved) / `Name [I]` (imported — origin unknown to this catalog); `*` =
  "not saved as shown".
  - **Editor Patch bar**: the name (double-click → inline rename = a fork name), **Save** (overwrite the
    linked user entry if the name is unchanged, else fork), **Save As** (always fork), **Load** (per-kind
    dropdown), **Catalog** (opens the window).
  - **Catalog window** ([src/js/ui/catalog.js](src/js/ui/catalog.js), a `panel.js` tenant): lists **kind → patch**
    (factory + user), live name search, **double-click = apply to the current target** (cross-kind
    aware), the target's patch highlighted, per-user-patch **Rename ✎ / Delete ✕** (factory read-only);
    live-refreshes on every store/target change.
  - **Behaviors**: the `imported [I]` flag is explicit, set on project-file Open when a lane's origin
    isn't in this catalog. A **Delete** of an in-use patch detaches its linkers to `Name*`. **True
    in-place Rename** keeps the id and propagates to clean linkers (dirty linkers keep their snapshot).
    A **name collision** with an existing user patch opens a Save/Rename/Cancel dialog; factory-name
    collisions auto-uniquify (`Init`→`Init1`). Patch identity **live-carries through tile undo/redo** and
    seeds onto fresh lanes. `notch/patches.mjs`.

### Grid editor (one pattern at a time)
- **Per-pattern column count** (time) × resizable pitch rows (one octave by default, C4 at
  bottom). A pattern's width = `columns.length` (default `DEFAULT_COLS` = 12, range `[MIN_COLS, MAX_COLS]`);
  a toolbar **"Cols − N +"** stepper resizes the current pattern (grow appends rests on the diagonal,
  shrink drops trailing columns — undoable, persisted with the pattern; New/Clone inherit the width,
  Clear keeps it). Notes stored by **absolute degree**, so resizing/scrolling never loses notes.
- **Mono mode (one note/rest per column). Rhythm ⊥ pitch: groove is set in the FOOTER performance
  lanes, not by clicking notes.** Four **performance lanes** stack below the grid body (the "attribute
  rack"), one **chit** per column each: **notes** (neutral gray handle = the column's pitch content),
  **duration** (color = value via `durationColor`/`PALETTE` + a small numeric), **accent** (3-level:
  normal / accent / ghost → velocities 0.78 / 1.0 / 0.45; green/yellow/blue, `>` / `( )` glyphs),
  **articulation** (`ARTICULATIONS`: spiccato / staccato / normal / legato / tenuto; chit = a
  gate-length bar + label). Accents and articulations are **column groove attributes** (can be laid
  over rests, then pitched — backbeats etc.). Playback resolves articulation to a **sounded length**
  `n.artDur` (beats, baked in `toScore` via `articBeats`; used by the scheduler / auditions /
  WAV+MIDI+stem exports): normal 0.88, staccato 0.5, legato 1.0, tenuto 1.15 (rings past the slot),
  spiccato an absolute ~55 ms. Model: `accent` 0/1/2 + `artic` index are column fields (backward-safe
  `toJSON`).
  - **Chit gestures:** single-**click EDITS** the lane (duration → current brush; accent/artic cycle;
    notes-chit click = arm the notes); **double-click ARMS/disarms** that lane (notes double-click =
    arm all four; armed chits show a blue frame); **drag swaps** the ARMED lanes between the grabbed and
    drop columns (just the grabbed lane if nothing is armed) via `swapLanes(cols,a,b,laneIds)`, with a
    live preview and a floating ghost stack of the grabbed chits. Arming is transient/per-column,
    disarms on ESC / body click / a completed swap; selection follows a swap only when `notes` is armed.
    Single vs double click is disambiguated by a `DBL_MS` (260 ms) hold with optimistic feedback (a 2nd
    click rolls the edit back and arms instead). **Double-clicking a toolbar duration brush = set the
    whole pattern to that duration** (`applyDurationAll`).
  - **Body clicks are pitch-only:** click a rest = place a note at the column's existing duration; click
    a note's cell = re-audition; a different row = repitch; right-click = note↔rest. **Body click-drag is
    axis-locked** — vertical repitches; horizontal swaps only the pitch (degree + isRest), leaving the
    groove in place (`swapNotePayload`) = "reorder pitches over a fixed groove." **ESC cancels any
    in-progress gesture** (`cancelGesture`). All performance-lane edits are **undoable** (one per-pattern
    entry each). In mono the notes-chit swap and the body horizontal drag do the same column-level pitch
    exchange; per-note "move, don't swap" arrives with poly (§7).
  - **Stretch view:** column widths are a **log-compressed** map of duration into a bounded band
    (`stretchWidth`, ~31–72px), decoupled from the roll, like music engraving. Pure helpers in `grid.js`
    (`swapNotePayload`, `swapColumn`, `swapLanes`, `durationLabel`).
- Duration brushes {1/16, 1/8, 3/16, 1/4, 3/8, 1/2} (shown shortest→longest via `DUR_ORDER`; 1/16
  and 3/16 — a dotted eighth — are stored at the end of `DURATIONS` so old `durIndex` values don't
  shift). Color = a **chilled spectrum** by duration
  (red 1/16 → yellow 1/8 → green 1/4 → blue 1/2 → violet whole), interpolated in log-duration space
  (`durationColor`), so 3/8 reads green-blue. **Clicking a duration brush with notes selected sets
  those notes' duration** (`applyDuration`, undoable).
- **Selection** (Ctrl = "select" modifier): **Ctrl-click** a note's cell toggles it in/out of
  a multi-note selection (blue halo ring); **Ctrl-drag from empty space/a rest** draws a
  **marching-ants marquee** that, on release, **toggles** every visible note inside it (so a
  marquee can add or remove). Crosshair cursor while Ctrl is held. It's an **independent
  layer** — plain edits leave it alone (a note turned to a rest is pruned), and a horizontal
  swap carries the selection with the note. Cleared by **Esc**, loading/switching the pattern,
  **Clear**, or leaving the grid pane. Transient (not saved/undone). Exposed as
  `grid.selection` for the selection *tools* (see Permute below; transpose/etc. to come).
- **Scale-mask library** ([src/js/core/scales.js](src/js/core/scales.js) `SCALES`) — a full 12-ET set: Chromatic, the
  **seven diatonic modes** (Ionian/Dorian/Phrygian/Lydian/Mixolydian/Aeolian/Locrian), **harmonic** &
  **melodic minor**, the **symmetric** scales (whole-tone, octatonic W–H & H–W = diminished, augmented),
  **blues**, and pentatonics; 16-ET has Mavila. Symmetric scales are a deliberate target — their even
  spacing makes scale-*step* transposition warp every interval quality at once (the striking-atonal
  engine the composer leans on; see [future_directions.md](future_directions.md) §11). Pure data; the
  picker is data-driven (`scalesFor(edo)`).
- **Pitch context (tuning + scale mask + root)**: each pattern carries a **tuning**, a **scale mask**,
  and a **root** (toolbar "Pitch" selectors, with explainer tooltips; persisted per-pattern, older data
  defaults to 12-ET/chromatic). The 12-degree tunings (`12-ET`, `Just (5-limit)`) stay on the 12-degree
  grid, so every tool (incl. the Triadulator) keeps working; the tuning only changes how degrees *sound*
  (`tuningFreq` per pattern — just intervals fan out from the root, which stays at its 12-ET pitch). The
  scale mask **highlights in-scale rows** (faint blue) and **snaps** placement/drag to them. The **root
  (tonic)** shows a gold left-edge stripe + label — only when it matters (a just tuning or non-chromatic
  mask). Audio resolves frequency **per note's pattern**, so a mixed-tuning arrangement plays correctly.
  The **piano roll plots by true pitch in cents** so mixed/microtonal notes land at real height (a fixed
  12-ET reference ruler backdrop; 12-ET maps pixel-identically via `yForCents`; a just third ≈ 2.5px
  below ET). *Deferred:* a global concert-pitch / C256 reference control, a vertical roll zoom for cents
  differences; microtonal MIDI export is §17.
- **The "cross" tuning — first NON-OCTAVE tuning BUILT (2026-07-06)** ([src/js/core/tuning.js](src/js/core/tuning.js);
  future_directions §15). A sparse **just** scale that deliberately **does not close the octave**: two
  generators fan out **both directions from middle C** — a just minor third (**6/5**) and a just perfect
  fourth (**4/3**), a **"cross"** (two independent chains, *not* the 2-D lattice). **Comma-pairs are KEPT**
  (only the exact shared anchor is deduped), so a **degree = index into the sorted absolute-pitch list**
  (`buildCross()` fills A0..C8; **middle C pinned to degree 60**). Slots into the `freq(degree,root)` seam
  (root ignored; anchor always middle C). **Equave-less machinery** (the reusable payoff): `equaveOf` /
  `hasEquave` — the cross carries **`equave: null`** (and `edo` = the degree **count**, so `%edo` stays
  safe and every degree is its own pitch-class, no false octave-mates). `hasEquave` gates the
  octave-dependent features **off**: octave-mate highlight, the home-row tint + tonic stripe, **Shift+↑/↓
  octave** transpose, the **triad labels + Triadulator** (both need pc-sets), and the **root picker**
  ("C (fixed)"). **Labels = nearest-12-ET note + cents** (`near12Name` → e.g. `D#4 +16`) in the grid rows
  and the roll gutter (header **"cx"**). A **true-2:1 octave ruler** on the grid (`_drawOctaveRuler`: faint
  dashed lines at real doublings of middle C) is an orientation aid, *not* pinned to any degree. Chromatic
  stepping works unchanged. `notch/cross.mjs`. *Deferred (§15):* the analysis-based consonance predicate +
  the general `{anchor,generators,range}` generator engine — this tuning is the concrete first target of
  the tuning⇄timbre platform.
- **Permute tools** (toolbar group after Triadulate), acting on the **selection — or all notes if
  nothing is selected** (`grid.permuteCount`), among their own columns (positions/halos stay put; whole
  notes — pitch + duration + accent — move); enabled at ≥2 notes, undoable, chainable: **⟳ Rotate**
  (cycle one position right, wrapping), **⇄ Reverse** (retrograde), **▁▃▅▇ / ▇▅▃▁ Sort** (by pitch
  asc/desc, stable on ties), **▃▇▇▅▁ Shuffle** (random permutation, re-rolled to differ), **▇▃▇▅▁ Shuffle
  (no consecutive repeats)** (no adjacent equal pitches when feasible, fewest unavoidable repeats
  otherwise — constructive greedy, verified optimal).
- **Mutate tools** (after Permute; same selection-or-all targets): **↑ / ↓ Transpose** —
  **scalar/diatonic**: each note moves to the next degree **in the active scale mask** (`transposeScalar`
  → `stepInScale`); under Chromatic that's ±1 semitone, under a narrower mask it steps to the next scale
  tone (an off-scale note snaps onto the mask in the move direction). Arrow keys ↑/↓ do the same;
  **Shift+↑/↓ = a literal octave/equave** (gated off for equave-less tunings). No-op if it would leave the
  navigable range; undoable; grid-only.
- Two views: **Grid** (uniform columns) and **Stretch** (width ∝ duration, aligned to the
  roll). Active rows highlight; **octave-mates highlight softly**.
- **Reference backdrop (2026-07-08)** ([src/js/core/reference.js](src/js/core/reference.js); the first pass of
  future_directions §16 New Counterpoint). A **read-only reference pattern** overlaid behind the edited
  one, to see/hear them together. **Toolbar "Reference" group**: **Set Reference** (enabled only when
  exactly one tile is selected) freezes that tile — pattern + its lane's patch + transforms — into an
  **immutable self-contained snapshot** (`bakeReference`); a **chip** (`❄ name`), **Clear**, and a **3-way
  level** button (green full / yellow Soft / red Muted). **Not a live link** (user's call): later edits to
  or deletion of the source tile never touch the reference. Both patterns render through the **shared
  merged-time layout** ([src/js/core/grid.js](src/js/core/grid.js) `mergedLayout` + `widthForBeats`) — one engraving-style
  `beat→x` map from the **union of their column boundaries**, so simultaneous onsets align regardless of
  each pattern's durations (a foreign onset widens an edited column); today's **Stretch is the degenerate
  case** of this, so a reference **forces Stretch**. **Length policy**: timeline = `max(edited,
  reference)`; the shorter **loops to fill**. The reference draws as **steel-blue ghost dots** (rows by
  degree; the roll's true-cents view is the honest cross-tuning home, deferred), nudged one radius
  (`GHOST_SHIFT`) left so the edited note overlaps and the ghost peeks out; the edited pattern's own
  loop-repeats past its length draw as faint **inert** ghosts. **Playback** (audition only, never the
  export): `buildAuditionScore` merges the reference via `mergeAudition` (tiled; Soft ~−8 dB; Mute drops
  it) dry through its baked patch via a **per-note `patch` override** on `engine.playNote`.
  **Persistence**: rides the workspace UI state (`referenceToJSON`; self-contained), cleared on project
  Open/New. `notch/reflayout.mjs`, `notch/reference.mjs`. **Deferred (§16)**: New Counterpoint generation,
  Split/Steal/Blend, drag-to-steal, multiple/arrangement-context references.
- **Keyboard-tracking pivot band (Boshwick) (2026-07-05).** When the grid's active instrument is
  Boshwick, a faded-pink band marks the **pivot row** — where Pitch Track has no effect (the drum sits at
  its nominal pitch, `(f0/FREF)^pitchTrack = 1`), the reference pitch that stays put as you drag the
  tracking slider. `FREF` is fixed middle C; the row is `nearestDegreeToFreq(FREF, tuning, root)`. Shown
  always for Boshwick. (The same reference is the filter "key center" for Vesperia/Wendelhorn — a future
  band could show it too.)
- **Triad labels** ("Show triads" toggle, default on): every run of **three adjacent notes** (no rest
  between) is classified via `classifyTriad` (Triadulator templates, **12-ET only**) and, if recognized,
  labeled (`C Maj` / `A min` / `G dim` / `E aug` / `C sus` — root + quality, inversion-agnostic) in a band
  **above the grid**, centered on the middle note, across **two staggered rows** so neighbours don't
  collide. `sus` is always recognized (sus2/sus4 = pc-set `{0,2,7}`). The scanner is structured for later
  liberalized triads / tetrads (window size + pc-set templates), and also labels the Triadulator's
  prospective (ghost) notes live.
- Vertical **resize** (drag handle, min 12 rows) + **wheel scroll** of pitch range, with a
  fixed-position dashed resize guide.
- **Navigable pitch range = the 88-key piano, A0 (27.5 Hz) → C8, per tuning.** `degreeBounds(tuningId,
  root)` ([src/js/core/tuning.js](src/js/core/tuning.js)) resolves the A0..C8 frequency band to the **degrees closest in
  pitch** to those edges in the pattern's tuning (monotonic scan, so any non-EDO tuning works without an
  inverse; memoized). So 12-ET = A0..C8 (MIDI 21–108, exactly the piano); 16-ET = degree 8–124 (~7.25
  octaves). Bounds are **per-pattern** (gridview clamps/viewport read `_loDeg`/`_hiDeg`). 12-ET stays in
  MIDI 0–127, so plain-MIDI export is unaffected.
- **New Random** (toolbar, next to New/Clone; [src/js/core/random.js](src/js/core/random.js)). Regenerates pitches
  **over the current grid's rhythm** (per-column durations + groove kept, only pitches randomize).
  **Never gated**: if the current pattern isn't in a tile it's rewritten in place; if referenced, a 3-way
  dialog — Replace All / New Pattern / Cancel. **Auto-rolls on open** (audition immediately); Accept = one
  undo step, Cancel restores. Default generation = a **generalized tone row**: a contiguous window of
  in-scale degrees centered on the viewport, random order, no degree reused; every position gets a note
  (generated rests are a future evolution). Controls (persisted in `notorolla.randgen`):
  - **Range** — max distinct in-scale degrees the melody may use (a pool centered on the grid view; far
    left = unlimited = note count; else 1..24 with a note-span readout). `range < count` → pitches repeat;
    `> count` → a wider, gappier spread.
  - **Unique** (permutation ↔ sampling-with-replacement), **Run** (−1…+1 stepwise continuation; ±1 = an
    even monotonic **staircase** across the pool, `runStaircase`), **Triad** (chance each note completes a
    triad with the previous two — EDO-aware `classifyTriad` off the Triadulator's enabled families, so
    16-ET gets septimal bias).
  - **Duration Bias** / **Accent Bias** (−1…+1, 0 = off) — both **move the NOTES, not the groove**: the
    same pitches are re-paired so pitch tracks the column's length / accent loudness (Low = lowest pitches
    on longest/loudest; High = highest). Two mechanisms: **STEER** (default) bakes the pull into generation
    (`biasTargets`/`biasedPick`), weighting only the otherwise-uniform pick so Run/Triad contour survives;
    a per-slider **Sort** checkbox switches to a post-hoc re-pairing (`rankBias`) for comparison. Grayed
    out when the rhythm / accents are uniform.
  - Dialog: **Randomize** (re-roll), **♪ Audition**, **Reset**, **Accept**, **Cancel/Esc**, plus **`<`
    back / `>` redo** — an ephemeral per-session stack of `{columns, settings}` restoring both pattern and
    sliders. The result inherits the source's tuning/scale/root + rhythm. Pure generator (`generateRandom`,
    injectable rng; `notch/random.mjs`).
- **Opening a pattern auto-centers the pitch viewport** on its notes (`centerGridOn`: midpoint of
  the note span, clamped to the pattern's navigable range), so a pattern a couple octaves away doesn't
  land off-screen. Applies on double-click-open a tile, Restore, and project load; a note-less
  pattern leaves the view untouched. A plain reload keeps the last-scrolled view.
- Generous **audition** (fixed quarter-note preview on edits).
- Cursor reflects brush duration (Dot default; Glyph experiment — SMuFL is the real
  long-term answer for music glyphs).

### Patterns as named, referenced objects
- A **registry** of named patterns (A, A1, A2…; New and Clone share the counter).
- The editor edits one "current" pattern **by reference**; tiles reference patterns by
  name, so **editing a pattern updates every tile that uses it** (thumbnails update live).
- **New** overloads as **Restore (`↺ A2`)** when a pattern is parked. Invariant: at most
  one floating (unsaved) pattern at a time; New/Clone disabled unless the current pattern
  is referenced or empty and nothing is parked. The antidote to setting one aside is the
  future **Save**, not invisible parking.
- **New = a GROOVE STENCIL, not a bare blank (2026-07-05).** New continues the current pattern's
  **working context** instead of snapping to a default 12-ET-chromatic blank: it carries the width,
  the **pitch context** (tuning / scale / root) **and** the per-column **performance lanes**
  (duration / accent / articulation) — only the **pitches clear** (rests on the diagonal). The seam
  is `Pattern.stencil(name)` in grid.js (next to `clone()`, which by contrast copies the notes too);
  `newPattern` calls it when there's a source, else `Pattern.initial` (the seed / New Project blank
  stays at defaults). The grid's **instrument** is NOT changed by New (see the borrow model). `newctx.mjs`.
- **Clear** is destructive (empties the current pattern in place → empties referencing
  tiles); tucked away, confirms when referenced.
- **Undo/redo is per-pattern**; the tile lane has its own append/delete undo.

### Tile player (the arrangement)
- **Parallel lanes** — **2 by default**, add more via a **"+ Lane"** button (a pinned, lane-head-width
  enclosure below the stack, `position:sticky; left:0` so it doesn't scroll away): `addLane` makes an
  empty active lane (undoable, persisted; New Project resets to 2). No hard cap. Each lane is an ordered
  set of positioned tile references. *Removing* lanes is deferred.
- **Track vs lane, and reordering (drag the colour stripe).** The lane *object* is the **track** — its
  colour, patch, tiles, inserts, mute/solo are all intrinsic; the **lane** is just the row it currently
  sits in (only the positional "Lane N" number is positional). **Colour is intrinsic** (`lane.color`,
  seeded from `laneColor` by lane id at birth — blue/orange first, golden-angle HSL after — and
  serialized), so it **travels with the track** on reorder instead of repainting by slot; old colourless
  saves fall back to the by-position colour, reproducing the prior look. Grab the widened colour stripe at
  a lane head's left and drag up/down to reorder: a **pick-up ghost** (a faded, right-fading photocopy of
  the lane's on-screen strip) + an **insert bump** — the neighbours and a viewport-wide, track-coloured
  **drop-band** (its bright top edge is the insertion divider) FLIP-slide to open the target gap (an
  insert, never a pairwise swap). The timeline (horizontal) scroll is frozen for the gesture so the
  bumping layer can't drift; vertical auto-scroll near the screen edge still works; **Esc cancels**.
  `Arrangement.moveLane(id, toIndex)` is a pure array splice — one undoable arrangement edit with **no
  audio replumbing** (buses and selection are keyed by lane id, and lane summation order is inaudible). A
  click on the stripe (below the drag threshold) is reserved for a future colour picker.
- Drag the grid's **grab handle** into a lane to drop a tile (a width-proportional
  thumbnail; note bars colored by duration; bordered in lane color; name centered).
- **Fresh-lane instrument seeding**: dropping into a **fresh** lane (`lane.fresh` — brand-new or
  just-reset, never used) sets that lane's instrument so the tile keeps sounding as it did — the
  **grid's** patch when dropped from the grab handle, or the **source lane's** patch when a tile is
  moved/copied in from another lane (a tile carries no patch — its lane does). A lane stops being
  fresh once it gets a tile **or** its instrument is edited, so a lane you set up and later emptied
  keeps its sound (it won't be re-seeded). `fresh` persists (optional; old saves default not-fresh).
- **Reset / clear** (both undoable, no confirm): a red **"R"** at the far left of each lane head
  **resets that lane** (clears its tiles + restores default instrument/mixer/delay/mute-solo, marks
  it fresh; the lane stays in the stack), and a **"Reset player"** button (top-right of the tile
  controls) returns the whole player to **two blank fresh lanes** with the play region cleared.
  Reset undo restores the **instrument** too: arrangement-undo entries are tagged — a reset is a
  `full` entry that restores each lane's patch from the snapshot, while normal entries keep
  live-carrying the current patch (so a tile-move undo never reverts a separate sound edit).
- **Multi-select + transform ACTIONS.** Selection is a **SET of tiles on ONE lane**
  (`arrangement.selectedIds` + `selectedId` = the **anchor**, last-clicked; runtime-only, not
  serialized; every mutator keeps the one-lane invariant, in [library.js](src/js/core/library.js)). Gestures:
  **Marquee** (click empty track space + drag → a blue band, clamped to the anchor lane, live-selects
  every tile it intersects; a no-drag click clears; Esc cancels), **Ctrl-click** toggles a tile in/out
  (Ctrl still means *copy* during a drag), **Shift-click** selects the contiguous run to the anchor,
  plain click = fresh single selection. **Delete** removes every selected tile in one undo entry.
  **Transforms are ACTION BUTTONS** (select tiles, then click; one undo entry; the selection survives
  so actions chain; buttons disable with no selection — deliberately no "or all" fallback):
  - **Transpose** SETs each tile's transpose to the bar's **Amount/Scale** (always-visible params; a
    second application replaces, 0 clears; Scale Auto = each tile's own mask; tuning never changes). The
    Scale dropdown is filled from `scalesFor(edo)` for the selected tile's tuning (mixed-tuning selection
    → only Auto + Chromatic), with a read-only **key readout** ("varies" on a disagreeing multi-select).
  - **Reverse**: **unify** — if every selected tile is reversed, un-reverse all, else reverse all
    (retrograde within the tile's full length, trailing rests included).
  - **Clone**: each selected tile repoints to a fresh deep copy (`library.cloneOf`), **deduped per
    source within the action**; the anchor's clone opens in the grid. (Undo repoints back but the clones
    linger in the registry — orphan-GC is deferred.)
  - **Transform inspector** (chips right of the bar): one tile = its ordered removable chips; several =
    the **intersection view** — a count + a chip per transform kind common to all selected ("Transpose
    (mixed)" when the kind is shared but amounts differ); a chip's ✕ removes that kind from every selected
    tile.
  - **Block ops:** the selection moves/copies/repeats as a **rigid block** (relative offsets + gaps
    preserved) with a per-tile **"ignore" collision policy** (a member overlapping a non-moving tile is
    `blocked` — a move leaves it, a copy/repeat skips it). Pure planners (`planSelectionDrop`/`planRepeat`,
    `notch/blockops.mjs`) are shared by preview and commit. **Multi-move/copy**: dragging any member
    carries the whole block (Ctrl = copy; cross-lane works; a band per placed member). **Repeat — the
    fill handle**: a blue grip on the block's right edge stamps whole-block copies at `blockStart +
    k·period` (period = block span → seamless); **bidirectional** (drag right for `k>0`, left through/past
    the block for `k<0`, clamped at beat 0); a `position:fixed` count chip follows the pointer ("N + M",
    or "N + M (I)" with I = |k| for a multi-tile selection). One undo entry; afterwards selection =
    originals + all stamps. Transforms clone onto copies.
- **Per-tile transforms (nondestructive)** ([src/js/core/transforms.js](src/js/core/transforms.js), applied in
  `arrangementScore`): transforms live on the **tile instance** as an **ordered list**, never the
  pattern, so two tiles can share one pattern yet sound different and editing the pattern still
  updates both. A **note-list pipeline** (`applyTransforms`): **transpose** maps pitch (re-resolves
  freq in the tile's tuning), **reverse** retrogrades time, **detune** shifts sounding pitch —
  walked in list order. **The One True Order (2026-07-09):** at most **one of each kind**, in the
  canonical order **invert → transpose → rotate → reverse → detune** (degree-space ops that
  re-resolve freq first, time ops, then frequency-space last — forced: detune upstream of transpose
  would be clobbered; invert/rotate are reserved slots). `normalizeTransforms` enforces
  one-of-each + emits canonical order (any historical file comes out ordered); the `setTileX`
  helpers maintain it. With one-of-each + signed params, any "other order" is reachable by
  adjusting parameters; the planned **Bake** (future_directions §12) makes staging fully general.
  The tile's **thumbnail stays the pattern's identity**; transforms show as **stacked translucent
  swaths** at the bottom (transpose purple `+n`, reverse teal `◄`, detune amber `+37¢`) and as
  chips in the bar (see the inspector above); the **roll shows the real transformed notes**. Saved
  per-tile (`tile.transforms`, optional/backward-safe), **undoable** (carried through `arrApply`),
  **copies carry cloned transforms**.
- **Detune transform (2026-07-09)** — the third transform: shift a tile's **SOUNDING pitch by ±100
  whole cents, uniformly for every instrument** (the contract: it alters the *output* pitch, not
  the input note — a PitchTrack-0 Boshwick drum still moves the full amount). Mechanism, two parts:
  `applyDetune` **multiplies `note.freq`** by `2^(cents/1200)` (exactly right for every voice whose
  pitch is linear in f0 — all the melodic kinds — and the roll's true-pitch plot draws the offset
  for free) **and stamps `note.detune`** (cents), carried like `artDur` through score-build →
  scheduler → `playNote` → `buildVoice` → both offline export loops. **Boshwick tops up** the
  nonlinear remainder (`× 2^(cents·(1−PitchTrack)/1200)`); the stated contract for future nonlinear
  voices (sampler: shift playbackRate by the same ratio). Bar UI mirrors Transpose: a **Detune**
  action + cents stepper (**5 ¢/click, Shift = 1 ¢**), SET-not-accumulate, 0 clears, one undo,
  amber chips/swath. Reference backdrop + tile audition inherit via the shared pipeline. **MIDI
  export doesn't carry it** (12-ET degrees; the §17 microtonal-export bucket). `notch/detune.mjs`
  (23 — incl. the [T,D]≡[D,T] canonicalization regression).
- **Modeless-pane primitive** ([src/js/ui/panel.js](src/js/ui/panel.js); Patch Catalog Phase A). `createPanel({title,
  storeKey, defaultGeom})` is the floating / draggable / resizable / scroll-resistant / geometry-remembered
  / **document-agnostic** window chrome — a tenant appends content to `panel.root` and drives
  `show/hide/toggle/isOpen/onToggle`. Shared by the Tile Inspector and the Patch Catalog (future_directions
  §14).
- **Tile Inspector (2026-07-05)** ([src/js/ui/inspector.js](src/js/ui/inspector.js); a button in the tile-player top
  row). A **modeless window** (future_directions §12) — not a modal: stays open, blocks nothing, and
  **follows the tile selection**. `position: fixed` (owns its spot, ignores page scroll), header-draggable,
  `resize: both` (min 240×180), never scrolls the page (interior overflow scrolls inside `.inspector-body`);
  position/size/open-state persist (`notorolla.inspector`). Renders from a plain **facts** structure
  (`setFacts({heading, sub, sections})`) so a later pop-out is just adopting the node. **Content** (read-only
  for now) for the **anchor** tile: Placement, Pattern (name/columns/notes/tuning/scale/key), Instrument,
  Transforms; a multi-selection shows the anchor with an "anchor of N selected" note. **Transport cluster
  (▶ ■ ↻)**: Play auditions the anchor tile once, Loop = the app's **limited loop** (tap to stack passes,
  capped, counting down — *there is no infinite loop anywhere in the app*), Stop. The inspector **never holds
  focus** (transport buttons `tabIndex=-1` + blur after click) except while renaming. **Rename**:
  double-click the heading to give the tile a **friendly name** shown as "Break Beat 2 (A6)". The label
  lives on the **PATTERN** (`Pattern.label`), so every referencing tile follows; **clones/stencils don't
  inherit it**. Persisted (omitted when empty, backward-safe) and **counts as musical content** (renaming
  marks dirty). The friendly name shows **wherever the tile is displayed** (the thumbnail shows just the
  friendly name, canonical name via hover `title`); the `(A6)` parens form is inspector-only.
  `notch/label.mjs`. *Deferred:* per-tile editing; friendly name in clone lineage.
- Both lanes share **one horizontal time axis** (a single scale `tilePlayer.ppb`, one shared
  scroll, common origin), so tiles **align in time** across lanes. Tiles are **freely positioned**:
  each carries an explicit **`start` beat** (snapped to the 1/4-note grid = integer beats), so gaps
  (silence) between tiles are allowed. Faint **beat ticks + bar lines** in the track show the snap.
- **Adjustable horizontal scale**: a strip below the lanes — `[−] [slider] [+]`, **smaller ←→
  bigger**, quantized to notches (`TILE_SCALES = [4,6,9,13,19,28,40]` px/beat; the old fixed 6
  sits near the low end, the rest is zoom-in headroom). Slider snaps to notches, −/+ step one
  notch (disabled at the ends). Zoom keeps the left-edge beat roughly in place (scroll scales
  with it). **View-only** — persists in `notorolla.ui` (`tileScaleIdx`), never flips the dirty bit.
- Each lane has a **sticky header block** (pinned during horizontal scroll): a color stripe + a
  two-line **Instrument / Patch block** (**double-click anywhere in it → the instrument editor on that
  lane**; the patch line shows the patch name with `*`/`[I]` flags) + a **stacked effect column**
  (**"M" modulators** at left, then **"D" delay** over **"C" chorus**; each lit when on, opening its
  modal) + a **knob column** (**Pan** over **Gain**) + the **Mute / Solo** stack. The knobs are
  mixer-style: click + vertical-drag (Shift = fine, double-click = reset); Pan has a center detent, Gain
  is a **dB knob** (−∞…+6 dB, unity detent at 0 dB) storing linear gain; a knob drag is one undo step.
  M/S are a **per-lane tri-state** {none | muted | soloed} (turning one clears the other for that lane;
  no cross-lane exclusivity). Audible rule: **solo wins globally** — if any lane is soloed, only soloed
  lanes sound; else every non-muted lane sounds. M/S **save with the project** (part of the content
  snapshot → toggling marks dirty; undoable, rides tile Undo/Redo; New Project resets).
- **M/S act in real time (a per-lane gain bus).** Each lane's voices route through its own
  `GainNode` (a tiny mixer in [src/js/audio/audio.js](src/js/audio/audio.js): `laneBus`/`setLaneGain`, voices via
  `playNote(..., laneId)`); Mute/Solo just ramps that bus to 0/1 (~12 ms, click-free). Because the
  scheduler keeps scheduling **every** lane's notes regardless of mute, the voices always run into
  their bus — so muting silences **present tails and future notes at once**, and **unmute reveals
  whatever's playing on that lane at that instant** (mid-note/tail), like a DAW channel mute. No
  per-voice/`noteOff` API needed; the lane bus is also the future home of per-lane **volume** (the
  gain *is* the fader) and per-lane **effect inserts** (upstream of the gain). Un-laned sound (grid
  playback, audition) goes straight to master, unaffected. The roll still **shows** silenced notes,
  **hatched** (driven by the baked `muted` flag, independent of the audio path).
- **Lanes play simultaneously** from t=0; arrangement length = the farthest tile end
  (`max(start + length)`) across lanes; shorter lanes rest at the tail; the whole thing loops as one
  unit.
- A tile's playable length is the **full sum of its column durations** — note *and* rest, including
  trailing rests. Trailing rests are intentional time, so a tile can carry built-in space before
  the next one.
- **Click = select AND open** the tile's pattern in the grid editor (modifier clicks — Ctrl toggle /
  Shift range — build selection without churning the grid); **double-click = AUDITION**: plays just that
  tile — pattern + transforms, through its lane's instrument/bus/effects/modulators (mute/solo respected;
  notes keep their true ruler position for the Loop-Mod anchor). One-shot via the shared scheduler
  (`activeSource = 'audit'`; no playhead sweep — the auditioned tile gets the green badge); another
  double-click replaces it, Space stops it. (Double-click is detected manually in the click path since
  the first click's refresh rebuilds the tile element.)
- **Drag to position / move / copy** (pointer-based; a small movement threshold separates a drag from
  a click). Placement is governed by the **Ripple toggle** (leftmost in the transform bar, **default
  OFF**, a workspace pref; covers insert AND delete):
  - **Ripple OFF (default) — exact placement, overwrite on collision.** The tile lands with its left
    edge at the snapped drop beat exactly; every existing tile it **overlaps is removed whole** (tiles
    are **atomic** — no trimming). Deletes/move-outs **leave a gap**.
  - **Ripple ON — rigid ripple.** Clamped so it can't overlap the anchored left neighbor; tiles to the
    right shift right just enough to clear (gaps preserved); deletes/move-outs ripple everything to the
    right back left by the tile's length.
  Either mode: dropping off the lanes cancels; **Ctrl = a shallow copy** ("+" badge), no modifier =
  move (keeps the id). **Drop position** = the beat nearest the tile's **carried** position:
  `round(cursor − grip)` for tile drags (the normalized grip is held where grabbed, `clampGrip`/`gripFor`;
  the ghost hangs from the same point), `round(cursor − len/2)` for grid drops (always centered). During
  a drag the **beat caret enters CARRY MODE** — it marks the left edge of the prospective landing
  (`setCarryCaret`), so caret and landing band agree without warping the drop math to the pointer. Each
  change is one undo step; afterward the tile is selected and its lane active. (`moveTile`/`copyTile`/
  `insertAt`/`removeRipple` in [library.js](src/js/core/library.js).)
- **Prospective preview while dragging** (DAW-style), mode-aware, computed by running the **same
  placement ops on a throwaway copy** (preview == commit) while a floating ghost follows the cursor.
  **Landing is a filled blue band** over the exact span; **Ripple OFF** additionally marks doomed tiles
  (dimmed 40% + red outline), **Ripple ON** keeps the FLIP-animated rigid-shift preview. The preview is
  **visual only** — audio/roll/playhead keep playing the committed layout; a committed change's audio
  lands at the next tile boundary / loop, visual is immediate. Editing while playing is fully supported.
- The **grab-handle drop** (a new tile from the grid) is **position-honoring** (lands at the beat under
  the cursor, `insertAt`); the HTML5 dragover feeds the same landing preview (`onGridDragOver`). A fresh
  lane adopts the grid's instrument. Old gapless projects migrate by deriving each tile's `start` from
  the cumulative order (`ensureTileStarts`).
- **Active lane** (highlighted) set on drop / select / empty-lane click.
- **Beat caret — MODAL**: with nothing in hand, hovering a lane shows a light-blue vertical line at
  the beat **left of the pointer** (a "land/paste here" cursor, hovered lane only). **While a tile is
  carried** it switches to **carry mode** — marks the left edge of the prospective landing on the target
  lane instead of tracking the pointer (`setCarryCaret`). One element re-parented between tracks;
  `pointer-events: none`. Groundwork for copy/paste.
- **Range edits — Insert / Clear / Delete time.** Transform bar's `│ Range: [Insert] [Clear] [Delete]`
  (color-keyed): arm one, the ruler glows, draw a beat-snapped range — a band tracks the drag on the
  ruler and down every lane, affected tiles lit live (doomed = dim+red, `.range-shift` = blue outline).
  Semantics (all lanes; `Arrangement.insertTime/clearRange/deleteTime`): **Insert** = everything starting
  at/after the range start shifts right by the range length; **Clear** = tiles starting in [start, end)
  removed, nothing moves; **Delete** = Clear + everything at/after the range end shifts left to close the
  gap. Tiles are **atomic** (one starting before the range but reaching into it is untouched). The
  playhead and region markers **ride along** as timeline points (`insertPoint`/`deletePoint`); a
  degenerate region reopens 4 beats apart at the range start. One undo entry per op. `notch/rangeops.mjs`.
  - **Insert-at-origin exception (2026-07-12):** a **start marker at beat 0** (and a **playhead parked at
    0**) *stay* at 0 when time is inserted at the beginning, rather than being pushed to the end of the
    inserted gap — the prepended time joins the play region / stays "at the start," which is what the
    user expects there. Narrow special-case (`s === 0 && point === 0`) in `insertTime` (marker) and
    `commitRange` (playhead); every other configuration still rides along by the general rule.
- **The roll has a fixed-height (400 px) viewport that scrolls internally** (both axes; pairs with the V
  zoom) so a changing pitch span never resizes the pane and slides the page. (One half of the anti-scroll
  discipline — see Gotchas.)
- **Horizontal scroll persists across reloads** (`state.tileScrollX` in notorolla.ui — even with
  the playhead off screen you come back to the same view; scroll events land on state, the
  localStorage write is debounced 400 ms; restored after the initial render, browser-clamped).
- **Drop headroom**: the lane tracks + ruler extend **~half a viewport (min 8 beats) past the
  content end**, so an overflowing arrangement never pins its last tile against the window's right
  edge — there's always empty, droppable, scrollable track at the end (markers still clamp to the
  real content end). First piece of the "enable longer projects" push (2026-07-03).
- **Performance mechanisms for long projects** (the current shape; details/rationale archived):
  - **Ruler** is a one-major-period tick tile repeated as a CSS background (`rulerBackground(ppb)`,
    cached per zoom) + sparse number spans — not a full-width per-render canvas.
  - **Thumbnails** are CSS background-images from a content-keyed cache (`thumbImage`; key = zoom +
    per-column rest/degree/duration), so 100 tiles of one pattern = one rendered image.
  - **Playback updates** (`setPlaying`/`setPlayhead`, per frame) diff against render-time element caches
    (`_tileEls`/`_playheadEls`) rather than `querySelectorAll` sweeps.
  - **Auto-follow jumps a page** (playhead re-enters at the left margin) rather than writing `scrollLeft`
    per frame; **edge auto-scroll while dragging** (`tilePlayer.edgeScroll`) jumps a half-page when the
    pointer nears either side (time-gated, jumps not creep). Both the lanes and the ruler edge-scroll.
- **Playhead — always visible, parks when stopped**: during tile playback a vertical line sweeps each
  lane track (`.tile-playhead` per track, track-relative so it scrolls with the tiles and aligns across
  lanes); the lanes auto-follow it. When stopped it **stays on screen, parked** (`state.playheadBeat`, a
  workspace pref; project Open/New parks it at 0):
  - **Manual Stop parks it where playback was; a natural finish rewinds it to the region start**
    (`scheduler.onEnded`).
  - **Space** = play from the region start / stop (active pane); **Shift+Space** = loop.
  - **ArrowRight resumes from the parked playhead** (`resumePlay`, tiles pane, stopped only): the first
    pass is windowed to `[playhead, region end)`, but **a resumed play that loops wraps to the region
    start** (user decision).
  - **⏮ / ⏭ + B / E keys** park the playhead at the region start / end (`movePlayhead`; no-op while
    playing — live locate is deferred). No ruler click-to-scrub yet (it owns marker drags).
  - The **clock shows the parked playhead's position whenever the tiles aren't playing**.
- **Beat ruler + play-region markers** (sticky strip atop the lanes; `_buildRuler`/`drawRuler`). Marked
  in **0-based beat numbers** (a ruler number = a tile's `start` beat), minor ticks every beat, major
  every 4; a row in the same horizontal scroller so beats align and it scrolls in sync. **Play/loop
  region:** a **start marker** (always present, default beat 0) + an **optional end marker**
  (`arrangement.playStart`/`playEnd`; `playEnd: null` = end of the last tile, follows the arrangement).
  **Left-drag moves either marker** (empty-ruler click moves the start); **right-click clears the end**
  (back to auto). Dashed green/red guides mark the bounds through every track. **Both Play and Loop honor
  [start, end)** via `windowedArrangementScore` (windows the score to the region, shifted to beat 0, so
  the scheduler is unchanged). Markers **save with the project** (dirty-tracked) and are **undoable**;
  **Open restores the file's markers, New resets to 0/auto** — `loadContent` copies `playStart`/`playEnd`
  onto the live arrangement, so they never carry over from the previous document (fixed 2026-07-12).
  Marker edits land at the next loop boundary. **Export still renders the whole arrangement** (a "marked
  section only" mode is deferred).

### Transport & roll
- **Roll zoom — adjustable V + H scale**: quantized notches (`ROLL_V_SCALES` 4–32 px/semitone,
  `ROLL_H_SCALES` 16–80 px/beat), a V/H strip under the roll, persisted view-only
  (`rollVIdx`/`rollHIdx`). The exported `BEAT_WIDTH` is unchanged, so the grid's Stretch mode still
  aligns with the roll's DEFAULT zoom. **Labels = graph-ticks**: 12-ET pitch names on the left gutter at
  "musical round number" steps (the step ladder is [every pitch, octaves, 2-octaves]; the densest that
  keeps ≥13 px spacing; constant font size, C anchored/brighter). **Labels live on a PINNED GUTTER** (a
  second canvas `#rollGutter`, `position: sticky; left: 0` overlaying the roll; playback-follow +
  scroll-to-selected account for its width). Column 0 = 12-ET names; then **one column per non-12-ET
  tuning IN USE** (tiles view scans every tile-referenced pattern, grid view the current one; distinct by
  (tuning, root)), each headed by its EDO, with the tuning's own nomenclature (`degreeToName`) and ticks
  at true cent heights. (Closed-form degree placement assumes an equal division — an unequal scale would
  need a scan, noted in the code.)
- Grid transport (top bar) and tile transport (in the pane) are **mutually exclusive**
  (one shared scheduler; `activeSource`).
- **Output level meter + master fader** (right of the transport bar). The meter is a **stereo peak**
  display — **two stacked bars (L over R)**, dB scale, per-bar peak-hold, green→amber→red — tapping
  the **final post-master/post-compressor** signal (a stereo-upmix tap → `ChannelSplitter` → one
  `AnalyserNode` per channel; `engine.getPeak()` returns `{l, r}`). The **clip LED** lights at
  **peak ≥ 0 dBFS on either channel** (where the output/screen-recorder would clamp); click it to
  reset. A small always-on rAF loop drives it (reads 0 when idle). The **master fader**
  (`engine.setMasterGain`, anti-zipper ramp; persisted in `notorolla.ui`) sets output level and
  **the WAV export renders post-fader** (`renderToBuffer` uses the same `masterLevel`).
- **Stereo signal path:** each lane runs `voices → volume → StereoPanner → [chorus insert] → [delay insert]
  → mute-gate → master` (pan is BEFORE the inserts so ping-pong's hard-L/R and the chorus's stereo aren't
  re-panned; the mute gate is LAST so mute is instant yet the inserts keep running while muted and unmute
  reveals their tails). The inserts are an **ordered chain** (chorus then delay); `_relink(strip)` rebuilds
  only the edges between the panner, whichever inserts are active, and the gate — so toggling one insert
  doesn't disturb the other's tail. master + limiter are channel-agnostic, so the tail is stereo once
  panners feed it; the offline export is `OfflineAudioContext(2, …)` rebuilding each lane's
  volume+pan+chorus+delay so the **WAV is stereo and matches the live mix** (`encodeWav` was already
  channel-general). Un-laned grid audio is mono/centered.
- **Per-lane delay** (a "track" effect — an insert on the lane strip; `lane.delay = {on, mode, time,
  wet, feedback}`, saved with the project). **"D" button** in the lane head opens a **modal**
  (`buildDelayEditor` + generic `openModal`) with On/off, **Mode** (mono echo | crossfeed ping-pong),
  **Time** (tempo-synced note value 1/16…1 → `beats×60/bpm`), **Wet** and **Feedback** knobs (feedback
  capped 0.9; the master limiter backstops runaway). `buildDelayInsert(ctx, mode)` (audio.js) builds
  the native graph: mono = a stereo `DelayNode` with self-feedback (echo stays at the dry's pan);
  ping-pong = input summed to mono → `delayL` (hard-L, T) cross-feeds `delayR` (hard-R, 2T) cross-feeds
  `delayL` (3T)…, bouncing, feedback = bounce decay. Built lazily per strip / rebuilt on a mode change;
  time follows the tempo (`applyLaneDelayAll` on tempo change). A delay-modal session is **one undo
  step** (snapshot on open, live audio while editing, commit on close); persists + dirty-tracked. No
  WASM. Effects philosophy (user): delay = per-track; chorus = per-track (below); drive = future
  instrument-patch character; reverb = future instrument or shared send bus.
- **Per-lane chorus — Juno-60 emulation** (a "track" effect — an insert *before* the delay;
  `lane.chorus = {on, mode}`, saved with the project). **"C" button** in the lane head opens a **modal**
  (`buildChorusEditor` + `openModal`) with just On/off and a **Mode** switch (I | II | I+II) — authentic
  to the Juno, **rate/depth are fixed presets, no user knobs**. `buildChorusInsert(ctx, mode)` (audio.js)
  builds a **BBD chorus**: the dry passes through (keeping its pan) while a mono-summed copy runs a short
  (~5 ms) `DelayNode` swept by **triangle LFO(s)** (the pitch wobble = the chorus); a gentle lowpass models
  BBD bandwidth. The famous Juno stereo is **one delay line mixed +to-left / −to-right** (anti-phase via a
  `ChannelMerger`), so it spreads wide and **collapses toward mono on an L+R sum** (authentic). Modes are
  LFO presets — I: 0.513 Hz, II: 0.863 Hz (the measured Juno-60 rates), I+II runs both at once. Built
  lazily per strip / rebuilt on a mode change (`applyLaneChorus`); chorus-modal session is **one undo
  step**, same bracket as the delay. No WASM. ([src/js/audio/chorus.js](src/js/audio/chorus.js) owns the config + editor.)
- **Per-lane INSERT REVERB (2026-07-04)** ([src/js/audio/reverb.js](src/js/audio/reverb.js); `buildReverbInsert`/`reverbIR`
  in audio.js): character reverbs for a single instrument — canonical case **gated snare** (default mode
  = Gated). **"R" chiclet** (chiclets are a 2×2 grid, `M C / D R`), modal with **Type** (Gated / Ambience
  / Room / Hall / Plate / Spring) · **PreDelay** (0–80 ms) · **Size** (for Gated it IS the gate time,
  60–300 ms) · **Wet** · **Damp**. Engine: a **ConvolverNode over a SYNTHESIZED IR** — seeded noise
  (mulberry32 keyed on the settings, decorrelated per channel), envelope per mode (gated = near-flat
  burst hard-cut with a 2 ms anti-click fade — **the gate lives in the IR**; spring = decay × ~18 Hz
  flutter; damping = a one-pole lowpass along the tail); `normalize=true` equalizes IR energy, so **Wet
  runs a square law up to ×6** (`reverbWetGain`) since a smeared transient reads quieter than the dry hit.
  **Deterministic** (live + offline build the bit-identical IR). **Reverb is LAST in the insert chain**
  (pan → chorus → delay → reverb → gate). Save/undo/dirty/reset per the delay/chorus pattern; WAV + stem
  exports rebuild it (dry stems exclude it) and the **export tail extends by the longest enabled IR +
  predelay**. The shared send-bus reverb remains future. `notch/reverbcfg.mjs`.
- **Effect editors have Copy / Paste (2026-07-05).** A standardized Copy/Paste bar atop the **delay,
  chorus and reverb** modals (shared `openFxModal`/`fxCopyBar`). Copy snapshots the config into a
  **per-type** clipboard (a delay can't paste onto a reverb); it persists across modal opens, so you
  can copy one lane's effect and paste it onto another. Paste overwrites the config in place, applies
  it live, and rebuilds the controls; Paste is disabled until that type has been copied. Rides the
  same one-undo-step mix bracket.
- **Per-lane playback MODULATORS** ([src/js/audio/mods.js](src/js/audio/mods.js)) — slow parameter movement à la Cubase
  modulators, so notes evolve as their patterns repeat. **"M" chiclet** (lit violet when active) opens a
  modal with **two fixed mod slots**, each: **On** · **Shape** (Sine / Triangle / Ramp↑ / Ramp↓ /
  **Walk**) · **Parameter** (from `paramsFor(kind)` — numeric params only) · **Amount** (0–100% = peak
  deviation in slider-position space, perceptually even on log params) · **Rate** (0.01–1 Hz, log) ·
  **Phase** (0–360°).
  - **Note-time sampling**: a mod is a pure function of time; each note-on builds the voice from `patch +
    offsets(t)` — no persistent nodes, every numeric param of every kind, zero cost when off. No
    within-note movement (a future "continuous" tier could add that).
  - **Time anchors**: **Loop Mod OFF** (default) = *elapsed* — t counts from the session's first Play
    (`engine.modEpoch`), so looped passes keep evolving. **Loop Mod ON** = *ruler* — t = the note's
    absolute timeline position (`note.rulerBeat`), so every pass is identical. **Loop Mod is ONE GLOBAL
    toggle** (a `tbtn` by the ↻ loop button, `state.modLoop`; the resolver overrides every mod's `loop`
    flag). A **transport clock** (`mm:ss.hh`, left of Undo) shows the clock the mods read while tiles
    play (elapsed, or the pass's ruler time under Loop Mod), else the parked playhead's position.
    *Deferred:* a "Scale Mod Rate to Tempo" checkbox.
  - **Walk** = interpolated **value-noise** (seeded hash points, smoothstep between): bounded, centered,
    deterministic, O(1) — the "tempered random walk"; seed = lane × slot, so walks decorrelate.
  - **Per-kind storage** (`lane.modsByKind = { kind: [mod, mod] }`, persists): each instrument kind keeps
    its own pair, intact across instrument switches. Copy/Paste patch does NOT carry mods; lane Reset
    wipes them; `normalizeModsByKind` is forward-safe.
  - Both mods on one target **add** in position space, then clamp once. Applied at the note→voice seam
    (`engine.moddedPatch`, non-destructive), so **WAV + stem exports inherit modulation automatically**;
    grid audition / ♪ Test are unmodulated (lanes only). Modal is one undo step.
- **Gain calibration (against the meter):** the master `DynamicsCompressor` is a **transparent ceiling
  limiter** (`setupLimiter`: threshold −1.5 dB, knee 0, ratio 20, attack 3 ms, release 100 ms) — idle
  below −1.5 dB, only holding peaks under 0 dBFS; the **per-voice peak** is `VOICE_PEAK 0.095`, so **0 dB
  is a lane's natural resting gain**. Same chain offline. **Level instrumentation (opt-in):**
  `window.notorollaLevels()` → `{peakL, peakR, maxDb, clips}`, `notorollaResetLevels()`, and
  `NOTO_LOG_LEVELS = true` logs each clip.
- **Finite loop with stacking**: each loop tap adds **+4 passes**, capped at **8**; the
  button shows complete repeats remaining and blanks on the last pass; auto-shutoff.
- **Queue, don't interrupt**: tapping Loop while a source is *already playing* — whether
  looping or a **one-shot still in progress** — promotes it to a loop **in place** (+4 passes)
  **without restarting**; only a stopped/other source starts fresh. (First instance of the
  general principle: transport commands queue to a boundary; only Stop interrupts immediately.)
- **Active pane** concept: exactly one of grid/tiles is active (highlighted frame +
  titlebar); the **piano roll mirrors the active pane** — grid → current pattern, tiles →
  the whole arrangement. General rule: clicking in a pane activates it. Exceptions:
  double-click a tile loads it but keeps tiles active; grab-handle drag keeps grid active.
- Roll **overlays all lanes** with per-lane colors; the **active lane shows full, others
  dim** (a *focus* signal; updates live during playback). Lanes that **aren't being heard**
  (explicitly muted, or silenced because another lane is soloed) render **hatched** — a faint
  body under a diagonal hatch (an orthogonal *audible-vs-silent* signal), so the roll always
  shows what you'll hear. Roll **auto-scrolls** to follow the playhead, and to a selected tile's
  slice.
- Live edits commit at the loop boundary (per-cycle re-read); thumbnails/roll update
  immediately, audio follows on the next pass.
- **Tiles are the commit unit ("atoms") for live tile-player edits.** During tile playback an
  edit reconciles into the *running* cycle at tile granularity (`scheduler.resync`, hooked off
  `refresh`): a tile **already playing is locked** (keeps the content it started with), while a tile
  **not yet started is taken live** — so an **appended tile plays this pass**, and an edit to a
  not-yet-started tile lands when it starts. The **cycle end follows the live arrangement** (extends
  on append, contracts on shrink), and the playhead stays in sync (its wrap reference tracks the live
  length). Each note carries its `tileStart`, which is the lock boundary; already-scheduled notes
  (within the ~100 ms lookahead) are the irreducible exception. **Grid playback** has no tiles, so its
  commit unit is the **whole-pattern loop** (changes land at the next cycle boundary, as before).

### Layout
- Four reorderable panes (Grid, Tile player, Piano roll, Edit instrument); order persists.
  Default order Grid → Tile player → Roll → Edit instrument.
- Several unwanted-scroll defects were fixed here (pane-drag stale reference, instrument-pane yank,
  end-of-play jump-to-top) — the standing rule is in the Gotchas section; the fixes are archived.
- **Floating windows** (Tile Inspector, Patch Catalog, the Keyboard visualizer) are `panel.js`
  tenants — draggable/resizable, geometry+open persisted as a **workspace pref**. They share a
  **click-to-front** z-order (pressing one lifts it above the others). `panel.js` is doc-agnostic so
  a window can later be adopted into a popped-out browser window without a second implementation.

### Visualizer — the HEX keyboard (future_directions §22)  (2026-07-11)
- **Phase 1 shipped.** A **⬡ Keyboard** button in the transport bar summons a floating window drawing
  an **isomorphic hex keyboard** (Harmonic Table). As the sequence plays, cells **light up in lockstep
  with the sound** — the tap is on the scheduler (`onNoteVisual`), stamped with each note's audio-clock
  time, so lighting is **scheduled, not FFT-reactive**. A note holds for its gate + a short decay glow;
  colour = lane colour, brightness = velocity. A played degree lights **every instance** on the board
  (isomorphic redundancy) at full brightness and its **octave-mates dimmer** — chords read as the
  Tonnetz's fixed triangles.
- **Tuning-general by construction.** The layout is `degree = base + q·x + r·y` in EDO steps
  ([core/hexlayout.js](src/js/core/hexlayout.js)); Harmonic Table's axes are the nearest EDO steps to
  5/4 and 3/2, so the same engine works in any tuning (12-ET → 4,7; 16-ET → 5,9). Board rebuilds on
  tuning change / resize; centres on the degree nearest middle C. Layouts are **data presets** —
  "lots of modes" is designed-for (Wicki-Hayden/Bosanquet/etc. are future data rows, not new code).
- **CPU-lite.** Empty board pre-rendered once to an offscreen canvas; per frame just blits it + fills
  the lit hexes (Canvas 2D, no WebGL/WASM). The rAF loop runs **only while the window is open AND
  something is animating** — closed or idle costs nothing. Respects the "decorative, never blocking"
  and workspace-pref rules (§22). Verified headlessly (`notch/hexlayout.mjs` + a stubbed render smoke
  test): geometry, triad-triangle adjacency, exact-vs-octave indexing, pixel→cell round-trip, and the
  scheduled light/decay/prune lifecycle.
- **Deferred (phases 2/3 + beyond):** pop-out into a separate browser window (`window.open`, portable —
  **no** Chromium-only Document-PiP, a hard project rule) and Fullscreen (`requestFullscreen`), both
  "re-parent the same canvas". A **mode picker** once more layouts land. The **same geometry** can later
  become a click/tap **input** surface (`cellAt` already inverts pixel→degree) — tap-to-trigger works
  with today's fire-and-forget voice; a *sustaining* hex keyboard waits on the deferred noteOn/noteOff
  voice API (the same piece live MIDI needs). Mixed-tuning arrangements light by raw degree on the
  current tuning's board (fine for the common single-tuning case; a known edge, like the roll's).
- **No-equave tunings (the cross) handled.** The board is labelled by pitch class, but the cross has
  none — so cell labels go through `pitchClassLabel` (returns `''`, no home tint), and octave-mate
  lighting is skipped (there are no octaves). The board still lights the exact degrees, just
  unlabelled. `notch/vizcross.mjs`. (Was mislabelling as "undefined-2 −13" before the gate.)
- **Per-kind scene modifier (§22 "scenes mirror instrument kinds"), first tenant Boshwick.**  (2026-07-11)
  Two visual **layers that never compete**: pitch owns the hex **faces** (the good part, untouched);
  percussion owns the **edges between keys**. A drum hit lights a **sparse few** (≤3) of the lattice
  edges — thin glowing filaments in the gaps — chosen by region on the **radius = frequency** axis:
  **kick** near the centre, **hat/cymbal** at the rim (hat = 1 edge closed / 3 + longer when open;
  cymbal = a longer rim wash), **snare** across the mid band, **clap** a scatter, **cowbell/rim/clave** a
  fixed accent edge each. **Tom** is the pitched **hybrid** exception — it rides its real pitch face
  like a melodic voice. Routing is a pure `sceneForNote` (`notch/vizscene.mjs`); edge zones derive from
  the geometry's `edges`/`ring` (`notch/hexlayout.mjs`); the drum `type` rides the `onNoteVisual` tap.
  All Canvas-2D, no new cost. Verified end-to-end with a stubbed-canvas smoke (kick → ≤3 centre edges,
  no faces; hat → a rim edge; tom(67) / melodic(67) → the off-centre pitch face, no edges). *(Superseded
  the first attempt's zone-FILLS, which flooded the board and drowned the pitch view.)* **Deferred
  flourishes:** blend a pitched drum's anchor toward its pitch face by `pitchTrack` (the event already
  carries it); edge **orientation** or edges-near-active-pitch as alternate selectors.

### Keyboard shortcuts
- Act on the **active pane** (grid or tiles); ignored while a form field (input/textarea/select)
  is focused.
- **Each shortcut flashes the button it maps to** (`flash()` adds a `.flash` glow pulse) — undo/
  redo, tile delete, transpose ↑/↓. Shortcuts with no on-screen control (Select All/None, Esc,
  grid Delete-to-rest) simply don't flash. Reusable helper so future shortcuts follow the rule.
- **Ctrl/⌘-Z** undo, **Shift-Ctrl/⌘-Z** redo — per-pattern in the grid, arrangement-level in tiles.
- **Ctrl/⌘-A** Select All — grid: all notes (tiles are single-select, so no-op there).
- **Ctrl/⌘-D** Select None (and **Esc** still does this) — grid: clear note selection; tiles:
  deselect the tile.
- **Delete / Backspace** — grid: turn the selected notes into rests (one undo entry); tiles:
  delete the selected tile.
- **↑ / ↓** (grid) transpose by one **scale-mask step** (chromatic mask = a semitone); **Shift+↑/↓**
  by a literal octave (selection, or all notes).
- **Space** play/stop the active pane; **Shift+Space** start/extend the loop (plain Space stops it).
  Space is **transport-only** — it never activates a focused button or select (the handler runs
  ahead of the default and `preventDefault`s).

### Triadulator — "corrupt dodecaphony into tonality"
- Proposes chords built from the pitch classes **not yet used** on the grid — the harmonic
  *negative space* of your row — and lays them out as **prospective** (un-set) notes following
  what you've placed.
- **Chord families (two toggles, `trad` + `sus`, one or both):** `trad` = the four traditional
  triads (maj/min/dim/aug, **default on**); `sus` = suspended chords (**default off**). sus2 and
  sus4 are the **same pc-set** `{0,2,7}` (sus4 is an inversion), so one template covers both and
  every sus set is named by its **sus2 root**; sus sets are **disjoint** from every trad set (no
  third), so the families union cleanly. **Combinatorial caveat:** partial trad+sus makes many more
  3-pc subsets qualify → far more alternatives; `MAX_RESULTS = 200` caps the search (extras beyond
  200 truncated, deterministic).
- **Engine** ([src/js/core/triads.js](src/js/core/triads.js)) is pure and works on pitch-class **sets**, so
  all **inversions** are inherent ({0,4,7}={4,7,0}=C major). `chordsFor(edo, families)` makes the
  candidate pool (templates tagged by EDO); `enumerateTriadulations(pcs, {proper, families, edo})` returns
  a deterministic, stable list (proper/best first); rotation is just an index into it. The recursive search
  is unchanged — only the candidate pool (the membership test) changes with the EDO + enabled families.
  **Families are per-tuning** (12-ET: `trad`+`sus`; 16-ET: `septimal` = 4:5:7 `[0,5,13]` + supermajor
  `[0,6,13]`, built on the strong 7/4 since there's no good fifth): the toolbar's family toggles are rebuilt
  from `familiesFor(edo)` when the tuning changes (`state.families` is a per-id enabled map); the labeler
  recognizes every family the tuning offers, with hex roots in 16-ET.
- **Proper** (toggle on) = every remaining pc covered by disjoint chords (possible only
  when distinct used pcs ∈ {3,6,9} **and** a partition exists — divisibility is necessary,
  not sufficient; all chords are 3-pc so this is unchanged by sus). **Partial** (off) = as many
  whole chords as possible + leftover.
- **Triadulate** button: enabled when ≥3 pitch classes are placed *and* a placeable
  triadulation exists. Press to show the canonical proposal (ghosted dots + dashed ring);
  press again to **rotate** through alternatives (`Triadulate 2/9`) and wrap. **Confirm**
  registers them as real notes (one undo entry, marks the project dirty). Editing the grid,
  switching patterns, or toggling Proper / trad / sus discards the proposal.
- **Placement** — horizontal: columns strictly after the last placed note (interior rests
  ignored); vertical: each note's octave chosen nearest the **centroid** of placed notes, so
  the proposal is **centered** on your register (this is where inversions become visible —
  only matters once the grid spans more than one octave). Overflow (partial only): keep
  whole triads that fit. Proposed notes are **playable** — grid playback merges them in.
- **Abstract by design**: analysis is over the pattern's pitch classes — the **tuning's EDO**
  (`edoOf(pattern.tuningId)`, threaded into the engine) regardless of grid height/width; the engine
  knows nothing about columns or octaves (the placement helper in main.js is the only grid-aware part).
- New territory — to our knowledge this exact tool hasn't been built before, so the canonical
  ordering / partial enumeration / centering heuristics are first-cut and open to tuning.

### Projects (save / load) — file format **version 1**
- A **project bar** above everything: **New Project**, **Open…**, **Save…**, plus the
  project name and a `●` unsaved indicator.
- **Two persistence layers**: localStorage is the continuous **autosave** of the working
  session; a **project file** is the explicit document. The **dirty bit** tracks divergence
  from the last Save/Load (not from localStorage), by comparing a snapshot of the **musical
  content only** (library + arrangement + tempo) — so view/layout tweaks never flip it.
- **Save…** prompts for a name (prefilled with a timestamp stem, e.g.
  `notorolla-20260615-1430`, editable) and downloads JSON. Download-only (Firefox-friendly,
  no file handle) — so every Save is a named export, not an in-place overwrite.
- **Open…** validates `format: "notorolla"`, runs `migrate()`, confirms if dirty, then
  rebuilds library/arrangement/tempo and clears undo histories.
- **New Project** reseeds a blank A + empty lanes, tempo 120; confirms only if dirty.
- A `beforeunload` guard warns **only if localStorage persistence has failed** (private mode /
  quota — `storageOK` flag set in `safeSet`). A normal reload restores the autosaved session,
  so merely-unsaved-to-file changes don't trigger a nag.
- **File envelope**: `{ format:"notorolla", version:1, savedAt, name, lib, arr, tempo }`.
  Musical only — **view/layout is deliberately excluded** (stays machine-local), deferred.
- **Compatibility rule**: load runs a `migrate()` chain keyed on `version`; adding optional
  fields is backward-safe automatically; newer-than-app files warn but still attempt to load.

### Export to MIDI
- **Export MIDI** (in the Tile-player controls) writes the arrangement as a **Standard MIDI
  File** ([src/js/export/midi.js](src/js/export/midi.js), pure). Our pitches are already MIDI note numbers and
  beats are quarter notes, so the mapping is direct; **480 ticks/quarter** keeps every event
  on an integer tick.
- **Format 1**, one named track per non-empty lane (`Lane 1`/`Lane 2`), each on its own
  channel; a single tempo meta (current BPM) on the first track. One pass, as written (no
  loop repeats). No CC/program-change — assign instruments in the DAW.
- Note lengths are **articulated** (per-column `artDur`), so the export **matches what you hear**.
  Filename defaults to the project name (or a timestamp) + `.mid`.

**Microtonal MIDI export is deferred and unbuilt** — the design discussion moved to
[future_directions.md](future_directions.md) §17 (MIDI and microtonal export). Today's exporter
is correct only for `edo === 12`; a non-12-ET piece currently exports transposed/compressed
gibberish (degree ≠ MIDI note off 12).

### Export to audio (WAV)
- Two buttons (2026-07-08): **Quick Export** — one-click whole-project mixdown at defaults — and
  **Export Audio…** — the same but via an **options dialog** (rate / range / tail). Both render the
  arrangement to a **stereo WAV** (16-bit PCM) via a faster-than-realtime **offline bounce**,
  `engine.renderToBuffer(notes, durationSec, sampleRate)`, which builds an `OfflineAudioContext`
  mirroring the live master + compressor and the **same context-parametric `buildVoice`** (per-lane
  patch + mix + chorus + delay + reverb). One pass, **mute/solo respected**, **articulation applied**,
  plus a **release tail** so notes ring out. `encodeWav` ([src/js/export/wav.js](src/js/export/wav.js)) → bytes. The
  mixdown **always begins at time 0** (plain WAV, no BWF metadata — a mixdown has no offset to store).
  An **indeterminate** "Rendering…" bar (no portable offline progress event in Firefox).
- **Export options** (shared with the stems dialog, `exportRangeControls` in [src/js/main.js](src/js/main.js)):
  - **Sample rate** — **48 kHz default**, or 44.1 / 96 kHz. The rate is now **caller-chosen and stamped
    into the WAV** rather than inherited from the live device (see Gotchas re the 44.1-vs-48 confusion).
  - **Range** — **Entire project** or **Between markers** (the latter offered only when the play-region
    markers actually narrow it; the dialog shows resolved start/end beat + m:ss). The region is shifted
    so its start is **file time 0**; notes triggering before the start marker are dropped.
  - **Tail (sec)** — an editable field **pre-filled with the computed default** (`computeTail()` =
    release + reverb, **ceilinged at 8 s** — `TAIL_CEILING`). Delay/feedback washes are deliberately
    **not** chased (they can ring for many seconds; a mixer rolls them off) — bump the field if wanted.
- *Deferred:* loop-count selection, finer progress.

### Export stems (BWF, per lane → zip)
- **Export Stems…** (Tile-player controls, right of Export Audio…) opens a modal — **Export Stems**
  ([src/js/ui/modal.js](src/js/ui/modal.js)) — to pick a **bus mode** plus the shared **rate / range / tail**
  options, then renders **one Broadcast Wave (BWF) per lane** and bundles them in a **zip**. Every lane
  with notes is rendered (**mute/solo ignored** — you mute in the DAW; the single-file mixdown export
  still respects it). All stems share one length (region length + tail) and one **`TimeReference`**, so
  dragging the set into Cubase/Reaper (Import at Origin) lands them **aligned**. File = `NN <Instrument>.wav`
  (lane index + kind, de-duplicated, filesystem-sanitized); archive = `<project>-stems.zip`.
- **`TimeReference`** (2026-07-08) is **0** by default (stems are their own clip starting at zero). With
  a **Between-markers** range starting past beat 0, a **"Treat Start marker as time 0"** checkbox
  (default on) governs it: **off** stamps `TimeReference` = the marker's **absolute sample offset** at
  the chosen rate, so the set re-lands at its project position on Import-at-Origin.
- **Bus modes** (`engine.renderStem(notes, durSec, laneId, busMode, sampleRate)`, [src/js/audio/audio.js](src/js/audio/audio.js) —
  a per-lane sibling of `renderToBuffer`):
  - **`dry`** (default) — voice straight to output: no volume/pan/chorus/delay, no master limiter.
  - **`postfader`** — lane volume/pan/chorus/delay baked, master limiter **off** so stems **sum to the mix**.
  - **`baked`** — as post-fader, plus the master fader + limiter (sounds as soloed-in-mix, but the
    nonlinear limiter means stems no longer sum exactly). `masterLevel` is applied only in `baked`.
- **BWF writer** — [src/js/export/wav.js](src/js/export/wav.js) refactored to share a `pcm16Bytes` core + a `cursor`/chunk
  assembler between `encodeWav` and new **`encodeBwf(buffer, meta)`**, which inserts a 602-byte **`bext`**
  chunk (EBU Tech 3285 v1; Description / Originator=`Notorolla` / OriginationDate+Time / 64-bit
  `TimeReference`). It stays a valid WAVE — players ignoring `bext` still find `fmt `+`data`. `bext`
  fields are ASCII (non-printable → `?`).
- **Zip writer** — new [src/js/export/zip.js](src/js/export/zip.js): `zipStore([{name,bytes}], date)`, **STORE method (no
  compression)** — PCM is already uncompressed, so deflate would cost a dependency for ~nothing. Pure,
  no-deps (own CRC-32 table); writes local headers + central directory + EOCD, UTF-8 names (flag set).
- *Deferred:* loop selection; mono "pre-pan" option; a single multichannel poly-WAV alternative.

---

## Known limitations / deferred

_(Actionable parked items are in the **Deferred work / TODO** section near the top; this is the
standing list of broader gaps. Already-fixed bugs live in the archive.)_

- **Partial lane controls**: Mute/Solo, adding lanes, **reordering lanes** (drag the colour stripe),
  per-lane **gain + pan** (lane-head knobs → mixer strips), and **per-lane instrument** (with patch
  identity) are in. Still deferred: **removing** lanes (likely a right-click menu), lane **naming**, and
  a **colour picker** (the stripe carries an intrinsic per-track colour now, but it can't yet be changed).
- **No phasing**: lanes share one combined loop; independent per-lane loop lengths
  (Reich-style phasing) is a future option.
- **Interactive lane editing — partial**: drag-reorder/position within a lane, move/copy between
  lanes (with prospective ripple preview), and **adding lanes** are **in**. Still deferred:
  **removing lanes**, and **multi-tile** drags (a set of tiles, contiguous or not — the move/copy
  model is shaped to extend to a list of ids, but the gesture/multi-select that feeds it isn't built).
- **Per-tile playhead sync** (edits committing at the next tile rather than the next whole
  pass) is tied to interactive lane editing — deferred.
- One octave per grid, monophonic — by design for now (polyphony is future_directions §7).
- **Live MIDI I/O** not wired (deferred by decision; **export to .mid is built** — see Export to MIDI).
- Cursor "Glyph" mode is shaky for 3/8 and 1/2 (Unicode coverage) — **SMuFL** later.

## Conventions

- Discuss-before-implementing: play back the spec, flag tensions, ask focused questions,
  then build on "make it so."
- Comment anything non-obvious; a 1–2 line description for each non-trivial function.
- Keep the no-build / no-dependency setup unless asked otherwise.
- **Headless tests live in [notch/](notch/)** (moved in-repo from C:\tmp\notch 2026-07-04, user
  request): `node notch/run.mjs` runs every suite; tests import the live `../src` directly (the
  root `package.json` `{"type":"module"}` exists solely to make `src/*.js` ESM-resolvable to
  node — inert for the browser, no dependencies). `wasim.mjs` is the Web Audio simulator,
  `meter-bosh.mjs` a metering rig (both skipped by the runner).

---

## Purpose (from the composer)

The real goal is a **platform to experiment** — a place to apply **12-tone and other restrictive
aesthetics to pattern development**, because those constraints reliably produce **"unusual" /
"engaging"** material. (The provocation of 12-tone was avoiding tonal hierarchy; the practical value
here is the engaging textures it coughs up — and we're happy to abuse these systems for ends they
were never meant for.) Reference point: **Cubase's newer pattern editor is good but its limits are
quickly exceeded** — Notorolla exists to go past them, with analysis and generation **interactive and
visible**, not hidden behind menus.

The larger roadmap — and the concrete wants this grew from (a genuinely good arpeggiator, live
harmonic analysis, notation, more tunings) — lives in [future_directions.md](future_directions.md).

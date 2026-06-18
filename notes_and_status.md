# Notorolla — notes & status

A static-web tool for **algorithmic / pattern-based music composition**. Generates its
own sound (no audio samples), runs from plain files, no build step, no dependencies.

---

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

## Two architectural "seams" (the important bits)

- **Time is in beats**, tempo-independent, throughout the model; seconds are derived only
  at the audio layer (`Score.secondsPerBeat`). This is where generative rhythm plugs in.
- **Pitch goes through a tuning seam** ([src/tuning.js](src/tuning.js)): `degreeToFreq` /
  `degreeToName`. Today a "degree" is just a MIDI number (12-TET), but this is the one
  place microtones / alternate scales will change.

---

## File map

| File | Responsibility |
|---|---|
| [index.html](index.html) | Layout (transport bar + reorderable panes), all CSS |
| [src/model.js](src/model.js) | `Note`, `Score` (beats, tempo, articulation, explicit length), MIDI↔freq, note names, black-key test |
| [src/tuning.js](src/tuning.js) | row/degree → pitch/frequency seam |
| [src/grid.js](src/grid.js) | `Pattern` (named, 12 columns), `DURATIONS`, `PALETTE`, `COLS`, `BASE_PITCH` |
| [src/library.js](src/library.js) | `PatternLibrary` (registry, naming, parking), `Arrangement` (lanes/tiles + per-lane mute/solo + `lane.gain`/`lane.pan`/`lane.patch`, play-region `playStart`/`playEnd`, `audibleLaneIds`), `LANE_COLORS` |
| [src/audio.js](src/audio.js) | `AudioEngine` — additive synth voice (`buildVoice`, context-parametric), per-lane patch resolution (`patchFor`), per-lane **stereo mixer strips** (volume→panner→**delay insert**→mute-gate; `setLaneVolume`/`setLaneGain`/`setLanePan`, `laneMix`, `applyLaneDelay`/`buildDelayInsert`), master limiter (`setupLimiter`) + fader (`setMasterGain`) + **stereo meter tap** (`getPeak`→`{l,r}`); `renderToBuffer` (offline **stereo** bounce, per-lane patch+mix+delay) |
| [src/instrument.js](src/instrument.js) | the **Vesperia** patch: `DEFAULT_PATCH`, `PARAMS` (editor metadata), slider mapping, `normalizePatch`, `clonePatch` |
| [src/instrumentpane.js](src/instrumentpane.js) | `buildInstrumentPane` — the retargetable "Edit instrument" pane (grouped sliders, target chip, Test, Copy/Paste, Factory Reset) |
| [src/knob.js](src/knob.js) | `makeKnob` — click-vertical-drag rotary widget (detents, dbl-click reset, gesture-bracketed callbacks) + `PAN_MAP` / `GAIN_MAP` mixer mappings |
| [src/delay.js](src/delay.js) | per-lane delay config (`defaultDelay`/`normalizeDelay`, `DELAY_TIMES`/`DELAY_MODES`) + `buildDelayEditor` (modal form) |
| [src/modal.js](src/modal.js) | `openModal` — generic centered modal (Esc / backdrop / × to close, `onClose`) |
| [src/scheduler.js](src/scheduler.js) | lookahead scheduler, finite looping, per-cycle re-read (`onCycle`), mid-cycle tile reconciliation (`resync`) |
| [src/pianoroll.js](src/pianoroll.js) | `PianoRoll` canvas render + playhead; per-note color/alpha |
| [src/gridview.js](src/gridview.js) | `GridView` — grid editor (render + gestures + viewport + resize) |
| [src/tileplayer.js](src/tileplayer.js) | `TilePlayer` — multi-lane tile rendering + interaction; lane heads (instrument/Edit, Pan/Gain knobs, M/S); beat **ruler + play-region markers** (`_buildRuler`/`drawRuler`) |
| [src/toolbar.js](src/toolbar.js) | grid toolbar (brush, pattern lifecycle, view toggles) |
| [src/panes.js](src/panes.js) | reorderable vertical panes, order persisted |
| [src/project.js](src/project.js) | versioned file envelope (`format`/`version`), migrate, save (download) / load (file read) helpers |
| [src/triads.js](src/triads.js) | Triadulator engine (pure): partition a pitch-class set into chords — `trad` (maj/min/dim/aug) and/or `sus` families (proper / partial); `classifyTriad` for labels |
| [src/midi.js](src/midi.js) | Standard MIDI File writer (pure): note data → bytes (Format 1, tempo, track names) |
| [src/wav.js](src/wav.js) | WAV encoder (pure): an `AudioBuffer` → 16-bit PCM RIFF bytes |
| [src/main.js](src/main.js) | wires everything; transport, undo, active pane, persistence, project save/load |

---

## What works today

### Sound — the Vesperia (per-lane editable instrument)
- Additive synth voice: ~6 sine partials, slight inharmonicity, an **ADSR** amplitude
  envelope + a **resonant lowpass** with its own envelope and keyboard tracking. Conservative
  per-voice level (`VOICE_PEAK`) into a transparent **master limiter** (see Transport & roll).
  Default articulation ~0.88 (slightly detached / non-legato).
- The voice's parameters live in a **patch** struct ([src/instrument.js](src/instrument.js))
  the engine reads **at every note-on**, so edits are heard on the next note with no
  re-wiring. The instrument is the **Vesperia** (the one synth model so far); the
  struct/`PARAMS` are shaped so a future registry of named instruments is a lookup, not a
  rewrite.
- **Patches are now per lane.** Each arrangement lane owns its own `lane.patch` (the engine
  resolves a voice's patch via `engine.patchFor(laneId)` → that lane's patch). New lanes start
  from the **factory preset**. Un-laned sound (grid click-to-hear / ♪ Test on the grid) uses a
  **separate neutral grid patch** — a workspace preference, *not* part of the project.
- **Edit instrument pane** ([src/instrumentpane.js](src/instrumentpane.js), below the roll —
  an editor panel, *not* a transport pane: it doesn't touch the active-pane or shortcut
  routing). It edits **one target patch at a time**, retargetable: focusing the **grid** pane
  loads the neutral grid patch; a lane's **Edit** button (lane header, left of M/S) loads that
  lane's patch (and scrolls the pane into view). A color-swatch chip in the header shows which
  target is being edited ("Grid" / "Lane N"). **Copy / Paste** ferry settings between targets
  (in-memory clipboard, session only). Grouped sliders:
  - **Amp Envelope** — Attack / Decay / **Sustain** / Release. It's a true ADSR; **Sustain 0
    reproduces the old struck-string decay-to-silence** (Decay = the old ring time-constant),
    and Sustain > 0 holds the note (pad/organ territory).
  - **Timbre** — one slider: a spectral tilt over the fixed partial mix (`k^e`), **0.5 =
    neutral (the old mix exactly)**, left darkens (upper partials attenuated), right brightens.
  - **Filter** — **Cutoff**, **Resonance** (Q), **Env Amount** (octaves the filter envelope
    opens cutoff above base at the attack, then settles) and **Key Track** (0 = fixed Hz,
    1 = cutoff fully follows pitch). All native Web Audio `BiquadFilter` — no WASM.
  - **♪ Test** auditions a mid-register note through the **current target** patch (a lane
    target plays through that lane's bus, so M/S apply); **Factory Reset** restores the target
    to the defaults that *are* the original sound.
- **Defaults reproduce the prior sound** in the central register (e.g. A4's filter sweep is
  identical, 1760 → 4842 Hz). The one intentional difference: the old per-note cutoff *floors/
  ceilings* (guard clamps) are gone, replaced by continuous Key Track — so the bass can now
  open darker and the treble brighter than the old fixed clamps allowed.
- **Patch persistence:**
  - **Lane patches** ride the arrangement (autosave `notorolla.arr` + the project file via
    `Arrangement.toJSON`/`fromJSON`) and **count as musical content** — editing one marks the
    project dirty. They are *not* part of the tile **undo/redo** stack, though: `arrApply`
    carries each lane's *live* patch across by id, so undoing a tile move never reverts a sound
    edit (and a lane reappearing on a redo takes its snapshot patch).
  - **Grid/neutral patch**: `notorolla.gridpatch` (localStorage only, a workspace preference —
    not in the project, not dirty-tracked).
  - **Migration**: the old single global patch (`notorolla.patch`) seeds any patch-less lane on
    first load, so existing projects reload sounding identical; the saved dirty baseline absorbs
    the auto-added patches so the silent upgrade doesn't flag the project dirty. The
    `notorolla.patch` key is vestigial afterward.

### Grid editor (one pattern at a time)
- **12 columns** (time) × resizable pitch rows (one chromatic octave by default, C4 at
  bottom). Notes stored by **absolute degree**, so resizing/scrolling never loses notes.
- Mono mode (one note/rest per column). Gestures: click a note = if the brush duration differs,
  **adopt the brush duration first**, else **rotate** to the next duration (beats order); click a
  rest = place; click a different row = repitch; **click-drag is axis-locked** (decided on first
  movement, never diagonal) — **vertical** repitches the column's note, **horizontal** swaps this
  column with the column dragged onto (a clean two-cell exchange); shift-click = accent;
  right-click = note↔rest.
- Duration brushes {1/16, 1/8, 1/4, 3/8, 1/2} (shown shortest→longest; 1/16 is stored at the end
  of `DURATIONS` so old `durIndex` values don't shift). Color = a **chilled spectrum** by duration
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
- **Pitch context (tuning + scale mask) — microtonal Stage 1**: each pattern carries a
  **tuning** (`12-ET` or `Just (5-limit)`), a **scale mask** (Chromatic / Major- / Minor-
  pentatonic) and a **root** (toolbar "Pitch" selectors). All Stage 1 tunings stay on the
  **12-degree grid**, so every tool (incl. the Triadulator) keeps working; the tuning only
  changes how degrees *sound* (`tuningFreq` resolves each note per its pattern — just intervals
  fan out from the root, which stays at its 12-ET pitch). The scale mask **highlights in-scale
  rows** (faint blue) and **snaps** placement/drag to in-scale degrees. So "ET pentatonic" =
  pentatonic mask over 12-ET; "just pentatonic" = the same mask over the JI tuning. The **root
  (tonic)** is marked with a gold left-edge stripe + bold label on the grid — shown only when it
  matters (a just tuning or non-chromatic mask; plain 12-ET chromatic has no tonic). Selectors
  carry 1–2 sentence explainer tooltips. *(Future: a global concert-pitch / reference control —
  A440 vs C256 — would let 12-ET mark its reference note too.)* Per-pattern
  tuning/scale/root persist (localStorage + project file; older data defaults to 12-ET/chromatic
  — optional fields, no version break). Audio resolves frequency **per note's pattern**, so an
  arrangement with mixed-tuning tiles plays correctly — and (**Stage 2**) the **piano roll plots
  by true pitch in cents** so mixed/microtonal notes land at their real height instead of
  overlapping. The roll keeps a fixed **12-ET reference ruler** as the backdrop and 12-ET notes
  map pixel-identically (`yForCents`, `FREF = noteToFreq(0)` so pitch p == 100·p cents); offsets
  are at true scale (a just third ≈ 2.5px below ET). *Deferred (later stages):* true size ≠ 12
  scales (no-octave, lattices, the viewport rework), a vertical **roll zoom** to enlarge cents
  differences, **accurate microtonal MIDI export** (still nearest-12-ET), a **C256** reference
  option, and the **ratio-based "triad definer"** (the Triadulator stays pc-set / 12-degree).
- **Permute tools** (toolbar group after Triadulate), acting on the **selection — or all notes
  if nothing is selected** (`grid.permuteCount`/`_permuteTargets`), *among their own columns* —
  positions/halos stay put, whole notes (pitch + duration + accent) move, enabled at ≥2 notes,
  undoable, chainable:
  - **⟳ Rotate** — cycle one position right (rightmost wraps to leftmost's column). (⟳ chosen
    distinct from the transport's ↻; loop-symbol cleanup pending.)
  - **⇄ Reverse** — reverse the note order (retrograde).
  - **▁▃▅▇ / ▇▅▃▁ Sort** — reorder by pitch ascending / descending (stable on ties).
  - **▃▇▇▅▁ Shuffle** — random permutation, re-rolled to differ from the current arrangement
    when possible (a swap for two notes). May place identical pitches adjacent (its glyph shows
    two equal bars touching).
  - **▇▃▇▅▁ Shuffle (no consecutive repeats)** — same heights, none adjacent in the glyph.
    Randomizes so no two adjacent notes share a pitch when feasible, and with the **fewest**
    unavoidable repeats when a pitch dominates (> ½ the selection). **Constructive, no rejection
    looping**: greedy "deal from the largest remaining pitch-pool that isn't the one just placed,
    random among ties," + a random end-for-end flip to de-bias. Verified optimal (0 when feasible,
    theoretical min otherwise).
- **Mutate tools** (toolbar group after Permute; same selection-or-all targets): **↑ / ↓
  Transpose** — **scalar/diatonic**: each note moves to the next degree **in the active scale mask**
  (`transposeScalar` → `stepInScale`). Under the **Chromatic** mask that's the old ±1 semitone;
  under **pentatonic** it steps to the next scale tone (skipping non-mask degrees), each note moving
  independently so intervals follow the scale, and an off-scale note snaps onto the mask in the move
  direction. No chromatic nudge *within* a mask (switch to the Chromatic mask for that — consistent
  with placement already snapping to the mask). Arrow keys ↑/↓ do the same; **Shift+↑/↓ = a literal
  octave** (the equave — currently always the 12-degree octave; the "disable when a tuning has no
  equave" gate waits on non-octave scales). No-op if it would leave the navigable range; undoable;
  grid-only.
  - *Planned permute tools (design open):* **Invert** — needs a chosen axis/pivot to mirror
    pitches around (first/selected note? the centroid? a fixed degree?), TBD. **Transpose** —
    the composer wants it *smarter than "move up/down N"*; e.g. a **"smart transpose / harmonize"**
    that detects whether adjacent notes form a triad and moves each to the **next chord tone** of
    that triad (so transposition follows the harmony, not a fixed interval). Both wait on those
    decisions; once the **ratio-based triad definer** exists, "harmonize" composes naturally with it.
- Two views: **Grid** (uniform columns) and **Stretch** (width ∝ duration, aligned to the
  roll). Active rows highlight; **octave-mates highlight softly**.
- **Triad labels** ("Show triads" toggle, default on): every run of **three adjacent notes**
  (no rest between) is classified via `classifyTriad` (reuses the Triadulator templates, **12-ET
  only**) and, if it's a recognized chord, labeled (`C Maj` / `A min` / `G dim` / `E aug` / `C sus`
  — root + quality, inversion-agnostic) in a band **above the grid**, centered on the middle note,
  packed across **two staggered rows** so neighbours (arpeggios / Stretch / future 16ths) don't
  collide. **`sus` is always recognized** (sus2 / sus4 are the same pc-set `{0,2,7}` — named by the
  sus2 root; disjoint from the trad sets). Root name via a `pitchClassName` seam (12-ET note names
  now). The scanner is structured for later **liberalized triads / tetrads / other shapes** (window
  size + pc-set templates). **Now labels the Triadulator's prospective (ghost) notes too**
  (`_labelColumns` merges `prospective` into the scan), so proposed chords get labeled live.
- Vertical **resize** (drag handle, min 12 rows) + **wheel scroll** of pitch range, with a
  fixed-position dashed resize guide.
- **Opening a pattern auto-centers the pitch viewport** on its notes (`centerGridOn`: midpoint of
  the note span, clamped to the navigable C1..C8 range), so a pattern a couple octaves away doesn't
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
- **Clear** is destructive (empties the current pattern in place → empties referencing
  tiles); tucked away, confirms when referenced.
- **Undo/redo is per-pattern**; the tile lane has its own append/delete undo.

### Tile player (the arrangement)
- **Parallel lanes** — **2 by default**, and you can **add more** via a thin "+" row at the bottom
  of the lane stack (`addLane`; new lane is empty and becomes active; undoable, persisted; New
  Project resets to 2). No hard cap. Lane colors are auto-assigned (`laneColor`: the established
  blue/orange first, then golden-angle HSL hues). *Removing* lanes is deferred (likely a right-click
  menu later). Each lane is an ordered set of positioned tile references.
- Drag the grid's **grab handle** into a lane to drop a tile (a width-proportional
  thumbnail; note bars colored by duration; bordered in lane color; name centered).
- Both lanes share **one horizontal time axis** (a single scale `tilePlayer.ppb`, one shared
  scroll, common origin), so tiles **align in time** across lanes. Tiles are **freely positioned**:
  each carries an explicit **`start` beat** (snapped to the 1/4-note grid = integer beats), so gaps
  (silence) between tiles are allowed. Faint **beat ticks + bar lines** in the track show the snap.
- **Adjustable horizontal scale**: a strip below the lanes — `[−] [slider] [+]`, **smaller ←→
  bigger**, quantized to notches (`TILE_SCALES = [4,6,9,13,19,28,40]` px/beat; the old fixed 6
  sits near the low end, the rest is zoom-in headroom). Slider snaps to notches, −/+ step one
  notch (disabled at the ends). Zoom keeps the left-edge beat roughly in place (scroll scales
  with it). **View-only** — persists in `notorolla.ui` (`tileScaleIdx`), never flips the dirty bit.
- Each lane has a **sticky header block** (stays pinned during horizontal scroll): a color
  stripe + an **instrument block** (the **Vesperia** name — a label now, the future instrument
  selector — over an **Edit** button that opens the per-lane instrument editor) + a **"D" delay
  button** (lit when the lane's delay is on; opens the delay modal) + a **knob column**
  (**Pan** over **Gain**) + the **Mute / Solo** stack. The knobs are mixer-style: click +
  **vertical-drag** to turn (Shift = fine, **double-click = reset**); Pan has a center detent, Gain is
  a **dB knob** (−∞…+6 dB, unity detent at 0 dB) storing linear gain. A knob drag is **one undo step**
  (bracketed on release). Room remains for future per-lane controls (naming, add/remove).
  M/S are a **per-lane tri-state** {none | muted | soloed} — turning one
  on clears the other for that lane; across lanes there's no exclusivity (mute both, solo both,
  etc. all fine). Audible rule: **solo wins globally** — if any lane is soloed, only soloed lanes
  sound; otherwise every non-muted lane sounds. M/S **save with the project and restore on load**
  (it reloads sounding exactly as saved; New Project resets them), so they're part of the content
  snapshot → toggling one marks the project dirty, and it's an **undoable arrangement edit** (rides
  tile Undo/Redo).
- **M/S act in real time (a per-lane gain bus).** Each lane's voices route through its own
  `GainNode` (a tiny mixer in [src/audio.js](src/audio.js): `laneBus`/`setLaneGain`, voices via
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
- Click = select; double-click = open the pattern in the editor (keeps tiles active +
  selected); Delete (button or key) removes; each lane has its own drop zone.
- **Drag to position / move / copy** (pointer-based; a small movement threshold distinguishes
  a drag from a click/double-click). The dragged tile lands at the **snapped drop beat**, clamped so
  it can't overlap the anchored left neighbor. Positioning and ripple are **one rigid operation**:
  tiles to the right shift right by a **single amount** = just enough to clear the dropped tile —
  **0 when it already fits** (free positioning, gaps preserved) — and that shift **preserves the
  gaps among the right-side tiles**. So there's no overlap and **no invalid/rejected drop**; only
  dropping *off* the lanes cancels. Drag all the way left → contiguous; mid-gap → silence/offset on
  the left is kept. **Shift = a shallow copy** ("+" badge on the ghost); no modifier = move (keeps
  the id). **Removing** a tile (Delete, or moving it *out* to the other lane) rigid-ripples
  everything to its right **left** by the tile's length; **repositioning within a lane** just lifts
  and re-places (no source ripple-close, so dropping back where it started is a true no-op). Each
  real change is one undo step; afterward the tile is selected and its lane active. (`moveTile` /
  `copyTile` / `removeRipple` in [library.js](src/library.js), via the shared `rippleInsertInto` /
  `rippleRemoveFrom` primitives.)
- **Prospective preview while dragging** (DAW-style): the lanes show the *result* of the
  ripple — the rigid shift applied, a dashed **slot** at the dropped tile's snapped spot — computed
  by running the **same ripple ops on a throwaway copy** (so preview == commit), FLIP-animated,
  while a floating **ghost** follows the cursor. Crucially this preview is **visual only**: audio,
  the roll, and the playhead keep playing the **committed** layout (the preview "is not what's
  playing"). During an active drag the green "playing" badge is suppressed (the playhead still runs)
  so it doesn't mark a hypothetical slot. **Editing while playing is fully supported** — the drag
  never touches the committed model until drop; a committed change's audio lands at the next tile
  boundary / loop per the reconciliation, visual is immediate.
- The **grab-handle drop** (a new tile from the grid) **appends flush** — as far left as possible
  (right after the lane's last tile, snapped up to the next beat; beat 0 if empty); reposition later
  by dragging. Old gapless projects migrate by deriving each tile's `start` from the cumulative order
  (`ensureTileStarts`), so they open identically.
- **Active lane** (highlighted) set on drop / select / empty-lane click.
- **Playhead**: during tile playback a vertical line sweeps each lane track at the current beat
  (one `.tile-playhead` per track, positioned track-relative so it scrolls with the tiles and aligns
  across lanes; `tilePlayer.setPlayhead(beat)` from the render loop). It marks **real playback
  position** — shown even mid-drag (when the green "playing" badge is suppressed). The lanes
  auto-scroll to follow it (`ensureTileVisible`, not scrolling it behind the sticky lane header).
- **Beat ruler + play-region markers** (sticky strip on top of the lanes; `_buildRuler`/`drawRuler`).
  Marked in **0-based beat numbers** (so a ruler number = a tile's `start` beat) with minor ticks
  every beat and major ticks/numbers every 4 beats (widened at low zoom so labels don't collide).
  It's a row in the same horizontal scroller — a left **spacer matching the (now fixed-width)
  lane head** + a ruler track sharing the tiles' width/origin — so beats align and it scrolls in
  sync. **A play/loop region:** a **start marker (always present, default beat 0)** and an
  **optional end marker** (`arrangement.playStart` / `playEnd`; `playEnd: null` = "end of the last
  tile", so it follows the arrangement as it grows). **Left-drag moves either marker** (grab the
  handle under the cursor — drag the end handle in from the content end to set an end — or an
  empty-ruler click moves the start); **right-click clears the end marker** (back to auto), and
  dragging the end to/past the content end also clears it. Context menu suppressed; both snap to the
  beat grid. Faint dashed guide lines (green/red) mark the
  bounds through every track, with a tint band on the ruler. **Both Play and Loop honor [start, end)**:
  the tile-playback provider (`windowedArrangementScore`) windows the arrangement score to the region
  — notes triggering in `[start, end)`, shifted so the region begins at beat 0, cycle length =
  region length — so the **scheduler/resync logic is unchanged** (it just sees a shorter score); the
  render loop adds `playStart` back for the absolute playhead/highlight/scroll. Default markers
  (0 … arrangement end) = the whole thing, identical to before. Markers **save with the project**
  (in `Arrangement.toJSON`, dirty-tracked) and are **undoable** (shared arrangement-edit bracket with
  the mixer knobs; `arrApply` restores them); **New Project resets** to start 0 / end auto. Marker
  edits land at the **next loop boundary** (provider re-read), not mid-cycle. **Export still renders
  the whole arrangement** (a "just the marked section" mode is a deferred follow-up). A plain
  click-to-scrub on the ruler is intentionally forgone in favor of marker-setting.

### Transport & roll
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
- **Stereo signal path:** each lane runs `voices → volume → StereoPanner → [delay insert] → mute-gate
  → master` (pan is BEFORE the delay so ping-pong's hard-L/R isn't re-panned; the mute gate is LAST so
  mute is instant yet the delay keeps running while muted and unmute reveals its tail). master +
  limiter are channel-agnostic, so the tail is stereo once panners feed it; the offline export is
  `OfflineAudioContext(2, …)` rebuilding each lane's volume+pan+delay so the **WAV is stereo and
  matches the live mix** (`encodeWav` was already channel-general). Un-laned grid audio is mono/centered.
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
  WASM. Effects philosophy (user): delay = per-track; chorus/phaser/drive = future instrument-patch
  character; reverb = future instrument or shared send bus.
- **Gain calibration (done against the meter):** the master `DynamicsCompressor` is a **transparent
  ceiling limiter** (`setupLimiter`: threshold −1.5 dB, knee 0, ratio 20, attack 3 ms, release 100 ms)
  — idle below −1.5 dB (no always-on compression), only holding peaks under 0 dBFS; the **per-voice
  peak** is `VOICE_PEAK 0.095` (trimmed ~2.7 dB from 0.13 — "Vesperia is persistently too hot" — so
  **0 dB is a lane's natural resting gain**). Same chain in the offline export. **Level instrumentation
  (opt-in):** `window.notorollaLevels()` → `{peakL, peakR, maxDb, clips}`, `window.notorollaResetLevels()`,
  and `window.NOTO_LOG_LEVELS = true` logs each clip (throttled).
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
- **Engine** ([src/triads.js](src/triads.js)) is pure and works on pitch-class **sets**, so
  all **inversions** are inherent ({0,4,7}={4,7,0}=C major). `buildChords(families)` makes the
  candidate pool; `enumerateTriadulations(pcs, {proper, trad, sus})` returns a deterministic, stable
  list (proper/best first); rotation is just an index into it. The recursive search is unchanged —
  only the candidate pool (the membership test) grows with sus.
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
- **Abstract by design**: analysis is always over the 12 chromatic pitch classes
  (`DEGREES_PER_OCTAVE`) regardless of grid height/width; the engine knows nothing about
  columns or octaves (the placement helper in main.js is the only grid-aware part).
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
  File** ([src/midi.js](src/midi.js), pure). Our pitches are already MIDI note numbers and
  beats are quarter notes, so the mapping is direct; **480 ticks/quarter** keeps every event
  on an integer tick.
- **Format 1**, one named track per non-empty lane (`Lane 1`/`Lane 2`), each on its own
  channel; a single tempo meta (current BPM) on the first track. One pass, as written (no
  loop repeats). No CC/program-change — assign instruments in the DAW.
- Note lengths are **articulated (×articulation, 0.88)** — a deliberate detached feel. Now
  that playback also applies articulation (fixed), the export **matches what you hear**.
  Filename defaults to the project name (or a timestamp) + `.mid`.

### Export to audio (WAV)
- **Export Audio** (Tile-player controls, right of Export MIDI) renders the whole arrangement to a
  **WAV** (16-bit PCM, mono) — a faster-than-realtime **offline bounce** of the Vesperia. One pass,
  **mute/solo respected** (silenced notes skipped), **articulation applied**, plus a **release tail**
  so notes ring out. Filename defaults to the project name (or timestamp) + `.wav`.
- **How:** `engine.renderToBuffer(notes, durationSec)` builds an `OfflineAudioContext` (mirroring the
  live master gain + compressor) and renders the notes through the **context-parametric `buildVoice`**
  — the same synth code the live engine uses (the refactor that also serves a future per-lane voice /
  effects work). `encodeWav` ([src/wav.js](src/wav.js)) turns the `AudioBuffer` into bytes; download
  via the existing `downloadBytes`. Works without the live audio context running (uses its sample
  rate if present, else 44.1 kHz).
- **Progress:** an **indeterminate** "Rendering…" bar (the button shows "Rendering…", disabled).
  Offline rendering has no portable progress event — `OfflineAudioContext.suspend()` (which could
  drive a determinate bar) isn't supported in Firefox, the primary browser — so an honest busy
  indicator is used. Render is fast (faster than realtime) for one pass anyway.
- *Deferred:* loop-count / range selection (one pass only), stereo, finer progress.

---

## Known limitations / deferred

- ~~BUG — articulation not applied in playback~~ **FIXED**: the scheduler now shortens each
  note to `note.duration * articulation * spb` (captured per cycle in `_beginCycle`), so the
  "slightly non-legato" default is actually audible — and MIDI export (which also applies
  ×articulation) matches playback.

- **Partial lane controls**: **Mute / Solo** and **adding lanes** are in. Still deferred:
  **removing** lanes (likely a right-click menu), volume, naming, per-lane instrument.
- **No phasing**: lanes share one combined loop; independent per-lane loop lengths
  (Reich-style phasing) is a future option.
- **Interactive lane editing — partial**: drag-reorder/position within a lane, move/copy between
  lanes (with prospective ripple preview), and **adding lanes** are **in**. Still deferred:
  **removing lanes**, and **multi-tile** drags (a set of tiles, contiguous or not — the move/copy
  model is shaped to extend to a list of ids, but the gesture/multi-select that feeds it isn't built).
- **Per-tile playhead sync** (edits committing at the next tile rather than the next whole
  pass) is tied to interactive lane editing — deferred.
- One octave per grid by default; **microtones / alternate scales** not built (the tuning
  seam is ready for them).
- **Save / pattern browser** not built; localStorage is a stand-in.
- **MIDI** not wired.
- Cursor "Glyph" mode is shaky for 3/8 and 1/2 (Unicode coverage) — **SMuFL** later.

## Potential directions

- Lane/channel controls; more lanes; mute/solo; per-lane or per-tile attributes.
- Phasing / independent loop lengths.
- Interactive lane editing (reorder, insert, drag between lanes) + per-tile commit/sync.
- Save & a pattern browser (supersedes the parked-slot convenience and orphan-naming).
- Microtones / scales via the tuning seam; taller / multi-octave grids.
- Generative layer: 12-tone rows/matrix (the grid is literally matrix-shaped),
  constraint/probabilistic generators feeding patterns.
- MIDI input (live audition + step entry); richer synthesis; SMuFL glyphs; eventually
  light notation.

## Conventions

- Discuss-before-implementing: play back the spec, flag tensions, ask focused questions,
  then build on "make it so."
- Comment anything non-obvious; a 1–2 line description for each non-trivial function.
- Keep the no-build / no-dependency setup unless asked otherwise.

---

## Purpose & wishlist (from the composer)

The real goal is a **platform to experiment** — a place to apply **12-tone and other
restrictive aesthetics to pattern development** because those constraints reliably produce
**"unusual" / "engaging"** material. (The original provocation of 12-tone was avoiding
tonal hierarchy — "not just unmusical garbage" — but the practical value here is the
engaging textures it coughs up. We're happy to abuse these systems for ends they were
never meant for.)

Reference point: **Cubase's newer pattern editor is good but its limits are quickly
exceeded.** Notorolla exists to go past those limits. Concrete things wanted:

- **Show which rows/pitch-classes are "used."** Cubase can't; it doesn't even take much
  imagination. *(Seeded already: the grid highlights active rows strongly and octave-mates
  softly. Natural extensions: pitch-classes "remaining" vs "spent" in a 12-tone row,
  used-count per pitch, etc.)*
- **Interactive harmonic/"naughty" analysis** that intentionally cuts against the grain of
  the source system. E.g.: *"what triads (or other chords) can I build from the notes
  remaining in this 12-tone sequence?"* — surface the available sonorities live as the row
  fills in. (Pitch-class set theory, chord/interval availability, complement sets, etc.)
- **A genuinely good arpeggiator.** Cubase has a dozen arp methods and they all feel
  "peripheral." Want arpeggiation as a **first-class, central, experimentation-friendly**
  operation, not a bolted-on effect.
- General stance: a flexible bench for trying constraint-based and generative ideas, where
  analysis and generation are **interactive and visible**, not hidden behind menus.

### How this maps to the architecture (notes for later)

- The **12×12 grid is literally a twelve-tone matrix shape** — a row is a path through it;
  the editor and any serial machinery are the same object viewed two ways.
- This analytical/generative logic should be **pure data-in/data-out** (a pattern/row in →
  highlights, chord lists, arpeggiations out), which keeps it testable and WASM-portable,
  and lets the views (grid/roll/tile player) just render the results.
- "Used rows," "remaining pitch-classes," "available triads," and arpeggiation are all
  **functions over a `Pattern` (or a set of degrees)** — they slot in alongside the
  existing highlight pipeline without touching playback/transport.

### 12-tone exercises & études (Hanon / Mikrokosmos — half-seriously)

The composer wants to author **12-tone exercises and études** in the spirit of **Hanon** and
**Mikrokosmos**: half-serious as genuine ear/technique training (adapting the ear to
post-tonal material), half-joking because *people will take anything seriously* — and the
joke is funniest if the material is actually good. **Tools to generate/author these** are
wanted. Ideas (offhand, not yet built), in rough order of leverage:

- **Serial transforms as permute tools** (drop into the existing Permute group, act on the
  selection or whole pattern): **Retrograde** (reverse order), **Invert** (mirror pitches
  about a pivot — first/selected note), **Transpose ±** (shift degrees). With Rotate/Sort/
  Shuffle already there, these complete the classic row operations *and* are generically
  useful. The 48 forms (P/I/R/RI × 12) fall out of Transpose + Invert + Retrograde.
- **Sequence / "Hanon engine"**: take a short cell and emit a sequence — repeat it N times,
  each copy transposed by a fixed interval (semitone, or a scale step) up/down the range.
  This is the core étude-spinner; could append the copies as tiles (using the tile player) or
  concatenate into one pattern.
- **Row workbench + matrix view**: the grid is *already* a 12×12 twelve-tone matrix; show the
  P/I/R/RI matrix of the current row and click a form to load it. A "valid row" lamp (all 12
  pitch-classes once) and a one-click random-row generator.
- **Ship études as project files**: the save/load format means a starter pack can be authored
  as `.json` projects and just *loaded* — no new engine. A cheeky "12-Tone Hanon, Book I."
- **Pair with the Triadulator**: drills like "complete this row's negative space with triads,"
  or interval-cycle / trichord études — constraint exercises that are also analysis practice.
- (Further out) **call-and-response ear-training mode**: play a row form, identify/notate it.

These are all **pure functions over a `Pattern`/row** (transform in → pattern out), so they
slot beside the existing permute/highlight pipeline without touching transport.

### Rhythm overlays

Apply a repeating **duration template** over an existing grid, reshaping its rhythm while
keeping the pitches. E.g. `1/4 1/8 1/8` tiled (×4 fills the 12-column grid), or
`1/4 1/4 1/8 1/8 1/8 1/8` (×2). Only column `durIndex` changes; degree / rest / accent stay.
Design notes & thoughts:

- **Tiling:** lay the template across the columns cyclically; if it doesn't divide the column
  count evenly, the final cycle is partial (tile-and-truncate). The composer's examples divide
  12 evenly. (If the time axis ever becomes variable-length, an overlay could *define* the
  column count instead of mapping onto a fixed 12.)
- **Palette limit:** overlays use only the current four durations {1/8, 1/4, 3/8, 1/2} (an
  eighth-note grid) — no 1/16 or triplets yet. This *does* already cover **tresillo**
  (3/8 3/8 1/4 = 3+3+2 eighths) and **gallop** (1/4 1/8 1/8).
- **Length changes:** durations set the pattern's beat-length, so an overlay shortens/length-
  ens the pattern and re-stretches the Stretch view — intended.
- **Scope:** whole-grid first; a **selection-scoped** overlay (rhythm only a sub-range) is a
  natural extension that pairs with the selection layer.
- **Rests:** duration-only for now (a rest keeps its slot, takes the new duration). Overlays
  could later encode rest slots too — a rhythm with holes.
- **UI:** ship common cells as one-click presets (straight, gallop, reverse gallop, tresillo,
  long-short, dotted) plus a custom template via a compact text spec (e.g. `4 8 8`), likely a
  small "Rhythm" menu to avoid toolbar bloat.
- **Pure & undoable:** a function (template + column count → durIndex list), one `_commit`,
  sits beside the permute tools. Great fodder for **rhythm études** (apply a cell, then permute
  the pitches under it).

**Named-rhythm presets (dropdown).** A menu of named grooves — Tresillo, Habanera, Gallop,
Charleston, Son/Rumba clave, Bo Diddley, etc. — applied to the grid or the selected columns.
Best stored as a **step pattern** at a stated resolution (`{ name, pulses, steps:[1,0,0,…] }`,
1 = onset / 0 = rest — the universal clave / 808 notation), so it's data-driven and trivial to
add more. "Apply" derives durations from the onset gaps, puts pitches on the onsets, rests on
the silences. Two current limits decide which of the composer's examples actually fit:

- **Resolution ceiling = the eighth note** (8 pulses/bar). **Fit today:** Tresillo
  (`3/8 3/8 1/4`), Gallop, Charleston, Habanera — all 8-pulse. **Need sixteenths:** Son/Rumba
  **clave** and **Bo Diddley** are 16-pulse; they require adding `1/16` (and `3/16`) to
  `DURATIONS` — a contained but real model change (eighth-grid assumption, Stretch widths;
  MIDI is fine, already 480 ticks/quarter).
- **Length:** claves are 16-step, often **two bars** → they want 16/32 columns, but the grid is
  fixed at 12. So the full clave family also waits on **variable column counts** (or a dedicated
  step-grid). The 8-pulse grooves map onto ≤12 columns fine.
- **Pitch ↔ onset mapping** (sub-decision): when a rhythm has K onsets and the target has M
  notes, **cycle** the M pitches through the K onsets (simple; melody wraps onto the groove) vs.
  keep pitches positionally and only re-rhythm / insert rests. Default to cycle.

Net: ship the **8-pulse grooves now** (real and fun), and let the iconic 16-step claves be the
carrot for adding sixteenth resolution + variable grid length.

### Triad identification & operations

- **Name the triads in the Triadulator.** The engine already classifies each as
  `{ quality, root, pcs }`, so naming is nearly free: pitch-class name + quality → "C maj",
  "A min", "G dim", "E♭ aug". Surface as a readout for the current triadulation (e.g.
  `2/9 · C maj · A min · E♭ dim`) and/or per-group labels; tooltips on the ghost notes.
- **Generalize to a "triad object."** Identify triads *anywhere* (in a selection or the whole
  pattern, not just the complement), label them, and **operate**: change **inversion**
  (re-voice — which chord tone is lowest), swap **quality** (maj↔min↔dim↔aug), transpose,
  arpeggiate. Inversion re-uses the Triadulator's octave/centering logic and only *shows* on a
  multi-octave grid (same caveat). Pairs with the selection layer: select 3 notes → "these are
  X — invert / revoice / change quality." All pure functions over a set of degrees.

### Counterpoint aids: A/B audition + the Fuguenator

- **Audition pattern-vs-pattern (visible + audible)** to aid writing counterpoint/harmony:
  while editing one pattern, overlay a chosen **reference pattern** in the roll (second color,
  dimmed) and **play both together**. *The machinery already exists* — the tile player overlays
  two lanes with per-lane colors + dimming, and notes carry `color`/`alpha`; this is the same
  thing surfaced from the grid via a "reference slot." Natural extensions = the "naughty
  analysis" the composer wants: **interval/consonance readout** between the two voices over
  time, and **forbidden-parallels detection** (parallel 5ths/8ves).
- **The Fuguenator** (generation, an extension of the Hanon line): given a pattern, create a
  companion (or pair) that **harmonizes with or relates to** it. Spectrum, cheap → deep:
  - **Canon / answer (cheap, do first):** copy the subject into the second voice **transposed**
    (e.g. +7 = answer at the fifth) and/or **time-delayed** (stretto). This is literally the
    serial transforms (transpose/invert/retrograde) feeding the second voice — reuses work
    already planned.
  - **Serial answer:** the companion as an I / R / RI / Tn form of the subject row.
  - **Harmonization:** generate triads/chords under a melody (ties to the Triadulator + triad
    objects above).
  - **Species counterpoint (deep):** rule-following consonant line(s) against a cantus firmus
    (1:1, 2:1, …) with voice-leading constraints — research-grade; defer.
  - Pairs directly with the A/B audition (hear subject vs generated answer) and with the
    two-lane tile player as the place a generated pair lands.

### Microtonal pitch sets (7-limit) — and a tuning-general chord finder

The payoff of the **tuning seam** ([src/tuning.js](src/tuning.js)). Generalize a tuning to a
**Scale = an ordered list of N pitches** (ratios from a `1/1`, or cents, or frequencies) with an
**optional period / "equave"** — `2/1` (octave), `3/1` (tritave, Bohlen-Pierce), or **none at
all**. **Octaves are not assumed and may be absent**: a scale can simply be N unique pitches with
no repeat interval. So `DEGREES_PER_OCTAVE` becomes `scale.size` + an optional `scale.period`; a
degree indexes the scale (extending by the period if one exists, else the pitch axis is the
finite N). Decided direction for the 7-limit start: a **JI lattice navigator** (rows/cols = prime
axes of the 3·5·7 lattice, each cell a pitch by ratio coordinates) with a **shipped default scale
you can edit**. Candidate default (configurable): `1/1 8/7 5/4 4/3 3/2 12/7 7/4` — features the
septimal `8/7` and harmonic seventh `7/4`. (Octave-reduction of lattice points is itself optional
once octaves aren't privileged.)

**Prep step DONE:** [audio.js](src/audio.js) now resolves pitch→frequency through the seam
(`degreeToFreq`) instead of `noteToFreq` directly — backward-compatible (identity in 12-ET), and
it makes the seam's frequency half *live* (it was previously dead code). Swapping the tuning is
now the only thing between us and audible microtonality.

The counterintuitive part: **the audio is the easy half.** `playNote` already takes a frequency,
so the moment `degreeToFreq` returns the scale's ratios the additive synth plays them *exactly in
tune* — the **best place to hear JI** (beatless intervals), better than exporting.
Baked-to-12 spots to generalize (to `scale.size` / the optional period):
- `model.js isBlackKey` (no black/white off 12) and `noteName` → scale-aware shading / ratio
  labels via `degreeToName`.
- the `% 12` "octave-mate" highlight → **"equave-mate"** (pitches a period apart); **none** when
  the scale has no period — then every pitch is simply unique.
- `BASE_PITCH` / `COLS = 12` in [src/grid.js]; the roll's semitone lanes/labels → ratio-based.

**"Triads" recomputed from the tuning (the composer's insight — and genuinely not hard).** What
makes a triad a triad is a **numerical relationship** (major ≈ `4:5:6`, minor ≈ `10:12:15`, plus
septimal tetrads `4:5:6:7`, otonal/utonal, …). So generalize the Triadulator's predicate from
"pitch-class set mod 12" to **"a pitch subset whose intervals match a target ratio/interval
template within a tolerance"** — computed in log-frequency / cents space, uniform across 12-ET,
other ETs, and JI (tolerance `0` = exact JI; ~15¢ = temperament approximations like 12-ET's sharp
third). **The combinatorial search (find / partition chords) is unchanged — only the membership
test changes**, which is why it's small; today's 12-tone Triadulator becomes the special case
(period `2/1`, 12 EDO, `4:5:6`-family templates within ~15¢, folded by the octave). Honest
subtleties: matching needs a **tolerance**; **octave-folding applies only when an equave exists**
(no period → chords are literal pitch subsets, actually *simpler*); and **inversions/voicings are
period-dependent**, so they only mean something when the scale has one.

**Playback vs. export.** Cubase can render these via **MTS** (MIDI Tuning Standard) / MTS-ESP, but
plain MIDI export is 12-ET; getting microtones *out* needs **MTS sysex** or **MPE / pitch-bend-
per-note** — the genuinely hard plumbing. Strong argument to **improve the in-app synth anyway**:
it plays exact frequencies natively, and in JI a cleaner, harmonically-locked timbre makes the
consonance *audible* (timbre matters more in JI than in 12-ET). Double payoff with the "better
sounds" / Faust-WASM wishlist below.

**Timbre ↔ tuning are coupled (Sethares).** Sensory consonance comes from how two tones' partials
line up. For a **harmonic** timbre (our additive synth) consonance peaks at simple ratios → **JI
is the natural fit and our current sound already favors it** (a 4:5:6 rings beatless).
**Inharmonic / bell** timbres (non-integer partials) move those peaks elsewhere — which is why
bells sound euphonic in scales *matched to their spectrum* (and sour in 12-ET). So "better sounds"
and "microtonal" are entangled: eventually the synth's **`PARTIALS`** should be parameterizable
per tuning (spectrum/scale matching). Defer the synth work, but keep that knob in mind.

**7-limit vs 12-ET, concretely.** 12-ET has near-perfect fifths but **thirds ~14¢ sharp** (buzzy)
and **no real 7** (its m7 is ~31¢ off `7/4`). 7-limit JI gives **beatless 4:5:6** plus septimal
colors 12-ET can't reach — `7/4` (969¢ "blue" 7th), `7/6` (267¢ subminor 3rd), `8/7` (231¢),
`7/5` (583¢). Cost: a fixed JI scale doesn't modulate freely (commas/wolves in distant keys) — but
"pick a tuning and explore its colors" is exactly Notorolla's stance, so that's a feature. A
ratio-based Triadulator's 4:5:6 / 4:5:6:7 become *exactly* consonant.

**Pentatonic fits trivially — and is the ideal first test.** Major pentatonic is 5-limit JI:
`1/1 9/8 5/4 3/2 5/3` (C D E G A); a subset reachable inside a 7-limit lattice (Pythagorean
`1/1 9/8 81/64 3/2 27/16` is an alt flavor). Being **size 5, octave-periodic, and familiar**, it's
the best way to *validate the generalized Scale* (size ≠ 12) before exotic JI — you instantly hear
whether the seam/grid handle a non-12 scale.

**Two anchors — keep them separate.** (1) **Reference / concert pitch**: the absolute Hz the whole
tuning hangs from — **A440** vs **C256**. They're *incompatible* (A440 ⇒ C≈261.6, not 256), so a
genuine choice; **C256 is clean for JI** (octaves of C are exact powers of two, a tidy `1/1`). Our
current implicit anchor is A440 (`noteToFreq`). (2) **Scale root / tonic**: which degree is `1/1`
and **transposing the scale to a new root** (e.g. major pentatonic starting on **D**). JI subtlety:
"transpose to D" = **re-anchor `1/1` to D** (pure pentatonic, new absolute pitches) vs **a D-rooted
mode of a fixed C-lattice** (reuses C's pitches → JI's uneven modes / comma pumps — interesting but
impure); default to the simple re-anchor. So the `Scale` interface wants: `referenceHz` (+ which
degree it pins), a movable `root`, the `ratios`, and an optional `period`.

#### Pitch "worlds" = (size, period) — the 12-note family vs. other sizes

A tuning belongs to a **pitch world** defined by `(size, period)`. This is the line between
"scales with 12 notes (some masked)" and "scales with more/fewer notes":
- **Same (size, period) ⇒ freely interchangeable by *reinterpretation*** (a degree is the same
  *slot*, only its frequency changes). This is why **12-ET ↔ 5-limit just swaps losslessly** —
  same 12-note world, just retuned — and why you can escape a JI wolf (D–A) by flipping to ET.
  **Masks live inside a world**: a pentatonic mask is a subset of the 12, not a note-count change
  (the masked notes still exist and sound).
- **Different (size, period) ⇒ NOT a swap but a *conversion*** (remap each pitch to the nearest
  in the target — lossy, explicit). Patterns carry their world, so you never cross by accident.
- The rule generalizes beyond 12: 19-EDO + a 19-note JI would form their own swap-group. *12 is
  just today's default world.*

**Pentatonic is the poster child of the split:** a 5-of-12 **mask** in the 12-note world (ET / just
pentatonic — built, keeps all 12-note tooling) **vs.** a **native size-5 scale** in its own world
(needs the size-5 grid + ratio tools). Same name, two families — the system must know which.

Implications: tunings declare `(size, period)` as first-class data; tools branch on `size`
(Triadulator stays 12-note until the ratio-definer; octave-mate folding + grid row layout key off
`size` = the viewport rework); the UI separates a *retune* (swap within a world — today's Tuning
dropdown) from a *world change* (different size/period — a separate, conversion-aware action). This
is exactly the **Stage 1 (the (12, octave) world, done) / Stage 2+ (other worlds)** boundary.

#### Tuning vs. scale, and mixing them (the model)

Crucial distinction (surfaced by "ET pentatonic *and* just pentatonic"):
- a **tuning** = the degree→frequency continuum (12-ET, or a JI lattice) — what `degreeToFreq` does;
- a **scale** = a selected *subset/mask* of a tuning's pitches (a key-signature-like "allowed notes").
- **ET pentatonic** = pentatonic *mask* over the 12-ET tuning; **just pentatonic** = pentatonic as its
  own JI *tuning*. Same scale, two tunings — and we want both.

"Mix scales/tunings" decomposes into an easy and a hard half:
- **Scales within one tuning (masks)** — e.g. chromatic + pentatonic, both 12-ET. **Easy**, needs no
  multi-tuning: 12-ET tooling (Triadulator etc.) spans it because the pitch world is shared.
- **Different tunings coexisting** — a just-pentatonic lane vs a 12-ET lane. The **hard** xenharmonic
  half: two pitch continua at once.

**Converged model — patterns carry their own tuning (+ optional scale mask).** The grid shows the
current pattern *in its tuning*, so **"flip a grid" stops being a thing**: you never flip a pattern,
you open a different one and the grid adopts its tuning. The registry holds mixed-tuning patterns
(each self-describes → no nonsense, one parked slot still fine). 12-ET tools light up when the
current pattern is 12-ET, grey out otherwise.

The hard half (Stage 2) then needs: the Score build **resolves degree→frequency using each note's
pattern tuning** (not a global fn); **audio plays that frequency**; the **roll plots by
frequency/cents** (continuous y) so mixed tunings coexist visually for free. `degreeToET(degree) →
{ midi, cents }` stays the 12-ET fallback/export bridge (export = `.midi` now; accurate microtonal
later = `.midi` + per-note pitch-bend/MPE or an MTS table from `.cents`).

**Staging:** Stage 1 = scale **masks** + a few selectable tunings (incl. **both** pentatonics) + the
per-pattern `tuning` field landed in **V2** (default 12-ET, mask optional) — delivers "12-ET tools
over a pentatonic+chromatic mix" now. Stage 2 = mixed-tuning playback (Score/roll/audio by
frequency) — no re-migration, the data's already there. **V2 envelope:** each pattern gets `tuning`
(default 12-ET) + optional `scale`; `migrate` reads every v1 pattern as 12-ET/chromatic.

Decisions banked: MIDI export = nearest-ET (`degreeToET.midi`) now, accurate (pitch-bend/MTS via
`.cents`) planned; "SET note" = friendly name for the 12-ET fallback, but code uses `degreeToET` /
`nearestET` (avoid colliding with "pitch-class *set*"); ratio-based **triad definer** is the
prerequisite for a tuning-general Triadulator (composer to pick up soon).

## Wishlist: notation & "can this sound good?"

### Notation
- Composer has **Dorico**, so the pragmatic path is **export a Standard MIDI File** and
  notate there. SMF is simple to generate (no library needed) and routes the
  `Score`/arrangement straight into Dorico.
- In-app notation is a rabbit hole — the hard part is **pitch spelling** (C♯ vs D♭ is
  genuinely ambiguous in a 12-tone context with no tonal anchor), plus clefs/accidentals/
  beaming/multi-voice (lanes). Our rhythms are friendly (1/8, 1/4, 3/8=dotted-quarter,
  1/2). If ever wanted, do a **read-only** staff via **VexFlow** (bundles SMuFL fonts) —
  but it's a dependency and still needs spelling decisions. **Low priority vs. Dorico.**

### Sound ("can this sound good?")
- **VSTs cannot load in a browser** (native binaries). Three realistic bridges instead:
  1. **MIDI file export** → open in the DAW and play through existing VSTs. *Lowest
     effort, also IS the notation bridge — build this first.*
  2. **Web MIDI output → virtual port → DAW, live.** Web MIDI can *send* notes to a
     virtual MIDI cable (Windows: **loopMIDI**) feeding the DAW, so Notorolla's transport
     drives real VST instruments in real time. Chromium-only + virtual cable; reuses the
     scheduler.
  3. **WASM / AudioWorklet synthesis in-app** for self-contained good sound:
     **Faust** (DSP language → WebAudio worklet, big synth/fx library — best fit),
     **Csound (WASM)**, **WebPd** (Pure Data in the browser), or **soundfont/SFZ** players
     (sampled, if "generates its own sound" is relaxed). *VCV Rack is desktop/GPL — no
     known clean browser port; verify before relying on it.*
- Cheap interim: improve the built-in Web Audio voice so the default sound is less plain.
  *Started:* the **Vesperia** edit pane (ADSR + Timbre + resonant filter w/ env & key track,
  all native). Still wanted: a real **reverb / convolver**, and (tying into the microtonal
  work) **tuning-matched `PARTIALS`** per Sethares. Multi-instrument registry, per-lane voices,
  and folding patches into the project file are the next steps once the model settles.
- **Recommended order:** MIDI export → Web MIDI out (live) → in-app Faust/AudioWorklet
  (ambitious, self-contained).

### Record the audio output
**Path B (offline → WAV) is now BUILT** as **Export Audio** for the tile player (see "Export to
audio (WAV)" above): `OfflineAudioContext` render → `encodeWav` → download, via the now
context-parametric `buildVoice`. The notes below are the original survey; **Path A** (live
MediaRecorder capture) and the open scope choices remain available if wanted later.
- **Path A — live capture (cheap, ~30 lines, no refactor):** connect `master` to a
  `MediaStreamAudioDestinationNode` and feed a **`MediaRecorder`**; download the Blob via the
  existing `downloadBlob` ([src/project.js](src/project.js)). *Catch:* records in **real time**
  and is **compressed/lossy** — Firefox emits **WebM/Opus**, not WAV. Good for a quick "record
  what I'm hearing (tails and all)" grab.
- **Path B — offline render → WAV (recommended deliverable):** schedule the whole score into an
  **`OfflineAudioContext`**, render faster-than-real-time to an `AudioBuffer`, encode to **WAV**
  with a tiny pure-JS PCM/RIFF writer (same spirit as [src/midi.js](src/midi.js)). **Exact,
  lossless, fast.** Fits the data model: notes are already pure beat-data (`arrangementScore` /
  `buildScore` in main.js), so just × seconds-per-beat and `playNote` them all in — **no lookahead
  scheduler needed offline** (that's only for live/interactive playback); render a **release tail**
  past the last note (also where a future reverb lands). *One real cost:* `AudioEngine` currently
  hardwires `this.ctx`/`this.master`, so the voice-building needs to become **context-parametric**
  (pass ctx/destination) to serve both the live and offline contexts — a healthy refactor that's the
  **same seam** the future multi-instrument / per-lane-voice work wants.
- Pairs naturally with **Export MIDI** (MIDI for the DAW/notation, WAV for the actual sound).
- **Open scope decision (when built):** what a recording captures — the **active pane** (grid or
  arrangement, like the transport), the **arrangement only** (like Export MIDI), or the active pane
  **× its loop count**. Both paths are feasible whichever way.

### Audio effects (deferred — native quality is fine for the important ones)
Effects on the built-in synth, **no WASM needed**, using native Web Audio nodes (`DelayNode`,
`ConvolverNode`, `BiquadFilter`, `GainNode`, `WaveShaperNode`, `OscillatorNode` as an LFO):
- **Delay — excellent, trivial.** DelayNode + feedback gain + wet/dry, optional lowpass in the
  feedback for darkening repeats. **Tempo-synced** (1/8, dotted-1/8, 1/4) is nearly free since the
  model knows BPM — a strong fit for a loop/ostinato tool. Build-first candidate.
- **Chorus — very good, easy.** 1–3 short DelayNodes (~15–35 ms) with LFO-modulated `delayTime`,
  mixed with dry. Same module yields **flanger / vibrato / tremolo** by changing ranges.
- **Reverb — good (better than "ok").** `ConvolverNode` is true convolution reverb; it needs an
  impulse response. Recommended: **synthesize the IR in code** (exponentially-decaying noise, with
  decay-time / pre-delay / tone / width knobs) — keeps the **no-sample / no-dependency** stance and
  sounds like a solid generic hall/plate. (Alternatives: ship a real IR file = more realism but a
  sample; or a Freeverb-style comb/allpass network = classic, more nodes, no IR.)
- **The one real gap: pitch-shift / time-stretch / spectral** — native quality is poor; those want
  an AudioWorklet/WASM. Not among the priority three.
- **Architecture (the design fork):** standard DAW split — **inserts** (delay, chorus, drive) in
  series, naturally **per-instrument** (eventually part of the Vesperia patch, beside ADSR/filter);
  **reverb as a shared *send* bus** (one reverb many sources feed, not a copy per voice). This rides
  the **same context-parametric `AudioEngine` refactor** the offline-render / multi-instrument work
  wants. Today's path is voice → `master` → compressor → destination ([src/audio.js](src/audio.js)).

### "MIDI-filter"-style note-transform tools (deferred)
MIDI-insert/effect-style **note → more-notes** transforms, in the spirit of a hardware MIDI echo or a
DAW MIDI insert — but over Notorolla's **pattern** model rather than a live event stream. Canonical
example: a **"MIDI echo" / pattern echo** — repeat the notes at a delay with **per-repeat
transposition** (e.g. each echo +N degrees and quieter), an arpeggiator-adjacent generator. Family
also includes: chord-ize (add intervals/triads above each note — ties to the Triadulator/triad
object), velocity/accent shapers, humanize, note-length filters, range fold/clamp. Two ways to
realize each, decide per tool: **(a) offline expansion** — bake the extra notes into the
pattern/score (pure `Pattern`→`Pattern` or →expanded score, undoable, beside the permute tools); or
**(b) a playback-time layer** that generates events live without altering the stored pattern. Pure
data-in/data-out, so they slot beside the existing permute/transform pipeline and pair with the
**genuinely-good arpeggiator** already on the wishlist.

<!-- add below -->

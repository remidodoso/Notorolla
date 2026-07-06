# Notorolla — future directions

Big-picture roadmap for the **large** features still ahead. This is the "where are we
going" companion to [notes_and_status.md](notes_and_status.md), which stays the detailed
log of what's *built* and the fine-grained deferred backlog. When one of these lands, the
mechanics move over there and this entry shrinks to a pointer.

Everything here honors the standing constraints: **static web, no build, no dependencies,
Web Audio for all sound, beats-not-seconds in the model, pitch through the tuning seam,
pure data-in/data-out logic** so it stays testable and WASM-portable. Where a direction
strains one of those (samples cross the "generates its own sound" line; a few want WASM),
it's called out.

---

## What goes here vs. in notes & status

**This file is not the status log.** The detailed record of what's *built* — mechanics,
decisions, file/function names, test counts, the fine-grained deferred backlog — lives in
[notes_and_status.md](notes_and_status.md). Day-to-day implementation updates go **there**,
not here.

Updates to *this* file are only two kinds:

- **Accumulating future debt** — new "pie in the sky" / wish-list ideas as they come up
  (a new numbered direction, or a bullet under an existing one).
- **Status flips on an existing direction** — a short note that idea X has been
  **implemented** (then the mechanics move to notes & status and this entry shrinks to a
  pointer), or **shelved**, **reworked**, **superseded**, etc.

So: if you're writing down *how* something now works, it belongs in notes & status. If
you're writing down *that* a future idea landed / died / changed shape, or adding a brand-new
wish, it belongs here.

---

## The shape of it (leverage vs. cost)

A few of these are keystones that multiply the value of the others; a few are gated behind
a shared enabler. Rough read before the details:

| Direction | Core cost | Needs WASM? | Depends on |
|---|---|---|---|
| **1. Subsequences** (nestable arrangement tiles) | pure model — recursion over the material graph | no | — |
| **2. PaulStretch drones** | FFT / phase-vocoder DSP | for realtime; **offline render can be plain JS** | a source to stretch (5, or a self-bounce) |
| **3. Beat generator** | pure generators + a real multi-sound drum track | no | 7 (for true multi-sound tracks) |
| **4. PadSynth (+ more voices)** | frequency-domain wavetable **bake** | **no** — one-time table, not realtime | — |
| **5. Sample player** | pool/slicer/clips + zip packaging | only for independent pitch/time | — |
| **6. Etuderator** | serial-transform primitives + notation | no | 1 (emit études as subsequences) |
| **7. Polyphony + expression** | model migration + per-note expression + instrument pass | no | — |
| **8. Physical-modeling / plucked voice** | AudioWorklet DSP kernel (extended Karplus-Strong) | **no** — plain-JS worklet, no build step | shares the worklet seam with 2 & 5 |
| **9. Convolution cross-synthesis** | native `ConvolverNode` + offline bounce | **no** — reuses the reverb core | reverb + `renderToBuffer`; sample-IR waits on 5 |
| **10. Analog synths** (mono+glide, poly Prophet/OB) | native subtractive engine (shared) | **no** | glide pairs with 7's legato/gate |
| **11. Scale-space tools** | scale-mask library (data) + transpose features | **no** | harmonization waits on 7 |
| **12. Tile inspector** (per-tile modifiers) — *shell + facts + transport + rename BUILT; per-tile modifiers ahead* | pure model + UI | no | composes with 1 & 7 |
| **13. Instrument cleanup pass** (levels, weak controls, shared labels) | audio metering + DSP tuning | no | — |
| **14. Patch catalog** (named patches + modeless catalog windows) — *Phases A–C BUILT; D (groups/tags) & E (drag-to-lane) ahead* | pure model + UI + a user-global store | no | reuses the inspector's pane shell (12); catalogs generalize |

Two corrections to flag up front, because they change sequencing:

- **PadSynth does *not* need WASM.** Its cost is a one-time frequency-domain table build at
  patch/note time, exactly the per-context `PeriodicWave` bake we already do for Wendelhorn
  and Tervik. It's probably the *cheapest* big instrument win, not an expensive one.
- **PaulStretch doesn't need WASM for a *drone bed*.** Drones are static and offline — a
  plain-JS FFT overlap-add at bounce time is slow but perfectly fine. WASM only earns its
  keep if you want to hear the stretch move in real time.

Three cross-cutting enablers underlie the rest and are worth building deliberately (see
[Cross-cutting enablers](#cross-cutting-enablers)): a **unified "playable material"
abstraction**, one **DSP worklet investment**, and the **pure generator/transform pattern**
we already use ([src/random.js](src/random.js), [src/transforms.js](src/transforms.js)).

**Suggested order:** 1 (subsequences) → 4 (PadSynth) → 7 (polyphony) → 3 (beat generator)
→ 5 (sampler) → 6 (etuderator) → 2 (PaulStretch). Rationale in
[Sequencing](#sequencing-a-recommended-path).

---

## 1. Subsequences — nestable arrangement tiles (Opcode Vision)

**The idea (yours):** like Opcode Vision's subsequences. Open an empty subsequence window
(a new tile-player view), *or* make a selection and "create subsequence"; the subsequence
then shows in the tile player as a single subsequence tile. Nestable.

**Why this is the keystone.** Notorolla's whole identity is already *patterns as first-class
named, referenced objects* — a tile references a `Pattern` by name, and editing the pattern
updates every tile that uses it (the Vision promise, deliberately against Cubase's
deep-copy default). A subsequence is the *exact same idea one level up*: a tile that
references a **sub-arrangement** instead of a leaf pattern. Everything Vision-ish we've
built is a special case of this.

**How it maps to the architecture.** Today the tile player *is* the single top-level
`Arrangement`. The move is to unify:

- Define a **"playable material" interface** — something that can be flattened to notes at a
  time offset. A **leaf** is a `Pattern`; a **node** is an `Arrangement` fragment. A tile
  references either by name (the registry already handles naming/parking/reference-counting;
  extend it to hold sub-arrangements too).
- `arrangementScore` becomes **recursive**: flattening a subsequence tile emits its
  sub-arrangement's notes, each shifted by the tile's `start`, then scaled/looped to the
  tile's length. This is the one real engine change; everything downstream (roll, scheduler,
  export) consumes the flattened score as it does now.
- **Opening** a subsequence = a tile-player view *scoped to that sub-arrangement*. This is
  the natural home for the "panes in separate windows" idea we discussed — a subsequence
  editor is just another tile-player instance over a different root.
- **Transforms compose for free.** The per-tile nondestructive transform pipeline
  ([src/transforms.js](src/transforms.js)) already runs on a flattened note list, so
  transpose/reverse *of a whole nested block* falls out — a reversed subsequence tile
  retrogrades everything inside it. (Reverse-of-a-nest is order-sensitive; the existing
  ordered-transform normalization already anticipates that.)

**My recommendations / watch-outs:**

- **Guard against cycles.** A subsequence must not contain itself (directly or transitively).
  A DAG check at "create/insert subsequence" time; reject with a clear message.
- **Reference semantics are the whole point** — two subsequence tiles pointing at the same
  node should update together, just like patterns. That also means "create subsequence from
  selection" should *replace* the selection with one referencing tile, not copy.
- **This is pure model work — no WASM, no audio changes** beyond the recursive flatten. It's
  the highest-leverage thing on the list: the beat generator (3) and etuderator (6) both
  want to *emit subsequences* as their output, and multi-window panes want this scoping.
  **Build it first.**
- Length/loop policy for a subsequence tile needs a decision (does the tile's length crop,
  loop, or exactly equal the sub-arrangement's natural length?). Defaults to "natural length,
  croppable later" to match how leaf tiles already work.

---

## 2. PaulStretch "drone" tracks

**The idea (yours):** add PaulStretch to Notorolla for drone track(s). Probably needs WASM.

**What PaulStretch is:** extreme time-stretch (10×–1000×) via a phase-vocoder with
*randomized* phases per FFT frame — which is what turns a source into a smooth, shimmering
drone instead of a stuttering stretch. It's an audio-domain process, so it presupposes a
buffer to stretch.

**How it maps — and the on-brand angle.** Two source options:

1. **Stretch a sample** — depends on the sample player (5). Straightforward but crosses the
   "no samples" line.
2. **Stretch a self-bounce** — render a Notorolla pattern/tile to an `AudioBuffer` (we
   already do offline bounces for WAV export via the context-parametric `buildVoice`), then
   PaulStretch *that* into a drone bed. **This keeps the whole thing self-generated — no
   external samples** — and is the more Notorolla-native path. A "freeze this pattern to a
   drone" action.

**My recommendations:**

- **WASM is optional here.** A drone is static and rendered offline, so a plain-JS FFT +
  overlap-add at bounce time is acceptable (slow, but it's a one-shot bake, and the result
  is cached as a buffer — same spirit as the reverb IR). Reserve the worklet for *live*
  stretching if you ever want to hear it move.
- **A native "granular drone" voice is a cheaper approximation** worth considering first:
  many overlapped, randomly-offset grains from a synthesized source smear into a drone
  without any FFT machinery. It might be *enough* for a bed, entirely within the registry.
- **Gate this behind either 5 or the self-bounce.** On its own it has no input. The
  self-bounce path is the one I'd pursue — it reuses the offline-render seam and stays
  sample-free.
- Note the **pre-beat scheduling trick** already banked in the notes (schedule lead-in audio
  at `time − preT`) pairs naturally with drone swells/builds.

---

## 3. Beat generator

**The idea (yours):** tracks with multiple percussion (or other) sounds — a "drum kit," but
generalize it. A tool to randomly **mutate** an existing pattern to add a fill, or to
**generate** a breakbeat.

**What's already here.** Boshwick is a full 808-style percussion synth
([src/instrument.js](src/instrument.js)), deliberately *monotimbral* — **one drum per lane,
layer lanes for a kit**. So today a "kit" is a group of Boshwick lanes, and a beat generator
that targets that group is a **pure pattern generator** in the exact mold of
[src/random.js](src/random.js).

**Two separable pieces — and they have different costs:**

- **(a) The generator / mutator — buildable now, cheap, high-leverage.** Pure functions over
  patterns: Euclidean rhythms, density/probability fills, genre templates (the breakbeat
  spinner), and a **"mutate to add a fill"** transform that perturbs a subset (e.g. the last
  bar) of an existing pattern. This last one is a member of the **"MIDI-filter"-style
  note-transform family** already sketched in the notes — realize it as an offline
  `Pattern → Pattern` op beside the permute tools. No new audio. Emits tiles or a
  **subsequence** (ties to 1).
- **(b) A true multi-sound drum *track*** (several percussion sounds on one lane/row-map)
  **needs polyphony (7).** Boshwick is one-drum-per-lane by design; a single track holding a
  kick+snare+hat map is really chordal/multi-note-per-column entry plus a drum-map. So the
  "multiple percussion sounds per track" half of this direction **depends on 7**.

**My recommendation:** build **(a) first** against layered Boshwick lanes — it's cheap, it's
pure, and it delivers "generate/mutate a beat" immediately. Defer **(b)** until polyphony
lands, then it's a drum-map view over a poly pattern rather than new machinery.

---

## 4. More instruments — PadSynth in particular

**The idea (yours):** more instruments, PadSynth especially. Probably needs WASM.

**The correction: PadSynth does not need WASM.** PadSynth (Nasca Octavian Paul,
ZynAddSubFX) builds a rich spectrum in the *frequency domain* — each harmonic is smeared
into a Gaussian band of bins — then does **one IFFT** to produce a long wavetable that you
loop. The FFT is a **one-time table bake at patch/note-build time**, not a per-sample
realtime operation. That is precisely the pattern the registry already uses: Wendelhorn and
Tervik **bake per-context `PeriodicWave`s** and cache them. PadSynth slots into the same
mechanism — compute the wavetable in plain JS when the patch changes, feed it as a looping
buffer (or `PeriodicWave`). **Likely the easiest big instrument to add.**

**How it maps.** It's a new **kind** in the instrument registry
([src/instrument.js](src/instrument.js)): defaults + `PARAMS` editor metadata + a DSP branch
in `buildVoice`. Params are the PadSynth naturals — harmonic profile/bandwidth (the "spread"
that makes it lush), number of harmonics, a stretch/inharmonicity knob (ties beautifully to
the tuning seam — Sethares-style tuning-matched partials are already on the wishlist). The
edit pane rebuilds per-kind already.

**My recommendations:**

- **Next instrument, no WASM.** Reuse the per-context wave-cache pattern.
- **Great fit for the microtonal work** — a PadSynth whose partials are stretched to match a
  non-12 EDO is exactly the "tuning-matched `PARTIALS` per Sethares" idea already banked.
- Other cheap-and-native voices worth queuing behind it: **Karplus-Strong pluck** (trivial,
  native delay line), a **wavetable-scanner**, a straight **virtual-analog subtractive** (we
  have biquads). None need WASM.
- Watch CPU on the heavy end — Nayumi is already ~17 nodes/note; a looped-buffer PadSynth is
  actually *cheap* per voice, which is good news for polyphony (7).

---

## 5. Sample player

**The idea (yours):** load samples; slicer; retime, repitch, process, etc. Sounds like WASM
in places.

**Status:** already designed in discussion (recorded in the summary/notes). The agreed
shape: **IndexedDB hash-keyed sample pool**; **clips as `{sampleId, in, out}` views** (not
copies); a **slice-n-dice editor**; drag audio *or video* in (try `decodeAudioData`, no
demuxer dependency); and **zip-packaging** so a library can be bundled for another copy of
the app (this is the on-brand answer to "no dependencies but I still want to share sounds").

**The honest tension:** this **crosses the "generates its own sound / no samples" line** that
is core to Notorolla's identity. You've explicitly wanted it anyway, and zip-packaging keeps
the *app* self-contained even if the *content* isn't synthesized. Worth stating plainly in
the feature's own docs when it lands, because it's a deliberate identity decision, not an
accident.

**What needs WASM and what doesn't:**

- **Native, no WASM:** load/decode, slicing, looping, enveloping, and **varispeed
  repitch** (`playbackRate` couples pitch+time, the classic sampler behavior).
- **Wants WASM/worklet:** **independent** pitch-shift / time-stretch (the "one real gap"
  where native quality is poor). This is the *same* DSP investment PaulStretch (2) wants.

**My recommendation:** phase it — **(1)** native pool + slicer + clips + IDB + zip
packaging (no WASM, ships the whole "AoN/Yello snippet kit" use case), then **(2)** the
worklet DSP for independent pitch/time, which **also unlocks 2**. So 5→2 is a clean
sequence, and phase (1) is the on-ramp.

---

## 6. Etuderator

**The idea (yours):** generate random études / exercises via transformations of smaller
patterns — possibly with notation, if a simple-but-suitable methodology can be found.

**This already has a home.** The notes carry a whole **"12-tone exercises & études
(Hanon / Mikrokosmos)"** wishlist — half genuine post-tonal ear/technique training, half
joke that lands *because the material is actually good*. The Etuderator is that, made real.

**The primitives are mostly identified:**

- **Serial-transform permute tools** — Retrograde (have Reverse), **Invert** (mirror about a
  pivot — needs the axis decision already flagged as open), Transpose± (have scalar
  transpose). Transpose + Invert + Retrograde generate all 48 row forms (P/I/R/RI × 12).
- **A "Hanon engine" / sequence-spinner** — take a short cell, emit N copies each transposed
  by a fixed interval (semitone or scale step) up the range. This is the core étude
  generator.
- **Emit as subsequences (ties to 1).** An étude is naturally a *sequence of transformed
  cells* — i.e. a sub-arrangement of tiles that all reference one small pattern with
  different per-tile transforms. That's a subsequence. **6 wants 1 as its output target.**
- **Pair with the Triadulator** — "complete this row's negative space with triads,"
  interval-cycle and trichord études: constraint exercises that double as analysis practice.
- **Ship as project files** — the save/load format means a starter pack ("12-Tone Hanon,
  Book I") is authored as `.json` and just *loaded*, no new engine.

**On notation — my suggestion for the "suitable methodology."** The hard part of standard
notation in an atonal context is **pitch spelling** (C♯ vs D♭ is genuinely ambiguous with no
tonal anchor) — that's why in-app staff notation is a rabbit hole and Dorico-via-MIDI is the
pragmatic path. But for *constraint études* you can **sidestep spelling entirely** with a
notation that's more honest for post-tonal material:

- **Pitch-class / integer notation** (0–11, or hex to match the non-12 tunings already using
  0–f) — no enharmonic decision to make.
- **Interval / contour notation** — for row work, the sequence of intervals *is* the object.
- Or a read-only **piano-roll-derived tablature** — we already render the roll by true cents.

Standard staff (read-only VexFlow — a dependency, and still needs spelling decisions) stays
the "someday, low priority vs. Dorico" fork. I'd lead with pitch-class/interval notation: it
avoids the dependency *and* the ambiguity, and it suits the aesthetic.

**My recommendation:** build the serial-transform + sequence-engine primitives (pure
functions, drop into the Permute group), have them **emit subsequences**, and start notation
with integer/interval notation. Mostly pure-function work; a strong differentiator.

---

## 7. Polyphony + expression (the grid-model overhaul)

**The idea (yours), now decided.** Polyphony plus a real per-note expression layer.
**Permanent model commitment:** the grid's **Y axis is pitch, X axis is duration** — forever.
Today patterns are mono (one note/rest per column); we generalize to multiple pitches per
column, each with its own articulation. This is the highest-cost item and wants a **format
version bump**, but the axes never move again.

**The confirmed data model (decided this session):**

- A **column keeps its one duration** — that's the X-axis time value: the shared onset *and*
  the nominal note-value. The grid stays a true grid; Stretch view stays coherent.
- A column holds a **notes-list** instead of a single `degree`/`accent`:
  `{ durIndex, notes: [ {degree, velocity, gate, artic}, … ] }`. A rest = an empty list.
  Migration is backward-safe: `{durIndex, degree, accent}` →
  `{durIndex, notes:[{degree, velocity: accent?1.0:0.78, gate: 0.88}]}`.
- **`gate` is an unbounded length multiplier** (not capped at 1.0). Small = staccato, ~1 =
  tenuto, **>1 = the note rings past its column** into later ones (legato / overlap / sustain).
  This is how "expand the non-legato duration" happens *without* breaking "X = column
  duration": structure stays column-quantized, the *sounded* length is the gate. Overlap falls
  out of polyphony for free (voices are fire-and-forget); **ties** (same-pitch, no re-attack)
  and **mono legato-glide** (see 10) are later refinements.

**Articulation = a per-note expression bundle, instrument-resolved (decided).** Not just a
number: a named-articulation **palette** (Staccato / Tenuto / Marcato / Muted …), each a bundle
of offsets — gate, velocity, brightness/filter, attack/release, vibrato — that the **voice
interprets in its own DSP terms**, a seam parallel to the tuning seam
(`articulationToPatch(basePatch, artic, note)`). Plus **optional per-note raw overrides** for
hand-tuning. Implementation lever: the mod system (`mods.js`) already applies patch offsets in
**position space** (`applyMods`, `toPos`/`fromPos`) — per-note articulation is the same
machinery evaluated at note-on instead of over time.

**Velocity is already wired — the grid is the bottleneck.** Every `buildVoice` branch already
scales loudness by `velocity` (`velocity * VOICE_PEAK`); the grid just emits **two** levels
(`NORMAL_VELOCITY 0.78` / `ACCENT_VELOCITY 1.0`) via the `accent` boolean. So the audio
foundation for dynamics exists; what's missing is (a) **continuous per-note velocity in the
editor** and (b) the **timbral** response to velocity (brighter/snappier when hit harder) — only
**Boshwick** has that today (`bright = 1 + (velocity−0.78)*0.7`). The **instrument
responsiveness pass** adds velocity→brightness/attack (and articulation interpretation) to
Vesperia / Zindel / Wendelhorn / Tervik / Nayumi, with Boshwick as the template; re-meter with
the `wasim.mjs` rig to keep levels honest. This also finally gives **MIDI export** real
velocities.

**Named-rhythm grids (part of this cluster; ties to 3).** A tool to make a grid of a named
groove — "give me a tresillo grid," "four-on-the-floor." Crucially a groove is **durations
*and* an accent/velocity scheme** (four-on-the-floor's identity *is* its accents, not its
durations), so this depends on velocity being in the model. Data shape:
`{ name, lengthBeats, steps:[ {beats, velocity, gate?}, … ] }`; a **groove library**
(Tresillo, Habanera, Gallop, Charleston, Son/Rumba clave, Bo Diddley, four-on-the-floor…). Two
ops, both pure functions beside New Random / the permute tools: **generate a fresh grid** and
**overlay a groove onto an existing grid**. Now more reachable than when first discussed — 1/16
is in `DURATIONS` and variable grid length exists, so the 16-step claves are in range. Shares
the step-pattern data with the beat generator (3).

**What's cheap vs. not.** Audio is nearly free (fire-and-forget voices; overlapping durations
already work). The work is **model + grid UI**: notes-list migration, chord entry, note-length
dragging (incl. gate>1), a velocity/expression lane, articulation assignment, roll rendering of
stacks, transform semantics over note sets. Composes directly with the **Triadulator** (chords
from pitch-class sets), the octave-mate highlighting, and scale-step **harmonization** (11).
Version the format; migrate mono patterns as single-note columns. **Free polyphony** (independent
note-values in one column) stays deliberately out — gate>1 covers the expressive need.

**Grid-editor "basic improvements" (all four wanted):** multi-note (chord) entry · note-length
dragging (incl. overlap) · velocity/expression editing · selection & cursor ergonomics. These
*are* the near-term grid work; the enabling first step is the **notes-list refactor** (pure
model + one migration + a grid gesture, headless-testable), after which the rest are incremental.

**Rhythm ⊥ pitch — the duration FOOTER (decided this session).** The blended "click a note to
adopt/rotate its duration" gesture is the thing the composer fought; separate the two. Add a
**per-column duration lane rendered as a band at the bottom of the grid canvas** (same render
pass → alignment for free in Grid *and* Stretch views, and under scroll). Duration is edited
*only* there — **click-to-rotate** through `DURATIONS` for now (wheel-nudge deferred, user "might
warm to it"); **COLOR is the primary indicator** (the `durationColor`/`PALETTE` spectrum; the
toolbar duration brushes are the legend) with a small **numeric ("1/8") as backup** until SMuFL.
Grid-body clicks become **pitch-only** (place/repitch/rest/accent — the duration branch is
removed); a placed note takes its **column's** footer duration. Pure UI/gesture refactor — the
model already stores `durIndex` per column, so **no data/format change**. Nice side effects: the
footer is a scannable **rhythm map** (esp. in uniform Grid view), and it lets you **lay out the
rhythm first, then pitch it** — which is also where a **named-rhythm grid** deposits its groove.

**A column is a stack of swappable GROOVE LANES (decided/refined).** Model a column as a full
stack of attributes — **notes · duration · accent · articulation** — the footer exposing
duration/accent/articulation as lanes (notes stay in the grid body above). Column-level
accent/articulation is **distinct from per-note velocity**: it's how **four-on-the-floor** and
**backbeat** are expressed (groove emphasis is a property of the *beat*, not the pitches). The two
levels compose by **the user's rule — a per-note attribute MODIFIES the column attribute where
they overlap** (column = baseline, note = modifier/override): for accent a note nudges the
column's emphasis, for articulation it overrides the column default. In **phase 1 notes are pure
pitch**, so column attributes rule outright; the note-modifier layer arrives with per-note
attributes later. Named-rhythm grids populate the lanes (durations AND the accent scheme).
Today's per-note `accent` field stays a *column* attribute (that's what it already is); a
*separate* per-note velocity/accent modifier comes with polyphony.

**Footer drags are ALWAYS SWAPS, selective by attribute (decided).** A column is **never empty** —
it always carries every attribute — so a footer drag **swaps** attribute(s) between two columns
(no move-into-empty, no collision policy). Each **lane is independently draggable** (drag the
duration lane → swap just durations; likewise accent, articulation, and the notes). The user wants
to compose several via **dedicated areas, not modifiers**; recommended mechanism — **the vertical
span of the grab selects which contiguous lanes swap**: grab notes+duration to swap the *figure*,
a full-height grab swaps the *whole column*, one lane swaps one attribute (the two zones the user
named — "notes+duration" and "duration-only" — fall out of this). **Grid-body single-note editing
stays the fine layer:** place/repitch, and dragging *one* pitch (**mono → swap**, **poly → move**
within the stack). **Mono/poly is a per-pattern mode (confirmed)** — sets one-note-per-column
enforcement + the single-note collision behavior, and pairs with the mono-synth voice (10).

**Grace notes, ornaments & drum RUDIMENTS (future — flagged MUST-ADD; "Cubase can't, we can").**
Notes that do *not* own structural column time — borrowed from the beat via the **pre-beat
scheduling** trick already banked (schedule at `time − preT` so the main note stays on the grid).
One mechanism covers **melodic ornaments** (grace/mordent/trill) *and* **drum rudiments** (a flam =
a grace hit just before the main one — pre-beat scheduling makes flams/drags/ruffs trivial). A
per-note **ornament** attribute; orthogonal to the column/duration model (an ornament never gets
its own column), so it layers on after the notes-list + articulation work.

**Build phasing (settled — the plan).** **Phase 1 — BUILT (2026-07-04):** the footer *duration*
lane + the gesture split — body-click = pitch only (dropped the duration adopt/rotate branch),
footer-click = rotate that column's duration, **body h-drag swaps the note payload only**
(durations stay put), **footer h-drag swaps the whole column**. Zero model change (`durIndex`/
`accent` were already column fields); pure `swapNotePayload`/`swapColumn`/`durationLabel` in
`grid.js`, `notch/footer.mjs` 13/13. Two column-drag models the user named map cleanly: *grab-and-go*
= the footer whole-column drag (done); *select-attributes-then-drag* = the arming model (phase 2).
**Nomenclature (user, 2026-07-04):** the footer lanes are the **performance lanes** (aka **X-axis
lanes**); the current one is the **duration lane**; the small rectangle where a column meets a lane
is a **lane chit** (here, the **duration chit**). **Phase 2 opened with three duration-lane fixes —
BUILT (2026-07-04):** (a) **chit drag = pick up the WHOLE column** with drag-and-drop feedback —
source column lifts (full-height band + a ghosted chit tracking the cursor, swap on release) +
target-column highlight; (b) **cursor over the performance lanes = finger/`pointer`** (`grabbing`
while dragging a chit), not the note-placement dot; (c) **click a duration chit = SET it to the
current duration brush** (the brush is now the duration selector — replaced click-to-rotate). Clean
split: **click sets, drag picks-up-&-swaps** — no adopt-then-rotate blend. **Phase 2 — BUILT
(2026-07-04):** the **accent + articulation** groove lanes (see notes_and_status.md), then the
**NOTES lane + selective attribute swap** — a 4th gray "notes" handle lane on top completes the
**attribute rack** (notes/dur/accent/artic), and `swapLanes` swaps any **armed** subset. Arming
resolved to **double-click arms / single-click still edits**, per-column, transient; an unarmed
chit drag swaps just that lane. The "combine rule" stayed simple (a swap, no blend) — evolve if a
real need appears. **Phase 3 (next):** note-length / gate>1 + **polyphony** (notes-list, per-pattern
mono/poly mode) + per-note attributes as modifiers — this is where the body note-drag becomes
**"move, don't swap"** and `tenuto` gate>1 gets a real UI. **Phase 4:** named-rhythm generators +
named-articulation palette + the instrument responsiveness pass. **Phase 5:** grace notes /
ornaments / rudiments.

---

## 8. Physical-modeling / plucked instrument (Chromaphone-style)

**The idea (yours):** a good plucked-instrument **generator** — inspired by Chromaphone (AAS),
the exciter→resonator physical-modeling synth demoed and liked but not worth $300.

**What Chromaphone is, and what to steal.** It's an **exciter → coupled-resonator** physical
model: an exciter (mallet impact or noise burst, with stiffness/tone/position) strikes one or
two resonator objects (string, beam, marimba bar, drumhead, membrane, plate, tube), coupled in
series or parallel. The character comes from the resonators being *real models* that ring and
couple like acoustic objects, an expressive exciter, and a big tweakable timbre space. The
**plucked string** — the thing asked for — is the cheapest, best-sounding object in that whole
family: extended **Karplus-Strong** (the Jaffe-Smith waveguide string) is a genuine physical
model — a delay line whose length sets pitch, a damping filter in the loop for decay, plus
pick-position (a comb filter), pick dynamics and decay-stretch. A few multiplies per sample,
sounds like a real string, and — tuned by frequency — it **follows the tuning seam for free**
(a just or 16-ET harp/koto is nearly free, which Chromaphone can barely do).

**The architectural fork: native nodes can't do a waveguide string.** Native `DelayNode`
feedback is spec-floored at one render quantum (128 samples ≈ 2.7 ms), so a Karplus-Strong loop
tops out around **375 Hz** and is block-quantized — unusable for real pitches. Not an
optimize-later thing; it just doesn't work. Three honest paths:

1. **AudioWorklet (recommended).** A per-sample DSP processor — circular buffer + one-pole
   damping filter + fractional-delay allpass for fine tuning, ~30 lines. Still no-build /
   no-dependency (a worklet is just another static ES module), and the DSP kernel can be a
   **pure function** shared between the worklet and a `notch/` test — so we get real *unit*
   tests of the string, better than Boshwick's simulation. This is the **first, smallest
   customer of the DSP-worklet enabler** below.
2. **Native modal synthesis (a real option, different sound).** A bank of tuned high-Q bandpass
   biquads excited by a noise/impulse burst — native, no worklet, Boshwick's metallic-cluster
   trick generalized and *tuned*. Nails the **struck/mallet** half of Chromaphone (marimba,
   vibes, kalimba, music box, bells, glassy tines, short plucky objects) but does a long
   sustained string badly. Fast, low-risk win for the mallet family, not the guitar/harp asked
   for.
3. **Native convolution hack (clever, limited).** A *linear* Karplus-Strong string is LTI, so
   its impulse response is a decaying comb — bake it and play through a `ConvolverNode`, reusing
   the reverb IR machinery. But it needs a **separate baked IR per pitch** (long, expensive to
   build and convolve, one convolver per note) and loses live tweaking without a re-bake. Worth
   knowing; not where to invest.

**Recommendation.** Worklet-first, structured like Chromaphone's own **exciter→resonator** split
so the pluck is phase one of a family, not a one-off: an **exciter** (shaped noise/impulse burst
with stiffness/position + velocity/accent tie-in) into a **resonator** — start with the
**waveguide string** (worklet) for the pluck; later a **native modal resonator** covers the
mallet objects; eventually **coupling two resonators** recreates Chromaphone's signature
richness. Determinism for offline export via seeded excitation (mulberry32, like the reverb IR);
one wrinkle to plan — the worklet module must be `addModule`'d into each `OfflineAudioContext`
before rendering.

**The "generator" angle.** Very on-brand: a **patch randomizer** ("roll a new plucked object")
that explores the physical-model parameter space, à la New Random for patterns — that's what
turns "a plucked instrument" into a plucked-instrument *generator*. Built on the pure
generator/transform pattern (enabler 3).

**Why it's a strong pick.** Microtonal for free; **featherweight per voice** (unlike Nayumi's
~17 nodes — poly-friendly); builds the worklet muscle on a small, contained problem; pure DSP
kernel stays headless-testable; deterministic exports. It's really a richer, model-based sibling
of direction 4 (more voices), promoted to its own entry because it introduces the worklet seam.

**Open questions (from the discussion, to settle before building):** pluck-only vs. the full
acoustic-object family; is the randomizer part of the appeal; OK to introduce the first
AudioWorklet; single Karplus-Strong string first vs. two-resonator coupling from the start.

---

## 9. Convolution cross-synthesis (musical sounds as impulse responses)

**The idea (yours):** convolve actual *sounds* together — use musical / semi-musical sounds as
impulse responses, not just reverb IRs.

**What convolution of two sounds does** (the two facts that explain the magic and the
disappointments): (1) it keeps the **intersection** of the two spectra — a spectral *multiply*,
so frequencies strong in *both* survive and anything weak in either is suppressed (why a reverb
IR "stamps" a room onto a source, and why two very different sounds convolve to something thin or
dull); it is **not** layering A over B, it's "keep only what they share, smeared." (2) Every
**transient in A is replaced by a copy of B** (symmetric): drum loop × sung vowel = the vowel
sprayed at each hit; click train × phrase = the phrase re-triggered per click; anything × a
sustained tone = a wash. Output length ≈ len(A) + len(B). The reliable recipe: a
**transient/rhythmic carrier × a tonal/spectral stamp** (percussion × chord, pluck × vowel);
two arbitrary sustained sounds usually make mud.

**Why Notorolla is unusually ready.** We already have the whole machine: the reverb insert is a
`ConvolverNode`, and `ConvolverNode` *is* convolution — feeding it a musical buffer instead of a
decaying-noise buffer is the trick. Because Notorolla **generates its own sound**, we can render
a tile/lane/note to an `AudioBuffer` via the existing offline bounce (`renderToBuffer`) and use
*that* as the IR — so **"convolve one Notorolla sound with another" needs no samples and no WASM**.
It reuses the reverb's `ConvolverNode` + IR bake, the offline `renderToBuffer` seam, the
export-tail accounting for IR length, and seeded determinism (so exports match live). It is,
almost literally, **the reverb insert with a different IR source.**

**Two framings (different features):**
- **Generative "cross-synthesize" bake (lead with this).** Pick two sounds (two tiles, two
  lanes, a note × a phrase), bounce each offline, convolve into a **new buffer that becomes
  material** — a placeable one-shot, a sampler clip, or a drone seed. Offline, so no latency and
  no live-IR-swap problem, and it makes new *material* (fits "patterns as material"; ties to the
  sampler and PaulStretch — all three are "process a self-bounce into new material").
- **Live "Convolve" insert.** A per-lane insert, sibling of the reverb, whose IR is a chosen
  sound buffer — another sound as a lane's character. Inherits the annoying parts: a fixed IR
  buffer (an *evolving* IR = re-bake and swap, like the reverb shape-key rebuild), and long IRs
  add smear/latency live.

**Caveats to set expectations on:** levels are wild (keep `normalize` on + the master limiter);
**onset delay** (silence/attack before the IR's peak shifts the output late — trim the IR to its
onset, the inverse of reverb predelay); **smear-vs-rhythm is a length knob** (short IR preserves
rhythm, long IR washes out); it's a **color/smear tool, not layering** — say so in the UI.

**Recommendation.** Lead with the **generative bake** — it produces material, runs offline where
none of the hard problems bite, and reuses the reverb + offline-bounce infrastructure almost
wholesale (likely a small feature). The live insert is a natural follow-on. Both native, no WASM.
**Open questions:** IR source (self-bounce only, or a loaded sample too — the latter waits on 5);
insert vs. generative action vs. both (start with the bake); what the output *becomes* (placeable
one-shot / sampler clip / drone seed — which decides whether it lands before or after 5).

---

## 10. Analog synths — a mono lead (glide) and a poly (Prophet-5 / OB-X)

**The idea (yours):** a standard 2–3 oscillator **mono synth with portamento/glide**, and a
**poly synth** capturing the "highlights" of the Prophet-5 / OB-X sound.

**Decided: two registry kinds over one shared subtractive engine.** Build the DSP core once —
an oscillator bank (2–3 saw/pulse/triangle, detune, sync, PWM, sub/noise) → a **resonant
lowpass with its own envelope + key track** (Vesperia's filter section is reusable) + amp ADSR
+ an LFO — and expose it as **two focused kinds**, so each editor stays lean.

**Poly synth — fits the current model as-is.** Fire-and-forget-friendly: each note is an
independent voice with its own envelopes (exactly today's model, no cross-note state).
"Highlights" = dual osc + sync/PWM → resonant filter (cascade two biquads for a 24 dB slope if
wanted) + filter/amp envelopes + LFO, plus the character trick that sells analog: **per-voice
detune/drift** (small per-note random detune — the Wendelhorn decorrelation move). Prophet
flavor specifically = **poly-mod** (osc B / filter env modulating osc A freq + PWM); OB reads
fatter/simpler. This is the *easier* of the two and could ship first.

**Mono synth — carries the one new mechanism: glide.** Portamento is stateful across notes (the
pitch slides from the previous note), which our fire-and-forget voices don't track. **But it's
bakeable per note from the lookahead score** — the scheduler commits cycles ahead, so the
previous note's pitch is known; a note's oscillator can start at the prev frequency and ramp to
its own over the glide time. **No engine rewrite** — the only new thing is passing prev-note
context (freq + glide-on flag) into `buildVoice`. (Live MIDI would want true persistent voices,
already deferred.) Glide classically fires **only on legato** — connected notes, no gap — which
is exactly the **gate>1 / overlap** condition from 7, so glide and the legato articulation are
the same feature family. Two rules to settle when built: **last- vs top-note priority** when a
mono synth meets a chord column, and the legato/glide trigger tied to gate.

All native, no WASM. Lands under "more instruments" (4) but promoted here because the mono voice
introduces the glide mechanism and both share an engine.

---

## 11. Scale-space tools — doubling down on scale-step transposition

**The idea (yours):** scale-based transposition is *really* good at generating unusual, striking
atonal harmonies — so add more scales and more features to exploit it. (Why it works: scale
steps are unequal, so scale-step transposition **warps interval qualities** instead of
translating them — in asymmetric/exotic scales that produces surprising-but-coherent material,
exactly the app's north star.)

**The cheap enabler: a real scale-mask library — BUILT (2026-07).** In [src/scales.js](src/scales.js)
a mask is **just data** (`scalesFor(edo)`), and the generous 12-ET palette is now in: the **seven
modes**, harmonic/melodic minor, blues, and especially the **symmetric** scales — **whole-tone,
octatonic (diminished) ×2, augmented** — which give scale-transposition its most disorienting even
shifts (data-driven picker; `scales3.mjs`). Still ahead: exotic/world scales, Messiaen modes.
Microtonal masks are just as data-cheap *per EDO*, but new EDOs are tuning-seam work and
**non-octave** scales (Bohlen-Pierce, Carlos) need the deferred equave/viewport rework. Endgame:
**Scala `.scl` import** (thousands of scales).

**Features that turn transposition into a harmony *generator*** (roughly by payoff):

- **Scale-step harmonization** *(the big one — waits on 7).* Add voices N scale-degrees away,
  following the scale, so the interval quality shifts through the scale and you get **stacked
  chords**, not a doubled line. Lands the moment chordal-column polyphony exists — they're made
  for each other.
- **Scale projection / substitution** *(works now, monophonic).* Re-map a pattern's degrees
  *through a different scale/mode* — "play this as octatonic." Fast striking recolorings.
- **Evolving / per-repeat scale transposition** *(the loop aesthetic).* Step the pattern by
  scale degrees each loop pass — the scale-space cousin of the per-lane modulators (`mods.js`).
- **Scale sequence & random offsets** *(generators).* A Hanon-style spinner (emit copies, each
  +k scale steps) and bounded-random scale offsets — the étude / New-Random philosophy. **Reuse New
  Random's proven pattern:** bias generation *in place* by weighting the pick within the
  harmonic/melodic constraints (its **Steer** mode, `biasTargets`/`biasedPick`) rather than
  re-sorting the result — steering preserves Run/Triad/arpeggio contour, sorting destroys it.
- **Scale-space inversion / rotation** — invert a melody *within* the scale around a pivot
  (modal inversion); also the clean answer to the long-open "Invert needs a pivot" question.

**Composes with:** polyphony (harmonization), the tuning seam (microtonal scales), the
Triadulator (scale-diatonic chords), the mods system (evolving transposition), the serial/étude
work (inversion + sequences). Clean split for sequencing: **scale library + projection +
evolving transposition ship now (monophonic); harmonization lands right after 7.** All native,
no WASM.

---

## 12. Tile inspector — the per-tile modifier stack

**First cut BUILT (2026-07-05):** the modeless-window shell + a read-only facts dump + a play/stop/loop
transport cluster ([src/inspector.js](src/inspector.js), a "Tile Inspector" button in the tile-player top
row) — floating, `position:fixed`, draggable, resizable, never scrolls the page, follows the tile
selection, never holds focus. No per-tile modifier *editing* yet (transforms still live in the transform
bar; the instrument-override plumbing below is untouched). Mechanics in
[notes_and_status.md](notes_and_status.md). The rest of this section is still ahead.

**The idea (yours):** individual tiles in the player can already be changed without touching the
pattern they reference — today that's transpose and reverse. Add more per-tile modifiers, and give
them a proper home: a **tile inspector** panel for the selected tile. The first real new use:
**change instrument settings per tile** — e.g. a different **Nayumi vowel** on different tiles that
all reference the same pattern on the same lane.

**What's already here.** This extends machinery we have:

- **Per-tile transforms** ([src/transforms.js](src/transforms.js)) live on the tile *instance*, are
  applied when the score is built ([src/main.js](src/main.js) `arrangementScore`), never change the
  referenced pattern, are honored in the offline bounce, and are saved with the tile. Two tiles
  sharing one pattern already sound different.
- **Instrument patches live on the lane** (`lane.patch`, resolved per note by `patchFor(laneId)`),
  and **mods** ([src/mods.js](src/mods.js)) are a per-lane, per-instrument thing that stays there.

**The one real change.** The instrument is chosen per *lane*, but a tile is a group of notes *within*
a lane — several tiles on one lane share one instrument. So to vary a setting per tile, each note has
to carry its tile's override down to where the voice is built. That's the only new plumbing;
everything else is placement.

**How the instrument override works:**

- Stored on the tile as **just the settings that differ** (a small delta), not a full copy — so
  editing the lane's instrument still flows through to every other setting. Same reason transforms are
  stored as instructions, not baked notes.
- Stored **keyed by instrument kind** (mirroring `lane.modsByKind`), so switching the lane's
  instrument away and back leaves the override intact, and an override for an instrument the lane
  isn't currently using is simply ignored.
- **Applied when each note's voice is built, and included in the offline export** — a per-tile
  setting is real musical content, so the bounce must reflect it (the opposite of the Lite switch,
  which is a live-only preference).
- **First cut is an absolute set** ("vowel = ee"), which also makes menu-style settings like the vowel
  work directly. **Relative offsets** ("a bit brighter") are the early follow-on, reusing the mod
  system's even-feeling slider math.
- **Scope is settings within the lane's current instrument** — not swapping the instrument itself. But
  build the resolution so a tile *layers on top of* the lane's instrument, leaving room to grow toward
  the future where **"the lane has a default instrument"** and tiles (or notes) can override more
  deeply. Don't hard-wire "one lane = one fixed instrument" at the point where the voice is chosen.

**The inspector UI.** Select a tile → a panel shows its modifiers: the existing transforms, plus an
instrument-override section that renders the lane instrument's own controls (reusing the instrument
pane, [src/instrumentpane.js](src/instrumentpane.js)) with an inherit-or-override choice per setting.
For a Nayumi lane that's a vowel menu; for Wendelhorn, detune/cutoff/etc. The panel is also the home
for the modifiers below. Even where a setting isn't editable yet, the inspector should **show the
relevant facts** — e.g. the transpose control lists the *current* scale library (not a frozen subset)
and shows the tile's **key**, read-only if need be, so nothing important is hidden.

**A floating, non-modal, scroll-resistant pane (decided shape).** Unlike today's editors (delay,
reverb, random), which are modal dialogs that block everything until closed, the inspector **stays
open and follows the selection** — click from tile to tile and it updates. It's a **draggable,
position-remembered floating pane**, and it must **resist scrolling**: `position: fixed` so it doesn't
ride the page scroll, any overflow scrolls *inside* the pane (never the page), scroll-chaining
contained so a control or the pane's end doesn't start scrolling the page behind it, and no auto-scroll
of the document when dragging near an edge. The same no-scroll discipline holds in the popped-out
window below.

**Pop out into its own window (decided; with a Firefox caveat).** Build the inspector so it **renders
into a container element without caring which document that container lives in** — then docked →
floating → popped-out is just *moving the container* (a DOM node can be adopted into another window's
document), not a second implementation. The pop-out itself uses plain `window.open` (same-origin, so
the main window's code drives the popped-out document and the audio engine stays in the main window —
no dependencies, no build step); the cost is copying the app's styles into the new window, handling it
being closed (re-dock), and that a popup needs a real click, so it **can't auto-reopen on reload** (it
returns as a floating pane, re-pop with a click). The nicer always-on-top "document picture-in-picture"
API is **Chromium-only**, so it's ruled out on the same Firefox-first grounds as the File System Access
API. Make the pop-out mechanism **generic to any pane**, not inspector-only — that's the same "panes in
separate windows" capability flagged in subsequences (1), so a subsequence window reuses it later.

**Fixed order (decided).** Modifiers apply in **one built-in order** — there is no per-tile "drag to
reorder." When we add order-dependent transforms (rotate especially), you get the result you want by
choosing the rotate direction, not by rearranging. (An arbitrary, user-ordered insert stack is a
separate, later **mixer pane** — audio effects — not this.)

**Other modifiers the inspector will hold (later):**

- **A timing nudge** — shift the whole tile a little early/late, separate from its placed start. Units
  left open (milliseconds / beats / MIDI ticks).
- **"MIDI effects" — note doublers**, e.g. play a second copy of the tile ~50 ms offset. This
  **re-triggers the voice** (a fresh attack, honoring each copy's pitch and tuning), which is
  musically different from the lane's existing **audio** delay insert (that copies the sound already
  produced). It pairs with the pre-beat scheduling trick already banked for grace notes/flams in 7.

**How it composes.**

- With **subsequences (1)**: the same modifiers apply to a whole nested block (a brighter, echoed,
  reversed *nest*), with a small decision to make about how a nest's override reaches the tiles inside
  it.
- With **polyphony/expression (7)**: a per-tile timbre change is the tile-level sibling of per-note
  articulation.
- The "**change 'timbre' regardless of which instrument**" idea waits on the instrument pass (13),
  which adds the shared labels that make it possible.

**Cost.** Pure model + UI — no WASM, no new sound-generating code. One small override on the note, one
merge where the voice is built, matching behavior in the export, and the inspector panel.
**Watch-outs:** note doublers and late nudges push notes past the tile's nominal end, so the export
tail length has to include them (the reverb/delay code already does this kind of accounting). Deciding
what wins when a tile setting and a lane mod touch the same thing is left for later.

---

## 13. Instrument cleanup pass — levels, weak controls, shared labels

**The idea (yours):** a real pass over the existing instruments. Several have **volume mismatches**,
and a number of sliders **don't do much when they should**. Fix that, and while in there, add the
shared control labels described below.

**What the pass covers:**

- **Match levels across instruments** so switching kinds doesn't jump the loudness. There's already a
  metering rig for this — the `wasim.mjs` simulator referenced in 7 — so re-metering every kind to a
  common reference is testable, not by-ear guesswork.
- **Make weak sliders earn their place** — widen ranges, re-curve where a knob's useful action is
  bunched at one end, and fix or drop settings that barely change the sound.
- **Add shared labels ("roles") to settings.** Each instrument tags some of its controls with a
  common name — a **timbre** control, a **filter sweep** control, a **brightness** control, and so on.
  Once those exist, a mod, a per-tile override (12), or a per-note articulation (7) can ask for
  "brighter" without knowing which instrument it's talking to, and each instrument does something
  sensible — or nothing, gracefully, where the role doesn't apply (an organ with no filter just
  ignores "filter sweep").

**Why it's its own entry.** It's partly overdue maintenance that makes *everything* sound better, and
partly an enabler: the shared labels let **lane mods survive an instrument change**, let **tile
overrides ignore which instrument is loaded**, and give **7's articulation** the vocabulary it already
assumes — 7 describes articulations as bundles of offsets that "the voice interprets in its own DSP
terms," which is exactly this. So this pass unblocks the "change the sound in instrument-agnostic
terms" idea that runs through mods, tiles, and expression.

**Cost.** Audio tuning + metering, no WASM. Mostly careful adjustment of the existing voice code plus
the small amount of metadata for the shared labels. **Tie-ins:** 7 (articulation is the per-note user
of the labels), 12 (tile overrides start with concrete settings and gain the shared labels once this
lands).

---

## 14. Patch catalog — named patches + modeless catalog windows

**The idea (yours):** a whole family of **modeless "catalog" windows** for browsing collections — the
first and most-needed being **instrument patches**. Others follow the same shape (effects presets, a
pattern browser, grid templates like "four-on-the-floor"); rack instances are "probably another catalog"
too. This is the *library* sibling of the **Tile inspector (12)**: the inspector shows facts about the
one selected thing; a catalog shows *many things you pick from and apply*. Both are **modeless floating
windows**, so they share one pane shell (see Phase A).

**"Catalog" is the old-school word (user's), not "preset" — an instrument's saved sounds are its
patches, browsed in the patch catalog.**

### The core model — patches as first-class, id-keyed, named objects

Today a lane owns a private `lane.patch` blob. Promote patches to **first-class named objects**, the way
patterns already are (a registry + references), but **keyed by a globally-unique random id, not by name**:

- **Patch** = `{ id, name, kind, group, tags, params, factory }`. `id` = a UUID-ish token
  (`crypto.randomUUID()`, fine on localhost) so two users' catalogs **can never collide** — the key to
  alien-project imports. **Names are non-unique display labels, never dictionary keys.** The id is
  internal but occasionally surfaceable (an inspector could show it).
- **Everything is always named.** Each kind ships a factory **`Init`** patch (read-only); fresh lanes /
  grid start on it. There is no "Unnamed" state.
- **A lane (and the grid patch, treated the same) stores its full working params (self-contained — rides
  the project, the catalog is never a load-time dependency) plus `originId` + an `originName` snapshot +
  a `dirty` bool.** Display state is computed at render time:
  - **`Name`** — origin id resolves in my catalog and matches → clean.
  - **`Name*`** — resolves but edited, or a typed-but-not-yet-Saved name. The asterisk means *"this sound
    may be related to this name, but isn't exactly this named sound"* (one unified meaning — an editor's
    dirty dot; not two overloaded uses).
  - **`Name [I]`** — origin id does **not** resolve: an **imported/foreign** patch (globally-unique ids
    make this unambiguous). Ride-the-project and sounds correct; **no auto-pollution** of my catalog on
    import; **Save As** *adopts* it (mints a fresh id in my namespace). `[I]` is a display decoration
    (id-unresolved), not stored in the name.

### The stores — user-global vs. in-document

- **The catalog is user-global** (localStorage now; file **export/import** later so patches are
  shareable), **not** part of any project file. Editing it never dirties the project.
- **Factory tier** = `factory:true` entries shipped as **code/data** (a factory-patches source file),
  separate from the user store. A **super-user "Factory Save"** authoring tool (deferred) writes into that
  tier — practically, emits the JSON the dev commits. It changes nothing else; just targets the factory
  tier instead of the user tier.
- The project stays **self-contained**: the resolved params always ride it, so a patch that isn't in the
  opener's catalog still sounds right (just shows `[I]` or the remembered name).

### The editor (instrument pane) owns save/load/name

- The pane header carries the **inline-renamable patch name** (the exact double-click-to-rename control
  from the Tile inspector) + **Save / Save As / Load / Delete** (Delete/Rename on **user** entries only).
- **Save** on an `Init`/factory ancestry can't overwrite (factory is read-only) → becomes **Save As with a
  blank name field you must fill**. A user Save whose name collides with a **factory** name in that kind
  **auto-uniquifies** (`Init` → `Init1` … `Init57`); user↔user name collisions are allowed.
- **Naming is intent; Save commits.** Typing a name shows `Name*` until Save writes the catalog entry.
- **Changing the instrument kind resets to that kind's `Init`** (a name is meaningful only within a kind;
  the catalog is per-kind). *(Open, deferred to build time: Save-with-a-changed-name on a **user** patch —
  rename the entry in place vs. fork; Save As is always the explicit fork.)*

### The catalog window

- Modeless floating window (the Phase-A pane), one **per catalog type** (patches, effects, patterns…).
- Hierarchy **kind → group → patch** (group = one folder path per patch); **tags** = many cross-cutting
  attributes (a second, faceted filter); **live text search** prunes the tree. The three filters compose
  — the design for hundreds/thousands of patches (virtualized rendering only if we actually hit huge lists;
  factory content is sparse at first — one `Init` per kind + whatever you Save).
- **Double-click a patch = apply to the current editor target.** **Drag a patch onto a lane head** (and the
  instrument-pane target chip) = apply there — reusing the tile-drag ghost idiom. Applying a patch of a
  *different* kind switches the lane's instrument (kind + params in one move); an undoable mutation.

### Lane head, restated

The **Edit button goes away**; the lane head shows two lines — **Instrument** (kind) over **Patch**
(`Name` / `Name*` / `Name [I]`). **Double-click anywhere there** → scroll to the editor with that lane
loaded. (This keeps evolving as lane heads get reworked.)

### Rack instruments (deferred, but designed-for)

Lanes "notionally sharing an instrument" — really **sharing one live patch instance** (Cubase *rack*
vs. *track* instruments): edit once, all sharers re-sound. First-class id-keyed patches make this natural
later (multiple lanes → one instance, exactly as tiles → one pattern). **Not in the initial phases** —
for now every lane keeps its own independent patch. When it lands it needs a lane-head indicator and is
"probably its own catalog" (a catalog of shared instances you assign lanes to). Until then, **Save does
*not* re-sound independent copies** — a lane holding an old copy of a just-re-Saved patch simply goes
`Name*` (its copy no longer matches the saved sound).

### Auditioning (parked, but this is what it plugs into)

Judging a patch needs to hear it play a **pattern**, not one Test note. Decided shape: an **"Audition
Grid"** action (in the instrument pane, beside Test) that plays the **current grid pattern, looped** (the
limited/counted loop — no burn-in), through the **pane's current edit target** (so a lane's bus/effects
apply); disabled on an empty grid; a keybind later. The **catalog's per-patch ♪ audition reuses that same
verb**. Test stays for the quick single note. Deliberately **parked** for now to keep the catalog work
focused — but it's the audio verb the catalog leans on, so build it alongside the catalog, not after.

### Implementation phases

- **Phase A — extract the modeless-pane primitive — BUILT (2026-07-06)** *(enabler, no visible change)*:
  the floating / draggable / resizable / scroll-resistant / geometry-persisted / **document-agnostic**
  chrome is now [src/panel.js](src/panel.js) (`createPanel`); the Tile inspector is its first tenant
  (behavior-preserving). The shared shell the catalog (and future pop-outs) build on. *(Mechanics in
  notes_and_status.md.)*
- **Phase B — patch identity on the lane + the editor's Save/Load — BUILT (2026-07-06)** *(the core
  value)*: the user-global patch store ([src/patches.js](src/patches.js), factory `Init` per kind + user
  tier, id-keyed); lane/grid patches carry originId/originName/dirty; the instrument pane gained a Patch
  bar (inline-rename + Save / Save As / Load); lane-head rework (two-line Instrument/Patch(`*`),
  double-click → editor, Edit button removed); Save = overwrite-or-fork by whether-the-name-changed, with
  sibling `*` propagation. Delete/true-Rename deferred to C. Mechanics in notes_and_status.md;
  `notch/patches.mjs`. *The "desperately needed" step — name, recall, and see-when-changed.*
- **Phase C — the patch catalog window — BUILT (2026-07-06)** *(browse + apply + manage)*:
  [src/catalog.js](src/catalog.js), a panel.js tenant opened from the instrument pane — kind → patch
  (all instruments), **live name search**, **double-click = apply to the current target** (cross-kind
  aware), **Rename / Delete** of user patches (factory read-only). Plus the **`imported` flag** (`[I]`,
  set on project-file Open; a local delete detaches linkers to `Name*`, not `[I]`), the **name-collision
  dialog** (Save / Rename / Cancel — we discourage silent duplicates), and true in-place **Rename**
  (display derives from the entry when clean, so it propagates). Mechanics in notes_and_status.md;
  `notch/patches.mjs`.
- **Phase D — organize at scale**: group (one path) + tags (many) on patches; the window gains the tree,
  tag facets, and live search.
- **Phase E — drag-to-apply**: drag a patch onto a lane head / the pane target chip, reusing the tile-drag
  ghost.
- **Deferred (explicitly out):** rack instruments (+ their catalog + lane indicator), patch auditioning
  (parked as above), Factory-Save tooling, pop-out-into-OS-window, catalog file export/import,
  virtualization for huge lists.

**Cost.** Pure model + UI + a small persisted store — no WASM, no new sound-generating code.

---

## Cross-cutting enablers

Three investments that several directions draw on — worth building deliberately rather than
ad hoc inside one feature.

1. **The unified "playable material" abstraction** (drives 1; the emission target for 3
   and 6). One interface that flattens to notes at an offset, with a **leaf = `Pattern`** and
   a **node = `Arrangement` fragment**, both living in the registry with reference/naming/
   parking. Recursion in `arrangementScore`. This is the single biggest structural lever;
   most of the interesting directions either *are* it or *emit* it.

2. **One DSP worklet investment** (shared by 2, the second phase of 5, and voice 8). Independent
   pitch-shift / time-stretch / spectral is the "one real gap" where native Web Audio quality
   is poor. Build it **once** as an AudioWorklet (Faust → worklet is the best-fit path noted
   in the wishlist; plain-JS FFT is viable for *offline* drone bakes). Don't solve it twice
   inside the sampler and PaulStretch separately. The **plucked voice (8) is the smallest first
   customer** — a self-contained Karplus-Strong kernel is a low-risk way to stand the worklet
   seam up before the harder spectral DSP leans on it.

3. **The pure generator/transform pattern — already established.**
   [src/random.js](src/random.js) (generator) and [src/transforms.js](src/transforms.js)
   (per-tile transform) are the templates: data-in/data-out, injectable rng, headless-tested
   in [notch/](notch/). The beat generator (3), the serial transforms / Hanon engine (6), and
   the note-transform "MIDI-filter" family all follow this mold — no new architecture, just
   more pure functions beside the existing pipeline.

Standing enabler already on the books: the **context-parametric `AudioEngine`** (used for
offline WAV bounce) is the same seam self-bounce drones (2) and any offline rendering want.

---

## Sequencing (a recommended path)

**Near-term progress (as of 2026-07):** (0a) **octatonic + whole-tone + augmented masks** — **DONE**,
part of (0b). (0b) the **scale-mask library is BUILT** (full 12-ET palette); the **monophonic
scale-space features** (projection, evolving transposition — 11) remain and ship without polyphony.
(0c) the **grid-editor overhaul (7)** — the **performance lanes are BUILT** (Phases 1–2: the
duration/accent/articulation groove lanes + the **notes lane + arm-then-drag selective swap**), and
New Random grew groove-aware **Duration/Accent bias** (steer-vs-sort). The remaining big piece is the
**notes-list refactor** (Phase 3) → the four "basic improvements" (chord entry · note-length drag
incl. gate>1 · velocity/expression editing · selection ergonomics), then the named-articulation seam
and the instrument responsiveness pass. Scale-step **harmonization** (11) and the multi-sound drum
track (3b) fall in right after 7.

Then, ordered by *leverage per unit cost*, respecting the dependency edges above:

1. **Subsequences (1)** — pure model, no WASM, and it's the emission target for 3 and 6 and
   the scoping model for multi-window panes. Keystone; do it first among the *structural* items.
2. **PadSynth / analog synths (4, 10)** — cheapest big instruments (native, no WASM). PadSynth
   reuses the wave-cache; the **poly analog** fits the current voice model as-is; the **mono
   analog** adds glide (pairs with 7's legato). Quick wins between larger efforts.
3. **Polyphony + expression (7)** — the deep migration; unblocks harmonization (11), the
   multi-sound drum track (3), and richer MIDI export. Version the format. *(Pulled early in the
   near-term list above because the grid overhaul is what the user wants to work on next.)*
4. **Beat generator (3)** — phase (a) the pure generator/mutator can actually come *earlier*
   (it only needs layered Boshwick lanes); phase (b) the true multi-sound track waits on 7.
5. **Sample player (5), phase 1** — native pool/slicer/clips/zip; the on-brand line-crossing,
   self-contained via packaging.
6. **Etuderator (6)** — serial-transform primitives emitting subsequences (needs 1);
   integer/interval notation to start.
7. **Plucked voice (8)** — slots in wherever a fresh instrument is wanted, but note it's the
   **natural first AudioWorklet**: a small, contained Karplus-Strong kernel that stands the
   worklet seam up before the spectral DSP below leans on it. Can come early as the muscle-builder.
8. **DSP worklet → PaulStretch (2) + sampler phase 2 (5)** — the shared worklet investment,
   cashed in for independent pitch/time and drones (the worklet already exists from 8). Or bring
   the *self-bounce granular/offline* drone forward if you want a drone bed sooner.

None of 1–6 require WASM, and even 8's worklet is plain JS (no build step). The only genuinely
WASM-flavored work is the spectral DSP in item 8-of-sequencing above, and even there the offline
drone path has a plain-JS fallback.

<!-- add below -->

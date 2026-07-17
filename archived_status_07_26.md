# Archived status — July 2026

Historical detail pruned out of [notes_and_status.md](notes_and_status.md): the *how we got
here* — rationale, rejected alternatives, debug war-stories, phase-by-phase build logs, and
already-fixed bugs. The **current** state of each feature lives in notes & status; this file is
the record, not a document a new-session agent needs to read. Hard-won *don't-do-this-again*
lessons were lifted into the "Gotchas" section of notes & status (and may also appear here in
their original context).

Entries keep their original inline `(YYYY-MM-DD)` timestamps and are filed under the ISO week
(Mon–Sun) in which the work was done. Undated background material sits in its own section.

---

## Undated / background

_(historical / background material with no inline timestamp)_

**Vesperia editor — defaults reproduce the prior sound.** When the fixed voice became a patch-driven
editor, the defaults were tuned to reproduce the original sound in the central register (e.g. A4's
filter sweep is identical, 1760 → 4842 Hz). The one intentional difference: the old per-note cutoff
floors/ceilings (guard clamps) are gone, replaced by continuous Key Track — so the bass can open
darker and the treble brighter than the old fixed clamps allowed. Timbre's energy-normalization: the
raw `k^e` tilt swelled the summed partials ~+24 dB at full-bright (a loudness slider); each note's
tilted mix is now scaled by `sqrt(E_neutral/E_tilted)` so total energy matches neutral (0.5 stays
bit-identical; RMS across the travel sits in a ~4 dB window). [Lesson lifted to Gotchas.]

### Instrument voices — build history, rationale & implementation detail

**Zindel — formulas.** Modulation: FM index `modulation × 8`, `modGain = index × modFreq` (so
brightness is constant across pitch). Spread: `mult(k)=1+(k−1)(1+spread)` (0 = pure harmonic).
Acceleration: `ts=1/(1+accel·(k−1))` (upper partials run the envelope faster). Factory default is
Hammond-ish: full fundamental + octave, a touch of 3rd & 5th, slightly percussive onset. Levels
tunable by ear.

**Wendelhorn — details & the "ensemble does nothing unless you detune" fix.** Random start phase is
baked into per-context `PeriodicWave`s because Web Audio oscillators can't be re-phased, so
identical saws would beat coherently; rotating each wave's harmonic phases decorrelates them. Detune
spacing = Szabo's irregular positions (the JP-8000 reverse-engineering); the side saws swell in as
Detune opens (center stays ~constant). Ensemble's uneven pitch LFO: outer saws swing most, center
least, all move. It **lifts the side saws to an audible floor** so the drift is heard *at any
Detune* — the fix for "ensemble does nothing unless you detune": at low detune the Szabo mix had
silenced the very saws being modulated. Speed = LFO rate 0.1–5 Hz (log), ±15% rate spread; shared
3-LFO pool (each saw taps one) → 10 osc/note. Stereo is a source-level M/S widen (no M/S matrix —
done on the saws, cheap and mono-safe): even pan spread by index (flat → left, sharp → right, inner
saws pushed out) plus a center-saw ("Mid") scoop gated by side energy, so a near-mono sound is never
hollowed out. Pitch blip: τ = time/4 over a log 10 ms–1 s window, scheduled on each saw's detune,
summing with the ensemble LFO. Levels tunable by ear.

**Tervik — details.** Effective ratio clamped to `[1/16, 17]`. Modulator depth = index × its own
frequency, `index = Level × TERVIK_MAX_INDEX` (the Zindel brightness-constant trick). Follow Op 1:
one Level slider serves both roles (the user's scheme). Feedback is a cheap stand-in for true
operator feedback — Op 1 stays sine; blended `PeriodicWave`s cached per context. Default = a DX-style
electric piano: Op 3 at 14:1 with a fast-decaying index (the metallic "tine") over a 1:1 body.
Introduced the editor's enum/`select` (Algorithm dropdown), stepped-list slider (Coarse), and knob
(Fine, reusing `makeKnob`'s detent + double-click-reset) param types. v1: when Follow is on, that
op's own A/D/S/R sliders stay visible but inert (graying-out is a fast follow-up if wanted).

**Nayumi — v1 decisions, soprano rounding & the "too white/sizzly" fix.** ARR1 famously reads as a
blown bottle; the design leans into that ambiguity. Carrier harmonics `1/h^1.1` (slightly softer than
a saw). Bit-crush `oversample:'none'` so the aliasing reads; gated off at grit 0. v1 decisions (user):
WaveShaper grit (not an AudioWorklet decimator — fast-follow if the grain isn't enough); no unison
(single carrier; lean on the existing chorus insert for choir width); 3 formants.
- *Soprano rounding:* high notes got harsh because fixed formants ring on sparse harmonics (a high-Q
  bandpass with no harmonic under it screeches). Real sopranos do formant tuning — raise F1 onto the
  fundamental, vowels dissolve to a pure tone. Modelled per vowel off `r = f0/F1`: below `R0` (0.6)
  nothing happens (low/mid untouched; Soprano 0 = no change anywhere, fully back-compat), then by
  `t = engage × soprano` the F1 bandpass tunes onto f0, F2/F3 fade out, breath rolls off (folded into
  `t`), the source darkens a touch. User: favour smooth over vowel identity up high (full dissolve).
- *Pink noise + band-limited grit (the "too white/sizzly" fix):* the breath buffer is pink (Paul
  Kellet's filter baked into the per-context buffer fill — the natural breath spectrum, far less
  white sizzle than flat noise). The bit-crush gained a grit-tracked post-crush lowpass (≈11 kHz →
  5.5 kHz as Grit rises) — the bandwidth ceiling that turns raw quantization fizz into warm lo-fi (the
  CMI low-sample-rate move). Crush still hits the whole mix (one cohesive grain); the lowpass tames it.

**Boshwick — topologies, metering, kick rework, and the rejected preverb.** Monotimbral per the
user's call. Per-type topologies over a shared knob set (the Tervik `sel`-swaps-DSP + inert-param
precedent — no pane change): pitched body + downward pitch-env (kick=sine, tom=triangle); two shell
tones + bandpassed noise (snare, Snap = noise↔body); inharmonic 6-square cluster → highpass
(hat/cymbal — the 808 metallic fingerprint); two squares → bandpass (cowbell); 3-burst-plus-tail
bandpassed noise (clap); short pitched click (rim = +noise tick, clave = lone sine). Hat/Cymbal choke
at note-off (cross-note choke groups deferred). Per-context white-noise buffer + `boshEnv`
(instant-attack exp-decay, optional gated choke) in audio.js; cheap, short-lived voices. All
level/centre/ratio constants by-ear tunable.
- *Levels set by headless metering (user: "way too soft").* A sample-accurate Web Audio simulator
  ([notch/wasim.mjs](notch/wasim.mjs): scheduled AudioParams incl. setTarget/exp-ramp semantics,
  sine/tri/square oscillators, RBJ biquads, looping noise buffers, pull-based DAG render) renders each
  default drum and meters peak/RMS against a default Vesperia note (`meter-bosh.mjs`). This exposed a
  real bug: hat/cymbal/cowbell applied `peak` twice (sources scaled ×peak AND the bus envelope ramped
  to peak → peak², ~−20 dB) — their envelopes now ramp to 1 (shape only). [Lesson lifted to Gotchas.]
  Remaining per-topology filter losses (a hat's ~8 kHz highpass swallows most of its 540 Hz-based
  square cluster) are equalized by a measured `BOSH_LVL` per-type trim map: every drum's rendered peak
  ≈ the Vesperia reference peak, +2 dB for the click-length hits (clap/rim/clave — equal peak reads
  softer that short). Noise-based drums wobble ~±1 dB between renders (fresh random buffer per context).
- *Kick reworked for variability + snap* (user: "needs more variability and definitely more click/snap
  potential"; kick split from the tom branch, tom untouched). Tone = body drive: a soft-clip
  `tanh(d·x)/tanh(d)` WaveShaper between the ±1 sine and the level envelope (unit-peak, so levels stay
  anchored; drive tapered `tone²×6` so the lower half is warmth not fuzz; cached per context like
  Nayumi's crush; Tone 0 skips the node — bit-clean sub). This fulfils Tone's original "body harmonics"
  tooltip, which the old kick never implemented. Punch = a two-part attack: an oscillator sweep spike
  (+5× on top of the main sweep, collapsing in ~4 ms — the 808 "knock") + a beater noise click scaling
  to 1.1×peak with a tighter 8 ms decay (the 909 snap). Pitch Env opened up: depth to ~9× (was 3×),
  sweep time to ~140 ms (was 75). `BOSH_LVL.kick` re-trimmed 1.25 → 0.95 (metered; the stronger default
  click had pushed +2.4 dB).
- *Preverb: considered and REJECTED.* User noticed a ~10–20 ms lead-in on 808 samples auditioned
  online. Analysis: a real TR-808 emits nothing pre-trigger; tape print-through / vinyl pre-echo are
  ~0.5–2 s early (not tens of ms); the tens-of-ms smear is most plausibly MP3/AAC codec pre-echo
  (transient quantization noise spread across the ~13–26 ms codec block — the user's own suspicion),
  linear-phase pre-ringing, or sample-pack design. Decided not to emulate an encoding artifact. **Kept
  for the future** (user flagged it as clever/useful): the **pre-beat scheduling** technique — schedule
  lead-in audio at `time − preT` so the hit stays on the grid and the lead-in eats into the previous
  beat (works because the scheduler commits whole cycles ahead and playback starts at now+100 ms; clamp
  at audition/t=0). Useful for swells, grace notes, reverse builds.

---

### Wishlist sections pruned from notes & status (2026-07-08)

The tail's forward-looking wishlist moved to its proper home in future_directions.md or was retired
as built/obsolete:
- **Potential directions** (an older near-term jotting) — superseded by future_directions.md.
- **12-tone exercises & études** — now owned by future_directions §6 (Fuguenator/Etuderator).
- **Rhythm overlays** — the duration-template idea is effectively built (performance lanes); the
  named-groove / clave / step-pattern / 808-notation speculation moved to future_directions §3.
- **Counterpoint aids** — the A/B audition is built (the Reference backdrop); the Fuguenator
  companion-voice generation moved to §6, the two-voice consonance/parallels analysis to §16.
- **Triad identification & operations** — the ratio-based chord finder + triad-object ops fold into
  future_directions §15c.
- **Purpose & wishlist concrete wants** (show used rows / interactive harmonic analysis / arpeggiator):
  used-rows is seeded (grid highlights), harmonic analysis is the Triadulator + §15c, the arpeggiator
  moved to §19 (Note attributes). **How this maps to the architecture** (the grid is a 12×12 twelve-tone
  matrix; analysis/generation as pure data-in/out functions over a Pattern) is retired as background.
- **Sound ("can this sound good?")** — largely built (Vesperia edit pane, multi-instrument registry,
  per-lane voices). The bridges, for the record: (1) MIDI export → DAW VSTs; (2) Web MIDI out → virtual
  cable (loopMIDI) → DAW live (Chromium-only); (3) in-app WASM/AudioWorklet (Faust best fit, Csound,
  WebPd, soundfont/SFZ). Still wanted: tuning-matched `PARTIALS` per Sethares.
- **Record the audio output** — Path B (offline → WAV) is built as Export Audio; Path A (live
  MediaRecorder capture, WebM/Opus in Firefox) remains an option if wanted.
- **Audio effects** — delay / chorus / reverb are built (per-lane inserts). The one real native gap
  stays pitch-shift / time-stretch / spectral (want an AudioWorklet/WASM). Design fork noted: inserts
  per-instrument (delay/chorus/drive) vs. reverb as a shared send bus.
- **MIDI-filter note-transform tools** — moved to future_directions §19 (Note attributes).

### Microtonal pitch sets (7-limit) — the full design discussion (archived 2026-07-08)

Kept for the record (7-limit and many other tunings will be built; the platform design now lives in
future_directions §15).

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

---

## 2026-06-29 – 07-05

**Arrangement-undo overwriting the sound layer — fix (2026-07-05).** Previously only the *patch*
live-carried across a tile undo/redo; **reverb was dropped entirely** and delay/chorus/mods were
snapshot-restored, so any undo past the point they were set wiped/reverted the effects. The fix
extends the live-carry treatment to the whole **sound layer** (patch + delay + chorus + reverb +
`modsByKind`), snapshot-restoring only on a `full` entry (lane/player reset) or when a lane reappears
on redo. (The effect/mod modals still bracket an undo entry via the mix bracket; with live-carry that
entry is a harmless no-op for the sound settings — mixer gain/pan stays genuinely undoable.)

**Grid overhaul — performance lanes / attribute rack (2026-07-04).** Built in phases (the current
behavior is in notes & status):
- *Phase 1:* rhythm ⊥ pitch — duration moved off note-clicks into a per-column footer band (`FOOTER_H`;
  color = value + numeric backup; same column geometry as the body). Nomenclature (user): footer lanes =
  "performance lanes" (X-axis lanes); the cell where a column meets a lane = a "lane chit."
- *Phase 2:* added ACCENT and ARTICULATION lanes below duration (`PERF_LANES` stack; shared
  `_drawChit`/`_laneAt`; gutter labels). Articulation chit colors: violet = spiccato, warm = tenuto>1,
  teal else. Spiccato is tempo/duration-independent, capped at the slot.
- *NOTES lane + arm-then-drag selective swap:* a 4th lane on top (nearest the grid), gray handle, no
  text — completes the attribute rack. The swap model evolved "simple → arming": earlier an any-chit drag
  swapped the WHOLE column (`swapColumn`); now `swapLanes` exchanges only the armed lanes, driven by
  `LANE_FIELDS`. Single/double-click disambiguation uses optimistic feedback + a deferred undo entry: a
  held single-click edit rolls back if a 2nd click arrives within `DBL_MS`. `grid.pattern =` is now an
  accessor that flushes a held click against the OLD pattern before a switch. User decisions
  (2026-07-04): notes on top, gray, no text; arm within a single column; "double click to arm is fine for
  now"; moving a note onto an existing note (poly) just moves + dedupes. `notch/footer.mjs` 13/13 → 45/45.
- *Stretch view:* width-changing drags used to **oscillate** — fixed by computing the drop target against
  the pristine pre-drag layout (a live-swapped layout shifted the columns out from under the cursor and
  made the target flip-flop). Pure UI/gesture refactor — `durIndex`/`accent` were already column fields,
  so no model/format change.
- *Grid + performance-lane scale-up (2026-07-04):* canvas bumped ~120% (`ROW_H` 24→29, `UNIFORM_COL_W`
  40→48, Stretch band 26–60→31–72px, `DOT_R` 7→8, pitch labels 11→13px; toolbars untouched). Chits taller
  ~1.5× (`PERF_LANES` notes 18→27 / dur 20→30 / acc 16→24 / art 16→24); chit fonts grew (dur numeric 12px,
  accent glyph 13px, artic label 11px). Gutter labels bumped from faint 9px `#6a7280` to bold 12px
  `#aeb8c6`. (User: "eyeballing 120% will do"; chit height "50% increase … might or might not be enough";
  labels "too subtle … incredibly small".)

**New Random — rework + bias mechanism (2026-07-04).** (Current behavior in notes & status.) Reworked to
regenerate over the current grid's rhythm rather than minting a blank at the brush duration; the old
"Clear first" gating removed (in-place vs a 3-way Replace-All/New-Pattern dialog when referenced; split
into `openRandomModal`/`openReplaceChoice`/`runRandomModal(mode)` + `tileRefCount`); auto-roll on open.
**Duration/Accent Bias — STEER vs SORT:** the post-hoc re-pairing "sort" (`applyDurationBias`/
`applyAccentBias` via `rankBias`) **scrambles arpeggios** — it reorders the whole sequence, wiping the
Run/Triad contour that makes arpeggiated-chord ostinatos. So each bias defaults to **STEER**: bake the
pull into generation (`generateRandom`'s `bias` param → `biasTargets`/`biasedPick`), weighting the
otherwise-uniform pick — Triad character survives (bias chooses among chord-completions; a forced triad
wins) and Runs stay intact (deterministic picks bias never touches). Weighting `exp(BIAS_SHARP·strength·
align)` (BIAS_SHARP≈3.2), stochastic even at max (user's requirement), subsumes the sort (Run/Triad 0 →
same global correlation). Duration ties break by the GENERATED pitch order (within-group variety). Accent
"loudness" ranks ghost < normal < accent by sounded velocity. **First-cut bug:** wrongly shuffled the
accents around the columns — user: "it's moving columns around … the bias moves the NOTES"; corrected to
re-pair pitches. `random.mjs` 52/52.

**Tile player — the July 3–5 build-out (2026-07-03/04/05).** (Current behavior in notes & status.)
- *Multi-select replaced the brushes (2026-07-04).* Transforms were "brushes" (armed, one-shot,
  Shift-to-stay, path-exact sweep hit-testing via `segmentHits`/Liang–Barsky) before multi-select
  existed — user: "we implemented brush because we didn't have multi-select… remove the brush feature
  entirely." Removed with them: arming, the paint-gesture Esc path, `segmentHits`, the painted-tile
  highlight, the clone-brush dedup map. Losses accepted: cross-lane sweeps (one-lane selection) and
  scattered painting (now Ctrl-click). Selection mutators headless-tested; block-ops planners
  `notch/blockops.mjs` 23. The Repeat fill-handle was chosen over shift-drag / a one-shot button
  ("Cubase kinda sorta does the handle thing" — user).
- *Transpose Scale menu (2026-07-05):* was a frozen 4-item list → filled from `scalesFor(edo)` per the
  selected tile. Root-clamp fix — `transposeTransform` clamped the snapshotted root `% 12`, corrupting
  roots ≥ 12 in 16-ET; it now stores the raw integer and lets `inScale` reduce by the right EDO
  (`edo.mjs`).
- *Drop position settled (2026-07-03) after two failed experiments:* drop-at-floor(pointer), then
  caret+drop both at round(pointer) — each made the drop ignore the carried tile's position. Resolved
  with the MODAL caret (carry mode marks the landing's left edge; drops keep grip/centered math). "the
  ghost/drop was working correctly before… what needs to change is the caret" — user.
- *Range edits (2026-07-03):* `rangeops.mjs` 23/23; suite 446.
- *Anti-scroll fixes (2026-07-03/04):* page scroll-anchoring adjusted the page on canvas resize ("the
  pane scrolls itself back") → `overflow-anchor: none` + skip same-value canvas width/height writes;
  residual layout-shift jumps (roll height following pitch span on score swap) → the roll's fixed-height
  400 px internal-scroll viewport. [Now under the Scroll gotcha.]
- *Perf pass for long projects (2026-07-03):* ruler tiled (was a full-width per-render canvas that made
  scrolling crawl / would hit canvas caps), thumbnail cache, delta playback updates, page-jump
  auto-follow, edge auto-scroll, and scroll-no-longer-resets-on-rebuild (the innerHTML wipe clamped
  `scrollLeft` to 0 — user: "scrolls back to the beginning a lot, especially on stop"). Held in reserve:
  keyed reconciliation of `render()` instead of the innerHTML wipe. Stacking fix: `.tile` `z-index:0`,
  `.tile-playhead` z 5→2.

**Articulation applied in playback — fix.** The scheduler now shortens each note to
`note.duration * articulation * spb` (captured per cycle in `_beginCycle`), so the slightly non-legato
default is audible — and MIDI export (which also applies ×articulation) matches playback. (Later
superseded by per-column `artDur`.)

---

## 2026-07-06 – 07-12

**Patch catalog — phased build (2026-07-06).** The current catalog is described in notes & status;
this is the build log.
- *Phase B* — the store + Patch bar + lane-head rework. Introduced the id-keyed named-patch model
  (`PatchStore`, `{id,name,kind,params,factory}`), user-global `notorolla.patches`, per-lane/grid
  `patchOriginId`/`patchName`/`patchDirty`, and the editor Patch bar (Save/Save As/Load). Lane-head
  rework: the old **Edit button was removed** in favor of a two-line Instrument / Patch block with
  **double-click → editor on that lane**. On an overwrite, other lanes holding an independent copy of
  that entry (same id, clean) go `*` via `markSiblingsDirty` (they don't re-sound; rack sharing later
  would). Save-with-a-changed-name = a NEW patch (true rename + Delete were deferred to C). Migration:
  legacy lanes (no identity) → their kind's Init marked dirty → `Init*`; the dirty baseline absorbs the
  migrated identity. `notch/patches.mjs` (30). Verified in-browser (Chrome/Playwright): edit→`Init*`,
  Save→named+clean, edit→`Name*`, Load recalls, per-lane dirty isolation.
- *Phase C* — the catalog **window** ([src/catalog.js](src/catalog.js)) + "Catalog" button. Made the
  `imported [I]` flag explicit (a bool set on project-file Open, not inferred from id-resolution;
  display composes `name + (dirty?'*') + (imported?' [I]')`). A local Delete of an in-use patch detaches
  linkers to `Name*` (keeps the name, not `[I]` — deleted deliberately); only a file Open ever mints
  `[I]`. True in-place Rename (`renamePatchEntry`) keeps the id and propagates to clean linkers. Name
  collisions with a user patch open a Save/Rename/Cancel dialog (`openNameCollision`); factory names
  auto-uniquify. Add-to-catalog for an imported patch = just Save it. `notch/patches.mjs` (35). Verified
  in-browser: catalog lists 6 factory Inits, search filters, Save adds a patch, cross-kind double-click
  apply, collision dialog fires on a duplicate name, Delete → `Pad1*`.

**"Cross" tuning — model decisions & tests (2026-07-06).** (Current behavior in notes & status.) Model
decisions (user, all confirmed): scale-first bespoke list, not the general `{anchor,generators,range}`
engine yet; keep comma-pairs; equal-size rows on the grid (the roll stays log-frequency proportional, so
the ~14–90¢ comma-pairs read as tiny gaps there); Chromatic-only mask; root/anchor always middle C (a
general convention now — *ask* when a specific anchor decision arises). `crossFreq` clamps out-of-range
degrees to the endpoints so the `degreeBounds`/`nearestDegreeToFreq` scans stay monotone. `notch/cross.mjs`
**21/21** (anchor at deg 60, monotonic in-range, contains 6/5 & 4/3 both directions, comma-pairs retained,
A0..C8 resolves, open octave, equave flags, `D#4 +16` label); full suite green; 12-ET/JI/16-ET paths
unchanged (edo/tuning2/scales3/triads4 still green).

**Reference backdrop — details & bugs (2026-07-08).** (Current behavior in notes & status.) The
transform is kept first-class (stored separate from the columns, applied on use — always on now,
`referenceScore`). Ghost dots are centred on their own span like real notes; the merged-time layout is
unified and pixel-identical with no reference (Stretch = merge with nothing). `notch/reflayout.mjs`
**45/45**, `notch/reference.mjs` **30/30** (full suite green). Two bugs fixed same day: (1) the tile
selection was cleared before Set Reference read it — the grid pane's `pointerdown` handler runs
`setActive('grid')` (→ `clearSelection`) on button PRESS, disabling the button before its `click` could
fire; Set Reference now fires on `pointerdown`, which reaches the button before that ancestor handler.
[Lesson lifted to Gotchas.] (2) `onToolbarChange` also snapshots the selection before its own
`setActive('grid')`.

**New Random — Range slider + back/redo history (2026-07-06).** (Current behavior in notes & status.)
`windowSize = range || count` in `generateRandom`. Full run (|run|=1) became an even monotonic staircase
across the pool (`runStaircase`) — the sorted window when range==count, evenly-repeating steps when range
< count (fixing the ramp-then-flat-top the user flagged), evenly-spaced when range > count. The `<`/`>`
history is an ephemeral per-session linear stack of `{columns, settings}`: every Randomize (incl. the
auto-roll = state 0) pushes, nav restores that snapshot's pattern AND sliders, a fresh roll truncates
forward history, disabled at the ends, soft cap 500; Reset and plain slider/checkbox moves don't touch
the stack. **Sort demoted** to a plain setting — toggling it no longer re-rolls (nothing but Randomize /
nav touches the grid now). `notch/random.mjs` 64. Verified in-browser (Chrome/Playwright): range readout,
exact pattern+settings restore on back/redo, nav enable/disable sequence, Sort-no-reroll.

**Tile player / inspector — July 6 items (2026-07-06).** (Current behavior in notes & status.)
- *Modeless-pane primitive extracted (Patch Catalog Phase A):* `createPanel` factored out of the
  inspector; the inspector is its first tenant (behavior-preserving; smoke 34/34). CSS `.inspector*` →
  `.panel*`. Border QoL: a clearer 2px `#4a5670` (up from 1px `#2a3040`).
- *Tile Inspector rename:* `notch/label.mjs` 7; smoke 34/34. The window-scroll restore in
  `TilePlayer.render()` must run BEFORE `_flip` measures client rects — placed after, FLIP read the
  "after" positions while the page was still clamped from the innerHTML wipe and animated a bogus
  vertical delta (a jerk/bounce on tile pickup and drag-across-row). Order fixed.
- *Repeat fill-handle went bidirectional:* the one right-edge grip goes both ways (drag left through/past
  the block for left copies, `k<0`); `planRepeat` takes a signed k; blockops covers left stamps + the
  beat-0 clamp.
- *"+ Lane" button reworked:* a pinned, lane-head-width enclosure (was a tiny 22×20 "+" that slid off on
  h-scroll).

**Known limitations — stale entries pruned (2026-07-10).** A doc-hygiene pass (during the
control-skin handoff prep) removed standing-gap entries from notes & status that had quietly
closed as features landed:

- *"Save / pattern browser not built; localStorage is a stand-in"* — closed by the **project
  document layer** (versioned save/load, file format v1: Save / Open / New + dirty tracking;
  `core/project.js` + `app/projectio.js`), the **PatternLibrary** (named patterns + parking),
  and the **Patch Catalog** (Phases A–C).
- *"Microtones / alternate scales not built (the tuning seam is ready for them)"* — closed by
  the tuning seam's real implementations (**Just intonation, 16-ET**, the non-octave **"cross"
  tuning** with per-tuning naming/equave) and the **per-EDO scale-mask library**
  (`core/scales.js`: modes, harmonic/melodic minor, blues, the symmetric scales).
- *Lane controls listing "volume, naming, per-lane instrument" as deferred* — per-lane
  **gain + pan** (lane-head knobs feeding the stereo mixer strips) and **per-lane instrument
  with patch identity** are in; only **removing lanes** and lane **naming** remain (tracked in
  Deferred work / TODO).
- *"MIDI not wired"* — **Export to MIDI (SMF Format 1)** is built; the limitations entry now
  names the actual gap (live MIDI I/O, deferred by decision).

**Control-skin integration handoff — the executed plan (written 2026-07-10, done 2026-07-11/12).**
(Current state — the integrated skin + the retained exhibits — is in notes & status.) The mockup phase
finished 2026-07-09/10: all seven instruments got a composer-signed exhibit in `future/ui_skin/`
("looks great" throughout; drawbar tabs "done"; Padlington 1.3 "TERRIFIC"). Integration was a two-step,
**zero-DSP** job:
- *Step 1 — the common-clusters pane refactor* ([ui/instrumentpane.js](src/js/ui/instrumentpane.js);
  future_directions §13): every kind assembles from shared param-group builders (`ampEnvelopeParams()`,
  `lowpassParams()`, `pitchAtkParams()`, `stereoParams()`, …) in the canonical role order, hue = role.
  Each exhibit's group/subgroup mapping ported verbatim: Vesperia = Oscillator[Timbre] · Filter[Lowpass]
  · Envelope[Amplitude]; Zindel = Oscillator[Drawbars · Tone] · Motion(green filter-role)[Acceleration] ·
  Envelope; Wendelhorn = LFO[Ensemble] · Oscillator[Saws · Pitch] · Filter[Lowpass] · Envelope ·
  Effects[Stereo]; Tervik = Oscillator[Routing · Op 1·2·3] · Envelope[Env 1·2·3] (envelopes extracted;
  Follow → "1 → 2" copy buttons); Nayumi = LFO[Vibrato] · Oscillator[Voice · Breath] · Filter[Formant] ·
  Envelope; Boshwick = Oscillator[Voice · Pitch] · Tone(green filter-role)[Colour] · Envelope; Padlington
  = Oscillator[Source · Pad · Pitch] · Filter · Envelope · Effects[Stereo] (later extended 2026-07-12/13
  with Shape, and the Air + Formant subgroups → Source · Pad · Air · Formant · Pitch).
- *Step 2 — the real widgets* ([ui/vslider.js](src/js/ui/vslider.js), [ui/rotaryswitch.js](src/js/ui/rotaryswitch.js),
  drawbar tabs, toggles): vertical slider (uni + bipolar amber-detent tick, off-centre allowed); rotary
  switch (≤6 radial / >6 readout window); round knobs only in mixer strips; inert via `spec.inert(patch)`;
  wheel = coarse / tilt = fine; dblclick-to-type readouts; the pointerdown `preventDefault` + global
  `dragstart` block carried over (the canvas-drag-hijack fix). Scoped under `.instr-skin` in index.html.
Agreed editing upgrades folded in: dblclick-to-type readouts; **Tervik Fine** precision 2 → 3–4 decimals;
**typed values bypass detents** (the detent radius made |Tervik fine| < 0.06 unreachable by drag — the
PWM-beating range lived inside the snap zone); a per-param detent radius. Design laws locked during the
roster pass (2026-07-10) — bipolar-zero = amber detent tick; enums >6 → readout-window rotary (≤6 radial,
6 splits 3-left/3-right); a tone-shaper takes the green Filter slot without a biquad; live inert dimming
off any selector; drawbar tabs a distinct widget species — now live in the skin and in future_directions
§13 (the standing record). Still-open reserved items routed to future_directions §13: app-wide skin
spread; FM operator-diagram labels for Tervik's Algorithm rotary; app-wide UI-scale; per-instrument
identity; key-up-pluck envelope; plus minor mapping calls (Wendelhorn Detune placement, Stereo/Width box,
Nayumi Grit placement, Boshwick inert map / Snap placement).

## 2026-07-13 – 07-19

**Filter envelope — the fixed "strike" practice, OBSOLETE (2026-07-13).** Superseded by the single-ADSR
(Juno-60) model in which the filter cutoff tracks the amplitude ADSR (current behavior in notes & status;
shared `scheduleFilterEnv`). The OLD practice, in all three filtered voices (`audio.js` Vesperia /
Wendelhorn / Padlington): the cutoff was set to `base·2^filterEnv` at note onset and settled back to base
with a FIXED `FILTER_ENV_TAU = 0.10 s` time constant — independent of the amp envelope and the note
length, a fast percussive "strike over the ringing body." It had **no release stage**, and on a note
shorter than the attack the settle was scheduled *past* note-off (a duration-dependent inconsistency).
Consequence: **seconds-long filter sweeps were impossible** — the fixed ~0.5 s settle is what surfaced the
bug when the composer expected a slow sweep. It was never the intended design (that Vesperia envelope was
a pre-front-panel "Mary Had a Little Lamb" test tone, not a signed-off sound); "envelope tracking" is
meant to track a USER envelope, and the only user envelope today is the amp ADSR. Fix: the filter tracks
the amp ADSR scaled by `filterEnv` octaves (open→decay-to-sustain→release), `FILTER_ENV_TAU` deleted, the
three copy-pasted blocks converged on the shared helper. Pure play-time scheduling, so **no migration** —
existing patches keep their exact values and simply sound correct. `notch/padsynth.mjs` gained filter-env
stage coverage (open to peak / decay to sustain-cutoff / release to base / static at filterEnv 0 / short-note
clamp).

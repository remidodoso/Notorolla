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
  `degreeToName(degree, tuningId)` / `pitchClassName(pc, tuningId)`, plus `tuningFreq(degree, tuningId, root)`
  per pattern and **`edoOf(tuningId)`** — the **degrees-per-octave is a property of the tuning** (not a
  global constant), so the pitch-class logic (scales, triads, the grid's octave math) takes `edo` as a
  parameter. Tunings: **12-ET**, **Just (5-limit)**, and **16-ET** (`2^((d−60)/16)`, anchored so degree 60
  stays middle C; octave = 16 degrees; pitch-classes named in **hex `0–f`**). Naming is per-tuning (12-ET
  letters, non-12 hex); the grid renders octave-every-`edo`, drops black keys for non-12 (tints the class-0
  home row instead). **Scale masks are EDO-tagged** ([src/scales.js](src/scales.js) `scalesFor(edo)`): the
  picker shows Chromatic (universal) + the tuning's masks — 12-ET pentatonics, or 16-ET **Mavila[7]** `{0,2,4,6,9,11,13}`
  + Mavila pentatonic; switching tuning drops an out-of-EDO mask back to Chromatic. **Roll** still mirrors with
  12-ET-flavored black-key/octave cosmetics (notes sit at the right degree + sound correct; per-tuning roll
  shading is a deferred polish — it ties into mixed-tuning arrangements).

---

## File map

| File | Responsibility |
|---|---|
| [index.html](index.html) | Layout (transport bar + reorderable panes), all CSS |
| [src/model.js](src/model.js) | `Note`, `Score` (beats, tempo, articulation, explicit length), MIDI↔freq, note names, black-key test |
| [src/tuning.js](src/tuning.js) | row/degree → pitch/frequency seam; per-pattern `tuningFreq` + **`edoOf(tuningId)`** (degrees-per-octave is a tuning property); 12-ET / Just / **16-ET**; per-tuning `degreeToName`/`pitchClassName` (12-ET letters, non-12 hex) |
| [src/grid.js](src/grid.js) | `Pattern` (named; **per-pattern column count** = `columns.length`, `DEFAULT_COLS`/`MIN_COLS`/`MAX_COLS`, `Pattern.initial(name, cols)`), `DURATIONS`, `PALETTE`, `BASE_PITCH` |
| [src/library.js](src/library.js) | `PatternLibrary` (registry, naming, parking), `Arrangement` (lanes/tiles + per-lane mute/solo + `lane.gain`/`lane.pan`/`lane.patch`, play-region `playStart`/`playEnd`, `audibleLaneIds`), `LANE_COLORS` |
| [src/audio.js](src/audio.js) | `AudioEngine` — additive synth voice (`buildVoice`, context-parametric), per-lane patch resolution (`patchFor`), per-lane **stereo mixer strips** (volume→panner→**[chorus insert]→[delay insert]**→mute-gate; ordered insert chain via `_relink`; `setLaneVolume`/`setLaneGain`/`setLanePan`, `laneMix`, `applyLaneChorus`/`buildChorusInsert`, `applyLaneDelay`/`buildDelayInsert`), master limiter (`setupLimiter`) + fader (`setMasterGain`) + **stereo meter tap** (`getPeak`→`{l,r}`); `renderToBuffer` (offline **stereo** bounce, per-lane patch+mix+chorus+delay) |
| [src/instrument.js](src/instrument.js) | the **instrument registry** (`INSTRUMENTS`): per-kind defaults + `PARAMS` (editor metadata) for **Vesperia**, **Zindel**, **Wendelhorn**, **Tervik**, **Nayumi** & **Boshwick**; kind-aware `defaultPatch(kind)`, `normalizePatch` (numeric + boolean + enum/select + **stepped-list** params; Tervik legacy-ratio migration), `nearestStep`, `clonePatch`, `paramsFor`, slider mapping |
| [src/instrumentpane.js](src/instrumentpane.js) | `buildInstrumentPane` — the retargetable, **kind-aware** "Edit instrument" pane (instrument selector, body rebuilt per kind; slider / drawbar-fader / checkbox / dropdown / **stepped-list slider** / **knob** widgets; target chip, Test, Copy/Paste, Factory Reset) |
| [src/knob.js](src/knob.js) | `makeKnob` — click-vertical-drag rotary widget (detents, dbl-click reset, gesture-bracketed callbacks) + `PAN_MAP` / `GAIN_MAP` mixer mappings |
| [src/delay.js](src/delay.js) | per-lane delay config (`defaultDelay`/`normalizeDelay`, `DELAY_TIMES`/`DELAY_MODES`) + `buildDelayEditor` (modal form) |
| [src/chorus.js](src/chorus.js) | per-lane Juno-60 chorus config (`defaultChorus`/`normalizeChorus`, `CHORUS_MODES` = I/II/I+II) + `buildChorusEditor` (modal form; On + Mode only) |
| [src/modal.js](src/modal.js) | `openModal` — generic centered modal (Esc / backdrop / × to close, `onClose`) |
| [src/scheduler.js](src/scheduler.js) | lookahead scheduler, finite looping, per-cycle re-read (`onCycle`), mid-cycle tile reconciliation (`resync`) |
| [src/pianoroll.js](src/pianoroll.js) | `PianoRoll` canvas render + playhead; per-note color/alpha |
| [src/gridview.js](src/gridview.js) | `GridView` — grid editor (render + gestures + viewport + resize) |
| [src/tileplayer.js](src/tileplayer.js) | `TilePlayer` — multi-lane tile rendering + interaction; lane heads (instrument/Edit, Pan/Gain knobs, M/S); beat **ruler + play-region markers** (`_buildRuler`/`drawRuler`); per-tile transform swath; `tileAt` hit-test |
| [src/transforms.js](src/transforms.js) | per-tile **nondestructive** pattern transforms (pure): v1 scalar/chromatic **transpose** — `transformDegree`, `setTileTranspose`, `findTranspose`, `normalizeTransforms`, `describeTranspose` |
| [src/toolbar.js](src/toolbar.js) | grid toolbar (brush, pattern lifecycle, view toggles) |
| [src/panes.js](src/panes.js) | reorderable vertical panes, order persisted |
| [src/project.js](src/project.js) | versioned file envelope (`format`/`version`), migrate, save (download) / load (file read) helpers |
| [src/triads.js](src/triads.js) | Triadulator engine (pure): partition a pitch-class set into chords — families `trad` (maj/min/dim/aug) + `sus` (12-ET), `septimal` (16-ET: 4:5:7 `[0,5,13]`, supermajor `[0,6,13]`); `enumerateTriadulations(pcs, {families, edo})` / `classifyTriad(pcs, edo)`. Templates tagged by **EDO**, pools per-edo; `familiesFor(edo)`/`familyLabel` drive the per-tuning family toggles |
| [src/random.js](src/random.js) | New Random generator (pure): a contiguous in-scale degree window around the viewport centroid → random degrees, bent by Unique / Run / Triad settings; injectable rng |
| [src/mods.js](src/mods.js) | per-lane playback modulators: config model (`modsByKind`), waveform evaluation (`modWave` incl. value-noise walk), position-space patch application (`applyMods`), target filtering, and the modal editor |
| [src/midi.js](src/midi.js) | Standard MIDI File writer (pure): note data → bytes (Format 1, tempo, track names) |
| [src/wav.js](src/wav.js) | WAV encoder (pure): an `AudioBuffer` → 16-bit PCM RIFF bytes |
| [src/main.js](src/main.js) | wires everything; transport, undo, active pane, persistence, project save/load |

---

## What works today

### Sound — instruments (a registry of synth kinds, per-lane editable)
- **The Vesperia** — additive synth voice: ~6 sine partials, slight inharmonicity, an **ADSR**
  amplitude envelope + a **resonant lowpass** with its own envelope and keyboard tracking.
  Conservative per-voice level (`VOICE_PEAK`) into a transparent **master limiter** (see
  Transport & roll). Default articulation ~0.88 (slightly detached / non-legato).
- **Zindel** — a drawbar additive organ. **8 drawbar levels** (harmonics 1–8, shown as parallel
  vertical faders, **up = louder**) like Hammond drawbars, plus: **Modulation** (each partial is a
  **2-op FM stack** — a sine carrier with a 1:1 sine modulator; 0 = pure sine, up adds harmonic
  sidebands; FM index `modulation × 8`, `modGain = index × modFreq` so brightness is constant
  across pitch), **Spread** (stretches the partials off the integer harmonics —
  `mult(k)=1+(k−1)(1+spread)`, 0 = pure harmonic, + = inharmonic/bell), one **ADSR applied per
  partial**, and **Acceleration** (the *filter substitute*: upper partials run the envelope
  faster — `ts=1/(1+accel·(k−1))` — so they decay first and the tone darkens over time; there is
  **no biquad** on Zindel). Factory default = Hammond-ish (full fundamental + octave, a touch of
  3rd & 5th) with a slightly percussive onset. Levels scaled by `ZINDEL_NORM` (tunable by ear).
- **Wendelhorn** — a brass "supersaw" ensemble. **7 detuned band-limited saws** with **random
  start phase** (baked into per-context `PeriodicWave`s — Web Audio oscillators can't be re-phased,
  so identical saws would beat coherently; rotating each wave's harmonic phases decorrelates them).
  Detune spacing is **Szabo's irregular positions** (the JP-8000 reverse-engineering) and the side
  saws **swell in** as Detune opens (center stays ~constant). **Ensemble** = a slow chorus: an
  uneven pitch LFO (outer saws swing most, center least, all move; up to 50 cents) **and** it
  **lifts the side saws to an audible floor** so the drift is heard *at any Detune* (the fix for
  "ensemble does nothing unless you detune" — at low detune the Szabo mix had silenced the very
  saws being modulated). Ensemble 0 leaves the clean single-saw behavior intact. **Speed** = LFO
  rate 0.1–5 Hz (log), ±15% rate spread; **shared 3-LFO pool** (each saw taps one) → **10 osc/note**.
  **Stereo** = a **source-level M/S widen** (no M/S matrix — done on the saws, so it's cheap and
  **mono-safe**): an even pan spread by index (flat → left, sharp → right, inner saws pushed out)
  **plus** a center-saw (the on-tune "Mid") scoop **gated by side energy**, so width opens up where
  there's detune/ensemble to back it and a near-mono sound is never hollowed out. **Pitch Atk / Pitch Time** = the synth-brass pitch "blip": the
  note starts up to 200 cents sharp and **exp-decays to pitch** (τ = time/4) over a log 10 ms–1 s
  window (scheduled on each saw's detune, summing with the ensemble LFO; 0 cents = off). Into
  Vesperia's **resonant lowpass + filter envelope** (the brass swell) and a shared ADSR. Levels
  scaled by `WENDEL_NORM` (tunable by ear). (Future controls pass: a Cubase-style
  combined Width+Pan panner, user-requested.)
- **Tervik** — a lightweight **3-operator FM** synth (the cheap-polyphony / FM-complexity instrument):
  only **3 oscillators/voice**, so it's by far the cheapest voice. **Op 1 is always the final carrier**
  and its ADSR is the **reference/amp envelope**; a 4-way **Algorithm** selects how Ops 2 & 3 route —
  **Stack** (3→2→1), **Y** ((2+3)→1), **Pair** (3→2 · 1), **Parallel** (1·2·3) — as modulators (into
  another op's frequency) or extra carriers. Each op's **frequency ratio = Coarse + Fine**: Coarse snaps
  to exact values `[0.25, 0.5, 1, 2 … 16]` (so you can reliably land on integer/harmonic ratios — vital for
  FM), Fine is a ±1.0 knob (0 = exactly the coarse value, double-click resets; off-zero = inharmonic/bell);
  effective ratio clamped to `[1/16, 17]`. Each modulator's **depth = index × its own frequency**
  (`index = Level × TERVIK_MAX_INDEX`), so brightness stays even across pitch (the Zindel trick). Ops 2
  & 3 each have a **Follow Op 1** toggle: off = its own ADSR, on = shaped by Op 1's envelope with **Level
  as the "amount"** (one slider serves both — the user's scheme). **Feedback** morphs Ops 2 & 3 from sine
  toward a band-limited saw (a cheap stand-in for true operator feedback — Op 1 stays sine; blended
  `PeriodicWave`s cached per context). Default = a DX-style **electric piano** (Op 3 at 14:1 with a fast-
  decaying index = the metallic "tine" over a 1:1 body). Carriers summed, scaled by `TERVIK_NORM` (tunable).
  Introduced the editor's **enum/`select`** (Algorithm dropdown), **stepped-list slider** (Coarse) and
  **knob** (Fine, reusing `makeKnob`'s detent + double-click-reset) param types. v1: when Follow is on, that
  op's own A/D/S/R sliders stay visible but inert (graying-out is a fast follow-up if wanted).
- **Nayumi** — a **breathy formant "voice"** (oohs/ahhs) by **source–filter** synthesis, aimed at the
  **Fairlight ARR1** zone: a lush, *synthetic*, slightly grainy choir that can slide from a clear sung
  vowel toward a hollow "blown vessel" (ARR1 famously reads as a blown bottle — the design leans into that
  ambiguity). **Carrier** = a per-context **glottal-pulse `PeriodicWave`** (harmonics `1/h^1.1`, slightly
  softer than a saw); **male↔female is one `Size` knob that scales the formants**, not a different carrier.
  The carrier (through a **Brightness** lowpass) and **aspiration noise** both feed a **parallel 3-band
  bandpass formant bank** (`Vowel` = ooh/oh/ah/eh/ee select → F1/F2/F3 Hz, scaled by Size; `Resonance` =
  bandpass Q = vowel sharpness/hollowness); a little **air** noise high-passed bypasses the formants.
  **Breath** crossfades tone↔noise. The sum runs an optional **bit-crush** `WaveShaper` (`Grit` — the lo-fi
  Fairlight grain, `oversample:'none'` so the aliasing reads; gated off at grit 0) into one **soft-attack
  ADSR**. A **vibrato** sine LFO sways `carrier.detune` (cents) to keep held vowels alive. One looping
  white-noise buffer + the glottal wave + crush curves are **cached per context** (live + offline export).
  v1 decisions (user): **WaveShaper grit** (not an AudioWorklet decimator — fast-follow if the grain isn't
  enough), **no unison** (single carrier; lean on the existing chorus insert for choir width), **3 formants**.
  Heaviest voice (~17 nodes/note), so it's the polyphony-expensive one.
  - **Soprano rounding** (`soprano` knob, 0–1): high notes got harsh because fixed formants ring on sparse
    harmonics (a high-Q bandpass with no harmonic under it screeches). Real sopranos do **formant tuning** —
    raise F1 onto the fundamental, vowels dissolve to a pure tone. Modelled **per vowel** off `r = f0/F1`:
    below `R0` (0.6) nothing happens (low/mid untouched — *Soprano 0 also = no change anywhere*, fully
    back-compat), then by `t = engage × soprano` the **F1 bandpass tunes onto f0**, **F2/F3 fade out**,
    **breath rolls off** (folded into `t`), and the source **darkens** a touch. User: favour *smooth over
    vowel identity* up high (full dissolve), so high notes converge to a clean fluty "whistle".
  - **Pink noise + band-limited grit** (the "too white/sizzly" fix): the breath buffer is now **pink**
    (Paul Kellet's filter baked into the per-context buffer fill — the natural breath spectrum, far less
    white sizzle than flat noise). The bit-crush gained a **grit-tracked post-crush lowpass** (≈11 kHz →
    5.5 kHz as Grit rises) — the bandwidth ceiling that turns raw quantization fizz into warm lo-fi (the
    CMI low-sample-rate move). Crush still hits the whole mix (one cohesive grain); the lowpass tames it.
- **Boshwick** — a multipurpose **808-style percussion** synth (no samples; "Son of TR-808"). Monotimbral
  per the user's call — **one drum per lane, layer lanes for a kit**. A **`Type` select** (Kick / Tom /
  Snare / Hat / Clap / Cowbell / Rimshot / Clave / Cymbal) picks the **topology** over a shared knob set
  (the Tervik `sel`-swaps-DSP + inert-param precedent — no pane change): **pitched body + downward pitch-
  env** (kick=sine, tom=triangle), **two shell tones + bandpassed noise** (snare, Snap = noise↔body),
  **inharmonic 6-square cluster → highpass** (hat/cymbal — the 808 metallic fingerprint), **two squares →
  bandpass** (cowbell), **3-burst-plus-tail bandpassed noise** (clap), **short pitched click** (rim = +noise
  tick, clave = lone sine). All voices are **one-shot decays that ignore note duration** EXCEPT **Hat &
  Cymbal**, which are **duration-gated**: the amp decays over Decay but a fast **choke** is scheduled at
  note-off, so a *short* note = closed hat and a *long* note rings *open* (user: open HHs must understand
  duration; cross-note choke groups deferred). **Everything is pitch-trackable**: `hz = nominal × Tune
  (±1.5 oct) × (f0/C4)^PitchTrack` — **PitchTrack 1 (default)** = playable/melodic drums (and they follow
  the active tuning — microtonal toms free), **0** = a fixed drum on every row. **Accent (velocity) raises
  level and, just audibly, brightness** (filter cutoffs ×, user's ask). Shared knobs: Type · Tune ·
  PitchTrack · Decay (mapped to a per-type seconds range) · Punch (attack click) · Pitch Env (inert for
  noise/metallic) · Tone (per-type colour) · Snap (snare; inert otherwise). Per-context **white-noise
  buffer** + `boshEnv` (instant-attack exp-decay, optional gated choke) in audio.js; cheap, short-lived
  voices. v1 = **808 only** (user: the one 909 thing wanted is HH variety — a future Model select for
  ride/china/crash/909-hats is noted). All level/centre/ratio constants are **by-ear tunable**.
  - **Levels set by headless metering** (user: "way too soft"). A **sample-accurate Web Audio simulator**
    ([notch/wasim.mjs](notch/wasim.mjs): scheduled AudioParams incl. setTarget/exp-ramp semantics, sine/tri/square
    oscillators, RBJ biquads, looping noise buffers, pull-based DAG render) renders each default drum and
    meters peak/RMS against a **default Vesperia note** (`meter-bosh.mjs`). This exposed a real **bug**:
    hat/cymbal/cowbell applied `peak` **twice** (sources scaled ×peak AND the bus envelope ramped to peak
    → peak², ~−20 dB) — their envelopes now ramp to **1** (shape only). Remaining per-topology filter
    losses (a hat's ~8 kHz highpass swallows most of its 540 Hz-based square cluster) are equalized by a
    measured **`BOSH_LVL`** per-type trim map: every drum's rendered peak ≈ the Vesperia reference peak,
    **+2 dB for the click-length hits** (clap/rim/clave — equal peak reads softer that short). Note the
    noise-based drums wobble ~±1 dB between renders (fresh random buffer per context). Re-meter with
    `node meter-bosh.mjs` after any voicing change.
  - **Kick reworked for variability + snap** (user: "needs more variability and definitely more
    click/snap potential"; kick split from the tom branch, tom untouched). **Tone = body drive**: a
    soft-clip `tanh(d·x)/tanh(d)` WaveShaper between the ±1 sine and the level envelope (unit-peak, so
    levels stay anchored; drive tapered `tone²×6` so the lower half is warmth not fuzz; cached per
    context like Nayumi's crush; Tone 0 skips the node — bit-clean sub). This *fulfils* Tone's original
    "body harmonics" tooltip, which the old kick never implemented. **Punch = a two-part attack**: an
    oscillator sweep spike (+5× on top of the main sweep, collapsing in ~4 ms — the 808 "knock") + a
    beater noise click scaling to 1.1×peak with a tighter 8 ms decay (the 909 snap). **Pitch Env opened
    up**: depth to ~9× (was 3×), sweep time to ~140 ms (was 75) — tight thump through dubby drop.
    `BOSH_LVL.kick` re-trimmed 1.25 → 0.95 (metered; the stronger default click had pushed +2.4 dB).
    *Planned:* the **other Boshwick tones get the same treatment** in later passes; user has sanctioned
    **per-type factory presets** if needed to put the sliders in expected positions (ties into the
    parked preset-system discussion).
  - **Preverb: considered and REJECTED.** User noticed a ~10–20 ms lead-in on 808 samples auditioned
    online. Analysis: a real TR-808 emits nothing pre-trigger; tape print-through / vinyl pre-echo are
    ~0.5–2 s early (not tens of ms); the tens-of-ms smear is most plausibly **MP3/AAC codec pre-echo**
    (transient quantization noise spread across the ~13–26 ms codec block — the user's own suspicion),
    linear-phase pre-ringing, or sample-pack design. Decided not to emulate an encoding artifact.
    **Kept for the future** (user explicitly flagged it as clever/useful): the **pre-beat scheduling**
    technique — schedule lead-in audio at `time − preT` so the hit stays on the grid and the lead-in
    eats into the previous beat (works because the scheduler commits whole cycles ahead and playback
    starts at now+100 ms; clamp at audition/t=0). Useful for swells, grace notes, reverse builds.
- **Multi-instrument registry** ([src/instrument.js](src/instrument.js)): each **kind** owns its
  defaults + `PARAMS` (editor metadata) + description; a patch carries a `kind` tag, the engine
  dispatches on it in `buildVoice` (a `switch`, one DSP branch per kind), and `normalizePatch` /
  `defaultPatch(kind)` / `clonePatch` are kind-aware (unknown/missing kind → Vesperia, so old
  projects upgrade silently). The voice's parameters live in a **patch** struct the engine reads
  **at every note-on**, so edits are heard on the next note with no re-wiring.
- **Patches are now per lane.** Each arrangement lane owns its own `lane.patch` (the engine
  resolves a voice's patch via `engine.patchFor(laneId)` → that lane's patch). New lanes start
  from the **factory preset**. Un-laned sound (grid click-to-hear / ♪ Test on the grid) uses a
  **separate neutral grid patch** — a workspace preference, *not* part of the project.
- **Edit instrument pane** ([src/instrumentpane.js](src/instrumentpane.js), below the roll —
  an editor panel, *not* a transport pane: it doesn't touch the active-pane or shortcut
  routing). It edits **one target patch at a time**, retargetable: focusing the **grid** pane
  loads the neutral grid patch; a lane's **Edit** button (lane header, left of M/S) loads that
  lane's patch (and scrolls the pane into view). A color-swatch chip in the header shows which
  target is being edited ("Grid" / "Lane N"). An **instrument selector** (dropdown in the header)
  switches the target's **kind**; the pane **rebuilds its body** for that kind's params. Switching
  away and back is non-destructive — a **per-target stash** keeps each kind's last-dialed patch
  (session-scoped; the *active* kind always rides the project). **Copy / Paste** ferry settings
  between targets and **across kinds** (in-memory clipboard, session only); **Factory Reset**
  restores *this kind's* defaults. Vesperia's grouped sliders:
  - **Amp Envelope** — Attack / Decay / **Sustain** / Release. It's a true ADSR; **Sustain 0
    reproduces the old struck-string decay-to-silence** (Decay = the old ring time-constant),
    and Sustain > 0 holds the note (pad/organ territory).
  - **Timbre** — one slider: a spectral tilt over the fixed partial mix (`k^e`), **0.5 =
    neutral (the old mix exactly)**, left darkens (upper partials attenuated), right brightens.
    **Energy-normalized** (metered fix): the raw tilt swelled the summed partials **~+24 dB at
    full bright** — a loudness slider, not a timbre slider. Each note's tilted mix is now scaled
    by `sqrt(E_neutral/E_tilted)` so total energy matches the neutral mix (0.5 stays bit-identical;
    RMS across the whole travel now sits in a ~4 dB window, the bright end a touch down post-filter,
    which offsets brightness reading louder per RMS).
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
- **Per-pattern column count** (time) × resizable pitch rows (one octave by default, C4 at
  bottom). A pattern's width = `columns.length` (default `DEFAULT_COLS` = 12, range `[MIN_COLS, MAX_COLS]`);
  a toolbar **"Cols − N +"** stepper resizes the current pattern (grow appends rests on the diagonal,
  shrink drops trailing columns — undoable, persisted with the pattern; New/Clone inherit the width,
  Clear keeps it). Notes stored by **absolute degree**, so resizing/scrolling never loses notes.
- Mono mode (one note/rest per column). Gestures: click a note = if the brush duration differs,
  **adopt the brush duration first**, else **rotate** to the next duration (beats order); click a
  rest = place; click a different row = repitch; **click-drag is axis-locked** (decided on first
  movement, never diagonal) — **vertical** repitches the column's note, **horizontal** swaps this
  column with the column dragged onto (a clean two-cell exchange); shift-click = accent;
  right-click = note↔rest.
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
- **Scale-mask library expanded (2026-07-04)** — [src/scales.js](src/scales.js) `SCALES` grew
  from Chromatic + the two pentatonics to a full 12-ET set: the **seven diatonic modes**
  (Major/Ionian, Dorian, Phrygian, Lydian, Mixolydian, Minor/Aeolian, Locrian), **harmonic** &
  **melodic minor**, the **symmetric** scales (**whole-tone**, **octatonic W–H** & **H–W** =
  diminished, **augmented**), **blues**, and the pentatonics (16-ET Mavila unchanged). Symmetric
  scales especially were the target — their even spacing makes scale-*step* transposition warp
  every interval quality at once, the striking-atonal-harmony engine the composer wants to lean
  on. Pure data; the picker is data-driven (`scalesFor(edo)` → main.js:1916), so they appear
  automatically under 12-ET. `notch/scales3.mjs` 29/29. First step of the "double down on scale
  transposition" direction (see [future_directions.md](future_directions.md) §11).
- **Pitch context (tuning + scale mask) — microtonal Stage 1**: each pattern carries a
  **tuning** (`12-ET` or `Just (5-limit)`), a **scale mask** (Chromatic, the diatonic modes,
  harmonic/melodic minor, whole-tone/octatonic/augmented, blues, pentatonics) and a **root**
  (toolbar "Pitch" selectors). All Stage 1 tunings stay on the
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
- **Navigable pitch range = the 88-key piano, A0 (27.5 Hz) → C8, per tuning.** The grid's low/high
  degree bounds are no longer the fixed `24`/`108` (a 12-ET-only ruler that left 16-ET squeezed and
  bottoming out at "81"). `degreeBounds(tuningId, root)` ([src/tuning.js](src/tuning.js)) resolves the
  **A0..C8 frequency band** (`LOW_HZ`/`HIGH_HZ`) to the **degrees closest in pitch** to those edges in
  the pattern's tuning (closest, not strict ≥, so 16-ET's "80" at ~1¢ under A0 still counts; monotonic
  scan, so any future/non-EDO tuning works without an inverse; memoized). Result: 12-ET = A0..C8 (MIDI
  21–108, exactly the piano); **16-ET = "80"..​"c7" (degree 8–124, ~7.25 octaves — no longer squeezed,
  and reaches its own A0**, fixing "the grid won't go below 81"). Bounds are **per-pattern** — gridview's
  clamps/transpose-guards/viewport read `this._loDeg`/`_hiDeg` and `centerGridOn` uses `degreeBounds`,
  retiring the duplicated `24`/`108` (the latter had been hardcoded again in main.js). 12-ET stays in
  MIDI 0–127, so plain-MIDI export is unaffected.
- **New Random** (toolbar, next to New/Clone; [src/random.js](src/random.js) + `openRandomModal` in
  main.js): generates a **new pattern** (same New semantics — parks the current one; same `canCreate`
  gating) from random in-scale notes, via a dialog with **live grid preview**. Default = a **generalized
  tone row**: a contiguous window of N in-scale degrees (N = the pattern's column count) approximately
  **centered on the grid viewport's middle**, in random order, **no degree reused** (uniqueness is
  by-degree, so narrow masks like pentatonic span extra octaves rather than starving); notes take the
  **brush duration**, no accents. Three persistent sliders bend it — **Unique** (100% = permutation …
  0% = sampling with replacement), **Run** (−1…+1: |v| = chance of stepwise continuation in that
  direction; at the ends a single unbroken run = the sorted window; run outranks triad so full runs
  stay intact), **Triad** (chance each note completes a harmonic triad with the previous two — EDO-aware
  `classifyTriad` pc-set keys from the **Triadulator's enabled family toggles**, so 16-ET gets septimal
  bias). Dialog: **Randomize** (re-roll in place, repeatable), **♪ Audition** (plays the preview once
  through the grid patch), **Reset** (defaults), **Accept** (disabled until first roll; keeps it),
  **Cancel/Esc** (restores the library *exactly* — the generated pattern is dropped and current/parked/
  counter put back, re-adding an evaporated empty float). Settings persist in `notorolla.randgen`.
  The new pattern **inherits the source's tuning/scale/root** (Pattern.initial resets them; the
  generator ran in that context so the pattern must carry it). Pure generator (`generateRandom`,
  injectable rng) — headless-tested incl. run extremes, triad bias, 16-ET Mavila, short-ladder reuse.
  *Deferred (user):* generator **presets**, more controls (e.g. articulation/rhythm randomization).
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
- **MULTI-SELECT + transform ACTIONS (2026-07-04 — replaced the brushes).** Selection is now a
  **SET of tiles on ONE lane** (`arrangement.selectedIds` + `selectedId` = the **anchor**, the
  last-clicked tile; runtime-only, not serialized; every mutator keeps the one-lane invariant —
  `select`/`toggleSelect`/`selectRange`/`selectMarquee`/`pruneSelection` in
  [library.js](src/library.js), headless-tested). Gestures:
  - **Marquee**: click empty track space and **drag** — a translucent blue band (clamped to the
    anchor lane, the one-lane rule) live-selects every tile it **intersects** (Cubase-like; edge
    auto-scroll works; content-anchored so jumps don't skew it). A **no-drag click** on empty
    space activates the lane and **clears** the selection; **Esc mid-band cancels** back to the
    prior selection. No modifier key (user: "why don't we start with click-over-empty-space").
  - **Ctrl-click** toggles a tile in/out (cross-lane starts fresh there; Ctrl still means *copy*
    during a drag — only the no-movement click reads it). **Shift-click** selects the contiguous
    run between the anchor and the clicked tile. Plain click = fresh single selection.
  - **Delete** (button/key) removes **every** selected tile, one undo entry (ripple mode closes
    each gap; off leaves silence).
  **Transforms are now ACTION BUTTONS, not brushes** (user: "we implemented brush because we
  didn't have multi-select… remove the brush feature entirely") — select tiles, then click;
  applies to the whole selection in **one undo entry**; the **selection survives so actions
  chain** (the grid Permute convention). Buttons **disable with no selection** (deliberately NOT
  the grid's "or all" fallback — silently reversing a whole arrangement is too surprising).
  - **Transpose**: SETs each tile's transpose to the bar's **Amount/Scale** (always-visible
    controls now — they're the action's parameters); a second application replaces; 0 clears;
    Scale Auto = each tile's own mask; the tuning is never changed (walks `stepInScale`).
  - **Reverse**: **unify** — if every selected tile is reversed, un-reverse all; else reverse all
    (exactly clone-and-reverse: retrograde within the tile's full length, trailing rests incl.).
  - **Clone**: each selected tile repoints to a fresh deep copy (`library.cloneOf`), **deduped
    per source within the action** (5×A1 + 2×A3 → 5×A8 + 2×A9 — a selection keeps its internal
    sharing while diverging as a block); the **anchor's clone opens in the grid**. Accepted:
    undo repoints back but the clones linger in the registry (pattern browser / orphan-GC is the
    real fix, deferred).
  **The transform inspector** (chips right of the bar): one tile selected = its ordered removable
  chips as before; **several = the INTERSECTION view** — a count label ("3 tiles") + a chip per
  transform kind common to ALL selected (uniform details shown, "**Transpose (mixed)**" when the
  kind is shared but amounts differ); a chip's ✕ removes that kind **from every selected tile**,
  one undo. Nothing in common = just the count.
  **Selection BLOCK ops (2026-07-04, same push):** the selection moves/copies/repeats as a
  **rigid block** (relative offsets + internal gaps preserved), all with the per-tile
  **"ignore" collision policy** (a member whose destination overlaps a non-moving tile is
  `blocked`: a move leaves it where it was, a copy/repeat skips it — overwrite may become a
  toggle later; a blocked move-member left behind can overlap a placed one's spot, accepted).
  Pure planners on the Arrangement (`planSelectionDrop`/`planRepeat`) are shared by preview AND
  commit, so preview == commit ([notch/blockops.mjs](notch/blockops.mjs), 23 tests):
  - **Multi-MOVE / multi-COPY**: dragging any member of a ≥2 selection carries the whole block
    (the grabbed tile keeps its grip; the shift clamps so nothing lands before beat 0);
    Ctrl = copy as usual; cross-lane works (fresh-lane instrument seeding applies once); the
    landing preview shows a **band per placed member** (blocked move-members visibly stay put);
    the carry caret marks the **block's** left edge. Ripple mode doesn't apply to multi drags.
    Move keeps the same ids selected; copy selects the placed copies (parallel to single-copy).
  - **REPEAT — the fill handle** (Excel idiom; chosen over shift-drag and a one-shot button —
    discoverable, no modifier, no arming; "Cubase kinda sorta does the handle thing" — user):
    a small blue grip rides the **right edge of the selection block** (kept glued by
    `syncSelHandle` on every selection change; hidden during drag previews). Drag it right to
    stamp **whole-block copies at `blockStart + k·period`** (period = block span → seamless;
    a trailing gap can't be part of the loop, accepted); count tracks the pointer (pull back to
    shed, release to commit, k=0 no-op, Esc cancels); preview bands are drawn **without
    re-rendering** (the handle under the pointer must survive its own gesture). One undo entry;
    afterwards the **selection = originals + all stamps** (user's choice — ready for a
    whole-run transform). Transforms clone onto stamps/copies.
  **Removed with the brushes** (select-then-act replaced them; git remembers): arming/one-shot/
  Shift-to-stay, the paint-gesture Esc-cancel path, path-exact sweep hit-testing (`segmentHits`,
  Liang–Barsky — deleted, tests trimmed to `clampGrip`), the painted-tile highlight, and the
  clone brush's armed-session dedup map. Losses accepted: **cross-lane sweeps** (one-lane
  selection — per-lane rounds for now) and scattered-tile painting (covered by Ctrl-click).
- **Per-tile transforms (nondestructive)** ([src/transforms.js](src/transforms.js), applied in
  `arrangementScore`): transforms live on the **tile instance** as an **ordered list**, never the
  pattern, so two tiles can share one pattern yet sound different and editing the pattern still
  updates both. A **note-list pipeline** (`applyTransforms`): **transpose** maps pitch (re-resolves
  freq in the tile's tuning), **reverse** retrogrades time — walked in list order. Phase-1 policy:
  at most **one transpose + one reverse** (`normalizeTransforms` enforces last-transpose-wins +
  reverse parity). The tile's **thumbnail stays the pattern's identity**; transforms show as
  **stacked translucent swaths** at the bottom (transpose purple `+n`, reverse teal `◄`) and as
  chips in the bar (see the inspector above); the **roll shows the real transformed notes**. Saved
  per-tile (`tile.transforms`, optional/backward-safe), **undoable** (carried through `arrApply`),
  **copies carry cloned transforms**. Future Phase 2: append semantics + reorderable chips +
  **Rotate** (the non-commuting case that forces real ordering UI).
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
  selector — over an **Edit** button that opens the per-lane instrument editor) + a **stacked effect
  column** (**"M" modulators** alone at left, then **"D" delay** over **"C" chorus**; each lit when its
  feature is on, opening its modal) + a **knob column**
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
- **Click = select AND open** the tile's pattern in the grid editor (user: "no harm from that";
  modifier clicks — Ctrl toggle / Shift range — are selection-building and don't churn the grid);
  **double-click = AUDITION** (2026-07-04): plays JUST that tile — its pattern with its
  transforms, through its lane's instrument, bus, effects and modulators (mute/solo respected;
  notes keep their true ruler position for the Loop-Mod anchor — it sounds exactly as in
  context). One-shot via the shared scheduler (`activeSource = 'audit'`; no roll/tile playhead
  sweep — the roll shows the arrangement, a sweep would lie; the auditioned tile gets the green
  badge); double-clicking another tile replaces the audition; **Space stops it**; any transport
  start replaces it. Double-click is detected MANUALLY in the click path (400 ms window) — the
  first click's refresh rebuilds the tile element, so the native dblclick event can never fire.
  Delete (button or key) removes the selection; each lane has its own drop zone.
- **Drag to position / move / copy** (pointer-based; a small movement threshold distinguishes
  a drag from a click/double-click). Placement semantics are governed by the **Ripple toggle**
  (leftmost in the transform bar, **default OFF**, a workspace pref in `notorolla.ui`; it covers
  insert AND delete):
  - **Ripple OFF (default) — exact placement, overwrite on collision.** The tile lands with its
    left edge at the **snapped drop beat, exactly** — empty lane, mid-gap, wherever ("the tile goes
    exactly where the user drops it"). Every existing tile the drop **overlaps is removed whole**
    (tiles are **atomic** — no trimming for now (user); clipping the edge of an 8-beat tile removes
    all 8 beats, leaving silence). Deletes/move-outs **leave a gap**. One undo entry incl. removals.
    (`overwriteInsertInto` / `remove` in [library.js](src/library.js).)
  - **Ripple ON — the original rigid ripple.** Clamped so it can't overlap the anchored left
    neighbor; tiles to the right shift right by a **single amount** = just enough to clear (0 when
    it already fits, gaps among them preserved); no overlap, no rejected drop. Deletes/move-outs
    rigid-ripple everything right of them **left** by the tile's length. Repositioning within a
    lane lifts without a source close (drop-back = no-op).
  Either mode: only dropping *off* the lanes cancels; **Ctrl = a shallow copy** ("+" badge on the
  ghost; moved off Shift, which the upcoming multi-select needs for range selection); no modifier =
  move (keeps the id). **Drop position (settled 2026-07-03 after two experiments):** the tile
  lands at the **beat nearest its CARRIED position** — `round(cursor − grip)` for tile drags
  (the **normalized grip**: `clampGrip`/`gripFor`, held where grabbed, clamped ≥ half the tile
  height from either edge, center for square tiles; the ghost hangs from the same grip point,
  `makeGhost(id, gripPx)`), and `round(cursor − len/2)` for grid drops (**always centered**, no
  prior grip to preserve). During any drag the **beat caret goes into CARRY MODE**: it stops
  tracking the pointer and marks the **left edge of the prospective landing** (`setCarryCaret`,
  fed by both drag pipelines on every move; hidden off-lanes where a drop would cancel) — so
  the caret and the landing band always agree WITHOUT warping the drop math to the pointer.
  (Two failed experiments recorded so we don't repeat them: drop-at-floor(pointer), then
  caret+drop both at round(pointer) — each made the drop ignore the carried tile's position;
  "the ghost/drop was working correctly before… what needs to change is the caret" — user.)
  Each real change is one undo step; afterward the tile is selected and its lane active. (`moveTile(…, ripple)` /
  `copyTile(…, ripple)` / `insertAt` / `removeRipple` in [library.js](src/library.js), via the
  shared `rippleInsertInto` / `overwriteInsertInto` / `rippleRemoveFrom` primitives.)
- **Prospective preview while dragging** (DAW-style), mode-aware, computed by running the **same
  placement ops on a throwaway copy** (so preview == commit) while a floating **ghost** follows the
  cursor. **Landing is a filled band** (translucent blue over the exact span the drop occupies —
  user: highlight the area, not an outline; ripple mode's in-flow slot got the same fill). **Ripple
  OFF** additionally marks the tiles the drop would remove as **doomed — dimmed to 40% + red
  outline** ("fading out, marked for deletion"); nothing shifts. **Ripple ON** keeps the
  FLIP-animated rigid-shift preview. Crucially the preview is **visual only**: audio,
  the roll, and the playhead keep playing the **committed** layout (the preview "is not what's
  playing"). During an active drag the green "playing" badge is suppressed (the playhead still runs)
  so it doesn't mark a hypothetical slot. **Editing while playing is fully supported** — the drag
  never touches the committed model until drop; a committed change's audio lands at the next tile
  boundary / loop per the reconciliation, visual is immediate.
- The **grab-handle drop** (a new tile from the grid) is **position-honoring**: the tile lands at
  the **beat under the cursor** (was: append-flush-at-end, ignoring position — the user's reported
  inconsistency), via the mode-aware `insertAt`. The HTML5 dragover feeds the **same landing
  preview** as tile drags (`onGridDragOver` → an `external` preview, re-rendered only when the
  snapped target changes; cleared on the grab handle's `dragend`). A fresh lane still adopts the
  grid's instrument on drop. Old gapless projects migrate by deriving each tile's `start` from the
  cumulative order (`ensureTileStarts`), so they open identically.
- **Active lane** (highlighted) set on drop / select / empty-lane click.
- **Beat caret (2026-07-03) — MODAL**: with nothing in hand, hovering a lane shows a light-blue
  vertical line at the beat **left of the pointer** (floor — "nearest left", a "land/paste here"
  cursor), hovered lane only, steady (blink deferred). **While a tile is carried** (tile drag or
  grid drag) the caret switches to **carry mode**: it marks the **left edge of the prospective
  landing** on the target lane instead of tracking the pointer (`setCarryCaret`). Always live, gestures included: delegated pointermove
  covers tile drags and brush sweeps; the HTML5 grid-drag's dragover updates it (pointermove
  doesn't fire during dnd); ruler drags capture the pointer away from the lanes, which correctly
  hides it. One element re-parented between tracks, no-op unless the (lane, beat) pair changes;
  `pointer-events: none`; z 2 (over tiles, under the sticky heads). Groundwork for copy/paste.
  The caret-vs-drop question was settled the same day with the **modal caret** (carry mode marks
  the landing's left edge; drops keep the grip/centered math — see the drag bullet above).
- **Range edits — Insert time / Clear / Delete time (2026-07-03).** Transform bar gained
  `│ Range: [Insert] [Clear] [Delete]` (color-keyed green/amber/red, same arming rules as the
  brushes: exclusive with them, one-shot, **Shift at release keeps armed**, Esc disarms — or
  cancels a drag in progress via its capture listener). Arm one and **the ruler glows**
  (crosshair + blue glow, marker drags inert) — draw a beat-snapped range there; a color-keyed
  band tracks the drag on the ruler AND down through every lane track, with affected tiles lit
  live: **doomed** (dim+red) = will be removed, **`.range-shift`** (blue outline) = will move.
  Semantics (all lanes, global timeline surgery; `Arrangement.insertTime/clearRange/deleteTime`
  in [library.js](src/library.js)):
  - **Insert**: everything *starting* at/after the range start shifts right by the range length.
  - **Clear**: tiles *starting* in [start, end) removed; nothing moves.
  - **Delete**: Clear + everything starting at/after the range end shifts left to close the gap —
    shifted material may overlap an earlier tile's tail (accepted; already possible via
    pattern-length changes).
  Tiles are **atomic**: one starting before the range but reaching into it is untouched (the
  no-trimming doctrine). The **playhead and region markers ride along** as timeline points
  (`insertPoint`/`deletePoint`, exported pure): a point inside a deleted range collapses to the
  range start; if both markers were inside (region degenerate), they **reopen 4 beats apart at
  the range start** (user's rule); an auto (null) end marker stays auto. One undo entry per op
  (no entry if the range touched nothing); an empty range (plain click) cancels; the Ripple
  toggle has no bearing. rangeops.mjs 23/23; suite 446.
- **Page no longer scrolls itself on edits** (user: "let the user scroll it back"): edits resize
  the grid canvas (triad band appearing/leaving, stretch-mode length) and the roll canvas (pitch
  span), and the browser's **scroll anchoring** was adjusting the page scroll in response — read
  as "the pane scrolls itself back into view." Fixed: `html { overflow-anchor: none; }` + both
  canvases now skip same-value width/height writes (a no-op assignment still invalidates layout).
  **Second wave (ruler clicks / Space-stop, 2026-07-04)**: with anchoring off the residual jumps
  were LAYOUT SHIFT — the roll canvas height follows the content's pitch span, and switching its
  score (pane activation swaps pattern↔arrangement; stop swaps windowed↔full) resized the pane,
  sliding everything below it. Fixed by giving the roll a **fixed-height viewport (400 px) that
  scrolls internally** both axes (pairs with the V zoom — tall canvases scroll inside, the page
  never breathes; `align-items: flex-start` so flex doesn't stretch the canvases).
- **Horizontal scroll persists across reloads** (`state.tileScrollX` in notorolla.ui — even with
  the playhead off screen you come back to the same view; scroll events land on state, the
  localStorage write is debounced 400 ms; restored after the initial render, browser-clamped).
- **Drop headroom**: the lane tracks + ruler extend **~half a viewport (min 8 beats) past the
  content end**, so an overflowing arrangement never pins its last tile against the window's right
  edge — there's always empty, droppable, scrollable track at the end (markers still clamp to the
  real content end). First piece of the "enable longer projects" push (2026-07-03).
- **Perf pass for long projects (2026-07-03)** — three independent fixes (the invasive fourth,
  keyed reconciliation of `render()` instead of the innerHTML wipe, is held in reserve if drag
  previews still stutter on big arrangements):
  - **Ruler tiled**: the giant per-render canvas (as wide as the whole track — a huge layer that
    made scrolling crawl and would eventually hit canvas size caps) is now a **one-major-period
    tick tile** repeated as a CSS background (`rulerBackground(ppb)`, cached per zoom — integer
    TILE_SCALES so the repeat never drifts) + **sparse number spans** (`.ruler-num`, one per major).
  - **Thumbnail cache**: tiles no longer each own a redrawn-every-render canvas; the thumbnail is a
    **CSS background-image from a content-keyed cache** (`thumbImage`: key = zoom + per-column
    rest/degree/duration, so edits mint a new key; dumb full reset at 300 entries). 100 tiles of A1
    = one rendered image; the drag ghost inherits it via cloneNode for free (its canvas-repaint
    workaround removed).
  - **Delta playback updates**: `setPlaying`/`setPlayhead` run per frame — they now use render-time
    element caches (`_tileEls`/`_playheadEls`) and diff (previous playing-set / last playhead x)
    instead of `querySelectorAll` sweeps; `updateTransportButtons` early-outs on an unchanged
    input signature.
  - **Page-jump auto-follow** (user: continuous follow still scrolled badly): both playback
    followers (`ensureTileVisible`/`ensureRollVisible`) hold the view still while the playhead
    sweeps across it and **jump a page** (playhead re-enters at the left margin, right of the
    sticky heads) only when it runs off the right edge — no more per-frame `scrollLeft` writes
    dragging the whole track layer.
  - **Scroll no longer resets on rebuild** (user: "scrolls back to the beginning a lot,
    especially on stop"): `render()`'s innerHTML wipe momentarily collapsed the content, so the
    browser clamped `scrollLeft` to 0 on **every** rebuild (stop, drop, undo, …). The scroll
    position is now saved/restored across the rebuild (before the FLIP measures rects), and both
    stop paths keep the playhead in view (`ensureTileVisible` after a manual stop parks it /
    after a natural finish rewinds it).
  - **Edge auto-scroll while dragging** (`tilePlayer.edgeScroll`): dragging a tile (or the grid
    grab-handle, or sweeping a brush) within 48 px of either side of the visible tracks **jumps
    the view half a page** that way (time-gated at 350 ms — jumps, not creep, per the user).
    Pointer-driven, so a perfectly still pointer stalls between jumps (hand jitter suffices;
    HTML5 dragover auto-repeats so grid drags don't stall at all). Brush sweeps hit-test against
    a scroll-compensated coordinate (pointer x mapped back into the gesture's snapshot space),
    and a jump resets the segment anchor so the sweep doesn't paint everything that streamed
    past a stationary pointer. **Ruler drags too**: region-marker drags and range-tool drags
    edge-scroll the same way — their `beatAt` reads the track rect fresh per event (the ruler
    scrolls with the content, so a rect cached at pointerdown goes stale the moment the view
    jumps). Stacking fix same pass: `.tile` got `z-index: 0` (own stacking context) so
    transform swaths can't paint over the sticky lane heads; `.tile-playhead` z 5→2 (same reason).
- **Playhead — always visible, parks when stopped**: during tile playback a vertical line sweeps
  each lane track at the current beat (one `.tile-playhead` per track, positioned track-relative so
  it scrolls with the tiles and aligns across lanes; `tilePlayer.setPlayhead(beat)` from the render
  loop, re-applied after every `render()` rebuild). It marks **real playback position** — shown even
  mid-drag (when the green "playing" badge is suppressed). The lanes auto-scroll to follow it
  (`ensureTileVisible`, not scrolling it behind the sticky lane header). When stopped the playhead
  **stays on screen, parked** (`state.playheadBeat`, a workspace pref in `notorolla.ui`, clamped to
  the arrangement on restore; project Open/New parks it at 0):
  - **Manual Stop parks it where playback was; a natural finish** (one-shot end / loop passes
    exhausted, `scheduler.onEnded`) **rewinds it to the region start.**
  - **Space** = play from the region start / stop (as before, active pane); **Shift+Space** = loop.
  - **ArrowRight resumes from the parked playhead** (`resumePlay`, tiles pane, stopped only): the
    **first pass** is windowed to `[playhead, region end)` — a one-shot `resumeBeat` the provider
    self-clears at the first loop boundary (`scheduler.cycleStart` moved past the armed start), so
    **a resumed play that loops wraps to the region start**, not the resume point (user decision).
    The render loop tracks the pass origin (`passBase`, flipped forward when the position wraps) so
    the on-screen playhead stays absolute during a resumed pass. At/after the region end = no-op.
  - **⏮ / ⏭ transport buttons + B / E keys** park the playhead at the **play-region start / end**
    (`movePlayhead`, scrolls it into view; disabled/no-op while playing — live locate is a
    deliberately deferred bigger feature). No click-to-scrub on the ruler yet (it owns marker drags).
  - The **clock shows the parked playhead's position whenever the tiles aren't playing**
    (regardless of Loop Mod — see the modulator-clock note below).
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
- **Roll zoom — adjustable V + H scale (2026-07-04)**: quantized notches (`ROLL_V_SCALES`
  4–32 px/semitone, `ROLL_H_SCALES` 16–80 px/beat; defaults = the old fixed constants), a
  V/H strip under the roll (same styling as the tile-player scale strip), persisted view-only
  (`rollVIdx`/`rollHIdx` in notorolla.ui). The exported `BEAT_WIDTH` const is unchanged, so the
  grid's Stretch mode still aligns with the roll's DEFAULT zoom (zooming the roll is a
  deliberate view divergence). **Labels are graph-ticks (user spec)**: 12-ET pitch names on the
  left gutter at "musical round number" steps — semitone/whole-tone/m3/M3/tritone/octave/2-oct,
  the densest step that keeps ≥13 px spacing, always anchored on C (Cs drawn brighter).
  Refined per user: **constant font size always** (density comes from the step, never a smaller
  font), and the step ladder is just **[every pitch, octaves, 2-octaves]** — no intermediate
  "minor tick" labels at reduced scale ("exact pitch isn't super important there; zoom in").
  **Labels live on a PINNED GUTTER** (user: they mustn't scroll out of sight): a second canvas
  (`#rollGutter`), `position: sticky; left: 0` with a negative margin equal to its width so it
  overlays rather than displaces the roll; opaque background + lane stripes so content visibly
  slides under it; the playback follow + scroll-to-selected account for its width. Column 0 =
  12-ET names; then **one column per non-12-ET tuning IN USE** (user: "display all of the
  scales that are in use" — tiles view scans every tile-referenced pattern, grid view the
  current one; distinct by (tuning, root) since the root moves the degrees), each headed by its
  EDO, with the tuning's own nomenclature (`degreeToName` — 16-ET hex+octave) and tick marks at
  true cent heights, thinned by the same rule, degree-0 classes brightened. Closed-form degree
  placement assumes an equal division (true of all current tunings; an unequal scale would need
  a scan — noted in the code).
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
  step**, same bracket as the delay. No WASM. ([src/chorus.js](src/chorus.js) owns the config + editor.)
- **Per-lane INSERT REVERB (2026-07-04)** ([src/reverb.js](src/reverb.js) config+editor;
  `buildReverbInsert`/`reverbIR` in [src/audio.js](src/audio.js)): character reverbs for a
  single instrument — canonical case **gated snare**, hence the **default mode = Gated,
  moderately pronounced** (user; a "proper" gated reverb also runs a compressor/envelope —
  trying convolution alone first, "we'll see how it sounds"). **"R" chiclet** (chiclets now a
  2×2 grid, user's layout: `M C / D R`), modal with **Type** (Gated / **Ambience** = a live
  room's early reflections only / Room / Hall / Plate / Spring) · **PreDelay** (0–80 ms, live
  param — dry hit first, then the burst) · **Size** (for Gated it IS the gate time, 60–300 ms)
  · **Wet** (live) · **Damp** (high-frequency decay tilt; plate bites half as hard, spring
  harder). Engine: a **ConvolverNode over a SYNTHESIZED impulse response** — seeded noise
  (mulberry32 keyed on the settings, decorrelated per channel for stereo width), envelope per
  mode (gated = near-flat burst hard-cut with a 2 ms anti-click fade — **the gate lives in the
  IR**; spring = decay × ~18 Hz flutter; damping = a one-pole lowpass tightening along the
  tail), `normalize=true` equalizes IR energy so Wet is comparable across modes/sizes — but
  energy equalization makes a TRANSIENT's reverb (smeared across the IR) read far quieter than
  the dry hit, so **Wet runs a square law up to ×6** (`reverbWetGain` — user: a full-up gate on
  a snare must go "Tssst"; unity wet was too subtle; the master limiter backstops the top).
  **Deterministic**: live ctx and every offline export build the bit-identical IR, so bounces
  match playback. **Reverb is LAST in the insert chain** (pan → chorus → delay → reverb → gate);
  a shape change (mode/size/damp) rebuilds the convolver, wet/predelay update live. Save/undo/
  dirty/reset per the delay/chorus pattern (`lane.reverb`, one-undo-step modal, R lit warm);
  WAV + stem exports rebuild the insert (dry stems exclude it) and the **export tail extends by
  the longest enabled IR + predelay** so halls ring out. The shared send-bus reverb ("the
  communal wash") remains future. reverbcfg.mjs tests config/decay-model/persistence.
- **Per-lane playback MODULATORS** ([src/mods.js](src/mods.js)) — slow parameter movement à la Cubase
  modulators, for "notes sound different as their patterns repeat" (user's goal). **"M" chiclet** (left
  of the D/C stack, lit violet when active) opens a modal with **two fixed mod slots**, each: **On** ·
  **Shape** (Sine / Triangle / Ramp↑ / Ramp↓ / **Walk**) · **Parameter** (dropdown from `paramsFor(kind)`
  — numeric sliders/knobs only, **no bool/select/stepped**: cycling vowels/algos isn't musical) ·
  **Amount** (0–100% = peak deviation in **slider-position space** via `toPos/fromPos` — perceptually
  even on log params, clamped at the ends) · **Rate** (0.01–1 Hz, log) · **Phase** (0–360°, 0 = centered
  rising).
  - **Note-time sampling** (user decision: fine for now): a mod is a pure function of time; at each
    note-on the voice is built from `patch + offsets(t)` — **no persistent nodes, works for every
    numeric param of every kind, zero cost when off** (`modsFor` returns null). No within-note movement
    (a future "continuous" tier could add strip-level pan/gain + held-note cutoff).
  - **Time anchors** (user decisions): **Loop Mod OFF** (default) = *elapsed* — t counts from the
    **session's first Play press** (`engine.modEpoch`), so looped passes keep evolving. **Loop Mod ON**
    = *ruler* — t = the note's absolute timeline position (`note.rulerBeat`, set in `arrangementScore`,
    survives region windowing), so every pass is identical and t0 is always the ruler's 0 regardless of
    where playback started. Deterministic both ways. **Loop Mod is ONE GLOBAL toggle** (user: "one
    checkbox for the entire tile player, for now") — a `tbtn` next to the ↻ loop button, persisted as
    `state.modLoop` (workspace pref, `notorolla.ui`); the resolver overrides every mod's `loop` flag
    with it (the per-mod field stays in the data model for a possible per-mod return). A **transport
    clock** (`mm:ss.hh`, left of Undo; 50 ms interval, writes only on change): while the **tiles play**
    it shows the clock the mods actually read — elapsed since first Play, or the pass's ruler time when
    Loop Mod is on; **stopped (or grid playing) it shows the parked playhead's position** regardless of
    Loop Mod (user decision — it no longer ticks elapsed time while stopped, though the elapsed anchor
    itself keeps running underneath). *Deferred (user):* "Scale Mod Rate to Tempo" checkbox.
  - **Walk** = interpolated **value-noise** (seeded hash points, smoothstep between): bounded by
    construction, centered, deterministic, O(1) — the "tempered random walk"; seed = lane × slot, so
    walks decorrelate across lanes/slots.
  - **Per-kind storage** (`lane.modsByKind = { kind: [mod, mod] }`, persists with the project): each
    instrument kind keeps its own pair — switch instruments and back and the setup is intact (the user's
    "save and put it back", with no stash mechanism at all). Copy/Paste patch does NOT carry mods;
    lane Reset wipes them; `normalizeModsByKind` is forward-safe (unknown kinds preserved).
  - **Both mods on one target add** in position space, then clamp once (drift + sine on cutoff = legit).
  - Applied at the note→voice seam (`engine.moddedPatch`, non-destructive copy — the transforms
    doctrine), so **WAV + stem exports inherit modulation automatically** (bounce = a fresh play from
    ruler 0 = the first live pass); grid audition / ♪ Test are unmodulated (lanes only). Modal is one
    undo step (the delay/chorus bracket). Lane head widened 178 → 202 px for the M column.
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
  File** ([src/midi.js](src/midi.js), pure). Our pitches are already MIDI note numbers and
  beats are quarter notes, so the mapping is direct; **480 ticks/quarter** keeps every event
  on an integer tick.
- **Format 1**, one named track per non-empty lane (`Lane 1`/`Lane 2`), each on its own
  channel; a single tempo meta (current BPM) on the first track. One pass, as written (no
  loop repeats). No CC/program-change — assign instruments in the DAW.
- Note lengths are **articulated (×articulation, 0.88)** — a deliberate detached feel. Now
  that playback also applies articulation (fixed), the export **matches what you hear**.
  Filename defaults to the project name (or a timestamp) + `.mid`.

#### MIDI + microtonality — design discussion (NOT built; deferred 2026-06-24)
Captured from a design discussion; **no code written**, the user parked it ("audio export is
fine at the moment"). Decisions reached + open questions, so we can pick it back up cold.
- **The current export is wrong for non-12-ET.** It writes `n.pitch` (the scale **degree**) as
  the note number. In 12-ET degree == MIDI note, so it's fine. But a 16-ET pattern stores
  degrees in **16-steps-per-octave** space anchored at 60 ([grid.js](src/grid.js):
  `freq = noteToFreq(60)·2^((degree−60)/16)`), so degree 76 is an octave up yet we'd emit MIDI
  76 (E5) — a 16-ET piece currently exports **transposed/compressed gibberish**.
- **Chosen direction: two separate export options, NO pitch bend.** The user finds pitch-bend /
  MPE "grotesque" and explicitly rejected it (its only real upsides — tuning-ignorant synths +
  the Dorico-notation hack — don't matter for a Surge-centric workflow).
  - **Plain MIDI** — for `edo === 12` pieces. This is *exactly today's output* (degree == MIDI
    note), no change needed. The dividing line is the **EDO, not the scale's "feel"**: a Mavila
    scale is 16-EDO → Scala, even though it sounds diatonic-ish.
  - **Scala (microtonal)** — the **degree IS the interchange unit, no pitch math**. Emit the
    same degree-MIDI **plus a generated `.scl` + `.kbm`**, zipped (reuse [src/zip.js](src/zip.js)),
    loaded into a tuning-aware synth (Surge XT, Pianoteq, Vital, anything Scala/MTS-ESP). The
    synth retunes per key → exact pitch, **full polyphony, lane tracks intact, one channel**.
- **Why Scala fits Notorolla naturally:** our internal degree space (EDO steps anchored at
  degree 60) is *exactly* what a **linear `.kbm`** expects. `.kbm` anchor = middle note 60,
  reference note 60, **261.6256 Hz** (`noteToFreq(60)`), period = EDO size; `.scl` = `edo` equal
  lines (16 × 75¢ → 1200¢). Because our `freq` is defined off that same anchor, Surge reproduces
  our pitches to the cent. Non-octave tunings would just change the `.scl`'s last (period) line.
- **How Surge-family microtonality works (for reference):** two philosophies — *tuning baked in
  the MIDI* (pitch bend/MPE; rejected) vs *tuning held by the synth* (what we want). The latter
  via **Scala `.scl`/`.kbm`** files (static, what we'd export), **MTS-ESP** (Oddsound real-time
  broadcast; needs a master plugin, not a file we emit), or **MTS SysEx** (old, patchy support).
- **Open wrinkles to resolve before building:**
  1. **Plain MIDI invoked on non-12 content** — refuse-with-a-nudge ("use Scala") [leaning] vs
     quantize-to-nearest-12 (deliberate lossy reduction).
  2. **Mixed-tuning pieces** (per-pattern tuning means a lane can mix EDOs across tiles). A `.scl`
     is one scale per synth instance. Proposed general design: **one MIDI track per (lane ×
     tuning)** actually present + **one `.scl`/`.kbm` per distinct tuning** (12-EDO file shared,
     not duplicated) + a `README.txt`. Collapses to "tracks = lanes, one scale file" for a
     single-tuning piece. Open: do this splitting in v1, or require single-tuning lanes (warn)
     and defer the split.
  3. **MIDI 0–127 range** — degree-as-note-number must fit. 16-EDO over its A0..C8 grid (degree
     8–124) is fine; a future high EDO (e.g. 31) over several octaves would clip 127 (escape hatch: Surge's
     "channel for octave" mode — avoid until forced).
- **Real microtonal *notation* (Dorico) is out of scope for MIDI entirely** — Dorico won't turn
  imported pitch-bend into notated microtones; that path wants a future **MusicXML** export.

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
- **Release-tail = per-kind, not `patch.release`.** The bounce tail (`Math.max(2.5, maxRelease*6+0.5)`)
  must size to each lane's actual ring-out. Tervik has **no top-level `release`** (its amp tail
  tracks Op 1's `r1`, [src/audio.js](src/audio.js) `buildTervikVoice`), so reading `patch.release`
  for a Tervik lane returned `undefined` → `Math.max(…, undefined)` = **NaN** → NaN frames →
  `OfflineAudioContext` "**Length must be nonzero**" and a dead export. Fixed: `patchRelease(patch)`
  ([src/instrument.js](src/instrument.js)) returns the kind's effective release (`r1` for Tervik,
  else `release`), defaulting non-finite to 0; export uses it for the grid patch and every lane.
  `renderToBuffer` also now floors a non-finite/zero `durationSec` to one frame as a backstop.

### Export stems (BWF, per lane → zip)
- **Export Stems** (Tile-player controls, right of Export Audio) opens a small modal — **Export Stems**
  ([src/modal.js](src/modal.js)) — to pick a **bus mode**, then renders **one Broadcast Wave (BWF)
  per lane** and bundles them in a **zip**. Every lane with notes is rendered (**mute/solo ignored** —
  you mute in the DAW; the single-file mixdown export still respects it). All stems share one length
  (mix length + release tail via `patchRelease`) and **`TimeReference = 0`**, so dragging the set into
  Cubase/Reaper (Import at Origin) lands them **aligned**. File = `NN <Instrument>.wav`
  (lane index + kind, de-duplicated, filesystem-sanitized); archive = `<project>-stems.zip`.
- **Bus modes** (`engine.renderStem(notes, durSec, laneId, busMode)`, [src/audio.js](src/audio.js) —
  a per-lane sibling of `renderToBuffer`):
  - **`dry`** (default) — voice straight to output: no volume/pan/chorus/delay, no master limiter.
  - **`postfader`** — lane volume/pan/chorus/delay baked, master limiter **off** so stems **sum to the mix**.
  - **`baked`** — as post-fader, plus the master fader + limiter (sounds as soloed-in-mix, but the
    nonlinear limiter means stems no longer sum exactly). `masterLevel` is applied only in `baked`.
- **BWF writer** — [src/wav.js](src/wav.js) refactored to share a `pcm16Bytes` core + a `cursor`/chunk
  assembler between `encodeWav` and new **`encodeBwf(buffer, meta)`**, which inserts a 602-byte **`bext`**
  chunk (EBU Tech 3285 v1; Description / Originator=`Notorolla` / OriginationDate+Time / 64-bit
  `TimeReference`). It stays a valid WAVE — players ignoring `bext` still find `fmt `+`data`. `bext`
  fields are ASCII (non-printable → `?`).
- **Zip writer** — new [src/zip.js](src/zip.js): `zipStore([{name,bytes}], date)`, **STORE method (no
  compression)** — PCM is already uncompressed, so deflate would cost a dependency for ~nothing. Pure,
  no-deps (own CRC-32 table); writes local headers + central directory + EOCD, UTF-8 names (flag set).
- *Deferred:* range/loop selection; mono "pre-pan" option; a single multichannel poly-WAV alternative.

---

## Known limitations / deferred

- **BUG (diagnosed 2026-07-03, fix deferred — user: "another time, low priority"): arrangement
  Undo overwrites live modulator settings.** The mods themselves serialize/restore fine (round-trip
  verified headlessly); the loss is the undo path: the mod modal brackets an *undoable* arrangement
  entry, and `arrApply` restores `modsByKind` **from the snapshot** on every undo/redo — so the
  first Undo after mod tweaking (or any undo past the point mods were set up) silently reverts
  them ("my mod settings just go away"). Lane *patches* were exempted from exactly this
  ("undoing a tile move never reverts a later sound edit" — live-carried in `arrApply`); the
  intended fix is the same treatment for mods: live-carry on normal entries (snapshot-restore only
  on `full` resets) + the mod modal persists without minting an undo entry (like `persistPatch`).
- **BUG (found same hunt, deferred): `loadContent` doesn't restore `playStart`/`playEnd`** — opening
  a project file keeps the *previous* session's region markers (`Arrangement.fromJSON` parses them
  but the in-place copy skips them). One-line fix when touched next.
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

**See [future_directions.md](future_directions.md)** for the big-picture roadmap of the
*large* features ahead — subsequences (nestable arrangement tiles), PaulStretch drones, a
beat generator, PadSynth + more voices, the sample player, the Etuderator, and polyphony —
with dependencies, WASM-or-not analysis, and a recommended sequencing. The list below is the
older near-term jotting.

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
- **Headless tests live in [notch/](notch/)** (moved in-repo from C:\tmp\notch 2026-07-04, user
  request): `node notch/run.mjs` runs every suite; tests import the live `../src` directly (the
  root `package.json` `{"type":"module"}` exists solely to make `src/*.js` ESM-resolvable to
  node — inert for the browser, no dependencies). `wasim.mjs` is the Web Audio simulator,
  `meter-bosh.mjs` a metering rig (both skipped by the runner).

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
- **Chorus — BUILT (per-lane, Juno-60).** A BBD chorus insert before the delay: ~5 ms `DelayNode`
  swept by triangle LFO(s), anti-phase +L/−R stereo, On + Mode (I/II/I+II) only — see the Per-lane
  chorus note above. (The same module would yield **flanger / vibrato / tremolo** by changing ranges,
  if wanted later.)
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

// scheduler.js — a lookahead scheduler with finite looping.
//
// A coarse JS timer wakes often and hands the audio engine any notes due within
// a short window, stamped with sample-accurate Web Audio times. The score is
// supplied by a *provider* function, re-read at the start of every loop cycle —
// so edits made while playing commit cleanly at the next loop boundary, and
// tempo changes take effect there too. Looping is finite with a countdown.
//
// `resync()` adds finer, mid-cycle reconciliation for the tile player, where the
// commit unit is the *tile*: a note carries its tile's start beat (`tileStart`),
// and on a live edit we keep the notes of tiles that have already started
// ("locked" once playing) while taking tiles that haven't started yet from the
// fresh read. The cycle length then follows the live arrangement, so an appended
// tile plays this pass and the playhead stays in sync.

const LOOKAHEAD = 0.1;       // seconds of audio scheduled ahead of time
const TICK_MS = 25;          // how often the scheduler wakes up

export class Scheduler {
  constructor(engine) {
    this.engine = engine;
    this.timer = null;
    this.loop = false;
    this.remaining = 0;       // cycles still to play, including the current one
  }

  get isPlaying() { return this.timer !== null; }
  get isLooping() { return this.isPlaying && this.loop; }

  // Position within the current cycle, in beats, for the playhead. Tracks a
  // "display cycle" (start time + length) that advances at the real audio-time
  // boundary — independent of the scheduler's lookahead-early advance — and whose
  // length follows the live cycle, so the playhead stays synced when the loop's
  // length changes mid-play (append / shrink).
  get currentBeat() {
    if (!this.isPlaying || this.displayCycleStart == null || this.displayCycleSeconds == null) return 0;
    const t = this.engine.currentTime;
    while (this.displayCycleSeconds > 0 && t >= this.displayCycleStart + this.displayCycleSeconds) {
      this.displayCycleStart += this.displayCycleSeconds;
      this.displayCycleSeconds = this.cycleSeconds; // next display cycle uses the live length
    }
    return (t - this.displayCycleStart) / this.spb;
  }

  // provider() -> Score (re-read each cycle). repeats: 1 = one-shot.
  start(provider, startTime, repeats, loop) {
    this.provider = provider;
    this.startTime = startTime;
    this.cycleStart = startTime;
    this.remaining = repeats;
    this.loop = loop;
    this.displayCycleStart = startTime;
    this.displayCycleSeconds = null;
    this._beginCycle();
    this._tick();
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.loop = false;
  }

  // Reset the countdown without interrupting playback ("keep it going" tap).
  rearm(repeats) {
    if (this.isLooping) this.remaining = repeats;
  }

  // Read the current pattern into a fresh cycle. The first cycle's metrics are
  // captured for the playhead.
  _beginCycle() {
    const score = this.provider();
    this.cycleNotes = [...score.notes].sort((a, b) => a.start - b.start);
    this.nextIndex = 0;
    this.spb = score.secondsPerBeat;
    // Fraction of each note's slot that actually sounds (<1 = non-legato). The
    // notes themselves carry full slot durations; we shorten at schedule time.
    this.articulation = score.articulation != null ? score.articulation : 1;
    this.cycleSeconds = score.lengthBeats * this.spb;
    if (this.displayCycleSeconds == null) {
      this.displayCycleSeconds = this.cycleSeconds || this.spb;
    }
    // Hand the freshly-read score to the view so the roll tracks live edits
    // that commit at each cycle/loop boundary.
    if (this.onCycle) this.onCycle(score);
  }

  // Mid-cycle reconciliation against the live provider (tile-player edits).
  // Tiles already playing are "locked": their notes are kept from the snapshot
  // that was sounding when they started. Tiles that haven't started yet are taken
  // from the fresh read — so an appended tile plays this pass, and edits to a
  // not-yet-started tile land when it starts. The cycle length follows the live
  // arrangement (extends on append, contracts on shrink). Already-scheduled notes
  // (within the lookahead window) are untouched — the irreducible ~100 ms.
  resync() {
    if (!this.isPlaying || !this.provider) return;
    const fresh = this.provider();
    // Beats already committed to audio: anything up to the lookahead horizon. A
    // tile whose start is at/under this has begun → it's locked.
    const horizonBeat = (this.engine.currentTime + LOOKAHEAD - this.cycleStart) / this.spb;
    const started = (n) => (n.tileStart ?? 0) <= horizonBeat;

    const committed = this.cycleNotes.slice(0, this.nextIndex); // already scheduled
    const lockedTail = this.cycleNotes.slice(this.nextIndex).filter(started); // playing tiles, not yet scheduled
    const freshFuture = fresh.notes.filter((n) => !started(n));               // tiles not yet begun → live
    const future = lockedTail.concat(freshFuture).sort((a, b) => a.start - b.start);

    this.cycleNotes = committed.concat(future);
    this.nextIndex = committed.length;
    this.cycleSeconds = fresh.lengthBeats * this.spb;     // cycle end follows the live length
    this.displayCycleSeconds = this.cycleSeconds;          // keep the playhead wrap on the live end
  }

  _tick() {
    const horizon = this.engine.currentTime + LOOKAHEAD;

    // May cross one or more cycle boundaries within a single tick.
    for (;;) {
      while (this.nextIndex < this.cycleNotes.length) {
        const note = this.cycleNotes[this.nextIndex];
        const noteTime = this.cycleStart + note.start * this.spb;
        if (noteTime > horizon) return;
        // Every note is scheduled (even from muted lanes) and routed by laneId;
        // Mute/Solo is applied downstream by the lane's gain bus, so it acts in
        // real time on present tails and future notes alike (no re-snapshot).
        this.engine.playNote(note.pitch, noteTime, note.duration * this.articulation * this.spb, note.velocity, note.freq, note.laneId);
        this.nextIndex++;
      }

      const cycleEnd = this.cycleStart + this.cycleSeconds;

      if (this.remaining <= 1) {
        // Last (or only) cycle — let its tail sound, then finish.
        if (this.engine.currentTime >= cycleEnd) {
          this.stop();
          if (this.onEnded) this.onEnded();
        }
        return;
      }

      // More cycles to go: advance once the window reaches the boundary.
      if (horizon >= cycleEnd) {
        this.cycleStart = cycleEnd;
        this.remaining--;
        this._beginCycle();   // re-read the pattern (live edits land here)
      } else {
        return;
      }
    }
  }
}

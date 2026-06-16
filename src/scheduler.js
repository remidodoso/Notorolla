// scheduler.js — a lookahead scheduler with finite looping.
//
// A coarse JS timer wakes often and hands the audio engine any notes due within
// a short window, stamped with sample-accurate Web Audio times. The score is
// supplied by a *provider* function that is re-read at the start of every loop
// cycle — so edits made while playing commit cleanly at the next loop boundary,
// and tempo changes take effect there too. Looping is finite with a countdown.

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

  // Position within the current cycle, in beats, for the playhead. Uses the
  // first cycle's length/tempo as a stable reference so it wraps smoothly.
  get currentBeat() {
    if (!this.isPlaying || this.displayCycleSeconds == null) return 0;
    const elapsed = this.engine.currentTime - this.startTime;
    const cs = this.displayCycleSeconds;
    const within = ((elapsed % cs) + cs) % cs;
    return within / this.displaySpb;
  }

  // provider() -> Score (re-read each cycle). repeats: 1 = one-shot.
  start(provider, startTime, repeats, loop) {
    this.provider = provider;
    this.startTime = startTime;
    this.cycleStart = startTime;
    this.remaining = repeats;
    this.loop = loop;
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
      this.displaySpb = this.spb;
    }
    // Hand the freshly-read score to the view so the roll tracks live edits
    // that commit at each cycle/loop boundary.
    if (this.onCycle) this.onCycle(score);
  }

  _tick() {
    const horizon = this.engine.currentTime + LOOKAHEAD;

    // May cross one or more cycle boundaries within a single tick.
    for (;;) {
      while (this.nextIndex < this.cycleNotes.length) {
        const note = this.cycleNotes[this.nextIndex];
        const noteTime = this.cycleStart + note.start * this.spb;
        if (noteTime > horizon) return;
        // `muted` notes (from a silenced lane) stay in the score so the roll can
        // still show them hatched, but they don't sound.
        if (!note.muted) {
          this.engine.playNote(note.pitch, noteTime, note.duration * this.articulation * this.spb, note.velocity, note.freq);
        }
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

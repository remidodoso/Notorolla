// score.js — the score-building layer: turns the grid pattern / arrangement +
// play-region into Score objects for the roll, audition, transport and export.
// Pure-ish (data-in/data-out over the shared model); the future-WASM-friendly
// seam. Reads stable objects (library/arrangement/scheduler/gridPatch/state) via
// ctx; the transport mutables it touches (proposal, activePane, resumeBeat,
// resumeStartTime) are ctx fields whose writers live in other clusters.

import { Score, Note } from '../core/model.js';
import { Pattern, DEFAULT_ARTIC } from '../core/grid.js';
import { mergeAudition } from '../core/reference.js';
import { applyTransforms } from '../core/transforms.js';
import { laneColor } from '../core/library.js';
import { reverbSeconds } from '../audio/reverb.js';
import { patchRelease } from '../audio/instrument.js';

const TAIL_CEILING = 8;
const REF_QUIET = 0.4; // reference velocity multiplier when "Soft" is on (~ −8 dB)

export function initScore(ctx) {
  const { library, arrangement, scheduler, gridPatch } = ctx;
  const state = ctx.state;

  // The longest reverb tail any lane needs at the end of a bounce (the IR decay
  // + predelay of every enabled insert; 0 when none are on).
  function maxReverbTail() {
    let tail = 0;
    for (const lane of arrangement.lanes) {
      if (lane.reverb && lane.reverb.on) tail = Math.max(tail, reverbSeconds(lane.reverb) + (lane.reverb.predelay || 0));
    }
    return tail;
  }

  // The default export tail (seconds): let the longest-releasing lane + reverb ring
  // out, but CEILING it at 8s. A long delay/feedback wash can ring for many more
  // seconds; we deliberately don't chase that (the mixer usually rolls it off) — the
  // export dialogs pre-fill this value in an editable field, so a user who wants a
  // longer (or shorter) tail just types it.
  function computeTail() {
    const maxRelease = Math.max(patchRelease(gridPatch), ...arrangement.lanes.map((l) => patchRelease(l.patch)));
    return Math.min(TAIL_CEILING, Math.max(2.5, maxRelease * 6 + 0.5) + maxReverbTail());
  }

  // The grid's score, with any prospective Triadulator notes merged in so they
  // play and audition like real notes (but stay un-set until Confirm).
  function buildScore() {
    const cur = library.current();
    if (!ctx.proposal.length) return cur.toScore(state.bpm, state.articulation);
    const cols = cur.columns.map((c) => ({ ...c }));
    for (const p of ctx.proposal) cols[p.col] = { durIndex: p.durIndex, isRest: false, degree: p.degree, accent: 0, artic: DEFAULT_ARTIC };
    const tmp = new Pattern(cols, cur.name);
    tmp.tuningId = cur.tuningId; tmp.scaleId = cur.scaleId; tmp.root = cur.root; // resolve in the same tuning
    return tmp.toScore(state.bpm, state.articulation);
  }

  // The grid transport's provider: the pattern PLUS the reference backdrop merged in
  // (audition only — the roll's static view stays grid-only via buildScore).
  function buildAuditionScore() { return withReference(buildScore()); }

  // Merge the reference backdrop into a grid score for AUDITION (never the export —
  // the reference isn't part of the composition). The tiling/attenuation/patch-tag
  // math is pure in reference.js (mergeAudition); here we wrap it in a Score.
  function withReference(gridScore) {
    if (!state.reference || state.reference.muted) return gridScore;
    const { notes, total } = mergeAudition(state.reference, gridScore.notes, gridScore.lengthBeats, state.bpm, state.articulation, REF_QUIET);
    return new Score(notes, state.bpm, state.articulation, total);
  }

  function patternLen(name) {
    const p = library.patterns.get(name);
    return p ? p.toScore(state.bpm, state.articulation).lengthBeats : 0;
  }

  // Old projects stored tiles gaplessly (no `start`); derive starts from the
  // cumulative order so they open identically. No-op once tiles carry `start`.
  function ensureTileStarts() {
    for (const lane of arrangement.lanes) {
      let acc = 0;
      for (const tile of lane.tiles) {
        if (tile.start == null) tile.start = acc;
        acc = tile.start + patternLen(tile.name);
      }
      lane.tiles.sort((a, b) => a.start - b.start);
    }
  }

  // Overlay all lanes in parallel (each from t=0) into one score; the length is
  // the longest lane. Notes carry their lane color, dimmed for non-active lanes.
  function arrangementScore() {
    const notes = [];
    let maxLen = 0;
    const audible = arrangement.audibleLaneIds(); // mute/solo: which lanes sound
    arrangement.lanes.forEach((lane, li) => {
      const color = lane.color || laneColor(li);
      const alpha = lane.id === arrangement.activeLaneId ? 1 : 0.3; // focus dim
      const muted = !audible.has(lane.id);                          // silent → hatched, not sounded
      for (const tile of lane.tiles) {
        const p = library.patterns.get(tile.name);
        if (!p) continue;
        const s = p.toScore(state.bpm, state.articulation);
        // Per-tile transforms (nondestructive): run the tile's ordered transform
        // list over its note list (transpose maps pitch + re-resolves freq in the
        // tile's tuning; reverse retrogrades within the tile length), then offset by
        // tile.start.
        const src = tile.transforms
          ? applyTransforms(
              s.notes.map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity, freq: n.freq, artDur: n.artDur })),
              tile.transforms, { lengthBeats: s.lengthBeats, tuningId: p.tuningId, root: p.root })
          : s.notes;
        for (const n of src) {
          const nn = new Note(n.pitch, n.start + tile.start, n.duration, n.velocity);
          nn.freq = n.freq;         // carry each pattern's tuning-resolved frequency
          nn.artDur = n.artDur;     // articulated (sounded) length in beats
          nn.detune = n.detune;     // per-tile detune transform, in cents (for the nonlinear voices)
          nn.color = color;
          nn.alpha = alpha;
          nn.laneId = lane.id;      // routes the voice through this lane's gain bus
          nn.muted = muted;         // for the roll's hatch (audio mute is the lane bus)
          nn.tileStart = tile.start; // this tile's start beat — the scheduler's commit unit
          nn.rulerBeat = nn.start;  // absolute timeline position (survives region windowing) — the "Loop Mod" anchor
          notes.push(nn);
        }
        maxLen = Math.max(maxLen, tile.start + s.lengthBeats); // tiles are freely positioned
      }
    });
    return new Score(notes, state.bpm, state.articulation, maxLen);
  }

  // End beat of the whole arrangement (the last tile's end), without building a
  // full score — also the default play-region end when no end marker is set.
  function arrangementEndBeat() {
    let end = 0;
    for (const lane of arrangement.lanes) {
      for (const tile of lane.tiles) end = Math.max(end, tile.start + patternLen(tile.name));
    }
    return end;
  }

  // The resolved play-region bounds in beats. Start is always present; end falls
  // back to the arrangement end when no marker is set. Clamped so start < end.
  function playStartBeat() {
    return Math.max(0, Math.min(arrangement.playStart || 0, Math.max(0, arrangementEndBeat() - 1)));
  }
  function playEndBeat() {
    const contentEnd = arrangementEndBeat();
    const end = arrangement.playEnd == null ? contentEnd : Math.min(arrangement.playEnd, contentEnd);
    return Math.max(end, playStartBeat() + 1);
  }

  // The scheduler's provider for tile playback: the arrangement score windowed to
  // the play region — notes triggering within [start, end), shifted so the region
  // begins at beat 0, with the cycle length = the region length. So Play and Loop
  // both honor the markers, and the scheduler/resync logic is unchanged (it just
  // sees a shorter score). Default markers (0 … arrangement end) = the whole thing.
  function windowedArrangementScore() {
    // A resume narrows the FIRST pass to [playhead, end). The scheduler re-reads
    // this provider at every loop boundary with cycleStart advanced past the start
    // we armed — those reads get the full region again, so a resumed play that
    // loops wraps to the region start, not the resume point.
    if (ctx.resumeBeat != null && scheduler.cycleStart !== ctx.resumeStartTime) ctx.resumeBeat = null;
    const score = arrangementScore();
    const start = ctx.resumeBeat != null ? ctx.resumeBeat : playStartBeat();
    const end = playEndBeat();
    if (start <= 0 && end >= score.lengthBeats) return score; // full range — no windowing
    const notes = score.notes.filter((n) => n.start >= start && n.start < end);
    for (const n of notes) { n.start -= start; n.tileStart -= start; }
    return new Score(notes, state.bpm, state.articulation, end - start);
  }

  // The tiles currently sounding — one per audible lane whose timeline covers
  // `beat` (muted / solo-silenced lanes don't get the "playing" highlight).
  function playingTileIds(beat) {
    const ids = new Set();
    const audible = arrangement.audibleLaneIds();
    for (const lane of arrangement.lanes) {
      if (!audible.has(lane.id)) continue;
      for (const tile of lane.tiles) {
        if (beat >= tile.start && beat < tile.start + patternLen(tile.name)) { ids.add(tile.id); break; }
      }
    }
    return ids;
  }

  // Start beat of a tile (its explicit position on the lane's timeline).
  function tileStartBeat(id) {
    const lane = arrangement.laneOfTile(id);
    const tile = lane && lane.tiles.find((t) => t.id === id);
    return tile ? tile.start : 0;
  }

  // The roll mirrors the active pane: the grid's current pattern, or the whole
  // arrangement when the tile player is active.
  function activeScore() {
    return ctx.activePane === 'tiles' ? arrangementScore() : buildScore();
  }

  Object.assign(ctx, {
    maxReverbTail, computeTail, buildScore, buildAuditionScore, withReference,
    patternLen, ensureTileStarts, arrangementScore, arrangementEndBeat,
    playStartBeat, playEndBeat, windowedArrangementScore, playingTileIds,
    tileStartBeat, activeScore,
  });
}

// transport.js — playback: scheduler wiring, the render/animation loop, the
// parked playhead + transport buttons, tempo, the mod-clock, the Lite toggle,
// and playback auto-scroll. The scheduler itself is constructed in main.js (like
// the view instances) and registered as ctx.scheduler; this module drives it.
// `activeSource` lives here but is exposed as ctx.activeSource (read across
// clusters); `passBase`/`lastCurBeat`/`rafId` stay module-local.

export const LOOP_MAX = 8;
export const LOOP_STEP = 4;

export function initTransport(ctx) {
  const { engine, roll, tilePlayer, arrangement, scheduler } = ctx;
  const state = ctx.state;

  // --- transport-local state --------------------------------------------
  // Display-side pass origin: the absolute beat the CURRENT pass began at. Equals
  // the resume point during a resumed first pass, the region start otherwise;
  // renderLoop flips it forward when the loop wraps.
  let passBase = 0;
  let lastCurBeat = 0;
  let rafId = null;
  let transportSig = null; // last-applied button state — updateTransportButtons runs per frame
  let laneHeadW = 0;       // sticky tile-lane head width — runtime-constant, read from the DOM once

  ctx.activeSource = null; // 'grid' | 'tiles' | 'audit' | null — one transport at a time
  // Resume (ArrowRight): the FIRST pass runs from this beat instead of the region
  // start; null = a normal from-the-top play. Read by windowedArrangementScore.
  ctx.resumeBeat = null;
  ctx.resumeStartTime = 0; // the scheduler startTime a pending resume was armed for

  // --- DOM refs (own copies; shared elements are re-acquired per module) -
  const loopBtn = document.getElementById('loop');
  const playBtn = document.getElementById('play');
  const stopBtn = document.getElementById('stop');
  const tilePlayBtn = document.getElementById('tilePlay');
  const tileStopBtn = document.getElementById('tileStop');
  const tileLoopBtn = document.getElementById('tileLoop');
  const phHomeBtn = document.getElementById('phHome');
  const phEndBtn = document.getElementById('phEnd');
  const tempo = document.getElementById('tempo');
  const tempoLabel = document.getElementById('tempoLabel');
  const modLoopBtn = document.getElementById('modLoop');
  const modClockEl = document.getElementById('modClock');
  const liteBox = document.getElementById('liteInstruments');
  const midiExportBtn = document.getElementById('midiExport');
  const quickExportBtn = document.getElementById('quickExport');
  const audioExportBtn = document.getElementById('audioExport');
  const stemExportBtn = document.getElementById('stemExport');
  const rollScroll = document.getElementById('rollScroll');

  // Beat position → "m:ss" wall-clock at the current tempo (for the range readout).
  function fmtClock(beats) {
    const sec = Math.round(beats * (60 / state.bpm));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // --- scheduler wiring (the scheduler is constructed in main.js) --------
  // Natural finish (one-shot ended, loop passes exhausted): the playhead rewinds
  // to the beginning. A manual Stop parks it in place instead (see stop()).
  scheduler.onEnded = () => {
    if (ctx.activeSource === 'tiles') {
      state.playheadBeat = ctx.playStartBeat();
      tilePlayer.setPlayhead(state.playheadBeat);
      ensureTileVisible(state.playheadBeat); // follow the rewind back into view
    }
    ctx.resumeBeat = null;
  };
  scheduler.onCycle = (score) => { roll.setScore(score); };

  // --- playback auto-scroll ---------------------------------------------
  // Playback auto-follow is PAGE-JUMP scrolling (DAW-style), not continuous: the
  // view holds still while the playhead sweeps across it, and JUMPS a page (the
  // playhead re-enters at the left margin) only when it runs off the right edge.
  // Scrolling the whole track layer a little every frame was the remaining
  // playback scroll cost — an occasional jump is cheap (and easier to watch).
  function ensureRollVisible(x) {
    const el = rollScroll;
    const headW = roll.gutter ? roll.gutter.width : 0; // the pinned label gutter overlays the left edge
    const margin = 60;
    if (x > el.scrollLeft + el.clientWidth - margin || x < el.scrollLeft + headW) {
      el.scrollLeft = Math.max(0, x - headW - margin);
    }
  }
  // Same page-jump follow for the tile player. The playhead's x within the scroll
  // content is the (sticky) lane-header width plus its track position, so a jump
  // lands it just right of the header, never behind it.
  function ensureTileVisible(beat) {
    const el = document.getElementById('tileLane');
    if (!laneHeadW) {
      const head = el.querySelector('.lane-head');
      laneHeadW = head ? head.offsetWidth : 0;
    }
    const x = laneHeadW + beat * tilePlayer.ppb;
    const margin = 80;
    if (x > el.scrollLeft + el.clientWidth - margin || x < el.scrollLeft + laneHeadW) {
      el.scrollLeft = Math.max(0, x - laneHeadW - margin);
    }
  }

  // --- mod-clock + workspace toggles ------------------------------------
  // Global "Loop Mod" toggle: all modulators on ruler time (reset each loop pass)
  // vs elapsed time from the session's first Play. A workspace preference.
  modLoopBtn.className = 'tbtn' + (state.modLoop ? ' active' : '');
  modLoopBtn.addEventListener('click', () => {
    state.modLoop = !state.modLoop;
    modLoopBtn.classList.toggle('active', state.modLoop);
    ctx.persist();
  });

  // "Lite Instruments" — a workspace preference (not part of the document): the
  // heavy voices (Wendelhorn, Nayumi) build a cheaper live graph to avoid dropouts.
  // Read fresh at every note-on, so toggling takes effect on the next note; offline
  // exports never see it, so a bounce is always the full voice.
  liteBox.checked = state.lite;
  liteBox.addEventListener('change', () => {
    state.lite = liteBox.checked;
    engine.lite = state.lite;
    ctx.persist();
  });

  // The transport clock (mm:ss.hh). Stopped (or grid playing): the parked
  // playhead's position — regardless of Loop Mod. While the tiles play: the clock
  // the mods actually read — elapsed since the session's first Play, or the
  // playhead's ruler time when Loop Mod is on. Cheap fixed interval; only writes
  // the DOM when the text changes.
  function modClockText() {
    let sec;
    if (!(scheduler.isPlaying && ctx.activeSource === 'tiles')) {
      sec = clampPlayhead(state.playheadBeat) * (60 / state.bpm);
    } else if (state.modLoop) {
      sec = (passBase + scheduler.currentBeat) * (60 / state.bpm);
    } else {
      sec = engine.modEpoch != null ? Math.max(0, engine.currentTime - engine.modEpoch) : 0;
    }
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const h = Math.floor((sec % 1) * 100);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(m)}:${p2(s)}.${p2(h)}`;
  }
  setInterval(() => {
    const t = modClockText();
    if (modClockEl.textContent !== t) modClockEl.textContent = t;
  }, 50);

  // --- the render / animation loop --------------------------------------
  function renderLoop() {
    // No roll playhead for a tile audition — the roll shows the arrangement (or
    // grid pattern), not the one tile being auditioned, so a sweep would lie.
    const rollBeat = scheduler.isPlaying && ctx.activeSource !== 'audit' ? scheduler.currentBeat : null;
    roll.draw(rollBeat);
    if (rollBeat != null) {
      ensureRollVisible(roll.xForBeat(rollBeat));
      if (ctx.activeSource === 'tiles') {
        // The scheduler runs in pass-relative beats (the windowed score); the tile
        // timeline is absolute, so add the pass origin back. When the position
        // jumps backward the loop wrapped — passes after the first always start at
        // the region start (a resume offsets only its own pass).
        const cur = scheduler.currentBeat;
        if (cur < lastCurBeat) passBase = ctx.playStartBeat();
        lastCurBeat = cur;
        const absBeat = passBase + cur;
        // The playhead marks real playback position — shown even mid-drag.
        tilePlayer.setPlayhead(absBeat);
        ensureTileVisible(absBeat);
        // The green "playing" badge is suppressed during a drag (prospective slots).
        if (!ctx.tileDrag) tilePlayer.setPlaying(ctx.playingTileIds(absBeat));
      } else {
        tilePlayer.setPlayhead(state.playheadBeat); // grid playback: the parked playhead stays put
      }
    }
    updateTransportButtons();
    if (scheduler.isPlaying) {
      rafId = requestAnimationFrame(renderLoop);
    } else {
      rafId = null;
      ctx.activeSource = null;
      tilePlayer.setPlaying(new Set());
      tilePlayer.setPlayhead(state.playheadBeat); // parked — the playhead never hides
      ctx.refresh();
    }
  }

  function startRender() { if (rafId === null) renderLoop(); }

  async function startTransport(source, loop, fromBeat = null) {
    if (source === 'tiles' && arrangement.allTiles().length === 0) return;
    ctx.setActive(source);
    const now = await engine.ensureRunning();
    // The "elapsed" modulator clock's zero: the session's FIRST Play, counting up
    // from there (later plays do NOT reset it — modulators keep evolving).
    if (engine.modEpoch == null) engine.modEpoch = now;
    scheduler.stop();
    ctx.activeSource = source;
    // Arm a resume only when it lands strictly inside the region — at/before the
    // start it's just a normal play, at/after the end there'd be nothing to hear.
    ctx.resumeBeat = source === 'tiles' && fromBeat != null
      && fromBeat > ctx.playStartBeat() && fromBeat < ctx.playEndBeat() ? fromBeat : null;
    ctx.resumeStartTime = now + 0.1;
    passBase = ctx.resumeBeat != null ? ctx.resumeBeat : ctx.playStartBeat();
    // -Infinity, NOT 0: playback starts 100 ms in the future, so the first frames'
    // currentBeat is slightly NEGATIVE — seeding 0 would read that as a loop wrap
    // and instantly reset passBase, drawing a resumed pass's playhead at the start.
    lastCurBeat = -Infinity;
    if (source === 'tiles') ctx.applyLaneGains(0); // set mute/solo before the first note
    const provider = source === 'tiles' ? ctx.windowedArrangementScore : ctx.buildAuditionScore;
    scheduler.start(provider, now + 0.1, loop ? LOOP_STEP : 1, loop);
    startRender();
    updateTransportButtons();
  }

  // Loop tap: queue, don't interrupt. If this source is already playing — whether
  // looping OR a one-shot still in progress — promote it to a loop in place and
  // add LOOP_STEP passes (capped), without restarting. Only a stopped/other source
  // starts fresh.
  function loopClick(source) {
    if (ctx.activeSource === source && scheduler.isPlaying) {
      scheduler.loop = true; // promote a one-shot in progress to a loop
      scheduler.remaining = Math.min(scheduler.remaining + LOOP_STEP, LOOP_MAX);
      updateTransportButtons();
      return;
    }
    startTransport(source, true);
  }

  function stop() {
    // A manual Stop parks the playhead where playback was (a natural finish
    // rewinds it to the beginning instead — see scheduler.onEnded).
    const wasTiles = scheduler.isPlaying && ctx.activeSource === 'tiles';
    if (wasTiles) {
      state.playheadBeat = clampPlayhead(passBase + scheduler.currentBeat);
    }
    scheduler.stop();
    ctx.activeSource = null;
    ctx.auditTileId = null;
    ctx.resumeBeat = null;
    tilePlayer.setPlaying(new Set());
    tilePlayer.setPlayhead(state.playheadBeat);
    ctx.refresh();
    if (wasTiles) ensureTileVisible(state.playheadBeat); // stop with the playhead in view
  }

  // --- the parked playhead ----------------------------------------------
  // Where the tile transport sits when stopped (beats, absolute; always visible).
  // Space plays from the region start; ArrowRight resumes from the parked spot.
  function clampPlayhead(beat) {
    return Math.max(0, Math.min(beat || 0, ctx.arrangementEndBeat()));
  }

  // Park the playhead (⏮/⏭ buttons, B/E keys) and scroll it into view. Stopped
  // transport only — live locate is a bigger feature, deliberately not this one.
  function movePlayhead(beat) {
    if (scheduler.isPlaying) return;
    state.playheadBeat = clampPlayhead(beat);
    tilePlayer.setPlayhead(state.playheadBeat);
    ensureTileVisible(state.playheadBeat);
    ctx.persist();
  }

  // ArrowRight: play the arrangement from the parked playhead — one pass of
  // [playhead, region end); a Shift+Space loop promotion wraps to the region start.
  function resumePlay() {
    if (scheduler.isPlaying || arrangement.allTiles().length === 0) return;
    if (state.playheadBeat >= ctx.playEndBeat()) return; // parked at/after the end — nothing to play
    startTransport('tiles', false, state.playheadBeat);
  }

  function updateTransportButtons() {
    const playing = scheduler.isPlaying;
    const haveTiles = arrangement.allTiles().length > 0;
    // Everything below derives from these inputs; skip the DOM when none changed.
    const sig = `${playing}|${haveTiles}|${ctx.activeSource}|${scheduler.isLooping}|${scheduler.remaining}|${ctx.exporting}|${ctx.exportingStems}`;
    if (sig === transportSig) return;
    transportSig = sig;

    playBtn.disabled = playing;
    stopBtn.disabled = !playing;
    tilePlayBtn.disabled = playing || !haveTiles;
    tileStopBtn.disabled = !playing;
    tileLoopBtn.disabled = !haveTiles;
    phHomeBtn.disabled = phEndBtn.disabled = playing; // playhead parks only while stopped
    midiExportBtn.disabled = !haveTiles;
    quickExportBtn.disabled = ctx.exporting || !haveTiles;
    audioExportBtn.disabled = ctx.exporting || !haveTiles;
    stemExportBtn.disabled = ctx.exportingStems || !haveTiles;

    const gridLooping = ctx.activeSource === 'grid' && scheduler.isLooping;
    loopBtn.textContent = loopLabel(gridLooping);
    loopBtn.classList.toggle('active', gridLooping);

    const tilesLooping = ctx.activeSource === 'tiles' && scheduler.isLooping;
    tileLoopBtn.textContent = loopLabel(tilesLooping);
    tileLoopBtn.classList.toggle('active', tilesLooping);

    ctx.syncInspectorTransport(); // mirror onto the inspector's play/stop/loop cluster
  }

  // Complete repeats still to come after the current pass; nothing on the last.
  function loopLabel(looping) {
    if (!looping) return '↻';
    const complete = scheduler.remaining - 1;
    return complete > 0 ? `↻ ${complete}` : '↻';
  }

  // --- listeners --------------------------------------------------------
  loopBtn.addEventListener('click', () => loopClick('grid'));
  playBtn.addEventListener('click', () => startTransport('grid', false));
  stopBtn.addEventListener('click', stop);
  tileLoopBtn.addEventListener('click', () => loopClick('tiles'));
  tilePlayBtn.addEventListener('click', () => startTransport('tiles', false));
  tileStopBtn.addEventListener('click', stop);
  phHomeBtn.addEventListener('click', () => movePlayhead(ctx.playStartBeat()));
  phEndBtn.addEventListener('click', () => movePlayhead(ctx.playEndBeat()));

  tempo.value = state.bpm;
  tempoLabel.textContent = `${state.bpm} BPM`;
  tempo.addEventListener('input', () => {
    state.bpm = Number(tempo.value);
    tempoLabel.textContent = `${state.bpm} BPM`;
    ctx.applyLaneDelayAll(); // delay time is tempo-synced
    ctx.refresh();
  });

  Object.assign(ctx, {
    fmtClock, ensureRollVisible, ensureTileVisible, startRender, startTransport,
    loopClick, stop, clampPlayhead, movePlayhead, resumePlay, updateTransportButtons,
  });
}

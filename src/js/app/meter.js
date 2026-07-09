// meter.js — the master fader + the continuous stereo output meter / clip LED,
// plus the opt-in level instrumentation (window.notorolla* hooks). initMeter
// runs after ctx.engine is constructed; it kicks the rAF loop (drawMeter) that
// reads engine.getPeak() every frame — 0 (idle) until audio starts.

export function initMeter(ctx) {
  const { engine } = ctx;
  const state = ctx.state;

  // --- master fader + output level meter --------------------------------

  const masterGainEl = document.getElementById('masterGain');
  masterGainEl.value = String(Math.round(state.masterGain * 100));
  masterGainEl.addEventListener('input', () => {
    state.masterGain = Number(masterGainEl.value) / 100;
    engine.setMasterGain(state.masterGain);
    ctx.persist();
  });

  // A continuous (cheap) STEREO meter loop: reads the per-channel output peaks and
  // draws two stacked dB bars (L over R) with peak-hold and a shared clip LED.
  // Runs from load; reads 0 (idle) until audio starts.
  const meterCanvas = document.getElementById('meter');
  const meterCtx = meterCanvas.getContext('2d');
  const clipLed = document.getElementById('clipLed');
  const MW = meterCanvas.width, MH = meterCanvas.height;
  const BAR_H = Math.floor((MH - 1) / 2);        // two bars + a 1px gap
  const chan = { l: { bar: 0, hold: 0, holdF: 0 }, r: { bar: 0, hold: 0, holdF: 0 } };
  let clipFrames = 0;     // clip LED latch (frames remaining lit) — either channel

  // Level instrumentation (opt-in). Session running-max + clip count, queryable
  // from the console via window.notorollaLevels(); set window.NOTO_LOG_LEVELS = true
  // to also log each clip (throttled). notorollaResetLevels() clears the stats.
  let peakMax = 0, clipCount = 0, lastClipLog = 0;
  const toDb = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -Infinity);
  window.notorollaLevels = () => ({ peakL: toDb(chan.l.bar), peakR: toDb(chan.r.bar), maxDb: toDb(peakMax), clips: clipCount });
  window.notorollaResetLevels = () => { peakMax = 0; clipCount = 0; };

  clipLed.addEventListener('click', () => { clipFrames = 0; clipLed.classList.remove('on'); });

  const dbToX = (db) => Math.max(0, Math.min(1, (db + 60) / 60)) * MW; // -60..0 dBFS across the bar
  const peakToX = (p) => (p > 0 ? dbToX(20 * Math.log10(p)) : 0);

  // Gradient is constant (depends only on width); build it once.
  const meterGrad = meterCtx.createLinearGradient(0, 0, MW, 0);
  meterGrad.addColorStop(0, '#4caf6a');
  meterGrad.addColorStop(dbToX(-12) / MW, '#7fc77a');
  meterGrad.addColorStop(dbToX(-6) / MW, '#d6c34e');
  meterGrad.addColorStop(dbToX(-3) / MW, '#e07a3a');
  meterGrad.addColorStop(1, '#ff5050');

  // Advance one channel's smoothed bar + peak-hold from this frame's peak.
  function stepChannel(c, peak) {
    c.bar = peak >= c.bar ? peak : Math.max(peak, c.bar * 0.85);
    if (peak >= c.hold) { c.hold = peak; c.holdF = 45; }
    else if (c.holdF > 0) c.holdF--;
    else c.hold *= 0.94;
  }

  function drawBar(y, c) {
    meterCtx.fillStyle = meterGrad;
    meterCtx.fillRect(0, y, peakToX(c.bar), BAR_H);
    const hx = peakToX(c.hold);
    if (hx > 0) { meterCtx.fillStyle = '#e8eaf0'; meterCtx.fillRect(Math.min(MW - 1, hx - 1), y, 2, BAR_H); }
  }

  function drawMeter() {
    const { l, r } = engine.getPeak();
    stepChannel(chan.l, l);
    stepChannel(chan.r, r);
    const peak = Math.max(l, r);
    if (peak > peakMax) peakMax = peak;
    if (peak >= 1.0) {                           // clip = would clamp at the device (0 dBFS)
      clipFrames = 120;
      clipCount++;
      if (window.NOTO_LOG_LEVELS && performance.now() - lastClipLog > 500) {
        console.warn(`[noto level] CLIP — peak ${toDb(peak)} dBFS`);
        lastClipLog = performance.now();
      }
    } else if (clipFrames > 0) clipFrames--;
    clipLed.classList.toggle('on', clipFrames > 0);

    meterCtx.clearRect(0, 0, MW, MH);
    drawBar(0, chan.l);
    drawBar(MH - BAR_H, chan.r);

    requestAnimationFrame(drawMeter);
  }
  drawMeter();
}

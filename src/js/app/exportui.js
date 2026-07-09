// exportui.js — MIDI, single-file audio (WAV), and per-lane stem (BWF zip)
// export, plus the Export Audio / Export Stems dialogs (shared rate/range/tail
// controls). The `exporting`/`exportingStems` flags gate the buttons live.

import { notesToMidi } from '../export/midi.js';
import { encodeWav, encodeBwf } from '../export/wav.js';
import { zipStore } from '../export/zip.js';
import { downloadBytes, defaultName } from '../core/project.js';
import { instrument } from '../audio/instrument.js';
import { openModal } from '../ui/modal.js';

export function initExportui(ctx) {
  const { library, arrangement, state, engine } = ctx;
  const midiExportBtn = document.getElementById('midiExport');
  const quickExportBtn = document.getElementById('quickExport');
  const audioExportBtn = document.getElementById('audioExport');
  const stemExportBtn = document.getElementById('stemExport');
  const exportProgEl = document.getElementById('exportProg');

  // Export the tile-player arrangement as a Format-1 MIDI file: one named track
  // per non-empty lane, current tempo, one pass (no loop repeats). Note lengths
  // are articulated (×articulation) per the export choice; pitch is already MIDI.
  function exportMidi() {
    if (arrangement.allTiles().length === 0) return;
    const tracks = arrangement.lanes
      .map((lane, i) => {
        const notes = [];
        for (const tile of lane.tiles) {
          const p = library.patterns.get(tile.name);
          if (!p) continue;
          const s = p.toScore(state.bpm, state.articulation);
          for (const n of s.notes) {
            notes.push({
              pitch: n.pitch,
              startBeat: n.start + tile.start,
              durBeats: n.artDur != null ? n.artDur : n.duration * state.articulation,
              velocity: n.velocity,
            });
          }
        }
        return { name: `Lane ${i + 1}`, notes };
      })
      .filter((tr) => tr.notes.length > 0);
    if (!tracks.length) return;
    const bytes = notesToMidi(tracks, state.bpm, { tpqn: 480 });
    downloadBytes(`${ctx.projectName || defaultName()}.mid`, bytes, 'audio/midi');
  }

  // Export the tile-player arrangement to a WAV file: render the whole arrangement
  // (one pass, mute/solo respected, articulation applied) through the Vesperia via
  // an OfflineAudioContext, plus a release tail, then encode + download. Faster
  // than realtime; an indeterminate "Rendering…" bar shows while it works (offline
  // rendering has no portable progress event — Firefox lacks `suspend()`).
  // Mixdown to a single stereo WAV. `opts` (all optional; Quick Export passes none):
  //   sampleRate  render rate in Hz (default 48000)
  //   startBeat   region start; notes triggering before it are dropped (default 0)
  //   endBeat     region end; notes at/after it are dropped (default project end)
  //   tailSec     ring-out after the region end (default computeTail())
  // The region is always shifted so its start is file time 0 (a mixdown has no
  // notion of an offset — plain WAV, no BWF metadata).
  ctx.exporting = false;
  async function exportAudio(opts = {}) {
    if (ctx.exporting || arrangement.allTiles().length === 0) return;
    const score = ctx.arrangementScore();
    const spb = 60 / state.bpm;
    const sampleRate = opts.sampleRate || 48000;
    const startBeat = opts.startBeat || 0;
    const endBeat = opts.endBeat != null ? opts.endBeat : score.lengthBeats;
    const tail = opts.tailSec != null ? opts.tailSec : ctx.computeTail();
    const notes = [];
    for (const n of score.notes) {
      if (n.muted) continue; // silenced lanes (mute / solo) aren't rendered
      if (n.start < startBeat || n.start >= endBeat) continue; // outside the export range
      notes.push({
        pitch: n.pitch,
        time: (n.start - startBeat) * spb, // shift region start to file time 0
        duration: (n.artDur != null ? n.artDur : n.duration * state.articulation) * spb,
        velocity: n.velocity,
        freq: n.freq,
        laneId: n.laneId, // render through this lane's instrument patch
      });
    }
    if (!notes.length) return;
    const durSec = (endBeat - startBeat) * spb + tail;

    setExporting(true);
    try {
      const buffer = await engine.renderToBuffer(notes, durSec, sampleRate);
      downloadBytes(`${ctx.projectName || defaultName()}.wav`, encodeWav(buffer), 'audio/wav');
    } catch (err) {
      alert(`Audio export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  }

  // Quick Export and Export Audio… share the `exporting` flag, so both disable and
  // read "Rendering…" while a mixdown runs.
  function setExporting(on) {
    ctx.exporting = on;
    exportProgEl.classList.toggle('on', on);
    const haveTiles = arrangement.allTiles().length > 0;
    quickExportBtn.textContent = on ? 'Rendering…' : 'Quick Export';
    quickExportBtn.disabled = on || !haveTiles;
    audioExportBtn.textContent = on ? 'Rendering…' : 'Export Audio…';
    audioExportBtn.disabled = on || !haveTiles;
  }

  // Make a string safe as a filename across OSes (no \ / : * ? " < > |, no control
  // chars, trimmed of trailing dots/spaces). Empty falls back to 'Track'.
  function safeFileName(s) {
    const out = String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
    return out || 'Track';
  }

  // Export the arrangement as STEMS: one BWF (Broadcast Wave) per lane, bundled in
  // a zip. Every lane with notes is rendered (mute/solo ignored — you mute in the
  // DAW), all sharing one length + TimeReference 0 so they import aligned. The
  // bus mode (how much of the lane strip is baked in) is chosen in the dialog.
  // `opts`: busMode ('dry'|'postfader'|'baked'), sampleRate, startBeat, endBeat,
  // tailSec (as exportAudio), plus timeRefSamples — the BWF TimeReference written
  // into every stem. 0 = "region start is time 0" (stems align to each other);
  // a nonzero value = the region's absolute sample offset, so the DAW re-places the
  // set at its true project position on Import-at-Origin.
  ctx.exportingStems = false;
  async function exportStems(opts = {}) {
    if (ctx.exportingStems || arrangement.allTiles().length === 0) return;
    const busMode = opts.busMode || 'dry';
    const score = ctx.arrangementScore();
    const spb = 60 / state.bpm;
    const sampleRate = opts.sampleRate || 48000;
    const startBeat = opts.startBeat || 0;
    const endBeat = opts.endBeat != null ? opts.endBeat : score.lengthBeats;
    const tail = opts.tailSec != null ? opts.tailSec : ctx.computeTail();
    const timeRefSamples = opts.timeRefSamples != null ? opts.timeRefSamples : 0;
    // Group each lane's in-range notes (ignore n.muted: stems include muted lanes),
    // shifting the region start to file time 0.
    const byLane = new Map();
    for (const n of score.notes) {
      if (n.start < startBeat || n.start >= endBeat) continue;
      let arr = byLane.get(n.laneId);
      if (!arr) { arr = []; byLane.set(n.laneId, arr); }
      arr.push({
        pitch: n.pitch, time: (n.start - startBeat) * spb, duration: (n.artDur != null ? n.artDur : n.duration * state.articulation) * spb,
        velocity: n.velocity, freq: n.freq, laneId: n.laneId,
      });
    }
    if (byLane.size === 0) return;
    // One shared duration (region length + tail) so all stems are equal-length.
    const durSec = (endBeat - startBeat) * spb + tail;
    const proj = ctx.projectName || defaultName();

    setExportingStems(true);
    try {
      const now = new Date();
      const used = new Set();
      const files = [];
      for (let li = 0; li < arrangement.lanes.length; li++) {
        const lane = arrangement.lanes[li];
        const notes = byLane.get(lane.id);
        if (!notes || !notes.length) continue;   // skip empty lanes
        const buffer = await engine.renderStem(notes, durSec, lane.id, busMode, sampleRate);
        const label = instrument(lane.patch && lane.patch.kind).label;
        let base = safeFileName(`${String(li + 1).padStart(2, '0')} ${label}`);
        let name = base, k = 2;                   // de-dup same-instrument lanes
        while (used.has(name.toLowerCase())) name = `${base} (${k++})`;
        used.add(name.toLowerCase());
        const meta = {
          description: `${proj} - lane ${li + 1} (${label})`,
          originator: 'Notorolla', date: now, timeReferenceSamples: timeRefSamples,
        };
        files.push({ name: `${name}.wav`, bytes: encodeBwf(buffer, meta) });
      }
      if (!files.length) return;
      downloadBytes(`${safeFileName(proj)}-stems.zip`, zipStore(files, now), 'application/zip');
    } catch (err) {
      alert(`Stem export failed: ${err.message}`);
    } finally {
      setExportingStems(false);
    }
  }

  function setExportingStems(on) {
    ctx.exportingStems = on;
    exportProgEl.classList.toggle('on', on);
    stemExportBtn.textContent = on ? 'Rendering…' : 'Export Stems…';
    stemExportBtn.disabled = on || arrangement.allTiles().length === 0;
  }

  // Build the shared rate / range / tail controls into `body` (appends a .export-sec).
  // Returns accessors the dialog reads on Export, plus onRange(fn) so a caller can
  // react to the range choice (the stems dialog uses it to reveal the align option).
  function exportRangeControls(body) {
    const sec = document.createElement('div');
    sec.className = 'export-sec';

    // Sample rate — default 48 kHz, independent of the live device rate.
    const rateRow = document.createElement('div'); rateRow.className = 'export-row';
    const rateLbl = document.createElement('span'); rateLbl.className = 'export-lbl'; rateLbl.textContent = 'Sample rate';
    const rateSel = document.createElement('select');
    for (const [v, t] of [[44100, '44.1 kHz'], [48000, '48 kHz'], [96000, '96 kHz']]) {
      const o = document.createElement('option'); o.value = String(v); o.textContent = t; if (v === 48000) o.selected = true; rateSel.append(o);
    }
    rateRow.append(rateLbl, rateSel); sec.append(rateRow);

    // Range — whole project vs the marked region (offered only when markers narrow it).
    const startBeat = ctx.playStartBeat();
    const endBeat = ctx.playEndBeat();
    const fullEnd = ctx.arrangementEndBeat();
    const markersSet = startBeat > 0 || endBeat < fullEnd;
    let rangeChoice = 'entire';
    const rangeCbs = [];
    const rangeWrap = document.createElement('div'); rangeWrap.className = 'export-range';
    const mkRange = (id, text, detail, disabled) => {
      const lab = document.createElement('label');
      if (disabled) lab.className = 'disabled';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'exportRange'; radio.value = id; radio.disabled = !!disabled;
      if (id === 'entire') radio.checked = true;
      radio.addEventListener('change', () => { if (radio.checked) { rangeChoice = id; rangeCbs.forEach((f) => f(id)); } });
      const span = document.createElement('span'); span.textContent = text;
      if (detail) { const d = document.createElement('span'); d.className = 'export-range-detail'; d.textContent = detail; span.append(' ', d); }
      lab.append(radio, span);
      return lab;
    };
    rangeWrap.append(mkRange('entire', 'Entire project', `(end beat ${+fullEnd.toFixed(2)} · ${ctx.fmtClock(fullEnd)})`, false));
    const markerDetail = markersSet
      ? `Start beat ${+startBeat.toFixed(2)} (${ctx.fmtClock(startBeat)}) — End beat ${+endBeat.toFixed(2)} (${ctx.fmtClock(endBeat)})`
      : '(no markers set)';
    rangeWrap.append(mkRange('markers', 'Between markers', markerDetail, !markersSet));
    const rangeRow = document.createElement('div'); rangeRow.className = 'export-row';
    const rangeLbl = document.createElement('span'); rangeLbl.className = 'export-lbl'; rangeLbl.textContent = 'Range';
    rangeRow.append(rangeLbl, rangeWrap); sec.append(rangeRow);

    // Tail (seconds) — pre-filled with the computed default; free to override up or down.
    const tailRow = document.createElement('div'); tailRow.className = 'export-row';
    const tailLbl = document.createElement('span'); tailLbl.className = 'export-lbl'; tailLbl.textContent = 'Tail (sec)';
    const tailInput = document.createElement('input');
    tailInput.type = 'number'; tailInput.min = '0'; tailInput.step = '0.5'; tailInput.value = String(+ctx.computeTail().toFixed(1));
    tailRow.append(tailLbl, tailInput); sec.append(tailRow);

    body.append(sec);

    return {
      startBeat, markersSet,
      readRate: () => parseInt(rateSel.value, 10) || 48000,
      readRange: () => (rangeChoice === 'markers' ? { startBeat, endBeat } : { startBeat: 0, endBeat: null }),
      readTail: () => { const v = parseFloat(tailInput.value); return isFinite(v) && v >= 0 ? v : ctx.computeTail(); },
      onRange: (fn) => rangeCbs.push(fn),
    };
  }

  // The Export Audio… dialog: rate / range / tail, then a single-file mixdown.
  function openAudioModal() {
    if (ctx.exporting || arrangement.allTiles().length === 0) return;
    const body = document.createElement('div');
    body.className = 'stem-export';
    const intro = document.createElement('p');
    intro.className = 'stem-intro';
    intro.textContent = 'Render the arrangement to a single stereo WAV. The export always begins at time 0.';
    body.append(intro);

    const ctrls = exportRangeControls(body);

    const actions = document.createElement('div');
    actions.className = 'stem-actions';
    const go = document.createElement('button');
    go.className = 'stem-go'; go.textContent = 'Export';
    go.addEventListener('click', () => {
      modal.close();
      const r = ctrls.readRange();
      exportAudio({ sampleRate: ctrls.readRate(), startBeat: r.startBeat, endBeat: r.endBeat, tailSec: ctrls.readTail() });
    });
    actions.append(go);
    body.append(actions);

    const modal = openModal({ title: 'Export Audio', body });
  }

  // The stem-export dialog: pick the bus mode + rate/range/tail, then render. Dry default.
  const STEM_MODES = [
    { id: 'dry', label: 'Dry — pre-insert, pre-fader',
      desc: 'Voice only: no volume, pan, chorus or delay. The driest stems — process them in the DAW.' },
    { id: 'postfader', label: 'Post-fader — pre-limiter',
      desc: 'Volume, pan, chorus & delay baked in; the master limiter is left off, so stems sum back to the mix.' },
    { id: 'baked', label: 'Fully baked — incl. limiter',
      desc: 'As post-fader, plus the master limiter. Each stem sounds as it does soloed in the mix, but stems no longer sum exactly.' },
  ];
  function openStemModal() {
    if (ctx.exportingStems || arrangement.allTiles().length === 0) return;
    const body = document.createElement('div');
    body.className = 'stem-export';
    const intro = document.createElement('p');
    intro.className = 'stem-intro';
    intro.textContent = 'One Broadcast Wave (BWF) per lane, bundled in a zip — all equal-length and aligned. Choose how much of each lane’s strip to bake in:';
    body.append(intro);

    let chosen = 'dry';
    for (const m of STEM_MODES) {
      const row = document.createElement('label');
      row.className = 'stem-mode';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'stemMode'; radio.value = m.id;
      if (m.id === chosen) radio.checked = true;
      radio.addEventListener('change', () => { if (radio.checked) chosen = m.id; });
      const text = document.createElement('div');
      text.className = 'stem-mode-text';
      const t = document.createElement('div'); t.className = 'stem-mode-label'; t.textContent = m.label;
      const d = document.createElement('div'); d.className = 'stem-mode-desc'; d.textContent = m.desc;
      text.append(t, d);
      row.append(radio, text);
      body.append(row);
    }

    const ctrls = exportRangeControls(body);

    // "Treat Start marker as time 0" — only meaningful for a marker range starting
    // past beat 0. Checked → TimeReference 0 (each stem is its own clip at zero);
    // unchecked → TimeReference = the region's absolute sample offset, so the set
    // re-lands at its project position on Import-at-Origin.
    const alignWrap = document.createElement('div');
    const alignLab = document.createElement('label'); alignLab.className = 'export-check';
    const alignBox = document.createElement('input'); alignBox.type = 'checkbox'; alignBox.checked = true;
    const alignText = document.createElement('span'); alignText.textContent = 'Treat Start marker as time 0';
    alignLab.append(alignBox, alignText);
    const alignDesc = document.createElement('p'); alignDesc.className = 'export-check-desc';
    alignDesc.textContent = 'Off: stamp each stem’s BWF TimeReference with the marker’s offset, so the set re-lands at its project position on Import-at-Origin.';
    alignWrap.append(alignLab, alignDesc);
    body.append(alignWrap);
    const syncAlign = (id) => { alignWrap.style.display = (id === 'markers' && ctrls.startBeat > 0) ? '' : 'none'; };
    ctrls.onRange(syncAlign); syncAlign('entire');

    const actions = document.createElement('div');
    actions.className = 'stem-actions';
    const go = document.createElement('button');
    go.className = 'stem-go'; go.textContent = 'Export';
    go.addEventListener('click', () => {
      modal.close();
      const r = ctrls.readRange();
      const rate = ctrls.readRate();
      const spb = 60 / state.bpm;
      // Region-to-zero (checked, or no offset) → TimeReference 0; else the region's
      // absolute sample offset at the chosen rate.
      const timeRefSamples = (!alignBox.checked && r.startBeat > 0) ? Math.round(r.startBeat * spb * rate) : 0;
      exportStems({ busMode: chosen, sampleRate: rate, startBeat: r.startBeat, endBeat: r.endBeat, tailSec: ctrls.readTail(), timeRefSamples });
    });
    actions.append(go);
    body.append(actions);

    const modal = openModal({ title: 'Export Stems', body });
  }

  midiExportBtn.addEventListener('click', exportMidi);
  quickExportBtn.addEventListener('click', () => exportAudio()); // one-click defaults
  audioExportBtn.addEventListener('click', openAudioModal);
  stemExportBtn.addEventListener('click', openStemModal);
}

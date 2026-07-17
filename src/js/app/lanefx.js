// lanefx.js — per-lane mixer + effects: the volume/pan/mute/solo bus pushers,
// the delay/chorus/reverb/modulator modal editors (with a shared Copy/Paste
// bar and one-undo-step bracket), add-lane, and lane/player reset.

import { normalizeDelay, buildDelayEditor } from '../audio/delay.js';
import { normalizeChorus, buildChorusEditor } from '../audio/chorus.js';
import { normalizeReverb, buildReverbEditor } from '../audio/reverb.js';
import { MOD_SLOTS, defaultMod, buildModEditor, modTargetsFor } from '../audio/mods.js';
import { instrument } from '../audio/instrument.js';
import { openModal } from '../ui/modal.js';

export function initLanefx(ctx) {
  const { arrangement, engine, tilePlayer } = ctx;

  // Push every lane's volume + pan onto its bus (after undo/redo or a load, where
  // values change under existing strips; new strips read the resolver themselves).
  function applyLaneMix(rampSec = 0.012) {
    for (const lane of arrangement.lanes) {
      engine.setLaneVolume(lane.id, lane.gain, rampSec);
      engine.setLanePan(lane.id, lane.pan, rampSec);
    }
  }

  // (Re)apply every lane's delay to the engine — after a modal edit, a tempo
  // change (delay time is tempo-synced), or a load/undo.
  function applyLaneDelayAll() {
    for (const lane of arrangement.lanes) engine.applyLaneDelay(lane.id);
  }

  // (Re)apply every lane's chorus to the engine — after a modal edit or a load/undo.
  function applyLaneChorusAll() {
    for (const lane of arrangement.lanes) engine.applyLaneChorus(lane.id);
  }

  // (Re)apply every lane's reverb to the engine — after a modal edit or a load/undo.
  function applyLaneReverbAll() {
    for (const lane of arrangement.lanes) engine.applyLaneReverb(lane.id);
  }

  const fxClip = { delay: null, chorus: null, reverb: null };

  // A standardized Copy/Paste bar for the effect modals. Copy snapshots the config
  // into the per-type clipboard; Paste overwrites the config IN PLACE (so the lane's
  // object identity holds), applies it to the audio, and rebuilds the controls.
  function fxCopyBar(kind, cfg, normalize, apply, rebuild) {
    const bar = document.createElement('div');
    bar.className = 'fx-copybar';
    const copy = document.createElement('button');
    copy.className = 'tbtn'; copy.textContent = 'Copy'; copy.title = 'Copy these settings';
    const paste = document.createElement('button');
    paste.className = 'tbtn'; paste.textContent = 'Paste'; paste.title = 'Paste copied settings';
    paste.disabled = !fxClip[kind];
    copy.addEventListener('click', () => { fxClip[kind] = normalize(cfg); paste.disabled = false; });
    paste.addEventListener('click', () => {
      if (!fxClip[kind]) return;
      const next = normalize(fxClip[kind]);
      for (const k of Object.keys(cfg)) delete cfg[k];
      Object.assign(cfg, next);
      apply();
      rebuild(); // re-read the pasted values into the controls
    });
    bar.append(copy, paste);
    return bar;
  }

  // Open one of the per-lane effect editors (delay / chorus / reverb) in a modal.
  // The whole session is ONE undo step: snapshot on open (the shared arrangement-
  // edit bracket), apply each change live, commit on close. A standardized Copy/
  // Paste bar sits atop the editor; Paste rebuilds the body to show the new values.
  function openFxModal({ title, kind, cfg, normalize, buildBody, apply, onClose }) {
    onMixStart(); // capture the pre-edit snapshot
    const wrap = document.createElement('div');
    wrap.className = 'fx-modal';
    const rebuild = () => {
      wrap.textContent = '';
      wrap.append(fxCopyBar(kind, cfg, normalize, apply, rebuild), buildBody());
    };
    rebuild();
    openModal({ title, body: wrap, onClose });
  }

  function openDelayModal(laneId) {
    const lane = arrangement.lane(laneId);
    if (!lane) return;
    const idx = arrangement.lanes.indexOf(lane);
    const apply = () => engine.applyLaneDelay(laneId);
    openFxModal({
      title: `Delay — Lane ${idx + 1}`, kind: 'delay', cfg: lane.delay, normalize: normalizeDelay, apply,
      buildBody: () => buildDelayEditor(lane.delay, { onChange: apply }),
      onClose: () => { apply(); onMixEnd(); tilePlayer.render(); /* reflect the D-button lit state */ },
    });
  }

  function openChorusModal(laneId) {
    const lane = arrangement.lane(laneId);
    if (!lane) return;
    const idx = arrangement.lanes.indexOf(lane);
    const apply = () => engine.applyLaneChorus(laneId);
    openFxModal({
      title: `Chorus — Lane ${idx + 1}`, kind: 'chorus', cfg: lane.chorus, normalize: normalizeChorus, apply,
      buildBody: () => buildChorusEditor(lane.chorus, { onChange: apply }),
      onClose: () => { apply(); onMixEnd(); tilePlayer.render(); /* reflect the C-button lit state */ },
    });
  }

  function openReverbModal(laneId) {
    const lane = arrangement.lane(laneId);
    if (!lane) return;
    const idx = arrangement.lanes.indexOf(lane);
    if (!lane.reverb) lane.reverb = normalizeReverb(null); // older autosaves lack the field
    const apply = () => engine.applyLaneReverb(laneId);
    openFxModal({
      title: `Reverb — Lane ${idx + 1}`, kind: 'reverb', cfg: lane.reverb, normalize: normalizeReverb, apply,
      buildBody: () => buildReverbEditor(lane.reverb, { onChange: apply }),
      onClose: () => { apply(); onMixEnd(); tilePlayer.render(); /* reflect the R-button lit state */ },
    });
  }

  // Open the per-lane modulators editor in a modal — same one-undo-step bracket
  // as the delay/chorus modals. Edits need no audio rewiring (mods are evaluated
  // at each note-on from the live lane data), so onChange is a no-op until close.
  function openModModal(laneId) {
    const lane = arrangement.lane(laneId);
    if (!lane) return;
    const idx = arrangement.lanes.indexOf(lane);
    const rp = arrangement.resolvePatch(lane); // mods key off the resolved (shared) voice's kind
    const kind = rp && rp.kind;
    if (!lane.modsByKind) lane.modsByKind = {};
    if (!lane.modsByKind[kind]) lane.modsByKind[kind] = Array.from({ length: MOD_SLOTS }, defaultMod);
    onMixStart(); // capture the pre-edit snapshot
    const body = buildModEditor(lane.modsByKind[kind], modTargetsFor(kind), { onChange: () => {} });
    openModal({
      title: `Modulators — Lane ${idx + 1} (${instrument(kind).label})`,
      body,
      onClose: () => {
        onMixEnd();          // commit one undo step if changed + persist + dirty
        tilePlayer.render(); // reflect the M-button lit state
      },
    });
  }

  // Pan/Gain knob drag. The knob updates itself live; we apply each move to the
  // lane bus immediately (so you hear it) but defer autosave/dirty + the single
  // undo step to release — so a continuous drag is one undoable change, not many.
  let mixBefore = null;
  function onMixStart() { mixBefore = ctx.arrSnap(); }
  function onMixChange(laneId, key, value) {
    const lane = arrangement.lane(laneId);
    if (!lane) return;
    if (key === 'pan') { lane.pan = value; engine.setLanePan(laneId, value, 0.01); }
    else { lane.gain = value; engine.setLaneVolume(laneId, value, 0.01); }
  }
  function onMixEnd() {
    if (mixBefore != null) ctx.arrCommit(mixBefore); // a net change → one undo step
    mixBefore = null;
    ctx.persist(); // autosave + dirty (knobs already drove the audio live)
    ctx.updateTransportButtons(); // reflect the new arrangement-undo entry immediately
  }

  // Add a lane (undoable arrangement edit) and make it active.
  function addLane() {
    ctx.setActive('tiles');
    ctx.arrRecord();
    const lane = arrangement.addLane();
    arrangement.activeLaneId = lane.id;
    applyLaneGains(0); // give the new lane's bus the right gain under any active solo/mute
    ctx.refresh();
  }

  // Reorder lanes (drag the colour stripe): move the track with `laneId` to the
  // insertion index `toIndex` (among the OTHER lanes). Pure model reorder — no
  // audio replumbing (buses are keyed by lane id), just an undoable arrangement
  // edit + a re-render. `toIndex` already excludes the moved lane, so a net change
  // is guaranteed by the caller; arrCommit still no-ops if nothing changed.
  function moveLane(laneId, toIndex) {
    const before = ctx.arrSnap();
    arrangement.moveLane(laneId, toIndex);
    ctx.arrCommit(before);
    ctx.refresh();
  }

  // Mute / Solo: an undoable arrangement edit (so it rides tile Undo/Redo and the
  // dirty bit). The audio change is the lane gain bus (real-time, ramped); refresh
  // re-renders the lane buttons + roll hatching.
  function toggleLaneFlag(kind, laneId) {
    ctx.setActive('tiles');
    ctx.arrRecord();
    if (kind === 'mute') arrangement.toggleMute(laneId);
    else arrangement.toggleSolo(laneId);
    applyLaneGains(0.012); // immediate (ramped) — present tails + future notes
    ctx.refresh();
  }

  // Push the current mute/solo state onto the lane gain buses. rampSec 0 = instant
  // (use when starting playback so an already-muted lane is silent from note one);
  // a small ramp avoids clicks for live toggles.
  function applyLaneGains(rampSec) {
    const audible = arrangement.audibleLaneIds();
    for (const lane of arrangement.lanes) {
      engine.setLaneGain(lane.id, audible.has(lane.id) ? 1 : 0, rampSec);
    }
  }

  // Reset one lane to a blank slate (the red "R"): clear its tiles + restore the
  // default instrument / mixer / delay / mute-solo, and mark it fresh again. The
  // lane stays in the stack. Undoable as a `full` entry (so the instrument too).
  function resetLane(id) {
    const before = ctx.arrSnap();
    arrangement.resetLane(id);
    ctx.arrCommit(before, true);
    ctx.patchStash.delete(ctx.stashKey(id)); // forget stashed per-kind patches for this lane
    applyLaneMix(0.012);  // gain/pan back to unity/center on the bus
    applyLaneDelayAll();  // delay off → remove the insert
    applyLaneChorusAll(); // chorus off → remove the insert
    applyLaneReverbAll();  // reverb off → remove the insert
    if (ctx.editTarget.laneId === id) ctx.editLane(id); // re-point the pane onto the new default patch
    ctx.refresh();
  }

  // Reset the whole tile player ("Reset player"): back to two blank, fresh lanes
  // and the play region cleared. Undoable as a `full` entry.
  function resetPlayer() {
    const before = ctx.arrSnap();
    arrangement.resetPlayer();
    ctx.arrCommit(before, true);
    ctx.patchStash.clear();    // the old lanes are gone
    engine.resetLanes();   // tear down every strip (delay tails / orphaned lanes)
    ctx.editGrid();            // the edited lane may no longer exist → back to the grid
    applyLaneMix(0);       // initialize the two fresh lanes' buses
    applyLaneDelayAll();
    applyLaneChorusAll();
    applyLaneReverbAll();
    ctx.refresh();
  }

  Object.assign(ctx, {
    applyLaneMix, applyLaneDelayAll, applyLaneChorusAll, applyLaneReverbAll, applyLaneGains,
    onMixStart, onMixChange, onMixEnd, addLane, moveLane, toggleLaneFlag, resetLane, resetPlayer,
    openDelayModal, openChorusModal, openReverbModal, openModModal,
  });
}

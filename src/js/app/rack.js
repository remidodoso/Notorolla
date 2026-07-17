// rack.js (app) — the instrument RACK controller: wires the Rack window
// (ui/rackpane.js), owns the drag-a-chip-onto-a-lane-head assignment gesture, and
// the undoable assign / detach ops. The pure model lives on the Arrangement
// (core/rack.js); "Add to rack" lives in patchedit.js (it copies the edited sound
// into a new instance). Here we turn instances into UI and route the gestures.

import { createRackPane } from '../ui/rackpane.js';
import { instrument } from '../audio/instrument.js';

export function initRack(ctx) {
  const { arrangement } = ctx;

  const rackPane = createRackPane({
    list: () => arrangement.rack.instances.map((inst) => {
      const info = ctx.patchInfo(inst); // inst carries the same identity fields a lane does
      return {
        id: inst.id, name: inst.name, color: inst.color,
        patchLabel: `${instrument(inst.patch.kind).label} · ${info.name}${info.dirty ? '*' : ''}`,
        editing: !!(ctx.editTarget && ctx.editTarget.rackId === inst.id),
      };
    }),
    onDragStart,
    onRename: renameInstance,
  });
  if (rackPane.isOpen()) rackPane.refresh(); // it may have auto-reopened from last session

  function refreshRack() { rackPane.refresh(); }

  // --- the drag: a rack chip → a lane head (assign the shared voice) -----------
  // A pointer drag with a floating ghost (the app's ghost idiom), NOT native DnD —
  // it crosses the floating-pane boundary cleanly. While dragging, the rack pane is
  // made click-through so elementFromPoint can find a lane head beneath it.
  function onDragStart(instId, ev) {
    ev.preventDefault();
    const inst = arrangement.rack.get(instId);
    if (!inst) return;

    const ghost = document.createElement('div');
    ghost.className = 'rack-drag-ghost';
    ghost.textContent = '⟲ ' + inst.name;
    ghost.style.background = inst.color;
    document.body.append(ghost);
    const place = (x, y) => { ghost.style.left = (x + 14) + 'px'; ghost.style.top = (y + 10) + 'px'; };
    place(ev.clientX, ev.clientY);

    rackPane.root.style.pointerEvents = 'none'; // let lane heads under the pane be hittable
    document.body.classList.add('rack-dragging');

    let overHead = null;
    const setOver = (head) => {
      if (head === overHead) return;
      if (overHead) overHead.classList.remove('rack-drop');
      overHead = head;
      if (overHead) overHead.classList.add('rack-drop');
    };
    const move = (e) => {
      place(e.clientX, e.clientY);
      const el = document.elementFromPoint(e.clientX, e.clientY);
      setOver(el && el.closest ? el.closest('.lane-head[data-lane]') : null);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      const head = overHead;
      setOver(null);
      ghost.remove();
      rackPane.root.style.pointerEvents = '';
      document.body.classList.remove('rack-dragging');
      if (head) assignRackToLane(Number(head.dataset.lane), instId);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  // Assign a shared instance to a lane (an undoable `full` entry — so patchRef is
  // restored on undo, reverting the assignment). Re-point the editor if it was on
  // this lane so its target chip flips to the instance.
  function assignRackToLane(laneId, instId) {
    const before = ctx.arrSnap();
    arrangement.assignRack(laneId, instId);
    ctx.arrCommit(before, true);
    if (ctx.editTarget && ctx.editTarget.laneId === laneId) ctx.editLane(laneId);
    ctx.refresh(); // persists + re-renders lane heads
    refreshRack();
  }

  // Detach a lane from its instance: it keeps the sound as its own private copy.
  // Also a `full` entry (undo re-links it). Wired to the lane-head Detach button.
  function detachLane(laneId) {
    const lane = arrangement.lane(laneId);
    if (!lane || !lane.patchRef) return;
    const before = ctx.arrSnap();
    arrangement.detachRack(laneId);
    ctx.arrCommit(before, true);
    if (ctx.editTarget && ctx.editTarget.laneId === laneId) ctx.editLane(laneId);
    ctx.refresh();
    refreshRack();
  }

  // Rename an instance (a workspace nicety — persisted, not an undo step, like a
  // catalog rename). Repaints the pane, the lane heads, and the editor target chip.
  function renameInstance(id) {
    const inst = arrangement.rack.get(id);
    if (!inst) return;
    const n = (prompt('Rename rack instrument:', inst.name) || '').trim();
    if (!n || n === inst.name) return;
    arrangement.rack.rename(id, n);
    ctx.persist();
    refreshRack();
    ctx.tilePlayer.render(); // lane heads show the rack name
    if (ctx.editTarget && ctx.editTarget.rackId === id && ctx.editTarget.laneId != null) ctx.editLane(ctx.editTarget.laneId);
  }

  Object.assign(ctx, {
    rackPane,
    refreshRack,
    openRackPane: () => { rackPane.show(); },
    toggleRackPane: () => { rackPane.toggle(); },
    assignRackToLane,
    detachLane,
  });
}

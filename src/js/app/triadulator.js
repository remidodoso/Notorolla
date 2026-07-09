// triadulator.js — propose traditional triads built from the pitch classes NOT
// yet used on the grid, overlay them as prospective (un-set) notes after the
// last placed note, rotate through alternatives, and Confirm to register them.

import { hasEquave, edoOf } from '../core/tuning.js';
import { familiesFor, enumerateTriadulations } from '../core/triads.js';
import { BASE_PITCH, DEFAULT_ARTIC } from '../core/grid.js';

export function initTriadulator(ctx) {
  const { library, arrangement, grid, tb } = ctx;
  const state = ctx.state;

  let triadList = [];
  let triadIdx = -1;
  let triadSig = null; // identity of the list the current rotation belongs to

  // --- Triadulator ------------------------------------------------------
  //
  // Propose traditional triads built from the pitch classes NOT yet used on the
  // grid, place them as prospective (un-set) notes after the last placed note,
  // rotate through alternatives, and Confirm to register them as real notes.

  // What's currently triadulatable: the enabled state and the list of placeable
  // triadulations (proper or partial, per the Proper toggle). The analysis is over
  // the pattern's pitch classes (its tuning's EDO) regardless of grid height.
  function triadulationState() {
    const pattern = library.current();
    if (!hasEquave(pattern.tuningId)) return { enabled: false, list: [] }; // no pitch-classes: no pc-set triads
    const cols = pattern.columns;
    const edo = edoOf(pattern.tuningId);
    const used = new Set();
    for (const c of cols) {
      if (!c.isRest) used.add(((c.degree % edo) + edo) % edo);
    }
    if (used.size < 3) return { enabled: false, list: [] };

    const remaining = [];
    for (let pc = 0; pc < edo; pc++) if (!used.has(pc)) remaining.push(pc);
    const families = familiesFor(edo).filter((id) => state.families[id]); // enabled families for this tuning
    const list = enumerateTriadulations(remaining, { proper: state.proper, families, edo });
    if (!list.length) return { enabled: false, list: [] };

    // Placeability: notes go in the columns strictly after the last placed note.
    const nSlots = cols.length - (lastNoteColumn(cols) + 1);
    const usable = state.proper
      ? (remaining.length <= nSlots ? list : []) // proper must place all remaining
      : (nSlots >= 3 ? list : []);               // partial needs room for >=1 triad
    return { enabled: usable.length > 0, list: usable };
  }

  function lastNoteColumn(cols) {
    let last = -1;
    cols.forEach((c, i) => { if (!c.isRest) last = i; });
    return last;
  }

  // Degree ≡ pc (mod edo) closest to `centroid`: centers the proposal in the
  // register of the placed notes, and (on a multi-octave grid) picks the inversion.
  function nearestDegreeForPC(pc, centroid, edo) {
    const base = Math.round(centroid);
    const off = ((((base - pc) % edo) + edo) % edo);
    const d = base - off; // largest degree <= base with this pitch class
    return Math.abs(d - centroid) <= Math.abs(d + edo - centroid) ? d : d + edo;
  }

  // Turn a chosen triadulation into prospective columns. Horizontal: after the
  // last note (ignoring interior rests). Vertical: centered on the placed register.
  function proposalColumns(tri) {
    const cols = library.current().columns;
    const startCol = lastNoteColumn(cols) + 1;
    const nSlots = cols.length - startCol;

    let pcs = tri.triads.flatMap((t) => t.pcs).concat(tri.leftover || []);
    if (pcs.length > nSlots) {
      // Overflow (partial only — proper is guarded upstream): keep whole triads.
      const nTriads = Math.min(tri.triads.length, Math.floor(nSlots / 3));
      pcs = tri.triads.slice(0, nTriads).flatMap((t) => t.pcs);
    }

    const placed = cols.filter((c) => !c.isRest).map((c) => c.degree);
    const centroid = placed.length ? placed.reduce((a, b) => a + b, 0) / placed.length : BASE_PITCH;
    const durIndex = state.brush.durIndex;
    const edo = edoOf(library.current().tuningId);
    return pcs.map((pc, k) => ({ col: startCol + k, degree: nearestDegreeForPC(pc, centroid, edo), durIndex }));
  }

  // Identity of a triadulation list, so repeated presses on an unchanged grid
  // rotate through it while any change restarts at the canonical first.
  function listSig(list) {
    return list.map((t) => `${t.triads.map((x) => x.pcs.join('.')).join(',')}/${(t.leftover || []).join('.')}`).join('|');
  }

  function triadulate() {
    ctx.setActive('grid');
    const st = triadulationState();
    if (!st.enabled) { updateTriadulateButtons(); return; }
    const sig = listSig(st.list);
    if (sig === triadSig && ctx.proposal.length) {
      triadIdx = (triadIdx + 1) % st.list.length; // rotate; wraps to the beginning
    } else {
      triadIdx = 0;
      triadSig = sig;
    }
    triadList = st.list;
    ctx.proposal = proposalColumns(st.list[triadIdx]);
    grid.setProspective(ctx.proposal);
    ctx.refresh();
  }

  // Register the prospective notes as if hand-placed (one undo entry, marks dirty).
  function confirmTriadulation() {
    if (!ctx.proposal.length) return;
    const before = ctx.curSnap();
    const cols = library.current().columns;
    for (const p of ctx.proposal) cols[p.col] = { durIndex: p.durIndex, isRest: false, degree: p.degree, accent: 0, artic: DEFAULT_ARTIC };
    ctx.pushHistory(before);
    clearProposal();
    arrangement.clearSelection();
    ctx.refresh();
  }

  function clearProposal() {
    ctx.proposal = [];
    triadList = [];
    triadIdx = -1;
    triadSig = null;
    grid.setProspective([]);
  }

  function updateTriadulateButtons() {
    const st = triadulationState();
    // Stay enabled while a proposal shows so you can keep rotating.
    tb.triadBtn.disabled = !(st.enabled || ctx.proposal.length);
    tb.confirmBtn.disabled = ctx.proposal.length === 0;
    tb.triadBtn.textContent = (ctx.proposal.length && triadList.length)
      ? `Triadulate ${triadIdx + 1}/${triadList.length}`
      : 'Triadulate';
  }

  Object.assign(ctx, { clearProposal, triadulate, confirmTriadulation, updateTriadulateButtons });
}

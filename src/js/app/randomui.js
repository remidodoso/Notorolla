// randomui.js — the New Random modal: generate random in-scale pitches over the
// current grid's rhythm, live-previewed, with in-modal back/redo, audition, and
// Replace-in-place / New-Pattern / Cancel. Settings persist across uses.

import { readJSON } from './storage.js';
import { generateRandom, applyDurationBias, applyAccentBias, scaleWindow, RANDOM_DEFAULTS } from '../core/random.js';
import { Pattern, BASE_PITCH, DURATIONS, DEFAULT_ARTIC } from '../core/grid.js';
import { edoOf, degreeBounds, degreeToName } from '../core/tuning.js';
import { familiesFor, chordsFor } from '../core/triads.js';
import { openModal } from '../ui/modal.js';

export function initRandomui(ctx) {
  const { library, arrangement, engine } = ctx;
  const state = ctx.state;

  // --- New Random ---------------------------------------------------------
  //
  // New Random. Generates random in-scale pitches over the CURRENT grid's rhythm
  // (its per-column durations), live-previewed on the grid. If the current pattern
  // isn't referenced it's rewritten in place; if it IS referenced, a 3-way choice
  // asks Replace-All (rewrite in place → every tile updates) / New Pattern (mint an
  // independent one) / Cancel. Auto-rolls a candidate on open (ready to audition);
  // Randomize re-rolls; Accept keeps it (one undo step for in-place); Cancel restores.
  // Slider settings persist across uses (Reset = defaults).

  const RAND_KEY = 'notorolla.randgen';

  function tileRefCount(name) {
    let n = 0;
    for (const lane of arrangement.lanes) for (const t of lane.tiles) if (t.name === name) n++;
    return n;
  }

  function openRandomModal() {
    const src = library.current();
    if (!src) return;
    const n = tileRefCount(src.name);
    if (n > 0) openReplaceChoice(src.name, n, (mode) => { if (mode) runRandomModal(mode); });
    else runRandomModal('inplace'); // not in use → rewrite in place, no question
  }

  // The up-front choice when New Random targets an in-use pattern.
  function openReplaceChoice(name, n, done) {
    const body = document.createElement('div');
    body.className = 'delay-editor';
    const msg = document.createElement('div');
    msg.className = 'delay-row'; msg.style.display = 'block';
    msg.textContent = `Pattern ${name} is used in ${n} tile${n === 1 ? '' : 's'}. Replace it in all of them, or generate an independent new pattern?`;
    const actions = document.createElement('div');
    actions.className = 'delay-row rand-actions';
    let choice = null;
    const mk = (text, cls, val) => {
      const b = document.createElement('button');
      b.className = cls; b.textContent = text;
      b.addEventListener('click', () => { choice = val; modal.close(); });
      actions.append(b);
    };
    mk('Replace All', 'stem-go', 'inplace');
    mk('New Pattern', 'seg', 'new');
    const spacer = document.createElement('span'); spacer.style.flex = '1'; actions.append(spacer);
    mk('Cancel', 'seg', null);
    body.append(msg, actions);
    const modal = openModal({ title: 'New Random — pattern in use', body, onClose: () => done(choice) });
  }

  function runRandomModal(mode) {
    // Sanitize persisted settings (clamp each to its slider's range).
    const saved = readJSON(RAND_KEY) || {};
    const cl = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
    const settings = {
      unique: cl(saved.unique, 0, 1, RANDOM_DEFAULTS.unique),
      run: cl(saved.run, -1, 1, RANDOM_DEFAULTS.run),
      triad: cl(saved.triad, 0, 1, RANDOM_DEFAULTS.triad),
      durBias: cl(saved.durBias, -1, 1, RANDOM_DEFAULTS.durBias),
      accentBias: cl(saved.accentBias, -1, 1, RANDOM_DEFAULTS.accentBias),
      durSort: saved.durSort === true,       // false = steer generation (default), true = post-hoc sort
      accentSort: saved.accentSort === true,
      range: Math.round(cl(saved.range, 0, 24, RANDOM_DEFAULTS.range)), // 0 = unlimited, else 1..24 scale degrees
    };

    const src = library.current();
    const srcDurs = src.columns.map((c) => c.durIndex);   // the grid's groove: rhythm…
    const srcAccents = src.columns.map((c) => c.accent | 0); // …accents…
    const srcArtics = src.columns.map((c) => (c.artic == null ? DEFAULT_ARTIC : c.artic)); // …articulations — kept; only pitches randomize
    const rhythmVaries = new Set(srcDurs).size > 1;     // Duration Bias only matters if durations differ
    const accentsVary = new Set(srcAccents).size > 1;   // Accent Bias only matters if accents differ
    const width = src.columns.length;
    const tctx = { tuningId: src.tuningId, scaleId: src.scaleId, root: src.root };

    // Snapshots. inplace: restore the current pattern's columns on Cancel + push one
    // undo step on Accept. new: mint a pattern, restore library identity on Cancel.
    const beforeJSON = JSON.stringify(src.toJSON());
    const prev = { currentName: library.currentName, parkedName: library.parkedName, counter: library.counter };
    let genPattern = null;
    let accepted = false;

    // In-modal back/redo: an ephemeral linear stack of { columns, settings } snapshots.
    // Every Randomize (incl. the auto-roll = state 0) pushes; ‹ / › restore a snapshot's
    // pattern AND settings; a fresh roll truncates the forward history. Reset and plain
    // slider/checkbox moves don't touch it. Session-scoped (fresh each open); soft cap.
    const HIST_CAP = 500;
    const hist = [];
    let histIdx = -1;
    let backBtn = null, fwdBtn = null;
    const captureState = () => ({ columns: JSON.parse(JSON.stringify(target().columns)), settings: { ...settings } });
    function pushState() {
      hist.length = histIdx + 1;       // drop any forward (redo) history
      hist.push(captureState());
      while (hist.length > HIST_CAP) hist.shift();
      histIdx = hist.length - 1;
      updateNavButtons();
    }
    function restoreState(i) {
      if (i < 0 || i >= hist.length) return;
      histIdx = i;
      const st = hist[i];
      Object.assign(settings, st.settings);         // sliders/checkboxes → this snapshot's settings
      for (const s of sliders) { s.input.value = String(settings[s.key]); s.show(); }
      for (const c of checkboxes) c.input.checked = !!settings[c.key];
      target().columns = JSON.parse(JSON.stringify(st.columns)); // pattern → this snapshot's pitches
      ctx.refresh();
      updateNavButtons();
    }
    function updateNavButtons() {
      if (backBtn) backBtn.disabled = histIdx <= 0;
      if (fwdBtn) fwdBtn.disabled = histIdx >= hist.length - 1;
    }

    // The pattern the roll writes into: the current one (in place), or a lazily-minted new one.
    const target = () => {
      if (mode !== 'new') return src;
      if (!genPattern) {
        genPattern = library.newPattern();
        if (genPattern) { genPattern.tuningId = tctx.tuningId; genPattern.scaleId = tctx.scaleId; genPattern.root = tctx.root; }
      }
      return genPattern;
    };

    const body = document.createElement('div');
    body.className = 'delay-editor rand-editor';

    // Slider rows. Each: label, range input, live value readout — plus, for the bias
    // rows, a "Sort" checkbox choosing the mechanism (off = steer generation so Run/Triad
    // survive; on = post-hoc re-pair, stronger but scrambles arpeggios). Nothing but
    // Randomize (and the ‹ › history nav) ever touches the grid — a setting change just
    // stages the next roll.
    const sliders = [];
    const checkboxes = [];
    const row = (label, min, max, key, fmt, title, enabled = true, disabledNote = '(uniform rhythm)', sortKey = null) => {
      const r = document.createElement('div');
      r.className = 'delay-row' + (enabled ? '' : ' rand-disabled');
      const l = document.createElement('span');
      l.className = 'delay-label'; l.textContent = label; if (title) r.title = title;
      const input = document.createElement('input');
      input.type = 'range'; input.min = String(min); input.max = String(max); input.step = '0.01';
      input.value = String(settings[key]);
      input.disabled = !enabled;
      const val = document.createElement('span');
      val.className = 'delay-val';
      const show = () => { val.textContent = enabled ? fmt(settings[key]) : disabledNote; };
      input.addEventListener('input', () => { settings[key] = +input.value; show(); });
      show();
      r.append(l, input, val);
      if (sortKey) {
        const wrap = document.createElement('label');
        wrap.className = 'rand-sort';
        wrap.title = 'Sort: re-pair the finished pitches by this bias (stronger, but breaks Run/Triad arpeggios). Off = steer generation so those shapes survive.';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = !!settings[sortKey]; cb.disabled = !enabled;
        cb.addEventListener('change', () => { settings[sortKey] = cb.checked; }); // a plain setting — takes effect on the next Randomize
        const t = document.createElement('span'); t.textContent = 'Sort';
        wrap.append(cb, t);
        r.append(wrap);
        checkboxes.push({ key: sortKey, input: cb });
      }
      body.append(r);
      sliders.push({ key, input, show });
    };
    // Range: the pool size (distinct in-scale degrees, centered on the grid view).
    // Its own row — integer 0..24 with a note-name readout instead of a % — and it
    // rides `sliders` so Reset restores it. 0 (far left) = unlimited (one per note).
    {
      const r = document.createElement('div');
      r.className = 'delay-row';
      r.title = 'Range — the maximum number of distinct scale degrees the melody may use, centered on the grid view. Far left = unlimited (one degree per note). Fewer degrees than notes → pitches must repeat; more → a wider, gappier spread.';
      const l = document.createElement('span'); l.className = 'delay-label'; l.textContent = 'Range';
      const input = document.createElement('input');
      input.type = 'range'; input.min = '0'; input.max = '24'; input.step = '1'; input.value = String(settings.range);
      const val = document.createElement('span'); val.className = 'delay-val';
      const show = () => {
        if (!settings.range) { val.textContent = 'unlimited'; return; }
        const centroid = Math.round(state.topDegree - (state.visibleRows - 1) / 2);
        const w = scaleWindow({ count: settings.range, centroid, scaleId: tctx.scaleId, root: tctx.root, edo: edoOf(tctx.tuningId), bounds: degreeBounds(tctx.tuningId, tctx.root) });
        val.textContent = w.length ? `${degreeToName(w[0], tctx.tuningId)}–${degreeToName(w[w.length - 1], tctx.tuningId)}` : '—';
      };
      input.addEventListener('input', () => { settings.range = +input.value; show(); });
      show();
      r.append(l, input, val);
      body.append(r);
      sliders.push({ key: 'range', input, show });
    }
    row('Unique', 0, 1, 'unique', (v) => `${Math.round(v * 100)}%`,
      'How strictly pitches avoid repeating: 100% = never reuse a degree (a tone row); lower = repeats allowed.');
    row('Run', -1, 1, 'run', (v) => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`),
      'Stepwise-run tendency: 0 = none; toward + ascending runs, toward − descending; at the ends a single unbroken run.');
    row('Triad', 0, 1, 'triad', (v) => (v < 0.005 ? 'no effect' : v > 0.995 ? 'max' : `${Math.round(v * 100)}%`),
      'Harmonic bias: chance each note completes a triad (the Triadulator’s enabled families) with the two before it.');
    row('Duration Bias', -1, 1, 'durBias',
      (v) => (Math.abs(v) < 0.005 ? 'off' : `${v < 0 ? 'Low' : 'High'} ${Math.abs(v).toFixed(2)}`),
      'Bias longer notes toward lower (Low) or higher (High) pitches — e.g. Low puts the lowest pitches on the longest notes (a bass feel). Steers generation, so Run/Triad arpeggios survive; tick "Sort" to re-pair the finished pitches instead (stronger, but scrambles arpeggios). Disabled when every column shares a duration.',
      rhythmVaries, '(uniform rhythm)', 'durSort');
    row('Accent Bias', -1, 1, 'accentBias',
      (v) => (Math.abs(v) < 0.005 ? 'off' : `${v < 0 ? 'Low' : 'High'} ${Math.abs(v).toFixed(2)}`),
      'Bias the loudest-accented columns toward lower (Low) or higher (High) pitches (accents rank ghost < normal < accent by loudness). Steers generation, so Run/Triad arpeggios survive; tick "Sort" to re-pair the finished pitches instead. The accents themselves never move. Disabled when every column shares an accent level.',
      accentsVary, '(uniform accents)', 'accentSort');

    // Roll: random pitches over the SOURCE grid's per-column durations, every position a note.
    function doRandomize() {
      const t = target();
      if (!t) return;
      const edo = edoOf(tctx.tuningId);
      const families = familiesFor(edo).filter((id) => state.families[id]);
      const chordKeys = new Set(chordsFor(edo, families).map((x) => x.pcs.join(',')));
      const centroid = Math.round(state.topDegree - (state.visibleRows - 1) / 2);
      const beats = srcDurs.map((di) => DURATIONS[di].beats);
      // Each bias runs in one of two mechanisms (per its "Sort" checkbox): STEER = bake the
      // pull into generation (Run/Triad arpeggios survive) — passed to generateRandom as
      // `bias`; SORT = leave generation alone, re-pair the finished pitches afterward
      // (stronger, but scrambles contour). Both move only the NOTES; the groove stays put.
      const gen = generateRandom({
        count: width, centroid, scaleId: tctx.scaleId, root: tctx.root, edo,
        bounds: degreeBounds(tctx.tuningId, tctx.root), chordKeys, settings,
        bias: {
          durBias: settings.durSort ? 0 : settings.durBias,
          accentBias: settings.accentSort ? 0 : settings.accentBias,
          beats, accents: srcAccents,
        },
      });
      let degrees = settings.durSort ? applyDurationBias(gen, beats, settings.durBias) : gen.slice();
      if (settings.accentSort) degrees = applyAccentBias(degrees, srcAccents.slice(0, degrees.length), settings.accentBias);
      // Keep the grid's rhythm (durIndex per position); if the scale+range offered
      // fewer degrees than columns (tiny masks), the remainder stays rests.
      t.columns = [];
      for (let i = 0; i < width; i++) {
        const has = i < degrees.length;
        t.columns.push({
          durIndex: srcDurs[i], isRest: !has,
          degree: has ? degrees[i] : (degrees[degrees.length - 1] ?? BASE_PITCH),
          accent: srcAccents[i], artic: srcArtics[i], // keep the groove; only pitches change
        });
      }
      ctx.refresh();
      pushState(); // this roll (and its settings) becomes a history entry
    }

    // Play the previewed pattern once through the grid's audition patch.
    async function doAudition() {
      const t = mode === 'new' ? genPattern : src;
      if (!t) return;
      const score = t.toScore(state.bpm, state.articulation);
      const t0 = await engine.ensureRunning();
      const spb = 60 / state.bpm;
      for (const n of score.notes) {
        engine.playNote(n.pitch, t0 + 0.06 + n.start * spb, (n.artDur != null ? n.artDur : n.duration * state.articulation) * spb, n.velocity, n.freq, null);
      }
    }

    // Cancel: undo the preview. inplace → restore the current pattern's columns;
    // new → drop the minted pattern and restore the library identity.
    function revert() {
      if (mode === 'new') {
        if (!genPattern) return;
        library.patterns.delete(genPattern.name);
        library.currentName = prev.currentName;
        library.parkedName = prev.parkedName;
        library.counter = prev.counter;
        genPattern = null;
      } else {
        src.columns = Pattern.fromJSON(JSON.parse(beforeJSON), src.name).columns;
      }
      ctx.refresh();
    }

    const actions = document.createElement('div');
    actions.className = 'delay-row rand-actions';
    const mkbtn = (text, cls, title, fn) => {
      const b = document.createElement('button');
      b.className = cls; b.textContent = text; if (title) b.title = title;
      b.addEventListener('click', fn);
      actions.append(b);
      return b;
    };
    backBtn = mkbtn('‹', 'seg rand-nav', 'Back — recall the previous roll and its settings', () => restoreState(histIdx - 1));
    mkbtn('Randomize', 'seg', 'Generate (or re-generate) a candidate — previewed live on the grid', doRandomize);
    fwdBtn = mkbtn('›', 'seg rand-nav', 'Redo — the roll you backed over', () => restoreState(histIdx + 1));
    mkbtn('♪ Audition', 'seg', 'Play the previewed pattern once', doAudition);
    mkbtn('Reset', 'seg', 'Restore the sliders to their defaults', () => {
      Object.assign(settings, RANDOM_DEFAULTS);
      for (const s of sliders) { s.input.value = String(settings[s.key]); s.show(); }
      for (const c of checkboxes) c.input.checked = !!settings[c.key];
    });
    const spacer = document.createElement('span'); spacer.style.flex = '1';
    actions.append(spacer);
    mkbtn('Accept', 'stem-go', 'Keep this pattern', () => {
      accepted = true;
      if (mode !== 'new') ctx.pushHistory(beforeJSON); // in-place = one undo step back to the original
      modal.close();
    });
    mkbtn('Cancel', 'seg', 'Discard and restore the previous pattern', () => modal.close());
    body.append(actions);

    const modal = openModal({
      title: mode === 'new' ? 'New Random — New Pattern' : 'New Random Pattern',
      body,
      onClose: () => {
        ctx.safeSet(RAND_KEY, JSON.stringify(settings)); // settings persist across uses
        if (!accepted) revert();
      },
    });

    doRandomize(); // auto-roll a candidate on open, ready to audition
  }

  Object.assign(ctx, { openRandomModal });
}

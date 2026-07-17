// tilepreview.js — the grid pane's "drag me into the Tile player" card.
//
// Replaces the old nondescript "⠿ pattern →" grab handle with a faithful preview
// of how the current pattern's tile will look in the Tile player: the same
// duration-colored note-bar thumbnail (thumbImage) and centered name as a placed
// tile, at the SAME height (TILE_H). The card IS the HTML5 drag source (the drop
// side is unchanged — lanes / "+ Lane" read the same dataTransfer).
//
// Magnification is NOT the player's live zoom nor a fixed px/beat: a pattern's
// beat-length varies ~12× across the usual inventory, so the card is drawn at
// BASE_PPB and its width CLAMPED to [MIN_W, MAX_W]. Short/typical patterns render
// proportionally around a ~100px target; long (half-note) patterns cap at MAX_W.
// These three are the tuning knobs.
import { thumbImage, patternBeats } from './tileplayer.js';

const BASE_PPB = 28; // px/beat before clamping — a ~3.5-beat typical tile lands near the target width
const MIN_W = 40;    // floor so the shortest patterns aren't slivers
const MAX_W = 200;   // cap so long half-note patterns don't sprawl

export class TilePreview {
  // cb.onDragEnd() — fires on the card's dragend (drop OR cancel), so the
  // controller can clear the landing preview (mirrors the old grab handle).
  constructor(containerEl, cb) {
    this.container = containerEl;
    this.cb = cb;

    const label = document.createElement('span');
    label.className = 'tile-preview-label';
    label.textContent = 'Drag to Tile player →';

    // Reuse the player's .tile look (neutral default border = no lane colour yet);
    // .preview switches it from absolute (track-positioned) to an in-flow card.
    this.card = document.createElement('div');
    this.card.className = 'tile preview';
    this.card.setAttribute('draggable', 'true');
    const name = document.createElement('span');
    name.className = 'tile-name';
    this.nameTxt = document.createElement('span');
    this.nameTxt.className = 'tile-name-txt';
    name.append(this.nameTxt);
    this.card.append(name);

    this.card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', 'pattern');
      e.dataTransfer.effectAllowed = 'copy';
    });
    this.card.addEventListener('dragend', () => this.cb.onDragEnd());

    this.container.append(label, this.card);
  }

  // Re-skin the persistent card for `pattern` (the current grid pattern). Mutates
  // in place so the drag listeners attached once in the constructor survive.
  render(pattern) {
    if (!pattern) { this.card.style.display = 'none'; return; }
    this.card.style.display = '';
    const beats = patternBeats(pattern);
    const width = Math.max(MIN_W, Math.min(MAX_W, Math.round(beats * BASE_PPB)));
    const ppb = beats > 0 ? width / beats : BASE_PPB; // effective scale so the thumbnail fills the card
    this.card.style.width = `${width}px`;
    this.card.style.backgroundImage = thumbImage(pattern, ppb);
    this.nameTxt.textContent = pattern.label || pattern.name;
    this.card.title = (pattern.label ? `${pattern.label} (${pattern.name})` : pattern.name) + ' — drag into the Tile player';
  }
}

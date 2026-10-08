/**
 * Inline SVG icons for the chrome (DESIGN §4). One consistent drawing style: 24-unit grid,
 * 1.6 stroke, round caps and joins, `currentColor`, so forced-colors and both grounds just work.
 * No external assets: the single-file build must work offline.
 */

export type IconName =
  | 'mark' | 'undo' | 'redo' | 'trash' | 'arrow' | 'close' | 'back' | 'chevron'
  | 'plus' | 'open' | 'save' | 'image' | 'clock' | 'play' | 'keys' | 'eraser' | 'reset' | 'share';

/** Inner markup per icon (viewBox 0 0 24 24). */
export const ICONS: Readonly<Record<IconName, string>> = {
  // The Rise mark: a stroke that rises from the lower left and ends in a seed, with one leaf.
  mark:
    '<path d="M5 19.5c3.6 0 6.3-2.5 7-6.4.6-3.2 2.4-5.6 5.4-6.6"/>' +
    '<path d="M12.3 12.6c-2.6-.1-4.6-1.8-5.1-4.3 2.6-.1 4.7 1.6 5.1 4.3z"/>' +
    '<circle cx="18.2" cy="6.1" r="1.9" fill="currentColor" stroke="none"/>',
  undo: '<path d="M8.5 5.5 4 10l4.5 4.5"/><path d="M4.5 10H14a5.5 5.5 0 0 1 0 11h-3"/>',
  redo: '<path d="M15.5 5.5 20 10l-4.5 4.5"/><path d="M19.5 10H10a5.5 5.5 0 0 0 0 11h3"/>',
  trash:
    '<path d="M4.5 7h15"/><path d="M9.5 7V5.2h5V7"/>' +
    '<path d="M6.6 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4L17.4 7"/>',
  arrow: '<path d="M5 12h13"/><path d="M13 7l5 5-5 5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  back: '<path d="M14.5 6 8.5 12l6 6"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  open: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  save: '<path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  image:
    '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/>' +
    '<path d="m4.2 17 4.8-4.8 3.8 3.8 2.6-2.6 4.4 4.4"/><circle cx="15.6" cy="9.4" r="1.3"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.6V12l2.9 1.9"/>',
  play: '<path d="M8.2 5.6v12.8L18.6 12z"/>',
  keys:
    '<rect x="3" y="6.5" width="18" height="11" rx="2.2"/>' +
    '<path d="M7 10.4h.01M10.3 10.4h.01M13.7 10.4h.01M17 10.4h.01M8.2 14h7.6"/>',
  eraser:
    '<path d="M9 19.5h10.5"/>' +
    '<path d="m4.9 14.6 8.4-8.4a2 2 0 0 1 2.8 0l2.3 2.3a2 2 0 0 1 0 2.8l-7.3 7.3a3 3 0 0 1-2.1.9H8.7a2 2 0 0 1-1.4-.6l-2.4-2.4a1.3 1.3 0 0 1 0-1.9z"/>' +
    '<path d="m9.4 10.1 4.9 4.9"/>',
  reset: '<path d="M5.2 12a6.8 6.8 0 1 0 2-4.8"/><path d="M5 4.6V9h4.4"/>',
  // a frame with a play triangle, leaving it by an arrow: the drawing as a video, sent out
  share:
    '<path d="M13.5 5H6a2.5 2.5 0 0 0-2.5 2.5v9A2.5 2.5 0 0 0 6 19h11a2.5 2.5 0 0 0 2.5-2.5V13"/>' +
    '<path d="M10 9.6v5.3l4.3-2.65z"/><path d="M16.5 3.5h4v4"/><path d="m20.3 3.7-4.6 4.6"/>',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A decorative SVG element for `name` (aria-hidden; the owning control carries the label). */
export function icon(name: IconName, size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('r-icon');
  svg.innerHTML = ICONS[name];
  return svg;
}

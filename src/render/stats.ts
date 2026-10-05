/**
 * Render work counters (debug / benchmarks only; DESIGN §9 pan / zoom budget). Plain integer
 * increments on one module object, so they cost nothing measurable when nobody reads them.
 * scripts/bench-zoom.mjs reads them through `window.__rise.renderStats` (?debug) and, while
 * `record` is on, the renderer appends one per-frame delta to `log` at the end of each frame.
 */

export interface RenderCounters {
  /** renderer.frame calls. */
  frames: number;
  /** renderer.frame CPU ms (sum). */
  frameMs: number;
  /** setCamera calls that changed the camera or phase. */
  setCamera: number;
  /** Settle transitions (gesture → tiles may render). */
  settles: number;
  /** #base re-composites (drawInto runs). */
  composites: number;
  /** #base updates done by CSS transform only (no canvas work). */
  transformOnly: number;
  /** Tile blits into #base (current level + fallback levels). */
  tileBlits: number;
  /** Tile full renders started. */
  tileRenders: number;
  /** Tile dirty sub-rect renders started. */
  rectRenders: number;
  /** Strokes drawn into tiles (render steps + adds). */
  strokeDraws: number;
  /** Tile steps run synchronously by flushDisplayed (a camera change forcing work). */
  flushSteps: number;
  /** Full-canvas clears of viewport-sized layers (#base, #dry, #wet). */
  fullClears: number;
  /** Canvases allocated / freed / resized through the ledger. */
  canvasAlloc: number;
  canvasFree: number;
  canvasResize: number;
  /** Bloom renders (¼-res downsample + blur chain). */
  bloomRenders: number;
}

const KEYS: (keyof RenderCounters)[] = [
  'frames', 'frameMs', 'setCamera', 'settles', 'composites', 'transformOnly', 'tileBlits', 'tileRenders',
  'rectRenders', 'strokeDraws', 'flushSteps', 'fullClears', 'canvasAlloc', 'canvasFree', 'canvasResize', 'bloomRenders',
];

function zero(): RenderCounters {
  const o = {} as RenderCounters;
  for (const k of KEYS) o[k] = 0;
  return o;
}

export interface FrameRecord extends RenderCounters { t: number }

export const rstats = {
  c: zero(),
  /** Append a per-frame delta to `log` at the end of every renderer frame. */
  record: false,
  log: [] as FrameRecord[],
  last: zero(),
};

/** End of a renderer frame: log the delta since the previous one while recording. */
export function endFrame(t: number): void {
  if (!rstats.record) return;
  const c = rstats.c, l = rstats.last;
  const d = { t } as FrameRecord;
  for (const k of KEYS) { d[k] = c[k] - l[k]; l[k] = c[k]; }
  rstats.log.push(d);
}

/** Read the totals (and the per-frame log), optionally resetting both; `record` turns logging on/off. */
export function readStats(opts: { reset?: boolean; record?: boolean } = {}): { totals: RenderCounters; log: FrameRecord[] } {
  const out = { totals: { ...rstats.c }, log: rstats.log };
  if (opts.reset) { rstats.c = zero(); rstats.last = zero(); rstats.log = []; }
  if (opts.record !== undefined) { rstats.record = opts.record; rstats.last = { ...rstats.c }; }
  return out;
}

/**
 * The app's remix links (DESIGN §8): persist/remix.ts rounds each recipe's input, and this module
 * is its judge. Some growth (Sprout, Drift, Craze on a sharp, crowded scribble) branches on tiny
 * differences of input, so no rounding is safe for every stroke; instead each rounding is cooked
 * and kept only if its ink lands where the original's does.
 */
import type { Cooked, Doc, StrokeRecipe, Vec2 } from '../core/types';
import { sceneHash } from '../doc/serialize';
import { cook } from '../ink/cook';
import { remixUrl } from '../persist/remix';
import { VERSION } from './version';

/** How far (sp at the stroke's zoom) a cooked point may move: a grid cell, its neighbours included. */
const CELL_SP = 1;

/** Every point of `a` lies in or beside a grid cell holding a point of `b` (positions relative to `at`). */
function covers(a: Cooked, ao: Vec2, b: Cooked, bo: Vec2, at: Vec2, cell: number): boolean {
  const key = (x: number, y: number): number => (Math.floor(x / cell) + 2 ** 20) * 2 ** 21 + Math.floor(y / cell) + 2 ** 20;
  const cells = new Set<number>();
  for (let i = 0; i < b.nPts * 4; i += 4) cells.add(key(b.pts[i] + bo[0] - at[0], b.pts[i + 1] + bo[1] - at[1]));
  for (let i = 0; i < a.nPts * 4; i += 4) {
    const x = a.pts[i] + ao[0] - at[0], y = a.pts[i + 1] + ao[1] - at[1];
    let near = false;
    for (let dx = -1; dx <= 1 && !near; dx++) for (let dy = -1; dy <= 1 && !near; dy++) near = cells.has(key(x + dx * cell, y + dy * cell));
    if (!near) return false;
  }
  return true;
}

/** Whether the rounded recipe cooks to the same picture: each one's ink within a cell or so of the other's. */
export function looksSame(r: StrokeRecipe, q: StrokeRecipe): boolean {
  const a = cook({ ...r, xf: null }), b = cook({ ...q, xf: null });
  const cell = CELL_SP / r.z;
  return covers(a, r.origin, b, q.origin, r.origin, cell) && covers(b, q.origin, a, r.origin, r.origin, cell);
}

/** The document's remix link, or null when it is too big. Symmetry copies cook once (they differ only by placement). */
export function remixLink(doc: Doc): Promise<string | null> {
  const seen = new Map<string, boolean>();
  const unplaced = (r: StrokeRecipe): number => sceneHash([{ ...r, id: '0', xf: null }]);
  return remixUrl(doc, VERSION, (r, q) => {
    const k = unplaced(r) + ':' + unplaced(q);
    let same = seen.get(k);
    if (same === undefined) seen.set(k, same = looksSame(r, q));
    return same;
  });
}

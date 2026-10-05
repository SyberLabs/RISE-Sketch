/**
 * Undo / redo (DESIGN §8) and the render-world document-change protocol
 * (docs/contract-requests/render-world.md §1): every command is applied to the document first and,
 * in the same task, announced to the renderer as the animation it deserves:
 *
 *   an add that comes back (redo, undo of an erase)  -> strokesAdded(…, 'grow')   re-grow
 *   a remove (undo of a stroke, redo of an erase)    -> strokesRemoved(…, 'ungrow') un-grow
 *   a replace (peel undo, restyle undo / redo)       -> strokesReplaced(…, 'morph')
 *                                                      (pools-only changes play as a diff: the
 *                                                      pools drain, the stroke stays put)
 *
 * Removed recipes are captured before the command runs, so their geometry can animate out.
 */
import type { Command, StrokeId, StrokeRecipe } from '../core/types';
import type { Runtime } from './runtime';

/** What an applied history step did, for announcements. */
export interface StepInfo { added: number; removed: number; replaced: number; peel: boolean }

function collectRemoved(rt: Runtime, c: Command, out: Map<StrokeId, StrokeRecipe>): void {
  switch (c.k) {
    case 'remove': for (const id of c.ids) { const r = rt.doc.get(id); if (r) out.set(id, r); } break;
    case 'batch': for (const s of c.cmds) collectRemoved(rt, s, out); break;
    default: break;
  }
}

function announce(rt: Runtime, c: Command, pre: Map<StrokeId, StrokeRecipe>, info: StepInfo): void {
  const R = rt.renderer;
  switch (c.k) {
    case 'add':
      if (c.recipes.length) { R.strokesAdded(c.recipes, 'grow'); info.added += c.recipes.length; }
      break;
    case 'remove': {
      const gone: StrokeRecipe[] = [];
      for (const id of c.ids) { const r = pre.get(id); if (r && !rt.doc.has(id)) gone.push(r); }
      if (gone.length) { R.strokesRemoved(gone, 'ungrow'); info.removed += gone.length; }
      break;
    }
    case 'replace':
      if (c.after.length) {
        R.strokesReplaced(c.before, c.after, 'morph');
        info.replaced += c.after.length;
        for (let i = 0; i < c.after.length; i++) {
          if (c.before[i].pools.length !== c.after[i].pools.length) info.peel = true;
        }
      }
      break;
    case 'batch':
      for (const s of c.cmds) announce(rt, s, pre, info);
      break;
    case 'meta':
      break;
  }
}

/** Undo (redo when `back` is false) one history entry; null when there was nothing to do. */
export function step(rt: Runtime, back: boolean): StepInfo | null {
  const h = rt.history as Runtime['history'] & { peekRedo(): Command | null };
  if (back ? !h.canUndo : !h.canRedo) return null;
  const next = back ? h.peekUndo() : h.peekRedo();
  const pre = new Map<StrokeId, StrokeRecipe>();
  if (next) collectRemoved(rt, next, pre);
  const applied = back ? h.undo() : h.redo();
  if (!applied) return null;
  const info: StepInfo = { added: 0, removed: 0, replaced: 0, peel: false };
  announce(rt, applied, pre, info);
  return info;
}

/**
 * Undo / redo: two stacks of commands, capped (DESIGN §8).
 *
 * `push` records a command the caller already applied (`push` never applies).
 * Each stack entry holds the command that entry will apply next. `undo` applies
 * the top undo entry and pushes the inverse *returned by that apply* onto the redo
 * stack, and `redo` does the mirror image, so both stacks always hold commands that
 * are exact for the document's current state, however often the user goes back
 * and forth.
 *
 * A risen stroke is two entries (`add`, then `replace` with the pools): the first
 * undo peels the pools, the second removes the stroke. `peekUndo` lets the caller
 * see which it is before animating.
 *
 * If applying an entry throws (the document was changed outside history in a way
 * that contradicts it), the entry is dropped and the error rethrown: one bad entry
 * never wedges the stack.
 */
import type { Command, Doc, History } from '../core/types';
import { isEmptyCommand } from './commands';

/** Default and maximum number of undo entries. */
export const HISTORY_CAP = 500;

/** History plus redo peeking and depth counters (debug HUD, tests). */
export interface HistoryInternal extends History {
  /** The command `redo()` would apply, or null. */
  peekRedo(): Command | null;
  readonly undoDepth: number;
  readonly redoDepth: number;
}

/**
 * Create a history bound to `doc`. `cap` defaults to 500 entries. An empty inverse
 * (the command changed nothing, e.g. an eraser pass that hit no ink) is not
 * recorded, so Undo never spends a press on a no-op, and redo is kept.
 */
export function createHistory(doc: Doc, cap = HISTORY_CAP): History {
  const max = cap >= 1 ? Math.floor(cap) : cap === cap ? 1 : HISTORY_CAP; // NaN -> default
  const undos: Command[] = []; // each: the inverse to apply on undo
  const redos: Command[] = []; // each: the command to re-apply on redo

  const h: HistoryInternal = {
    push(_c, inverse) {
      if (isEmptyCommand(inverse)) return;
      undos.push(inverse);
      if (undos.length > max) undos.splice(0, undos.length - max);
      redos.length = 0;
    },
    undo() {
      const inv = undos.pop();
      if (!inv) return null;
      const back = doc.apply(inv);
      if (!isEmptyCommand(back)) redos.push(back);
      return inv;
    },
    redo() {
      const c = redos.pop();
      if (!c) return null;
      const back = doc.apply(c);
      if (!isEmptyCommand(back)) undos.push(back);
      return c;
    },
    peekUndo() { return undos.length ? undos[undos.length - 1] : null; },
    peekRedo() { return redos.length ? redos[redos.length - 1] : null; },
    clear() {
      undos.length = 0;
      redos.length = 0;
    },
    get canUndo() { return undos.length > 0; },
    get canRedo() { return redos.length > 0; },
    get undoDepth() { return undos.length; },
    get redoDepth() { return redos.length; },
  };
  return h;
}

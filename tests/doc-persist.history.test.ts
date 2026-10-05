import { describe, it, expect } from 'vitest';
import type { Command } from '../src/core/types';
import { createDoc, newMeta } from '../src/doc/document';
import { createHistory, HISTORY_CAP } from '../src/doc/history';
import type { HistoryInternal } from '../src/doc/history';
import { addCmd, batchCmd, metaCmd, peelCommands, removeCmd } from '../src/doc/commands';
import { randomRecipe, seeded } from './doc-persist.helpers';

function setup(cap?: number) {
  const doc = createDoc(newMeta(0, 1, 'd'));
  const h = createHistory(doc, cap) as HistoryInternal;
  const rand = seeded(42);
  const commit = (c: Command): void => h.push(c, doc.apply(c));
  const stroke = (pools = false) => randomRecipe(rand, doc.nextId(), { pools });
  return { doc, h, commit, stroke };
}

describe('history', () => {
  it('defaults to a cap of 500', () => {
    const { h, commit, stroke } = setup();
    for (let i = 0; i < HISTORY_CAP + 20; i++) commit(addCmd([stroke()]));
    expect(h.undoDepth).toBe(500);
  });

  it('caps the undo stack, dropping the oldest entries', () => {
    const { doc, h, commit, stroke } = setup(3);
    const rs = Array.from({ length: 5 }, () => stroke());
    for (const r of rs) commit(addCmd([r]));
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(3);
    expect(doc.ordered().map(r => r.id)).toEqual([rs[0].id, rs[1].id]);
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBe(null);
  });

  it('peekUndo is exactly what undo applies; push clears redo', () => {
    const { h, commit, stroke } = setup();
    expect(h.peekUndo()).toBe(null);
    commit(addCmd([stroke()]));
    commit(addCmd([stroke()]));
    const p = h.peekUndo();
    expect(h.undo()).toBe(p);
    expect(h.canRedo).toBe(true);
    expect(h.peekRedo()).not.toBe(null);
    commit(addCmd([stroke()]));
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBe(null);
  });

  it('peels a risen stroke: pools first, then the stroke; redo re-grows in order', () => {
    const { doc, h, commit, stroke } = setup();
    const r = stroke(true);
    expect(r.pools.length).toBeGreaterThan(0);
    const cmds = peelCommands(r);
    expect(cmds.map(c => c.k)).toEqual(['add', 'replace']);
    for (const c of cmds) commit(c);
    const risen = doc.get(r.id)!;
    expect(risen).toBe(r); // the document holds the very recipe the app cooked
    const bare = (cmds[0] as { recipes: readonly typeof r[] }).recipes[0];
    expect(bare.samples).toBe(r.samples);
    expect(bare.pools.length).toBe(0);
    expect(bare.geomRev).not.toBe(r.geomRev); // never shares a geometry cache key with r
    expect(bare.colorRev).toBe(r.colorRev);

    const peek = h.peekUndo()!;
    expect(peek.k).toBe('replace');
    if (peek.k !== 'replace') return;
    expect(peek.after[0].pools.length).toBe(0); // the undo drains the pools
    h.undo();
    expect(doc.get(r.id)!.pools.length).toBe(0);
    expect(h.peekUndo()!.k).toBe('remove');
    h.undo();
    expect(doc.has(r.id)).toBe(false);
    h.redo();
    expect(doc.get(r.id)!.pools.length).toBe(0);
    h.redo();
    expect(doc.get(r.id)).toBe(risen);
  });

  it('a stroke without pools is a single add', () => {
    const { stroke } = setup();
    expect(peelCommands(stroke(false)).map(c => c.k)).toEqual(['add']);
  });

  it('drops an entry that no longer applies instead of wedging', () => {
    const { doc, h, commit, stroke } = setup();
    const a = stroke(), b = stroke();
    commit(addCmd([a]));
    commit(removeCmd([a.id])); // undo of this = add(a)
    doc.apply(addCmd([a]));    // a re-added outside history: the entry now contradicts the doc
    expect(() => h.undo()).toThrow(RangeError);
    expect(h.undoDepth).toBe(1); // the bad entry is gone, the earlier one remains
    expect(h.undo()!.k).toBe('remove');
    expect(doc.has(a.id)).toBe(false);
    void b;
  });

  it('does not record commands that changed nothing, and keeps redo', () => {
    const { doc, h, commit, stroke } = setup();
    const a = stroke();
    commit(addCmd([a]));
    commit(metaCmd('Garden'));
    h.undo(); // title back to Untitled; redo available
    expect(h.canRedo).toBe(true);
    commit(removeCmd(['nothing000000']));  // an eraser pass that hit nothing
    commit(metaCmd(doc.meta.title));       // a rename to the same title
    commit(batchCmd([addCmd([]), removeCmd([])]));
    expect(h.undoDepth).toBe(1);
    expect(h.canRedo).toBe(true);
    expect(h.redo()!.k).toBe('meta');
    expect(doc.meta.title).toBe('Garden');
    expect(h.undo()!.k).toBe('meta');
    expect(h.undo()!.k).toBe('remove');
    expect(doc.size).toBe(0);
  });

  it('a non-numeric cap falls back to 500; caps below 1 keep one entry', () => {
    const a = setup(Number.NaN);
    for (let i = 0; i < 510; i++) a.commit(addCmd([a.stroke()]));
    expect(a.h.undoDepth).toBe(500);
    const b = setup(0);
    b.commit(addCmd([b.stroke()]));
    b.commit(addCmd([b.stroke()]));
    expect(b.h.undoDepth).toBe(1);
  });

  it('clear empties both stacks', () => {
    const { h, commit, stroke } = setup();
    commit(addCmd([stroke()]));
    commit(addCmd([stroke()]));
    h.undo();
    h.clear();
    expect(h.canUndo || h.canRedo).toBe(false);
  });

  it('50 undo/redo cycles keep the document exact', () => {
    const { doc, h, commit, stroke } = setup();
    for (let i = 0; i < 10; i++) commit(addCmd([stroke(i % 3 === 0)]));
    const final = doc.ordered();
    for (let i = 0; i < 50; i++) { h.undo(); if (i % 2) h.redo(); }
    while (h.redo());
    expect(doc.ordered()).toEqual(final);
    doc.ordered().forEach((r, i) => expect(r).toBe(final[i]));
  });
});

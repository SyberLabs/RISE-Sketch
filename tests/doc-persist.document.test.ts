import { describe, it, expect } from 'vitest';
import type { Command, DocChange, StrokeId, StrokeRecipe } from '../src/core/types';
import { hash32 } from '../src/core/det';
import { createDoc, newMeta, ALL_INKS } from '../src/doc/document';
import { createHistory } from '../src/doc/history';
import { addCmd, batchCmd, metaCmd, patchRecipe, removeCmd, replaceCmd } from '../src/doc/commands';
import { isStdStrokeId } from '../src/doc/ids';
import { pick, randInt, randomRecipe, seeded } from './doc-persist.helpers';

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, set: (v: number) => { t = v; }, tick: (d = 1) => { t += d; } };
}

describe('doc: basics', () => {
  it('newMeta has zeroed counters for every ink, Night, 100 % at the origin', () => {
    const m = newMeta(5, -1, 'd');
    expect(m.docSeed).toBe(0xffffffff);
    expect(Object.keys(m.inkCounters).sort()).toEqual([...ALL_INKS].sort());
    expect(Object.values(m.inkCounters).every(v => v === 0)).toBe(true);
    expect(m).toMatchObject({ id: 'd', created: 5, updated: 5, counter: 0, ground: 'night', camera: { cx: 0, cy: 0, scale: 1, rot: 0 } });
  });

  it('keeps strokes in id order whatever order they arrive in', () => {
    const rand = seeded(1);
    const ids = ['00000000a0001', '00000000c0002', '00000000b0003'];
    const recs = ids.map(id => randomRecipe(rand, id));
    const doc = createDoc(newMeta(0, 1, 'd'), [recs[1]]);
    doc.apply(addCmd([recs[2], recs[0]]));
    expect(doc.ordered().map(r => r.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(doc.size).toBe(3);
    expect(doc.has(ids[2])).toBe(true);
    expect(doc.get(ids[0])).toBe(recs[0]);
  });

  it('ordered() and meta are stable frozen snapshots', () => {
    const rand = seeded(2);
    const doc = createDoc(newMeta(0, 1, 'd'));
    const a = doc.ordered();
    expect(doc.ordered()).toBe(a);
    doc.apply(addCmd([randomRecipe(rand, doc.nextId())]));
    expect(a.length).toBe(0);
    expect(Object.isFrozen(doc.ordered())).toBe(true);
    const m = doc.meta;
    expect(Object.isFrozen(m) && Object.isFrozen(m.camera) && Object.isFrozen(m.inkCounters)).toBe(true);
    expect(() => { (m.camera as { cx: number }).cx = 9; }).toThrow();
  });

  it('createDoc copies the meta it is given', () => {
    const meta = newMeta(0, 1, 'd');
    const doc = createDoc(meta);
    meta.title = 'changed';
    meta.camera.cx = 50;
    expect(doc.meta.title).toBe('Untitled');
    expect(doc.meta.camera.cx).toBe(0);
  });

  it('rejects duplicate ids at creation', () => {
    const rand = seeded(3);
    const r = randomRecipe(rand, '00000000a0001');
    expect(() => createDoc(newMeta(0, 1, 'd'), [r, r])).toThrow(RangeError);
  });
});

describe('doc: counters and ids', () => {
  it('nextSeed bumps the counter and hashes it with docSeed', () => {
    const doc = createDoc(newMeta(0, 77, 'd'));
    expect(doc.nextSeed()).toBe(hash32(77, 1));
    expect(doc.nextSeed()).toBe(hash32(77, 2));
    expect(doc.meta.counter).toBe(2);
  });

  it('nextVariant returns then bumps per ink', () => {
    const doc = createDoc(newMeta(0, 1, 'd'));
    expect([doc.nextVariant('moss'), doc.nextVariant('moss'), doc.nextVariant('rose'), doc.nextVariant('moss')]).toEqual([0, 1, 0, 2]);
    expect(doc.meta.inkCounters.moss).toBe(3);
  });

  it('nextId is strictly increasing and standard, even when the clock stalls or goes backwards', () => {
    const c = clock();
    const doc = createDoc(newMeta(0, 1, 'd'), [], { now: c.now });
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (i === 20) c.set(1_600_000_000_000); // clock jumps back
      if (i % 7 === 0) c.tick(3);
      ids.push(doc.nextId());
    }
    for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true);
    expect(ids.every(isStdStrokeId)).toBe(true);
  });

  it('nextId terminates and stays ordered with a broken clock (Infinity, NaN, far future)', () => {
    const c = clock();
    const doc = createDoc(newMeta(0, 1, 'd'), [], { now: c.now });
    const ids = [doc.nextId()];
    for (const t of [Infinity, Infinity, NaN, 1e300, -Infinity, 1_700_000_000_005]) {
      c.set(t);
      ids.push(doc.nextId());
    }
    for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true);
    expect(ids.every(isStdStrokeId)).toBe(true);
  });

  it('new ids sort after every id the document has seen, including added ones from the future', () => {
    const c = clock(1000);
    const rand = seeded(4);
    const doc = createDoc(newMeta(0, 1, 'd'), [], { now: c.now });
    const future = randomRecipe(rand, 'zzzzzzzzz0000');
    doc.apply(addCmd([future]));
    const id = doc.nextId();
    expect(id > future.id).toBe(true);
    expect(id.length).toBe(13);
  });

  it('counters are monotonic and outside history', () => {
    const rand = seeded(5);
    const doc = createDoc(newMeta(0, 1, 'd'));
    const h = createHistory(doc);
    for (let i = 0; i < 5; i++) {
      doc.nextSeed(); doc.nextVariant('ochre');
      const c = addCmd([randomRecipe(rand, doc.nextId())]);
      h.push(c, doc.apply(c));
    }
    const before = { counter: doc.meta.counter, ochre: doc.meta.inkCounters.ochre };
    while (h.undo());
    expect(doc.size).toBe(0);
    expect(doc.meta.counter).toBe(before.counter);
    expect(doc.meta.inkCounters.ochre).toBe(before.ochre);
  });
});

describe('doc: apply', () => {
  it('returns exact inverses for every command kind (same recipe objects)', () => {
    const rand = seeded(6);
    const doc = createDoc(newMeta(0, 1, 'd'));
    const a = randomRecipe(rand, doc.nextId()), b = randomRecipe(rand, doc.nextId());
    const invAdd = doc.apply(addCmd([a, b]));
    expect(invAdd).toEqual({ k: 'remove', ids: [a.id, b.id] });

    const a2 = patchRecipe(a, { stroke: { nib: 'chisel', size: 12 } }, 'geometry');
    const invRep = doc.apply(replaceCmd([a], [a2]));
    expect(doc.get(a.id)).toBe(a2);
    expect(invRep.k).toBe('replace');
    doc.apply(invRep);
    expect(doc.get(a.id)).toBe(a);

    const invRem = doc.apply(removeCmd([b.id, 'missing0000000']));
    expect(invRem).toEqual({ k: 'add', recipes: [b] });
    doc.apply(invRem);
    expect(doc.get(b.id)).toBe(b);

    const invMeta = doc.apply(metaCmd('Garden'));
    expect(doc.meta.title).toBe('Garden');
    doc.apply(invMeta);
    expect(doc.meta.title).toBe('Untitled');
    // renaming to the current title changes nothing: the inverse is empty
    expect(doc.apply(metaCmd('Untitled'))).toEqual({ k: 'meta', patch: {} });
  });

  it('replace inverse is the swap', () => {
    const rand = seeded(7);
    const doc = createDoc(newMeta(0, 1, 'd'));
    const a = randomRecipe(rand, doc.nextId());
    doc.apply(addCmd([a]));
    const a2 = patchRecipe(a, { color: { ...a.color, ink: 'rose', lch: null } }, 'color');
    const inv = doc.apply(replaceCmd([a], [a2]));
    expect(inv).toEqual({ k: 'replace', before: [a2], after: [a] });
    if (inv.k !== 'replace') throw new Error('kind');
    expect(inv.before[0]).toBe(a2);
    expect(inv.after[0]).toBe(a);
  });

  it('classifies replaces by geomRev / colorRev and reports one net change per apply', () => {
    const rand = seeded(8);
    const doc = createDoc(newMeta(0, 1, 'd'));
    const changes: DocChange[] = [];
    doc.subscribe(ch => changes.push(ch));
    const a = randomRecipe(rand, doc.nextId()), b = randomRecipe(rand, doc.nextId()), c = randomRecipe(rand, doc.nextId());
    doc.apply(addCmd([a, b]));
    expect(changes.pop()).toEqual({ added: [a.id, b.id], removed: [], geometry: [], color: [], meta: false, view: false });

    const aG = patchRecipe(a, { form: { form: 'drift', v: 1, base: 3 } }, 'geometry');
    const bC = patchRecipe(b, { color: { ...b.color, k: b.color.k + 1 } }, 'color');
    doc.apply(replaceCmd([a, b], [aG, bC]));
    expect(changes.pop()).toEqual({ added: [], removed: [], geometry: [a.id], color: [b.id], meta: false, view: false });

    // add and remove inside one batch nets out; the title change is reported
    doc.apply(batchCmd([addCmd([c]), removeCmd([c.id]), metaCmd('T')]));
    expect(changes.pop()).toEqual({ added: [], removed: [], geometry: [], color: [], meta: true, view: false });

    // a no-op command emits nothing
    const n = changes.length;
    doc.apply(removeCmd(['nothing000000']));
    doc.apply(metaCmd('T'));
    expect(changes.length).toBe(n);
  });

  it('validates before mutating and rolls back a failing batch', () => {
    const rand = seeded(9);
    const doc = createDoc(newMeta(0, 1, 'd'));
    const a = randomRecipe(rand, doc.nextId()), b = randomRecipe(rand, doc.nextId());
    doc.apply(addCmd([a]));
    let emitted = 0;
    doc.subscribe(() => emitted++);
    expect(() => doc.apply(addCmd([a]))).toThrow(RangeError);
    expect(() => doc.apply(addCmd([b, b]))).toThrow(RangeError);
    expect(() => doc.apply(replaceCmd([b], [b]))).toThrow(RangeError);
    expect(() => doc.apply(replaceCmd([a], [b]))).toThrow(RangeError);
    expect(() => doc.apply(replaceCmd([a], []))).toThrow(RangeError);
    expect(() => doc.apply(batchCmd([metaCmd('X'), removeCmd([a.id]), addCmd([b]), addCmd([b])]))).toThrow(RangeError);
    expect(doc.ordered()).toEqual([a]);
    expect(doc.get(a.id)).toBe(a);
    expect(doc.meta.title).toBe('Untitled');
    expect(emitted).toBe(0);
  });

  it('delivers re-entrant changes in order to every listener', () => {
    const rand = seeded(10);
    const doc = createDoc(newMeta(0, 1, 'd'));
    const a = randomRecipe(rand, doc.nextId()), b = randomRecipe(rand, doc.nextId());
    const log: string[] = [];
    doc.subscribe(ch => {
      log.push('1:' + ch.added.join());
      if (ch.added[0] === a.id) doc.apply(addCmd([b]));
    });
    doc.subscribe(ch => log.push('2:' + ch.added.join()));
    doc.apply(addCmd([a]));
    expect(log).toEqual([`1:${a.id}`, `2:${a.id}`, `1:${b.id}`, `2:${b.id}`]);
  });

  it('unsubscribe stops delivery', () => {
    const rand = seeded(11);
    const doc = createDoc(newMeta(0, 1, 'd'));
    let n = 0;
    const off = doc.subscribe(() => n++);
    doc.apply(addCmd([randomRecipe(rand, doc.nextId())]));
    off();
    doc.apply(addCmd([randomRecipe(rand, doc.nextId())]));
    expect(n).toBe(1);
  });

  it('updated moves forward on content changes only', () => {
    const c = clock(100);
    const rand = seeded(12);
    const doc = createDoc(newMeta(100, 1, 'd'), [], { now: c.now });
    c.set(200);
    doc.setView({ ground: 'paper' });
    expect(doc.meta.updated).toBe(100);
    doc.apply(addCmd([randomRecipe(rand, doc.nextId())]));
    expect(doc.meta.updated).toBe(200);
    c.set(150);
    doc.apply(metaCmd('x'));
    expect(doc.meta.updated).toBe(200);
  });

  it('setView changes ground and camera outside history and reports view changes', () => {
    const doc = createDoc(newMeta(0, 1, 'd'));
    const changes: DocChange[] = [];
    doc.subscribe(ch => changes.push(ch));
    doc.setView({ ground: 'paper', camera: { cx: 10, cy: -4, scale: 2, rot: 0 } });
    expect(doc.meta.ground).toBe('paper');
    expect(doc.meta.camera).toEqual({ cx: 10, cy: -4, scale: 2, rot: 0 });
    expect(changes).toEqual([{ added: [], removed: [], geometry: [], color: [], meta: true, view: true }]);
    doc.setView({ ground: 'paper', camera: { cx: 10, cy: -4, scale: 2, rot: 0 } });
    expect(changes.length).toBe(1);
    expect(() => doc.setView({ camera: { cx: NaN, cy: 0, scale: 1, rot: 0 } })).toThrow(RangeError);
  });
});

// ------------------------------------------------------------------ property test

interface Model { strokes: Map<StrokeId, StrokeRecipe>; title: string }

function cloneModel(m: Model): Model { return { strokes: new Map(m.strokes), title: m.title }; }

/** Apply a command to the reference model (the specification of apply). */
function modelApply(m: Model, c: Command): void {
  switch (c.k) {
    case 'add': for (const r of c.recipes) m.strokes.set(r.id, r); break;
    case 'remove': for (const id of c.ids) m.strokes.delete(id); break;
    case 'replace': for (const r of c.after) m.strokes.set(r.id, r); break;
    case 'meta': if (c.patch.title !== undefined) m.title = c.patch.title; break;
    case 'batch': for (const s of c.cmds) modelApply(m, s); break;
  }
}

function expectedChange(a: Model, b: Model): DocChange {
  const ch: DocChange = { added: [], removed: [], geometry: [], color: [], meta: a.title !== b.title, view: false };
  for (const [id, r] of b.strokes) {
    const p = a.strokes.get(id);
    if (!p) ch.added.push(id);
    else if (p !== r) (p.geomRev !== r.geomRev ? ch.geometry : ch.color).push(id);
  }
  for (const id of a.strokes.keys()) if (!b.strokes.has(id)) ch.removed.push(id);
  for (const k of ['added', 'removed', 'geometry', 'color'] as const) ch[k].sort();
  return ch;
}

describe('doc: property test (200 seeded random commands)', () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: model agreement, undo-all to empty, redo-all to the same objects`, () => {
      const rand = seeded(1000 + seed);
      const c = clock();
      const doc = createDoc(newMeta(0, seed, 'doc'), [], { now: c.now });
      const h = createHistory(doc, 10_000);
      let model: Model = { strokes: new Map(), title: doc.meta.title };
      let last: DocChange | null = null;
      doc.subscribe(ch => { last = ch; });
      const check = (): void => {
        const want = [...model.strokes.keys()].sort();
        expect(doc.ordered().map(r => r.id)).toEqual(want);
        for (const r of doc.ordered()) expect(r).toBe(model.strokes.get(r.id));
        expect(doc.meta.title).toBe(model.title);
      };

      /** A random command valid against `m` (which it updates as it goes). */
      const gen = (m: Model, depth: number): Command => {
        const ids = [...m.strokes.keys()];
        const roll = rand();
        let cmd: Command;
        if (ids.length === 0 || roll < 0.35) {
          const n = randInt(rand, 1, 3);
          cmd = addCmd(Array.from({ length: n }, () => randomRecipe(rand, doc.nextId())));
        } else if (roll < 0.5) {
          const n = randInt(rand, 1, Math.min(3, ids.length));
          const pickIds = new Set<StrokeId>();
          while (pickIds.size < n) pickIds.add(pick(rand, ids));
          if (rand() < 0.2) pickIds.add('ghost' + randInt(rand, 0, 99999999).toString().padStart(8, '0'));
          cmd = removeCmd([...pickIds]);
        } else if (roll < 0.8) {
          const n = randInt(rand, 1, Math.min(3, ids.length));
          const pickIds = new Set<StrokeId>();
          while (pickIds.size < n) pickIds.add(pick(rand, ids));
          const before = [...pickIds].map(id => m.strokes.get(id) as StrokeRecipe);
          const after = before.map(r => rand() < 0.5
            ? patchRecipe(r, { seed: (r.seed + 1) >>> 0, form: { ...r.form, base: r.form.base + 0.25 } }, 'geometry')
            : patchRecipe(r, { color: { ...r.color, dh: r.color.dh + 1 } }, 'color'));
          cmd = replaceCmd(before, after);
        } else if (roll < 0.9 || depth > 0) {
          cmd = metaCmd('title ' + randInt(rand, 0, 5));
        } else {
          const n = randInt(rand, 2, 4);
          const sub: Command[] = [];
          for (let i = 0; i < n; i++) sub.push(gen(m, depth + 1));
          return batchCmd(sub); // sub-commands already updated m
        }
        modelApply(m, cmd);
        return cmd;
      };

      const expectLast = (want: DocChange): void => {
        const nothing = !want.meta && want.added.length + want.removed.length + want.geometry.length + want.color.length === 0;
        if (nothing) expect(last).toBe(null);
        else expect(last).toEqual(want);
      };

      let applied = 0;
      while (applied < 200) {
        const r = rand();
        if (r < 0.08 && h.canUndo) {
          const peek = h.peekUndo();
          const before = cloneModel(model);
          last = null;
          const inv = h.undo() as Command;
          expect(inv).toBe(peek);
          modelApply(model, inv);
          expectLast(expectedChange(before, model));
          check();
          continue;
        }
        if (r < 0.12 && h.canRedo) {
          const before = cloneModel(model);
          last = null;
          modelApply(model, h.redo() as Command);
          expectLast(expectedChange(before, model));
          check();
          continue;
        }
        const before = cloneModel(model);
        const next = cloneModel(model);
        const cmd = gen(next, 0);
        last = null;
        h.push(cmd, doc.apply(cmd));
        model = next;
        expectLast(expectedChange(before, model));
        check();
        applied++;
      }

      const finalOrder = doc.ordered().slice();
      const finalTitle = doc.meta.title;
      const counters = doc.meta.counter;
      let undos = 0;
      while (h.undo()) undos++;
      expect(undos).toBeGreaterThan(0);
      expect(doc.size).toBe(0);
      expect(doc.ordered()).toEqual([]);
      expect(doc.meta.title).toBe('Untitled');
      expect(doc.meta.counter).toBe(counters);

      while (h.redo());
      expect(doc.ordered().length).toBe(finalOrder.length);
      doc.ordered().forEach((r, i) => expect(r).toBe(finalOrder[i]));
      expect(doc.meta.title).toBe(finalTitle);

      while (h.undo());
      expect(doc.size).toBe(0);
    });
  }
});

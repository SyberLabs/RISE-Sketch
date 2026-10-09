import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Camera, Doc, DocMeta, StrokeId, StrokeRecipe } from '../src/core/types';
import { addCmd, metaCmd, patchRecipe, removeCmd, replaceCmd } from '../src/doc/commands';
import { cloneMeta, createDoc, newMeta } from '../src/doc/document';
import { createHistory } from '../src/doc/history';
import { createAutosave } from '../src/persist/autosave';
import type { AutosaveInternal } from '../src/persist/autosave';
import type { DocStore, DocSummary, StoreBatch, SyncInfo } from '../src/persist/idb';
import { prefs } from '../src/persist/prefs';
import { adoptDocument } from '../src/app/docs';
import { remixUrl } from '../src/persist/remix';
import type { Runtime } from '../src/app/runtime';
import type { Controller } from '../src/app/controller';
import { pick, randomRecipe, seeded } from './doc-persist.helpers';

/** In-memory DocStore that records every batch and can be told to fail. */
class FakeStore implements DocStore {
  docs = new Map<string, { meta: DocMeta; strokes: number }>();
  strokes = new Map<string, Map<StrokeId, StrokeRecipe>>();
  snaps = new Map<string, { blob: Blob; cam: Camera }>();
  thumbs = new Map<string, Blob>();
  batches: StoreBatch[] = [];
  failNext: unknown[] = [];
  persistCalls = 0;
  evictions = 0;

  private bucket(id: string) {
    let m = this.strokes.get(id);
    if (!m) this.strokes.set(id, (m = new Map()));
    return m;
  }
  async listDocs(): Promise<DocSummary[]> {
    return [...this.docs.values()].map(d => ({ id: d.meta.id, title: d.meta.title, updated: d.meta.updated, strokes: d.strokes })).sort((a, b) => b.updated - a.updated);
  }
  async loadDoc(id: string) {
    const d = this.docs.get(id);
    if (!d) return null;
    return { meta: cloneMeta(d.meta), strokes: [...this.bucket(id).values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
  }
  async putMeta(meta: DocMeta, strokeCount: number) { this.docs.set(meta.id, { meta: cloneMeta(meta), strokes: strokeCount }); }
  async putStrokes(docId: string, rs: readonly StrokeRecipe[]) { for (const r of rs) this.bucket(docId).set(r.id, r); }
  async deleteStrokes(docId: string, ids: readonly StrokeId[]) { for (const id of ids) this.bucket(docId).delete(id); }
  async deleteDoc(id: string) { this.docs.delete(id); this.strokes.delete(id); this.snaps.delete(id); this.thumbs.delete(id); }
  async putSnapshot(docId: string, blob: Blob, cam: Camera) { this.snaps.set(docId, { blob, cam }); }
  async getSnapshot(docId: string) { return this.snaps.get(docId) ?? null; }
  async putThumb(docId: string, blob: Blob) { this.thumbs.set(docId, blob); }
  async getThumb(docId: string) { return this.thumbs.get(docId) ?? null; }
  async requestPersist() { this.persistCalls++; return true; }
  async writeBatch(b: StoreBatch) {
    this.batches.push(b);
    await Promise.resolve();
    const f = this.failNext.shift();
    if (f) throw f;
    await this.putStrokes(b.docId, b.put);
    await this.deleteStrokes(b.docId, b.del);
    if (b.meta) await this.putMeta(b.meta, b.strokeCount);
  }
  async syncInfo(docId: string): Promise<SyncInfo> {
    return { exists: this.docs.has(docId), ids: [...this.bucket(docId).keys()] };
  }
  async evictSnapshots(keep: string) {
    this.evictions++;
    let n = 0;
    for (const k of [...this.snaps.keys()]) if (k !== keep) { this.snaps.delete(k); n++; }
    return n;
  }
  /** The stored strokes of a doc as an id-ordered list. */
  list(docId: string) { return [...this.bucket(docId).values()].sort((a, b) => (a.id < b.id ? -1 : 1)); }
}

const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

function mkDoc(id = 'doc1', strokes: StrokeRecipe[] = []) {
  return createDoc(newMeta(Date.now(), 1, id), strokes);
}

function expectStoreMatches(store: FakeStore, doc: Doc): void {
  const stored = store.list(doc.meta.id);
  expect(stored.map(r => r.id)).toEqual(doc.ordered().map(r => r.id));
  stored.forEach((r, i) => expect(r).toBe(doc.ordered()[i]));
  const rec = store.docs.get(doc.meta.id)!;
  expect(rec.strokes).toBe(doc.size);
  expect(rec.meta.title).toBe(doc.meta.title);
  expect(rec.meta.counter).toBe(doc.meta.counter);
  expect(rec.meta.camera).toEqual(doc.meta.camera);
}

describe('autosave', () => {
  let rand: () => number;
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    rand = seeded(9);
    prefs.remove('persist-asked');
  });
  afterEach(() => { vi.useRealTimers(); });

  const stroke = (doc: Doc, pools?: boolean) => randomRecipe(rand, doc.nextId(), { pools });

  it('never writes an empty, never-stored document', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const doc = mkDoc();
    as.attach(doc);
    doc.setView({ camera: { cx: 5, cy: 5, scale: 2, rot: 0 } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.batches.length).toBe(0);
    expect(store.docs.size).toBe(0);
    expect(as.ok).toBe(true);
    as.dispose();
  });

  it('batches changes into one write per 250 ms window', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const doc = mkDoc();
    as.attach(doc);
    await vi.advanceTimersByTimeAsync(0);
    const a = stroke(doc), b = stroke(doc);
    doc.apply(addCmd([a]));
    await vi.advanceTimersByTimeAsync(100);
    doc.apply(addCmd([b]));
    await vi.advanceTimersByTimeAsync(149);
    expect(store.batches.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.batches.length).toBe(1);
    expect(store.batches[0].put.map(r => r.id)).toEqual([a.id, b.id]);
    expect(store.batches[0].meta?.id).toBe('doc1');
    expect(store.batches[0].strokeCount).toBe(2);
    expectStoreMatches(store, doc);
    as.dispose();
  });

  it('puts only touched records: replace, remove, add-then-remove coalesce to the latest state', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const doc = mkDoc();
    as.attach(doc);
    const a = stroke(doc), b = stroke(doc), c = stroke(doc);
    doc.apply(addCmd([a, b]));
    await as.flush();
    store.batches.length = 0;
    const a2 = patchRecipe(a, { seed: 1 }, 'geometry');
    doc.apply(replaceCmd([a], [a2]));
    doc.apply(removeCmd([b.id]));
    doc.apply(addCmd([c]));
    doc.apply(removeCmd([c.id]));
    await vi.advanceTimersByTimeAsync(250);
    expect(store.batches.length).toBe(1);
    const bt = store.batches[0];
    expect(bt.put).toEqual([a2]);
    expect([...bt.del].sort()).toEqual([b.id, c.id].sort());
    expectStoreMatches(store, doc);
    as.dispose();
  });

  it('flush() writes at once', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const doc = mkDoc();
    as.attach(doc);
    doc.apply(addCmd([stroke(doc)]));
    await as.flush();
    expect(store.batches.length).toBe(1);
    expect((as as AutosaveInternal).pending).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.batches.length).toBe(1);
    as.dispose();
  });

  it('reconciles on attach: loaded docs write nothing, opened files write everything, drift is repaired', async () => {
    const store = new FakeStore();
    const seedDoc = mkDoc('loaded');
    const rs = [stroke(seedDoc), stroke(seedDoc), stroke(seedDoc)];
    await store.putStrokes('loaded', rs);
    await store.putMeta(cloneMeta(seedDoc.meta), 3);
    const as = createAutosave(store);

    // identical to the store: nothing to write
    as.attach(createDoc(cloneMeta(seedDoc.meta), rs));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.batches.length).toBe(0);

    // drifted: the store has an extra stroke and lacks one
    const extra = stroke(seedDoc);
    await store.putStrokes('loaded', [extra]);
    const fresh = stroke(seedDoc);
    const drifted = createDoc(cloneMeta(seedDoc.meta), [rs[0], rs[1], rs[2], fresh]);
    as.attach(drifted);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.batches.length).toBe(1);
    expect(store.batches[0].put).toEqual([fresh]);
    expect(store.batches[0].del).toEqual([extra.id]);
    expectStoreMatches(store, drifted);

    // a document opened from a file (unknown to the store) is written whole
    const fileDoc = mkDoc('fromfile', [stroke(seedDoc), stroke(seedDoc)]);
    as.attach(fileDoc);
    await vi.advanceTimersByTimeAsync(1000);
    expectStoreMatches(store, fileDoc);
    as.dispose();
  });

  it('persists adoption recency for older backups and Recent without losing either drawing', async () => {
    const store = new FakeStore();
    const current = mkDoc('current', [randomRecipe(seeded(11), 'currentstroke')]);
    await store.putStrokes(current.meta.id, current.ordered());
    await store.putMeta(current.meta, current.size);
    const older = mkDoc('restored', [randomRecipe(seeded(12), 'backupstroke')]);
    const sourceMeta = { ...older.meta, updated: current.meta.updated - 1000 };
    const originalLink = await remixUrl(older, 'recency-fixture', () => true);
    const autosave = createAutosave(store) as AutosaveInternal;
    autosave.attach(current);
    const scene = () => ({ dispose() {}, ensure: async () => {} });
    const rt = { doc: current, autosave, scene: scene(), makeScene: scene,
      renderer: { live: { fastForward() {} }, rebind() {} }, docStore: store } as unknown as Runtime;
    const ctl = { leaveDocument() {}, adoptView() {}, refreshDoc() {}, docChanged() {} } as unknown as Controller;
    vi.setSystemTime(current.meta.updated + 1000);
    adoptDocument(rt, ctl, sourceMeta, older.ordered(), 'none');
    await vi.advanceTimersByTimeAsync(500);
    await autosave.flush();
    const restored = rt.doc;
    expect(await remixUrl(restored, 'recency-fixture', () => true)).toBe(originalLink);
    expect(restored.meta.created).toBe(sourceMeta.created);
    expect(restored.meta.camera).toEqual(sourceMeta.camera);
    expect(restored.meta.ground).toBe(sourceMeta.ground);
    expect(sourceMeta.updated).toBe(current.meta.updated - 1000);
    expect((await store.listDocs())[0].id).toBe(restored.meta.id);
    expect((await store.loadDoc(restored.meta.id))!.strokes).toEqual(older.ordered());
    expect((await store.loadDoc(current.meta.id))!.strokes).toEqual(current.ordered());
    // Opening an existing Recent document has no ink drift, so its metadata still must write.
    vi.setSystemTime(restored.meta.updated + 1000);
    adoptDocument(rt, ctl, current.meta, current.ordered(), 'none');
    await vi.advanceTimersByTimeAsync(500);
    await autosave.flush();
    expect((await store.listDocs())[0].id).toBe(current.meta.id);
    expect(store.docs.size).toBe(2);
    autosave.dispose();
  });

  it('flush immediately after attach waits for delayed reconciliation and persists all imported ink', async () => {
    const store = new FakeStore();
    let release!: (info: SyncInfo) => void;
    store.syncInfo = () => new Promise(resolve => { release = resolve; });
    const doc = mkDoc('imported', [randomRecipe(seeded(13), 'imported-stroke')]);
    const autosave = createAutosave(store);
    autosave.attach(doc, { persistMeta: true });
    let finished = false;
    const flushing = autosave.flush().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release({ exists: false, ids: [] });
    await flushing;
    expectStoreMatches(store, doc);
    expect(finished).toBe(true);
    autosave.dispose();
  });

  it('persists an explicitly adopted empty drawing as latest without changing default empty boot behavior', async () => {
    const store = new FakeStore();
    const prior = mkDoc('prior', [randomRecipe(seeded(14), 'prior-stroke')]);
    await store.putStrokes(prior.meta.id, prior.ordered());
    await store.putMeta(prior.meta, prior.size);
    vi.setSystemTime(prior.meta.updated + 1000);
    const empty = mkDoc('restored-empty');
    const autosave = createAutosave(store);
    autosave.attach(empty, { persistMeta: true });
    await autosave.flush();
    const latest = (await store.listDocs())[0];
    expect(latest.id).toBe(empty.meta.id);
    expect(latest.strokes).toBe(0);
    expect((await store.loadDoc(empty.meta.id))!.strokes).toEqual([]);
    expect((await store.loadDoc(prior.meta.id))!.strokes).toEqual(prior.ordered());
    autosave.dispose();
  });

  it('reports failures, keeps the data dirty, retries once, and recovers', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const statuses: boolean[] = [];
    as.onStatus(ok => statuses.push(ok));
    const doc = mkDoc();
    as.attach(doc);
    store.failNext.push(quota());
    const a = stroke(doc);
    doc.apply(addCmd([a]));
    await vi.advanceTimersByTimeAsync(250);
    expect(as.ok).toBe(false);
    expect(statuses).toEqual([false]);
    expect(store.list('doc1')).toEqual([]);
    expect((as as AutosaveInternal).lastError).toBeInstanceOf(DOMException);
    await vi.advanceTimersByTimeAsync(5000); // the single scheduled retry
    expect(as.ok).toBe(true);
    expect(statuses).toEqual([false, true]);
    expectStoreMatches(store, doc);
    as.dispose();
  });

  it('after a failed retry it waits for the next change (no recurring timers)', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const doc = mkDoc();
    as.attach(doc);
    store.failNext.push(quota(), quota());
    doc.apply(addCmd([stroke(doc)]));
    await vi.advanceTimersByTimeAsync(250 + 5000);
    expect(store.batches.length).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.batches.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    doc.apply(metaCmd('again'));
    await vi.advanceTimersByTimeAsync(250);
    expect(as.ok).toBe(true);
    expectStoreMatches(store, doc);
    as.dispose();
  });

  it('on a quota error, evicts other documents\' snapshots once', async () => {
    const store = new FakeStore();
    store.snaps.set('other', { blob: new Blob(['x']), cam: { cx: 0, cy: 0, scale: 1, rot: 0 } });
    const as = createAutosave(store);
    const doc = mkDoc();
    as.attach(doc);
    store.failNext.push(quota());
    doc.apply(addCmd([stroke(doc)]));
    await vi.advanceTimersByTimeAsync(250);
    expect(store.evictions).toBe(1);
    expect(store.snaps.has('other')).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(as.ok).toBe(true);
    expectStoreMatches(store, doc);
    as.dispose();
  });

  it('switching documents flushes the old one immediately', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const a = mkDoc('A');
    as.attach(a);
    a.apply(addCmd([stroke(a)]));
    const b = mkDoc('B');
    as.attach(b);
    await vi.advanceTimersByTimeAsync(0);
    expectStoreMatches(store, a);
    b.apply(addCmd([stroke(b)]));
    await vi.advanceTimersByTimeAsync(250);
    expectStoreMatches(store, b);
    expect(store.list('A').length).toBe(1);
    as.dispose();
  });

  it('a store without writeBatch: overlapping flushes never land a delete after a newer put', async () => {
    const store = new FakeStore();
    (store as { writeBatch?: unknown }).writeBatch = undefined; // fallback: put, delete, meta as separate calls
    const delays: number[] = [];
    const put = store.putStrokes.bind(store);
    store.putStrokes = async (id, rs) => {
      const d = delays.shift() ?? 0;
      if (d) await new Promise(r => setTimeout(r, d));
      return put(id, rs);
    };
    const as = createAutosave(store);
    const doc = mkDoc();
    as.attach(doc);
    const x = stroke(doc), z = stroke(doc);
    doc.apply(addCmd([x]));
    await as.flush();
    delays.push(100);                  // the next put is slow
    doc.apply(removeCmd([x.id]));
    doc.apply(addCmd([z]));
    const f1 = as.flush();             // put [z] (slow), then delete [x]
    doc.apply(addCmd([x]));            // undo the erase straight away
    const f2 = as.flush();             // put [x]: must not be overtaken by f1's delete
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([f1, f2]);
    expectStoreMatches(store, doc);
    expect(store.list('doc1').map(r => r.id)).toContain(x.id);
    as.dispose();
  });

  it('without a store it reports not-ok and never throws', async () => {
    const as = createAutosave(null);
    expect(as.ok).toBe(false);
    const doc = mkDoc();
    as.attach(doc);
    doc.apply(addCmd([stroke(doc)]));
    await vi.advanceTimersByTimeAsync(1000);
    await as.flush();
    as.dispose();
  });

  it('requests persistent storage once, after the 10th stroke', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const doc = mkDoc();
    as.attach(doc);
    for (let i = 0; i < 9; i++) doc.apply(addCmd([stroke(doc)]));
    expect(store.persistCalls).toBe(0);
    doc.apply(addCmd([stroke(doc)]));
    doc.apply(addCmd([stroke(doc)]));
    expect(store.persistCalls).toBe(1);
    as.dispose();
    const as2 = createAutosave(store);
    const doc2 = mkDoc('second');
    as2.attach(doc2);
    for (let i = 0; i < 12; i++) doc2.apply(addCmd([stroke(doc2)]));
    expect(store.persistCalls).toBe(1);
    as2.dispose();
  });

  it('snapshots after 2 s idle, at most every 10 s, with a derived thumbnail', async () => {
    const store = new FakeStore();
    const thumbs: number[] = [];
    const as = createAutosave(store, { thumb: async (b, px) => { thumbs.push(px); return new Blob([String(b.size)], { type: 'image/png' }); } }) as AutosaveInternal;
    let shots = 0;
    as.setSnapshotSource(async () => { shots++; return { blob: new Blob(['img' + shots], { type: 'image/png' }), cam: { cx: shots, cy: 0, scale: 1, rot: 0 } }; });
    const doc = mkDoc();
    as.attach(doc);
    doc.apply(addCmd([stroke(doc)]));
    await vi.advanceTimersByTimeAsync(1999);
    expect(shots).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(shots).toBe(1);
    expect(store.snaps.get('doc1')?.cam.cx).toBe(1);
    expect(store.thumbs.has('doc1')).toBe(true);
    expect(thumbs).toEqual([96]);
    doc.apply(addCmd([stroke(doc)]));              // t = 2 s
    await vi.advanceTimersByTimeAsync(9999);       // t ≈ 12 s: still inside the 10 s gap
    expect(shots).toBe(1);
    await vi.advanceTimersByTimeAsync(1);          // t = 12 s = last + 10 s
    expect(shots).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);     // nothing changed: no more snapshots
    expect(shots).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    as.dispose();
  });

  it('postpones idle snapshots while busy', async () => {
    const store = new FakeStore();
    const as = createAutosave(store, { thumb: async () => null }) as AutosaveInternal;
    let busy = true, shots = 0;
    as.setSnapshotSource(async () => { shots++; return { blob: new Blob(['i']), cam: { cx: 0, cy: 0, scale: 1, rot: 0 } }; }, () => busy);
    const doc = mkDoc();
    as.attach(doc);
    doc.apply(addCmd([stroke(doc)]));
    await vi.advanceTimersByTimeAsync(6000);
    expect(shots).toBe(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(shots).toBe(1);
    as.dispose();
  });

  it('fuzz: after random edits, undo and redo across many windows, the store equals the document', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const doc = mkDoc('fuzz');
    const h = createHistory(doc);
    as.attach(doc);
    for (let i = 0; i < 300; i++) {
      const r = rand();
      const ids = doc.ordered().map(x => x.id);
      if (r < 0.35 || ids.length === 0) { const c = addCmd([stroke(doc)]); h.push(c, doc.apply(c)); }
      else if (r < 0.5) { const c = removeCmd([pick(rand, ids)]); h.push(c, doc.apply(c)); }
      else if (r < 0.7) {
        const old = doc.get(pick(rand, ids))!;
        const c = replaceCmd([old], [patchRecipe(old, { color: { ...old.color, k: old.color.k + 1 } }, 'color')]);
        h.push(c, doc.apply(c));
      } else if (r < 0.85) h.undo();
      else if (r < 0.95) h.redo();
      else doc.setView({ camera: { cx: rand() * 100, cy: 0, scale: 1, rot: 0 } });
      if (rand() < 0.02) store.failNext.push(quota());
      await vi.advanceTimersByTimeAsync(Math.floor(rand() * 400));
    }
    await vi.advanceTimersByTimeAsync(6000);
    await as.flush();
    expectStoreMatches(store, doc);
    as.dispose();
  });

  it('dispose detaches and clears timers', async () => {
    const store = new FakeStore();
    const as = createAutosave(store);
    const doc = mkDoc();
    as.attach(doc);
    doc.apply(addCmd([stroke(doc)]));
    as.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.batches.length).toBe(1); // dispose flushed what was pending
    expect((doc as Doc & { listeners: number }).listeners).toBe(0);
    doc.apply(addCmd([stroke(doc)]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.batches.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

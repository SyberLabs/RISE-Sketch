/**
 * IndexedDB storage (DESIGN §8): database `rise`, version 1.
 *
 *   docs     key: doc id             meta, camera, ground, counters, updated, stroke count
 *   strokes  key: [docId, strokeId]  recipes, Float32Arrays stored natively
 *   snaps    key: doc id             viewport snapshot bytes + MIME type + its camera
 *   thumbs   key: doc id             96 px Recent thumbnail bytes + MIME type
 *
 * Images are stored as ArrayBuffer + type rather than Blob: Safari has a long
 * history of failing to store or read Blobs in IndexedDB, and the extra copy is
 * small and rare (snapshots are written at most every 10 s).
 *
 * Robustness: opening times out (some browsers hang on `file://` or in private
 * modes) and resolves null; a lost connection (Safari drops idle connections, the
 * user clears site data) is reopened once per failing call; a version change from
 * another tab closes this connection. Write transactions are committed explicitly
 * so a flush started in `pagehide` reaches the backend before the page goes away.
 */
import type { Camera, DocMeta, Ground, StrokeId, StrokeRecipe } from '../core/types';
import { freshRev, restoreRecipe } from '../doc/commands';
import type { RecipeFields } from '../doc/commands';
import { cloneMeta } from '../doc/document';

export const DB_NAME = 'rise';
export const DB_VERSION = 1;
const DOCS = 'docs', STROKES = 'strokes', SNAPS = 'snaps', THUMBS = 'thumbs';
const OPEN_TIMEOUT_MS = 4000;

/** One row of the Recent list. */
export interface DocSummary { id: string; title: string; updated: number; strokes: number }

/** Everything one autosave flush writes, applied in a single transaction. */
export interface StoreBatch {
  docId: string;
  /** Metadata to write (null: leave the doc record alone). */
  meta: DocMeta | null;
  strokeCount: number;
  put: readonly StrokeRecipe[];
  del: readonly StrokeId[];
}

/** What the store holds for one document (autosave reconciliation on attach). */
export interface SyncInfo { exists: boolean; ids: StrokeId[] }

export interface DocStore {
  listDocs(): Promise<DocSummary[]>;                                     // newest first
  loadDoc(id: string): Promise<{ meta: DocMeta; strokes: StrokeRecipe[] } | null>;
  putMeta(meta: DocMeta, strokeCount: number): Promise<void>;
  putStrokes(docId: string, recipes: readonly StrokeRecipe[]): Promise<void>;
  deleteStrokes(docId: string, ids: readonly StrokeId[]): Promise<void>;
  deleteDoc(id: string): Promise<void>;
  putSnapshot(docId: string, blob: Blob, cam: Camera): Promise<void>;
  getSnapshot(docId: string): Promise<{ blob: Blob; cam: Camera } | null>;
  putThumb(docId: string, blob: Blob): Promise<void>;
  getThumb(docId: string): Promise<Blob | null>;
  requestPersist(): Promise<boolean>;
  /** Optional: meta + stroke puts/deletes in one atomic transaction (autosave prefers it). */
  writeBatch?(b: StoreBatch): Promise<void>;
  /** Optional: whether the doc record exists and which stroke ids are stored. */
  syncInfo?(docId: string): Promise<SyncInfo>;
  /** Optional: delete the snapshots of every document except `keep` (quota relief). Returns how many. */
  evictSnapshots?(keep: string): Promise<number>;
  /** Optional: close the connection. */
  close?(): void;
}

// ---------------------------------------------------------------- records

interface DocRecord extends DocMeta { strokes: number }
type StrokeRecord = RecipeFields & { docId: string; geomRev: number; colorRev: number };
interface ImageRecord { buf: ArrayBuffer; type: string; cam?: Camera }

/** Typed array that owns exactly its bytes (structured clone copies a view's whole buffer). */
function own<T extends Float32Array | Float64Array>(a: T): T {
  return a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : (a.slice() as T);
}

function toRecord(docId: string, r: StrokeRecipe): StrokeRecord {
  return {
    docId, id: r.id, created: r.created, origin: [r.origin[0], r.origin[1]], z: r.z, rot: r.rot, seed: r.seed,
    device: r.device, calib: r.calib, stroke: r.stroke, color: r.color, form: r.form, s0: r.s0, cut: r.cut,
    resume: r.resume ? own(r.resume) : null, samples: own(r.samples), pools: own(r.pools),
    closed: r.closed, radial: r.radial, sym: r.sym, xf: r.xf ? own(r.xf) : null,
    geomRev: r.geomRev, colorRev: r.colorRev,
  };
}

/**
 * Rebuild a recipe from a stored record; null for a malformed record (it is skipped,
 * not fatal). The stored revs are NOT reused: revs are in-memory cache keys, and a
 * rev stored by an earlier session can equal one this session already issued for
 * the same stroke id with different content (e.g. after opening a `.rise` export of
 * this document and restyling it). Like `parseDoc`, loading assigns `rev`, which is
 * fresh for this session.
 */
function fromRecord(rec: unknown, rev: number): StrokeRecipe | null {
  const r = rec as Partial<StrokeRecord> | null;
  if (!r || typeof r.id !== 'string' || !(r.samples instanceof Float32Array) || !(r.pools instanceof Float32Array)) return null;
  if (!r.calib || !r.stroke || !r.color || !r.form || !Array.isArray(r.origin)) return null;
  try {
    return restoreRecipe(r as StrokeRecord, rev, rev);
  } catch {
    return null;
  }
}

const finite = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function metaFromRecord(rec: DocRecord): DocMeta {
  const c = rec.camera ?? { cx: 0, cy: 0, scale: 1, rot: 0 };
  const scale = finite(c.scale, 1);
  return cloneMeta({
    id: rec.id,
    title: typeof rec.title === 'string' ? rec.title : 'Untitled',
    created: finite(rec.created, 0),
    updated: finite(rec.updated, finite(rec.created, 0)),
    docSeed: finite(rec.docSeed, 0) >>> 0,
    counter: finite(rec.counter, 0),
    inkCounters: rec.inkCounters ?? ({} as DocMeta['inkCounters']),
    ground: (rec.ground === 'paper' ? 'paper' : 'night') as Ground,
    camera: { cx: finite(c.cx, 0), cy: finite(c.cy, 0), scale: scale > 0 ? scale : 1, rot: finite(c.rot, 0) },
  });
}

function metaRecord(meta: DocMeta, strokeCount: number): DocRecord {
  const m = cloneMeta(meta);
  return { ...m, strokes: strokeCount };
}

const strokeRange = (docId: string): IDBKeyRange => IDBKeyRange.bound([docId], [docId, []]);

// ---------------------------------------------------------------- transactions

/** Issue requests in `body` synchronously; resolve with `body`'s reader once the transaction commits. */
function transact<T>(db: IDBDatabase, names: string[], mode: IDBTransactionMode, body: (t: IDBTransaction) => () => T, commit = mode === 'readwrite'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let t: IDBTransaction;
    try {
      t = db.transaction(names, mode);
    } catch (e) {
      reject(e);
      return;
    }
    let read: () => T;
    try {
      read = body(t);
    } catch (e) {
      try { t.abort(); } catch { /* already finished */ }
      reject(e);
      return;
    }
    t.oncomplete = () => {
      try { resolve(read()); } catch (e) { reject(e); }
    };
    t.onabort = () => reject(t.error ?? new DOMException('Transaction aborted', 'AbortError'));
    t.onerror = ev => ev.preventDefault(); // handled by onabort; keep it off the console / window.onerror
    if (commit) {
      try { t.commit(); } catch { /* commit() is optional; auto-commit still happens */ }
    }
  });
}

function capture<T>(req: IDBRequest<T>): () => T {
  return () => req.result;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (db: IDBDatabase | null): void => {
      if (settled) { db?.close(); return; }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      finish(null);
      return;
    }
    req.onupgradeneeded = ev => {
      const db = req.result;
      if (ev.oldVersion < 1) {
        db.createObjectStore(DOCS, { keyPath: 'id' });
        db.createObjectStore(STROKES, { keyPath: ['docId', 'id'] });
        db.createObjectStore(SNAPS);
        db.createObjectStore(THUMBS);
      }
    };
    req.onsuccess = () => finish(req.result);
    req.onerror = ev => { ev.preventDefault(); finish(null); };
    // onblocked: an older connection in another tab has not closed yet; wait (the timeout bounds it)
  });
}

const isConnectionLost = (e: unknown): boolean =>
  e instanceof DOMException && (e.name === 'InvalidStateError' || e.name === 'UnknownError');

/** Open the `rise` database. Resolves null when IndexedDB is unavailable, blocked, or hangs. */
export async function openDocStore(): Promise<DocStore | null> {
  if (typeof indexedDB === 'undefined') return null;
  let db = await openDb();
  if (!db) return null;
  let closed = false;

  const adopt = (d: IDBDatabase): IDBDatabase => {
    d.onversionchange = () => { d.close(); if (db === d) db = null; };
    d.onclose = () => { if (db === d) db = null; };
    return d;
  };
  adopt(db);

  /** Shared in-flight reopen, so concurrent callers get one connection (none leaks). */
  let opening: Promise<IDBDatabase | null> | null = null;

  async function conn(): Promise<IDBDatabase> {
    if (closed) throw new DOMException('Document store closed', 'InvalidStateError');
    if (db) return db;
    if (!opening) {
      opening = openDb().then(d => {
        opening = null;
        if (d && closed) { d.close(); return null; }
        if (d) db = adopt(d);
        return d;
      });
    }
    const d = await opening;
    if (!d) throw new DOMException(closed ? 'Document store closed' : 'IndexedDB is unavailable', closed ? 'InvalidStateError' : 'UnknownError');
    return d;
  }

  /** Run a transaction, reopening the connection once if it was lost. */
  async function run<T>(names: string[], mode: IDBTransactionMode, body: (t: IDBTransaction) => () => T, commit?: boolean): Promise<T> {
    const d = await conn();
    try {
      return await transact(d, names, mode, body, commit);
    } catch (e) {
      if (!isConnectionLost(e) || closed) throw e;
      if (db === d) db = null;
      return transact(await conn(), names, mode, body, commit);
    }
  }

  const store: DocStore = {
    async listDocs() {
      const recs = await run([DOCS], 'readonly', t => capture(t.objectStore(DOCS).getAll() as IDBRequest<DocRecord[]>));
      return recs
        .filter(r => r && typeof r.id === 'string')
        .map(r => ({ id: r.id, title: typeof r.title === 'string' ? r.title : 'Untitled', updated: finite(r.updated, 0), strokes: finite(r.strokes, 0) }))
        .sort((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    },

    async loadDoc(id) {
      const [rec, rows] = await run([DOCS, STROKES], 'readonly', t => {
        const m = t.objectStore(DOCS).get(id) as IDBRequest<DocRecord | undefined>;
        const s = t.objectStore(STROKES).getAll(strokeRange(id));
        return () => [m.result, s.result as unknown[]] as const;
      });
      if (!rec) return null;
      const strokes: StrokeRecipe[] = [];
      const rev = freshRev();
      for (const row of rows) {
        const r = fromRecord(row, rev);
        if (r) strokes.push(r);
      }
      return { meta: metaFromRecord(rec), strokes };
    },

    async putMeta(meta, strokeCount) {
      const rec = metaRecord(meta, strokeCount);
      await run([DOCS], 'readwrite', t => { t.objectStore(DOCS).put(rec); return () => undefined; });
    },

    async putStrokes(docId, recipes) {
      if (!recipes.length) return;
      const recs = recipes.map(r => toRecord(docId, r));
      await run([STROKES], 'readwrite', t => {
        const s = t.objectStore(STROKES);
        for (const r of recs) s.put(r);
        return () => undefined;
      });
    },

    async deleteStrokes(docId, ids) {
      if (!ids.length) return;
      await run([STROKES], 'readwrite', t => {
        const s = t.objectStore(STROKES);
        for (const id of ids) s.delete([docId, id]);
        return () => undefined;
      });
    },

    async deleteDoc(id) {
      await run([DOCS, STROKES, SNAPS, THUMBS], 'readwrite', t => {
        t.objectStore(DOCS).delete(id);
        t.objectStore(STROKES).delete(strokeRange(id));
        t.objectStore(SNAPS).delete(id);
        t.objectStore(THUMBS).delete(id);
        return () => undefined;
      });
    },

    async putSnapshot(docId, blob, cam) {
      const rec: ImageRecord = { buf: await blob.arrayBuffer(), type: blob.type, cam: { cx: cam.cx, cy: cam.cy, scale: cam.scale, rot: cam.rot } };
      await run([SNAPS], 'readwrite', t => { t.objectStore(SNAPS).put(rec, docId); return () => undefined; });
    },

    async getSnapshot(docId) {
      const rec = await run([SNAPS], 'readonly', t => capture(t.objectStore(SNAPS).get(docId) as IDBRequest<ImageRecord | undefined>));
      if (!rec || !(rec.buf instanceof ArrayBuffer) || !rec.cam) return null;
      return { blob: new Blob([rec.buf], { type: rec.type || 'image/png' }), cam: rec.cam };
    },

    async putThumb(docId, blob) {
      const rec: ImageRecord = { buf: await blob.arrayBuffer(), type: blob.type };
      await run([THUMBS], 'readwrite', t => { t.objectStore(THUMBS).put(rec, docId); return () => undefined; });
    },

    async getThumb(docId) {
      const rec = await run([THUMBS], 'readonly', t => capture(t.objectStore(THUMBS).get(docId) as IDBRequest<ImageRecord | undefined>));
      if (!rec || !(rec.buf instanceof ArrayBuffer)) return null;
      return new Blob([rec.buf], { type: rec.type || 'image/png' });
    },

    async requestPersist() {
      try {
        const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
        if (!s || typeof s.persist !== 'function') return false;
        if (typeof s.persisted === 'function' && await s.persisted()) return true;
        return await s.persist();
      } catch {
        return false;
      }
    },

    async writeBatch(b) {
      const recs = b.put.map(r => toRecord(b.docId, r));
      const meta = b.meta ? metaRecord(b.meta, b.strokeCount) : null;
      if (!recs.length && !b.del.length && !meta) return;
      await run([DOCS, STROKES], 'readwrite', t => {
        const s = t.objectStore(STROKES);
        for (const r of recs) s.put(r);
        for (const id of b.del) s.delete([b.docId, id]);
        if (meta) t.objectStore(DOCS).put(meta);
        return () => undefined;
      });
    },

    async syncInfo(docId) {
      return run([DOCS, STROKES], 'readonly', t => {
        const m = t.objectStore(DOCS).count(docId);
        const k = t.objectStore(STROKES).getAllKeys(strokeRange(docId));
        return () => ({ exists: m.result > 0, ids: (k.result as unknown as [string, string][]).map(x => x[1]) });
      });
    },

    async evictSnapshots(keep) {
      return run([SNAPS], 'readwrite', t => {
        const s = t.objectStore(SNAPS);
        let n = 0;
        const req = s.getAllKeys();
        req.onsuccess = () => {
          for (const k of req.result) if (k !== keep) { s.delete(k); n++; }
        };
        return () => n;
      }, false);
    },

    close() {
      closed = true;
      db?.close();
      db = null;
    },
  };
  return store;
}

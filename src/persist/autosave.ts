/**
 * Autosave (DESIGN §8).
 *
 * Writes only what changed: every DocChange marks stroke ids dirty, and a flush
 * puts the *current* recipe of each dirty id (or deletes it when the stroke is
 * gone), so coalescing, undo storms and add-then-remove inside one window all
 * resolve to one idempotent write of the latest state. Writes are batched with a
 * one-shot 250 ms timer (no recurring timers while idle) and flushed at once on
 * `visibilitychange: hidden`, `pagehide` and `freeze`. Each flush is one
 * transaction (meta + strokes) when the store supports `writeBatch`.
 *
 * Attaching a document reconciles it with the store (one key scan), so the caller
 * never has to say where a document came from: one loaded from IndexedDB writes
 * nothing, one opened from a file writes every stroke, a brand-new empty document
 * writes nothing until it has ink (empty canvases never litter Recent).
 *
 * Failures (IndexedDB unavailable, QuotaExceededError, a lost connection) turn
 * `ok` false and notify `onStatus` (the not-autosaving dot and its toast); the
 * failed ids stay dirty, one retry is scheduled, and any later change retries
 * again. On a quota error the snapshots of other documents are evicted once.
 *
 * Snapshots (optional, `setSnapshotSource`): written on hide, and otherwise at most
 * every 10 s after content changes, once the page has been idle for 2 s. The 96 px
 * Recent thumbnail is derived from each snapshot.
 *
 * After the 10th stroke of the first document, `navigator.storage.persist()` is
 * requested once (remembered in prefs).
 */
import type { Camera, Doc, DocChange, StrokeId, StrokeRecipe } from '../core/types';
import { cloneMeta } from '../doc/document';
import type { DocStore, StoreBatch } from './idb';
import { prefs } from './prefs';

export interface Autosave {
  /** Track a document: subscribes to doc changes, batches writes every 250 ms, flushes on hide/pagehide. */
  attach(doc: Doc, options?: { persistMeta?: boolean }): void;
  /** Start writing everything pending now; resolves when all writes so far have settled (check `ok`). */
  flush(): Promise<void>;
  readonly ok: boolean;
  /** Called with the new value whenever `ok` changes. Returns an unsubscribe function. */
  onStatus(fn: (ok: boolean) => void): () => void;
  dispose(): void;
}

/** Produces a viewport snapshot (e.g. `renderer.snapshot(maxEdge)` plus the camera). */
export type SnapshotSource = () => Promise<{ blob: Blob; cam: Camera } | null>;

/** Autosave plus snapshot wiring and debug state. */
export interface AutosaveInternal extends Autosave {
  /** Enable snapshots. `isBusy` (e.g. a contact is down) postpones idle snapshots. */
  setSnapshotSource(src: SnapshotSource | null, isBusy?: () => boolean): void;
  /** Write a snapshot (and thumbnail) now if the content changed since the last one (call before switching documents). */
  snapshotNow(force?: boolean): Promise<void>;
  /** True while changes are waiting or writes are in flight. */
  readonly pending: boolean;
  readonly lastError: unknown;
  readonly doc: Doc | null;
}

export interface AutosaveOptions {
  batchMs?: number;          // 250
  retryMs?: number;          // 5000
  snapshotIdleMs?: number;   // 2000
  snapshotGapMs?: number;    // 10000
  thumbPx?: number;          // 96
  persistAfter?: number;     // 10 strokes
  now?: () => number;
  /** Thumbnail maker (default `thumbFromSnapshot`). */
  thumb?: (blob: Blob, px: number) => Promise<Blob | null>;
  /** Register page lifecycle listeners (default: when a DOM is present). */
  lifecycle?: boolean;
}

const PERSIST_KEY = 'persist-asked';

const isQuota = (e: unknown): boolean =>
  !!e && typeof e === 'object' && ((e as { name?: string }).name === 'QuotaExceededError' || (e as { code?: number }).code === 22);

/** Create the autosaver. With a null store it never writes and reports ok = false. */
export function createAutosave(store: DocStore | null, opts?: AutosaveOptions): Autosave {
  const batchMs = opts?.batchMs ?? 250;
  const retryMs = opts?.retryMs ?? 5000;
  const idleMs = opts?.snapshotIdleMs ?? 2000;
  const gapMs = opts?.snapshotGapMs ?? 10000;
  const thumbPx = opts?.thumbPx ?? 96;
  const persistAfter = opts?.persistAfter ?? 10;
  const now = opts?.now ?? (() => Date.now());
  const makeThumb = opts?.thumb ?? thumbFromSnapshot;

  let doc: Doc | null = null;
  let unsub: (() => void) | null = null;
  let gen = 0;
  const dirty = new Set<StrokeId>();
  let metaDirty = false;
  /** The store holds a record for the attached document. */
  let known = false;
  let persistEmpty = false;
  /**
   * Ids (and whether meta) written since attach while reconciliation is pending. The
   * reconciliation read precedes every later write (IndexedDB orders transactions), so
   * these ids are already handled by dirty tracking and must not be rewritten.
   */
  let sinceAttach: Set<StrokeId> | null = null;
  let metaSinceAttach = false;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const inflight = new Set<Promise<void>>();
  let seq = 0, lastFailSeq = -1, failStreak = 0;
  let evicted = false;
  let ok = store !== null;
  let lastError: unknown = null;
  const statusFns: ((ok: boolean) => void)[] = [];
  let persistAsked = prefs.get<boolean>(PERSIST_KEY, false);
  let disposed = false;
  let reconciliation: Promise<void> = Promise.resolve();

  let snapSrc: SnapshotSource | null = null;
  let snapBusy: (() => boolean) | null = null;
  let snapDirty = false;
  let lastSnapAt = -Infinity;
  let snapTimer: ReturnType<typeof setTimeout> | null = null;
  let snapping: Promise<void> | null = null;

  function setOk(v: boolean): void {
    if (v === ok) return;
    ok = v;
    for (const fn of statusFns.slice()) {
      try { fn(v); } catch (e) { Promise.reject(e); }
    }
  }

  function schedule(): void {
    if (batchTimer === null && !disposed) batchTimer = setTimeout(() => { batchTimer = null; void flushNow(); }, batchMs);
  }

  /** Tail of the fallback write chain (stores without `writeBatch`). */
  let chain: Promise<unknown> = Promise.resolve();

  function write(b: StoreBatch): Promise<void> {
    const s = store as DocStore;
    if (s.writeBatch) return s.writeBatch(b); // one transaction; IndexedDB orders them
    // Without one transaction per flush, the steps of overlapping flushes could
    // interleave (an older delete landing after a newer put of the same stroke), so
    // fallback flushes run strictly one after another.
    const run = async (): Promise<void> => {
      if (b.put.length) await s.putStrokes(b.docId, b.put);
      if (b.del.length) await s.deleteStrokes(b.docId, b.del);
      if (b.meta) await s.putMeta(b.meta, b.strokeCount);
    };
    const p = chain.then(run, run);
    chain = p.catch(() => undefined);
    return p;
  }

  function settled(): Promise<void> {
    return Promise.all([...inflight]).then(() => undefined);
  }

  function onFailure(e: unknown, mySeq: number): void {
    lastError = e;
    lastFailSeq = Math.max(lastFailSeq, mySeq);
    failStreak++;
    setOk(false);
    if (isQuota(e) && !evicted && store?.evictSnapshots && doc) {
      evicted = true;
      store.evictSnapshots(doc.meta.id).then(n => { if (n > 0) schedule(); }, () => undefined);
    }
    if (failStreak === 1 && retryTimer === null && !disposed) {
      retryTimer = setTimeout(() => { retryTimer = null; void flushNow(); }, retryMs);
    }
  }

  /** Gather everything dirty and start one write, synchronously (safe inside pagehide). */
  function flushNow(): Promise<void> {
    if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; }
    const d = doc;
    if (!store || !d || (!dirty.size && !metaDirty)) return settled();
    const ids = [...dirty];
    dirty.clear();
    metaDirty = false;
    const put: StrokeRecipe[] = [], del: StrokeId[] = [];
    for (const id of ids) {
      const r = d.get(id);
      if (r) put.push(r); else del.push(id);
    }
    // A never-stored empty document gets no record (deletes still go through).
    const meta = d.size === 0 && !known && !persistEmpty ? null : cloneMeta(d.meta);
    if (!put.length && !del.length && !meta) return settled();
    if (sinceAttach) {
      for (const id of ids) sinceAttach.add(id);
      if (meta) metaSinceAttach = true;
    }
    const batch: StoreBatch = { docId: d.meta.id, meta, strokeCount: d.size, put, del };
    const myGen = gen, mySeq = ++seq;
    const p = write(batch).then(
      () => {
        if (myGen === gen && meta) known = true;
        if (mySeq > lastFailSeq) { failStreak = 0; setOk(true); }
      },
      (e: unknown) => {
        if (myGen === gen) {
          for (const id of ids) dirty.add(id);
          metaDirty = true;
        } else if (!disposed) {
          // The document was switched meanwhile: retry this exact batch once, immediately.
          // (A delayed retry could land after the document is reopened and overwrite newer
          // edits; an immediate one is ordered before any later reconciliation read.)
          void write(batch).catch(() => undefined);
        }
        onFailure(e, mySeq);
      },
    );
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return settled();
  }

  function maybePersist(d: Doc): void {
    if (persistAsked || !store || d.size < persistAfter) return;
    persistAsked = true;
    prefs.set(PERSIST_KEY, true);
    void store.requestPersist().catch(() => false);
  }

  // ------------------------------------------------------------ snapshots

  function scheduleSnapshot(): void {
    if (!snapSrc || disposed) return;
    if (snapTimer !== null) clearTimeout(snapTimer);
    const wait = Math.max(idleMs, lastSnapAt + gapMs - now());
    snapTimer = setTimeout(() => {
      snapTimer = null;
      if (snapBusy?.()) { scheduleSnapshot(); return; }
      whenIdle(() => { void snapshotNow(false); });
    }, wait);
  }

  function snapshotNow(force = false): Promise<void> {
    const d = doc;
    if (!store || !d || !snapSrc || (!snapDirty && !force)) return snapping ?? Promise.resolve();
    if (d.size === 0 && !known) return Promise.resolve();
    if (snapping) return snapping;
    snapDirty = false;
    lastSnapAt = now();
    const id = d.meta.id, src = snapSrc, s = store;
    const job = (async () => {
      try {
        const shot = await src();
        if (!shot) return;
        await s.putSnapshot(id, shot.blob, shot.cam);
        const t = await makeThumb(shot.blob, thumbPx);
        if (t) await s.putThumb(id, t);
      } catch (e) {
        lastError = e; // a missing snapshot only costs cold-load speed; it is not data loss
      }
    })();
    snapping = job.finally(() => { snapping = null; });
    return snapping;
  }

  // ------------------------------------------------------------ lifecycle

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      void flushNow();
      void snapshotNow(false);
    }
  };
  const onPageHide = (): void => { void flushNow(); };
  const lifecycle = opts?.lifecycle ?? (typeof document !== 'undefined' && typeof addEventListener === 'function');
  if (lifecycle) {
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('pagehide', onPageHide);
    document.addEventListener('freeze', onPageHide);
  }

  function onChange(ch: DocChange): void {
    for (const id of ch.added) dirty.add(id);
    for (const id of ch.removed) dirty.add(id);
    for (const id of ch.geometry) dirty.add(id);
    for (const id of ch.color) dirty.add(id);
    metaDirty = true;
    snapDirty = true;
    schedule();
    scheduleSnapshot();
    if (doc) maybePersist(doc);
  }

  function reconcile(d: Doc, myGen: number): Promise<void> {
    if (!store) return Promise.resolve();
    if (!store.syncInfo) {
      if (d.size > 0) { for (const r of d.ordered()) dirty.add(r.id); metaDirty = true; schedule(); }
      return Promise.resolve();
    }
    sinceAttach = new Set();
    metaSinceAttach = false;
    return store.syncInfo(d.meta.id).then(info => {
      if (myGen !== gen) return;
      const skip = sinceAttach ?? new Set<StrokeId>();
      sinceAttach = null;
      if (info.exists) known = true;
      const stored = new Set(info.ids);
      let drift = false;
      for (const id of stored) if (!d.has(id) && !skip.has(id)) { dirty.add(id); drift = true; }
      for (const r of d.ordered()) if (!stored.has(r.id) && !skip.has(r.id)) { dirty.add(r.id); drift = true; }
      if (drift || (!info.exists && !metaSinceAttach && d.size > 0)) { metaDirty = true; schedule(); }
    }, (e: unknown) => {
      if (myGen !== gen) return;
      sinceAttach = null;
      // cannot tell what is stored: write everything once
      for (const r of d.ordered()) dirty.add(r.id);
      if (d.size > 0) { metaDirty = true; schedule(); }
      onFailure(e, seq);
    });
  }

  const api: AutosaveInternal = {
    attach(d, options) {
      if (disposed || d === doc) return;
      if (doc) {
        void flushNow();
        unsub?.();
      }
      if (snapTimer !== null) { clearTimeout(snapTimer); snapTimer = null; }
      gen++;
      doc = d;
      dirty.clear();
      metaDirty = false;
      known = false;
      persistEmpty = Boolean(options?.persistMeta);
      snapDirty = false;
      lastSnapAt = -Infinity;
      unsub = d.subscribe(onChange);
      reconciliation = reconcile(d, gen);
      // A deliberate document adoption must persist its new recency even if ink is unchanged.
      if (options?.persistMeta) { metaDirty = true; schedule(); }
    },
    flush() {
      return reconciliation.then(flushNow);
    },
    get ok() { return ok; },
    onStatus(fn) {
      statusFns.push(fn);
      return () => {
        const i = statusFns.indexOf(fn);
        if (i >= 0) statusFns.splice(i, 1);
      };
    },
    dispose() {
      if (disposed) return;
      void flushNow();
      disposed = true;
      unsub?.();
      unsub = null;
      for (const t of [batchTimer, retryTimer, snapTimer]) if (t !== null) clearTimeout(t);
      batchTimer = retryTimer = snapTimer = null;
      if (lifecycle) {
        document.removeEventListener('visibilitychange', onVisibility);
        removeEventListener('pagehide', onPageHide);
        document.removeEventListener('freeze', onPageHide);
      }
      statusFns.length = 0;
      doc = null;
    },
    setSnapshotSource(src, isBusy) {
      snapSrc = src;
      snapBusy = isBusy ?? null;
      if (!src && snapTimer !== null) { clearTimeout(snapTimer); snapTimer = null; }
      else if (src && snapDirty) scheduleSnapshot();
    },
    snapshotNow,
    get pending() { return dirty.size > 0 || metaDirty || inflight.size > 0; },
    get lastError() { return lastError; },
    get doc() { return doc; },
  };
  return api;
}

/** Run `fn` when the main thread is idle (requestIdleCallback with a 1 s cap, else now). */
function whenIdle(fn: () => void): void {
  const g = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(fn, { timeout: 1000 });
  else fn();
}

/**
 * Downscale a snapshot to a Recent thumbnail whose long edge is `px` CSS px
 * (WebP when the browser encodes it, else PNG). Null when decoding is unavailable.
 */
export async function thumbFromSnapshot(blob: Blob, px = 96): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const k = px / Math.max(1, bmp.width, bmp.height);
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      if (!g) return null;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, w, h);
      try {
        return await c.convertToBlob({ type: 'image/webp', quality: 0.82 });
      } catch {
        return await c.convertToBlob({ type: 'image/png' });
      }
    }
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, h);
    return await new Promise<Blob | null>(res => c.toBlob(b => res(b), 'image/webp', 0.82));
  } finally {
    bmp.close();
  }
}

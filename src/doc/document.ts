/**
 * The document: an ordered set of immutable stroke recipes plus metadata.
 *
 * `apply` is the only stroke mutator. Every command is validated before anything
 * changes, a failing `batch` is rolled back, and the returned inverse is built from
 * the state actually replaced, so applying it restores the document exactly (same
 * recipe objects). Each top-level `apply` emits one net DocChange: an id added and
 * removed inside one batch is not reported, and a replaced id is classified by
 * comparing its recipe before and after the whole apply (geomRev differs ->
 * geometry; only colorRev differs -> color).
 *
 * Counters (`counter`, `inkCounters`) are monotonic and outside history: undo never
 * winds them back. Ground and camera are saved but not undoable (`setView`).
 */
import { hash32 } from '../core/det';
import { INK_ORDER } from '../core/types';
import type { Camera, Command, Doc, DocChange, DocMeta, Ground, InkId, StrokeId, StrokeRecipe } from '../core/types';
import { ID_COUNTER_SPAN, ID_MAX_MS, idMs, isStdStrokeId, makeStrokeId } from './ids';
import { noteRevs } from './commands';

/** Every ink that owns a variant counter (the seven stock inks plus custom). */
export const ALL_INKS: readonly InkId[] = [...INK_ORDER, 'custom'];

/** Default title of a new document. */
export const DEFAULT_TITLE = 'Untitled';

/** Fresh metadata for a new, empty document (Night ground, 100 % at the origin). */
export function newMeta(now: number, docSeed: number, id: string): DocMeta {
  const inkCounters = {} as Record<InkId, number>;
  for (const ink of ALL_INKS) inkCounters[ink] = 0;
  return {
    id, title: DEFAULT_TITLE, created: now, updated: now, docSeed: docSeed >>> 0,
    counter: 0, inkCounters, ground: 'night', camera: { cx: 0, cy: 0, scale: 1, rot: 0 },
  };
}

/** Optional construction parameters (an injectable clock for ids and `updated`). */
export interface DocOptions {
  /** Wall clock in ms (default Date.now). Feeds stroke ids and `meta.updated` only. */
  now?: () => number;
}

/** Doc plus a few read-only extras used by persistence and tests. */
export interface DocInternal extends Doc {
  /** Number of change listeners (tests / leak checks). */
  readonly listeners: number;
}

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function copyMeta(m: DocMeta): DocMeta {
  const inkCounters = {} as Record<InkId, number>;
  for (const ink of ALL_INKS) inkCounters[ink] = m.inkCounters?.[ink] ?? 0;
  const c = m.camera;
  return {
    id: m.id, title: m.title, created: m.created, updated: m.updated, docSeed: m.docSeed >>> 0,
    counter: m.counter, inkCounters, ground: m.ground,
    camera: { cx: c.cx, cy: c.cy, scale: c.scale, rot: c.rot },
  };
}

function freezeMeta(m: DocMeta): Readonly<DocMeta> {
  const f = copyMeta(m);
  Object.freeze(f.inkCounters);
  Object.freeze(f.camera);
  return Object.freeze(f);
}

const sameCamera = (a: Camera, b: Camera): boolean => a.cx === b.cx && a.cy === b.cy && a.scale === b.scale && a.rot === b.rot;

/** Validate a command tree without changing anything (no state access). */
function shapeCheck(c: Command, depth: number): void {
  if (depth > 64) throw new RangeError('command: batch nesting too deep');
  switch (c.k) {
    case 'add': {
      const seen = new Set<string>();
      for (const r of c.recipes) {
        if (!r || typeof r.id !== 'string' || r.id.length === 0) throw new TypeError('add: recipe without an id');
        if (!(r.samples instanceof Float32Array)) throw new TypeError(`add: recipe ${r.id} has no samples`);
        if (seen.has(r.id)) throw new RangeError(`add: duplicate id ${r.id}`);
        seen.add(r.id);
      }
      return;
    }
    case 'remove':
      for (const id of c.ids) if (typeof id !== 'string') throw new TypeError('remove: ids must be strings');
      return;
    case 'replace': {
      if (c.before.length !== c.after.length) throw new RangeError('replace: before/after length mismatch');
      const seen = new Set<string>();
      for (let i = 0; i < c.before.length; i++) {
        const b = c.before[i], a = c.after[i];
        if (!b || !a || b.id !== a.id) throw new RangeError(`replace: entry ${i} pairs different ids`);
        if (!(a.samples instanceof Float32Array)) throw new TypeError(`replace: recipe ${a.id} has no samples`);
        if (seen.has(b.id)) throw new RangeError(`replace: duplicate id ${b.id}`);
        seen.add(b.id);
      }
      return;
    }
    case 'meta':
      if (c.patch.title !== undefined && typeof c.patch.title !== 'string') throw new TypeError('meta: title must be a string');
      return;
    case 'batch':
      for (const s of c.cmds) shapeCheck(s, depth + 1);
      return;
    default:
      throw new TypeError(`command: unknown kind ${(c as { k: unknown }).k}`);
  }
}

/** Create a document from metadata and (optionally) its strokes, e.g. loaded from storage. */
export function createDoc(meta: DocMeta, strokes?: readonly StrokeRecipe[], opts?: DocOptions): Doc {
  const now = opts?.now ?? Date.now;
  const m = copyMeta(meta);
  const map = new Map<StrokeId, StrokeRecipe>();
  const arr: StrokeRecipe[] = [];
  let frozenMeta: Readonly<DocMeta> | null = null;
  let frozenOrder: readonly StrokeRecipe[] | null = null;
  /** Greatest standard-form id ever seen by this document (new ids sort after it). */
  let lastId = '';
  const subs: ((ch: DocChange) => void)[] = [];
  const queue: DocChange[] = [];
  let emitting = false;

  const noteId = (id: string): void => { if (isStdStrokeId(id) && id > lastId) lastId = id; };

  if (strokes) {
    for (const r of strokes) {
      if (map.has(r.id)) throw new RangeError(`createDoc: duplicate stroke id ${r.id}`);
      map.set(r.id, r);
      arr.push(r);
      noteId(r.id);
      noteRevs(r);
    }
    arr.sort((a, b) => cmpId(a.id, b.id));
  }

  /** Binary search: index of id, or -(insertion point) - 1. */
  function find(id: string): number {
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = arr[mid].id;
      if (v < id) lo = mid + 1;
      else if (v > id) hi = mid - 1;
      else return mid;
    }
    return -lo - 1;
  }

  function insert(r: StrokeRecipe): void {
    map.set(r.id, r);
    const n = arr.length;
    if (n === 0 || arr[n - 1].id < r.id) arr.push(r); // creation order: the common case
    else arr.splice(-find(r.id) - 1, 0, r);
    noteId(r.id);
  }
  function erase(id: string): void {
    map.delete(id);
    const i = find(id);
    if (i >= 0) arr.splice(i, 1);
  }
  function swap(r: StrokeRecipe): void {
    map.set(r.id, r);
    arr[find(r.id)] = r;
  }

  /** Per top-level apply: each touched id's recipe before the apply (undefined = absent). */
  let touched: Map<StrokeId, StrokeRecipe | undefined> | null = null;
  const touch = (id: StrokeId): void => { if (touched && !touched.has(id)) touched.set(id, map.get(id)); };

  function run(c: Command): Command {
    switch (c.k) {
      case 'add': {
        for (const r of c.recipes) if (map.has(r.id)) throw new RangeError(`add: stroke ${r.id} already exists`);
        for (const r of c.recipes) { touch(r.id); insert(r); }
        return { k: 'remove', ids: c.recipes.map(r => r.id) };
      }
      case 'remove': {
        const removed: StrokeRecipe[] = [];
        for (const id of c.ids) {
          const r = map.get(id);
          if (!r) continue; // already gone: the inverse restores only what this removed
          touch(id);
          erase(id);
          removed.push(r);
        }
        return { k: 'add', recipes: removed };
      }
      case 'replace': {
        const prev: StrokeRecipe[] = new Array(c.before.length);
        for (let i = 0; i < c.before.length; i++) {
          const cur = map.get(c.before[i].id);
          if (!cur) throw new RangeError(`replace: stroke ${c.before[i].id} does not exist`);
          prev[i] = cur;
        }
        for (const r of c.after) { touch(r.id); swap(r); noteRevs(r); }
        return { k: 'replace', before: c.after.slice(), after: prev };
      }
      case 'meta': {
        const old = m.title;
        // An unchanged title yields an empty inverse, which history does not record.
        if (c.patch.title === undefined || c.patch.title === old) return { k: 'meta', patch: {} };
        m.title = c.patch.title;
        return { k: 'meta', patch: { title: old } };
      }
      case 'batch': {
        const inv: Command[] = [];
        try {
          for (const s of c.cmds) inv.push(run(s));
        } catch (e) {
          for (let i = inv.length - 1; i >= 0; i--) run(inv[i]); // roll back: inverses always apply
          throw e;
        }
        inv.reverse();
        return { k: 'batch', cmds: inv };
      }
    }
  }

  function emit(ch: DocChange): void {
    queue.push(ch);
    if (emitting) return; // re-entrant apply from a listener: delivered after the current change, in order
    emitting = true;
    try {
      while (queue.length) {
        const next = queue.shift() as DocChange;
        for (const fn of subs.slice()) {
          try { fn(next); } catch (e) { Promise.reject(e); } // surface listener errors without breaking the doc
        }
      }
    } finally {
      emitting = false;
    }
  }

  function changed(): void {
    frozenMeta = null;
    frozenOrder = null;
  }

  const doc: DocInternal = {
    get meta() {
      return frozenMeta ?? (frozenMeta = freezeMeta(m));
    },
    get(id) { return map.get(id); },
    has(id) { return map.has(id); },
    ordered() {
      return frozenOrder ?? (frozenOrder = Object.freeze(arr.slice()));
    },
    get size() { return map.size; },
    get listeners() { return subs.length; },

    apply(c) {
      if (touched) throw new Error('Doc.apply is not re-entrant inside a command');
      shapeCheck(c, 0);
      touched = new Map();
      const titleBefore = m.title;
      let inverse: Command;
      const t = touched;
      try {
        inverse = run(c);
      } finally {
        touched = null;
      }
      const ch: DocChange = { added: [], removed: [], geometry: [], color: [], meta: m.title !== titleBefore, view: false };
      for (const [id, before] of t) {
        const after = map.get(id);
        if (before === after) continue;
        if (!before) ch.added.push(id);
        else if (!after) ch.removed.push(id);
        else if (before.geomRev !== after.geomRev) ch.geometry.push(id);
        else if (before.colorRev !== after.colorRev) ch.color.push(id);
        else ch.geometry.push(id); // different content under equal revs: re-cook to be safe
      }
      const changedSomething = ch.added.length + ch.removed.length + ch.geometry.length + ch.color.length > 0 || ch.meta;
      if (changedSomething) {
        ch.added.sort(cmpId); ch.removed.sort(cmpId); ch.geometry.sort(cmpId); ch.color.sort(cmpId);
        const tNow = now();
        if (tNow > m.updated) m.updated = tNow;
        changed();
        emit(ch);
      }
      return inverse;
    },

    nextSeed() {
      m.counter += 1;
      changed();
      return hash32(m.docSeed, m.counter);
    },

    nextVariant(ink) {
      const k = m.inkCounters[ink] ?? 0;
      m.inkCounters[ink] = k + 1;
      changed();
      return k;
    },

    nextId() {
      m.counter += 1;
      changed();
      const c = m.counter % ID_COUNTER_SPAN;
      // lastId only ever holds standard ids, so lastMs is a finite integer.
      const lastMs = lastId ? idMs(lastId) : 0;
      let ms = Math.floor(now());
      if (!(ms >= lastMs)) ms = lastMs;     // clock went backwards (or NaN): stay in creation order
      if (!(ms <= ID_MAX_MS)) ms = ID_MAX_MS; // Infinity / far future: keep the fixed width
      let id = makeStrokeId(ms, c);
      // ms >= lastMs, so only an equal prefix with a smaller (wrapped) counter can tie
      // or sort before; one more millisecond fixes it. (Past ID_MAX_MS, the year 5138,
      // ids stop being fixed width and ordering is no longer guaranteed.)
      if (id <= lastId) id = makeStrokeId(ms + 1, c);
      if (isStdStrokeId(id)) lastId = id;
      return id;
    },

    setView(v) {
      let dirty = false;
      if (v.ground !== undefined && v.ground !== m.ground) {
        if (v.ground !== 'night' && v.ground !== 'paper') throw new TypeError(`setView: unknown ground ${String(v.ground)}`);
        m.ground = v.ground as Ground;
        dirty = true;
      }
      if (v.camera !== undefined && !sameCamera(v.camera, m.camera)) {
        const c = v.camera;
        if (!Number.isFinite(c.cx) || !Number.isFinite(c.cy) || !(c.scale > 0) || !Number.isFinite(c.scale) || !Number.isFinite(c.rot)) {
          throw new RangeError('setView: camera values must be finite with scale > 0');
        }
        m.camera = { cx: c.cx, cy: c.cy, scale: c.scale, rot: c.rot };
        dirty = true;
      }
      if (!dirty) return;
      changed();
      emit({ added: [], removed: [], geometry: [], color: [], meta: true, view: true });
    },

    subscribe(fn) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  };
  return doc;
}

/** Structural snapshot of a document for equality checks (tests, debugging). Counters excluded. */
export function docState(d: Doc): { title: string; ids: StrokeId[]; recipes: readonly StrokeRecipe[] } {
  const recipes = d.ordered();
  return { title: d.meta.title, ids: recipes.map(r => r.id), recipes };
}

/** Deep copy of plain metadata (counters and camera are fresh objects). */
export function cloneMeta(m: Readonly<DocMeta>): DocMeta {
  return copyMeta(m as DocMeta);
}

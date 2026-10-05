/**
 * The scene: everything the app knows about committed strokes beyond the document
 * itself (DESIGN §7.1 scene/, §2.3.9, §3.4, §6.8, §9).
 *
 * It subscribes to the Doc and keeps three structures coherent with it:
 *  - an R-tree of stroke boxes: the cooked `inkBox` (∪ `hitBox`, which adds the
 *    untapered spine) once known, otherwise a conservative box (sample bbox padded
 *    by (64 + 3·S)/z) so uncooked strokes are never missed by queries;
 *  - the occupancy grid (crowding c / side crowding CS for new strokes);
 *  - an LRU cache of `Cooked` keyed by id:geomRev, capped in bytes per device
 *    class (phone 48 MB, tablet 96 MB, desktop 192 MB; re-cooking is always safe).
 *
 * Cache entries also remember the recipe they were cooked from and are matched by
 * geometry inputs, not just geomRev, so two different restyles that happen to reach
 * the same geomRev (A→B, undo, A→C) can never share geometry. Older revisions and
 * removed strokes stay cached until the LRU drops them: the renderer can un-grow a
 * removed stroke (cooked(id) still answers for it), and undo/redo of a restyle or an
 * erase needs no re-cook.
 *
 * Cooking goes through the injected CookFn via the time-sliced kitchen; the scene
 * never imports ink/cook.ts. Pure: no DOM, no clock.
 */
import type {
  AABB, Cooked, CookFn, Doc, DocChange, Scene, Spine, StrokeId, StrokeRecipe, Vec2,
} from '../core/types';
import { JobPrio } from '../sched/jobs';
import type { Jobs } from '../sched/jobs';
import { RTree } from './rtree';
import { createOccupancy } from './occupancy';
import type { OccupancyGrid } from './occupancy';
import { CookCancelled, createKitchen, sameGeometry } from './kitchen';
import type { KitchenImpl } from './kitchen';
import {
  boxDistance, conservativeBox, createTrack, hitPoly, liftTime, polysHitSegment, trackDistance,
  trackHitsPoint, trackHitsSegment, trackInside, trackOf, validBox,
} from './query';

/** Cooked-cache caps by device class (DESIGN §6.8, §9 memory). */
export const COOKED_CAP_BYTES: Readonly<Record<'phone' | 'tablet' | 'desktop', number>> = {
  phone: 48 * 1024 * 1024,
  tablet: 96 * 1024 * 1024,
  desktop: 192 * 1024 * 1024,
};

/** Default minimum effective alpha for hit tests (DESIGN §3.4). */
export const HIT_MIN_ALPHA = 0.3;
/** Lineage (DESIGN §2.4.2): proximity floor, recency window and recency radius. */
export const LINEAGE_NEAR_SP = 6;
export const LINEAGE_RECENT_MS = 3000;
export const LINEAGE_RECENT_SP = 48;
/**
 * Clock-skew tolerance for recency: a lift time up to this far in the future still
 * counts (covers a draft that stamps `created` at lift instead of pen-down), while a
 * caller on the wrong clock (performance.now vs Date.now) never matches.
 */
const LINEAGE_FUTURE_MS = 60000;
/** Half-size (sp) of the square around the view centre whose occupancy is pre-built. */
const WARM_HALF_SP = 1024;
/** Distinguishes the warm-job keys of scenes sharing one job queue. */
let sceneSerial = 0;
/** put() calls waiting for their stroke to be added. */
const MAX_PENDING_PUTS = 16;

export interface SceneDeps {
  doc: Doc;
  cook: CookFn;
  jobs: Jobs;
  requestFrame(): void;
  /** ink-forms' cached spine of a committed recipe (hit/lasso/lineage); raw samples otherwise. */
  spineOf?: (r: StrokeRecipe) => Spine;
  /** Cooked LRU cap in bytes; pass COOKED_CAP_BYTES[deviceClass()] (default: desktop). */
  cacheBytes?: number;
}

/** A hit with the poly it landed on (Alt-click sampling). */
export interface ScenePick { id: StrokeId; poly: number }

/** The scene plus the extras integration and tests use. */
export interface SceneImpl extends Scene {
  dispose(): void;
  /** Geometry of this exact recipe revision (e.g. the `before` side of a restyle), if cached. */
  cookedFor(r: StrokeRecipe): Cooked | undefined;
  /** Register geometry for an explicit recipe (safer than put(id) when the doc is mid-update). */
  putFor(r: StrokeRecipe, c: Cooked): void;
  /** Topmost stroke hit plus the nearest qualifying cooked poly (-1 if the stroke is uncooked). */
  pick(p: Vec2, rDoc: number, minAlpha?: number): ScenePick | null;
  /**
   * The box the stroke is indexed under, absolute doc: inkBox ∪ hitBox once cooked,
   * the conservative box before. Null for unknown ids and for corrupt recipes that
   * cannot be placed (non-finite coordinates).
   */
  boxOf(id: StrokeId): AABB | null;
  /** True once the indexed box comes from the cooked geometry of the current revision. */
  isExact(id: StrokeId): boolean;
  setCacheBytes(bytes: number): void;
  /**
   * Count extra bytes derived from a cached Cooked (render's decimated LODs, DESIGN §6.8:
   * "evicted with the Cooked entry; counted in its bytes") against its LRU entry.
   * No-op if `c` is not (or no longer) cached. Re-registering geometry resets the charge.
   */
  charge(c: Cooked, bytes: number): void;
  readonly cachedBytes: number;
  readonly cacheCap: number;
  readonly cachedEntries: number;
  readonly occupancy: OccupancyGrid;
  readonly kitchen: KitchenImpl;
}

interface Rec {
  r: StrokeRecipe;
  box: AABB;
  exact: boolean;          // box is the cooked inkBox ∪ hitBox of r's geometry
  hit: AABB | null;        // cooked hitBox of r's geometry (absolute)
  failed: StrokeRecipe | null; // geometry whose cook threw (not retried)
}

interface Entry {
  id: StrokeId;
  rev: number;
  src: StrokeRecipe;
  c: Cooked;
  bytes: number;
  pts: number;
  prev: Entry | null; next: Entry | null;   // LRU list: head = least recently used
  older: Entry | null; newer: Entry | null; // per-id revision chain: heads map holds the newest
}

/** True when two recipes cook to the same geometry (defined next to the kitchen, which needs it too). */
export { sameGeometry };

function bytesOf(c: Cooked): number {
  if (c.bytes > 0 && Number.isFinite(c.bytes)) return c.bytes;
  let b = c.pts.byteLength + c.start.byteLength + c.count.byteLength + c.kind.byteLength + c.gen.byteLength +
    c.tone.byteLength + c.alpha.byteLength + c.born.byteLength + c.unit.byteLength + c.box.byteLength +
    c.genStart.byteLength;
  if (c.ang) b += c.ang.byteLength;
  return b;
}

const copyBox = (b: AABB): AABB => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });

/** Create the scene for `deps.doc` and index every stroke already in it. */
export function createScene(deps: SceneDeps): SceneImpl {
  const { doc } = deps;
  const recs = new Map<StrokeId, Rec>();
  const tree = new RTree<StrokeId>();
  const occ = createOccupancy();
  const pendingPuts = new Map<StrokeId, Cooked>();

  // ---------------------------------------------------------------- cooked LRU
  const heads = new Map<StrokeId, Entry>();
  const byCooked = new WeakMap<Cooked, Entry>();
  let lruHead: Entry | null = null, lruTail: Entry | null = null;
  let bytes = 0, points = 0, entries = 0;
  let cap = deps.cacheBytes !== undefined && deps.cacheBytes >= 0 ? deps.cacheBytes : COOKED_CAP_BYTES.desktop;

  function lruUnlink(e: Entry): void {
    if (e.prev) e.prev.next = e.next; else lruHead = e.next;
    if (e.next) e.next.prev = e.prev; else lruTail = e.prev;
    e.prev = e.next = null;
  }
  function lruAppend(e: Entry): void {
    e.prev = lruTail; e.next = null;
    if (lruTail) lruTail.next = e; else lruHead = e;
    lruTail = e;
  }
  function touch(e: Entry): void {
    if (lruTail === e) return;
    lruUnlink(e);
    lruAppend(e);
  }
  function chainUnlink(e: Entry): void {
    if (e.newer) e.newer.older = e.older;
    else if (e.older) heads.set(e.id, e.older);
    else heads.delete(e.id);
    if (e.older) e.older.newer = e.newer;
    e.older = e.newer = null;
  }
  function chainPushHead(e: Entry): void {
    const h = heads.get(e.id);
    e.newer = null;
    e.older = h ?? null;
    if (h) h.newer = e;
    heads.set(e.id, e);
  }
  function dropEntry(e: Entry): void {
    lruUnlink(e);
    chainUnlink(e);
    byCooked.delete(e.c);
    bytes -= e.bytes; points -= e.pts; entries--;
  }
  function evict(keep: Entry | null): void {
    while (bytes > cap && lruHead && lruHead !== keep) dropEntry(lruHead);
    // `keep` may sit at the head only when it is the last entry standing
  }
  /** Cached entry holding r's geometry, if any. */
  function findFor(r: StrokeRecipe): Entry | null {
    for (let e = heads.get(r.id) ?? null; e; e = e.older) {
      if (e.rev !== r.geomRev) continue;
      if (e.src === r) return e;
      if (sameGeometry(e.src, r)) { e.src = r; return e; }
    }
    return null;
  }
  function store(r: StrokeRecipe, c: Cooked): Entry {
    let e = findFor(r);
    const b = bytesOf(c);
    if (e) {
      bytes += b - e.bytes; points += c.nPts - e.pts;
      byCooked.delete(e.c);
      e.c = c; e.bytes = b; e.pts = c.nPts; e.src = r;
      byCooked.set(c, e);
      chainUnlink(e);
      chainPushHead(e);
      touch(e);
    } else {
      e = { id: r.id, rev: r.geomRev, src: r, c, bytes: b, pts: c.nPts, prev: null, next: null, older: null, newer: null };
      chainPushHead(e);
      lruAppend(e);
      byCooked.set(c, e);
      bytes += b; points += c.nPts; entries++;
    }
    evict(e);
    return e;
  }

  // ---------------------------------------------------------------- records + index
  const scratchBox: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };

  function adoptBox(rec: Rec, c: Cooked | null): void {
    if (c && validBox(c.inkBox)) {
      const b = copyBox(c.inkBox);
      rec.hit = validBox(c.hitBox) ? copyBox(c.hitBox) : null;
      // hitBox also covers the untapered spine capsule, which can reach past the
      // tapered ink at the ends: index the union so hit/sweep/lineage never miss it
      if (rec.hit) {
        if (rec.hit.x0 < b.x0) b.x0 = rec.hit.x0;
        if (rec.hit.y0 < b.y0) b.y0 = rec.hit.y0;
        if (rec.hit.x1 > b.x1) b.x1 = rec.hit.x1;
        if (rec.hit.y1 > b.y1) b.y1 = rec.hit.y1;
      }
      rec.box = b;
      rec.exact = true;
    } else {
      rec.box = conservativeBox(rec.r, { x0: 0, y0: 0, x1: 0, y1: 0 });
      rec.exact = false;
      rec.hit = null;
    }
    // a corrupt recipe (non-finite origin or samples, no cook) has no place in space
    if (validBox(rec.box)) tree.insert(rec.box, rec.r.id);
    else tree.remove(rec.r.id);
  }

  function addRec(r: StrokeRecipe): void {
    const rec: Rec = { r, box: scratchBox, exact: false, hit: null, failed: null };
    recs.set(r.id, rec);
    const put = pendingPuts.get(r.id);
    if (put) pendingPuts.delete(r.id);
    const e = put ? store(r, put) : findFor(r);
    adoptBox(rec, e ? e.c : null);
    occ.add(r);
    zDirty = true;
  }

  function removeRec(rec: Rec): void {
    const id = rec.r.id;
    occ.remove(rec.r);
    tree.remove(id);
    kitchen.cancel(id);
    recs.delete(id);
    // keep the removed revision first in its chain so cooked(id) can still un-grow it
    const e = findFor(rec.r);
    if (e && heads.get(id) !== e) { chainUnlink(e); chainPushHead(e); }
    zDirty = true;
  }

  function regeometry(rec: Rec, r: StrokeRecipe): void {
    const old = rec.r;
    rec.r = r;
    rec.failed = null;
    occ.replace(old, r);
    const q = kitchen.queued(r.id);
    if (q && (q.geomRev !== r.geomRev || !sameGeometry(q, r))) kitchen.cancel(r.id);
    const e = findFor(r);
    adoptBox(rec, e ? e.c : null);
    zDirty = true;
  }

  function reconcile(id: StrokeId): void {
    const r = doc.get(id);
    const rec = recs.get(id);
    if (!r) { if (rec) removeRec(rec); return; }
    if (!rec) { addRec(r); return; }
    if (rec.r === r) return;
    if (r.geomRev !== rec.r.geomRev || !sameGeometry(rec.r, r)) regeometry(rec, r);
    else { occ.replace(rec.r, r); rec.r = r; }
  }

  function onChange(ch: DocChange): void {
    for (const id of ch.removed) reconcile(id);
    for (const id of ch.added) reconcile(id);
    for (const id of ch.geometry) reconcile(id);
    for (const id of ch.color) reconcile(id);
    if (ch.view || ch.added.length) warmCamera();
  }

  /**
   * Pre-build the occupancy blocks new strokes will read (the camera's zoom, around
   * the view centre) in a background job, so crowding at pen-down is a plain lookup.
   * Queries build missing blocks on demand anyway; this only moves the cost off the
   * first sample of a stroke.
   */
  const warmKey = 'occ:warm:' + sceneSerial++;
  function warmCamera(): void {
    const cam = doc.meta.camera;
    const z = cam?.scale;
    if (!(z > 0) || occ.strokes === 0) return;
    if (occ.isBuilt(cam.cx, cam.cy, z) && !deps.jobs.has(warmKey)) return;
    deps.jobs.add(JobPrio.Cook, occ.warm(cam.cx, cam.cy, WARM_HALF_SP, z), warmKey);
    deps.requestFrame();
  }

  function landed(r: StrokeRecipe, c: Cooked): void {
    const rec = recs.get(r.id);
    if (!rec || (rec.r !== r && (rec.r.geomRev !== r.geomRev || !sameGeometry(rec.r, r)))) return;
    store(rec.r, c);
    adoptBox(rec, c);
    deps.requestFrame();
  }

  const kitchen = createKitchen({ cook: deps.cook, jobs: deps.jobs, requestFrame: () => deps.requestFrame(), onCooked: landed });

  // ---------------------------------------------------------------- query helpers
  const track = createTrack();
  const cand: StrokeId[] = [];
  const probe: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let zMin = 1, zDirty = true;

  function spineFor(r: StrokeRecipe): Readonly<Spine> | null {
    if (!deps.spineOf) return null;
    try { return deps.spineOf(r); } catch { return null; }
  }
  function trackFor(rec: Rec) { return trackOf(rec.r, spineFor(rec.r), track); }

  function currentCooked(rec: Rec): Cooked | null {
    const e = findFor(rec.r);
    if (!e) return null;
    touch(e);
    return e.c;
  }

  function candidates(x0: number, y0: number, x1: number, y1: number): StrokeId[] {
    probe.x0 = x0; probe.y0 = y0; probe.x1 = x1; probe.y1 = y1;
    cand.length = 0;
    tree.search(probe, cand);
    cand.sort();
    return cand;
  }

  function hitsPoint(rec: Rec, px: number, py: number, r: number, minAlpha: number): boolean {
    if (trackHitsPoint(trackFor(rec), px, py, r)) return true;
    const c = currentCooked(rec);
    if (!c) return false;
    const hb = minAlpha >= HIT_MIN_ALPHA ? rec.hit : rec.box;
    if (hb && (px < hb.x0 - r || px > hb.x1 + r || py < hb.y0 - r || py > hb.y1 + r)) return false;
    return hitPoly(c, rec.r.origin[0], rec.r.origin[1], px, py, r, minAlpha, true) >= 0;
  }

  function topmost(p: Vec2, rDoc: number, minAlpha: number): Rec | null {
    const px = p[0], py = p[1], r = rDoc > 0 ? rDoc : 0;
    if (!(px === px && py === py)) return null;
    const ids = candidates(px - r, py - r, px + r, py + r);
    for (let i = ids.length - 1; i >= 0; i--) {
      const rec = recs.get(ids[i]);
      if (rec && hitsPoint(rec, px, py, r, minAlpha)) return rec;
    }
    return null;
  }

  function minZ(): number {
    if (zDirty) {
      zMin = Infinity;
      for (const rec of recs.values()) if (rec.r.z > 0 && rec.r.z < zMin) zMin = rec.r.z;
      if (zMin === Infinity) zMin = 1;
      zDirty = false;
    }
    return zMin;
  }

  // ---------------------------------------------------------------- the Scene
  const scene: SceneImpl = {
    cooked(id) {
      const rec = recs.get(id);
      if (rec) return currentCooked(rec) ?? undefined;
      const h = heads.get(id);
      if (!h) return undefined;
      touch(h);
      return h.c;
    },

    cookedFor(r) {
      const e = findFor(r);
      if (!e) return undefined;
      touch(e);
      return e.c;
    },

    put(id, c) {
      const rec = recs.get(id);
      if (!rec) {
        pendingPuts.delete(id);
        pendingPuts.set(id, c);
        if (pendingPuts.size > MAX_PENDING_PUTS) pendingPuts.delete(pendingPuts.keys().next().value!);
        return;
      }
      scene.putFor(rec.r, c);
    },

    putFor(r, c) {
      // a recipe not (yet) in the doc is simply cached: addRec finds it by geometry
      store(r, c);
      const rec = recs.get(r.id);
      if (rec && (rec.r === r || (rec.r.geomRev === r.geomRev && sameGeometry(rec.r, r)))) {
        const q = kitchen.queued(r.id);
        if (q && q.geomRev === r.geomRev && sameGeometry(q, r)) kitchen.cancel(r.id);
        rec.failed = null;
        adoptBox(rec, c);
      }
    },

    ensure(ids, prio) {
      let waits: Promise<unknown>[] | null = null;
      for (const id of ids) {
        const rec = recs.get(id);
        if (!rec) continue;
        if (findFor(rec.r)) continue;
        if (rec.failed && (rec.failed === rec.r || sameGeometry(rec.failed, rec.r))) continue;
        const r = rec.r;
        const w = kitchen.cook(r, prio).then(undefined, (err: unknown) => {
          if (err instanceof CookCancelled) return;
          const cur = recs.get(r.id);
          if (cur && (cur.r === r || sameGeometry(cur.r, r))) cur.failed = r;
        });
        (waits ??= []).push(w);
      }
      return waits ? Promise.all(waits).then(() => undefined) : Promise.resolve();
    },

    query(box, out) {
      out.length = 0;
      if (!validBoxLoose(box)) return out;
      tree.search(box, out);
      out.sort();
      return out;
    },

    hit(p, rDoc, minAlpha = HIT_MIN_ALPHA) {
      return topmost(p, rDoc, minAlpha)?.r.id ?? null;
    },

    pick(p, rDoc, minAlpha = HIT_MIN_ALPHA) {
      const rec = topmost(p, rDoc, minAlpha);
      if (!rec) return null;
      const c = currentCooked(rec);
      const poly = c ? hitPoly(c, rec.r.origin[0], rec.r.origin[1], p[0], p[1], rDoc > 0 ? rDoc : 0, minAlpha) : -1;
      return { id: rec.r.id, poly };
    },

    sweep(a, b, rDoc, out) {
      const r = rDoc > 0 ? rDoc : 0;
      const ax = a[0], ay = a[1], bx = b[0], by = b[1];
      if (!(ax === ax && ay === ay && bx === bx && by === by)) return;
      const ids = candidates(Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (out.has(id)) continue;
        const rec = recs.get(id);
        if (!rec) continue;
        if (trackHitsSegment(trackFor(rec), ax, ay, bx, by, r)) { out.add(id); continue; }
        const c = currentCooked(rec);
        if (!c) continue;
        const hb = rec.hit;
        if (hb && (Math.max(ax, bx) < hb.x0 - r || Math.min(ax, bx) > hb.x1 + r ||
          Math.max(ay, by) < hb.y0 - r || Math.min(ay, by) > hb.y1 + r)) continue;
        if (polysHitSegment(c, rec.r.origin[0], rec.r.origin[1], ax, ay, bx, by, r, HIT_MIN_ALPHA)) out.add(id);
      }
    },

    lasso(poly) {
      const res: StrokeId[] = [];
      const m = poly.length >> 1;
      if (m < 3) return res;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < m; i++) {
        const x = poly[2 * i], y = poly[2 * i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (!(x0 <= x1 && y0 <= y1)) return res;
      const ids = candidates(x0, y0, x1, y1);
      for (let i = 0; i < ids.length; i++) {
        const rec = recs.get(ids[i]);
        if (rec && trackInside(trackFor(rec), poly, true) >= 0.5) res.push(ids[i]);
      }
      return res;
    },

    crowding: (x, y, z) => occ.crowding(x, y, z),
    sideCrowding: (x, y, nx, ny, z) => occ.side(x, y, nx, ny, z),

    lineage(x, y, ink, wDoc, now) {
      if (!(x === x && y === y) || recs.size === 0) return null;
      const w3 = wDoc > 0 ? 3 * wDoc : 0;
      // 1. proximity: the nearest same-ink spine within max(6 sp, 3w)
      const reach = Math.max(LINEAGE_NEAR_SP / minZ(), w3);
      const ids = candidates(x - reach, y - reach, x + reach, y + reach);
      let best: StrokeId | null = null, bestD = Infinity;
      for (let i = ids.length - 1; i >= 0; i--) {
        const rec = recs.get(ids[i]);
        if (!rec || rec.r.color.ink !== ink) continue;
        const lim = Math.max(LINEAGE_NEAR_SP / (rec.r.z > 0 ? rec.r.z : 1), w3);
        if (boxDistance(rec.box, x, y) > lim) continue;
        const d = trackDistance(trackFor(rec), x, y);
        if (d <= lim && d < bestD) { best = rec.r.id; bestD = d; }
      }
      if (best !== null) return best;
      // 2. recency: the last same-ink stroke, lifted < 3 s ago, spine within 48 sp
      let last: Rec | null = null, lastT = -Infinity;
      for (const rec of recs.values()) {
        if (rec.r.color.ink !== ink) continue;
        const t = liftTime(rec.r);
        if (t > lastT || (t === lastT && last !== null && rec.r.id > last.r.id)) { lastT = t; last = rec; }
      }
      if (!last) return null;
      const age = now - lastT;
      if (!(age < LINEAGE_RECENT_MS && age > -LINEAGE_FUTURE_MS)) return null;
      const lim = LINEAGE_RECENT_SP / (last.r.z > 0 ? last.r.z : 1);
      if (boxDistance(last.box, x, y) > lim) return null;
      return trackDistance(trackFor(last), x, y) <= lim ? last.r.id : null;
    },

    contentBox: () => tree.bounds(),

    get cachedPoints() { return points; },

    boxOf(id) {
      const rec = recs.get(id);
      return rec && tree.has(id) ? copyBox(rec.box) : null;
    },
    isExact: id => recs.get(id)?.exact ?? false,
    charge(c, extra) {
      const e = byCooked.get(c);
      if (!e || !(extra > 0)) return;
      e.bytes += extra;
      bytes += extra;
      evict(null);
    },
    setCacheBytes(b) {
      cap = b >= 0 ? b : 0;
      evict(null);
    },
    get cachedBytes() { return bytes; },
    get cacheCap() { return cap; },
    get cachedEntries() { return entries; },
    occupancy: occ,
    kitchen,

    dispose() {
      unsubscribe();
      kitchen.cancelAll();
      deps.jobs.cancel(warmKey);
      recs.clear();
      tree.clear();
      occ.clear();
      pendingPuts.clear();
      heads.clear();
      lruHead = lruTail = null;
      bytes = points = entries = 0;
    },
  };

  for (const r of doc.ordered()) addRec(r);
  const unsubscribe = doc.subscribe(onChange);
  warmCamera();
  return scene;
}

/** Finite, non-inverted box (search boxes may be degenerate points). */
const validBoxLoose = (b: AABB): boolean => b.x0 <= b.x1 && b.y0 <= b.y1;


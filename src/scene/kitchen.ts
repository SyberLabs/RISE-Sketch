/**
 * The kitchen: an asynchronous, time-sliced cook queue on top of `Jobs`
 * (DESIGN §7.1 scene/kitchen.ts, §8 load sequence, §9 job priority).
 *
 * Each requested recipe becomes one job keyed `cook:<id>`; its single step runs the
 * injected CookFn (ink/cook.ts is never imported here). Slicing is therefore per
 * stroke: the frame's job budget stops between cooks, never inside one, since a
 * CookFn is synchronous. Priorities map onto the scheduler's:
 *
 *   handoff → JobPrio.Handoff, visible → JobPrio.Visible,
 *   prefetch → JobPrio.Prefetch, background → JobPrio.Cook
 *
 * Asking again for a queued recipe (or one with identical geometry inputs, e.g. its
 * colour-only twin) returns the same promise and raises its priority if the new one
 * is higher. Asking for different geometry under the same id, even at the same
 * geomRev (A→B, undo, A→C), or calling cancel, rejects the old promise with
 * `CookCancelled`.
 */
import type { Cooked, CookFn, Kitchen, Priority, StrokeId, StrokeRecipe } from '../core/types';
import { JobPrio } from '../sched/jobs';
import type { Jobs } from '../sched/jobs';
import { sameBits } from './occupancy';

function sameCalib(a: StrokeRecipe['calib'], b: StrokeRecipe['calib']): boolean {
  return a === b || (a.lo === b.lo && a.hi === b.hi && a.gamma === b.gamma && a.flat === b.flat &&
    a.vMed === b.vMed && a.jitter === b.jitter && a.fcMin === b.fcMin);
}

function sameF64(a: Float64Array | null, b: Float64Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * True when two recipes cook to the same geometry: every geometry input matches
 * (colour, ids, revs and `created` are ignored). Arrays shared by reference (the
 * restyle pattern) compare in O(1); otherwise they compare bit for bit.
 */
export function sameGeometry(a: StrokeRecipe, b: StrokeRecipe): boolean {
  if (a === b) return true;
  return a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1] && a.z === b.z && a.rot === b.rot &&
    a.seed === b.seed && a.device === b.device && a.closed === b.closed && a.radial === b.radial &&
    a.s0 === b.s0 && a.cut === b.cut &&
    a.stroke.nib === b.stroke.nib && a.stroke.size === b.stroke.size &&
    a.form.form === b.form.form && a.form.v === b.form.v && a.form.base === b.form.base &&
    sameCalib(a.calib, b.calib) &&
    (a.sym === b.sym || (!!a.sym && !!b.sym && a.sym.axis === b.sym.axis && a.sym.at === b.sym.at)) &&
    sameF64(a.xf, b.xf) && sameBits(a.resume, b.resume) && sameBits(a.pools, b.pools) &&
    sameBits(a.samples, b.samples);
}

/** Rejection reason for cooks dropped by `cancel` or superseded by a newer revision. */
export class CookCancelled extends Error {
  constructor(readonly id: StrokeId) {
    super(`cook cancelled: ${id}`);
    this.name = 'CookCancelled';
  }
}

/** Scheduler priority for a scene priority. */
export function jobPrio(p: Priority): JobPrio {
  switch (p) {
    case 'handoff': return JobPrio.Handoff;
    case 'visible': return JobPrio.Visible;
    case 'prefetch': return JobPrio.Prefetch;
    default: return JobPrio.Cook;
  }
}

export interface KitchenDeps {
  cook: CookFn;
  jobs: Jobs;
  /** Ask the frame loop for a rAF (the jobs run inside frames). */
  requestFrame(): void;
  /** Called synchronously inside the job step, before the promise resolves. */
  onCooked?(r: StrokeRecipe, c: Cooked): void;
}

export interface KitchenImpl extends Kitchen {
  /** True while a cook for this stroke is queued. */
  has(id: StrokeId): boolean;
  /** Queued recipe for this stroke, if any. */
  queued(id: StrokeId): StrokeRecipe | undefined;
  readonly pending: number;
  /** Cancel everything (rejects every pending promise). */
  cancelAll(): void;
}

interface Order {
  r: StrokeRecipe;
  prio: JobPrio;
  promise: Promise<Cooked>;
  resolve(c: Cooked): void;
  reject(e: unknown): void;
}

const keyOf = (id: StrokeId): string => 'cook:' + id;
const noop = (): void => {};

/** Create a kitchen that cooks through `deps.jobs`. */
export function createKitchen(deps: KitchenDeps): KitchenImpl {
  const orders = new Map<StrokeId, Order>();

  function schedule(o: Order): void {
    const id = o.r.id;
    deps.jobs.add(o.prio, () => {
      if (orders.get(id) !== o) return false;
      orders.delete(id);
      let c: Cooked;
      try {
        c = deps.cook(o.r);
      } catch (err) {
        o.reject(err);
        return false;
      }
      try { deps.onCooked?.(o.r, c); } finally { o.resolve(c); }
      return false;
    }, keyOf(id));
    deps.requestFrame();
  }

  function drop(id: StrokeId): void {
    const o = orders.get(id);
    if (!o) return;
    orders.delete(id);
    deps.jobs.cancel(keyOf(id));
    o.reject(new CookCancelled(id));
  }

  return {
    cook(r, prio) {
      const p = jobPrio(prio);
      const old = orders.get(r.id);
      if (old) {
        if (old.r === r || (old.r.geomRev === r.geomRev && sameGeometry(old.r, r))) {
          if (p < old.prio) { old.prio = p; schedule(old); }
          return old.promise;
        }
        drop(r.id);
      }
      let resolve!: (c: Cooked) => void, reject!: (e: unknown) => void;
      const promise = new Promise<Cooked>((res, rej) => { resolve = res; reject = rej; });
      // a cancelled cook nobody awaited is not an error; callers that chain still see the rejection
      promise.catch(noop);
      const o: Order = { r, prio: p, promise, resolve, reject };
      orders.set(r.id, o);
      schedule(o);
      return promise;
    },
    cancel: drop,
    has: id => orders.has(id),
    queued: id => orders.get(id)?.r,
    get pending() { return orders.size; },
    cancelAll() { for (const id of [...orders.keys()]) drop(id); },
  };
}

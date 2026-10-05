/**
 * Drives a live stroke through the fake cook and the live layer on a manual clock (tests).
 */
import type { Ground } from '../src/core/types';
import { createLiveLayer, type LiveLayerExtras } from '../src/render/live';
import type { LiveLayerInternal } from '../src/render/types';
import { FakeCook, addSample, freeze, makeDraft, wavePath, type FakeDraft, type FakeOpts } from './render-live.fakecook';
import { FakeHost } from './render-live.helpers';

export interface Env {
  host: FakeHost;
  live: LiveLayerInternal & LiveLayerExtras;
  d: FakeDraft;
  cook: FakeCook;
  tDown: number;
}

export function setup(o: FakeOpts & { rm?: boolean; ground?: Ground } = {}): Env {
  const host = new FakeHost();
  host.rm = !!o.rm;
  if (o.ground) host.g = o.ground;
  const live = createLiveLayer(host);
  const d = makeDraft(o);
  const cook = new FakeCook(d, o);
  return { host, live, d, cook, tDown: host.t };
}

/** Run one frame `dt` ms later; returns frame()'s result. */
export function tick(e: Env, dt = 16): boolean {
  e.host.t += dt;
  return e.live.frame(e.host.t);
}

/**
 * Begin a stroke and draw `path` (doc units), `perFrame` samples per 16 ms frame. Pressure
 * follows a gentle hump. Leaves the stroke active (no commit).
 */
export function drawPath(e: Env, path: readonly (readonly [number, number])[], perFrame = 2): void {
  e.tDown = e.host.t;
  e.live.begin(e.d, e.cook);
  let k = 0;
  while (k < path.length) {
    const n = Math.min(perFrame, path.length - k);
    for (let q = 0; q < n; q++, k++) {
      const p = 0.35 + 0.5 * Math.sin((k / path.length) * Math.PI);
      addSample(e.d, path[k][0], path[k][1], e.host.t - e.tDown + q * (16 / perFrame), p);
    }
    e.cook.append(n);
    e.live.update();
    tick(e);
  }
}

/** Run frames until frame() returns false (or the limit); returns the number of frames run. */
export function settle(e: Env, limit = 400, dt = 16): number {
  for (let i = 0; i < limit; i++) if (!tick(e, dt)) return i + 1;
  return limit;
}

/** Commit the drawn stroke (finish + live.commit). */
export function commit(e: Env, id = 'stroke-1'): { r: ReturnType<typeof freeze>; c: ReturnType<FakeCook['finish']> } {
  const r = freeze(e.d, id);
  const c = e.cook.finish(r);
  e.live.commit(r, c);
  return { r, c };
}

export const PATH = wavePath(120, 300, 520, 70, 220);

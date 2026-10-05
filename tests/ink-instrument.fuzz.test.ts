/**
 * Randomised gestures through the whole instrument: every device, zooms 0.25–8,
 * holds, arcs, tremor, near-teleports, closed and open, fed in random chunks.
 * Invariants: finite fields, strictly increasing arc and time, station spacing,
 * unit normals, p in [0, 1], positive widths, a bounded envelope, and
 * incremental ≡ full bit for bit.
 */
import { describe, it, expect } from 'vitest';
import type { Device, Spine, StrokeRecipe } from '../src/core/types';
import { buildSpine, createSpineBuilder } from '../src/ink/spine';
import { finalEnvelope, liveEnvelope, closureTest } from '../src/ink/envelope';
import { Hand, recipe, draftOf, mulberry32 } from './ink-instrument.fixtures';

const FIELDS = ['x', 'y', 's', 't', 'p', 'w', 'vn', 'k', 'c', 'cs', 'alt', 'az', 'nx', 'ny', 'corner'] as const;

function randomStroke(seed: number): StrokeRecipe {
  const rand = mulberry32(seed);
  const devs: Device[] = ['pen', 'mouse', 'touch'];
  const dev = devs[Math.floor(rand() * 3)];
  const hz = [60, 120, 125, 240, 480][Math.floor(rand() * 5)];
  const h = new Hand(rand() * 200, rand() * 200, { hz, jitter: rand() < 0.3 ? 0 : rand() * 1.2, seed, p: rand() });
  const segs = 1 + Math.floor(rand() * 12);
  for (let k = 0; k < segs; k++) {
    const m = rand();
    if (m < 0.45) h.moveTo(h.x + (rand() - 0.5) * 200, h.y + (rand() - 0.5) * 200, 0.02 + rand() * rand() * 4, rand());
    else if (m < 0.6) h.hold(rand() * 400, rand());
    else if (m < 0.8) {
      const r = 3 + rand() * 80, a0 = rand() * 6;
      h.arc(h.x - r * Math.cos(a0), h.y - r * Math.sin(a0), r, a0, a0 + (rand() - 0.5) * 12, 0.05 + rand() * 3);
    } else if (m < 0.9) h.moveTo(h.x + (rand() - 0.5) * 3, h.y + (rand() - 0.5) * 3, 0.01 + rand() * 0.2);
    else h.moveTo(h.x + (rand() - 0.5) * 600, h.y + (rand() - 0.5) * 600, 5 + rand() * 40);
  }
  const z = [0.25, 1, 1, 2.5, 8][Math.floor(rand() * 5)];
  return recipe(h.rows(z, dev !== 'pen' || rand() < 0.2), {
    device: dev, z, nib: (['pen', 'brush', 'chisel'] as const)[Math.floor(rand() * 3)], closed: rand() < 0.2,
  });
}

function invariants(sp: Spine): string | null {
  for (let i = 0; i < sp.n; i++) {
    for (const f of FIELDS) if (!Number.isFinite(sp[f][i])) return `station ${i}: ${f} = ${sp[f][i]}`;
    if (i > 0) {
      const ds = sp.s[i] - sp.s[i - 1];
      if (!(ds > 0) || ds > 3.6 + 1e-3) return `station ${i}: ds = ${ds}`;
      if (!(sp.t[i] >= sp.t[i - 1])) return `station ${i}: t went back`;
    }
    if (Math.abs(Math.hypot(sp.nx[i], sp.ny[i]) - 1) > 1e-4) return `station ${i}: |n| != 1`;
    if (!(sp.p[i] >= 0 && sp.p[i] <= 1)) return `station ${i}: p = ${sp.p[i]}`;
    if (!(sp.w[i] > 0)) return `station ${i}: w = ${sp.w[i]}`;
  }
  return null;
}

describe('fuzz: random gestures', () => {
  it('keep every spine invariant, a bounded envelope, and incremental ≡ full bit for bit', () => {
    for (let seed = 1; seed <= 160; seed++) {
      const r = randomStroke(seed);
      const full = buildSpine(r);
      const bad = invariants(full);
      if (bad) throw new Error(`seed ${seed} (full): ${bad}`);
      const env = finalEnvelope(r, full);
      for (let i = 0; i < full.n; i++) {
        const e = env.at(full.s[i]);
        if (!(e >= 0 && e <= 1.12 + 1e-9)) throw new Error(`seed ${seed}: E = ${e}`);
      }
      const rand = mulberry32(seed * 7);
      const { d, total, feed } = draftOf(r);
      const b = createSpineBuilder(d);
      let fed = 0, closing = false;
      while (fed < total) {
        fed = feed(1 + Math.floor(rand() * 30));
        b.append();
        const sp = b.spine;
        const lb = invariants(sp);
        if (lb) throw new Error(`seed ${seed} (live, row ${fed}): ${lb}`);
        closing = closureTest(sp, closing);
        const le = liveEnvelope(d, sp);
        expect(Number.isFinite(le.at(sp.L))).toBe(true);
        const tip = b.tip(fed * 5);
        if (!Number.isFinite(tip.p) || !Number.isFinite(tip.s) || !Number.isFinite(tip.travel)) throw new Error(`seed ${seed}: tip`);
      }
      b.finish(r.closed);
      const sp = b.spine;
      expect(sp.n).toBe(full.n);
      for (let i = 0; i < full.n; i++) {
        for (const f of FIELDS) if (!Object.is(full[f][i], sp[f][i])) throw new Error(`seed ${seed}: station ${i} ${f} incremental != full`);
      }
    }
  });
});

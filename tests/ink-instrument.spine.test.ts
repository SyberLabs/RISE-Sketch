import { describe, it, expect } from 'vitest';
import type { Spine, StrokeRecipe } from '../src/core/types';
import { S } from '../src/core/types';
import {
  createSpineBuilder, buildSpine, createSpine, continuationSamples, STATION, RESUME, type InkSpine,
} from '../src/ink/spine';
import { calibratePressure, DEFAULT_CALIB } from '../src/ink/calib';
import { nibWidth } from '../src/ink/nibs';
import { weldWidth } from '../src/ink/envelope';
import { Hand, recipe, draftOf, scribble, mulberry32 } from './ink-instrument.fixtures';

const FIELDS = ['x', 'y', 's', 't', 'p', 'w', 'vn', 'k', 'c', 'cs', 'alt', 'az', 'nx', 'ny', 'corner'] as const;
type Field = typeof FIELDS[number];

/** First differing field of station i, bitwise, or null. */
function diff(a: Spine, b: Spine, i: number, fields: readonly Field[] = FIELDS): Field | null {
  for (const f of fields) if (!Object.is(a[f][i], b[f][i])) return f;
  return null;
}

function snapshotSettled(sp: Spine): Spine {
  const out = createSpine(Math.max(1, sp.settled));
  for (const f of FIELDS) (out[f] as Float32Array | Uint8Array).set((sp[f] as Float32Array | Uint8Array).subarray(0, sp.settled));
  out.n = out.settled = sp.settled;
  return out;
}

interface Case { name: string; r: StrokeRecipe }
const cases: Case[] = [
  { name: 'pen scribble, brush', r: recipe(scribble(3, 0.25, 240).rows(), { device: 'pen' }) },
  { name: 'mouse scribble, NaN pressure, 125 Hz', r: recipe(scribble(5, 0.3, 125).rows(1, true), { device: 'mouse', nib: 'pen', size: 2.5 }) },
  { name: 'touch scribble, 60 Hz, heavy jitter', r: recipe(scribble(9, 1.0, 60).rows(1, true), { device: 'touch' }) },
  (() => {
    const h = new Hand(0, 0, { jitter: 0.2, seed: 11, alt: 0.6, az: 0.4, p: 0.2, c: 0.3, cs: -0.2 });
    h.hold(500, 0.7).moveTo(80, 40, 0.5).moveTo(81, 41, 0.05).hold(600).moveTo(10, 120, 2.0, 0.1).moveTo(200, 90, 0.7, 0.9);
    return { name: 'pen chisel at z 2.5, bloom + holds + tilt', r: recipe(h.rows(2.5), { device: 'pen', nib: 'chisel', size: 12, z: 2.5 }) };
  })(),
];

describe('spine: incremental ≡ full', () => {
  for (const c of cases) {
    it(`${c.name}: random chunking is bitwise identical, settled is final and monotone`, () => {
      const full = buildSpine(c.r);
      expect(full.n).toBeGreaterThan(20);
      expect(full.settled).toBe(full.n);
      for (let trial = 0; trial < 12; trial++) {
        const rand = mulberry32(1000 + trial);
        const maxChunk = trial === 0 ? 1 : trial === 1 ? 400 : 1 + Math.floor(rand() * 24);
        const { d, total, feed } = draftOf(c.r);
        const b = createSpineBuilder(d);
        let prev = snapshotSettled(b.spine), fed = 0;
        while (fed < total) {
          fed = feed(1 + Math.floor(rand() * maxChunk));
          b.append();
          const sp = b.spine;
          expect(sp.settled).toBeGreaterThanOrEqual(prev.settled);
          expect(sp.settled).toBeLessThanOrEqual(sp.n);
          for (let i = 0; i < prev.settled; i++) {
            const f = diff(prev, sp, i);
            if (f) throw new Error(`settled station ${i} changed (${f}) at row ${fed}`);
          }
          for (let i = prev.settled; i < sp.settled; i++) {
            const f = diff(full, sp, i);
            if (f) throw new Error(`station ${i} settled with ${f} != full build (row ${fed}, chunk ≤ ${maxChunk})`);
          }
          prev = snapshotSettled(sp);
        }
        b.finish();
        const sp = b.spine;
        expect(sp.n).toBe(full.n);
        expect(sp.settled).toBe(sp.n);
        expect(Object.is(sp.L, full.L)).toBe(true);
        for (let i = 0; i < sp.n; i++) {
          const f = diff(full, sp, i);
          if (f) throw new Error(`after finish, station ${i} differs (${f})`);
        }
      }
    });
  }

  it('closed loop: settled stations only change inside the declared lift zones', () => {
    const h = new Hand(100, 0, { jitter: 0.2, seed: 4 });
    h.arc(0, 0, 100, 0, 2 * Math.PI - 0.06, 0.9);
    const r = recipe(h.rows(), { closed: true });
    const full = buildSpine(r) as InkSpine;
    const { d, total, feed } = draftOf(r, true);
    const b = createSpineBuilder(d);
    const rand = mulberry32(77);
    let fed = 0, settledSeen = 0;
    const keep = createSpine(4096);
    while (fed < total) {
      fed = feed(1 + Math.floor(rand() * 9)); b.append();
      const sp = b.spine;
      for (let i = settledSeen; i < sp.settled; i++) for (const f of FIELDS) (keep[f] as Float32Array)[i] = sp[f][i];
      settledSeen = sp.settled;
    }
    b.finish();
    const L = full.L, s0 = full.s[0], W = 50;
    let checked = 0;
    for (let i = 0; i < settledSeen; i++) {
      const s = full.s[i];
      const inZone = s >= L - W - 6 || s <= s0 + 6;
      const f = diff(keep, full, i, inZone ? ['s', 't', 'p', 'w', 'vn', 'c', 'cs', 'alt', 'az', 'corner'] : FIELDS);
      if (f) throw new Error(`station ${i} (s=${s}) changed ${f} outside the lift zones`);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
    for (let i = 0; i < b.spine.n; i++) expect(diff(full, b.spine, i)).toBe(null);
  });
});

describe('spine: geometry', () => {
  it('starts on the first sample, ends exactly on the raw lift point (end flush)', () => {
    const h = new Hand(5, 5, { hz: 240 });
    h.moveTo(205, 5, 2.5); // fast: the filter lags several sp at lift
    const rows = h.rows(), r = recipe(rows);
    const b = createSpineBuilder(draftOf(r).d);
    const dr = draftOf(r);
    const live = createSpineBuilder(dr.d);
    dr.feed(dr.total); live.append();
    const sp = buildSpine(r);
    const n = sp.n, last = (rows.length / S.STRIDE - 1) * S.STRIDE;
    expect(sp.x[0]).toBe(rows[S.X]); expect(sp.y[0]).toBe(rows[S.Y]);
    expect(sp.x[n - 1]).toBe(rows[last + S.X]); expect(sp.y[n - 1]).toBe(rows[last + S.Y]);
    expect(sp.L).toBeGreaterThan(199);
    // the live (pre-lift) spine stops short of the raw tip by the filter lag
    expect(live.spine.L).toBeLessThan(sp.L - 2);
    expect(b.spine.n).toBe(0);
  });

  it('stations sit on the 2.4 sp grid; s strictly increases; t never decreases', () => {
    for (const c of cases) {
      const sp = buildSpine(c.r);
      for (let i = 1; i < sp.n; i++) {
        expect(sp.s[i]).toBeGreaterThan(sp.s[i - 1]);
        expect(sp.t[i]).toBeGreaterThanOrEqual(sp.t[i - 1]);
        expect(sp.s[i] - sp.s[i - 1]).toBeLessThanOrEqual(3.6 + 1e-3);
      }
      for (let i = 0; i < sp.n - 1; i++) if (!sp.corner[i]) expect(sp.s[i]).toBe(Math.fround(i * STATION));
    }
  });

  it('unsettled tail stays short while drawing (≤ 30 sp behind the provisional tip)', () => {
    const h = new Hand(0, 0, { jitter: 0.2, seed: 2 });
    h.moveTo(300, 0, 0.6).arc(300, 60, 60, -Math.PI / 2, Math.PI / 2, 1.8).moveTo(0, 120, 0.3);
    const r = recipe(h.rows());
    const { d, total, feed } = draftOf(r);
    const b = createSpineBuilder(d);
    let worst = 0, fed = 0;
    while (fed < total) {
      fed = feed(4); b.append();
      const sp = b.spine;
      if (sp.L > 60 && sp.settled > 0) worst = Math.max(worst, sp.L - sp.s[sp.settled - 1]);
    }
    expect(worst).toBeGreaterThan(5);
    expect(worst).toBeLessThanOrEqual(30);
  });

  it('keeps a crisp corner where the hand slows and turns; none on a smooth fast curve', () => {
    const h = new Hand(0, 0, { jitter: 0.1, seed: 8 });
    h.moveTo(60, 0, 0.5).moveTo(80, 0, 0.1).hold(120).moveTo(80, 60, 0.1).moveTo(80, 120, 0.5);
    const sp = buildSpine(recipe(h.rows()));
    const corners: number[] = [];
    for (let i = 0; i < sp.n; i++) if (sp.corner[i]) corners.push(i);
    expect(corners.length).toBe(1);
    const i = corners[0];
    expect(Math.hypot(sp.x[i] - 80, sp.y[i] - 0)).toBeLessThan(0.6);
    // the polyline actually turns 90° there (crisp), not a rounded chamfer
    const a1 = Math.atan2(sp.y[i] - sp.y[i - 1], sp.x[i] - sp.x[i - 1]);
    const a2 = Math.atan2(sp.y[i + 1] - sp.y[i], sp.x[i + 1] - sp.x[i]);
    expect(Math.abs(a2 - a1)).toBeGreaterThan(1.1);

    const g = new Hand(100, 0, { jitter: 0.1, seed: 9 });
    g.arc(0, 0, 100, 0, 3, 1.2);
    const sc = buildSpine(recipe(g.rows()));
    for (let k = 0; k < sc.n; k++) expect(sc.corner[k]).toBe(0);
  });

  it('normals are unit, left of travel; curvature has the documented sign', () => {
    const h = new Hand(0, 0);
    h.moveTo(100, 0, 0.8);
    const sp = buildSpine(recipe(h.rows()));
    for (let i = 0; i < sp.n; i++) {
      expect(Math.hypot(sp.nx[i], sp.ny[i])).toBeCloseTo(1, 5);
      expect(sp.ny[i]).toBeCloseTo(-1, 5); // travelling +x on a y-down screen, left is up
      expect(Math.abs(sp.k[i])).toBeLessThan(1e-4);
    }
    const R = 60, c = new Hand(R, 0);
    c.arc(0, 0, R, 0, 4, 0.8); // angle increasing = clockwise on screen, bending away from n
    const sc = buildSpine(recipe(c.rows()));
    let ks = 0, rs = 0, m = 0;
    for (let i = 0; i < sc.n; i++) {
      if (sc.s[i] < 40 || sc.s[i] > sc.L - 20) continue;
      ks += sc.k[i]; rs += Math.hypot(sc.x[i], sc.y[i]); m++;
    }
    expect(ks / m).toBeCloseTo(-m / rs, 4); // unbiased: mean κ = −1/R' of the (filter-shrunk) circle
    for (let i = 5; i < sc.n - 5; i++) {
      // past the filter's start transient (the path spirals onto its lagged circle) κ is steady
      if (sc.s[i] > 40) expect(Math.abs(sc.k[i] * R + 1)).toBeLessThan(0.12);
      // n points away from the centre (left of clockwise travel on screen is outward)
      const ox = sc.x[i], oy = sc.y[i];
      expect((sc.nx[i] * ox + sc.ny[i] * oy) / Math.hypot(ox, oy)).toBeGreaterThan(0.99);
    }
  });

  it('pen pressure is calibrated per station; widths follow the nib; c/cs are copied', () => {
    const h = new Hand(0, 0, { p: 0.5, c: 0.4, cs: -0.3 });
    h.moveTo(120, 30, 0.9);
    const r = recipe(h.rows(), { nib: 'brush', size: 9 });
    const sp = buildSpine(r);
    const p = Math.fround(calibratePressure(0.5, DEFAULT_CALIB.pen));
    for (let i = 0; i < sp.n; i++) {
      expect(sp.p[i]).toBe(p);
      expect(sp.c[i]).toBe(Math.fround(0.4)); expect(sp.cs[i]).toBe(Math.fround(-0.3));
      expect(sp.w[i]).toBeCloseTo(nibWidth('brush', 9, sp.p[i], sp.vn[i], 'pen'), 4);
    }
    // 0.9 sp/ms over vMed 0.9; the One Euro output runs a few % fast mid-stroke while it catches up
    for (let i = 6; i < sp.n - 6; i++) { expect(sp.vn[i]).toBeGreaterThan(0.9); expect(sp.vn[i]).toBeLessThan(1.12); }
  });

  it('mouse pressure is synthesised from stored t: 0.35 at the start, rich when slow, dry when fast', () => {
    const slow = new Hand(0, 0, { hz: 125 }); slow.moveTo(80, 0, 0.1);
    const fast = new Hand(0, 0, { hz: 125 }); fast.moveTo(400, 0, 3);
    const a = buildSpine(recipe(slow.rows(1, true), { device: 'mouse' }));
    const b = buildSpine(recipe(fast.rows(1, true), { device: 'mouse' }));
    expect(a.p[0]).toBe(Math.fround(0.35)); expect(b.p[0]).toBe(Math.fround(0.35));
    expect(a.p[a.n - 3]).toBeGreaterThan(0.85);
    expect(b.p[b.n - 3]).toBeLessThan(0.3);
  });

  it('zoom: positions are doc units (sp / z), arc and widths stay in sp / doc', () => {
    const h = new Hand(0, 0); h.moveTo(120, 0, 0.9);
    const z = 2;
    const sp = buildSpine(recipe(h.rows(z), { z })) as InkSpine;
    expect(sp.z).toBe(z);
    expect(sp.L).toBeCloseTo(120, 3);
    expect(sp.x[sp.n - 1]).toBeCloseTo(60, 4);
    expect(sp.x[2] - sp.x[1]).toBeCloseTo(STATION / z, 4);
    expect(sp.w[3]).toBeCloseTo(nibWidth('brush', 9, sp.p[3], sp.vn[3], 'pen') / z, 4);
  });

  it('taps and empty recipes', () => {
    const tap = buildSpine(recipe(new Hand(3, 4).rows()));
    expect(tap.n).toBe(1); expect(tap.settled).toBe(1); expect(tap.L).toBe(0);
    expect(tap.x[0]).toBe(Math.fround(3));
    const none = buildSpine(recipe(new Float32Array(0)));
    expect(none.n).toBe(0); expect(none.L).toBe(0);
  });

  it('measures jitter on slow segments and exposes a live tip', () => {
    const h = new Hand(0, 0, { jitter: 0.5, seed: 21, hz: 240 });
    h.moveTo(40, 10, 0.08).hold(300).moveTo(60, 30, 0.1);
    const r = recipe(h.rows());
    const b = createSpineBuilder(r);
    b.append();
    const J = b.jitter();
    // per-axis σ 0.5 ⇒ 2D residual RMS ≈ 0.71 (a short stroke: ~16 windows)
    expect(J).toBeGreaterThan(0.5); expect(J).toBeLessThan(0.85);
    const tip = b.tip();
    expect(tip.travel).toBeGreaterThan(30);
    expect(tip.s).toBe(b.spine.L);

    const m = new Hand(0, 0, { hz: 125 }); m.moveTo(100, 0, 2);
    const mb = createSpineBuilder(recipe(m.rows(1, true), { device: 'mouse' }));
    mb.append();
    const tl = m.t;
    const p1 = mb.tip(tl).p, p2 = mb.tip(tl + 400).p;
    expect(p1).toBeLessThan(0.45);
    expect(p2).toBeGreaterThan(0.85); // a still mouse pools ink
  });
});

describe('spine: split pieces', () => {
  it('a cut-tail piece ends on its snapshot station and the continuation starts there', () => {
    const h = new Hand(0, 0, { jitter: 0.15, seed: 31 });
    h.moveTo(200, 50, 0.8).arc(200, 100, 50, -Math.PI / 2, Math.PI / 2, 0.8).moveTo(0, 150, 1.0);
    const rows = h.rows(), total = rows.length / S.STRIDE;
    const split = Math.floor(total * 0.55);
    const whole = buildSpine(recipe(rows));
    const head = rows.slice(0, split * S.STRIDE);
    const b = createSpineBuilder(recipe(head, { cut: 2 }));
    b.append();
    const snap = b.snapshot();
    b.finish();
    const p1 = b.spine;
    expect(snap[RESUME.VERSION]).toBe(1);
    expect(p1.s[p1.n - 1]).toBe(snap[RESUME.S]);
    expect(p1.x[p1.n - 1]).toBe(snap[RESUME.X]);
    // piece 1 is a prefix of the uncut stroke, bit for bit
    for (let i = 0; i < p1.n; i++) expect(diff(whole, p1, i)).toBe(null);

    const cont = continuationSamples(rows, total, snap);
    const r2 = recipe(cont, { s0: snap[RESUME.S], cut: 1, resume: snap });
    const p2 = buildSpine(r2);
    expect(p2.x[0]).toBe(snap[RESUME.X]); expect(p2.y[0]).toBe(snap[RESUME.Y]);
    expect(p2.s[0]).toBe(snap[RESUME.S]);
    expect(p2.L).toBeGreaterThan(snap[RESUME.S] + 100);
    // it tracks the uncut stroke closely after a short settling distance
    let worst = 0;
    for (let i = 0; i < p2.n; i++) {
      const s = p2.s[i];
      if (s < snap[RESUME.S] + 15 || s > whole.L - 10) continue;
      let j = 0; while (j < whole.n - 1 && whole.s[j + 1] < s) j++;
      worst = Math.max(worst, Math.hypot(p2.x[i] - whole.x[j], p2.y[i] - whole.y[j]));
    }
    expect(worst).toBeLessThan(STATION + 1);
    expect(p2.p[0]).toBeCloseTo(snap[RESUME.P], 5);
  });
});

describe('spine: closure weld', () => {
  it('a closed loop is welded: last station on the first, seamless frame, only the tail moved', () => {
    const h = new Hand(100, 0, { jitter: 0.1, seed: 6 });
    h.arc(0, 0, 100, 0, 2 * Math.PI - 0.08, 1.0);
    const rows = h.rows();
    const open = buildSpine(recipe(rows, { closed: false }));
    const closed = buildSpine(recipe(rows, { closed: true }));
    const n = closed.n;
    expect(n).toBe(open.n);
    expect(closed.x[n - 1]).toBe(closed.x[0]); expect(closed.y[n - 1]).toBe(closed.y[0]);
    expect(closed.nx[n - 1]).toBe(closed.nx[0]); expect(closed.ny[n - 1]).toBe(closed.ny[0]);
    const gap = Math.hypot(open.x[n - 1] - open.x[0], open.y[n - 1] - open.y[0]);
    expect(gap).toBeGreaterThan(5);
    const W = weldWidth(open.L - open.s[0], gap);
    expect(W).toBeLessThanOrEqual(50);
    for (let i = 0; i < n; i++) {
      if (closed.s[i] <= closed.L - W) {
        expect(closed.x[i]).toBe(open.x[i]); expect(closed.y[i]).toBe(open.y[i]);
      }
      expect(closed.w[i]).toBe(open.w[i]); expect(closed.s[i]).toBe(open.s[i]);
    }
  });
});

describe('spine: closure weld (seam direction)', () => {
  const seamTurn = (sp: Spine): number => {
    const n = sp.n;
    const a = Math.atan2(sp.y[n - 1] - sp.y[n - 2], sp.x[n - 1] - sp.x[n - 2]);
    const b = Math.atan2(sp.y[1] - sp.y[0], sp.x[1] - sp.x[0]);
    let d = Math.abs(b - a) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d * 180 / Math.PI;
  };

  it('a loop that stops short of its start welds without a kink (arrives in the start direction)', () => {
    // regression: a position-only blend joined end and start at their raw directions (~g/R = 8.6° here)
    const R = 100, h = new Hand(R, 0, { seed: 6 });
    h.arc(0, 0, R, 0, 2 * Math.PI - 0.15, 1.0);
    const open = buildSpine(recipe(h.rows()));
    const closed = buildSpine(recipe(h.rows(), { closed: true }));
    const n = closed.n;
    expect(closed.x[n - 1]).toBe(closed.x[0]); expect(closed.y[n - 1]).toBe(closed.y[0]);
    // the open stroke's end direction differs from its start direction by the gap angle
    const openEnd = Math.atan2(open.y[n - 1] - open.y[n - 2], open.x[n - 1] - open.x[n - 2]);
    const openStart = Math.atan2(open.y[1] - open.y[0], open.x[1] - open.x[0]);
    expect(Math.abs(openEnd - openStart) * 180 / Math.PI).toBeGreaterThan(6);
    // welded: the seam turns no more than neighbouring stations do on this circle (2.4/R rad ≈ 1.4°)
    expect(seamTurn(closed)).toBeLessThan(2.5);
    for (let i = 1; i < n - 1; i++) {
      const a = Math.atan2(closed.y[i] - closed.y[i - 1], closed.x[i] - closed.x[i - 1]);
      const b = Math.atan2(closed.y[i + 1] - closed.y[i], closed.x[i + 1] - closed.x[i]);
      let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d * 180 / Math.PI).toBeLessThan(4); // no kink anywhere in the blend either
    }
  });

  it('a deliberately pointed loop keeps its point at the seam', () => {
    // a teardrop: leaves heading +x and returns heading −y, a 90° point at the start
    const h = new Hand(0, 0, { seed: 7 });
    h.moveTo(120, 0, 0.8).arc(120, 60, 60, -Math.PI / 2, Math.PI / 2, 0.8).moveTo(30, 120, 0.8).moveTo(0, 60, 0.8).moveTo(0, 6, 0.8);
    const sp = buildSpine(recipe(h.rows(), { closed: true }));
    expect(seamTurn(sp)).toBeGreaterThan(60);
  });
});

describe('spine: robustness', () => {
  it('closing toggles and read-only calls (tip, snapshot, jitter) never perturb the build', () => {
    const r = cases[0].r;
    const full = buildSpine({ ...r, closed: true });
    const { d, total, feed } = draftOf(r, false);
    const b = createSpineBuilder(d);
    const rand = mulberry32(5);
    for (let fed = 0; fed < total;) {
      fed = feed(1 + Math.floor(rand() * 11));
      b.append();
      d.closing = rand() < 0.5;
      b.tip(fed * 4 + 100); b.snapshot(); b.jitter();
    }
    d.closing = true;
    b.finish();
    expect(b.spine.n).toBe(full.n);
    for (let i = 0; i < full.n; i++) expect(diff(full, b.spine, i)).toBe(null);
  });

  it('skips corrupt rows (non-finite position or time) instead of poisoning the filter', () => {
    const h = new Hand(0, 0); h.moveTo(100, 0, 0.8);
    const rows = h.rows();
    const bad = rows.slice();
    bad[10 * S.STRIDE + S.X] = NaN; bad[11 * S.STRIDE + S.T] = Infinity;
    const sp = buildSpine(recipe(bad));
    for (let i = 0; i < sp.n; i++) { expect(Number.isFinite(sp.x[i])).toBe(true); expect(Number.isFinite(sp.k[i])).toBe(true); }
    expect(sp.L).toBeGreaterThan(98);
  });

  it('corrupt rows never reach any station field: t, v_n, p, w stay finite and sane (pen and mouse)', () => {
    // regression: stations interpolated across a skipped row read its T = ∞ (t = ∞/NaN, v_n huge)
    const h = new Hand(0, 0); h.moveTo(100, 0, 0.8);
    for (const mouse of [false, true]) {
      const bad = h.rows(1, mouse).slice();
      bad[0 * S.STRIDE + S.Y] = NaN;            // the first row
      bad[10 * S.STRIDE + S.X] = NaN;
      bad[11 * S.STRIDE + S.T] = Infinity;
      bad[30 * S.STRIDE + S.T] = NaN;
      const sp = buildSpine(recipe(bad, mouse ? { device: 'mouse' } : {}));
      expect(sp.n).toBeGreaterThan(30);
      for (let i = 0; i < sp.n; i++) {
        for (const f of FIELDS) if (!Number.isFinite(sp[f][i])) throw new Error(`station ${i} ${f} = ${sp[f][i]}`);
        if (i > 0) expect(sp.t[i]).toBeGreaterThanOrEqual(sp.t[i - 1]);
        expect(sp.vn[i]).toBeLessThan(1.3); // 0.8 sp/ms over vMed 0.9
      }
    }
  });

  it('end flush keeps the stroke speed: no v_n spike at the end, t strictly increases to t_last + τ', () => {
    // regression: every station on the flush segment (filtered tip → raw lift point, up to 15 sp
    // for a mouse) carried the lift time, so v_n read 25–70× vMed over the last stations
    for (const v of [0.3, 0.8, 2.5]) {
      for (const mouse of [false, true]) {
        const h = new Hand(0, 0); h.moveTo(200, 0, v);
        const r = recipe(h.rows(1, mouse), mouse ? { device: 'mouse' } : {});
        const sp = buildSpine(r);
        const mid = sp.vn[sp.n >> 1];
        expect(mid).toBeCloseTo(v / 0.9, 0);
        const tLast = h.t;
        for (let i = sp.n - 10; i < sp.n; i++) {
          expect(sp.t[i]).toBeGreaterThan(sp.t[i - 1]);
          expect(Math.abs(sp.vn[i] / mid - 1)).toBeLessThan(0.06);
        }
        expect(sp.t[sp.n - 1]).toBeGreaterThan(tLast);
        expect(sp.t[sp.n - 1]).toBeLessThan(tLast + 140); // τ ≤ 1/(2π·1.2 Hz)
        expect(sp.x[sp.n - 1]).toBe(Math.fround(200));      // still ends on the raw lift point
      }
    }
  });

  it('tip travel counts the earlier pieces of a split stroke (no bloom at s = 0 in a continuation)', () => {
    const h = new Hand(0, 0); h.moveTo(3, 0, 0.5);
    const b = createSpineBuilder(recipe(h.rows(), { s0: 1000, cut: 1 }));
    expect(b.tip().travel).toBe(1000);
    b.append();
    const tip = b.tip();
    expect(tip.travel).toBeGreaterThan(1000);
    expect(tip.travel).toBeLessThan(1004);
    expect(tip.s).toBe(b.spine.L);
  });

  it('is deterministic across builds', () => {
    const a = buildSpine(cases[1].r), b = buildSpine(cases[1].r);
    for (let i = 0; i < a.n; i++) expect(diff(a, b, i)).toBe(null);
  });
});


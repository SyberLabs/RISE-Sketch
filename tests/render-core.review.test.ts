/**
 * render-core review: regression tests for defects found in review (each block names the bug).
 */
import { describe, it, expect } from 'vitest';
import { PolyKind } from '../src/core/types';
import type { InkTable } from '../src/core/types';
import { tracePoly } from '../src/render/tessellate';
import { drawCooked, drawStats } from '../src/render/raster';
import { Batcher, MODE_FILL, exactKey, alphaOf, MAX_FILLS } from '../src/render/batch';
import { zoomAt, fitBox } from '../src/render/camera';
import { createLedger } from '../src/render/ledger';
import { resolveInk, assignVariant } from '../src/ink/color';
import { synthCooked, along, RecordingSink, FlatSink, distToPath } from './render-core.fixtures';

const I = Float64Array.of(1, 0, 0, 1, 0, 0);
const scaleM = (s: number) => Float64Array.of(s, 0, 0, s, 0, 0);
const night = (): InkTable => resolveInk(assignVariant('moss', 0, null, null), 'night');
const paper = (): InkTable => resolveInk(assignVariant('indigo', 0, null, null), 'paper');

/** Context stand-in recording each fill / stroke with its alpha and the path's arcs and subpaths. */
function fakeCtx() {
  const log: { op: string; alpha: number; subpaths: number; arcs: number[] }[] = [];
  let subpaths = 0, arcs: number[] = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    save() {}, restore() {}, setTransform() {},
    beginPath() { subpaths = 0; arcs = []; },
    moveTo() { subpaths++; }, lineTo() {}, quadraticCurveTo() {}, closePath() {},
    arc(_x: number, _y: number, r: number) { arcs.push(r); },
    fill() { log.push({ op: 'fill', alpha: ctx.globalAlpha, subpaths, arcs }); },
    stroke() { log.push({ op: 'stroke', alpha: ctx.globalAlpha, subpaths, arcs }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

/** Grid samples where both sinks cover, and where the true stroke is covered by neither. */
function overlapAndGaps(A: FlatSink, B: FlatSink, pts: [number, number, number][], box: [number, number, number, number], step = 0.25) {
  let both = 0, gaps = 0;
  for (let y = box[1]; y <= box[3]; y += step) for (let x = box[0]; x <= box[2]; x += step) {
    const ia = A.winding(x, y) !== 0, ib = B.winding(x, y) !== 0;
    if (ia && ib) both++;
    const { d, w } = distToPath(pts, x, y);
    if (d < w / 2 - 0.4 && !ia && !ib) gaps++;
  }
  return { both, gaps };
}

describe('review: empty and sub-pixel arc ranges never draw a full-width bead', { timeout: 60000 }, () => {
  const pts = along([[0, 0], [100, 0]], 2.5, () => 10);
  const c = synthCooked([{ pts }]);

  it('an empty range draws nothing (arcFrom at the end, arcTo at the start, arcFrom = arcTo)', () => {
    expect(tracePoly(new RecordingSink(), c, 0, I, { arcFrom: 100 })).toBe(false);
    expect(tracePoly(new RecordingSink(), c, 0, I, { arcFrom: 150 })).toBe(false);
    expect(tracePoly(new RecordingSink(), c, 0, I, { arcTo: 0 })).toBe(false);
    expect(tracePoly(new RecordingSink(), c, 0, I, { arcFrom: 40, arcTo: 40 })).toBe(false);
    expect(tracePoly(new RecordingSink(), c, 0, I, { arcFrom: 41, arcTo: 40 })).toBe(false);
  });

  it('cuts a hair apart snap together: the sub-pixel middle range is empty, its neighbours share one edge', () => {
    // (Canvas AA only sums to full coverage across edges at the same position: three fills meeting
    // within a pixel would leave a seam up to 25 % dark, measured in Chrome)
    const A = new RecordingSink(), M = new RecordingSink(), B = new RecordingSink();
    tracePoly(A, c, 0, I, { arcTo: 50 });
    expect(tracePoly(M, c, 0, I, { arcFrom: 50, arcTo: 50.1 })).toBe(false);
    tracePoly(B, c, 0, I, { arcFrom: 50.1 });
    const pts2 = (r: RecordingSink) => r.ops.filter(o => o.op !== 'Z' && o.op !== 'A').map(o => o.a.slice(-2).join(','));
    expect(pts2(A).filter(p => pts2(B).includes(p)).length).toBeGreaterThanOrEqual(2);
    const fa = new FlatSink(), fb = new FlatSink();
    tracePoly(fa, c, 0, I, { arcTo: 50 }); tracePoly(fb, c, 0, I, { arcFrom: 50.1 });
    expect(overlapAndGaps(fa, fb, pts, [40.13, -7.13, 60, 7])).toEqual({ both: 0, gaps: 0 });
  });

  it('a cut within half a quarter-pixel of a poly end snaps onto it (that end stays a cap or weld)', () => {
    const head = new FlatSink(), tail = new FlatSink();
    tracePoly(head, c, 0, I, { arcTo: 99.9 });
    expect(tracePoly(tail, c, 0, I, { arcFrom: 99.9 })).toBe(false);
    expect(head.winding(103, 0)).not.toBe(0);                // the head keeps the whole poly and its cap
    const start = new FlatSink();
    expect(tracePoly(new FlatSink(), c, 0, I, { arcTo: 0.1 })).toBe(false);
    tracePoly(start, c, 0, I, { arcFrom: 0.1 });
    expect(start.winding(-3, 0)).not.toBe(0);
    const r = new RecordingSink();
    tracePoly(r, c, 0, I, { arcFrom: 0.1, arcTo: 99.9 });
    expect(r.ops.filter(o => o.op === 'A').length).toBe(2);   // both ends are caps again
  });

  it('a range that collapses below 0.25 device px next to a cut is only the open half disc', () => {
    // anisotropic view: the vertical leg is squashed 100×, so an arc step that is a quarter pixel on
    // average is far below a pixel there and the tail range collapses to one point
    const legs = [...along([[0, 0], [100, 0]], 2.5, () => 10), ...along([[100, 0], [100, 100]], 2.5, () => 10).slice(1)];
    const cc = synthCooked([{ pts: legs }]);
    const m = Float64Array.of(1, 0, 0, 0.01, 0, 0);
    const head = new FlatSink(), tail = new FlatSink();
    tracePoly(head, cc, 0, m, { arcTo: 190.3 });
    expect(tracePoly(tail, cc, 0, m, { arcFrom: 190.3 })).toBe(true);
    expect(tail.polys.length).toBe(1);
    for (const ar of tail.areas()) expect(ar).toBeLessThan(0);
    // the half disc lies ahead of the cut only: no overlap with the head
    const box: [number, number, number, number] = [95.07, -2.07, 105, 3];
    let both = 0;
    for (let y = box[1]; y <= box[3]; y += 0.05) for (let x = box[0]; x <= box[2]; x += 0.05) if (head.winding(x, y) !== 0 && tail.winding(x, y) !== 0) both++;
    expect(both).toBe(0);
  });

  it('a tiny reveal right after a welded joint is a half disc ahead of the weld, not a bead over the predecessor', () => {
    const all = along([[0, 0], [100, 0]], 2.4, () => 12);
    const k = 20;
    const cc = synthCooked([{ pts: all.slice(0, k + 1), gen: 0, tone: 3 }, { pts: all.slice(k), gen: 0, tone: 9 }]);
    const A = new FlatSink(), B = new FlatSink();
    tracePoly(A, cc, 0, I);
    expect(tracePoly(B, cc, 1, I, { reveal: 0.001 })).toBe(true);
    const jx = all[k][0];
    const r = overlapAndGaps(A, B, all.slice(0, k + 1), [jx - 10.13, -8.13, jx + 8, 8]);
    expect(r.both).toBe(0);
    expect(B.winding(jx + 4, 0)).not.toBe(0);
  });
});

describe('review: flat ends on curves and gentle corners partition the ink exactly', { timeout: 60000 }, () => {
  /** Ribbon along a circle of radius R (stations every 2.4), constant width w. */
  const circle = (R: number, w: number, turns = 2.5): [number, number, number][] => {
    const out: [number, number, number][] = [];
    for (let i = 0; i <= Math.round((R * turns) / 2.4); i++) { const a = -Math.PI / 2 + (2.4 * i) / R; out.push([R * Math.cos(a), R + R * Math.sin(a), w]); }
    return out;
  };
  /** Two straight arms of width w meeting at (60, 0) with a turn of `deg`. */
  const corner = (deg: number, w: number): [number, number, number][] => {
    const t = (deg * Math.PI) / 180;
    const a = along([[0, 0], [60, 0]], 2.4, () => w), b = along([[60, 0], [60 + 60 * Math.cos(t), -60 * Math.sin(t)]], 2.4, () => w);
    return [...a, ...b.slice(1)];
  };

  it('arc cuts on tight curves (radius down to 1.5 × w/2): no overlap, no gap', () => {
    // (at radius ≤ w/2 the ribbon covers its own centre from both sides of any cut: that is the
    // stroke overlapping itself, which adds across batches like any self-crossing)
    for (const R of [30, 40, 80]) {
      const pts = circle(R, 40);
      const c = synthCooked([{ pts }]);
      const L = c.pts[4 * (c.nPts - 1) + 3];
      for (const f of [0.3, 0.55]) {
        const cut = L * f + 0.013;
        const A = new FlatSink(), B = new FlatSink();
        tracePoly(A, c, 0, I, { arcTo: cut }); tracePoly(B, c, 0, I, { arcFrom: cut });
        expect({ R, f, ...overlapAndGaps(A, B, pts, [-R - 25.07, -25.07, R + 25, 2 * R + 25], 0.5) }).toEqual({ R, f, both: 0, gaps: 0 });
      }
    }
  });

  it('welded chunks on a tight curve: no overlap, no gap', () => {
    const pts = circle(30, 40);
    for (const k of [17, 30]) {
      const c = synthCooked([{ pts: pts.slice(0, k + 1), gen: 0, tone: 3 }, { pts: pts.slice(k), gen: 0, tone: 9 }]);
      const A = new FlatSink(), B = new FlatSink();
      tracePoly(A, c, 0, I); tracePoly(B, c, 1, I);
      expect({ k, ...overlapAndGaps(A, B, pts, [-55.07, -25.07, 55, 85], 0.5) }).toEqual({ k, both: 0, gaps: 0 });
    }
  });

  it('cuts swept through a gentle corner (≤ 28°): no overlap, sub-pixel gaps at most', () => {
    for (const deg of [10, 20, 28]) {
      const pts = corner(deg, 30);
      const c = synthCooked([{ pts }]);
      const aV = c.pts[4 * 25 + 3];
      let gaps = 0;
      for (const d of [-8, -3, -0.5, 0.5, 3, 8]) {
        const A = new FlatSink(), B = new FlatSink();
        tracePoly(A, c, 0, I, { arcTo: aV + d + 0.013 }); tracePoly(B, c, 0, I, { arcFrom: aV + d + 0.013 });
        const r = overlapAndGaps(A, B, pts, [25.07, -45.07, 95, 25], 0.5);
        expect({ deg, d, both: r.both }).toEqual({ deg, d, both: 0 });
        gaps += r.gaps;
      }
      expect(gaps * 0.25 / 6).toBeLessThan(1);              // px² per cut (sub-pixel)
    }
  });

  it('a cut on (or within half a pixel of) a corner station ≤ 60° splits on the bisector: exact', () => {
    for (const deg of [35, 45, 59]) {
      const pts = corner(deg, 30);
      const c = synthCooked([{ pts }]);
      const aV = c.pts[4 * 25 + 3];                         // the corner is station 25
      for (const d of [0, -0.3, 0.3]) {
        const A = new FlatSink(), B = new FlatSink();
        tracePoly(A, c, 0, I, { arcTo: aV + d }); tracePoly(B, c, 0, I, { arcFrom: aV + d });
        expect({ deg, d, ...overlapAndGaps(A, B, pts, [25.07, -60.07, 100, 25], 0.5) }).toEqual({ deg, d, both: 0, gaps: 0 });
      }
    }
  });

  it('a sharp corner near a cut never loses ink (its overlap is the declared limitation)', () => {
    for (const deg of [45, 90, 135]) {
      const pts = corner(deg, 30);
      const c = synthCooked([{ pts }]);
      const aV = c.pts[4 * 25 + 3];
      for (const d of [-6, -1, 1, 6]) {
        const A = new FlatSink(), B = new FlatSink();
        tracePoly(A, c, 0, I, { arcTo: aV + d + 0.013 }); tracePoly(B, c, 0, I, { arcFrom: aV + d + 0.013 });
        expect({ deg, d, gaps: overlapAndGaps(A, B, pts, [25.07, -80.07, 110, 25], 0.5).gaps }).toEqual({ deg, d, gaps: 0 });
      }
    }
  });

  it('ink far along the poly that crosses the extension of the cut line is never clipped', () => {
    // a U-turn: the far arm passes right across the extension of the cut line at the start
    const pts = [...along([[0, 0], [80, 0]], 2.4, () => 12), ...along([[80, 0], [80, -40]], 2.4, () => 12).slice(1), ...along([[80, -40], [-10, -40]], 2.4, () => 12).slice(1)];
    const c = synthCooked([{ pts }]);
    const B = new FlatSink();
    tracePoly(B, c, 0, I, { arcFrom: 20.013 });             // start cut at x ≈ 20, line x = 20
    for (const x of [0, 10, 19]) expect(B.winding(x, -40)).not.toBe(0);   // far arm, behind the line
  });
});

describe('review: single-station chisel', { timeout: 60000 }, () => {
  it('is the nib footprint (E long, core thick), not a disc of diameter E', () => {
    const th = 0.5;
    const c = synthCooked([{ pts: [[0, 0, 20]], kind: PolyKind.Chisel, ang: [th] }]);
    const f = new FlatSink();
    expect(tracePoly(f, c, 0, I)).toBe(true);
    const ux = Math.cos(th), uy = Math.sin(th), nx = -uy, ny = ux;
    expect(f.winding(9 * ux, 9 * uy)).not.toBe(0);           // along the nib, near its corner
    expect(f.winding(-9 * ux, -9 * uy)).not.toBe(0);
    expect(f.winding(5 * nx, 5 * ny)).toBe(0);               // across the nib beyond the core (1.5)
    for (const a of f.areas()) expect(a).toBeLessThan(0);
  });

  it('thinner than minDevWidth: a disc at minDevWidth like any dot', () => {
    const c = synthCooked([{ pts: [[0, 0, 0.3]], kind: PolyKind.Chisel, ang: [0.5] }]);
    const s = new RecordingSink();
    expect(tracePoly(s, c, 0, I)).toBe(true);
    expect(s.ops.filter(o => o.op === 'A').map(o => o.a[2])).toEqual([0.5, 0.5]);
  });
});

describe('review: chisel welds need one nib line', { timeout: 60000 }, () => {
  it('chunks whose shared point has different nib angles get free ends', () => {
    const p1 = along([[0, 0], [40, 0]], 2.4, () => 16), p2 = along([[40, 0], [80, 0]], 2.4, () => 16);
    const same = synthCooked([
      { kind: PolyKind.Chisel, pts: p1, ang: p1.map(() => 0.7), gen: 0 },
      { kind: PolyKind.Chisel, pts: p2, ang: p2.map(() => 0.7), gen: 0 },
    ]);
    const diff = synthCooked([
      { kind: PolyKind.Chisel, pts: p1, ang: p1.map(() => 0.7), gen: 0 },
      { kind: PolyKind.Chisel, pts: p2, ang: p2.map(() => 1.1), gen: 0 },
    ]);
    // a free end adds the nib footprint subpath; a welded end does not
    const count = (c: typeof same) => { const f = new FlatSink(); tracePoly(f, c, 0, I); return f.polys.length; };
    expect(count(diff)).toBe(count(same) + 1);
  });
});

describe('review: welds under morph follow the drawn geometry', { timeout: 60000 }, () => {
  it('a straight chunked stroke morphing from a rotated copy keeps its full width at the joint', () => {
    const all = along([[0, 0], [60, 0]], 2.4, () => 10);
    const k = 12;
    const c = synthCooked([{ pts: all.slice(0, k + 1), gen: 0, tone: 3 }, { pts: all.slice(k), gen: 0, tone: 9 }]);
    // from: the same stroke rotated 90° (vertical); at t = 0 the drawn stroke is vertical
    const from = new Float32Array(2 * c.nPts);
    for (let j = 0; j < c.nPts; j++) { from[2 * j] = 0; from[2 * j + 1] = c.pts[4 * j]; }
    const A = new FlatSink(), B = new FlatSink();
    tracePoly(A, c, 0, I, { morphFrom: from, morphT: 0 });
    tracePoly(B, c, 1, I, { morphFrom: from, morphT: 0 });
    const drawn = all.map(([x, , w]) => [0, x, w] as [number, number, number]);
    const jy = all[k][0];
    const r = overlapAndGaps(A, B, drawn, [-8.13, jy - 10.13, 8, jy + 10]);
    expect(r.gaps).toBe(0);
    expect(r.both).toBe(0);
    // the joint is welded (flat), not capped: only the far ends carry caps
    const s = new RecordingSink();
    tracePoly(s, c, 0, I, { morphFrom: from, morphT: 0 });
    expect(s.ops.filter(o => o.op === 'A').length).toBe(1);
  });

  it('drawCooked unwelds neighbours that sit at different morph t', () => {
    const c = synthCooked([{ pts: [[0, 0, 6], [20, 0, 6]], tone: 3 }, { pts: [[20, 0, 6], [40, 1, 6]], tone: 9 }]);
    const from = new Float32Array(2 * c.nPts);
    for (let j = 0; j < c.nPts; j++) { from[2 * j] = c.pts[4 * j]; from[2 * j + 1] = c.pts[4 * j + 1]; }
    const sameT = fakeCtx(), diffT = fakeCtx();
    drawCooked(sameT.ctx, c, night(), I, { morph: { from, t: () => 0.5 } });
    drawCooked(diffT.ctx, c, night(), I, { morph: { from, t: i => (i === 0 ? 0.5 : 0.25) } });
    const arcs = (l: ReturnType<typeof fakeCtx>['log']) => l.reduce((n, f) => n + f.arcs.length, 0);
    expect(arcs(sameT.log)).toBe(2);
    expect(arcs(diffT.log)).toBe(4);
  });
});

describe('review: alpha (Paper safety, exact alphaMax and alphaScale)', { timeout: 60000 }, () => {
  const c = () => synthCooked([{ pts: along([[0, 0], [100, 0]], 2.4, () => 6), alpha: 1 }, { pts: along([[0, 20], [100, 20]], 2.4, () => 6), alpha: 0.5, tone: 3 }]);

  it('Paper never exceeds 0.85, even for hot ink or alphaScale > 1', () => {
    for (const o of [{}, { hot: () => 1.6 }, { alphaScale: 1.5 }, { alphaScale: 1.5, hot: () => 2 }]) {
      const { ctx, log } = fakeCtx();
      drawCooked(ctx, c(), paper(), I, o);
      expect(log.length).toBeGreaterThan(0);
      for (const f of log) expect(f.alpha).toBeLessThanOrEqual(0.85);
    }
  });

  it('alphaScale is applied exactly (continuous fades) and never changes the batching', () => {
    for (const s of [1, 0.37, 0.05]) {
      const { ctx, log } = fakeCtx();
      drawCooked(ctx, c(), night(), I, { alphaScale: s });
      expect(log).toHaveLength(2);
      const alphas = log.map(f => f.alpha).sort((a, b) => a - b);
      expect(alphas[0]).toBeCloseTo(0.5 * s, 9);
      expect(alphas[1]).toBeCloseTo(s, 9);
    }
  });

  it('fill alpha never goes above 1 (Canvas2D would silently keep the previous batch alpha)', () => {
    const { ctx, log } = fakeCtx();
    drawCooked(ctx, c(), night(), I, { alphaScale: 3 });
    for (const f of log) expect(f.alpha).toBeLessThanOrEqual(1);
  });

  it('hot ink with alphaScale < 1: one exact pass while the total stays ≤ 1, two passes above', () => {
    const one = fakeCtx();
    drawCooked(one.ctx, synthCooked([{ pts: along([[0, 0], [50, 0]], 2.4, () => 6) }]), night(), I, { alphaScale: 0.5, hot: () => 1.5 });
    expect(one.log.map(f => f.alpha)).toEqual([0.75]);
    const two = fakeCtx();
    drawCooked(two.ctx, synthCooked([{ pts: along([[0, 0], [50, 0]], 2.4, () => 6) }]), night(), I, { alphaScale: 0.8, hot: () => 1.5 });
    const a = two.log.map(f => f.alpha).sort((x, y) => x - y);
    expect(a).toHaveLength(2);
    expect(a[1]).toBe(1);
    expect(a[0]).toBeCloseTo(0.2, 3);
  });

  it('the generation cull does not depend on alphaScale (a fade does not pop generations)', () => {
    const g = synthCooked([
      { pts: along([[0, 0], [100, 0]], 2.4, () => 4), gen: 0 },
      { pts: along([[0, 10], [100, 10]], 2.4, () => 0.2), gen: 1, alpha: 0.5 },   // w·α = 0.1 > 0.06
    ]);
    const { ctx } = fakeCtx();
    drawCooked(ctx, g, night(), I, { alphaScale: 0.3 });
    expect(drawStats.culled).toBe(0);
  });
});

describe('review: stroke-cull dot honours subset, reveal and hot', { timeout: 60000 }, () => {
  const c = synthCooked([{ pts: along([[0, 0], [100, 0]], 2.4, () => 6) }, { pts: along([[0, 20], [100, 20]], 2.4, () => 6), alpha: 0.5 }]);
  const m = scaleM(0.02);

  it('two complementary subsets sum to the whole stroke instead of drawing it twice', () => {
    const all = fakeCtx(), a = fakeCtx(), b = fakeCtx();
    drawCooked(all.ctx, c, night(), m);
    drawCooked(a.ctx, c, night(), m, { polys: [0] });
    drawCooked(b.ctx, c, night(), m, { polys: [1] });
    expect(all.log).toHaveLength(1);
    expect(a.log[0].alpha + b.log[0].alpha).toBeCloseTo(all.log[0].alpha, 9);
    expect(a.log[0].alpha).toBeCloseTo(2 * b.log[0].alpha, 9);   // alpha 1 vs 0.5, equal areas
  });

  it('an unrevealed stroke draws no dot; a half-revealed one half the alpha', () => {
    const none = fakeCtx(), half = fakeCtx(), all = fakeCtx();
    drawCooked(none.ctx, c, night(), m, { reveal: () => 0 });
    drawCooked(half.ctx, c, night(), m, { reveal: () => 0.5 });
    drawCooked(all.ctx, c, night(), m);
    expect(none.log).toHaveLength(0);
    expect(half.log[0].alpha).toBeCloseTo(all.log[0].alpha * 0.5, 9);
  });
});

describe('review: clip padding covers miter overshoot', { timeout: 60000 }, () => {
  it('a thick V whose outer miter pokes below its box is drawn for a clip rect just below the box', () => {
    // symmetric V with a 55° turn at the apex (arms 62.5° from vertical): a crisp outer miter
    // reaching h/cos(27.5°) = 1.127·h below the apex, while the box stops at h below it
    const h = 20, b = (62.5 * Math.PI) / 180;
    const pts: [number, number, number][] = [[-40 * Math.sin(b), -40 * Math.cos(b), 2 * h], [0, 0, 2 * h], [40 * Math.sin(b), -40 * Math.cos(b), 2 * h]];
    const c = synthCooked([{ pts }]);
    const f = new FlatSink();
    tracePoly(f, c, 0, I);
    let maxY = -Infinity;
    for (const p of f.polys) for (let i = 1; i < p.length; i += 2) maxY = Math.max(maxY, p[i]);
    const boxY1 = c.box[3];
    expect(maxY).toBeGreaterThan(boxY1 + 2);             // the miter overshoots the box
    const clip = { x0: -5, y0: boxY1 + 1.5, x1: 5, y1: boxY1 + 2 };
    const { ctx, log } = fakeCtx();
    drawCooked(ctx, c, night(), I, { clipDev: clip });
    expect(log).toHaveLength(1);
  });
});

describe('review: misc', { timeout: 60000 }, () => {
  it('lod: false draws a sub-pixel dot at its true size (no 1 px enlargement without the alpha fix)', () => {
    const c = synthCooked([{ pts: [[0, 0, 0.4]], kind: PolyKind.Dot }]);
    const off = fakeCtx(), on = fakeCtx();
    drawCooked(off.ctx, c, night(), I, { lod: false });
    drawCooked(on.ctx, c, night(), I);
    expect(off.log[0].arcs[0]).toBeCloseTo(0.2, 6);
    expect(off.log[0].alpha).toBe(1);
    expect(on.log[0].arcs[0]).toBeCloseTo(0.5, 9);
    expect(on.log[0].alpha).toBeCloseTo(0.16, 5);       // the whole stroke is < 3 px: one area-matched dot
  });

  it('batch merging folds a faint exact alpha into the faintest level, not 1/8', () => {
    const b = new Batcher();
    let i = 0;
    // 30 tones × (11 bucket levels + 30 exact alphas): only folding exact alphas (level 4) fits 96
    for (let tone = 0; tone < 30; tone++) {
      for (let k = 0; k < 11; k++) b.add(i++, tone, k, MODE_FILL);
      for (let k = 0; k < 30; k++) b.add(i++, tone, exactKey(0.1 + k * 0.02), MODE_FILL);
    }
    const faintPoly = i;
    b.add(i++, 7, exactKey(0.002), MODE_FILL);
    const p = b.build(false);
    expect(p.n).toBeLessThanOrEqual(MAX_FILLS);
    let faintAlpha = -1;
    for (let k = 0; k < p.n; k++) for (let e = p.first[k]; e < p.first[k] + p.count[k]; e++) if (b.poly[p.order[e]] === faintPoly) faintAlpha = p.alpha[k];
    expect(faintAlpha).toBeCloseTo(1 / 96, 9);
    expect(alphaOf(exactKey(2.5))).toBe(2.5);
  });

  it('camera: a NaN zoom factor leaves the camera alone; a non-finite fit box gives a sane camera', () => {
    const c = { cx: 10, cy: 20, scale: 2, rot: 0 };
    expect(zoomAt(c, NaN, 100, 100, 800, 600)).toBe(c);
    const f = fitBox({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }, 800, 600);
    expect([f.cx, f.cy, f.scale, f.rot]).toEqual([0, 0, 1, 0]);
  });

  it('ledger: an evictor freeing the canvas being resized does not corrupt the byte count', () => {
    const make = () => ({ width: 300, height: 150, getContext: () => ({}) }) as unknown as HTMLCanvasElement;
    const L = createLedger('phone', make);
    const big = L.alloc(4096, 4096, 'tile')!;            // 64 MB
    const victim = L.alloc(4096, 4096, 'tile')!;
    L.onPressure(() => { L.free(victim); });
    expect(L.resize(victim, 4096, 8192)).toBe(true);     // 64 → 128 MB pushes past the 160 MB cap
    expect(L.bytes).toBe(big.width * big.height * 4 + victim.width * victim.height * 4);
    L.free(victim); L.free(big);
    expect(L.bytes).toBe(0);
  });
});

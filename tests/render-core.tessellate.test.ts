import { describe, it, expect } from 'vitest';
import { PolyKind } from '../src/core/types';
import { tracePoly, traceCentre } from '../src/render/tessellate';
import { synthCooked, along, RecordingSink, FlatSink, distToPath, type SynthPoly } from './render-core.fixtures';

const I = Float64Array.of(1, 0, 0, 1, 0, 0);

/**
 * Coverage check on a grid: inside the true stroke (distance < w/2 − tolIn) the winding must be
 * non-zero (no holes / notches); beyond 1.16·w/2 + tolOut it must be zero (no spikes).
 */
function checkCoverage(pts: [number, number, number][], opts: { kind?: PolyKind; ang?: number[]; step?: number; tolIn?: number; tolOut?: number } = {}) {
  const c = synthCooked([{ pts, kind: opts.kind, ang: opts.ang }]);
  const s = new FlatSink();
  expect(tracePoly(s, c, 0, I)).toBe(true);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, wmax = 0;
  for (const [x, y, w] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); wmax = Math.max(wmax, w); }
  const pad = wmax;
  const step = opts.step ?? 0.7;
  const holes: string[] = [], spikes: string[] = [];
  for (let y = y0 - pad; y <= y1 + pad; y += step) {
    for (let x = x0 - pad; x <= x1 + pad; x += step) {
      const { d, w } = distToPath(pts, x, y);
      const h = w / 2;
      const wn = s.winding(x, y);
      if (d < h - (opts.tolIn ?? Math.max(0.35, 0.06 * h)) && wn === 0) holes.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      const hmax = wmax / 2;
      if (d > 1.16 * Math.max(h, 0) + (opts.tolOut ?? 0.5) && d > 0.5 && wn !== 0 && d > 1.16 * hmax + (opts.tolOut ?? 0.5)) spikes.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
  }
  return { holes, spikes, sink: s };
}

describe('tessellate: ribbon coverage (no holes, notches or spikes)', { timeout: 60000 }, () => {
  it('straight constant ribbon', () => {
    const r = checkCoverage(along([[0, 0], [120, 0]], 2.4, () => 20));
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
  });

  it('thick 90° corner with dense stations (inner clamp)', () => {
    const r = checkCoverage(along([[0, 0], [80, 0], [80, 80]], 2.4, () => 40));
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
  });

  it('150° hairpin, thick', () => {
    const a = (150 * Math.PI) / 180;
    const r = checkCoverage(along([[0, 0], [90, 0], [90 + 90 * Math.cos(Math.PI - a), 90 * Math.sin(Math.PI - a)]], 2.4, () => 30));
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
  });

  it('near-reversal with long arms and a thin line (long inner miter stays inside)', () => {
    const r = checkCoverage([[0, 0, 3], [100, 0, 3], [0, 6, 3]], { step: 0.25, tolIn: 0.2 });
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
  });

  it('tight curl thicker than its radius (fold zone)', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 60; i++) { const t = (i / 60) * Math.PI * 1.6; path.push([8 * Math.cos(t), 8 * Math.sin(t)]); }
    const r = checkCoverage(along(path, 2.4, () => 40), { step: 0.6 });
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
  });

  it('short-arm thick hairpin: the inner miter is clamped (no spike out of the far side)', () => {
    const r = checkCoverage([[0, 0, 12], [10, 0, 12], [0, 3, 12]], { step: 0.25 });
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
  });

  it('closed loop thicker than its radius has no hole in the middle', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 80; i++) { const t = (i / 80) * Math.PI * 2.15; path.push([10 * Math.cos(t), 10 * Math.sin(t)]); }
    const r = checkCoverage(along(path, 2.4, () => 50), { step: 0.6 });
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
    expect(r.sink.winding(0, 0)).not.toBe(0);
  });

  it('dense jitter with a fat brush (scribble) stays solid', () => {
    const pts: [number, number, number][] = [];
    let x = 0, y = 0, seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 80; i++) { x += 2.4 * Math.cos(rnd() * 6.28); y += 2.4 * Math.sin(rnd() * 6.28); pts.push([x, y, 30]); }
    const r = checkCoverage(pts, { step: 0.7 });
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
  });

  it('zigzag crackle with 120° turns', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 12; i++) path.push([i * 6, i % 2 ? 9 : 0]);
    const r = checkCoverage(path.map(([x, y]) => [x, y, 5] as [number, number, number]), { step: 0.3 });
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
  });

  it('tapered S-curve (0 → 30 → 0)', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 80; i++) { const t = i / 80; path.push([t * 200, 40 * Math.sin(t * Math.PI * 2)]); }
    const r = checkCoverage(along(path, 2.4, t => 30 * Math.sin(Math.PI * t)), { step: 0.8, tolIn: 1.2 });
    expect(r.holes).toEqual([]);
    expect(r.spikes).toEqual([]);
  });

  it('self-crossing figure-8 unions instead of punching a hole', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 120; i++) { const t = (i / 120) * Math.PI * 2; path.push([60 * Math.sin(t), 30 * Math.sin(2 * t)]); }
    const pts = along(path, 2.4, () => 14);
    const r = checkCoverage(pts, { step: 0.8 });
    expect(r.holes).toEqual([]);
    expect(r.sink.winding(0, 0)).not.toBe(0);
  });

  it('every ribbon outline is wound the same way (negative area) whatever its direction', () => {
    for (const path of [[[0, 0], [100, 30]], [[100, 30], [0, 0]], [[0, 0], [0, -100]]] as [number, number][][]) {
      const c = synthCooked([{ pts: along(path, 2.4, () => 10) }]);
      const s = new FlatSink();
      tracePoly(s, c, 0, I);
      for (const a of s.areas()) expect(a).toBeLessThan(0);
    }
  });
});

describe('tessellate: ribbon structure', { timeout: 60000 }, () => {
  it('outline is one closed subpath: M … Z, with semicircular caps', () => {
    const c = synthCooked([{ pts: along([[0, 0], [50, 0]], 2.4, () => 10) }]);
    const s = new RecordingSink();
    tracePoly(s, c, 0, I);
    expect(s.ops[0].op).toBe('M');
    expect(s.ops[s.ops.length - 1].op).toBe('Z');
    expect(s.ops.filter(o => o.op === 'M').length).toBe(1);
    const arcs = s.ops.filter(o => o.op === 'A');
    expect(arcs.length).toBe(2);
    for (const a of arcs) { expect(a.a[2]).toBeCloseTo(5, 6); expect(Math.abs(a.a[4] - a.a[3])).toBeCloseTo(Math.PI, 6); }
  });

  it('no caps when the end is ≤ 1 device px wide', () => {
    const c = synthCooked([{ pts: [[0, 0, 0.8], [20, 0, 4], [40, 0, 0.8]] }]);
    const s = new RecordingSink();
    tracePoly(s, c, 0, I);
    expect(s.ops.filter(o => o.op === 'A').length).toBe(0);
  });

  it('smooth curves use midpoint quadratic Béziers', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 40; i++) { const t = i / 40; path.push([100 * Math.cos(t), 100 * Math.sin(t)]); }
    const c = synthCooked([{ pts: along(path, 2.4, () => 8) }]);
    const s = new RecordingSink();
    tracePoly(s, c, 0, I);
    expect(s.ops.filter(o => o.op === 'Q').length).toBeGreaterThan(40);
  });

  it('sharp corner: round join (arc of radius w/2) on the outer side, pivot through the vertex inside', () => {
    const pts = along([[0, 0], [60, 0], [60, 60]], 2.4, () => 30);
    const c = synthCooked([{ pts }]);
    const s = new RecordingSink();
    tracePoly(s, c, 0, I);
    const joins = s.ops.filter(o => o.op === 'A' && Math.abs(Math.abs(o.a[4] - o.a[3]) - Math.PI) > 1e-6);
    expect(joins.length).toBe(1);
    expect(joins[0].a[0]).toBeCloseTo(60, 6);
    expect(joins[0].a[1]).toBeCloseTo(0, 6);
    expect(joins[0].a[2]).toBeCloseTo(15, 6);
    expect(s.ops.some(o => o.op === 'L' && Math.abs(o.a[0] - 60) < 1e-9 && Math.abs(o.a[1]) < 1e-9)).toBe(true);
  });

  it('thin crisp corner keeps an exact inner miter (no pivot) when the segments are long enough', () => {
    const c = synthCooked([{ pts: [[0, 0, 4], [60, 0, 4], [60, 60, 4]] }]);
    const s = new RecordingSink();
    tracePoly(s, c, 0, I);
    // inner miter of a right turn (toward +y, side A): (60 − 2, 0 + 2)
    expect(s.ops.some(o => (o.op === 'L' || o.op === 'M') && Math.abs(o.a[0] - 58) < 1e-9 && Math.abs(o.a[1] - 2) < 1e-9)).toBe(true);
  });

  it('transforms by the matrix: widths scale with it', () => {
    const c = synthCooked([{ pts: [[0, 0, 2], [10, 0, 2]] }]);
    const m = Float64Array.of(3, 0, 0, 3, 100, 50);
    const s = new RecordingSink();
    tracePoly(s, c, 0, m);
    const arcs = s.ops.filter(o => o.op === 'A');
    expect(arcs[0].a[2]).toBeCloseTo(3, 9);
    expect(s.ops[0].a[0]).toBeCloseTo(100, 9);
    expect(s.ops[0].a[1]).toBeCloseTo(53, 9);
  });

  it('widthScale multiplies the device width', () => {
    const c = synthCooked([{ pts: [[0, 0, 2], [10, 0, 2]] }]);
    const s = new RecordingSink();
    tracePoly(s, c, 0, I, { widthScale: 2.5 });
    expect(s.ops.find(o => o.op === 'A')!.a[2]).toBeCloseTo(2.5, 9);
  });
});

describe('tessellate: reveal, ranges, morph', { timeout: 60000 }, () => {
  const straight = (): SynthPoly => ({ pts: along([[0, 0], [100, 0]], 2.5, () => 6) });

  it('prefix reveal interpolates the end point and ends in a round tip', () => {
    const c = synthCooked([straight()]);
    const s = new RecordingSink();
    expect(tracePoly(s, c, 0, I, { reveal: 0.437 })).toBe(true);
    const tipArc = s.ops.filter(o => o.op === 'A')[0];
    expect(tipArc.a[0]).toBeCloseTo(43.7, 4);
    expect(tipArc.a[1]).toBeCloseTo(0, 6);
    const f = new FlatSink();
    tracePoly(f, c, 0, I, { reveal: 0.437 });
    expect(f.winding(43.7 + 2.5, 0)).not.toBe(0);
    expect(f.winding(43.7 + 3.5, 0)).toBe(0);
  });

  it('reveal 0 draws nothing; reveal 1 equals no reveal', () => {
    const c = synthCooked([straight()]);
    expect(tracePoly(new RecordingSink(), c, 0, I, { reveal: 0 })).toBe(false);
    const a = new RecordingSink(), b = new RecordingSink();
    tracePoly(a, c, 0, I, { reveal: 1 }); tracePoly(b, c, 0, I);
    expect(a.ops).toEqual(b.ops);
  });

  it('adjacent arc ranges share their cut edge exactly (no gap, no overlap)', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 50; i++) { const t = i / 50; path.push([t * 120, 30 * Math.sin(t * 3)]); }
    const pts = along(path, 2.4, t => 6 + 10 * t);
    const c = synthCooked([{ pts }]);
    const cut = 47.31;
    const A = new FlatSink(), B = new FlatSink(), Ar = new RecordingSink(), Br = new RecordingSink();
    tracePoly(A, c, 0, I, { arcTo: cut }); tracePoly(B, c, 0, I, { arcFrom: cut });
    tracePoly(Ar, c, 0, I, { arcTo: cut }); tracePoly(Br, c, 0, I, { arcFrom: cut });
    // the flat edge endpoints coincide bit for bit
    const aPts = Ar.ops.filter(o => o.op !== 'Z' && o.op !== 'A').map(o => o.a.slice(-2).join(','));
    const bPts = Br.ops.filter(o => o.op !== 'Z' && o.op !== 'A').map(o => o.a.slice(-2).join(','));
    const shared = aPts.filter(p => bPts.includes(p));
    expect(shared.length).toBeGreaterThanOrEqual(2);
    let both = 0, gaps = 0;
    for (let y = -40; y <= 50; y += 0.5) for (let x = -10; x <= 130; x += 0.5) {
      const { d, w } = distToPath(pts, x, y);
      const ia = A.winding(x, y) !== 0, ib = B.winding(x, y) !== 0;
      if (ia && ib) both++;
      if (d < w / 2 - 0.4 && !ia && !ib) gaps++;
    }
    expect(gaps).toBe(0);
    expect(both).toBe(0);
  });

  it('morph draws at lerp(from, to, t)', () => {
    const c = synthCooked([{ pts: [[0, 0, 4], [10, 0, 4]] }]);
    const from = new Float32Array([0, 20, 10, 20]);
    const s = new RecordingSink();
    tracePoly(s, c, 0, I, { morphFrom: from, morphT: 0.25 });
    const arcs = s.ops.filter(o => o.op === 'A');
    for (const a of arcs) expect(a.a[1]).toBeCloseTo(15, 6);
  });
});

describe('tessellate: chunk joints', { timeout: 60000 }, () => {
  it('trunk chunks sharing a point weld with one shared flat edge (no double-added bead)', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 40; i++) { const t = i / 40; path.push([t * 100, 20 * Math.sin(t * 2.5)]); }
    const all = along(path, 2.4, () => 14);
    const k = 17;
    const c = synthCooked([
      { pts: all.slice(0, k + 1), gen: 0, unit: 0, tone: 3 },
      { pts: all.slice(k), gen: 0, unit: 1, tone: 9 },
    ]);
    const A = new FlatSink(), B = new FlatSink(), Ar = new RecordingSink();
    tracePoly(A, c, 0, I); tracePoly(B, c, 1, I); tracePoly(Ar, c, 0, I);
    expect(Ar.ops.filter(o => o.op === 'A').length).toBe(1);   // start cap only
    let both = 0, gaps = 0;
    for (let y = -30; y <= 40; y += 0.5) for (let x = -10; x <= 110; x += 0.5) {
      const { d, w } = distToPath(all, x, y);
      const ia = A.winding(x, y) !== 0, ib = B.winding(x, y) !== 0;
      if (ia && ib) both++;
      if (d < w / 2 - 0.4 && !ia && !ib) gaps++;
    }
    expect(gaps).toBe(0);
    expect(both).toBe(0);
  });

  it('a sharp turn at the shared point falls back to caps; joins:false disables welding', () => {
    const c = synthCooked([
      { pts: [[0, 0, 6], [20, 0, 6]], gen: 0 },
      { pts: [[20, 0, 6], [20, 20, 6]], gen: 0 },
    ]);
    const s = new RecordingSink();
    tracePoly(s, c, 0, I);
    expect(s.ops.filter(o => o.op === 'A').length).toBe(2);
    const c2 = synthCooked([{ pts: [[0, 0, 6], [20, 0, 6]] }, { pts: [[20, 0, 6], [40, 1, 6]] }]);
    const w = new RecordingSink(), nw = new RecordingSink();
    tracePoly(w, c2, 0, I); tracePoly(nw, c2, 0, I, { joins: false });
    expect(w.ops.filter(o => o.op === 'A').length).toBe(1);
    expect(nw.ops.filter(o => o.op === 'A').length).toBe(2);
  });

  it('joinStart / joinEnd turn a welded end back into a round tip', () => {
    const c = synthCooked([{ pts: [[0, 0, 6], [20, 0, 6]] }, { pts: [[20, 0, 6], [40, 1, 6]] }]);
    const a = new RecordingSink(), b = new RecordingSink();
    tracePoly(a, c, 0, I, { joinEnd: false });
    tracePoly(b, c, 1, I, { joinStart: false });
    expect(a.ops.filter(o => o.op === 'A').length).toBe(2);
    expect(b.ops.filter(o => o.op === 'A').length).toBe(2);
    const w = new RecordingSink();
    tracePoly(w, c, 1, I, { joinEnd: false });   // the start still welds
    expect(w.ops.filter(o => o.op === 'A').length).toBe(1);
  });

  it('different generations or units (gen ≥ 1) never weld', () => {
    const c = synthCooked([
      { pts: [[0, 0, 6], [20, 0, 6]], gen: 1, unit: 3 },
      { pts: [[20, 0, 6], [40, 0, 6]], gen: 1, unit: 4 },
    ]);
    const s = new RecordingSink();
    tracePoly(s, c, 0, I);
    expect(s.ops.filter(o => o.op === 'A').length).toBe(2);
  });
});

describe('tessellate: chisel', { timeout: 60000 }, () => {
  it('quads + core in one path, every subpath wound like a ribbon', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 60; i++) { const t = (i / 60) * Math.PI * 2; path.push([50 * Math.cos(t), 50 * Math.sin(t)]); }
    const pts = along(path, 2.4, () => 16);
    const c = synthCooked([{ kind: PolyKind.Chisel, pts, ang: pts.map(() => 0.7) }]);
    const s = new FlatSink();
    expect(tracePoly(s, c, 0, I)).toBe(true);
    const areas = s.areas();
    expect(areas.length).toBeGreaterThan(pts.length - 5);
    for (const a of areas) expect(a).toBeLessThan(0);
  });

  it('covers the swept nib segment, including where the travel passes through the nib angle', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 60; i++) { const t = (i / 60) * Math.PI * 2; path.push([50 * Math.cos(t), 50 * Math.sin(t)]); }
    const pts = along(path, 2.4, () => 16);
    const th = 0.7;
    const c = synthCooked([{ kind: PolyKind.Chisel, pts, ang: pts.map(() => th) }]);
    const s = new FlatSink();
    tracePoly(s, c, 0, I);
    const ex = 8 * Math.cos(th), ey = 8 * Math.sin(th);
    let holes = 0;
    // (the first/last stations' nib segments ARE the flat ends: samples there sit on the boundary)
    for (const [x, y] of pts.slice(1, -1)) for (let u = -0.9; u <= 0.9; u += 0.1) if (s.winding(x + ex * u, y + ey * u) === 0) holes++;
    expect(holes).toBe(0);
    expect(s.winding(0, 0)).toBe(0);
    expect(s.winding(80, 0)).toBe(0);
  });

  it('chisel chunks sharing a point weld along the nib line: no double-added bow-tie, no gap', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 40; i++) { const t = i / 40; path.push([t * 120, 25 * Math.sin(t * 3)]); }
    const all = along(path, 2.4, () => 20);
    for (const th of [0.7, 1.2, 0.15, -0.4]) {
      for (const k of [9, 20, 31]) {
        const c = synthCooked([
          { kind: PolyKind.Chisel, pts: all.slice(0, k + 1), ang: Array(k + 1).fill(th), gen: 0, tone: 3 },
          { kind: PolyKind.Chisel, pts: all.slice(k), ang: Array(all.length - k).fill(th), gen: 0, tone: 9 },
        ]);
        const A = new FlatSink(), B = new FlatSink();
        tracePoly(A, c, 0, I); tracePoly(B, c, 1, I);
        let both = 0;
        const [jx, jy] = all[k];
        for (let y = jy - 14; y <= jy + 14; y += 0.25) for (let x = jx - 14; x <= jx + 14; x += 0.25) {
          if (A.winding(x, y) !== 0 && B.winding(x, y) !== 0) both++;
        }
        const trav = Math.atan2(all[k + 1][1] - all[k - 1][1], all[k + 1][0] - all[k - 1][0]);
        const alpha = (Math.abs(trav - th) * 180) / Math.PI;
        // exact partition along the nib line; a nib sliding along its own length (< 10°) is left
        // unclipped and may overlap in a thin sliver (declared limitation)
        if (alpha > 10.5) expect(both).toBe(0);
        else expect(both * 0.0625).toBeLessThan(0.1 * 20 * 20);
      }
    }
  });

  it('chisel ends are flat along the nib (the core never pokes past them)', () => {
    const th = 0.6;
    const c = synthCooked([{ kind: PolyKind.Chisel, pts: along([[0, 0], [60, 0]], 2.4, () => 20), ang: Array(26).fill(th) }]);
    const s = new FlatSink();
    tracePoly(s, c, 0, I);
    // just beyond the end nib line through (60, 0): nothing; just inside: covered
    const nx = -Math.sin(th), ny = Math.cos(th);   // unit normal of the nib line
    const side = (x: number, y: number) => (x - 60) * nx + (y - 0) * ny;
    let poke = 0;
    for (let y = -10; y <= 10; y += 0.2) for (let x = 50; x <= 70; x += 0.2) {
      if (side(x, y) * Math.sign(side(70, 0)) > 0.3 && s.winding(x, y) !== 0) poke++;
    }
    expect(poke).toBe(0);
    expect(s.winding(59, 0)).not.toBe(0);
  });

  it('nib nearly parallel to the travel: no holes anywhere in the swept nib', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 50; i++) { const t = i / 50; path.push([t * 100, 8 * Math.sin(t * 6)]); }
    const all = along(path, 2.4, () => 40);
    const th = Math.atan2(8 * 6 * Math.cos(0) / 100, 1);   // matches the travel at the start
    const k = 7;
    const c = synthCooked([
      { kind: PolyKind.Chisel, pts: all.slice(0, k + 1), ang: Array(k + 1).fill(th), gen: 0, tone: 3 },
      { kind: PolyKind.Chisel, pts: all.slice(k), ang: Array(all.length - k).fill(th), gen: 0, tone: 3 },
    ]);
    const s = new FlatSink();
    tracePoly(s, c, 0, I); tracePoly(s, c, 1, I);
    const ex = 20 * Math.cos(th), ey = 20 * Math.sin(th);
    let holes = 0;
    for (const [x, y] of all) for (let u = -0.9; u <= 0.9; u += 0.05) if (s.winding(x + ex * u, y + ey * u) === 0) holes++;
    expect(holes).toBe(0);
  });

  it('a stroke parallel to the nib keeps the core minimum thickness', () => {
    const th = 0;
    const c = synthCooked([{ kind: PolyKind.Chisel, pts: along([[0, 0], [60, 0]], 2.4, () => 20), ang: Array(26).fill(th) }]);
    const s = new FlatSink();
    expect(tracePoly(s, c, 0, I)).toBe(true);
    expect(s.winding(30, 1.2)).not.toBe(0);    // core half = 0.075·20 = 1.5
    expect(s.winding(30, 2.2)).toBe(0);
  });
});

describe('tessellate: dots, hairlines, edge cases', { timeout: 60000 }, () => {
  it('dot: a disc of diameter w; reveal scales it; tiny dots draw at minDevWidth', () => {
    const c = synthCooked([{ pts: [[5, 5, 8]] }]);
    const s = new RecordingSink();
    expect(tracePoly(s, c, 0, I)).toBe(true);
    expect(s.ops.filter(o => o.op === 'A').map(o => o.a[2])).toEqual([4, 4]);
    const r = new RecordingSink();
    tracePoly(r, c, 0, I, { reveal: 0.5 });
    expect(r.ops.find(o => o.op === 'A')!.a[2]).toBeCloseTo(2, 9);
    const tiny = synthCooked([{ pts: [[0, 0, 0.2]] }]);
    const t = new RecordingSink();
    tracePoly(t, tiny, 0, I);
    expect(t.ops.find(o => o.op === 'A')!.a[2]).toBeCloseTo(0.5, 9);
    const f = new FlatSink();
    tracePoly(f, c, 0, I);
    expect(f.areas()[0]).toBeLessThan(0);
  });

  it('hairline: thin ribbons return false from tracePoly; traceCentre gives the centreline', () => {
    const c = synthCooked([{ pts: along([[0, 0], [40, 10]], 2.4, () => 0.6) }]);
    expect(tracePoly(new RecordingSink(), c, 0, I)).toBe(false);
    expect(tracePoly(new RecordingSink(), c, 0, I, { minDevWidth: 0 })).toBe(true);
    const s = new RecordingSink();
    expect(traceCentre(s, c, 0, I)).toBe(true);
    expect(s.ops[0]).toEqual({ op: 'M', a: [0, 0] });
    const last = s.ops[s.ops.length - 1];
    expect(last.op).toBe('L');
    expect(last.a[0]).toBeCloseTo(40, 4);
    expect(last.a[1]).toBeCloseTo(10, 4);
  });

  it('degenerate polys: all points coincide → a disc; out-of-range index → false', () => {
    const c = synthCooked([{ pts: [[3, 3, 6], [3, 3, 6], [3, 3, 6]], kind: PolyKind.Ribbon }]);
    const s = new FlatSink();
    expect(tracePoly(s, c, 0, I)).toBe(true);
    expect(s.winding(3, 3)).not.toBe(0);
    expect(tracePoly(s, c, 5, I)).toBe(false);
    expect(tracePoly(s, c, -1, I)).toBe(false);
  });

  it('allocation-free steady state: repeated traces give identical output', () => {
    const c = synthCooked([{ pts: along([[0, 0], [30, 40], [80, 10]], 2.4, t => 4 + 8 * t) }]);
    const a = new RecordingSink(), b = new RecordingSink();
    tracePoly(a, c, 0, I);
    for (let k = 0; k < 5; k++) tracePoly(new RecordingSink(), c, 0, I);
    tracePoly(b, c, 0, I);
    expect(a.ops).toEqual(b.ops);
  });
});

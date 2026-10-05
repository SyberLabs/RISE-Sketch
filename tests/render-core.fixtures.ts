/**
 * render-core test fixtures (also imported by sandbox/render-core): a hand-built Cooked
 * builder, a recording PathSink and a flattening PathSink that measures nonzero winding.
 */
import type { AABB, Cooked } from '../src/core/types';
import { PolyKind } from '../src/core/types';
import type { PathSink } from '../src/render/tessellate';

export interface SynthPoly {
  kind?: PolyKind;
  /** [x, y, w] per point, doc units relative to origin. */
  pts: readonly (readonly [number, number, number])[];
  /** Chisel nib angle per point (radians, doc). */
  ang?: readonly number[];
  gen?: number; tone?: number; alpha?: number; born?: number; unit?: number;
  /** Arc offset of the first point (sp); default 0. */
  a0?: number;
}

/**
 * Build a Cooked from synthetic polys. Arc `a` = cumulative doc distance × z (sp), boxes include
 * w/2, polys are sorted by gen (stable), genStart is filled. `origin` shifts inkBox/hitBox.
 */
export function synthCooked(polys: readonly SynthPoly[], z = 1, origin: readonly [number, number] = [0, 0]): Cooked {
  const order = polys.map((p, i) => ({ p, i })).sort((a, b) => (a.p.gen ?? 0) - (b.p.gen ?? 0) || a.i - b.i).map(e => e.p);
  const nPolys = order.length;
  const nPts = order.reduce((s, p) => s + p.pts.length, 0);
  const pts = new Float32Array(nPts * 4);
  const anyChisel = order.some(p => p.kind === PolyKind.Chisel);
  const ang = anyChisel ? new Float32Array(nPts) : null;
  const start = new Uint32Array(nPolys), count = new Uint32Array(nPolys);
  const kind = new Uint8Array(nPolys), gen = new Uint8Array(nPolys), tone = new Uint8Array(nPolys);
  const alpha = new Float32Array(nPolys), born = new Float32Array(nPolys), unit = new Uint32Array(nPolys);
  const box = new Float32Array(nPolys * 4);
  let w = 0, maxGen = 0;
  const ink: AABB = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  order.forEach((p, i) => {
    start[i] = w; count[i] = p.pts.length;
    kind[i] = p.kind ?? (p.pts.length === 1 ? PolyKind.Dot : PolyKind.Ribbon);
    gen[i] = p.gen ?? 0; tone[i] = p.tone ?? 20; alpha[i] = p.alpha ?? 1; born[i] = p.born ?? 0; unit[i] = p.unit ?? i;
    maxGen = Math.max(maxGen, gen[i]);
    let a = p.a0 ?? 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    p.pts.forEach(([x, y, ww], j) => {
      if (j > 0) { const [px, py] = p.pts[j - 1]; a += Math.hypot(x - px, y - py) * z; }
      pts[4 * w] = x; pts[4 * w + 1] = y; pts[4 * w + 2] = ww; pts[4 * w + 3] = a;
      if (ang) ang[w] = p.ang ? p.ang[j] : 0.698;
      const r = ww / 2;
      x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r);
      w++;
    });
    box[4 * i] = x0; box[4 * i + 1] = y0; box[4 * i + 2] = x1; box[4 * i + 3] = y1;
    ink.x0 = Math.min(ink.x0, x0 + origin[0]); ink.y0 = Math.min(ink.y0, y0 + origin[1]);
    ink.x1 = Math.max(ink.x1, x1 + origin[0]); ink.y1 = Math.max(ink.y1, y1 + origin[1]);
  });
  const genStart = new Uint32Array(maxGen + 2);
  for (let g = 0; g <= maxGen + 1; g++) {
    let k = 0;
    while (k < nPolys && gen[k] < g) k++;
    genStart[g] = k;
  }
  const bytes = pts.byteLength + (ang ? ang.byteLength : 0) + start.byteLength * 2 + nPolys * 3 + alpha.byteLength * 2 + unit.byteLength + box.byteLength + genStart.byteLength;
  return {
    pts, ang, start, count, kind, gen, tone, alpha, born, unit, box, genStart, nPolys, nPts,
    inkBox: ink, hitBox: { ...ink }, ceilingMax: 0, coverage: 0, bytes,
  };
}

/** Points along a polyline, resampled every `step` doc units, with width from `wf(t)` (t = 0..1 arc fraction). */
export function along(path: readonly (readonly [number, number])[], step: number, wf: (t: number) => number): [number, number, number][] {
  const segs: number[] = [0];
  for (let i = 1; i < path.length; i++) segs.push(segs[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const L = segs[segs.length - 1];
  const out: [number, number, number][] = [];
  const n = Math.max(1, Math.round(L / step));
  let k = 1;
  for (let s = 0; s <= n; s++) {
    const d = (L * s) / n;
    while (k < path.length - 1 && segs[k] < d) k++;
    const t = segs[k] > segs[k - 1] ? (d - segs[k - 1]) / (segs[k] - segs[k - 1]) : 0;
    const x = path[k - 1][0] + (path[k][0] - path[k - 1][0]) * t, y = path[k - 1][1] + (path[k][1] - path[k - 1][1]) * t;
    out.push([x, y, wf(L > 0 ? d / L : 0)]);
  }
  return out;
}

/** Sink that records every call. */
export class RecordingSink implements PathSink {
  ops: { op: string; a: number[] }[] = [];
  moveTo(x: number, y: number): void { this.ops.push({ op: 'M', a: [x, y] }); }
  lineTo(x: number, y: number): void { this.ops.push({ op: 'L', a: [x, y] }); }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void { this.ops.push({ op: 'Q', a: [cx, cy, x, y] }); }
  closePath(): void { this.ops.push({ op: 'Z', a: [] }); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void { this.ops.push({ op: 'A', a: [x, y, r, a0, a1, ccw ? 1 : 0] }); }
}

/**
 * Sink that flattens Béziers and arcs (Canvas2D semantics, including the implicit line to an
 * arc's start) into closed polygons, for winding-number coverage tests.
 */
export class FlatSink implements PathSink {
  polys: number[][] = [];
  private cur: number[] | null = null;
  private x = 0; private y = 0;
  private sx = 0; private sy = 0;
  private pt(x: number, y: number): void { this.cur!.push(x, y); this.x = x; this.y = y; }
  moveTo(x: number, y: number): void { this.flush(); this.cur = [x, y]; this.x = this.sx = x; this.y = this.sy = y; }
  lineTo(x: number, y: number): void { if (!this.cur) this.moveTo(x, y); else this.pt(x, y); }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    const x0 = this.x, y0 = this.y;
    for (let i = 1; i <= 16; i++) {
      const t = i / 16, u = 1 - t;
      this.pt(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
    }
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    const TAU = Math.PI * 2;
    let sweep: number;
    if (ccw) { const d = a0 - a1; sweep = d >= TAU ? -TAU : -(((d % TAU) + TAU) % TAU); }
    else { const d = a1 - a0; sweep = d >= TAU ? TAU : ((d % TAU) + TAU) % TAU; }
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / 0.03));
    const sx = x + r * Math.cos(a0), sy = y + r * Math.sin(a0);
    if (!this.cur) this.moveTo(sx, sy); else this.pt(sx, sy);
    for (let i = 1; i <= n; i++) { const a = a0 + (sweep * i) / n; this.pt(x + r * Math.cos(a), y + r * Math.sin(a)); }
  }
  closePath(): void { if (this.cur) { this.pt(this.sx, this.sy); this.flush(); } }
  private flush(): void { if (this.cur && this.cur.length >= 6) this.polys.push(this.cur); this.cur = null; }
  /** Nonzero winding number of the accumulated path at (px, py). */
  winding(px: number, py: number): number {
    this.flush();
    let w = 0;
    for (const p of this.polys) {
      const n = p.length / 2;
      for (let i = 0; i < n; i++) {
        const x0 = p[2 * i], y0 = p[2 * i + 1], j = (i + 1) % n, x1 = p[2 * j], y1 = p[2 * j + 1];
        if (y0 <= py) { if (y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) w++; }
        else if (y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) w--;
      }
    }
    return w;
  }
  /** Signed shoelace area of each subpath. */
  areas(): number[] {
    this.flush();
    return this.polys.map(p => {
      let a = 0;
      const n = p.length / 2;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]; }
      return a / 2;
    });
  }
}

/** Distance from (px, py) to a polyline and the interpolated width there. */
export function distToPath(pts: readonly (readonly [number, number, number])[], px: number, py: number): { d: number; w: number } {
  let best = Infinity, bw = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay, aw] = pts[i - 1], [bx, by, bw2] = pts[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + dx * t - px, ay + dy * t - py);
    if (d < best) { best = d; bw = aw + (bw2 - aw) * t; }
  }
  if (pts.length === 1) { best = Math.hypot(pts[0][0] - px, pts[0][1] - py); bw = pts[0][2]; }
  return { d: best, w: bw };
}

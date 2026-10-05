/**
 * Tessellation of cooked polys into closed device-space outlines. Spec: docs/DESIGN.md §6.3,
 * §6.4, §6.6. PURE: no DOM types; it writes to a PathSink, which CanvasRenderingContext2D,
 * OffscreenCanvasRenderingContext2D and an SVG path builder all satisfy.
 *
 * Coverage guarantee (why there are no holes, notches or spikes). Every outline is built so it
 * decomposes into positively-wound pieces only: one trapezoid per segment, one wedge per outer
 * join, one half-disc per cap. Every poly is wound the same way (negative shoelace area in device
 * space), so under the nonzero rule the union of overlapping pieces, polys and subpaths is filled
 * and winding never cancels:
 *  - outer side of a turn ≤ 60°: one miter point (≤ 1.155·w/2; Bézier-smoothed up to 25°,
 *    crisp beyond, so drawn corners stay corners);
 *  - outer side of a turn > 60°: an exact round join (`arc`) between the two segment offsets;
 *  - inner side: the miter point when its retreat along both adjacent segments is ≤ half their
 *    length (a crisp, correct inner corner), otherwise the "pivot" through the centreline vertex
 *    (offset → vertex → offset). The pivot is what clamps inner offsets: a thick ribbon at a
 *    sharp corner or in a tight curl never folds into a notch, a reversed loop or a spike;
 *  - ends: semicircular caps (`arc`) when the end is wider than 1 device px; flat shared edges
 *    at cuts (arc ranges) and at welded chunk joints, so adjacent pieces share an edge exactly.
 * Smooth runs are drawn as midpoint quadratic Béziers (control = outline vertex, anchors =
 * midpoints), so 32× zoom shows no facets; corners, pivots and cap/join anchors are sharp.
 *
 * Flat ends partition the ink between neighbours (they are separate fills, so any overlap would
 * double-add under 'lighter'). A vertex near a flat end reaches across it by up to w/2·sin(turn),
 * so the outline entries generated near a flat end are clipped to its side of the edge
 * (clipOutline). That is exact on curves and at corners up to 30°. Past 30° a straight edge is no
 * longer the true split and the clip is skipped; the remaining overlap at a cut or weld lying
 * within ~w/2 of such a corner is a declared limitation. A flat end exactly at a corner station
 * (≤ 60°) splits on the bisector and is exact (welds, and cuts snapped onto stations, see snapCut).
 *
 * Chisel polys are one subpath per swept-nib quad plus the 0.15E core, every piece wound like a
 * ribbon; near flat ends the pieces are convex polygons clipped on the end's nib line (see
 * emitChisel). Dots are discs. Contract notes: Cooked `w` already carries the envelope (tapers),
 * so nothing here re-applies it; the chisel core width is derived from E (no S in Cooked).
 *
 * All arithmetic is in device px (points are transformed by `m` first), so widths, cap and
 * hairline thresholds are true on-screen sizes. Scratch buffers are module-level and grow only,
 * so tracing allocates nothing.
 */
import type { Cooked, Mat2x3 } from '../core/types';
import { PolyKind } from '../core/types';

/** Minimal path builder interface (Canvas2D and SVG builders satisfy it). */
export interface PathSink {
  moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void; closePath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
}

/** Per-trace options. All fields optional. */
export interface TraceOpts {
  reveal?: number;                  // prefix 0..1 of the poly's arc (interpolated end point)
  morphFrom?: Float32Array | null;  // stride-2 'from' positions aligned with c.pts (for this poly's points)
  morphT?: number;                  // 0..1
  widthScale?: number;
  minDevWidth?: number;             // hairline threshold (device px), default 1
  /**
   * Arc range (sp along the poly, same units as pts `a`). Interior cuts get FLAT ends whose edge
   * is computed from the raw segment containing the cut (or the vertex bisector at a station),
   * so ranges [a, b] and [b, c] of the same poly share their cut edge exactly (hot-window chunks,
   * DESIGN §3.2). Cut values snap (by at most 2 device px) onto the poly's ends, a 1 px grid and
   * gentle corner stations, so nearly coincident cuts never leave a sub-pixel sliver between two
   * fills (see snapCut). An empty range draws nothing. `reveal` instead ends in a round growing
   * tip. When both end limits are given the nearer one wins.
   */
  arcFrom?: number;
  arcTo?: number;
  /**
   * Weld to adjacent chunk polys (default true): when poly i−1's last point equals poly i's first
   * point (same kind and gen, and same unit unless gen 0) and the turn there is ≤ 60°, both polys
   * end in the same flat miter edge instead of overlapping round caps, so trunk chunks and Drift
   * thirds never double-add a bead under 'lighter'.
   */
  joins?: boolean;
  /**
   * Per-end weld switches (default true, and only meaningful when `joins` is on). A renderer that
   * reveals chunks one by one turns `joinStart` off while the predecessor is not fully drawn and
   * `joinEnd` off while the successor has not started, so a visible chunk end is a round tip.
   */
  joinStart?: boolean;
  joinEnd?: boolean;
}

// ---------------------------------------------------------------------------- constants

const CHISEL = PolyKind.Chisel, DOT = PolyKind.Dot;
/** Points closer than this (device px) to the previous kept point are dropped. */
const MIN_SEG = 0.25;
/** Arc cuts snap to this grid (device px along the poly), and onto poly ends within END_SNAP px. */
const CUT_QUANTUM = 1, END_SNAP = 2;
/** Caps and join arcs only when the half-width exceeds this (i.e. the end is wider than 1 px). */
const CAP_MIN = 0.5;
/** cos 60°: turns sharper than this get round joins on the outer side. */
const COS60 = 0.5;
/**
 * cos 25°: miter vertices turning more than this stay crisp (sharp) instead of Bézier-smoothed,
 * so drawn corners stay corners and the smoothing never cuts noticeably inside the true edge.
 */
const COS25 = 0.9063077870366499;
/** Chisel core half-width as a fraction of the edge length E (core = 0.15E ≈ 0.12S at p = 0.5). */
const CORE_HALF = 0.075;
/** Joints weld only below this turn (cos 60°); sharper joints fall back to caps. */
const JOINT_COS = 0.5;

const SMOOTH = 0, SHARP = 1, ARC = 2;
const END_CAP = 0, END_FLAT = 1;

// ---------------------------------------------------------------------------- scratch

let pcap = 0;
let PX = new Float64Array(0), PY = new Float64Array(0), PH = new Float64Array(0);
let EX = new Float64Array(0), EY = new Float64Array(0);
let SX = new Float64Array(0), SY = new Float64Array(0), SL = new Float64Array(0);
function ensurePts(n: number): void {
  if (n <= pcap) return;
  let c = pcap || 64;
  while (c < n) c *= 2;
  PX = new Float64Array(c); PY = new Float64Array(c); PH = new Float64Array(c);
  EX = new Float64Array(c); EY = new Float64Array(c);
  SX = new Float64Array(c); SY = new Float64Array(c); SL = new Float64Array(c);
  pcap = c;
}

let ocap = 0, ON = 0;
let OX = new Float64Array(0), OY = new Float64Array(0), OF = new Uint8Array(0), OM = new Uint8Array(0);
let ACX = new Float64Array(0), ACY = new Float64Array(0), ACR = new Float64Array(0), AA0 = new Float64Array(0), AA1 = new Float64Array(0);
function ensureOut(n: number): void {
  if (n <= ocap) return;
  let c = ocap || 256;
  while (c < n) c *= 2;
  const grow = (a: Float64Array): Float64Array<ArrayBuffer> => { const b = new Float64Array(c); b.set(a.subarray(0, ON)); return b; };
  OX = grow(OX); OY = grow(OY); ACX = grow(ACX); ACY = grow(ACY); ACR = grow(ACR); AA0 = grow(AA0); AA1 = grow(AA1);
  const f = new Uint8Array(c); f.set(OF.subarray(0, ON)); OF = f;
  const mk = new Uint8Array(c); mk.set(OM.subarray(0, ON)); OM = mk;
  ocap = c;
}
/** Clip-zone mask stamped on every pushed outline entry (see emitRibbon). */
let curMask = 0;
function push(x: number, y: number, f: number): void {
  if (ON >= ocap) ensureOut(ON + 1);
  OX[ON] = x; OY[ON] = y; OF[ON] = f; OM[ON] = curMask; ON++;
}
// second outline buffer (flat-end clipping)
let qcap = 0;
let QX = new Float64Array(0), QY = new Float64Array(0), QF = new Uint8Array(0), QM = new Uint8Array(0);
let QCX = new Float64Array(0), QCY = new Float64Array(0), QCR = new Float64Array(0), QA0 = new Float64Array(0), QA1 = new Float64Array(0);
function ensureQ(n: number): void {
  if (n <= qcap) return;
  let c = qcap || 256;
  while (c < n) c *= 2;
  QX = new Float64Array(c); QY = new Float64Array(c); QF = new Uint8Array(c); QM = new Uint8Array(c);
  QCX = new Float64Array(c); QCY = new Float64Array(c); QCR = new Float64Array(c); QA0 = new Float64Array(c); QA1 = new Float64Array(c);
  qcap = c;
}

/** Arc around (cx, cy) from angle a0 by `sweep` (negative = decreasing angle); (ex, ey) is its end point. */
function pushArc(cx: number, cy: number, r: number, a0: number, sweep: number, ex: number, ey: number): void {
  if (ON >= ocap) ensureOut(ON + 1);
  OX[ON] = ex; OY[ON] = ey; OF[ON] = ARC; OM[ON] = curMask;
  ACX[ON] = cx; ACY[ON] = cy; ACR[ON] = r; AA0[ON] = a0; AA1[ON] = a0 + sweep;
  ON++;
}

// gather results (module-level to avoid allocating a result object per trace)
let gN = 0, gMaxH = 0, gMaxE = 0;
let gStart = END_CAP, gEnd = END_CAP;
let gSVx = 0, gSVy = 0, gEVx = 0, gEVy = 0;
const jv = new Float64Array(2);

// ---------------------------------------------------------------------------- gather

/** Shortest signed angle difference b − a in (−π, π]. */
function angDiff(a: number, b: number): number {
  let d = (b - a) % 6.283185307179586;
  if (d > 3.141592653589793) d -= 6.283185307179586;
  else if (d <= -3.141592653589793) d += 6.283185307179586;
  return d;
}

/**
 * Device-space unit normal (−ty, tx) of raw segment (j, j+1) of the poly starting at `st`, morph
 * applied. Written to jv. Used for cut edges, so both neighbouring ranges compute it identically.
 */
function segNormal(c: Cooked, st: number, j: number, m: Mat2x3, from: Float32Array | null, mt: number): void {
  const p = c.pts;
  let x0 = p[4 * (st + j)], y0 = p[4 * (st + j) + 1], x1 = p[4 * (st + j + 1)], y1 = p[4 * (st + j + 1) + 1];
  if (from) {
    const f0 = 2 * (st + j), f1 = f0 + 2;
    x0 = from[f0] + (x0 - from[f0]) * mt; y0 = from[f0 + 1] + (y0 - from[f0 + 1]) * mt;
    x1 = from[f1] + (x1 - from[f1]) * mt; y1 = from[f1 + 1] + (y1 - from[f1 + 1]) * mt;
  }
  const dx = m[0] * (x1 - x0) + m[2] * (y1 - y0), dy = m[1] * (x1 - x0) + m[3] * (y1 - y0);
  const L = Math.sqrt(dx * dx + dy * dy);
  if (L > 0) { jv[0] = -dy / L; jv[1] = dx / L; } else { jv[0] = 0; jv[1] = 1; }
}

/**
 * Edge vector (into jv) of a cut at fraction f of raw segment j: the segment's normal, except
 * that a cut exactly on an interior station (f = 0) takes that vertex's miter when it turns by at
 * most 60°, so the two pieces split along the bisector exactly as a weld does (the straight
 * normal would leave the incoming piece's inner corner poking across into its neighbour).
 */
function cutEdge(c: Cooked, st: number, count: number, j: number, f: number, m: Mat2x3): void {
  if (f === 0 && j > 0 && miterAround(c.pts, st + j, st, st + j + 1, st + count - 1, m, xfrom, xmt)) return;
  segNormal(c, st, j, m, xfrom, xmt);
}

/**
 * Polys a and a+1 form a weldable chunk joint: shared end point (x, y, w; chisel also `ang`),
 * same kind and gen, and the same unit for gen ≥ 1.
 */
function joinable(c: Cooked, a: number): boolean {
  const b = a + 1;
  if (a < 0 || b >= c.nPolys) return false;
  const k = c.kind[a];
  if (k === DOT || k !== c.kind[b] || c.gen[a] !== c.gen[b]) return false;
  if (c.gen[a] !== 0 && c.unit[a] !== c.unit[b]) return false;
  if (c.count[a] < 2 || c.count[b] < 2) return false;
  const la = c.start[a] + c.count[a] - 1, fb = c.start[b];
  const p = c.pts, ia = 4 * la, ib = 4 * fb;
  if (p[ia] !== p[ib] || p[ia + 1] !== p[ib + 1] || p[ia + 2] !== p[ib + 2]) return false;
  // chisel neighbours split the ink on the nib line through the shared point: it must be one line
  return k !== CHISEL || !c.ang || c.ang[la] === c.ang[fb];
}

/** Position of global point g, morphed toward `from` when given; written to mpx/mpy. */
let mpx = 0, mpy = 0;
function morphedAt(p: Float32Array, g: number, from: Float32Array | null, mt: number): void {
  mpx = p[4 * g]; mpy = p[4 * g + 1];
  if (from) { mpx = from[2 * g] + (mpx - from[2 * g]) * mt; mpy = from[2 * g + 1] + (mpy - from[2 * g + 1]) * mt; }
}

/**
 * Miter vector (unit-half-width offset, n1+n2 over 1+n1·n2) of the joint between polys a and
 * a+1, written to jv. Returns false when the turn is too sharp to weld. Computed from the same
 * points in the same order whichever poly asks, so both sides get bit-identical edges. Under a
 * morph the drawn (morphed) positions are used, so the flat edge follows the geometry actually on
 * screen (both polys must be drawn with the same morph t; drawCooked unwelds them otherwise).
 */
function jointMiter(c: Cooked, a: number, m: Mat2x3, from: Float32Array | null, mt: number): boolean {
  const sa = c.start[a], na = c.count[a], sb = c.start[a + 1], nb = c.count[a + 1];
  return miterAround(c.pts, sa + na - 1, sa, sb + 1, sb + nb - 1, m, from, mt);
}

/**
 * Miter vector (into jv) at global point s, whose incoming direction comes from the nearest
 * distinct point searching back to `lo`, and outgoing from the nearest distinct point searching
 * forward from `fwd` to `hi`. False when the turn is sharper than 60° (or degenerate).
 */
function miterAround(p: Float32Array, si: number, lo: number, fwd: number, hi: number, m: Mat2x3, from: Float32Array | null, mt: number): boolean {
  morphedAt(p, si, from, mt);
  const sx = mpx, sy = mpy;
  let q = si - 1;
  for (; q > lo; q--) { morphedAt(p, q, from, mt); if (mpx !== sx || mpy !== sy) break; }
  morphedAt(p, q, from, mt);
  const qx = mpx, qy = mpy;
  let r = fwd;
  for (; r < hi; r++) { morphedAt(p, r, from, mt); if (mpx !== sx || mpy !== sy) break; }
  morphedAt(p, r, from, mt);
  const rx = mpx, ry = mpy;
  let t1x = m[0] * (sx - qx) + m[2] * (sy - qy), t1y = m[1] * (sx - qx) + m[3] * (sy - qy);
  let t2x = m[0] * (rx - sx) + m[2] * (ry - sy), t2y = m[1] * (rx - sx) + m[3] * (ry - sy);
  const l1 = Math.sqrt(t1x * t1x + t1y * t1y), l2 = Math.sqrt(t2x * t2x + t2y * t2y);
  if (!(l1 > 0 && l2 > 0)) return false;
  t1x /= l1; t1y /= l1; t2x /= l2; t2y /= l2;
  const dot = t1x * t2x + t1y * t2y;
  if (dot < JOINT_COS) return false;
  const k = 1 / (1 + dot);
  jv[0] = (-t1y - t2y) * k; jv[1] = (t1x + t2x) * k;
  return true;
}

// gather context (module-level so tracing allocates no closures)
let xc: Cooked | null = null;
let xst = 0, xfrom: Float32Array | null = null, xmt = 1, xws = 1, xsc = 1;
let xang: Float32Array | null = null;
let xm: Mat2x3 = new Float64Array(6);
/** When the range collapses to one point, keep the last (end cut) point rather than the first. */
let xKeepLast = false;
/** Both ends are flat (cut / weld): never collapse the range below two points. */
let xKeepBoth = false;

/** Arc (sp along the poly) of raw point j. */
const arcAt = (j: number): number => xc!.pts[4 * (xst + j) + 3];
/** Fraction of segment (j, j+1) at arc s. */
function frac(j: number, s: number): number {
  const a = arcAt(j), d = arcAt(j + 1) - a;
  return d > 0 ? Math.min(1, Math.max(0, (s - a) / d)) : 0;
}

/** Append raw point j (or the lerp toward j+1 at t) in device px to slot gN, with dedupe. */
function addPt(j: number, t: number, last: boolean): void {
  const p = xc!.pts, m = xm, from = xfrom, ang = xang;
  const b = 4 * (xst + j);
  let x = p[b], y = p[b + 1], w = p[b + 2];
  if (from) { const f = 2 * (xst + j); x = from[f] + (x - from[f]) * xmt; y = from[f + 1] + (y - from[f + 1]) * xmt; }
  let th = ang ? ang[xst + j] : 0;
  if (t > 0) {
    const b2 = b + 4;
    let x2 = p[b2], y2 = p[b2 + 1];
    if (from) { const f = 2 * (xst + j + 1); x2 = from[f] + (x2 - from[f]) * xmt; y2 = from[f + 1] + (y2 - from[f + 1]) * xmt; }
    x += (x2 - x) * t; y += (y2 - y) * t; w += (p[b2 + 2] - w) * t;
    if (ang) th += angDiff(th, ang[xst + j + 1]) * t;
  }
  const X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
  let H: number, ex = 0, ey = 0;
  if (ang) {
    const hw = 0.5 * w * xws, cs = Math.cos(th), sn = Math.sin(th);
    ex = (m[0] * cs + m[2] * sn) * hw; ey = (m[1] * cs + m[3] * sn) * hw;
    H = CORE_HALF * w * xws * xsc;
  } else {
    H = 0.5 * w * xws * xsc;
  }
  if (gN > 0) {
    const dx = X - PX[gN - 1], dy = Y - PY[gN - 1];
    if (dx * dx + dy * dy < MIN_SEG * MIN_SEG) {
      if (!last) return;
      if (gN >= 2) gN--;                         // keep the exact end point, drop the near one
      else if (!xKeepBoth || (dx === 0 && dy === 0)) {
        // collapsed to one point: it sits on the end that must stay exact (a cut beats a cap).
        // (Between two flat ends both points are kept: the sliver then fills its gap exactly.)
        if (xKeepLast) { PX[0] = X; PY[0] = Y; EX[0] = ex; EY[0] = ey; }
        if (H > PH[0]) PH[0] = H;
        if (H > gMaxH) gMaxH = H;
        return;
      }
    }
  }
  PX[gN] = X; PY[gN] = Y; PH[gN] = H; EX[gN] = ex; EY[gN] = ey;
  if (H > gMaxH) gMaxH = H;
  const e2 = ex * ex + ey * ey;
  if (e2 > gMaxE) gMaxE = e2;
  gN++;
}

/**
 * Arc (sp) spanned by CUT_QUANTUM device px along poly (st, count) under m, from its device
 * length; identical for every range of the same poly drawn with the same matrix.
 */
function cutQuantum(c: Cooked, st: number, count: number, m: Mat2x3, a0: number, aL: number): number {
  const p = c.pts;
  let dev = 0;
  for (let j = st + 1, end = st + count; j < end; j++) {
    const dx = p[4 * j] - p[4 * j - 4], dy = p[4 * j + 1] - p[4 * j - 3];
    const X = m[0] * dx + m[2] * dy, Y = m[1] * dx + m[3] * dy;
    dev += Math.sqrt(X * X + Y * Y);
  }
  return dev > 0 ? (CUT_QUANTUM * (aL - a0)) / dev : 0;
}

/**
 * Cut positions snap onto the poly's ends within END_SNAP device px, and elsewhere to a one-pixel
 * grid along the arc (from a0). Canvas antialiasing sums to full coverage only across fill edges
 * at the SAME position: where a pixel row holds two different edges (a cut a pixel or so from a
 * weld or from another cut, i.e. a sliver range between two fills) it comes out up to 25 % too
 * dark or too bright (measured in Chrome, for slivers of 0.04–1.4 px and quarter-pixel grids).
 * Snapped, a cut beside a poly end is no cut at all (that end welds or caps as usual, the sliver
 * range is empty) and nearby interior cuts coincide. A grid point within half a step of an interior
 * station whose vertex turns ≤ 60° moves onto that station, where the cut edge is the vertex's
 * bisector (cutEdge): the exact split, like a weld. The shift is at most END_SNAP px, invisible at
 * a hot-window boundary; both neighbours of a cut snap the same value identically.
 */
function snapCut(c: Cooked, st: number, count: number, m: Mat2x3, s: number, a0: number, aL: number, q: number): number {
  if (!(q > 0) || s !== s) return s;
  if (s - a0 <= END_SNAP * q) return a0;
  if (aL - s <= END_SNAP * q) return aL;
  const g = a0 + Math.round((s - a0) / q) * q;
  const p = c.pts;
  let lo = 0, hi = count - 1;                         // last station with arc <= g
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[4 * (st + mid) + 3] <= g) lo = mid; else hi = mid; }
  for (let j = lo; j <= lo + 1; j++) {
    if (j < 1 || j > count - 2) continue;
    const aj = p[4 * (st + j) + 3];
    if (Math.abs(aj - g) <= 0.5 * q && miterAround(p, st + j, st, st + j + 1, st + count - 1, m, xfrom, xmt)) return aj;
  }
  return g;
}

/**
 * Collect poly i's points in device px into PX/PY/PH (half-width; chisel: core half-width) and
 * EX/EY (chisel half-edge vectors), applying morph, arc range / reveal and point dedupe. Sets the
 * end modes and flat-edge vectors. Returns the number of points (0 = nothing to draw).
 */
function gather(c: Cooked, i: number, m: Mat2x3, o: TraceOpts | undefined, chisel: boolean): number {
  const st = c.start[i], count = c.count[i], p = c.pts;
  xc = c; xst = st; xm = m;
  xfrom = o && o.morphFrom ? o.morphFrom : null;
  xmt = xfrom ? clamp01(o!.morphT ?? 1) : 1;
  xws = o && o.widthScale !== undefined ? o.widthScale : 1;
  xang = chisel ? c.ang : null;
  xsc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const a0 = p[4 * st + 3], aL = p[4 * (st + count - 1) + 3];
  const hasArc = aL > a0;
  let aS = a0, aE = aL, startCut = false, endCut = false, tip = false;
  if (o) {
    if (o.reveal !== undefined) {
      const rv = o.reveal;
      if (!(rv > 0)) return 0;
      if (rv < 1 && hasArc) { aE = a0 + rv * (aL - a0); tip = true; }
    }
    const hasFrom = hasArc && o.arcFrom !== undefined, hasTo = hasArc && o.arcTo !== undefined;
    const q = hasFrom || hasTo ? cutQuantum(c, st, count, m, a0, aL) : 0;
    const from = hasFrom ? snapCut(c, st, count, m, o.arcFrom!, a0, aL, q) : a0;
    const to = hasTo ? snapCut(c, st, count, m, o.arcTo!, a0, aL, q) : aL;
    if (from > a0) { aS = Math.min(from, aL); startCut = true; }
    if (to < aE) { aE = Math.max(to, a0); endCut = true; tip = false; }
  }
  // an empty range draws nothing (never a stray full-width disc at the cut)
  if (aE < aS || ((startCut || endCut) && !(aE > aS))) return 0;
  ensurePts(count + 2);
  gN = 0; gMaxH = 0; gMaxE = 0;
  gStart = END_CAP; gEnd = END_CAP;
  const joins = !o || o.joins !== false;
  const joinS = joins && (!o || o.joinStart !== false), joinE = joins && (!o || o.joinEnd !== false);

  let j: number;
  if (startCut) {
    j = 0;
    while (j < count - 2 && arcAt(j + 1) <= aS) j++;
    const cutT = frac(j, aS);
    addPt(j, cutT, false);
    cutEdge(c, st, count, j, cutT, m);
    gStart = END_FLAT; gSVx = jv[0]; gSVy = jv[1];
    j++;
  } else {
    addPt(0, 0, count === 1);
    j = 1;
    if (count > 1 && joinS && joinable(c, i - 1) && jointMiter(c, i - 1, m, xfrom, xmt)) {
      gStart = END_FLAT; gSVx = jv[0]; gSVy = jv[1];
    }
  }
  const exactEnd = !endCut && !tip;
  // end weld decided before the points, so a sub-pixel piece between two flat ends keeps both
  const endWeld = exactEnd && count > 1 && joinE && joinable(c, i) && jointMiter(c, i, m, xfrom, xmt);
  const wvx = jv[0], wvy = jv[1];
  xKeepBoth = gStart === END_FLAT && (endCut || endWeld);
  xKeepLast = endCut && gStart !== END_FLAT;
  for (; j < count; j++) {
    if (!exactEnd && arcAt(j) > aE) break;
    addPt(j, 0, exactEnd && j === count - 1);
  }
  if (!exactEnd) {
    const k = Math.min(Math.max(j - 1, 0), count - 2);
    addPt(k, frac(k, aE), true);
    if (endCut) { cutEdge(c, st, count, k, frac(k, aE), m); gEnd = END_FLAT; gEVx = jv[0]; gEVy = jv[1]; }
  } else if (endWeld) {
    gEnd = END_FLAT; gEVx = wvx; gEVy = wvy;
  }
  xKeepBoth = false; xKeepLast = false;
  gMaxE = Math.sqrt(gMaxE);
  xc = null; xfrom = null; xang = null;
  return gN;
}

/** Clamp to [0, 1]; NaN reads as 1 (an unknown morph t draws the final geometry). */
const clamp01 = (x: number): number => (x < 0 ? 0 : x <= 1 ? x : 1);

// ---------------------------------------------------------------------------- emitters

/** Write the buffered outline to the sink: midpoint quadratic Béziers on smooth runs. */
function emitOutline(sink: PathSink): void {
  const N = ON;
  sink.moveTo(OX[0], OY[0]);
  for (let i = 1; i < N; i++) {
    const f = OF[i];
    if (f === ARC) {
      sink.arc(ACX[i], ACY[i], ACR[i], AA0[i], AA1[i], true);
    } else if (f === SHARP) {
      if (OF[i - 1] !== SMOOTH) sink.lineTo(OX[i], OY[i]);
    } else {
      const nx = i + 1 < N ? i + 1 : 0;
      if (OF[nx] === SMOOTH) sink.quadraticCurveTo(OX[i], OY[i], (OX[i] + OX[nx]) * 0.5, (OY[i] + OY[nx]) * 0.5);
      else sink.quadraticCurveTo(OX[i], OY[i], OX[nx], OY[nx]);
    }
  }
  sink.closePath();
}

/** Outline points this far (device px) beyond a flat end's line still count as on it. */
const CLIP_EPS = 1e-6;
/** Zone masks of outline entries: generated by stations near the end / start flat edge. */
const Z_END = 1, Z_START = 2;
/**
 * Flat-end clipping applies only where every vertex of the zone turns by at most this (cos 30°).
 * Measured on thick ribbons (w/2 = 15 px, cuts swept through a corner): up to ~30° the clip turns
 * a double-added sliver of ~8–20 px² per cut into a sub-pixel gap; past that the straight shared
 * edge is no longer the true partition (the far arm's own ink crosses it) and the clip would
 * remove more legitimate ink than the overlap it saves, so a sharp corner keeps its overlap.
 */
const CLIP_COS = 0.8660254037844387;

/**
 * Clip the zone entries (mask `bit`) of the buffered outline to the kept side of a flat end's
 * line: through (px, py) along the end edge vector (vx, vy); `keepAhead` keeps the side the travel
 * points into (a start), else the side behind (an end). A vertex just inside a cut or weld reaches
 * across it (its inner miter / pivot offset lies up to w/2·sin(turn) past the vertex) and the
 * neighbour's strip already covers that sliver, so without this the two fills double-add there.
 *
 * Only entries generated near the end are tested (others count as kept), so ink far along the
 * poly that happens to lie across the line's extension is never touched. Sutherland–Hodgman over
 * the outline's control polygon: winding numbers on the kept side are unchanged (no new holes),
 * Bézier control points are clipped as vertices (each quadratic stays in its control hull), and an
 * arc whose ends are both kept stays; otherwise it degrades to its chord. Skipped (unclipped) when
 * the zone's boundary entries are themselves outside, i.e. the stroke folds back across the line.
 */
function clipOutline(px: number, py: number, vx: number, vy: number, keepAhead: boolean, bit: number): void {
  const vl = Math.sqrt(vx * vx + vy * vy);
  if (!(vl > 0)) return;
  const s = keepAhead ? 1 / vl : -1 / vl;
  const ux = vy * s, uy = -vx * s;                    // into the kept side
  const N = ON;
  let out = false;
  for (let i = 0, j = N - 1; i < N; j = i, i++) {
    if (!(OM[i] & bit)) continue;
    const di = (OX[i] - px) * ux + (OY[i] - py) * uy;
    if (di >= -CLIP_EPS) continue;
    // an outside entry on the zone boundary: the fold is not local, leave the outline alone
    if (!(OM[j] & bit) || !(OM[i + 1 < N ? i + 1 : 0] & bit)) return;
    out = true;
  }
  if (!out) return;
  ensureQ(2 * N + 2);
  let n = 0;
  let dj = OM[N - 1] & bit ? (OX[N - 1] - px) * ux + (OY[N - 1] - py) * uy : 0;
  for (let i = 0, j = N - 1; i < N; j = i, i++) {
    const di = OM[i] & bit ? (OX[i] - px) * ux + (OY[i] - py) * uy : 0;
    const ini = di >= -CLIP_EPS, inj = dj >= -CLIP_EPS;
    if (ini !== inj) {
      let t = dj / (dj - di);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      QX[n] = OX[j] + (OX[i] - OX[j]) * t; QY[n] = OY[j] + (OY[i] - OY[j]) * t; QF[n] = SHARP; QM[n] = OM[i] | OM[j]; n++;
    }
    if (ini) {
      QX[n] = OX[i]; QY[n] = OY[i]; QM[n] = OM[i];
      let f = OF[i];
      if (f === ARC) {
        if (inj) { QCX[n] = ACX[i]; QCY[n] = ACY[i]; QCR[n] = ACR[i]; QA0[n] = AA0[i]; QA1[n] = AA1[i]; }
        else f = SHARP;
      }
      QF[n] = f; n++;
    }
    dj = di;
  }
  // copy back, rotated to start on a SHARP vertex (the moveTo must lie on the outline)
  let k = 0;
  while (k < n && QF[k] !== SHARP) k++;
  if (k === n) { ON = 0; return; }
  ensureOut(n);
  for (let m = 0; m < n; m++) {
    const q = m + k < n ? m + k : m + k - n;
    OX[m] = QX[q]; OY[m] = QY[q]; OF[m] = QF[q]; OM[m] = QM[q];
    if (QF[q] === ARC) { ACX[m] = QCX[q]; ACY[m] = QCY[q]; ACR[m] = QCR[q]; AA0[m] = QA0[q]; AA1[m] = QA1[q]; }
  }
  ON = n;
}

/**
 * Clip zone of a flat end: the first station (from the end, walking back; or from the start,
 * walking forward) farther than 1.2·w/2 + 1 px of arc, beyond which no vertex can reach the end's
 * line (a reach is at most w/2). Returns -1 when a vertex inside the zone turns more than 30°.
 * `fromEnd`: zone at the end (returns the lowest station in it), else at the start (the highest).
 */
function clipZone(o: number, n: number, fromEnd: boolean): number {
  const last = n - 1;
  let j = fromEnd ? last : 0, acc = 0, hz = PH[o + j];
  for (;;) {
    if (acc > 1.2 * hz + 1) break;
    if (fromEnd ? j <= 0 : j >= last) break;
    acc += SL[fromEnd ? j - 1 : j];
    j += fromEnd ? -1 : 1;
    if (PH[o + j] > hz) hz = PH[o + j];
    if (j > 0 && j < last && SX[j - 1] * SX[j] + SY[j - 1] * SY[j] < CLIP_COS) return -1;
  }
  return j;
}

/** Full disc, wound like every outline (decreasing angle), as two half arcs (SVG-friendly). */
function disc(sink: PathSink, x: number, y: number, r: number): void {
  sink.moveTo(x + r, y);
  sink.arc(x, y, r, 0, -Math.PI, true);
  sink.arc(x, y, r, -Math.PI, -2 * Math.PI, true);
  sink.closePath();
}

/**
 * A range that collapsed to one point (shorter than MIN_SEG). Free at both ends: a disc (a dot, a
 * growing tip). Flat at one end (a cut, a weld): only the half disc on the capped side, so it
 * never spills across the shared edge onto the neighbour. Flat at both ends: nothing.
 */
function emitPoint(sink: PathSink, o: number): void {
  const h = PH[o];
  if (!(h > 0)) return;
  const fs = gStart === END_FLAT, fe = gEnd === END_FLAT;
  if (!fs && !fe) { disc(sink, PX[o], PY[o], h); return; }
  if (fs && fe) return;
  let vx = fs ? gSVx : -gEVx, vy = fs ? gSVy : -gEVy;   // from this end vector the cap sweeps −π
  const L = Math.sqrt(vx * vx + vy * vy);
  if (!(L > 0)) return;
  vx /= L; vy /= L;
  const x = PX[o], y = PY[o], a0 = Math.atan2(vy, vx);
  sink.moveTo(x + h * vx, y + h * vy);
  sink.arc(x, y, h, a0, a0 - Math.PI, true);
  sink.closePath();
}

/**
 * Ribbon outline over PX/PY/PH[o..o+n) with the current end modes. `clipEnds` clips the outline
 * at its flat ends (cuts and welds shared with a neighbour); the chisel core passes false, its
 * flat ends being internal to one unioned path.
 */
function emitRibbon(sink: PathSink, n: number, o = 0, clipEnds = true): void {
  if (n === 1) { emitPoint(sink, o); return; }
  RO = o;
  for (let k = 0; k < n - 1; k++) {
    const dx = PX[o + k + 1] - PX[o + k], dy = PY[o + k + 1] - PY[o + k];
    const L = Math.sqrt(dx * dx + dy * dy);
    if (L > 0) { SX[k] = -dy / L; SY[k] = dx / L; } else if (k > 0) { SX[k] = SX[k - 1]; SY[k] = SY[k - 1]; } else { SX[k] = 0; SY[k] = 1; }
    SL[k] = L;
  }
  ON = 0;
  ensureOut(8 * n + 16);
  const last = n - 1, ke = n - 2;
  const x0 = PX[o], y0 = PY[o], xl = PX[o + last], yl = PY[o + last];
  // clip zones: stations >= zE belong to the end zone, stations <= zS to the start zone
  const zE = clipEnds && gEnd === END_FLAT ? clipZone(o, n, true) : -1;
  const zS = clipEnds && gStart === END_FLAT ? clipZone(o, n, false) : -1;
  zoneEnd = zE >= 0 ? zE : n; zoneStart = zS;

  // side A (+normal), forward
  const h0 = PH[o];
  curMask = maskOf(0);
  if (gStart === END_FLAT) push(x0 + h0 * gSVx, y0 + h0 * gSVy, SHARP);
  else push(x0 + h0 * SX[0], y0 + h0 * SY[0], SHARP);
  for (let j = 1; j < last; j++) { curMask = maskOf(j); vertex(j, true); }
  const he = PH[o + last];
  curMask = maskOf(last);
  let bx: number, by: number;
  if (gEnd === END_FLAT) {
    push(xl + he * gEVx, yl + he * gEVy, SHARP);
    bx = xl - he * gEVx; by = yl - he * gEVy;
    push(bx, by, SHARP);
  } else {
    push(xl + he * SX[ke], yl + he * SY[ke], SHARP);
    bx = xl - he * SX[ke]; by = yl - he * SY[ke];
    if (he > CAP_MIN) pushArc(xl, yl, he, Math.atan2(SY[ke], SX[ke]), -Math.PI, bx, by);
    else push(bx, by, SHARP);
  }
  // side B (-normal), backward
  for (let j = last - 1; j >= 1; j--) { curMask = maskOf(j); vertex(j, false); }
  curMask = maskOf(0);
  if (gStart === END_FLAT) push(x0 - h0 * gSVx, y0 - h0 * gSVy, SHARP);
  else {
    push(x0 - h0 * SX[0], y0 - h0 * SY[0], SHARP);
    if (h0 > CAP_MIN) pushArc(x0, y0, h0, Math.atan2(-SY[0], -SX[0]), -Math.PI, OX[0], OY[0]);
  }
  curMask = 0;
  if (zE >= 0) clipOutline(xl, yl, gEVx, gEVy, false, Z_END);
  if (zS >= 0) clipOutline(x0, y0, gSVx, gSVy, true, Z_START);
  if (ON >= 3) emitOutline(sink);
}
/** Clip zones of the ribbon being outlined (stations >= zoneEnd / <= zoneStart). */
let zoneEnd = 0, zoneStart = -1;
const maskOf = (j: number): number => (j >= zoneEnd ? Z_END : 0) | (j <= zoneStart ? Z_START : 0);
/** Index offset of the ribbon being outlined (vertex() reads PX/PY/PH at RO + j). */
let RO = 0;

/** One interior vertex j on side A (forward) or B (backward). See the module comment. */
function vertex(j: number, sideA: boolean): void {
  const n0x = SX[j - 1], n0y = SY[j - 1], n1x = SX[j], n1y = SY[j];
  const dot = n0x * n1x + n0y * n1y;
  const cross = n0x * n1y - n0y * n1x;
  const h = PH[RO + j], px = PX[RO + j], py = PY[RO + j];
  const sharp = dot < COS60;
  const flag = dot < COS25 ? SHARP : SMOOTH;
  const inner = sideA ? cross > 0 : cross <= 0;   // cross > 0: turning toward +normal (side A)
  const s = sideA ? 1 : -1;
  if (inner) {
    const r = h * Math.sqrt(Math.max(0, 1 - dot) / Math.max(1e-12, 1 + dot));
    if (r <= 0.5 * Math.min(SL[j - 1], SL[j])) {
      const mm = s * h / (1 + dot);
      push(px + (n0x + n1x) * mm, py + (n0y + n1y) * mm, flag);
    } else if (sideA) {
      push(px + h * n0x, py + h * n0y, SHARP); push(px, py, SHARP); push(px + h * n1x, py + h * n1y, SHARP);
    } else {
      push(px - h * n1x, py - h * n1y, SHARP); push(px, py, SHARP); push(px - h * n0x, py - h * n0y, SHARP);
    }
  } else if (!sharp) {
    const mm = s * h / (1 + dot);
    push(px + (n0x + n1x) * mm, py + (n0y + n1y) * mm, flag);
  } else if (h > CAP_MIN) {
    const phi = Math.acos(dot < -1 ? -1 : dot);
    if (sideA) {
      push(px + h * n0x, py + h * n0y, SHARP);
      pushArc(px, py, h, Math.atan2(n0y, n0x), -phi, px + h * n1x, py + h * n1y);
    } else {
      push(px - h * n1x, py - h * n1y, SHARP);
      pushArc(px, py, h, Math.atan2(-n1y, -n1x), -phi, px - h * n0x, py - h * n0y);
    }
  } else if (sideA) {
    push(px + h * n0x, py + h * n0y, SHARP); push(px + h * n1x, py + h * n1y, SHARP);
  } else {
    push(px - h * n1x, py - h * n1y, SHARP); push(px - h * n0x, py - h * n0y, SHARP);
  }
}

// convex polygon scratch for clipped chisel pieces
const CPX = new Float64Array(16), CPY = new Float64Array(16), CQX = new Float64Array(16), CQY = new Float64Array(16);
let cpn = 0;

/** Keep the part of polygon CPX/CPY[0..cpn) where (p − (px,py))·(nx,ny) ≥ 0 (Sutherland–Hodgman). */
function clipHalf(px: number, py: number, nx: number, ny: number): void {
  let m = 0;
  for (let i = 0; i < cpn; i++) {
    const j = i + 1 < cpn ? i + 1 : 0;
    const ax = CPX[i], ay = CPY[i], bx = CPX[j], by = CPY[j];
    const da = (ax - px) * nx + (ay - py) * ny, db = (bx - px) * nx + (by - py) * ny;
    if (da >= 0) { CQX[m] = ax; CQY[m] = ay; m++; }
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      CQX[m] = ax + (bx - ax) * t; CQY[m] = ay + (by - ay) * t; m++;
    }
  }
  for (let i = 0; i < m; i++) { CPX[i] = CQX[i]; CPY[i] = CQY[i]; }
  cpn = m;
}

// cut half-planes of the current chisel's ends: point and inward unit normal
let hsX = 0, hsY = 0, hsNx = 0, hsNy = 0;
let heX = 0, heY = 0, heNx = 0, heNy = 0;

/** Emit CPX/CPY as one subpath, clipped by the requested end half-planes, wound like a ribbon. */
function piece(sink: PathSink, clipS: boolean, clipE: boolean): void {
  if (clipS) clipHalf(hsX, hsY, hsNx, hsNy);
  if (clipE && cpn >= 3) clipHalf(heX, heY, heNx, heNy);
  if (cpn < 3) return;
  let a2 = 0;
  for (let i = 0; i < cpn; i++) { const j = i + 1 < cpn ? i + 1 : 0; a2 += CPX[i] * CPY[j] - CPX[j] * CPY[i]; }
  if (a2 > -1e-9 && a2 < 1e-9) return;
  sink.moveTo(CPX[0], CPY[0]);
  if (a2 > 0) for (let i = cpn - 1; i >= 1; i--) sink.lineTo(CPX[i], CPY[i]);
  else for (let i = 1; i < cpn; i++) sink.lineTo(CPX[i], CPY[i]);
  sink.closePath();
}
function setQuad(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
  CPX[0] = x0; CPY[0] = y0; CPX[1] = x1; CPY[1] = y1; CPX[2] = x2; CPY[2] = y2; CPX[3] = x3; CPY[3] = y3; cpn = 4;
}

const COS10 = 0.984807753012208;

/**
 * Cut line of a chisel end: the nib line through the end point. (nx, ny) is the end's normal
 * direction (joint miter / cut normal / own segment normal; the travel is its perpendicular) and
 * neighbouring chunks pass identical inputs, so they get the identical line. Writes the unit
 * normal of the line pointing into this chunk (`ahead`: the chunk lies ahead along the travel) and
 * returns whether to clip: the nib line partitions the swept ink only when the nib is at least 10°
 * off the travel; when it slides along its own length no partition exists, and the end is left
 * unclipped (neighbours then overlap in thin slivers, a declared limitation).
 */
function cutLine(nx: number, ny: number, ex: number, ey: number, ahead: boolean): boolean {
  const nl = Math.sqrt(nx * nx + ny * ny);
  if (nl > 0) { nx /= nl; ny /= nl; } else { nx = 0; ny = 1; }
  const tx = ny, ty = -nx;                          // travel direction (n = (−ty, tx))
  const el = Math.sqrt(ex * ex + ey * ey);
  if (!(el > 0)) return false;
  const ux = ex / el, uy = ey / el;
  if (Math.abs(ux * tx + uy * ty) > COS10) return false;
  let cnx = -uy, cny = ux;                          // normal of the nib line
  if ((cnx * tx + cny * ty > 0) !== ahead) { cnx = -cnx; cny = -cny; }
  jv[0] = cnx; jv[1] = cny;
  return true;
}

// per-chisel end state: clip flags and the flat end vectors used when an end is not clipped
let csOn = false, ceOn = false;
let svx = 0, svy = 1, evx = 0, evy = 1;

/**
 * Chisel (DESIGN §6.4): one quad per segment (split where the rails cross) and the 0.15E core,
 * all in ONE path with every piece wound like a ribbon, so nonzero fill unions them. Near each
 * flat end (stroke end, chunk joint, arc cut) every piece is a convex polygon clipped against the
 * nib line through the end, so neighbouring chunks partition the ink exactly along one shared
 * line: no double-added bow-tie, and no core nub past a chisel's flat ends. A free stroke end also
 * gets the nib's own footprint (E × core). Away from the ends the core is a smooth Bézier ribbon
 * whose flat ends match the neighbouring core rectangles exactly.
 */
function emitChisel(sink: PathSink, n: number): void {
  if (n === 1) {
    // a lone station: the nib's footprint; beside a flat end only the half on the open side
    const fs = gStart === END_FLAT, fe = gEnd === END_FLAT;
    if (fs && fe) return;
    let clip = false;
    if (fs || fe) {
      clip = cutLine(fs ? gSVx : gEVx, fs ? gSVy : gEVy, EX[0], EY[0], fs);
      hsX = heX = PX[0]; hsY = heY = PY[0]; hsNx = heNx = jv[0]; hsNy = heNy = jv[1];
    }
    nibFootprint(sink, 0, clip && fs, clip && fe);
    return;
  }
  const last = n - 1;
  const freeS = gStart !== END_FLAT, freeE = gEnd !== END_FLAT;
  // end vectors: flat ends keep the shared vector from gather; free ends use their own segment
  if (!freeS) { svx = gSVx; svy = gSVy; } else unitNormal(0, 1, true);
  if (!freeE) { evx = gEVx; evy = gEVy; } else unitNormal(last - 1, last, false);
  csOn = cutLine(svx, svy, EX[0], EY[0], true);
  hsX = PX[0]; hsY = PY[0]; hsNx = jv[0]; hsNy = jv[1];
  ceOn = cutLine(evx, evy, EX[last], EY[last], false);
  heX = PX[last]; heY = PY[last]; heNx = jv[0]; heNy = jv[1];

  // end zones (device arc): pieces closer than R to an end may cross its cut line
  let maxH = 0, maxE = 0;
  for (let j = 0; j < n; j++) {
    if (PH[j] > maxH) maxH = PH[j];
    const e2 = EX[j] * EX[j] + EY[j] * EY[j];
    if (e2 > maxE) maxE = e2;
  }
  const R = Math.sqrt(maxE) + 6 * maxH + 1;
  for (let k = 0; k < last; k++) SL[k] = Math.sqrt((PX[k + 1] - PX[k]) * (PX[k + 1] - PX[k]) + (PY[k + 1] - PY[k]) * (PY[k + 1] - PY[k]));
  let i0 = 0, acc = 0;
  while (i0 < last && acc <= R) { acc += SL[i0]; i0++; }          // segments [0, i0) are in the start zone
  let i1 = last; acc = 0;
  while (i1 > 0 && acc <= R) { i1--; acc += SL[i1]; }              // segments [i1, last) are in the end zone

  // nib quads
  for (let k = 0; k < last; k++) {
    const ax = PX[k], ay = PY[k], bx = PX[k + 1], by = PY[k + 1];
    const e0x = EX[k], e0y = EY[k], e1x = EX[k + 1], e1y = EY[k + 1];
    const dx = bx - ax, dy = by - ay;
    const s0 = dx * e0y - dy * e0x, s1 = dx * e1y - dy * e1x;
    const zs = csOn && k < i0, ze = ceOn && k >= i1;
    if (s0 * s1 < 0) {
      // the nib edge passes through the travel direction inside this segment: split there
      const t = s0 / (s0 - s1);
      const cx = ax + dx * t, cy = ay + dy * t, ecx = e0x + (e1x - e0x) * t, ecy = e0y + (e1y - e0y) * t;
      setQuad(ax + e0x, ay + e0y, cx + ecx, cy + ecy, cx - ecx, cy - ecy, ax - e0x, ay - e0y);
      piece(sink, zs, ze);
      setQuad(cx + ecx, cy + ecy, bx + e1x, by + e1y, bx - e1x, by - e1y, cx - ecx, cy - ecy);
      piece(sink, zs, ze);
    } else {
      setQuad(ax + e0x, ay + e0y, bx + e1x, by + e1y, bx - e1x, by - e1y, ax - e0x, ay - e0y);
      piece(sink, zs, ze);
    }
  }
  if (freeS) nibFootprint(sink, 0, csOn, false);
  if (freeE) nibFootprint(sink, last, false, ceOn);

  if (i0 >= i1) {
    for (let k = 0; k < last; k++) coreZone(sink, k, last, csOn, ceOn);
    return;
  }
  for (let k = 0; k < i0; k++) coreZone(sink, k, last, csOn, false);
  for (let k = i1; k < last; k++) coreZone(sink, k, last, false, ceOn);
  // middle core ribbon over stations [i0, i1]; its flat ends match the neighbouring rectangles
  const la = SL[i0 - 1], lb = SL[i1];
  gStart = END_FLAT; gEnd = END_FLAT;
  if (la > 0) { gSVx = -(PY[i0] - PY[i0 - 1]) / la; gSVy = (PX[i0] - PX[i0 - 1]) / la; } else { gSVx = 0; gSVy = 1; }
  if (lb > 0) { gEVx = -(PY[i1 + 1] - PY[i1]) / lb; gEVy = (PX[i1 + 1] - PX[i1]) / lb; } else { gEVx = 0; gEVy = 1; }
  emitRibbon(sink, i1 - i0 + 1, i0, false);
}

/** Unit normal (−ty, tx) of segment a→b into the start (svx) or end (evx) vector. */
function unitNormal(a: number, b: number, start: boolean): void {
  const dx = PX[b] - PX[a], dy = PY[b] - PY[a], L = Math.sqrt(dx * dx + dy * dy);
  const x = L > 0 ? -dy / L : 0, y = L > 0 ? dx / L : 1;
  if (start) { svx = x; svy = y; } else { evx = x; evy = y; }
}

/**
 * The nib's own footprint at station j (E long, core thick): the touchdown / lift of a free end.
 * `clipS` / `clipE` cut it on the start / end half-planes (hs*, he*).
 */
function nibFootprint(sink: PathSink, j: number, clipS: boolean, clipE: boolean): void {
  const ex = EX[j], ey = EY[j], L = Math.sqrt(ex * ex + ey * ey);
  const c = PH[j];
  if (!(L > 0) && !(c > 0)) return;
  const qx = L > 0 ? (-ey / L) * c : 0, qy = L > 0 ? (ex / L) * c : c;
  setQuad(PX[j] + ex + qx, PY[j] + ey + qy, PX[j] - ex + qx, PY[j] - ey + qy, PX[j] - ex - qx, PY[j] - ey - qy, PX[j] + ex - qx, PY[j] + ey - qy);
  piece(sink, clipS, clipE);
}

/**
 * Core piece of segment k inside an end zone: a rectangle of the core's half-widths plus the
 * wedge on the outer side of its far vertex, both convex. At a clipped end the end rectangle is
 * extended past the end so the cut line, not the rectangle, shapes it (and it covers the core
 * band the neighbour's clip removed); at an unclipped end its edge is the shared end vector.
 */
function coreZone(sink: PathSink, k: number, last: number, clipS: boolean, clipE: boolean): void {
  const ax = PX[k], ay = PY[k], bx = PX[k + 1], by = PY[k + 1];
  const L = SL[k];
  if (!(L > 0)) return;
  const tx = (bx - ax) / L, ty = (by - ay) / L, nx = -ty, ny = tx;
  const ha = PH[k], hb = PH[k + 1];
  const ext = 6 * Math.max(ha, hb) + 1;
  let ax0 = ax, ay0 = ay, vax = nx, vay = ny, bx1 = bx, by1 = by, vbx = nx, vby = ny;
  if (k === 0) { if (clipS) { ax0 -= tx * ext; ay0 -= ty * ext; } else { vax = svx; vay = svy; } }
  if (k === last - 1) { if (clipE) { bx1 += tx * ext; by1 += ty * ext; } else { vbx = evx; vby = evy; } }
  setQuad(ax0 + vax * ha, ay0 + vay * ha, bx1 + vbx * hb, by1 + vby * hb, bx1 - vbx * hb, by1 - vby * hb, ax0 - vax * ha, ay0 - vay * ha);
  piece(sink, clipS, clipE);
  if (k + 1 < last) {
    const L2 = SL[k + 1];
    if (L2 > 0) {
      const t2x = (PX[k + 2] - bx) / L2, t2y = (PY[k + 2] - by) / L2;
      const s = tx * t2y - ty * t2x > 0 ? -1 : 1;     // the outer side of the turn
      CPX[0] = bx; CPY[0] = by;
      CPX[1] = bx + s * nx * hb; CPY[1] = by + s * ny * hb;
      CPX[2] = bx - s * t2y * hb; CPY[2] = by + s * t2x * hb;
      cpn = 3;
      piece(sink, clipS, clipE);
    }
  }
}

// ---------------------------------------------------------------------------- public API

/**
 * Append poly i's closed outline (doc-rel-origin -> device via m) to sink. Returns false if
 * nothing was drawn: empty reveal/range, or a ribbon/chisel thinner than `minDevWidth` everywhere
 * (the caller then strokes `traceCentre` at 1 device px with alpha × device width). Dots (and any
 * single-point poly) thinner than `minDevWidth` are drawn at that diameter instead (the caller
 * scales alpha by w²); a dot's radius scales with `reveal` so taps grow and un-grow smoothly. A
 * single-point chisel poly is the nib's footprint (E × core). A range shorter than 0.25 device px
 * draws a disc only where both its ends are free; beside a cut or weld only the open half.
 */
export function tracePoly(sink: PathSink, c: Cooked, i: number, m: Mat2x3, o?: TraceOpts): boolean {
  if (i < 0 || i >= c.nPolys) return false;
  const count = c.count[i];
  if (count === 0) return false;
  const kind = c.kind[i];
  const minW = o && o.minDevWidth !== undefined ? o.minDevWidth : 1;
  // a single-station chisel is the nib's footprint, unless it is thinner than minW (then a disc)
  const nibDot = kind === CHISEL && count === 1 &&
    !(c.pts[4 * c.start[i] + 2] * (o && o.widthScale !== undefined ? o.widthScale : 1) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) >= minW);
  if (kind === DOT || (count === 1 && (kind !== CHISEL || nibDot))) {
    const rv = o && o.reveal !== undefined ? o.reveal : 1;
    if (!(rv > 0)) return false;
    const b = 4 * c.start[i];
    let x = c.pts[b], y = c.pts[b + 1];
    const from = o && o.morphFrom ? o.morphFrom : null;
    if (from) {
      const t = clamp01(o!.morphT ?? 1), f = 2 * c.start[i];
      x = from[f] + (x - from[f]) * t; y = from[f + 1] + (y - from[f + 1]) * t;
    }
    const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    let d = c.pts[b + 2] * (o && o.widthScale !== undefined ? o.widthScale : 1) * sc;
    if (d < minW) d = minW;
    const r = 0.5 * d * (rv < 1 ? rv : 1);
    if (!(r > 0)) return false;
    disc(sink, m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5], r);
    return true;
  }
  const chisel = kind === CHISEL;
  const n = gather(c, i, m, o, chisel);
  if (n === 0 || (n === 1 && gStart === END_FLAT && gEnd === END_FLAT)) return false;
  if (chisel) {
    if (2 * Math.max(gMaxE, gMaxH) < minW) return false;
    emitChisel(sink, n);
  } else {
    if (2 * gMaxH < minW || !(gMaxH > 0)) return false;
    emitRibbon(sink, n);
  }
  return true;
}

/**
 * Centreline of poly i (midpoint quadratic Béziers) for the hairline rule: stroke it at 1 device
 * px with alpha × the poly's device width. Honours reveal, morph and arc ranges. Returns false
 * for dots and polys that collapse to one point.
 */
export function traceCentre(sink: PathSink, c: Cooked, i: number, m: Mat2x3, o?: TraceOpts): boolean {
  if (i < 0 || i >= c.nPolys || c.count[i] < 2 || c.kind[i] === DOT) return false;
  const n = gather(c, i, m, o, false);
  if (n < 2) return false;
  sink.moveTo(PX[0], PY[0]);
  for (let j = 1; j < n - 1; j++) sink.quadraticCurveTo(PX[j], PY[j], (PX[j] + PX[j + 1]) * 0.5, (PY[j] + PY[j + 1]) * 0.5);
  sink.lineTo(PX[n - 1], PY[n - 1]);
  return true;
}

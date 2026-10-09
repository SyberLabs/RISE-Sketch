/**
 * Live-layer bookkeeping: dirty rects, growable buffers, the live mirror of a cook's geometry
 * (PolyStore), per-poly animation state with the content keys that carry it across views
 * (PolyState, KeyTable), and the chain and box helpers over them.
 */
import type { AABB, Cooked, Mat2x3, PolyView, Vec2 } from '../../core/types';
import { PolyKind } from '../../core/types';

/** Device rect of a doc-rel-origin box under m, padded, into a rect list. */
export function addBox(list: RectList, m: Mat2x3, x0: number, y0: number, x1: number, y1: number, pad: number): void {
  if (!(x1 >= x0 && y1 >= y0)) return;
  let X0: number, X1: number, Y0: number, Y1: number;
  if (m[1] === 0 && m[2] === 0) {
    X0 = m[0] * x0 + m[4]; X1 = m[0] * x1 + m[4];
    Y0 = m[3] * y0 + m[5]; Y1 = m[3] * y1 + m[5];
    if (X0 > X1) { const t = X0; X0 = X1; X1 = t; }
    if (Y0 > Y1) { const t = Y0; Y0 = Y1; Y1 = t; }
  } else {
    const xa = m[0] * x0, xb = m[0] * x1, xc = m[2] * y0, xd = m[2] * y1;
    const ya = m[1] * x0, yb = m[1] * x1, yc = m[3] * y0, yd = m[3] * y1;
    X0 = Math.min(xa, xb) + Math.min(xc, xd) + m[4]; X1 = Math.max(xa, xb) + Math.max(xc, xd) + m[4];
    Y0 = Math.min(ya, yb) + Math.min(yc, yd) + m[5]; Y1 = Math.max(ya, yb) + Math.max(yc, yd) + m[5];
  }
  list.add(X0 - pad, Y0 - pad, X1 + pad, Y1 + pad);
}

/** Device bbox of a doc-rel-origin box under m into out (no pad). */
export function devOf(m: Mat2x3, x0: number, y0: number, x1: number, y1: number, out: AABB): boolean {
  if (!(x1 >= x0 && y1 >= y0)) return false;
  const xa = m[0] * x0, xb = m[0] * x1, xc = m[2] * y0, xd = m[2] * y1;
  const ya = m[1] * x0, yb = m[1] * x1, yc = m[3] * y0, yd = m[3] * y1;
  out.x0 = Math.min(xa, xb) + Math.min(xc, xd) + m[4]; out.x1 = Math.max(xa, xb) + Math.max(xc, xd) + m[4];
  out.y0 = Math.min(ya, yb) + Math.min(yc, yd) + m[5]; out.y1 = Math.max(ya, yb) + Math.max(yc, yd) + m[5];
  return out.x1 >= out.x0 && out.y1 >= out.y0;
}

/** Two boxes intersect (edges touching counts). */
export const overlaps = (a: AABB, b: AABB): boolean => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

// ============================================================================ dirty rects

/**
 * Up to `cap` integer device-px rects. A rect that touches (within `gap`) another merges with it;
 * past the cap the pair whose union grows least merges. A repaint clips to their union.
 */
export class RectList {
  n = 0;
  full = false;
  readonly r: Float64Array;
  constructor(readonly cap = 8, readonly gap = 8) { this.r = new Float64Array(4 * (cap + 1)); }

  clear(): void { this.n = 0; this.full = false; }
  get empty(): boolean { return !this.full && this.n === 0; }
  /** Repaint everything. */
  setFull(): void { this.full = true; this.n = 0; }

  add(x0: number, y0: number, x1: number, y1: number): void {
    if (this.full) return;
    if (!(x1 > x0 && y1 > y0)) return;
    if (x0 < -1e7) x0 = -1e7; if (y0 < -1e7) y0 = -1e7; if (x1 > 1e7) x1 = 1e7; if (y1 > 1e7) y1 = 1e7;
    x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
    const r = this.r, g = this.gap;
    for (let k = 0; k < this.n;) {
      const o = 4 * k;
      if (r[o] <= x1 + g && r[o + 2] >= x0 - g && r[o + 1] <= y1 + g && r[o + 3] >= y0 - g) {
        if (r[o] < x0) x0 = r[o]; if (r[o + 1] < y0) y0 = r[o + 1];
        if (r[o + 2] > x1) x1 = r[o + 2]; if (r[o + 3] > y1) y1 = r[o + 3];
        this.removeAt(k);
        k = 0;
      } else k++;
    }
    const o = 4 * this.n++;
    r[o] = x0; r[o + 1] = y0; r[o + 2] = x1; r[o + 3] = y1;
    if (this.n > this.cap) this.mergeCheapest();
  }

  private removeAt(k: number): void {
    const r = this.r, last = 4 * (this.n - 1), o = 4 * k;
    r[o] = r[last]; r[o + 1] = r[last + 1]; r[o + 2] = r[last + 2]; r[o + 3] = r[last + 3];
    this.n--;
  }

  private mergeCheapest(): void {
    const r = this.r;
    let ba = 0, bb = 1, best = Infinity;
    for (let a = 0; a < this.n; a++) {
      for (let b = a + 1; b < this.n; b++) {
        const oa = 4 * a, ob = 4 * b;
        const ux = Math.max(r[oa + 2], r[ob + 2]) - Math.min(r[oa], r[ob]);
        const uy = Math.max(r[oa + 3], r[ob + 3]) - Math.min(r[oa + 1], r[ob + 1]);
        const cost = ux * uy - (r[oa + 2] - r[oa]) * (r[oa + 3] - r[oa + 1]) - (r[ob + 2] - r[ob]) * (r[ob + 3] - r[ob + 1]);
        if (cost < best) { best = cost; ba = a; bb = b; }
      }
    }
    const oa = 4 * ba, ob = 4 * bb;
    const x0 = Math.min(r[oa], r[ob]), y0 = Math.min(r[oa + 1], r[ob + 1]);
    const x1 = Math.max(r[oa + 2], r[ob + 2]), y1 = Math.max(r[oa + 3], r[ob + 3]);
    this.removeAt(bb);
    this.removeAt(ba);
    this.add(x0, y0, x1, y1);
  }

  /** Clip every rect to [0, W] × [0, H]; drops empty ones. */
  clampTo(W: number, H: number): void {
    const r = this.r;
    for (let k = 0; k < this.n;) {
      const o = 4 * k;
      if (r[o] < 0) r[o] = 0; if (r[o + 1] < 0) r[o + 1] = 0;
      if (r[o + 2] > W) r[o + 2] = W; if (r[o + 3] > H) r[o + 3] = H;
      if (!(r[o + 2] > r[o] && r[o + 3] > r[o + 1])) this.removeAt(k); else k++;
    }
  }

  /** Union of the rects into out; false when empty. */
  bbox(out: AABB): boolean {
    if (this.n === 0) return false;
    const r = this.r;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < this.n; k++) {
      const o = 4 * k;
      if (r[o] < x0) x0 = r[o]; if (r[o + 1] < y0) y0 = r[o + 1];
      if (r[o + 2] > x1) x1 = r[o + 2]; if (r[o + 3] > y1) y1 = r[o + 3];
    }
    out.x0 = x0; out.y0 = y0; out.x1 = x1; out.y1 = y1;
    return true;
  }
}

// ============================================================================ growable buffers

function g8(a: Uint8Array, n: number): Uint8Array<ArrayBuffer> { const b = new Uint8Array(n); b.set(a); return b; }
function gu32(a: Uint32Array, n: number): Uint32Array<ArrayBuffer> { const b = new Uint32Array(n); b.set(a); return b; }
export function gi32(a: Int32Array, n: number): Int32Array<ArrayBuffer> { const b = new Int32Array(n); b.set(a); return b; }
function gf32(a: Float32Array, n: number): Float32Array<ArrayBuffer> { const b = new Float32Array(n); b.set(a); return b; }
export function gf64(a: Float64Array, n: number): Float64Array<ArrayBuffer> { const b = new Float64Array(n); b.set(a); return b; }

/** A growable index list with a cached subarray view (DrawOpts.polys). */
export class IntList {
  a = new Int32Array(64);
  n = 0;
  private v: Int32Array = this.a.subarray(0, 0);
  push(x: number): void {
    if (this.n >= this.a.length) this.a = gi32(this.a, 2 * this.a.length);
    this.a[this.n++] = x;
  }
  clear(): void { this.n = 0; }
  view(): Int32Array {
    if (this.v.length !== this.n || this.v.buffer !== this.a.buffer) this.v = this.a.subarray(0, this.n);
    return this.v;
  }
}

/**
 * A Cooked the live layer owns: the mirror of the cook's live geometry, a ghost copy. Polys
 * appended with push() are copied (points, chisel angles, attributes, box). `genStart` only
 * carries the generation count (drawCooked reads its length); the order is the source's.
 */
export class PolyStore implements Cooked {
  pts = new Float32Array(1024);
  ang: Float32Array | null = null;
  start = new Uint32Array(64);
  count = new Uint32Array(64);
  kind = new Uint8Array(64);
  gen = new Uint8Array(64);
  tone = new Uint8Array(64);
  alpha = new Float32Array(64);
  born = new Float32Array(64);
  unit = new Uint32Array(64);
  box = new Float32Array(256);
  genStart = new Uint32Array(2);
  nPolys = 0;
  nPts = 0;
  inkBox: AABB = { x0: 0, y0: 0, x1: -1, y1: -1 };
  hitBox: AABB = { x0: 0, y0: 0, x1: -1, y1: -1 };
  ceilingMax = 0;
  coverage = 0;
  bytes = 0;

  /** Keep polys [0, k). */
  truncate(k: number): void {
    this.nPolys = k;
    this.nPts = k > 0 ? this.start[k - 1] + this.count[k - 1] : 0;
  }

  /** Append poly i of g; returns its index here. */
  push(g: Cooked, i: number): number {
    const k = this.nPolys, n = g.count[i], st = g.start[i], o = this.nPts;
    if (k + 1 > this.start.length) {
      const c = 2 * this.start.length;
      this.start = gu32(this.start, c); this.count = gu32(this.count, c); this.kind = g8(this.kind, c);
      this.gen = g8(this.gen, c); this.tone = g8(this.tone, c); this.alpha = gf32(this.alpha, c);
      this.born = gf32(this.born, c); this.unit = gu32(this.unit, c); this.box = gf32(this.box, 4 * c);
    }
    if (4 * (o + n) > this.pts.length) {
      let c = this.pts.length;
      while (c < 4 * (o + n)) c *= 2;
      this.pts = gf32(this.pts, c);
      if (this.ang) this.ang = gf32(this.ang, c >> 2);
    }
    // plain loops, not set(subarray): the mirror re-copies its unsettled suffix every live frame,
    // and a view object per poly per frame is garbage in the hot path
    const src = g.pts, dst = this.pts;
    for (let k = 4 * st, q = 4 * o, end = 4 * (st + n); k < end; k++, q++) dst[q] = src[k];
    if (g.ang && g.kind[i] === PolyKind.Chisel) {
      if (!this.ang) this.ang = new Float32Array(this.pts.length >> 2);
      const sa = g.ang, da = this.ang;
      for (let k = st, q = o, end = st + n; k < end; k++, q++) da[q] = sa[k];
    }
    this.start[k] = o; this.count[k] = n; this.kind[k] = g.kind[i]; this.gen[k] = g.gen[i];
    this.tone[k] = g.tone[i]; this.alpha[k] = g.alpha[i]; this.born[k] = g.born[i]; this.unit[k] = g.unit[i];
    this.box[4 * k] = g.box[4 * i]; this.box[4 * k + 1] = g.box[4 * i + 1];
    this.box[4 * k + 2] = g.box[4 * i + 2]; this.box[4 * k + 3] = g.box[4 * i + 3];
    this.nPolys = k + 1; this.nPts = o + n;
    if (g.gen[i] + 2 > this.genStart.length) this.genStart = new Uint32Array(g.gen[i] + 2);
    return k;
  }

  /** Recompute inkBox (absolute doc) from the poly boxes. */
  bounds(origin: Vec2): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const b = this.box;
    for (let i = 0; i < this.nPolys; i++) {
      if (b[4 * i] < x0) x0 = b[4 * i]; if (b[4 * i + 1] < y0) y0 = b[4 * i + 1];
      if (b[4 * i + 2] > x1) x1 = b[4 * i + 2]; if (b[4 * i + 3] > y1) y1 = b[4 * i + 3];
    }
    const ib = this.inkBox;
    if (x1 >= x0) { ib.x0 = origin[0] + x0; ib.y0 = origin[1] + y0; ib.x1 = origin[0] + x1; ib.y1 = origin[1] + y1; }
    else { ib.x0 = 0; ib.y0 = 0; ib.x1 = -1; ib.y1 = -1; }
    this.hitBox = this.inkBox;
  }
}

// ============================================================================ per-poly state

const KB = new Float32Array(1), KU = new Uint32Array(KB.buffer);
const bits = (x: number): number => { KB[0] = x; return KU[0]; };
const mix = (h: number, v: number): number => Math.imul(h ^ v, 0x01000193) >>> 0;

/**
 * Animation state per poly of a source Cooked, plus the content key that carries it across
 * views (hash, kind|gen|tone, unit, count, alpha, the two end points).
 */
export class PolyState {
  cap = 0;
  n = 0;
  st = new Uint8Array(0); settled = new Uint8Array(0); fd = new Uint8Array(0);
  t1 = new Float64Array(0); rs = new Float64Array(0); mt0 = new Float64Array(0); ft0 = new Float64Array(0);
  rd = new Float32Array(0); md = new Float32Array(0); coff = new Float32Array(0); ctot = new Float32Array(0);
  len = new Float32Array(0); wmax = new Float32Array(0); rv = new Float32Array(0); hv = new Float32Array(0);
  mv = new Float32Array(0); alpha = new Float32Array(0);
  hash = new Uint32Array(0); meta = new Uint32Array(0); unit = new Uint32Array(0); cnt = new Uint32Array(0);
  id = new Int32Array(0);
  ends = new Float32Array(0); box = new Float32Array(0); mbox = new Float32Array(0);

  ensure(n: number): void {
    if (n <= this.cap) return;
    let c = this.cap > 0 ? 2 * this.cap : 64;
    while (c < n) c *= 2;
    this.st = g8(this.st, c); this.settled = g8(this.settled, c); this.fd = g8(this.fd, c);
    this.t1 = gf64(this.t1, c); this.rs = gf64(this.rs, c); this.mt0 = gf64(this.mt0, c); this.ft0 = gf64(this.ft0, c);
    this.rd = gf32(this.rd, c); this.md = gf32(this.md, c); this.coff = gf32(this.coff, c); this.ctot = gf32(this.ctot, c);
    this.len = gf32(this.len, c); this.wmax = gf32(this.wmax, c); this.rv = gf32(this.rv, c); this.hv = gf32(this.hv, c);
    this.mv = gf32(this.mv, c); this.alpha = gf32(this.alpha, c);
    this.hash = gu32(this.hash, c); this.meta = gu32(this.meta, c); this.unit = gu32(this.unit, c); this.cnt = gu32(this.cnt, c);
    this.id = gi32(this.id, c);
    this.ends = gf32(this.ends, 6 * c); this.box = gf32(this.box, 4 * c); this.mbox = gf32(this.mbox, 4 * c);
    this.cap = c;
  }

  /** Key, box, max width and arc length of poly i of c into entry e. */
  keyFrom(c: Cooked, i: number, e: number): void {
    this.keyOnly(c, i, e);
    this.measure(c, i, e);
  }

  /** Content key and box of poly i of c into entry e (O(1): the two end points only). */
  keyOnly(c: Cooked, i: number, e: number): void {
    const st = c.start[i], n = c.count[i], p = c.pts;
    const a = 4 * st, b = 4 * (st + (n > 0 ? n - 1 : 0));
    const meta = c.kind[i] | (c.gen[i] << 8) | (c.tone[i] << 16);
    this.setKey(e, meta, c.unit[i] >>> 0, n, c.alpha[i], p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2]);
    this.box[4 * e] = c.box[4 * i]; this.box[4 * e + 1] = c.box[4 * i + 1];
    this.box[4 * e + 2] = c.box[4 * i + 2]; this.box[4 * e + 3] = c.box[4 * i + 3];
  }

  /** Max width and arc length of poly i of c into entry e (scans its points). */
  measure(c: Cooked, i: number, e: number): void {
    const st = c.start[i], n = c.count[i], p = c.pts;
    let w = 0;
    for (let j = st; j < st + n; j++) if (p[4 * j + 2] > w) w = p[4 * j + 2];
    this.wmax[e] = w;
    this.len[e] = n > 1 ? p[4 * (st + n - 1) + 3] - p[4 * st + 3] : 0;
  }

  /** Key of a drained PolyView into entry e. */
  keyFromView(v: PolyView, e: number): void {
    const p = v.pts, n = p.length >> 2;
    const meta = v.kind | (v.gen << 8) | (v.tone << 16);
    if (n === 0) { this.setKey(e, meta, v.unit >>> 0, 0, v.alpha, 0, 0, 0, 0, 0, 0); return; }
    const b = 4 * (n - 1);
    this.setKey(e, meta, v.unit >>> 0, n, v.alpha, p[0], p[1], p[2], p[b], p[b + 1], p[b + 2]);
  }

  private setKey(e: number, meta: number, unit: number, n: number, alpha: number,
    x0: number, y0: number, w0: number, x1: number, y1: number, w1: number): void {
    KB[0] = alpha;
    const ab = KU[0];
    this.meta[e] = meta; this.unit[e] = unit; this.cnt[e] = n;
    this.alpha[e] = alpha;
    const E = this.ends, o = 6 * e;
    E[o] = x0; E[o + 1] = y0; E[o + 2] = w0; E[o + 3] = x1; E[o + 4] = y1; E[o + 5] = w1;
    let h = 0x811c9dc5;
    h = mix(h, meta); h = mix(h, unit); h = mix(h, n); h = mix(h, ab);
    h = mix(h, bits(E[o])); h = mix(h, bits(E[o + 1])); h = mix(h, bits(E[o + 2]));
    h = mix(h, bits(E[o + 3])); h = mix(h, bits(E[o + 4])); h = mix(h, bits(E[o + 5]));
    this.hash[e] = h;
  }

  /** Content keys of entry j here and entry i of B are equal. */
  keyEq(j: number, B: PolyState, i: number): boolean {
    if (this.hash[j] !== B.hash[i] || this.meta[j] !== B.meta[i] || this.unit[j] !== B.unit[i] ||
      this.cnt[j] !== B.cnt[i] || this.alpha[j] !== B.alpha[i]) return false;
    const a = this.ends, b = B.ends, oa = 6 * j, ob = 6 * i;
    return a[oa] === b[ob] && a[oa + 1] === b[ob + 1] && a[oa + 2] === b[ob + 2] &&
      a[oa + 3] === b[ob + 3] && a[oa + 4] === b[ob + 4] && a[oa + 5] === b[ob + 5];
  }

  /** Animation state of entry j of src into entry i (keys stay). */
  carry(src: PolyState, j: number, i: number): void {
    this.st[i] = src.st[j]; this.settled[i] = src.settled[j]; this.fd[i] = src.fd[j];
    this.t1[i] = src.t1[j]; this.rs[i] = src.rs[j]; this.mt0[i] = src.mt0[j]; this.ft0[i] = src.ft0[j];
    this.rd[i] = src.rd[j]; this.md[i] = src.md[j]; this.rv[i] = src.rv[j]; this.hv[i] = src.hv[j]; this.mv[i] = src.mv[j];
    const o = 4 * j, q = 4 * i;
    this.mbox[q] = src.mbox[o]; this.mbox[q + 1] = src.mbox[o + 1]; this.mbox[q + 2] = src.mbox[o + 2]; this.mbox[q + 3] = src.mbox[o + 3];
  }

  /** Everything of entry j of src into entry i (snapshots). */
  copyAll(src: PolyState, j: number, i: number): void {
    this.carry(src, j, i);
    this.hash[i] = src.hash[j]; this.meta[i] = src.meta[j]; this.unit[i] = src.unit[j]; this.cnt[i] = src.cnt[j];
    this.alpha[i] = src.alpha[j]; this.id[i] = src.id[j]; this.coff[i] = src.coff[j]; this.ctot[i] = src.ctot[j];
    this.len[i] = src.len[j]; this.wmax[i] = src.wmax[j];
    for (let k = 0; k < 6; k++) this.ends[6 * i + k] = src.ends[6 * j + k];
    for (let k = 0; k < 4; k++) this.box[4 * i + k] = src.box[4 * j + k];
  }

  /** Default state of a new entry. */
  init(i: number, st: number, now: number): void {
    this.st[i] = st; this.settled[i] = 0; this.fd[i] = 0;
    this.t1[i] = now; this.rs[i] = -Infinity; this.mt0[i] = NaN; this.ft0[i] = -Infinity;
    this.rd[i] = 0; this.md[i] = 0; this.rv[i] = 1; this.hv[i] = 1; this.mv[i] = 1;
  }
}

/** Open-addressing table of entry indices by content hash. */
export class KeyTable {
  private t = new Int32Array(128);
  private mask = 127;
  private hs: Uint32Array = new Uint32Array(0);
  private pos = 0;
  private h = 0;

  build(hashes: Uint32Array, n: number): void {
    let cap = 128;
    while (cap < 2 * n) cap *= 2;
    if (this.t.length < cap) this.t = new Int32Array(cap);
    this.mask = cap - 1;
    this.t.fill(-1, 0, cap);
    this.hs = hashes;
    for (let j = 0; j < n; j++) {
      let p = hashes[j] & this.mask;
      while (this.t[p] !== -1) p = (p + 1) & this.mask;
      this.t[p] = j;
    }
  }

  /** Start iterating the entries with hash h. */
  find(h: number): void { this.h = h >>> 0; this.pos = this.h & this.mask; }

  /** Next entry with the started hash, or −1. */
  next(): number {
    for (;;) {
      const j = this.t[this.pos];
      if (j === -1) return -1;
      this.pos = (this.pos + 1) & this.mask;
      if (this.hs[j] === this.h) return j;
    }
  }
}

/** Polys a and b chain (consecutive gen ≥ 1 pieces of one filament sharing an end point). */
export function linked(c: Cooked, a: number, b: number): boolean {
  if (c.gen[a] === 0 || c.gen[a] !== c.gen[b] || c.unit[a] !== c.unit[b] || c.kind[a] !== c.kind[b]) return false;
  if (c.count[a] < 2 || c.count[b] < 2) return false;
  const p = c.pts, ia = 4 * (c.start[a] + c.count[a] - 1), ib = 4 * c.start[b];
  return p[ia] === p[ib] && p[ia + 1] === p[ib + 1];
}

/** Chain offsets/totals for polys from the head of the chain containing k to the end. */
export function computeChains(c: Cooked, S: PolyState, k: number): void {
  const n = c.nPolys;
  let i = Math.max(0, Math.min(k, n));
  while (i > 0 && i < n && linked(c, i - 1, i)) i--;
  while (i < n) {
    let j = i, off = S.len[i];
    S.coff[i] = 0;
    while (j + 1 < n && linked(c, j, j + 1)) { j++; S.coff[j] = off; off += S.len[j]; }
    for (let q = i; q <= j; q++) S.ctot[q] = off;
    i = j + 1;
  }
}

/** Device-px rect of entry i (box, plus the morph box while morphing), padded for joins and AA. */
export function dirtyEntry(list: RectList, S: PolyState, i: number, m: Mat2x3, sc: number): void {
  const b = S.box, o = 4 * i;
  const pad = 2 + 0.1 * S.wmax[i] * sc;
  addBox(list, m, b[o], b[o + 1], b[o + 2], b[o + 3], pad);
  if (S.mt0[i] === S.mt0[i]) {
    const mb = S.mbox;
    addBox(list, m, mb[o], mb[o + 1], mb[o + 2], mb[o + 3], pad);
  }
}

/** Morph box of entry i: its box united with the bbox of its `from` points (± half its max width). */
export function setMorphBox(S: PolyState, i: number, c: Cooked, from: Float32Array): void {
  const st = c.start[i], n = c.count[i], o = 4 * i, h = 0.5 * S.wmax[i];
  let x0 = S.box[o], y0 = S.box[o + 1], x1 = S.box[o + 2], y1 = S.box[o + 3];
  for (let j = st; j < st + n; j++) {
    const x = from[2 * j], y = from[2 * j + 1];
    if (x - h < x0) x0 = x - h; if (x + h > x1) x1 = x + h;
    if (y - h < y0) y0 = y - h; if (y + h > y1) y1 = y + h;
  }
  S.mbox[o] = x0; S.mbox[o + 1] = y0; S.mbox[o + 2] = x1; S.mbox[o + 3] = y1;
}

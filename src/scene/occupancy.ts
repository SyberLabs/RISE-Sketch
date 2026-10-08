/**
 * Occupancy: ink that knows about other ink (DESIGN §2.3.9).
 *
 * A sparse multi-level grid in doc space with exact integer keys (level, ix, iy).
 * Level ℓ has square cells of 2^ℓ doc units; a stroke drawn at zoom z belongs to
 * the level whose cell is closest to 8 sp, ℓ(z) = round(log2(8 / z)), and its spine
 * capsules count in levels ℓ−2 … ℓ+2. A reading stroke queries only its own level,
 * so ink drawn more than about two octaves of zoom away is not "nearby".
 *
 * Splat: the sample polyline is walked as chords of at least half a cell, each
 * carrying its true arc length, and each chord deposits its capsule area w·arc
 * (w = 0.7·S / z, doc) in pieces of at most a cell along it and, for capsules wider
 * than a cell, lanes a cell apart across it (≤ 16); the end caps add π w²/4 so a tap
 * still registers. Consecutive pieces in one cell merge into a run, and each run is
 * rounded to fixed point (1/65536 of the cell area) before anything else. Cell
 * values are therefore exact integer sums of per-run terms that depend only on the
 * recipe: removal cancels exactly, the grid returns to all-zero, and crowding never
 * depends on the order strokes arrived in. No cook is needed.
 *
 * Materialisation is lazy, per 32×32-cell block of a level. A query first builds
 * the blocks its disc touches, splatting (clipped to the block) only the strokes
 * whose boxes reach it, found through an R-tree of members; `warm` builds blocks
 * around a point ahead of time in slices. add/remove deposit only into blocks
 * already built. Because rounding happens per run before clipping, a cell holds
 * the same integer whenever its block was built, so lazy ≡ eager bit for bit, while
 * a 2,000-stroke document loads without rasterising five levels nobody reads and a
 * reader zoomed far in pays only for the ink near the pen.
 *
 * Queries use an antialiased disc: each cell is weighted by
 * clamp01((R − d)/cell + ½), d = distance from the disc centre to the cell centre,
 * so crowding varies smoothly as the nib moves instead of stepping at cell edges.
 *
 *   cov(R) = Σ weight·inked / Σ weight·cellArea
 *   c      = smoothstep(0.02, 0.35, cov(48 sp))
 *   CS     = c16(p + 24 sp·n) − c16(p − 24 sp·n),   c16 = smoothstep(0.02, 0.35, cov(16 sp))
 *
 * A stroke never sees itself: the live stroke is only added at commit, and the
 * values it read are frozen into its samples (S.C / S.CS).
 *
 * Only exact operations feed the grid (levels from exact powers of two, no
 * transcendentals), so the frozen C/CS values are reproducible across engines.
 */
import { S } from '../core/types';
import type { AABB, StrokeRecipe } from '../core/types';
import { pow2i } from '../core/det';
import { smoothstep } from '../core/num';
import { RTree } from './rtree';
import { placedSamples } from '../ink/symmetry';

export interface Occupancy {
  add(r: StrokeRecipe): void; remove(r: StrokeRecipe): void; clear(): void;
  /** Crowding c in [0, 1] at absolute doc (x, y) for a stroke drawn at zoom z. */
  crowding(x: number, y: number, z: number): number;
  /** Side crowding CS in [−1, 1]; (nx, ny) is the unit normal (left of travel). */
  side(x: number, y: number, nx: number, ny: number, z: number): number;
}

/** The grid with its lifecycle and introspection hooks (scene, tests, debug HUD). */
export interface OccupancyGrid extends Occupancy {
  /** Raw coverage fraction (inked area / disc area, unclamped) in a disc of rSp sp (capped at 512 sp). */
  coverage(x: number, y: number, rSp: number, z: number): number;
  /**
   * Swap a tracked recipe for its replacement. When both have the same footprint
   * (samples, origin, z, size) only membership changes; otherwise remove + add.
   */
  replace(before: StrokeRecipe, after: StrokeRecipe): void;
  /** Build now every block of zoom z's level within a square of half-size rSp sp around (x, y) (≤ 32 blocks each way). */
  build(x: number, y: number, rSp: number, z: number): void;
  /**
   * The same build, time-sliced and centre-out: one step per `next()`, each walking
   * about `samplesPerStep` sample rows. Safe to interleave with add/remove/queries.
   */
  warm(x: number, y: number, rSp: number, z: number, samplesPerStep?: number): Iterator<void>;
  /** True when the block holding (x, y) at zoom z's level is materialised. */
  isBuilt(x: number, y: number, z: number): boolean;
  /** Non-zero cells across all materialised blocks (0 after every stroke is removed). */
  readonly cells: number;
  /** Strokes currently tracked. */
  readonly strokes: number;
  /** Materialised blocks across all levels. */
  readonly blocks: number;
}

/** Target cell size, sp. */
export const CELL_SP = 8;
/** Levels a stroke counts in on each side of its own level. */
export const LEVEL_SPREAD = 2;
/** Capsule width as a fraction of nib size (no cook needed). */
export const WIDTH_FACTOR = 0.7;
export const CROWD_R_SP = 48;
export const SIDE_R_SP = 16;
export const SIDE_OFF_SP = 24;
/** log2 of the block side in cells (32). */
export const BLOCK_SHIFT = 5;
const BLOCK = 1 << BLOCK_SHIFT;
/** Fixed-point units per fully covered cell. */
const Q = 65536;
/** Most lanes a wide capsule is split into across its width. */
const MAX_LANES = 16;
/**
 * Most pieces along one chord. Real chords span a few dozen cells at most; the cap
 * only bounds the work for corrupt or absurd input (the area is still conserved).
 */
const MAX_PIECES = 4096;
/** Most blocks `touches` scans before conservatively answering yes (the result is the same either way). */
const MAX_TOUCH_BLOCKS = 256;
/** Zoom range over which levelFor is exact; reads clamp z into it so disc and cells stay consistent. */
const Z_LO = CELL_SP / 1048576, Z_HI = CELL_SP * 1048576;
/** Largest disc radius (sp) `coverage` reads: 64 cells, far beyond the 48 sp crowding disc. */
const MAX_COVER_SP = 64 * CELL_SP;
/** Largest warm/build half-extent in blocks around the centre. */
const WARM_MAX_BLOCKS = 32;
const SQRT2 = 1.4142135623730951;
const I32_MAX = 2147483647;
const EMPTY = -128, TOMB = -127; // slot states folded into the Int8 level key
const CLIP_RECT = 0, CLIP_BUILT = 1;

/** Grid level for a stroke drawn at zoom z: the cell nearest to 8 sp (exact; no logarithms). */
export function levelFor(z: number): number {
  let v = CELL_SP / z;
  if (!(v > 0) || v === Infinity) v = CELL_SP;
  if (v < 1 / 1048576) v = 1 / 1048576;
  if (v > 1048576) v = 1048576;
  let l = 0, p = 1;
  while (p * 2 <= v) { p *= 2; l++; }
  while (p > v) { p *= 0.5; l--; }
  // 2^l ≤ v < 2^(l+1); round in log space at the geometric midpoint
  return v >= p * SQRT2 ? l + 1 : l;
}

/** Bit-exact equality of two Float32 arrays (NaN-safe). */
export function sameBits(a: Float32Array | null, b: Float32Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

/** True when two recipes splat identically (everything the occupancy grid reads). */
export const sameFootprint = (a: StrokeRecipe, b: StrokeRecipe): boolean =>
  a === b || (a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1] && a.z === b.z &&
    a.stroke.size === b.stroke.size && sameBits(a.samples, b.samples) && sameXf(a.xf, b.xf));

const sameXf = (a: Float64Array | null, b: Float64Array | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** True for finite numbers (false for NaN and ±Infinity). */
const finite = (v: number): boolean => v - v === 0;

/** A reader's zoom clamped to where levels are exact (NaN and z ≤ 0 stay as they are: callers reject them). */
const readZ = (z: number): number => (z > 0 && z < Z_LO ? Z_LO : z > Z_HI ? Z_HI : z);

const cellIndex = (v: number): number => {
  const i = Math.floor(v);
  return i > I32_MAX ? I32_MAX : i < -I32_MAX ? -I32_MAX : i;
};

/** Capsule width of a recipe in doc units, or 0 when it cannot be splatted. */
const capsuleWidth = (r: StrokeRecipe): number => {
  const w = r.z > 0 ? (WIDTH_FACTOR * r.stroke.size) / r.z : 0;
  return w > 0 && w !== Infinity ? w : 0;
};

/**
 * Open-addressing hash map (level, ix, iy) -> integer value (held in a Float64 so
 * sums stay exact far beyond Int32). Zero values are deleted. 17 bytes per slot.
 */
class CellMap {
  private kl!: Int8Array; private kx!: Int32Array; private ky!: Int32Array;
  private val!: Float64Array;
  private mask = 0;
  used = 0;
  private tomb = 0;

  constructor(cap = 1024) { this.alloc(cap); }

  private alloc(cap: number): void {
    this.kl = new Int8Array(cap).fill(EMPTY);
    this.kx = new Int32Array(cap); this.ky = new Int32Array(cap);
    this.val = new Float64Array(cap);
    this.mask = cap - 1; this.used = 0; this.tomb = 0;
  }

  private static hash(l: number, x: number, y: number): number {
    let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(l + 64, 0xc2b2ae3d);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    return (h ^ (h >>> 15)) >>> 0;
  }

  get(l: number, x: number, y: number): number {
    const m = this.mask, kl = this.kl;
    for (let i = CellMap.hash(l, x, y) & m; ; i = (i + 1) & m) {
      const s = kl[i];
      if (s === EMPTY) return 0;
      if (s === l && this.kx[i] === x && this.ky[i] === y) return this.val[i];
    }
  }

  add(l: number, x: number, y: number, dv: number): void {
    if (dv === 0) return;
    if ((this.used + this.tomb + 1) * 2 > this.mask + 1) this.grow();
    const m = this.mask, kl = this.kl;
    let free = -1;
    for (let i = CellMap.hash(l, x, y) & m; ; i = (i + 1) & m) {
      const s = kl[i];
      if (s === l && this.kx[i] === x && this.ky[i] === y) {
        const v = this.val[i] + dv;
        if (v === 0) { kl[i] = TOMB; this.used--; this.tomb++; } else this.val[i] = v;
        return;
      }
      if (s === TOMB) {
        if (free < 0) free = i;
      } else if (s === EMPTY) {
        if (free >= 0) { this.tomb--; i = free; }
        kl[i] = l; this.kx[i] = x; this.ky[i] = y; this.val[i] = dv;
        this.used++;
        return;
      }
    }
  }

  private grow(): void {
    const { kl, kx, ky, val } = this;
    const cap = this.mask + 1;
    // grow only when live cells need it; otherwise rehash in place to purge tombstones
    this.alloc(this.used * 4 > cap ? cap * 2 : cap);
    for (let i = 0; i < cap; i++) if (kl[i] > TOMB) this.add(kl[i], kx[i], ky[i], val[i]);
  }

  clear(): void { this.alloc(1024); }
}

interface Member { own: number; box: AABB | null }

/** Create an empty occupancy grid. */
export function createOccupancy(): OccupancyGrid {
  const grid = new CellMap();
  const built = new CellMap(256);              // (level, bx, by) -> 1 for materialised blocks
  const perLevel = new Map<number, number>();  // level -> materialised block count
  const members = new Map<StrokeRecipe, Member>();
  const tree = new RTree<StrokeRecipe>();
  const cand: StrokeRecipe[] = [];
  const probe: AABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let blocks = 0;
  let epoch = 0; // bumped by clear(): abandons pending warm iterators

  // walk state (per grid, never module-level)
  let runX = 0, runY = 0, runAcc = 0, runOn = false, runL = 0, runQ = 0, runSign = 1;
  let clip = CLIP_RECT, cx0 = 0, cy0 = 0, cx1 = 0, cy1 = 0;
  let rx0 = 0, ry0 = 0, rx1 = 0, ry1 = 0; // CLIP_RECT in doc units: [rx0, rx1) × [ry0, ry1)
  let lastBX = 0, lastBY = 0, lastOk = false, lastValid = false;

  function flush(): void {
    if (!runOn) return;
    runOn = false;
    const units = Math.round(runAcc * runQ);
    runAcc = 0;
    if (units === 0) return;
    if (clip === CLIP_RECT) {
      if (runX < cx0 || runX > cx1 || runY < cy0 || runY > cy1) return;
    } else {
      const bx = runX >> BLOCK_SHIFT, by = runY >> BLOCK_SHIFT;
      if (!lastValid || bx !== lastBX || by !== lastBY) {
        lastBX = bx; lastBY = by; lastValid = true;
        lastOk = built.get(runL, bx, by) !== 0;
      }
      if (!lastOk) return;
    }
    grid.add(runL, runX, runY, runSign * units);
  }

  function deposit(x: number, y: number, a: number, inv: number): void {
    const ix = cellIndex(x * inv), iy = cellIndex(y * inv);
    if (runOn && ix === runX && iy === runY) { runAcc += a; return; }
    flush();
    runOn = true; runX = ix; runY = iy; runAcc = a;
  }

  /**
   * Deposit area w·arc along the chord A→B: pieces of at most one cell along it and,
   * for capsules wider than a cell, lanes one cell apart across it.
   */
  function chord(ax: number, ay: number, bx: number, by: number, arc: number, w: number, cs: number, inv: number): void {
    const dx = bx - ax, dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 0)) { deposit(ax, ay, w * arc, inv); return; }
    const k = Math.min(MAX_PIECES, Math.ceil(len * inv));
    const lanes = w > cs ? Math.min(MAX_LANES, Math.ceil(w * inv)) : 1;
    const a = (w * arc) / (k * lanes);
    const nx = (-dy / len) * w, ny = (dx / len) * w;
    for (let q = 0; q < lanes; q++) {
      const o = (q + 0.5) / lanes - 0.5;
      const sx = ax + nx * o, sy = ay + ny * o;
      for (let j = 0; j < k; j++) {
        const t = (j + 0.5) / k;
        deposit(sx + dx * t, sy + dy * t, a, inv);
      }
    }
  }

  /**
   * Can deposits inside the doc box [x0, x1] × [y0, y1] land in the clip? Chords that
   * cannot are skipped with a flush: a run inside the clip ends there either way (the
   * skipped deposits all fall in other cells), so the integers that reach the grid are
   * exactly those of the full walk. This keeps block builds and removals proportional
   * to the ink near the materialised blocks rather than to whole strokes.
   */
  function touches(x0: number, y0: number, x1: number, y1: number, l: number, inv: number): boolean {
    if (clip === CLIP_RECT) return x1 >= rx0 && x0 < rx1 && y1 >= ry0 && y0 < ry1;
    const bx0 = cellIndex(x0 * inv) >> BLOCK_SHIFT, bx1 = cellIndex(x1 * inv) >> BLOCK_SHIFT;
    const by0 = cellIndex(y0 * inv) >> BLOCK_SHIFT, by1 = cellIndex(y1 * inv) >> BLOCK_SHIFT;
    if ((bx1 - bx0 + 1) * (by1 - by0 + 1) > MAX_TOUCH_BLOCKS) return true; // yes is always safe
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) if (built.get(l, bx, by) !== 0) return true;
    }
    return false;
  }

  /** chord(), unless none of its deposits can reach the clip (lanes stay within w/2; one cell of slack for rounding). */
  function clippedChord(ax: number, ay: number, bx: number, by: number, arc: number, w: number, cs: number, inv: number, l: number): void {
    const pad = 0.5 * w + cs;
    const x0 = (ax < bx ? ax : bx) - pad, x1 = (ax > bx ? ax : bx) + pad;
    const y0 = (ay < by ? ay : by) - pad, y1 = (ay > by ? ay : by) + pad;
    if (touches(x0, y0, x1, y1, l, inv)) chord(ax, ay, bx, by, arc, w, cs, inv);
    else flush();
  }

  /**
   * Add (sign 1) or subtract (sign −1) recipe r's capsules in level l, keeping only
   * cells inside the clip (a block's cell rect, or every materialised block). Samples
   * merge into chords of at least half a cell carrying their true arc length, so the
   * cost follows the stroke's length in cells, not the pointer's sample rate.
   * Returns the number of sample rows walked.
   */
  function splat(r: StrokeRecipe, l: number, sign: number): number {
    const smp = placedSamples(r);
    const n = (smp.length / S.STRIDE) | 0;
    const w = capsuleWidth(r);
    if (n === 0 || w === 0) return 0;
    const ox = r.origin[0], oy = r.origin[1];
    const cs = pow2i(l), inv = pow2i(-l);
    const min2 = 0.25 * cs * cs; // (half a cell)²
    const cap = 0.39269908169872414 * w * w; // π w² / 8: half of the two end caps
    runL = l; runQ = Q / (cs * cs); runSign = sign;
    runOn = false; runAcc = 0; lastValid = false;
    // non-finite rows (corrupt input) are skipped as if absent, here and in memberBox
    let i = 0;
    while (i < n && !(finite(smp[i * S.STRIDE + S.X]) && finite(smp[i * S.STRIDE + S.Y]))) i++;
    if (i === n) return n;
    let px = ox + smp[i * S.STRIDE + S.X], py = oy + smp[i * S.STRIDE + S.Y]; // chord start
    let lx = px, ly = py;                                                     // last sample
    let arc = 0;
    deposit(px, py, cap, inv);
    for (i++; i < n; i++) {
      const bx = ox + smp[i * S.STRIDE + S.X], by = oy + smp[i * S.STRIDE + S.Y];
      if (!(finite(bx) && finite(by))) continue;
      const sx = bx - lx, sy = by - ly;
      arc += Math.sqrt(sx * sx + sy * sy);
      lx = bx; ly = by;
      const cx = lx - px, cy = ly - py;
      if (cx * cx + cy * cy >= min2) {
        clippedChord(px, py, lx, ly, arc, w, cs, inv, l);
        px = lx; py = ly; arc = 0;
      }
    }
    if (arc > 0) clippedChord(px, py, lx, ly, arc, w, cs, inv, l);
    deposit(lx, ly, cap, inv);
    flush();
    return n;
  }

  /**
   * Absolute box of everything r can deposit: sample bbox padded by w/2. Null when
   * nothing can be splatted (no finite sample, zero width, non-finite origin); such a
   * recipe is tracked but never touches the grid.
   */
  function memberBox(r: StrokeRecipe): AABB | null {
    const w = capsuleWidth(r);
    const smp = placedSamples(r);
    const n = (smp.length / S.STRIDE) | 0;
    if (w === 0 || n === 0) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = smp[i * S.STRIDE + S.X], y = smp[i * S.STRIDE + S.Y];
      if (!(finite(x) && finite(y))) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!(x0 <= x1 && y0 <= y1)) return null;
    const pad = 0.5 * w;
    const b = { x0: r.origin[0] + x0 - pad, y0: r.origin[1] + y0 - pad, x1: r.origin[0] + x1 + pad, y1: r.origin[1] + y1 + pad };
    return finite(b.x0) && finite(b.y0) && finite(b.x1) && finite(b.y1) ? b : null;
  }

  const near = (own: number, l: number): boolean => own - l <= LEVEL_SPREAD && l - own <= LEVEL_SPREAD;

  /** Materialise block (l, bx, by): splat every nearby member, clipped to it. Returns rows walked. */
  function buildBlock(l: number, bx: number, by: number): number {
    built.add(l, bx, by, 1);
    perLevel.set(l, (perLevel.get(l) ?? 0) + 1);
    blocks++;
    const cs = pow2i(l);
    const ix0 = bx * BLOCK, iy0 = by * BLOCK;
    // one cell of slack covers deposits that round onto the block edge
    probe.x0 = (ix0 - 1) * cs; probe.y0 = (iy0 - 1) * cs;
    probe.x1 = (ix0 + BLOCK + 1) * cs; probe.y1 = (iy0 + BLOCK + 1) * cs;
    cand.length = 0;
    tree.search(probe, cand);
    clip = CLIP_RECT; cx0 = ix0; cy0 = iy0; cx1 = ix0 + BLOCK - 1; cy1 = iy0 + BLOCK - 1;
    rx0 = ix0 * cs; ry0 = iy0 * cs; rx1 = (ix0 + BLOCK) * cs; ry1 = (iy0 + BLOCK) * cs;
    let walked = 0;
    for (const r of cand) {
      const m = members.get(r);
      if (m && near(m.own, l)) walked += splat(r, l, 1);
    }
    return walked;
  }

  /** Build every missing block of level l over the cell rect [ix0, ix1] × [iy0, iy1]. */
  function ensureCells(l: number, ix0: number, iy0: number, ix1: number, iy1: number): void {
    const bx0 = ix0 >> BLOCK_SHIFT, bx1 = ix1 >> BLOCK_SHIFT;
    const by0 = iy0 >> BLOCK_SHIFT, by1 = iy1 >> BLOCK_SHIFT;
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) if (built.get(l, bx, by) === 0) buildBlock(l, bx, by);
    }
  }

  /** Splat r into every materialised block of the levels it counts in. */
  function splatBuilt(r: StrokeRecipe, own: number, sign: number): void {
    for (const [l, count] of perLevel) {
      if (count === 0 || !near(own, l)) continue;
      clip = CLIP_BUILT;
      splat(r, l, sign);
    }
  }

  function add(r: StrokeRecipe): void {
    if (members.has(r)) return;
    const m: Member = { own: levelFor(r.z), box: memberBox(r) };
    members.set(r, m);
    if (m.box) tree.insert(m.box, r);
    if (blocks > 0 && m.box) splatBuilt(r, m.own, 1);
  }

  function remove(r: StrokeRecipe): void {
    const m = members.get(r);
    if (!m) return;
    members.delete(r);
    if (m.box) {
      tree.remove(r);
      if (blocks > 0) splatBuilt(r, m.own, -1);
    }
  }

  function coverage(x: number, y: number, rDoc: number, l: number): number {
    if (!(rDoc > 0) || !(finite(x) && finite(y)) || members.size === 0) return 0;
    const cs = pow2i(l), inv = pow2i(-l);
    const ix0 = cellIndex((x - rDoc) * inv), ix1 = cellIndex((x + rDoc) * inv);
    const iy0 = cellIndex((y - rDoc) * inv), iy1 = cellIndex((y + rDoc) * inv);
    ensureCells(l, ix0, iy0, ix1, iy1);
    if (grid.used === 0) return 0;
    let num = 0, den = 0;
    for (let iy = iy0; iy <= iy1; iy++) {
      const dy = (iy + 0.5) * cs - y;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = (ix + 0.5) * cs - x;
        let wgt = (rDoc - Math.sqrt(dx * dx + dy * dy)) * inv + 0.5;
        if (wgt <= 0) continue;
        if (wgt > 1) wgt = 1;
        den += wgt;
        num += wgt * grid.get(l, ix, iy);
      }
    }
    return den > 0 ? num / (den * Q) : 0;
  }

  const crowd = (cov: number): number => smoothstep(0.02, 0.35, cov);

  function* warmAround(x: number, y: number, rSp: number, z: number, budget: number): Generator<void> {
    if (!(z > 0) || !(rSp > 0) || !(finite(x) && finite(y))) return;
    z = readZ(z);
    const l = levelFor(z), inv = pow2i(-l), rDoc = rSp / z;
    const cbx = cellIndex(x * inv) >> BLOCK_SHIFT, cby = cellIndex(y * inv) >> BLOCK_SHIFT;
    // at most WARM_MAX_BLOCKS blocks either side of the centre (bounds memory for huge radii)
    const bx0 = Math.max(cbx - WARM_MAX_BLOCKS, cellIndex((x - rDoc) * inv) >> BLOCK_SHIFT);
    const bx1 = Math.min(cbx + WARM_MAX_BLOCKS, cellIndex((x + rDoc) * inv) >> BLOCK_SHIFT);
    const by0 = Math.max(cby - WARM_MAX_BLOCKS, cellIndex((y - rDoc) * inv) >> BLOCK_SHIFT);
    const by1 = Math.min(cby + WARM_MAX_BLOCKS, cellIndex((y + rDoc) * inv) >> BLOCK_SHIFT);
    const todo: number[] = [];
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) todo.push(bx, by);
    // centre-out: the block under the camera first
    const order = Array.from({ length: todo.length >> 1 }, (_, k) => k);
    const d = (k: number) => Math.max(Math.abs(todo[2 * k] - cbx), Math.abs(todo[2 * k + 1] - cby));
    order.sort((a, b) => d(a) - d(b) || a - b);
    const myEpoch = epoch;
    let spent = 0;
    for (const k of order) {
      if (epoch !== myEpoch) return;
      const bx = todo[2 * k], by = todo[2 * k + 1];
      if (built.get(l, bx, by) !== 0) continue;
      spent += buildBlock(l, bx, by) + 64; // a block with no ink still costs a little
      if (spent >= budget) { spent = 0; yield; }
    }
  }

  return {
    add,
    remove,
    replace(before, after) {
      if (before === after) return;
      if (!members.has(before)) { add(after); return; }
      if (members.has(after)) { remove(before); return; }
      if (sameFootprint(before, after)) {
        const m = members.get(before)!;
        members.delete(before);
        members.set(after, m);
        if (m.box) { tree.remove(before); tree.insert(m.box, after); }
        return;
      }
      remove(before);
      add(after);
    },
    clear() {
      grid.clear(); built.clear(); perLevel.clear(); members.clear(); tree.clear();
      blocks = 0;
      epoch++;
    },
    crowding(x, y, z) {
      if (members.size === 0 || !(z > 0)) return 0;
      z = readZ(z);
      return crowd(coverage(x, y, CROWD_R_SP / z, levelFor(z)));
    },
    side(x, y, nx, ny, z) {
      if (members.size === 0 || !(z > 0)) return 0;
      const len = Math.sqrt(nx * nx + ny * ny);
      if (!(len > 0 && len < Infinity)) return 0;
      z = readZ(z);
      const off = SIDE_OFF_SP / z / len, r = SIDE_R_SP / z, l = levelFor(z);
      return crowd(coverage(x + nx * off, y + ny * off, r, l)) - crowd(coverage(x - nx * off, y - ny * off, r, l));
    },
    coverage(x, y, rSp, z) {
      if (!(z > 0) || !(rSp < Infinity)) return 0;
      z = readZ(z);
      // the disc never needs more than CROWD_R_SP-scale radii; cap it so a huge rSp cannot stall
      return coverage(x, y, Math.min(rSp, MAX_COVER_SP) / z, levelFor(z));
    },
    build(x, y, rSp, z) {
      const it = warmAround(x, y, rSp, z, Infinity);
      while (!it.next().done) { /* drain */ }
    },
    warm(x, y, rSp, z, samplesPerStep = 2048) {
      return warmAround(x, y, rSp, z, samplesPerStep > 0 ? samplesPerStep : 2048);
    },
    isBuilt(x, y, z) {
      if (!(z > 0) || !(finite(x) && finite(y))) return false;
      const l = levelFor(readZ(z)), inv = pow2i(-l);
      return built.get(l, cellIndex(x * inv) >> BLOCK_SHIFT, cellIndex(y * inv) >> BLOCK_SHIFT) !== 0;
    },
    get cells() { return grid.used; },
    get strokes() { return members.size; },
    get blocks() { return blocks; },
  };
}

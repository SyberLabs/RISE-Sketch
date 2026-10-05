/**
 * Cook: recipe -> colourless Cooked geometry, live and committed through ONE code path
 * (DESIGN §7.4, §7.5 rule 1):
 *
 *     cook(r) ≡ createIncrementalCook(draftOf(r)).finish(r)        (literally)
 *
 * and finish(r) after ANY append chunking, regrow schedule or closure toggling returns a
 * bit-identical Cooked. This holds by construction, not by re-cooking everything at lift:
 *
 * ─── Units ──────────────────────────────────────────────────────────────────────────
 *  - Trunk blocks: gen-0 polys of the stations in absolute 50 sp blocks (block u starts
 *    at the first station with s ≥ 50u; adjacent blocks share their boundary station, so
 *    chunks weld). Inside a block, core chunks split where the tone changes; brush
 *    dry-split bristles follow. unit = u.
 *  - Growth units (Sprout anchors, Drift stations): a sequential chain decides each unit's
 *    arc and frozen choices from the spine around it; the unit is cooked once at
 *    its ceiling and truncated to d(s_unit). unit = chain index.
 *  - Echo's crystal and radial seeds are built at finish only.
 * Every unit is a pure function of (spine within its reach, the depth field, the entry
 * taper / closure head inputs, its rng address). A unit is emitted only once its whole
 * reach is SETTLED (spine stations below `settled` never change before finish), so the
 * live and the one-shot cook emit the same units with the same inputs.
 *
 * ─── What can change an emitted unit (and how it is re-emitted, never patched) ─────────
 *  - Pools: the cook keeps its own copy of the pool rows and diffs it against the draft on
 *    every append / regrow / setClosing and against r.pools at finish. Each changed row
 *    marks [s_i − 48, s_i + 32]; Line blocks within 24 sp re-cook, growth units there
 *    re-truncate (never re-cook), and the causal budget is re-walked. regrow(s0, s1) adds
 *    its window to that diff, so pool edits the caller did not report (the lift guard)
 *    are still caught.
 *  - Head inputs: the entry taper (until 40 ms of rows exist) and closure (Te → 0, Line's
 *    head pin) re-emit units in the first ≤ 42 sp when they change.
 *  - Finish (the declared lift zones): end flush (only provisional stations change), the
 *    final envelope (exit taper, seated bulb, TeTrunk ≤ 0.25·len), the seam weld of closed
 *    loops (stations s ≥ L − 56 and s ≤ s0 + 6 move), Sprout tail anchors (s ≤ L − 6),
 *    Drift tail stations, Echo's crystal, radial seeds. Units touching those zones re-emit.
 *
 * ─── Live view ─────────────────────────────────────────────────────────────────────────
 * view().geom holds every current poly, gen-sorted: settled units plus the PROVISIONAL tail
 * (trunk from the last settled block to the nib, round tip, no exit taper; Line's crackle
 * fades in over 20 sp behind the nib; growth units only where a pool has raised the
 * depth above base, so a hold visibly rises right under the nib). An additive `slot`
 * array maps each poly to its stable drain id (−1 = provisional). view().ghost is Echo's
 * ghost. After finish, view() returns the finished geometry and, for Echo, the fold-out
 * MorphSet (t0 = lift time on the stroke clock, ms since pen-down; the live layer adds
 * its pen-down timestamp).
 *
 * ─── drainSettled ──────────────────────────────────────────────────────────────────────
 * Each settled poly is delivered exactly once with a stable `index` (a monotonic id, never
 * reused). A re-emitted unit's k-th poly supersedes its previous k-th poly (`replaces` =
 * that id, or the id it was itself replacing if it was never drained); when a unit now
 * has fewer polys, the surplus old ones are superseded by EMPTY polys (pts.length 0).
 * After finish nothing more is drained: the committed Cooked replaces the live stroke.
 */
import type {
  Cooked, CookFn, CreateIncrementalCook, DepthField, DraftStroke, IncrementalCook, LiveView, MorphSet,
  PolyView, RecipeCore, RecipeView, Spine, StrokeRecipe, AABB,
} from '../core/types';
import { PL, PolyKind, S } from '../core/types';
import { hash32, Ch, dcos, dsin } from '../core/det';
import { clamp, smoothstep } from '../core/num';
import { F64 } from '../core/pool';
import { createSpineBuilder, buildSpine, RESUME, type SpineBuilder, type Tip } from './spine';
import { finalEnvelope, type InkEnvelope } from './envelope';
import { kernel } from './depth';
import { NIBS, CHISEL_CORE, chiselAngle } from './nibs';
import { rowsOf, entrySpeed, entryKnown } from './signals';
import { CurlField } from './noise';
import { operatorFor } from './operators/registry';
import { line } from './operators/line.v1';
import {
  Plan, planCrystal, buildCrystal, emitCrystal, echoGhost, crystalBucket, crystalFade, spineMeans, chordSp, MIN_CHORD,
  SpinePressure, type CrystalOut,
} from './operators/echo.v1';
import {
  PolyBuf, Sampler, TrunkPts, UnitGeom, plainTrunk, writeTrunk, radialSeed, toneOf, glow,
  type ChainCursor, type ChainRecord, type FormCx, type FormOps, type RadialSeed, type TrunkStyle,
} from './operators/types';

/** Trunk block length (sp): chunks split at every 50 sp of absolute arc. */
export const BLOCK = 50;
/** Head zone (sp past s0) that the entry taper (≤ 30 sp) and Line's closed pin (12 sp) can touch. */
const HEAD = 42;
/** Seam weld lift zone (sp): W ≤ 50 plus the 6 sp frame recompute. */
const WELD_TAIL = 56, WELD_HEAD = 6;
/** Provisional Line crackle fades in over this arc behind the nib (sp). */
const TIP_FADE = 20;
/** Lattice for the Drift field: λ/2 = 140 sp at the commit zoom. */
const FIELD_CELL = 140;
/** Resume layout appended after the spine's RESUME fields (split pieces). */
const enum RES { MARK = 0, PHASE = 1, S = 2, J = 3, SIDE = 4, BUDGET = 5, LENGTH = 6 }
const RES_MARK = 0x52; // 'R'

// ============================================================================ depth field

/** d(s) = base + max_i a_i·K(s − s_i) over the cook's own copy of the pool rows. */
class Depth implements DepthField {
  base = 0;
  P = new Float32Array(8 * PL.STRIDE);
  n = 0;
  at(s: number): number {
    const P = this.P;
    let m = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * PL.STRIDE, a = P[o + PL.A];
      if (a <= m) continue;
      const v = a * kernel(s - P[o + PL.S]);
      if (v > m) m = v;
    }
    return this.base + m;
  }
  maxPool(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) { const a = this.P[i * PL.STRIDE + PL.A]; if (a > m) m = a; }
    return m;
  }
  /** Replace the rows; returns the union window [lo, hi] of changed rows' reach, or null. */
  sync(src: Float32Array, n: number, win: Float64Array): boolean {
    let lo = Infinity, hi = -Infinity;
    const P = this.P, m = Math.max(n, this.n);
    for (let i = 0; i < m; i++) {
      const o = i * PL.STRIDE;
      const has0 = i < this.n, has1 = i < n;
      const s0 = has0 ? P[o + PL.S] : NaN, a0 = has0 ? P[o + PL.A] : 0;
      const s1 = has1 ? src[o + PL.S] : NaN, a1 = has1 ? src[o + PL.A] : 0;
      if (has0 && has1 && s0 === s1 && a0 === a1) continue;
      if (has0 && a0 > 0) { if (s0 - 48 < lo) lo = s0 - 48; if (s0 + 32 > hi) hi = s0 + 32; }
      if (has1 && a1 > 0) { if (s1 - 48 < lo) lo = s1 - 48; if (s1 + 32 > hi) hi = s1 + 32; }
    }
    if (n * PL.STRIDE > P.length) { const g = new Float32Array(Math.max(n * PL.STRIDE, 2 * P.length)); this.P = g; }
    this.P.set(src.subarray(0, n * PL.STRIDE));
    this.n = n;
    if (!(hi >= lo)) return false;
    win[0] = lo; win[1] = hi;
    return true;
  }
}

// ============================================================================ context

const ss = (T: number, x: number): number => (T > 0 ? smoothstep(0, T, x) : 1);

class Cx implements FormCx {
  sp: Spine;
  readonly at: Sampler;
  s0 = 0; L = 0; final = false; tipFade = 0; closed = false;
  cut: number;
  Te = 0;
  env: InkEnvelope | null = null;
  constructor(readonly r: RecipeCore, sp: Spine, readonly z: number, readonly depth: Depth, private readonly field: () => CurlField) {
    this.sp = sp; this.at = new Sampler(sp, 0);
    this.cut = r.cut;
  }
  get base(): number { return this.depth.base; }
  bind(sp: Spine, hi: number): void {
    this.sp = sp; this.at.set(sp, hi);
    this.s0 = sp.n > 0 ? sp.s[0] : this.r.s0;
    this.L = sp.n > 0 ? sp.s[hi] : this.r.s0;
  }
  inF(s: number): number { return ss(this.Te, s - this.s0); }
  trunkE(s: number): number { return this.env ? this.env.at(s) : ss(this.Te, s - this.s0); }
  curl(): CurlField { return this.field(); }
}

// ============================================================================ units

class Block {
  buf = new PolyBuf(32, 4);
  ids: number[] = [];
  teT = 0; closed = false;
  constructor(readonly u: number, readonly i0: number, readonly i1: number, readonly a0: number, readonly a1: number) {}
}

class GUnit {
  readonly rec: ChainRecord;
  geom = new UnitGeom();
  buf = new PolyBuf(64, 8);
  ids: number[] = [];
  D = -1; eIn = -1; exists = false; count = 0; dirty = true;
  /** Cooked at its ceiling (lazily: only once the causal budget lets the unit exist). */
  cooked = false;
  constructor(r: ChainRecord) { this.rec = { s: r.s, j: r.j, side: r.side, tmpl: r.tmpl }; }
}

/** One queued drain entry. */
interface Drain { id: number; buf: PolyBuf | null; k: number }

/** Live view with the stable drain id of every poly (−1 = provisional). */
export interface InkLiveView extends LiveView { slot: Int32Array }

/** The incremental cook with its additive API (the contract type is IncrementalCook). */
export interface InkIncrementalCook extends IncrementalCook {
  view(): InkLiveView | LiveView;
  /**
   * Split-piece resume state at the current settled station: the spine's RESUME fields
   * followed by the growth chain cursor and the causal budget spent. Take it right after
   * appending the last rows of piece 1 (see ink/spine.ts "Split pieces").
   */
  snapshot(): Float32Array;
  /**
   * The filtered tip of this cook's own spine builder (SpineBuilder.tip): exactly the Rise input
   * (sp relative to origin, pressure synthesised up to `now` for mouse/touch). Reused object.
   */
  tip(now?: number): Readonly<Tip>;
  /** Measured jitter J of the stroke so far (SpineBuilder.jitter, for the learner). */
  jitter(): number;
}

/** Entry taper Te (sp) for operators, with an explicit closure flag (≡ envelope.entryTaper). */
function teOf(r: RecipeView, closing: boolean): number {
  if (r.cut & 1 || closing) return 0;
  const { data, n } = rowsOf(r);
  if (n === 0) return 0;
  const vn = entrySpeed(data, n, r.z) / (r.calib.vMed > 0 ? r.calib.vMed : 0.9);
  return (4 + 26 * smoothstep(0.4, 2.0, vn)) * NIBS[r.stroke.nib].taper;
}

/** A resumed chain's next unit lies within this arc (sp) of the piece's s0 (Sprout Δ ≤ 72). */
const RESUME_SLACK = 128;

/**
 * Growth-chain cursor of a split piece from its resume state; returns the causal budget its
 * earlier pieces spent. A cursor snapshot() could not have produced (unknown phase, a
 * non-finite or far-off arc, a bad index, side or budget: a damaged file, or a resume taken
 * from another stroke) is ignored and the chain starts afresh at s0, so a bad resume can
 * never stall the cook by stepping through thousands of units.
 */
function readResume(d: RecipeView, cur: ChainCursor): number {
  const res = d.resume, o = RESUME.LENGTH;
  if (!res || res.length < o + RES.LENGTH || res[o + RES.MARK] !== RES_MARK) return 0;
  const phase = res[o + RES.PHASE], s = res[o + RES.S], j = res[o + RES.J];
  const side = res[o + RES.SIDE], spent = res[o + RES.BUDGET];
  const s0 = d.s0 === d.s0 ? d.s0 : 0;
  const okS = phase === 0 || (s - s0 >= -RESUME_SLACK && s - s0 <= RESUME_SLACK);
  const okJ = j >= 0 && j <= 0x7fffffff && Math.floor(j) === j;
  if (!((phase === 0 || phase === 1) && okS && okJ && (side === -1 || side === 0 || side === 1) && spent >= 0 && spent < Infinity)) return 0;
  cur.phase = phase; cur.s = phase === 0 ? 0 : s; cur.j = j; cur.side = side;
  return spent;
}

function poolsOf(d: RecipeView): { data: Float32Array; n: number } {
  const p = d.pools;
  return p instanceof Float32Array ? { data: p, n: Math.floor(p.length / PL.STRIDE) } : p;
}

const EMPTY32 = new Float32Array(0);

/**
 * Bitwise equality of two Float32 arrays, except that any NaN equals any NaN (the cook reads
 * every NaN alike, and an element-wise copy may canonicalise payloads); null equals only null.
 */
function sameBits(a: Float32Array | null, b: Float32Array | null): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length), y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && !(a[i] !== a[i] && b[i] !== b[i])) return false;
  return true;
}

// ============================================================================ assembly

interface Source { buf: PolyBuf; ids: readonly number[] | null }

/** Packs poly buffers into a gen-sorted Cooked (reused scratch for live views, exact for commits). */
class Assembler {
  private pts = new Float32Array(1024); private ang = new Float32Array(256);
  private start = new Uint32Array(64); private count = new Uint32Array(64);
  private kind = new Uint8Array(64); private gen = new Uint8Array(64); private tone = new Uint8Array(64);
  private alpha = new Float32Array(64); private born = new Float32Array(64); private unit = new Uint32Array(64);
  private box = new Float32Array(256); private slot = new Int32Array(64);
  private keyPolys = new Int32Array(16); private keyPts = new Int32Array(16);

  build(src: readonly Source[], exact: boolean, origin: readonly [number, number], sp: Spine | null,
    ceilingMax: number, coverage: number): { c: Cooked; slot: Int32Array } {
    let maxGen = 0, nPolys = 0, nPts = 0, chisel = false;
    for (const s of src) {
      const b = s.buf;
      for (let i = 0; i < b.nPolys; i++) {
        if (b.gen[i] > maxGen) maxGen = b.gen[i];
        nPts += b.count[i];
        if (b.kind[i] === PolyKind.Chisel) chisel = true;
      }
      nPolys += b.nPolys;
    }
    const keys = 2 * (maxGen + 1);
    if (keys > this.keyPolys.length) { this.keyPolys = new Int32Array(keys); this.keyPts = new Int32Array(keys); }
    const kp = this.keyPolys, kq = this.keyPts;
    kp.fill(0, 0, keys); kq.fill(0, 0, keys);
    for (const s of src) {
      const b = s.buf;
      for (let i = 0; i < b.nPolys; i++) { const k = 2 * b.gen[i] + (b.cat[i] ? 1 : 0); kp[k]++; kq[k] += b.count[i]; }
    }
    let ap = 0, aq = 0;
    for (let k = 0; k < keys; k++) { const p = kp[k], q = kq[k]; kp[k] = ap; kq[k] = aq; ap += p; aq += q; }
    const genStart = new Uint32Array(maxGen + 2);
    for (let g = 0; g <= maxGen; g++) genStart[g] = kp[2 * g];
    genStart[maxGen + 1] = nPolys;

    const A = <T extends Float32Array | Uint32Array | Uint8Array | Int32Array>(cur: T, n: number, mk: (n: number) => T): T =>
      exact ? mk(n) : (cur.length >= n ? cur : mk(Math.max(n, 2 * cur.length)));
    const pts = A(this.pts, 4 * nPts, (n) => new Float32Array(n));
    const ang = chisel ? A(this.ang, nPts, (n) => new Float32Array(n)) : null;
    const start = A(this.start, nPolys, (n) => new Uint32Array(n)), count = A(this.count, nPolys, (n) => new Uint32Array(n));
    const kind = A(this.kind, nPolys, (n) => new Uint8Array(n)), gen = A(this.gen, nPolys, (n) => new Uint8Array(n));
    const tone = A(this.tone, nPolys, (n) => new Uint8Array(n));
    const alpha = A(this.alpha, nPolys, (n) => new Float32Array(n)), born = A(this.born, nPolys, (n) => new Float32Array(n));
    const unit = A(this.unit, nPolys, (n) => new Uint32Array(n)), box = A(this.box, 4 * nPolys, (n) => new Float32Array(n));
    const slot = A(this.slot, nPolys, (n) => new Int32Array(n));
    if (!exact) {
      this.pts = pts; if (ang) this.ang = ang; this.start = start; this.count = count; this.kind = kind; this.gen = gen;
      this.tone = tone; this.alpha = alpha; this.born = born; this.unit = unit; this.box = box; this.slot = slot;
    }
    if (ang) ang.fill(0, 0, nPts);

    let ix0 = Infinity, iy0 = Infinity, ix1 = -Infinity, iy1 = -Infinity;
    let hx0 = Infinity, hy0 = Infinity, hx1 = -Infinity, hy1 = -Infinity;
    for (const s of src) {
      const b = s.buf;
      for (let i = 0; i < b.nPolys; i++) {
        const k = 2 * b.gen[i] + (b.cat[i] ? 1 : 0);
        const d = kp[k]++, q = kq[k], n = b.count[i], st = b.start[i];
        kq[k] = q + n;
        pts.set(b.pts.subarray(4 * st, 4 * (st + n)), 4 * q);
        if (ang && b.ang && b.kind[i] === PolyKind.Chisel) ang.set(b.ang.subarray(st, st + n), q);
        start[d] = q; count[d] = n; kind[d] = b.kind[i]; gen[d] = b.gen[i]; tone[d] = b.tone[i];
        alpha[d] = b.alpha[i]; born[d] = b.born[i]; unit[d] = b.unit[i];
        slot[d] = s.ids ? s.ids[i] : -1;
        const x0 = b.box[4 * i], y0 = b.box[4 * i + 1], x1 = b.box[4 * i + 2], y1 = b.box[4 * i + 3];
        box[4 * d] = x0; box[4 * d + 1] = y0; box[4 * d + 2] = x1; box[4 * d + 3] = y1;
        if (x0 < ix0) ix0 = x0; if (y0 < iy0) iy0 = y0; if (x1 > ix1) ix1 = x1; if (y1 > iy1) iy1 = y1;
        if (b.alpha[i] >= 0.3) { if (x0 < hx0) hx0 = x0; if (y0 < hy0) hy0 = y0; if (x1 > hx1) hx1 = x1; if (y1 > hy1) hy1 = y1; }
      }
    }
    if (sp) {
      for (let i = 0; i < sp.n; i++) {
        const h = 0.5 * sp.w[i], x = sp.x[i], y = sp.y[i];
        if (x - h < hx0) hx0 = x - h; if (y - h < hy0) hy0 = y - h; if (x + h > hx1) hx1 = x + h; if (y + h > hy1) hy1 = y + h;
      }
    }
    const ox = origin[0], oy = origin[1];
    const inkBox: AABB = ix1 >= ix0 ? { x0: ox + ix0, y0: oy + iy0, x1: ox + ix1, y1: oy + iy1 } : { x0: ox, y0: oy, x1: ox, y1: oy };
    const hitBox: AABB = hx1 >= hx0 ? { x0: ox + hx0, y0: oy + hy0, x1: ox + hx1, y1: oy + hy1 } : { ...inkBox };
    const sub = <T extends Float32Array | Uint32Array | Uint8Array | Int32Array>(a: T, n: number): T => (exact ? a : a.subarray(0, n) as T);
    const c: Cooked = {
      pts: sub(pts, 4 * nPts), ang: ang ? sub(ang, nPts) : null,
      start: sub(start, nPolys), count: sub(count, nPolys), kind: sub(kind, nPolys), gen: sub(gen, nPolys),
      tone: sub(tone, nPolys), alpha: sub(alpha, nPolys), born: sub(born, nPolys), unit: sub(unit, nPolys),
      box: sub(box, 4 * nPolys), genStart, nPolys, nPts, inkBox, hitBox, ceilingMax, coverage, bytes: 0,
    };
    c.bytes = c.pts.byteLength + (c.ang ? c.ang.byteLength : 0) + c.start.byteLength + c.count.byteLength +
      c.kind.byteLength + c.gen.byteLength + c.tone.byteLength + c.alpha.byteLength + c.born.byteLength +
      c.unit.byteLength + c.box.byteLength + c.genStart.byteLength;
    return { c, slot: sub(slot, nPolys) };
  }
}

// ============================================================================ the incremental cook

class Cook implements InkIncrementalCook {
  private readonly d: RecipeView;
  private readonly ops: FormOps;
  private readonly builder: SpineBuilder;
  private sp: Spine;
  private readonly z: number;
  private readonly depth = new Depth();
  private readonly cxS: Cx;
  private readonly cxP: Cx;
  private fieldObj: CurlField | null = null;
  private readonly style: TrunkStyle;
  private closing: boolean;
  /** Entry taper ignoring closure, and whether it can no longer change with more rows. */
  private teOpen = 0;
  private teFinal = false;
  private lastTe = NaN;
  private lastClosing = false;

  private readonly blocks: Block[] = [];
  private readonly units: GUnit[] = [];
  private readonly cur: ChainCursor = { phase: 0, s: 0, j: 0, side: 0 };
  private readonly provCur: ChainCursor = { phase: 0, s: 0, j: 0, side: 0 };
  private budget0 = 0;

  private readonly prov = new PolyBuf(256, 16);
  private readonly provUnits: GUnit[] = [];
  private provN = 0;
  private provBudgetOut = false;
  private radialLive = false;
  private radialCeil = 0;
  private readonly ghost = new PolyBuf(256, 8);
  /** Echo's crystal cap if the stroke lifted now (NaN: stale; see echoCeiling). */
  private echoCeil = NaN;
  private echoCeilL = NaN;
  private readonly echoPlan = new Plan();

  private readonly T = new TrunkPts();
  private readonly rec: ChainRecord = { s: 0, j: 0, side: 0, tmpl: 0 };
  private readonly win = new Float64Array(2);
  private readonly seedTmp: RadialSeed = { x: 0, y: 0, w: 0, p: 0, c: 0 };

  private nextId = 0;
  private readonly pending = new Map<number, number>();
  private queue: Drain[] = [];

  private readonly asm = new Assembler();
  private readonly liveSrc: Source[] = [];
  private readonly provSrc: Source = { buf: this.prov, ids: null };
  private readonly ghostAsm = new Assembler();
  private dirty = true;
  private live: InkLiveView | null = null;

  private done: Cooked | null = null;
  private doneView: LiveView | null = null;

  constructor(d: RecipeView) {
    this.d = d;
    this.ops = operatorFor(d.form.form, d.form.v);
    this.z = d.z > 0 ? d.z : 1;
    this.builder = createSpineBuilder(d);
    this.sp = this.builder.spine;
    this.depth.base = d.form.base;
    this.closing = 'closing' in d ? d.closing : d.closed;
    const field = (): CurlField => this.fieldObj ?? (this.fieldObj = new CurlField(hash32(d.seed >>> 0, Ch.Field), FIELD_CELL / this.z));
    this.cxS = new Cx(d, this.sp, this.z, this.depth, field);
    this.cxP = new Cx(d, this.sp, this.z, this.depth, field);
    this.cxS.closed = this.cxP.closed = this.closing;
    this.style = this.ops.trunkStyle(d);
    this.prov.zs = this.ghost.zs = this.z;
    this.budget0 = readResume(d, this.cur);
    const pools = poolsOf(d);
    this.depth.sync(pools.data, pools.n, this.win);
    this.updateTe();
  }

  // ---------------------------------------------------------------- IncrementalCook

  append(_nSamples: number): void {
    if (this.done) return;
    this.builder.append();
    this.sp = this.builder.spine;
    this.syncPools(NaN, NaN);
    this.updateTe();
    this.advanceSettled();
    this.rebuildProvisional();
    this.dirty = true;
  }

  regrow(s0: number, s1: number): void {
    if (this.done) return;
    this.syncPools(s0, s1);
    this.rebuildProvisional();
    this.dirty = true;
  }

  setClosing(on: boolean): void {
    if (this.done || on === this.closing) return;
    this.closing = on;
    this.echoCeil = NaN;
    this.cxS.closed = this.cxP.closed = on;
    this.syncPools(NaN, NaN);
    this.updateTe();
    this.rebuildProvisional();
    this.dirty = true;
  }

  view(): LiveView {
    if (this.doneView) return this.doneView;
    if (this.dirty || !this.live) this.live = this.buildLive();
    return this.live;
  }

  drainSettled(cb: (p: PolyView, replaces: number) => void): void {
    const q = this.queue;
    this.queue = [];
    for (const e of q) {
      const rep = this.pending.get(e.id);
      if (rep === undefined) continue;
      this.pending.delete(e.id);
      cb(this.polyView(e), rep);
    }
  }

  ceiling(s: number): number {
    const ops = this.ops;
    if (this.done) return this.done.ceilingMax;
    if (this.radialLive) return this.radialCeil;
    if (ops.id === 'echo') return this.echoCeiling();
    const ch = ops.chain;
    if (!ch) return ops.dMax;
    if (this.provBudgetOut) return Math.max(this.depth.base, Math.min(ops.dMax, this.depth.at(s)));
    let best = -1;
    const lo = s - 48, hi = s + 32;
    for (let k = this.units.length - 1; k >= 0; k--) {
      const u = this.units[k], us = u.rec.s;
      if (us < lo) break;
      if (us <= hi && u.exists && u.cooked && u.geom.ceil > best) best = u.geom.ceil;
    }
    for (let k = 0; k < this.provN; k++) {
      const u = this.provUnits[k], us = u.rec.s;
      if (us >= lo && us <= hi && u.geom.ceil > best) best = u.geom.ceil;
    }
    return best < 0 ? ops.dMax : Math.min(ops.dMax, best);
  }

  /**
   * Echo's ceiling: the cap (32k segments, 40× growth) of the crystal this stroke would get if
   * it lifted now, i.e. the RDP plan of the current spine, not the ghost's 8-vertex stand-in
   * (whose 7 segments cap an open stroke at 4 even when the real generator allows 5). Only
   * computed when asked (Rise asks every frame of a hold, ~0.5 ms on a 9k sp stroke), and
   * cached until the closure changes or the spine grows 6 sp (a still nib barely extends it).
   * A short open stroke becomes Line at lift, so it takes Line's cap.
   */
  private echoCeiling(): number {
    const sp = this.sp, n = sp.n, dMax = this.ops.dMax;
    if (this.echoCeil === this.echoCeil && Math.abs(sp.L - this.echoCeilL) < 6) return this.echoCeil;
    this.echoCeilL = sp.L;
    let N = dMax;
    if (n >= 2 && (this.closing || chordSp(sp, n - 1, this.z) >= MIN_CHORD)) {
      const cx = this.cxP;
      cx.bind(sp, n - 1);
      if (planCrystal(cx.at, this.z, this.closing, false, this.echoPlan, dMax)) N = this.echoPlan.N;
    }
    return (this.echoCeil = N);
  }

  spine(): Readonly<Spine> { return this.sp; }

  tip(now?: number): Readonly<Tip> { return this.builder.tip(now); }

  jitter(): number { return this.builder.jitter(); }

  /** Resume state at the current settled station: the spine's RESUME fields plus the chain cursor. */
  snapshot(): Float32Array {
    const a = this.builder.snapshot();
    const out = new Float32Array(RESUME.LENGTH + RES.LENGTH);
    out.set(a.subarray(0, RESUME.LENGTH));
    const o = RESUME.LENGTH;
    out[o + RES.MARK] = RES_MARK; out[o + RES.PHASE] = this.cur.phase; out[o + RES.S] = this.cur.s;
    out[o + RES.J] = this.cur.j; out[o + RES.SIDE] = this.cur.side;
    let b = this.budget0;
    for (const u of this.units) b += u.count;
    out[o + RES.BUDGET] = b;
    return out;
  }

  finish(r: StrokeRecipe): Cooked {
    if (this.done) return this.done;
    // r must freeze exactly what this cook consumed. If it does not (a pointer-up row added to
    // the recipe but not to the draft, an edited pen-down field), the incremental state cannot
    // reproduce cook(r), so cook r afresh: finish(r) ≡ cook(r) holds unconditionally.
    if (!this.frozenBy(r)) {
      const fresh = new Cook(draftOf(r));
      const out = fresh.finish(r);
      this.done = out; this.doneView = fresh.doneView; this.sp = fresh.sp;
      this.queue = []; this.pending.clear();
      return out;
    }
    const ops = this.ops;
    // 1. the last rows, then everything they settle, on the pre-finish spine (as the live path did)
    this.builder.append();
    this.sp = this.builder.spine;
    this.closing = r.closed;
    this.cxS.closed = this.cxP.closed = r.closed;
    this.cxS.cut = this.cxP.cut = r.cut;
    const pools = poolsOf(r);
    this.syncPoolsFrom(pools.data, pools.n, NaN, NaN);
    this.teFinal = false;
    this.updateTe(r);
    this.advanceSettled();

    // 2. finish the spine: end flush, seam weld; then the final envelope. A cut tail (the
    // recipe's flag decides, the draft may predate the split) keeps exactly the settled
    // stations, as SpineBuilder.finish does for a cut recipe: piece 1 ends on the station
    // its continuation resumes from.
    if (r.cut & 2 && this.builder.spine.settled > 0) {
      const t = this.builder.spine;
      t.n = t.settled;
      t.L = t.s[t.n - 1];
    } else this.builder.finish(r.closed);
    const sp = this.sp = this.builder.spine;
    const cx = this.cxS;
    cx.bind(sp, sp.n - 1);
    cx.final = true;
    const env = finalEnvelope(r, sp);
    cx.env = env;
    const L = cx.L, s0 = cx.s0, closed = r.closed;
    const tailLo = L - Math.max(WELD_TAIL, env.Tx + 6);
    const weld = closed && sp.n >= 3;
    const radial = r.radial || sp.n < 2;

    let ceilingMax = 0, coverage = 0;
    const sources: Source[] = [];
    let crystal: PolyBuf | null = null;
    let fromBuf: F64 | null = null;
    let liftT = 0;

    if (radial) {
      const rb = new PolyBuf(64, 8); rb.zs = this.z;
      if (sp.n > 0) ceilingMax = this.emitRadial(cx, rb, clamp(this.depth.at(s0), 0, ops.radialCeiling));
      sources.push({ buf: rb, ids: null });
    } else {
      // 3. trunk: re-emit lift-zone / head-changed blocks, then the tail blocks
      const echoLine = ops.id === 'echo' && !closed && chordSp(sp, sp.n - 1, this.z) < MIN_CHORD;
      const tOps = echoLine ? line : ops;
      const tStyle = echoLine ? line.trunkStyle(r) : this.style;
      const reach = tOps.trunkReach;
      for (const b of this.blocks) {
        const tail = b.a1 + reach >= tailLo;
        const head = weld && b.a0 - reach <= s0 + WELD_HEAD;
        const headIn = b.a0 - reach < s0 + HEAD && (b.teT !== env.TeTrunk || b.closed !== closed);
        if (echoLine || tail || head || headIn) this.emitBlock(b, cx, tOps, tStyle);
      }
      this.extendBlocks(cx, sp.n - 1, true, tOps, tStyle);
      for (const b of this.blocks) sources.push({ buf: b.buf, ids: null });

      // 4. growth chains: re-cook weld-zone units, add the tail units, re-truncate everything
      const ch = ops.chain;
      if (ch) {
        if (weld) {
          for (const u of this.units) {
            const lo = u.rec.s - ch.halfWin, hi = u.rec.s + ch.halfWin;
            if (hi >= L - WELD_TAIL || lo <= s0 + WELD_HEAD) { u.cooked = false; u.dirty = true; }
          }
        }
        if (!(r.cut & 2)) {
          for (let guard = 0; guard < 100000; guard++) {
            if (this.cur.phase !== 0 && !ch.keep(cx, this.cur.s)) break;
            if (ch.step(cx, this.cur, this.rec)) this.addUnit();
          }
        }
        this.refreshUnits(cx, 0, -Infinity, Infinity, false);
        for (const u of this.units) {
          sources.push({ buf: u.buf, ids: null });
          if (u.exists && u.count > 0) { const D = Math.min(u.D, u.geom.ceil); if (D > ceilingMax) ceilingMax = D; }
        }
      } else if (tOps === line) {
        for (let i = 0; i < sp.n; i++) { const dd = clamp(this.depth.at(sp.s[i]), 0, line.dMax); if (dd > ceilingMax) ceilingMax = dd; }
      }

      // 5. Echo's crystal
      if (ops.id === 'echo' && !echoLine) {
        const plan = new Plan();
        if (planCrystal(cx.at, this.z, closed, false, plan, ops.dMax)) {
          const dE = clamp(this.depth.base + this.depth.maxPool(), 0, plan.N);
          const fade = crystalFade(dE);
          ceilingMax = dE;
          if (fade > 0) {
            crystal = new PolyBuf(1024, 8); crystal.zs = this.z;
            fromBuf = new F64(1024);
            const nv = buildCrystal(plan, dE);
            const m = { w: 0, c: 0, p: 0 };
            spineMeans(sp, sp.n - 1, m);
            const res: CrystalOut = { coverage: 0, points: 0 };
            emitCrystal(nv, dE, m.w, this.z, new SpinePressure().set(cx.at, s0, L - s0), fade * glow(m.c), crystalBucket(dE),
              s0, true, crystal, fromBuf, res);
            coverage = res.coverage;
            sources.push({ buf: crystal, ids: null });
            liftT = sp.n > 0 ? sp.t[sp.n - 1] : 0;
          }
        }
      }
    }

    const out = this.asm.build(sources, true, this.d.origin, sp, ceilingMax, coverage).c;
    this.done = out;
    let morph: MorphSet | null = null;
    if (crystal && fromBuf && crystal.nPolys > 0) morph = foldOut(out, fromBuf, liftT, ceilingMax);
    this.doneView = { geom: out, ghost: null, morph };
    this.queue = []; this.pending.clear();
    spineCache.set(r, sp);
    return out;
  }

  /**
   * Whether r freezes this cook's inputs: the same sample rows (bitwise) and the pen-down
   * fields the cook read from the draft. Pools, closure, the tail cut and radial are read
   * from r itself at finish, so they may differ.
   */
  private frozenBy(r: StrokeRecipe): boolean {
    const d = this.d;
    if (d === r) return true;
    if (d.z !== r.z || d.rot !== r.rot || d.seed !== r.seed || d.device !== r.device || d.s0 !== r.s0 ||
      ((d.cut ^ r.cut) & 1) !== 0 || d.origin[0] !== r.origin[0] || d.origin[1] !== r.origin[1] ||
      d.stroke.nib !== r.stroke.nib || d.stroke.size !== r.stroke.size ||
      d.form.form !== r.form.form || d.form.v !== r.form.v || d.form.base !== r.form.base) return false;
    const a = d.calib, b = r.calib;
    if (a !== b && (a.lo !== b.lo || a.hi !== b.hi || a.gamma !== b.gamma || a.flat !== b.flat ||
      a.vMed !== b.vMed || a.jitter !== b.jitter || a.fcMin !== b.fcMin)) return false;
    if (d.resume !== r.resume && !sameBits(d.resume, r.resume)) return false;
    const rows = rowsOf(d), n = Math.floor(r.samples.length / S.STRIDE);
    if (rows.n !== n) return false;
    return rows.data === r.samples || sameBits(rows.data.subarray(0, n * S.STRIDE), r.samples.subarray(0, n * S.STRIDE));
  }

  // ---------------------------------------------------------------- settled emission

  private settledHi(): number { return this.sp.settled - 1; }

  /** Emit every unit whose reach the settled watermark now covers. */
  private advanceSettled(): void {
    const hi = this.settledHi();
    if (hi < 0) return;
    const cx = this.cxS;
    cx.bind(this.sp, hi);
    cx.final = false; cx.env = null;
    this.extendBlocks(cx, hi, false, this.ops, this.style);
    const ch = this.ops.chain;
    if (!ch) return;
    const avail = this.sp.s[hi];
    const first = this.units.length;
    for (let guard = 0; guard < 100000; guard++) {
      if (!(ch.need(cx, this.cur) <= avail)) break; // NaN-safe: a bad cursor stops the chain
      if (ch.step(cx, this.cur, this.rec)) this.addUnit();
    }
    if (this.units.length > first) this.refreshUnits(cx, first, -Infinity, Infinity, true);
  }

  /** Append blocks over stations [.., hi]; live blocks need their end station and reach settled. */
  private extendBlocks(cx: Cx, hi: number, final: boolean, ops: FormOps, style: TrunkStyle): void {
    const sp = this.sp, S = sp.s, avail = S[hi];
    for (let guard = 0; guard < 100000; guard++) {
      const last = this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
      const u = last ? last.u + 1 : Math.floor(S[0] / BLOCK);
      const i0 = last ? last.i1 : 0;
      if (i0 >= hi) break;
      const edge = BLOCK * (u + 1);
      let i1 = i0 + 1;
      while (i1 <= hi && S[i1] < edge) i1++;
      if (i1 > hi) { if (!final) break; i1 = hi; }
      if (!final && S[i1] + ops.trunkReach > avail) break;
      const b = new Block(u, i0, i1, S[i0], S[i1]);
      b.buf.zs = this.z;
      this.blocks.push(b);
      this.emitBlock(b, cx, ops, style);
    }
  }

  private emitBlock(b: Block, cx: Cx, ops: FormOps, style: TrunkStyle): void {
    b.buf.clear();
    this.trunkInto(b.buf, cx, b.i0, b.i1, b.u, ops, style);
    b.teT = cx.env ? cx.env.TeTrunk : cx.Te;
    b.closed = cx.closed;
    if (!this.done && !cx.final) this.settle(b);
  }

  private trunkInto(out: PolyBuf, cx: Cx, i0: number, i1: number, u: number, ops: FormOps, style: TrunkStyle): void {
    if (ops.trunk) {
      ops.trunk(cx, i0, i1, this.T);
      writeTrunk(this.T, cx.r.stroke.nib === 'chisel' ? PolyKind.Chisel : PolyKind.Ribbon, style.alpha, u, cx.r.seed, out);
    } else plainTrunk(cx, i0, i1, style, u, this.T, out);
  }

  private addUnit(): void {
    const u = new GUnit(this.rec);
    u.buf.zs = this.z;
    this.units.push(u);
  }

  /**
   * Re-truncate growth units from index k0: units with arc in [lo, hi] (or marked dirty, or
   * coming back into existence) get their depth and entry factor recomputed; existence
   * follows the causal budget. Changed units re-emit (and settle when `live`).
   * A unit is cooked at its ceiling only once its depth is above 0: at depth 0 it draws
   * nothing whatever its geometry, so a base-0 stroke (or a preview at depth 0) never walks
   * a Drift filament or grows a Sprout tree it would truncate to nothing.
   */
  private refreshUnits(cx: Cx, k0: number, lo: number, hi: number, live: boolean): void {
    const ch = this.ops.chain;
    if (!ch) return;
    let cum = this.budget0;
    for (let k = 0; k < k0; k++) cum += this.units[k].count;
    for (let k = k0; k < this.units.length; k++) {
      const u = this.units[k], s = u.rec.s;
      const exists = cum < ch.strokeBudget;
      let D = u.D, eIn = u.eIn;
      if (exists && (u.dirty || !u.exists || (s >= lo && s <= hi))) {
        const want = clamp(this.depth.at(s), 0, ch.dMax);
        if (want > 0 && !u.cooked) { ch.cook(cx, u.rec, u.geom); u.cooked = true; u.dirty = true; }
        D = want > 0 ? Math.min(want, u.geom.ceil) : 0;
        eIn = cx.inF(s);
      }
      if (u.dirty || exists !== u.exists || D !== u.D || eIn !== u.eIn) {
        u.D = D; u.eIn = eIn; u.exists = exists; u.dirty = false;
        u.buf.clear();
        u.count = exists ? ch.emit(cx, u.rec, u.geom, D, eIn, u.buf) : 0;
        if (live) this.settle(u);
      }
      cum += u.count;
    }
  }

  // ---------------------------------------------------------------- pools, head inputs

  /** Diff the draft's pools against the cook's copy; [x0, x1] (if not NaN) is regrown as well. */
  private syncPools(x0: number, x1: number): void {
    const p = poolsOf(this.d);
    this.syncPoolsFrom(p.data, p.n, x0, x1);
  }

  private syncPoolsFrom(data: Float32Array, n: number, x0: number, x1: number): void {
    let lo = Infinity, hi = -Infinity;
    if (this.depth.sync(data, n, this.win)) { lo = this.win[0]; hi = this.win[1]; }
    if (x1 >= x0) { if (x0 < lo) lo = x0; if (x1 > hi) hi = x1; }
    if (!(hi >= lo)) return;
    const hiS = this.settledHi();
    if (hiS < 0) return;
    const cx = this.cxS;
    cx.bind(this.sp, hiS); cx.final = false; cx.env = null;
    const dr = this.ops.trunkDepthReach;
    if (dr >= 0) {
      for (const b of this.blocks) if (b.a1 + dr >= lo && b.a0 - dr <= hi) this.emitBlock(b, cx, this.ops, this.style);
    }
    if (this.ops.chain) {
      let k0 = this.units.length;
      for (let k = 0; k < this.units.length; k++) if (this.units[k].rec.s >= lo) { k0 = k; break; }
      if (k0 < this.units.length) this.refreshUnits(cx, k0, lo, hi, true);
    }
  }

  /** Recompute the entry taper; when it (or closure) changed, re-emit the head zone. */
  private updateTe(d: RecipeView = this.d): void {
    if (!this.teFinal) {
      this.teOpen = teOf(d, false);
      const rows = rowsOf(d);
      this.teFinal = !('closing' in d) || (d.cut & 1) !== 0 || entryKnown(rows.data, rows.n);
    }
    const te = this.closing ? 0 : this.teOpen;
    this.cxS.Te = this.cxP.Te = te;
    // units emitted from now on use te; earlier ones only need a pass when the head inputs changed
    if (te === this.lastTe && this.closing === this.lastClosing) return;
    this.lastTe = te; this.lastClosing = this.closing;
    const hiS = this.settledHi();
    if (hiS < 0) return;
    const cx = this.cxS;
    cx.bind(this.sp, hiS); cx.final = false; cx.env = null;
    const s0 = cx.s0, reach = this.ops.trunkReach;
    for (const b of this.blocks) {
      if (b.a0 - reach >= s0 + HEAD) break;
      if (b.teT !== te || b.closed !== this.closing) this.emitBlock(b, cx, this.ops, this.style);
    }
    if (this.ops.chain && this.units.length) this.refreshUnits(cx, 0, -Infinity, s0 + HEAD + this.ops.chain.halfWin, true);
  }

  // ---------------------------------------------------------------- provisional tail

  private rebuildProvisional(): void {
    const prov = this.prov, sp = this.sp, n = sp.n;
    prov.clear(); this.ghost.clear();
    this.provN = 0; this.provBudgetOut = false; this.radialLive = false;
    if (n === 0) return;
    const cx = this.cxP;
    cx.bind(sp, n - 1);
    cx.final = false; cx.env = null;
    cx.tipFade = this.ops.trunk ? TIP_FADE : 0;
    const ops = this.ops, S = sp.s;
    // trunk tail in 50 sp blocks from the last settled block to the nib
    const last = this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
    let u = last ? last.u + 1 : Math.floor(S[0] / BLOCK);
    let i0 = last ? last.i1 : 0;
    while (i0 < n - 1) {
      const edge = BLOCK * (u + 1);
      let i1 = i0 + 1;
      while (i1 < n - 1 && S[i1] < edge) i1++;
      this.trunkInto(prov, cx, i0, i1, u, ops, this.style);
      i0 = i1; u++;
    }
    // bloom: a hold before 6 sp of travel previews its radial seed
    const L = sp.L, s0 = cx.s0;
    if (L - s0 < 6 && this.hasBloomPool(s0)) {
      this.radialLive = true;
      const want = clamp(this.depth.at(s0), 0, ops.radialCeiling);
      const got = this.emitRadial(cx, prov, want);
      // a seed that realised less than it was asked for sits at its own (budget) ceiling
      this.radialCeil = got < want ? got : ops.radialCeiling;
      return;
    }
    // growth units ahead of the settled chain, shown only where a pool raised the depth
    const ch = ops.chain;
    if (ch) {
      let cum = this.budget0;
      for (const un of this.units) cum += un.count;
      const c = this.provCur;
      c.phase = this.cur.phase; c.s = this.cur.s; c.j = this.cur.j; c.side = this.cur.side;
      for (let guard = 0; guard < 10000; guard++) {
        if (c.phase !== 0 && !ch.keep(cx, c.s)) break;
        if (!ch.step(cx, c, this.rec)) continue;
        const D = clamp(this.depth.at(this.rec.s), 0, ch.dMax);
        if (!(D > this.depth.base)) continue;
        if (!(cum < ch.strokeBudget)) { this.provBudgetOut = true; break; }
        if (this.provN === this.provUnits.length) this.provUnits.push(new GUnit(this.rec));
        const pu = this.provUnits[this.provN++];
        pu.rec.s = this.rec.s; pu.rec.j = this.rec.j; pu.rec.side = this.rec.side; pu.rec.tmpl = this.rec.tmpl;
        ch.cook(cx, pu.rec, pu.geom);
        cum += ch.emit(cx, pu.rec, pu.geom, Math.min(D, pu.geom.ceil), cx.inF(pu.rec.s), prov);
      }
      if (!(cum < ch.strokeBudget)) this.provBudgetOut = true;
    }
    if (ops.id === 'echo') echoGhost(cx, this.depth.base + this.depth.maxPool(), this.closing, this.ghost);
  }

  private hasBloomPool(s0: number): boolean {
    const P = this.depth.P;
    for (let i = 0; i < this.depth.n; i++) if (P[i * PL.STRIDE + PL.S] <= s0 + 0.5) return true;
    return false;
  }

  /** The gen-0 dot (a short edge stamp for chisel) plus the Form's radial growth; returns the depth. */
  private emitRadial(cx: Cx, out: PolyBuf, depth: number): number {
    const seed = radialSeed(cx.sp, this.seedTmp), r = cx.r;
    const w = seed.w * this.style.w, tone = toneOf(seed.p, 0);
    if (r.stroke.nib === 'chisel') {
      const sp = cx.sp, i = sp.n >> 1;
      const th = chiselAngle(sp.alt[i], sp.az[i]) - r.rot;
      const h = 0.5 * CHISEL_CORE * r.stroke.size / this.z;
      const nx = -dsin(th), ny = dcos(th);
      out.begin(PolyKind.Chisel, 0, this.style.alpha, tone, cx.s0, 0, 0);
      out.pt(seed.x - nx * h, seed.y - ny * h, w, th);
      out.pt(seed.x + nx * h, seed.y + ny * h, w, th);
      out.end();
    } else {
      out.begin(PolyKind.Dot, 0, this.style.alpha, tone, cx.s0, 0, 0);
      out.pt(seed.x, seed.y, w);
      out.end();
    }
    return this.ops.radial(cx, seed, depth, out);
  }

  // ---------------------------------------------------------------- drain bookkeeping

  /** Give a (re)emitted unit's polys fresh ids and queue them; surplus old polys get empty replacements. */
  private settle(unit: { buf: PolyBuf; ids: number[] }): void {
    const old = unit.ids, buf = unit.buf, nw: number[] = [];
    for (let k = 0; k < buf.nPolys; k++) {
      const id = this.nextId++;
      const rep = k < old.length ? this.supersede(old[k]) : -1;
      this.pending.set(id, rep);
      this.queue.push({ id, buf, k });
      nw.push(id);
    }
    for (let k = buf.nPolys; k < old.length; k++) {
      const rep = this.supersede(old[k]);
      if (rep < 0) continue;
      const id = this.nextId++;
      this.pending.set(id, rep);
      this.queue.push({ id, buf: null, k: 0 });
    }
    unit.ids = nw;
  }

  private supersede(oldId: number): number {
    const rep = this.pending.get(oldId);
    if (rep === undefined) return oldId;
    this.pending.delete(oldId);
    return rep;
  }

  private polyView(e: Drain): PolyView {
    const b = e.buf;
    if (!b) {
      return { index: e.id, kind: PolyKind.Ribbon, gen: 0, alpha: 0, tone: 0, born: 0, unit: 0, pts: EMPTY32, ang: null, box: new Float32Array(4) };
    }
    const k = e.k, st = b.start[k], n = b.count[k];
    return {
      index: e.id, kind: b.kind[k] as PolyKind, gen: b.gen[k], alpha: b.alpha[k], tone: b.tone[k], born: b.born[k], unit: b.unit[k],
      pts: b.pts.subarray(4 * st, 4 * (st + n)),
      ang: b.ang && b.kind[k] === PolyKind.Chisel ? b.ang.subarray(st, st + n) : null,
      box: b.box.subarray(4 * k, 4 * k + 4),
    };
  }

  // ---------------------------------------------------------------- live view

  private buildLive(): InkLiveView {
    this.dirty = false;
    const src = this.liveSrc;
    src.length = 0;
    for (const b of this.blocks) src.push(b);
    src.push(this.provSrc);
    for (const u of this.units) src.push(u);
    let cm = 0;
    for (const u of this.units) if (u.exists && u.count > 0 && u.D > cm) cm = u.D;
    const { c, slot } = this.asm.build(src, false, this.d.origin, this.sp, cm, 0);
    let ghost: Cooked | null = null;
    if (this.ops.id === 'echo' && this.ghost.nPolys > 0) {
      ghost = this.ghostAsm.build([{ buf: this.ghost, ids: null }], false, this.d.origin, null, 0, 0).c;
    }
    return { geom: c, ghost, morph: null, slot };
  }
}

// ============================================================================ helpers & public API

/** Echo fold-out: crystal points (gen ≥ 1) unfold from their depth-0 positions; others stay put. */
function foldOut(c: Cooked, from: F64, liftT: number, dE: number): MorphSet {
  const f = new Float32Array(2 * c.nPts), src = from.data;
  let q = 0;
  for (let i = 0; i < c.nPolys; i++) {
    const st = c.start[i], n = c.count[i];
    for (let k = 0; k < n; k++) {
      const j = st + k;
      if (c.gen[i] >= 1 && q + 1 < from.n) { f[2 * j] = src[q]; f[2 * j + 1] = src[q + 1]; q += 2; }
      else { f[2 * j] = c.pts[4 * j]; f[2 * j + 1] = c.pts[4 * j + 1]; }
    }
  }
  const g1 = c.genStart.length > 2 ? c.genStart[1] : c.nPolys;
  return {
    from: f, polyFirst: Uint32Array.of(g1), t0: Float32Array.of(liftT),
    dur: Float32Array.of(clamp(350 + 120 * dE, 350, 1100)),
  };
}

/** Finished spines by recipe (cook and spineOf share them; spines are read-only once finished). */
const spineCache = new WeakMap<StrokeRecipe, Spine>();

/** Incremental cook over a draft (or a committed recipe), with the additive API. */
export function createInkCook(d: RecipeView): InkIncrementalCook { return new Cook(d); }

/** Incremental cook over a draft (or a committed recipe). */
export const createIncrementalCook: CreateIncrementalCook = createInkCook;

/** The draft a committed recipe would have been: same fields, all rows and pools present, closing = closed. */
export function draftOf(r: StrokeRecipe): DraftStroke {
  return {
    origin: r.origin, z: r.z, rot: r.rot, seed: r.seed, device: r.device, calib: r.calib,
    stroke: r.stroke, color: r.color, form: r.form, s0: r.s0, cut: r.cut, resume: r.resume,
    samples: { data: r.samples, n: Math.floor(r.samples.length / S.STRIDE) },
    pools: { data: r.pools, n: Math.floor(r.pools.length / PL.STRIDE) },
    closing: r.closed,
  };
}

/** cook(r) ≡ createIncrementalCook(draftOf(r)).finish(r). Pure: reads only the recipe. */
export const cook: CookFn = (r: StrokeRecipe): Cooked => createIncrementalCook(draftOf(r)).finish(r);

/** Spine of a committed recipe, cached per recipe object (hit tests, lasso, lineage). */
export function spineOf(r: StrokeRecipe): Spine {
  let sp = spineCache.get(r);
  if (!sp) { sp = buildSpine(r); spineCache.set(r, sp); }
  return sp;
}

/**
 * Thumbnail-quality cook (sheet tiles, chip glyphs) with at most maxPts points (NaN: no
 * limit; below 2: 2). Decision: depth caps are lowered first (base and every pool down by
 * whole levels, so the shape stays coherent: a shallower crystal rather than a decimated
 * deep one); if even depth 0 is over budget, it is decimated (see decimate). Lowering
 * tries one level, then bisects (point counts fall with depth), so a deep Drift preview
 * costs ~4 cooks rather than 7; a trunk that alone is over budget goes straight to depth 0.
 */
export function cookPreview(r: StrokeRecipe, maxPts: number): Cooked {
  const lim = maxPts >= 2 ? Math.floor(maxPts) : maxPts === maxPts ? 2 : Infinity;
  const c0 = cook(r);
  if (c0.nPts <= lim) return c0;
  let top = r.form.base;
  for (let o = PL.A; o < r.pools.length; o += PL.STRIDE) if (r.pools[o] > top) top = r.pools[o];
  // dropping `full` levels leaves depth 0 everywhere
  const full = top > 0 ? Math.ceil(Math.min(top, 64)) : 0;
  if (full === 0) return decimate(c0, lim);
  const tried: (Cooked | undefined)[] = [];
  const at = (drop: number): Cooked => tried[drop] ?? (tried[drop] = cook(lowered(r, drop)));
  // growth is gen ≥ 1, and a trunk that ignores depth never shrinks: if it alone is over
  // budget, only a decimated depth-0 cook can fit
  if (operatorFor(r.form.form, r.form.v).trunkDepthReach < 0 && trunkPoints(c0) > lim) return decimate(at(full), lim);
  if (at(1).nPts <= lim) return at(1);
  if (full === 1 || at(full).nPts > lim) return decimate(at(full), lim);
  let lo = 1, hi = full; // at(lo) is over budget, at(hi) fits
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (at(mid).nPts <= lim) hi = mid; else lo = mid; }
  return at(hi);
}

/** r with its base and every pool lowered by `drop` levels (floored at 0). */
function lowered(r: StrokeRecipe, drop: number): StrokeRecipe {
  const pools = r.pools.slice();
  for (let o = PL.A; o < pools.length; o += PL.STRIDE) pools[o] = Math.max(0, pools[o] - drop);
  return { ...r, form: { ...r.form, base: Math.max(0, r.form.base - drop) }, pools };
}

/** Points of the gen-0 polys. */
function trunkPoints(c: Cooked): number {
  const g1 = c.genStart.length > 2 ? c.genStart[1] : c.nPolys;
  return g1 < c.nPolys ? c.start[g1] : c.nPts;
}

/** Whether poly i continues poly p: same gen and kind (not dots), its first point on p's last. */
function joins(c: Cooked, p: number, i: number): boolean {
  if (c.gen[i] !== c.gen[p] || c.kind[i] !== c.kind[p] || c.kind[i] === PolyKind.Dot) return false;
  const e = 4 * (c.start[p] + c.count[p] - 1), f = 4 * c.start[i];
  return c.pts[e] === c.pts[f] && c.pts[e + 1] === c.pts[f + 1];
}

/**
 * Fit a cook into lim ≥ 2 points, in order, each step only while still over budget:
 *  1. drop the deepest generations (gen 0 always stays);
 *  2. weld runs of joined polys (trunk chunks share their joints) into one poly each, which
 *     takes the first chunk's tone (thumbnail quality);
 *  3. shed the last polys (gen-0 bristles come after the core) until 2 points each fit;
 *  4. keep every k-th point of each poly, ends kept, with the smallest k that fits.
 * Boxes are the unions of their source polys' boxes, so they still contain every point.
 */
function decimate(c: Cooked, lim: number): Cooked {
  let nPolys = c.nPolys;
  const minPts = (np: number): number => { let n = 0; for (let i = 0; i < np; i++) n += Math.min(c.count[i], 2); return n; };
  for (let g = c.genStart.length - 2; g > 0 && minPts(nPolys) > lim; g--) nPolys = c.genStart[g];
  // runs [first[q], first[q + 1]) of source polys; a run's points are its polys' points with
  // each joint once
  const weld = minPts(nPolys) > lim;
  const first: number[] = [];
  for (let i = 0; i < nPolys; i++) if (!(weld && i > 0 && joins(c, i - 1, i))) first.push(i);
  first.push(nPolys);
  const runPts = (q: number): number => {
    let n = 0;
    for (let i = first[q]; i < first[q + 1]; i++) n += c.count[i];
    return n - (first[q + 1] - first[q] - 1);
  };
  let nRuns = first.length - 1, need = 0;
  for (let q = 0; q < nRuns; q++) need += Math.min(runPts(q), 2);
  while (need > lim && nRuns > 1) { nRuns--; need -= Math.min(runPts(nRuns), 2); }
  let total = 0;
  for (let q = 0; q < nRuns; q++) total += runPts(q);
  const keepOf = (n: number, k: number): number => (n <= 2 ? n : Math.floor((n - 1) / k) + 1 + ((n - 1) % k ? 1 : 0));
  let k = Math.max(1, Math.ceil(total / lim)), nPts = 0;
  for (; ; k++) {
    nPts = 0;
    for (let q = 0; q < nRuns; q++) nPts += keepOf(runPts(q), k);
    if (nPts <= lim || k > total) break;
  }
  const pts = new Float32Array(4 * nPts), ang = c.ang ? new Float32Array(nPts) : null;
  const start = new Uint32Array(nRuns), count = new Uint32Array(nRuns);
  const kind = new Uint8Array(nRuns), gen = new Uint8Array(nRuns), tone = new Uint8Array(nRuns);
  const alpha = new Float32Array(nRuns), born = new Float32Array(nRuns), unit = new Uint32Array(nRuns);
  const box = new Float32Array(4 * nRuns);
  let w = 0;
  for (let q = 0; q < nRuns; q++) {
    const i0 = first[q], i1 = first[q + 1], n = runPts(q);
    start[q] = w; kind[q] = c.kind[i0]; gen[q] = c.gen[i0]; tone[q] = c.tone[i0];
    alpha[q] = c.alpha[i0]; born[q] = c.born[i0]; unit[q] = c.unit[i0];
    box[4 * q] = Infinity; box[4 * q + 1] = Infinity; box[4 * q + 2] = -Infinity; box[4 * q + 3] = -Infinity;
    let v = 0, off = 0;
    for (let i = i0; i < i1; i++) {
      const st = c.start[i], m = c.count[i];
      box[4 * q] = Math.min(box[4 * q], c.box[4 * i]); box[4 * q + 1] = Math.min(box[4 * q + 1], c.box[4 * i + 1]);
      box[4 * q + 2] = Math.max(box[4 * q + 2], c.box[4 * i + 2]); box[4 * q + 3] = Math.max(box[4 * q + 3], c.box[4 * i + 3]);
      for (let j = i === i0 ? 0 : 1; j < m; j++, v++) {
        if (n > 2 && v % k !== 0 && v !== n - 1) continue;
        const s = 4 * (st + j), o = 4 * w;
        pts[o] = c.pts[s]; pts[o + 1] = c.pts[s + 1]; pts[o + 2] = c.pts[s + 2]; pts[o + 3] = c.pts[s + 3] + off;
        if (ang && c.ang) ang[w] = c.ang[st + j];
        w++;
      }
      off += c.pts[4 * (st + m - 1) + 3];
    }
    count[q] = w - start[q];
  }
  let maxGen = 0;
  for (let q = 0; q < nRuns; q++) if (gen[q] > maxGen) maxGen = gen[q];
  const genStart = new Uint32Array(maxGen + 2);
  for (let g = 0, q = 0; g <= maxGen + 1; g++) { while (q < nRuns && gen[q] < g) q++; genStart[g] = q; }
  const out: Cooked = {
    pts, ang, start, count, kind, gen, tone, alpha, born, unit, box,
    genStart, nPolys: nRuns, nPts: w, inkBox: { ...c.inkBox }, hitBox: { ...c.hitBox }, ceilingMax: c.ceilingMax, coverage: c.coverage, bytes: 0,
  };
  out.bytes = pts.byteLength + (ang ? ang.byteLength : 0) + start.byteLength + count.byteLength + kind.byteLength +
    gen.byteLength + tone.byteLength + alpha.byteLength + born.byteLength + unit.byteLength + box.byteLength + genStart.byteLength;
  return out;
}

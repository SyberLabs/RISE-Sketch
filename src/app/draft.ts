/**
 * The stroke lifecycle (DESIGN §7.4), owner of the DraftStroke.
 *
 *  pen-down   Snapshot the camera z, the device's calibration and the tool; seed, colour variant
 *             (lineage or a fresh k), id; create the growable DraftStroke, the incremental cook and
 *             the Rise detector; live.begin.
 *  per event  Rows are written straight into the draft (screen -> doc at the pen-down camera; the
 *             camera is locked while drawing). C / CS come from the occupancy grid at most once per
 *             2.4 sp of travel, else the last value repeats. Predicted samples go to live.predict.
 *             Nothing else happens in the handler (DESIGN §9: ≤ 0.3 ms, no allocation).
 *  per rAF    The rows of the frame go to cook.append in one batch; Rise steps on the rAF clock from
 *             the cook's filtered tip (a still mouse sends no events); a changed pool window goes to
 *             cook.regrow and the halo to live.halo; closure hysteresis drives cook.setClosing and
 *             the weld ring. Auto-split at 6000 stations.
 *  lift       The final pointer-up row (so a dwell before lift reaches the envelope), the lift
 *             guard (pools as they stood 60 ms before lift), the radial test, freeze, finish,
 *             peel commit (add at base depth, then replace with the pools: two history entries),
 *             scene.putFor, learner.observe(…, z), live.commit. Touch taps get their strokeEnd up
 *             to 300 ms late (double-tap window): contact(false) is the lift there.
 *  withdraw   live.withdraw (un-grow, no history).
 *  symmetry   With the tool's symmetry on, pen-down also fixes the copies' placements (about the
 *             tool's centre) and colours; the live layer draws the one cook once per copy, and the
 *             lift commits the stroke and its copies in the same add (and peel replace), so one
 *             undo removes the whole gesture (ink/symmetry.ts).
 */
import type {
  Command, Cooked, Device, DraftStroke, InputSample, NibId, PoolBuf, SampleBuf, StrokeId, StrokeRecipe,
} from '../core/types';
import type { Halo, LiveCopy } from '../render/types';
import { PL, S } from '../core/types';
import { createInkCook, type InkIncrementalCook } from '../ink/cook';
import { createRise, LIFT_GUARD_MS, type Rise, type RiseInput, type RiseOut } from '../ink/rise';
import { closureRadius, closureTest } from '../ink/envelope';
import { nibWidth } from '../ink/nibs';
import { CURRENT_V, FORMS } from '../ink/operators/registry';
import { assignVariant, swatchCss } from '../ink/color';
import { continuationSamples, RESUME } from '../ink/spine';
import { copyColor, placeCooked, symmetryXfs } from '../ink/symmetry';
import { addCmd, batchCmd, freezeRecipe, peelCommands } from '../doc/commands';
import type { Runtime } from './runtime';
import type { View } from './view';
import { sameCustom } from './tool';

/** Auto-split threshold (DESIGN §7.4 step 5). */
export const MAX_STATIONS = 6000;
/** C / CS are read from the occupancy grid at most once per this much travel (sp). */
const C_STEP = 2.4;
/** A continuation ignores the occupancy grid this far past the seam (it would see its own first piece). */
const SEAM_QUIET = 48;
/** A stroke shorter than this is a radial seed (sp). */
const RADIAL_SP = 6;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function ensureRows(b: SampleBuf | PoolBuf, rows: number, stride: number): void {
  if (rows * stride <= b.data.length) return;
  let cap = Math.max(64, Math.floor(b.data.length / stride));
  while (cap < rows) cap *= 2;
  const g = new Float32Array(cap * stride);
  g.set(b.data.subarray(0, b.n * stride));
  b.data = g;
}

/** What the lifecycle tells the controller. */
export interface DraftEvents {
  /** A stroke (or the last piece of a split one) entered the document. */
  committed(r: StrokeRecipe, rose: number): void;
}

/** One stroke being drawn. */
class Live {
  d: Mutable<DraftStroke>;
  cook: InkIncrementalCook;
  rise: Rise;
  id: StrokeId;
  readonly created: number;
  readonly device: Device;
  /** Input clock of the first sample (rows store T = t − t0). */
  readonly t0: number;
  /** Screen position of the first sample: rows are (screen − first) / z. */
  readonly sx0: number;
  readonly sy0: number;
  readonly z: number;
  pending = 0;
  lastT = -Infinity;
  lastSx = 0;
  lastSy = 0;
  // crowding sampling
  cX = 0;
  cY = 0;
  curC = 0;
  curCS = 0;
  travel = 0;
  quietUntil = 0;
  /** Stroke clock of the last Rise step. */
  riseT = -Infinity;
  /** Stroke clock of the physical lift (touch taps), NaN until then. */
  tUp = NaN;
  haloOn = false;
  /** Halo colour (resolved once per stroke and ground: no colour string per frame). */
  haloCss = '';
  haloGround = '';
  spineN = -1;
  maxLevel = 0;
  /** Committed pieces of an auto-split stroke (one history batch at the end). */
  readonly pieces: { cmd: Command; inv: Command }[] = [];
  /** Symmetry copies: placement and colour of each, fixed at pen-down. */
  copies: LiveCopy[] = [];

  constructor(d: Mutable<DraftStroke>, cook: InkIncrementalCook, rise: Rise, id: StrokeId, created: number,
    device: Device, t0: number, sx0: number, sy0: number) {
    this.d = d; this.cook = cook; this.rise = rise; this.id = id; this.created = created;
    this.device = device; this.t0 = t0; this.sx0 = sx0; this.sy0 = sy0; this.z = d.z;
  }
}

export class Drafts {
  private cur: Live | null = null;
  private readonly halo: Halo = { x: 0, y: 0, rCss: 0, level: 0, pre: 0, brim: false, css: '' };
  private readonly inp: RiseInput = { x: 0, y: 0, s: 0, p: 0, now: 0, travel: 0 };
  private readonly weldAt: [number, number] = [0, 0];
  private readonly haloAt: [number, number] = [0, 0];
  private readonly ceil: (s: number) => number = s => (this.cur ? this.cur.cook.ceiling(s) : Infinity);
  private readonly learn: { device: Device; samples: Float32Array; jitter: number; z: number }[] = [];
  private learnQueued = false;

  constructor(private readonly rt: Runtime, private readonly view: View, private readonly ev: DraftEvents) {}

  /** A stroke is being drawn (or waits for its deferred touch strokeEnd). */
  get active(): boolean { return this.cur !== null; }

  // ---------------------------------------------------------------- pen-down

  begin(device: Device, s: InputSample): void {
    if (this.cur) this.end('commit');
    const rt = this.rt, doc = rt.doc, t = rt.store.get().tool, cam = this.view.cam;
    const z = cam.scale;
    const ox = cam.cx + (s.x - this.view.W * 0.5) / z, oy = cam.cy + (s.y - this.view.H * 0.5) / z;
    const nib: NibId = t.nib;
    const size = t.sizes[nib];
    const calib = rt.learner.snapshot(device);
    const seed = doc.nextSeed();
    // colour family: inherited from a same-ink neighbour (lineage) or a fresh variant
    const custom = t.ink === 'custom' ? t.custom : null;
    const wDoc = nibWidth(nib, size, 0.6, 0, device) / z;
    const linId = rt.scene.lineage(ox, oy, t.ink, wDoc, Date.now(), z);
    const lin = linId ? doc.get(linId)?.color ?? null : null;
    const inherit = !!lin && lin.ink === t.ink && (t.ink !== 'custom' || sameCustom(lin.lch, custom));
    const color = inherit ? assignVariant(t.ink, lin!.k, lin, custom) : assignVariant(t.ink, doc.nextVariant(t.ink), null, custom);
    const d: Mutable<DraftStroke> = {
      origin: [ox, oy], z, rot: 0, seed, device, calib,
      stroke: { nib, size },
      color,
      form: { form: t.form, v: CURRENT_V[t.form], base: t.base[t.form] },
      s0: 0, cut: 0, resume: null,
      samples: { data: new Float32Array(256 * S.STRIDE), n: 0 },
      pools: { data: new Float32Array(8 * PL.STRIDE), n: 0 },
      closing: false,
    };
    const cook = createInkCook(d);
    const L = new Live(d, cook, createRise(device, calib), doc.nextId(), Date.now(), device, s.t, s.x, s.y);
    L.cX = s.x; L.cY = s.y;
    L.curC = rt.scene.crowding(ox, oy, z);
    L.curCS = 0;
    if (t.sym.on) {
      const { folds, cx, cy } = t.sym;
      L.copies = symmetryXfs(folds, cx, cy, d.origin).map((xf, k) => ({ xf, color: copyColor(color, k + 1, folds) }));
    }
    this.cur = L;
    this.row(L, s);
    rt.renderer.overlay.cursor(null, null);
    rt.renderer.live.begin(d, cook, L.copies);
    rt.loop.request();
  }

  // ---------------------------------------------------------------- events

  move(samples: readonly InputSample[], predicted: readonly InputSample[]): void {
    const L = this.cur;
    if (!L || L.tUp === L.tUp) return;
    for (let i = 0; i < samples.length; i++) this.row(L, samples[i]);
    if (predicted.length) this.rt.renderer.live.predict(predicted);
    this.rt.loop.request();
  }

  /** Append one input sample as a persisted row (doc units relative to the origin). */
  private row(L: Live, s: InputSample): void {
    const b = L.d.samples, n = b.n;
    ensureRows(b, n + 1, S.STRIDE);
    let T = s.t - L.t0;
    if (!(T > L.lastT)) T = n === 0 ? 0 : L.lastT + 0.25;
    L.lastT = T;
    const dx = s.x - L.lastSx, dy = s.y - L.lastSy;
    if (n > 0) L.travel += Math.sqrt(dx * dx + dy * dy);
    L.lastSx = s.x; L.lastSy = s.y;
    // C / CS at most once per 2.4 sp (screen px at the pen-down zoom are sp)
    const cx = s.x - L.cX, cy = s.y - L.cY, cd = Math.sqrt(cx * cx + cy * cy);
    if (cd >= C_STEP && L.travel >= L.quietUntil) {
      const z = L.z, ox = L.d.origin[0], oy = L.d.origin[1];
      const X = ox + (s.x - L.sx0) / z, Y = oy + (s.y - L.sy0) / z;
      const tx = cx / cd, ty = cy / cd;
      L.curC = this.rt.scene.crowding(X, Y, z);
      L.curCS = this.rt.scene.sideCrowding(X, Y, ty, -tx, z);
      L.cX = s.x; L.cY = s.y;
    }
    const o = n * S.STRIDE, D = b.data;
    D[o + S.X] = (s.x - L.sx0) / L.z;
    D[o + S.Y] = (s.y - L.sy0) / L.z;
    D[o + S.T] = T;
    D[o + S.P] = s.p;
    D[o + S.ALT] = s.alt;
    D[o + S.AZ] = s.az;
    D[o + S.R] = s.r;
    D[o + S.C] = L.curC;
    D[o + S.CS] = L.curCS;
    b.n = n + 1;
    L.pending++;
  }

  /** contact(false): the physical lift (a touch tap's strokeEnd may come 300 ms later). */
  lift(): void {
    const L = this.cur;
    if (!L || L.tUp === L.tUp) return;
    L.tUp = Math.max(L.lastT, performance.now() - L.t0);
    if (L.haloOn) { this.rt.renderer.live.halo(null); L.haloOn = false; }
  }

  // ---------------------------------------------------------------- per rAF

  /** Step Rise at stroke time `t` from the cook's tip (`this.inp`); the cook regrows what changed. */
  private stepRise(L: Live, t: number, ceil: (s: number) => number): RiseOut {
    const tip = L.cook.tip(t), inp = this.inp;
    inp.x = tip.x; inp.y = tip.y; inp.s = tip.s; inp.p = tip.p; inp.now = t; inp.travel = tip.travel;
    const out = L.rise.step(inp, L.d.pools, L.d.form.base, ceil);
    L.riseT = t;
    if (out.changed) L.cook.regrow(out.changed.s0, out.changed.s1);
    return out;
  }

  /** Frame participant: batch-append the frame's rows, step Rise, closure, auto-split. */
  frame(now: number): boolean {
    const L = this.cur;
    if (!L) return false;
    const rt = this.rt, live = rt.renderer.live;
    let changed = false;
    if (L.pending > 0) {
      L.cook.append(L.pending);
      L.pending = 0;
      changed = true;
    }
    if (L.tUp !== L.tUp) {
      const out = this.stepRise(L, Math.max(now - L.t0, 0), this.ceil);
      if (out.changed) changed = true;
      if (out.phase === 'moving') {
        if (L.haloOn) { live.halo(null); L.haloOn = false; this.announceRise(L); }
      } else if (out.hold) {
        const h = this.halo, z = L.z;
        const at = this.view.toScreenInto(L.d.origin[0] + out.hold.x / z, L.d.origin[1] + out.hold.y / z, this.haloAt);
        const k = this.view.cam.scale / z;
        const w = nibWidth(L.d.stroke.nib, L.d.stroke.size, this.inp.p, 0, L.device);
        const ceiling = L.cook.ceiling(out.hold.s);
        h.x = at[0]; h.y = at[1];
        h.rCss = (w * 0.5 + 6) * k;
        h.level = ceiling > 0 ? Math.max(0, Math.min(1, out.level / ceiling)) : 1;
        h.pre = out.pre;
        h.brim = out.brim;
        const g = rt.store.get().ground;
        if (L.haloGround !== g) { L.haloGround = g; L.haloCss = swatchCss(L.d.color, g, 0.85, 0); }
        h.css = L.haloCss;
        live.halo(h);
        L.haloOn = true;
        if (out.level > L.maxLevel) L.maxLevel = out.level;
      }
    }
    if (changed) {
      this.closure(L);
      live.update();
      if (L.cook.spine().n >= MAX_STATIONS) this.split(L);
    }
    return true;
  }

  /** Closure hysteresis on the live spine: setClosing and the weld ring at the start. */
  private closure(L: Live): void {
    const sp = L.cook.spine();
    if (sp.n === L.spineN) return;
    L.spineN = sp.n;
    const on = closureTest(sp, L.d.closing);
    if (on === L.d.closing) return;
    L.d.closing = on;
    L.cook.setClosing(on);
    const ov = this.rt.renderer.overlay;
    if (!on) { ov.weld(null, 0); return; }
    this.view.toScreenInto(L.d.origin[0] + sp.x[0], L.d.origin[1] + sp.y[0], this.weldAt);
    ov.weld(this.weldAt, closureRadius(sp.L - sp.s[0]) * (this.view.cam.scale / L.z));
  }

  private announceRise(L: Live): void {
    if (L.maxLevel <= L.d.form.base + 1e-6) return;
    this.rt.store.emit({ k: 'announce', text: `Rose to depth ${Math.round(L.maxLevel * 4) / 4}` });
  }

  // ---------------------------------------------------------------- lift

  end(how: 'commit' | 'withdraw'): void {
    const L = this.cur;
    if (!L) return;
    this.cur = null;
    const rt = this.rt;
    rt.renderer.overlay.weld(null, 0);
    if (how === 'withdraw') {
      rt.renderer.live.withdraw();
      if (L.pieces.length) this.pushPieces(L, null, null);
      return;
    }
    if (L.pending > 0) { L.cook.append(L.pending); L.pending = 0; }
    const d = L.d, b = d.samples;
    const tUp = L.tUp === L.tUp ? L.tUp : Math.max(L.lastT, performance.now() - L.t0);
    // Rise steps on rAF. When no frame stepped it since the guard time (a stalled frame loop: a
    // long task, a GPU stall), step it there once, so a hold the input shows is not lost to frame timing
    const tg = tUp - LIFT_GUARD_MS;
    if (tg > L.riseT) {
      const out = this.stepRise(L, tg, s => L.cook.ceiling(s)); // this.cur is already null
      if (out.hold && out.level > L.maxLevel) L.maxLevel = out.level;
    }
    // the final pointer-up row: the last row again at the lift time, so a dwell before lift
    // (mouse and touch send nothing while still) reaches the seated-stop test
    if (b.n > 0 && tUp > L.lastT + 0.25) {
      ensureRows(b, b.n + 1, S.STRIDE);
      const o = b.n * S.STRIDE, p = o - S.STRIDE;
      for (let c = 0; c < S.STRIDE; c++) b.data[o + c] = b.data[p + c];
      b.data[o + S.T] = tUp;
      L.lastT = tUp;
      b.n++;
      L.cook.append(1);
    }
    L.rise.liftGuard(d.pools, tUp);
    const sp = L.cook.spine();
    d.closing = closureTest(sp, d.closing);
    const radial = d.s0 === 0 && L.cook.tip().travel < RADIAL_SP;
    if (L.haloOn) this.announceRise(L);
    const r = this.freeze(L, d.cut, radial);
    const c = L.cook.finish(r);
    rt.scene.putFor(r, c);
    const copies = this.copiesOf(L, r, c);
    if (L.pieces.length) {
      const cmd = addCmd([r, ...copies.map(x => x.r)]);
      const inv = rt.doc.apply(cmd);
      this.pushPieces(L, cmd, inv);
    } else {
      for (const cmd of peelCommands(r, copies.map(x => x.r))) {
        const inv = rt.doc.apply(cmd);
        rt.history.push(cmd, inv);
      }
    }
    rt.renderer.live.commit(r, c, copies);
    this.observe(L.device, r.samples, L.cook.jitter(), L.z);
    this.ev.committed(r, L.maxLevel);
  }

  /**
   * Feed the calibration learner, between strokes (DESIGN §2.2.2) but off the lift: it sorts its
   * reservoirs and persists them (tens of KB of JSON into localStorage), which must not cost the
   * frame in which the lift zones and the hot trail start animating. Queued in order; the next
   * stroke may begin on the previous snapshot, which the learner's ≤ 8 % steps make invisible.
   */
  private observe(device: Device, samples: Float32Array, jitter: number, z: number): void {
    this.learn.push({ device, samples, jitter, z });
    if (this.learnQueued) return;
    this.learnQueued = true;
    const run = (): void => {
      this.learnQueued = false;
      const q = this.learn.splice(0, this.learn.length);
      for (const o of q) this.rt.learner.observe(o.device, o.samples, Math.floor(o.samples.length / S.STRIDE), o.jitter, o.z);
    };
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(run, { timeout: 1500 }); else setTimeout(run, 120);
  }

  private freeze(L: Live, cut: number, radial: boolean): StrokeRecipe {
    const d = L.d;
    return freezeRecipe({
      id: L.id, created: L.created, origin: d.origin, z: d.z, rot: d.rot, seed: d.seed, device: d.device,
      calib: d.calib, stroke: d.stroke, color: d.color, form: d.form, s0: d.s0, cut, resume: d.resume,
      samples: d.samples.data.subarray(0, d.samples.n * S.STRIDE),
      pools: d.pools.data.subarray(0, d.pools.n * PL.STRIDE),
      closed: d.closing, radial, sym: null, xf: null,
    });
  }

  /**
   * The symmetry copies of a frozen stroke: the same recipe under a new id, its own colour and
   * placement; their geometry is the stroke's, placed (≡ cook(copy)). Registered with the scene.
   */
  private copiesOf(L: Live, r: StrokeRecipe, c: Cooked): { r: StrokeRecipe; c: Cooked }[] {
    if (!L.copies.length) return [];
    return L.copies.map(cp => {
      const rk = freezeRecipe({ ...r, id: this.rt.doc.nextId(), color: cp.color, xf: cp.xf });
      const ck = placeCooked(c, cp.xf, r.origin);
      this.rt.scene.putFor(rk, ck);
      return { r: rk, c: ck };
    });
  }

  /** The pieces of a split stroke are one history entry: a batch of adds. */
  private pushPieces(L: Live, last: Command | null, lastInv: Command | null): void {
    const cmds = L.pieces.map(p => p.cmd), invs = L.pieces.map(p => p.inv);
    if (last && lastInv) { cmds.push(last); invs.push(lastInv); }
    invs.reverse();
    this.rt.history.push(batchCmd(cmds), batchCmd(invs));
  }

  // ---------------------------------------------------------------- auto-split

  /**
   * At 6000 stations the stroke commits with its tail marked as a cut and continues at once from
   * the last settled station (s0, head cut, resume state, same colour family and seed), so the
   * join is seamless (DESIGN §7.4 step 5; ink-forms contract note §5).
   */
  private split(L: Live): void {
    const rt = this.rt, d = L.d;
    const snap = L.cook.snapshot();
    const piece = this.freeze(L, d.cut | 2, false);
    const c = L.cook.finish(piece);
    rt.scene.putFor(piece, c);
    const copies = this.copiesOf(L, piece, c);
    const cmd = addCmd([piece, ...copies.map(x => x.r)]);
    L.pieces.push({ cmd, inv: rt.doc.apply(cmd) });
    if (L.haloOn) { rt.renderer.live.halo(null); L.haloOn = false; }
    rt.renderer.overlay.weld(null, 0);
    rt.renderer.live.commit(piece, c, copies);
    this.observe(L.device, piece.samples, L.cook.jitter(), L.z);
    // the continuation: same origin, its first row on the snapshot station
    const rows = continuationSamples(d.samples.data, d.samples.n, snap);
    const n = Math.floor(rows.length / S.STRIDE);
    const samples: SampleBuf = { data: new Float32Array(Math.max(256, 2 * n) * S.STRIDE), n };
    samples.data.set(rows);
    const next: Mutable<DraftStroke> = {
      ...d, s0: snap[RESUME.S], cut: 1, resume: snap, samples,
      pools: { data: new Float32Array(8 * PL.STRIDE), n: 0 }, closing: false,
    };
    L.d = next;
    L.cook = createInkCook(next);
    L.rise = createRise(L.device, d.calib);
    L.id = rt.doc.nextId();
    L.pending = n;
    L.spineN = -1;
    L.quietUntil = L.travel + SEAM_QUIET;
    rt.renderer.live.begin(next, L.cook, L.copies);
  }
}

/** Display name of a Form (announcements). */
export const formName = (r: StrokeRecipe): string => FORMS[r.form.form]?.name ?? 'Ink';

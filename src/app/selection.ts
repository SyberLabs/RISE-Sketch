/**
 * Selection and restyle (DESIGN §3.4 Select / Selection state / Restyle, §8 History).
 *
 *  - Picking: a hit test on the spine capsule and the cooked polys with alpha ≥ 0.3 (scene.hit)
 *    within 8 sp of the point; a lasso selects strokes with ≥ 50 % of their stations inside
 *    (scene.lasso). `add` toggles membership ("tap more ink adds"; tapping a selected stroke
 *    again removes it); a miss deselects whatever `add` says (input contract #3).
 *  - Selection state: the strokes are lifted into the selection layer (renderer.lift, the rest
 *    dims to 45 %), the overlay draws the bounds and outlines, AppState carries the ids and the
 *    screen bounds (selectionRect, refreshed on every camera publish), and the selection's
 *    uniform style is mirrored into the tool with its colour in recent slot 1 (ui contract #3).
 *    The tool as it stood before the selection is restored on deselect.
 *  - Restyle: every change is ONE `replace` command played as a restyle morph. Chip drags bend
 *    size / depth / hue+tone RELATIVE to each stroke; up to 12 lifted strokes preview live in the
 *    selection layer at ~30 Hz (cooked on the main thread, throttled by the measured cook cost),
 *    larger selections update on release. Tapping the selection's own Form again reseeds.
 *  - Delete is one `remove` played as an un-grow.
 */
import type { AABB, ColorStyle, Cooked, FormId, InkId, NibId, StrokeId, StrokeRecipe, ToolState } from '../core/types';
import { hash32 } from '../core/det';
import { cook } from '../ink/cook';
import { assignVariant, bendColor } from '../ink/color';
import { CURRENT_V } from '../ink/operators/registry';
import { patchRecipe, removeCmd, replaceCmd } from '../doc/commands';
import type { Runtime } from './runtime';
import type { View } from './view';
import { clampBase, clampSize, sameCustom } from './tool';

/** Hit tolerance around a tap or click (sp). */
export const HIT_SP = 8;
/** Selections up to this size preview chip drags live (DESIGN §3.4). */
export const PREVIEW_MAX = 12;
/** Preview cadence (ms), stretched when a preview cook costs more than a third of it. */
export const PREVIEW_MS = 33;

/** What a restyle does to one recipe (pure; one entry per stroke). */
export type Restyle =
  | { kind: 'nib'; nib: NibId; size: number }
  | { kind: 'form'; form: FormId }
  | { kind: 'ink'; ink: InkId; custom: ColorStyle['lch'] }
  | { kind: 'reseed' }
  | { kind: 'size'; factor: number }
  | { kind: 'depth'; delta: number }
  | { kind: 'color'; dh: number; dL: number; ground: 'night' | 'paper' };

/** Apply a restyle to a recipe (a new recipe, or the same object when nothing changes). */
export function restyleRecipe(r: StrokeRecipe, s: Restyle, nextSeed: () => number): StrokeRecipe {
  switch (s.kind) {
    case 'nib': {
      if (r.stroke.nib === s.nib && r.stroke.size === s.size) return r;
      return patchRecipe(r, { stroke: { nib: s.nib, size: clampSize(s.nib, s.size) } }, 'geometry');
    }
    case 'form': {
      if (r.form.form === s.form) return r;
      return patchRecipe(r, { form: { form: s.form, v: CURRENT_V[s.form], base: clampBase(s.form, r.form.base) } }, 'geometry');
    }
    case 'ink': {
      const same = r.color.ink === s.ink && (s.ink !== 'custom' || sameCustom(r.color.lch, s.custom));
      if (same) return r;
      return patchRecipe(r, { color: assignVariant(s.ink, r.color.k, null, s.custom) }, 'color');
    }
    case 'reseed':
      return patchRecipe(r, { seed: hash32(r.seed, nextSeed()) }, 'geometry');
    case 'size': {
      const size = clampSize(r.stroke.nib, r.stroke.size * s.factor);
      if (size === r.stroke.size) return r;
      return patchRecipe(r, { stroke: { nib: r.stroke.nib, size } }, 'geometry');
    }
    case 'depth': {
      const base = clampBase(r.form.form, r.form.base + s.delta);
      if (base === r.form.base) return r;
      return patchRecipe(r, { form: { ...r.form, base } }, 'geometry');
    }
    case 'color': {
      if (s.dh === 0 && s.dL === 0) return r;
      const lch = bendColor(r.color, s.dh, s.dL, s.ground);
      return patchRecipe(r, { color: { ink: 'custom', k: r.color.k, dh: 0, dL: 0, lch } }, 'color');
    }
  }
}

/** The fields every selected stroke shares (null = mixed), for mirroring into the tool. */
export function uniformStyle(rs: readonly StrokeRecipe[]): {
  nib: NibId | null; size: number | null; form: FormId | null; base: number | null;
  ink: InkId | null; custom: ColorStyle['lch'] | null; color: ColorStyle | null;
} {
  if (rs.length === 0) return { nib: null, size: null, form: null, base: null, ink: null, custom: null, color: null };
  const f = rs[0];
  let nib: NibId | null = f.stroke.nib, size: number | null = f.stroke.size;
  let form: FormId | null = f.form.form, base: number | null = f.form.base;
  let ink: InkId | null = f.color.ink, custom = f.color.lch;
  for (let i = 1; i < rs.length; i++) {
    const r = rs[i];
    if (r.stroke.nib !== nib) { nib = null; size = null; }
    if (r.stroke.size !== size) size = null;
    if (r.form.form !== form) { form = null; base = null; }
    if (r.form.base !== base) base = null;
    if (r.color.ink !== ink || (ink === 'custom' && !sameCustom(r.color.lch, custom))) { ink = null; custom = null; }
  }
  return { nib, size, form, base, ink, custom, color: f.color };
}

/** Screen rect of a doc box through the view (viewport CSS px). */
function rectOf(view: View, b: AABB): { x: number; y: number; w: number; h: number } {
  const [x0, y0] = view.toScreen(b.x0, b.y0);
  const [x1, y1] = view.toScreen(b.x1, b.y1);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export interface SelectionEvents {
  /** The selected set changed (ids in z-order; empty = deselected). */
  changed(ids: readonly StrokeId[]): void;
  /** The tool should mirror the selection's style (null restores the tool saved at selection). */
  mirror(patch: Partial<ToolState> | null): void;
  /** A restyle or delete entered history. */
  edited(what: 'restyle' | 'delete', n: number): void;
}

export class Selection {
  private ids: StrokeId[] = [];
  private box: AABB | null = null;
  private lassoXY = new Float64Array(256);
  private lassoN = 0;
  private lassoAdd = false;
  private lassoOn = false;
  private readonly docPt: [number, number] = [0, 0];
  /** Live chip-drag preview: the values last shown and when, so the cook cost throttles itself. */
  private preview: { key: string; items: { r: StrokeRecipe; c: Cooked }[]; t: number; cost: number } | null = null;
  private previewRaf = 0;
  private previewNext: Restyle | null = null;

  constructor(private readonly rt: Runtime, private readonly view: View, private readonly ev: SelectionEvents) {}

  get active(): boolean { return this.ids.length > 0; }
  get list(): readonly StrokeId[] { return this.ids; }
  /** The selected recipes in z-order (missing ids skipped). */
  recipes(): StrokeRecipe[] {
    const out: StrokeRecipe[] = [];
    for (const id of this.ids) { const r = this.rt.doc.get(id); if (r) out.push(r); }
    return out;
  }

  // ---------------------------------------------------------------- picking

  select(x: number, y: number, add: boolean): void {
    const p = this.view.toDocInto(x, y, this.docPt);
    const id = this.rt.scene.hit(p, HIT_SP / this.view.cam.scale);
    if (!id) { this.clear(); return; }
    if (!add) { this.set([id]); return; }
    const i = this.ids.indexOf(id);
    if (i >= 0) { const next = this.ids.slice(); next.splice(i, 1); this.set(next); }
    else this.set([...this.ids, id]);
  }

  lassoBegin(x: number, y: number, add: boolean): void {
    this.lassoOn = true;
    this.lassoAdd = add;
    this.lassoN = 0;
    this.lassoPush(x, y);
  }

  lassoMove(x: number, y: number): void {
    if (!this.lassoOn) return;
    const n = this.lassoN;
    // skip sub-pixel jitter: the path is drawn every event and tested at the end
    if (n > 0) {
      const dx = x - this.lassoXY[2 * n - 2], dy = y - this.lassoXY[2 * n - 1];
      if (dx * dx + dy * dy < 1) return;
    }
    this.lassoPush(x, y);
  }

  private lassoPush(x: number, y: number): void {
    if (2 * this.lassoN + 2 > this.lassoXY.length) {
      const g = new Float64Array(this.lassoXY.length * 2);
      g.set(this.lassoXY);
      this.lassoXY = g;
    }
    this.lassoXY[2 * this.lassoN] = x;
    this.lassoXY[2 * this.lassoN + 1] = y;
    this.lassoN++;
    this.rt.renderer.overlay.lasso(this.lassoXY.subarray(0, 2 * this.lassoN));
  }

  lassoEnd(): void {
    if (!this.lassoOn) return;
    this.lassoOn = false;
    this.rt.renderer.overlay.lasso(null);
    const n = this.lassoN;
    this.lassoN = 0;
    if (n < 3) return;
    const poly = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      const d = this.view.toDocInto(this.lassoXY[2 * i], this.lassoXY[2 * i + 1], this.docPt);
      poly[2 * i] = d[0]; poly[2 * i + 1] = d[1];
    }
    const hit = this.rt.scene.lasso(poly);
    if (this.lassoAdd && this.ids.length) {
      const set = new Set(this.ids);
      for (const id of hit) set.add(id);
      this.set([...set].sort());
    } else if (hit.length || !this.lassoAdd) this.set(hit);
  }

  selectAll(): void {
    this.set(this.rt.doc.ordered().map(r => r.id));
  }

  clear(): void {
    if (!this.ids.length) return;
    this.set([]);
  }

  /** Make `ids` the selection (deduplicated, z-ordered, missing ids dropped). */
  set(ids: readonly StrokeId[]): void {
    const doc = this.rt.doc;
    const next = [...new Set(ids)].filter(id => doc.has(id)).sort();
    const was = this.ids;
    if (next.length === was.length && next.every((id, i) => id === was[i])) return;
    this.cancelPreview();
    this.ids = next;
    const R = this.rt.renderer;
    if (next.length) {
      R.lift(next).catch(() => undefined);
      this.ev.mirror(this.mirrorPatch());
    } else {
      R.drop().catch(() => undefined);
      this.ev.mirror(null);
    }
    this.refreshBounds();
    this.ev.changed(next);
    if (next.length) this.rt.scene.ensure(next, 'visible').then(() => this.refreshBounds()).catch(() => undefined);
  }

  /** The document changed: drop ids that left it, re-mirror and re-measure the rest. */
  docChanged(): void {
    if (!this.ids.length) return;
    const doc = this.rt.doc;
    const kept = this.ids.filter(id => doc.has(id));
    if (kept.length !== this.ids.length) { this.set(kept); return; }
    this.refreshBounds();
    this.ev.mirror(this.mirrorPatch());
  }

  /** Bounds in doc space -> overlay + AppState.selectionRect (camera publish, doc change). */
  refreshBounds(): void {
    const rt = this.rt;
    if (!this.ids.length) {
      this.box = null;
      rt.renderer.overlay.selection(null, []);
      rt.store.set({ selection: this.ids, selectionRect: null });
      return;
    }
    let b: AABB | null = null;
    for (const id of this.ids) {
      const x = rt.scene.boxOf(id);
      if (!x) continue;
      if (!b) b = { x0: x.x0, y0: x.y0, x1: x.x1, y1: x.y1 };
      else { if (x.x0 < b.x0) b.x0 = x.x0; if (x.y0 < b.y0) b.y0 = x.y0; if (x.x1 > b.x1) b.x1 = x.x1; if (x.y1 > b.y1) b.y1 = x.y1; }
    }
    this.box = b;
    rt.renderer.overlay.selection(b, this.ids);
    rt.store.set({ selection: this.ids, selectionRect: b ? rectOf(this.view, b) : null });
  }

  /** Called on every camera publish: only the screen rect moves. */
  cameraMoved(): void {
    if (!this.ids.length || !this.box) return;
    this.rt.store.set({ selectionRect: rectOf(this.view, this.box) });
  }

  private mirrorPatch(): Partial<ToolState> {
    const t = this.rt.store.get().tool;
    const u = uniformStyle(this.recipes());
    const p: Partial<ToolState> = {};
    if (u.nib) { p.nib = u.nib; p.lastNib = u.nib; if (u.size !== null) p.sizes = { ...t.sizes, [u.nib]: u.size }; }
    if (u.form) { p.form = u.form; if (u.base !== null) p.base = { ...t.base, [u.form]: u.base }; }
    if (u.ink) { p.ink = u.ink; p.custom = u.ink === 'custom' ? u.custom : t.custom; }
    if (u.color) {
      const c: ColorStyle = { ink: u.color.ink, k: u.color.k, dh: u.color.dh, dL: u.color.dL, lch: u.color.lch };
      p.recents = [c, ...t.recents.filter((_, i) => i > 0)].slice(0, 2);
    }
    if (t.mode === 'erase') p.mode = 'draw';
    return p;
  }

  /** The selection's own colour (recent slot 1), for the sampling route. */
  color(): ColorStyle | null {
    const rs = this.recipes();
    return rs.length ? rs[0].color : null;
  }

  /** Every selected stroke already has this Form (a tap on it reseeds). */
  allForm(form: FormId): boolean {
    const rs = this.recipes();
    return rs.length > 0 && rs.every(r => r.form.form === form);
  }

  // ---------------------------------------------------------------- edits

  /** One `replace` command for the whole selection, played as a morph. Returns the count changed. */
  restyle(s: Restyle): number {
    return this.restyleStrokes(this.recipes(), s);
  }

  /** Restyle any strokes (the selection, or the last stroke for R): one `replace`, a morph. */
  restyleStrokes(before: readonly StrokeRecipe[], s: Restyle): number {
    this.cancelPreview();
    const rt = this.rt;
    if (!before.length) return 0;
    const preview = this.preview;
    this.preview = null;
    const after: StrokeRecipe[] = [], from: StrokeRecipe[] = [];
    const cooked: (Cooked | null)[] = [];
    // symmetry copies share their seed: a reseed gives them one new seed, so they stay symmetric
    const seeds = new Map<number, number>();
    for (const r of before) {
      const n = restyleRecipe(r, s, () => {
        let v = seeds.get(r.seed);
        if (v === undefined) { v = rt.doc.nextSeed(); seeds.set(r.seed, v); }
        return v;
      });
      if (n === r) continue;
      from.push(r); after.push(n);
      const pv = preview && preview.key === restyleKey(s) ? preview.items.find(it => it.r.id === r.id) : undefined;
      cooked.push(pv && pv.r.geomRev !== r.geomRev && sameGeometryInputs(pv.r, n) ? pv.c : null);
    }
    if (!after.length) { this.rt.renderer.previewLifted(null); return 0; }
    const cmd = replaceCmd(from, after);
    const inv = rt.doc.apply(cmd);
    rt.history.push(cmd, inv);
    for (let i = 0; i < after.length; i++) {
      const c = cooked[i];
      if (c) rt.scene.putFor(after[i], c);
      else if (after[i].geomRev === from[i].geomRev) {
        // colour only: the geometry is unchanged, share it
        const g = rt.scene.cookedFor(from[i]) ?? rt.scene.cooked(from[i].id);
        if (g) rt.scene.putFor(after[i], g);
      }
    }
    rt.renderer.strokesReplaced(from, after, rt.reduced() ? 'none' : 'morph');
    if (this.ids.length) {
      this.refreshBounds();
      this.ev.mirror(this.mirrorPatch());
      this.ev.edited('restyle', after.length);
      rt.scene.ensure(after.map(r => r.id), 'visible').then(() => this.refreshBounds()).catch(() => undefined);
    } else this.ev.edited('restyle', after.length);
    return after.length;
  }

  /**
   * A chip drag in progress: preview the bend on the lifted strokes (≤ 12) at ~30 Hz. The
   * preview is cooked on the main thread, so the cadence stretches to 3× the last cook cost.
   */
  previewBend(s: Restyle): void {
    if (this.ids.length > PREVIEW_MAX) return;
    this.previewNext = s;
    if (this.previewRaf) return;
    const now = performance.now();
    const p = this.preview;
    const wait = p ? Math.max(0, Math.max(PREVIEW_MS, 3 * p.cost) - (now - p.t)) : 0;
    this.previewRaf = window.setTimeout(() => { this.previewRaf = 0; this.runPreview(); }, wait);
  }

  private runPreview(): void {
    const s = this.previewNext;
    this.previewNext = null;
    if (!s || !this.ids.length) return;
    const rt = this.rt;
    const key = restyleKey(s);
    if (this.preview && this.preview.key === key) return;
    const t0 = performance.now();
    const items: { r: StrokeRecipe; c: Cooked }[] = [];
    for (const r of this.recipes()) {
      const n = restyleRecipe(r, s, () => 0);
      if (n === r) { const c = rt.scene.cooked(r.id); if (c) items.push({ r, c }); continue; }
      let c: Cooked | undefined;
      if (n.geomRev === r.geomRev) c = rt.scene.cookedFor(r) ?? rt.scene.cooked(r.id);
      else {
        // the same geometry as the last preview frame (a colour drag over a size drag, say)
        const prev = this.preview?.items.find(it => it.r.id === r.id);
        c = prev && sameGeometryInputs(prev.r, n) ? prev.c : cook(n);
      }
      if (c) items.push({ r: n, c });
    }
    this.preview = { key, items, t: t0, cost: performance.now() - t0 };
    rt.renderer.previewLifted(items);
  }

  private cancelPreview(): void {
    if (this.previewRaf) { clearTimeout(this.previewRaf); this.previewRaf = 0; }
    this.previewNext = null;
    if (this.preview) { this.preview = null; this.rt.renderer.previewLifted(null); }
  }

  /** Cancel a drag: back to the committed look. */
  endPreview(): void {
    this.cancelPreview();
  }

  /** Delete the selection: one `remove`, un-grown. */
  delete(): number {
    const rt = this.rt;
    const gone = this.recipes();
    if (!gone.length) return 0;
    this.cancelPreview();
    const ids = gone.map(r => r.id);
    const cmd = removeCmd(ids);
    const inv = rt.doc.apply(cmd);
    rt.history.push(cmd, inv);
    rt.renderer.strokesRemoved(gone, 'ungrow');
    this.ids = [];
    this.box = null;
    rt.renderer.drop().catch(() => undefined);
    this.refreshBounds();
    this.ev.mirror(null);
    this.ev.changed(this.ids);
    this.ev.edited('delete', gone.length);
    return gone.length;
  }
}

/** Identity of a bend's values (one preview per distinct value). */
function restyleKey(s: Restyle): string {
  switch (s.kind) {
    case 'size': return `size:${s.factor}`;
    case 'depth': return `depth:${s.delta}`;
    case 'color': return `color:${s.dh}:${s.dL}:${s.ground}`;
    case 'nib': return `nib:${s.nib}:${s.size}`;
    case 'form': return `form:${s.form}`;
    case 'ink': return `ink:${s.ink}`;
    case 'reseed': return 'reseed';
  }
}

/** Two recipes cook to the same geometry (same samples and every geometry input). */
function sameGeometryInputs(a: StrokeRecipe, b: StrokeRecipe): boolean {
  return a.samples === b.samples && a.pools === b.pools && a.seed === b.seed && a.z === b.z && a.s0 === b.s0 &&
    a.cut === b.cut && a.closed === b.closed && a.radial === b.radial && a.device === b.device &&
    a.stroke.nib === b.stroke.nib && a.stroke.size === b.stroke.size &&
    a.form.form === b.form.form && a.form.v === b.form.v && a.form.base === b.form.base &&
    a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1] && a.calib === b.calib && a.resume === b.resume && a.xf === b.xf;
}

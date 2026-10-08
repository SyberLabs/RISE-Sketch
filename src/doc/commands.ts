/**
 * Recipe construction and command helpers.
 *
 * Recipes are immutable: `freezeRecipe` builds one from a finished draft, and
 * `patchRecipe` derives a restyled one that shares `samples`. Both copy the small
 * nested style objects (so freezing never reaches into caller-owned state such as
 * the learner's calib or the tool's custom colour) and always build objects with
 * the same key order, so every recipe shares one hidden class.
 *
 * Decision (cache safety): `geomRev` / `colorRev` are cache keys (`id:geomRev` for
 * cooked geometry, `id:colorRev:ground` for ink tables). If a bump were simply
 * `rev + 1`, an undo followed by a *different* restyle would reuse a key for new
 * content and hit a stale cache. Revs are therefore drawn from one session-wide
 * monotonic clock that every recipe entering the session (`noteRevs`) advances, so
 * within a session (id, rev) always names exactly one content version.
 */
import { S, PL } from '../core/types';
import type { Calib, ColorStyle, Command, FormStyle, LCh, Mat2x3, StrokeId, StrokeRecipe, StrokeStyle, Symmetry, Vec2 } from '../core/types';

/** Fields a caller supplies to `freezeRecipe` (everything except the revs). */
export type RecipeFields = Omit<StrokeRecipe, 'geomRev' | 'colorRev'>;
/** Fields `patchRecipe` may change. */
export type RecipePatch = Partial<Omit<StrokeRecipe, 'id' | 'geomRev' | 'colorRev'>>;

let revClock = 0;

/** A rev greater than every rev issued or seen in this session. */
export function freshRev(): number {
  return ++revClock;
}

/** Advance the rev clock past a recipe's revs (call for recipes loaded from storage). */
export function noteRevs(r: Pick<StrokeRecipe, 'geomRev' | 'colorRev'>): void {
  const m = r.geomRev > r.colorRev ? r.geomRev : r.colorRev;
  if (m > revClock && Number.isFinite(m)) revClock = Math.floor(m);
}

function bumpFrom(prev: number): number {
  revClock = (prev > revClock ? Math.floor(prev) : revClock) + 1;
  return revClock;
}

/** The typed array itself when it owns its whole buffer, else an exact-length copy. */
function own<T extends Float32Array | Float64Array>(a: T): T {
  return a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : (a.slice() as T);
}

/** Always an exact-length copy: caller-owned storage is never adopted. */
function copyArr<T extends Float32Array | Float64Array>(a: T): T {
  return a.slice() as T;
}

const NO_POOLS = new Float32Array(0);

const lch3 = (c: LCh): LCh => Object.freeze([c[0], c[1], c[2]] as const);

function copyCalib(c: Calib): Calib {
  return Object.freeze({ lo: c.lo, hi: c.hi, gamma: c.gamma, flat: c.flat, vMed: c.vMed, jitter: c.jitter, fcMin: c.fcMin });
}
function copyStroke(s: StrokeStyle): StrokeStyle {
  return Object.freeze({ nib: s.nib, size: s.size });
}
function copyColor(c: ColorStyle): ColorStyle {
  return Object.freeze({
    ink: c.ink, k: c.k, dh: c.dh, dL: c.dL,
    lch: c.lch ? Object.freeze({ night: lch3(c.lch.night), paper: lch3(c.lch.paper) }) : null,
  });
}
function copyForm(f: FormStyle): FormStyle {
  return Object.freeze({ form: f.form, v: f.v, base: f.base });
}
function copySym(s: Symmetry | null): Symmetry | null {
  return s ? Object.freeze({ axis: s.axis, at: s.at }) : null;
}
const copyOrigin = (o: Vec2): Vec2 => Object.freeze([o[0], o[1]] as const);

function check(f: RecipeFields): void {
  if (typeof f.id !== 'string' || f.id.length === 0) throw new TypeError('recipe: id must be a non-empty string');
  if (!(f.samples instanceof Float32Array) || f.samples.length === 0 || f.samples.length % S.STRIDE !== 0) {
    throw new RangeError(`recipe ${f.id}: samples must be a non-empty Float32Array of ${S.STRIDE}-float rows`);
  }
  if (!(f.pools instanceof Float32Array) || f.pools.length % PL.STRIDE !== 0) {
    throw new RangeError(`recipe ${f.id}: pools must be a Float32Array of ${PL.STRIDE}-float rows`);
  }
  if (f.resume !== null && !(f.resume instanceof Float32Array)) throw new TypeError(`recipe ${f.id}: resume must be a Float32Array or null`);
  if (f.xf !== null && !(f.xf instanceof Float64Array && f.xf.length === 6)) throw new TypeError(`recipe ${f.id}: xf must be a 6-entry Float64Array or null`);
}

/**
 * `adopt`: typed arrays that own their whole buffer are kept as is (recipes from
 * storage or another recipe); otherwise every array is copied.
 */
function build(f: RecipeFields, geomRev: number, colorRev: number, adopt: boolean): StrokeRecipe {
  check(f);
  const take = adopt ? own : copyArr;
  const r: StrokeRecipe = {
    id: f.id,
    created: f.created,
    origin: copyOrigin(f.origin),
    z: f.z,
    rot: f.rot,
    seed: f.seed >>> 0,
    device: f.device,
    calib: copyCalib(f.calib),
    stroke: copyStroke(f.stroke),
    color: copyColor(f.color),
    form: copyForm(f.form),
    s0: f.s0,
    cut: f.cut,
    resume: f.resume ? take(f.resume) : null,
    samples: take(f.samples),
    pools: take(f.pools),
    closed: f.closed,
    radial: f.radial,
    sym: copySym(f.sym),
    xf: f.xf ? take(f.xf as Mat2x3) : null,
    geomRev,
    colorRev,
  };
  return Object.freeze(r);
}

/**
 * Freeze a finished draft into an immutable recipe with geomRev = colorRev = 0.
 * Every typed array (samples, pools, resume, xf) is copied to exact length, so
 * the recipe never aliases caller-owned storage: a draft's growable buffer is
 * reused for the next stroke, and when it happens to be exactly full a view of it
 * covers the whole buffer, so adopting "whole-buffer" arrays would let the next
 * stroke overwrite a committed one. One copy per stroke is cheap.
 * Throws on malformed sample / pool buffers.
 */
export function freezeRecipe(fields: Omit<StrokeRecipe, 'geomRev' | 'colorRev'>): StrokeRecipe {
  return build(fields, 0, 0, false);
}

/**
 * Rebuild a stored recipe with the given revs (advancing the rev clock past them).
 * Arrays that own their whole buffer (freshly decoded or structured-cloned) are
 * adopted; views are copied.
 */
export function restoreRecipe(fields: RecipeFields, geomRev: number, colorRev: number): StrokeRecipe {
  const r = build(fields, geomRev, colorRev, true);
  noteRevs(r);
  return r;
}

const GEOM_KEYS: readonly (keyof RecipePatch)[] = [
  'created', 'origin', 'z', 'rot', 'seed', 'device', 'calib', 'stroke', 'form', 's0', 'cut', 'resume',
  'samples', 'pools', 'closed', 'radial', 'sym', 'xf',
];

/**
 * New recipe with a patch; bumps geomRev (kind 'geometry') or colorRev (kind 'color').
 * Cache safety wins over the declared kind: a patch that changes `color` also bumps
 * colorRev, and one that changes any geometry input also bumps geomRev. `undefined`
 * values in the patch are ignored. `samples` (and any unpatched array) is shared;
 * a typed array supplied by the patch is copied, like in `freezeRecipe`.
 */
export function patchRecipe(
  r: StrokeRecipe,
  patch: Partial<Omit<StrokeRecipe, 'id' | 'geomRev' | 'colorRev'>>,
  kind: 'geometry' | 'color',
): StrokeRecipe {
  const f: { -readonly [K in keyof RecipeFields]: RecipeFields[K] } = { ...r };
  let geom = kind === 'geometry';
  let color = kind === 'color';
  const p = patch as Record<string, unknown>;
  const fr = f as unknown as Record<string, unknown>;
  for (const k of GEOM_KEYS) {
    let v = p[k];
    if (v === undefined) continue;
    if (v !== fr[k]) {
      if (k !== 'created') geom = true;
      if (v instanceof Float32Array || v instanceof Float64Array) v = copyArr(v);
    }
    fr[k] = v;
  }
  if (patch.color !== undefined) {
    if (patch.color !== r.color) color = true;
    f.color = patch.color;
  }
  return build(f, geom ? bumpFrom(r.geomRev) : r.geomRev, color ? bumpFrom(r.colorRev) : r.colorRev, true);
}

/** Recipe fields without the revs (for serialisation and storage). */
export function recipeFields(r: StrokeRecipe): RecipeFields {
  return {
    id: r.id, created: r.created, origin: r.origin, z: r.z, rot: r.rot, seed: r.seed, device: r.device,
    calib: r.calib, stroke: r.stroke, color: r.color, form: r.form, s0: r.s0, cut: r.cut, resume: r.resume,
    samples: r.samples, pools: r.pools, closed: r.closed, radial: r.radial, sym: r.sym, xf: r.xf,
  };
}

// ---------------------------------------------------------------- command builders

/** `add` command (one stroke, or the pieces of an auto-split inside a `batch`). */
export const addCmd = (recipes: readonly StrokeRecipe[]): Command => ({ k: 'add', recipes });
/** `remove` command (eraser gesture, Delete). */
export const removeCmd = (ids: readonly StrokeId[]): Command => ({ k: 'remove', ids });
/** `replace` command (restyle, peel pools); `before[i]` and `after[i]` share an id. */
export const replaceCmd = (before: readonly StrokeRecipe[], after: readonly StrokeRecipe[]): Command => ({ k: 'replace', before, after });
/** `meta` command (title). */
export const metaCmd = (title: string): Command => ({ k: 'meta', patch: { title } });
/** `batch` command; applied in order, undone in reverse. */
export const batchCmd = (cmds: readonly Command[]): Command => ({ k: 'batch', cmds });

/**
 * Peel split (DESIGN §3.1): a risen stroke commits as `add` at base depth, then a
 * `replace` that adds the pools, so the first undo drains the pools and the second
 * removes the stroke. Returns the two commands for `r` (which carries the pools);
 * for a stroke without pools only the `add` is returned.
 *
 * The recipe left in the document is `r` itself, so geometry cooked from `r`
 * (`cook.finish(r)`) can be registered for it directly. The bare stroke shares
 * `r`'s samples and gets a fresh geomRev, so it never shares a cache key with `r`.
 * Symmetry copies (same pools) ride in the same two commands: one gesture, one undo.
 */
export function peelCommands(r: StrokeRecipe, copies: readonly StrokeRecipe[] = []): Command[] {
  const all = copies.length ? [r, ...copies] : [r];
  if (r.pools.length === 0) return [addCmd(all)];
  const bare = all.map(x => build({ ...recipeFields(x), pools: NO_POOLS }, bumpFrom(x.geomRev), x.colorRev, true));
  return [addCmd(bare), replaceCmd(bare, all)];
}

/** True when a command changes nothing (empty add/remove/replace/batch, empty meta patch). */
export function isEmptyCommand(c: Command): boolean {
  switch (c.k) {
    case 'add': return c.recipes.length === 0;
    case 'remove': return c.ids.length === 0;
    case 'replace': return c.before.length === 0;
    case 'meta': return c.patch.title === undefined;
    case 'batch': return c.cmds.every(isEmptyCommand);
  }
}

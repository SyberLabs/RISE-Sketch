/**
 * Forms lab harness: cook a prototype FormOps through the REAL pipeline (ink/cook.ts),
 * so prototypes get the real spine, depth field, pools, closure, radial seeds, budgets,
 * incremental cooking and render path for free.
 *
 * Prototypes live in lab/forms/<name>.form.ts and export:
 *   export const meta: LabFormMeta   // name, version (>= 100, unique), ink, notes
 *   export const ops: FormOps        // id 'ripple', v === meta.v
 * They are registered under the P1 'ripple' slot at their own version, which no shipped
 * recipe uses, so nothing in src changes.
 */
import type { Cooked, Device, FormId, InkId, NibId, StrokeRecipe } from '../../src/core/types';
import { cook, createIncrementalCook } from '../../src/ink/cook';
import { registerOperator } from '../../src/ink/operators/registry';
import type { FormOps } from '../../src/ink/operators/types';
import { Feeder, formRecipe, cookedDiff, cookedProblems, cookedHash, Hand } from '../../tests/ink-forms.fixtures';

export const LAB_FORM: FormId = 'ripple';

export interface LabFormMeta {
  /** Display name, e.g. "Frost". */
  name: string;
  /** Operator version: unique per prototype, >= 100. */
  v: number;
  /** Ink the gallery draws it with. */
  ink: InkId;
  /** Base depth the gallery uses (defaults to ops.baseDefault). */
  base?: number;
  /** One paragraph: what it is, which gestures drive what. Shown in the gallery label. */
  notes: string;
}

export interface LabForm { meta: LabFormMeta; ops: FormOps }

const registered = new Set<number>();
/** Register once (idempotent per version). */
export function ensureRegistered(f: LabForm): void {
  if (registered.has(f.meta.v)) return;
  if (f.ops.v !== f.meta.v || f.ops.id !== LAB_FORM) throw new Error(`${f.meta.name}: ops.id/v must be '${LAB_FORM}'/${f.meta.v}`);
  registerOperator(LAB_FORM, f.meta.v, f.ops);
  registered.add(f.meta.v);
}

export interface LabStrokeOpts {
  base?: number; nib?: NibId; size?: number; device?: Device; z?: number;
  closed?: boolean; radial?: boolean; pools?: number[]; seed?: number; noP?: boolean;
  origin?: readonly [number, number];
}

/** A committed recipe over a Hand gesture that cooks with the lab form. */
export function labRecipe(f: LabForm, h: Hand, o: LabStrokeOpts = {}): StrokeRecipe {
  ensureRegistered(f);
  const rows = h.rows(o.z ?? 1, !!o.noP);
  const base = o.base ?? f.meta.base ?? f.ops.baseDefault;
  const r0 = formRecipe(rows, {
    form: LAB_FORM, base, nib: o.nib, size: o.size, device: o.device, z: o.z,
    closed: o.closed, radial: o.radial, pools: o.pools, seed: o.seed ?? 11,
  });
  return { ...r0, form: { form: LAB_FORM, v: f.meta.v, base }, origin: o.origin ?? r0.origin };
}

/** One-shot cook (≡ incremental finish, by construction). */
export function labCook(f: LabForm, h: Hand, o: LabStrokeOpts = {}): { r: StrokeRecipe; c: Cooked } {
  const r = labRecipe(f, h, o);
  return { r, c: cook(r) };
}

export interface LiveStage { r: StrokeRecipe; c: Cooked; ghost: Cooked | null; fraction: number }

/** Live views of a stroke at several fractions of its rows (optionally with a pool near the tip at the last one). */
export function labLive(f: LabForm, h: Hand, fractions: number[], o: LabStrokeOpts & { poolAtTip?: number } = {}): LiveStage[] {
  const r = labRecipe(f, h, o);
  return fractions.map((fr, i) => {
    const fd = new Feeder(r);
    const ic = createIncrementalCook(fd.d);
    const stop = Math.floor(fd.total * fr);
    while (fd.fed < stop) { const n0 = fd.fed; fd.feed(4); ic.append(fd.fed - n0); }
    if (o.poolAtTip && i === fractions.length - 1) { fd.setPools([ic.spine().L - 4, o.poolAtTip]); ic.regrow(0, 1e9); }
    const v = ic.view();
    return { r, c: v.geom, ghost: v.ghost, fraction: fr };
  });
}

/**
 * The key invariant every Form must hold: incremental cooking under ANY append chunking,
 * hold schedule and closure flicker must finish bit-identical to the one-shot cook.
 * Returns null when it holds, else a description of the first difference.
 */
export function checkIncremental(f: LabForm, h: Hand, o: LabStrokeOpts & { chunks?: number[]; holds?: number[][]; flickerClosure?: boolean } = {}): string | null {
  const r = labRecipe(f, h, o);
  const chunks = o.chunks ?? [1, 3, 7, 25, 64, 500];
  for (const k of chunks) {
    const fd = new Feeder(r);
    const ic = createIncrementalCook(fd.d);
    let step = 0;
    while (fd.fed < fd.total) {
      const n0 = fd.fed; fd.feed(k); ic.append(fd.fed - n0);
      step++;
      if (o.holds && step % 3 === 0) {
        const L = ic.spine().L;
        const hold = o.holds[step % o.holds.length];
        if (hold) { fd.setPools([Math.max(0, L - hold[0]), hold[1]]); ic.regrow(0, 1e9); }
      }
      if (o.flickerClosure && step % 5 === 0) ic.setClosing(step % 10 === 0);
    }
    if (o.pools) { fd.setPools(o.pools); ic.regrow(0, 1e9); }
    ic.setClosing(!!o.closed);
    const frozen = fd.freeze(!!o.closed);
    const inc = ic.finish(frozen);
    const full = cook(frozen);
    const d = cookedDiff(inc, full);
    if (d) return `chunk ${k}: ${d}`;
  }
  return null;
}

/** Structural problems of a Cooked (NaN, box containment, genStart order, budgets...). */
export function problems(c: Cooked): string[] { return cookedProblems(c); }
export { cookedHash, Hand, Feeder };

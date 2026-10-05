/**
 * Operator registry: Form metadata and (FormId, version) -> operator. Operators are
 * frozen by version (DESIGN §7.5 rule 8): a new look ships as `<form>.v2.ts`, and old
 * recipes keep cooking with the version they were drawn with.
 */
import type { FormId } from '../../core/types';
import type { FormOps } from './types';
import { line } from './line.v1';
import { echo } from './echo.v1';
import { sprout } from './sprout.v1';
import { drift } from './drift.v1';
import { craze } from './craze.v1';
import { plume } from './plume.v1';
import { caustic } from './caustic.v1';
import { burin } from './burin.v1';
import { plait } from './plait.v1';
import { orbit } from './orbit.v1';

/** UI / tool metadata of a Form. */
export interface FormMeta { id: FormId; name: string; dMax: number; baseDefault: number; locality: 'local' | 'global'; p0: boolean }

/**
 * The Forms (Ripple is P1: metadata only). Craze, Plume, Caustic, Burin, Plait and Orbit were
 * promoted from the forms lab (lab/forms, prototypes v101–v106) with unchanged geometry.
 */
export const FORMS: Record<FormId, FormMeta> = {
  line: { id: 'line', name: 'Line', dMax: 5, baseDefault: 0, locality: 'local', p0: true },
  echo: { id: 'echo', name: 'Echo', dMax: 5, baseDefault: 2, locality: 'global', p0: true },
  sprout: { id: 'sprout', name: 'Sprout', dMax: 4, baseDefault: 2, locality: 'local', p0: true },
  drift: { id: 'drift', name: 'Drift', dMax: 6, baseDefault: 2, locality: 'local', p0: true },
  ripple: { id: 'ripple', name: 'Ripple', dMax: 6, baseDefault: 2, locality: 'local', p0: false },
  craze: { id: 'craze', name: 'Craze', dMax: 4, baseDefault: 2, locality: 'local', p0: true },
  plume: { id: 'plume', name: 'Plume', dMax: 3, baseDefault: 2, locality: 'local', p0: true },
  caustic: { id: 'caustic', name: 'Caustic', dMax: 4, baseDefault: 2, locality: 'local', p0: true },
  burin: { id: 'burin', name: 'Burin', dMax: 4, baseDefault: 2, locality: 'local', p0: true },
  plait: { id: 'plait', name: 'Plait', dMax: 4, baseDefault: 2, locality: 'local', p0: true },
  orbit: { id: 'orbit', name: 'Orbit', dMax: 4, baseDefault: 2, locality: 'local', p0: true },
};

/** Operator version new strokes are drawn with. */
export const CURRENT_V: Record<FormId, number> = {
  line: 1, echo: 1, sprout: 1, drift: 1, ripple: 1,
  craze: 1, plume: 1, caustic: 1, burin: 1, plait: 1, orbit: 1,
};

const V1: Record<FormId, FormOps> = { line, echo, sprout, drift, ripple: line, craze, plume, caustic, burin, plait, orbit };

/** Operators registered at runtime by exact (form, version): experiments and future versions. */
const EXTRA: Map<string, FormOps> = new Map();

/**
 * Register an operator for an exact (form, version). Shipping operators live in V1; this
 * hook lets the forms lab (lab/forms) and tests cook prototypes through the real pipeline
 * under versions no shipped recipe uses (>= 100). Returns a function that unregisters it.
 */
export function registerOperator(form: FormId, v: number, ops: FormOps): () => void {
  const key = form + '@' + v;
  EXTRA.set(key, ops);
  return () => { if (EXTRA.get(key) === ops) EXTRA.delete(key); };
}

/**
 * The operator for a Form and version. Exact runtime registrations win; otherwise unknown
 * versions fall back to v1, and Ripple (P1, no operator yet) cooks as Line, so every
 * recipe still renders.
 */
export function operatorFor(form: FormId, v: number): FormOps {
  return EXTRA.get(form + '@' + v) ?? V1[form] ?? line;
}

/**
 * Paper alpha relative to the Night alpha baked into Cooked.alpha for a poly of `gen`
 * (geometry never depends on the ground, DESIGN §2.3.6): the hierarchy is 0.78^(g−1) on
 * Paper vs 0.72^(g−1) on Night, and Drift filaments are α 0.30 vs 0.38.
 */
export function paperAlphaScale(form: FormId, gen: number): number {
  if (gen <= 0) return 1;
  let k = 1;
  for (let i = 1; i < gen; i++) k *= 0.78 / 0.72;
  return form === 'drift' ? k * (0.30 / 0.38) : k;
}

/**
 * Paper exposure of an Echo crystal relative to its baked Night exposure, from
 * Cooked.coverage (DESIGN §2.4.2): min(0.85, 0.6/√max(cov, .45)) / min(1, 0.55/√max(cov, .3)).
 */
export function echoPaperExposure(cov: number): number {
  const night = Math.min(1, 0.55 / Math.sqrt(Math.max(cov, 0.3)));
  const paper = Math.min(0.85, 0.6 / Math.sqrt(Math.max(cov, 0.45)));
  return night > 0 ? paper / night : 1;
}

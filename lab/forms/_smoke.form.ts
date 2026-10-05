/**
 * Smoke prototype: the shipped Drift operator re-registered under the lab path, proving
 * that lab/forms/harness.ts + page.ts + shot.mjs drive a FormOps through the real pipeline.
 * Not a design; delete freely.
 */
import { drift } from '../../src/ink/operators/drift.v1';
import type { FormOps } from '../../src/ink/operators/types';
import type { LabFormMeta } from './harness';

export const meta: LabFormMeta = {
  name: 'Smoke (Drift)',
  v: 100,
  ink: 'rose',
  notes: 'The shipped Drift operator routed through the lab harness.',
};

export const ops: FormOps = { ...drift, id: 'ripple', v: 100 };

/**
 * Depth field (DESIGN §2.3.2): d(s) = base + max_i a_i·K(s − s_i).
 * The kernel soaks up the 48 sp drawn before a hold and unloads the brush back
 * to base over the 32 sp after it.
 */
import type { DepthField } from '../core/types';
import { PL } from '../core/types';
import { smoothstep } from '../core/num';

/** Arc (sp) a pool reaches back before its hold point. */
export const POOL_BACK = 48;
/** Arc (sp) a pool reaches forward after its hold point. */
export const POOL_AHEAD = 32;
/** Pool rows per stroke; a 33rd hold merges into the nearest pool. */
export const MAX_POOLS = 32;

/** K(x): smoothstep(−48, −6, x) for x ≤ 0, smoothstep(32, 0, x) for x > 0. */
export function kernel(x: number): number {
  return x <= 0 ? smoothstep(-POOL_BACK, -6, x) : smoothstep(POOL_AHEAD, 0, x);
}

/**
 * A depth field over `nPools` rows of `pools` (PL.STRIDE). The rows are read
 * live (no copy), so build a new field after the pool array is replaced.
 */
export function createDepthField(base: number, pools: Float32Array, nPools: number): DepthField {
  const n = Math.max(0, Math.min(nPools, Math.floor(pools.length / PL.STRIDE)));
  return {
    base,
    at(s: number): number {
      let m = 0;
      for (let i = 0; i < n; i++) {
        const o = i * PL.STRIDE;
        const a = pools[o + PL.A];
        if (a <= m) continue;
        const v = a * kernel(s - pools[o + PL.S]);
        if (v > m) m = v;
      }
      return base + m;
    },
    maxPool(): number {
      let m = 0;
      for (let i = 0; i < n; i++) { const a = pools[i * PL.STRIDE + PL.A]; if (a > m) m = a; }
      return m;
    },
  };
}

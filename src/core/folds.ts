/**
 * Symmetry fold counts (DESIGN §2.3.1): the steps of the Form sheet's symmetry switch.
 * 2 = Mirror (a reflection), 3..12 = radial copies. Core, so ui/ may use it.
 */

/** Fold counts the switch steps through: 2 = Mirror, then radial. Default 6. */
export const SYM_FOLDS: readonly number[] = [2, 3, 4, 5, 6, 8, 12];
export const SYM_DEFAULT_FOLDS = 6;

/** A valid fold count (anything else falls back to the default). */
export function clampFolds(n: unknown): number {
  const v = Number(n);
  return SYM_FOLDS.includes(v) ? v : SYM_DEFAULT_FOLDS;
}

/** The next / previous fold count (wraps). */
export function stepFolds(n: number, dir: 1 | -1): number {
  const i = SYM_FOLDS.indexOf(clampFolds(n));
  return SYM_FOLDS[(i + dir + SYM_FOLDS.length) % SYM_FOLDS.length];
}

/** `steps` fold counts away from `start`, clamped to the ends (a drag never wraps). */
export function foldsAt(start: number, steps: number): number {
  const i = SYM_FOLDS.indexOf(clampFolds(start)) + Math.trunc(steps);
  return SYM_FOLDS[i < 0 ? 0 : i >= SYM_FOLDS.length ? SYM_FOLDS.length - 1 : i];
}

/** Spoken name of a fold count (announcements, labels). */
export const foldsName = (folds: number): string => (folds === 2 ? 'Mirror' : `Kaleidoscope, ${folds}-fold`);

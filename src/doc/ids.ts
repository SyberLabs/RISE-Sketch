/**
 * Identifiers. Stroke ids sort lexicographically in creation order, which is
 * also z-order (DESIGN §7.2): a fixed-width base36 millisecond prefix followed
 * by a fixed-width base36 counter. Document ids use the same time prefix with a
 * random suffix, so Recent can also fall back to sorting by id.
 */
import type { StrokeId } from '../core/types';

/** Width of the base36 millisecond prefix (36^9 ms ≈ the year 5138). */
export const ID_MS_DIGITS = 9;
/** Width of the base36 counter suffix of a stroke id. */
export const ID_COUNTER_DIGITS = 4;
/** Counters at or above this no longer fit the fixed-width suffix (36^4). */
export const ID_COUNTER_SPAN = 1679616;
/** Largest millisecond value that fits the 9-digit prefix (36^9 - 1). */
export const ID_MAX_MS = 101559956668415;
/** Length of every id produced by `makeStrokeId` with an in-range counter. */
export const STROKE_ID_LENGTH = ID_MS_DIGITS + ID_COUNTER_DIGITS;

const STD_ID = /^[0-9a-z]{13}$/;

function b36(n: number, width: number): string {
  const v = n > 0 ? Math.floor(n) : 0;
  return v.toString(36).padStart(width, '0');
}

/**
 * base36(ms).padStart(9,'0') + base36(counter).padStart(4,'0').
 * Keep `counter` below ID_COUNTER_SPAN for fixed width (Doc.nextId wraps it).
 */
export function makeStrokeId(ms: number, counter: number): StrokeId {
  return b36(ms, ID_MS_DIGITS) + b36(counter, ID_COUNTER_DIGITS);
}

/** base36(ms).padStart(9,'0') + base36(rand32 >>> 0).padStart(7,'0'): 16 chars, sorts by creation. */
export function makeDocId(ms: number, rand32: number): string {
  return b36(ms, ID_MS_DIGITS) + ((rand32 >>> 0).toString(36)).padStart(7, '0');
}

/** True for ids in the standard 13-character stroke id form. */
export function isStdStrokeId(id: string): boolean {
  return STD_ID.test(id);
}

/** Millisecond prefix of a standard stroke (or doc) id; NaN when the id is not in that form. */
export function idMs(id: string): number {
  if (id.length < ID_MS_DIGITS || !/^[0-9a-z]+$/.test(id)) return NaN;
  return parseInt(id.slice(0, ID_MS_DIGITS), 36);
}

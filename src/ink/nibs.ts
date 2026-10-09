/**
 * Nibs: width and geometry per nib material (DESIGN §2.2.1).
 *
 * Widths here are UNTAPERED and in sp; the spine stores them in doc units
 * (÷ z) and the envelope (tapers) is applied at tessellation.
 */
import type { Device, NibId } from '../core/types';
import { clamp01, smoothstep } from '../core/num';
import { PI } from '../core/det';

/** A nib material: default size S and its range (sp), and the taper scale. */
export interface NibDef { id: NibId; name: string; S: number; min: number; max: number; taper: number }

/** The four nib materials. */
export const NIBS: Record<NibId, NibDef> = {
  pen: { id: 'pen', name: 'Pen', S: 2.5, min: 0.75, max: 12, taper: 0.5 },
  brush: { id: 'brush', name: 'Brush', S: 9, min: 2, max: 48, taper: 1 },
  chisel: { id: 'chisel', name: 'Chisel', S: 12, min: 3, max: 48, taper: 0.4 },
  charcoal: { id: 'charcoal', name: 'Charcoal', S: 7, min: 2, max: 40, taper: 0.8 },
};

const DEG = PI / 180;

/** Fingertips are blunt: every nib is this much wider under a finger. */
export const FINGER_WIDTH = 1.35;

/** Chisel minimum stroke thickness as a fraction of S (the core ribbon, §6.4). */
export const CHISEL_CORE = 0.12;

/** Charcoal laid on its side: width × (1 + CHARCOAL_LEAN·tK), tK = smoothstep(60°, 25°, alt). */
export const CHARCOAL_LEAN = 1.2;

/**
 * Untapered nib width in sp (Pen/Brush/Charcoal: full width; Chisel: edge length E).
 * Unknown (NaN) pressure reads as 0.6 and unknown speed as 0, so a width is always finite.
 * `alt` (pen altitude, radians; unknown = upright) only widens Charcoal: the side of the stick.
 */
export function nibWidth(nib: NibId, S: number, p: number, vn: number, device: Device, alt = PI / 2): number {
  const q = p === p ? clamp01(p) : 0.6;
  let w: number;
  switch (nib) {
    case 'pen': w = S * (0.72 + 0.38 * q); break;
    case 'brush':
      // p^1.5 without pow; the speed term applies to pens only (mouse/finger p already encodes speed)
      w = S * (0.14 + q * Math.sqrt(q)) * (device === 'pen' && vn === vn ? 1 - 0.25 * smoothstep(1, 3, vn) : 1);
      break;
    case 'chisel': w = S * (0.6 + 0.4 * q); break;
    default: w = S * (0.7 + 0.5 * q) * (alt === alt ? 1 + CHARCOAL_LEAN * smoothstep(60 * DEG, 25 * DEG, alt) : 1); break;
  }
  return device === 'touch' ? w * FINGER_WIDTH : w;
}

const CHISEL_DEFAULT = 40 * DEG;

/**
 * Chisel nib angle in screen radians: azimuth when altitude < 60°, else 40°.
 * Decision: a hard switch at 60° would make the edge snap mid-stroke as the
 * altitude hovers near the threshold, so the two are crossfaded over 55°–65°
 * (along the shorter way round, modulo π since an edge has no direction).
 * The result is normalised to [0, π).
 */
export function chiselAngle(alt: number, az: number): number {
  const a = alt === alt ? alt : PI / 2;
  const k = az === az ? smoothstep(65 * DEG, 55 * DEG, a) : 0;
  let th = CHISEL_DEFAULT;
  if (k > 0) {
    // shortest signed difference between the two edge orientations, modulo π
    let d = (az - CHISEL_DEFAULT) % PI;
    if (d > PI / 2) d -= PI; else if (d < -PI / 2) d += PI;
    th = CHISEL_DEFAULT + d * k;
  }
  th %= PI;
  return th < 0 ? th + PI : th;
}

/**
 * Brush dry-split weight 0..1 (0 = solid ribbon). Applies where v_n > 1.3 and
 * p < 0.5, crossfaded over smoothstep(1.1, 1.5, v_n); decision: the pressure
 * gate is crossfaded too (0.55 → 0.45) so strands never pop in or out.
 * Device-independent: mouse/finger pressure is speed-derived, so fast strokes split.
 */
export function drySplit(nib: NibId, vn: number, p: number, device: Device): number {
  if (nib !== 'brush') return 0;
  const k = smoothstep(1.1, 1.5, vn) * smoothstep(0.55, 0.45, p);
  return k === k ? k : 0;
}

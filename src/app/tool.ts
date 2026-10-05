/**
 * Tool state (DESIGN §2.5, §3.4): the nib, its size, the ink, the Form and its base depth.
 * Pure data with helpers; persisted in prefs (`rise:tool`) and never in history.
 *
 * First-run defaults (DESIGN §1.4): Night, Brush, Moss, Sprout at base 2.
 */
import type { ColorStyle, FormId, InkId, LCh, NibId, ToolState } from '../core/types';
import { INK_ORDER, P0_FORMS, P0_NIBS } from '../core/types';
import { NIBS } from '../ink/nibs';
import { FORMS } from '../ink/operators/registry';
import { prefs } from '../persist/prefs';

const TOOL_KEY = 'tool';

/** Fresh tool state (first run). */
export function defaultTool(): ToolState {
  return {
    nib: 'brush', lastNib: 'brush',
    sizes: { pen: NIBS.pen.S, brush: NIBS.brush.S, chisel: NIBS.chisel.S, charcoal: NIBS.charcoal.S },
    ink: 'moss', custom: null, recents: [],
    form: 'sprout',
    base: { line: FORMS.line.baseDefault, echo: FORMS.echo.baseDefault, sprout: FORMS.sprout.baseDefault, drift: FORMS.drift.baseDefault, ripple: FORMS.ripple.baseDefault },
    mode: 'draw',
    mirror: null,
  };
}

/** Clamp a size into its nib's range (NaN: the nib's default). */
export function clampSize(nib: NibId, s: number): number {
  const d = NIBS[nib];
  if (!(s === s)) return d.S;
  return s < d.min ? d.min : s > d.max ? d.max : s;
}

/** Quantise a base depth to quarter levels inside the Form's range. */
export function clampBase(form: FormId, b: number): number {
  const q = Math.round((b === b ? b : FORMS[form].baseDefault) * 4) / 4;
  const max = FORMS[form].dMax;
  return q < 0 ? 0 : q > max ? max : q;
}

const isLch = (v: unknown): v is LCh =>
  Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x));
const isCustom = (v: unknown): v is NonNullable<ColorStyle['lch']> =>
  !!v && typeof v === 'object' && isLch((v as { night?: unknown }).night) && isLch((v as { paper?: unknown }).paper);

function validColor(v: unknown): ColorStyle | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<ColorStyle>;
  const ink = c.ink;
  if (typeof ink !== 'string' || !(INK_ORDER as readonly string[]).concat('custom').includes(ink)) return null;
  const lch = c.lch === null || c.lch === undefined ? null : isCustom(c.lch) ? c.lch : undefined;
  if (lch === undefined || (ink === 'custom' && !lch)) return null;
  return { ink: ink as InkId, k: Number(c.k) || 0, dh: Number(c.dh) || 0, dL: Number(c.dL) || 0, lch };
}

/** The persisted tool state (validated field by field; anything odd falls back to the default). */
export function loadTool(): ToolState {
  const t = defaultTool();
  const v = prefs.get<Record<string, unknown> | null>(TOOL_KEY, null);
  if (!v || typeof v !== 'object') return t;
  const nib = v.nib as NibId;
  if ((P0_NIBS as readonly string[]).includes(nib)) t.nib = nib;
  const last = v.lastNib as NibId;
  t.lastNib = (P0_NIBS as readonly string[]).includes(last) ? last : t.nib;
  const sizes = v.sizes as Record<string, unknown> | undefined;
  if (sizes && typeof sizes === 'object') {
    for (const k of Object.keys(t.sizes) as NibId[]) {
      const s = Number(sizes[k]);
      if (Number.isFinite(s)) t.sizes[k] = clampSize(k, s);
    }
  }
  const custom = isCustom(v.custom) ? v.custom : null;
  const ink = v.ink as InkId;
  if ((INK_ORDER as readonly string[]).includes(ink)) t.ink = ink;
  else if (ink === 'custom' && custom) { t.ink = 'custom'; t.custom = custom; }
  if (Array.isArray(v.recents)) t.recents = v.recents.map(validColor).filter((c): c is ColorStyle => !!c).slice(0, 2);
  const form = v.form as FormId;
  if ((P0_FORMS as readonly string[]).includes(form)) t.form = form;
  const base = v.base as Record<string, unknown> | undefined;
  if (base && typeof base === 'object') {
    for (const k of Object.keys(t.base) as FormId[]) {
      const b = Number(base[k]);
      if (Number.isFinite(b)) t.base[k] = clampBase(k, b);
    }
  }
  return t;
}

/** Persist the tool (mode is session-only: a reload always starts drawing). */
export function saveTool(t: ToolState): void {
  prefs.set(TOOL_KEY, {
    nib: t.nib, lastNib: t.lastNib, sizes: t.sizes, ink: t.ink, custom: t.custom,
    recents: t.recents, form: t.form, base: t.base,
  });
}

/** The colour style the tool would draw with (variant fields neutral). */
export function toolColor(t: ToolState): ColorStyle {
  return { ink: t.ink, k: 0, dh: 0, dL: 0, lch: t.ink === 'custom' ? t.custom : null };
}

/** Next / previous P0 nib (never cycles into Erase). */
export function cycleNib(n: NibId, dir: 1 | -1): NibId {
  const i = P0_NIBS.indexOf(n);
  const k = ((i < 0 ? 0 : i) + dir + P0_NIBS.length) % P0_NIBS.length;
  return P0_NIBS[k];
}

/** Next / previous stock ink (a custom ink steps from Graphite's end). */
export function cycleInk(ink: InkId, dir: 1 | -1): InkId {
  const i = INK_ORDER.indexOf(ink);
  const k = i < 0 ? (dir > 0 ? 0 : INK_ORDER.length - 1) : (i + dir + INK_ORDER.length) % INK_ORDER.length;
  return INK_ORDER[k];
}

/** Two custom colours are the same ink. */
export function sameCustom(a: ColorStyle['lch'], b: ColorStyle['lch']): boolean {
  if (!a || !b) return a === b;
  for (const g of ['night', 'paper'] as const) for (let i = 0; i < 3; i++) if (Math.abs(a[g][i] - b[g][i]) > 1e-6) return false;
  return true;
}

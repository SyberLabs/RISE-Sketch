/**
 * Ink colour: the seven designed inks, their Night/Paper tone ramps, variants, custom inks
 * and the resolved per-stroke colour tables. Spec: docs/DESIGN.md §2.4.
 *
 * Colour is presentation (DESIGN §7.5 rule 4): it never feeds geometry, ids or sceneHash, so
 * this module is exempt from the Math allow-list. Custom inks are stored as LCh numbers in the
 * recipe and never re-derived.
 *
 * Every ink is a designed PAIR: the Night colour is light that adds ('lighter'), the Paper colour
 * is pigment that glazes ('multiply'). The same recipe renders on both grounds.
 */
import type { ColorStyle, Ground, InkDef, InkId, InkTable, LCh } from '../core/types';
import { gamutMap, lchToRgb255 } from '../core/oklab';
import { clamp, fract, wrapDeg } from '../core/num';

type StockInk = Exclude<InkId, 'custom'>;
type CustomLch = NonNullable<ColorStyle['lch']>;

/** The stock inks in sheet order (DESIGN §2.4.1). Spectral's hue is derived per stroke. */
export const INKS: Record<StockInk, InkDef> = {
  graphite: { id: 'graphite', name: 'Graphite', night: [0.90, 0.015, 250], paper: [0.30, 0.010, 255], band: 3, hd: 0, spectral: false },
  indigo: { id: 'indigo', name: 'Indigo', night: [0.74, 0.13, 262], paper: [0.42, 0.11, 238], band: 8, hd: -10, spectral: false },
  oxide: { id: 'oxide', name: 'Oxide', night: [0.78, 0.14, 55], paper: [0.52, 0.15, 35], band: 10, hd: -25, spectral: false },
  ochre: { id: 'ochre', name: 'Ochre', night: [0.88, 0.13, 88], paper: [0.82, 0.15, 92], band: 6, hd: -8, spectral: false },
  moss: { id: 'moss', name: 'Moss', night: [0.80, 0.12, 135], paper: [0.50, 0.10, 128], band: 12, hd: 25, spectral: false },
  rose: { id: 'rose', name: 'Rose', night: [0.72, 0.15, 10], paper: [0.48, 0.16, 15], band: 8, hd: -20, spectral: false },
  spectral: { id: 'spectral', name: 'Spectral', night: [0.76, 0.15, 0], paper: [0.64, 0.13, 0], band: 0, hd: 0, spectral: true },
};

/** Pressure buckets × depth buckets per stroke (tone = pBucket·5 + dBucket). */
export const TONES = 30;
/** Spectral hue buckets (10° steps). */
export const HUE_BUCKETS = 36;
/** Custom inks vary within ±3° (DESIGN §2.4.1). */
const CUSTOM_BAND = 3;
/** Legal custom-ink lightness per ground (chip drag clamp, twin clamp). */
const L_RANGE: Record<Ground, readonly [number, number]> = { night: [0.45, 0.95], paper: [0.25, 0.85] };
/** Paper safety: pigment never darker than this, so stacked glazes never reach black. */
const PAPER_MIN_L = 0.25;

/** Centre of pressure bucket pb (0..5). */
const pCentre = (pb: number): number => (pb + 0.5) / 6;

/**
 * Tone ramp (DESIGN §2.4.2) for base colour `b` on ground g at pressure p and depth d01.
 * `hd` is the hue shift with depth, `dh`/`dL` the variant offsets. Not gamut-mapped.
 */
function ramp(b: LCh, hd: number, dh: number, dL: number, g: Ground, p: number, d: number): [number, number, number] {
  const L0 = b[0], C0 = b[1];
  let L: number, C: number;
  if (g === 'night') {
    L = L0 - 0.20 * d - 0.08 * (1 - p) + dL;
    C = C0 * (0.75 + 0.25 * p) * (1 - 0.30 * d);
    L = clamp(L, 0, 1);
  } else {
    L = L0 + (0.93 - L0) * (0.45 * d + 0.25 * (1 - p)) + dL;
    C = C0 * (0.6 + 0.4 * p) * (1 - 0.45 * d);
    L = clamp(L, PAPER_MIN_L, 1);
  }
  return [L, Math.max(0, C), wrapDeg(b[2] + hd * d + dh)];
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const hexOf = (r: number, g: number, b: number): string => '#' + HEX[r] + HEX[g] + HEX[b];

/** Spectral base hue h_s of a stroke: 360·fract(0.618034·k), plus any explicit offset. */
function spectralHue(c: Pick<ColorStyle, 'k' | 'dh'>): number {
  return wrapDeg(360 * fract(0.618034 * (c.k || 0)) + (c.dh || 0));
}

/** Base LCh, hue shift with depth and variant offsets for a (non-spectral) colour style. */
function baseOf(c: Pick<ColorStyle, 'ink' | 'lch'> & Partial<ColorStyle>, g: Ground): { b: LCh; hd: number } {
  if (c.ink === 'custom') return { b: c.lch ? c.lch[g] : INKS.graphite[g], hd: 0 };
  const def = INKS[c.ink];
  return { b: def[g], hd: def.hd };
}

// ---------------------------------------------------------------------------- tables

const OP: Record<Ground, InkTable['op']> = { night: 'lighter', paper: 'multiply' };
const ALPHA_MAX: Record<Ground, number> = { night: 1, paper: 0.85 };

interface Built { css: string[]; rgb: Uint8Array }
const spectralBuilt: Partial<Record<Ground, Built>> = {};

/** The shared Spectral table for a ground: 36 hue buckets × 30 tones, index = bucket·30 + tone. */
function spectralTable(g: Ground): Built {
  let t = spectralBuilt[g];
  if (t) return t;
  const n = HUE_BUCKETS * TONES;
  const css = new Array<string>(n);
  const rgb = new Uint8Array(n * 3);
  const base = INKS.spectral[g];
  for (let hb = 0; hb < HUE_BUCKETS; hb++) {
    const b: LCh = [base[0], base[1], hb * 10];
    for (let tone = 0; tone < TONES; tone++) {
      const [r, gg, bb] = lchToRgb255(ramp(b, 0, 0, 0, g, pCentre((tone / 5) | 0), (tone % 5) / 4));
      const i = hb * TONES + tone;
      css[i] = hexOf(r, gg, bb);
      rgb[i * 3] = r; rgb[i * 3 + 1] = gg; rgb[i * 3 + 2] = bb;
    }
  }
  t = { css, rgb };
  spectralBuilt[g] = t;
  return t;
}

function buildTable(c: ColorStyle, g: Ground): InkTable {
  if (c.ink === 'spectral') {
    const t = spectralTable(g);
    return { css: t.css, rgb: t.rgb, op: OP[g], alphaMax: ALPHA_MAX[g], spectral: true, hs: spectralHue(c) };
  }
  const { b, hd } = baseOf(c, g);
  const css = new Array<string>(TONES);
  const rgb = new Uint8Array(TONES * 3);
  for (let tone = 0; tone < TONES; tone++) {
    const [r, gg, bb] = lchToRgb255(ramp(b, hd, c.dh || 0, c.dL || 0, g, pCentre((tone / 5) | 0), (tone % 5) / 4));
    css[tone] = hexOf(r, gg, bb);
    rgb[tone * 3] = r; rgb[tone * 3 + 1] = gg; rgb[tone * 3 + 2] = bb;
  }
  return { css, rgb, op: OP[g], alphaMax: ALPHA_MAX[g], spectral: false, hs: 0 };
}

const TABLE_CACHE_MAX = 512;
const tableCache = new Map<string, InkTable>();

function contentKey(c: ColorStyle, g: Ground): string {
  if (c.ink === 'spectral') return g + '|s|' + spectralHue(c);
  const l = c.ink === 'custom' && c.lch ? c.lch[g] : null;
  return g + '|' + c.ink + '|' + (c.dh || 0) + '|' + (c.dL || 0) + (l ? '|' + l[0] + ',' + l[1] + ',' + l[2] : '');
}

/**
 * Resolved colours for one stroke on one ground (30 entries; Spectral: the shared 36 × 30 table
 * plus this stroke's base hue). Cached by colour content, so equal styles share one table and no
 * colour string is ever built per frame.
 */
export function resolveInk(c: ColorStyle, g: Ground): InkTable {
  const key = contentKey(c, g);
  let t = tableCache.get(key);
  if (t) return t;
  t = buildTable(c, g);
  if (tableCache.size >= TABLE_CACHE_MAX) tableCache.delete(tableCache.keys().next().value as string);
  tableCache.set(key, t);
  return t;
}

/**
 * Table index of a poly. Non-spectral: the tone itself. Spectral: the hue rides absolute arc
 * length, h(s) = h_s + 0.2°·born + 60°·d01, bucketed to 10° (DESIGN §2.4.1).
 */
export function toneIndex(t: InkTable, tone: number, born: number): number {
  const tn = tone < 0 ? 0 : tone > TONES - 1 ? TONES - 1 : tone | 0;
  if (!t.spectral) return tn;
  const h = t.hs + 0.2 * (born === born ? born : 0) + 15 * (tn % 5);
  const hb = Math.round(wrapDeg(h) / 10) % HUE_BUCKETS;
  return hb * TONES + tn;
}

// ---------------------------------------------------------------------------- variants & custom inks

function sameLch(a: ColorStyle['lch'], b: ColorStyle['lch']): boolean {
  if (!a || !b) return a === b;
  for (const g of ['night', 'paper'] as const) {
    for (let i = 0; i < 3; i++) if (Math.abs(a[g][i] - b[g][i]) > 1e-6) return false;
  }
  return true;
}

/**
 * Colour style for a new stroke. `k` is the per-document, per-ink counter value; `lineage` is a
 * same-ink stroke found by the lineage test (its family is inherited verbatim). Decisions:
 * Spectral carries no dh/dL (its variant is the base hue h_s, so its table stays shared); a custom
 * ink inherits lineage only from a stroke with the same custom colours; 'custom' without colours
 * falls back to Graphite's pair as a custom ink.
 */
export function assignVariant(ink: InkId, k: number, lineage: ColorStyle | null, custom: ColorStyle['lch']): ColorStyle {
  const lch = ink === 'custom' ? (custom ?? customFromLch(INKS.graphite.night, 'night')) : null;
  if (lineage && lineage.ink === ink && (ink !== 'custom' || sameLch(lineage.lch, lch))) {
    return { ink, k: lineage.k, dh: lineage.dh, dL: lineage.dL, lch: ink === 'custom' ? lineage.lch : null };
  }
  if (ink === 'spectral') return { ink, k, dh: 0, dL: 0, lch: null };
  const band = ink === 'custom' ? CUSTOM_BAND : INKS[ink].band;
  const phi = fract(0.5 + 0.618034 * k) - 0.5;
  const dh = 2 * band * phi;
  const dL = 0.06 * (fract(0.5 + 0.381966 * k) - 0.5);
  return { ink, k, dh, dL, lch };
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Custom ink from a colour picked on ground g; derives the other ground's twin (DESIGN §2.4.1):
 * L' = clamp(1.02 − L, 0.25, 0.85), same hue, C ×1.1, gamut-mapped. Decision: the twin is also
 * clamped into its own ground's legal range (Night [0.45, 0.95], Paper [0.25, 0.85]) so a Paper
 * pick never yields an invisible Night twin. Values are rounded (L, C to 1e-4, h to 0.01°) so
 * stored recipes stay tidy.
 */
export function customFromLch(lch: LCh, g: Ground): CustomLch {
  const picked = gamutMap([clamp(lch[0], 0, 1), Math.max(0, lch[1]), wrapDeg(lch[2])]);
  const other: Ground = g === 'night' ? 'paper' : 'night';
  const [lo, hi] = L_RANGE[other];
  const L2 = clamp(clamp(1.02 - picked[0], 0.25, 0.85), lo, hi);
  const twin = gamutMap([L2, picked[1] * 1.1, picked[2]]);
  const a: LCh = [r4(picked[0]), r4(picked[1]), r2(picked[2])];
  const b: LCh = [r4(twin[0]), r4(twin[1]), r2(twin[2])];
  return g === 'night' ? { night: a, paper: b } : { night: b, paper: a };
}

/** The colour a style is "centred on" for ground g (variant offsets applied, depth/pressure not). */
function styleCentre(c: Pick<ColorStyle, 'ink' | 'lch'> & Partial<ColorStyle>, g: Ground): LCh {
  if (c.ink === 'spectral') {
    const b = INKS.spectral[g];
    return [b[0], b[1], spectralHue({ k: c.k ?? 0, dh: c.dh ?? 0 })];
  }
  const { b } = baseOf(c, g);
  return [b[0] + (c.dL ?? 0), b[1], wrapDeg(b[2] + (c.dh ?? 0))];
}

/**
 * Colour chip drag: bend a base ink by dh (degrees) and dL on ground g into custom colours.
 * Once the hue scrub exceeds the 6 px dead zone (|dh| > 4.5° at 0.75°/px) chroma is raised to at
 * least 0.10, so scrubbing from Graphite gains colour. L is clamped to the ground's legal range.
 */
export function bendColor(base: ColorStyle, dh: number, dL: number, g: Ground): CustomLch {
  const c0 = styleCentre(base, g);
  const C = Math.abs(dh) > 4.5 ? Math.max(c0[1], 0.10) : c0[1];
  const [lo, hi] = L_RANGE[g];
  return customFromLch([clamp(c0[0] + dL, lo, hi), C, wrapDeg(c0[2] + dh)], g);
}

/** A representative swatch colour (UI chips, cursor, halo). p/d default to 0.7 / 0. */
export function swatchCss(c: Pick<ColorStyle, 'ink' | 'lch'> & Partial<ColorStyle>, g: Ground, p = 0.7, d = 0): string {
  let L: number, C: number, h: number;
  if (c.ink === 'spectral') {
    const b = INKS.spectral[g];
    [L, C, h] = ramp([b[0], b[1], spectralHue({ k: c.k ?? 0, dh: c.dh ?? 0 })], 60, 0, 0, g, p, d);
  } else {
    const { b, hd } = baseOf(c, g);
    [L, C, h] = ramp(b, hd, c.dh ?? 0, c.dL ?? 0, g, p, d);
  }
  const [r, gg, bb] = lchToRgb255([L, C, h]);
  return hexOf(r, gg, bb);
}

/**
 * Resolved (gamut-mapped) colour of one poly, exactly as the table draws it (Spectral hue is the
 * bucketed hue). Used by Alt-click sampling.
 */
export function lchAt(c: ColorStyle, g: Ground, tone: number, born: number): LCh {
  const tn = clamp(tone | 0, 0, TONES - 1);
  const p = pCentre((tn / 5) | 0), d = (tn % 5) / 4;
  if (c.ink === 'spectral') {
    const t = resolveInk(c, g);
    const hb = Math.floor(toneIndex(t, tn, born) / TONES);
    const b = INKS.spectral[g];
    return gamutMap(ramp([b[0], b[1], hb * 10], 0, 0, 0, g, p, d));
  }
  const { b, hd } = baseOf(c, g);
  return gamutMap(ramp(b, hd, c.dh || 0, c.dL || 0, g, p, d));
}

// ---------------------------------------------------------------------------- ground tokens

const hexL = (L: number, C: number, h: number): string => {
  const [r, g, b] = lchToRgb255([L, C, h]);
  return hexOf(r, g, b);
};
const rgbaL = (L: number, C: number, h: number, a: number): string => {
  const [r, g, b] = lchToRgb255([L, C, h]);
  return `rgba(${r},${g},${b},${a})`;
};

/**
 * UI colour tokens per ground. `bg` is the ground's centre colour (DESIGN §6.1); `ui` is the dock
 * and sheet backing (ground at 86%); text ≥ 4.5:1 and control edges ≥ 3:1 against `bg` (§10).
 */
export const GROUND_TOKENS: Record<Ground, { bg: string; ui: string; uiBorder: string; text: string; textDim: string; accent: string; focus: string }> = {
  night: {
    bg: hexL(0.165, 0.012, 265),
    ui: rgbaL(0.19, 0.014, 265, 0.86),
    uiBorder: hexL(0.52, 0.02, 265),
    text: hexL(0.93, 0.01, 265),
    textDim: hexL(0.72, 0.015, 265),
    accent: hexL(0.80, 0.10, 255),
    focus: '#8fb3ff',
  },
  paper: {
    bg: hexL(0.955, 0.012, 85),
    ui: rgbaL(0.965, 0.010, 85, 0.86),
    uiBorder: hexL(0.56, 0.015, 85),
    text: hexL(0.25, 0.01, 85),
    textDim: hexL(0.45, 0.012, 85),
    accent: hexL(0.45, 0.14, 262),
    focus: '#2747a8',
  },
};

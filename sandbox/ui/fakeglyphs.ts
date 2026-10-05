/**
 * Sandbox-only fake Glyphs: paints plausible strokes for chips, sheet tiles and thumbnails with
 * Canvas2D, so the UI can be judged visually before render/glyphs.ts exists. Not product code.
 */
import type { ColorStyle, Ground, InkId, NibId, StrokeRecipe, ToolState } from '../../src/core/types';
import type { Glyphs, TileOption } from '../../src/render/types';
import { lchToCss } from '../../src/core/oklab';

type LCh = readonly [number, number, number];
const INKS: Record<Exclude<InkId, 'custom'>, { night: LCh; paper: LCh }> = {
  graphite: { night: [0.9, 0.015, 250], paper: [0.3, 0.01, 255] },
  indigo: { night: [0.74, 0.13, 262], paper: [0.42, 0.11, 238] },
  oxide: { night: [0.78, 0.14, 55], paper: [0.52, 0.15, 35] },
  ochre: { night: [0.88, 0.13, 88], paper: [0.82, 0.15, 92] },
  moss: { night: [0.8, 0.12, 135], paper: [0.5, 0.1, 128] },
  rose: { night: [0.72, 0.15, 10], paper: [0.48, 0.16, 15] },
  spectral: { night: [0.76, 0.15, 200], paper: [0.64, 0.13, 200] },
};
export const GROUND_BG: Record<Ground, string> = { night: '#0c0e14', paper: '#f4f0e7' };

function inkLch(ink: InkId, custom: ColorStyle['lch'] | undefined, g: Ground): LCh {
  if (ink === 'custom') return custom ? custom[g] : INKS.graphite[g];
  return INKS[ink][g];
}
/** Ink colour at depth fraction d (0..1), pressure p. */
export function inkCss(ink: InkId, custom: ColorStyle['lch'] | undefined, g: Ground, d = 0, p = 0.7, hueAt = 0): string {
  const [L0, C0, h0] = inkLch(ink, custom, g);
  const h = ink === 'spectral' ? (h0 + hueAt) % 360 : h0 + 20 * d;
  if (g === 'night') return lchToCss([L0 - 0.2 * d - 0.08 * (1 - p), C0 * (0.75 + 0.25 * p) * (1 - 0.3 * d), h]);
  return lchToCss([L0 + (0.93 - L0) * (0.45 * d + 0.25 * (1 - p)), C0 * (0.6 + 0.4 * p) * (1 - 0.45 * d), h]);
}

type Pt = [number, number];
function squiggle(w: number, h: number, n = 48, amp = 0.22, x0 = 0.12, x1 = 0.88, phase = 0): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([w * (x0 + (x1 - x0) * t), h * (0.55 + amp * Math.sin(t * Math.PI * 2 * 0.9 + phase) - 0.08 * Math.sin(t * Math.PI * 5))]);
  }
  return out;
}
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function ribbon(g: CanvasRenderingContext2D, pts: Pt[], width: (t: number) => number, css: string | ((t: number) => string)): void {
  // One stroke merges with itself (like a batch); strokes still add / glaze with each other.
  const op = g.globalCompositeOperation;
  g.globalCompositeOperation = 'source-over';
  ribbonInner(g, pts, width, css);
  g.globalCompositeOperation = op;
}
function ribbonInner(g: CanvasRenderingContext2D, pts: Pt[], width: (t: number) => number, css: string | ((t: number) => string)): void {
  for (let i = 1; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    g.strokeStyle = typeof css === 'string' ? css : css(t);
    g.lineWidth = Math.max(0.6, width(t));
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(pts[i - 1][0], pts[i - 1][1]);
    g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
  }
}
const taper = (t: number): number => Math.min(1, t / 0.18) * Math.pow(Math.min(1, (1 - t) / 0.3), 0.6);

function nibStroke(g: CanvasRenderingContext2D, pts: Pt[], nib: NibId, size: number, css: string | ((t: number) => string), scale: number): void {
  const S = size * scale;
  if (nib === 'pen') ribbon(g, pts, t => S * 0.95 * (0.35 + 0.65 * taper(t)), css);
  else if (nib === 'brush') ribbon(g, pts, t => S * (0.14 + Math.pow(0.35 + 0.6 * Math.sin(t * Math.PI), 1.5)) * taper(t), css);
  else {
    const a = (40 * Math.PI) / 180;
    const ex = Math.cos(a) * S * 0.5, ey = Math.sin(a) * S * 0.5;
    g.fillStyle = typeof css === 'string' ? css : css(0.5);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      g.beginPath();
      g.moveTo(x0 - ex, y0 - ey); g.lineTo(x0 + ex, y0 + ey); g.lineTo(x1 + ex, y1 + ey); g.lineTo(x1 - ex, y1 - ey);
      g.closePath(); g.fill();
    }
  }
}

function grow(g: CanvasRenderingContext2D, pts: Pt[], form: string, depth: number, css: (d: number) => string, unit: number, seed = 7): void {
  const r = rng(seed);
  const d = Math.max(0, depth);
  if (form === 'line') {
    if (d <= 0) return;
    const out: Pt[] = pts.map(([x, y], i) => [x + (r() - 0.5) * d * unit * 0.6, y + (r() - 0.5) * d * unit * 0.9 * Math.sin(i * 0.9)]);
    ribbon(g, out, () => unit * 0.35, css(0.3));
  } else if (form === 'echo') {
    if (d <= 0) return;
    const koch = (a: Pt, b: Pt, k: number): void => {
      if (k === 0) { g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); return; }
      const dx = (b[0] - a[0]) / 3, dy = (b[1] - a[1]) / 3;
      const p1: Pt = [a[0] + dx, a[1] + dy], p3: Pt = [a[0] + 2 * dx, a[1] + 2 * dy];
      const p2: Pt = [p1[0] + dx * 0.5 + dy * 0.87, p1[1] + dy * 0.5 - dx * 0.87];
      koch(a, p1, k - 1); koch(p1, p2, k - 1); koch(p2, p3, k - 1); koch(p3, b, k - 1);
    };
    g.lineWidth = Math.max(0.6, unit * 0.3);
    g.strokeStyle = css(0.4);
    const step = Math.max(1, Math.floor(pts.length / 5));
    for (let i = step; i < pts.length; i += step) koch(pts[i - step], pts[i], Math.min(3, Math.ceil(d)));
  } else if (form === 'sprout') {
    if (d <= 0) return;
    const branch = (x: number, y: number, ang: number, len: number, gen: number): void => {
      if (gen > Math.min(3, d) || len < 1.5) return;
      const steps = 6;
      let cx = x, cy = y, a = ang;
      g.strokeStyle = css(Math.min(1, gen / 4));
      g.lineWidth = Math.max(0.5, unit * 0.55 * Math.pow(0.66, gen));
      g.beginPath(); g.moveTo(cx, cy);
      for (let s = 0; s < steps; s++) {
        a += (-Math.PI / 2 - a) * 0.06;
        cx += Math.cos(a) * len / steps; cy += Math.sin(a) * len / steps;
        g.lineTo(cx, cy);
      }
      g.stroke();
      branch(cx - Math.cos(a) * len * 0.4, cy - Math.sin(a) * len * 0.4, a + 0.6, len * 0.55, gen + 1);
      branch(cx - Math.cos(a) * len * 0.15, cy - Math.sin(a) * len * 0.15, a - 0.55, len * 0.5, gen + 1);
    };
    for (let i = 4; i < pts.length - 2; i += 7) {
      const [x, y] = pts[i], [x2, y2] = pts[i + 1];
      const tang = Math.atan2(y2 - y, x2 - x);
      const side = i % 14 < 7 ? -1 : 1;
      branch(x, y, tang + side * 1.2 - 0.4, unit * (5 + 2 * d) * (0.7 + 0.5 * r()), 1);
    }
  } else if (form === 'drift') {
    if (d <= 0) return;
    for (let i = 2; i < pts.length; i += 3) {
      let [x, y] = pts[i];
      const n = Math.round(6 + 7 * d);
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < n; k++) {
        const a = Math.sin(x * 0.07 + y * 0.03) * 2.2 + Math.cos(y * 0.06) * 1.3;
        x += Math.cos(a) * unit * 0.9; y += Math.sin(a) * unit * 0.9;
        g.lineTo(x, y);
      }
      g.strokeStyle = css(0.5);
      g.globalAlpha = 0.5;
      g.lineWidth = Math.max(0.5, unit * 0.3);
      g.stroke();
      g.globalAlpha = 1;
    }
  }
}

const FORM_DMAX: Record<string, number> = { line: 5, echo: 5, sprout: 4, drift: 6, ripple: 6 };

function begin(c: HTMLCanvasElement, ground: Ground, fill: boolean): CanvasRenderingContext2D {
  const g = c.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, c.width, c.height);
  if (fill) { g.fillStyle = GROUND_BG[ground]; g.fillRect(0, 0, c.width, c.height); }
  g.globalCompositeOperation = ground === 'night' ? 'lighter' : 'multiply';
  return g;
}

export function createFakeGlyphs(): Glyphs & { calls: number } {
  const api = {
    calls: 0,
    chip(canvas: HTMLCanvasElement, which: 'stroke' | 'color' | 'form', tool: ToolState, ground: Ground, erase: boolean): void {
      api.calls++;
      const g = begin(canvas, ground, false);
      const w = canvas.width, h = canvas.height, u = w / 40;
      const ink = (d = 0, p = 0.75, t = 0) => inkCss(tool.ink, tool.custom, ground, d, p, t * 140);
      if (which === 'stroke') {
        if (erase) {
          g.globalCompositeOperation = 'source-over';
          g.translate(w / 2, h / 2); g.rotate(-0.6);
          g.strokeStyle = ground === 'night' ? '#e4e8ef' : '#24211c';
          g.lineWidth = 1.6 * u;
          g.beginPath(); g.roundRect(-10 * u, -5 * u, 20 * u, 10 * u, 2.5 * u); g.stroke();
          g.beginPath(); g.moveTo(-2 * u, -5 * u); g.lineTo(-2 * u, 5 * u); g.stroke();
          return;
        }
        const S = tool.sizes[tool.nib];
        const pts = squiggle(w, h, 40, 0.2, 0.14, 0.86);
        nibStroke(g, pts, tool.nib, Math.max(1.2, Math.min(9, Math.sqrt(S) * 2.1)), t => ink(0, 0.4 + 0.6 * Math.sin(t * Math.PI), t), u);
      } else if (which === 'color') {
        const pts = squiggle(w, h, 30, 0.08, 0.16, 0.84);
        ribbon(g, pts, t => 9 * u * (0.55 + 0.45 * Math.sin(t * Math.PI)), t => ink(t * 0.9, 1 - t * 0.5, t));
      } else {
        const pts = squiggle(w, h, 30, 0.16, 0.12, 0.88, 0.4);
        const base = tool.base[tool.form];
        ribbon(g, pts, () => 1.6 * u, ink());
        grow(g, pts, tool.form, Math.min(base, 3) * (4 / FORM_DMAX[tool.form]) + (base > 0 ? 0.6 : 0), d => ink(d), u * 0.9);
      }
    },
    tile(canvas: HTMLCanvasElement, opt: TileOption, _last: StrokeRecipe | null, tool: ToolState, ground: Ground): void {
      api.calls++;
      const g = begin(canvas, ground, true);
      const w = canvas.width, h = canvas.height, u = h / 60;
      const pts = squiggle(w, h, 56, 0.2);
      if (opt.k === 'nib') {
        nibStroke(g, pts, opt.nib, Math.min(tool.sizes[opt.nib], 18), t => inkCss(tool.ink, tool.custom, ground, 0, 0.4 + 0.6 * Math.sin(t * Math.PI), t * 160), u);
      } else if (opt.k === 'erase') {
        ribbon(g, pts, () => 3 * u, inkCss(tool.ink, tool.custom, ground, 0.6, 0.3));
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = GROUND_BG[ground];
        g.globalAlpha = 0.75;
        g.fillRect(w * 0.5, 0, w * 0.5, h);
        g.globalAlpha = 1;
        g.strokeStyle = ground === 'night' ? 'rgba(228,232,239,.9)' : 'rgba(36,33,28,.9)';
        g.lineWidth = 1.5 * u;
        g.beginPath(); g.arc(w * 0.5, h * 0.52, 11 * u, 0, Math.PI * 2); g.stroke();
      } else if (opt.k === 'ink') {
        const c = opt.custom;
        const ink = c ? c.ink : opt.ink;
        const lch = c ? c.lch : null;
        ribbon(g, pts, t => 7 * u * (0.25 + Math.sin(t * Math.PI)) * taper(t), t => inkCss(ink, lch, ground, 0, 0.5 + 0.5 * Math.sin(t * Math.PI), t * 220));
        grow(g, pts, 'sprout', 1.6, d => inkCss(ink, lch, ground, d, 0.7, 60), u, 11);
      } else {
        ribbon(g, pts, t => 2.6 * u * (0.3 + 0.7 * taper(t)), inkCss(tool.ink, tool.custom, ground));
        grow(g, pts, opt.form, Math.max(1.2, tool.base[opt.form] || 2), d => inkCss(tool.ink, tool.custom, ground, d), u, 3);
      }
    },
    thumb(canvas: HTMLCanvasElement, _recipes: readonly StrokeRecipe[], ground: Ground): void {
      api.calls++;
      paintThumb(canvas, ground, 5);
    },
  };
  return api;
}

/** A small document-like picture (Recent thumbnails, sandbox stage). */
export function paintThumb(canvas: HTMLCanvasElement, ground: Ground, seed: number): void {
  const g = begin(canvas, ground, true);
  const w = canvas.width, h = canvas.height, r = rng(seed);
  const inks: InkId[] = ['moss', 'indigo', 'oxide', 'rose', 'ochre'];
  for (let k = 0; k < 3; k++) {
    const ink = inks[Math.floor(r() * inks.length)];
    const pts = squiggle(w, h, 40, 0.15 + r() * 0.15, 0.08 + r() * 0.2, 0.7 + r() * 0.25, r() * 6).map(([x, y]) => [x, y + (r() - 0.5) * h * 0.4] as Pt);
    ribbon(g, pts, t => (h / 40) * (0.5 + 2 * Math.sin(t * Math.PI)), inkCss(ink, null, ground, 0, 0.8));
    grow(g, pts, ['sprout', 'drift', 'echo', 'line'][k % 4], 2, d => inkCss(ink, null, ground, d), h / 50, seed + k);
  }
}

/** Fake committed ink across the stage so blur and contrast can be judged. */
export function paintStage(canvas: HTMLCanvasElement, ground: Ground, ink: boolean): void {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  const g = canvas.getContext('2d')!;
  const w = canvas.width, h = canvas.height;
  g.globalCompositeOperation = 'source-over';
  if (ground === 'night') {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
    grd.addColorStop(0, '#0c0e14'); grd.addColorStop(1, '#06080d');
    g.fillStyle = grd;
  } else {
    const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
    grd.addColorStop(0, '#f4f0e7'); grd.addColorStop(1, '#ede9e1');
    g.fillStyle = grd;
  }
  g.fillRect(0, 0, w, h);
  if (!ink) return;
  g.globalCompositeOperation = ground === 'night' ? 'lighter' : 'multiply';
  const u = dpr * 1.6;
  const strokes: [InkId, string, number, number, number, number][] = [
    ['moss', 'sprout', 0.12, 0.58, 0.62, 3],
    ['indigo', 'drift', 0.3, 0.88, 0.32, 2.5],
    ['oxide', 'echo', 0.55, 0.95, 0.78, 2],
    ['rose', 'line', 0.05, 0.4, 0.2, 3],
  ];
  strokes.forEach(([ink, form, x0, x1, y, d], k) => {
    const pts = squiggle(w, h * 0.5, 80, 0.25, x0, x1, k * 1.7).map(([x, yy]) => [x, yy + h * (y - 0.27)] as Pt);
    ribbon(g, pts, t => 5 * u * (0.3 + Math.sin(t * Math.PI)) * taper(t), t => inkCss(ink, null, ground, 0, 0.5 + 0.5 * Math.sin(t * Math.PI)));
    grow(g, pts, form, d, dd => inkCss(ink, null, ground, dd), u * 1.4, 21 + k);
  });
}

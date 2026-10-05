import { describe, it, expect } from 'vitest';
import type { ColorStyle, Ground, InkId } from '../src/core/types';
import { INK_ORDER } from '../src/core/types';
import {
  INKS, TONES, HUE_BUCKETS, resolveInk, toneIndex, assignVariant, customFromLch, bendColor, swatchCss, lchAt, GROUND_TOKENS,
} from '../src/ink/color';
import { hexToLch, lchToRgb255, relLuminance } from '../src/core/oklab';

const GROUNDS: Ground[] = ['night', 'paper'];
const style = (ink: InkId, k = 0): ColorStyle => assignVariant(ink, k, null, null);
const rgbOf = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const contrast = (a: string, b: string): number => {
  const la = relLuminance(rgbOf(a)), lb = relLuminance(rgbOf(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

describe('color: ink definitions', () => {
  it('seven stock inks in sheet order, each a Night/Paper pair', () => {
    expect(Object.keys(INKS)).toEqual(INK_ORDER);
    for (const id of INK_ORDER) {
      const d = INKS[id as Exclude<InkId, 'custom'>];
      expect(d.id).toBe(id);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.paper[0]).toBeGreaterThanOrEqual(0.25);
    }
    expect(INKS.spectral.spectral).toBe(true);
    expect(INKS.moss.hd).toBe(25);
  });
});

describe('color: resolved tables', () => {
  it('30 valid hex entries per stroke and ground, rgb bytes match css', () => {
    for (const g of GROUNDS) for (const id of INK_ORDER.filter(i => i !== 'spectral')) {
      const t = resolveInk(style(id, 3), g);
      expect(t.css.length).toBe(TONES);
      expect(t.rgb.length).toBe(TONES * 3);
      t.css.forEach((c, i) => {
        expect(c).toMatch(/^#[0-9a-f]{6}$/);
        expect(rgbOf(c)).toEqual([t.rgb[3 * i], t.rgb[3 * i + 1], t.rgb[3 * i + 2]]);
      });
      expect(t.op).toBe(g === 'night' ? 'lighter' : 'multiply');
      expect(t.alphaMax).toBe(g === 'night' ? 1 : 0.85);
      expect(t.spectral).toBe(false);
    }
  });

  it('every entry is inside sRGB (gamut-mapped by chroma, hue kept within a few degrees)', () => {
    for (const g of GROUNDS) for (const id of INK_ORDER.filter(i => i !== 'spectral' && i !== 'graphite')) {
      const t = resolveInk(style(id), g);
      const base = INKS[id as Exclude<InkId, 'custom'>][g];
      const lch = hexToLch(t.css[25])!;   // full pressure, depth 0
      let dh = Math.abs(lch[2] - base[2]); if (dh > 180) dh = 360 - dh;
      expect(dh).toBeLessThan(6);
    }
  });

  it('ramps: Night darkens and desaturates with depth; Paper pales toward the paper; pressure enriches', () => {
    for (const id of ['indigo', 'oxide', 'moss', 'rose'] as const) {
      const n = resolveInk(style(id), 'night'), p = resolveInk(style(id), 'paper');
      const L = (hex: string) => hexToLch(hex)![0], C = (hex: string) => hexToLch(hex)![1];
      for (let d = 0; d < 4; d++) {
        expect(L(n.css[25 + d + 1])).toBeLessThan(L(n.css[25 + d]));
        expect(L(p.css[25 + d + 1])).toBeGreaterThan(L(p.css[25 + d]));
      }
      expect(C(n.css[25])).toBeGreaterThan(C(n.css[0]));     // pressure bucket 5 vs 0 at depth 0
      expect(L(p.css[25])).toBeLessThan(L(p.css[0]));        // heavier pigment is darker on Paper
    }
  });

  it('golden ramp values (locks the tone formulas to ≤ 1/255)', () => {
    const golden: [InkId, Ground, number, string][] = [
      ['indigo', 'night', 25, '#7ca8f9'], ['indigo', 'night', 29, '#45709f'], ['indigo', 'paper', 25, '#00567e'],
      ['oxide', 'paper', 25, '#af452a'], ['moss', 'night', 25, '#9bcd7f'], ['moss', 'night', 29, '#4f8d6d'],
      ['ochre', 'paper', 25, '#e7c144'], ['rose', 'night', 0, '#ca6f7e'], ['graphite', 'night', 25, '#d5dde5'],
      ['graphite', 'paper', 25, '#2e3136'],
    ];
    for (const [ink, g, tone, hex] of golden) {
      const got = rgbOf(resolveInk(style(ink), g).css[tone]), want = rgbOf(hex);
      for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(1);
    }
  });

  it('Paper safety: no Paper entry is darker than L 0.25 (before gamut rounding)', () => {
    for (const id of INK_ORDER) {
      const t = resolveInk(style(id as InkId, 5), 'paper');
      for (const c of t.css) expect(hexToLch(c)![0]).toBeGreaterThan(0.24);
    }
  });

  it('Indigo over Ochre on Paper glazes to a real green (hue 130–170)', () => {
    const a = rgbOf(swatchCss({ ink: 'indigo', lch: null }, 'paper'));
    const b = rgbOf(swatchCss({ ink: 'ochre', lch: null }, 'paper'));
    const mul = a.map((v, i) => Math.round((v * b[i]) / 255));
    const hex = '#' + mul.map(v => v.toString(16).padStart(2, '0')).join('');
    const h = hexToLch(hex)![2];
    expect(h).toBeGreaterThanOrEqual(130);
    expect(h).toBeLessThanOrEqual(170);
    // and with the real stroke alpha (0.85) composited over the paper ground
    const paper = rgbOf(GROUND_TOKENS.paper.bg);
    const glaze = (dst: number[], src: number[]) => dst.map((d, i) => d * (1 - 0.85 + 0.85 * (src[i] / 255)));
    const out = glaze(glaze(paper, b), a).map(v => Math.round(v));
    const h2 = hexToLch('#' + out.map(v => v.toString(16).padStart(2, '0')).join(''))![2];
    expect(h2).toBeGreaterThanOrEqual(130);
    expect(h2).toBeLessThanOrEqual(170);
  });

  it('equal colour styles share one cached table', () => {
    expect(resolveInk(style('moss', 4), 'night')).toBe(resolveInk(style('moss', 4), 'night'));
    expect(resolveInk(style('moss', 4), 'night')).not.toBe(resolveInk(style('moss', 5), 'night'));
  });
});

describe('color: spectral', () => {
  it('shared 36 × 30 table per ground; per-stroke base hue from k', () => {
    const a = resolveInk(style('spectral', 1), 'night'), b = resolveInk(style('spectral', 2), 'night');
    expect(a.css.length).toBe(HUE_BUCKETS * TONES);
    expect(a.css).toBe(b.css);
    expect(a.spectral).toBe(true);
    expect(a.hs).toBeCloseTo(360 * ((0.618034 * 1) % 1), 6);
    expect(b.hs).toBeCloseTo(360 * ((0.618034 * 2) % 1), 6);
  });

  it('hue rides absolute arc length (0.2°/sp) and depth (+60° at d01 = 1), in 10° buckets', () => {
    const t = { ...resolveInk(style('spectral', 0), 'night'), hs: 0 };
    expect(toneIndex(t, 25, 0)).toBe(0 * 30 + 25);
    expect(toneIndex(t, 25, 50)).toBe(1 * 30 + 25);           // +10°
    expect(toneIndex(t, 25, 24)).toBe(0 * 30 + 25);           // 4.8° rounds to bucket 0
    expect(toneIndex(t, 25, 26)).toBe(1 * 30 + 25);           // 5.2° rounds to bucket 1
    expect(toneIndex(t, 29, 0)).toBe(6 * 30 + 29);            // depth bucket 4: +60°
    expect(toneIndex(t, 25, 1800)).toBe(0 * 30 + 25);         // 360° wraps
    const t2 = { ...t, hs: 355 };
    expect(toneIndex(t2, 25, 0)).toBe(0 * 30 + 25);           // 355° rounds up to 360 ≡ 0
  });

  it('spectral entries really change hue bucket by bucket', () => {
    const t = resolveInk(style('spectral', 0), 'night');
    const h0 = hexToLch(t.css[0 * 30 + 25])![2], h9 = hexToLch(t.css[9 * 30 + 25])![2];
    let d = Math.abs(h9 - h0); if (d > 180) d = 360 - d;
    expect(d).toBeGreaterThan(60);
  });

  it('non-spectral toneIndex is the tone, clamped', () => {
    const t = resolveInk(style('oxide'), 'paper');
    expect(toneIndex(t, 17, 1234)).toBe(17);
    expect(toneIndex(t, 99, 0)).toBe(29);
    expect(toneIndex(t, -3, 0)).toBe(0);
  });
});

describe('color: variants and lineage', () => {
  it('variants are deterministic, within ±band, with golden-ratio spread', () => {
    const seen = new Set<string>();
    for (let k = 0; k < 40; k++) {
      const v = assignVariant('moss', k, null, null);
      expect(Math.abs(v.dh)).toBeLessThanOrEqual(12 + 1e-9);
      expect(Math.abs(v.dL)).toBeLessThanOrEqual(0.03 + 1e-9);
      expect(v).toEqual(assignVariant('moss', k, null, null));
      seen.add(v.dh.toFixed(3));
    }
    expect(seen.size).toBe(40);
    expect(assignVariant('moss', 0, null, null).dh).toBeCloseTo(0, 9);
  });

  it('lineage inherits k, dh, dL from a same-ink stroke only', () => {
    const parent = assignVariant('rose', 7, null, null);
    const child = assignVariant('rose', 12, parent, null);
    expect([child.k, child.dh, child.dL]).toEqual([parent.k, parent.dh, parent.dL]);
    const other = assignVariant('indigo', 12, parent, null);
    expect(other.k).toBe(12);
  });

  it('spectral: no dh/dL; custom: ±3° band, lineage only with the same colours', () => {
    const s = assignVariant('spectral', 9, null, null);
    expect([s.dh, s.dL]).toEqual([0, 0]);
    const lch = customFromLch([0.7, 0.12, 300], 'night');
    const c1 = assignVariant('custom', 3, null, lch);
    expect(c1.lch).toEqual(lch);
    expect(Math.abs(c1.dh)).toBeLessThanOrEqual(3);
    const lch2 = customFromLch([0.7, 0.12, 40], 'night');
    expect(assignVariant('custom', 4, c1, lch2).k).toBe(4);
    expect(assignVariant('custom', 4, c1, lch).k).toBe(3);
    expect(assignVariant('custom', 0, null, null).lch).not.toBeNull();
  });
});

describe('color: custom inks', () => {
  it('twin: L′ = clamp(1.02 − L, 0.25, 0.85), same hue, C ×1.1 (gamut-mapped)', () => {
    const c = customFromLch([0.62, 0.08, 200], 'night');
    expect(c.night[0]).toBeCloseTo(0.62, 4);
    expect(c.paper[0]).toBeCloseTo(0.40, 4);
    expect(c.paper[2]).toBeCloseTo(200, 1);
    expect(c.paper[1]).toBeLessThanOrEqual(0.088 + 1e-4);
    const p = customFromLch([0.3, 0.1, 30], 'paper');
    expect(p.paper[0]).toBeCloseTo(0.3, 4);
    expect(p.night[0]).toBeCloseTo(0.72, 4);
    const dark = customFromLch([0.9, 0.05, 90], 'paper');   // twin would be 0.25 → clamped into Night's range
    expect(dark.night[0]).toBeGreaterThanOrEqual(0.45);
  });

  it('custom inks resolve through their stored LCh', () => {
    const lch = customFromLch([0.75, 0.13, 300], 'night');
    const t = resolveInk(assignVariant('custom', 0, null, lch), 'night');
    const h = hexToLch(t.css[25])![2];
    expect(Math.abs(h - 300)).toBeLessThan(5);
  });

  it('bendColor: hue scrub past the dead zone gains chroma; L clamps per ground', () => {
    const g = bendColor(style('graphite'), 30, -0.2, 'night');
    expect(g.night[1]).toBeGreaterThanOrEqual(0.099);
    const light = bendColor(style('graphite'), 30, 0, 'night');   // L 0.90: chroma limited by sRGB, still gains
    expect(light.night[1]).toBeGreaterThan(0.03);
    const small = bendColor(style('graphite'), 3, 0, 'night');
    expect(small.night[1]).toBeLessThan(0.05);
    expect(bendColor(style('moss'), 0, 0.9, 'night').night[0]).toBeLessThanOrEqual(0.95);
    expect(bendColor(style('moss'), 0, -0.9, 'paper').paper[0]).toBeGreaterThanOrEqual(0.25);
    const ox = bendColor(style('oxide'), 20, 0, 'paper');
    expect(Math.abs(ox.paper[2] - 55)).toBeLessThan(1);
  });
});

describe('color: swatches, sampling, tokens', () => {
  it('swatchCss returns a hex colour and follows p/d', () => {
    const a = swatchCss({ ink: 'indigo', lch: null }, 'night');
    expect(a).toMatch(/^#[0-9a-f]{6}$/);
    expect(hexToLch(swatchCss({ ink: 'indigo', lch: null }, 'night', 0.7, 1))![0]).toBeLessThan(hexToLch(a)![0]);
  });

  it('lchAt is exactly the colour the table draws', () => {
    for (const s of [style('rose', 2), style('spectral', 5), assignVariant('custom', 1, null, customFromLch([0.6, 0.1, 250], 'paper'))]) {
      for (const g of GROUNDS) {
        const t = resolveInk(s, g);
        for (const [tone, born] of [[0, 0], [13, 77], [29, 400]]) {
          const rgb = lchToRgb255(lchAt(s, g, tone, born));
          const i = toneIndex(t, tone, born);
          for (let k = 0; k < 3; k++) expect(Math.abs(rgb[k] - t.rgb[3 * i + k])).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('ground tokens: text ≥ 4.5:1, control edges ≥ 3:1, focus rings from the spec', () => {
    for (const g of GROUNDS) {
      const T = GROUND_TOKENS[g];
      expect(contrast(T.text, T.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(T.textDim, T.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(T.uiBorder, T.bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(T.accent, T.bg)).toBeGreaterThanOrEqual(3);
    }
    expect(GROUND_TOKENS.night.focus).toBe('#8fb3ff');
    expect(GROUND_TOKENS.paper.focus).toBe('#2747a8');
    expect(hexToLch(GROUND_TOKENS.night.bg)![0]).toBeCloseTo(0.165, 2);
    expect(hexToLch(GROUND_TOKENS.paper.bg)![0]).toBeCloseTo(0.955, 2);
  });
});

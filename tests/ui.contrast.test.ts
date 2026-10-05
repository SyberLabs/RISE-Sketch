/**
 * DESIGN §10 visibility rules, checked on the tokens in src/styles.css: text ≥ 4.5:1 and control
 * edges ≥ 3:1 on both grounds. The dock / sheet backing is the ground at 86 %, so text is checked
 * against that surface composited over the worst ink beneath it (white light on Night, near-black
 * pigment on Paper) as well as over the bare ground. Focus rings use the spec's exact colours.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type RGBA = [number, number, number, number];
const css = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');

function tokens(ground: 'night' | 'paper'): Record<string, RGBA> {
  const re = new RegExp(`\\[data-ground="${ground}"\\][^{]*\\{([^}]*)\\}`, 'g');
  const out: Record<string, RGBA> = {};
  for (const m of css.matchAll(re)) {
    for (const d of m[1].matchAll(/--r-([a-z-]+):\s*([^;]+);/g)) {
      const c = parse(d[2].trim());
      if (c) out[d[1]] = c;
    }
  }
  return out;
}
function parse(v: string): RGBA | null {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(v);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  return null;
}
const over = (top: RGBA, under: RGBA): RGBA => {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
};
const lin = (c: number): number => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const lum = (c: RGBA): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a: RGBA, b: RGBA): number => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const WHITE: RGBA = [255, 255, 255, 1];
const BLACK: RGBA = [0, 0, 0, 1];

for (const ground of ['night', 'paper'] as const) {
  describe(`contrast on ${ground}`, () => {
    const t = tokens(ground);
    const worstInk = ground === 'night' ? WHITE : BLACK;
    const surfaces: [string, RGBA][] = [
      ['surface over the ground', over(t.surface, t.bg)],
      ['surface over the worst ink', over(t.surface, worstInk)],
    ];

    it('parses every token it checks', () => {
      for (const k of ['bg', 'surface', 'border', 'text', 'dim', 'accent', 'focus', 'warn', 'danger', 'well']) expect(t[k], k).toBeDefined();
      expect(t.surface[3]).toBeCloseTo(0.86, 5); // "the ground colour at 86 %"
    });
    it('text, dim text, accent, warning and danger text are ≥ 4.5:1 on every backing', () => {
      for (const [where, s] of surfaces) {
        for (const k of ['text', 'dim', 'accent', 'warn', 'danger']) {
          expect(ratio(t[k], s), `${k} on ${where}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
    it('control edges and state outlines are ≥ 3:1', () => {
      for (const [where, s] of surfaces) {
        expect(ratio(t.border, s), `border on ${where}`).toBeGreaterThanOrEqual(3);
        expect(ratio(t.accent, s), `accent outline on ${where}`).toBeGreaterThanOrEqual(3);
      }
      expect(ratio(t.text, t.well), 'selected tile outline on its well').toBeGreaterThanOrEqual(3);
      expect(ratio(t.focus, t.bg), 'focus ring on the ground').toBeGreaterThanOrEqual(3);
      expect(ratio(t.focus, over(t.surface, t.bg)), 'focus ring on a surface').toBeGreaterThanOrEqual(3);
    });
    it('inverted text (tooltip, switch thumb) is ≥ 4.5:1', () => {
      expect(ratio(t.bg, t.text)).toBeGreaterThanOrEqual(4.5);
    });
    it('focus rings use the spec colours', () => {
      const want = ground === 'night' ? [0x8f, 0xb3, 0xff] : [0x27, 0x47, 0xa8];
      expect(t.focus.slice(0, 3)).toEqual(want);
    });
  });
}

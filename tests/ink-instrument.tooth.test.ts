/**
 * Paper tooth (ink/tooth.ts, DESIGN §2.2.1, §6.4): a deterministic, world-anchored grain that
 * charcoal catches on, plus the charcoal nib's tilt widening.
 */
import { describe, it, expect } from 'vitest';
import { S } from '../src/core/types';
import { fnv1a } from '../src/core/det';
import { nibWidth } from '../src/ink/nibs';
import { cook } from '../src/ink/cook';
import {
  SMUDGE_LEVELS, TOOTH_LEVELS, TOOTH_N, toothCell, toothDensity, toothFor, toothInk, toothLevel, toothMaps, toothProfile, toothSmudge, toothSolid,
} from '../src/ink/tooth';
import { Hand, recipe } from './ink-instrument.fixtures';

/** Golden bytes of the tooth: any change to the paper is deliberate (it changes every charcoal drawing). */
const TOOTH_HASH = 'f5498e55';

const DEG = Math.PI / 180;

describe('tooth heightmap', () => {
  it('is the same bytes on every run and engine (golden fnv1a)', () => {
    const m = toothMaps();
    expect(m.crisp.length).toBe(TOOTH_N * TOOTH_N);
    expect(fnv1a([m.crisp, m.soft]).toString(16).padStart(8, '0')).toBe(TOOTH_HASH);
  });

  it('is equalised: every eighth of the height range covers an eighth of the paper', () => {
    for (const map of [toothMaps().crisp, toothMaps().soft]) {
      const hist = new Array(8).fill(0);
      for (const v of map) hist[v >> 5]++;
      for (const h of hist) expect(Math.abs(h / map.length - 1 / 8)).toBeLessThan(0.01);
    }
  });

  it('the smudged map is smoother than the crisp one', () => {
    const rough = (m: Uint8Array) => {
      let s = 0;
      for (let y = 0; y < TOOTH_N; y++) for (let x = 1; x < TOOTH_N; x++) s += Math.abs(m[y * TOOTH_N + x] - m[y * TOOTH_N + x - 1]);
      return s;
    };
    expect(rough(toothMaps().soft)).toBeLessThan(0.6 * rough(toothMaps().crisp));
  });
});

describe('coverage', () => {
  it('heavier pressure fills more of the tooth, at every smudge', () => {
    for (let s = 0; s < SMUDGE_LEVELS; s++) {
      let prev = -1;
      for (let l = 0; l < TOOTH_LEVELS; l++) {
        const v = toothSolid(l, s);
        expect(v).toBeGreaterThan(prev);
        prev = v;
      }
    }
    // the lightest touch leaves most of the paper showing, the heaviest covers more than half
    expect(toothSolid(0, 0)).toBeLessThan(0.3);
    expect(toothSolid(5, 0)).toBeGreaterThan(0.5);
    for (let l = 1; l < TOOTH_LEVELS; l++) expect(toothDensity(l)).toBeGreaterThan(toothDensity(l - 1));
    expect(toothDensity(TOOTH_LEVELS - 1)).toBeLessThanOrEqual(1);
  });

  it('the stick lays down most in the middle of the ribbon and least at its edge, with drag lanes between', () => {
    expect(toothProfile(0)).toBeCloseTo(1, 3);
    expect(toothProfile(0.95)).toBeLessThan(0.25);
    expect(toothProfile(1)).toBe(0);
    // a lane takes density away from the band it crosses: less than just outside it on both sides
    expect(toothProfile(0.6)).toBeLessThan(toothProfile(0.75));
    expect(toothProfile(0.6)).toBeLessThan(toothProfile(0.5));
  });

  it('one pigment at any pressure: the heaviest pressure bucket of the same depth (and hue) bucket', () => {
    expect([0, 7, 14, 23, 29].map(toothInk)).toEqual([25, 27, 29, 28, 29]);
    expect(toothInk(7 * 30 + 12)).toBe(7 * 30 + 27);
  });

  it('pressure level comes from the tone index (pBucket·5 + dBucket), Spectral hue buckets included', () => {
    expect([0, 4, 5, 14, 29].map(toothLevel)).toEqual([0, 0, 1, 2, 5]);
    expect(toothLevel(7 * 30 + 27)).toBe(5);
  });
});

describe('per stroke', () => {
  it('texel size is the power of two nearest one sp at the commit zoom', () => {
    expect(toothCell(1)).toBe(1);
    expect(toothCell(1.3)).toBe(1);
    expect(toothCell(1.5)).toBe(0.5);
    expect(toothCell(0.25)).toBe(4);
    expect(toothCell(32)).toBe(1 / 32);
    for (const z of [0.05, 0.3, 0.9, 2, 7.7, 32]) {
      const k = z * toothCell(z);
      expect(k).toBeGreaterThanOrEqual(Math.SQRT1_2);
      expect(k).toBeLessThan(Math.SQRT2);
    }
  });

  it('smudge follows the lean at pen-down: upright 0, laid on its side the top bucket', () => {
    const at = (alt: number) => { const r = new Float32Array(2 * S.STRIDE); r[S.ALT] = alt; r[S.STRIDE + S.ALT] = 0.1; return toothSmudge(r); };
    expect(at(90 * DEG)).toBe(0);
    expect(at(60 * DEG)).toBe(0);
    expect(at(42 * DEG)).toBeGreaterThan(0);
    expect(at(20 * DEG)).toBe(SMUDGE_LEVELS - 1);
    expect(at(NaN)).toBe(0);
    expect(toothSmudge({ data: new Float32Array(S.STRIDE).fill(20 * DEG), n: 1 })).toBe(SMUDGE_LEVELS - 1);
    expect(toothSmudge({ data: new Float32Array(S.STRIDE), n: 0 })).toBe(0);
  });

  it('only charcoal has a tooth; its grid offset is the origin modulo the period, also far from the origin', () => {
    const rows = new Hand(0, 0).moveTo(100, 0, 0.5).rows();
    expect(toothFor(recipe(rows, { nib: 'brush' }))).toBeUndefined();
    const r = { ...recipe(rows, { nib: 'charcoal', z: 1 }), origin: [1e6 + 3.25, -7.5] as const };
    const t = toothFor(r)!;
    expect(t.cell).toBe(1);
    expect(t.ox).toBeCloseTo((1e6 + 3.25) % TOOTH_N, 6);
    expect(t.oy).toBeCloseTo(TOOTH_N - 7.5, 9);
  });
});

describe('charcoal nib', () => {
  it('widens up to ×2.2 as the stick is laid on its side; other nibs ignore tilt', () => {
    expect(nibWidth('charcoal', 7, 0.5, 1, 'pen')).toBeCloseTo(7 * 0.95, 12);
    expect(nibWidth('charcoal', 7, 0.5, 1, 'pen', 90 * DEG)).toBeCloseTo(7 * 0.95, 12);
    expect(nibWidth('charcoal', 7, 0.5, 1, 'pen', 20 * DEG)).toBeCloseTo(7 * 0.95 * 2.2, 12);
    expect(nibWidth('charcoal', 7, 0.5, 1, 'pen', NaN)).toBeCloseTo(7 * 0.95, 12);
    for (const nib of ['pen', 'brush', 'chisel'] as const) expect(nibWidth(nib, 7, 0.5, 1, 'pen', 20 * DEG)).toBe(nibWidth(nib, 7, 0.5, 1, 'pen'));
  });

  it('a tilted charcoal stroke cooks wider than an upright one', () => {
    const up = cook(recipe(new Hand(0, 0, { alt: 90 * DEG }).moveTo(200, 0, 0.5).rows(), { nib: 'charcoal', size: 7 }));
    const side = cook(recipe(new Hand(0, 0, { alt: 20 * DEG }).moveTo(200, 0, 0.5).rows(), { nib: 'charcoal', size: 7 }));
    const h = (c: typeof up) => c.inkBox.y1 - c.inkBox.y0;
    expect(h(side) / h(up)).toBeGreaterThan(1.8);
  });
});

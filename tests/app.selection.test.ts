/** app/selection.ts: the pure restyle rules (DESIGN §3.4 Restyle) and the style mirror. */
import { describe, it, expect } from 'vitest';
import type { StrokeRecipe } from '../src/core/types';
import { S } from '../src/core/types';
import { DEFAULT_CALIB } from '../src/ink/calib';
import { NIBS } from '../src/ink/nibs';
import { FORMS } from '../src/ink/operators/registry';
import { freezeRecipe } from '../src/doc/commands';
import { restyleRecipe, uniformStyle } from '../src/app/selection';

function recipe(over: Partial<Pick<StrokeRecipe, 'stroke' | 'form' | 'color' | 'seed' | 'id'>> = {}): StrokeRecipe {
  const samples = new Float32Array(3 * S.STRIDE);
  for (let i = 0; i < 3; i++) { samples[i * S.STRIDE + S.X] = i * 20; samples[i * S.STRIDE + S.T] = i * 16; samples[i * S.STRIDE + S.P] = 0.5; }
  return freezeRecipe({
    id: over.id ?? '0000000001.0001', created: 1000, origin: [0, 0], z: 1, rot: 0, seed: over.seed ?? 7, device: 'pen',
    calib: DEFAULT_CALIB.pen, stroke: over.stroke ?? { nib: 'brush', size: 9 },
    color: over.color ?? { ink: 'moss', k: 3, dh: 1, dL: 0.01, lch: null },
    form: over.form ?? { form: 'sprout', v: 1, base: 2 },
    s0: 0, cut: 0, resume: null, samples, pools: new Float32Array(0), closed: false, radial: false, sym: null, xf: null,
  });
}

describe('restyleRecipe', () => {
  it('returns the same object when nothing would change', () => {
    const r = recipe();
    expect(restyleRecipe(r, { kind: 'nib', nib: 'brush', size: 9 }, () => 1)).toBe(r);
    expect(restyleRecipe(r, { kind: 'form', form: 'sprout' }, () => 1)).toBe(r);
    expect(restyleRecipe(r, { kind: 'ink', ink: 'moss', custom: null }, () => 1)).toBe(r);
    expect(restyleRecipe(r, { kind: 'size', factor: 1 }, () => 1)).toBe(r);
    expect(restyleRecipe(r, { kind: 'depth', delta: 0 }, () => 1)).toBe(r);
    expect(restyleRecipe(r, { kind: 'color', dh: 0, dL: 0, ground: 'night' }, () => 1)).toBe(r);
  });

  it('a nib tile re-cooks (geomRev bumps) and shares the samples', () => {
    const r = recipe();
    const n = restyleRecipe(r, { kind: 'nib', nib: 'pen', size: 2.5 }, () => 1);
    expect(n.stroke).toEqual({ nib: 'pen', size: 2.5 });
    expect(n.geomRev).not.toBe(r.geomRev);
    expect(n.colorRev).toBe(r.colorRev);
    expect(n.samples).toBe(r.samples);
    expect(n.id).toBe(r.id);
  });

  it('a Form tile keeps the seed, the base depth (clamped to the new range) and the pools', () => {
    const r = recipe({ form: { form: 'drift', v: 1, base: 5.5 } });
    const n = restyleRecipe(r, { kind: 'form', form: 'sprout' }, () => 1);
    expect(n.form.form).toBe('sprout');
    expect(n.form.base).toBe(FORMS.sprout.dMax);
    expect(n.seed).toBe(r.seed);
    expect(n.pools).toBe(r.pools);
  });

  it('an ink tile re-rasters only (colorRev bumps, geomRev stays) and keeps the variant', () => {
    const r = recipe();
    const n = restyleRecipe(r, { kind: 'ink', ink: 'indigo', custom: null }, () => 1);
    expect(n.color.ink).toBe('indigo');
    expect(n.color.k).toBe(r.color.k);
    expect(n.geomRev).toBe(r.geomRev);
    expect(n.colorRev).not.toBe(r.colorRev);
  });

  it('reseed derives a new seed from the old one and the counter', () => {
    const r = recipe();
    const a = restyleRecipe(r, { kind: 'reseed' }, () => 11);
    const b = restyleRecipe(r, { kind: 'reseed' }, () => 12);
    expect(a.seed).not.toBe(r.seed);
    expect(a.seed).not.toBe(b.seed);
    expect(restyleRecipe(r, { kind: 'reseed' }, () => 11).seed).toBe(a.seed);
  });

  it('bends are relative per stroke and clamped to the nib / Form range', () => {
    const a = recipe({ stroke: { nib: 'brush', size: 9 } }), b = recipe({ stroke: { nib: 'pen', size: 4 } });
    expect(restyleRecipe(a, { kind: 'size', factor: 2 }, () => 1).stroke.size).toBe(18);
    expect(restyleRecipe(b, { kind: 'size', factor: 2 }, () => 1).stroke.size).toBe(8);
    expect(restyleRecipe(a, { kind: 'size', factor: 100 }, () => 1).stroke.size).toBe(NIBS.brush.max);
    expect(restyleRecipe(a, { kind: 'depth', delta: -0.5 }, () => 1).form.base).toBe(1.5);
    expect(restyleRecipe(a, { kind: 'depth', delta: -9 }, () => 1).form.base).toBe(0);
    const c = restyleRecipe(a, { kind: 'color', dh: 30, dL: 0, ground: 'night' }, () => 1);
    expect(c.color.ink).toBe('custom');
    expect(c.color.lch).not.toBeNull();
    expect(c.geomRev).toBe(a.geomRev);
  });
});

describe('uniformStyle', () => {
  it('reports shared fields and marks mixed ones null', () => {
    const a = recipe(), b = recipe({ id: '0000000002.0001', stroke: { nib: 'pen', size: 3 } });
    const u = uniformStyle([a, b]);
    expect(u.nib).toBeNull();
    expect(u.size).toBeNull();
    expect(u.form).toBe('sprout');
    expect(u.base).toBe(2);
    expect(u.ink).toBe('moss');
    expect(u.color).toBe(a.color);
    expect(uniformStyle([a]).nib).toBe('brush');
    expect(uniformStyle([]).color).toBeNull();
  });
});

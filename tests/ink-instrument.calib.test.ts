import { describe, it, expect } from 'vitest';
import type { Calib } from '../src/core/types';
import { S } from '../src/core/types';
import {
  DEFAULT_CALIB, calibratePressure, synthPressure, createLearner, percentile, penFcMin, flatGuard, SYNTH_P0,
} from '../src/ink/calib';
import { mulberry32 } from './ink-instrument.fixtures';

/** A stroke of `n` rows at 240 Hz moving at `v` sp/ms with pressure from `pf`. */
function stroke(n: number, v: number, pf: (i: number) => number, z = 1): Float32Array {
  const out = new Float32Array(n * S.STRIDE);
  for (let i = 0; i < n; i++) {
    const o = i * S.STRIDE, t = i * (1000 / 240);
    out[o + S.X] = (v * t) / z; out[o + S.Y] = 0; out[o + S.T] = t; out[o + S.P] = pf(i);
    out[o + S.ALT] = Math.PI / 2; out[o + S.AZ] = 0; out[o + S.R] = NaN;
  }
  return out;
}

describe('pressure mappings', () => {
  it('cold-start calibration', () => {
    expect(DEFAULT_CALIB.pen).toMatchObject({ lo: 0.04, hi: 0.8, gamma: 1, flat: 1, vMed: 0.9, jitter: 0.3, fcMin: 3.5 });
    expect(DEFAULT_CALIB.mouse.fcMin).toBe(2.0);
    expect(DEFAULT_CALIB.touch.fcMin).toBe(1.5);
  });

  it('calibratePressure: normalise, curve, flat-hand guard', () => {
    const c = DEFAULT_CALIB.pen;
    expect(calibratePressure(0.04, c)).toBe(0);
    expect(calibratePressure(0.8, c)).toBe(1);
    expect(calibratePressure(0.42, c)).toBeCloseTo(0.5, 12);
    expect(calibratePressure(0, c)).toBe(0);
    expect(calibratePressure(1, c)).toBe(1);
    const g: Calib = { ...c, gamma: 2 };
    expect(calibratePressure(0.42, g)).toBeCloseTo(0.25, 9);
    // a flat hand (span < 0.08) maps everything to 0.6
    const flat: Calib = { ...c, lo: 0.5, hi: 0.55, flat: flatGuard(0.5, 0.55) };
    expect(flat.flat).toBe(0);
    expect(calibratePressure(0.2, flat)).toBe(0.6);
    expect(calibratePressure(0.9, flat)).toBe(0.6);
    expect(calibratePressure(NaN, c)).toBe(0.6);
  });

  it('synthesised pressure: rich when still, dry when fast, 45 ms time constant', () => {
    expect(SYNTH_P0).toBe(0.35);
    let p = SYNTH_P0;
    for (let i = 0; i < 100; i++) p = synthPressure(p, 0, 10);
    expect(p).toBeCloseTo(0.9, 6);
    p = SYNTH_P0;
    for (let i = 0; i < 100; i++) p = synthPressure(p, 3, 10);
    expect(p).toBeCloseTo(0.22, 6);
    expect(synthPressure(0.35, 0, 45)).toBeCloseTo(0.35 + (0.9 - 0.35) * (1 - Math.exp(-1)), 12);
    expect(synthPressure(0.5, 1, 0)).toBe(0.5);
    // rate independent: one 20 ms step equals two 10 ms steps
    expect(synthPressure(synthPressure(0.3, 1, 10), 1, 10)).toBeCloseTo(synthPressure(0.3, 1, 20), 12);
  });

  it('a damaged calib or an unknown speed never yields NaN pressure', () => {
    const c = DEFAULT_CALIB.pen;
    for (const bad of [{ gamma: NaN }, { gamma: 0 }, { gamma: -1 }, { flat: NaN }]) {
      const p = calibratePressure(0.42, { ...c, ...bad });
      expect(Number.isFinite(p)).toBe(true);
    }
    expect(calibratePressure(0.42, { ...c, gamma: NaN })).toBeCloseTo(0.5, 12); // γ falls back to 1
    expect(synthPressure(0.4, NaN, 10)).toBe(0.4);
  });

  it('pen fcMin falls as jitter rises', () => {
    expect(penFcMin(0.3)).toBe(3.5);
    expect(penFcMin(1.0)).toBeCloseTo(2.75, 12);
    expect(penFcMin(2.0)).toBe(2.0);
  });
});

describe('learner', () => {
  it('percentiles', () => {
    const a = Float64Array.from([0, 1, 2, 3, 4]);
    expect(percentile(a, 0.5)).toBe(2);
    expect(percentile(a, 0.05)).toBeCloseTo(0.2, 12);
    expect(percentile(a, 1)).toBe(4);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it('learns P5 / P95 / γ from in-stroke pressure (ends trimmed), by EMA at 8% per stroke', () => {
    const L = createLearner();
    const rand = mulberry32(5);
    // uniform 0.2..0.7 in-stroke; the first and last 30 ms carry outliers that must be ignored
    const mk = () => stroke(240, 0.8, i => (i < 7 || i > 232 ? 0.01 : 0.2 + 0.5 * rand()));
    const s1 = mk();
    L.observe('pen', s1, 240, 0.3);
    const c1 = L.snapshot('pen');
    expect(L.strokes.pen).toBe(1);
    // one stroke: lo moved 8% of the way from 0.04 toward ≈ 0.225
    expect(c1.lo).toBeCloseTo(0.04 + 0.08 * (0.225 - 0.04), 2);
    for (let k = 1; k < 120; k++) L.observe('pen', mk(), 240, 0.3);
    const c = L.snapshot('pen');
    expect(c.lo).toBeCloseTo(0.225, 1);
    expect(c.hi).toBeCloseTo(0.675, 1);
    expect(c.gamma).toBeCloseTo(1, 1);
    expect(c.flat).toBe(1);
    // mouse and touch are untouched
    expect(L.snapshot('mouse')).toEqual(DEFAULT_CALIB.mouse);
  });

  it('γ maps the median to 0.5', () => {
    const L = createLearner();
    const rand = mulberry32(9);
    // skewed: median at 25% of the span
    for (let k = 0; k < 140; k++) L.observe('pen', stroke(240, 0.8, () => { const u = rand(); return 0.1 + 0.8 * u * u; }), 240, 0.3);
    const c = L.snapshot('pen');
    const mid = 0.1 + 0.8 * 0.25;
    expect(calibratePressure(mid, c)).toBeCloseTo(0.5, 1);
  });

  it('learns vMed from window speeds (zoom-aware) and J from recent strokes', () => {
    const L = createLearner();
    for (let k = 0; k < 140; k++) L.observe('mouse', stroke(200, 1.6, () => NaN, 2), 200, 0.6, 2);
    const c = L.snapshot('mouse');
    expect(c.vMed).toBeCloseTo(1.6, 1);
    expect(c.jitter).toBeCloseTo(0.6, 1);
    expect(c.lo).toBe(DEFAULT_CALIB.mouse.lo); // no pressure data for a mouse
    expect(c.fcMin).toBe(2.0);
    const P = createLearner();
    for (let k = 0; k < 140; k++) P.observe('pen', stroke(200, 0.9, () => 0.5), 200, 1.6);
    expect(P.snapshot('pen').fcMin).toBeLessThan(2.3);
  });

  it('skips corrupt rows: one bad time stamp does not hide the rest of the stroke', () => {
    // regression: a T = ∞ row stopped the speed-window scan, so the rest of the stroke was ignored
    const clean = createLearner(), dirty = createLearner();
    for (let k = 0; k < 40; k++) {
      const s = stroke(240, 1.4, () => 0.3 + 0.4 * ((k * 7) % 10) / 10);
      const d = s.slice();
      d[40 * S.STRIDE + S.T] = Infinity; d[41 * S.STRIDE + S.X] = NaN; d[0] = NaN;
      clean.observe('pen', s, 240, 0.3); dirty.observe('pen', d, 240, 0.3);
    }
    expect(dirty.snapshot('pen').vMed).toBeCloseTo(clean.snapshot('pen').vMed, 2);
    expect(dirty.snapshot('pen').lo).toBeCloseTo(clean.snapshot('pen').lo, 2);
    expect(dirty.strokes.pen).toBe(40);
  });

  it('locks after 150 strokes: ≤ 1% per stroke and within ±15% of the converged value', () => {
    const L = createLearner();
    for (let k = 0; k < 150; k++) L.observe('touch', stroke(200, 1.0, () => NaN), 200, 0.5);
    const conv = L.snapshot('touch');
    expect(L.strokes.touch).toBe(150);
    let prev = conv;
    for (let k = 0; k < 60; k++) {
      L.observe('touch', stroke(200, 3.0, () => NaN), 200, 2.0);
      const c = L.snapshot('touch');
      expect(Math.abs(c.vMed - prev.vMed)).toBeLessThanOrEqual(0.01 * prev.vMed + 1e-9);
      expect(Math.abs(c.jitter - prev.jitter)).toBeLessThanOrEqual(0.01 * prev.jitter + 1e-9);
      prev = c;
    }
    expect(prev.vMed).toBeCloseTo(conv.vMed * 1.15, 6);
    expect(prev.jitter).toBeCloseTo(conv.jitter * 1.15, 6);
  });

  it('persists under rise:calib:<device>, survives garbage and storage failures, resets', () => {
    const store = new Map<string, string>();
    const io = { load: (k: string) => store.get(k) ?? null, save: (k: string, v: string) => { store.set(k, v); } };
    const L = createLearner(io);
    for (let k = 0; k < 20; k++) L.observe('pen', stroke(240, 0.8, i => 0.3 + 0.002 * i), 240, 0.4);
    expect([...store.keys()]).toEqual(['rise:calib:pen']);
    const again = createLearner(io);
    expect(again.snapshot('pen')).toEqual(L.snapshot('pen'));
    expect(again.strokes.pen).toBe(20);
    // continuing learning from the restored reservoirs matches continuing the original
    const s = stroke(240, 0.8, i => 0.25 + 0.002 * i);
    L.observe('pen', s, 240, 0.4); again.observe('pen', s, 240, 0.4);
    expect(again.snapshot('pen').lo).toBeCloseTo(L.snapshot('pen').lo, 3);

    store.set('rise:calib:mouse', '{not json');
    expect(createLearner(io).snapshot('mouse')).toEqual(DEFAULT_CALIB.mouse);
    const broken = createLearner({ load: () => { throw new Error('denied'); }, save: () => { throw new Error('quota'); } });
    broken.observe('pen', stroke(100, 1, () => 0.5), 100, 0.3);
    expect(broken.strokes.pen).toBe(1);

    again.reset('pen');
    expect(again.snapshot('pen')).toEqual(DEFAULT_CALIB.pen);
    expect(again.strokes.pen).toBe(0);
    expect(JSON.parse(store.get('rise:calib:pen')!).strokes).toBe(0);
    L.observe('mouse', stroke(100, 1, () => NaN), 100, 0.3);
    L.reset();
    expect(L.strokes.mouse).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import type { StrokeRecipe } from '../src/core/types';
import { freezeRecipe, freshRev, isEmptyCommand, patchRecipe, recipeFields, restoreRecipe, addCmd, batchCmd, metaCmd, removeCmd, replaceCmd } from '../src/doc/commands';
import { makeDocId, makeStrokeId, idMs, isStdStrokeId, ID_COUNTER_SPAN } from '../src/doc/ids';
import { CALIB, makeSamples, randomRecipe, seeded } from './doc-persist.helpers';

describe('ids', () => {
  it('stroke ids are fixed width and sort by (ms, counter)', () => {
    expect(makeStrokeId(0, 0)).toBe('0000000000000');
    expect(makeStrokeId(1_700_000_000_000, 1)).toBe((1_700_000_000_000).toString(36).padStart(9, '0') + '0001');
    const pairs: [number, number][] = [];
    const rand = seeded(1);
    for (let i = 0; i < 500; i++) pairs.push([Math.floor(rand() * 2e12), Math.floor(rand() * (ID_COUNTER_SPAN - 1))]);
    const byNum = pairs.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([m, c]) => makeStrokeId(m, c));
    const byStr = pairs.map(([m, c]) => makeStrokeId(m, c)).sort();
    expect(byStr).toEqual(byNum);
    expect(byNum.every(isStdStrokeId)).toBe(true);
  });

  it('idMs reads the time prefix back', () => {
    expect(idMs(makeStrokeId(123456789, 7))).toBe(123456789);
    expect(idMs('not-an-id')).toBeNaN();
  });

  it('doc ids are 16 chars and sort by time', () => {
    const a = makeDocId(1000, 0xffffffff), b = makeDocId(1001, 0);
    expect(a.length).toBe(16);
    expect(b.length).toBe(16);
    expect(a < b).toBe(true);
    expect(makeDocId(5, -1)).toBe(makeDocId(5, 0xffffffff));
  });
});

function draftFields(): Omit<StrokeRecipe, 'geomRev' | 'colorRev'> {
  const big = new Float32Array(9 * 64); // a draft's growable buffer: only the first 3 rows are used
  big.set(makeSamples(seeded(3), 3, 'pen'));
  return {
    id: '00000000a0001', created: 1, origin: [10, 20], z: 1, rot: 0, seed: 5, device: 'pen',
    calib: { ...CALIB }, stroke: { nib: 'brush', size: 9 },
    color: { ink: 'custom', k: 0, dh: 0, dL: 0, lch: { night: [0.8, 0.1, 140], paper: [0.4, 0.1, 140] } },
    form: { form: 'sprout', v: 1, base: 2 }, s0: 0, cut: 0, resume: null,
    samples: big.subarray(0, 27), pools: new Float32Array(0), closed: false, radial: false, sym: null, xf: null,
  };
}

describe('freezeRecipe / patchRecipe', () => {
  it('freezes with zero revs, copies nested objects and owns view buffers', () => {
    const f = draftFields();
    const r = freezeRecipe(f);
    expect(r.geomRev).toBe(0);
    expect(r.colorRev).toBe(0);
    expect(Object.isFrozen(r) && Object.isFrozen(r.calib) && Object.isFrozen(r.color) && Object.isFrozen(r.color.lch!.night)).toBe(true);
    expect(Object.isFrozen(f.calib)).toBe(false); // the caller's objects are untouched
    expect(r.calib).not.toBe(f.calib);
    expect(r.samples.length).toBe(27);
    expect(r.samples.buffer.byteLength).toBe(27 * 4); // copied out of the growable buffer
  });

  it('never aliases caller storage, even a draft buffer that is exactly full', () => {
    // A reused draft buffer whose capacity happens to equal the stroke's rows: its
    // view covers the whole buffer. Freezing must still copy, or the next stroke
    // drawn into the same buffer would rewrite this committed recipe.
    const f = draftFields();
    const draft = new Float32Array(27);
    draft.set(f.samples);
    const pools = new Float32Array([1, 2, 3, 4]);
    const resume = new Float32Array([5, 6]);
    const xf = new Float64Array([1, 0, 0, 1, 0, 0]);
    const r = freezeRecipe({ ...f, samples: draft.subarray(0, 27), pools, resume, xf });
    const before = r.samples.slice();
    draft.fill(-1); pools.fill(-1); resume.fill(-1); xf.fill(-1); // the draft starts its next stroke
    expect(Array.from(r.samples)).toEqual(Array.from(before));
    expect(Array.from(r.pools)).toEqual([1, 2, 3, 4]);
    expect(Array.from(r.resume!)).toEqual([5, 6]);
    expect(Array.from(r.xf!)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(r.samples.buffer).not.toBe(draft.buffer);
  });

  it('patchRecipe shares unpatched arrays but copies arrays supplied by the patch', () => {
    const a = freezeRecipe(draftFields());
    const live = new Float32Array([10, 1, 0, 100]);
    const p = patchRecipe(a, { pools: live }, 'geometry');
    expect(p.samples).toBe(a.samples);
    live[1] = 99;
    expect(p.pools[1]).toBe(1);
    expect(patchRecipe(p, { seed: 4 }, 'geometry').pools).toBe(p.pools);
  });

  it('rejects malformed buffers', () => {
    const f = draftFields();
    expect(() => freezeRecipe({ ...f, samples: new Float32Array(10) })).toThrow(RangeError);
    expect(() => freezeRecipe({ ...f, samples: new Float32Array(0) })).toThrow(RangeError);
    expect(() => freezeRecipe({ ...f, pools: new Float32Array(3) })).toThrow(RangeError);
    expect(() => freezeRecipe({ ...f, id: '' })).toThrow(TypeError);
  });

  it('all recipes share one key order (one hidden class)', () => {
    const a = freezeRecipe(draftFields());
    const b = patchRecipe(a, { seed: 9 }, 'geometry');
    const c = randomRecipe(seeded(4), '00000000b0001');
    expect(Object.keys(b)).toEqual(Object.keys(a));
    expect(Object.keys(c)).toEqual(Object.keys(a));
  });

  it('patch bumps the declared rev and shares samples', () => {
    const a = freezeRecipe(draftFields());
    const g = patchRecipe(a, { form: { form: 'echo', v: 1, base: 1 } }, 'geometry');
    expect(g.geomRev).toBeGreaterThan(a.geomRev);
    expect(g.colorRev).toBe(a.colorRev);
    expect(g.samples).toBe(a.samples);
    expect(g.id).toBe(a.id);
    const c = patchRecipe(a, { color: { ...a.color, dh: 3 } }, 'color');
    expect(c.colorRev).toBeGreaterThan(a.colorRev);
    expect(c.geomRev).toBe(a.geomRev);
  });

  it('cache safety: undo then a different restyle never reuses a rev', () => {
    const a = freezeRecipe(draftFields());
    const b = patchRecipe(a, { seed: 1 }, 'geometry');
    const c = patchRecipe(a, { seed: 2 }, 'geometry'); // a different edit of the same original
    expect(c.geomRev).not.toBe(b.geomRev);
    const d = patchRecipe(a, { color: { ...a.color, k: 1 } }, 'color');
    const e = patchRecipe(a, { color: { ...a.color, k: 2 } }, 'color');
    expect(d.colorRev).not.toBe(e.colorRev);
  });

  it('the declared kind cannot hide a change: colour and geometry fields bump their own revs', () => {
    const a = freezeRecipe(draftFields());
    const x = patchRecipe(a, { color: { ...a.color, k: 7 }, stroke: { nib: 'pen', size: 3 } }, 'color');
    expect(x.geomRev).toBeGreaterThan(a.geomRev);
    expect(x.colorRev).toBeGreaterThan(a.colorRev);
    const y = patchRecipe(a, { created: 99 }, 'color');
    expect(y.geomRev).toBe(a.geomRev);
    const z = patchRecipe(a, { pools: undefined, seed: a.seed }, 'color');
    expect(z.pools).toBe(a.pools);
    expect(z.geomRev).toBe(a.geomRev);
  });

  it('restored recipes advance the rev clock past their revs', () => {
    const r = restoreRecipe(recipeFields(freezeRecipe(draftFields())), 1_000_000, 5);
    expect(r.geomRev).toBe(1_000_000);
    expect(freshRev()).toBeGreaterThan(1_000_000);
    const p = patchRecipe(freezeRecipe(draftFields()), { seed: 3 }, 'geometry');
    expect(p.geomRev).toBeGreaterThan(1_000_000);
  });

  it('isEmptyCommand', () => {
    expect(isEmptyCommand(addCmd([]))).toBe(true);
    expect(isEmptyCommand(removeCmd([]))).toBe(true);
    expect(isEmptyCommand(replaceCmd([], []))).toBe(true);
    expect(isEmptyCommand({ k: 'meta', patch: {} })).toBe(true);
    expect(isEmptyCommand(batchCmd([addCmd([]), batchCmd([])]))).toBe(true);
    expect(isEmptyCommand(metaCmd('x'))).toBe(false);
    expect(isEmptyCommand(removeCmd(['a']))).toBe(false);
  });
});

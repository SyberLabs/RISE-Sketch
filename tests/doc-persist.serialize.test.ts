import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DocMeta, StrokeRecipe } from '../src/core/types';
import { freezeRecipe, patchRecipe } from '../src/doc/commands';
import { createDoc, newMeta } from '../src/doc/document';
import { base64ToBytes, bytesToBase64, decodeF32, encodeF32, FORMAT_VERSION, parseDoc, RiseFormatError, sampleTimeFault, sceneHash, serializeDoc } from '../src/doc/serialize';
import { CALIB, makeSamples, randomRecipe, recipeDiff, sameBits, seeded } from './doc-persist.helpers';

const APP = 'rise-sketch@0.1.0';
const FIXTURE_DIR = join(__dirname, 'fixtures');
/** Committed v1 fixture and its golden sceneHash (DESIGN §7.6: every format fixture migrates to it). */
const FIXTURES: { file: string; version: number; hash: number; strokes: number }[] = [
  { file: 'doc-v1.rise', version: 1, hash: 0x059a1552, strokes: 7 },
];

function expectSameRecipes(a: readonly StrokeRecipe[], b: readonly StrokeRecipe[]): void {
  expect(b.length).toBe(a.length);
  for (let i = 0; i < a.length; i++) expect(recipeDiff(a[i], b[i])).toBe(null);
}

function expectSameMeta(a: DocMeta, b: DocMeta): void {
  const { id: _ia, ...x } = a;
  const { id: _ib, ...y } = b;
  expect(y).toEqual(x);
}

describe('base64 / Float32', () => {
  it('matches Node base64 for every tail length', () => {
    const rand = seeded(1);
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = Math.floor(rand() * 256);
      const s = bytesToBase64(b);
      expect(s).toBe(Buffer.from(b).toString('base64'));
      expect(Array.from(base64ToBytes(s))).toEqual(Array.from(b));
    }
  });

  it('handles buffers larger than one encode chunk', () => {
    const b = new Uint8Array(100_003);
    for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761) >>> 24;
    const s = bytesToBase64(b);
    expect(s).toBe(Buffer.from(b).toString('base64'));
    expect(sameBits(base64ToBytes(s), b)).toBe(true);
  });

  it('accepts unpadded input and rejects garbage', () => {
    expect(Array.from(base64ToBytes('AQI'))).toEqual([1, 2]);
    for (const bad of ['A', 'AB=C', 'AB===', '@@@@', 'AQ=', 'AQé=']) expect(() => base64ToBytes(bad)).toThrow(RiseFormatError);
  });

  it('round-trips every Float32 bit pattern, NaN payloads and -0 included', () => {
    const rand = seeded(2);
    const u = new Uint32Array(4096);
    for (let i = 0; i < u.length; i++) u[i] = Math.floor(rand() * 4294967296) >>> 0;
    u[0] = 0x7fc00001; u[1] = 0xffbfffff; u[2] = 0x80000000; u[3] = 0x7f800000; u[4] = 0x00000001;
    const f = new Float32Array(u.buffer);
    const back = decodeF32(encodeF32(f));
    expect(Array.from(new Uint32Array(back.buffer))).toEqual(Array.from(u));
  });

  it('encodes a view without its neighbours and as little-endian bytes', () => {
    const f = new Float32Array([1, 2, 3, 4]);
    expect(Array.from(decodeF32(encodeF32(f.subarray(1, 3))))).toEqual([2, 3]);
    expect(encodeF32(new Float32Array([1]))).toBe(Buffer.from([0, 0, 0x80, 0x3f]).toString('base64'));
    expect(() => decodeF32('AQI=')).toThrow(RiseFormatError);
  });
});

/** A document exercising every recipe feature the v1 format stores. */
function buildFixture(): { meta: DocMeta; strokes: StrokeRecipe[] } {
  const meta = newMeta(1_759_600_000_000, 0x9e3779b9, 'fixture');
  meta.title = 'Fixture: garden / "quotes" — é';
  meta.updated = 1_759_600_123_456;
  meta.counter = 23;
  meta.inkCounters.moss = 4; meta.inkCounters.custom = 1; meta.inkCounters.spectral = 2;
  meta.ground = 'paper';
  meta.camera = { cx: 120.5, cy: -40.25, scale: 1.5, rot: 0 };
  const base = {
    created: 1_759_600_001_000, rot: 0, calib: { ...CALIB }, s0: 0, cut: 0, resume: null,
    pools: new Float32Array(0), closed: false, radial: false, sym: null, xf: null,
  };
  const circle = (n: number, r: number): Float32Array => {
    const a = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * Math.PI * 2.08;
      a.set([Math.cos(t) * r - r, Math.sin(t) * r, i * 8, NaN, Math.PI / 2, 0, 9.5, 0.1, -0.25], i * 9);
    }
    return a;
  };
  const strokes: StrokeRecipe[] = [];
  // 1. pen + brush + moss + sprout, risen (pools)
  strokes.push(freezeRecipe({
    ...base, id: '0mfkq3o8w0001', origin: [-310.75, 42.125], z: 1, seed: 0x1234abcd, device: 'pen',
    stroke: { nib: 'brush', size: 9 }, color: { ink: 'moss', k: 3, dh: 1.2, dL: 0.01, lch: null },
    form: { form: 'sprout', v: 1, base: 2 }, samples: makeSamples(seeded(11), 40, 'pen'),
    pools: new Float32Array([62.4, 1.5, 820, 1460, 130.1, 2.25, 1900, 2700]),
  }));
  // 2. mouse + pen nib + indigo + line (no pressure)
  strokes.push(freezeRecipe({
    ...base, id: '0mfkq3p1a0003', origin: [12, -8], z: 0.5, seed: 0xdeadbeef, device: 'mouse',
    stroke: { nib: 'pen', size: 2.5 }, color: { ink: 'indigo', k: 0, dh: -0.4, dL: 0, lch: null },
    form: { form: 'line', v: 1, base: 0 }, samples: makeSamples(seeded(12), 25, 'mouse'),
  }));
  // 3. touch + chisel + custom ink + echo, closed loop
  strokes.push(freezeRecipe({
    ...base, id: '0mfkq3q2b0005', origin: [400.5, 300.25], z: 2, seed: 77, device: 'touch',
    stroke: { nib: 'chisel', size: 12 },
    color: { ink: 'custom', k: 0, dh: 0, dL: 0, lch: { night: [0.82, 0.13, 148.5], paper: [0.47, 0.11, 151] } },
    form: { form: 'echo', v: 1, base: 2.5 }, samples: circle(48, 60), closed: true,
  }));
  // 4. radial tap seed: one sample, spectral drift
  strokes.push(freezeRecipe({
    ...base, id: '0mfkq3r3c0007', origin: [-50, -60], z: 1, seed: 4242, device: 'pen',
    stroke: { nib: 'pen', size: 3 }, color: { ink: 'spectral', k: 1, dh: 0, dL: 0, lch: null },
    form: { form: 'drift', v: 1, base: 2 }, samples: makeSamples(seeded(13), 1, 'pen'), radial: true,
    pools: new Float32Array([0, 1.25, 450, 1100]),
  }));
  // 5 + 6. auto-split pieces: tail cut, then a continuation with s0, head cut and resume state
  const split = makeSamples(seeded(14), 30, 'pen');
  strokes.push(freezeRecipe({
    ...base, id: '0mfkq3s4d0009', origin: [1e7 + 0.123456789, -2e6 - 0.5], z: 3.2, seed: 99, device: 'pen',
    stroke: { nib: 'brush', size: 14 }, color: { ink: 'ochre', k: 2, dh: 0.5, dL: -0.02, lch: null },
    form: { form: 'sprout', v: 1, base: 1.75 }, samples: split.slice(0, 15 * 9), cut: 2,
  }));
  strokes.push(freezeRecipe({
    ...base, id: '0mfkq3s4d000a', origin: [1e7 + 0.123456789, -2e6 - 0.5], z: 3.2, seed: 100, device: 'pen',
    stroke: { nib: 'brush', size: 14 }, color: { ink: 'ochre', k: 2, dh: 0.5, dL: -0.02, lch: null },
    form: { form: 'sprout', v: 1, base: 1.75 }, samples: split.slice(15 * 9), s0: 14400.5, cut: 1,
    resume: new Float32Array([1.5, -2.25, 0.125, 3e-8, 14400.5]),
  }));
  // 7. graphite line with an exotic but valid -0 and a negative-zero origin coordinate
  strokes.push(freezeRecipe({
    ...base, id: '0mfkq3t5e000c', origin: [-0, 0.1 + 0.2], z: 1, seed: 0, device: 'mouse',
    stroke: { nib: 'chisel', size: 5 }, color: { ink: 'graphite', k: 5, dh: -0, dL: 0, lch: null },
    form: { form: 'line', v: 1, base: 1 }, samples: makeSamples(seeded(15), 8, 'mouse'),
  }));
  return { meta, strokes };
}

describe('.rise serialisation', () => {
  it('round-trips bit-exactly (meta, recipes, file text)', () => {
    const { meta, strokes } = buildFixture();
    const text = serializeDoc(meta, strokes, APP);
    const back = parseDoc(text, { id: meta.id });
    expectSameMeta(meta, back.meta);
    expect(back.meta.id).toBe(meta.id);
    expectSameRecipes(strokes, back.strokes);
    expect(serializeDoc(back.meta, back.strokes, APP)).toBe(text);
    expect(sceneHash(back.strokes)).toBe(sceneHash(strokes));
  });

  it('round-trips random documents', () => {
    for (let seed = 0; seed < 20; seed++) {
      const rand = seeded(500 + seed);
      const doc = createDoc(newMeta(1000, seed, 'r'));
      const rs = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => randomRecipe(rand, doc.nextId()));
      const meta = { ...doc.meta, inkCounters: { ...doc.meta.inkCounters }, camera: { ...doc.meta.camera } };
      const text = serializeDoc(meta, rs, APP);
      const back = parseDoc(text, { id: 'r' });
      expectSameRecipes(rs, back.strokes);
      expect(serializeDoc(back.meta, back.strokes, APP)).toBe(text);
    }
  });

  it('writes the spec layout: header, meta, one z-ordered stroke per line', () => {
    const { meta, strokes } = buildFixture();
    const text = serializeDoc(meta, strokes.slice().reverse(), APP);
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('{"format":"rise","version":1,"app":"rise-sketch@0.1.0",');
    expect(lines[1].startsWith('"meta":{"title":')).toBe(true);
    expect(lines.length).toBe(3 + strokes.length + 1);
    const json = JSON.parse(text);
    expect(json.strokes.map((s: { id: string }) => s.id)).toEqual(strokes.map(r => r.id).sort());
    const s0 = json.strokes[0];
    expect(Object.keys(s0)).toEqual(['id', 'created', 'device', 'origin', 'z', 'rot', 'seed', 'calib', 'stroke', 'color', 'form',
      'closed', 'radial', 's0', 'cut', 'resume', 'sym', 'xf', 'stride', 'samples', 'pools']);
    expect(s0.stride).toBe(9);
    expect(json.meta.id).toBeUndefined();
  });

  it('preserves -0 and non-finite scalars', () => {
    const { meta, strokes } = buildFixture();
    const odd = patchRecipe(strokes[0], { calib: { ...CALIB, jitter: NaN, vMed: Infinity, fcMin: -0 }, color: { ...strokes[0].color, dL: -Infinity } }, 'geometry');
    const text = serializeDoc(meta, [odd], APP);
    expect(text).toContain('"jitter":"NaN"');
    expect(text).toContain('"fcMin":-0');
    const back = parseDoc(text).strokes[0];
    expect(back.calib.jitter).toBeNaN();
    expect(back.calib.vMed).toBe(Infinity);
    expect(Object.is(back.calib.fcMin, -0)).toBe(true);
    expect(back.color.dL).toBe(-Infinity);
  });

  it('refuses to write structurally impossible values', () => {
    const { meta, strokes } = buildFixture();
    const bad = freezeRecipe({ ...strokes[1], z: NaN });
    expect(() => serializeDoc(meta, [bad], APP)).toThrow(RiseFormatError);
  });

  it('never writes a file it cannot read back: every value the reader rejects fails the save', () => {
    const { meta, strokes } = buildFixture();
    const s = strokes[1];
    const backwards = s.samples.slice();
    backwards[9 + 2] = backwards[2] - 1;
    const nanT = s.samples.slice();
    nanT[2] = NaN;
    const recipes: [string, StrokeRecipe][] = [
      ['z = 0', freezeRecipe({ ...s, z: 0 })],
      ['z < 0', freezeRecipe({ ...s, z: -1 })],
      ['fractional form.v', freezeRecipe({ ...s, form: { ...s.form, v: 1.5 } })],
      ['form.v = 0', freezeRecipe({ ...s, form: { ...s.form, v: 0 } })],
      ['cut = 4', freezeRecipe({ ...s, cut: 4 })],
      ['fractional cut', freezeRecipe({ ...s, cut: 0.5 })],
      ['time goes backwards', freezeRecipe({ ...s, samples: backwards })],
      ['NaN time', freezeRecipe({ ...s, samples: nanT })],
      ['unknown nib', freezeRecipe({ ...s, stroke: { nib: 'quill' as never, size: 3 } })],
      ['unknown device', freezeRecipe({ ...s, device: 'stylus' as never })],
      ['unknown ink', freezeRecipe({ ...s, color: { ...s.color, ink: 'teal' as never } })],
      ['custom ink without colours', freezeRecipe({ ...s, color: { ...s.color, ink: 'custom', lch: null } })],
      ['unknown form', freezeRecipe({ ...s, form: { ...s.form, form: 'spiral' as never } })],
      ['bad symmetry axis', freezeRecipe({ ...s, sym: { axis: 'd' as never, at: 0 } })],
      ['non-base36 id', freezeRecipe({ ...s, id: 'Stroke-1' })],
    ];
    for (const [name, r] of recipes) {
      let err: unknown = null;
      try { serializeDoc(meta, [r], APP); } catch (e) { err = e; }
      expect(err, name).toBeInstanceOf(RiseFormatError);
      expect((err as Error).message, name).toMatch(/^cannot save/);
    }
    expect(() => serializeDoc(meta, [s, s], APP)).toThrow(/appears twice/);
    const metas: [string, DocMeta][] = [
      ['fractional counter', { ...meta, counter: 2.5 }],
      ['negative ink counter', { ...meta, inkCounters: { ...meta.inkCounters, rose: -1 } }],
      ['zero camera scale', { ...meta, camera: { ...meta.camera, scale: 0 } }],
      ['unknown ground', { ...meta, ground: 'dusk' as never }],
    ];
    for (const [name, m] of metas) expect(() => serializeDoc(m, strokes, APP), name).toThrow(/^cannot save/);
    // and the guard is exactly the reader's rule: equal timestamps are still fine
    const equalT = s.samples.slice();
    equalT[9 + 2] = equalT[2];
    expect(parseDoc(serializeDoc(meta, [freezeRecipe({ ...s, samples: equalT })], APP)).strokes.length).toBe(1);
  });

  it('opening yields a fresh document id, fresh revs, and optionally a fresh updated time', () => {
    const { meta, strokes } = buildFixture();
    const text = serializeDoc(meta, strokes, APP);
    const a = parseDoc(text, { now: 2_000_000_000_000, rand32: 1 });
    const b = parseDoc(text, { now: 2_000_000_000_000, rand32: 2 });
    expect(a.meta.id).not.toBe(b.meta.id);
    expect(a.meta.id.length).toBe(16);
    expect(a.meta.updated).toBe(2_000_000_000_000);
    expect(a.strokes[0].geomRev).toBeGreaterThan(0);
    expect(b.strokes[0].geomRev).toBeGreaterThan(a.strokes[0].geomRev);
    expect(Object.isFrozen(a.strokes[0])).toBe(true);
  });

  it('fills missing optional meta fields', () => {
    const json = { format: 'rise', version: 1, app: 'x', meta: { created: 5, docSeed: 1, counter: 0, ground: 'night', camera: { cx: 0, cy: 0, scale: 1, rot: 0 } }, strokes: [] };
    const { meta } = parseDoc(JSON.stringify(json));
    expect(meta.title).toBe('Untitled');
    expect(meta.updated).toBe(5);
    expect(meta.inkCounters.rose).toBe(0);
  });

  it('rejects unreadable files with RiseFormatError and a useful path', () => {
    const { meta, strokes } = buildFixture();
    const good = JSON.parse(serializeDoc(meta, strokes, APP));
    const variants: [string, (j: any) => void, RegExp][] = [
      ['not json', () => undefined, /invalid JSON/],
      ['wrong tag', j => { j.format = 'svg'; }, /not a \.rise file/],
      ['newer', j => { j.version = FORMAT_VERSION + 1; }, /newer/],
      ['v0', j => { j.version = 0; }, /unsupported/],
      ['no version', j => { delete j.version; }, /version/],
      ['bad stride', j => { j.strokes[0].stride = 8; }, /strokes\[0\]\.stride/],
      ['bad samples', j => { j.strokes[1].samples = 'AAAA'; }, /strokes\[1\]\.samples/],
      ['bad base64', j => { j.strokes[1].samples = '!!!!'; }, /strokes\[1\]\.samples/],
      ['bad pools', j => { j.strokes[0].pools = 'AAAAAAAA'; }, /strokes\[0\]\.pools/],
      ['bad nib', j => { j.strokes[2].stroke.nib = 'quill'; }, /strokes\[2\]\.stroke\.nib/],
      ['bad z', j => { j.strokes[2].z = 0; }, /strokes\[2\]\.z/],
      ['bad seed', j => { j.strokes[2].seed = -1; }, /strokes\[2\]\.seed/],
      ['custom without lch', j => { j.strokes[2].color.lch = null; }, /lch/],
      ['dup ids', j => { j.strokes[1].id = j.strokes[0].id; }, /duplicate/],
      ['bad ground', j => { j.meta.ground = 'dusk'; }, /meta\.ground/],
      ['strokes not array', j => { j.strokes = {}; }, /strokes/],
    ];
    for (const [name, mut, re] of variants) {
      const j = JSON.parse(JSON.stringify(good));
      mut(j);
      const text = name === 'not json' ? '{"format":' : JSON.stringify(j);
      let err: unknown = null;
      try { parseDoc(text); } catch (e) { err = e; }
      expect(err, name).toBeInstanceOf(RiseFormatError);
      expect((err as Error).message, name).toMatch(re);
    }
    expect(() => parseDoc('\u001f\u008b...')).toThrow(/compressed/);
  });

  it('rejects timestamps that are not finite or go backwards (rule 9), tolerates equal ones', () => {
    const { meta, strokes } = buildFixture();
    const withT = (fn: (s: Float32Array) => void) => {
      const s = strokes[0].samples.slice();
      fn(s);
      return serializeDoc(meta, [freezeRecipe({ ...strokes[0], samples: s })], APP);
    };
    expect(() => parseDoc(withT(s => { s[9 + 2] = s[2] - 1; }))).toThrow(/row 1 .*backwards/);
    expect(() => parseDoc(withT(s => { s[18 + 2] = NaN; }))).toThrow(/row 2/);
    expect(parseDoc(withT(s => { s[9 + 2] = s[2]; })).strokes.length).toBe(1);
    expect(sampleTimeFault(strokes[0].samples)).toBe(-1);
  });

  it('tolerates a BOM', () => {
    const { meta, strokes } = buildFixture();
    expect(parseDoc('﻿' + serializeDoc(meta, strokes, APP)).strokes.length).toBe(strokes.length);
  });
});

describe('sceneHash', () => {
  it('is order-independent, colour-blind and geometry-sensitive', () => {
    const { strokes } = buildFixture();
    const h = sceneHash(strokes);
    expect(sceneHash(strokes.slice().reverse())).toBe(h);
    const recolored = strokes.map(r => patchRecipe(r, { color: { ink: 'rose', k: 9, dh: 3, dL: 0.02, lch: null } }, 'color'));
    expect(sceneHash(recolored)).toBe(h);
    const moved = strokes.map((r, i) => (i === 3 ? patchRecipe(r, { form: { ...r.form, base: r.form.base + 0.25 } }, 'geometry') : r));
    expect(sceneHash(moved)).not.toBe(h);
    const s = strokes[1].samples.slice();
    s[4] = Math.fround(s[4] + 1e-3);
    expect(sceneHash(strokes.map((r, i) => (i === 1 ? freezeRecipe({ ...r, samples: s }) : r)))).not.toBe(h);
    expect(sceneHash(strokes.slice(1))).not.toBe(h);
    expect(sceneHash([])).toBe(0x811c9dc5);
  });

  it('hashes every NaN encoding of a scalar alike, so a file round trip keeps the hash', () => {
    const { meta, strokes } = buildFixture();
    // a negative quiet NaN with a payload, as computed NaNs can be on x86
    const bits = new Float64Array(1);
    const w = new Uint32Array(bits.buffer);
    w[0] = 0x12345; w[1] = 0xfff80000;
    const oddNaN = bits[0];
    const a = patchRecipe(strokes[0], { calib: { ...CALIB, jitter: oddNaN }, sym: { axis: 'v', at: oddNaN } }, 'geometry');
    const b = patchRecipe(strokes[0], { calib: { ...CALIB, jitter: NaN }, sym: { axis: 'v', at: NaN } }, 'geometry');
    expect(sceneHash([a])).toBe(sceneHash([b]));
    const back = parseDoc(serializeDoc(meta, [a], APP)).strokes;
    expect(sceneHash(back)).toBe(sceneHash([a]));
    expect(sceneHash([a])).not.toBe(sceneHash([strokes[0]])); // NaN still differs from a number
  });
});

describe('format fixtures', () => {
  it('the committed v1 fixture is what the writer produces for the fixture document', () => {
    const path = join(FIXTURE_DIR, 'doc-v1.rise');
    const { meta, strokes } = buildFixture();
    const text = serializeDoc(meta, strokes, APP);
    if (process.env.RISE_UPDATE_FIXTURES === '1' || !existsSync(path)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(path, text);
      console.log(`wrote ${path}; sceneHash 0x${sceneHash(strokes).toString(16).padStart(8, '0')}`);
    }
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  for (const fx of FIXTURES) {
    it(`${fx.file} (v${fx.version}) migrates to its golden sceneHash and re-serialises identically`, () => {
      const text = readFileSync(join(FIXTURE_DIR, fx.file), 'utf8');
      const raw = JSON.parse(text);
      expect(raw.version).toBe(fx.version);
      const { meta, strokes } = parseDoc(text);
      expect(strokes.length).toBe(fx.strokes);
      expect(sceneHash(strokes) >>> 0).toBe(fx.hash);
      if (fx.version === FORMAT_VERSION) expect(serializeDoc(meta, strokes, raw.app)).toBe(text);
      // and the round trip through a live document keeps everything
      const doc = createDoc(meta, strokes);
      expect(sceneHash(doc.ordered())).toBe(fx.hash);
    });
  }
});

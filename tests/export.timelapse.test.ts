/** export/timelapse.ts schedule, framing and encoder choice; export/mp4.ts box layout (DESIGN §8 Share timelapse). */
import { describe, it, expect } from 'vitest';
import type { StrokeRecipe } from '../src/core/types';
import { S } from '../src/core/types';
import { DEFAULT_CALIB } from '../src/ink/calib';
import { freezeRecipe } from '../src/doc/commands';
import { timeline } from '../src/app/replay';
import {
  MIME_CANDIDATES, MIN_SPEED, PLAY_MAX_MS, PLAY_MIN_MS, PORTRAIT_H, WIDTH, mimeExt, pickMime, timelapseFrame, timelapseSpeed,
} from '../src/export/timelapse';
import { muxMp4, nclx } from '../src/export/mp4';
import { exportFilename } from '../src/export/png';

function stroke(created: number, ms: number): StrokeRecipe {
  const samples = new Float32Array(2 * S.STRIDE);
  samples[S.STRIDE + S.X] = 10; samples[S.STRIDE + S.T] = ms;
  return freezeRecipe({
    id: `${created}`, created, origin: [0, 0], z: 1, rot: 0, seed: 1, device: 'pen', calib: DEFAULT_CALIB.pen,
    stroke: { nib: 'brush', size: 9 }, color: { ink: 'moss', k: 0, dh: 0, dL: 0, lch: null }, form: { form: 'line', v: 1, base: 0 },
    s0: 0, cut: 0, resume: null, samples, pools: new Float32Array(0), closed: false, radial: false, sym: null, xf: null,
  });
}

describe('timelapse duration rule', () => {
  it('plays at 1.5× while that lands within 5–10 s', () => {
    expect(timelapseSpeed(9000)).toBeCloseTo(1.5, 9);   // 6 s
    expect(timelapseSpeed(15000)).toBeCloseTo(1.5, 9);  // 10 s
  });
  it('stretches a short drawing to 5 s, never slower than half speed', () => {
    expect(9000 / timelapseSpeed(6000)).toBeCloseTo(PLAY_MIN_MS * 1.5, 6); // k = 1.2
    expect(6000 / timelapseSpeed(6000)).toBeCloseTo(PLAY_MIN_MS, 6);
    expect(timelapseSpeed(1000)).toBe(MIN_SPEED);
    expect(timelapseSpeed(0)).toBe(1);
  });
  it('compresses a long drawing to 10 s', () => {
    expect(120000 / timelapseSpeed(120000)).toBeCloseTo(PLAY_MAX_MS, 6);
  });
  it('drives the replay timeline: gaps capped, scaled by the timelapse speed', () => {
    const rs = [stroke(0, 3000), stroke(10000, 3000), stroke(13100, 3000)];
    const t = timeline(rs, timelapseSpeed);
    // 3000 + 250 + 3000 + 100 + 3000 = 9350 ms of drawing -> 1.5×
    expect(t.k).toBeCloseTo(1.5, 9);
    expect(t.total).toBeCloseTo(9350 / 1.5, 6);
    expect(Array.from(t.starts)).toEqual([0, 3250 / 1.5, 6350 / 1.5]);
    // Replay keeps its own rule
    expect(timeline(rs).k).toBe(1.5);
  });
});

describe('timelapse framing', () => {
  it('is square for wide or square drawings, centred with a 10 % margin', () => {
    const f = timelapseFrame({ x0: 100, y0: 50, x1: 600, y1: 250 });
    expect([f.width, f.height]).toEqual([WIDTH, WIDTH]);
    expect(f.pxPerDoc).toBeCloseTo(1080 / 600, 9);   // 500 wide + 2 × 50
    expect((f.box.x0 + f.box.x1) / 2).toBeCloseTo(350, 9);
    expect((f.box.y0 + f.box.y1) / 2).toBeCloseTo(150, 9);
    expect((f.box.x1 - f.box.x0) * f.pxPerDoc).toBeCloseTo(f.width, 6);
    expect((f.box.y1 - f.box.y0) * f.pxPerDoc).toBeCloseTo(f.height, 6);
  });
  it('is 4:5 portrait for a tall drawing', () => {
    const f = timelapseFrame({ x0: 0, y0: 0, x1: 300, y1: 600 });
    expect([f.width, f.height]).toEqual([WIDTH, PORTRAIT_H]);
    expect(f.pxPerDoc).toBeCloseTo(Math.min(1080 / 420, 1350 / 720), 9);
    expect(timelapseFrame({ x0: 0, y0: 0, x1: 300, y1: 320 }).height).toBe(WIDTH);
  });
  it('never magnifies past the cap', () => {
    const f = timelapseFrame({ x0: 0, y0: 0, x1: 10, y1: 10 }, 3);
    expect(f.pxPerDoc).toBe(3);
    expect((f.box.x1 - f.box.x0) * 3).toBeCloseTo(WIDTH, 6);
  });
});

describe('encoder choice', () => {
  it('prefers MP4/H.264, then WebM VP9, VP8', () => {
    expect(pickMime(() => true)).toBe(MIME_CANDIDATES[0]);
    expect(pickMime(t => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9');
    expect(pickMime(t => t === 'video/webm;codecs=vp8')).toBe('video/webm;codecs=vp8');
    expect(pickMime(t => t === 'video/mp4')).toBe('video/mp4');
    expect(pickMime(() => false)).toBe(null);
    expect(pickMime(() => { throw new Error('x'); })).toBe(null);
  });
  it('names the file by its container', () => {
    expect(mimeExt('video/mp4')).toBe('mp4');
    expect(mimeExt('video/webm;codecs=vp9')).toBe('webm');
    expect(exportFilename(new Date(2026, 9, 8, 9, 5), 'mp4')).toBe('rise-20261008-0905.mp4');
  });
});

// ---------------------------------------------------------------------------- mp4

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const fourcc = (b: Uint8Array, o: number): string => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf']);

/** Box tree as "path" -> [offset, size]; stsd/avc1 children are parsed too. */
function boxes(b: Uint8Array, from = 0, to = b.length, prefix = '', out = new Map<string, [number, number]>()): Map<string, [number, number]> {
  let o = from;
  while (o < to) {
    const size = u32(b, o), type = fourcc(b, o + 4);
    expect(size).toBeGreaterThanOrEqual(8);
    expect(o + size).toBeLessThanOrEqual(to);
    const path = prefix + type;
    out.set(path, [o, size]);
    if (CONTAINERS.has(type)) boxes(b, o + 8, o + size, path + '/', out);
    if (type === 'stsd') boxes(b, o + 16, o + size, path + '/', out);
    if (type === 'avc1') boxes(b, o + 8 + 78, o + size, path + '/', out);
    o += size;
  }
  return out;
}

describe('mp4 writer', () => {
  const avcC = Uint8Array.of(1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0);
  const samples = Array.from({ length: 65 }, (_, i) => ({ data: new Uint8Array(10 + (i % 7)).fill(i), key: i % 60 === 0, pts: Math.round(i * 1e6 / 30) }));
  const file = concat(muxMp4({ width: 1080, height: 1350, fps: 30, avcC, color: nclx({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }), samples }));
  const t = boxes(file);

  it('is ftyp, moov (fast start), mdat', () => {
    expect([...t.keys()].filter(k => !k.includes('/'))).toEqual(['ftyp', 'moov', 'mdat']);
    expect(fourcc(file, 8)).toBe('isom');
  });
  it('declares the size, duration and frame rate', () => {
    const [mvhd] = t.get('moov/mvhd')!;
    expect(u32(file, mvhd + 20)).toBe(1000);                    // timescale
    expect(u32(file, mvhd + 24)).toBe(Math.round(65 * 1000 / 30)); // duration, ms
    const [tkhd, tkhdSize] = t.get('moov/trak/tkhd')!;
    expect(u32(file, tkhd + tkhdSize - 8) / 65536).toBe(1080);
    expect(u32(file, tkhd + tkhdSize - 4) / 65536).toBe(1350);
    const [stts] = t.get('moov/trak/mdia/minf/stbl/stts')!;
    expect([u32(file, stts + 12), u32(file, stts + 16), u32(file, stts + 20)]).toEqual([1, 65, 3000]);
    const [avc1] = t.get('moov/trak/mdia/minf/stbl/stsd/avc1')!;
    expect([file[avc1 + 32] << 8 | file[avc1 + 33], file[avc1 + 34] << 8 | file[avc1 + 35]]).toEqual([1080, 1350]);
    expect(t.has('moov/trak/mdia/minf/stbl/stsd/avc1/avcC')).toBe(true);
    expect(t.has('moov/trak/mdia/minf/stbl/stsd/avc1/colr')).toBe(true);
    expect(t.has('moov/trak/mdia/minf/stbl/ctts')).toBe(false); // no reordering
  });
  it('lists the keyframes and points the chunk at the samples', () => {
    const [stss] = t.get('moov/trak/mdia/minf/stbl/stss')!;
    expect([u32(file, stss + 12), u32(file, stss + 16), u32(file, stss + 20)]).toEqual([2, 1, 61]);
    const [stsz] = t.get('moov/trak/mdia/minf/stbl/stsz')!;
    expect(u32(file, stsz + 16)).toBe(65);
    expect(u32(file, stsz + 20 + 4 * 3)).toBe(13);
    const [stco] = t.get('moov/trak/mdia/minf/stbl/stco')!;
    const off = u32(file, stco + 16);
    const [mdat, mdatSize] = t.get('mdat')!;
    expect(off).toBe(mdat + 8);
    expect(mdatSize).toBe(8 + samples.reduce((a, s) => a + s.data.length, 0));
    expect(file[off]).toBe(0);
    expect(file[off + 10]).toBe(1);  // sample 1 starts right after sample 0's ten bytes
  });
  it('writes signed composition offsets only when frames are reordered', () => {
    const re = [0, 2, 1, 3].map((f, i) => ({ data: new Uint8Array(4), key: i === 0, pts: Math.round(f * 1e6 / 30) }));
    const tt = boxes(concat(muxMp4({ width: 16, height: 16, fps: 30, avcC, samples: re })));
    expect(tt.has('moov/trak/mdia/minf/stbl/ctts')).toBe(true);
  });
  it('maps WebCodecs colour spaces to nclx code points', () => {
    expect(nclx({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true })).toEqual({ primaries: 1, transfer: 13, matrix: 0, full: true });
    expect(nclx({ primaries: 'bt709' })).toBe(null);
    expect(nclx(null)).toBe(null);
  });
});

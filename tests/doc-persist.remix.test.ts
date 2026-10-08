/** persist/remix.ts: v1 links still open, v2 rounds where it looks the same and re-encodes to the same link, size limit, damage (DESIGN §8). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { S } from '../src/core/types';
import type { StrokeRecipe } from '../src/core/types';
import { createDoc, newMeta } from '../src/doc/document';
import { parseDoc, sceneHash, serializeDoc } from '../src/doc/serialize';
import { carried, decodeRemix, encodeRemix, MAX_LINK, quantize, REMIX_BASE, remixPayload, remixUrl } from '../src/persist/remix';
import { looksSame } from '../src/app/remix';
import { randomRecipe, seeded } from './doc-persist.helpers';

const APP = 'rise-sketch@0.1.0';
/** Mirror and radial copies, NaN pressure, pools and a custom ink. */
const V2 = readFileSync(join(__dirname, 'fixtures', 'doc-v2.rise'), 'utf8');
/** V2 as a version-1 link payload (written by the PR #14 encoder). */
const LINK_V1 = readFileSync(join(__dirname, 'fixtures', 'remix-v1.txt'), 'utf8').trim();
const always = (): boolean => true;

function docOf(n: number, seed = 7) {
  const rand = seeded(seed);
  const strokes = Array.from({ length: n }, (_, i) => randomRecipe(rand, 'r' + i.toString(36).padStart(4, '0'), { pools: i % 3 === 0 }));
  return createDoc(newMeta(1759600000000, 42, 'remixdoc'), strokes);
}

/** Open a link the way the app does and make the link of what opened. */
async function relink(url: string, judge = looksSame): Promise<string | null> {
  const { meta, strokes } = parseDoc(await decodeRemix(remixPayload(new URL(url).hash)!));
  return remixUrl(createDoc(meta, strokes), APP, judge);
}

describe('remix links', () => {
  it('open version 1 links exactly, as before', async () => {
    const text = await decodeRemix(LINK_V1);
    expect(text).toBe(V2);
    expect(sceneHash(parseDoc(text).strokes)).toBe(sceneHash(parseDoc(V2).strokes));
  });

  it('pack the .rise text losslessly (rounding is quantize’s job)', async () => {
    expect(await decodeRemix(await encodeRemix(V2))).toBe(V2);
    const { meta, strokes } = parseDoc(V2);
    const rounded = serializeDoc(meta, strokes.map(r => quantize(r) ?? r), APP);
    expect(await decodeRemix(await encodeRemix(rounded))).toBe(rounded);
  });

  it('round a recipe onto grids and keep everything discrete exact', () => {
    for (const r of docOf(20).ordered()) {
      const q = quantize(r);
      if (!q) continue;
      expect([q.id, q.seed, q.form, q.stroke, q.color, q.device, q.cut, q.s0, q.z]).toEqual([r.id, r.seed, r.form, r.stroke, r.color, r.device, r.cut, r.s0, r.z]);
      expect(q.pools).toBe(r.pools);
      const sp = (a: number, b: number): number => Math.abs(a - b) * r.z;
      for (let o = 0; o < r.samples.length; o += S.STRIDE) {
        expect(sp(q.samples[o + S.X], r.samples[o + S.X])).toBeLessThanOrEqual(1 / 32);
        expect(sp(q.samples[o + S.Y], r.samples[o + S.Y])).toBeLessThanOrEqual(1 / 32);
        if (o) expect(q.samples[o + S.T]).toBeGreaterThan(q.samples[o - S.STRIDE + S.T]);
      }
      expect(quantize(q)!.samples).toEqual(q.samples);  // idempotent
    }
  });

  it('refuse a rounding that would make two sample times meet', () => {
    const r = docOf(1).ordered()[0];
    const samples = new Float32Array(r.samples.length * 2);
    samples.set(r.samples);
    samples.set(r.samples, r.samples.length);
    for (let o = 0, i = 0; o < samples.length; o += S.STRIDE, i++) samples[o + S.T] = i * 0.3;
    expect(quantize({ ...r, samples })).toBeNull();
  });

  it('carry a recipe exact when no rounding looks the same, and leave a rounded one as it is', () => {
    const r = docOf(1).ordered()[0];
    expect(carried(r, () => false)).toBe(r);
    const q = carried(r, always);
    expect(q).not.toBe(r);
    expect(carried(q, () => { throw new Error('a recipe already on a grid is not judged again'); })).toBe(q);
  });

  it('give the same link when the opened drawing is shared again', async () => {
    const doc = docOf(12);
    const url = await remixUrl(doc, APP, looksSame);
    expect(url!.startsWith(REMIX_BASE + '#r=')).toBe(true);
    expect(await relink(url!)).toBe(url);
    // the remix is deterministic but not the sender's bits
    const opened = parseDoc(await decodeRemix(remixPayload(new URL(url!).hash)!));
    expect(opened.strokes.length).toBe(12);
    expect(sceneHash(opened.strokes)).not.toBe(sceneHash(doc.ordered()));
    // a fixture with symmetry copies, NaN pressure and pools, judged by cooking
    const { meta, strokes } = parseDoc(V2);
    const fixture = await remixUrl(createDoc(meta, strokes), APP, looksSame);
    expect(await relink(fixture!)).toBe(fixture);
  });

  it('are smaller than version 1 links', async () => {
    const doc = docOf(12);
    const v2 = (await remixUrl(doc, APP, always))!.length;
    const v1 = (REMIX_BASE + '#r=' + await encodeRemix(serializeDoc(doc.meta, doc.ordered(), APP))).length;
    expect(v2).toBeLessThan(v1 * 0.6);
  });

  it('store a symmetry copy’s shared arrays once', async () => {
    const one = docOf(1);
    const r = one.ordered()[0];
    const copies = createDoc(one.meta, [r, ...[1, 2, 3, 4, 5].map((i): StrokeRecipe => ({ ...r, id: r.id + i, xf: Float64Array.of(1, 0, 0, 1, i, 0) }))]);
    const a = (await remixUrl(one, APP, always))!.length;
    const b = (await remixUrl(copies, APP, always))!.length;
    expect(b).toBeLessThan(a + 600);  // five more stroke headers, no more sample data
  });

  it('is URL-safe and fragment-only', async () => {
    const p = await encodeRemix(V2);
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(remixPayload('#r=' + p)).toBe(p);
    expect(remixPayload('')).toBeNull();
    expect(remixPayload('#x=1')).toBeNull();
  });

  it('refuses a drawing whose link would exceed MAX_LINK', async () => {
    expect(await remixUrl(docOf(600), APP, always)).toBeNull();
  });

  it('rejects truncated, corrupted and foreign payloads', async () => {
    const { meta, strokes } = parseDoc(V2);
    for (const p of [await encodeRemix(V2), (await remixUrl(createDoc(meta, strokes), APP, always))!.split('#r=')[1], LINK_V1]) {
      const bad = [
        p.slice(0, p.length >> 1),                       // truncated
        p.slice(0, 40) + (p[40] === 'A' ? 'B' : 'A') + p.slice(41), // one character changed (gzip CRC)
        '', '!!!!', 'abc', 'x'.repeat(MAX_LINK + 1),
        Buffer.from('{"format":"rise"}').toString('base64url'),  // not gzip
      ];
      for (const s of bad) await expect(decodeRemix(s), s.slice(0, 20)).rejects.toThrow();
    }
  });

  it('rejects an unknown version and a damaged grid blob that survives gzip', async () => {
    const gz = async (bytes: Uint8Array): Promise<string> => Buffer.from(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()).toString('base64url');
    const head = new TextEncoder().encode('{"samples":0}');
    const raw = (version: number, blob: number[]): Uint8Array => Uint8Array.from([version, ...head, 0, blob.length, 0, 0, 0, ...blob]);
    await expect(decodeRemix(await gz(raw(3, [1, 0])))).rejects.toThrow(/version/);
    await expect(decodeRemix(await gz(raw(2, [1, 5])))).rejects.toThrow(/damaged/);      // rows but no values
    await expect(decodeRemix(await gz(raw(2, [1, 1, ...Array(18).fill(0), 7])))).rejects.toThrow(/damaged/); // trailing bytes
  });
});

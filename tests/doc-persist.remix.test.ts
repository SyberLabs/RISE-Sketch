/** persist/remix.ts: remix links round-trip a drawing bit for bit, stay under MAX_LINK, and reject damage (DESIGN §8). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDoc, newMeta } from '../src/doc/document';
import { parseDoc, sceneHash, serializeDoc } from '../src/doc/serialize';
import { decodeRemix, encodeRemix, MAX_LINK, REMIX_BASE, remixPayload, remixUrl } from '../src/persist/remix';
import { randomRecipe, seeded } from './doc-persist.helpers';

const APP = 'rise-sketch@0.1.0';
/** Mirror and radial copies, NaN pressure, pools and a custom ink. */
const V2 = readFileSync(join(__dirname, 'fixtures', 'doc-v2.rise'), 'utf8');

function docOf(n: number, seed = 7) {
  const rand = seeded(seed);
  const strokes = Array.from({ length: n }, (_, i) => randomRecipe(rand, 'r' + i.toString(36).padStart(4, '0'), { pools: i % 3 === 0 }));
  return createDoc(newMeta(1759600000000, 42, 'remixdoc'), strokes);
}

describe('remix links', () => {
  it('round-trip the .rise text exactly, so the drawing cooks identically', async () => {
    const back = await decodeRemix(await encodeRemix(V2));
    expect(back).toBe(V2);
    expect(sceneHash(parseDoc(back).strokes)).toBe(sceneHash(parseDoc(V2).strokes));
  });

  it('round-trip a generated document and its scene hash', async () => {
    const doc = docOf(12);
    const url = await remixUrl(doc, APP);
    expect(url).not.toBeNull();
    expect(url!.startsWith(REMIX_BASE + '#r=')).toBe(true);
    const text = await decodeRemix(remixPayload(new URL(url!).hash)!);
    expect(text).toBe(serializeDoc(doc.meta, doc.ordered(), APP));
    expect(sceneHash(parseDoc(text).strokes)).toBe(sceneHash(doc.ordered()));
  });

  it('store a symmetry copy’s shared arrays once', async () => {
    const one = docOf(1);
    const r = one.ordered()[0];
    const copies = createDoc(one.meta, [r, ...[1, 2, 3, 4, 5].map(i => ({ ...r, id: r.id + i, xf: Float64Array.of(1, 0, 0, 1, i, 0) }))]);
    const a = (await encodeRemix(serializeDoc(one.meta, one.ordered(), APP))).length;
    const b = (await encodeRemix(serializeDoc(copies.meta, copies.ordered(), APP))).length;
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
    expect(await remixUrl(docOf(400), APP)).toBeNull();
  });

  it('rejects truncated, corrupted and foreign payloads', async () => {
    const p = await encodeRemix(V2);
    const bad = [
      p.slice(0, p.length >> 1),                       // truncated
      p.slice(0, 40) + (p[40] === 'A' ? 'B' : 'A') + p.slice(41), // one character changed (gzip CRC)
      '', '!!!!', 'abc', 'x'.repeat(MAX_LINK + 1),
      Buffer.from('{"format":"rise"}').toString('base64url'),  // not gzip
    ];
    for (const s of bad) await expect(decodeRemix(s), s.slice(0, 20)).rejects.toThrow();
  });
});

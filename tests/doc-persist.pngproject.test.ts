/** persist/pngproject.ts: the project rides in an iTXt chunk of the exported PNG (DESIGN §8 Export). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 as zcrc, deflateSync } from 'node:zlib';
// @ts-expect-error upng-js ships no types
import UPNG from 'upng-js';
import { parseDoc, sceneHash } from '../src/doc/serialize';
import { addITXt, crc32, isPng, KEYWORD, projectOf, readITXt, withProject } from '../src/persist/pngproject';

const V2 = readFileSync(join(__dirname, 'fixtures', 'doc-v2.rise'), 'utf8');
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A real 3×2 RGBA PNG, built with node:zlib (independent of the code under test). */
function png(): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(zcrc(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rows = new Uint8Array(2 * (1 + 3 * 4)).map((_, i) => (i % 13 === 0 ? 0 : (i * 37) & 255)); // filter byte 0 per row
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array(0)),
  ]));
}
const bytesOf = async (b: Blob): Promise<Uint8Array> => new Uint8Array(await b.arrayBuffer());

describe('crc32', () => {
  it('matches the reference values', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
    expect(crc32(ascii('IEND'))).toBe(0xae426082);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('iTXt chunk', () => {
  it('round-trips and leaves a PNG that decoders still read pixel for pixel', () => {
    const src = png();
    const out = addITXt(src, KEYWORD, false, ascii('héllo'));
    expect(isPng(out)).toBe(true);
    expect(out.length).toBe(src.length + 12 + KEYWORD.length + 5 + ascii('héllo').length);
    expect(Array.from(out.subarray(out.length - 12))).toEqual(Array.from(src.subarray(src.length - 12))); // IEND last
    const got = readITXt(out, KEYWORD)!;
    expect(got.compressed).toBe(false);
    expect(new TextDecoder().decode(got.text)).toBe('héllo');
    const a = UPNG.decode(src.slice().buffer), b = UPNG.decode(out.slice().buffer);
    expect(new Uint8Array(UPNG.toRGBA8(b)[0])).toEqual(new Uint8Array(UPNG.toRGBA8(a)[0]));
  });

  it('reads past a language tag and translated keyword', () => {
    const out = addITXt(png(), KEYWORD, false, ascii(''));
    // splice "en\0Skizze\0" in place of the two empty fields by building the chunk by hand
    const body = ascii(`iTXt${KEYWORD}\0\0\0en\0Skizze\0text`);
    const chunk = new Uint8Array(body.length + 8);
    new DataView(chunk.buffer).setUint32(0, body.length - 4);
    chunk.set(body, 4);
    new DataView(chunk.buffer).setUint32(4 + body.length, crc32(body));
    const p = png(), end = p.length - 12;
    const hand = new Uint8Array([...p.subarray(0, end), ...chunk, ...p.subarray(end)]);
    expect(new TextDecoder().decode(readITXt(hand, KEYWORD)!.text)).toBe('text');
    expect(readITXt(out, 'other')).toBeNull();
  });

  it('a foreign PNG carries no project; damage and non-PNGs throw', async () => {
    expect(await projectOf(png())).toBeNull();
    const out = addITXt(png(), KEYWORD, false, ascii('{}'));
    const bad = out.slice();
    bad[bad.length - 20] ^= 1; // inside the iTXt chunk: its CRC no longer matches
    await expect(projectOf(bad)).rejects.toThrow(/CRC/);
    await expect(projectOf(out.subarray(0, out.length - 30))).rejects.toThrow(/truncated/);
    await expect(projectOf(ascii('{"format":"rise"}'))).rejects.toThrow(/not a PNG/);
  });
});

describe('withProject / projectOf', () => {
  it('carries the exact .rise, compressed, so the drawing cooks bit-identically', async () => {
    const blob = await withProject(new Blob([png() as BlobPart], { type: 'image/png' }), V2);
    expect(blob.type).toBe('image/png');
    const bytes = await bytesOf(blob);
    expect(readITXt(bytes, KEYWORD)!.compressed).toBe(true);
    expect(bytes.length - png().length).toBeLessThan(V2.length);
    const text = await projectOf(bytes);
    expect(text).toBe(V2);
    expect(sceneHash(parseDoc(text!).strokes)).toBe(sceneHash(parseDoc(V2).strokes));
  });
});

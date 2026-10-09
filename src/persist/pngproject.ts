/**
 * Remixable images (DESIGN §8 Export): the `.rise` text rides inside the exported PNG as one
 * standard `iTXt` chunk, keyword `rise-sketch`, zlib-compressed (`CompressionStream('deflate')`,
 * uncompressed where that is missing). Viewers ignore the chunk, so the file is still just an image;
 * opened in RISE Sketch it is the exact drawing (the same `.rise`, so the same `sceneHash`).
 *
 * The chunk goes just before `IEND`. Layout (PNG spec §11.3.4.5): keyword, 0, compression flag,
 * method 0, empty language tag, 0, empty translated keyword, 0, text.
 */

export const KEYWORD = 'rise-sketch';
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO 3309, as PNG uses it). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const isPng = (b: Uint8Array): boolean => b.length >= 8 && SIG.every((v, i) => b[i] === v);

interface Chunk { type: string; start: number; data: Uint8Array }

/** The chunks of a PNG, in order; throws on a bad signature, a truncated chunk or a bad CRC. */
function chunks(png: Uint8Array): Chunk[] {
  if (!isPng(png)) throw new Error('not a PNG');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  for (let p = 8; p < png.length;) {
    if (p + 12 > png.length) throw new Error('truncated PNG');
    const len = dv.getUint32(p);
    if (p + 12 + len > png.length) throw new Error('truncated PNG');
    const typed = png.subarray(p + 4, p + 8 + len);
    if (crc32(typed) !== dv.getUint32(p + 8 + len)) throw new Error('PNG chunk CRC mismatch');
    const type = String.fromCharCode(...typed.subarray(0, 4));
    out.push({ type, start: p, data: typed.subarray(4) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** `png` with an `iTXt` chunk (keyword, compression flag, text bytes) inserted before `IEND`. */
export function addITXt(png: Uint8Array, keyword: string, compressed: boolean, text: Uint8Array): Uint8Array<ArrayBuffer> {
  const end = chunks(png).find(c => c.type === 'IEND');
  if (!end) throw new Error('PNG without IEND');
  const head = new TextEncoder().encode(`iTXt${keyword}\0`);
  const body = new Uint8Array(head.length + 4 + text.length);
  body.set(head);
  body[head.length] = compressed ? 1 : 0; // then method 0, empty language tag and translated keyword
  body.set(text, head.length + 4);
  const out = new Uint8Array(png.length + body.length + 8);
  const dv = new DataView(out.buffer);
  out.set(png.subarray(0, end.start));
  dv.setUint32(end.start, body.length - 4);
  out.set(body, end.start + 4);
  dv.setUint32(end.start + 4 + body.length, crc32(body));
  out.set(png.subarray(end.start), end.start + 8 + body.length);
  return out;
}

/** The first `iTXt` chunk named `keyword`: its compression flag and text bytes, or null. */
export function readITXt(png: Uint8Array, keyword: string): { compressed: boolean; text: Uint8Array } | null {
  const key = new TextEncoder().encode(keyword + '\0');
  for (const c of chunks(png)) {
    if (c.type !== 'iTXt' || !key.every((v, i) => c.data[i] === v)) continue;
    let p = key.length + 2;
    for (let z = 0; z < 2; z++) { p = c.data.indexOf(0, p); if (p < 0) throw new Error('bad iTXt chunk'); p++; }
    return { compressed: c.data[key.length] === 1, text: c.data.subarray(p) };
  }
  return null;
}

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t)).arrayBuffer());
}

/** The exported image with the project embedded. */
export async function withProject(png: Blob, riseText: string): Promise<Blob> {
  const text = new TextEncoder().encode(riseText);
  const zip = typeof CompressionStream !== 'undefined';
  const body = zip ? await pipe(text, new CompressionStream('deflate')) : text;
  return new Blob([addITXt(new Uint8Array(await png.arrayBuffer()), KEYWORD, zip, body)], { type: 'image/png' });
}

/** The `.rise` text a PNG carries, or null when it carries none. Throws on a damaged PNG or chunk. */
export async function projectOf(png: Uint8Array): Promise<string | null> {
  const got = readITXt(png, KEYWORD);
  if (!got) return null;
  const bytes = got.compressed ? await pipe(got.text, new DecompressionStream('deflate')) : got.text;
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

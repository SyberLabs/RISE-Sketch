/**
 * Remix links (DESIGN §8, §13): the whole drawing travels in the URL fragment, `#r=<payload>`, so
 * it never reaches a server and needs none. Opening one loads the drawing as a new document.
 *
 * The payload is the `.rise` text with its typed arrays pulled out as binary, gzipped, then
 * base64url. Float32 sample data is noisy in its low bits, so plain gzip of the base64 text
 * barely halves it; the arrays are stored instead as column-wise deltas of their 32-bit words,
 * split into byte planes, which gzips about 45 % smaller. The transform is lossless word for
 * word, so every float (NaN payloads, -0) comes back bit-exact and the drawing cooks identically.
 * Identical arrays are stored once: a symmetry copy shares its stroke's samples, pools and resume.
 *
 * Layout before gzip: version byte (1) · the `.rise` text with each array replaced by its blob
 * index (`"samples":3`) · NUL · per blob: u32 LE byte length, then the packed bytes.
 */
import type { Doc } from '../core/types';
import { base64ToBytes, bytesToBase64, serializeDoc } from '../doc/serialize';

/** Where remix links point: the shipped app, whatever page made the link. */
export const REMIX_BASE = 'https://sketch.syberlabs.io/';
/**
 * Longest link Rise makes (characters). 32 KiB opens in every browser and survives Slack,
 * WhatsApp, iMessage and email; longer links start to be cut by chat apps. Past it the
 * person is told to save the project instead.
 */
export const MAX_LINK = 32768;

const VERSION = 1;
const ARRAY_RE = /"(samples|pools|resume)":"([A-Za-z0-9+/]+=*)"/g;
const INDEX_RE = /"(samples|pools|resume)":(\d+)/g;
/** Row widths (the writer guarantees whole rows); they only steer compression. */
const STRIDE: Record<string, number> = { samples: 9, pools: 4, resume: 1 };

/** Column-wise word deltas, as byte planes (lossless). */
function pack(bytes: Uint8Array, key: string): Uint8Array {
  const n = bytes.length >>> 2, s = STRIDE[key], rows = n / s;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array(n * 4);
  let i = 0;
  for (let c = 0; c < s; c++) {
    let prev = 0;
    for (let r = 0; r < rows; r++, i++) {
      const w = v.getUint32((r * s + c) * 4, true);
      const d = (w - prev) >>> 0;
      prev = w;
      out[i] = d; out[n + i] = d >>> 8; out[2 * n + i] = d >>> 16; out[3 * n + i] = d >>> 24;
    }
  }
  return out;
}

function unpack(p: Uint8Array, key: string): Uint8Array {
  const n = p.length >>> 2, s = STRIDE[key], rows = n / s;
  const out = new Uint8Array(n * 4);
  const v = new DataView(out.buffer);
  let i = 0;
  for (let c = 0; c < s; c++) {
    let prev = 0;
    for (let r = 0; r < rows; r++, i++) {
      prev = (prev + (p[i] | p[n + i] << 8 | p[2 * n + i] << 16 | p[3 * n + i] << 24)) >>> 0;
      v.setUint32((r * s + c) * 4, prev, true);
    }
  }
  return out;
}

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t)).arrayBuffer());
}

const toB64url = (b: Uint8Array): string => bytesToBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Uint8Array => base64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/'));

/** `.rise` text -> the base64url payload of a remix link. */
export async function encodeRemix(text: string): Promise<string> {
  const blobs: Uint8Array[] = [];
  const index = new Map<string, number>();
  const body = text.replace(ARRAY_RE, (_, key: string, b64: string) => {
    let i = index.get(key + b64);
    if (i === undefined) { i = blobs.length; index.set(key + b64, i); blobs.push(pack(base64ToBytes(b64), key)); }
    return `"${key}":${i}`;
  });
  const head = new TextEncoder().encode(body);
  let size = 1 + head.length + 1;
  for (const b of blobs) size += 4 + b.length;
  const raw = new Uint8Array(size);
  const v = new DataView(raw.buffer);
  raw[0] = VERSION;
  raw.set(head, 1);
  let o = head.length + 2;
  for (const b of blobs) { v.setUint32(o, b.length, true); raw.set(b, o + 4); o += 4 + b.length; }
  return toB64url(await pipe(raw, new CompressionStream('gzip')));
}

/** Inverse of encodeRemix: the `.rise` text (unvalidated: parseDoc checks it). Throws on a damaged payload. */
export async function decodeRemix(payload: string): Promise<string> {
  if (payload.length > MAX_LINK) throw new Error('remix link too long');  // a bound on what inflates
  const raw = await pipe(fromB64url(payload), new DecompressionStream('gzip'));
  if (raw[0] !== VERSION) throw new Error('unknown remix link version');
  // gzip's CRC already rejects damage; what survives it is checked by parseDoc
  const nul = raw.indexOf(0, 1);
  const blobs: Uint8Array[] = [];
  const v = new DataView(raw.buffer);
  for (let o = nul + 1, len = 0; o < raw.length; o += 4 + len) {
    len = v.getUint32(o, true);
    blobs.push(raw.subarray(o + 4, o + 4 + len));
  }
  const body = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(1, nul));
  return body.replace(INDEX_RE, (_, key: string, i: string) => {
    const b = blobs[Number(i)];
    if (!b) throw new Error('damaged remix link');
    return `"${key}":"${bytesToBase64(unpack(b, key))}"`;
  });
}

/** The remix link for a document, or null when it would be longer than MAX_LINK. */
export async function remixUrl(doc: Doc, app: string): Promise<string | null> {
  const url = REMIX_BASE + '#r=' + await encodeRemix(serializeDoc(doc.meta, doc.ordered(), app));
  return url.length <= MAX_LINK ? url : null;
}

/** The payload of a location hash that carries a drawing (`#r=...`), else null. */
export function remixPayload(hash: string): string | null {
  return hash.startsWith('#r=') ? hash.slice(3) : null;
}

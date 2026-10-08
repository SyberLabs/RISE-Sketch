/**
 * Remix links (DESIGN §8, §13): the whole drawing travels in the URL fragment, `#r=<payload>`, so
 * it never reaches a server and needs none. Opening one loads the drawing as a new document.
 *
 * Version 2 (what Rise writes): before encoding, each recipe's input is rounded to a grid finer
 * than anyone can see (`quantize`: positions to 1/16 sp, time, pressure, tilt and crowding to a
 * few hundredths of their range; seeds and every discrete field stay exact). The recipient cooks
 * those rounded samples, so the remix looks the same as the sender's drawing but is not bit-
 * identical to it (its `sceneHash` differs); it is deterministic, and rounding twice changes
 * nothing, so a remix of a remix carries the same link. Forms whose growth amplifies any change
 * of input (`EXACT_FORMS`) keep their recipes exact.
 *
 * The payload is the `.rise` text with its typed arrays pulled out as binary, gzipped, then
 * base64url. Each array is stored losslessly, as one of:
 *  - grid (v2): per column, the coarsest power-of-two grid its values sit on, then the
 *    zigzag varint deltas of the grid indexes (0 stands for NaN). Rounded samples cost about
 *    one byte per value;
 *  - words (v1, and v2 arrays the grid cannot hold): column-wise deltas of the 32-bit words,
 *    split into byte planes.
 * Identical arrays are stored once: a symmetry copy shares its stroke's samples, pools and resume.
 *
 * Layout before gzip: version byte · the `.rise` text with each array replaced by its blob index
 * (`"samples":3`) · NUL · per blob: u32 LE byte length, then (v2 only) a mode byte (0 words,
 * 1 grid) and the packed bytes. Version 1 links (all words, no mode byte) open forever.
 */
import type { Calib, Doc, StrokeRecipe } from '../core/types';
import { S } from '../core/types';
import { base64ToBytes, bytesToBase64, sceneHash, serializeDoc } from '../doc/serialize';

/** Where remix links point: the shipped app, whatever page made the link. */
export const REMIX_BASE = 'https://sketch.syberlabs.io/';
/**
 * Longest link Rise makes (characters). 32 KiB opens in every browser and survives Slack,
 * WhatsApp, iMessage and email; longer links start to be cut by chat apps. Past it the
 * person is told to save the project instead.
 */
export const MAX_LINK = 32768;

const VERSION = 2;
const ARRAY_RE = /"(samples|pools|resume)":"([A-Za-z0-9+/]+=*)"/g;
const INDEX_RE = /"(samples|pools|resume)":(\d+)/g;
/** Row widths (the writer guarantees whole rows). */
const STRIDE: Record<string, number> = { samples: S.STRIDE, pools: 4, resume: 1 };

// ================================================================ rounding (measured, DESIGN §13 #10)

/**
 * Grids of the sample columns, coarse first. X and Y are in sp at the stroke's zoom (then a power
 * of two in doc units, so every rounded value is exact in Float32 and short in text); time in ms.
 */
const TIERS = [
  { xy: 1 / 16, t: 1, p: 2 ** -10, ang: 2 ** -8, r: 1 / 4, c: 2 ** -8 },
  { xy: 1 / 128, t: 1 / 8, p: 2 ** -12, ang: 2 ** -10, r: 1 / 16, c: 2 ** -10 },
  { xy: 1 / 1024, t: 1 / 64, p: 2 ** -16, ang: 2 ** -14, r: 1 / 64, c: 2 ** -16 },
];
type Grid = typeof TIERS[number];
/** Significant digits kept of the calibration (a pressure curve and speeds). */
const CALIB_DIGITS = 4;

/** Largest power of two ≤ x (x > 0, finite), by exact doubling and halving. */
function pow2Floor(x: number): number {
  let p = 1;
  while (p > x) p /= 2;
  while (p * 2 <= x) p *= 2;
  return p;
}

const onGrid = (v: number, q: number): number => Math.round(v / q) * q;
const sig = (v: number): number => (Number.isFinite(v) ? Number(v.toPrecision(CALIB_DIGITS)) : v);

/**
 * The recipe rounded to one grid: samples, origin, the copy's offset and the calibration; seeds
 * and every discrete field stay exact. Null when two sample times would meet (input faster than
 * the time grid), since time must keep increasing and must not be stretched.
 */
export function quantize(r: StrokeRecipe, g: Grid = TIERS[0]): StrokeRecipe | null {
  const pos = pow2Floor(g.xy / r.z);
  const q = [pos, pos, g.t, g.p, g.ang, g.ang, g.r, g.c, g.c];
  const src = r.samples, out = new Float32Array(src.length);
  for (let o = 0; o < src.length; o += S.STRIDE) {
    for (let c = 0; c < S.STRIDE; c++) {
      const v = src[o + c];
      out[o + c] = Number.isFinite(v) ? onGrid(v, q[c]) : NaN;
    }
    if (o > 0 && !(out[o + S.T] > out[o - S.STRIDE + S.T])) return null;
  }
  const c = r.calib;
  const calib: Calib = { lo: sig(c.lo), hi: sig(c.hi), gamma: sig(c.gamma), flat: sig(c.flat), vMed: sig(c.vMed), jitter: sig(c.jitter), fcMin: sig(c.fcMin) };
  let xf = r.xf;
  if (xf) { xf = xf.slice(); xf[4] = onGrid(xf[4], pos); xf[5] = onGrid(xf[5], pos); }
  return { ...r, origin: [onGrid(r.origin[0], pos), onGrid(r.origin[1], pos)], calib, xf, samples: out };
}

/** Whether a rounded recipe still looks like the original (app/remix.ts cooks both and compares). */
export type LooksSame = (original: StrokeRecipe, rounded: StrokeRecipe) => boolean;

/**
 * What a remix carries of one recipe: the coarsest rounding that still looks the same, else the
 * recipe exact. A recipe already on a grid (a remix being remixed) stays as it is, so encoding a
 * decoded link gives the same link.
 */
export function carried(r: StrokeRecipe, looksSame: LooksSame): StrokeRecipe {
  const rounded = TIERS.map(g => quantize(r, g));
  const h = sceneHash([r]);
  if (rounded.some(q => q && sceneHash([q]) === h)) return r;
  return rounded.find(q => q && looksSame(r, q)) ?? r;
}

// ================================================================ packing

/** v1 words: column-wise deltas of the 32-bit words, as byte planes (lossless). */
function packWords(bytes: Uint8Array, key: string): Uint8Array {
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

function unpackWords(p: Uint8Array, key: string): Uint8Array {
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

/** Grid indexes stay well inside exact integers, deltas and zigzag included. */
const MAX_K = 2 ** 48;

function pushVarint(out: number[], v: number): void {
  while (v >= 128) { out.push(v % 128 + 128); v = Math.floor(v / 128); }
  out.push(v);
}
const zigzag = (d: number): number => (d >= 0 ? 2 * d : -2 * d - 1);
const unzigzag = (u: number): number => (u % 2 ? -(u + 1) / 2 : u / 2);

/** 2^e, exactly (Math.pow is not specified to be exact). */
function pow2(e: number): number {
  let p = 1;
  for (; e > 0; e--) p *= 2;
  for (; e < 0; e++) p /= 2;
  return p;
}

/** Exponent of the coarsest power-of-two grid a finite nonzero value sits on. */
function gridExp(v: number): number {
  let e = 0;
  while (!Number.isInteger(v)) { v *= 2; e--; }
  while (v % 2 === 0) { v /= 2; e++; }
  return e;
}

/** Grid indexes of one column (null = NaN) as varints: 0 = NaN, else zigzag(residual) + 1, the
 *  residual being the change from the last index (order 1) or from the line through the last two (order 2). */
function residuals(ks: (number | null)[], order: number): number[] {
  const out: number[] = [];
  let k1 = 0, k0 = 0;
  for (const k of ks) {
    if (k === null) { out.push(0); continue; }
    pushVarint(out, zigzag(order === 2 ? k - 2 * k1 + k0 : k - k1) + 1);
    k0 = k1; k1 = k;
  }
  return out;
}

/**
 * Grid packing (lossless): row count, then per column a header (zigzag of the grid exponent,
 * times 2, plus 1 for second order) and the residuals, whichever order is shorter: second order
 * suits smooth paths and steady clocks, first order steps (crowding) and constants (tilt).
 * Null when a column holds ±Infinity, -0 or too fine a spread.
 */
function packGrid(a: Float32Array, stride: number): Uint8Array | null {
  const rows = a.length / stride, out: number[] = [];
  pushVarint(out, rows);
  for (let c = 0; c < stride; c++) {
    let e = Infinity;
    for (let r = 0; r < rows; r++) {
      const v = a[r * stride + c];
      if (v !== v) continue;
      if (!Number.isFinite(v) || Object.is(v, -0)) return null;
      if (v !== 0) e = Math.min(e, gridExp(v));
    }
    if (e === Infinity) e = 0;
    const unit = pow2(-e), ks: (number | null)[] = [];
    for (let r = 0; r < rows; r++) {
      const v = a[r * stride + c];
      if (Math.abs(v * unit) > MAX_K) return null;
      ks.push(v === v ? v * unit : null);
    }
    const one = residuals(ks, 1), two = residuals(ks, 2);
    pushVarint(out, zigzag(e) * 2 + (two.length < one.length ? 1 : 0));
    for (const b of two.length < one.length ? two : one) out.push(b);
  }
  return Uint8Array.from(out);
}

function unpackGrid(p: Uint8Array, stride: number): Float32Array {
  let i = 0;
  const next = (): number => {
    let v = 0, m = 1, b: number;
    do {
      if (i >= p.length || m > MAX_K * 256) throw new Error('damaged remix link');
      b = p[i++];
      v += (b & 127) * m;
      m *= 128;
    } while (b & 128);
    return v;
  };
  const rows = next();
  if (rows * stride > p.length) throw new Error('damaged remix link');
  const a = new Float32Array(rows * stride);
  for (let c = 0; c < stride; c++) {
    const head = next(), order = head % 2 + 1, unit = pow2(unzigzag((head - head % 2) / 2));
    let k1 = 0, k0 = 0;
    for (let r = 0; r < rows; r++) {
      const u = next();
      if (u === 0) { a[r * stride + c] = NaN; continue; }
      const k = unzigzag(u - 1) + (order === 2 ? 2 * k1 - k0 : k1);
      k0 = k1; k1 = k;
      a[r * stride + c] = k * unit;
    }
  }
  if (i !== p.length) throw new Error('damaged remix link');
  return a;
}

/** Float32 array <-> little-endian bytes (the `.rise` base64 payload). */
const f32ToBytes = (a: Float32Array): Uint8Array => {
  const b = new Uint8Array(a.length * 4), v = new DataView(b.buffer);
  for (let i = 0; i < a.length; i++) v.setFloat32(i * 4, a[i], true);
  return b;
};
const bytesToF32 = (b: Uint8Array): Float32Array => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), a = new Float32Array(b.length >>> 2);
  for (let i = 0; i < a.length; i++) a[i] = v.getFloat32(i * 4, true);
  return a;
};

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t)).arrayBuffer());
}

const toB64url = (b: Uint8Array): string => bytesToBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Uint8Array => base64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/'));

/** `.rise` text -> the base64url payload of a (version 2) remix link. Lossless: rounding is `quantize`'s job. */
export async function encodeRemix(text: string): Promise<string> {
  const blobs: Uint8Array[] = [];
  const index = new Map<string, number>();
  const body = text.replace(ARRAY_RE, (_, key: string, b64: string) => {
    let i = index.get(key + b64);
    if (i === undefined) {
      i = blobs.length;
      index.set(key + b64, i);
      const bytes = base64ToBytes(b64);
      const grid = packGrid(bytesToF32(bytes), STRIDE[key]);
      const packed = grid ?? packWords(bytes, key);
      const blob = new Uint8Array(1 + packed.length);
      blob[0] = grid ? 1 : 0;
      blob.set(packed, 1);
      blobs.push(blob);
    }
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

/** Inverse of encodeRemix (versions 1 and 2): the `.rise` text (unvalidated: parseDoc checks it). Throws on a damaged payload. */
export async function decodeRemix(payload: string): Promise<string> {
  if (payload.length > MAX_LINK) throw new Error('remix link too long');  // a bound on what inflates
  const raw = await pipe(fromB64url(payload), new DecompressionStream('gzip'));
  const version = raw[0];
  if (version !== 1 && version !== 2) throw new Error('unknown remix link version');
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
    const bytes = version === 1 ? unpackWords(b, key)
      : b[0] === 1 ? f32ToBytes(unpackGrid(b.subarray(1), STRIDE[key]))
      : unpackWords(b.subarray(1), key);
    return `"${key}":"${bytesToBase64(bytes)}"`;
  });
}

/** The remix link for a document, or null when it would be longer than MAX_LINK. */
export async function remixUrl(doc: Doc, app: string, looksSame: LooksSame): Promise<string | null> {
  const strokes = doc.ordered().map(r => carried(r, looksSame));
  const url = REMIX_BASE + '#r=' + await encodeRemix(serializeDoc(doc.meta, strokes, app));
  return url.length <= MAX_LINK ? url : null;
}

/** The payload of a location hash that carries a drawing (`#r=...`), else null. */
export function remixPayload(hash: string): string | null {
  return hash.startsWith('#r=') ? hash.slice(3) : null;
}

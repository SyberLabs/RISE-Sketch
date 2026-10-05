/**
 * The `.rise` project file (DESIGN §8), format version 1.
 *
 * JSON with typed arrays as base64 little-endian Float32, which round-trips every
 * bit (NaN payloads and -0 included, DESIGN §7.5 rule 10). Scalars are written by a
 * small schema-aware writer instead of JSON.stringify so that the file is also
 * bit-exact for scalars: -0 is written as `-0` (valid JSON that parses back to -0),
 * and the rare non-finite value is written as the string "NaN" / "Infinity" /
 * "-Infinity" and accepted back wherever it is not structurally impossible.
 * Fields that must be finite (origin, z, seed, s0, cut, counters, camera...) are
 * checked on write, so anything this module writes it can read back.
 *
 * Layout: one header line, the meta on its own line, then one stroke per line
 * (strokes in z-order), which keeps files diffable.
 *
 * Opening always produces a new document (DESIGN §8): `parseDoc` assigns a fresh
 * document id (unless one is given) and fresh session-unique revs, because revs
 * are cache keys and are never stored in files.
 */
import { fnv1a } from '../core/det';
import { S, PL } from '../core/types';
import type { Calib, ColorStyle, Device, DocMeta, FormId, FormStyle, Ground, InkId, LCh, NibId, StrokeRecipe, StrokeStyle, Symmetry, Vec2 } from '../core/types';
import { freshRev, restoreRecipe } from './commands';
import type { RecipeFields } from './commands';
import { ALL_INKS, DEFAULT_TITLE } from './document';
import { makeDocId } from './ids';
import { migrate, MigrationError } from './migrate';
import type { RiseJson } from './migrate';

/** Current `.rise` format version. */
export const FORMAT_VERSION = 1;
/** The `format` tag every `.rise` file carries. */
export const FORMAT_TAG = 'rise';

/** A file that is not a readable `.rise` document (bad JSON, wrong tag, newer version, bad field). */
export class RiseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiseFormatError';
  }
}

const DEVICES: readonly Device[] = ['pen', 'mouse', 'touch'];
const NIBS: readonly NibId[] = ['pen', 'brush', 'chisel', 'charcoal'];
const FORMS: readonly FormId[] = ['line', 'echo', 'sprout', 'drift', 'ripple'];
const GROUNDS: readonly Ground[] = ['night', 'paper'];
const AXES: readonly Symmetry['axis'][] = ['v', 'h'];
const ID_RE = /^[0-9a-z]+$/;

// ================================================================ base64 (no btoa/atob in the pure layer)

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ENC = new Uint16Array(64);
const DEC = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) { ENC[i] = ALPHA.charCodeAt(i); DEC[ENC[i]] = i; }
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const CHUNK = 3 * 4096; // bytes per String.fromCharCode batch (well under engine argument limits)
const charBuf = new Uint16Array((CHUNK / 3) * 4);

/** Standard base64 (RFC 4648, padded) of raw bytes. */
export function bytesToBase64(b: Uint8Array): string {
  const parts: string[] = [];
  const n = b.length;
  for (let off = 0; off < n; off += CHUNK) {
    const end = Math.min(n, off + CHUNK);
    let k = 0, i = off;
    for (; i + 2 < end; i += 3) {
      const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      charBuf[k++] = ENC[v >>> 18]; charBuf[k++] = ENC[(v >>> 12) & 63];
      charBuf[k++] = ENC[(v >>> 6) & 63]; charBuf[k++] = ENC[v & 63];
    }
    if (i < end) { // tail (only in the last chunk, since CHUNK is a multiple of 3)
      const v = (b[i] << 16) | (i + 1 < end ? b[i + 1] << 8 : 0);
      charBuf[k++] = ENC[v >>> 18]; charBuf[k++] = ENC[(v >>> 12) & 63];
      charBuf[k++] = i + 1 < end ? ENC[(v >>> 6) & 63] : 61;
      charBuf[k++] = 61;
    }
    parts.push(String.fromCharCode.apply(null, charBuf.subarray(0, k) as unknown as number[]));
  }
  return parts.join('');
}

/** Decode standard base64 (padding optional). Throws RiseFormatError on any invalid character or length. */
export function base64ToBytes(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--;
  const pad = s.length - len;
  if (pad > 2 || len % 4 === 1 || (pad > 0 && s.length % 4 !== 0)) throw new RiseFormatError('invalid base64 length');
  const out = new Uint8Array((len * 3) >>> 2);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const d = c < 128 ? DEC[c] : -1;
    if (d < 0) throw new RiseFormatError(`invalid base64 character at ${i}`);
    acc = ((acc << 6) | d) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >>> bits) & 255; }
  }
  return out;
}

function swap32(b: Uint8Array): void {
  for (let i = 0; i + 3 < b.length; i += 4) {
    const t0 = b[i], t1 = b[i + 1];
    b[i] = b[i + 3]; b[i + 1] = b[i + 2]; b[i + 2] = t1; b[i + 3] = t0;
  }
}

/** Base64 of a Float32Array's little-endian bytes (exact: every bit pattern survives). */
export function encodeF32(a: Float32Array): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  if (LITTLE) return bytesToBase64(b);
  const c = b.slice();
  swap32(c);
  return bytesToBase64(c);
}

/** Inverse of encodeF32. Throws RiseFormatError if the data is not whole Float32 values. */
export function decodeF32(s: string): Float32Array {
  const b = base64ToBytes(s);
  if (b.length % 4 !== 0) throw new RiseFormatError('Float32 data length is not a multiple of 4 bytes');
  if (!LITTLE) swap32(b);
  return new Float32Array(b.buffer, 0, b.length >>> 2);
}

// ================================================================ writer

type JVal = null | boolean | number | string | JVal[] | { [k: string]: JVal };

function wnum(v: number): string {
  if (Number.isFinite(v)) return Object.is(v, -0) ? '-0' : String(v);
  return v !== v ? '"NaN"' : v > 0 ? '"Infinity"' : '"-Infinity"';
}

function write(v: JVal): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number': return wnum(v);
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
  }
  if (Array.isArray(v)) return '[' + v.map(write).join(',') + ']';
  let s = '{', first = true;
  for (const k in v) {
    s += (first ? '' : ',') + JSON.stringify(k) + ':' + write(v[k]);
    first = false;
  }
  return s + '}';
}

// The writer enforces exactly what the reader requires, so a saved file can always
// be opened again: a value the reader would reject fails the save, loudly, instead
// of producing a file that is lost for good.
const cannot = (path: string, what: string): never => { throw new RiseFormatError(`cannot save: ${path} ${what}`); };

function fin(v: number, path: string): number {
  if (!Number.isFinite(v)) cannot(path, 'is not finite');
  return v;
}
function wPos(v: number, path: string): number {
  if (!(Number.isFinite(v) && v > 0)) cannot(path, 'is not a positive number');
  return v;
}
function wInt(v: number, path: string, lo: number, hi: number): number {
  if (!Number.isInteger(v) || v < lo || v > hi) cannot(path, `is not an integer in [${lo}, ${hi}]`);
  return v;
}
function wOne<T extends string>(v: T, list: readonly T[], path: string): T {
  if (!list.includes(v)) cannot(path, `is not one of ${list.join(', ')}`);
  return v;
}

const lchJ = (c: LCh): JVal => [c[0], c[1], c[2]];

function strokeJ(r: StrokeRecipe): JVal {
  const p = `stroke ${r.id}`;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) cannot(`${p}.id`, 'is not a base36 id');
  const ink = wOne(r.color.ink, ALL_INKS, `${p}.color.ink`);
  if (ink === 'custom' && !r.color.lch) cannot(`${p}.color.lch`, 'is missing for a custom ink');
  const n = r.samples.length;
  if (n === 0 || n % S.STRIDE !== 0) cannot(`${p}.samples`, `is not whole rows of ${S.STRIDE} floats`);
  const bad = sampleTimeFault(r.samples);
  if (bad >= 0) cannot(`${p}.samples`, `has a timestamp at row ${bad} that is not finite or goes backwards`);
  if (r.pools.length % PL.STRIDE !== 0) cannot(`${p}.pools`, `is not whole rows of ${PL.STRIDE} floats`);
  return {
    id: r.id,
    created: fin(r.created, `${p}.created`),
    device: wOne(r.device, DEVICES, `${p}.device`),
    origin: [fin(r.origin[0], `${p}.origin`), fin(r.origin[1], `${p}.origin`)],
    z: wPos(r.z, `${p}.z`),
    rot: fin(r.rot, `${p}.rot`),
    seed: r.seed >>> 0,
    calib: { lo: r.calib.lo, hi: r.calib.hi, gamma: r.calib.gamma, flat: r.calib.flat, vMed: r.calib.vMed, jitter: r.calib.jitter, fcMin: r.calib.fcMin },
    stroke: { nib: wOne(r.stroke.nib, NIBS, `${p}.stroke.nib`), size: r.stroke.size },
    color: {
      ink, k: r.color.k, dh: r.color.dh, dL: r.color.dL,
      lch: r.color.lch ? { night: lchJ(r.color.lch.night), paper: lchJ(r.color.lch.paper) } : null,
    },
    form: { form: wOne(r.form.form, FORMS, `${p}.form.form`), v: wInt(r.form.v, `${p}.form.v`, 1, 0xffff), base: r.form.base },
    closed: r.closed,
    radial: r.radial,
    s0: fin(r.s0, `${p}.s0`),
    cut: wInt(r.cut, `${p}.cut`, 0, 3),
    resume: r.resume ? encodeF32(r.resume) : null,
    sym: r.sym ? { axis: wOne(r.sym.axis, AXES, `${p}.sym.axis`), at: r.sym.at } : null,
    xf: r.xf ? Array.from(r.xf) : null,
    stride: S.STRIDE,
    samples: encodeF32(r.samples),
    pools: encodeF32(r.pools),
  };
}

function metaJ(m: Readonly<DocMeta>): JVal {
  if (typeof m.title !== 'string') cannot('meta.title', 'is not a string');
  const inkCounters: { [k: string]: JVal } = {};
  for (const ink of ALL_INKS) inkCounters[ink] = wInt(m.inkCounters[ink] ?? 0, `meta.inkCounters.${ink}`, 0, Number.MAX_SAFE_INTEGER);
  const c = m.camera;
  return {
    title: m.title,
    created: fin(m.created, 'meta.created'),
    updated: fin(m.updated, 'meta.updated'),
    docSeed: m.docSeed >>> 0,
    counter: wInt(m.counter, 'meta.counter', 0, Number.MAX_SAFE_INTEGER),
    inkCounters,
    ground: wOne(m.ground, GROUNDS, 'meta.ground'),
    camera: { cx: fin(c.cx, 'meta.camera.cx'), cy: fin(c.cy, 'meta.camera.cy'), scale: wPos(c.scale, 'meta.camera.scale'), rot: fin(c.rot, 'meta.camera.rot') },
  };
}

/**
 * Serialise a document to `.rise` text. Strokes are written in z-order (id order)
 * whatever order they are given in. `app` names the writer, e.g. "rise-sketch@0.1.0".
 * Throws RiseFormatError ("cannot save: ...") for a value the reader would reject.
 */
export function serializeDoc(meta: DocMeta, strokes: readonly StrokeRecipe[], app: string): string {
  const sorted = strokes.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (sorted[i].id === sorted[i - 1].id) cannot(`stroke ${sorted[i].id}`, 'appears twice');
  const lines = sorted.map(r => write(strokeJ(r)));
  const head = `{"format":${JSON.stringify(FORMAT_TAG)},"version":${FORMAT_VERSION},"app":${JSON.stringify(String(app))},`;
  const body = `"meta":${write(metaJ(meta))},`;
  const list = lines.length ? `"strokes":[\n${lines.join(',\n')}\n]}` : '"strokes":[]}';
  return `${head}\n${body}\n${list}\n`;
}

// ================================================================ reader

type J = { [k: string]: unknown };
const fail = (path: string, what: string): never => { throw new RiseFormatError(`${path}: ${what}`); };

function obj(v: unknown, path: string): J {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'expected an object');
  return v as J;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'expected a string');
  return v as string;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected true or false');
  return v as boolean;
}
/** Any number the writer can produce (finite, -0, or the non-finite strings). */
function anyNum(v: unknown, path: string): number {
  if (typeof v === 'number') return v;
  if (v === 'NaN') return NaN;
  if (v === 'Infinity') return Infinity;
  if (v === '-Infinity') return -Infinity;
  return fail(path, 'expected a number');
}
function finNum(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected a finite number');
  return v as number;
}
function intIn(v: unknown, path: string, lo: number, hi: number): number {
  const n = finNum(v, path);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(path, `expected an integer in [${lo}, ${hi}]`);
  return n;
}
function oneOf<T extends string>(v: unknown, list: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) fail(path, `expected one of ${list.join(', ')}`);
  return v as T;
}
function f32(v: unknown, path: string): Float32Array {
  const s = str(v, path);
  try {
    return decodeF32(s);
  } catch (e) {
    return fail(path, e instanceof Error ? e.message : 'invalid Float32 data');
  }
}
function lch(v: unknown, path: string): LCh {
  if (!Array.isArray(v) || v.length !== 3) fail(path, 'expected [L, C, h]');
  const a = v as unknown[];
  return [anyNum(a[0], `${path}[0]`), anyNum(a[1], `${path}[1]`), anyNum(a[2], `${path}[2]`)];
}

function readMeta(v: unknown, id: string, now: number | undefined): DocMeta {
  const m = obj(v, 'meta');
  const created = finNum(m.created, 'meta.created');
  const ic = m.inkCounters === undefined ? {} : obj(m.inkCounters, 'meta.inkCounters');
  const inkCounters = {} as Record<InkId, number>;
  for (const ink of ALL_INKS) inkCounters[ink] = ic[ink] === undefined ? 0 : intIn(ic[ink], `meta.inkCounters.${ink}`, 0, Number.MAX_SAFE_INTEGER);
  const c = obj(m.camera, 'meta.camera');
  const scale = finNum(c.scale, 'meta.camera.scale');
  if (!(scale > 0)) fail('meta.camera.scale', 'expected a positive number');
  return {
    id,
    title: m.title === undefined ? DEFAULT_TITLE : str(m.title, 'meta.title'),
    created,
    updated: now ?? (m.updated === undefined ? created : finNum(m.updated, 'meta.updated')),
    docSeed: intIn(m.docSeed, 'meta.docSeed', 0, 0xffffffff),
    counter: intIn(m.counter, 'meta.counter', 0, Number.MAX_SAFE_INTEGER),
    inkCounters,
    ground: oneOf(m.ground, GROUNDS, 'meta.ground'),
    camera: { cx: finNum(c.cx, 'meta.camera.cx'), cy: finNum(c.cy, 'meta.camera.cy'), scale, rot: finNum(c.rot, 'meta.camera.rot') },
  };
}

function readStroke(v: unknown, i: number): RecipeFields {
  const p = `strokes[${i}]`;
  const s = obj(v, p);
  const id = str(s.id, `${p}.id`);
  if (!ID_RE.test(id)) fail(`${p}.id`, 'expected a base36 id');
  const stride = s.stride === undefined ? S.STRIDE : intIn(s.stride, `${p}.stride`, 1, 64);
  if (stride !== S.STRIDE) fail(`${p}.stride`, `expected ${S.STRIDE}`);

  const o = s.origin;
  if (!Array.isArray(o) || o.length !== 2) fail(`${p}.origin`, 'expected [x, y]');
  const origin: Vec2 = [finNum((o as unknown[])[0], `${p}.origin[0]`), finNum((o as unknown[])[1], `${p}.origin[1]`)];
  const z = finNum(s.z, `${p}.z`);
  if (!(z > 0)) fail(`${p}.z`, 'expected a positive number');

  const cj = obj(s.calib, `${p}.calib`);
  const calib: Calib = {
    lo: anyNum(cj.lo, `${p}.calib.lo`), hi: anyNum(cj.hi, `${p}.calib.hi`), gamma: anyNum(cj.gamma, `${p}.calib.gamma`),
    flat: anyNum(cj.flat, `${p}.calib.flat`), vMed: anyNum(cj.vMed, `${p}.calib.vMed`), jitter: anyNum(cj.jitter, `${p}.calib.jitter`),
    fcMin: anyNum(cj.fcMin, `${p}.calib.fcMin`),
  };
  const sj = obj(s.stroke, `${p}.stroke`);
  const stroke: StrokeStyle = { nib: oneOf(sj.nib, NIBS, `${p}.stroke.nib`), size: anyNum(sj.size, `${p}.stroke.size`) };
  const kj = obj(s.color, `${p}.color`);
  const ink = oneOf(kj.ink, ALL_INKS, `${p}.color.ink`);
  let lchPair: ColorStyle['lch'] = null;
  if (kj.lch !== null && kj.lch !== undefined) {
    const lj = obj(kj.lch, `${p}.color.lch`);
    lchPair = { night: lch(lj.night, `${p}.color.lch.night`), paper: lch(lj.paper, `${p}.color.lch.paper`) };
  }
  if (ink === 'custom' && !lchPair) fail(`${p}.color.lch`, 'a custom ink needs its colours');
  const color: ColorStyle = { ink, k: anyNum(kj.k, `${p}.color.k`), dh: anyNum(kj.dh, `${p}.color.dh`), dL: anyNum(kj.dL, `${p}.color.dL`), lch: lchPair };
  const fj = obj(s.form, `${p}.form`);
  const form: FormStyle = { form: oneOf(fj.form, FORMS, `${p}.form.form`), v: intIn(fj.v, `${p}.form.v`, 1, 0xffff), base: anyNum(fj.base, `${p}.form.base`) };

  let sym: Symmetry | null = null;
  if (s.sym !== null && s.sym !== undefined) {
    const yj = obj(s.sym, `${p}.sym`);
    sym = { axis: oneOf(yj.axis, AXES, `${p}.sym.axis`), at: anyNum(yj.at, `${p}.sym.at`) };
  }
  let xf: Float64Array | null = null;
  if (s.xf !== null && s.xf !== undefined) {
    if (!Array.isArray(s.xf) || s.xf.length !== 6) fail(`${p}.xf`, 'expected 6 numbers');
    xf = Float64Array.from(s.xf as unknown[], (x, j) => anyNum(x, `${p}.xf[${j}]`));
  }

  const samples = f32(s.samples, `${p}.samples`);
  if (samples.length === 0 || samples.length % S.STRIDE !== 0) fail(`${p}.samples`, `expected whole rows of ${S.STRIDE} floats`);
  const bad = sampleTimeFault(samples);
  if (bad >= 0) fail(`${p}.samples`, `timestamp of row ${bad} is not finite or goes backwards`);
  const pools = s.pools === undefined || s.pools === '' ? new Float32Array(0) : f32(s.pools, `${p}.pools`);
  if (pools.length % PL.STRIDE !== 0) fail(`${p}.pools`, `expected whole rows of ${PL.STRIDE} floats`);

  return {
    id,
    created: finNum(s.created, `${p}.created`),
    origin, z,
    rot: finNum(s.rot, `${p}.rot`),
    seed: intIn(s.seed, `${p}.seed`, 0, 0xffffffff),
    device: oneOf(s.device, DEVICES, `${p}.device`),
    calib, stroke, color, form,
    s0: finNum(s.s0, `${p}.s0`),
    cut: intIn(s.cut, `${p}.cut`, 0, 3),
    resume: s.resume === null || s.resume === undefined ? null : f32(s.resume, `${p}.resume`),
    samples, pools,
    closed: bool(s.closed, `${p}.closed`),
    radial: bool(s.radial, `${p}.radial`),
    sym, xf,
  };
}

/**
 * DESIGN §7.5 rule 9: stored timestamps come from the sanitiser, so they are finite
 * and strictly increasing. Float32 rounding is monotonic, so a row whose T is
 * *smaller* than the previous one can never come from a file Rise wrote; equal T
 * (Float32 rounding of a stroke held for over ~70 minutes) is tolerated. Returns
 * the first offending row, or -1. Samples are never rewritten: geometry is frozen.
 */
export function sampleTimeFault(samples: Float32Array): number {
  let prev = -Infinity;
  for (let i = 0, o = S.T; o < samples.length; i++, o += S.STRIDE) {
    const t = samples[o];
    if (!Number.isFinite(t) || t < prev) return i;
    prev = t;
  }
  return -1;
}

/** Options for parseDoc. */
export interface ParseOptions {
  /** Document id for the opened document (default: a fresh makeDocId). */
  id?: string;
  /** Wall clock for the fresh id, and if given also the opened document's `updated`. */
  now?: number;
  /** 32 random bits for the fresh id (default Math.random). */
  rand32?: number;
}

/**
 * Parse `.rise` text into document metadata and recipes (z-ordered), migrating
 * older format versions. Throws RiseFormatError for anything unreadable.
 */
export function parseDoc(text: string, opts?: ParseOptions): { meta: DocMeta; strokes: StrokeRecipe[] } {
  if (typeof text !== 'string') throw new RiseFormatError('expected text');
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (t.charCodeAt(0) === 0x1f) throw new RiseFormatError('this .rise file is compressed; read it with persist/files readFileText');
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    throw new RiseFormatError('not a .rise file (invalid JSON)');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as J).format !== FORMAT_TAG) {
    throw new RiseFormatError('not a .rise file');
  }
  let json = raw as RiseJson;
  const version = json.version;
  if (typeof version !== 'number') throw new RiseFormatError('missing format version');
  try {
    json = migrate(json, version, FORMAT_VERSION);
  } catch (e) {
    if (e instanceof MigrationError) throw new RiseFormatError(e.message);
    throw e;
  }

  const id = opts?.id ?? makeDocId(opts?.now ?? Date.now(), opts?.rand32 ?? Math.floor(Math.random() * 4294967296));
  const meta = readMeta(json.meta, id, opts?.now);
  if (!Array.isArray(json.strokes)) throw new RiseFormatError('strokes: expected an array');
  const fields = (json.strokes as unknown[]).map(readStroke);
  fields.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < fields.length; i++) {
    if (fields[i].id === fields[i - 1].id) throw new RiseFormatError(`strokes: duplicate id ${fields[i].id}`);
  }
  const rev = freshRev();
  const strokes = fields.map(f => restoreRecipe(f, rev, rev));
  return { meta, strokes };
}

// ================================================================ scene hash

const DEVICE_CODE: Record<Device, number> = { pen: 0, mouse: 1, touch: 2 };
const NIB_CODE: Record<NibId, number> = { pen: 0, brush: 1, chisel: 2, charcoal: 3 };
const FORM_CODE: Record<FormId, number> = { line: 0, echo: 1, sprout: 2, drift: 3, ripple: 4 };
const N_SCALARS = 31;
/** Canonical quiet NaN as two 32-bit words in platform order (low word first on LE). */
const NAN_LO = LITTLE ? 0 : 0x7ff80000, NAN_HI = LITTLE ? 0x7ff80000 : 0;

/**
 * FNV-1a over every geometry-relevant recipe field, in z-order (sorted by id here,
 * so input order does not matter). Colour, `created` and the revs are excluded:
 * colour never feeds geometry (DESIGN §7.5 rule 4). Used by e2e reload and
 * round-trip checks.
 *
 * NaN scalars are hashed as one canonical bit pattern: engines may store any NaN
 * encoding (a computed 0/0 on x86 is negative), while the `.rise` writer stores NaN
 * as "NaN", so raw bits would make a file round trip change the hash. Typed-array
 * columns are hashed raw, since files and IndexedDB keep their bits exactly.
 */
export function sceneHash(strokes: readonly StrokeRecipe[]): number {
  const sorted = strokes.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sc = new Float64Array(N_SCALARS);
  const scw = new Uint32Array(sc.buffer);
  let idBuf = new Uint16Array(16);
  let h = 0x811c9dc5;
  for (const r of sorted) {
    const n = r.id.length;
    if (idBuf.length < n) idBuf = new Uint16Array(n * 2);
    for (let i = 0; i < n; i++) idBuf[i] = r.id.charCodeAt(i);
    const c = r.calib;
    let k = 0;
    sc[k++] = n;
    sc[k++] = r.origin[0]; sc[k++] = r.origin[1]; sc[k++] = r.z; sc[k++] = r.rot; sc[k++] = r.seed >>> 0;
    sc[k++] = DEVICE_CODE[r.device] ?? -1;
    sc[k++] = c.lo; sc[k++] = c.hi; sc[k++] = c.gamma; sc[k++] = c.flat; sc[k++] = c.vMed; sc[k++] = c.jitter; sc[k++] = c.fcMin;
    sc[k++] = NIB_CODE[r.stroke.nib] ?? -1; sc[k++] = r.stroke.size;
    sc[k++] = FORM_CODE[r.form.form] ?? -1; sc[k++] = r.form.v; sc[k++] = r.form.base;
    sc[k++] = r.s0; sc[k++] = r.cut; sc[k++] = r.closed ? 1 : 0; sc[k++] = r.radial ? 1 : 0;
    sc[k++] = r.sym ? 1 : 0; sc[k++] = r.sym ? (r.sym.axis === 'v' ? 0 : 1) : 0; sc[k++] = r.sym ? r.sym.at : 0;
    sc[k++] = r.samples.length; sc[k++] = r.pools.length; sc[k++] = r.resume ? r.resume.length : -1;
    sc[k++] = r.xf ? 1 : 0; sc[k++] = sorted.length;
    for (let i = 0; i < k; i++) if (sc[i] !== sc[i]) { scw[2 * i] = NAN_LO; scw[2 * i + 1] = NAN_HI; }
    h = fnv1a([idBuf.subarray(0, n), sc, r.samples, r.pools], h);
    if (r.resume) h = fnv1a([r.resume], h);
    if (r.xf) h = fnv1a([r.xf], h);
  }
  return h >>> 0;
}

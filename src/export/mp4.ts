/**
 * A minimal MP4 writer for one H.264 video track (DESIGN §8 Share timelapse), so WebCodecs output
 * becomes a file every share sheet and social app accepts, with no dependency. Pure: bytes in,
 * bytes out.
 *
 * Layout: `ftyp`, then `moov` (ahead of the media, "fast start", so a player or an upload can
 * begin before the whole file arrives), then one `mdat` holding every sample as a single chunk.
 * Constant frame rate (one `stts` entry); sync samples in `stss`; `ctts` (version 1, signed) only
 * when an encoder reorders frames; an `nclx` `colr` box when the colour space is known.
 */

export interface Mp4Sample { data: Uint8Array; key: boolean; /** presentation time, µs */ pts: number }

export interface Mp4Video {
  width: number;
  height: number;
  fps: number;
  /** AVCDecoderConfigurationRecord (VideoEncoder's decoderConfig.description with avc.format 'avc'). */
  avcC: Uint8Array;
  /** ISO/IEC 23091-2 code points (primaries, transfer, matrix) and the full-range flag, when known. */
  color?: { primaries: number; transfer: number; matrix: number; full: boolean } | null;
  /** In decode order. */
  samples: readonly Mp4Sample[];
}

const TIMESCALE = 90000;

class W {
  private cur = new Uint8Array(256);
  private n = 0;
  private ensure(k: number): void {
    if (this.n + k <= this.cur.length) return;
    const next = new Uint8Array(Math.max(this.cur.length * 2, this.n + k));
    next.set(this.cur.subarray(0, this.n));
    this.cur = next;
  }
  u8(v: number): this { this.ensure(1); this.cur[this.n++] = v & 255; return this; }
  u16(v: number): this { return this.u8(v >>> 8).u8(v); }
  u32(v: number): this { return this.u16(v >>> 16).u16(v & 0xffff); }
  i32(v: number): this { return this.u32(v >>> 0); }
  zeros(k: number): this { for (let i = 0; i < k; i++) this.u8(0); return this; }
  str(s: string): this { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this; }
  bytes(b: Uint8Array): this { this.ensure(b.length); this.cur.set(b, this.n); this.n += b.length; return this; }
  get size(): number { return this.n; }
  done(): Uint8Array { return this.cur.slice(0, this.n); }
}

/** A box: 32-bit size, fourcc, body. */
function box(type: string, ...body: Uint8Array[]): Uint8Array {
  let len = 8;
  for (const b of body) len += b.length;
  const w = new W().u32(len).str(type);
  for (const b of body) w.bytes(b);
  return w.done();
}

/** A full box: version and flags before the body. */
function full(type: string, version: number, flags: number, body: (w: W) => void): Uint8Array {
  const w = new W().u8(version).u8(flags >>> 16).u16(flags & 0xffff);
  body(w);
  return box(type, w.done());
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/** The file as parts for a Blob (header, then the samples untouched). */
export function muxMp4(v: Mp4Video): Uint8Array[] {
  const n = v.samples.length;
  const delta = Math.round(TIMESCALE / v.fps);
  const dur = n * delta;
  const durMs = Math.round(dur * 1000 / TIMESCALE);
  let mdatLen = 0;
  for (const s of v.samples) mdatLen += s.data.length;

  // presentation offsets: zero unless the encoder reordered frames
  const offsets = new Int32Array(n);
  let reordered = false;
  if (n) {
    const p0 = v.samples.reduce((m, s) => Math.min(m, s.pts), Infinity);
    for (let i = 0; i < n; i++) {
      offsets[i] = Math.round((v.samples[i].pts - p0) * TIMESCALE / 1e6) - i * delta;
      if (offsets[i] !== 0) reordered = true;
    }
  }

  const ftyp = box('ftyp', new W().str('isom').u32(0x200).str('isomiso2avc1mp41').done());

  const stbl = (chunkOffset: number): Uint8Array => {
    const avc1Body = new W().zeros(6).u16(1).zeros(16).u16(v.width).u16(v.height)
      .u32(0x00480000).u32(0x00480000).u32(0).u16(1).zeros(32).u16(0x0018).u16(0xffff).done();
    const extra: Uint8Array[] = [box('avcC', v.avcC)];
    if (v.color) {
      const c = v.color;
      extra.push(box('colr', new W().str('nclx').u16(c.primaries).u16(c.transfer).u16(c.matrix).u8(c.full ? 0x80 : 0).done()));
    }
    extra.push(box('pasp', new W().u32(1).u32(1).done()));
    const stsd = full('stsd', 0, 0, w => { w.u32(1).bytes(box('avc1', avc1Body, ...extra)); });
    const stts = full('stts', 0, 0, w => { w.u32(n ? 1 : 0); if (n) w.u32(n).u32(delta); });
    const keys: number[] = [];
    v.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
    const stss = full('stss', 0, 0, w => { w.u32(keys.length); for (const k of keys) w.u32(k); });
    const stsc = full('stsc', 0, 0, w => { w.u32(n ? 1 : 0); if (n) w.u32(1).u32(n).u32(1); });
    const stsz = full('stsz', 0, 0, w => { w.u32(0).u32(n); for (const s of v.samples) w.u32(s.data.length); });
    const stco = full('stco', 0, 0, w => { w.u32(n ? 1 : 0); if (n) w.u32(chunkOffset); });
    const parts = [stsd, stts, stss];
    if (reordered) parts.push(full('ctts', 1, 0, w => { w.u32(n); for (let i = 0; i < n; i++) w.u32(1).i32(offsets[i]); }));
    parts.push(stsc, stsz, stco);
    return box('stbl', ...parts);
  };

  const moov = (chunkOffset: number): Uint8Array => {
    const mvhd = full('mvhd', 0, 0, w => {
      w.u32(0).u32(0).u32(1000).u32(durMs).u32(0x00010000).u16(0x0100).zeros(10);
      for (const m of MATRIX) w.u32(m);
      w.zeros(24).u32(2);
    });
    const tkhd = full('tkhd', 0, 3, w => {
      w.u32(0).u32(0).u32(1).u32(0).u32(durMs).zeros(8).u16(0).u16(0).u16(0).u16(0);
      for (const m of MATRIX) w.u32(m);
      w.u32(v.width * 65536).u32(v.height * 65536);
    });
    const mdhd = full('mdhd', 0, 0, w => { w.u32(0).u32(0).u32(TIMESCALE).u32(dur).u16(0x55c4).u16(0); });
    const hdlr = full('hdlr', 0, 0, w => { w.u32(0).str('vide').zeros(12).str('VideoHandler').u8(0); });
    const vmhd = full('vmhd', 0, 1, w => { w.zeros(8); });
    const dinf = box('dinf', full('dref', 0, 0, w => { w.u32(1).bytes(full('url ', 0, 1, () => undefined)); }));
    const minf = box('minf', vmhd, dinf, stbl(chunkOffset));
    return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, minf)));
  };

  // moov's size does not depend on the offset value, so measure once, then write for real
  const head = ftyp.length + moov(0).length + 8;
  const mdatHeader = new W().u32(8 + mdatLen).str('mdat').done();
  return [ftyp, moov(head), mdatHeader, ...v.samples.map(s => s.data)];
}

/** ISO/IEC 23091-2 code points for a WebCodecs VideoColorSpaceInit (null when incomplete). */
export function nclx(cs: { primaries?: string | null; transfer?: string | null; matrix?: string | null; fullRange?: boolean | null } | null | undefined): Mp4Video['color'] {
  if (!cs || !cs.primaries || !cs.transfer || !cs.matrix) return null;
  const P: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
  const T: Record<string, number> = { bt709: 1, smpte170m: 6, linear: 8, 'iec61966-2-1': 13, pq: 16, hlg: 18 };
  const M: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 };
  const p = P[cs.primaries], t = T[cs.transfer], m = M[cs.matrix];
  if (p === undefined || t === undefined || m === undefined) return null;
  return { primaries: p, transfer: t, matrix: m, full: !!cs.fullRange };
}

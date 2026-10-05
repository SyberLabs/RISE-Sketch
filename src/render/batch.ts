/**
 * Fill batching for one stroke (DESIGN §6.3). Polys are grouped by (colour-table index, alpha
 * slot, mode) so each group is ONE path filled once: inside a batch overlaps merge (nonzero
 * union); across batches and strokes they add (Night) or glaze (Paper). A stroke needs at most
 * MAX_FILLS fills; above that, adjacent tones merge (pressure first, then depth / spectral hue,
 * then alpha) until it fits.
 *
 * No DOM; allocation-free after warm-up (scratch arrays grow only).
 */

/** Hard cap on fills (+ hairline strokes) per stroke per draw. */
export const MAX_FILLS = 96;

/**
 * Alpha levels: 8 linear levels (1/8 … 1) for a ≥ 1/16, plus three faint levels (1/24, 1/48,
 * 1/96) so hairline and deep-generation polys fade steadily instead of snapping to 1/8 or 0.
 */
export const ALPHA_LEVELS: readonly number[] = [1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8, 1, 1 / 24, 1 / 48, 1 / 96];
/**
 * Alpha keys ≥ EXACT_BASE carry an exact alpha (quantised to 1/1024, up to EXACT_MAX): used for
 * hot ink. drawCooked's keys are relative to the ground's alphaMax × alphaScale, so they may exceed
 * 1 when alphaScale < 1; the caller clamps the final fill alpha.
 */
export const EXACT_BASE = 16;
const EXACT_Q = 1024;
/** Largest alpha an exact key can carry. */
export const EXACT_MAX = 4;

/** Bucket key of an alpha (index into ALPHA_LEVELS), or −1 when it is invisible (< 1/192). */
export function alphaBucket(a: number): number {
  if (!(a >= 1 / 192)) return -1;
  if (a >= 1 / 16) {
    const b = Math.round(a * 8);
    return (b < 1 ? 1 : b > 8 ? 8 : b) - 1;
  }
  return a >= 1 / 32 ? 8 : a >= 1 / 64 ? 9 : 10;
}
/** Key for an exact alpha (0 < a ≤ EXACT_MAX), quantised finely enough to look continuous. */
export function exactKey(a: number): number {
  const q = Math.round((a > EXACT_MAX ? EXACT_MAX : a) * EXACT_Q);
  return EXACT_BASE + (q >= 1 ? q : 1);
}
/** Alpha value of a key. */
export function alphaOf(key: number): number {
  return key >= EXACT_BASE ? (key - EXACT_BASE) / EXACT_Q : ALPHA_LEVELS[key];
}

/** Batch mode: filled outlines, or 1-device-px hairline centrelines. */
export const MODE_FILL = 0, MODE_HAIR = 1;

const KEY_SPAN = 8192;            // alpha keys per css index (EXACT_BASE + EXACT_MAX·EXACT_Q < 8192)
const ENTRY_SPAN = 16777216;      // 2^24 entries per draw; max sort key ≈ 3e14 < 2^53 (exact in a Float64)

/**
 * Collects (poly, css index, alpha key, mode) entries for one stroke and plans the batches.
 * Reuse one instance; `reset()` before each stroke.
 */
export class Batcher {
  /** Number of entries added since reset. */
  n = 0;
  /** Per entry: poly index. */
  poly = new Int32Array(256);
  private css = new Int32Array(256);
  private ak = new Int32Array(256);
  private md = new Uint8Array(256);
  private sortKey = new Float64Array(256);

  /** Planned batches (valid until the next plan()). */
  readonly plan = {
    n: 0,
    css: new Int32Array(MAX_FILLS * 2),
    alpha: new Float64Array(MAX_FILLS * 2),
    mode: new Uint8Array(MAX_FILLS * 2),
    first: new Int32Array(MAX_FILLS * 2),
    count: new Int32Array(MAX_FILLS * 2),
    /** Entry indices grouped by batch (entry e → poly[e]). */
    order: new Int32Array(256),
  };

  reset(): void { this.n = 0; }

  add(poly: number, css: number, alphaKey: number, mode: number): void {
    if (this.n >= this.poly.length) this.grow();
    const e = this.n++;
    this.poly[e] = poly; this.css[e] = css; this.ak[e] = alphaKey; this.md[e] = mode;
  }

  private grow(): void {
    const c = this.poly.length * 2;
    const g32 = (a: Int32Array): Int32Array<ArrayBuffer> => { const b = new Int32Array(c); b.set(a); return b; };
    this.poly = g32(this.poly); this.css = g32(this.css); this.ak = g32(this.ak);
    const m = new Uint8Array(c); m.set(this.md); this.md = m;
    this.sortKey = new Float64Array(c);
    this.plan.order = new Int32Array(c);
  }

  /**
   * Group entries into batches (sorted by css index, alpha, mode, so the order is deterministic).
   * `spectral` selects the merge rule for 36 × 30 tables. Returns the plan.
   */
  build(spectral: boolean): Batcher['plan'] {
    const n = Math.min(this.n, ENTRY_SPAN - 1);
    let level = 0;
    for (;;) {
      const sk = this.sortKey;
      for (let e = 0; e < n; e++) {
        const key = keyOf(this.css[e], this.ak[e], this.md[e], level, spectral);
        sk[e] = key * ENTRY_SPAN + e;
      }
      const view = sk.subarray(0, n);
      view.sort();
      let groups = 0, prev = -1;
      for (let e = 0; e < n; e++) {
        const k = Math.floor(view[e] / ENTRY_SPAN);
        if (k !== prev) { groups++; prev = k; }
      }
      if (groups <= MAX_FILLS || level >= MAX_LEVEL) break;
      level++;
    }
    const p = this.plan, view = this.sortKey;
    p.n = 0;
    let prev = -1;
    for (let e = 0; e < n; e++) {
      const packed = view[e];
      const k = Math.floor(packed / ENTRY_SPAN);
      const ent = packed - k * ENTRY_SPAN;
      if (k !== prev) {
        if (p.n >= p.css.length) growPlan(p);
        const b = p.n++;
        const mode = k % 2, ka = Math.floor(k / 2);
        p.css[b] = Math.floor(ka / KEY_SPAN); p.alpha[b] = alphaOf(ka % KEY_SPAN); p.mode[b] = mode;
        p.first[b] = e; p.count[b] = 0;
        prev = k;
      }
      p.order[e] = ent;
      p.count[p.n - 1]++;
    }
    return p;
  }
}

function growPlan(p: Batcher['plan']): void {
  const c = p.css.length * 2;
  const i32 = (a: Int32Array): Int32Array<ArrayBuffer> => { const b = new Int32Array(c); b.set(a); return b; };
  p.css = i32(p.css); p.first = i32(p.first); p.count = i32(p.count);
  const al = new Float64Array(c); al.set(p.alpha); p.alpha = al;
  const md = new Uint8Array(c); md.set(p.mode); p.mode = md;
}

const MAX_LEVEL = 5;
/** Index of the faintest alpha level (1/96). */
const FAINTEST = 10;

/**
 * Batch key at a merge level. Tone = pBucket·5 + dBucket (spectral index = hue·30 + tone).
 * Levels: 1 pressure pairs, 2 one pressure, 3 depth pairs (spectral: hue pairs),
 * 4 exact alphas fold into buckets, 5 spectral hue quads / depth all.
 */
function keyOf(css: number, ak: number, mode: number, level: number, spectral: boolean): number {
  if (level > 0) {
    let hue = spectral ? Math.floor(css / 30) : 0;
    const tone = spectral ? css % 30 : css;
    let pb = Math.floor(tone / 5), db = tone % 5;
    if (level >= 1) pb = (pb >> 1) * 2 + 1;
    if (level >= 2) pb = 3;
    if (level >= 3) { if (spectral) hue = (hue >> 1) * 2; else db = db === 0 ? 0 : db <= 2 ? 1 : 3; }
    if (level >= 4 && ak >= EXACT_BASE) { const kb = alphaBucket(alphaOf(ak)); ak = kb >= 0 ? kb : FAINTEST; }
    if (level >= 5) { if (spectral) hue = (hue >> 2) * 4; else db = db === 0 ? 0 : 2; }
    css = spectral ? hue * 30 + pb * 5 + db : pb * 5 + db;
  }
  return (css * KEY_SPAN + ak) * 2 + mode;
}

/**
 * CanvasLedger: counts every canvas byte (tiles, live layers, bloom, sheets, export) against a
 * per-device-class budget and asks registered evictors to free memory. Spec: DESIGN §6.9, §6.10.
 *
 * The cap is a budget, not a wall: going over it triggers onPressure handlers (the tile cache
 * evicts LRU tiles), and the allocation then proceeds. Only a real browser refusal (getContext
 * returns null, or the canvas comes back 0×0) fails, after one evict-and-retry.
 */

export type DeviceClass = 'phone' | 'tablet' | 'desktop';

const MB = 1024 * 1024;
/** Global canvas budgets (DESIGN §6.9). */
export const LEDGER_CAPS: Record<DeviceClass, number> = { phone: 160 * MB, tablet: 256 * MB, desktop: 512 * MB };

/**
 * Device class from capabilities, never the user agent (DESIGN §6.9): a coarse primary pointer or
 * multi-touch with a short screen side < 500 CSS px is a phone; a coarse pointer, or multi-touch
 * on a screen no bigger than ~1400 × 1100 (iPads with a trackpad report a fine pointer), is a
 * tablet; everything else is a desktop. Outside a browser: 'desktop'.
 */
export function deviceClass(): DeviceClass {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'desktop';
  let coarse = false;
  try { coarse = !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches; } catch { coarse = false; }
  const touch = (navigator.maxTouchPoints || 0) > 1;
  const sw = window.screen ? window.screen.width : window.innerWidth;
  const sh = window.screen ? window.screen.height : window.innerHeight;
  const short = Math.min(sw, sh);
  if ((coarse || touch) && short < 500) return 'phone';
  if (coarse || (touch && sw * sh <= 1400 * 1100)) return 'tablet';
  return 'desktop';
}

export interface CanvasLedger {
  alloc(w: number, h: number, tag: string): HTMLCanvasElement | null;  // evicts via onPressure and retries once
  resize(c: HTMLCanvasElement, w: number, h: number): boolean;
  free(c: HTMLCanvasElement): void;                                    // sets width = height = 0
  onPressure(fn: (needBytes: number) => void): void;                  // the tile cache registers an evictor
  readonly bytes: number; readonly cap: number;
}

/** Ledger with the optional extras the renderer uses (context settings, adoption, breakdown). */
export interface CanvasLedgerExt extends CanvasLedger {
  /** alloc with 2D context settings (e.g. `{ desynchronized: true }` for the overlay). */
  alloc(w: number, h: number, tag: string, ctx?: CanvasRenderingContext2DSettings): HTMLCanvasElement | null;
  /** Start counting a canvas created elsewhere. */
  adopt(c: HTMLCanvasElement, tag: string): void;
  /** Bytes per tag (debug HUD). */
  byTag(): Record<string, number>;
  /** Number of tracked canvases. */
  readonly count: number;
}

interface Rec { bytes: number; tag: string }

/**
 * Create a ledger for a device class (default: detected). `make` builds a canvas element
 * (injectable for tests; default document.createElement('canvas')).
 */
export function createLedger(cls?: DeviceClass, make?: () => HTMLCanvasElement): CanvasLedgerExt {
  const cap = LEDGER_CAPS[cls ?? deviceClass()];
  const recs = new Map<HTMLCanvasElement, Rec>();
  const evictors: ((needBytes: number) => void)[] = [];
  const create = make ?? (() => document.createElement('canvas'));
  let bytes = 0;

  const pressure = (need: number): void => {
    for (const fn of evictors) {
      try { fn(need); } catch { /* an evictor failing must not break allocation */ }
    }
  };
  const budget = (extra: number): void => {
    if (extra > 0 && bytes + extra > cap) pressure(bytes + extra - cap);
  };
  const sizeOk = (c: HTMLCanvasElement, w: number, h: number): boolean => c.width === w && c.height === h;
  const dims = (w: number, h: number): [number, number] => [Math.max(1, Math.ceil(w) | 0), Math.max(1, Math.ceil(h) | 0)];

  function tryMake(w: number, h: number, opts?: CanvasRenderingContext2DSettings): HTMLCanvasElement | null {
    let c: HTMLCanvasElement | null = null;
    try {
      c = create();
      c.width = w; c.height = h;
      const ctx = opts ? c.getContext('2d', opts) : c.getContext('2d');
      if (ctx && sizeOk(c, w, h)) return c;
    } catch { /* treated as an allocation failure */ }
    if (c) { c.width = 0; c.height = 0; }
    return null;
  }

  return {
    get bytes() { return bytes; },
    get cap() { return cap; },
    get count() { return recs.size; },
    alloc(w: number, h: number, tag: string, opts?: CanvasRenderingContext2DSettings): HTMLCanvasElement | null {
      if (!(w > 0 && h > 0)) return null;
      const [W, H] = dims(w, h);
      const need = W * H * 4;
      budget(need);
      let c = tryMake(W, H, opts);
      if (!c) { pressure(need); c = tryMake(W, H, opts); }
      if (!c) return null;
      recs.set(c, { bytes: need, tag });
      bytes += need;
      return c;
    },
    resize(c: HTMLCanvasElement, w: number, h: number): boolean {
      const [W, H] = dims(w, h);
      let r = recs.get(c);
      if (!r) { r = { bytes: c.width * c.height * 4, tag: 'adopted' }; recs.set(c, r); bytes += r.bytes; }
      if (sizeOk(c, W, H)) return true;
      const need = W * H * 4;
      budget(need - r.bytes);
      // an evictor may have freed this very canvas; it is being resized, so it is live: re-track it
      if (!recs.has(c)) { r = { bytes: c.width * c.height * 4, tag: r.tag }; recs.set(c, r); bytes += r.bytes; }
      const apply = (): boolean => {
        try { c.width = W; c.height = H; } catch { return false; }
        return sizeOk(c, W, H);
      };
      let ok = apply();
      if (!ok) { pressure(need); ok = apply(); }
      const now = c.width * c.height * 4;
      bytes += now - r.bytes;
      r.bytes = now;
      return ok;
    },
    free(c: HTMLCanvasElement): void {
      const r = recs.get(c);
      if (r) { bytes -= r.bytes; recs.delete(c); }
      c.width = 0; c.height = 0;
    },
    onPressure(fn: (needBytes: number) => void): void { evictors.push(fn); },
    adopt(c: HTMLCanvasElement, tag: string): void {
      if (recs.has(c)) return;
      const b = c.width * c.height * 4;
      recs.set(c, { bytes: b, tag });
      bytes += b;
    },
    byTag(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const r of recs.values()) out[r.tag] = (out[r.tag] ?? 0) + r.bytes;
      return out;
    },
  };
}

/**
 * Growable typed buffers that reuse their backing store, so hot paths (pointer
 * handlers, incremental cooking) do not allocate per event.
 */

export class F32 {
  data: Float32Array;
  n = 0;
  constructor(cap = 256) { this.data = new Float32Array(cap); }
  reserve(extra: number): void {
    const need = this.n + extra;
    if (need <= this.data.length) return;
    let cap = this.data.length || 16;
    while (cap < need) cap *= 2;
    const d = new Float32Array(cap);
    d.set(this.data.subarray(0, this.n));
    this.data = d;
  }
  push(v: number): void { if (this.n >= this.data.length) this.reserve(1); this.data[this.n++] = v; }
  push3(a: number, b: number, c: number): void {
    if (this.n + 3 > this.data.length) this.reserve(3);
    const d = this.data, n = this.n;
    d[n] = a; d[n + 1] = b; d[n + 2] = c; this.n = n + 3;
  }
  clear(): void { this.n = 0; }
  /** Exact-length copy (persistable / transferable). */
  snapshot(): Float32Array { return this.data.slice(0, this.n); }
  view(): Float32Array { return this.data.subarray(0, this.n); }
}

export class F64 {
  data: Float64Array;
  n = 0;
  constructor(cap = 256) { this.data = new Float64Array(cap); }
  reserve(extra: number): void {
    const need = this.n + extra;
    if (need <= this.data.length) return;
    let cap = this.data.length || 16;
    while (cap < need) cap *= 2;
    const d = new Float64Array(cap);
    d.set(this.data.subarray(0, this.n));
    this.data = d;
  }
  push(v: number): void { if (this.n >= this.data.length) this.reserve(1); this.data[this.n++] = v; }
  push2(a: number, b: number): void {
    if (this.n + 2 > this.data.length) this.reserve(2);
    this.data[this.n] = a; this.data[this.n + 1] = b; this.n += 2;
  }
  clear(): void { this.n = 0; }
  snapshot(): Float64Array { return this.data.slice(0, this.n); }
  view(): Float64Array { return this.data.subarray(0, this.n); }
}

export class U32 {
  data: Uint32Array;
  n = 0;
  constructor(cap = 64) { this.data = new Uint32Array(cap); }
  push(v: number): void {
    if (this.n >= this.data.length) {
      const d = new Uint32Array(Math.max(16, this.data.length * 2));
      d.set(this.data); this.data = d;
    }
    this.data[this.n++] = v;
  }
  clear(): void { this.n = 0; }
  snapshot(): Uint32Array { return this.data.slice(0, this.n); }
}

import { describe, it, expect } from 'vitest';
import { createLedger, deviceClass, LEDGER_CAPS } from '../src/render/ledger';

/** Fake canvas: `fail` makes getContext return null (simulated allocation failure). */
function factory(state: { fail: number; made: number }) {
  return () => {
    state.made++;
    const c = { width: 300, height: 150, getContext: () => (state.fail > 0 ? (state.fail--, null) : {}) };
    return c as unknown as HTMLCanvasElement;
  };
}
const MB = 1024 * 1024;

describe('CanvasLedger', () => {
  it('counts bytes through alloc, resize and free', () => {
    const st = { fail: 0, made: 0 };
    const L = createLedger('desktop', factory(st));
    expect(L.cap).toBe(LEDGER_CAPS.desktop);
    const a = L.alloc(512, 512, 'tile')!;
    const b = L.alloc(100.2, 50, 'wet')!;
    expect(a.width).toBe(512);
    expect(b.width).toBe(101);
    expect(L.bytes).toBe(512 * 512 * 4 + 101 * 50 * 4);
    expect(L.resize(b, 200, 100)).toBe(true);
    expect(L.bytes).toBe(512 * 512 * 4 + 200 * 100 * 4);
    expect(L.byTag()).toEqual({ tile: 512 * 512 * 4, wet: 200 * 100 * 4 });
    L.free(a);
    expect(a.width).toBe(0);
    expect(a.height).toBe(0);
    expect(L.bytes).toBe(200 * 100 * 4);
    expect(L.count).toBe(1);
    L.free(a);                                           // double free is harmless
    expect(L.bytes).toBe(200 * 100 * 4);
  });

  it('asks evictors for memory when the budget would be exceeded, then allocates', () => {
    const st = { fail: 0, made: 0 };
    const L = createLedger('phone', factory(st));
    const tiles: HTMLCanvasElement[] = [];
    const asked: number[] = [];
    L.onPressure(need => {
      asked.push(need);
      let freed = 0;
      while (freed < need && tiles.length) { const t = tiles.shift()!; freed += t.width * t.height * 4; L.free(t); }
    });
    for (let i = 0; i < 200; i++) { const t = L.alloc(512, 512, 'tile'); if (t) tiles.push(t); }
    expect(asked.length).toBeGreaterThan(0);
    expect(L.bytes).toBeLessThanOrEqual(160 * MB);
  });

  it('evicts and retries once when the browser refuses a context; null after a second refusal', () => {
    const st = { fail: 1, made: 0 };
    const L = createLedger('tablet', factory(st));
    let calls = 0;
    L.onPressure(() => { calls++; });
    expect(L.alloc(64, 64, 'x')).not.toBeNull();
    expect(calls).toBe(1);
    st.fail = 2;
    expect(L.alloc(64, 64, 'x')).toBeNull();
    expect(calls).toBe(2);
    expect(L.bytes).toBe(64 * 64 * 4);
  });

  it('rejects empty sizes; adopts foreign canvases; device class defaults to desktop outside a browser', () => {
    const L = createLedger('desktop', factory({ fail: 0, made: 0 }));
    expect(L.alloc(0, 10, 'x')).toBeNull();
    const foreign = { width: 10, height: 10, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    L.adopt(foreign, 'overlay');
    expect(L.bytes).toBe(400);
    expect(deviceClass()).toBe('desktop');
  });
});

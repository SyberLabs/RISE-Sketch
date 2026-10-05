import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prefs, prefKey, prefKeys } from '../src/persist/prefs';

class FakeStorage {
  map = new Map<string, string>();
  failWrites = false;
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (this.failWrites) throw new DOMException('full', 'QuotaExceededError');
    this.map.set(k, v);
  }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const g = globalThis as { localStorage?: unknown };
let ls: FakeStorage;

describe('prefs', () => {
  beforeEach(() => { ls = new FakeStorage(); g.localStorage = ls; });
  afterEach(() => { for (const k of prefKeys()) prefs.remove(k); delete g.localStorage; });

  it('namespaces keys under rise: without doubling the prefix', () => {
    expect(prefKey('tool')).toBe('rise:tool');
    expect(prefKey('rise:calib:pen')).toBe('rise:calib:pen');
    prefs.set('tool', { nib: 'brush' });
    expect(ls.getItem('rise:tool')).toBe('{"nib":"brush"}');
    prefs.save('rise:calib:pen', 'raw');
    expect(ls.getItem('rise:calib:pen')).toBe('raw');
    expect(prefs.load('calib:pen')).toBe('raw');
  });

  it('returns the fallback for missing, corrupt or wrongly typed values', () => {
    expect(prefs.get('missing', 3)).toBe(3);
    ls.setItem('rise:corrupt', '{nope');
    expect(prefs.get('corrupt', { a: 1 })).toEqual({ a: 1 });
    prefs.set('n', 5);
    expect(prefs.get('n', 'text')).toBe('text');
    expect(prefs.get('n', 0)).toBe(5);
    prefs.set('arr', [1, 2]);
    expect(prefs.get('arr', {})).toEqual({});
    expect(prefs.get<number[]>('arr', [])).toEqual([1, 2]);
    expect(prefs.get<unknown>('arr', null)).toEqual([1, 2]);
  });

  it('keeps values in memory when storage writes fail, then hands back to storage', () => {
    ls.failWrites = true;
    prefs.set('penMode', true);
    expect(prefs.get('penMode', false)).toBe(true);
    expect(ls.getItem('rise:penMode')).toBe(null);
    ls.failWrites = false;
    prefs.set('penMode', false);
    expect(ls.getItem('rise:penMode')).toBe('false');
    expect(prefs.get('penMode', true)).toBe(false);
  });

  it('works with no localStorage at all, and when access throws', () => {
    delete g.localStorage;
    prefs.set('x', 1);
    expect(prefs.get('x', 0)).toBe(1);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    expect(() => prefs.set('y', 2)).not.toThrow();
    expect(prefs.get('y', 0)).toBe(2);
    expect(prefs.load('nothing')).toBe(null);
    delete g.localStorage;
  });

  it('remove and set(undefined) delete', () => {
    prefs.set('a', 1);
    prefs.remove('a');
    expect(prefs.get('a', 0)).toBe(0);
    prefs.set('b', 1);
    prefs.set('b', undefined);
    expect(ls.getItem('rise:b')).toBe(null);
  });
});

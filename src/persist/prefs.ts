/**
 * Preferences in localStorage under the `rise:` prefix (DESIGN §8). The prefix
 * matters because Chrome gives every `file://` page the same origin.
 *
 * Every access is wrapped in try/catch: storage can be disabled, full, or throw on
 * access (Safari private mode, blocked third-party storage). When a write fails the
 * value is kept in memory for the rest of the session, so reads stay consistent
 * (e.g. the pen-mode flag still sticks), and a later successful write clears it.
 */

const PREFIX = 'rise:';
const mem = new Map<string, string>();

/** Full storage key: keys that already carry the prefix (e.g. 'rise:calib:pen') are used as is. */
export function prefKey(key: string): string {
  return key.startsWith(PREFIX) ? key : PREFIX + key;
}

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // accessing the property itself can throw (SecurityError)
  }
}

function rawGet(k: string): string | null {
  const m = mem.get(k);
  if (m !== undefined) return m;
  try {
    return store()?.getItem(k) ?? null;
  } catch {
    return null;
  }
}

function rawSet(k: string, v: string): void {
  try {
    const s = store();
    if (!s) throw new Error('no localStorage');
    s.setItem(k, v);
    mem.delete(k);
  } catch {
    mem.set(k, v);
  }
}

function rawRemove(k: string): void {
  mem.delete(k);
  try {
    store()?.removeItem(k);
  } catch {
    // nothing to do: the in-memory copy is already gone
  }
}

/** True when `v` has the same JSON kind as `fallback` (null fallback accepts anything). */
function sameKind(v: unknown, fallback: unknown): boolean {
  if (fallback === null || fallback === undefined) return true;
  if (Array.isArray(fallback)) return Array.isArray(v);
  if (typeof fallback === 'object') return !!v && typeof v === 'object' && !Array.isArray(v);
  return typeof v === typeof fallback;
}

/** localStorage preferences under 'rise:'; never throws. */
export const prefs = {
  /** Parsed JSON value, or `fallback` when missing, unparsable, or of a different JSON kind. */
  get<T>(key: string, fallback: T): T {
    const s = rawGet(prefKey(key));
    if (s === null) return fallback;
    try {
      const v: unknown = JSON.parse(s);
      return sameKind(v, fallback) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  },
  /** Store `v` as JSON (undefined removes the key). */
  set(key: string, v: unknown): void {
    if (v === undefined) { rawRemove(prefKey(key)); return; }
    let s: string;
    try {
      s = JSON.stringify(v);
    } catch {
      return; // cyclic or otherwise unserialisable: ignore rather than throw into UI code
    }
    rawSet(prefKey(key), s);
  },
  remove(key: string): void {
    rawRemove(prefKey(key));
  },
  /** Raw string (for createLearner's io). */
  load(key: string): string | null {
    return rawGet(prefKey(key));
  },
  /** Raw string (for createLearner's io). */
  save(key: string, v: string): void {
    rawSet(prefKey(key), v);
  },
};

/** Every stored `rise:` key (debug / reset). */
export function prefKeys(): string[] {
  const out = new Set<string>(mem.keys());
  try {
    const s = store();
    if (s) for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(PREFIX)) out.add(k); }
  } catch {
    // storage unavailable: memory keys only
  }
  return [...out].sort();
}

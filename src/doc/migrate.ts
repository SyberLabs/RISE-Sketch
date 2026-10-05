/**
 * `.rise` format evolution (DESIGN §8): an ordered list `migrations[v](json) -> json`
 * that lifts a version-v document to v + 1. Each migration is a pure function of
 * the parsed JSON tree and never touches recipe geometry semantics (a migration that
 * changed how a stroke cooks would break "ink is frozen once laid"); it only moves,
 * renames or fills fields. Every format version keeps a committed fixture under
 * tests/fixtures/ that must migrate to its golden sceneHash.
 *
 * Version 1 is the first published format, so the list is empty; the runner is
 * exercised by tests with injected migrations.
 */

/** A parsed `.rise` JSON tree. */
export type RiseJson = { [key: string]: unknown };
/** Lifts a version-v tree to version v + 1. May mutate and return its input. */
export type Migration = (json: RiseJson) => RiseJson;

/** migrations[v] upgrades a version-v document to v + 1 (index 0 is unused: there is no v0). */
export const migrations: readonly (Migration | undefined)[] = [];

/** Thrown when a document cannot be brought to the target version. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Run `list[from] .. list[to - 1]` over `json` and stamp `version = to`.
 * Throws MigrationError for versions outside [1, to] or a missing step.
 */
export function migrate(json: RiseJson, from: number, to: number, list: readonly (Migration | undefined)[] = migrations): RiseJson {
  if (!Number.isInteger(from) || from < 1) throw new MigrationError(`unsupported format version ${String(from)}`);
  if (from > to) throw new MigrationError(`format version ${from} is newer than this app understands (${to}); update Rise to open it`);
  let cur = json;
  for (let v = from; v < to; v++) {
    const step = list[v];
    if (!step) throw new MigrationError(`no migration from format version ${v} to ${v + 1}`);
    const next = step(cur);
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new MigrationError(`migration ${v} -> ${v + 1} returned a non-object`);
    next.version = v + 1;
    cur = next;
  }
  return cur;
}

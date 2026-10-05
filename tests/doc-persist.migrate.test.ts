import { describe, it, expect } from 'vitest';
import { migrate, migrations, MigrationError } from '../src/doc/migrate';
import type { Migration, RiseJson } from '../src/doc/migrate';
import { FORMAT_VERSION } from '../src/doc/serialize';

describe('migrations', () => {
  it('has a step for every version below the current one', () => {
    for (let v = 1; v < FORMAT_VERSION; v++) expect(typeof migrations[v]).toBe('function');
    expect(migrations.length).toBeLessThanOrEqual(FORMAT_VERSION);
  });

  it('is the identity at the current version', () => {
    const j: RiseJson = { format: 'rise', version: FORMAT_VERSION, x: 1 };
    expect(migrate(j, FORMAT_VERSION, FORMAT_VERSION)).toBe(j);
  });

  it('runs injected steps in order and stamps each version', () => {
    const seen: number[] = [];
    const list: (Migration | undefined)[] = [];
    list[1] = j => { seen.push(j.version as number); return { ...j, renamed: j.old, old: undefined }; };
    list[2] = j => { seen.push(j.version as number); j.filled = true; return j; };
    const out = migrate({ format: 'rise', version: 1, old: 'v' }, 1, 3, list);
    expect(seen).toEqual([1, 2]);
    expect(out).toMatchObject({ version: 3, renamed: 'v', filled: true });
  });

  it('refuses newer, invalid or unbridgeable versions', () => {
    expect(() => migrate({}, FORMAT_VERSION + 1, FORMAT_VERSION)).toThrow(/newer/);
    expect(() => migrate({}, 0, FORMAT_VERSION)).toThrow(MigrationError);
    expect(() => migrate({}, 1.5, 2)).toThrow(MigrationError);
    expect(() => migrate({}, 1, 2, [])).toThrow(/no migration/);
    const bad: (Migration | undefined)[] = [undefined, () => null as unknown as RiseJson];
    expect(() => migrate({}, 1, 2, bad)).toThrow(/non-object/);
  });
});

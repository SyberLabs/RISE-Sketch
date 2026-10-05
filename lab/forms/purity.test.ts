/**
 * The lab is outside src, so tests/purity.test.ts does not scan it. Prototypes must still
 * obey DESIGN §7.5 rule 3 (geometry determinism) or they can never be promoted.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname);
const ALLOWED_MATH = new Set(['sqrt', 'abs', 'floor', 'ceil', 'round', 'trunc', 'min', 'max', 'imul', 'fround', 'sign', 'clz32']);
const codeOnly = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``').replace(/'(?:\\.|[^'\\\n])*'/g, "''").replace(/"(?:\\.|[^"\\\n])*"/g, '""');

describe('lab purity', () => {
  it('*.form.ts use only the Math allow-list, no **, Date, performance or DOM', () => {
    const bad: string[] = [];
    for (const f of readdirSync(DIR).filter(f => f.endsWith('.form.ts'))) {
      const code = codeOnly(readFileSync(join(DIR, f), 'utf8'));
      for (const m of code.matchAll(/\bMath\.([a-zA-Z0-9_]+)/g)) if (!ALLOWED_MATH.has(m[1])) bad.push(`${f}: Math.${m[1]}`);
      if (/\*\*/.test(code)) bad.push(`${f}: ** operator`);
      for (const w of ['Date', 'performance', 'window', 'document', 'Math.random']) if (new RegExp(`\\b${w.replace('.', '\\.')}\\b`).test(code)) bad.push(`${f}: ${w}`);
    }
    expect(bad).toEqual([]);
  });
});

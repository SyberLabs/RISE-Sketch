/**
 * Enforces docs/DESIGN.md §7.3 (dependency direction) and §7.5 rule 3 (Math
 * allow-list in geometry modules) on the source text.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.ts$/.test(f)) out.push(p);
  }
  return out;
}
const files = walk(SRC).map(p => ({ path: p, rel: relative(SRC, p).split(sep).join('/'), text: readFileSync(p, 'utf8') }));

/** Strip comments and string/template literals so prose never trips the scanners. */
function codeOnly(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

const GEOMETRY = (rel: string) =>
  rel === 'core/det.ts' || rel === 'core/geom.ts' || rel === 'core/num.ts' || rel === 'core/mat.ts' ||
  (rel.startsWith('ink/') && rel !== 'ink/color.ts');
const ALLOWED_MATH = new Set(['sqrt', 'abs', 'floor', 'ceil', 'round', 'trunc', 'min', 'max', 'imul', 'fround', 'sign', 'clz32']);

describe('purity', () => {
  it('geometry modules use only the Math allow-list, no **, Date or performance', () => {
    const bad: string[] = [];
    for (const f of files.filter(f => GEOMETRY(f.rel))) {
      const code = codeOnly(f.text);
      for (const m of code.matchAll(/\bMath\.([a-zA-Z0-9_]+)/g)) {
        if (!ALLOWED_MATH.has(m[1])) bad.push(`${f.rel}: Math.${m[1]}`);
      }
      if (/\*\*/.test(code)) bad.push(`${f.rel}: ** operator`);
      if (/\bDate\b/.test(code)) bad.push(`${f.rel}: Date`);
      if (/\bperformance\b/.test(code)) bad.push(`${f.rel}: performance`);
    }
    expect(bad).toEqual([]);
  });

  it('import edges follow the dependency direction', () => {
    // layer -> layers it may import from
    const MAY: Record<string, string[]> = {
      core: ['core'],
      ink: ['core', 'ink'],
      doc: ['core', 'doc'],
      scene: ['core', 'ink', 'doc', 'scene', 'sched'],
      sched: ['core', 'sched'],
      render: ['core', 'ink', 'doc', 'scene', 'sched', 'render'],
      export: ['core', 'ink', 'doc', 'scene', 'render', 'export'],
      input: ['core', 'input'],
      persist: ['core', 'doc', 'persist'],
      ui: ['core', 'ui', 'app/types', 'app/store', 'render/types', 'render/glyphs'],
      app: ['*'],
      assets: ['core', 'assets'],
    };
    const bad: string[] = [];
    for (const f of files) {
      const layer = f.rel.includes('/') ? f.rel.split('/')[0] : 'root';
      if (layer === 'root' || layer === 'app') continue;
      const allowed = MAY[layer];
      if (!allowed) continue;
      for (const m of f.text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const target = join(f.path, '..', m[1]);
        const trel = relative(SRC, target).split(sep).join('/');
        const tl = trel.split('/')[0];
        const ok = allowed.includes('*') || allowed.includes(tl) || allowed.some(a => a.includes('/') && trel.startsWith(a));
        if (!ok) bad.push(`${f.rel} -> ${trel}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('pure layers never touch the DOM', () => {
    const bad: string[] = [];
    for (const f of files.filter(f => /^(core|ink|doc|scene)\//.test(f.rel))) {
      const code = codeOnly(f.text);
      for (const w of ['window', 'document', 'Path2D', 'HTMLCanvasElement', 'requestAnimationFrame', 'localStorage', 'indexedDB']) {
        if (new RegExp(`\\b${w}\\b`).test(code)) bad.push(`${f.rel}: ${w}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

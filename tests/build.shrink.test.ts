/**
 * scripts/shrink.ts (DESIGN §9 Single-file bundle): renaming private and protected members must
 * reach every reference. Unit tests run the original sources, so a missed reference only breaks
 * the built app: before the fix, `this.arcReveal = true` in PlayStroke's constructor kept its
 * name while WakeItem's field was renamed, and every replayed trunk popped in whole.
 *
 * The live layer's classes live in separate files (render/live/: WakeItem in items.ts, its
 * subclasses in stroke.ts and play.ts), so the check spans them all: a `this.<member>` in one
 * file whose declaration, in any of them, is renamed must be renamed too.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { planShrink } from '../scripts/shrink';

const norm = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase();

describe('shrink: private / protected renames', () => {
  it('renames every this.<member> in render/live whose declaration is renamed, across files', () => {
    const root = resolve(__dirname, '..');
    const plan = planShrink(root);
    const dir = resolve(root, 'src/render/live');
    const files = readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => resolve(dir, f));
    expect(files.length).toBeGreaterThan(1);
    // renamed positions per file
    const at = new Map<string, Set<number>>();
    for (const f of files) at.set(norm(f), new Set((plan.edits.get(norm(f)) ?? []).map(e => e.start)));
    const renamed = (sf: ts.SourceFile, pos: number): boolean => at.get(norm(sf.fileName))?.has(pos) ?? false;
    // an independent checker over the same files: which declaration does each this.<name> reach?
    const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root);
    const program = ts.createProgram({ rootNames: files, options: cfg.options });
    const checker = program.getTypeChecker();
    const missed: string[] = [];
    let checked = 0, crossFile = 0;
    for (const f of files) {
      const sf = program.getSourceFile(f)!;
      const visit = (n: ts.Node): void => {
        if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const decl = checker.getSymbolAtLocation(n.name)?.declarations?.[0] as ts.NamedDeclaration | undefined;
          const dsf = decl?.getSourceFile();
          if (decl?.name && dsf && at.has(norm(dsf.fileName)) && renamed(dsf, decl.name.getStart(dsf))) {
            checked++;
            if (dsf !== sf) crossFile++;
            if (!renamed(sf, n.name.getStart(sf))) missed.push(`${n.name.text} at ${sf.fileName.split('/').pop()}:${sf.getLineAndCharacterOfPosition(n.name.getStart(sf)).line + 1}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(checked).toBeGreaterThan(300);
    // the subclasses reach WakeItem's protected members from other files (camRev, arcReveal, beyond…)
    expect(crossFile).toBeGreaterThan(10);
    expect(missed).toEqual([]);
  }, 60000);
});

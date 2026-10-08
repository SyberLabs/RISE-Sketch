/**
 * scripts/shrink.ts (DESIGN §9 Single-file bundle): renaming private and protected members must
 * reach every reference. Unit tests run the unshrunk sources, so a missed reference only breaks
 * the built app: before the fix, `this.arcReveal = true` in PlayStroke's constructor kept its
 * name while WakeItem's field was renamed, and every replayed trunk popped in whole.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import ts from 'typescript';
import { planShrink } from '../scripts/shrink';

describe('shrink: private / protected renames', () => {
  it('renames every this.<member> in render/live.ts whose declaration is renamed', () => {
    const root = resolve(__dirname, '..');
    const plan = planShrink(root);
    const edits = [...plan.edits].find(([f]) => f.endsWith('/src/render/live.ts'))![1];
    const at = new Set(edits.map(e => e.start));
    // an independent checker over the same file: which declaration does each this.<name> reach?
    const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root);
    const program = ts.createProgram({ rootNames: [resolve(root, 'src/render/live.ts')], options: cfg.options });
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(resolve(root, 'src/render/live.ts'))!;
    const missed: string[] = [];
    let checked = 0;
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const decl = checker.getSymbolAtLocation(n.name)?.declarations?.[0] as ts.NamedDeclaration | undefined;
        if (decl?.name && decl.getSourceFile() === sf && at.has(decl.name.getStart(sf))) {
          checked++;
          if (!at.has(n.name.getStart(sf))) missed.push(`${n.name.text} at line ${sf.getLineAndCharacterOfPosition(n.name.getStart(sf)).line + 1}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(checked).toBeGreaterThan(300);
    expect(missed).toEqual([]);
  }, 60000);
});

/**
 * Build-only, type-aware source rewrites that the minifier cannot do on its own (bundle size,
 * DESIGN §9 "Single-file bundle"). Both are semantics-preserving by construction: they use the
 * TypeScript checker over the whole of src/, and run before oxc strips the types.
 *
 *  1. Cross-module `const enum` inlining. oxc compiles each file alone (isolatedModules), so an
 *     imported `S.STRIDE` stays a property read on a runtime enum object. The checker knows the
 *     value (`getConstantValue`), so every access to a member of a `const enum` becomes its literal,
 *     and the then-unused enum objects are tree-shaken.
 *  2. Short names for TypeScript `private` and `protected` members. They are reachable only inside
 *     their own class (and, for protected, its subclasses): any other access is a type error, so
 *     renaming every reference the checker resolves to them is safe. Each distinct name gets one
 *     `$`-prefixed short name (`$a`, `$Q9`…); nothing else in src/ uses that namespace, so no
 *     rename can collide with another member. Overrides share their base member's name, so they
 *     stay overrides. A protected name that some class also declares public (a subclass may widen
 *     it) is left alone.
 *
 * Unit tests run the original sources (vitest skips this: `apply: 'build'`); the e2e suite runs
 * the debug single-file build, which goes through these rewrites like production does.
 */
import ts from 'typescript';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

interface Edit { start: number; end: number; text: string }

const norm = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase();

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$';
function shortName(i: number): string {
  let s = '';
  do { s = ALPHA[i % 64] + s; i = Math.floor(i / 64) - 1; } while (i >= 0);
  return '$' + s;
}

const hasConst = (d: ts.EnumDeclaration): boolean => (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Const) !== 0;

function isConstEnumMember(sym: ts.Symbol | undefined): boolean {
  const decl = sym?.valueDeclaration;
  return !!decl && ts.isEnumMember(decl) && hasConst(decl.parent);
}

/** A class member's declared visibility. */
function access(node: ts.Node): 'private' | 'protected' | 'public' {
  const m = ts.canHaveModifiers(node) ? ts.getCombinedModifierFlags(node as ts.Declaration) : 0;
  return m & ts.ModifierFlags.Private ? 'private' : m & ts.ModifierFlags.Protected ? 'protected' : 'public';
}

/** Class members: properties, methods, accessors and constructor parameter properties. */
function isMember(n: ts.Node): n is ts.PropertyDeclaration | ts.MethodDeclaration | ts.AccessorDeclaration | ts.ParameterDeclaration {
  if (ts.isParameter(n)) return ts.isConstructorDeclaration(n.parent) && (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.ParameterPropertyModifier) !== 0;
  return (ts.isPropertyDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && ts.isClassLike(n.parent);
}

/** Compute every edit, per normalised file name. */
export function planShrink(root: string, srcDir = 'src'): { edits: Map<string, Edit[]>; texts: Map<string, string>; stats: { enums: number; privates: number; refs: number } } {
  const cfgPath = resolve(root, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const srcRoot = norm(resolve(root, srcDir)) + '/';
  // src/ only (tsconfig.json also lists vite.config.ts, which would drag in vite's and node's types)
  const rootNames = parsed.fileNames.filter(f => norm(f).startsWith(srcRoot));
  const program = ts.createProgram({ rootNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const edits = new Map<string, Edit[]>();
  const texts = new Map<string, string>();
  const push = (file: string, e: Edit): void => { const k = norm(file); let a = edits.get(k); if (!a) edits.set(k, a = []); a.push(e); };
  const stats = { enums: 0, privates: 0, refs: 0 };

  const ours = program.getSourceFiles().filter(sf => !sf.isDeclarationFile && norm(sf.fileName).startsWith(srcRoot));
  const privates: ts.Identifier[] = [], protecteds: ts.Identifier[] = [];
  const publicNames = new Set<string>(); // every public class member name in src/
  // Every top-level `const enum` name in src/, plus local aliases (`import { S as SR }`): only reads
  // under these names are handed to the checker. A read under any other name is left as it is.
  const enumNames = new Set<string>();
  for (const sf of ours) for (const st of sf.statements) if (ts.isEnumDeclaration(st) && hasConst(st)) enumNames.add(st.name.text);
  for (const sf of ours) for (const st of sf.statements) {
    const nb = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (nb && ts.isNamedImports(nb)) for (const sp of nb.elements) if (sp.propertyName && enumNames.has(sp.propertyName.text)) enumNames.add(sp.name.text);
  }
  for (const sf of ours) {
    texts.set(norm(sf.fileName), sf.text);
    const visit = (n: ts.Node): void => {
      // 1. const enum member reads: S.X (and S['X'])
      // (a syntactic pre-filter on the enum names keeps the checker work small)
      if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && ts.isIdentifier(n.expression) && enumNames.has(n.expression.text)) {
        const v = checker.getConstantValue(n);
        const sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : n.argumentExpression);
        if (typeof v === 'number' && Number.isFinite(v) && isConstEnumMember(sym)) {
          push(sf.fileName, { start: n.getStart(sf), end: n.getEnd(), text: `(${v})` });
          stats.enums++;
          return;
        }
      }
      // 2. class member declarations, by visibility
      if (isMember(n) && ts.isIdentifier(n.name)) {
        const a = access(n);
        if (a === 'private') privates.push(n.name);
        else if (a === 'protected') protecteds.push(n.name);
        else publicNames.add(n.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // Rename: one checker pass over src/ finds every reference (identifiers resolving to a renamed
  // symbol, plus `{ a, b } = this` shorthand bindings, which name the property implicitly).
  // References are matched by declaration, not by symbol identity: the checker can hand back a
  // fresh symbol for an inherited member (`this.arcReveal = true` in a subclass constructor), and
  // a missed reference is a silent bug (the subclass writes a property nobody reads). A parameter
  // property is two symbols (the parameter and the property) with one declaration: both match.
  const target = new Map<ts.Node, string>();
  const nameOf = (s: ts.Symbol | undefined): string | undefined => {
    for (const d of s?.declarations ?? []) { const t = target.get(d); if (t) return t; }
    return undefined;
  };
  const privateNames = new Set<string>(); // only identifiers with these texts are worth resolving
  for (const id of [...privates, ...protecteds.filter(p => !publicNames.has(p.text))]) {
    privateNames.add(id.text);
    target.set(id.parent, id.text);
  }
  // `pre` / `post`: text kept around the new name where a shorthand names two things at once.
  const found: { file: string; start: number; end: number; name: string; pre: string; post: string }[] = [];
  const count = new Map<string, number>();
  for (const sf of ours) {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && privateNames.has(n.text)) {
        const p = n.parent;
        let name = nameOf(checker.getSymbolAtLocation(n));
        let pre = '', post = '';
        if (!name && ts.isBindingElement(p) && p.name === n && !p.propertyName && ts.isObjectBindingPattern(p.parent)) {
          // `const { a } = this` with `a` private: the key is renamed, the local keeps its name
          const prop = checker.getTypeAtLocation(p.parent).getProperty(n.text);
          if (prop && (name = nameOf(prop))) post = ': ' + n.text;
        } else if (ts.isShorthandPropertyAssignment(p) && p.name === n) {
          // `{ a }` reading a renamed parameter property's parameter: the key stays, the value is renamed
          const v = checker.getShorthandAssignmentValueSymbol(p);
          if (v && (name = nameOf(v))) pre = n.text + ': ';
        }
        if (name) {
          found.push({ file: sf.fileName, start: n.getStart(sf), end: n.getEnd(), name, pre, post });
          count.set(name, (count.get(name) ?? 0) + 1);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // Most-referenced names get the shortest replacements.
  const short = new Map<string, string>();
  [...count].sort((a, b) => b[1] - a[1]).forEach(([n], i) => short.set(n, shortName(i)));
  for (const f of found) push(f.file, { start: f.start, end: f.end, text: f.pre + short.get(f.name)! + f.post });
  stats.privates = short.size;
  stats.refs = found.length;

  // Sort, drop exact duplicates, refuse overlaps.
  for (const [file, list] of edits) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    const out: Edit[] = [];
    for (const e of list) {
      const prev = out[out.length - 1];
      if (prev && prev.start === e.start && prev.end === e.end && prev.text === e.text) continue;
      if (prev && e.start < prev.end) throw new Error(`[shrink] overlapping edits in ${file} at ${e.start}`);
      out.push(e);
    }
    edits.set(file, out);
  }
  return { edits, texts, stats };
}

export function applyEdits(text: string, list: readonly Edit[]): string {
  let out = '', at = 0;
  for (const e of list) { out += text.slice(at, e.start) + e.text; at = e.end; }
  return out + text.slice(at);
}

/** The Vite plugin: plans once per build, rewrites each src/ module before oxc sees it. */
export function shrink(): Plugin {
  let plan: ReturnType<typeof planShrink> | null = null;
  let root = process.cwd();
  return {
    name: 'rise:shrink',
    apply: 'build',
    enforce: 'pre',
    configResolved(c) { root = c.root; },
    buildStart() {
      plan = planShrink(root);
      this.info(`inlined ${plan.stats.enums} const enum reads; renamed ${plan.stats.privates} private/protected members (${plan.stats.refs} references)`);
    },
    transform(code, id) {
      if (!plan || !/\.ts$/.test(id)) return null;
      const k = norm(id.split('?')[0]);
      const list = plan.edits.get(k);
      if (!list) return null;
      // Only rewrite the exact text the checker saw; anything else is a bug upstream, so fail loudly.
      if (plan.texts.get(k) !== code) this.error(`[shrink] ${id} changed between planning and transform`);
      return { code: applyEdits(code, list), map: null };
    },
  };
}

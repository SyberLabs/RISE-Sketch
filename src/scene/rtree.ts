/**
 * Dynamic R-tree (Guttman 1984): quadratic split, at most 9 entries per node,
 * at least 4 in every non-root node. Items are kept in a map to their leaf entry,
 * so `remove(item)` needs no box and costs O(log n). Boxes are inclusive
 * (touching boxes intersect) and should be finite with x0 ≤ x1, y0 ≤ y1; a NaN
 * box never corrupts the tree, it is simply never found.
 *
 * Pure; search is recursive and allocation-free.
 */
import type { AABB } from '../core/types';

const MAX = 9;
const MIN = 4;

interface Entry<T> {
  x0: number; y0: number; x1: number; y1: number;
  item: T;
  node: RNode<T>;
}

class RNode<T> {
  x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
  parent: RNode<T> | null = null;
  /** Entries when `leaf`, otherwise child nodes. */
  kids: (RNode<T> | Entry<T>)[] = [];
  constructor(public leaf: boolean) {}
}

type Boxed = { x0: number; y0: number; x1: number; y1: number };

const area = (b: Boxed): number => (b.x1 - b.x0) * (b.y1 - b.y0);
const unionArea = (a: Boxed, b: Boxed): number =>
  (Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0)) * (Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0));
const hits = (a: Boxed, b: Boxed): boolean => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

function extend(n: Boxed, b: Boxed): void {
  if (b.x0 < n.x0) n.x0 = b.x0;
  if (b.y0 < n.y0) n.y0 = b.y0;
  if (b.x1 > n.x1) n.x1 = b.x1;
  if (b.y1 > n.y1) n.y1 = b.y1;
}

function refit<T>(n: RNode<T>): void {
  n.x0 = Infinity; n.y0 = Infinity; n.x1 = -Infinity; n.y1 = -Infinity;
  for (const k of n.kids) extend(n, k);
}

/** Spatial index of items by axis-aligned box. */
export class RTree<T> {
  private root: RNode<T> = new RNode<T>(true);
  private readonly where = new Map<T, Entry<T>>();

  /** Index `item` under box `b` (the box is copied). Re-inserting an indexed item moves it. */
  insert(b: AABB, item: T): void {
    if (this.where.has(item)) this.remove(item);
    const e: Entry<T> = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, item, node: this.root };
    this.where.set(item, e);
    this.place(e);
  }

  /** Remove `item`; false if it was not indexed. */
  remove(item: T): boolean {
    const e = this.where.get(item);
    if (!e) return false;
    this.where.delete(item);
    const leaf = e.node;
    const i = leaf.kids.indexOf(e);
    if (i >= 0) leaf.kids.splice(i, 1);
    this.condense(leaf);
    return true;
  }

  /** Append every item whose box intersects `b` to `out` (out is not cleared). Returns out. */
  search(b: AABB, out: T[]): T[] {
    if (this.where.size > 0 && hits(this.root, b)) this.visit(this.root, b, out);
    return out;
  }

  has(item: T): boolean { return this.where.has(item); }

  /** The indexed box of `item` (a live view; do not mutate), or undefined. */
  boxOf(item: T): Readonly<AABB> | undefined { return this.where.get(item); }

  /** Union of every indexed box, or null when empty. */
  bounds(): AABB | null {
    if (this.where.size === 0) return null;
    const r = this.root;
    return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
  }

  clear(): void {
    this.root = new RNode<T>(true);
    this.where.clear();
  }

  get size(): number { return this.where.size; }

  /** Structural self-check for tests: throws on a broken invariant. Returns the tree height. */
  validate(): number {
    let leafDepth = -1;
    let count = 0;
    const walk = (n: RNode<T>, depth: number): void => {
      if (n !== this.root && (n.kids.length < MIN || n.kids.length > MAX)) throw new Error(`node fill ${n.kids.length}`);
      if (n.kids.length > MAX) throw new Error('root overflow');
      const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const k of n.kids) extend(b, k);
      if (n.kids.length && (b.x0 !== n.x0 || b.y0 !== n.y0 || b.x1 !== n.x1 || b.y1 !== n.y1)) throw new Error('stale box');
      if (n.leaf) {
        if (leafDepth < 0) leafDepth = depth; else if (leafDepth !== depth) throw new Error('unbalanced');
        for (const k of n.kids) {
          const e = k as Entry<T>;
          if (e.node !== n || this.where.get(e.item) !== e) throw new Error('bad entry link');
          count++;
        }
      } else {
        for (const k of n.kids) {
          const c = k as RNode<T>;
          if (c.parent !== n) throw new Error('bad parent link');
          walk(c, depth + 1);
        }
      }
    };
    walk(this.root, 0);
    if (count !== this.where.size) throw new Error(`count ${count} != ${this.where.size}`);
    return leafDepth + 1;
  }

  // ------------------------------------------------------------------ internals

  private visit(n: RNode<T>, b: AABB, out: T[]): void {
    const kids = n.kids;
    if (n.leaf) {
      for (let i = 0; i < kids.length; i++) {
        const e = kids[i] as Entry<T>;
        if (hits(e, b)) out.push(e.item);
      }
    } else {
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i] as RNode<T>;
        if (hits(c, b)) this.visit(c, b, out);
      }
    }
  }

  /** Insert a leaf entry: descend by least enlargement, then split upward on overflow. */
  private place(e: Entry<T>): void {
    let n = this.root;
    while (!n.leaf) {
      // default to the first child: NaN enlargements (a NaN box) compare false everywhere
      let best = n.kids[0] as RNode<T>;
      let bestGrow = Infinity, bestArea = Infinity;
      for (const k of n.kids) {
        const c = k as RNode<T>;
        const a = area(c);
        const grow = unionArea(c, e) - a;
        if (grow < bestGrow || (grow === bestGrow && a < bestArea)) { best = c; bestGrow = grow; bestArea = a; }
      }
      extend(n, e);
      n = best;
    }
    extend(n, e);
    n.kids.push(e);
    e.node = n;
    let over: RNode<T> | null = n.kids.length > MAX ? n : null;
    while (over) over = this.split(over);
  }

  /** Quadratic split of an overflowing node; returns the parent if it overflows in turn. */
  private split(n: RNode<T>): RNode<T> | null {
    const all = n.kids;
    // pick seeds: the pair that would waste the most area together
    let s1 = 0, s2 = 1, worst = -Infinity;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const d = unionArea(all[i], all[j]) - area(all[i]) - area(all[j]);
        if (d > worst) { worst = d; s1 = i; s2 = j; }
      }
    }
    const sib = new RNode<T>(n.leaf);
    const g1: (RNode<T> | Entry<T>)[] = [all[s1]];
    const g2: (RNode<T> | Entry<T>)[] = [all[s2]];
    const b1 = { x0: all[s1].x0, y0: all[s1].y0, x1: all[s1].x1, y1: all[s1].y1 };
    const b2 = { x0: all[s2].x0, y0: all[s2].y0, x1: all[s2].x1, y1: all[s2].y1 };
    const rest: (RNode<T> | Entry<T>)[] = [];
    for (let i = 0; i < all.length; i++) if (i !== s1 && i !== s2) rest.push(all[i]);

    while (rest.length) {
      if (g1.length + rest.length <= MIN) { for (const k of rest) { g1.push(k); extend(b1, k); } break; }
      if (g2.length + rest.length <= MIN) { for (const k of rest) { g2.push(k); extend(b2, k); } break; }
      // pick next: the entry with the strongest preference for one group
      let pick = 0, pref = -1, d1Best = 0, d2Best = 0;
      const a1 = area(b1), a2 = area(b2);
      for (let i = 0; i < rest.length; i++) {
        const d1 = unionArea(b1, rest[i]) - a1;
        const d2 = unionArea(b2, rest[i]) - a2;
        const p = Math.abs(d1 - d2);
        if (p > pref) { pref = p; pick = i; d1Best = d1; d2Best = d2; }
      }
      const k = rest[pick];
      rest[pick] = rest[rest.length - 1];
      rest.pop();
      const toFirst = d1Best < d2Best || (d1Best === d2Best && (a1 < a2 || (a1 === a2 && g1.length <= g2.length)));
      if (toFirst) { g1.push(k); extend(b1, k); } else { g2.push(k); extend(b2, k); }
    }

    n.kids = g1;
    sib.kids = g2;
    for (const k of g1) this.adopt(n, k);
    for (const k of g2) this.adopt(sib, k);
    refit(n);
    refit(sib);

    const parent = n.parent;
    if (!parent) {
      const root = new RNode<T>(false);
      root.kids = [n, sib];
      n.parent = root; sib.parent = root;
      refit(root);
      this.root = root;
      return null;
    }
    parent.kids.push(sib);
    sib.parent = parent;
    extend(parent, sib);
    return parent.kids.length > MAX ? parent : null;
  }

  private adopt(n: RNode<T>, k: RNode<T> | Entry<T>): void {
    if (n.leaf) (k as Entry<T>).node = n;
    else (k as RNode<T>).parent = n;
  }

  /** After a removal: dissolve underfull nodes up the path, refit boxes, reinsert orphans. */
  private condense(leaf: RNode<T>): void {
    const orphans: Entry<T>[] = [];
    let n = leaf;
    while (n !== this.root) {
      const parent = n.parent!;
      if (n.kids.length < MIN) {
        const i = parent.kids.indexOf(n);
        if (i >= 0) parent.kids.splice(i, 1);
        this.collect(n, orphans);
      } else {
        refit(n);
      }
      n = parent;
    }
    refit(this.root);
    while (!this.root.leaf && this.root.kids.length === 1) {
      const only = this.root.kids[0] as RNode<T>;
      only.parent = null;
      this.root = only;
    }
    if (!this.root.leaf && this.root.kids.length === 0) this.root = new RNode<T>(true);
    for (const e of orphans) this.place(e);
  }

  private collect(n: RNode<T>, out: Entry<T>[]): void {
    if (n.leaf) for (const k of n.kids) out.push(k as Entry<T>);
    else for (const k of n.kids) this.collect(k as RNode<T>, out);
  }
}

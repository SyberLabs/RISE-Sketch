import { describe, it, expect } from 'vitest';
import { RTree } from '../src/scene/rtree';
import type { AABB } from '../src/core/types';
import { mulberry } from './scene-sched.helpers';

const hits = (a: AABB, b: AABB) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

function randomBox(rnd: () => number, world = 10000, maxSize = 300): AABB {
  const x = (rnd() - 0.5) * world, y = (rnd() - 0.5) * world;
  // a mix of points, slivers and big boxes
  const k = rnd();
  const w = k < 0.1 ? 0 : k < 0.2 ? rnd() * 2 : rnd() * maxSize;
  const h = k < 0.1 ? 0 : k < 0.3 ? rnd() * maxSize * 4 : rnd() * maxSize;
  return { x0: x, y0: y, x1: x + w, y1: y + h };
}

function brute(boxes: Map<number, AABB>, q: AABB): number[] {
  const out: number[] = [];
  for (const [id, b] of boxes) if (hits(b, q)) out.push(id);
  return out.sort((a, b) => a - b);
}

describe('rtree vs brute force', () => {
  it('10k boxes, 1k queries; then 5k removals and 1k more queries', () => {
    const rnd = mulberry(7);
    const tree = new RTree<number>();
    const boxes = new Map<number, AABB>();
    for (let i = 0; i < 10000; i++) {
      const b = randomBox(rnd);
      boxes.set(i, b);
      tree.insert(b, i);
    }
    expect(tree.size).toBe(10000);
    const height = tree.validate();
    expect(height).toBeGreaterThan(2);
    expect(height).toBeLessThan(10);

    const out: number[] = [];
    let total = 0;
    for (let q = 0; q < 1000; q++) {
      const qb = randomBox(rnd, 11000, 1500);
      out.length = 0;
      tree.search(qb, out);
      const got = out.slice().sort((a, b) => a - b);
      expect(got).toEqual(brute(boxes, qb));
      total += got.length;
    }
    expect(total).toBeGreaterThan(1000); // the queries actually find things

    // remove half (random order), checking structure as we go
    const ids = [...boxes.keys()].sort(() => rnd() - 0.5).slice(0, 5000);
    ids.forEach((id, k) => {
      expect(tree.remove(id)).toBe(true);
      boxes.delete(id);
      if (k % 1000 === 999) tree.validate();
    });
    expect(tree.remove(ids[0])).toBe(false);
    expect(tree.size).toBe(5000);
    tree.validate();
    for (let q = 0; q < 1000; q++) {
      const qb = randomBox(rnd, 11000, 1500);
      out.length = 0;
      tree.search(qb, out);
      expect(out.slice().sort((a, b) => a - b)).toEqual(brute(boxes, qb));
    }
  });

  it('interleaved inserts, moves and removals stay consistent', () => {
    const rnd = mulberry(99);
    const tree = new RTree<string>();
    const boxes = new Map<string, AABB>();
    for (let step = 0; step < 6000; step++) {
      const k = rnd();
      const id = 'k' + Math.floor(rnd() * 800);
      if (k < 0.5) {
        const b = randomBox(rnd, 2000, 80);
        tree.insert(b, id); // insert of an existing item moves it
        boxes.set(id, b);
      } else {
        expect(tree.remove(id)).toBe(boxes.delete(id));
      }
      if (step % 500 === 0) tree.validate();
    }
    tree.validate();
    expect(tree.size).toBe(boxes.size);
    const out: string[] = [];
    for (let q = 0; q < 300; q++) {
      const qb = randomBox(rnd, 2200, 400);
      out.length = 0;
      tree.search(qb, out);
      const want = [...boxes].filter(([, b]) => hits(b, qb)).map(([id]) => id).sort();
      expect(out.sort()).toEqual(want);
    }
  });
});

describe('rtree basics', () => {
  it('empty tree, bounds, clear, inclusive edges, appending search', () => {
    const tree = new RTree<number>();
    expect(tree.bounds()).toBeNull();
    expect(tree.search({ x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 }, [])).toEqual([]);
    tree.insert({ x0: 0, y0: 0, x1: 10, y1: 10 }, 1);
    tree.insert({ x0: 20, y0: -5, x1: 30, y1: 5 }, 2);
    expect(tree.bounds()).toEqual({ x0: 0, y0: -5, x1: 30, y1: 10 });
    // touching counts
    expect(tree.search({ x0: 10, y0: 10, x1: 15, y1: 15 }, [])).toEqual([1]);
    // search appends
    const out = [99];
    tree.search({ x0: 25, y0: 0, x1: 26, y1: 1 }, out);
    expect(out).toEqual([99, 2]);
    expect(tree.has(2)).toBe(true);
    expect(tree.boxOf(2)).toMatchObject({ x0: 20, y0: -5, x1: 30, y1: 5 });
    // the inserted box was copied
    const b = { x0: 100, y0: 100, x1: 101, y1: 101 };
    tree.insert(b, 3);
    b.x0 = -1000;
    expect(tree.search({ x0: -1000, y0: 100, x1: -999, y1: 101 }, [])).toEqual([]);
    tree.remove(1);
    expect(tree.bounds()).toEqual({ x0: 20, y0: -5, x1: 101, y1: 101 });
    tree.clear();
    expect(tree.size).toBe(0);
    expect(tree.bounds()).toBeNull();
    tree.validate();
  });

  it('bounds track removals exactly through splits and condensation', () => {
    const tree = new RTree<number>();
    for (let i = 0; i < 500; i++) tree.insert({ x0: i, y0: -i, x1: i + 1, y1: -i + 1 }, i);
    expect(tree.bounds()).toEqual({ x0: 0, y0: -499, x1: 500, y1: 1 });
    for (let i = 499; i >= 10; i--) tree.remove(i);
    tree.validate();
    expect(tree.bounds()).toEqual({ x0: 0, y0: -9, x1: 10, y1: 1 });
    for (let i = 0; i < 10; i++) tree.remove(i);
    expect(tree.bounds()).toBeNull();
    tree.validate();
  });

  it('a NaN box in a multi-level tree is inert: no crash, never found, removable', () => {
    const tree = new RTree<number>();
    for (let i = 0; i < 200; i++) tree.insert({ x0: i, y0: i, x1: i + 1, y1: i + 1 }, i);
    expect(tree.validate()).toBeGreaterThan(1);              // the root is an inner node
    tree.insert({ x0: NaN, y0: 0, x1: 1, y1: 1 }, 1000);     // crashed in place() before the fix
    tree.insert({ x0: NaN, y0: NaN, x1: NaN, y1: NaN }, 1001);
    tree.insert({ x0: -Infinity, y0: 5, x1: Infinity, y1: 5 }, 1002);
    tree.validate();
    expect(tree.size).toBe(203);
    expect(tree.search({ x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 }, []).filter(i => i >= 1000)).toEqual([1002]);
    expect(tree.remove(1000)).toBe(true);
    expect(tree.remove(1001)).toBe(true);
    tree.validate();
    expect(tree.search({ x0: 10.5, y0: 10.5, x1: 10.5, y1: 10.5 }, [])).toEqual([10]);
  });

  it('handles many identical boxes and far-from-origin coordinates', () => {
    const tree = new RTree<number>();
    for (let i = 0; i < 300; i++) tree.insert({ x0: 1e7, y0: 1e7, x1: 1e7 + 1, y1: 1e7 + 1 }, i);
    tree.validate();
    expect(tree.search({ x0: 1e7 + 0.5, y0: 1e7 + 0.5, x1: 1e7 + 0.5, y1: 1e7 + 0.5 }, []).length).toBe(300);
    for (let i = 0; i < 300; i += 3) tree.remove(i);
    tree.validate();
    expect(tree.size).toBe(200);
  });
});

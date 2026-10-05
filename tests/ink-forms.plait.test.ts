import { describe, it, expect } from 'vitest';
import { plait, OVER, UNDER, crossingArc, strandSine, underA, periodFor, ampFor, gapOf, T_OVER, T_UNDER } from '../src/ink/operators/plait.v1';
import { opsIncremental, opsCook, opsLive, cookedProblems, Hand, cookedHash, formRecipe } from './ink-forms.fixtures';
import { cook, spineOf } from '../src/ink/cook';
import type { Cooked } from '../src/core/types';

// ---------------------------------------------------------------------------- gestures (the gallery's)

const sig = (seed = 3) => {
  const h = new Hand(0, 60, { jitter: 0.25, seed, p: 0.3 });
  h.moveTo(40, 20, 0.5, 0.7).arc(80, 40, 45, Math.PI, 2.1 * Math.PI, 0.9);
  h.moveTo(150, 110, 1.3, 0.55).arc(200, 110, 50, Math.PI, 1.9 * Math.PI, 1.6).moveTo(300, 40, 2.3, 0.25);
  return h;
};
const loop = (seed = 7) => {
  const h = new Hand(170, 90, { jitter: 0.15, seed, p: 0.6 });
  h.arc(110, 90, 60, 0, 2 * Math.PI * 1.01, 0.8);
  return h;
};
const corners = (seed = 9) => {
  const h = new Hand(10, 140, { jitter: 0.2, seed, p: 0.55 });
  h.moveTo(60, 20, 0.5).moveTo(61, 21, 0.05).hold(70).moveTo(130, 150, 0.6).moveTo(131, 149, 0.05).hold(70);
  h.moveTo(200, 20, 0.6).moveTo(201, 21, 0.05).hold(70).moveTo(280, 140, 0.9, 0.3);
  return h;
};
const straight = (speed: number, o: { p?: number; alt?: number; az?: number; c?: number; cs?: number; seed?: number; len?: number } = {}) => {
  const h = new Hand(0, 100, { jitter: 0, seed: o.seed ?? 1, p: o.p ?? 0.5, alt: o.alt, az: o.az, c: o.c, cs: o.cs });
  h.moveTo(o.len ?? 400, 100, speed);
  return h;
};
const tap = (hold = 60, seed = 13) => { const h = new Hand(0, 0, { jitter: 0.05, seed, p: 0.65 }); h.hold(hold); return h; };
const speedStroke = (v: number, p: number, seed: number) => {
  const h = new Hand(0, 60, { jitter: 0.2, seed, p });
  h.moveTo(120, 20, v).moveTo(240, 70, v).moveTo(380, 30, v);
  return h;
};

// ---------------------------------------------------------------------------- helpers

const growthPts = (c: Cooked): number => { let n = 0; for (let i = c.genStart[1] ?? c.nPolys; i < c.nPolys; i++) n += c.count[i]; return n; };
const gensOf = (c: Cooked): Set<number> => { const s = new Set<number>(); for (let i = c.genStart[1] ?? c.nPolys; i < c.nPolys; i++) s.add(c.gen[i]); return s; };
/** Unit start arcs (the polys' `born`), sorted. */
const unitArcs = (c: Cooked): number[] => {
  const m = new Map<number, number>();
  for (let i = c.genStart[1]; i < c.nPolys; i++) m.set(c.unit[i], c.born[i]);
  return [...m.values()].sort((a, b) => a - b);
};
/** Braid period away from cuts: a unit is half a period, so twice the median unit spacing. */
const medianPeriod = (c: Cooked): number => {
  const u = unitArcs(c), d = u.slice(1).map((x, i) => x - u[i]).sort((a, b) => a - b);
  return 2 * d[d.length >> 1];
};
/** Points (x, y, w) of every poly of gen g. */
function polysOf(c: Cooked, g: number): { x: number[]; y: number[]; w: number[]; unit: number }[] {
  const out: { x: number[]; y: number[]; w: number[]; unit: number }[] = [];
  for (let i = 0; i < c.nPolys; i++) {
    if (c.gen[i] !== g) continue;
    const x: number[] = [], y: number[] = [], w: number[] = [];
    for (let k = 0; k < c.count[i]; k++) { const j = 4 * (c.start[i] + k); x.push(c.pts[j]); y.push(c.pts[j + 1]); w.push(c.pts[j + 2]); }
    out.push({ x, y, w, unit: c.unit[i] });
  }
  return out;
}
/** Visible (w > 0) coverage of x by gen-g polys on a straight stroke along x: is any segment with both ends inked spanning x? */
function inkedAt(c: Cooked, g: number, x: number): boolean {
  for (const p of polysOf(c, g)) for (let k = 0; k + 1 < p.x.length; k++) {
    const a = p.x[k], b = p.x[k + 1];
    if (Math.min(a, b) <= x && x <= Math.max(a, b) && p.w[k] > 0.2 && p.w[k + 1] > 0.2) return true;
  }
  return false;
}
/** Max |y − 100| of gen ≥ 1 points with x in [x0, x1], split by side. */
function offsets(c: Cooked, x0 = -Infinity, x1 = Infinity): { up: number; down: number } {
  let up = 0, down = 0;
  for (let i = c.genStart[1]; i < c.nPolys; i++) for (let k = 0; k < c.count[i]; k++) {
    const j = 4 * (c.start[i] + k), x = c.pts[j], y = c.pts[j + 1] - 100;
    if (x < x0 || x > x1) continue;
    if (y < 0) up = Math.max(up, -y); else down = Math.max(down, y);
  }
  return { up, down };
}
const maxW = (c: Cooked, g: number): number => { let m = 0; for (const p of polysOf(c, g)) for (const w of p.w) m = Math.max(m, w); return m; };
const longStroke = () => {
  const h = new Hand(0, 0, { jitter: 0.1, seed: 5, p: 0.9 });
  for (let i = 0; i < 12; i++) h.arc(200 * (i % 2), 0, 200, i % 2 ? Math.PI : 0, i % 2 ? 2 * Math.PI : Math.PI, 0.2);
  return h;
};

// ---------------------------------------------------------------------------- pure braid facts

describe('plait: the braid rule', () => {
  it('crossing k joins the pair whose sines are equal there, and the over strand is the one rising at even k, falling at odd k', () => {
    for (let k = 0; k < 6; k++) {
      const phi = Math.PI / 6 + (k * Math.PI) / 3;
      const o = [0, 1, 2].map(m => strandSine(m, phi));
      const pair = [OVER[k], UNDER[k]];
      expect(Math.abs(o[pair[0]] - o[pair[1]])).toBeLessThan(1e-9);
      const third = 3 - pair[0] - pair[1];
      expect(Math.abs(o[third] - o[pair[0]])).toBeGreaterThan(0.5);
      const rising = (m: number) => Math.cos(phi + (m * 2 * Math.PI) / 3) > 0;
      expect(rising(OVER[k])).toBe(k % 2 === 0);
      expect(rising(UNDER[k])).toBe(k % 2 === 1);
    }
  });

  it('every strand alternates over, under, over, under along its crossings (two periods)', () => {
    for (let m = 0; m < 3; m++) {
      const seq: string[] = [];
      for (let k = 0; k < 12; k++) { if (OVER[k % 6] === m) seq.push('o'); else if (UNDER[k % 6] === m) seq.push('u'); }
      expect(seq.length).toBe(8);
      for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
      // its under-crossings are k_a and k_a + 3
      expect(UNDER[underA(m)]).toBe(m); expect(UNDER[underA(m) + 3]).toBe(m);
    }
  });

  it('the trefoil constants are its self-crossings: the over and under passes meet at one point', () => {
    const P = (t: number) => [Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t)];
    for (let i = 0; i < 3; i++) {
      const a = P(T_OVER + (i * 2 * Math.PI) / 3), b = P(T_UNDER + (i * 2 * Math.PI) / 3);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-4);
    }
  });
});

// ---------------------------------------------------------------------------- invariants

describe('plait: pipeline invariants', () => {
  it('is deterministic and structurally sound on the signature', () => {
    const { c } = opsCook(plait, sig());
    expect(c.nPts).toBeGreaterThan(500);
    expect(c.genStart.length).toBe(4); // base 2: trunk + strands 0, 1 (genStart has maxGen + 2 entries)
    expect(cookedProblems(c)).toEqual([]);
    expect(cookedHash(opsCook(plait, sig()).c)).toBe(cookedHash(c));
    for (const b of [3, 4]) expect(cookedProblems(opsCook(plait, sig(), { base: b }).c)).toEqual([]);
  });

  it('incremental ≡ full under chunking, holds and closure flicker (3 gestures)', () => {
    expect(opsIncremental(plait, sig(), { holds: [[30, 1.5], [10, 2]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(plait, loop(), { closed: true, holds: [[20, 2], [40, 1]], flickerClosure: true })).toBeNull();
    expect(opsIncremental(plait, corners(), { holds: [[12, 2.5]], flickerClosure: true, pools: [95, 2] })).toBeNull();
    expect(opsIncremental(plait, sig(5), { base: 3.4, holds: [[25, 0.6]], flickerClosure: true })).toBeNull();
  });

  it('incremental ≡ full on a long slow stroke near the causal budget', () => {
    expect(opsIncremental(plait, longStroke(), { chunks: [7, 500], base: 4 })).toBeNull();
  });

  it('honours the budgets', () => {
    for (const b of [2, 4]) {
      const { c } = opsCook(plait, sig(), { base: b });
      const per = new Map<number, number>();
      for (let i = c.genStart[1]; i < c.nPolys; i++) per.set(c.unit[i], (per.get(c.unit[i]) ?? 0) + c.count[i]);
      for (const n of per.values()) expect(n).toBeLessThanOrEqual(plait.unitBudget);
    }
    const big = opsCook(plait, longStroke(), { base: 4 }).c;
    expect(growthPts(big)).toBeLessThanOrEqual(plait.strokeBudget + plait.unitBudget);
    expect(cookedProblems(big)).toEqual([]);
    // ≤ ~4 points per sp of cord at full depth (brief)
    const sp = spineOf(opsCook(plait, straight(0.8), { base: 4 }).r);
    expect(growthPts(opsCook(plait, straight(0.8), { base: 4 }).c) / (sp.L - sp.s[0])).toBeLessThan(4);
  });

  it('survives degenerate input (2-sample stroke, tap, bloom, base 0, live)', () => {
    const two = new Hand(0, 0, { jitter: 0, seed: 1 }); two.moveTo(1, 0.5, 0.1);
    for (const o of [{}, { radial: true }, { base: 0 }, { base: 4 }, { closed: true }]) expect(cookedProblems(opsCook(plait, two, o).c)).toEqual([]);
    const t = opsCook(plait, tap(), { radial: true }).c;
    expect(cookedProblems(t)).toEqual([]);
    expect(t.nPts).toBeGreaterThan(60);
    const bloom = opsCook(plait, tap(800), { radial: true, pools: [0, 1.5] }).c;
    expect(cookedProblems(bloom)).toEqual([]);
    const live = opsLive(plait, sig(40), [0.1, 0.3, 0.8, 1], { poolAtTip: 2 });
    for (const s of live) expect(cookedProblems(s.c)).toEqual([]);
    const short = new Hand(0, 0, { jitter: 0.1, seed: 2, p: 0.6 }); short.moveTo(9, 3, 0.4);
    for (const b of [1, 4]) expect(cookedProblems(opsCook(plait, short, { base: b }).c)).toEqual([]);
  });

  it('depth 0 is bit-exactly the plain trunk (the same gen-0 polys as Sprout at depth 0)', () => {
    const h = sig();
    const bare = opsCook(plait, h, { base: 0 }).c;
    expect(bare.genStart.length).toBe(2);
    const sprout = cook(formRecipe(h.rows(), { form: 'sprout', base: 0, seed: 11 }));
    expect(bare.nPts).toBe(sprout.nPts);
    expect(Array.from(bare.pts.subarray(0, 4 * bare.nPts))).toEqual(Array.from(sprout.pts.subarray(0, 4 * sprout.nPts)));
  });

  it('is continuous in depth: a 1/16 level moves no point far and changes widths only a little', () => {
    // Points can be inserted (a dynamic gap splitting), so compare each level's points to the
    // nearest point of the next level, both ways (a symmetric Hausdorff bound in sp).
    const pts = (c: Cooked) => { const a: number[][] = []; for (let i = c.genStart[1] ?? c.nPolys; i < c.nPolys; i++) for (let k = 0; k < c.count[i]; k++) { const j = 4 * (c.start[i] + k); if (c.pts[j + 2] > 0.3) a.push([c.pts[j], c.pts[j + 1]]); } return a; };
    const far = (A: number[][], B: number[][]) => { let m = 0; for (const p of A) { let b = Infinity; for (const q of B) b = Math.min(b, Math.hypot(p[0] - q[0], p[1] - q[1])); m = Math.max(m, b); } return m; };
    for (let b = 1; b < 64; b += 5) {
      const a = pts(opsCook(plait, straight(0.8, { len: 160 }), { base: b / 16 }).c), c = pts(opsCook(plait, straight(0.8, { len: 160 }), { base: (b + 1) / 16 }).c);
      if (a.length === 0 || c.length === 0) { expect(Math.max(a.length, c.length)).toBeLessThan(12); continue; }
      expect(far(a, c)).toBeLessThan(4.5);
      expect(far(c, a)).toBeLessThan(4.5);
    }
    const first = opsCook(plait, sig(), { base: 1 / 16 }).c;
    expect(growthPts(first)).toBeLessThan(80); // the first strand only just begins to grow
  });
});

// ---------------------------------------------------------------------------- depth ladder

describe('plait: depth ladder', () => {
  it('strand 0 by d = 1, two by 2, three by 3, the groove at 4', () => {
    expect([...gensOf(opsCook(plait, sig(), { base: 1 }).c)].sort()).toEqual([1]);
    expect([...gensOf(opsCook(plait, sig(), { base: 2 }).c)].sort()).toEqual([1, 2]);
    expect([...gensOf(opsCook(plait, sig(), { base: 3 }).c)].sort()).toEqual([1, 2, 3]);
    expect([...gensOf(opsCook(plait, sig(), { base: 3.5 }).c)].sort()).toEqual([1, 2, 3, 4]);
    expect(maxW(opsCook(plait, sig(), { base: 4 }).c, 4)).toBeGreaterThan(maxW(opsCook(plait, sig(), { base: 3.5 }).c, 4) * 1.5);
  });

  it('the core thins as the strands arrive: ≤ 0.31 w at d = 2, ≤ 0.11 w at d ≥ 3', () => {
    const w0 = maxW(opsCook(plait, straight(0.8), { base: 0 }).c, 0);
    expect(maxW(opsCook(plait, straight(0.8), { base: 2 }).c, 0)).toBeLessThan(0.31 * w0);
    expect(maxW(opsCook(plait, straight(0.8), { base: 3 }).c, 0)).toBeLessThan(0.11 * w0);
  });

  it('strand 0 runs unbroken until strand 2 arrives over it, then its gaps open', () => {
    // strand 0's runs (one per unit) meet end to start at its under-crossings, zero width to zero
    // width (no bead), while strand 2 is absent; once strand 2 lies over them the gap is open
    const joints = (b: number) => {
      const ps = polysOf(opsCook(plait, straight(0.8), { base: b }).c, 1), out: number[] = [];
      for (let i = 0; i + 1 < ps.length; i++) {
        const a = ps[i], n = ps[i + 1], k = a.x.length - 1;
        out.push(Math.hypot(a.x[k] - n.x[0], a.y[k] - n.y[0]));
        expect(a.w[k]).toBe(0); expect(n.w[0]).toBe(0);
      }
      return out;
    };
    const closed = joints(2), open = joints(4);
    expect(closed.length).toBeGreaterThan(8);
    expect(Math.max(...closed)).toBeLessThan(0.05);
    expect(Math.min(...open)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------- acceptance criteria

describe('plait: acceptance', () => {
  it('1. a true plait: at every crossing the over strand is inked and the under strand is cut by a clean gap', () => {
    // straight stroke along x (doc = sp at z = 1, origin at the hand's start): crossings at s_j + P_j(2k + 1)/12
    const { r, c } = opsCook(plait, straight(0.8), { base: 4 });
    const sp = spineOf(r), u = unitArcs(c);
    const s0 = sp.s[0];
    let checked = 0;
    for (let j = 0; j + 1 < u.length; j++) {
      const P = 2 * (u[j + 1] - u[j]); // a unit is half a period, three crossings
      const ws = 0.45 * sp.w[sp.n >> 1], g = gapOf(ws, P);
      for (let k = 0; k < 3; k++) {
        const x = u[j] - s0 + crossingArc(P, k);
        if (x < 30 || x > 360) continue;
        expect(inkedAt(c, OVER[k] + 1, x)).toBe(true);
        for (const dx of [-0.6 * g, 0, 0.6 * g]) expect(inkedAt(c, UNDER[k] + 1, x + dx)).toBe(false);
        // the over strand is never nicked: inked across the whole gap
        for (const dx of [-g, -0.5 * g, 0.5 * g, g]) expect(inkedAt(c, OVER[k] + 1, x + dx)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('1. the strands never fold on the signature bends (no strand runs backwards against the cord)', () => {
    // A fold is a strand reversing against the local direction of the cord: every visible strand
    // segment must advance along the spine tangent at its nearest station. (The strand may turn as
    // sharply as the stroke itself does, so the turn angle alone is not the test.) Beside a sharp
    // turn of the stroke the nearest station may lie on the other leg, which reads a sub-sp
    // segment as slightly backward; a real fold reverses (dot ≪ 0) over sp of strand.
    for (const g0 of [sig(), sig(8), corners()]) {
      const { r, c } = opsCook(plait, g0, { base: 3 });
      const sp = spineOf(r);
      let segs = 0, back = 0, backLen = 0;
      for (let g = 1; g <= 3; g++) for (const p of polysOf(c, g)) for (let k = 0; k + 1 < p.x.length; k++) {
        const dx = p.x[k + 1] - p.x[k], dy = p.y[k + 1] - p.y[k], l = Math.hypot(dx, dy);
        if (l < 0.3 || p.w[k] <= 0 || p.w[k + 1] <= 0) continue;
        const mx = (p.x[k] + p.x[k + 1]) / 2, my = (p.y[k] + p.y[k + 1]) / 2;
        let best = 0, bd = Infinity;
        for (let i = 0; i < sp.n; i++) { const d = Math.hypot(sp.x[i] - mx, sp.y[i] - my); if (d < bd) { bd = d; best = i; } }
        const tx = -sp.ny[best], ty = sp.nx[best];
        segs++;
        const dot = (dx * tx + dy * ty) / l;
        if (dot < -0.3) back++;
        if (dot < 0) backLen += l;
      }
      expect(segs).toBeGreaterThan(150);
      expect(back).toBe(0);
      expect(backLen).toBeLessThan(1);
    }
  });

  it('2. speed: the fast stroke of the speed sheet braids with a longer period and a looser (flatter) braid', () => {
    const slow = opsCook(plait, speedStroke(0.25, 0.85, 60)), fast = opsCook(plait, speedStroke(2.4, 0.25, 62));
    const Ps = medianPeriod(slow.c), Pf = medianPeriod(fast.c);
    expect(Pf).toBeGreaterThan(Ps * 1.05);
    const loose = (x: { r: Parameters<typeof spineOf>[0] }, P: number) => { const sp = spineOf(x.r); return ampFor(sp.w[sp.n >> 1], P) / P; };
    expect(loose(fast, Pf)).toBeLessThan(loose(slow, Ps) * 0.8);
    // at equal pressure, speed alone lengthens the period ×2.4
    expect(periodFor(4, 2.6, 0)).toBeCloseTo(2.4 * periodFor(4, 0.5, 0), 6);
  });

  it('2. nibs: the brush cord is fat and long-period, the pen cord tight and fine', () => {
    const pen = opsCook(plait, sig(30), { nib: 'pen', size: 2.5 }).c, brush = opsCook(plait, sig(32), { nib: 'brush', size: 22 }).c;
    expect(medianPeriod(brush)).toBeGreaterThan(medianPeriod(pen) * 1.4);
    expect(maxW(brush, 1)).toBeGreaterThan(maxW(pen, 1) * 3);
    expect(cookedProblems(opsCook(plait, sig(33), { nib: 'chisel', size: 12 }).c)).toEqual([]);
    const ch = opsCook(plait, sig(33), { nib: 'chisel', size: 12 }).c;
    let chisel = 0;
    for (let i = ch.genStart[1]; i < ch.nPolys; i++) if (ch.kind[i] === ch.kind[0]) chisel++;
    expect(chisel).toBe(ch.nPolys - ch.genStart[1]); // strands are chisel polys like the trunk
  });

  it('3. Night: strand alpha ≤ 0.8 and the over/under gaps remove half of the strand overlaps', () => {
    const { c } = opsCook(plait, sig(), { base: 4 });
    for (let i = c.genStart[1]; i < c.nPolys; i++) expect(c.alpha[i]).toBeLessThanOrEqual(0.8 + 1e-6);
    // per half period 3 crossings, each with exactly one inked strand (checked geometrically
    // above); here: every strand is cut once per unit, so each strand has ≈ one run per unit
    const c3 = opsCook(plait, straight(0.8), { base: 3 }).c, units = unitArcs(c3).length;
    for (let g = 1; g <= 3; g++) expect(polysOf(c3, g).length).toBeGreaterThanOrEqual(units - 1);
  });

  it('3. Paper: the held tap ties a trefoil, three pieces with alternating over/under gaps', () => {
    const c = opsCook(plait, tap(800), { radial: true, pools: [0, 1.5] }).c;
    const strands = polysOf(c, 1);
    expect(strands.length).toBe(3);
    // piece q ends and piece q + 1 starts either side of an under gap; the third piece passes over
    // the gap's centre (inked through it), the two flanking pieces do not: one over, one under at
    // each of the three crossings, so walking the knot alternates over, under, over, ...
    for (let q = 0; q < 3; q++) {
      const a = strands[q], b = strands[(q + 1) % 3], o = strands[(q + 2) % 3];
      const ex = a.x[a.x.length - 1], ey = a.y[a.y.length - 1], mx = (ex + b.x[0]) / 2, my = (ey + b.y[0]) / 2;
      const gap = Math.hypot(ex - b.x[0], ey - b.y[0]);
      expect(gap).toBeGreaterThan(0.5);
      let best = Infinity;
      o.x.forEach((x, k) => { best = Math.min(best, Math.hypot(x - mx, o.y[k] - my)); });
      expect(best).toBeLessThan(0.35 * gap + 0.6);
    }
    // a quick tap at base 2 also ties it; the groove eases in above 2
    expect(gensOf(opsCook(plait, tap(), { radial: true, base: 3 }).c).has(4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------- gesture grammar

describe('plait: gesture grammar', () => {
  it('pressure: a heavy hand makes a fat, long-period, wider rope', () => {
    const light = opsCook(plait, straight(0.8, { p: 0.15 })).c, heavy = opsCook(plait, straight(0.8, { p: 0.95 })).c;
    expect(medianPeriod(heavy)).toBeGreaterThan(medianPeriod(light) * 1.3);
    expect(maxW(heavy, 1)).toBeGreaterThan(maxW(light, 1) * 2);
    const ol = offsets(light, 60, 340), oh = offsets(heavy, 60, 340);
    expect(oh.up).toBeGreaterThan(ol.up * 1.3);
  });

  it('lean: a pen tilted across the stroke flattens the braid on one side and lifts the other', () => {
    const up = offsets(opsCook(plait, straight(0.8)).c, 60, 340);
    const lean = offsets(opsCook(plait, straight(0.8, { alt: 0.6, az: Math.PI / 2 })).c, 60, 340);
    expect(Math.abs(up.up - up.down)).toBeLessThan(0.15 * up.up);
    expect(Math.min(lean.up, lean.down)).toBeLessThan(Math.max(lean.up, lean.down) * 0.7);
  });

  it('nearby ink: side ink flattens the crowded side, crowding lengthens the period', () => {
    const side = offsets(opsCook(plait, straight(0.8, { cs: 1 })).c, 60, 340);
    expect(Math.min(side.up, side.down)).toBeLessThan(Math.max(side.up, side.down) * 0.65);
    expect(medianPeriod(opsCook(plait, straight(0.8, { c: 0.9 })).c)).toBeGreaterThan(medianPeriod(opsCook(plait, straight(0.8)).c) * 1.2);
  });

  it('holding: a pool raises strand 2 and the groove only around the hold', () => {
    const h = straight(0.8);
    const c = opsCook(plait, h, { base: 2, pools: [200, 2] }).c;
    const xs: number[] = [];
    for (const p of polysOf(c, 3)) xs.push(...p.x);
    expect(xs.length).toBeGreaterThan(10);
    expect(Math.min(...xs)).toBeGreaterThan(80);
    expect(Math.max(...xs)).toBeLessThan(330);
    expect(polysOf(c, 4).length).toBeGreaterThan(0);
    // and the core thins there, not elsewhere
    const core = polysOf(c, 0), wAt = (x: number) => { let best = 0, d = Infinity; for (const p of core) p.x.forEach((v, i) => { if (Math.abs(v - x) < d) { d = Math.abs(v - x); best = p.w[i]; } }); return best; };
    expect(wAt(200)).toBeLessThan(wAt(30) * 0.7);
  });

  it('corners: the cord is cut either side of a corner (no strand ink at the corner station)', () => {
    const { r, c } = opsCook(plait, corners(), { base: 3 });
    const sp = spineOf(r);
    let nCorners = 0;
    for (let i = 0; i < sp.n; i++) {
      if (!sp.corner[i]) continue;
      nCorners++;
      for (let g = 1; g <= 3; g++) for (const p of polysOf(c, g)) p.x.forEach((x, k) => {
        if (p.w[k] > 0.2) expect(Math.hypot(x - sp.x[i] + r.origin[0] * 0, p.y[k] - sp.y[i])).toBeGreaterThan(1.5);
      });
    }
    expect(nCorners).toBeGreaterThanOrEqual(3);
  });

  it('closure: a closed loop is a cut cord at the seam (cooks clean, strands gather there)', () => {
    const { c } = opsCook(plait, loop(), { closed: true, base: 3 });
    expect(cookedProblems(c)).toEqual([]);
    expect(growthPts(c)).toBeGreaterThan(300);
  });

  it('zoom: period and amplitude are in sp, so zooming in gives a finer braid in doc units', () => {
    const band = (c: Cooked) => { let lo = Infinity, hi = -Infinity; for (let i = c.genStart[1]; i < c.nPolys; i++) for (let k = 0; k < c.count[i]; k++) { const y = c.pts[4 * (c.start[i] + k) + 1]; lo = Math.min(lo, y); hi = Math.max(hi, y); } return hi - lo; };
    const z1 = opsCook(plait, straight(0.8, { len: 300 }), { z: 1 }).c, z2 = opsCook(plait, straight(0.8, { len: 300 }), { z: 2 }).c;
    expect(band(z2)).toBeLessThan(band(z1) * 0.7);
    expect(band(z2)).toBeGreaterThan(band(z1) * 0.3);
  });

  it('cook cost: the forms sheet strokes cook well under budget', () => {
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) { opsCook(plait, sig(3 + i)); opsCook(plait, loop(7 + i), { closed: true }); opsCook(plait, corners(9 + i)); }
    expect((performance.now() - t0) / 3).toBeLessThan(150);
  });
});

/**
 * Golden fnv1a hashes of Cooked per Form fixture (operator v1, plus later versions keyed form@v,
 * e.g. sprout@2). Any change to a shipped version's geometry fails here: a new look ships as
 * a new version (DESIGN §7.5 rule 8). Regenerate deliberately with
 * UPDATE_GOLDEN=1 npx vitest run tests/ink-forms.golden.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FormId, StrokeRecipe } from '../src/core/types';
import { S } from '../src/core/types';
import { cook, createInkCook } from '../src/ink/cook';
import { FORMS } from '../src/ink/operators/registry';
import { continuationSamples, RESUME } from '../src/ink/spine';
import { formRecipe, longStroke, loopStroke, tapStroke, scribble, Hand, Feeder, cookedHash } from './ink-forms.fixtures';

// cooks are heavy; other suites may share the CPU, so 5 s is not enough under load
vi.setConfig({ testTimeout: 60000 });

const FILE = join(__dirname, 'fixtures', 'ink-forms.golden.json');

function fixtures(): Record<string, StrokeRecipe> {
  const out: Record<string, StrokeRecipe> = {};
  const chisel = new Hand(0, 0, { jitter: 0.2, seed: 11, alt: 0.6, az: 0.4, p: 0.3, c: 0.3, cs: -0.2 });
  chisel.moveTo(80, 40, 0.5).moveTo(10, 120, 2.0, 0.1).moveTo(200, 90, 0.7, 0.9);
  // every Form at v1, plus the later versions (keyed form@v): Sprout v2, Drift v2
  const variants: [FormId, number][] = [
    ...(['line', 'echo', 'sprout', 'drift', 'craze', 'plume', 'caustic', 'burin', 'plait', 'orbit'] as FormId[]).map((f): [FormId, number] => [f, 1]),
    ['sprout', 2],
    ['drift', 2],
  ];
  for (const [form, v] of variants) {
    const key = v === 1 ? form : `${form}@${v}`;
    const base = form === 'line' ? 1.5 : 2;
    out[`${key}/pen-brush-long`] = formRecipe(longStroke(3).rows(), { v, form, base });
    out[`${key}/pools`] = formRecipe(longStroke(5).rows(), { v, form, base: base - 1, pools: [150, 1.5, 420, 2.25, 700, 0.5] });
    out[`${key}/mouse-pen-nib`] = formRecipe(scribble(5, 0.3, 125).rows(1, true), { v, form, base, device: 'mouse', nib: 'pen', size: 2.5 });
    out[`${key}/touch`] = formRecipe(scribble(9, 0.8, 60).rows(1, true), { v, form, base, device: 'touch' });
    out[`${key}/chisel-z2.5`] = formRecipe(chisel.rows(2.5), { v, form, base, nib: 'chisel', size: 12, z: 2.5 });
    out[`${key}/closed-loop`] = formRecipe(loopStroke(70).rows(), { v, form, base, closed: true });
    out[`${key}/tap`] = formRecipe(tapStroke(60).rows(), { v, form, base, radial: true });
    out[`${key}/bloom`] = formRecipe(tapStroke(800).rows(), { v, form, base, radial: true, pools: [0, 1.75] });
    out[`${key}/max-depth`] = formRecipe(longStroke(7).rows(), { v, form, base: FORMS[form].dMax });
    const light = new Hand(50, 50, { jitter: 0.05, seed: 9, p: 0.15 });
    light.hold(60).moveTo(51, 50.5, 0.05);
    out[`${key}/tap-light`] = formRecipe(light.rows(), { v, form, base: 2.5, radial: true });
    out[`${key}/base0-pools`] = formRecipe(longStroke(6).rows(), { v, form, base: 0, pools: [180, 2.5, 520, 1.25] });
    // split pieces
    const whole = formRecipe(longStroke(4).rows(), { v, form, base });
    const total = Math.floor(whole.samples.length / S.STRIDE), cutAt = Math.floor(total * 0.55);
    const fd = new Feeder(whole), ic = createInkCook(fd.d);
    while (fd.fed < cutAt) { const n0 = fd.fed; fd.feed(Math.min(6, cutAt - fd.fed)); ic.append(fd.fed - n0); }
    const snap = ic.snapshot();
    out[`${key}/split-a`] = { ...fd.freeze(false), cut: 2 };
    out[`${key}/split-b`] = { ...whole, samples: continuationSamples(whole.samples, total, snap), s0: snap[RESUME.S], cut: 1, resume: snap };
  }
  return out;
}

describe('golden hashes (v1, and later versions keyed form@v)', () => {
  it('every fixture cooks to its committed hash', () => {
    const fx = fixtures();
    const got: Record<string, string> = {};
    for (const [k, r] of Object.entries(fx)) got[k] = cookedHash(cook(r)).toString(16).padStart(8, '0');
    if (process.env.UPDATE_GOLDEN || !existsSync(FILE)) {
      writeFileSync(FILE, JSON.stringify(got, null, 2) + '\n');
      return;
    }
    const want = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>;
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const k of Object.keys(want)) expect(`${k} ${got[k]}`).toBe(`${k} ${want[k]}`);
  });
});

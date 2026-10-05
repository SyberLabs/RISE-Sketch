# Forms lab

A sandbox for designing new procedural stroke types ("Forms") for Rise, prototyped against the
real pipeline (spine, depth field, pools, closure, radial seeds, budgets, incremental cooking and
render path) without touching shipping code.

## How a prototype is wired

- A prototype is one file, `lab/forms/<name>.form.ts`, exporting
  - `meta: LabFormMeta` (`name`, a unique operator version `v >= 100`, the `ink` the gallery
    draws it with, optional `base`, and `notes`), and
  - `ops: FormOps` with `id: 'ripple'` and `v === meta.v` (the P1 Ripple slot, at a version no
    shipped recipe uses — see `registerOperator` in `src/ink/operators/registry.ts`).
- `harness.ts` registers it and cooks real recipes: `labCook`, `labLive`, `checkIncremental`
  (incremental ≡ full under random chunking / holds / closure flicker — the invariant every Form
  must hold), `problems` (Cooked invariants), `cookedHash`.
- The gallery page renders a prototype through the real `drawCooked`:
  `npx vite --port <port> --strictPort` (repo root, background), then
  `node lab/forms/shot.mjs <name> <port> <outDir> [views...]`
  with views `forms paper depth speed nibs seeds live compare` (compare = beside the four
  shipped Forms on one gesture). Open `http://localhost:<port>/lab/forms/index.html?form=<name>&view=<view>`
  to look interactively.
- Tests: `lab/forms/<name>.test.ts`, run with `npx vitest run --config lab/vitest.config.ts lab/forms/<name>`.
  `purity.test.ts` enforces the geometry Math allow-list on every `*.form.ts`.
- Typecheck: `npx tsc --noEmit -p lab/tsconfig.json`.

## The operator model (read `src/ink/operators/types.ts` in full)

The cook (`src/ink/cook.ts`) owns all state; an operator is pure geometry:

- **Trunk** (gen 0): the stroke itself. `trunkStyle` gives its width multiplier and alpha;
  `trunk` may replace the plain station trunk (Line displaces it), reading `trunkReach` sp of
  spine and `trunkDepthReach` sp of depth field around each point.
- **Chain** (gen ≥ 1, optional): a sequential chain of growth *units* along the arc
  (Sprout anchors, Drift stations). `need`/`step` walk the cursor (frozen `ChainRecord` per
  unit: arc `s`, index `j`, `side`, template `tmpl`); `cook` builds the unit's geometry ONCE at
  its ceiling into a `UnitGeom` (branches = polylines with arc `pa`); `count`/`emit` truncate it
  to depth `D` (fractional depth must be continuous: prefix truncation and width easing, never a
  pop); `keep` decides whether a tail unit survives lift. Each unit must be a pure function of
  the spine within `halfWin` sp of its arc, `d(s)` there, the entry factor and its integer rng
  address (`rnd(seed, Ch.*, j, k)`), so `regrow`, truncation and `cook ≡ finish` stay exact.
- **Radial** seed: what a tap / bloom becomes (`radial`, `radialCeiling`).
- **Global** forms (like Echo) do their work at finish; prefer *local* chains unless the idea
  truly needs the whole stroke. (Global work beyond the trunk/chain/radial hooks needs a
  change to cook.ts; note it in your report rather than hacking around it.)
- Output goes through `Sink.begin(kind, gen, alpha, tone, born, unit, cat?)` / `pt(x, y, w, ang?)`
  / `end()`. `tone = toneOf(p, dBucket)` (`dBucket = min(gen, 4)`), alpha =
  design alpha × `hierarchy(gen)` × `glow(c)` (Night values; Paper scales are applied at raster),
  `born` = the spine arc the poly grows from, `unit` = chain index. Widths are FULL widths in doc
  units (`/ cx.z` converts sp → doc).
- Determinism: only the Math allow-list (`sqrt abs floor ceil round trunc min max imul fround
  sign clz32`), transcendentals from `core/det.ts` (`dsin dcos datan2 dexp dlog dpow`), no `**`,
  randomness only via `rnd` with integer addresses. Budgets: `unitBudget` points per unit,
  `strokeBudget` causal per stroke.

Study `sprout.v1.ts` (chain with branches, truncation by generation), `drift.v1.ts` (chain of
filaments, prefix truncation, tone thirds) and `line.v1.ts` (trunk replacement + radial seed)
before writing a new one.

## What makes a Form good here

It must be *alive under the hand*: speed, pressure, lean, curvature, closure, holding (depth
pools) and nearby ink (`c`, `cs`) should each visibly change it, within bounded, predictable
limits (DESIGN.md §2.3, §3.3). Depth 0 is always the bare stroke. It must look beautiful on both
Night (additive light) and Paper (multiplied pigment), at fine and broad nibs, on a tap, a loop,
a corner-heavy stroke, a long stroke and a fast scribble. And it must be clearly distinct from
Line (weathering), Echo (self-similar crystal), Sprout (botany) and Drift (smoke).

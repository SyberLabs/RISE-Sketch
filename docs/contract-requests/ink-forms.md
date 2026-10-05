# ink-forms: contract requests and integration notes

Each entry: problem, proposed change, workaround used. Every export listed in BUILD.md §3
exists with its listed signature; nothing here blocks anyone.

## 1. Paper alphas cannot live in a ground-independent `Cooked`

**Problem.** DESIGN gives ground-specific alphas: the hierarchy is `0.72^(g−1)` on Night but
`0.78^(g−1)` on Paper, Drift filaments are α 0.38 on Night and 0.30 on Paper, and Echo's
exposure rule differs per ground. `Cooked` must not depend on the ground (§2.3.6: "Geometry
never depends on the ground"), and `Cooked.alpha` is documented as "design alpha ×
hierarchy × glow(c)".

**Proposed change (render-core, `drawCooked`).** On Paper, multiply each poly's alpha by
`paperAlphaScale(form, gen)` and, for Echo polys with gen ≥ 1, by
`echoPaperExposure(c.coverage)`. Both are exported from `ink/operators/registry.ts` (pure,
cheap). The raster needs the recipe's Form, which `inkTableFor(r, g)` callers already have.

**Workaround used.** `Cooked.alpha` carries the **Night** values. Paper renders slightly
fainter deep generations and slightly stronger Drift than designed until the raster applies
the scale.

## 2. Live view: stable poly identities (additive)

**Problem.** `LiveView.geom` is rebuilt as a gen-sorted `Cooked`, so its poly indices are not
stable between calls. A live layer that drains settled polys into `#dry` needs to know
which polys of `geom` it already holds.

**Additive API (no change requested).** `view()` returns an `InkLiveView` with
`slot: Int32Array` (one per poly of `geom`): the stable drain id of a settled poly, or −1 for
a provisional one (the unsettled trunk tail, growth rising under the nib, a bloom preview).

**Drain semantics** (also in the `ink/cook.ts` header):
- `PolyView.index` is a stable id: monotonic and never reused.
- When a unit re-emits (a pool regrow, a head-taper change, closure), its k-th new poly
  `replaces` its k-th old poly. If the old poly was itself never drained, the new one
  replaces whatever that old poly was replacing.
- When a unit now has fewer polys, each surplus old poly is superseded by an **empty**
  `PolyView` (`pts.length === 0`). The live layer clears the old poly and draws nothing.
- After `finish()` nothing more is drained. Commit with the returned `Cooked`.

## 3. `MorphSet.t0` is on the stroke clock

**Problem.** `MorphSet.t0` is documented as `performance.now()` time, but the cook is pure and
has no clock.

**Workaround used.** `t0` is ms since pen-down (the lift time for Echo's fold-out). The live
layer adds its own pen-down timestamp. `view()` after `finish()` returns
`{ geom: finished, ghost: null, morph }`, where `morph` holds the Echo fold-out:
- `from` is aligned with `geom.pts`.
- `polyFirst[0]` is the first crystal poly (`genStart[1]`).
- `dur = clamp(350 + 120·d_E, 350, 1100)`.

Apply easeOutCubic.

## 4. Line's live reveal is spatial, not a 160 ms morph

**Decision (no change requested).** Line's provisional tail already shows its crackle, faded to
zero over the 20 sp behind the nib, so the nib stays clean and roughness develops behind it.
Settled Line polys therefore appear already displaced. A spine → displaced morph would make
them collapse and re-grow, so `view().morph` is `null` while drawing. Sprout and Drift use
prefix reveal, as specified: `pts` carries the per-poly arc `a`, and `born` is the spine arc
of the unit.

## 5. Auto-split: use `InkIncrementalCook.snapshot()`; `finish(r)` honours `r.cut`

**Protocol for app/draft.ts.**
1. Use `createInkCook(draft)` (it is `createIncrementalCook` with the additive API).
2. Right after appending piece 1's last rows, call `cook.snapshot()`. It returns the spine's
   `RESUME` fields followed by the growth-chain cursor and the causal budget spent.
3. Commit piece 1 as `{ ...frozen, cut: cut | 2 }` and call `cook.finish(piece1)`. This works
   even though the draft was created without the cut bit: `finish(r)` reads the cut flags
   from `r` and keeps exactly the settled stations.
4. The continuation is `{ s0: snap[RESUME.S], cut: 1, resume: snap, samples:
   continuationSamples(rows, n, snap) }`.

The pieces meet on one station:
- Line pins its offset to 0 at cut ends.
- Trunks have no taper at cuts.
- Sprout and Drift unit indices continue from the cursor, with no gap and no duplicate.

## 6. `finish(r)` reads rows through the draft (fast path), and is always ≡ `cook(r)`

`finish(r)` consumes the remaining rows from the draft the cook was created with. `r.pools`,
`r.closed`, `r.cut` and `r.radial` are taken from `r`. When `r` freezes exactly what the draft
held (the same rows, bitwise, and the same pen-down fields), lift is incremental and cheap.
If it does not, for example a pointer-up row (ink-instrument request #1) appended to the
recipe but not to the draft, `finish(r)` falls back to a one-shot cook of `r`. The result is
still bit-identical to `cook(r)`, but the lift costs a full cook (10–35 ms on a long stroke).
So app/draft.ts should still append any pointer-up row to the **draft** buffer before
freezing.

## 7. `ceiling(s)` for the rise halo

Returns the realisable depth around arc `s`:
- **Line:** 5.
- **Echo:** the cap of the crystal the stroke would get if it lifted now: the RDP plan of
  the current spine, a snowflake while closing. It is computed only when asked and cached
  until the spine changes. A short open stroke, which becomes Line at lift, gets 5.
- **Sprout and Drift:** the largest ceiling among cooked units within the pool reach
  `[s − 48, s + 32]`, else `dMax`. Once the causal budget is spent, it returns the current
  depth, so a hold cannot rise and the brim flashes at once.
- **Bloom (hold before 6 sp):** the Form's radial cap (Line 5, Echo 5, Sprout 3, Drift 6).
  When the seed's own budget stops it short, it returns the depth it actually reached, which
  is the committed `ceilingMax`. A large Sprout bush stops at about 2.8.

**Resume cursors (doc-persist / app FYI).** A `resume` whose growth-chain fields could not
have come from `snapshot()` is ignored, and the chain restarts at `s0`. This covers an unknown
phase, a non-finite arc, an arc more than 128 sp from `s0`, a bad index, side or budget, a
damaged file, or a resume from another stroke. A bad resume therefore never stalls a cook.

## 8. Closed loops end in two coincident caps (render-core FYI)

The committed trunk of a closed loop starts and ends on the same point, the welded seam, and
the tessellator draws a round cap at each end. Under 'lighter' the two caps overlap, unless
they share a batch, which they do whenever the seam's two pressure buckets agree. If a bead
ever shows at the seam, weld the first and last points of gen-0 chunks the way chunk joints
are welded when they coincide.

## 9. Additive exports

From `ink/cook.ts`:
- `createInkCook`, `InkIncrementalCook`, `InkLiveView`
- `BLOCK` (the 50 sp trunk unit)

From `ink/operators/registry.ts`:
- `operatorFor`, `paperAlphaScale`, `echoPaperExposure`

From `ink/noise.ts`:
- `CurlField`, `gradNoise`, `permutation`
- the gradient and jitter tables

`ink/operators/types.ts` holds the operator contract (`FormOps`, `ChainOperator`, `Sink`,
`FormCx`) and the shared runtime kit (`PolyBuf`, `Sampler`, `TrunkPts`, `writeTrunk`).

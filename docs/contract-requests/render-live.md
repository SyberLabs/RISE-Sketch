# render-live: contract requests and integration notes

Every export listed in BUILD.md §6 exists with its listed signature (`createLiveLayer(host)`,
`createOverlay(host)`). Each entry below gives the problem, the proposed change and the workaround
that is live code today.

## 1. LiveHost has no route to the overlay (prediction)

**Problem.** `LiveLayer.predict(tail)` must draw the predicted tail on the overlay (DESIGN §2.2.2).
Only the live layer knows the ink's tip position, width and colour, but `LiveHost` has no overlay.

**Proposed change.** Add `readonly overlay?: Pick<OverlayInternal, 'predicted'> | null` to `LiveHost`.

**Workaround used.** `render/live.ts` exports `interface LiveHostExt extends LiveHost { overlay? }`
and the returned layer has `attachOverlay(o)`. render-world's `renderer.ts` already passes
`overlay` through `LiveHostExt`. `predict(tail)` sends `[ink tip, last raw sample, ...tail]` to
`overlay.predicted(seq, wCss, css)`: the first two points bridge the filter lag (they have
`predicted: false`, `t: NaN`). The overlay clips the ink's round tip out at the first point, so the
50 % spine continues the ink instead of veiling it. **app/draft.ts should pass only the predicted
samples to `live.predict`**; the live layer adds the bridge.

## 2. Paper per-generation alpha must be applied identically by tiles and live

**Problem.** ink-forms bakes Night's hierarchy into `Cooked.alpha` (0.72^(g−1), Drift 0.38).
Paper wants 0.78^(g−1) and 0.30 (`ink/operators/registry.paperAlphaScale`), plus Echo's Paper
exposure (`echoPaperExposure(coverage)`). `drawCooked` has a single `alphaScale`, so either every
caller splits by generation or the two paths disagree at the bake hand-off.

**Proposed change.** render-core adds `DrawOpts.genScale?: (gen: number) => number` (or a `form`
argument), so the rule lives in one place.

**Workaround used.** `render/live.ts` exports `drawInk(ctx, c, table, m, form, opts)`. On Night, or
for a stroke with only gen 0, it is exactly one `drawCooked` call; on Paper it is one call per
generation with that generation's `alphaScale`. render-world's tiles already draw through
`drawInk`, so live ink and baked ink agree.

## 3. `MorphSet.t0` is documented on the performance.now clock but the cook cannot know it

**Problem.** core/types.ts says `t0` is "ms, performance.now clock". ink/cook.ts (pure) fills it with
the stroke clock (ms since pen-down). A replay running faster than real time would also skew it.

**Proposed change.** Document `t0` as stroke-clock ms, informational only.

**Workaround used.** The live layer ignores `t0`. A morph starts when its poly first appears inside
a group: at commit for Echo's fold-out, on first sight for live groups. It uses `dur` when it is
positive, otherwise the DESIGN default (Echo `clamp(350 + 120·d, 350, 1100)` ms, Line 160 ms).

## 4. Settled-poly identity: document `slot` and `PolyView.index`

**Problem.** The contract does not say what `PolyView.index` / `replaces` index. The real cook uses
monotonic drain ids (not geom indices), and its views are gen-sorted, so geom indices shift on
every append. It also returns an additive `slot` array (`InkLiveView`: drain id per geom poly,
−1 for provisional polys).

**Proposed change.** Add `slot?: Int32Array` to `LiveView` in core/types.ts and document
`index` / `replaces` as drain ids.

**Workaround used.** The live layer does not depend on index semantics. It mirrors the view
(copying only the suffix that changed) and carries each poly's animation state by a content key:
kind, gen, tone, unit, alpha, count and both end points. A poly counts as settled when its `slot`
is ≥ 0; without `slot`, drained polys are matched by the same key. Tested against the fake cook
in every mode (slot ids on or off, views reordered) and against the real ink/cook.ts for all four
Forms.

## 5. (render-core) faint dark seam at welded joints between differently coloured chunks

**Observation.** On Night (Chrome / SwiftShader), a welded joint between two trunk chunks with
*different tones* leaves 1 to 4 pixels whose coverage sums to about 80–90 %. The R channel of
saturated oxide dips from 255 to 197–227, which shows as a hairline seam at 3× zoom. This happens
in plain `drawCooked` (one call, separate fills per colour), so tiles show it too. Same-tone joints
and joints split across #dry / #wet are seamless (measured).

**Proposed change.** render-core looks at shared-edge coverage between fills of different colours,
for example by drawing tone boundaries with a sub-pixel overlap in the lower-alpha batch only.
No change in render-live.

## 6. Notes for app/ and render-world (no change requested)

- **Halo.** `live.halo(h)` copies `h` (it may be a reused object). The live layer times the
  ×1.8 brim flash from the rising edge of `h.brim` (160 ms, easing off over its last 60 ms). Under
  reduced motion the halo is static: pre ≥ 0.5 shows, level in quarter steps, no flash. A halo
  shown during drawing also pins the hold window: ink settled within 96 sp behind the nib returns
  to #wet until 300 ms after `halo(null)`, so regrowing units never repaint #dry each frame.
  The halo belongs to the nib: `begin`, `commit` and `withdraw` end it even if `halo(null)` was
  never sent (a nib that is still held simply re-sends it the next frame).
- **Bake.** The layer calls `host.bake(r, c, done)` exactly once per committed, played or grown
  stroke, only after every reveal, fade and hot trail has finished (≤ 3τ after lift, so ≤ 660 ms on
  Night and ≤ 1140 ms on Paper). `done()` clears the stroke from #dry synchronously and is
  idempotent; a stroke that is un-grown before its bake completes ignores a late `done()`.
- **frame(now)** may be called twice in one rAF (the renderer re-runs it after transaction commits).
  It returns false and touches no pixels when nothing changes. A change of #dry / #wet backing size
  or DPR is detected and repainted in full. After a canvas context loss, call `live.resize()` (or
  `onCamera`): the layer keeps all geometry and repaints from it.
- **Diff restyles.** `morph(before, after)` pairs revisions by id. When only pools or base depth
  differ (`depthOnlyChange`), the restyle is a diff: shared ink stays put, the old revision's own
  growth retracts over 200 ms, and the new revision's own growth grows over 320 ms. This is the
  peel undo's "drains the pools with a 200 ms reverse growth". A side with nothing of its own
  skips its phase: a drain-only peel bakes the new revision at once while the old growth drains,
  and a grow-only change grows at once. The generation schedule spans only the generations that
  actually animate. Any change of look plays the full 150 ms un-grow, then the re-grow.
- **First-run seed.** `play(r, c, { bake: false })` replays a recorded stroke (trunk on its own
  timing, growth behind the nib, its pools rising with a synthetic halo) and then rests in #dry
  until `dissolve(ms)`. `durationScale` scales the stroke's timing and the reveal durations, not
  the hot τ.
- **Concurrency.** At most 4 items animate at once, counting the stroke being drawn (it is never
  fast-forwarded). Older ones fast-forward and bake.
- **Extras on the returned object.** `attachOverlay(o)`; `inspect()` returns per-item state for
  tests and the debug HUD. Exported helpers: `drawInk`, `depthOnlyChange`, `diffMasks`, `hotEta`,
  `hotMultiplier`, `RectList`, `ArcClock`, `PolyStore`, `haloAlpha`.

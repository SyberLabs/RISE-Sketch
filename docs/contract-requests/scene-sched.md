# Contract requests: scene-sched

Every listed export in BUILD.md §8 is implemented with its exact signature. The items below are
gaps in the frozen contracts that I worked around locally; the workaround is live code, so
integration can adopt or reject each one independently.

## 1. `Scene.lineage` cannot convert sp to doc for the new stroke

**Problem.** DESIGN §2.4.2 measures lineage in sp: proximity `max(6 sp, 3w)` and recency "spine
within 48 sp". The signature is `lineage(x, y, ink, wDoc, now)`, so `3w` is available
(`3·wDoc`), but 6 sp and 48 sp need the new stroke's zoom `z`, and that isn't passed.

**Proposed change.** `lineage(x, y, ink, wDoc, now, z?: number)`.

**Workaround used.** Both distances use the **candidate** stroke's zoom (`6 / candidate.z`,
`48 / candidate.z`). When you keep drawing at the same zoom, which is the common case, this
is identical.

## 2. Clock for `lineage(now)` and the meaning of `StrokeRecipe.created`

**Problem.** Recency needs each stroke's lift time. A recipe only carries `created` ("wall-clock
ms, Date.now") plus per-sample `t` (ms since pen-down). The contract doesn't say whether
`created` is stamped at pen-down or at lift, or which clock `now` is on.

**Proposed change.** Document that `created` = `Date.now()` at pen-down, and that
`lineage(…, now)` takes `Date.now()`.

**Workaround used.** Lift time = `created + t(last sample)`. Recency accepts
`−60 s < now − lift < 3 s`. A draft that stamps `created` at lift still works. A caller on the
wrong clock (`performance.now()`, about 1e5, vs `Date.now()`, about 1.7e12) never matches,
instead of always matching.

## 3. `Scene.put(id, c)` is ambiguous during the peel commit

**Problem.** A risen stroke commits as `add` (at base depth) and then `replace` (with pools), and
`cook.finish(r)` returns the geometry **with** pools. `put(id, c)` has no recipe, so the scene
binds `c` to whatever recipe the doc holds under `id` at call time. If the draft calls `put`
between the two `apply`s, the pooled geometry is bound to the base-depth recipe. The first
undo (the peel) would then show pooled geometry for an unpooled stroke.

**Proposed change.** Add `putFor(r: StrokeRecipe, c: Cooked): void` to `Scene` (already
implemented on the object `createScene` returns). Alternatively, document that `put` must be
called after every `doc.apply` of the commit.

**Workaround used.** Both are implemented:
- `put(id, c)` binds to the current doc recipe. If the stroke isn't in the doc yet, it waits
  (max 16 pending) for the next `add` of that id.
- `putFor(r, c)` binds to exactly `r`, and can be called before either `apply`.

## 4. The renderer needs the `before` geometry of a restyle

**Problem.** `Renderer.strokesReplaced(before, after)` morphs old geometry into new, but
`Scene.cooked(id)` can only answer for the current revision.

**Proposed change.** Add `cookedFor(r: StrokeRecipe): Cooked | undefined` to `Scene` (implemented).

**Workaround used.** `cookedFor(r)` exists on the returned object. The LRU keeps older revisions
and removed strokes until it evicts them, matched by full geometry inputs, not just `geomRev`.
`cooked(id)` for a removed id returns the revision that was current when it was removed,
which covers the un-grow animation.

## 5. Additive extras on `createScene` / `SceneImpl` / `createFrameLoop` (no change requested, FYI)

- `createScene(deps)` accepts an optional `cacheBytes`. The app should pass
  `COOKED_CAP_BYTES[deviceClass()]` (phone 48 MB / tablet 96 MB / desktop 192 MB). The default
  is desktop. The scene is pure and can't detect the device class itself.
- `SceneImpl.charge(c, bytes)` lets render-world count decimated LODs against their `Cooked`
  entry, as DESIGN §6.8 specifies ("evicted with the Cooked entry; counted in its bytes").
  Keep the LODs in a `WeakMap<Cooked, …>` so they are collected when the entry is evicted.
- `SceneImpl.pick(p, rDoc)` returns `{ id, poly }`: the topmost stroke and its nearest
  qualifying poly, for Alt-click sampling with `lchAt(color, ground, tone[poly], born[poly])`.
- `createFrameLoop(env?)` takes an optional fake rAF/clock for tests.
  `attachJobs(loop, jobs, order = 1000)` wires the job queue in as the last participant
  (DESIGN §9 step 6).

## 6. Auto-split continuations see their own predecessor in the occupancy grid (FYI for app/draft)

**Problem.** DESIGN §2.3.9 says "a stroke never sees itself", and §7.4 step 5 says an auto-split
is seamless. But the first piece is committed (`doc.apply(add)`), so the scene splats it into
the occupancy grid, while the continuation is still being drawn. From then on the continuation's
`C`/`CS` reads include the predecessor.
- **Thin nibs:** the effect at the seam is negligible (c ≈ 0.01 for w = 6 sp).
- **A 40 sp brush:** c ≈ 0.4 over the first ~48 sp after the seam.
- **A long scribble over one area:** after the split it suddenly sees all ~14,400 sp of its own
  earlier ink.

**Proposed change.** Either the draft keeps feeding the continuation the pre-split `C`/`CS`
policy (for example, it ignores occupancy within 48 sp of the seam), or the scene adds an
exclusion read. The frozen `crowding(x, y, z)` can't take an exclusion list, so this would be an
additive `crowdingExcept(x, y, z, ids)`.

**Workaround used.** None in the scene. Nothing is wrong until auto-split lands in `app/draft.ts`.

(Review pass, scene-sched: the review also hardened every scene entry point against corrupt
recipes, made the kitchen share a queued cook only for identical geometry, and indexed cooked
strokes by `inkBox ∪ hitBox`. No contract change is needed for any of these.)

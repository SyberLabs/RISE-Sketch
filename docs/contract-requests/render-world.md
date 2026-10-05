# render-world: contract requests and integration notes

Each entry: problem, proposed change, workaround used. `createRenderer(deps: RendererDeps): Renderer`
exists with its listed signature (it accepts the optional extras below and returns a superset);
`render/glyphs.ts` exports `createGlyphs()` implementing `Glyphs`, and `renderer.glyphs` is one.
No frozen contract had to change.

## 1. How the app must tell the renderer about document changes (app)

**Problem.** `Renderer.strokesAdded / Removed / Replaced` are "mutations that did NOT go through
the live layer", but the renderer also sees every change through `doc.subscribe`, and a live
commit adds the stroke to the document before the live layer bakes it. The renderer must never
draw a stroke into tiles while the live layer still shows it, and never miss one.

**Protocol implemented (no type change).**
- Call `doc.apply(...)` first, then, **in the same task**, either `renderer.live.commit(r, c)`
  (or `live.play`) or the matching `renderer.strokesAdded / strokesRemoved / strokesReplaced`.
- `renderer.live` is a facade over render-live's layer: `commit` and `play` (unless
  `bake: false`) put the stroke on a *live hold* until its bake; the bake claims it into tiles.
- Anything the document changed that no call announced by the end of the task is handled by a
  microtask safety net with no animation (added: claimed into tiles; removed: dirty-rect
  re-render; replaced: dirty-rect re-render). A live hold that never bakes is released after 30 s.
- A stroke added and immediately committed as a peel (`add` then `replace` with pools) needs no
  `strokesReplaced`: commit the pooled recipe through `live.commit`.

## 2. Renderer extras the app needs (additive; `RendererImpl` in render/renderer.ts)

- `busy: boolean` — settle pending, transactions, tile work, cooks the renderer requested, a
  ground swap, live animations. Use it in `__rise.idle()` (frame-loop idle alone is not enough:
  the 150 ms camera settle uses a one-shot timer, not rAF).
- `hold(ids)` / `release(ids)` — keep strokes out of the tiles (Replay: `reset('fade')`, then
  `hold(all)`, then `live.play` each; a play converts the hold into a live hold and its bake puts
  the stroke back). `release` returns them without animation (stop replay); strokes the live
  layer still shows (live holds) are left to their bake, so call `live.fastForward()` when
  stopping a replay and nothing ever shows twice.
- `rebind(doc, scene, anim)` — New / Open with a fresh `Doc` + `Scene`: re-subscribes and resets.
  If the app instead keeps one Doc and swaps its content, call `reset(anim)`; strokes the doc adds
  afterwards are picked up by the safety net.
- `debug()` — internal counters (transactions, holds, tile work, level, frame interval) for the
  `?debug` HUD.
- `host` (the `LiveHost`), `ledger` (share it with export: `ledger.alloc(w, h, 'export')`),
  `dpr` (effective DPR after the 3× and 8 MP caps; pass raw `devicePixelRatio` to `resize`).
- Construction options (`RendererOptions`): `ledger`, `liveFactory`, `overlayFactory`, `glyphs`,
  `now` — for tests and sandboxes.

## 3. Paper per-generation alpha (render-core / ink-forms / render-live)

**Problem.** ink-forms §1: `Cooked.alpha` carries Night's hierarchy; Paper needs
`paperAlphaScale(form, gen)` and Echo's Paper exposure. render-live applied it in its
`drawInk(ctx, c, table, m, form, opts)`; tiles must match or the hand-off breaks on Paper.

**Workaround used.** Tiles, `renderRegion` (export) and glyphs all draw through render-live's
exported `drawInk`. Measured hand-off (sandbox `handoff`): ≤ 1/255 on every inked pixel, Night
and Paper, for Line / Sprout / Drift / Echo.

**Proposed change.** Move the per-generation Paper scale into render-core's `drawCooked` (it
needs the Form: `inkTableFor(r, g)` could carry it), so there is one raster rule.

## 4. Snapshot extent (persist / app)

**Problem.** `showSnapshot(img, cam)` gets the camera but not the CSS viewport size the snapshot
covered, so the image's doc extent is ambiguous after a resize or rotation.

**Proposed change.** Store `{ cam, cssW, cssH }` with the snapshot and add an optional
`viewport` argument to `showSnapshot`.

**Workaround used.** `snapshotDocBox()`: the image is the current viewport when the aspect ratios
agree (or agree rotated), else the current viewport fitted to the image's aspect.

**Ordering (app).** `reset()` / `rebind()` and `setGround()` drop a snapshot that is showing (it
belongs to the previous document / ground), so call `showSnapshot` AFTER them on Open and at
startup. While it shows, removals, restyles and lifts punch their boxes out of it (the image is
stale there); it disappears once every visible tile is complete.

## 5. Export and memory (app/export)

- Call `renderer.purge()` right before allocating the export canvas: it frees every tile and the
  bloom's scratch chain and suspends tile allocation for 2 s (any camera change, resize or
  document operation resumes it at once). `#base` and the bloom keep showing their last picture
  meanwhile, and after the rest `#base` is not re-composited until the visible tiles are rebuilt
  (at most 1 s), so the canvas never flashes blank.
- `renderRegion(ctx, box, pxPerDoc, ground, paintGround)` draws ALL document strokes (ignoring
  holds and the lifted selection) and returns ids skipped as uncooked: `scene.ensure` them and
  run it again (or draw them in a second pass).

## 6. Scene extras used (scene-sched, FYI)

Duck-typed when present: `cookedFor(r)` (the `before` side of restyles and removals) and
`boxOf(id)` (conservative boxes of uncooked strokes). Without them the renderer falls back to
`cooked(id)` and the recipe's conservative box.

## 7. Glyphs (ui, FYI)

- The device pixel ratio of a glyph canvas is `canvas.width / canvas.clientWidth` (the UI sizes
  the backing store, ui.md §5); renders are cached per (key, backing size), so calling `chip` /
  `tile` again with unchanged inputs costs one blit (no cook, no raster). The canvas is always
  redrawn, so it is safe to clear or resize it between calls.
- Nib tiles show your last stroke as a **bare nib mark** (depth 0) at true width, so growth never
  crowds or crops what a Stroke tile is about. Ink and Form tiles show the stroke grown.
- Erase tile: the stroke ghosted under an accent eraser ring.

## 8. Behaviour decisions the app may rely on

- Removal of more than 24 strokes with `'ungrow'` plays a 200 ms base cross-fade instead
  (DESIGN §3.2 reserves un-grow for ≤ 24). `'fade'` always cross-fades.
- A restyle of lifted strokes updates the selection layer without the morph (the chip-drag
  preview already showed it); `strokesReplaced` is still required.
- Lift cap (> 200 strokes or > 2 M points): `lift` resolves without lifting or dimming.
- Ground swap: the new ground's visible tiles render first (≤ 250 ms, with the larger
  user-edit tile slice), then ground and ink cross-fade together over 400 ms (instant under
  reduced motion). The Night bloom keeps glowing until the swap and fades with the old picture.
- `strokesAdded(items, 'none')` skips strokes the live layer still holds (committed / playing):
  their bake puts them in the tiles. A restyle (`strokesReplaced`) waits for the new geometry to
  cook before the old version leaves the tiles, with or without the morph (no blink).
- `previewLifted(items)` draws only items that are actually lifted (over the lift cap nothing is
  lifted, so a preview would show the strokes twice: do the restyle on release instead).
- Deleting the whole lifted selection (`strokesRemoved`) un-dims the drawing by itself; `drop()`
  un-dims first and bakes the strokes back once `#base` is at full opacity again (≈ 160 ms).

/**
 * The live layer: where the ink is alive. Spec: docs/DESIGN.md §3.1 (halo), §3.2 (hot trail,
 * living wake, un-grow, concurrency), §6.2 (#dry / #wet, two-phase hand-off), §6.6 (prefix and
 * morph reveal, reduced motion), §9 LOD rules 7–8.
 *
 * Two canvases. #dry holds ink that is final and still: settled live polys that have cooled and
 * finished revealing, committed strokes while they bake, the lifted selection, a resting replay.
 * #wet holds what moves: the provisional tail, the hot window, young growth, the pool window
 * during a hold, the halo, the Echo ghost and every animating stroke. Both are repainted only
 * inside dirty rects built from per-poly boxes (clip, clear, redraw whatever intersects), so an
 * idle frame does no work and a live frame repaints the region around the nib.
 *
 * Everything is drawn through render-core (drawCooked, and tracePoly for the hot trunk's 12 sp
 * chunks), so live ink and baked tiles share batching, LOD and tessellation. The hot multiplier
 * (1 + h·η) reaches exactly 1 at age 3τ, at which point a poly draws with its plain bucketed
 * alpha: bit-for-bit the committed look, and only then does it hand off to #dry.
 *
 * Identity. The cook's live geometry is gen-sorted, so poly indices shift as the stroke grows.
 * The layer keeps its own mirror of it (copying only the suffix that changed) and carries each
 * poly's animation state across views by a content key (kind, gen, unit, tone, alpha, count,
 * end points), so a poly keeps its reveal and hot clocks however the cook reorders, and a
 * superseded poly (regrow) simply stops matching. `slot` ids (ink/cook's InkLiveView) mark
 * settled polys when present; otherwise drainSettled events do.
 *
 * Decisions (also in the render-live report):
 *  - Hot ages use an arc clock: the wall time at which the nib first reached each arc. It equals
 *    t(station) for live drawing and stays right for replays played faster than real time.
 *  - The hot window is the last 120 sp; its oldest 48 sp cool spatially to 0, so a fast stroke
 *    has no step at the cap. Ink older than 3τ is cold anywhere.
 *  - Growth reveals by unit: a unit's clock starts when the unit first appears (provisional or
 *    settled), so a rise that re-truncates a unit never restarts its reveal; the deeper growth it
 *    adds rises with the geometry. A Sprout generation starts when its parent reaches 60 %
 *    (easeOutCubic reaches 0.6 at 26.3 % of T). Drift thirds reveal as one filament.
 *  - Fresh growth polys are hot from the moment they appear, so a rising pool glows while it
 *    rises and cools after.
 *  - Lift zones cross-fade over 120 ms: polys that are new at lift fade in, live polys absent
 *    from the committed geometry fade out. New growth units unfurl normally; Echo's crystal
 *    folds out with the cook's MorphSet (or reveals by prefix without one) while the ghost
 *    dissolves over 150 ms.
 *  - Un-grow / re-grow schedule generations on a grid of dur/(G + 2) with two-slot phases
 *    (consecutive generations overlap by half): deepest first and the spine last when removing;
 *    the spine first when growing. Re-grow (redo, restyle, load) takes 320 ms.
 *  - A restyle that changes only depth inputs (pools, base depth: a peel undo, a Form-chip depth
 *    bend) is a diff: ink present in both revisions stays put, only the old revision's own growth
 *    retracts (200 ms), then the new revision's own growth grows; a side with nothing of its own
 *    skips its phase (a drain-only peel bakes at once). Any change of look (colour, nib, Form)
 *    plays the full un-grow (150 ms) then re-grow.
 *  - The halo belongs to the nib: begin, lift and withdraw end it.
 *  - Wet ink may reach alpha 1 on Paper (above the 0.85 safety cap of committed ink) while it is
 *    hot, so the darker wet trail is visible on full-alpha trunks; it dries to exactly 0.85.
 *  - Replays (play) reveal the trunk along their own sample timing (raw arc normalised onto the
 *    cooked trunk), unfurl growth a hand's breadth behind the nib, raise units under a pool
 *    through their depth over the pool's recorded interval (the fractional-depth contract makes
 *    a prefix reveal equal the rising geometry for Sprout and Drift), and swell a halo there.
 *  - Paper per-generation alpha (ink-forms registry.paperAlphaScale, Echo's Paper exposure) is
 *    applied here through drawInk; tiles draw through it too (render-live contract request §2).
 *
 * Modules (render/live/), in dependency order:
 *  - timing.ts  hot decay, reveal and un-grow schedules, tuning constants, the arc clock, halo brightness
 *  - polys.ts   dirty rects, the live mirror (PolyStore), per-poly state and content keys
 *  - draw.ts    drawInk, the hot trunk (drawHot), the halo glow
 *  - items.ts   the Item contract, the frame context, WakeItem (the #dry / #wet poly-by-poly base)
 *  - stroke.ts  LiveStroke (the stroke being drawn) and FinishStroke (after lift)
 *  - play.ts    PlayStroke (replays, the first-run seed)
 *  - anim.ts    AnimStroke (whole-stroke grow / un-grow / bake / lifted) and diff restyles
 *  - layer.ts   createLiveLayer: items, frames, repaints, halo, prediction, the LiveLayer API
 * This file is the public entry: the API below is the whole of it.
 */
export {
  HOT, HOT_WINDOW, HOT_CHUNK, HOT_EDGE, CHILD_AT, UNGROW_MS, RESTYLE_UNGROW_MS, GROW_MS, LIFT_MS, GHOST_MS, BRIM_MS,
  MAX_ANIMATING, ArcClock, chainReveal, echoFoldMs, genOffset, genPhase, haloAlpha, hotEta, hotMultiplier, revealMs,
  windowEdge,
} from './live/timing';
export { PolyStore, RectList } from './live/polys';
export { cssRgb, drawInk } from './live/draw';
export type { PlayOpts } from './live/play';
export { depthOnlyChange, diffMasks } from './live/anim';
export { createLiveLayer, type LiveHostExt, type LiveItemInfo, type LiveLayerExtras } from './live/layer';

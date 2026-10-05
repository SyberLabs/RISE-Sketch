# Wave 1 reports (builders and reviewers)

Generated from the build workflow journal. For each group: the builder report, then the reviewer report. Contract requests live in docs/contract-requests/*.md; the architect has already folded these into the frozen contracts: Spine.z, Scene.{cookedFor,putFor,pick}, lineage(…, z), InputController.{onPenMode,onFingerPan}, AppState.{selectionRect,currentDocId}, and documented clocks (created = Date.now() at pen-down; MorphSet.t0 = stroke clock), LiveView.slot and Night-valued Cooked.alpha.


## build: ink-instrument

**Tests:** 73 passed, 0 failed. **Typecheck clean:** true

Built the ink-instrument group: all eight modules in src/ink per BUILD.md §2 and DESIGN §2.2, §2.3.2, §3.1, §7.4 and §7.5. Every listed export exists with its listed signature. The code is pure TypeScript with no DOM, uses only the allowed Math functions, and passes the purity test.

How it is proven: `tests/ink-instrument.spine.test.ts` feeds 4 different strokes (pen, mouse with no pressure, heavily jittered 60 Hz touch, chisel at zoom 2.5 with holds and tilt) in 12 different chunkings each, from 1 row at a time up to 400. After every append it checks that:
- `settled` never goes backwards;
- stations below the old `settled` are unchanged, bit for bit;
- newly settled stations equal the one-shot `buildSpine`, bit for bit.

After `finish()` the whole spine equals `buildSpine` bit for bit. A closed-loop test checks that `finish()` changes earlier settled stations only inside the declared lift zones.

Spine (`spine.ts`): a chain of streaming stages, each fed in order and never revising what it has emitted:
- One Euro filter on sp positions;
- knots every 2.4 sp along the filtered path;
- corner decision with 4 knots of lookahead, snapped onto the true vertex;
- two rounds of Chaikin smoothing with corners and ends held fixed;
- stations every 2.4 sp, with the nearest station moved onto each corner;
- per-station signals.

Stations below `settled` are final. Stations from `settled` to `n` are recomputed on each append by running a copy of the pipeline to end-of-stream, with no per-sample allocation. Measured on long strokes at 0.3–2.5 sp/ms: an append costs about 15 µs, and `settled` trails the provisional tip by 19–23 sp on average, 26 sp at worst. A full warm build of a typical 280 sp stroke takes about 0.2 ms.

`finish()` appends the raw lift point (end flush) and flushes. On closed strokes it also welds the seam via the exported `weldSpine`, which a live preview can run on a copy of the spine. Tapers, flick, seated stop and ramp-down live in the envelope, not the spine. The header comment of `spine.ts` documents the incremental model, what lags how far and why, exactly what `finish()` may change, and the definition of every station field (x/y/s/t/p/w/vn/k/c/cs/alt/az/nx/ny/corner).

Pressure: pens go through `calibratePressure`. When the stored pressure is NaN (mouse, touch), pressure is synthesised station to station from the stored timestamps.

Split pieces: `snapshot()` plus resume seeding, and `continuationSamples()`. For a recipe whose tail is cut, `finish()` keeps exactly the settled stations, so piece 1 ends on the snapshot station and the continuation starts on it.

`SpineBuilder` gained two extra methods:
- `tip(now)` returns exactly what the Rise input needs (filtered tip, arc, pressure, travel);
- `finish(closed?)` takes an optional override of the closed flag.

The other modules:
- **Envelope:** live envelope (causal entry taper, plus a `teFinal` flag) and final envelope (exit taper and flick, seated stop with the ×1.12 end bulb, pen ramp-down, cut bits, closure). `closureTest` applies hysteresis, needs 300° of net turning, and caches the turning over settled stations.
- **Depth:** the K(x) kernel and the depth field.
- **Rise:** a state machine per device: moving, pre-halo, pooling, paused or settling under the pen pressure gate, ceiling with a brim flash. Also move-on freeze, bloom at s = 0, pools quantised to 1/16 with a changed-window range for regrow, merging into the nearest pool once 32 exist, and a journal-based lift guard.
- **Calib:** the learner (pressure P5/P95/γ, vMed from ≥ 8 ms speed windows, J from recent strokes; EMA for 150 strokes, then locked at ≤ 1% per stroke within ±15%; persisted under `rise:calib:<device>`), plus `calibratePressure` and `synthPressure`.
- **Nibs:** widths, finger ×1.35, chisel angle, dry-split weight.
- **Stabilize:** the One Euro filter (no transcendentals) and the jitter meter.

### Decisions
- Pipeline order: One Euro filter on sp, then knots every 2.4 sp of filtered arc (this matches the spec's 'support 12 sp'), then corner resolution, then Chaikin ×2 with corners and ends fixed, then stations every 2.4 sp, then signals. A corner needs a turn over 55° measured ±4 sp either side and speed below 0.25·vMed. It must also out-turn the knots within ±2 (ties go to the earlier knot), and it is snapped onto the filtered vertex of greatest turning within ±1.2 sp. The station nearest each corner is moved exactly onto it, so corners stay crisp.
- Station arc s = s0 + 2.4·i on a fixed grid. A corner station keeps its exact arc, within 1.2 sp of its grid value. The last station of a finished stroke sits at the end arc; a grid station within 0.6 sp of the end is replaced by it. `Spine.L` is the absolute end arc s[n−1].
- Curvature κ is the polyline's turning integrated over [s−3, s+3] per sp, with each station's turning spread over the arc between its segment midpoints. This is exact on circles. The literal 'chord to P(s±3)' reading overstates κ by about 12% at R = 60 because of chord sagitta; a test proves the new form is unbiased. κ > 0 means the path bends toward the normal. The normal is left of travel, (ty, −tx) on a y-down screen, with the tangent taken as the chord over 6 sp.
- Station speed v is a central difference over stations i±k, with the smallest k ≤ 4 that spans at least 8 ms. It measures the filtered motion, which runs a few percent fast mid-stroke while the filter catches up from its cold start.
- One Euro filter: the speed estimate uses the raw derivative, as in Casiez's reference C++, smoothed at 5 Hz rather than the paper's 1 Hz so the cutoff keeps up with a hand accelerating out of a stroke start. fcMin comes from the stroke's calibration snapshot; β per device is from the spec.
- Jitter J: measured as the raw sample minus the time-interpolated midpoint of its neighbours, divided by √1.5, on slow segments only. 'Raw minus filtered' would be dominated by filter lag. J is the RMS length of the 2D residual, i.e. σ√2 for per-axis noise σ, taken as the median over 16-sample windows; it is NaN when a stroke has too few slow samples.
- Pressure mode is decided by row 0: a NaN stored pressure means synthesised pressure. In a real-pressure stroke, NaN rows are bridged from neighbouring or earlier rows in a way that does not depend on chunking. Synthesised pressure starts at 0.35 at station 0 (or at the carried value from a resume snapshot). `calibratePressure(NaN)` returns 0.6.
- End flush: the raw lift point (the last intact row) is appended to the filtered path at finish. Rows with non-finite position or time are skipped.
- Weld width W = min(50, max(0.04·len, 2·gap, 6), len/2). Positions blend by smoothstep(L−W, L, s), and nx/ny/k are recomputed with the window wrapping across the seam within 6 sp. So the lift zones are s ≥ L − W − 6 (at most 56 sp) and s ≤ s0 + 6; t/p/w/vn/c/cs/alt/az/s never change. The weld runs only at finish, because displaced positions can never be settled; previews call the exported `weldSpine` on a copy.
- A recipe with cut bit 1 (tail is a cut) skips the end flush, and its spine keeps exactly the stations settled after its last row. The resume snapshot layout is the const enum RESUME. `continuationSamples` puts the continuation's first row exactly on the snapshot station; the resume seeds the One Euro velocity estimate and the synthesised pressure.
- Chisel angle crossfades between azimuth and 40° over altitude 55–65° (a hard switch at 60° would snap mid-stroke), modulo π, returned in [0, π). The dry-split pressure gate is crossfaded from 0.55 to 0.45 and applies to every device.
- Entry and exit speeds are mean speed along the raw sample path over the first or last 40 ms. Seated-stop dwell uses the device's still radius × jf. Pen ramp-down reads calibrated pressure 30 ms before lift, to exclude the lift-off transient. In the final envelope, operators use the causal entry taper (`inF`) while the trunk uses TeTrunk = min(Te, 0.25·len). The seated bulb is ×1.12 over the last 3 sp with a 3 sp ramp in.
- `liveEnvelope(...).teFinal` is true once 40 ms of rows exist, the head is cut, or the recipe is a committed one. Closure still toggles the entry taper to 0 within the 30 sp head zone.
- Closure test: |net turning| > 300°, the stroke longer than 8 × the gap, hysteresis on distance (on inside r_c, off beyond 1.5·r_c). It reads z from InkSpine, or estimates it for a spine built elsewhere.
- Rise 'still' means every filtered position in the trailing 120 ms lies within the still radius of the current one. This displacement test is frame-rate independent. Stillness is dated from the start of that window. When the history doesn't yet cover the window, the time before the first step counts as still only if travel was below the radius.
- Rise thresholds: jf scales the distance thresholds only, not the onset times. Bloom (pool at s = 0) is decided at pre-halo start using travel < 6 sp. A hold within 0.5 sp of an existing pool continues that row; the 33rd hold continues the nearest row with its arc unchanged.
- Rise pools are stored quantised to 1/16, and `changed` fires only when the stored value changes. Hitting the ceiling stops rising but never lowers an existing row. The brim flash fires on the step that crosses the ceiling, or when a pool starts already at it. The lift guard replays a journal of row edits backwards to tUp − 60 ms. `rose` means some row has a > 0.
- Learner: EMA weight 0.08 per stroke for the first 150 strokes. Then it locks: at most 1% per stroke and within ±15% of the value at stroke 150. Pressure targets need ≥ 32 reservoir samples and exclude the first and last 30 ms. Speeds come from ≥ 8 ms windows, ignoring windows under 0.06 sp/ms (holds). J's target is the median of the last 15 strokes' jitter. Reservoirs persist in JSON rounded to 4 decimals; storage and parse errors are swallowed.
- Additive API (nothing listed was changed): InkSpine (Spine plus z), `SpineBuilder.tip(now)`, `SpineBuilder.finish(closed?)`, `weldSpine`, `continuationSamples`, `RESUME`, InkEnvelope (teFinal, TeTrunk, s0, L), `entryTaper`, `weldWidth`, `closureRadius`, `spineZ`, the HOLD table and rate constants in rise.ts, `percentile`, `penFcMin`, `flatGuard`, `SYNTH_P0`, and the signal helpers in signals.ts. `Learner.observe` gained an optional fifth parameter z.

### Gaps
- The live seam weld is not applied inside the incremental spine. Moved positions can never become settled, because closure can still turn off. The weld is a lift-zone change applied in finish(), and a live preview has to run the exported `weldSpine` on a copy of the spine.
- Seated-stop detection for mouse and touch depends on app/draft.ts appending a final row at pointerup (contract request #1). Until then, mouse and touch strokes always get an exit taper.
- Split pieces: the continuation tracks the uncut stroke within about 2.4 sp, not bit for bit. The continuation's One Euro filter and knot grid restart at the snapshot station; only the velocity estimate and synthesised pressure are carried over. The join itself is exact (piece 1's last station is piece 2's first), and piece 1 is a bit-for-bit prefix of the uncut stroke.
- Finger contact-radius pressure and tilt shading are P1 and not implemented. The R and tilt channels are carried through (alt/az are on every station) but unused.

### Contract requests
- docs/contract-requests/ink-instrument.md #1: app/draft.ts should append one final row at pointerup: the last row repeated with T = lift time. Mouse and touch send no rows while still, so without it the seated stop (end dwell ≥ 60 ms) can never trigger for them.
- docs/contract-requests/ink-instrument.md #2: `Learner.observe` needs the stroke's zoom. Implemented as an optional fifth parameter z (backward compatible). app/ should pass recipe.z, otherwise vMed is learned in doc units and is wrong at any zoom other than 100%.
- docs/contract-requests/ink-instrument.md #3: proposes adding `z` (sp per doc unit) to core `Spine`. Workaround in place: InkSpine extends Spine with z, and `envelope.spineZ()` falls back to estimating it.
- The same file carries integration notes for ink-forms and app: using tip(now) for the Rise input, how to wire closure, the exact lift-zone bounds, teFinal and TeTrunk, and the auto-split protocol.


## review: ink-instrument

**Tests:** 83 passed, 0 failed. **Typecheck clean:** true

I reviewed the ink-instrument group (BUILD §2) and fixed eight real bugs. One was serious: every finished stroke had a speed spike at its end. All 83 group tests pass (up from 73), and my files typecheck cleanly. The purity test currently fails, but only on two ink-forms files that are mid-write; my eight modules pass all three of its checks.

**What checked out.**
- Every export listed in BUILD §2 exists with its exact signature.
- The formulas match DESIGN §2.2, §2.3.2, §3.1, §7.4 and §7.5: widths, tapers, seated stop, ramp-down, closure radius and hysteresis, kernel K(x), hold thresholds and timings, pressure gate, settle, brim, lift guard, learner EMA and lock, pressure synthesis.
- Geometry modules use only the allowed Math functions. Typed buffers are reused, so nothing allocates per sample. There are no listener, timer or canvas leaks.
- A new fuzz test feeds 160 random strokes in random chunk sizes: every device, zoom 0.25–8, holds, arcs, tremor, near-teleports, open and closed. The builder's core holds up: incremental equals full build bit for bit, and all invariants hold.
- Measured cost is unchanged: about 17.6 µs per appended row, about 7 ms for a full build of a 9,300 sp stroke (3,875 stations), and 5.6 µs per frame for the closure test plus live envelope.

**Bugs fixed.**
1. **Speed spike at the end of every stroke** (`spine.ts:331`, `:511`; `stabilize.ts:58`). All stations between the filtered tip and the raw lift point (up to 15 sp for a mouse) carried the lift time. Their `vn` read 25–70× vMed, so a pen brush thinned 25% at the tail and the end of light brush strokes would dry-split into bristles. The lift point is now timed one filter time constant τ after the last row; under steady motion the filter lags exactly v·τ, so speed stays the same across it. Spacing the lift point so time per row matches the last real step also removes a ±17% bump where the two meet. The last stations now read 0.99–1.00 of the mid-stroke speed.
2. **Corrupt rows produced bad station times** (`signals.ts:32–110`). A row with `T = Infinity` gave station `t` of Infinity or NaN and a huge `vn`. Every per-station lookup now skips corrupt rows, and its output on clean data is identical bit for bit.
3. **A corrupt first row made the tapers NaN** (`signals.ts:134–215`, `envelope.ts:110`). That NaN would reach every width. The speed and dwell measures now skip corrupt rows.
4. **Seated stop never fired for a shaky hand** (`signals.ts:184`, `envelope.ts:115`). Tremor of 0.5 sp adds path length on every sample and reads as about 0.2 sp/ms, above the threshold. The seated test now uses net displacement over the last 40 ms, scored against 0.15·vMed. The exit-taper length still uses path speed.
5. **Visible kink at the seam of closed loops** (`spine.ts:707`). I found this by looking at sandbox screenshots. The weld joined end and start at their own directions, about gap/radius apart (7–9° in the test loops). It now uses a cubic blend that arrives in the start's direction. Loops whose ends differ by more than 30–60° keep their point, and the lift zones are unchanged.
6. **Wrong closure on reused spine objects** (`envelope.ts:158`, `:178`). The cached turning total was trusted for a different stroke in the same buffer, and an open square read as closed. The cache now checks station 0 and its last station before trusting itself.
7. **Hold at the start of a split continuation bloomed at s = 0** (`spine.ts:661`). `tip().travel` restarted at 0 in piece 2; it now includes `s0`.
8. **NaN inputs to Rise wrote NaN into pool rows** (`rise.ts:225–268`). A NaN ceiling, pressure or base reached the rows, and a NaN tip counted as "still". Non-finite tips are now ignored, unknown pressure reads as 0.6, a NaN ceiling means no cap, and a NaN base reads as 0.

Smaller guards:
- A damaged calib no longer gives NaN pressure (`calib.ts:47`).
- NaN speed holds the synthesised pressure (`calib.ts:54`).
- Unknown pressure or speed gives a finite width and dry-split (`nibs.ts:33`, `:80`).
- The learner no longer drops the rest of a stroke after one bad time stamp (`calib.ts:158`).
- The snapshot fallback reads the first intact row (`spine.ts:645`).

**Tests added.**
- One regression test per bug above, plus pointed-loop and NaN-width tests.
- The 160-seed fuzz suite (`tests/ink-instrument.fuzz.test.ts`).

**Sandbox.** `sandbox/ink-instrument/` (port 5191) shows a gallery of strokes plus a live panel driven by a real pen stroke through Chrome. I looked at the gallery and zoomed views: the L corner is crisp, the welded seam is smooth, tapers, the seated bulb and the chisel angle look right, and the live loop closes and welds. The server is stopped.

### Decisions
- End-flush timing: the raw lift point gets time t_last + τ, where τ = 1/(2π·fc) is the filter's time constant at lift. Its row position is li + τ/Δt_last, so time per row and (under steady motion) arc per row continue across the join. So `Spine.t` of a finished stroke runs on up to τ past the last sample (typically 3–45 ms, at most about 133 ms) and strictly increases. Documented in the spine.ts header and the integration notes.
- Corrupt rows (non-finite X, Y or T) are skipped by every row lookup, not only by the filter. Station channels are interpolated between the nearest intact rows. On clean data the result is identical bit for bit to before.
- The seated-stop test uses exit velocity (net displacement over the last 40 ms of intact rows) against 0.15·vMed, because a shaky hand inflates path length. The exit-taper length Tx still uses mean speed (path length), so flick-off and slow-end behaviour are unchanged.
- The closure weld is a cubic Hermite blend. It departs smoothly, lands exactly on the first station, and arrives in the start's direction. The direction match fades out between 30° and 60° of mismatch so pointed loops keep their point. Lift zones are unchanged: x/y/nx/ny/k only, s ≥ L − W − 6 and s ≤ s0 + 6.
- `tip().travel` is s0 plus this piece's filtered travel, i.e. the whole stroke's travel. The Tip interface doc says so.
- Rise robustness: a step with a non-finite tip or clock is ignored with state unchanged. NaN pressure reads as 0.6 (as calibratePressure(NaN) does), a NaN ceiling counts as uncapped (+Infinity), and a NaN base reads as 0.
- calibratePressure falls back to γ = 1 when gamma is not a positive finite number, and to k = 1 when flat is NaN. synthPressure returns the previous value when speed is NaN. nibWidth reads NaN pressure as 0.6 and NaN speed as 0. drySplit returns 0 for NaN.
- The closure-test turning cache now checks station 0 and its last cached station before reusing its prefix, so a pooled or reused Spine object is rebuilt rather than trusted.
- Additive exports only; no listed name or signature changed: signals.rowOk/firstOk/lastOk/exitVelocity/posAtArc, an optional `chord` parameter on windowSpeed, OneEuro.lagMs().

### Gaps
- The live seam weld is still not applied inside the builder's live spine, because welded positions could never be marked final. A live preview must run the exported weldSpine on a copy (it is the exact function finish() applies). Unchanged from the builder's report.
- Seated stop for mouse and touch still depends on app/draft.ts appending a final row at pointerup (contract request #1).
- Split continuations track the uncut stroke to within about 2.4 sp, not bit for bit. The resumed velocity estimate comes from the tip's time rather than the snapshot station's. The join itself and piece 1's match with the uncut stroke are exact.
- Finger contact-radius pressure and tilt shading are P1 and not implemented; alt/az are carried on every station.
- Rows whose timestamps go backwards (a violation of the sanitised-time contract) can still produce non-monotone station t. Input sanitises time, so I did not guard it.
- tests/purity.test.ts currently fails on two ink-forms files that are mid-write (ink/operators/types.ts and sprout.v1.ts reference `window`). Not mine; all eight ink-instrument modules pass its allow-list, import-direction and no-DOM checks.

### Contract requests
- No new contract requests. The builder's three still stand in docs/contract-requests/ink-instrument.md: #1 app/draft.ts should append a final row at pointerup so mouse and touch can get a seated stop; #2 Learner.observe should take z (implemented as an optional 5th parameter, and app must pass recipe.z); #3 core Spine should carry z (worked around with InkSpine).
- I updated the integration notes in that file for ink-forms and app: the tangent-continuous weld, end-flush timing (t[n−1] is not the last sample's T), tip().travel including s0, and the corrupt-row and NaN policy.


## build: ink-forms

**Tests:** 93 passed, 0 failed. **Typecheck clean:** true

Built the ink-forms group: src/ink/noise.ts, the five operator files plus registry in src/ink/operators/, and src/ink/cook.ts. Every export listed in BUILD.md §3 works with its listed signature. All my files typecheck under all three configs and pass the purity scan. 93 tests across 7 ink-forms test files plus purity.test.ts pass. In the full repo run, 3 tests fail, all in render-core's in-progress tests/render-core.review.test.ts, which does not import any ink-forms module.

**How the key invariant holds.** `cook(r)` is literally `createIncrementalCook(draftOf(r)).finish(r)`, and it holds by construction:
- Every unit is a pure function of the settled spine within its reach, the depth field, its head inputs and its integer rng address. Units are gen-0 trunk blocks on an absolute 50 sp grid, Sprout anchors and Drift stations.
- A unit is emitted only once its whole reach is settled, so live and one-shot cooks emit the same units with the same inputs.
- Pools are handled by diffing the cook's own copy of the pool rows on every call and at finish. Each changed row re-emits only the units within [s−48, s+32] (Line blocks within a further 24 sp). Sprout and Drift units only re-truncate. Pool edits the cook is never told about, such as the lift guard, are still caught.
- The entry taper and closure changes re-emit units in the first 42 sp.
- At finish, units touching the lift zones re-emit: exit taper and seated bulb, TeTrunk ≤ 0.25·len, the seam weld (s ≥ L−56 and s ≤ s0+6), tail anchors and stations, Echo's crystal, radial seeds.

**Tests that prove it:**
- **Incremental ≡ full:** 20 cases (4 Forms × pen, mouse, touch, chisel at zoom 2.5, closed loop), 6 schedules each. Schedules mix 1-row to 500-row chunks, random holds and Settles, deliberately too-narrow regrow windows, unreported lift-guard edits and closure flicker. Result is bitwise.
- **Lift-zone correctness:** the committed trunk is checked station by station against the final spine and final envelope. I mutation-tested the head, tail and weld rules: each mutant is caught.

**The Forms:**
- **Line:** a nested-lattice hat offset field. Depth 0 is exactly the spine ribbon. Seams and cuts are pinned. Live, the nib stays clean and crackle fades in behind it.
- **Echo:** an RDP generator with caps, snowflake on closed loops, alternate-copy flip, an 8-vertex live ghost that snaps to the snowflake on closure, and a fold-out MorphSet at lift.
- **Sprout:** developmental templates (fern / coral / bush), side chosen away from neighbouring ink or toward the convex side, speed and tilt lean, tropism. Cooked once at the ceiling and truncated.
- **Drift:** curl noise using permutation tables, momentum, jitter table, tone thirds.
- **Shared:** radial seeds for all four, hierarchy and glow alphas, Echo exposure, per-unit and causal budgets, `drainSettled` with stable ids, and a live view with an additive `slot` array, provisional tail and bloom preview.

**Auto-split works:** `createInkCook(...).snapshot()` carries the growth-chain cursor, and `finish(r)` honours `r.cut`. The pieces meet on one station and growth continues with no gap or duplicate. `cookPreview` and `spineOf` (cached) are done.

**Measured:** live per-frame cost (append, regrow, view, drain) is p95 0.3–0.9 ms on an 8.7k sp stroke against the 4 ms budget. One-shot cook of that stroke is 9–35 ms.

**Visual checks:** the sandbox at sandbox/ink-forms/ (forms, paper, depth, close, speed, live and nibs views) drew real cooks through render-core's `drawCooked`; screenshots via `node sandbox/ink-forms/shot.mjs <outDir>`. They showed two problems, both fixed: Line had no visible crackle, and Sprout stamped a bright bar at every anchor.

### Decisions
- Line level amplitude decays ×0.62 per level from h_1 (h_1·A·0.62^(k−1)) instead of the literal h_k·A·0.62^(k−1). Read literally, the amplitude falls ×0.31 per level: level 5 is under 0.05 sp, depths 3–5 look the same, and the spec's own note that level-6 hats would alias could not hold. With ×0.62, d = 1 is a gentle undulation, 3 a coastline, 5 crackle; fast strokes throw lightning.
- Line asymmetry: sign(κ̄) is softened to clamp(κ̄/0.004, −1, 1), using the spec's own straight-run threshold. Bumps erode outward: asym = −0.35·that, since κ > 0 bends toward +n. Pen tilt uses unit(azimuth) and crossfades in over cos(alt) 0.1–0.3.
- Line pins its offset to zero over 12 sp at closed or cut ends. Live, the provisional tail fades the crackle in over 20 sp behind the nib (a spatial reveal) instead of the 160 ms morph, so view().morph is null while drawing. Line keeps dBucket 0.
- Sprout branch width eases in over a collar of 0.6 × the branch base width (still a pure function of arc, so truncation stays exact). Without it, additive Night ink stamped a bright bar across the stem at every anchor.
- Sprout: + and − turns are mirrored by the primary's side σ, so alternate anchors grow mirrored. The anchor arc, side and template are frozen when the chain reaches the anchor; geometry is recomputed whenever the unit re-cooks. The 900-point unit cap is honoured but realistic sizes peak around 600 points.
- Causal budgets (Sprout 24k, Drift 30k) count emitted (truncated) points at the current depth, and decide which units exist. Units are cooked lazily, only once they exist; this cut the one-shot Drift cook from 105 ms to 35 ms.
- Drift: n_max is clamped to [6, 150] (the 150-steps budget), so every unit's ceiling is 6. Widths are floored at 0.28 sp (the demo's floor). Thirds split at fractional step boundaries; a filament shorter than 3 sp is one poly. Radial Drift uses the full 0.8 outward momentum. The field cell is λ/2 = 140 sp at the commit zoom, and the noise uses seeded 256-entry permutation tables.
- Echo trunk blends from the bare nib at base 0 to α 0.55 / width ×0.6 by smoothstep(0, 0.5, base), so depth 0 is the bare nib for every Form. Width uses 0.78^d (continuous). The crystal is chunked at 256 points that share their joints. Tone depth bucket = round(4·min(1, d_E/5)). Fold-out sources are each vertex's position at depth 0. Snowflake bump orientation uses the generator's length-weighted mean y.
- Cooked.alpha carries the Night design values: hierarchy 0.72^(g−1), Drift 0.38, Night Echo exposure. Paper conversions are exported (paperAlphaScale, echoPaperExposure) for the raster to apply.
- Poly boxes are rounded outward to Float32, so they contain every stored point exactly at any coordinate magnitude.
- Trunk chunks: absolute 50 sp blocks are the units (unit = block index); chunks also split where the tone changes. Bristles are ordered after all core chunks in gen 0 so adjacent core chunks stay weldable. A chisel tap is a short edge stamp, not a disc.
- drainSettled: indices are stable monotonic ids. A re-emitted unit's k-th poly replaces its old k-th poly; surplus old polys are replaced by empty PolyViews. Nothing is drained after finish. view() returns all polys gen-sorted, plus an additive slot array (−1 = provisional).
- Growth near the nib is shown provisionally only where a pool has raised the depth above base, so a hold visibly rises under the nib. A bloom (a pool at s ≤ s0 + 0.5 while the stroke is under 6 sp) previews its radial seed.
- finish(r) takes pools, closed, cut and radial from r. A cut tail truncates the spine to its settled stations even when the draft predates the split. A stroke with fewer than 2 stations cooks as radial.
- Ripple (P1) and unknown operator versions cook with the v1 operators (Ripple as Line).
- MorphSet.t0 is in ms since pen-down (the lift time); the live layer adds its own pen-down timestamp.

### Gaps
- Ground-dependent alphas (Paper hierarchy 0.78^(g−1), Drift α 0.30, Echo Paper exposure) cannot live in a ground-independent Cooked. Night values are baked; Paper needs render-core to apply the exported scale (contract request #1).
- Line's spec'd 160 ms live morph is replaced by a spatial fade behind the nib, so no Line MorphSet exists while drawing. Echo's fold-out MorphSet is a single per-vertex lerp from depth-0 positions (1× the points), not a hierarchy of parent anchors at ~1.3×.
- Split pieces join exactly (same station; Line pinned, untapered cut ends; growth chain continues). Near the join, a continuation's first units read a spine clamped at s0, so they are not bit-identical to an uncut stroke within about 12 sp. This inherits the instrument's split model.
- Under 'lighter', growth that overlaps the trunk or its parent branch still glows brighter where batches differ (now small tapered nodes thanks to the Sprout collar). The closed-loop seam has two coincident end caps; fixing that belongs in the tessellator.
- Ripple is P1 and cooks as Line. P1 features (tilt shading, Drift combing, Sprout collision, bud dots) are not implemented.
- cookPreview lowers depth by whole levels (and decimates as a last resort). It does not cache; glyph callers should cache by (recipe, option, ground) as DESIGN §6.8 says.

### Contract requests
- docs/contract-requests/ink-forms.md #1: render-core's drawCooked should apply Paper alphas, multiplying by paperAlphaScale(form, gen) and, for Echo, by echoPaperExposure(coverage). Cooked carries the Night values because geometry must not depend on the ground.
- #2 (additive, nothing requested): InkLiveView.slot gives stable drain ids for live polys. The note documents the drain replace semantics, including empty replacement polys.
- #3: MorphSet.t0 is on the stroke clock (ms since pen-down) because the cook is pure and has no clock.
- #4: Line's live reveal is spatial (crackle fades in behind the nib) rather than the 160 ms morph.
- #5: auto-split protocol for app/draft.ts: createInkCook(draft).snapshot() right after piece 1's last rows; finish(piece1 with cut|2); continuation = {s0, cut 1, resume: snap, samples: continuationSamples(...)}.
- #6: finish(r) reads rows through the draft, so app must append any pointer-up row to the draft buffer, not only to the recipe.
- #7: semantics of ceiling(s) for the rise halo.
- #8 (FYI for render-core): a closed loop's trunk ends in two coincident caps at the welded seam.


## review: ink-forms

**Tests:** 112 passed, 0 failed. **Typecheck clean:** true

I reviewed ink-forms (BUILD §3) against DESIGN §2.3, §3.1, §3.2, §6.6, §7.4, §7.5 and §9 and fixed seven bugs plus one performance problem. All 112 group tests pass, the whole repo passes (891/891), and my files typecheck cleanly under all three configs.

**What checked out.**
- Every export in BUILD §3 exists with its exact signature (FORMS, CURRENT_V, createIncrementalCook, cook, draftOf, cookPreview, spineOf).
- The operator formulas match the spec, apart from the builder's documented decisions: Line lattice, Echo caps and fractional fold-out, Sprout spacing, templates, lengths, angle, side, lean, tropism, width and budgets, Drift stations, n(d), momentum, jitter, width and thirds, and the hierarchy, glow and exposure alphas.
- The geometry files use only the allowed Math functions, and nothing allocates per sample.
- The core invariant (finish ≡ cook, bit for bit) is sound by construction. I attacked it with a 2,000-seed fuzz over every Form, device, nib, zoom 0.25–8, base 0–dMax, holds, Settles, lift guard and closure flicker: 0 failures. A 120-seed version is now a permanent test.
- The instrument reviewer's spine changes were already in the builder's goldens.

**Bugs fixed (src/ink/cook.ts unless noted).**
1. **finish(r) did not match cook(r) when r was not exactly what the draft saw** (`:539`, `:667`). A pointer-up row added only to the recipe gave a different Cooked. finish now compares rows and pen-down fields and, on a mismatch, cooks r afresh, so finish(r) ≡ cook(r) always. The normal lift stays incremental, at 0.8–1.6 ms.
2. **A damaged resume cursor stalled the cook** (`:221`, `:700`, `:615`, `:873`). A NaN arc or an unknown phase made the chain step 100k times per call: 1.3–4.5 s per cook, repeated on every live append. Invalid cursors are now ignored and the chain loops are NaN-safe.
3. **A unit dropped by the causal budget kept a stale depth** (`:764`). When it came back into existence outside the regrow window, it drew at the old depth until lift. Proven by a history-independence test that fails without the fix.
4. **Light radial Echo taps had inward bumps** (echo.v1.ts:390). Below a pressure of about 0.58, the Koch bump fell under the 0.05 area flip rule, so alternate bumps flipped inward. Radial snowflakes now never flip.
5. **Sprout's pen lean misread azimuth near the 0/2π wrap** (sprout.v1.ts:250). It interpolated the long way round, which flipped the lean. Added `Sampler.angle` (types.ts:208); Line now uses the same helper, bit for bit as before.
6. **Bloom ceiling** (`:862`). It returned the Form's nominal cap even when the seed's own budget stopped short; a large Sprout bush stops at about 2.8. It now returns the depth actually reached.
7. **Echo live ceiling** (`:505`). It used the 8-vertex ghost, which caps open strokes at 4. It now uses the RDP plan of the current spine, computed on demand and cached until the spine grows 6 sp.

**Performance.**
- Growth units at depth 0 are no longer walked or grown (`:766`; `:488` skips uncooked units in the ceiling). A base-0 Drift cook went from 11 ms to about 3 ms; output is unchanged and goldens confirm it.
- `cookPreview` (`:1038`) now handles a NaN budget, jumps straight to depth 0 when the trunk alone is over budget, and otherwise tries one level down and then bisects. Before, a deep Drift preview took 6 cooks totalling about 300 ms.
- `decimate` (`:1088`) welds joined chunks and sheds trailing polys, so it now truly guarantees ≤ maxPts.
- Live frames on an 8.7k sp stroke with holds: p95 0.4–1.2 ms against the 4 ms budget.

**Visual check (sandbox, port 5191, server stopped).** The screenshots showed Drift radial seeds as one-sided comets: outward momentum of 0.8 can never beat the unit field. I set the radial throw to 2.5 (drift.v1.ts:50), so taps now read as a radial burst that pours into the current. I added `seeds` and `preview` sandbox views, and shot.mjs now reads PORT. All other views look right on Night and Paper.

**Goldens: regenerated, so say so.**
- Only drift/tap and drift/bloom changed, from the radial throw. The other 42 hashes are unchanged.
- I added 8 fixtures (light taps and base-0 strokes with pools per Form), so the golden file now has 52 entries.

**Tests.**
- New file tests/ink-forms.review.test.ts with 20 tests. I confirmed every fix's test fails when that fix is reverted.
- I changed one assertion in the live test: it now checks the corrected bloom ceiling.
- The heavier test files get a 60 s timeout, because cooks hit the 5 s default when other agents load the CPU.

### Decisions
- finish(r) compares r with the draft it was built on: the sample rows bitwise (any NaN equals any NaN), and z, rot, seed, device, s0, head cut, origin, nib, size, Form, version, base, calib and resume. On any mismatch it cooks r afresh, so finish(r) ≡ cook(r) holds unconditionally; the cost is a full cook only in that case. Pools, closed, the tail cut and radial are still read from r.
- A resume cursor is accepted only if phase is 0 or 1, the arc is finite and within 128 sp of s0, the index is a non-negative integer, side is in {−1, 0, 1} and the budget is finite and ≥ 0. Otherwise the chain starts afresh at s0 with budget 0.
- Growth units are cooked at their ceiling only once their depth is above 0, which is output-identical. ceiling() ignores uncooked units.
- A unit coming back into existence recomputes its depth and entry factor, so the live state depends only on the current inputs.
- Radial Drift outward momentum is 2.5, decaying 0.95 per step, instead of 0.8. The spec says only 'momentum radially outward'; at 0.8 the 24 filaments formed a one-sided plume, which I saw in screenshots.
- Radial Echo snowflakes never flip alternate copies. The 0.05 area flip rule applies to drawn generators; §2.3.8 says bumps face outward.
- Echo live ceiling = the cap of the RDP plan of the current spine (a snowflake while closing; 5 for short open strokes, which become Line), cached until the spine grows 6 sp or closure changes. The previous ghost-based cap was ≤ 4 on open strokes.
- Bloom live ceiling = the Form's radial cap, unless the seed realised less than requested; then it is the realised depth, which equals the committed ceilingMax.
- cookPreview tries one level down, then bisects between it and depth 0. If the trunk ignores depth and alone exceeds the budget, it goes straight to depth 0. decimate welds joined same-gen polys (a run takes its first chunk's tone; thumbnail quality) and sheds trailing polys (bristles first) before striding, so ≤ maxPts is guaranteed. A NaN budget means no limit; a budget below 2 means 2.
- I kept the builder's decisions: Line amplitude decays ×0.62 per level from h_1, a spatial live fade for Line instead of the 160 ms morph, Night alphas baked into Cooked, and t0 on the stroke clock.
- Golden hashes were regenerated deliberately: drift/tap and drift/bloom changed (radial throw), and 8 fixtures were added (tap-light and base0-pools per Form). The other 42 hashes are unchanged, so no other fix moved fixture geometry.

### Gaps
- Unchanged from the builder: Line's 160 ms live morph is replaced by a spatial fade, and Echo's fold-out is one per-vertex lerp from depth-0 positions rather than a hierarchy of parent anchors at ~1.3×.
- Unchanged from the builder: Paper alphas need the raster to apply paperAlphaScale and echoPaperExposure, and split continuations are not bit-identical to an uncut stroke within about 12 sp of the join.
- MorphSet.t0 semantics still differ from the core/types.ts comment (contract request #3).
- Echo's live ceiling is computed on the pre-lift spine; the end flush and weld can very rarely change the RDP generator, so the halo's brim can differ by a level from the committed crystal's cap.
- cookPreview has no internal cache; callers cache, as DESIGN §6.8 says. A deep Drift preview still costs about 3–4 cooks.
- Not mine, observed: tests/det.test.ts timed out once at 5 s while the full repo suite ran in parallel; it passes alone and passed in the final full run (891/891).

### Contract requests
- Updated docs/contract-requests/ink-forms.md #6: app/draft.ts should still append the pointer-up row to the draft (fast lift), but finish(r) is now correct either way; a mismatch costs a full cook (10–35 ms on a long stroke).
- Updated #7 with the new ceiling semantics: Echo uses the RDP plan of the current spine; a bloom reports the depth it actually reached.
- Added an FYI for doc-persist and app: invalid resume cursors are ignored, so the chain restarts at s0.
- The builder's requests still stand: #1 (Paper alphas applied at raster; render/live.ts already does this), #3 (MorphSet.t0 is ms since pen-down while core/types.ts says performance.now clock; render-live ignores t0), #4 (Line live reveal is spatial), #5 (auto-split protocol), #8 (seam caps).


## build: render-core

**Tests:** 91 passed, 0 failed. **Typecheck clean:** true

I built render-core: `src/ink/color.ts` and `src/render/{tessellate,raster,batch,camera,ledger,ground}.ts`. Every export listed in BUILD.md §4 exists with its exact signature. My 88 tests pass, the purity test passes, and my files typecheck cleanly under all three configs. The sandbox renders both grounds without artifacts, checked by eye on screenshots and by measuring pixels.

**Colour (`color.ts`)**
- Seven inks, each designed as a Night/Paper pair in OKLCH, with the spec's tone ramps: 30 tones per stroke; Spectral uses one shared 36 hue × 30 tone table.
- Indigo over Ochre on Paper glazes to #0c482e (hue 159°), inside the required 130–170°.
- Variants, lineage, custom inks with derived twins, chip bending, swatches, Alt-click sampling (`lchAt`) and UI tokens are all in. The tokens are checked for contrast (text ≥ 4.5:1, control edges ≥ 3:1).

**Tessellation (`tessellate.ts`, pure, writes to `PathSink`)**
- Ribbons are built from pieces that all wind the same way, so overlaps merge and nothing cancels into holes.
- Turns up to 25° get smooth midpoint Bézier edges, 25–60° crisp miters, over 60° exact round joins (`arc`). Inner corners are clamped by routing through the centreline vertex, so thick strokes don't fold into notches or spikes.
- Ends get exact semicircular caps. Adjacent chunks sharing a point are welded with one shared edge, so no bright beads at chunk boundaries on Night.
- Chisel: one quad per segment, split where the travel crosses the nib angle, plus a core, all in one path. Near flat ends every piece is clipped on the nib line, so neighbouring chunks split the ink exactly and the core never pokes past the flat end.
- Also: dots, prefix reveal with an interpolated round tip, morph reveal, arc sub-ranges whose cuts share an edge exactly (for the hot-trail chunks), and per-end weld switches.
- Coverage tests compute winding numbers on a grid (thick hairpins, curls thicker than their radius, scribbles, figure-8s, chisel twists). I broke the code on purpose three ways (no inner clamp, no winding fix on quads or clipped pieces) and the tests failed each time.

**Drawing (`raster.ts`, `batch.ts`)**
- `drawCooked` groups polys into one fill per (colour, alpha level), capped at 96, merging neighbouring tones above that. It applies the hairline rule, generation cull, stroke-to-dot cull and the lazily cached simplified copies.
- Hot ink uses the exact multiplier on top of the bucketed alpha. On Night anything above 1 becomes a second additive pass, so the fresh trail genuinely burns brighter.
- All level-of-detail decisions depend only on the stroke and the zoom, never on the clip, so neighbouring tiles agree. `viewMatrix` builds its offsets in double precision; `inkTableFor` caches per recipe object.
- CPU cost: about 1.4 ms for a 9.5k-point stroke (0.15 µs per point), 6.6 µs for a 21-point live chunk.

**Camera, ledger, ground**
- Camera: conversions, pan, zoom-at-point, fit, detents, visible box, plus `snapToDevice` (settled camera lands on whole device pixels).
- Ledger: per-device memory budgets, evictor callbacks, evict-and-retry, `free` zeroes the canvas, plus a few extras.
- Ground: the CSS gradient, vignette and static dither grain, with a 400 ms cross-fade. The export painter matches the CSS ground to within 0.1 of an 8-bit level (measured).

**Bugs the screenshots caught and I fixed**
- The ground's internal layers covered the ink canvases (a stacking-context problem render-world would also have hit).
- Bow-tie overlaps at chisel chunk joints.
- The export vignette came out darker than the CSS one on Paper.
- Chunk ends showed as flat welds instead of round tips while a neighbour was still growing.
- Generation cull could differ between neighbouring tiles.

**Sandbox:** `sandbox/render-core` has 9 views (main, three zoom views, LOD, reveal, export, ground, dpr 2). `shot.mjs` screenshots them all; the screenshots are in the scratchpad `shots/` folder. The dev server on port 5182 is stopped.

### Decisions
- Spectral strokes carry dh = dL = 0. Their variant is the base hue h_s = 360·fract(0.618034·k) + dh, so one 36×30 table per ground is shared and InkTable.hs holds each stroke's base hue.
- Custom inks use a ±3° band plus the normal dL variant. Lineage is inherited only from a stroke with identical custom colours. ink 'custom' with lch = null falls back to Graphite's pair as a custom ink.
- customFromLch: the twin L′ = clamp(1.02 − L, 0.25, 0.85) is additionally clamped to the twin ground's legal range (Night 0.45–0.95). Stored LCh values are rounded (L and C to 1e-4, h to 0.01°).
- bendColor: the 6 px dead zone maps to |dh| > 4.5° (0.75°/px), past which C ≥ 0.10. The base includes the style's own dh/dL. Gamut mapping can lower C at very light L.
- inkTableFor caches per recipe object in a WeakMap (recipes are immutable, so this equals the id:colorRev:ground key with no per-frame key strings). resolveInk has its own content cache (512 entries), so equal colours share one table.
- Alpha levels: 8 linear levels (1/8–1) for a ≥ 1/16, plus three faint levels (1/24, 1/48, 1/96) so hairlines and deep generations fade smoothly. Below 1/192 a poly is skipped.
- Hot ink: the exact multiplier (quantised to 1/1024) applies on top of the bucketed base alpha, so it lands exactly on the committed alpha. On 'lighter', alpha above 1 is drawn as a second additive pass.
- Ribbon joins: Bézier smoothing up to 25° of turn, crisp miter for 25–60°, exact round join via arc() above 60°. The inner miter is used when its retreat is ≤ half of each adjacent segment, otherwise the outline routes through the centreline vertex. Caps and joins use arc() (exact circles) instead of the spec's 3–6 / 4 points.
- Chunk welding convention: poly i and i+1 are welded when they share the end point bit-exactly (x, y, w), have the same kind and gen (and the same unit for gen ≥ 1), and turn ≤ 60° there. Otherwise both ends get round caps. drawCooked turns welds off at an end whose neighbour is not yet drawn up to the shared point.
- Chisel core = 0.15·E, which equals 0.12S at p = 0.5 (Cooked has no S). Flat ends (stroke ends, joints, cuts) are clipped on the nib line when the nib is at least 10° off the travel; below 10° (nib sliding along its length) the end is not clipped. Free stroke ends also get the nib's E × core footprint.
- Hairline alpha uses the arc-weighted mean device width. Dots and single-point polys under 1 px are drawn at 1 px with alpha × w².
- Generation cull uses the per-generation max(w·α) of the whole stroke (cached per Cooked), never just the clipped subset, so tiles agree at seams.
- Simplified-copy switch-over is measured in device px: a copy is used once its tolerance maps to ≤ 0.5 device px. This equals the spec's 0.5× / 0.125× at dpr 1 and is more conservative above dpr 1. The commit scale z is recovered from the arc column (Δa/Δd).
- Stroke cull: strokes under 3 px become one disc in the most heavily weighted table colour (no colour string built), with radius and alpha matched to the ink area.
- drawCooked saves/restores the context, draws with an identity transform, and sets the composite op from the table for the duration of the call.
- Ground: Paper also gets a fainter grain, since its slow vignette can band too. The grain is mid-grey noise blended with overlay at one texel per device pixel. The cross-fade fades the new layer in over the old, opaque one. applyGround makes the element its own stacking context.
- Ledger: the cap is a budget that triggers onPressure evictors; allocation still proceeds. alloc returns null only when the browser refuses a 2D context twice. Extras: alloc(w, h, tag, ctxSettings?), adopt, byTag, count, and an optional canvas factory for tests.
- fitBox margin is a fraction of the viewport per side. Degenerate boxes count as 1e-6 doc units, so the scale clamps to MAX_SCALE. viewMatrix and the camera functions support rot (P1); the rot = 0 path uses no trig. Added snapToDevice.
- A dot's radius scales with reveal so taps grow and un-grow smoothly. morphFrom is indexed by global point index (aligned with c.pts / 4).

### Gaps
- Chisel quads have straight rail edges (the spec says quads), so facets can show at extreme zoom (about 20×+) on sharply curving or rapidly tapering chisel strokes. Ribbons are fully Bézier-smoothed.
- Where a chisel nib slides along its own length (within 10° of the travel) at a chunk joint, no exact split exists. Those ends are left unclipped, so neighbours overlap in a thin sliver (bounded by test).
- Under Paper's 'multiply', two different-tone chunks sharing an AA edge can leave a sub-level lighter line at the boundary. Night ('lighter') sums correctly.
- Merging only happens within one drawCooked call. Live → tile hand-off fidelity therefore depends on render-live drawing a stroke's overlapping polys in a single call (documented).
- The per-Cooked cache (simplified copies, generation maxima) is validated by (pts buffer, nPts, nPolys). A live Cooked mutated in place without changing size would not be re-derived; this only matters for live strokes drawn below 0.5× of their commit scale.
- applyGround, paintGround and real canvas allocation are verified in the sandbox (screenshots plus pixel measurement), not by Node unit tests. Ledger accounting and eviction are unit-tested with a fake canvas factory.
- No SVG PathSink builder is included (SVG export is P1). PathSink's arc() is used for caps, joins and dots (dots as two half-arcs, which suits SVG).
- Spectral's 10° hue steps between chunks are visible as edges at high zoom (by design: 36 buckets).
- The grain texel size follows devicePixelRatio when applyGround is called; the renderer should re-call it after a DPR change.

### Contract requests
- docs/contract-requests/render-core.md §1 (for ink-forms): emit chunked runs (trunk chunks, bristle chunks, Drift thirds) as consecutive polys whose boundary point is bit-identical (x, y, w, and ang for chisel), with the same kind and gen, and the same unit for gen ≥ 1, so tessellation can weld them with one shared edge.
- §2 (for render-live): hot ink on Night needs alpha above 1. drawCooked's `hot` option already does this with exact alpha and a second additive pass.
- §3: Cooked has no nib size S, so the chisel core is 0.15·E (equal to 0.12S at p = 0.5); no change requested.
- Integration notes in the same file: coordinate conventions; merging only happens within one drawCooked call (matters for live → tile hand-off); reveal and weld rules; arcFrom/arcTo for hot-window chunks; lodBytes for the Cooked LRU; ledger extras; ground stacking context and DPR re-apply.


## review: render-core

**Tests:** 119 passed, 0 failed. **Typecheck clean:** true

I reviewed render-core (BUILD.md §4) against DESIGN §2.4, §6.1, §6.3, §6.4, §6.9 and §9 LOD rules 2–5, then fixed the defects I found in place. Every listed export still has its exact name and signature. **119/119 tests pass** (91 before, 28 new review tests in render-core.review.test.ts) and my files typecheck clean under all three configs. I checked every fix in the browser sandbox (port 5192, now stopped) with screenshots and canvas pixel readback. CPU cost is 0.11 µs per point (the builder measured 0.15) and 2.6 µs for a 21-point chunk.

**Real defects fixed**
1. **Paper broke "Paper safety".** Its 0.85 alpha was bucketed up to 0.875, against the spec's ≤ 0.85. Now the design alpha is bucketed and alphaMax/alphaScale are applied exactly at fill time (raster.ts:303, :349, :373, :391). This also makes `alphaScale` fades continuous instead of stepping through 8 levels, and fill alpha never goes above 1 (Canvas ignores values over 1 and would keep the previous batch's alpha).
2. **Empty or sub-pixel arc ranges drew a full-width disc** at the cut, a bright bead on Night. Empty ranges now draw nothing (tessellate.ts:408). A one-sided collapse draws only the open half disc (emitPoint :590), and the collapsed point stays on the cut, not the cap (addPt :292).
3. **Seams between hot-window range fills.** Measured in Chrome, two different fill edges within about a pixel come out up to 25% too dark or bright. Cuts now snap (by at most 2 px) onto poly ends, a 1 px grid, or a nearby corner station of ≤ 60° (snapCut :363, cutQuantum :340). A cut exactly on a station splits on that vertex's bisector, like a weld (cutEdge :203). Measured clean afterwards.
4. **Double-added slivers where a vertex next to a cut or weld reaches across it.** Outline entries near a flat end are now clipped to their own side (clipOutline :506, clipZone :563). Measured exact on curves (a curl with radius 1.5× its half-width went from 41 px² overlap to 0) and at corners up to 28° (from 8–14 px² per cut to under 0.5 px² of gap). Far-away ink is never touched.
5. **The stroke-cull dot ignored `polys`/`reveal`/`hot`**, so a stroke split across #dry and #wet drew its dot twice, and an unrevealed stroke drew one (cullDot raster.ts:448).
6. **Polys were culled at tile seams.** A miter reaches up to 1.155·w/2, past the poly's box, so the clip test now pads by 0.08×min(box side) + 1 px (boxHits :426).
7. **Welds under morph used final rather than drawn positions**, pinching the joint (morphedAt :228, miterAround :250). drawCooked now unwelds neighbours whose morph t differ (:401).
8. **A single-station chisel poly drew a disc of diameter E** instead of the nib footprint (:930). Chisel welds now also require the same nib angle (joinable :212).
9. **Smaller fixes:**
   - `lod: false` enlarged sub-pixel dots to 1 px (:404).
   - Batch merging folded faint exact alphas to 1/8 instead of 1/96 (batch.ts:167).
   - Exact-key range widened to 4 and the entry limit raised to 2^24, which removes silent poly drops above 1M entries (batch.ts:27, :51–52).
   - A NaN morph t now draws the final geometry (:456).
   - A NaN zoom factor jumped the camera to 100% (camera.ts:54); a non-finite fit box gave a NaN camera (:73).
   - Ledger lost byte accounting when an evictor freed the canvas being resized (ledger.ts:114).
   - Paper corner vignette was −0.032 L against the spec's −0.02; now measured at −0.0196, with the CSS and export grounds matching exactly (ground.ts:49).

**Verified correct, no change needed:** color.ts (ramps, variants, lineage, spectral indexing, custom twins, tokens, Indigo×Ochre glaze), viewMatrix/regionMatrix precision, camera round-trips, the LOD switch-over points and determinism. The purity test passes. I added a `review` view to the sandbox and a PORT variable to shot.mjs.

### Decisions
- drawCooked buckets only the poly's design alpha (× the hairline or dot-area factor). The ground's alphaMax and alphaScale multiply it exactly at fill time. Fill alpha is clamped to 1 on Night and to alphaMax on Paper. The generation cull uses alphaMax but not alphaScale, so a fade never pops generations.
- Flat-end clipping is applied only to outline entries generated within 1.2·w/2 + 1 px of the flat end, and only when no vertex in that zone turns more than 30°. Measured: it is exact or sub-pixel below 30°. Above 30° a straight shared edge is not the true split, and clipping would remove more real ink than the overlap it saves, so the overlap is kept (never a gap).
- Arc cuts snap by at most 2 device px: onto poly ends within 2 px, else to a 1 px grid along the arc, else onto an interior station within half a pixel whose vertex turns ≤ 60°. Chrome antialiasing only sums correctly across edges at the same position; I measured up to 25% error for slivers of 0.04–1.4 px. A range that snaps empty draws nothing and returns false.
- A cut exactly on an interior station turning ≤ 60° uses that vertex's miter (bisector) as its edge, so it splits exactly like a weld.
- A range collapsing below 0.25 device px: a disc if both ends are free, the open half disc if one end is flat, nothing if both are flat. Between two flat ends both exact points are kept so the sliver fills its gap.
- A NaN morph t draws the final geometry. Welds under a morph use the morphed (drawn) positions, and neighbours drawn at different morph t are unwelded.
- boxHits pads each poly box by 0.08×min(box side) + 1 px. That pad bounds the 1.155·w/2 miter overshoot.
- zoomAt with a NaN factor returns the camera unchanged. fitBox with a non-finite box returns the 100% camera at the origin.
- Paper vignette alpha changed from 0.16 to 0.085, so the corners land at −0.02 L as the spec says (measured −0.0196). The CSS and export grounds stay pixel-identical.

### Gaps
- A cut or weld lying within about w/2 of a corner sharper than 30° (but not exactly on it) keeps a double-added triangle; ink is never lost. Measured over 14 sweep cuts at w/2 = 15 px: about 21 px² per cut at 35°, 160 px² per cut at 100°. An exact split needs the medial-axis boundary. A one-vertex bisector rule is exact at welds but not for hot-window ranges, whose neighbour extents are unknown, so I did not ship it. Mitigated by the corner convention in contract request §4/§5.
- Joints sharper than 60° still fall back to two overlapping round caps (a bead), as in the builder's design.
- Interior cuts that straddle a 1 px grid line can still land a pixel apart and show a faint seam. Only cuts the caller passes at nearly the same value hit this; shared cuts and cuts near poly ends are exact.
- Flat-end clipping and snapping apply to ribbons only. Chisel ends keep the builder's nib-line clipping, including its declared unclipped case below 10°.
- Under Paper's multiply, two different tones meeting at a shared AA edge still leave a sub-level light line (inherent to multiply; the builder already declared this).
- The builder's remaining gaps still stand: chisel quads have straight rails at extreme zoom; the live Cooked cache is keyed on buffer and size, not content; Spectral's 10° hue steps; no SVG PathSink yet (P1); merging only within one drawCooked call.
- applyGround, paintGround and real canvas allocation are verified in the browser sandbox (screenshots and pixel readback), not by Node unit tests.

### Contract requests
- docs/contract-requests/render-core.md §4 (for ink-forms, convention only): put a trunk chunk boundary that falls within w/2 of a spine 'corner' station (turn > 30°) exactly AT that station when the turn is ≤ 60°, where the weld is the exact bisector split. Keep it at least w/2 away from corners sharper than 60°, which fall back to round caps.
- §5 (render-live): arcFrom/arcTo are snapped by at most 2 px (onto poly ends, a 1 px grid, gentle-corner stations). Pass the same value to both neighbours of a cut. For exact splits, choose hot-window cuts at corner stations of ≤ 60°, or keep them w/2 from corners sharper than 30°.
- §6 (render-live, render-world, glyphs): new alpha semantics. alphaMax and alphaScale are applied exactly, Paper is capped at 0.85, and the stroke-cull dot honours polys, reveal and hot.
- §7 (render-live, render-world): pad per-poly boxes by 0.08×min(box side) + 1 px before using them for dirty rects or tile tests, because miters overshoot the box.
- §8: chisel welds require an equal nib angle; single-station chisel polys draw the nib footprint; morph welds follow the drawn geometry; lod:false keeps true dot sizes. I also corrected §2: hot alpha on Paper clamps to alphaMax, not 1.


## build: render-world

**Tests:** 55 passed, 0 failed. **Typecheck clean:** true

I built render-world: the five files `src/render/{tiles,compositor,bloom,renderer,glyphs}.ts`. `createRenderer(deps)` keeps its listed signature and returns a superset of `Renderer`; `createGlyphs()` implements `Glyphs`. All 55 tests pass (52 of mine plus the purity test), my files typecheck cleanly under all three configs, and all 12 sandbox scenarios pass against render-live's real `live.ts` / `overlay.ts`. I looked at every screenshot.

**What the renderer does**
- **Layer stack**: `#ground`, `#base`, `#bloomA/B`, `#dry`, `#wet`, `#overlay` (desynchronized), plus `#snap` and `#baseFade` only while in use. Blend modes follow the ground. The blit fallback (no CSS plus-lighter) is checked on Night.
- **Tiles**: half-octave levels, 512² device px, LRU through the ledger. Empty tiles allocate nothing.
  - Dirty rects re-render as one multi-rect clip region.
  - Missing tiles render centre-out 150 ms after the camera settles, with a prefetch ring.
  - During a gesture only cached tiles composite: stale tiles from other levels stand in, blitted on a rounded shared grid so there are no seams.
  - A settled camera snaps to whole device pixels.
- **No stroke shows twice**: a stroke is in the tiles unless it is held by the live layer or lifted into the selection. Each edit is a transaction: its tile work runs in time slices while `#base` keeps the old picture, then one frame recomposites and runs the follow-up in the same rAF (bake `done()`, un-grow, morph, lift/drop).
  - A property test with 16 random seeds checks that every eligible stroke lands exactly once per tile cell, both at the end and in idle intermediate states.
  - Deliberately breaking the rules makes 3 of 4 checks fail. The fourth (an epoch rule) only protects transient frames, which the final-state checks can't see.
- **Edits**: `strokesAdded/Removed/Replaced` handle grow, un-grow, fade (more than 24 strokes) and morph. Lift dims the rest to 45%; drop is a two-phase bake back.
- **Ground swap**: the new ground's visible tiles render first, then ground and ink cross-fade over 400 ms.
- **Night bloom**: quarter resolution, a 3-down / 3-up drawImage chain, double-buffered with a 400 ms cure, follows the camera by CSS transform during gestures.
- **Robustness**: context loss marks tiles for re-render; a coarse-pointer device hidden more than 30 s re-renders and shows the last snapshot meanwhile. `snapshot()` encodes WebP; `showSnapshot()` sits under the tiles and is uncovered as tiles complete. `renderRegion`, `purge`, `stats` and `frame(now, budget)` are all in.
- **Glyphs**:
  - Chips: the Stroke S-curve, an eraser ring in erase mode, the ink's tone ramp, and a Form squiggle at the current depth.
  - Sheet tiles: your last stroke through each option, with the use rule and the stock squiggle fallback.
  - Recent thumbnails are cooked within a time budget.
  - All are cached per input, so an unchanged call is just a key compare.

**Measured (headless, software raster)**
- **Hand-off**: live drawing vs baked tiles differ by at most 1/255 on every inked pixel, Night and Paper, for Line, Sprout, Drift and Echo.
- **Gestures**: frame CPU p95 is 0.9–1 ms with 60 and 300 strokes.
- **Erase**: a 2-stroke erase swaps tiles in 79 ms, within the 100 ms budget. A 20-stroke erase in a dense 300-stroke drawing takes 170–320 ms (about 150–260 ms CPU, every frame under 15 ms), so it exceeds the budget under software raster.

**Bugs the screenshots and profiles caught, all fixed**
- **Blank screen during the first gesture**: the startup camera armed the settle delay with nothing cached. It now renders at once when the cache is empty.
- **Empty bloom**: it was rendered while strokes were still uncooked and never refreshed.
- **Slow erase**: dirty rects merged into their union, and edits ran in the 6 ms bake slice. They now use one clip region and up to ~12 ms per frame while nothing is being drawn. A 20-stroke erase went from 10.4 s to under 0.4 s.
- **Gesture frames**: they were draining late-cook adds; they now finish only what consistency needs.
- **1 s stall on the first Paper flip**: this was render-core's grain encoding. I now prepare it while idle.
- **Paper hand-off**: tiles now draw through render-live's `drawInk`, which applies Paper's per-generation alphas.

The sandbox is `sandbox/render-world/`. Run `npx vite --config sandbox/render-world/vite.config.mjs --port 5183 --strictPort`, then `node sandbox/render-world/shot.mjs <outDir>`. The stand-ins under `standins/` are only used if the real live/overlay files are missing or `RW_STANDIN=1`. The dev server is stopped.

### Decisions
- Which strokes are in the tiles: a document stroke is drawn in tiles unless it is held by the live layer or lifted into the selection. Each entry into the tiles adds the stroke to the cached tiles it touches; renders snapshot the eligible set when they start, and a tile drains its pending adds before taking a snapshot.
- `renderer.live` is a facade over the live layer: `commit` and `play` (unless `bake: false`) hold the stroke until its bake. Document adds that no explicit call announced by the end of the task are added to the tiles without animation; removals and replacements re-render their dirty rects. A live hold that never bakes is released after 30 s.
- Transactions: tile work runs while #base keeps its previous composite; one frame recomposites when every waiting transaction's visible tiles are complete, then runs the commits (bake done(), un-grow, morph, lift/drop) and calls live.frame again so animations start in the same rAF. A camera change forces a composite after finishing in-place renders, plus adds and dirty rects only if transactions are waiting.
- #base is a composite buffer. Tiles are blitted with replace semantics (clear the rect, then draw): fallback tiles from other levels first (farthest level first), then the current level. Destination rects are rounded on the shared grid.
- Skipped (uncooked) strokes are recorded per tile with the region where they are missing (whole tile or a dirty rect). When they cook they are added whole or the rect is re-rendered, so geometry evicted from the scene's cache never causes a double draw.
- Dirty rects render as one multi-rect clip region rather than their union bounding box.
- User-visible edits (erase, undo, restyle, lift/drop) may use up to min(12 ms, 0.7 × measured frame interval) per frame while nothing is being drawn. Bakes keep the 6 ms slice. No background tile work runs during a gesture.
- The 150 ms settle delay is skipped when the tile cache is empty (first view, after reset or purge).
- Bloom source is #base (exactly the visible tiles composited) drawn at 1/4 resolution in one drawImage. The upsample mixes each level 60/40 with the level above for a soft core plus a wide halo. It re-renders after any ink change inside the view and after settle.
- Fades (New/Open reset, removals of more than 24 strokes, the ground swap) cross-fade a frozen copy of #base, kept with its own blend mode, against the new #base, both linear so additive sums stay constant. A camera change ends a running fade at once.
- Ground swap: the new ground's visible tiles render first (at most 250 ms), then ground and ink cross-fade together over 400 ms (instant under reduced motion).
- The tile soft cap is 55% of the ledger cap (45% on phones), with LRU eviction outside the view. The ledger's pressure callback also evicts. `purge()` frees all tiles and the bloom chain and suspends tile allocation for 2 s, or until the next camera change, resize or document operation.
- DPR passed to resize() is capped at 3 and so the viewport stays within 8 MP; the overlay is capped at 2.
- Restyling lifted strokes updates the selection layer without the morph (the chip-drag preview already showed it).
- Snapshot extent: the camera is stored, the viewport size isn't, so I assume the current viewport (or the rotated one) and otherwise fit to the image aspect. Snapshots are WebP, falling back to PNG, composed from #base, bloom, #dry and #wet over the painted ground.
- Glyphs: nib tiles show your last stroke as a bare nib mark (depth 0) at true width so growth never crops it; ink and Form tiles show it grown. The last stroke is re-laid to tile size with times scaled alike, which keeps speeds (and so tapers and lean). Chip strokes are cooked 2.5× larger and drawn back down so tapers stay short. Glyph DPR = canvas.width / clientWidth.
- Tiles, renderRegion and glyphs all draw through render-live's exported `drawInk` (Paper per-generation alpha), so live and baked ink use one rule.
- The other ground's grain is prepared in requestIdleCallback; render-core's lazy grain encoding stalled the first Paper flip for 1 s.
- Additive renderer API beyond the contract: busy, debug(), hold/release (replay), rebind(doc, scene) for New/Open, host, ledger, dpr, plus construction options for injected live/overlay/glyphs/ledger/clock.

### Gaps
- The 100 ms budget for erase/undo/lift holds for small edits (2 strokes: 79 ms) but not for large ones in dense areas: a 20-stroke erase among 300 strokes takes 170–320 ms under software raster. Re-rendering dirty rects is inherently proportional to the ink inside them; real-GPU timings are unmeasured.
- Tiles at other levels are kept and repaired at low priority. During a zoom gesture they can show content a few frames out of date in regions the current level hasn't rendered yet.
- A ground swap whose visible tiles take more than 250 ms to render starts the fade with some tiles missing; they appear as they complete.
- Context loss is handled through contextlost/contextrestored events and the coarse-pointer hidden-for-30-s rule. It is unit-tested at the tile level (markLost) but was never triggered for real in the sandbox (headless Chrome can't easily simulate it).
- The blit fallback (no CSS plus-lighter) only recomposes when the live layer reports activity or the facade is called. It is best effort as the spec allows; the ground cross-fade is not visible in fallback mode.
- The 'fade' animation for removals is a cross-fade of #base copies. On Paper, multiply makes unchanged ink a few levels lighter mid-fade; it lasts 200 ms.
- The snapshot extent is a heuristic until the viewport size is stored with it (contract request §4).
- Measurements come from headless Chrome on SwiftShader: CPU-side frame costs are reliable, wall-clock timings are not (frames there arrive 200–800 ms apart under load).

### Contract requests
- docs/contract-requests/render-world.md §1 (app): protocol for document changes. Call doc.apply, then in the same task live.commit/play or the matching strokesAdded/Removed/Replaced; unannounced changes are handled at the end of the task without animation.
- §2 (app): renderer extras: busy (use it in __rise.idle; frame-loop idle isn't enough because the settle uses a one-shot timer), debug(), hold/release for Replay, rebind(doc, scene, anim) for New/Open, ledger/host/dpr.
- §3 (render-core / ink-forms / render-live): move Paper's per-generation alpha (paperAlphaScale, Echo Paper exposure) into drawCooked; tiles, export and glyphs currently use render-live's drawInk.
- §4 (persist / app): store the viewport CSS size with the snapshot and add an optional viewport argument to showSnapshot; I currently infer it from the image aspect.
- §5 (export): call renderer.purge() just before allocating the export canvas. renderRegion draws every document stroke and returns ids skipped as uncooked.
- §6–8 FYI: scene extras used by duck typing (cookedFor, boxOf), glyph sizing notes, and behaviour the app can rely on (more than 24 removals fade, lift cap, ground-swap timing).


## review: render-world

**Tests:** 78 passed, 0 failed. **Typecheck clean:** true

I reviewed render-world (`src/render/{tiles,compositor,bloom,renderer,glyphs}.ts`) and fixed 16 issues in place. Every listed export exists with a compatible signature and none were renamed. Before this review the renderer itself (the transaction / hold / lift logic) had no tests at all.

**Tests:** I added a renderer test suite that runs on a fake DOM and checks the order of tile draws, `#base` composites and live-layer commits. I also added tile and bloom tests, and changed one glyph test whose expectation encoded the old skip behaviour. To check the new tests really guard the fixes, I re-introduced each fix's bug one at a time: all 17 reverts made a test fail. Group tests: 78 pass, 0 fail (the builder had 55). The full repo suite passes (930/930), and my files typecheck cleanly under all three configs.

**Sandbox (port 5193):** all 12 scenarios pass and I looked at every screenshot.
- In the blit fallback (no CSS `plus-lighter`), an empty Night viewport now reads (11,13,19), the same as normal mode. Before the fix it read (15,17,25): the bloom was blooming the painted ground.
- Hand-off between live and baked ink differs by at most 2/255 on both grounds.
- Gesture frames: p95 0.5 ms (60 strokes) and 1 ms (300 strokes).

**What I fixed (file:line in the final source)**
1. **Bloom in fallback mode** (renderer.ts:618, compositor.ts:218): the bloom was made from `#base`, which in fallback also holds the painted ground, the live layers and the previous bloom. That lifted the ground about 30% and fed the bloom back into itself. It now uses the tiles-only composite (new `inkSource` getter).
2. **Fallback double-bright strokes** (renderer.ts:603): `#base` was rebuilt before commits ran, so a just-baked stroke stayed doubled until some later live change. It is now rebuilt after commits.
3. **Drop flash** (renderer.ts:902, compositor.ts:280 `finishDim`): dropped strokes moved from full strength into a `#base` still at 45%, dipping then recovering over 160 ms. Drop now un-dims first and bakes the strokes back once the transition ends.
4. **Delete with a selection** (renderer.ts:460 `setLiftedLayer`): deleting the whole lifted selection left the drawing dimmed at 45% unless the app also called `drop()`. It now un-dims by itself.
5. **Blank flash after export** (renderer.ts:384 `resume(gate)`): after `purge()`'s 2 s rest, `#base` was re-composited with no tiles. It now keeps its picture until the visible tiles are rebuilt (at most 1 s). `purge` also keeps the bloom buffers so the glow doesn't vanish during export (bloom.ts:254 `freeScratch`).
6. **Live-held strokes claimed twice** (renderer.ts:683): `strokesAdded(..,'none')` claimed strokes the live layer still showed, so they appeared twice until the bake.
7. **`release()`** (renderer.ts:1176): same double-show problem for live-held strokes; it now leaves them to their bake.
8. **Restyle blink** (renderer.ts:836): a restyle without the morph (reduced motion, or more than 24 strokes) dropped the old version from the tiles before the new geometry was cooked, so strokes vanished until the cook finished. It now waits for the cook, as the morph path already did.
9. **`previewLifted`** (renderer.ts:935): it drew strokes that were not actually lifted (over the lift cap) into the selection layer, showing them twice. It now ignores them.
10. **Stale display during gestures** (tiles.ts:638/654/672/698): `readyFor`, `flushDisplayed` and `busy` ignored or mis-handled tiles from other zoom levels that are on screen standing in for missing ones. During a zoom gesture, a commit could make a stroke vanish or double. They now treat those stand-in tiles as on screen; tiles hidden under complete ones no longer block compositing.
11. **Cold-load snapshot never uncovering** (tiles.ts:849): a stroke removed before it ever cooked stayed recorded as missing in its tile, so that cell never counted as complete and the snapshot stayed under it forever. `forget()` now clears it.
12. **Snapshot handling** (renderer.ts:326, 854, 954): the snapshot survived `reset`/`rebind`/`setGround`, showing the previous document or ground. Edits during cold load left ghost ink under incomplete cells. Edits now punch their boxes out of the snapshot; reset and ground changes drop it.
13. **Bloom popping off** (renderer.ts:854, bloom.ts:240 `fadeOut`): the bloom vanished instantly on `reset('fade')` and at the key press of an animated ground swap. It now fades with the old picture.
14. **Glyphs left blank** (glyphs.ts:261): glyphs skipped drawing when a canvas had already shown the same key, so a sheet tile the UI cleared and refilled with the same option stayed blank. Unchanged calls are now one blit, with no cook or repaint.
15. **`busy` resolving early** (renderer.ts:318 `waitFor`): `busy` ignored pending cook waits (grow, restyle, lift), so an e2e idle check could resolve too early.
16. **Ground-swap wait** (renderer.ts:583): the wait for the new ground's tiles now gets the larger tile-work slice used for user edits, and the snapshot now includes the cold-load underlay (renderer.ts:1039).

I also made the sandbox port configurable (`RW_PORT`) and updated `docs/contract-requests/render-world.md` with the new behaviour and call orderings the app must follow.

### Decisions
- Drop un-dims #base and the bloom at once and holds the bake-back commit until the 160 ms transition ends (Txn.notBefore). A forced camera composite can commit earlier; the commit then snaps the transition to its end with finishDim().
- Commits remain all-or-nothing: no partial composite while any transaction is in flight. A half-finished multi-tile erase would otherwise show half a stroke before its un-grow starts.
- After a purge, a gate transaction (ready when visibleComplete() or after 1 s) keeps #base's picture. reset, setGround and resize resume without the gate: reset fades, setGround has its own wait, and a resize clears #base anyway.
- purge() frees only the bloom's scratch chain and keeps its quarter-resolution buffers, so the glow stays during an export. dispose() still frees everything.
- The cold-load snapshot gets holes (doc boxes) for removals, restyles and lifts while it shows, and is dropped after 64 holes, on reset/rebind and on setGround. The app must call showSnapshot after reset/rebind (documented in contract-requests §4).
- release() and strokesAdded('none') skip live holds; those strokes enter the tiles through their bake. The app should call live.fastForward() when stopping a replay (documented).
- previewLifted draws only items that are actually lifted; over-cap selections restyle on release, as the spec says.
- Tiles from other zoom levels count as on screen only where they stand in for a missing current-level cell. readyFor waits for their pending work only during gestures (when missing cells can't be filled); busy() ignores in-place renders of hidden tiles.
- Glyphs always redraw the target canvas, as a blit from the raster cache, instead of skipping when the key matches. This is safe against the UI clearing or resizing canvases, and an unchanged call costs one drawImage.
- The ground-swap wait uses the urgent tile slice (min(12 ms, 0.7 × frame interval)). Nothing else is animating then, and every frame of waiting is latency on G.
- I kept the builder's 250 ms ground-swap deadline. Extending it trades responsiveness on G for completeness.

### Gaps
- Dense erases are still over the 100 ms budget under software raster: a 20-stroke erase among 300 strokes swapped tiles after 269 ms wall over 17 frames (≈ 207 ms CPU, frames ≤ 13 ms). The cost is proportional to the ink in the dirty rects; real-GPU timing is unmeasured.
- An animated ground swap whose visible tiles take more than 250 ms starts the cross-fade with tiles missing. Centre-out order means the centre column is drawn first and the rest appears during the 400 ms fade. Headless SwiftShader shows this strongly (2 of 6 tiles at the swap); real devices are expected to fill far more in that time.
- In blit-fallback mode (no CSS plus-lighter, now rare) #base is opaque, so the cold-load snapshot underlay is never visible and the ground cross-fade is not animated. This is best effort, as the spec allows.
- The drop un-dim timing (160 ms) is verified by unit tests only. Headless screenshots take 100–700 ms each, too slow to sample the transition on the real stack.
- Real context loss (contextlost/contextrestored on actual canvases) is still unverified in a browser. It is covered at the tile level (markLost) and by the property test.
- If a stroke's cook fails permanently during cold load, its cell keeps the snapshot underneath (showing the stroke as last saved) until an edit punches a hole there or a reset.

### Contract requests
- No frozen contract changed. I updated docs/contract-requests/render-world.md: §2 release() leaves live holds to their bake (call live.fastForward() when stopping a replay); §4 call showSnapshot after reset/rebind/setGround, and edits punch holes in it; §5 purge keeps #base and the bloom on screen and has no blank flash after the rest; §7 glyph calls with unchanged inputs are one blit and always redraw; §8 strokesAdded('none') skips live holds, restyles wait for the new geometry, previewLifted filters to lifted ids, deleting the whole selection un-dims, drop un-dims first, and the ground swap uses the urgent slice with the bloom fading with the old picture.


## build: render-live

**Tests:** 91 passed, 0 failed. **Typecheck clean:** true

I built render-live: `src/render/live.ts` (`createLiveLayer(host)`) and `src/render/overlay.ts` (`createOverlay(host)`), with the exact BUILD §6 signatures. Both files typecheck with zero errors under all three configs (the whole project currently has 0 errors). 88 render-live tests pass, and so do purity and render-world's 59 tests. render-world's `renderer.ts` already imports my `drawInk` and `LiveHostExt`.

The live layer was also checked against the real `ink/cook.ts` for all four Forms: the mirror equals the cook's view point for point, settled ink cools into #dry, Echo's fold-out is picked up, and each stroke bakes exactly once.

**What the live layer does**
- **Two canvases.** #dry holds ink that is final and still. #wet holds whatever moves: the unsettled tail, the hot window, young growth, the hold window, the halo, the Echo ghost and every animation. Both repaint only inside dirty rects built from each poly's box. An idle frame returns false and draws nothing (tested).
- **Hot trail.** Each 12 sp chunk of the trunk's last 120 sp draws at the committed alpha × (1 + h·η(age)), with η reaching exactly 0 at 3τ. Adjacent chunks share their cut edges exactly. Alpha, cull and hairline decisions copy `drawCooked` exactly, so a cooled chunk is pixel-identical to the committed draw. On Night the extra brightness is a second additive pass. Growth is hot from the moment it appears. A poly moves to #dry only after it has cooled, finished revealing and settled. Moves to #dry happen in batches at most every 100 ms, so #dry repaints at no more than 10 Hz.
- **Living wake.**
  - Sprout unfurls 280 ms per generation, each child starting when its parent reaches 60 %.
  - Drift's three pieces of a filament reveal as one filament.
  - Line morphs run from the cook's MorphSet when it supplies one; the real cook supplies none while drawing, so this path is only exercised at Echo's lift.
  - A unit's reveal clock starts when it first appears, so a rise never restarts it.
- **Hold.** The halo is drawn as ink: brightness 0.15 + 0.5·level, ×1.8 brim flash for 160 ms, static under reduced motion. When a hold starts, settled ink within 96 sp of the nib returns to #wet so regrowth never repaints #dry.
- **Lift.** The changed ends of the stroke cross-fade over 120 ms. Young growth finishes on the wall clock. Echo's crystal folds out from the cook's MorphSet while its ghost dissolves over 150 ms. Then `host.bake` is called once, and `done()` clears #dry synchronously.
- **Un-grow / re-grow.** Un-grow retracts the deepest generations first and the spine last (200 ms; 150 ms for a restyle). Re-grow runs spine first.
- **Restyle.** A change that only alters pools or base depth (a peel undo, a depth bend) is played as a diff: shared ink stays put, the old revision's own growth drains in 200 ms, then the new growth grows. Any change of look plays the full un-grow then re-grow.
- **Replay (`play`).** The stroke draws itself on its own sample timing, raises growth through its pools with a halo, then bakes or rests until `dissolve()`.
- **Other.** At most 4 strokes animate at once. A camera gesture fast-forwards and bakes everything. Reduced motion makes everything instant. Withdraw and dissolve un-grow from what is currently visible.

**Overlay**
- Nib cursor at true size in the ink colour; chisel shows an oriented bar.
- Predicted tail drawn as a 50 % bare spine. The ink's round tip is clipped out at its first point, so the tail continues the ink instead of covering it.
- Weld ring fades in; size ring fades out.
- Lasso: dashed accent line with a faint fill.
- Eraser ring plus a doom mask (the doomed strokes' own outlines, ground colour at α 0.75).
- Selection: dashed bounds and a 1 px accent ring 1.5 px off the ink.
- Every call draws at once inside dirty rects; device pixel ratio is capped at 2.

**Sandbox and measurements.** `sandbox/render-live/` runs a minimal LiveHost stand-in (CSS ground plus the four canvases with their real blend modes) on a virtual clock, with the fake or real cook. I looked at screenshots mid-stroke, mid-hold, just after lift, after bake, on Paper, for every Form, for withdraw, replay, both overlay grounds, and 3× close-ups.
- **Bugs the screenshots caught and I fixed:** the live tip never cooled while the pen was still; replays stalled a hair short of full reveal; the predicted tail veiled the ink tip; the selection outline vanished against similar-coloured ink; the weld fade-in ran on the wrong clock; a two-chunk brightness step at the hot window's far end.
- **Speed:** `live.frame` takes 0.8–4 ms at the 95th percentile (budget 4 ms) in headless Chrome with software rendering (SwiftShader). It was measured on this machine only, not on the reference devices and not at 4× throttle.
- **Dev server** on port 5184 is stopped.

### Decisions
- Identity: the live layer mirrors the cook's view and copies only the part that changed, because the view is sorted by generation and indices shift on every append. Each poly's state (reveal, hot, morph and fade clocks) is carried across views by a content key: kind, gen, tone, unit, alpha, point count and both end points. A poly counts as settled when its `slot` id is ≥ 0, falling back to matching drained polys by the same key. Nothing depends on what `PolyView.index` means.
- Hot ages use an arc clock: the time the nib first reached each arc. For live drawing this equals t(station); it stays right for replays played faster than real time. Ink past the last mark (the round tip) counts as laid at the last update.
- Hot window: the last 120 sp in 12 sp chunks (DESIGN), with the oldest 48 sp cooling spatially to 0 so fast strokes show no step at the cap. Ink older than 3τ is cold anywhere.
- Wet ink on Paper may reach alpha 1 while hot, above the 0.85 safety cap for committed ink, so the darker wet trunk is visible; it dries to exactly bucket × 0.85. On Night, alpha above 1 is drawn as a second additive pass.
- Growth reveals by unit: a unit's clock starts when it first appears, provisional or settled. Sprout generation g starts (g − 1) × 0.263 × 280 ms later, which is when easeOutCubic reaches 60 %. Drift's three filament pieces reveal as one chain. Fresh growth is hot from the moment it appears, so rising growth glows while it rises.
- Lift: polys new at lift fade in and vanished live polys fade out over 120 ms. Growth from units first seen at lift unfurls; units seen before cross-fade. Echo's crystal folds out using the cook's MorphSet duration, started at commit time (its t0 is ignored); without a MorphSet it reveals by prefix. The ghost dissolves over 150 ms. The bake happens only after everything has cooled (≤ 660 ms on Night, ≤ 1140 ms on Paper).
- Un-grow and re-grow schedule generations on a grid of dur/(G + 2) with phases two slots long, so neighbouring generations overlap by half. Removal retracts the deepest generation first and the spine last; growth runs spine first. Re-grow takes 320 ms.
- Restyles that change only pools or base depth (`depthOnlyChange`) are played as a diff: shared ink stays put, the old revision's own polys retract over 200 ms, then the new revision's own polys grow. This realises the peel undo's 'drains the pools'. Any change of look plays the full 150 ms un-grow, then the re-grow.
- Hold: when the halo first appears, settled ink within 96 sp of the nib moves back to #wet. It returns to #dry 300 ms after the halo ends, so regrowth during the hold never repaints #dry each frame.
- Dirty rects are snapped to whole device pixels, merge when within 8 px, and are capped at 8 (cheapest pair merges). Repaints clip, clear, and redraw every item that intersects. Cooled polys move to #dry in batches every 100 ms, or at once when the item is otherwise idle. A wet poly whose hot multiplier changed by less than 1/512 is not repainted that frame.
- Paper's per-generation alpha (ink-forms registry.paperAlphaScale, plus Echo's Paper exposure) is applied by the exported `drawInk`: one drawCooked call per generation on Paper, a single call on Night. render-world's tiles already draw through it, so live and baked ink agree.
- Replay (`play`): the raw sample arc is normalised onto the cooked trunk's arc range, giving the trunk a round growing tip. Growth starts when the nib reaches its born arc + 24 sp + the Form's reach. Units under a pool appear when the pool starts rising and rise through their depth by prefix, which is exact for Sprout and Drift by the fractional-depth contract. A halo swells over each pool's recorded interval. `durationScale` scales stroke timing and reveal durations, not the hot τ.
- Concurrency: the stroke being drawn counts toward the cap of 4 animating strokes but is never fast-forwarded; the oldest others are. Withdraw and dissolve un-grow from what is currently visible instead of popping young growth to full first.
- Reduced motion: no hot trail; reveals, fold-out, lift fades and un-grow are instant. The halo shows at pre ≥ 0.5 with its level in quarter steps and no flash.
- Overlay: draws immediately inside dirty rects. The predicted tail lives until the next frame after it was drawn. Animations started between frames (weld fade-in, size-ring fade-out) begin on the next frame's timestamp.
- Overlay looks: the cursor (ring with a light fill, chisel as an oriented bar) and size ring use the ink colour on a soft ground-coloured backing. Lasso and selection use the ground's accent; the eraser ring is neutral. The selection ring sits 1.5 px off the ink so it never merges with ink of a similar hue. Outlines and the doom mask stop after 400k traced points per repaint.
- Prediction: `live.predict(tail)` sends [ink tip, last raw sample, ...tail] to `overlay.predicted`, bridging the filter lag. The overlay clips the ink's round tip out at the first point and caps the predicted part at 24 CSS px and 16 ms past the last real sample.

### Gaps
- The 12 sp hot chunks (the spec's size) leave visible brightness steps of up to ~4 % on long straight strokes viewed close up; they are not noticeable on curved, moving strokes.
- The overlay is normal-blended (DESIGN §6.2), so on Night the 50 % predicted spine reads as a dimmer ghost of the ink rather than as light.
- Live Line 'morph from spine to displaced position' depends on the cook supplying a MorphSet. The real cook supplies none while drawing (it fades its crackle in over 20 sp instead), so only Echo's lift fold-out exercises the morph path.
- #dry and #wet are drawn in separate drawCooked calls, so while a stroke is live, overlaps between a #dry poly and a #wet poly of the same colour and alpha add instead of merging. The difference is transient: before the bake, #dry holds the whole committed stroke drawn one call per region, which matches the tiles. I did not measure the e2e hand-off tolerance (≤ 2/255); that needs the integrated renderer.
- Replays reproduce rising growth exactly only for Sprout and Drift (truncation = prefix). Line and Echo replays show their final depth with no rise animation.
- Selection outlines and the doom mask trace at most 400k points per repaint.
- Performance was measured only in headless Chrome with software rendering (SwiftShader) on this machine: live.frame p95 0.8–4 ms (Drift with a 24 sp brush ~4 ms). There is no 4× CPU-throttle measurement and no reference-device numbers. The ~5 ms lift frame and the 11.7 ms spike are the commit's one-off full repaint and the sandbox's own synchronous bake.
- Small per-frame allocations remain: subarray views when a draw list changes length, per-generation lists on Paper, one object per bake. There is no per-sample or per-event allocation.

### Contract requests
- docs/contract-requests/render-live.md §1: LiveHost has no route to the overlay. Proposed: add `overlay?: Pick<OverlayInternal,'predicted'>` to LiveHost. Workaround: exported `LiveHostExt` plus `attachOverlay()`; render-world already passes the overlay. app/draft should pass only the predicted samples to `live.predict`.
- §2: Paper per-generation alpha must be applied the same way by tiles and live. Proposed: render-core adds `DrawOpts.genScale` (or a `form` argument). Workaround: exported `drawInk`, which render-world's tiles already use.
- §3: `MorphSet.t0` is documented on the performance.now clock, but the pure cook fills it with stroke-clock ms. Proposed: document it as stroke-clock and informational. Workaround: t0 is ignored; morphs start on first sight, or at commit for Echo.
- §4: document `LiveView.slot?: Int32Array` and that PolyView.index / replaces are drain ids. Workaround: content-key identity, so the layer is independent of index semantics.
- §5 (for render-core): faint dark anti-aliasing seam at welded joints between chunks of different tones on Night: 1–4 pixels at about 80–90 % coverage, R 255 → 197–227. It appears in plain drawCooked too, so tiles have it; same-tone joints and joints split across #dry/#wet are seamless.
- §6 integration notes:
- The halo's brim flash is timed by the live layer.
- One bake per stroke, after cooling; `done()` is synchronous and idempotent.
- `frame()` may run twice per rAF.
- After a context loss, call `live.resize()`.
- Diff restyles cover peel undo and depth bends.
- First-run seed: `play(..., {bake: false})` then `dissolve(ms)`.
- The returned object has extras `attachOverlay()` and `inspect()`; helpers are exported.


## review: render-live

**Tests:** 181 passed, 0 failed. **Typecheck clean:** true

I reviewed render-live (`src/render/live.ts`, `src/render/overlay.ts`) against BUILD §6, DESIGN §3.1/§3.2/§6.2/§6.6/§9 and the frozen contracts, and fixed what I found in place. Every listed export is present with its exact signature (`createLiveLayer(host)`, `createOverlay(host)`) and behaves as specified. render-world's renderer.ts still compiles against `drawInk` / `LiveHostExt`.

**What I verified**
- The η formula reaches exactly 0 at 3τ, and h/τ are correct for both grounds.
- Hot window: 120 sp in 12 sp chunks; a cold chunk is pixel-identical to the committed draw.
- Reveal times: Sprout 280 ms with each child starting at its parent's 60 %; Drift thirds reveal as one filament; Echo fold-out T = clamp(350 + 120·d).
- Un-grow and re-grow ordering; concurrency cap of 4; camera fast-forward; reduced-motion paths.
- Two-phase hand-off: `done()` clears #dry synchronously and is idempotent.
- Dirty rects: integer-snapped and capped; an idle frame draws nothing.
- Identity across gen-sorted views, both with and without slot ids.
- Edge cases: NaN and degenerate inputs, Float64 offsets far from the origin, and no leaked listeners or timers.

**Screenshots** (sandbox on port 5194, server stopped): mid-stroke, hold, lift, bake, withdraw, replay (fake and real cook), Paper hold, both overlay grounds, and 3× close-ups. Live and baked ink match. Both halos render: the live one at the nib, and the replay's synthetic one.

**Bugs fixed (`live.ts`)**
1. **Replay never finished (real bug).** When a stroke's last samples creep (steps under 0.25 sp, less than 40 ms apart), `ArcClock.mark` dropped the final mark. The trunk then stayed a hair short of fully revealed, so the replay never baked or came to rest, and the rAF loop ran forever. This would also block render-world's live-hold safety net, which only fires when `!live.animating`.
   - Fix: `mark(s, t, force)` at :325; the replay force-marks the trunk end at :1798; the trunk counts as fully drawn once the recorded stroke time has passed (:1902).
2. **Halo outlived the stroke.** A halo the caller never cleared kept drawing after lift or withdraw. Fix: `endHalo()` at :2372, called from begin, commit and withdraw.
3. **Diff restyles waited on nothing.**
   - A drain-only peel undo waited 200 ms, then ran an empty 320 ms grow before baking. A grow-only change also waited 200 ms for nothing.
   - In the generation schedule, a shared (unchanged) trunk still took the first slot, so changed growth sat idle for about a third of the duration.
   - Fix: a side with nothing of its own now skips its phase (:2624), and the schedule spans only the generations that animate (`gMin`, :2006).
4. **A tap's zero-length trunk popped in whole on re-grow** and stayed fully visible through un-grow. Fix at :2084.
5. **Hot-path allocation.** `PolyStore.push` created two `subarray` views per poly copied, and `sync()` re-copies the whole unsettled suffix every live frame. Now plain copy loops (:448).
6. **Matrix storage (defensive).** Items now copy `host.matrixFor()` into their own readonly storage (:1051, :1542, :2059), so a host that reuses a scratch matrix cannot corrupt other items.

**Overlay (`overlay.ts:228`):** outlines and the doom mask now skip whole strokes whose ink box misses the repaint clip, so a cursor move over a large selection no longer scans every poly. Pixel output is unchanged.

**Tests:** I added `tests/render-live.review.test.ts` with 15 tests: a regression test for each fix, plus hold-and-lift against the real cook for all four Forms, and degenerate strokes. I updated the builder's peel-undo test to the new bake-at-once behaviour. The real-cook tests now have 30 s timeouts: one hit the 5 s default under load from other agents on this machine, although they normally run in under 0.4 s.

### Decisions
- Of the 181 passing tests, 103 are render-live's own (the builder's 88 plus my 15), 3 are purity and the rest are render-world. Typecheck is clean under tsconfig.json and tsconfig.test.json; the project as a whole currently reports 0 errors.
- The halo belongs to the nib: begin, commit and withdraw end it even if halo(null) was never sent. A nib that is still held simply re-sends it the next frame.
- One-sided diff restyles skip the empty phase. A drain-only peel undo (the remaining ink is a subset of the pooled ink) bakes the new revision at once while the old growth drains over 200 ms. A grow-only change grows at once. This is still the spec's 'drains the pools with a 200 ms reverse growth', without an idle 520 ms before baking.
- Whole-stroke grow and un-grow schedule only the generations that animate (gMin to G). Without a mask, gMin is 0, so non-restyle behaviour is unchanged.
- A zero-length trunk piece in a whole-stroke animation shows once the spine reaches it. A stroke whose whole trunk has zero length (a tap) grows and un-grows by the trunk progress F.
- ArcClock.mark gained an optional `force` parameter (additive; existing calls are unchanged). It lands a stroke's final arc even within the 0.25 sp / 40 ms dedupe distance. If the time is unchanged it raises the last arc instead.
- sandbox/render-live/shot.mjs now reads PORT from the environment (default 5184 as before), so reviewers can use their own port.

### Gaps
- Inherited from the builder and still open: replays reproduce rising growth only for Sprout and Drift. Line and Echo replays show final depth without a rise.
- Inherited and still open: the Line live morph needs a cook MorphSet, which the real cook does not supply while drawing. Only Echo's fold-out at lift exercises the morph path.
- Inherited and still open: while a stroke is live, #dry and #wet are separate draw calls, so same-colour overlaps between them add instead of merging. This is transient, and the e2e hand-off tolerance (≤ 2/255) still needs the integrated renderer to measure.
- When the cook's view changes, sync() still re-copies the whole unsettled suffix. Because the view is gen-sorted, that is all of the growth. It no longer allocates per poly, but the copy cost is O(growth points) per changed frame. Matching growth by slot id instead would avoid the copy.
- The overlay's 16 ms prediction cap only applies when the tail carries real samples with timestamps. The bridge points live.predict prepends have no absolute time, because the draft rows store time since pen-down. Input's own 16 ms / 24 sp cap covers this.
- I did not re-measure performance; the builder's numbers stand (SwiftShader only, no 4× throttle, no reference devices). Small per-frame (not per-sample) allocations remain: list subarray views when draw-list lengths change, Paper per-generation lists, and the Batcher's per-build view in render-core.
- Additive white overlaps at Sprout generation joints on Night appear identically in live and baked ink, so they come from the cook and raster design, not from this layer.

### Contract requests
- No new contract requests. In docs/contract-requests/render-live.md §6 (integration notes, no change requested), I documented the halo lifetime and the one-sided diff-restyle behaviour for app/ and render-world.


## build: doc-persist

**Tests:** 82 passed, 0 failed. **Typecheck clean:** true

Built the complete doc-persist group. doc/ (pure): ids.ts (fixed-width base36 stroke/doc ids), commands.ts (freezeRecipe copying nested objects and typed-array views, fixed key order; patchRecipe with session-unique monotonic revs and automatic rev bumps when colour/geometry fields change; command builders; peelCommands for the add+replace peel split), document.ts (createDoc/newMeta: apply is the only stroke mutator; validates before mutating, rolls back failing batches, returns the exact inverse built from the state it actually replaced; one net DocChange per apply classified by geomRev/colorRev; FIFO delivery for re-entrant applies; monotonic counters outside history; nextId strictly increasing even if the clock goes backwards; setView outside history; frozen meta/ordered snapshots), history.ts (cap 500; stores the inverse returned by each apply so undo/redo stay exact; peekUndo/peekRedo; drops an entry that no longer applies instead of wedging), serialize.ts (.rise v1: base64 LE Float32 with a hand-written base64 since the pure layer has no btoa; schema writer that preserves -0 and non-finite scalars bit-exactly; one stroke per line; strict validation with path-specific RiseFormatError messages; sceneHash; timestamp check for rule 9), migrate.ts (ordered migrations[v] list plus runner; empty because v1 is the first format). persist/ (DOM): prefs.ts (localStorage under rise: in try/catch, in-memory fallback, type check against the fallback, no double prefix), idb.ts (database rise v1 with docs/strokes/snaps/thumbs; open timeout resolves null; reconnects once on a lost connection; closes on versionchange; explicit tx.commit; images stored as ArrayBuffer+type; optional writeBatch/syncInfo/evictSnapshots), autosave.ts (dirty-id coalescing with a one-shot 250 ms batch; one transaction per flush; flush on visibilitychange hidden, pagehide and freeze; reconciles with the store on attach; empty never-stored documents are not saved; ok/onStatus on failure including QuotaExceededError; one retry; evicts other documents' snapshots once on quota; optional snapshots on hide and at most every 10 s after 2 s idle, with a busy check and a derived 96 px thumbnail; navigator.storage.persist() once after the 10th stroke), files.ts (downloadBlob with sanitised names, pickFile with cancel detection, readFileText with gzip inflate and BOM strip, onDropFiles, gzipText, riseFilename). Verified: 82 unit tests in 7 doc-persist test files, including the 200-command property test over 3 seeds and a bit-exact round trip; the committed v1 fixture parses to golden sceneHash 0x059a1552 and re-serialises byte-identically. The headless Chrome sandbox passes 31/31 checks: write, then a reload where the last stroke is saved only by the pagehide flush, then read with an identical sceneHash, list, snapshot/thumbnail read-back, reattach writing nothing, file and gzip round trips, drop, file picker, download, quota status, connection-loss recovery, and delete.

### Decisions
- geomRev/colorRev come from one session-wide monotonic counter, not prev+1. With +1, an undo followed by a different restyle would reuse a cache key (id:geomRev, id:colorRev:ground) for new content. Recipes loaded from storage advance the counter (noteRevs/restoreRecipe). patchRecipe bumps the declared kind and also bumps colorRev or geomRev whenever the patch actually changes colour or geometry fields; undefined patch values are ignored. Consumers must not assume revs step by exactly 1.
- parseDoc assigns fresh session-unique revs instead of resetting them to 0 as DESIGN §8 says (revs are still never stored in files), so a file sharing stroke ids with an open document cannot hit stale global caches. It also assigns a fresh document id by default (optional opts {id, now, rand32}; now also sets meta.updated), because opening is always a new document. The file does not store the document id; it does store updated.
- The .rise writer is schema-aware: -0 is written as -0, non-finite values as the strings "NaN"/"Infinity"/"-Infinity" and read back, so round trips are bit-exact for scalars as well as Float32 data. Fields that must be finite (origin, z, rot, seed, s0, cut, counters, camera, created) are checked on write, so the writer never produces a file it cannot read. Layout: header line, meta line, one stroke per line in z-order; strokes keep the spec's key order.
- §7.5 rule 9: parseDoc rejects a stroke whose T column has non-finite or decreasing values. Equal T is tolerated, because Float32 rounding can only collapse, never reorder, sanitised times. Samples are never rewritten, since geometry is frozen.
- Doc.nextId bumps meta.counter and wraps the counter part to 36^4 so ids stay 13 characters. It guarantees new ids sort after every standard id the document has seen, even if the clock goes backwards. createDoc takes an optional third argument {now} (an injectable clock for ids and meta.updated).
- Doc.apply: remove ignores ids that are not present (the inverse restores only what it removed); add of an existing or duplicate id, and replace of a missing id, a mismatched pairing or a duplicate id, throw before any mutation. A failing batch is rolled back. Replaced ids whose revs are equal but whose objects differ are reported as geometry, to be safe. meta.updated advances on content changes only, not on setView. Changes triggered by a listener calling apply are queued and delivered in order; listener errors are rethrown as unhandled rejections instead of breaking the document.
- History stores the inverse returned by each apply, so redo after undo is exact for the current state. If applying an entry throws, the entry is dropped and the error rethrown. Added peekRedo/undoDepth/redoDepth (HistoryInternal).
- newMeta: title 'Untitled', Night ground, camera {0,0,1,0}, every ink counter (including custom) set to 0.
- Added helper peelCommands(r) -> [add(bare), replace(bare->risen)] for the risen-stroke peel. The recipe left in the document is `risen` (a new geomRev), so the app must register its cooked geometry under that recipe.
- Autosave decides what to write by comparing the attached document with the store on attach (optional DocStore.syncInfo), so the app never has to say where a document came from. Never-stored empty documents are not saved, so blank canvases never appear in Recent. Each flush is one transaction (optional DocStore.writeBatch). A failed batch for a document that has since been detached is retried immediately, not on a delay, so it cannot overwrite newer data if that document is reopened. After a failure exactly one retry is scheduled, then it waits for the next change (no recurring timers).
- Snapshots are optional: AutosaveInternal.setSnapshotSource(src, isBusy?) writes on hide and otherwise at most every 10 s after 2 s idle (via requestIdleCallback), deriving the 96 px thumbnail (WebP when available) through thumbFromSnapshot. storage.persist() is requested once ever, remembered in prefs key 'rise:persist-asked'.
- IndexedDB: snapshot and thumbnail images are stored as ArrayBuffer+type, not Blob (Safari compatibility). Opening times out after 4 s and resolves null. A lost connection (InvalidStateError/UnknownError) is reopened once per call. versionchange closes the connection. Write transactions call commit() explicitly so a pagehide flush reaches the backend. Malformed stroke records are skipped on load instead of failing the whole document.
- prefs keeps values in memory when localStorage is missing, throws, or a write fails, so reads stay consistent within the session. get() returns the fallback when the stored JSON is of a different kind. Keys that already start with 'rise:' (the learner's 'rise:calib:<device>') are not prefixed twice.
- readFileText inflates gzip input (magic 1f 8b) via DecompressionStream, so the P1 compressed format can already be read; gzipText is added for writing. safeFilename/riseFilename clean names for downloads.

### Gaps
- Snapshot encoding belongs to the renderer (Renderer.snapshot); autosave only schedules and stores snapshots once the app calls setSnapshotSource. If the app does not wire it, there are no cold-load snapshots or Recent thumbnails. The app should call snapshotNow() before switching documents so the thumbnail is current.
- The cold-load sequence (paint the snapshot within 300 ms, cook the viewport first) and the 12-item Recent limit are app/UI responsibilities; listDocs returns every document, newest first.
- The pagehide flush durability was verified in headless Chrome (navigation right after an edit); not verified in Safari or Firefox.
- migrations is empty because v1 is the first format; the runner is tested only with injected steps. One fixture (doc-v1.rise) exists, as required for v1.
- The persisted undo stack is P2 and not implemented.
- src/persist/idb.ts has no Node unit tests (fake-indexeddb is not available and no new dependencies are allowed); it is covered by the browser sandbox (sandbox/doc-persist/run.mjs, needs the vite server on port 5188).

### Contract requests
- (none)


## review: doc-persist

**Tests:** 93 passed, 0 failed. **Typecheck clean:** true

I reviewed the doc-persist group (BUILD.md §7) against DESIGN.md §7.2 and §8 and the frozen contracts, and fixed 9 defects in place. Every listed export exists with the signature BUILD.md gives. After the fixes: 90 doc-persist unit tests pass, plus 3/3 purity, 93/93 in total (up from 85). The browser sandbox passes 33/33, up from 31. Typecheck shows 0 errors in my files across all three tsconfigs.

**Fixes:**
1. `src/doc/commands.ts`, `freezeRecipe`: it kept the caller's typed array whenever that array covered its whole buffer. A draft buffer that gets reused and happens to be exactly full therefore ended up inside the committed recipe, and the next stroke drawn into that buffer would silently rewrite it. `freezeRecipe` now always copies samples, pools, resume and xf (one copy per stroke). `patchRecipe` still shares arrays it doesn't change but copies arrays supplied in the patch.
2. `src/doc/commands.ts`, `peelCommands`: the document now ends up holding the risen recipe `r` itself, not a rebuilt copy, so the geometry cooked from `r` can be registered for it directly. The bare stroke shares `r`'s samples and gets a fresh geomRev, so the two never share a cache key.
3. `src/doc/document.ts`, `nextId`: if the clock returned Infinity, the id became non-standard, the next call read its time as NaN, and the loop `++ms` never ended. The time is now clamped to the 9-digit range and needs at most one bump.
4. `src/doc/document.ts`: renaming to the current title now returns an empty inverse. `src/doc/history.ts`: `push`, `undo` and `redo` no longer record empty commands (an eraser pass that hit nothing, a same-name rename), so Undo never wastes a press and the redo stack is kept. A NaN cap now falls back to 500.
5. `src/doc/serialize.ts`, writer: it claimed to write only what it can read back, but it accepted values the reader rejects (`z <= 0`, a fractional or zero `form.v`, `cut` outside 0..3, sample times that are NaN or go backwards, unknown enum values, custom ink without colours, non-base36 or duplicate ids, a fractional counter, camera scale 0). Such a save produced a file that could never be opened. The writer now applies exactly the reader's checks and fails with "cannot save: ...".
6. `src/doc/serialize.ts`, `sceneHash`: NaN scalars are now hashed as one fixed bit pattern. Engines can store different NaN encodings, while the file writer stores "NaN", so a file round trip could change the hash. The golden fixture hash 0x059a1552 is unchanged.
7. `src/persist/idb.ts`, `loadDoc`: revs saved by an earlier session were reused, and they could equal a rev this session had already issued for the same stroke with different content (for example after opening a `.rise` export of the same drawing and restyling it). Loading now assigns one fresh rev, as `parseDoc` already does.
8. `src/persist/idb.ts`, `conn()`: callers that hit a lost connection at the same time each opened their own connection, and all but one leaked. They now share a single reopen.
9. `src/persist/autosave.ts`, `write()`: for a store without `writeBatch`, the put, delete and meta steps of two overlapping saves could interleave, so an older delete could land after a newer put and lose the stroke. Those saves now run one after another.

**Tests added:**
- Draft-buffer aliasing, and patch arrays being copied.
- `nextId` with an Infinity, NaN or far-future clock.
- Empty inverse for a same-title rename.
- No-op entries not recorded in history, the NaN cap, and the new peel behaviour.
- The writer refusing 19 invalid inputs.
- NaN encodings hashing alike.
- The overlapping-save ordering case. With the fix reverted this test fails, and passes with it.

**Sandbox:** I made the runner's port configurable (`PORT`, default 5188) and added two checks: loaded strokes get one fresh rev, and three simultaneous calls after a lost connection make exactly one `open()`. I ran it on port 5198 and looked at the screenshot: the stored snapshot and the 96x60 WebP thumbnail render correctly. The dev server is stopped and the port is free.

### Decisions
- freezeRecipe always copies its typed arrays instead of keeping a whole-buffer array as is: it is never safe to assume the caller won't reuse the buffer, and one copy per stroke fits the allocation rule. restoreRecipe (used for parse and IndexedDB loads) still keeps freshly decoded or cloned arrays. patchRecipe shares the arrays it doesn't change and copies arrays supplied in the patch.
- peelCommands returns [add(bare), replace([bare],[r])], so the document ends up holding the caller's recipe r, the same object cook.finish(r) was cooked from. bare gets a fresh geomRev (it previously had 0 and the risen copy got the new rev). This is a change to the builder's helper; it is not a BUILD.md export.
- Revs stored in IndexedDB are ignored on load: every load assigns one fresh rev, consistent with parseDoc. The builder's choice to give opened files fresh revs instead of resetting them to 0 (as DESIGN §8 says) is kept; it is safer for cache keys. Records still store the revs, so the database schema is unchanged.
- History does not record empty inverses, and a push of an empty inverse keeps the redo stack. Doc.apply returns {k:'meta',patch:{}} when the title doesn't change. Both are exact: applying them changes nothing.
- The writer applies exactly the reader's checks and fails with 'cannot save: <path> ...' rather than writing an unopenable file. The reader stays strict.
- sceneHash hashes every NaN scalar as one fixed bit pattern. Typed-array columns are still hashed raw, because files and IndexedDB keep their bits exactly.
- Stores without writeBatch run their saves one after another. The writeBatch path is unchanged, since one transaction per save is already ordered by IndexedDB.
- sandbox/doc-persist/run.mjs reads PORT (default 5188), so it can run on my assigned port 5198.

### Gaps
- src/persist/idb.ts still has no Node unit tests: fake-indexeddb isn't installed and new dependencies aren't allowed. It is covered only by the browser sandbox, now 33 checks including the two new IndexedDB checks.
- pickFile: if input.click() is blocked because there was no user gesture, the promise stays pending and the hidden input stays in the page until the window next gets focus. The app must call it from a user gesture.
- Rare race: draw on a new document, undo, and force an immediate save while the first metadata write is still in flight. The saved record can then show 1 stroke when 0 are stored. Only an immediate flush (page hide or flush()) can trigger it. Not fixed.
- Ids that aren't in the standard 13-character form can only come from hand-made files. New strokes can sort below such strokes in z-order; nextId only guarantees ordering after standard ids.
- One malformed stroke in a .rise file still rejects the whole file. This is strict by design; the writer now refuses to produce such files, but files from other sources are not salvaged.
- Carried over from the builder: snapshot encoding is the renderer's job, so the app must call setSnapshotSource and snapshotNow before switching documents. The cold-load sequence and the 12-item Recent limit are app/UI work. Flushing on pagehide is verified only in headless Chrome. The persisted undo stack (P2) is not implemented. migrations is empty because v1 is the first format.

### Contract requests
- (none)


## build: scene-sched

**Tests:** 89 passed, 0 failed. **Typecheck clean:** true

Built scene-sched per BUILD.md §8. Every listed export is there with its exact signature: JobPrio, Jobs, createJobs, FrameLoop, createFrameLoop, createScene, Occupancy, createOccupancy and RTree. My 89 tests pass, as does the shared purity test, and my files typecheck cleanly under all three configs.

**What each piece does**
- **sched/jobs.ts:** the job queue. The highest priority always runs first, first-in-first-out within a priority. Jobs can be iterators or step functions. A repeated key replaces the queued job, and cancelling closes an iterator properly. It stops once the budget is spent, but always runs at least one step. The clock is injectable, and the module has no DOM so the pure scene layer can import it.
- **sched/frame.ts:** the single on-demand rAF loop. It schedules frames only on request() or while a participant returns true. Each participant gets a budget of clamp(0.45 × frame interval − time already used this frame, 1, 6) ms. The frame interval is the median of the last 15 back-to-back frames; idle gaps and hidden-tab stalls are ignored. One throwing participant cannot kill the loop. Optional additions: a fake environment for tests, and attachJobs(loop, jobs) to wire the queue in last.
- **scene/rtree.ts:** a standard R-tree (quadratic split, at most 9 per node), with item-to-entry lookup so removal needs no box. Also has bounds() and a validate() self-check for tests.
- **scene/occupancy.ts:** the crowding grid. A stroke at zoom z belongs to the level whose cell is about 8 sp and counts in the two levels either side. Capsules use width 0.7·S/z, with end caps so taps register. Cell values are exact integers, so removing a stroke restores the grid exactly and results never depend on insertion order. Queries weight cells smoothly, so crowding doesn't jump at cell edges. c and CS follow DESIGN §2.3.9.
  - **Lazy building:** cells are only computed for 32×32-cell blocks when a query reaches them, or ahead of time by a background job around the camera. A lazily built block holds bit-for-bit the same values as an eagerly maintained one; tests check this, including random interleavings.
- **scene/query.ts:**
  - **Hit:** the spine capsule first, then cooked polys with alpha ≥ minAlpha.
  - **Lasso:** at least 50% of spine stations inside.
  - **Also:** eraser-segment tests, the nearest-poly pick for Alt-click sampling, the conservative box for uncooked strokes, and lift times for lineage.
  - **Spine source:** these use the injected spineOf when provided, otherwise raw samples.
- **scene/kitchen.ts:** the cook queue. One job per stroke runs the injected CookFn; ink/cook.ts is never imported. Priorities map onto the scheduler's (handoff, visible, prefetch, background). A repeat request shares the promise and can raise priority. A newer revision or cancel() rejects with CookCancelled.
- **scene/scene.ts:** subscribes to the Doc and keeps three things in step with it on every add, remove, geometry change and colour change:
  - **R-tree:** indexes the cooked inkBox, or the conservative box until cooked.
  - **Occupancy:** follows every add, remove and replace.
  - **Cooked cache:** an LRU capped in bytes; a geometry change makes the new revision miss until it is cooked.

  It also provides query (z-ordered), hit, sweep, lasso, lineage, contentBox, ensure, put and the crowding queries.

**Performance at the supported size** (2,000 strokes × 300 samples, desktop, JIT warm):
- Scene load: 75–125 ms. Before the occupancy grid became lazy, it was 759 ms and created about 1M cells.
- Background warm job: 83 ms in 13 slices.
- First crowding read at pen-down in an unwarmed area: 0.2–1.7 ms at zoom ≥ 1, 8 ms at zoom 0.5.
- Crowding + side crowding once built: 11–20 µs.
- query: 14 µs. hit: about 90 µs.
- Committing or erasing one stroke: about 1.3 ms.
- Grid size after warm: 31k cells.

**Browser check:** a sandbox page in real Chrome measured a 16.7 ms frame interval and a 6 ms job budget with at most 0.4 ms overrun. It drained 300 jobs and made zero rAF calls once idle.

### Decisions
- Jobs: the highest priority always runs first, first-in-first-out within a priority. Adding with a key that is already queued replaces the earlier job. A positive budget always runs at least one step; a budget of 0 runs nothing. A throwing job is removed and the error rethrown, unless an onError callback is given. A cancelled iterator is closed with return(). Calling run() from inside a job does nothing.
- Frame loop: every participant gets the same budget formula, clamp(0.45 × frame interval − time already used this frame, 1, 6) ms. That is DESIGN §9 step 6: the live work, ordered early, gets the full slice, and jobs, ordered last, get what is left. The frame interval is the median of the last 15 back-to-back frames between 2 and 100 ms (16.67 ms until measured). Participants receive the rAF timestamp. A participant that throws keeps the loop alive for at most 3 frames in a row.
- Occupancy: the level is round(log2(8/z)), computed exactly with no logarithms. The capsule width is 0.7·S/z. I added the capsule end caps (π w²/4 in total) so a tap still counts, and split wide capsules into lanes across their width so a fat brush covers its real width when read from a deeper zoom.
- Occupancy values are stored as fixed-point integers (1/65536 of a cell's area). Removing a stroke restores the grid exactly to zero, and values never depend on the order strokes were added. Only exact operations feed the grid, so the C/CS values frozen into samples are reproducible across engines.
- Occupancy cells are computed lazily, per 32×32-cell block per level. A query builds the blocks it touches. The scene also schedules a background job for the 2,048 sp square around the camera centre, on creation and whenever the doc reports a view change or new strokes. The DESIGN text says strokes are splatted on add and on load; the values are bit-identical either way (tested).
- Crowding queries weight each cell by how much of it falls inside the disc, so c changes smoothly as the nib moves. c16 (for CS) applies the same smoothstep(0.02, 0.35, ·) to a 16 sp disc. Both queries read only the reader's own level, as the spec says.
- Hit: returns the topmost stroke (largest id) whose spine capsule, or any cooked poly with alpha ≥ minAlpha, comes within r. The alpha tested is Cooked.alpha without the ink's alphaMax, so hit results don't change when the ground flips. sweep uses the same 0.3 rule. Chisel polys are tested as capsules of half their edge length, which is slightly generous. pick() returns the poly whose outline is nearest, for Alt-click sampling.
- Lasso: even-odd point-in-polygon on spine stations (raw samples if no spine is available), selected at ≥ 50%, stopping early once the answer is certain. Results are in z-order.
- Lineage: the proximity test runs first and picks the nearest same-ink spine within max(6 sp, 3w); ties go to the topmost stroke. Only if that fails does the recency test run: the last same-ink stroke by lift time, lifted under 3 s ago, with its spine within 48 sp. Lift time = created + t of the last sample. The custom ink matches any custom ink.
- Cooked LRU: keyed by id and geomRev, but each entry is also checked against every geometry input of the recipe. So two different restyles that reach the same geomRev (A→B, undo, A→C) can never share geometry. Older revisions and removed strokes stay cached until evicted; cooked(id) for a removed stroke returns the revision that was current at removal, which covers the un-grow animation and makes undo instant. An evicted stroke keeps its exact inkBox in the index.
- The default cache cap is the desktop 192 MB. The app should pass the device-class cap through the new optional cacheBytes field.
- Doc changes are handled by reconciling each mentioned id against the doc's current state, so batches and inconsistent change lists cannot desynchronise the scene.
- Scene.query clears `out` and sorts by id (z-order). RTree.search appends to `out` without clearing it.
- contentBox() is the R-tree's bounds, so strokes not yet cooked contribute their conservative box: it never crops ink but can be loose until cooking finishes.
- The scene never cooks on its own when strokes are added; callers use ensure() or put(). A cook that throws is not retried for the same geometry, which prevents an endless retry loop.
- put(id, c) attaches to the recipe the doc currently holds under that id; if the stroke isn't in the doc yet, it waits (up to 16) for the next add. putFor(r, c) attaches to exactly r.
- The kitchen runs one job per stroke, each step being one complete cook (the CookFn is synchronous). The base promise is pre-handled, so a cancellation nobody awaited doesn't surface as an unhandled rejection.

### Gaps
- The kitchen time-slices between cooks, not inside one, because the injected CookFn is synchronous. One very large cook can overrun the frame's job budget. Splitting a single cook would need the incremental cook to be injected as well.
- A single occupancy block build can't be split either. In the 2,000-stroke benchmark the largest warm slice was 8.6 ms against the 6 ms budget. Cold reads far from the warmed area cost 0.2–8 ms on the first sample of a stroke; on phones expect roughly 3–5× that.
- The hit-test alpha excludes the ink's alphaMax (0.85 on Paper), because the scene doesn't know the ground. Exact ground-dependent hit testing would need the app to pass a scaled minAlpha.
- Lineage measures sp at the candidate stroke's zoom, not the new stroke's (contract request #1).
- The scene is pure and can't detect the device class, so the app must pass COOKED_CAP_BYTES[deviceClass()] as cacheBytes; otherwise the desktop 192 MB cap applies.
- Nothing is integrated yet against the real ink-forms cook/spineOf or the real doc-persist Doc. All tests use a fake CookFn, a fake spineOf and a FakeDoc written to the core contract. ink-forms' spineOf is cached per recipe object, so a colour-only restyle (a new object) may rebuild a spine on its first hit test.
- Not in P0 and not implemented: the cook Worker (P1), Sprout collision (P1), enclosure (P2) and Drift combing along ink (P1).

### Contract requests
- docs/contract-requests/scene-sched.md #1: lineage needs the new stroke's zoom to convert 6 sp and 48 sp to doc units. Proposal: lineage(x, y, ink, wDoc, now, z?). Workaround: use the candidate stroke's zoom.
- #2: specify that created = Date.now() at pen-down and that lineage(now) takes Date.now(). Workaround: lift time = created + t of the last sample, with a tolerance of −60 s < age < 3 s.
- #3: put(id, c) is ambiguous during the two-step commit of a risen stroke (add at base depth, then replace with pools). Proposal: add putFor(r, c) to Scene (already implemented), or require put to be called after both doc.apply calls.
- #4: the renderer needs the before geometry when a restyle morphs. Proposal: add cookedFor(r) to Scene (already implemented).
- #5 (FYI, additive only): the optional cacheBytes field on createScene, COOKED_CAP_BYTES, and SceneImpl.charge(c, bytes) for counting render's decimated LODs against their cache entry (DESIGN §6.8). Also SceneImpl.pick, createFrameLoop(env?) and attachJobs.


## review: scene-sched

**Tests:** 102 passed, 1 failed. **Typecheck clean:** true

I reviewed scene-sched (BUILD.md §8) and fixed five bugs in place, three of them confirmed with probes first. All 100 group tests pass (97 before plus 3 new test cases, and 3 existing tests extended), and my files typecheck cleanly. Out of 103 tests in the run, one fails: the shared purity test trips on another group's in-progress file.

**What I checked:** every listed export (JobPrio, Jobs, createJobs, FrameLoop, createFrameLoop, createScene, Occupancy, createOccupancy, RTree) exists with its exact signature. The formulas and constants match DESIGN §2.3.9, §2.4.2, §3.4, §6.8 and §9:
- occupancy level round(log2(8/z)), counting in levels ±2;
- capsule width 0.7·S/z;
- c = smoothstep(0.02, 0.35, cov over 48 sp);
- CS = c16(p + 24n) − c16(p − 24n);
- hit: spine capsule first, then polys with alpha ≥ 0.3;
- lasso: at least 50% of spine stations inside;
- lineage: max(6 sp, 3w), and under 3 s within 48 sp;
- LRU caps 48 / 96 / 192 MB;
- job budget clamp(0.45·frame interval − time already used, 1, 6) ms;
- no requestAnimationFrame calls when idle.

I also checked the occupancy claims (removal returns the grid exactly to zero; lazily built blocks equal eagerly maintained ones bit for bit), for per-sample allocation in hot paths (none), and for leaked listeners or timers (none).

**Fixed:**
1. **R-tree crash.** Inserting a NaN box into a tree with more than one level crashed in place() (TypeError, confirmed). It now falls back to the first child, so a NaN entry is harmless and never found. src/scene/rtree.ts:150.
2. **Occupancy hang.** A sample row with ±Infinity made one chord loop forever and froze the tab (confirmed). Now:
   - non-finite rows are skipped and a box with a non-finite origin is rejected (occupancy.ts:347, 355, 384, 391);
   - pieces per chord are capped at 4096 (:286);
   - `touches` answers yes for very large block ranges, which gives the same result (:311);
   - reader zoom is clamped to the range where levels are exact (:149, 529–555), so a tiny z can't scan billions of cells;
   - the coverage radius (:544) and the warm area (:484–487) are capped.
3. **Kitchen returned the wrong geometry.** When a different recipe arrived with the same geomRev (the A→B, undo, A→C case), cook() handed back the old promise, which resolved with B's geometry (confirmed). It now shares a queued cook only when the geometry is identical. kitchen.ts:137. `sameGeometry` moved into kitchen.ts and scene.ts re-exports it, so its export is unchanged.
4. **Hits missed past the tapered ends.** Cooked strokes were indexed by inkBox only, but the hit rule uses the untapered spine capsule, which the contract's hitBox covers. Hit, sweep and lineage missed points just beyond tapered ends. The index is now inkBox ∪ hitBox. scene.ts:230–251.
5. **Bad boxes and zero zoom.**
   - A recipe with non-finite coordinates is now kept but never put in the index; boxOf returns null for it (scene.ts:250, 548).
   - nominalWidth returned Infinity when z = 0, so every point counted as a hit. It now returns 0 (query.ts:21).

**Tests added:**
- a NaN box in the R-tree;
- four occupancy tests: Infinity/NaN rows, a non-finite origin, an absurd jump between samples, and extreme zooms and radii;
- the kitchen same-geomRev case;
- three scene tests: a hit past the tapered end, a corrupt recipe, and lineage ties going to the topmost stroke (custom ink matches custom);
- a frame-loop participant removing itself mid-frame;
- a randomized model test of the jobs queue against a simple reference implementation (20 trials of 600 random adds, keyed replaces, cancels and runs);
- nominalWidth with z = 0 or NaN, added to an existing test.

**Browser check (port 5197):**
- The frame loop measured a 16.7 ms frame interval and a 6 ms job budget, overran by at most 0.3 ms, drained all 300 jobs and made zero rAF calls once idle.
- I added a sandbox page that draws the crowding heat map, CS arrows, hit probes and a lasso, and looked at the screenshot:
  - Hatching and the fat brush saturate.
  - A stroke drawn at z = 0.125 correctly adds no crowding for a z = 1 reader.
  - CS arrows point toward neighbouring ink.
  - All 10 hit probes and the lasso match hand calculation.

**Benchmark** (2,000 strokes × 300 samples, noisy shared machine): scene load 130–260 ms, background warm job about 100 ms, crowding 23–45 µs, committing or erasing one stroke 1–5 ms. Each warm step builds exactly one block, so a slice overruns the budget by at most one block build, about 1–2 ms when the machine is quiet.

The dev server is stopped.

### Decisions
- Test counts: all 100 tests in the 7 scene-sched files pass. The single failure is the shared purity test 'pure layers never touch the DOM', which flags 'window' in src/ink/operators/types.ts. That file belongs to ink-forms and is being written in parallel. scene/ and sched/ pass all three purity checks.
- R-tree: a NaN box is accepted but is never returned by a search; it never corrupts the tree. Boxes with Infinity coordinates already worked.
- Occupancy: non-finite sample rows are skipped as if absent, and a recipe with a non-finite origin is tracked but never touches the grid. Readers' z is clamped to [8/2^20, 8·2^20], the range where levels are exact. coverage() caps its radius at 512 sp, and build/warm cover at most 32 blocks either side of the centre. A chord is cut into at most 4096 pieces (real strokes need a few dozen). touches() answers yes for more than 256 blocks, which is always safe. Eager and lazy building use the same caps, so the bit-for-bit equivalence and exact removal still hold (the existing equivalence tests pass). At realistic zooms the values are bitwise unchanged.
- The kitchen shares a queued cook only when the geometry is identical (old.r === r, or the same geomRev and sameGeometry). A colour-only twin still shares the promise. sameGeometry now lives in kitchen.ts, and scene.ts re-exports it, so its import path is unchanged.
- The scene indexes cooked strokes under inkBox ∪ hitBox, because the contract's hitBox includes the untapered spine that the hit rule tests. query() and contentBox() can therefore return a marginally larger set, which is safe. boxOf documents this and returns null for strokes that cannot be indexed.
- I kept the builder's choices that I judged reasonable: lineage measures 6 sp and 48 sp at the candidate stroke's zoom (contract request #1); hit alpha is Cooked.alpha without the ground's alphaMax, matching the contract's hitBox definition; kitchen slices fall between cooks.
- The sandbox check.mjs now reads PORT from the environment (default 5187). I ran it on my assigned port 5197.

### Gaps
- A single occupancy block build cannot be split. The warm job already yields after each block, so a slice overruns its budget by at most one block build: about 1–2 ms on desktop when the machine is quiet, and roughly 3–5× that on phones. CellMap rehashes can add a rare spike of a few ms.
- The kitchen slices between cooks only, because the injected CookFn is synchronous. One very large cook can overrun the frame's job budget.
- Lineage converts sp to doc units at the candidate stroke's zoom, not the new stroke's (contract request #1).
- Hit-test alpha leaves out the ground's alphaMax (0.85 on Paper), by the same reading as the contract's hitBox.
- Auto-split self-crowding is not handled in the scene (contract request #6).
- put(id, c) still binds to whatever recipe the doc holds under that id. The app should use putFor(r, c), or call put after both doc.apply calls of the commit (contract request #3).
- Nothing has been tested against the real ink-forms cook/spineOf or the real doc-persist Doc yet. All tests use fakes written to the core contract.
- Not implemented, as in the builder's report: the P1 cook Worker, Sprout collision, Drift combing along ink, and the P2 enclosure.

### Contract requests
- docs/contract-requests/scene-sched.md #6 (new, FYI for app/draft): after an auto-split, the continuation sees its committed predecessor in the occupancy grid, which breaks 'a stroke never sees itself' at the seam. The effect is negligible for thin nibs and about c = 0.4 for 40 sp brushes. Two options: the draft adjusts its C/CS policy near the seam, or the scene adds a crowdingExcept(x, y, z, ids) read.
- The builder's requests #1–#5 are unchanged: lineage needs the new stroke's z; specify the clock for created/now; ambiguity of put() during the two-step commit (the scene provides putFor); cookedFor(r) for restyle morphs; additive extras (cacheBytes, charge, pick, createFrameLoop(env), attachJobs).


## build: input

**Tests:** 142 passed, 0 failed. **Typecheck clean:** true

Built the input group (src/input/{pointer,devices,arbiter,gestures,wheel,keys,index}.ts) to BUILD.md §9 and DESIGN §5, against the frozen src/input/types.ts.

What it covers:
- **Arbiter** (arbiter.ts): a state machine with no DOM code (idle → draw | erase | lasso | navigate | sample | chipDrag, plus 'pending'). index.ts feeds it pointer records and sample batches; timers and the clock are injected, so all of §5 runs under vitest.
- **Mouse / desktop pen:** left draws, or erases in erase mode (mode() read at pointerdown). Mod-click selects, Mod-drag lassos, Shift adds (Mod = ⌘ on mac, else Ctrl; mac Ctrl+click is treated as a right click). Alt-click samples. Right-drag and pen barrel-drag (buttons & 2) erase after ≥ 4 sp; a bare right-click does nothing. The eraser end (buttons & 32 / button 5) erases at once. Middle-drag and Space-drag pan. The camera is locked during strokes and lassos.
- **Touch, no pen seen:** one finger draws at once. A second finger within 150 ms (first finger < 20 px travel) withdraws the stroke and starts pan/pinch with the 4 % dead zone; later second fingers are ignored. Taps are classified at release by max simultaneous contacts: 2-finger tap undoes, 3-finger does nothing. Double-tap selects and double-tap-drag lassos.
- **Pen mode:** turned on by the first pen event, remembered in localStorage 'rise:penmode', expires 30 min after the last pen event; disablePenMode lasts until the next pen event. Palms are ignored (radius > 20 sp, touches that begin while the pen hovers, while it is down, and for 300 ms after it lifts). Fingers never draw: a tap selects, a 350 ms hold then drag lassos, > 12 sp within 250 ms pans (only with no pen contact or hover in the last 500 ms). Two fingers pinch only once both have moved.
- **pointercancel:** pen and mouse commit; touch withdraws inside 150 ms and commits after.
- **Samples** (pointer.ts): coalesced via getCoalescedEvents (falls back to the event when the list is missing or empty). Timestamps are sanitised so they strictly increase. Predicted samples come from getPredictedEvents, else a least-squares line fit through the last 3 samples, capped at 16 ms / 24 sp and never stored. Tilt is converted to altitude/azimuth. Samples are pooled and the arrays handed out are cached per length, so nothing is allocated per event.
- **Wheel** (wheel.ts): bursts are classified on their first event with a 400 ms gap (notch ×1.15 at the cursor, ctrl pinch ×exp(−Δy·0.012), trackpad scroll pans). navEnd('wheel') fires 400 ms after the last event using one-shot timers only.
- **Keys** (keys.ts): mapped by e.code, with '?' matched by e.key. Single keys are ignored while keysBlocked() or in text fields; Mod chords stay live except in text fields. Auto-repeat only for steps and undo/redo.
- **Also:** contextmenu and Safari gesture* are prevented (and Safari trackpad pinch zooms when no touch pointers are down), middle-click autoscroll is prevented, touch-action is set to none, hover is reported for pen and mouse, and contact(true/false) drives chrome hiding.

Two bugs found and fixed while testing:
- Browsers send one pointermove per finger, so between the two events of one frame the finger distance is briefly wrong. A fast two-finger pan could trip the 4 % dead zone and zoom by accident. Zoom now starts only when two updates in a row exceed it in the same direction (unit-tested).
- In pen mode, lifting one finger of a pinch, or a brief second touch during a finger pan, used to kill the pan. The remaining finger now keeps panning, and navEnd still reports 'pinch' if any zoom happened.

Measured in Chrome with a no-op sink (alloc.mjs, ~5000 pointermoves): handler p50 0.1 ms, p99 0.2 ms, max 0.5 ms (budget ≤ 0.3 ms). Sampled allocation from src/input frames was 0 bytes in one run and 360 bytes in another. The 360 bytes came from one-off pool growth and readOne, which runs only on down/up/hover; per event it is effectively nothing.

### Decisions
- Touch-only double-tap: the first tap starts an ordinary stroke (radial seed) at once, and its strokeEnd is held back for a 300 ms window. A second tap within 24 px withdraws it (un-grow, no history) and selects. Anything else commits it first: a far contact, a key, wheel, a pen contact, page hide/blur, or a press on the chrome (window capture-phase pointerdown listener). contact(false) fires at the real lift. 300 ms / 24 px are my values; the spec gives none.
- A double-tap followed by a hold with no drag commits the first tap and does nothing else. If a second finger joins during the double-tap, the first tap is committed and the gesture becomes a normal two-finger one (so a 2-finger tap still undoes the right thing).
- contact(true) is sent only for contacts that draw, erase, lasso or navigate. Clicks never hide the chrome (Mod-click, Alt-click, finger taps, bare right-click), so selection feedback isn't delayed by the 700 ms chrome return. Once a two-finger gesture includes a counted contact, both fingers count.
- Palm rules (radius > 20 sp, pen hovering, pen down, 300 ms after lift) apply only in pen mode, since that is the section they appear in. A pen hover also cancels any pending finger tap, so a palm under a hovering pen can't select.
- A stale pen hover expires after 500 ms without hover events, so a lost pointerleave can't block touches forever. A hover sample after a lost pen pointerup counts as the lift.
- A pen touching down while a finger stroke is live withdraws that stroke (it is almost always the palm that landed first on the first pen use) and ends every finger gesture: all touches yield to the pen.
- The both-moved pinch rule applies in pen mode only (it is a palm guard). In touch-only mode a pinch starts once either finger passes the 10 px tap slop, which keeps anchored one-finger pinches working.
- Zoom engages after two updates in a row past the 4 % dead zone in the same direction; the dead-zone edge becomes the zoom reference, so there is no jump. This removes false zooms from the half-updated state between the two fingers' events in one frame.
- navEnd reports 'pinch' only if zoom engaged at some point in the navigation; a two-finger pan without zoom ends as 'drag', so it never snaps to a zoom detent. In pen mode the finger left after a pinch keeps panning; in touch-only mode it rests, and a finger that rejoins it starts a new pinch (re-grip).
- Pan gestures (pen-mode finger, two-finger) pan by the whole movement since the gesture began, so the canvas stays under the fingers.
- Travel thresholds (4 sp right-drag, 20 px withdraw, 10 px tap) use the maximum distance from the down point, so jitter in place never counts as travel.
- Mod-click, Mod-drag and Alt-drag use the same 4 sp drag threshold as right-drag. Alt-drag does nothing (duplicate is P1). Pen barrel uses the same ≥ 4 sp rule, so a barrel click (often a right-click on Windows) does nothing.
- Wheel: whether a burst is a mouse notch or a trackpad is decided by its first event (400 ms gap). Inside a trackpad burst, each event is pinch if ctrlKey is set and scroll otherwise, so a pinch right after a scroll still zooms. Ctrl+mouse-wheel stays a notch (×1.15, never the pinch curve). deltaMode 2 (pages) counts as a notch. Shift+notch pans horizontally. Pinch factor is clamped to [0.25, 4] per event.
- Keys: single-key shortcuts need no Ctrl/⌘/Alt, and Mod chords need no Alt, so AltGr characters never trigger them. '?' (by e.key) also works with AltGr. Shift is ignored for [ ] - = (so '+' deepens), Delete/Backspace and Escape. Numpad +/− also set depth. Ctrl+Y redoes on every platform. P1 bindings return null. Auto-repeat only for size, depth, nib, ink and undo/redo.
- Space only becomes the pan modifier when focus isn't on a button, field or radio, so Space still activates focused controls. Space-drag keeps panning until the pointer lifts even if Space is released. Blur and page hide release Space.
- Lift sample: appended only if it moved ≥ 1 px from the last move. A pen's zero lift pressure is replaced by the last pressure (otherwise it would fake a ramp-down), and its time is forced past the last sample.
- Lost pointerup: a mouse moving with buttons = 0 counts as released; a pen needs buttons = 0 and zero pressure. A repeated pointerdown on a still-tracked pointer finishes the old contact as cancelled. Losing our own pointer capture counts as a cancel; a child losing implicit capture does not.
- Down samples join the stroke timestamp clock only if that contact could become the stroke (arb.mayStroke), so a palm landing mid-stroke can't squash the next coalesced pen samples into 0.25 ms steps.
- Coalesced samples reach the sink in chunks of at most 64, which keeps the per-length array cache bounded after a main-thread stall. Prediction is attached to the last chunk only.
- Touch sample r is the mean contact radius ((w + h) / 4); the palm test uses max(w, h) / 2. Mouse and touch pressure is NaN (synthesised at cook time); pen pressure is raw, clamped to [0, 1].
- Safari trackpad pinch (gesturechange scale) zooms only when no touch pointers are down (iOS also reports touch pinches as pointers) and no ctrl-wheel pinch arrived in the last 250 ms. All gesture phases are passed through so the cumulative scale stays consistent.
- 'chipDrag' is in the ArbiterState type but never entered: chips live in #chrome, outside the input target.

### Gaps
- P1 items not built: view rotation (Alt+wheel in 15° steps, two-finger twist, Safari gesturechange rotate, snapping), touch inertia, Mod-drag move, Alt-drag duplicate, Digit5 / Mod+D / M / arrows / Mod+Shift+E. Finger-radius pressure is P1 too; the radius is recorded in InputSample.r.
- Verified only in headless Chrome through CDP (pen pressure and tilt, mouse, multi-touch, wheel, keys). The eraser end is tested with synthetic PointerEvents because CDP can't send buttons = 32. Not tested on real Safari/iPad Pencil, Surface/Wacom, or Firefox; the Safari gesture-event zoom path has unit tests only.
- The first-finger-pan toast and AppState.penMode need app/ to use the InputControllerEx hooks until contract request #1 is resolved.
- Labels from navigator.keyboard.getLayoutMap() are the help sheet's job (ui), not input's.
- To run the sandbox: start `npx vite --config sandbox/input/vite.config.mjs --port 5185 --strictPort` (HMR is off so edits to shared modules can't reload the page mid-run), then `node sandbox/input/drive.mjs` (39 checks plus a screenshot) and `node sandbox/input/alloc.mjs` (handler time and allocation). The server is stopped now.

### Contract requests
- docs/contract-requests/input.md #1: InputController should get onPenMode(fn) and onFingerPan(fn) so AppState.penMode and the first-finger-pan toast can be wired. Workaround: createInput returns InputControllerEx (exported from src/input/index.ts), a superset that adds exactly these two plus `state`.
- docs/contract-requests/input.md #2: document that a touch-only tap's strokeEnd arrives up to 300 ms after contact(false) (double-tap window). app/draft.ts should stop stepping rise at contact(false) and use that as t_up. Alternative: add a strokeLift() sink method.
- docs/contract-requests/input.md #3: document select(x, y, add). Pen-mode taps and touch double-taps pass add=true ('tap more ink adds'). The app should deselect on a miss regardless of add. Lassos from touch and pen mode pass add=false.
- docs/contract-requests/input.md #4/#5: document that the strokeBegin sample and the hover object are reused (copy what you keep) and that KeyActions are frozen shared constants. Reword the contact() doc to 'drawing, erasing, lasso or navigation contact'.


## review: input

**Tests:** 161 passed, 0 failed. **Typecheck clean:** true

I reviewed the input group (BUILD §9, DESIGN §5, §2.2.2, §3.4) against the frozen src/input/types.ts and fixed seven real defects in place. Results: 161/161 input tests pass (was 142), my files typecheck cleanly, and the sandbox driver passes 42/42 on port 5195.

**Checked and correct as built:**
- All listed exports exist with the exact signatures. `createInput` returns a superset of `InputController`.
- The timestamp sanitiser formula, coalesced events with the `?? [e]` fallback, and prediction (`getPredictedEvents`, else a 3-sample line fit, capped at 16 ms / 24 sp, never stored).
- Tilt converted to altitude/azimuth per the Pointer Events spec; pen pressure clamped; mouse and touch pressure NaN.
- Wheel bursts (400 ms gap, notch rule, ×1.15, exp(−Δy·0.012)) and the key map (every P0 binding by `e.code`, `?` by `e.key`).
- Tap rules (250 ms, 10 px, classified by max simultaneous contacts), the 150 ms / 20 px withdraw, the 4 % dead zone, pen-mode palm rules, 350 ms hold-lasso and > 12 sp in 250 ms finger pan.
- No allocation per event: handler p50 ≈ 0 ms, p99 0.2 ms, max 0.3 ms. The only allocation sampled was 144 bytes, from arming the pen-expiry timer once.
- Listeners are removed on dispose; import direction is clean (purity test passes for input).

**Fixed (src/input/arbiter.ts unless noted):**
1. **Resting palm blocked finger taps (`yieldTouches`, lines 873–910).** Touches that were down when the pen landed stayed in the tap session. While a palm rested, finger taps never selected and the palm could join a two-finger gesture. They now leave the session; the session and its two-finger flag are reset.
2. **Pen barrel erased in the air (lines 291–295, `land` at 821).** Pressing the barrel while hovering fires `pointerdown`, so 4 sp of hover motion started an erase. Travel now counts only from where the tip lands, and that landing sample is the stroke's first sample.
3. **Barrel erase kept going after the tip lifted (line 322, `liftBarrel` at 845).** Lifting the tip with the barrel still held is only a `pointermove`, so the erase swept through the air until the barrel was released. The erase now commits at the lift, and landing again starts a new one.
4. **Pen-mode expiry was only noticed lazily (`armPenExpiry` / `onPenExpiry` at 797–806, new `dispose` at 264; index.ts:318).** `onPenMode(false)` and `AppState.penMode` (used by help rows and hints) stayed stale until the next touch. One re-armed timer now reports the 30 min expiry on time. `disablePenMode` and `dispose` clear it.
5. **A palm rolling on was never re-classified (line 361, `toPalm` at 863; gestures.ts `TapSession.leave` at line 77).** A pen-mode finger whose contact grows past 20 sp before it has panned, lassoed or tapped now becomes a palm and leaves the tap session.
6. **A second contact froze a pen-mode finger pan (`twoMove` at 576, line 565, `releaseTwo` at 686).** Until the new contact moved 4 px, panning stopped and the lost motion was never recovered; when the gate opened, zoom jumped (×1.35 in the old test scenario). The panning finger now keeps panning, the pinch measures from the point where both have moved, and an unmoved contact does not take over the pan when the panning finger lifts.
7. **Key gating (keys.ts:111, index.ts:222–240).** AltGr (Ctrl+Alt) counted as a chord, so AltGr-`?` ignored `keysBlocked()`. Input now also blocks single keys when focus is in a radio group (a spec rule it previously left entirely to the app), and skips keydowns a focused widget already consumed with `preventDefault`.

I also fixed doc drift: the code withdraws a pending touch tap when a pen lands, but the arbiter header and contract request #2 said it commits. I kept the code (the tap is almost certainly the hand landing) and corrected the docs.

**Tests:** I added 19 unit tests (15 arbiter, 1 gestures, 1 keys assertion block, 2 pointer). Each fix was mutation-checked: reverting it fails at least one test. One existing test, "a finger pan becomes a pinch…", now needs one more move and checks the exact zoom with no jump; that change follows from fix 6. In the sandbox I added a radio-group tile, a key-consuming widget, and driver checks for key gating, AltGr `?`, and barrel air/lift using dispatched PointerEvents. The three new checks failed against the stale pre-fix server and pass on the fixed code. Screenshots look right: the barrel erase spans only landing to lift.

### Decisions
- A pen landing within 300 ms of a touch-only tap withdraws the pending tap, as the code already did; I corrected the arbiter header and contract request #2, which said it commits. The tap is almost certainly the hand landing before the pen, and it can only happen on first pen use.
- Touches that were down when the pen landed stay palms until they lift: they leave the tap session, and the session and its two-finger flag are reset. The spec says touches are ignored while the pen is down; I extended that to the whole lifetime of those contacts.
- A pen barrel erase counts only while the tip is in contact. The tip is judged lifted when buttons bit 1 is clear and pressure is 0. The pressure check keeps pens without pressure support (pressure 0.5 when a button is pressed) and the CDP harness working as before. After landing, conversion waits one move event so every sample after the begin sample is strictly later.
- Pen-mode expiry uses one timer, re-armed for the remaining time when it fires early, with a floor of 1000 ms. Pen events never touch timers once it is armed. Arbiter got a new dispose() method (not a listed export) that index.ts calls.
- A palm that rolls on is re-classified only while the finger is undecided. A finger that is already panning, lassoing or in a two-finger gesture keeps its gesture, so a growing contact never cuts a pan.
- Pen mode, a second contact joining a finger pan: until both have moved, the panning finger pans alone and the pinch re-bases (no zoom jump when the gate opens). If the panning finger lifts first, the unmoved contact does not inherit the pan. Two fingers placed fresh keep the builder's behaviour.
- isChord now excludes Alt (AltGr). Single keys are also ignored when focus is inside [role=radiogroup] or [role=radio], per the spec, regardless of keysBlocked(). A keydown that a focused widget already handled with preventDefault never reaches the canvas key map.
- In arbiter.track and land, Math.hypot became sqrt(dx·dx + dy·dy) because it runs per sample. Behaviour is identical.
- Sandbox defaults still point at port 5185 (input's port in BUILD §0). I ran it on 5195 with the URL env var.

### Gaps
- Palm radius risk on real iPads: the palm test uses max(width, height)/2 > 20 sp. If iPad Safari reports a normal fingertip at about 21 pt radius (UITouch.majorRadius often reads around 21), every finger in pen mode would be treated as a palm. This needs a real-device check; if it fails, the threshold or the mean-radius measure should be tuned.
- Wheel notch scale: in pixel mode a notch is |Δy|/100 rounded. If Chrome scales notch deltas by display scaling or page zoom, a 150 % display would give ×1.15² per notch, and non-integer deltas at page zoom ≠ 100 % fail the spec's integer test and pan instead of zooming. I kept the spec rule; real hardware should confirm.
- Still verified only in headless Chrome via CDP plus dispatched PointerEvents (barrel air/lift, eraser end). Not tested on Safari/iPad Pencil, Surface/Wacom or Firefox. Barrel-in-hover behaviour depends on the platform firing pointerdown with pressure 0, as the Pointer Events spec describes.
- spaceHeld has no change notification in the frozen contract; app/ must poll it to show the pan cursor.
- Unchanged from the builder: P1 items (rotation, touch inertia, Mod-drag move, Alt-drag duplicate, Digit5 / Mod+D / M / arrows / Mod+Shift+E) are not built.
- tests/purity.test.ts currently fails on ink/operators/*.ts (another group, mid-flight); input passes its rules. The sandbox server on 5195 is stopped.

### Contract requests
- No new requests. I amended docs/contract-requests/input.md: #2 now says a pen landing within the double-tap window withdraws the pending tap (everything else still commits it); #1 now says onPenMode(false) fires when the 30 min expiry happens, not at the next touch.
- Existing builder requests #1 to #6 still stand: onPenMode/onFingerPan on InputController (InputControllerEx is the workaround), deferred strokeEnd for touch taps, select add semantics, object-reuse notes, and the contact() wording.


## build: ui

**Tests:** 246 passed, 0 failed. **Typecheck clean:** true

I built the whole ui group (BUILD.md §10). `createUI(root, store, glyphs)` in src/ui/index.ts builds the full chrome. It only reads AppState, dispatches Intents, listens to AppEvents and draws mini canvases through Glyphs, and the purity test passes.

**Results**
- 71 vitest tests pass across my 5 test files plus tests/purity, 0 fail.
- The sandbox driver (sandbox/ui/shoot.mjs) passes all 175 checks against a live page with real input events. It takes 41 state screenshots across desktop, phone 390×844, phone landscape 844×390, tablet and Paper, plus 6 interaction shots.
- I looked at every screenshot and fixed what I found: the switch thumb sharing a class name with the Recent thumbnails, a CSS specificity bug that stopped the toast action using the accent colour, help-sheet typography, focus rings clipped inside phone sheets, and faint Night edges.
- My files typecheck clean under tsconfig.json and tsconfig.test.json.

**What the UI does**
- **Control budget (DESIGN §1.2):** the pure `visibleControls(state)` model drives the DOM. Unit tests prove 4 at rest, 5 with ink, 6 in selection, 0 while drawing or replaying, never more than 7 over all 64 combinations. The sandbox counts the same numbers in the real page on every layout. Every conditional control fades in a fixed slot, so Undo never moves when Redo appears and the chips stay centred on phones.
- **Chips (§3.4):** tap opens the sheet; drag past a 6 px dead zone bends the amount, measured from where the dead zone was left so nothing jumps.
  - Size ×2^(−Δy/60), depth −Δy/40 in quarter levels, hue 0.75°·Δx and tone −0.002·Δy.
  - At most one intent per animation frame, with `done: true` on release.
  - Long-press (500 ms) shows "Form · drag ↕ to deepen"; desktop tooltips appear after 600 ms with the shortcut and the drag.
  - Arrow keys on a focused chip bend one step and announce the result. In erase mode the Stroke chip tap returns to the last nib.
- **Sheets:** dialogs that grow out of their chip (scale .96 → 1, 160 ms, no bounce).
  - Tiles are rendered by `glyphs.tile` a few per frame (checked one first), sit in a radiogroup with one tab stop, and keep labels always. Selected tiles get a 2 px outline plus a dot.
  - The active nib tile drags to set size, and the Color sheet has the Night | Paper switch.
  - Esc returns focus to the chip, Tab is trapped inside, and pressing the canvas outside a sheet closes it without drawing.
  - Phones get bottom sheets (≤ 46 % height, grid, swipe down); phone landscape gets a side sheet next to a vertical bar on the trailing edge.
- **Menu** has exactly the seven items, with a Recent drill-in: 96 px thumbnails, local dates, and an in-sheet delete confirmation that focuses Keep. The not-autosaving dot sits on the menu mark.
- **Help** prints the Ink Grammar line verbatim, then Keys or Gestures depending on the device, with labels from the keyboard layout map where available, and Reset calibration.
- **Toasts:** one at a time, an optional action and progress bar, 6 s by default, paused while hovered or focused.
- **Hints and pulse:** the four hints and the Form chip pulse.
- **Announcements:** a throttled aria-live region that coalesces repeats of the same kind (a long hold announces only its final depth).
- **Chrome fade (§4):** 90 ms out and then `visibility: hidden` on contact; back 220 ms after 700 ms; at once if the mouse is within 80 px of the dock or a hovering pen within 96 px.
- **Accessibility:** focus rings #8fb3ff / #2747a8; 44 px targets (48 px on coarse pointers); reduced-motion and forced-colors rules, both checked with emulation. A unit test parses the colour tokens out of styles.css and checks contrast (text ≥ 4.5:1, control edges ≥ 3:1) over both the bare ground and the worst ink under the 86 % surface.

**Things the app owner needs to know** (all in docs/contract-requests/ui.md)
- The app should set `chromeHidden` to the raw contact state; the UI owns the 700 ms delay.
- Tapping the selection's own Form tile again sends `pickForm`, so the app must treat that as a reseed. The app should also put the selection's colour in `tool.recents[0]`.
- `ui/index.ts` imports styles.css itself, so main.ts must not import it again.

The sandbox dev server on port 5186 is stopped.

### Decisions
- The 700 ms chrome return delay, the early return (mouse within 80 px of the dock, hovering pen within 96 px) and the 90 ms / 220 ms fades are owned by the UI; AppState.chromeHidden is read as the raw contact state.
- Without a selection, choosing a tile closes its sheet so the next touch draws; with a selection the sheet stays open so restyles can be compared. The Night | Paper switch never closes the sheet; Erase always does.
- Pressing the canvas while a sheet is open hits a transparent backdrop that closes the sheet and does not draw. Menu and Help are modal; on phones every sheet is modal because it covers the dock.
- A keyboard chip step is one intent with done:true (one step, one history entry). A drag whose pointer is cancelled by the system sends neutral values with done:true. The Form chip only dispatches when the quarter-level value changes.
- The Form sheet always sends pickForm; reseeding when the selection's own Form is tapped again is left to the app, because the UI cannot see the selection's recipes.
- Undo is shown when canUndo, not merely when there is ink, so a freshly opened document with nothing to undo shows no dead button.
- Phone tile grids use 3 columns for the 9-tile Color sheet and 4 columns (2 in the landscape side sheet) for the 4-tile Stroke and Form sheets, so those sheets stay one row high.
- Only the chip sheets are capped at 46 % height on phones; the Menu may use 64 % and Help (a full sheet) 92 %.
- Fine-pointer windows between 600 and 1100 px wide use the desktop layout, and the Color sheet wraps to 5 columns below 52rem.
- On phones all targets are 48 px except the menu mark, which stays 44 px as §10 specifies. Delete sits above the dock on desktop unless the app supplies a selectionRect.
- Empty recent colour slots show as quiet dashed wells that are not controls (disabled and hidden from screen readers), so the Color sheet layout stays stable.
- Every hint except 'draw' dismisses itself after 4 s and dispatches hintDone; 'draw' fades at the first canvas contact. A hint is shown at most once per session even if the app's hint state lags.
- Announcements are throttled to one per 900 ms; a message of the same kind (same text with numbers masked) replaces the queued one, and at most 3 distinct messages queue.
- Colour tokens mirror render-core's GROUND_TOKENS, except the Night border (#80868f instead of #636975), Paper warning text (#7a4500) and Paper danger text (#a11f19), which were changed to meet the §10 contrast rules over saturated ink.
- ui/index.ts imports styles.css itself; index.html does not link it and adds only a tiny inline background style so there is no white flash before load.
- Help opened from the menu returns focus to the menu mark; Help opened by key returns focus to wherever it was. A focused control that hides (Undo emptied, Delete done, view reset) hands focus to Undo, then Redo, then the Stroke chip.

### Gaps
- Not tested against the real Glyphs, store or input: render/glyphs.ts and the app store do not exist yet, so all visual checks used the sandbox's fake glyphs and mock store.
- The canvas's role=img summary label ("14 strokes: 8 Sprout, 6 Drift, Night ground") is not built: the UI does not own #stage and has no per-Form stroke counts. The app needs to add it.
- Delete is positioned above the dock rather than "just above the selection's bounds" until the app provides selectionRect (contract request #1).
- The 'nav' hint has no text in the spec; the UI's default is "Two fingers pan and zoom." on touch and a scroll / Space-drag / pinch-or-wheel line on desktop. The app may send its own text in the event.
- Recent rows open and delete documents but cannot mark which one is the current document, because AppState has no current document id.
- P1 items not built: hold-to-repeat Undo, Mirror toggle in the Form sheet, animated tiles, a movable dock.

### Contract requests
- docs/contract-requests/ui.md #1: add selectionRect {x,y,w,h} | null (viewport CSS px) to AppState so Delete can sit above the selection. The UI reads it as an optional field; without it Delete sits above the dock.
- ui.md #2: confirm chromeHidden means raw contact and the app does not delay it, because the UI owns the 700 ms return and the early return near the dock.
- ui.md #3: while a selection exists, the app should mirror the selection's uniform style into `tool` and put the selection's colour in tool.recents[0]; the app must treat pickForm of the selection's own Form as a reseed.
- ui.md #4: a bend with done:true and no open drag must be treated as a complete one-step bend (keyboard path); a system-cancelled drag ends with neutral values and done:true.
- ui.md #5 (wiring, no contract change): main.ts must not import styles.css again; glyph canvases arrive sized to their CSS box × dpr (≤ 3); hintDone should be idempotent; the replay catcher dispatches stopReplay; a press on the sheet backdrop dispatches openSheet:null.
- ui.md #6: render-core's GROUND_TOKENS.night.uiBorder (#636975) drops to 2.2:1 over bright ink; suggest #80868f for consistency.


## review: ui

**Tests:** 283 passed, 0 failed. **Typecheck clean:** true

I reviewed the whole ui group (BUILD.md §10) against DESIGN §1.2, §3.0, §3.4, §4 and §10. I fixed 6 real bugs and several smaller robustness issues in place. No exported name or signature changed; I only added exports.

**Results**
- 85 vitest tests pass (71 existing plus 14 new in tests/ui.review.test.ts), including tests/purity. None fail.
- The sandbox driver passes 198/198 checks on port 5196: 175 existing plus 23 new regression checks. It drives real mouse, keyboard and CDP touch input.
- My files typecheck clean under tsconfig.json and tsconfig.test.json.
- I looked at screenshots of the desktop, phone, landscape side sheet, Recent, menu, Color sheet, help, and the scrolled help on a short phone.

**What I checked**
- `createUI(root, store, glyphs)` exists with the exact signature.
- The budget model gives 4 at rest, 5 with ink, 6 in selection, 0 while drawing, never more than 7, and the DOM follows it.
- The chip formulas match the spec: size ×2^(−Δy/60), depth −Δy/40 in quarter levels, hue 0.75°·Δx and tone −0.002·Δy; key steps are 1.25/0.8, ±0.25, 5° and 0.02.
- The 6 px dead zone, 500 ms long-press, 600 ms tooltip and at most one intent per frame all hold.
- Chrome fade: 90 ms out, back 700 ms after release, early return within 80 px (mouse) / 96 px (hovering pen), and idle leaves no timers.
- Sheets: radiogroup with one tab stop, Esc returns focus to the chip, Tab is trapped. Contrast tokens, the menu's seven items, the grammar line, toasts, announcer, listener/timer cleanup on dispose, and the purity import rules all check out.

**Bugs fixed** (each has a sandbox regression check)
1. **Deleting a Recent drawing dropped focus to `<body>`** (recent.ts:160). With a synchronous store the list is rebuilt inside the dispatch, so the saved neighbour element was already detached. Focus now moves to the neighbouring row by id, or to Back when the list empties. Esc stopped working afterwards as a knock-on effect.
2. **Esc from Recent left focus nowhere** (menu.ts:53), so the next Esc never reached the sheet. Focus now returns to the Recent item.
3. **Swipe-down on phone bottom sheets only worked on the grab bar** (sheet.ts:110, :174, swipe end; styles.css). The sheet body allowed vertical panning (`touch-action: pan-y`), so the browser claimed every vertical drag in the gaps between tiles. The body now allows panning only when its content really overflows, inner scrollers flatten, a cancelled pointer snaps back instead of possibly closing, and the scrolled-content check now walks up to the real scroller.
4. **Chrome took clicks during the 90 ms fade-out** (styles.css:188). Buttons set their own `pointer-events: auto`, so a tap in that window still opened a sheet. The spec says the chrome stops taking input on contact.
5. **Erase-mode Stroke chip: arrow keys still sent `bendSize`** while the drag was correctly disabled (chip.ts:400). It now follows the same rule (`chipBends`). The long-press label now says "Erase · tap to return", and `aria-haspopup` is dropped because a tap returns to the last nib instead of opening the sheet.
6. **Help showed "SS" for the German ß key** (help.ts:34): `toUpperCase` turns ß into two letters.

**Smaller fixes**
- **Per-frame tile updates during chip drags:** the tile sheets compared options with `JSON.stringify` and rewrote every label each frame, which re-laid out an open sheet. Now a cheap `sameOpt` comparison (sheet.ts:472) and label writes only on change.
- **aria-modal on phones:** it now reflects that chip sheets are modal there (index.ts:159).
- **Hints:** a hint marked 'showing' during a contact is now shown when the chrome returns (hints.ts:122).
- **Device-specific text:** a desktop pen tablet now gets the Keys list in Help (help.ts:219) and the right navigation hint. The desktop hint no longer says "Scroll to move", which is wrong for a mouse wheel that zooms.
- **Bad values from the app:** NaN or negative zoom, NaN progress, bad toast `ms`, non-finite selection rects and bad Recent dates/counts no longer show "NaN%", "Invalid Date" or "NaN strokes".
- **Cleanup and polish:** the pulse timer is cleared on dispose, and theme-color follows the ground.
- **Sandbox driver:** the port is now configurable with `UI_PORT`.

The dev server I started is stopped.

### Decisions
- Bottom and side sheets allow browser panning only while their content overflows (sheet.ts adds `.is-scrollable`); otherwise any drag on the sheet is swipe-to-close. Sheets that do scroll (Help on short phones, a long Recent list) close from the grab bar or the Close button.
- A cancelled pointer during a sheet swipe snaps the sheet back and never closes it; only a real release can close.
- The Stroke chip bends nothing in erase mode, by drag or by arrow keys (`chipBends`). Its long-press says 'Erase · tap to return', and it drops aria-haspopup there because a tap returns to the last nib instead of opening a dialog.
- Help shows Keys whenever the pointer is fine, including a desktop pen tablet in pen mode; gestures (the pen-mode set when a pen has been seen) only on touch devices.
- Default 'nav' hint: desktop 'Space-drag to move · wheel or pinch to zoom.'; touch-only 'Two fingers pan and zoom.'; pen mode on touch 'One finger pans · two fingers zoom.' (DESIGN §5).
- After a confirmed Recent delete, focus goes to the neighbouring row, found by id after the dispatch, or to Back when the list is empty; it never falls to <body>.
- Bad values from the app fall back to safe defaults: zoom NaN/≤0 reads as 100 %, NaN progress means still running, a bad toast ms means 6 s, a non-finite selectionRect places Delete above the dock, and bad Recent dates or counts print '' / '0 strokes'.
- Kept the builder's choice that on desktop only the dock stays live while a chip sheet is open (menu mark, Undo/Redo and view chip are inert, and pressing them closes the sheet first). Mod+Z still undoes.
- The UI sets <meta name=theme-color> to the ground colour (#0c0e14 / #f4f0e7).

### Gaps
- Still not tested against the real Glyphs, store or input: render/glyphs.ts, app/store.ts and main.ts do not exist yet, so all visual and interaction checks used the sandbox's fake glyphs and mock synchronous store. A batched (asynchronous) store is handled by the Recent focus path but has not been exercised.
- The canvas's role=img summary label ('14 strokes: 8 Sprout, 6 Drift, Night ground') is not built: #stage and the per-Form counts belong to the app.
- Delete sits above the dock instead of above the selection until the app supplies selectionRect (contract request #1).
- On desktop, Undo/Redo, the menu mark and the view chip cannot be clicked while a chip sheet is open (a design choice kept from the builder). Restyle comparisons in a selection need Mod+Z, or closing the sheet first.
- Swipe-to-close relies on CSS touch-action, verified with emulated touch in Chrome only; iOS Safari behaviour is unverified.
- P1 items still not built: hold-to-repeat Undo, the Mirror toggle, animated tiles, a movable dock. Recent cannot mark the current document because AppState has no current document id.
- The NBSP constant in announce.ts is the literal U+00A0 character (the editing tools turned the escape back into the character); it works the same.

### Contract requests
- No new contract requests. The builder's docs/contract-requests/ui.md #1–#6 still stand: selectionRect in AppState; chromeHidden is the raw contact state (the UI owns the 700 ms delay); mirror the selection's style into tool and its colour into tool.recents[0], and treat pickForm of the selection's own Form as a reseed; a done:true bend with no open drag is a one-step bend; wiring notes; GROUND_TOKENS night.uiBorder.

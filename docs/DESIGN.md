# Rise: Product and Technical Specification (v1, final)

> **Your stroke is the seed. Hold still, and it rises.**

This is the build spec for Rise (`rise-sketch`). It replaces the v1 draft and settles the three critiques of it (clutter, feasibility, delight). Section 13 logs every critique point with its verdict and a one-line reason. Where this document and the draft disagree, this document wins.

**Status (2026-10-05).** P0 is built (§11 lists what is not), plus six Forms beyond the original plan.
- **Forms:** eleven in the app. Line, Echo, Sprout and Drift as specified; Craze, Plume, Caustic, Burin, Plait and Orbit promoted from the forms lab (`lab/forms`) with unchanged geometry (§2.3.10–§2.3.15); Ripple v2 promoted from lab prototype v107 (§2.3.7). New Sprout and Drift strokes cook with v2 operators (§2.3.5, §2.3.6); old documents keep v1.
- **Tests:** `npx vitest run` passes 1186 tests in 76 files under `tests/` (the forms lab has its own suite, §7.6).
- **e2e:** `scripts/e2e.mjs` has 28 scenarios (27 on the debug build, plus `prod-file`), §7.6.
- **Share timelapse:** every drawing can leave the app as a short MP4 of its ink growing (§8).
- **Remix links:** a drawing travels in a link's `#r=` fragment and opens, replaying, as a new document that looks the same (§8, §13 #13).
- **Not met:** the single-file bundle budget (§9).
- The user-facing summary is `README.md` at the repo root.

**Repo baseline** (verified when this spec was written; the scripts are as they stand today):
- **Toolchain:** Vite 8.3.2, TypeScript 5.9 (strict), vite-plugin-singlefile 2.3.3, vitest 5.0.3, puppeteer-core 25.12. All are dev-only; there are **zero runtime dependencies**.
- **Scripts:**
  - `dev`
  - `build` runs `npm run typecheck && vite build`
  - `build:single` (`vite build --mode single`) writes the self-contained `dist-single/index.html`, which opens by double-click
  - `build:debug` (`vite build --mode debug`) writes `dist-debug/index.html`: the same file with the `?debug` hooks compiled in (§7.6)
  - `typecheck` runs the app, pure and test configs; `test` runs vitest
  - `e2e` runs `scripts/e2e.mjs`; `bench:zoom` runs `scripts/bench-zoom.mjs` (§9)
- **Harness:** `scripts/harness.mjs` drives Chrome through CDP (pen pressure and tilt, mouse, multi-touch) with SwiftShader raster.
- **`src/core/` modules that predate the build:**
  - `det.ts`: fdlibm-port `dsin`/`dcos`/`datan2`/`dexp`/`dlog`/`dpow`, the addressed-hash `rnd`, `Ch` channels, `fnv1a`
  - `geom.ts`, `mat.ts`, `num.ts`, `pool.ts`
  - `oklab.ts`, which is presentation-only and allowed to use `Math.*` (§7.5)
  - `types.ts`, which §7.2 defines
- **Tests that predate the build:** `tests/det.test.ts`, `tests/core.test.ts`.

**Units used throughout**

| Term | Meaning |
|---|---|
| **sp** | Screen CSS pixels at the zoom when the stroke began. Every gesture measure (speed, length, radius, spacing) is in sp, so zoom never changes a stroke's character. |
| **doc** | Document units. `doc = sp / z`, where `z = camera.scale` at pen-down. |
| `s` | Absolute arc length along the stroke's spine, in sp, counted from the stroke's first station `s0` (which is 0 except for split pieces). |
| `L` | Current or final spine length, in sp. |
| `p` | Calibrated pressure, 0..1. |
| `v`, `v_n` | Speed in sp/ms. `v_n = v / vMed`, where `vMed` is learned per device class. |
| `c`, `CS` | Frozen crowding, 0..1. Signed side-crowding, −1..1 (§2.3.9). |
| `d(s)` | Depth field: the Form's base depth plus the pools the user held (§2.3.2). |
| `S` | Nib size in sp. |
| `r` | `rnd(seed, channel, a, b)` from `det.ts`: a stateless hash in [0,1). |
| `smoothstep(a,b,x)` | Hermite smoothstep. It also works reversed when `a > b`. |

---

## 1. Product vision and principles

Rise is a drawing instrument in which every mark is alive.

**How a mark grows.**
- You lay down a stroke. The stroke is a seed, and a growth **Form** grows it into coastline, crystal, botany or smoke, a hand's breadth behind the nib.
- Where you linger, the ink pools and rises deeper. Where you flick, it runs wild and dry.

**How it is controlled.**
- The demo needed six sliders to do a fraction of this. Rise reads the hand instead. The parameter space is speed, pressure, lean, stillness, zoom and the ink already on the page.
- That parameter space is calibrated to each person and frozen into each stroke, so a mark never changes after you leave it.
- The user makes three kinds of choice, each a tap on one of three chips: a nib (**Stroke**), an ink (**Color**), a growth (**Form**).
- Dragging the same chip bends that primitive's single amount: size, hue and tone, or depth.
- Everything else is inferred, kept within bounds, and visible within one frame.

**The surface.**
- The canvas is infinite, and a drawing is a list of small deterministic recipes.
- The chrome vanishes the moment ink flows.
- The same recipes render as light on **Night** or as pigment on **Paper**.

### 1.1 Principles

1. **The hand is the interface.** Speed, pressure, lean, stillness, zoom and nearby ink are the controls. A capability ships as a gesture mapping or an inference before it is ever allowed to ship as a control.
2. **Tap a kind, drag an amount.**
   - Every visible choice is a category: a nib, an ink, a Form.
   - Each chip carries exactly one continuous amount, set by dragging that chip.
   - There are zero sliders. The only number on screen is the zoom % on the view chip.
3. **Infer how, never what.**
   - Rise infers width, taper, smoothing, roughness, branching, spacing, tone, colour family and growth direction.
   - It never infers a nib, an ink or a Form. It never deletes, and it never changes an existing stroke.
4. **What you see is what you get.** The live mark *is* the committed mark, built by the same code path (`cook ≡ incremental.finish`). There are exactly three declared exceptions (§1.3). Each is visible and lasts ≤ 1.1 s.
5. **Ink is frozen once laid.** Calibration, crowding, colour family, base depth and pools are snapshotted into the recipe. Only an explicit restyle changes a stroke, and it can always be undone.
6. **Every inference is bounded and bendable.** Each inferred value has a clamped range that stays within its family. At least one gesture overrides it: hold, Settle, chip drag, select-and-restyle, or keys.
7. **Only the ink moves.**
   - No controls are visible while drawing.
   - Feedback at the nib (halo, hot trail) is drawn *as ink*, not as instrument chrome.
   - Nothing bounces.
   - An idle frame costs nothing: no rAF and no recurring timers.

### 1.2 How "less is more" is enforced

**Control budget.** These are hard limits. `scripts/e2e.mjs --budget` checks every state below by counting visible interactive elements.

| State | Visible controls (max) |
|---|---|
| Empty canvas | **4**: Menu, Stroke chip, Color chip, Form chip |
| With ink | **5**: adds Undo |
| Conditional | **Redo** appears after an undo and stays until the next new command. The **view chip** appears when zoom ≠ 100%, or when the document has ink but none is in view. **Absolute max 7.** |
| Selection | **6**: the 3 chips, Undo, Redo, Delete. Menu and the view chip hide. |
| Drawing | **0** |
| Any sheet | At most 9 tiles plus one two-way switch. **Exception:** the Form sheet shows all 11 Forms, in two rows (6 + 5) on desktop (§13). Its one switch is Free \| Symmetry (§2.3.1). |
| Toast | One at a time, with at most one action, and only for the events listed in §4 |
| Sliders / numeric readouts | **0 / 1** |

**Feedback is not a control.** None of these is ever clickable while drawing: nib cursor, rise halo, weld ring, lasso path, eraser ring and doom mask, selection bounds, hints.

**Feature gate.** Every feature must pass this test: *"Does the ink get smarter so the user configures less?"*
- A feature that adds a visible control must remove one, or live inside an existing sheet or the menu.
- A feature that needs a setting is redesigned as an inference or cut.
- **Cut on this test:** sound, layers, scribble-to-erase, Apply to all, whole-recipe eyedropper, Focus mode, size dots, selection steppers, sibling colour separation, any settings page.

### 1.3 Declared exceptions to "what you see is what you get"

1. **Lift zones.**
   - At lift, these re-cook: the exit taper, the end flush, the seated stop and, on closed strokes, the seam weld.
   - They affect at most the last 50 sp and the first 30 sp.
   - The change animates in over 120 ms.
2. **Echo ghost.**
   - Echo is the one global Form. While you draw, it shows a provisional ghost crystal: an 8-vertex uniform generator at α 0.3.
   - At lift the true crystal folds out and the ghost dissolves.
3. **Hot ink.** Fresh ink is brighter on Night and darker on Paper. It decays to *exactly* the committed value within 3τ, which is ≤ 1.14 s.

### 1.4 Resolved product questions

| Question | Decision | Reason |
|---|---|---|
| Forms in P0 | **Line, Echo, Sprout, Drift**. *Since shipped:* **Craze, Plume, Caustic, Burin, Plait, Orbit**, promoted from the forms lab (§2.3.10–§2.3.15), then **Ripple** (§2.3.7). | Depth 0 of every Form is the bare nib, so "Bare" is not a separate Form. The six lab Forms each add a primitive the first four lack (network, vane, optics, hatching, weave, kinematics). |
| Depth model | **Base depth per Form** (tool state, bent by dragging the Form chip) **plus local pools where the user holds** | Pools are a new expressive freedom, and they keep rising local and cheap. |
| Stationary contact | **Tap** gives a radial seed at base depth. **Hold** gives a radial seed that rises. | Holding always means rise, everywhere. |
| Selecting | **Never with the drawing contact.** Modifier-click on desktop, a finger tap in pen mode, a double-tap on touch-only devices. | Keeps hold = rise unambiguous. |
| Nibs | **Pen, Brush, Chisel** in P0. Charcoal is P1, together with paper tooth. | A nib's material is a kind. Charcoal needs the tooth map. |
| Inks | **Graphite, Indigo, Oxide, Ochre, Moss, Rose, Spectral**, plus custom | Designed as Night/Paper pairs that glaze correctly. Rose closes the red/magenta gap. |
| First-run defaults | **Night, Brush, Moss, Sprout (base 2)** | The first image is glowing botany growing from the user's own stroke. |
| Paper ground | **P0** | A drawing tool needs a light ground. It costs one ramp table and one blend mode. |
| `[` `]` vs `-` `=` | `[` `]` set size. `-` `=` set depth. | Artist muscle memory from Photoshop, Krita and Clip Studio. |
| Erase | **Whole stroke in P0.** Partial erase of local Forms is P1. | Regrowing half a fractal looks broken. Local Forms cut cleanly. |
| Committed raster | **World tiles at half-octave levels** | The demo re-rendered everything on every erase. |
| Live compositing | **CSS mix-blend stack over a CSS ground** | Avoids full-screen blits every frame. |
| Deterministic maths | **`det.ts` in P0** | A `.rise` file must re-cook identically on every engine. |
| View rotation; move and scale | **P1** | They touch tiles, hit-testing, occupancy and export. P0 ships without them. `recipe.rot` is always 0 in P0. |
| WebGL2 | **P2**, for HDR accumulation only | Canvas2D covers everything in v1. |

---

## 2. The three primitives

### 2.1 Overview

| Primitive | Definition | User chooses (tap) | User bends (drag the chip) | Ink infers |
|---|---|---|---|---|
| **STROKE** | How the hand becomes a mark: the nib's material and the spine it lays down. | Nib: Pen, Brush, Chisel (Charcoal in P1); Erase | Size, remembered per nib | Pressure curve, smoothing, corners, width, tapers and endings, closure, chisel angle, dry-split |
| **COLOR** | The light (Night) or pigment (Paper) the mark carries, and the ground beneath it. | Ink: 7, plus 2 recents. Ground: Night or Paper. | Hue (x) and tone (y), which creates a custom ink | Variant, lineage, pressure and depth tone, glow budget, hot ink |
| **FORM** | What the seed grows into, and how far. | Form: Line, Echo, Sprout, Drift, Craze, Plume, Caustic, Burin, Plait, Orbit, Ripple | Base depth, remembered per Form | Roughness, asymmetry, generator, branch template, angle, side, spacing, field, filament length, plate size, barb sweep, lamp direction, hatch side, braid period, orbit radius, response to crowding and to closed loops. Pools come from holding. |

### 2.2 STROKE

#### 2.2.1 Choices: nibs

| Nib | Character | Default S (range), sp | Width / geometry (sp) | Taper scale | Technique | Pri |
|---|---|---|---|---|---|---|
| **Pen** | Technical liner, near-constant width | 2.5 (0.75–12) | `w = S·(0.72 + 0.38p)` | 0.5 | Ribbon | P0 |
| **Brush** (default) | Expressive; responds to pressure and speed | 9 (2–48) | `w = S·(0.14 + p^1.5)·(pen ? 1 − 0.25·smoothstep(1, 3, v_n) : 1)` | 1.0 | Ribbon, plus dry-split | P0 |
| **Chisel** | Broad-edge calligraphy | 12 (3–48) | Edge `E = S·(0.6 + 0.4p)` at angle `θ_nib`; minimum thickness `0.12S` | 0.4 | Quads and core in one path | P0 |
| **Charcoal** | Grain registered to the paper tooth | 7 (2–40) | `w = S·(0.7 + 0.5p)`; tooth level `k = floor(4p)` | 0.8 | Tooth-pattern ribbon | P1 |
| **Erase** | Removes whole strokes | 16 sp radius | — | — | Sweep plus doom mask | P0 |

- **Fingers:** width ×1.35 automatically, because a fingertip is blunt.
- **Speed term:** Brush's speed term applies only to pens. Mouse and finger pressure is already derived from speed.
- **Brush dry-split** (P0):
  - Applies where `v_n > 1.3` and `p < 0.5`, crossfaded over `smoothstep(1.1, 1.5, v_n)`.
  - The ribbon is replaced by 4 bristle sub-ribbons of width `w/4.5`, offset by `(j − 1.5)·w/4`.
  - Each bristle is gated by hashed 1D value noise sampled every 12 sp along the arc: `r(seed, Ch.Misc, j, floor(s/12)) > 0.35`, so strands break.
  - Every bristle goes into the same batch path as the ribbon, so strands merge where they touch and never double-add.

**Size.** Each nib remembers its own `S` (stored in prefs). There are three ways to change it, plus zoom:
1. **Drag the Stroke chip vertically:** `S' = S·2^(−Δy/60)`, so 60 px is one doubling, clamped to the nib's range.
   - A 6 px dead zone means taps never nudge the size.
   - A true-size nib ring previews at the centre of the screen.
2. **The same drag on the active nib tile** in the Stroke sheet.
3. **Press `[` or `]`** for ×0.8 or ×1.25. A ghost ring flashes to show the new size.
4. **Zoom (implicit).** `size_doc = S/z`, so zooming in gives finer marks without touching size.

#### 2.2.2 Inferred: signals and mappings

**Per sample** (coalesced Pointer Events), all frozen into the sample row:
- `x`, `y`
- `t`, sanitised to be strictly increasing: `t_i = max(e.timeStamp, t_{i−1} + 0.25)`
- raw `p`
- altitude and azimuth
- contact radius
- crowding `C` and side-crowding `CS`, computed at most once per 2.4 sp of travel

**Per station** (every 2.4 sp on the filtered spine):
- `v`: central difference over ≥ 8 ms
- `v_n`
- `κ`: turning in rad/sp over a 6 sp window
- dwell

**Per stroke:**
- `L`
- `v_entry` and `v_exit`: mean speed over the first and last 40 ms
- the closure state

| Inferred | Mapping | Default / cold start | Where it lives |
|---|---|---|---|
| **Pen pressure (learner)** | See the learner steps after this table. | `lo .04, hi .80, γ 1` | Snapshot in `recipe.calib` |
| **Mouse, trackpad and finger pressure** | `p* = 0.22 + 0.68·(1 − smoothstep(0.3, 2.4, v_n))`, then `p += (p* − p)·(1 − dexp(−dt/45))`, with `p(0) = 0.35`. Slow strokes pool ink; fast strokes run dry. | `vMed = 0.9` sp/ms, learned as the median in-stroke speed per device class | Derived at cook time from stored `t`. Stored `P = NaN`. |
| **Learned jitter `J`** (P0) | `J` = median RMS of (raw − filtered) on slow segments (`v_n < 0.5`). It sets the One Euro `fcMin` and the hold thresholds (§3.1). | `J = 0.3` sp | Snapshot in `calib` |
| **Smoothing** | One Euro filter on sp positions using the sanitised `t`. Cutoff `fc = fcMin + β·abs(v)`, with v in sp/s.<br>• **Pen:** `fcMin = clamp(3.5 − 1.5·smoothstep(0.4, 1.6, J), 1.2, 3.5)` Hz, β 0.020<br>• **Mouse:** 2.0 Hz, β 0.010<br>• **Finger:** 1.5 Hz, β 0.008<br>The filter is causal and uses no transcendentals: `α = 1/(1 + 1/(2π·fc·dt))`. | — | Derived |
| **End flush** | At lift, the raw lift point is appended. The filtered spine converges to it within the last 3 stations, so filter lag never shortens a stroke. | — | Lift zone |
| **Corners** | A station is a corner if it turns > 55° within ±4 sp **and** `v < 0.25·vMed`. Chaikin ×2 runs only *between* corners, then the result is resampled at 2.4 sp. | — | Derived (local, support 12 sp) |
| **Entry taper** | `Te = (4 + 26·smoothstep(0.4, 2.0, v_entry_n))·nibTaper` sp. It is causal: known once 40 ms of samples exist. The trunk additionally clamps `Te ≤ 0.25L` at lift. | — | Derived |
| **Exit taper** | `Tx = clamp(4 + 46·smoothstep(0.4, 2.2, v_exit_n), 4, 0.35L)·nibTaper` sp. A flick-off gives a long brush lift. | — | Lift zone |
| **Envelope** | `E(s) = smoothstep(0, Te, s)·smoothstep(0, Tx, L − s)^0.6`, applied as a width multiplier **at tessellation** (never stored in `Spine.w`). Operators see only the causal entry factor `E_in(s) = smoothstep(0, Te, s)`. | — | Derived |
| **Seated stop** | If `v_exit_n < 0.15` and dwell ≥ 60 ms: `Tx = 0`, the last 3 sp ×1.12, round cap | — | Lift zone |
| **Pen ramp-down** | If real pressure already fell at the end (`p_end < 0.35`): `Tx × 0.5` | — | Lift zone |
| **Closure** | `abs(tip − start) < r_c` **and** `L > 8·abs(tip − start)` **and** total turning > 300°, where `r_c = max(10 sp, 0.06L)`.<br>• **Hysteresis:** closure turns on inside `r_c` and off beyond `1.5·r_c`.<br>• **While on:** a weld ring shows at the start point, the seam is welded **live** (the last 4% of arc blends into the start) and both tapers are dropped. | — | Frozen in `recipe.closed` |
| **Chisel angle** | `θ_nib` = pen azimuth when altitude < 60°, otherwise 40° in screen space. Converted to doc space with `recipe.rot` (0 in P0). | 40° | Derived from samples |
| **Tilt shading** (P1, Pen and Brush) | `tK = smoothstep(60°, 25°, alt)`. Width ×`(1 + 1.8tK)`, alpha ×`(1 − 0.45tK)`. Laying the pen down shades. | — | Derived |
| **Finger contact radius** (P1) | `p_r = clamp01((r − r_P10)/(r_P90 − r_P10))`, blended 50/50 with the speed-derived value | — | Derived |

**Pen pressure learner** (one reservoir per device class: pen, mouse, touch), in order:
1. Keep the last 3000 in-stroke samples, excluding the first and last 30 ms of each stroke.
2. Take `lo = P5`, `mid = P50`, `hi = P95`.
3. Normalise: `p_n = clamp01((p_raw − lo)/(hi − lo))`.
4. Curve: `γ = clamp(dlog(0.5)/dlog((mid − lo)/(hi − lo)), 0.55, 1.8)`.
5. Guard against flat hands: `k = smoothstep(0.08, 0.25, hi − lo)`, then `p = lerp(0.6, dpow(p_n, γ), k)`.

**Learner rules.** This covers `lo`, `hi`, `γ`, `vMed` and `J`.
- It updates **only between strokes**.
- **First 150 strokes per device class:** each parameter moves by EMA at up to 8% per stroke.
- **After that it locks:** each parameter moves at most 1% per stroke and stays within ±15% of its converged value.
- State persists in `localStorage` under `rise:calib:<class>`, wrapped in try/catch.
- **Menu → Gestures & keys → Reset calibration** clears it.
- Every stroke snapshots the state into its recipe, so replay never depends on the learner.

**Latency.**
- **Target:** time to pixel ≤ 2 frames, with prediction covering up to 16 ms of it.
- **Predicted points:** from `e.getPredictedEvents?.()`; otherwise a line fit through the last 3 samples.
- **Limits on prediction:** capped at 16 ms and 24 sp, and drawn as a bare spine at 50% alpha.
- **Where the tip is drawn:** the predicted tip and the cursor draw on the `desynchronized` overlay.
- **Predicted points are never stored** and never grow.

### 2.3 FORM

#### 2.3.1 Choices: Forms in v1

| Key | Form | From the demo | Relation to the seed | Depth range (default base) | What rising does | Locality (reach) | Budget | Pri |
|---|---|---|---|---|---|---|---|---|
| 1 | **Line** | Bare nib + Roughen | Transforms the seed | 0–5 (**0**) | Clean line → weathered coastline → crackle | Local (36 sp) | Lattice ≤ 2 points/sp | P0 |
| 2 | **Echo** | Self-Koch | Grows from it (trunk kept) | 0–5 (**2**) | The stroke repeats inside itself | **Global** | 32k points | P0 |
| 3 | **Sprout** | L-system | Grows from it | 0–4 (**2**) | Buds appear and extend | Local (24 sp) | 900 per sprout; 24k per stroke, causal | P0 |
| 4 | **Drift** | Attractor | Grows from it | 0–6 (**2**) | The wake lengthens | Local (12 sp) | 150 steps per filament; 30k per stroke, causal | P0 |
| 5 | **Craze** | new (forms lab) | Cracks around it (a film) | 0–4 (**2**) | Transverse cracks → lengthwise splits → sub-plates → old seams widen | Local (60 sp) | 160 per plate; 10k per stroke, causal | P0 (added) |
| 6 | **Plume** | new (forms lab) | Grows from it | 0–3 (**2**) | Barbs → barbules → down | Local (22 sp) | 80 per unit; 24k per stroke, causal | P0 (added) |
| 7 | **Caustic** | new (forms lab) | Reflects off it | 0–4 (**2**) | Rays lengthen and brighten, then triple; the caustic gathers | Local (20 sp) | 40 per unit; 16k per stroke, causal | P0 (added) |
| 8 | **Burin** | new (forms lab) | Shades beside it | 0–4 (**2**) | Hatch → doubled hatch → cross-hatch → second diagonal and stipple | Local (8 sp) | 40 per unit; 16k per stroke, causal | P0 (added) |
| 9 | **Plait** | new (forms lab) | Transforms the seed (core strand) | 0–4 (**2**) | Strands arrive one per level, the core thins, then the carver's groove | Local (108 sp) | 220 per unit; 20k per stroke, causal | P0 (added) |
| 0 | **Orbit** | new (forms lab) | Orbits it | 0–4 (**2**) | Loops → five-lobed frill → scalloped lace → swell | Local (54 sp) | 220 per orbit; 24k per stroke, causal | P0 (added) |
| — | **Ripple** | new | Grows from it | 0–6 (**2**) | More contour rings | Local (52 sp) | 16k | shipped (v2) |

The six lab Forms were designed and judged in `lab/forms` (briefs in `lab/forms/briefs/`), then promoted unchanged into `src/ink/operators/<name>.v1.ts`. Where a brief and the operator disagree, the operator's header comment records the decision and the operator wins. Ripple has no key and no operator yet: its recipes cook as Line.

**Base depth** is tool state, kept per Form and persisted.
- **Bending it:** drag the Form chip vertically: `Δbase = −Δy/40` levels, in quarter-level steps, clamped to [0, dMax]. With a selection, the drag applies to the selection instead (§3.4).
- **Feedback:** the chip glyph re-renders at the new depth. No number is shown.
- **Depth 0** is the bare nib for every Form.

**Symmetry** (Mirror and kaleidoscope; shipped, §13 After the build #6) is the Form sheet's one two-way switch, **Free | Symmetry**.
- **Tap** toggles it. Turning it on centres it on the view centre at that moment (doc coordinates, kept in tool state). To move the centre: off, look elsewhere, on. A document switch re-centres it on the new view.
- **Drag the switch sideways** to step the fold count, 28 px per step, clamped: **Mirror** (2: a reflection across the vertical axis through the centre), then **3, 4, 5, 6, 8, 12** radial copies (360°/n). Default 6. ArrowLeft/Right on the focused switch step it; `M` toggles and `Shift+M` cycles the count (§5). This is the chip rule (tap a kind, drag an amount): the switch has no track and shows no number; the count shows as a spoke glyph on the switch and as a badge on the Form chip.
- **Guide:** a non-interactive 1 CSS px hairline at 15 % of the ground's text colour on the overlay, at rest and while drawing: the vertical axis for Mirror, otherwise one spoke per fold from a 4 px ring at the centre. It is feedback, never a target (the P1 list's "draggable at rest" axis was not built: a grab target on the canvas would steal pen-downs near the centre).
- **What it makes:** every stroke drawn with symmetry on becomes `n` strokes: the stroke and `n − 1` copies. A copy is a full recipe with its own id that shares every geometry input with the stroke (samples, seed, calib, pools, base) and carries a placement `xf` (§7.2, §7.5 rule 8). `cook(copy)` cooks those inputs exactly as the stroke and then places the result, so every petal is the bit-exact transform of the stroke's geometry (a Sprout branches the same way in every copy) and the live copies are exactly what is committed. With **Spectral** ink copy `i` takes `dh += 360°·i/n`, stored in its recipe (§2.4.2): a six-fold mandala is a rainbow wheel, a Mirror pair complementary. Other inks keep the stroke's colour.
- After the gesture each copy is an ordinary stroke: erased, selected and restyled on its own. Undo/redo, `R` on the last stroke (it reseeds the whole last gesture with one shared new seed) and Replay (copies play together) treat the gesture as one.

#### 2.3.2 Depth field: base plus pools

```
d(s) = base + max_i  a_i · K(s − s_i)
K(x) = smoothstep(−48, −6, x)   for x ≤ 0     (the 48 sp drawn before the hold soak it up)
K(x) = smoothstep( 32,  0, x)   for x > 0     (moving on unloads the brush back to base over 32 sp)
```

- **Storage.** Pools are stored in `recipe.pools` as rows of `(s_i, a_i, t0_i, t1_i)`.
  - `a_i` is quantised to 1/16.
  - There are at most 32 pools per stroke; a 33rd merges into the nearest.
  - `t0` and `t1` exist only for Replay.
- **Echo** is global, so it uses `d_E = base + max_i a_i`.
- **Radial seeds** use `base + a_0`.
- **Ceiling.** The realisable depth at `s` is `min(dMax, the depth the unit budget allows there)`. When rising reaches it, the halo flashes (§3.1).

**Fractional depth contract** (`n = floor`, `f = fract`). Every Form is continuous in `d` by construction.

| Form | Depth `n + f` |
|---|---|
| Line | The level-k displacement weight is `W_k(s) = clamp(d(s_node) − k + 1, 0, 1)` |
| Echo | Level n+1 vertices lerp from their position on the parent segment to their final position by `f` (fold-out) |
| Sprout | A generation-g branch at anchor j is drawn to length `ℓ_g·clamp(D_j − g + 1, 0, 1)`, where `D_j = d(s_j)` |
| Drift | Each filament is drawn to `N(d)/150` of its ceiling length, so the last step is partial |
| Ripple | Ring n+1 offset and alpha × `f` |
| Craze | A generation-g crack is drawn to `len·clamp(D − g + 1, 0, 1)`; the plate's film fades in with `min(D, 1)`; gen 1–2 seams widen ×`(1 + 0.8·clamp(D − 3, 0, 1))` |
| Plume | Barbs to `ℓ·clamp(D, 0, 1)`, barbules to `clamp(D − 1, 0, 1)`, down to `clamp(D − 2, 0, 1)` of their length |
| Caustic | Ray length `ℓ_max·min(D, 1)·(1 + 0.6·max(0, D − 1))`; the side rays' alpha × `clamp(D − 2, 0, 1)`; the caustic's alpha follows how far the rays reach past their focus |
| Burin | A family-g tick is drawn to `ℓ·clamp(D − g + 1, 0, 1)`; stipple dots ease in by width × `clamp(D − 3, 0, 1)` |
| Plait | Strand m is drawn to `clamp(D − m, 0, 1)` of its unit arc; the groove eases in by width × `clamp(D − 3, 0, 1)`; the trunk's width multiplier is a continuous function of `d` |
| Orbit | Epicycle k is weighted `f_k = clamp(D − k + 1, 0, 1)`; the swell is `1 + 0.5·clamp(D − 3, 0, 1)` |

**Sprout and Drift growth units, and the chain units of the six lab Forms, are cooked once at the unit's ceiling and then truncated to `d`.** A single code path does this, so rising never re-runs those operators. It only truncates and recomputes widths. Line re-cooks only the pool window. Echo re-cooks only its ghost.

**Hierarchy rule** (every Form with growth; Burin, Plait and Orbit set their own Night alphas per family instead of `0.72^(g−1)`, and Orbit puts its whole trail in gen 1 with tone buckets 1/2/3 by thirds, §2.3.13–§2.3.15):
- **Generation 0** (the seed or trunk) is always drawn and is never affected by crowding.
- **Generation g ≥ 1** has alpha `α_form·0.72^(g−1)` on Night and `·0.78^(g−1)` on Paper.
- Tone depth bucket `= min(g, 4)`, so `d01 = bucket/4`.

#### 2.3.3 Line: Bare and Roughen merged

- **At depth 0** the output is exactly the spine ribbon: stations only, with no wobble.
- **Above depth 0** it applies an **offset field along the normal** of the full-resolution spine:
  ```
  h_k      = 24 · 2^(1−k) sp                    level-k node spacing (k = 1..5)
  s_{k,i}  = (i + ½) · h_k                       absolute arc positions
  D_{k,i}  = h_k · A(s) · 0.62^(k−1) · [ (2·r(Geometry, k, i) − 1)·(0.4 + 1.2·p(s)) + 0.7·asym(s) ] · W_k(s)
  off(s)   = Σ_k Σ_i D_{k,i} · max(0, 1 − |s − s_{k,i}| / h_k)          (hat bases)
  point    = spine(s) + off(s)·n(s)              n = spine normal smoothed over 6 sp
  ```
- **Output points.** These are the stations, plus lattice points at absolute multiples of `δ(s)`:

  | `ceil d(s)` | `δ(s)` |
  |---|---|
  | ≤ 3 | 2 sp |
  | 4 | 1 sp |
  | 5 | 0.5 sp |

  There are no lattice points where `d(s) = 0`. The lattices nest, so chunks splice exactly after a local re-cook. The step from depth 0 to 0.0625 is continuous, because the new points lie on the spine with an offset of about 0.
- **Roughness:** `A(s) = 0.10 + 0.32·smoothstep(0.6, 2.4, v_n(s))`. A stroke that accelerates crackles at its fast end. P1 adds `+0.08·tK`.
- **Asymmetry:**
  - Pen with tilt: `asym = clamp(dot(tiltVec, n(s)), −0.6, 0.6)`, so bumps lean toward the pen's lean.
  - Otherwise: `0.35·sign(κ̄(s))`, oriented so bumps erode toward the outside of curves.
- **Closed loops:** the seam is welded, and `off(s)` is multiplied by `smoothstep(0, 12, s − s0)·smoothstep(0, 12, L − s)`.
- **Width:** the nib width at `s`, with the envelope applied at tessellation.

#### 2.3.4 Echo: Self-Koch

**Generator.**
- RDP of the spine with ε = 3% of the chord, giving 4–12 vertices. RDP keeps the corners you drew.
- If it gives fewer than 4, resample uniformly to 5. If it gives more than 12, raise ε.
- The generator is normalised to a unit chord.

**Depth.**
- Depth n means n Koch substitutions of the generator into itself, so the curve has `nSeg^(n+1)` segments.
- **At depth 0** the crystal is the generator itself, which is the stroke.
- The crystal's alpha is `smoothstep(0, 0.5, d_E)`, so it fades in while it unfolds off the trunk.

**Shape rules.**
- **Snowflake flip:** if `abs(signedArea(G)) < 0.05`, alternate copies flip.
- **Caps** (the ceiling for the halo):
  - `nSeg^(n+1) ≤ 32k`
  - growth ratio `(arcLen/chord)^(n+1) ≤ 40`
  - on closed loops, `3·nSeg^(n+1) ≤ 32k`
- **Closed loop** gives a snowflake:
  - Split the loop into thirds by arc length to get triangle A, B, C.
  - The generator is the RDP of arc A→B.
  - It recurses on all three sides, with bumps facing away from the centroid.
- **Short open stroke** (chord < 12 sp and not closed): falls back to Line at the same depth.

**Rendering.**
- **Width:** `meanW·(0.35 + 0.9·p(u))·0.78^n`, where `u` is the normalised arc on the crystal (Echo is global).
- **Trunk:** the spine at α 0.55 and width ×0.6.
- **Crystal:** generation 1 for the glow budget. Tone depth is `min(1, d_E/5)`.

**Live behaviour.**
- **Ghost:** each frame, the current spine is resampled *uniformly* to 8 vertices and drawn at depth `min(d_E, 3)` and α 0.3. That is at most 7⁴ = 2401 segments. The ghost morphs smoothly and never pops.
- **During a hold** the ghost deepens with the pool.
- **When the live spine enters closure** the ghost snaps into the snowflake, so the loop visibly clicks shut.
- **At lift:** the true RDP crystal folds out from level 0 to `d_E` over `T = clamp(350 + 120·d_E, 350, 1100)` ms, using easeOutCubic. It is a per-vertex lerp from cached parent anchors (§6.6). The ghost dissolves over the first 150 ms.

#### 2.3.5 Sprout: developmental L-system

The demo's three rule strings are kept verbatim as **branch templates**. Depth now means *developmental* growth rather than parallel rewriting: apices extend and new generations bud, so `n + f` is continuous and existing branches never move.

- **Anchors.**
  - Anchors sit at absolute arc positions: `s_0 = s0 + Δ(s0)/2`, then `s_{j+1} = s_j + Δ(s_j)`.
  - An anchor is created once the spine has settled past `s_j + 12 sp`.
  - At lift, anchors with `s_j ≤ L − 6` are kept. So lift only *adds* growth and never removes any.
  - The chain is sequential. Its cursor lives in the resumable operator state.
- **Spacing:** `Δ(s) = clamp(lerp(46, 18, p̄)·(1 + 1.2c̄)·(1 − 0.3·min(1, |κ̄|/0.05)), 14, 72)` sp. `p̄`, `c̄` and `κ̄` are averaged over ±12 sp.
- **Templates.** The F's outside brackets are the segments of a branch. Each bracket is a child branch spawned at the node where it appears, turned by its signs (`+` is θ, `++` is 2θ).

  | Condition | Template | Segments | Children |
  |---|---|---|---|
  | `abs(κ̄) < 0.012` rad/sp | fern `F[+F]F[-F]F` | 3 | node 1 on the + side, node 2 on the − side |
  | otherwise | coral `F[+F][-F]F` | 2 | node 1 on both sides |
  | radial seed | bush `FF[+F][-F][++F][--F]` | 2 | node 2: four children at ±θ and ±2θ, capped at generation 3 |

- **Lengths.**
  - Primary: `ℓ_1 = (20 + 2S)·(0.4 + 1.3p_j)·(0.6 + 0.8·r(Length, j))·(1 − 0.3c_j)` sp.
  - Each child: `ℓ_{g+1} = 0.55·ℓ_g·(0.8 + 0.4·r(Length, j, branchId))`.
  - Lengths depend on generation, never on total depth. A fine nib grows fine sprouts.
- **Growth:** at anchor j, generations ≤ n are full, generation n+1 is drawn to `f·ℓ`, and deeper generations are absent. A child exists only once its parent has been drawn past the child's node.
- **Angle:** `θ_j = 16° + 26°·smoothstep(0.25, 0.85, p_j)`. Pressing harder opens the branches. Each turn is ×`(0.75 + 0.5·r)`.
- **Side of the primary branch**, in order:
  1. If `|CS_j| > 0.15`: `σ = −sign(CS_j)`, so it grows **away from neighbouring ink**.
  2. Otherwise, the convex side with probability 0.7.
  3. On straight runs (`|κ̄| < 0.004`), alternate from the previous anchor.
- **Lean:** the primary heading is `σ·n(s_j)` rotated by `λ = 0.7·tilt_along_tangent + (r − 0.5)·0.5 − 0.5·smoothstep(1.0, 2.4, v_n(s_j))`. The last term turns toward the trailing tangent, so fast strokes look wind-swept and slow ones grow upright.
- **Tropism:** each segment is walked in substeps of ≤ 3 sp. The heading turns by `0.008·cross(h, up)` rad per sp, where up is screen-up at commit, rotated by `recipe.rot`. Curvature is defined per sp, so subdividing never changes the shape.
- **Width:** each branch tapers linearly along its own arc, from `w_b·0.66^(g−1)` at its base to `w_b·0.66^g` at its tip. Here `w_b = w(s_j)·E_in(s_j)`, with a floor of 0.35 sp. Because width is a function of position along the branch, truncation is exact.
- **Alpha:**
  - Branches: `0.92·0.72^(g−1)` on Night (`0.78^(g−1)` on Paper), ×glow(c).
  - Trunk: α 1.
- **Budget:**
  - Each sprout is capped at 900 points at its ceiling; above that, its ceiling drops.
  - The stroke's causal total is 24k. Once it is spent, no new anchors are created, and the trunk continues.
- **Sprout v2** (`sprout.v2.ts`; `CURRENT_V.sprout = 2`, so every new Sprout stroke uses it; v1 stays for the documents drawn with it, §7.5 rule 8):
  - **Why.** Branches of different generations sit in different batches, so on Night a child ribbon lying on its parent *adds*. v1 started each branch on its parent's centreline, so every node stamped a white dash along the branch and every primary a bead on the trunk.
  - **Fix.** A branch is drawn from where its centreline clears the parent's edge, and it widens only as the room allows: `w ≤ (2·(d − 0.2) − w_par)/|cos φ|` beside a parent, `w ≤ √((2·(d − 0.2))² − w_par²)` off a round end, until its own taper takes over. Every ancestor constrains, the tightest one per point. The crotch reads as one shape, the branch peeling off its parent's edge.
  - Clearance is cooked once at the ceiling and is a function of position along the branch, so truncation stays exact. Branches of different trees that cross still add, like any two crossing lines of light.
  - Everything else is v1: anchors, templates, angles, lengths, tropism, alphas, tones and budgets. The v1 width collar is gone.

#### 2.3.6 Drift: attractor wake

- **Stations:** `σ_0 = s0 + 2.5`, then `σ_{m+1} = σ_m + 5·(1 + c(σ_m))` sp.
- **Ceiling walk:** `n_max = round(150·(0.35 + 0.9p_m)·(1 − 0.5c_m))` steps of `1.7/z` doc.
- **Drawn length:** `n(d) = n_max·N(d)/150`, where `N(d) = 18·min(d, 1) + 26.4·max(0, d − 1)`. So N(6) = 150 matches the demo's maximum, and the last step is partial.
- **Field:** `F = normalize(curl ψ)` with `curl ψ = (∂ψ/∂y, −∂ψ/∂x)`.
  - ψ is 2-octave hand-written gradient noise (the second octave at half amplitude), seeded by `hash32(seed, Ch.Field)`, with analytic derivatives and a 256-entry gradient table.
  - It is divergence-free, so filaments never pool.
  - **Wavelength:** λ = 280 sp at the commit zoom (`λ_doc = 280/z`). Zoom out for broad currents, zoom in for fine eddies.
- **Momentum:** `dir_k = normalize(F(x_k) + 0.8·smoothstep(0.3, 2, v_n)·0.95^k·T_m)`. A fast stroke throws its wake forward.
- **Jitter:** rotate by `(r − 0.5)·0.28` rad, using a 64-entry cos/sin table.
- **Width:** `0.55·w(σ_m)·E_in(σ_m)·(1 − k/n)²`. It is recomputed whenever the filament is truncated.
- **Alpha:** 0.38 on Night and 0.30 on Paper, ×glow(c). Geometry never depends on the ground.
- **Colour along the filament:** split into thirds by step index, with `d01` 0.2 / 0.5 / 0.8, so the wake deepens in colour as it fades.
- **Trunk:** the spine at width ×0.8, α 1.
- **Drift combs along existing ink** is P1 (§11).
- **Drift v2** (`drift.v2.ts`, `CURRENT_V.drift = 2`; `drift.v1.ts` kept so old documents cook unchanged). Stations, field, momentum, jitter, step counts, lengths, tapers, tones, alphas and budgets are v1’s; only where a filament starts and how wide it may be near the trunk differ:
  - Each filament starts just outside the trunk edge (half width + 0.2 sp), on the side the field pushes toward; where a corner or hairpin would put the start inside the trunk it is pushed further out. Radial seeds start their 24 filaments off the dot’s rim.
  - Each point gets a width limit, computed once at the ceiling, from its room to the trunk edge over the stretch it pours off (s ± 6 sp). A filament leaving square to the stroke opens to full width at once; one running alongside stays a hairline on the edge until it peels away; one looping back under that stretch passes as a hairline.
  - The limit depends only on position along the filament, so truncation stays a prefix and depth stays continuous; each filament writes exactly v1’s points.
  - Result on Night: the trunk keeps its ink colour instead of adding into a near-white core. Filaments the field carries across a different part of the stroke still brighten where they cross (as with Sprout v2).

#### 2.3.7 Ripple: interference contours

*Shipped as Ripple v2, promoted from lab prototype v107. The brief `lab/forms/briefs/ripple.md` and the header of `src/ink/operators/ripple.v2.ts` are authoritative; Ripple v1 never had an operator, so v1 recipes keep cooking as Line.*

Contour rings run parallel to the stroke on both sides, ever wider apart outward, and wrap open ends in round caps. Each ring breathes along the arc in a slow sine whose phase lags ring by ring, so neighbouring rings, and the rings of neighbouring strokes, beat into moiré. On Night it is an interference glow; on Paper, survey-map contours.

- **Rings:** `K(D) = 2·D·(0.6 + 0.8p)`, up to 10 per side; ring `k` has weight `clamp(K − k + 1, 0, 1)`, arriving as a centred dash that lengthens until it joins (no pops).
- **Spacing:** ring `k` at `b·1.18^(k−1)`, `b = 1.2·w̄ + 3` sp. Breathing wavelength `32 + 2.5S` sp, phase lag 0.35 rad per ring; amplitude 7 %–27 % of the offset with speed (below the 43 % at which rings could cross).
- **Placement:** both sides for open strokes; closed loops shrink inward to a bullseye until collapse, plus outward; the seam joins exactly.
- **Cleanup:** a soft fade against the spine within ±40 sp gives mitred V's inside corners (replaces the spatial hash + Chaikin, which could not stay exact under incremental cooking).
- **Look:** inner rings hairlines, outer rings bands (0.38 × the gap, ≤ 3.2 sp); odd rings ≈ 1.7× brighter; tone alternates buckets 3/4 so Spectral steps per ring and flickers.
- **Radial seed:** a bullseye spiral of arcs; a second family 1.6 gaps off-centre fades in over depth 0.5–2 and beats against it.

The draft P1 numbers (`round(1.4·d)` rings, ratio 1.22, reach 24 sp) gave a thin 2–3-ring tube at base depth and a cleanup that could not see across corners; the brief records each departure.

<details><summary>Original P1 sketch</summary>


- **Rings:** `round(1.4·d)`.
- **Spacing:** `δ_i = (1.2·w̄ + 3)·1.22^i` sp.
- **Placement:** both sides for open strokes. For closed loops, inward until collapse plus outward.
- **Cleanup:** drop points within `0.9δ_i` of the seed (spatial hash), then apply Chaikin once.
- **Noise:** displacement of `0.4i` sp.

</details>

#### 2.3.8 Radial seeds: tap and bloom

A stroke with `L < 6 sp` is radial (`recipe.radial = true`).
- A **tap** (< 250 ms) grows at base depth.
- A **hold** blooms: its pool sits at `s = 0` and rises like any other pool.

| Form | Radial seed |
|---|---|
| Line | At depth 0, a round dot of diameter `w(p)`, so stippling survives. Above depth 0, 6 rays at `60°·i + 60°·r`, each of length `(8 + 1.2S)·(0.5 + p)` sp, crackled with Line's field. |
| Echo | A hexagonal snowflake of radius `(6 + S)·(0.6 + 0.8p)` sp. The generator is a 4-segment Koch bump of height `0.29·(0.6 + 0.8p)`, with bumps outward. |
| Sprout | A bush burst: 5 primaries at `72°·i + 72°·r ± 12°`, using the bush template, capped at generation 3. |
| Drift | Radial emission: 24 filaments at `15°·i` plus jitter, with momentum radially outward. |
| Craze | A dried drop: a film disc of radius `R = (7 + 1.6S)·(0.65 + 0.75p)` sp, 6–8 radial cracks from a centre offset by up to `0.2R`, a ring crack at `0.55R`, short radials from ring to rim, then widening (§2.3.10). |
| Plume | A tuft of 12 curled down barbs, fringed with barbules above depth 1, with 12 more between them above depth 2: a powder-down rosette. |
| Caustic | A glint: 12 rays at `30°·i` plus a random rotation, from the dot's rim, tripled above depth 2, around a 4-cusp astroid caustic at `0.3·ℓ(D)`. |
| Burin | A dot, then a stippled disc: ring k at radius `(3 + 0.4S)·k` sp of `6k` dots, easing in by width over `D ∈ [(k − 1)/2, k/2]` (a mezzotint rocker spot). |
| Plait | A trefoil knot `x = sin t + 2 sin 2t, y = cos t − 2 cos 2t` of scale `(8 + 1.2S)·(0.5 + p)/3` sp per unit, with alternating over/under gaps; it ties itself as a prefix over depth 0–2 and takes its groove over 2–4. |
| Orbit | A five-loop spirograph rose, `(1, 1)` and `(−4, 0.55)` scaled by `1.25R`, drawn as a prefix to `min(1, D/2)` of its parameter; its moon `(+6, 0.06)` fades in over depth 2–3, then it swells. |

#### 2.3.9 Context: ink that knows about other ink

**Occupancy.** A sparse multi-level hash grid in doc space, with integer keys `(level, ix, iy)`.
- Each stroke reads the level whose cell is about 8 sp at its own `z`.
- **On add, and on load,** a stroke's **spine capsules** are splatted into levels ±2 of its own level as `Σ w·segLen` per cell. The capsules come from samples plus nib width, so no cook is needed. They are subtracted on removal.
- A stroke never sees itself.

**Crowding.**
- `c = smoothstep(0.02, 0.35, cov48)`, where `cov48` is the inked area within 48 sp divided by the disc area.
- `CS = c16(x + 24n) − c16(x − 24n)`, where `c16` uses a 16 sp disc.
- Both are computed at sample time from the live filtered position and tangent, and are **frozen into the sample's `C` and `CS` channels**. Later edits never change an existing stroke.

**Crowding never touches generation 0.** Going over an area again always intensifies the seed line. Only growth is restrained:

| Use | Mapping | Pri |
|---|---|---|
| Sprout | Spacing ×`(1 + 1.2c)`; branch length ×`(1 − 0.3c)`; side away from ink via `CS` | P0 |
| Drift | Station spacing ×`(1 + c)`; filament length ×`(1 − 0.5c)` | P0 |
| Glow budget, all growth with g ≥ 1 | Alpha ×`1/(1 + 0.6c)` | P0 |
| Craze | Band ×`(1 − 0.35c)`; the band shrinks on the side of nearby ink (`CS`) | P0 (added) |
| Plume | Pitch ×`(1 + 0.6c)`; barbs ×`(1 − 0.5c)`; the vane facing ink narrows (`CS`) | P0 (added) |
| Caustic | Unit spacing ×`(1 + c)`; rays toward side ink shorten (`CS`) | P0 (added) |
| Burin | Spacing ×`(1 + 0.8c)`; ticks on the crowded side shorten (`CS`) | P0 (added) |
| Plait | Period ×`(1 + 0.4c)`; the braid flattens on the crowded side (`CS`) | P0 (added) |
| Orbit | Radius ×`(1 − 0.4c)`; loops lean away from side ink (`CS`) | P0 (added) |
| Drift combs along existing ink (frozen orientation snapshot) | `normalize(curl + 1.2·T_ink)` | P1 |
| Drift vortex inside a closed loop | The field turns tangential inside the loop | P1 |
| Sprout collision | An F step stops on an occupied cell | P1 |
| Enclosure | A stroke inside a closed loop clips to it | P2 |

**Closed loops:**
- **Line:** seamless weld.
- **Echo:** snowflake.
- **Sprout:** grows outward automatically, because "convex side" means outward on a loop.
- **Drift:** unchanged in P0.
- **The six lab Forms** never read `closed`: every loop behaviour comes from curvature, so tight open curls behave the same way. Craze makes a cracked annulus; Plume an ocellus with a clear pupil; Caustic a nephroid inside the loop; Burin a shaded sphere; Plait a cord cut at the seam; Orbit a wreath that joins itself exactly.

#### 2.3.10 Craze: the stroke as a drying film

The stroke is a film that dries into a cellular **network** of cracks meeting in T-junctions, the one primitive the first four Forms lack. Night: a lava crust, brightest in the seams over the trunk. Paper: craquelure.

- **Units.** Unit j is the transverse crack at `s_j` (gen 1) plus the plate behind it, `[s_{j−1}, s_j]`. The plate carries a faint film (a gen-0 ribbon at α 0.14, welded to its neighbours at the cracks), its lengthwise split (gen 2), one or two tertiary cracks across each sub-cell (gen 3) and a longitudinal in each tertiary cell (gen 4).
- **Band and plates** (`p̄`, `c̄`, `v̄_n`, `κ̄` over ±12 sp; `fast = smoothstep(1.0, 2.4, v̄_n)`):
  ```
  h  = clamp(max(3.5, w/2 + (4 + S)·(0.55 + 0.8p))·(1 − 0.35c), 3.5, 38) sp            band half-width
  h± = h·(1 − 0.4·max(0, ±CS))·(1 ± 0.4·tilt_across)      capped at 0.8/|κ̄| on the concave side
  Λ  = clamp(2h·(0.8 + 0.7p)·(0.7 + 0.6r)·(1 − 0.4·fast)·(1 − 0.4·min(1, |κ̄|/0.05))·(corner ? 0.5 : 1), 6, 44) sp
  ```
  A corner station within ±6 sp also narrows the band ×0.7, so corners shatter.
- **Cracks.** Each crack is a straight segment in band coordinates `(s, ν)` plus a low bow and a hat wobble that vanish at its ends, mapped through `pos(s) + ν·n(s)`. A child ends on its parent's drawn polyline, so the network welds exactly and nothing dangles except at the band edge. Transverse cracks shear up to 35° with pen tilt along the stroke, ±16° at random.
- **Width and alpha.** Seams `clamp(0.26w, 0.8, 2.4)` sp, ×0.9/0.85/0.8 for gens 2–4, at α `0.55·hierarchy(g)·glow(c)`.
- **Gesture grammar.** Pressure is film thickness: bigger plates and wider seams. Speed is a thin film: shorter plates, more wobble. Lean along the stroke shears the cracks; lean across spreads the band downhill. Curvature narrows plates. Nearby ink narrows the band toward the free side.
- **Depth.** `dMax 4`, base 2. Gen g is drawn to `len·clamp(D − g + 1, 0, 1)`, centre-out for gen 1, old-to-new for gen 2. Above depth 3 the gen-1 and gen-2 seams widen ×`(1 + 0.8·clamp(D − 3, 0, 1))`. A hold is a patch of fine craquelure in a field of slabs.
- **Radial seed:** a dried drop (§2.3.8).
- **Closed loop:** a cracked annulus; the last partial plate stays whole.
- **Budget:** 160 points per plate (the ceiling drops in 1/16 steps above it); 10k per stroke, causal. Reach 60 sp: a unit reads the spine on `[s_j − 60, s_j + 50]`.

#### 2.3.11 Plume: the stroke as a rachis

The stroke is a feather's shaft. A vane of dense, parallel, gently curved barbs grows from both edges; the entry taper is the bare quill. Nothing branches.

- **Units.** Unit j is two barb pairs, at `s_j` and `s_j + Δ/2`, with pitch `Δ = clamp(3.1 + 0.07S, 3.1, 6.4)·(1 + 0.6c)` sp. Each barb is up to 4 substeps of ≤ 6 sp from a root on the shaft edge.
- **Barbs.**
  ```
  θ0 = 62° − 30°·smoothstep(0.3, 2, v̄_n)   ± 18°·ρ per 8 sp group, ± 8°·ρ per barb       angle from the shaft
  ℓ  = min(42, (8 + 1.6S)·(0.45 + 1.1p)·(1 − 0.5c))·vane(s)·(1 ± asym)·(1 − 0.5·max(0, σ·CS))   ± 30%·ρ
  ```
  `ρ = smoothstep(1.0, 2.4, v_n)`. `vane(s)` is a smooth 0.88–1.12 lattice over 24 sp cells. `asym` comes from pen tilt across the stroke, otherwise the outside of a curve is longer. The concave vane is capped at `0.8·sin θ0/|κ̄|`, which leaves a pupil inside a loop. Barbs curve 16°·(1 + 0.5ρ) toward the tip.
- **Width and alpha.** Barbs `clamp(0.16w·E, 0.45, 1.4)` sp tapering to 0.3×, as Chisel polys at the nib angle for the chisel nib. Barbules and down are 0.35 and 0.55 sp hairlines. α `0.5·hierarchy(g)·glow(c)`. Barbules fade out as the pitch drops from 1.5 to 0.75 doc units (moiré guard).
- **Gesture grammar.** Speed lays the barbs back and ruffles them into groups that sway together; slow is pristine. Pressure widens the vane. Lean makes flight-feather asymmetry. Curvature lengthens the outer vane. Nearby ink shortens barbs and narrows the vane facing it.
- **Depth.** `dMax 3`, base 2. Barbs to `ℓ·clamp(D, 0, 1)`; barbule zigzags on the first pair of each unit to `clamp(D − 1, 0, 1)`; a wavy down barb (1.4ℓ) per side on the first pair to `clamp(D − 2, 0, 1)`. A hold turns the vane downy.
- **Radial seed:** a tuft of down (§2.3.8).
- **Closed loop:** an ocellus, a fringed eye with a clear pupil.
- **Budget:** 80 points per unit (the ceiling drops above it); 24k per stroke, causal; 640 for the tuft. Reach 22 sp.

#### 2.3.12 Caustic: the stroke as a mirror

A lamp shines across the page from the side the pen leans toward, or from the top without tilt. The stroke is a polished mirror: reflected rays leave its lit face, and where it bends toward the lamp they gather on a caustic with a cusp at every curvature peak. Nothing grows from the stroke.

- **Units.** Unit j is `Δ = 8·(1 + c)` sp of arc, holding 3 rays and a 5-point segment of the caustic.
- **Optics** (per ray at arc s):
  ```
  L     lamp: pen  normalize(wt·(−tiltVec) + (1 − wt)·down), wt = smoothstep(0.1, 0.3, cos alt);  mouse / finger: down
  r     = L − 2(L·n)n                                       reflected direction
  ρ_f   = min(cos θ/(2|κ|), 400) sp, cos θ = |L·n|         focal distance; a real focus where −κ·(L·n) > 0
  ℓ_max = (24 + 2.5S)·(0.6 + 0.8p)·(1 − 0.5·max(0, CS·sign(r·n)))
  ℓ(D)  = ℓ_max·min(D, 1)·(1 + 0.6·max(0, D − 1))
  α_ray = (0.14 + 0.18p)·min(1, ρ_f/12)·smoothstep(0, 0.12, cos θ)·glow(c)·(1 + 0.3·clamp(D − 1, 0, 1))
  ```
  Scatter is `±(0.02 + 0.25·smoothstep(0.6, 2.4, v_n))` rad on each ray.
- **Caustic** (gen 1): the locus of real foci, drawn in runs that break at virtual points, beyond 140 sp, or across gaps over 40 sp. α 0.9 × how far the rays reach past the focus × `cos θ`, fading out for foci beyond about 100 sp. Width `0.35w·(0.5 + 0.5 cos θ)`, thinning with focal distance. Fast strokes break it into glints.
- **Rays** (gen 2): `clamp(0.25w, 0.7, 2.4)` sp tapering to 0.4 sp over the drawn length.
- **Gesture grammar.** Lean is the lamp: rolling the pen swings the whole fan. Curvature is the engine: tight concave bends focus close, straight runs hatch in parallel, corners cross rays in an X. Speed roughens the mirror from a razor caustic to glitter. Pressure brightens and lengthens the rays. Spectral ink disperses the fan along the stroke.
- **Depth.** `dMax 4`, base 2. Rays lengthen and brighten (×1.3 by depth 2); above depth 2 a ±2.5° pair joins each ray at α × `clamp(D − 2, 0, 1)`, so a held spot blazes.
- **Radial seed:** a glint (§2.3.8).
- **Closed loop:** a crown outward from the near side, a nephroid inside.
- **Budget:** 40 points per unit; 16k per stroke, causal. Reach 20 sp. Chisel uses the spine normal.

#### 2.3.13 Burin: engraving that follows the form

The stroke becomes an engraver's contour: short lozenge ticks (thin, thick, thin) laid **across** it on the side the light does not reach. A straight run reads as a lit cylinder, the inside of a bend as a sphere's far rim. Night: scratched film. Paper: a steel engraving, the Form's home.

- **Units.** Unit j is one hatch station, `Δ = clamp(lerp(8.5, 4.5, p̄)·(1 + 0.8c̄), 3, 11)` sp, skipped within 3 sp of a corner (the engraver's open corner).
- **Light.** Pen azimuth sets the light (`wt = smoothstep(0.1, 0.3, cos alt)`); otherwise the lamp is up-left. The shadow side is a continuous weight `smoothstep(−0.15, 0.15, σ·n·ℓ)`, so ticks migrate smoothly where the line turns. A sustained bend takes the sphere rule: its concave side is shaded on the far rim.
- **Ticks.** Length `(5 + 1.3S/(1 + max(0, S − 10)/25))·(0.5 + p)·(1 − 0.4·fast)·(0.9 + 0.2r)` sp, `fast = smoothstep(1, 2.5, v_n)`; fast ticks also skew up to 25° toward the trailing tangent. They start 0.5 sp outside the trunk edge, are ray-cast against the stroke's own trunk within ±8 sp and stop short of it, and fade out inside tight bends. Width is a lozenge, `w_t·(0.25 + 0.75·4a(ℓ − a)/ℓ²)`, with belly `w_t = clamp(w·lerp(0.22, 0.4, p), 0.5, 2.4)` sp (pen: `clamp(0.6w, 0.5, 1.4)`).
- **Families** (Night α 0.55 / 0.45 / 0.35 / 0.35 × glow): gen 1 the shadow hatch; gen 2 an infill tick (0.85ℓ) halfway to the next station (the tone doubles), plus a lit-side terminator tick on straight runs; gen 3 a +40° cross family; gen 4 the −40° family and 2 stipple dots.
- **Gesture grammar.** Pressure tightens the spacing and fattens the belly, so pressing darkens the tone as on a plate. Speed skids the burin. Lean moves the light. Curvature fans the ticks and shades bends as spheres. Nearby ink widens the spacing and shortens ticks on the crowded side. Chisel ticks are Chisel polys at the nib's edge angle.
- **Depth.** `dMax 4`, base 2. Family g is drawn to `ℓ·clamp(D − g + 1, 0, 1)`; dots ease in by width × `clamp(D − 3, 0, 1)`. A hold is a burnished patch.
- **Radial seed:** a stippled disc (§2.3.8).
- **Closed loop:** a sphere, hatched inside on the side away from the light.
- **Budget:** 40 points per unit; 16k per stroke, causal. Reach 8 sp.

#### 2.3.14 Plait: a woven cord along the line

The stroke becomes a cord. As it rises the trunk thins to a core strand and strands twine around it in the 120° rhythm of a three-strand plait, passing **over and under** with the carved gaps of a knotwork panel. Over/under occlusion is a primitive no other Form has.

- **Trunk.** Plait replaces the station trunk with a per-station width multiplier: the core thins to about `0.25w` (at most `1.2 + 0.1w` sp) by depth 1 and ×0.3 by depth 3. Depth 0 is bit-exactly the plain trunk.
- **Braid** (`fast = smoothstep(1, 2.5, v̄_n)`):
  ```
  P   = clamp(clamp(2.5w + 22, 20, 72)·(1 + 1.4·fast)·(1 + 0.4c), 20, 96) sp      period
  A   = A0·clamp(1 − A0·|κ̄|/0.8, 0.3, 1), A0 = min(0.9w + 2, 0.13P)          amplitude, capped again on tight bends; inner strands never fold
  A±  = A·(1 ∓ 0.4·tilt_n)·(1 − 0.5·max(0, ±CS))
  o_m = A±·sin(φ + 2πm/3)                                                       strand m's offset
  ```
  Crossings sit at `φ = π/6 + kπ/3`; each strand goes over, under, over, under per period. The under strand is removed for a gap around the crossing, with its ends eased to zero width, so nothing double-adds on Night.
- **Units.** Unit j is half a period. A corner station cuts the cord about `2 + w/2` sp either side, and within 12 sp of a cut the amplitude gathers to 0.4 (a whipped end). There is no rng in the braid.
- **Alpha.** Strands 0.8 × `0.88^m` × glow (peers, not a hierarchy; their tone buckets `m + 1` deepen the colour). The groove α 0.45, bucket 4.
- **Gesture grammar.** Pressure (through `w`) makes a fat, long-period rope. Speed braids loose. Lean lays the cord over to one side. Curvature shrinks the amplitude; corners cut the cord. Nearby ink flattens the braid and lengthens the period. Chisel strands make a flat tablet-woven band.
- **Depth.** `dMax 4`, base 2. Strand 0 arrives over `d ∈ (0, 1]`, strand 1 over `(1, 2]`, strand 2 over `(2, 3]`, each drawn as a prefix of its unit arc. Below depth 2 strand 0 is one unbroken strand (a two-ply twist). The carver's groove eases in over `(3, 4]`. A hold ties a thick knot.
- **Radial seed:** a trefoil (§2.3.8).
- **Closed loop:** the cord is cut at the seam.
- **Budget:** 220 points per unit (the ceiling drops in 1/16 steps above it); 20k per stroke, causal. Reach 108 sp, so the braid trails the nib by about 30–40 sp.

#### 2.3.15 Orbit: epicycles around the nib

A satellite circles the nib as it travels; its trail, a trochoid in the spine's moving frame, curls along the stroke as one unbroken rope of loops. Rising adds epicycles, so every loop grows a lace edge, like a copperplate flourish. Orbit is kinematic: its shape is the hand's motion integrated.

- **Units.** Unit j is one orbit over `[s_j, s_j + P_j]`, starting at phase 0 on `+t`, so orbits join at a bit-identical point.
  ```
  P    = clamp((10 + 2S)·(0.6 + 0.9·smoothstep(0.4, 2.4, v̄_n)), 10, 36) sp
  R    = (3.5 + 1.1S)·(0.5 + p)·(1 − 0.5·smoothstep(1, 2.6, v_n))·(1 − 0.4c) sp
  T(s) = pos(s) + swell(D)·Σ_k f_k(D)·R·ρ_k·M·(cos φ_k·t + sin φ_k·n),   φ_k = m_k·2π(s − s_j)/P_j
  (m_k, ρ_k) = (1, 1), (+6, 0.13), (+11, 0.04);   f_k = clamp(D − k + 1, 0, 1);   swell = 1 + 0.5·clamp(D − 3, 0, 1)
  ```
  `M` squashes the circle along the pen's lean (`1 − 0.6·cos alt`). The normal component on the side of nearby ink is scaled by `1 − 0.6·|CS|`.
- **Width and alpha.** Brush `0.32w'·(0.5 + 0.8v̂)`, thick on the outer sweep and thin at the inner cusp; pen `0.5w`; `w' = max(w, 0.4S)`; floor 0.35 sp. Over the trunk the width eases to 0.4×, so Night crossings stay off white. α `0.8·glow(c)`, eased in over depth 0–0.5. Each orbit is three polys by thirds, tone buckets 1/2/3, so every loop deepens in colour around itself.
- **Gesture grammar.** Speed lengthens the period and shrinks the radius: slow hands make tight round loops, fast ones cusps and waves. Pressure sets the radius. Lean makes ellipses. Curvature spreads loops outside bends; a corner swings the satellite wide. Nearby ink shrinks the loops and leans them away.
- **Depth.** `dMax 4`, base 2. The trail grows out of the trunk (a wobble, a wave, loops by depth 1); the five-lobed frill comes over (1, 2], the ten-fold scallop over (2, 3], the swell over (3, 4]. Each unit is cooked once at its ceiling and emitted as a weighted sum, so rising never re-cooks.
- **Radial seed:** a spirograph rose (§2.3.8).
- **Closed loop:** at lift the last orbit stretches to end exactly at `L`, so the wreath joins itself. On an open stroke the last orbit fades over 10 sp, so the satellite lands on the nib.
- **Budget:** 220 points per orbit (≤ 216 samples); 24k per stroke, causal. Reach 54 sp.

### 2.4 COLOR

#### 2.4.1 Choices: inks, ground, custom

Colour maths is hand-written OKLab/OKLCH (`core/oklab.ts`). Colours outside the gamut are brought back by bisecting chroma at constant L and h (8 iterations). P0 renders in sRGB only.

| Ink (sheet order) | Night L / C / h | Paper L / C / h | Variant band ± | Hue shift with depth `hd` | Reads as |
|---|---|---|---|---|---|
| **Graphite** | .90 / .015 / 250 | .30 / .010 / 255 | 3° | 0 | Silver light / pencil lead |
| **Indigo** | .74 / .13 / 262 | .42 / .11 / 238 | 8° | −10 | Cobalt glow / blue pigment |
| **Oxide** | .78 / .14 / 55 | .52 / .15 / 35 | 10° | −25 | Amber turning to ember / burnt sienna |
| **Ochre** | .88 / .13 / 88 | .82 / .15 / 92 | 6° | −8 | Sodium lamp / yellow ochre |
| **Moss** (first-run default) | .80 / .12 / 135 | .50 / .10 / 128 | 12° | +25 | Bioluminescence cooling to teal / sap green |
| **Rose** | .72 / .15 / 10 | .48 / .16 / 15 | 8° | −20 | Neon rose deepening to magenta / alizarin |
| **Spectral** | .76 / .15 / `h(s)` | .64 / .13 / `h(s)` | — | — | `h(s) = h_s + 0.2°·s + 60·d01`. The hue rides absolute arc length. |

- **Ground.** The Night | Paper switch sits in the Color sheet. `G` also toggles it. The ground is saved with the document but is not in history.
- **Custom inks.** There are two sources:
  1. **Sampling** with Alt/Option-click takes the resolved colour of the topmost stroke's poly at that point. It is a geometry hit test and never reads pixels, because additive whites belong to no stroke.
  2. **Color chip drag**:
     - `Δh = 0.75°·Δx`, `ΔL = −0.002·Δy`.
     - Once `|Δx| > 6` px, `C = max(C_ink, 0.10)`, so scrubbing from Graphite gains colour.
     - L is clamped to [0.45, 0.95] on Night and [0.25, 0.85] on Paper.
     - Release creates the ink.

  A custom ink has a ±3° band. Its other-ground twin is `L' = clamp(1.02 − L, 0.25, 0.85)`, same hue, C ×1.1, gamut-mapped. Custom inks are stored as LCh numbers in the recipe and never re-derived.
- **Recents.** The last **2** custom inks fill the Color sheet's last two tiles. **With a selection, recent slot 1 shows the selected stroke's colour.** One tap adopts it. This is how sampling works on touch and from the keyboard.

#### 2.4.2 Inferred colour

**Variant.** `k` is a monotonic counter per document and per ink.
- `φ_k = fract(0.5 + 0.618034·k) − 0.5`
- `dh = 2·band·φ_k`
- `dL = 0.06·(fract(0.5 + 0.381966·k) − 0.5)`
- Spectral uses `h_s = 360·fract(0.618034·k) + dh`. Spectral variants carry `dh = 0`; symmetry copy `i` of `n` carries `dh = 360·i/n` (mod 360), frozen in its recipe (§2.3.1).

**Lineage.** At pen-down, the new stroke inherits `k`, `dh` and `dL` from a same-ink stroke if either test passes:
1. **Proximity:** it starts within `max(6 sp, 3w)` of that stroke's spine.
2. **Recency:** the last same-ink stroke lifted less than 3 s ago and its spine is within 48 sp.

Continuing a line keeps its colour, and rapid hatching stays one family. There is **no sibling separation**.

**Tone ramps.** Here `d = d01` of the poly and `p` is the pressure bucket centre.
```
Night: L = L0 − 0.20d − 0.08(1−p) + dL     C = C0·(0.75 + 0.25p)·(1 − 0.30d)     h = h0 + hd·d + dh
Paper: L = L0 + (0.93 − L0)·(0.45d + 0.25(1−p)) + dL
       C = C0·(0.6 + 0.4p)·(1 − 0.45d)                                         h = h0 + hd·d + dh
```

**Buckets.**
- Each stroke resolves **6 pressure × 5 depth = 30** CSS colours per ground.
- Spectral resolves 36 hue (10° steps) × 5 depth = 180.
- Tables are cached per (stroke `colorRev`, ground), so nothing builds a colour string per frame.

**Paper safety.** Stroke alpha ≤ 0.85 and ink L ≥ 0.25, so stacked glazes darken without going black.

**Exposure.**
- **Local Forms** use their design alphas (§2.3) × glow(c), and gen ≥ 1 only for the glow term.
- **Echo** additionally uses `α ×= min(1, 0.55/√max(cov, 0.3))` on Night and `min(0.85, 0.6/√max(cov, 0.45))` on Paper, with `cov = Σ(w·segLen)/inkBoxArea` of the final crystal.

### 2.5 Chosen vs inferred

**The user controls:**
- nib
- size
- ink, sampled colour, or hue/tone
- ground
- Form
- base depth
- pools (hold) and Settle
- zoom
- selection and restyle
- symmetry: Free, Mirror or a 3–12-fold kaleidoscope, and its centre (the view when switched on)
- rotation (P1)

**Inference happens at four moments only:**
1. **Pen-down:** calibration snapshot, base depth, colour variant and lineage, occupancy level.
2. **Per sample:** `C`, `CS`, width, smoothing, closure state, growth.
3. **During a hold:** pools, shown by the halo.
4. **At lift:** exit taper, end flush, closure weld, Echo's generator. These animate over ≤ 120 ms, or fold out.

**Nothing is inferred after lift.**

---

## 3. Signature interactions

### 3.0 The first ten seconds

1. **Empty Night canvas.** Menu and the three chips are visible. "Draw anything. It grows." sits at 35% opacity.
2. **After 600 ms idle, on first run only**, a bundled recorded seed draws itself through the real live pipeline. It is about 1 KB and lives in `src/assets/seed.ts`:
   - a short arc in Moss/Sprout
   - a pause, while a halo swells under the virtual nib
   - botany rising from the pool
   It then rests. It never enters the document or history.
3. **The first `pointerdown` anywhere** un-grows the seed over 200 ms, and **the same event** starts the user's own stroke. The hint text fades.
4. **The first stroke** burns hot at the nib and cools behind it. Sprouts unfurl a hand's breadth behind the nib. A tap bursts into a bush.
5. **1.2 s after the first stroke**, the Form chip pulses once with "Try another Form".
6. **If no rise has happened by stroke 5**, a hint appears near that stroke's end: "Hold still to make it rise."
7. **Under reduced motion**, the seed's final frame shows statically, and the first touch removes it instantly.

### 3.1 Rise: hold still, and the ink pools

**Hold detection.**
- It runs in `ink/rise.ts`, a pure module.
- It works on **filtered positions** and on the **rAF clock**, because a still mouse or pen sends no events.
- Thresholds depend on the device. Each is multiplied by `jf = 1 + clamp((J − 0.3)/0.6, 0, 1.5)`.

| Device | Still: travel over the trailing 120 ms below | Move-on: distance from the hold point above | Pre-halo at | Pooling starts at | Pressure gate |
|---|---|---|---|---|---|
| Pen | 1.5 sp | 3 sp | 250 ms | 450 ms | Rise needs `p ≥ 0.8·p₀`. Settle when `p < 0.5·p₀`. In between, it pauses. |
| Mouse / trackpad | 1.0 sp | 3 sp | 350 ms | 600 ms | None (synthesised `p ≈ 0.9` while still) |
| Finger | 4 sp | 8 sp | 350 ms | 600 ms | None |

`p₀` is the pressure at the moment stillness began. Corner dwells last under 150 ms, so corners never trigger a hold.

**Timeline of a hold** at arc position `s_i`:

| Phase | Behaviour |
|---|---|
| **Pre-halo** | A soft halo starts to fade in at the nib. It has radius `w/2 + 6 sp` and is drawn in the ink colour with the ground's composite op. Moving cancels it at no cost. |
| **Pooling** | Pool `i` is created at `s_i`. If an earlier pool already covers that spot, `a_i` starts at `d(s_i) − base`, so it continues from the local level. Then `da_i/dt = 0.9 + 1.6·p` levels per second: pressing harder pools faster, and a still mouse gives about 2.3 levels per second. The halo's brightness tracks the local level. The growth within the pool window, `[s_i − 48, s_i + 32]`, rises live. |
| **Settle** (pen) | Easing below `0.5·p₀` drains the pool at −0.8 levels per second, down to 0. A pen can always take back an overshoot. |
| **Ceiling** | At the local realisable ceiling (§2.3.2), the halo brightens once for 160 ms (a brim flash) and pooling stops. |
| **Move on** | Moving more than the move-on threshold freezes `a_i`, and the stroke continues. Ahead of the hold the brush unloads back to base over 32 sp. A later hold at the same spot continues from the local level. |
| **Bloom** | A hold before 6 sp of travel pools at `s = 0`. On lift it becomes a radial seed (§2.3.8). If you move on instead, the stroke simply starts lush. |
| **Lift guard** | Pools are taken as they stood at `t_up − 60 ms`, so the pressure drop during lift-off never changes the result. |

**Costs.** Rising is local:
- Sprout and Drift truncate geometry that was already cooked at the unit's ceiling.
- Line re-cooks only the window.
- Echo re-cooks only its ghost.

The rise frame has the same budget as the live frame. There is no rise-specific level of detail.

**Recovery: peel undo.**
- A stroke with pools commits as **two** history entries: `add` (at base depth) and `replace` (adds the pools).
- The first Undo drains the pools with a 200 ms reverse growth. The second removes the stroke.

**Other ways to change depth.** Each is one history entry.
- Drag the Form chip: it sets base depth for future strokes, or for the selection when there is one.
- `-` / `=`: ±0.5 level, with the same target rule.

**Reduced motion.** The halo is static, depth shows in visible quarter-level steps, and there is no brim flash.

**Announcements.** At the end of a hold, aria-live says "Rose to depth 3", throttled.

### 3.2 Living ink

**Hot trail.** This is presentation only and lives in `#wet`.
- Each hot chunk draws at alpha `α·(1 + h·η(age))`, where `η(age) = max(0, (e^(−age/τ) − e^(−3))/(1 − e^(−3)))`. It reaches *exactly* 0 at `age = 3τ`.
- **Night:** `h = 0.45`, `τ = 220 ms`. The fresh trail burns like light painting and cools.
- **Paper:** `h = 0.25`, `τ = 380 ms`. Wet ink reads darker and dries lighter, as real watercolour does.
- The hot window is capped at 120 sp, tessellated in 12 sp chunks that share edges.
- **Ages:** for the trunk, `age = now − t(station)`. For growth, `age = now − born time`.
- A poly hands off to `#dry` only when its age passes 3τ.
- Off under reduced motion.

**The living wake.** Local Forms are cooked incrementally *at final quality* while you draw. Each poly records the arc position `born` it grows from and is revealed by `f = easeOutCubic(clamp01((now − t_born)/T))`.

| Form | T | Reveal kind |
|---|---|---|
| Line | 160 ms | **Morph:** points lerp from the spine to their displaced position |
| Sprout | 280 ms per generation | **Prefix:** each branch extends from its base. A child starts when its parent reaches 60%. |
| Drift | 240 ms | **Prefix** of each filament by arc |
| Craze, Plume, Caustic, Burin, Plait, Orbit | 240 ms | **Prefix** of each poly by arc |
| Echo | `clamp(350 + 120·d, 350, 1100)` ms at lift | **Morph:** per-vertex fold-out from parent anchors |

Reveal never calls an operator. It is a prefix or a lerp applied at tessellation.

**At lift:**
- The lift zones re-cook and animate in over 120 ms.
- Young growth finishes on the wall clock.
- The preview alpha is the commit alpha.
- The stroke then bakes into tiles in two phases (§6.2).

**Un-grow.** Every removal plays growth in reverse over 200 ms: deepest generations first, the spine retracting last. This covers erase, undo of an add, Delete, a peel undo of pools, and the touch withdraw.
- **Order:** affected tiles first re-render without the stroke. Then, in one rAF, the new tiles swap in and the un-grow starts in `#wet`.
- **Redo** re-grows.
- **Restyle** plays un-grow (150 ms) of the old version, then growth of the new one.
- **Rapid repeats** fast-forward.
- **New** and opening a file use a 200 ms fade of the base instead, because un-growing is reserved for ≤ 24 strokes.

**Concurrency.**
- At most 4 strokes animate at once. Older ones fast-forward.
- A camera gesture fast-forwards and bakes every animating stroke.
- Exports always use finished geometry.

### 3.3 The hand is the parameter: the Ink Grammar

The `?` sheet prints the grammar in one line:

**Speed = wildness · Pressure = weight & opening · Hold = rise · Lean = direction · Zoom = scale · Nearby ink = awareness**

| Gesture | Stroke | Line | Echo | Sprout | Drift | Color |
|---|---|---|---|---|---|---|
| Speed | Flicks give long tapers; Brush thins and dry-splits | Crackle amplitude | — | Wind-swept lean | Wake is thrown forward | — |
| Pressure | Width | Displacement amplitude | Width | Branches open, lengthen, pack tighter | Longer filaments | Brighter and richer; pooling rate |
| Hold | Seated round end | Pools → crackle | Pools → deeper crystal | Pools → lusher buds | Pools → smoke pours | Halo |
| Ease off during a hold (pen) | — | Settle | Settle | Settle | Settle | — |
| Lean (tilt/azimuth) | Chisel angle; shading (P1) | Bumps lean toward the tilt | — | Branches lean | — | — |
| Curvature | Corners kept crisp | Erosion to the outside of curves | Generator keeps your corners | Fern vs coral; convex side | — | — |
| Closing a loop | Weld ring; tapers dropped | Seamless weld | Snowflake | Grows outward | — | — |
| Zoom | Finer nib | Finer coastline | Finer crystal | Finer sprouts | Field wavelength | — |
| Nearby ink | Seed is never dimmed | — | — | Grows away from neighbours; sparser and shorter | Sparser and shorter | Lineage keeps the family; glow budget on growth |

The six lab Forms, on the same rows (§2.3.10–§2.3.15):

| Gesture | Craze | Plume | Caustic | Burin | Plait | Orbit |
|---|---|---|---|---|---|---|
| Speed | Thin film: finer, more jagged crazing | Barbs laid back and ruffled in swaying groups | Rougher mirror: razor caustic → glitter | Burin skids: ticks shorten and lean back | Braids loose (longer period) | Longer period, smaller radius: loops → cusps and waves |
| Pressure | Thick film: bigger plates, wider seams | Wider vane | Brighter, longer rays | Tighter spacing, fatter belly: darker tone | Fat, long-period rope | Larger loops |
| Hold | Pools → fine craquelure, widened seams | Pools → barbules and down | Pools → rays lengthen, brighten and triple | Pools → cross-hatch and stipple | Pools → a thick knot | Pools → lace and swell |
| Ease off during a hold (pen) | Settle | Settle | Settle | Settle | Settle | Settle |
| Lean (tilt/azimuth) | Along: cracks shear; across: band spreads downhill | Flight-feather asymmetry | **The lamp**: the fan swings with the pen | **The light**: ticks move to the shadow side | The cord lies over | Loops squash into ellipses |
| Curvature | Plates narrow; corners shatter | Outer vane longer; pupil inside | Concave bends focus; corners cross in an X | Ticks fan; bends shade as spheres; open corners | Amplitude shrinks; corners cut the cord | Loops spread outside bends; corners swing wide |
| Closing a loop | Cracked annulus | Ocellus | Nephroid inside, crown outside | Shaded sphere | Cut cord at the seam | Wreath that joins itself |
| Zoom | Finer crazing | Finer plumage | Finer focus | Finer engraving | Finer braid | Smaller loops |
| Nearby ink | Band narrows toward the free side | Shorter barbs; the vane facing ink narrows | Rays toward ink shorten | Wider spacing; shorter ticks toward ink | Flatter on the crowded side; longer period | Smaller loops leaning away |

All of this is personal: the learner maps *your* lightest and heaviest touch, *your* typical speed and *your* hand's tremor onto the full range.

### 3.4 Tap a kind, drag an amount

**One rule for all three chips:**
- **Tap** opens the chip's sheet, where you choose a kind.
- **Drag** bends that primitive's single amount:

  | Chip | Drag |
  |---|---|
  | Stroke | Vertical drag sets size |
  | Color | X scrubs hue, Y scrubs tone |
  | Form | Vertical drag sets base depth |

- A 6 px dead zone separates tap from drag.
- Long-press, 500 ms without moving, shows the chip's label and its drag: "Form · drag ↕ to deepen".
- **Target rule:** with a selection, the drag bends the selection, relatively and per stroke. Otherwise it bends the tool. `[` `]` and `-` `=` follow the same rule.

**Sheets show your own stroke.**
- Every tile in the Stroke, Color and Form sheets is a render of **your last committed stroke** through that option, cooked at tile quality (≤ 2.5k points).
- The last stroke is used only if `40 ≤ L ≤ 2000` sp and its aspect ratio is between 1:4 and 4:1. Otherwise a stock seed squiggle stands in.
- Nib tiles render at true size.
- **Labels are always shown.**
- In P0 the tiles are static renders, cached by (recipe, option, ground). Staggered rise animation is P1.

**Select.** Selecting is never done with the drawing contact.

| Device | Select one | Lasso | Add | Deselect |
|---|---|---|---|---|
| Desktop (mouse, trackpad, tablet pen) | Mod-click on ink | Mod-drag | Shift with Mod | `Esc`; Mod-click on empty canvas; or start drawing outside the selection, which deselects and draws in one gesture |
| Pen mode (iPad, Surface) | One-finger tap on ink | One finger held still 350 ms, then dragged | Tap more ink | Tap empty canvas; or draw with the pen outside the selection |
| Touch-only | Double-tap on ink. The first tap's seed un-grows (120 ms), with no history entry. | Double-tap, then drag | Double-tap more ink | Double-tap empty canvas; or draw outside the selection |

- **Mod** is ⌘ on macOS and Ctrl elsewhere.
- **Lasso rule:** a stroke is selected if ≥ 50% of its spine stations fall inside.
- **Hit rule:** the spine capsule, then cooked polys with effective alpha ≥ 0.3.

**Selection state.**
- Selected strokes are **lifted** out of the tiles into the selection layer (§6.2). The rest of the drawing dims to 45%.
- Dashed bounds and a 1 px accent outline on the selected ink show on the overlay.
- The dock gets an accent outline. **Delete** appears.
- Menu and the view chip hide. aria-live announces the count, so there is no count badge.

**Restyle.** With a selection:

| Action | Effect |
|---|---|
| Tap a nib tile | Re-cook |
| Tap a Form tile | Re-cook with the same seed, base depth and pools |
| Tap the selection's own Form tile again | **Reseed**: `seed' = hash32(seed, ++counter)`, "another Sprout" |
| Tap an ink tile | Re-raster only |
| Chip drags | Bend size, depth or hue/tone relative to each stroke |
| `R` | Reseed the selection, or the last stroke when nothing is selected |

- **Live previews:** during a chip drag, selections of ≤ 12 strokes re-render live in the selection layer at 30 Hz. Larger selections update on release.
- **History:** each change is exactly one `replace` command, played as a restyle morph.
- **Lift cap:** selections larger than 200 strokes or 2M cooked points are not lifted. They show bounds and outlines only, without dimming, and restyle on release.

**Sample.** There are two routes, and neither is ever accidental:
1. Alt/Option-click on ink, on desktop.
2. Recent slot 1 in the Color sheet shows the selection's colour.

**P1 additions to selection:**
- Move: Mod-drag on selected ink, or a finger drag on selected ink in pen mode.
- Duplicate: Alt-drag or Mod+D.
- Scale and rotate: a two-finger pinch or twist that starts inside the bounds, or Shift-drag on a corner on desktop.
- Drag a tile out of a sheet onto ink, to restyle that stroke. There is no hover preview; the target is outlined.

### 3.5 Night and Paper: two physics, one drawing

One tap on the Color sheet switch, or `G`, cross-fades over 400 ms between two physics:
- **Night** composites ink additively (`lighter` / `plus-lighter`). Overlaps glow like long-exposure light, and a ¼-resolution bloom lets dense ink read as light rather than as flat white (§6.7).
- **Paper** composites it as transparent pigment (`multiply`). Overlaps glaze like watercolour. Indigo (≈ `#1D5B8A`) over Ochre (≈ `#E8C04A`) gives ≈ `#1A4428`, a real green, at no per-pixel cost.

The recipes are the same on both grounds. Each ink has designed ramps for each, so the second image holds together. Geometry never depends on the ground.

---

## 4. Complete UI inventory

| Control | Location | At rest | While drawing | On demand | Behaviour |
|---|---|---|---|---|---|
| **Menu mark** | top-left | ✓ (hidden during selection) | hidden | Menu sheet | New · Open… · Save project · Export image · Share timelapse · Copy remix link · Recent ▸ · Replay · Gestures & keys. The not-autosaving dot rides on the mark. |
| **Stroke chip** | dock | ✓ | hidden | Stroke sheet | 40×28 glyph: an S-curve in the current nib, size and ink. **Tap** opens the sheet. **Vertical drag** sets size. **In erase mode** the glyph becomes an eraser with an accent outline, and one tap returns to the last nib without opening the sheet. |
| **Color chip** | dock | ✓ | hidden | Color sheet | Glyph of the current ink's ramp on the current ground. **Tap** opens the sheet. **2D drag** sets hue (x) and tone (y), creating a custom ink. |
| **Form chip** | dock | ✓ | hidden | Form sheet | Glyph of a tiny squiggle grown at the current base depth. **Tap** opens the sheet. **Vertical drag** sets base depth. While symmetry is on, a small spoke badge (state, not a control) shows Mirror or the fold count. |
| **Undo** | top-right; on phones, the trailing end of the dock | after the first stroke | hidden | — | Tap to undo. A risen stroke peels: pools first, then the stroke. P1: long-press repeats every 150 ms. |
| **Redo** | beside Undo | after an undo, until the next new command | hidden | — | |
| **View chip** | bottom-right; on phones, the leading end of the dock | when zoom ≠ 100%, or ink exists but none is in view | hidden | — | Shows "140%", or an arrow pointing to the ink, or both. **Tap:** fits the content if no ink is in view, otherwise resets to 100%. **Long-press:** fits the content. |
| **Delete** | just above the selection's bounds; on phones, the leading dock slot | selection only | hidden | — | Deletes the selection (un-grow). |
| Stroke sheet | grows out of its chip | — | — | ✓ | Pen · Brush · Chisel (· Charcoal P1) · Erase, as labelled live tiles. Drag the active tile vertically to set size. |
| Color sheet | grows out of its chip | — | — | ✓ | 7 inks and 2 recents as labelled tiles, plus the Night \| Paper switch |
| Form sheet | grows out of its chip | — | — | ✓ | Line · Echo · Sprout · Drift · Craze · Plume · Caustic · Burin · Plait · Orbit · Ripple as labelled live tiles: eleven, in two rows (6 + 5) on desktop and tablet, a 3-column grid on phones (the one sheet over the 9-tile cap, §13). Tooltips name the key (1–9, 0). Re-tapping the selection's Form tile reseeds it. Below the tiles, the **Free \| Symmetry** switch: tap toggles, drag sideways steps the folds (§2.3.1). |
| Menu sheet | top-left | — | — | ✓ | Items listed above. Recent: the last 12 documents with date, a 96 px thumbnail, open, and delete. |
| Help sheet | full sheet | — | — | `?`, F1 or the menu | Ink Grammar; Keys (desktop) or Gestures (touch), with labels from `navigator.keyboard.getLayoutMap()` where it exists; **Reset calibration** |
| Toast | above the dock | — | — | listed events only | **New:** "New canvas. The last one is in Recent." **Open / drop:** "Opened ⟨title⟩". **Export:** a progress toast with **Cancel** while it takes > 300 ms, then "Image saved". **Share timelapse:** "Recording timelapse…" with progress and **Cancel**; then on a phone or tablet whose share sheet takes files "Timelapse ready" with **Share** (20 s), and after a closed sheet "Timelapse ready" with **Save** (20 s); else "Timelapse saved"; without video support, "This browser can’t record video, so here is an image". **Copy remix link:** "Remix link copied", or "Too big for a link. Save the project to share it." with **Save**, or "Couldn’t copy the link". **Remix link opened:** "Opened ⟨title⟩" (or "a shared drawing"); a damaged one: "That link is damaged or incomplete". **Autosave failure:** "Not autosaving" with **Save**. **Pen mode:** on the first finger pan of a session, "Fingers pan while a pen is in use" with **Draw with fingers**. 6 s; one at a time. |
| Hints | in context | — | — | at most 5, ever | (1) "Draw anything. It grows." with the first-run seed. (2) "Hold still to make it rise." at stroke 5 if there has been no rise. (3) The Form chip pulses once, "Try another Form", 1.2 s after the first stroke. (4) A navigation hint on the first off-screen stroke or after 10 strokes. (5) "Share it: ⇧P makes a video of it growing" (touch: "Share it: Menu → Share timelapse") at the first 4.5 s pause once the drawing has 6 strokes, never if Share timelapse or Copy remix link was ever used (§13 After the build #13). One at a time, never while drawing. Each is shown once, dismissed by doing the action or after 4 s, and remembered in prefs. |
| *Feedback (not controls)* | at the nib / pointer | — | ✓ | — | **Nib cursor:** true width and shape in the ink colour; Chisel shows an oriented bar that follows azimuth live; it replaces the demo's crosshair. **Rise halo**, drawn as ink. **Weld ring** at the start point when closure is on. **Lasso path.** **Eraser ring**, with a doom mask over the strokes that will go. **Selection bounds and outlines.** |

**Chrome behaviour:**
- **On canvas contact** all chrome fades to 0 in 90 ms, stops taking input, and is then set to `visibility: hidden`, so its backdrop blur costs nothing during drawing.
- **It returns** over 220 ms after 700 ms with no contact, so fast hatching never makes it flicker.
- **Early return:** a mouse within 80 px of the dock, or a pen hovering near it, brings it back at once.
- **Transitions** take 160 ms with `cubic-bezier(.2,.8,.2,1)`. Sheets grow out of their chip (scale .96 → 1, plus a fade). Nothing bounces.

**Wireframes**

Desktop, at rest (first run):
```
+--------------------------------------------------------------------------------+
| (R)                                                                  (<-) (->) |
|                                                                                |
|                       ~~~Y~~~Y~~Y~~(o)    <- recorded seed draws itself, pools  |
|                          Draw anything. It grows.                              |
|                                                                                |
|                                                                                |
|                                                                       [140%]   |
|                             +-------------------+                              |
|                             |  [~]   [o]   [Y]  |                              |
|                             +-------------------+                              |
+--------------------------------------------------------------------------------+
 (R) menu   (<-) undo (after the first stroke)   (->) redo (after an undo)
 [~] Stroke  [o] Color  [Y] Form   tap = choose a kind, drag = bend its amount
 [140%] view chip: only when off 100%, or as "-> ink" when no ink is in view
```

Desktop, Form sheet open (tiles are your last stroke, grown):
```
              +-------------------------------------------------------+
              |  [~~~~~~]   [/\/\/\]   [Y.Y.Y.]   [))))))]   [#|#|#]   |
              |    Line       Echo     *Sprout     Drift      Craze    |
              |  [\\\\\\]   [>>>>>>]   [//////]   [XXXXXX]   [@@@@@@]  |
              |   Plume     Caustic     Burin      Plait      Orbit    |
              +----------------------------v--------------------------+
                             +-------------------+
                             |  [~]   [o]  ([Y]) |    drag [Y] up = deeper base, down = shallower
                             +-------------------+
```

Stroke sheet and Color sheet:
```
  +------------------------------------------+   +------------------------------------------------------+
  | [~~~~]  [~~~~]  [====]   |   [ (x) ]      |   | [###] [###] [###] [###] [###] [###] [###] | [##] [##] |
  |  Pen    *Brush  Chisel   |    Erase       |   | Graph Indig Oxide Ochre *Moss  Rose Spect | recents   |
  |  (drag the active tile up/down = size)    |   |                ( *Night | Paper )                     |
  +------------------------------------------+   +------------------------------------------------------+
```

Drawing (no chrome):
```
+--------------------------------------------------------------------------------+
|                                                                                |
|              ~~~~Y~~~Y~~~~Y~~~~~====(*)    hot trail cools behind the nib;       |
|                                            (*) = halo while holding             |
+--------------------------------------------------------------------------------+
```

Selection (desktop):
```
                                                                     (<-) (->)
        + - - - - - - - - - - - - - - - - - +
        :   Y.Y.Y   (lifted, full strength)  :     everything else dims to 45%
        + - - - - - - - - - - - - - - - - - +
                                    [Delete]
                    +----------------------+
                    | [~]   [o]   [Y]      |   accent outline: tap/drag restyles the selection
                    +----------------------+       (menu and view chip hidden)
```

Erase mode (the chip shows it; tap the chip to return):
```
                             +-------------------+
                             | [(x)]  [o]   [Y]  |   [(x)] = eraser glyph, accent outline
                             +-------------------+
```

Phone, portrait (at rest; Color sheet open):
```
+-----------------------+     +-----------------------+
|(R)                    |     |(R)                    |
|                       |     |       (canvas)        |
|   Draw anything.      |     +-----------------------+
|      It grows.        |     |          ---          |   swipe down to close
|                       |     |  [###] [###] [###]    |
|                       |     |  Graph Indigo Oxide   |
|                       |     |  [###] [###] [###]    |
|                       |     |  Ochre *Moss  Rose    |
| +-------------------+ |     |  [###] [##]  [##]     |
| |[v] [~][o][Y] [<-] | |     |  Spect recent recent  |
| +-------------------+ |     |   ( *Night | Paper )  |
+-----------------------+     +-----------------------+
 [v] view chip (conditional)   [<-] undo, then [->] redo (conditional); Delete takes [v]'s slot in selection
```

Phone, landscape:
```
+------------------------------------------------+
|(R)                                        [<-] |
|                                           [~]  |
|              (canvas)                     [o]  |   the dock goes vertical on the trailing edge;
|                                           [Y]  |   sheets open from that edge
|                                           [v]  |
+------------------------------------------------+
```

---

## 5. Input and gestures

**Arbiter** (`input/arbiter.ts`): `idle → draw | erase | lasso | navigate | sample | chipDrag`. In P1 it adds `move`.

**Pointer rules:**
- One drawing pointer at a time.
- The camera is locked during a pen or mouse stroke.

**`pointercancel`:**
- Pen or mouse: commits what exists.
- Touch: inside the 150 ms window, withdraws the stroke (un-grow, no history). After it, commits.

**Pen mode and palms:**
- **Switching on:** the first pen event turns pen mode on, remembered per device. It expires after 30 minutes with no pen event.
- **In pen mode fingers never draw.** A finger pan starts only after > 12 sp of motion within 250 ms, with no pen contact or hover in the last 500 ms.
- **Ignored contacts:**
  - contacts with radius > 20 sp
  - contacts that begin while the pen hovers
  - all touches while the pen is down and for 300 ms after it lifts
- **Pinch:** two near-simultaneous contacts become a pinch only once both have moved.
- **Toast:** the first finger pan of each session shows the pen-mode toast, whose action turns pen mode off until the next pen event.

| Input | Draw | Erase | Select | Sample | Navigate | Undo / redo |
|---|---|---|---|---|---|---|
| **Mouse** | Left-drag. Hold = rise; a hold before travel = bloom. | Right-drag, which erases only after ≥ 4 sp of travel (a bare right-click does nothing). `E` toggles mode. | Mod-click; Mod-drag lassos; Shift adds | Alt/Option-click | A wheel notch zooms ×1.15 at the cursor. Ctrl+wheel zooms. Middle-drag or Space-drag pans. | Keys or buttons |
| **Trackpad** | Click-drag | `E` or the Erase tile | Same as mouse | Alt-click | Two-finger scroll pans. Pinch (`ctrlKey` wheel) zooms by `×exp(−Δy·0.012)`. | Keys or buttons |
| **Touch, no pen seen** | 1 finger. A second finger within 150 ms, with < 20 px travel, withdraws the stroke with no history entry. | Erase tile | Double-tap on ink; double-tap then drag lassos | Color sheet slot 1 (selection) | 2 fingers pan and pinch-zoom | 2-finger tap undoes; the Redo button redoes |
| **Pen device** (pen + fingers) | Pen | Eraser end (`buttons & 32` or `button === 5`); barrel-button drag (`buttons & 2`) | One-finger tap on ink; one finger held 350 ms then dragged lassos | Color sheet slot 1 (selection) | 1 finger pans (palm rules above). 2 fingers pan and zoom. Pen hover shows the nib cursor and reveals the chrome near the dock. | 2-finger tap / Redo button |
| **All** | Hold after travel = **pool**. Easing pen pressure = **Settle**. | | | | Zoom detents at 25/50/100/200/400% when a pinch ends within ±8% of one. Two-finger gestures ignore scale changes below 4%. | |

**Rules shared by every input:**
- **Taps:** a tap means all contacts go down and up within 250 ms, each moving < 10 px. It is classified at release by the maximum number of simultaneous contacts.
- **Wheel:** each burst is classified on its first event (a new burst starts after a 400 ms gap). It is a **mouse notch** if `deltaMode = 1`, or if `|Δy|` is an integer ≥ 50 with `deltaX = 0`. Anything else is a trackpad scroll and pans.
- **Coalesced events:** read with `e.getCoalescedEvents?.() ?? [e]`.
- **Allocation:** app code allocates nothing per event. The browser's own event arrays are excused.
- **Rotation** (P1): Alt+wheel in 15° steps, two-finger twist, and Safari `gesturechange`. It snaps to 0/90/180/270° within ±6°.

**Keyboard.** Bindings use `e.code`, so they follow the physical key position on any layout. `?` is the one exception and matches `e.key`. **Mod** = ⌘ on macOS and Ctrl elsewhere. Single-key shortcuts are ignored while focus is in a text field or a radio group.

| Key (`e.code`) | Action |
|---|---|
| `Digit1`–`Digit9`, `Digit0` | Form, in sheet order: Line, Echo, Sprout, Drift, Craze, Plume, Caustic, Burin, Plait, Orbit. Ripple, the eleventh, has no key. |
| `KeyB` / `Shift+KeyB` | Next / previous nib (never cycles into Erase) |
| `KeyC` / `Shift+KeyC` | Next / previous ink |
| `KeyG` | Night / Paper |
| `KeyE` | Toggle erase mode (`Escape` exits) |
| `BracketLeft` / `BracketRight` | Size ×0.8 / ×1.25 (selection, else tool) |
| `Minus` / `Equal` | Depth −0.5 / +0.5 (selection, else the tool's base) |
| `KeyR` | Reseed the selection, else the last gesture (the last stroke and its symmetry copies) |
| `KeyM` / `Shift+KeyM` | Symmetry on / off (centred on the view) / next fold count (Mirror, 3, 4, 5, 6, 8, 12; turns it on) |
| `Mod+Z`, `Shift+Mod+Z`, `Ctrl+Y` | Undo / redo |
| `Mod+A` · `Delete` / `Backspace` · `Escape` | Select all · delete the selection · deselect, close a sheet or exit a mode |
| `Space`+drag | Pan |
| `Shift+Digit1` / `Shift+Digit0` | Fit content / reset to 100% |
| `KeyP` | Replay |
| `Shift+KeyP` | Share timelapse (the replay as a video, §8) |
| `?` (by `e.key`) or `F1` | Help |
| `Mod+S` / `Mod+O` / `Mod+E` | Save `.rise` / open / export PNG |
| P1: `Mod+D`, arrows (`Shift`: ×10), `Mod+Shift+E`, `Alt`+wheel | Duplicate, nudge, export SVG, rotate |

---

## 6. Rendering and materials

**Canvas2D only in v1.** WebGL2 is P2 and has one job: float16 additive accumulation with a `c/(1+c)` tone-map, so dense Night ink glows instead of clipping. It would be an alternate `Renderer` behind the same interface, with Canvas2D as the fallback.

### 6.1 Grounds

Grounds are painted in **CSS** on `#ground`, not on a canvas. A canvas copy is painted only for export.

**Night**
- A radial gradient from `oklch(.165 .012 265)` at the centre to `.135` at the corners.
- An elliptical vignette starting at 55% radius.
- A static 128² hash-noise grain at ±1.2% L. It is generated once into a data URL, used as a repeating `background-image` anchored to the screen, and never animated. Its job is to dither away 8-bit banding.

**Paper**
- `oklch(.955 .012 85)`, warm cotton, with a corner vignette at −0.02 L.
- **P1** adds a world-anchored tooth heightmap:
  - 512², 3-octave value noise plus about 300 fibre curves.
  - Drawn as a canvas pattern at α 0.06.
  - It is the **same** map Charcoal thresholds, so grain registers with the paper.
  - P1 drying rim: at commit, Brush strokes on Paper are re-stroked along the outline at 0.9 px, α ×0.5, L −0.12.

### 6.2 Layer stack and compositing

Bottom to top:

| # | Element | Contents | Blend |
|---|---|---|---|
| 0 | `#ground` (div) | CSS ground (§6.1) | — |
| 1 | `#base` | Committed tiles composited under the camera transform. Re-composited only on a camera or tile change; a gesture frame whose last composite still covers the viewport (a zoom in, or a return towards it) moves it by CSS transform instead, and the settle re-composites. | CSS `plus-lighter` (Night) / `multiply` (Paper) |
| 2 | `#bloomA`, `#bloomB` (Night only) | ¼-resolution blurred ink, double-buffered (§6.7) | CSS `plus-lighter`, opacity .30 |
| 3 | `#dry` | Settled live polys; committed strokes that are still baking; the **lifted selection** | Same as `#base` |
| 4 | `#wet` | Unsettled tail, hot window, pool window, young growth, prediction, halo, and animating strokes (reveal, un-grow, fold-out, restyle morph). Cleared by dirty rects built from per-poly boxes. `#dry` and `#wet` are hidden while blank, so pan and zoom frames neither clear nor blend empty layers. | Same as `#base` |
| 5 | `#overlay` | Cursor, predicted tip, weld ring, lasso, eraser ring and doom mask, selection bounds and outlines. `desynchronized: true`, DPR ≤ 2. | Normal |

**Selection dimming.** While a selection is lifted, `#base` and the bloom canvases go to CSS opacity .45. No tile re-renders are needed.

**Lift.**
- Selecting re-renders the tiles under the selected strokes without them, then draws them into `#dry`. This is a one-time cost of ≤ 100 ms for ≤ 500 strokes in view.
- Deselecting bakes them back using the two-phase rule below.

**Erase preview.** During an eraser drag, the strokes about to go are covered on the overlay by their own cooked outlines, filled with the ground colour at α 0.75 (the doom mask). Tiles re-render once, at lift.

**Tiles:**
- Night tiles start transparent and are composited with `lighter`.
- Paper tiles start white and are composited with `multiply`.
- Both ops are order-independent, so a new stroke draws straight onto the 1–6 tiles it touches.

**Two-phase bake.**
1. The stroke is drawn into its tile canvases in time slices of ≤ 6 ms per frame. Meanwhile it stays visible in `#dry`, and `#base` is not re-composited.
2. When every slice is done, in **one rAF**: re-composite `#base` and clear that stroke's region from `#dry`, redrawing any other `#dry` content in that region.

Edge cases:
- A camera change or a tile eviction during a bake first finishes the bake synchronously.
- Tiles cached at other levels are marked stale and never drawn into.

**Fidelity.** Live and baked output are compared with a **measured hand-off tolerance**: ≤ 2/255 on ≤ 0.5% of pixels, at 100% zoom and integer DPR, checked in e2e. This replaces the draft's claim of pixel-identical output.

**Fallback.** If `CSS.supports('mix-blend-mode', 'plus-lighter')` is false, `#dry` and `#wet` are composited into `#base` each live frame with the same canvas ops. This is best effort, with no tolerance guarantee.

### 6.3 Batching and tessellation

**Batches.**
- At raster time, each stroke's polys are merged by **(tone, alpha bucket)** into one path and filled once. Alpha is bucketed to 8 levels.
- A typical stroke needs ≤ 40 fills per tile, with a hard cap of 96. Above the cap, adjacent tones merge.
- **The look that follows:** inside a batch, overlaps *merge* (nonzero union). Across batches and strokes, they *add* (Night) or *glaze* (Paper).
- Ribbon outlines are oriented consistently, so a ribbon crossing itself unions instead of punching a hole. This matches the demo, where each operator emitted one fill per poly.

**Sorting and boxes.**
- Polys are sorted by generation, and `genStart[]` lets culling drop whole generations.
- A per-poly box array (4 floats per poly) drives culling, hit tests and dirty rects.

**Path building.**
- There is **no `Path2D` cache**: paths are built from the Float32 outlines when rasterising.
- Edges use **midpoint quadratic Béziers** (`quadraticCurveTo` through segment midpoints), so 32× zoom never shows facets.

**Chunking.**
- Trunks are chunked **where the tone bucket changes**, capped at 256 stations.
- Adjacent chunks share an edge exactly. Under `lighter`, antialiasing coverage at the shared edge sums correctly.

### 6.4 Nib rendering

**Ribbon** (Pen, Brush, Charcoal):
- Both edges are offset along vertex normals.
- At vertices turning more than 60°, 3–6 round-join points are inserted on the outer edge.
- **Inner offsets are clamped at corners**, so thick crisp corners never fold into notches.
- Each end gets a 4-point semicircular cap when its width exceeds 1 device px.
- The envelope (tapers) is applied here as a width multiplier.

**Chisel:**
- Edges sit at `p ± (E/2)(cos θ_nib, sin θ_nib)`, not along the normal.
- Each segment emits a quad as a subpath of a **single path**. Each quad's winding is normalised (reversed if its signed area is < 0), so nonzero fill unions.
- The `0.12S` core ribbon is a subpath **of the same path**, with the same winding. It never double-adds.

**Brush dry-split:** see §2.2.1. The bristles are subpaths in the ribbon's batch.

**Charcoal** (P1):
- Ribbon chunks of about 24 sp, filled with `createPattern(tooth_k)`.
- 4 pre-thresholded tooth tiles, with `t = {.70, .55, .40, .22}` and `α = smoothstep(t − .08, t + .08, H)`.
- `pattern.setTransform(view)` keeps the grain from swimming on pan or zoom.

### 6.5 Operator aesthetics

| Form | Night | Paper |
|---|---|---|
| **Line** | Clean light trail. Pools crackle into filament and lightning on fast strokes. | Pencil line rising into a torn deckle edge or coastline |
| **Echo** | A crystal of light that folds out of your own gesture | An engraved snowflake |
| **Sprout** | Bioluminescent botany curling upward (tropism), leaning away from neighbours | Haeckel-plate botany in glazes |
| **Drift** | Silk and smoke. Divergence-free filaments, deepening in hue along the wake, pouring from where you held. | Hair-fine ink currents at α 0.30 |
| **Craze** | A cooling lava crust: the seams over the trunk are the hottest light, the seams beyond it faint glowing hairlines | Craquelure: the same seams multiply darker over the pigment, like old varnish |
| **Plume** | A vane of warm light, a soft translucent sheet with the rachis brightest; loop eyes glow round a dark pupil | A pen-and-ink quill study; down as faint grey wisps |
| **Caustic** | Its home: hairline rays add up where they fold, so the caustic burns; Spectral ink disperses the fan like a prism | Engraver's reflection hatching with a burnished caustic line |
| **Burin** | Scratched film; a triple crossing is a bright knot, never a white patch | Its home: a steel engraving, the lozenge swell exactly the burin's cut |
| **Plait** | A cord of light; over-crossings are bright lozenges, the gaps keep the cord off white | Its home: a carved stone knot; over-crossings read as the carver's shadow |
| **Orbit** | A rope of light-loops, each deepening in colour around itself | A copperplate flourish, the nib loading and unloading around every loop |
| **Ripple** | Interference moiré glow | Survey-map contours |

### 6.6 Growth animation (implementation)

There are two reveal kinds, both applied at tessellation. **Neither calls an operator.**
- **Prefix** (Sprout, Drift, the six lab Forms, and un-grow): draw each poly up to arc `f·len`, with an interpolated end point. `Cooked.pts` carries the per-point arc `a` for this.
- **Morph** (Line in the live window, Echo fold-out): each point is drawn at `lerp(from, to, f)`.
  - For Line, `from` is the spine position.
  - For Echo, `from` is the point's position on its parent segment.

  The `from` arrays live only in the live layer (`MorphSet`) for the duration of the animation. For Echo that means all levels 1..d with their parent anchors, about 1.3× the final point count. The arrays are dropped at hand-off.

**Halo.** A soft radial gradient in the ink colour, drawn in `#wet` with the ground's composite op. Its brightness is `0.15 + 0.5·(local level / ceiling)`, and the brim flash multiplies it by 1.8 for 160 ms.

**Reduced motion.** Under `prefers-reduced-motion`:
- reveal and fold-out are instant
- the halo is static
- there is no hot trail and no brim flash
- un-grow is instant
- the ground swap and bloom changes are instant
- the first-run seed shows statically

### 6.7 Night bloom (P0)

- **Source:** the visible tiles, drawn at ¼ resolution into a scratch canvas. That is 20–40 small `drawImage` calls.
- **Blur:** a dual-filter chain of three 2× downsamples followed by three 2× upsamples, using `drawImage` with `imageSmoothingQuality = 'high'`. It never uses `ctx.filter`, which Safari does not support reliably.
- **Double buffer:** after each bake, the new bloom renders into the back buffer and cross-fades in over 400 ms. Unchanged regions are identical in both buffers, so only the new stroke's glow fades in: the ink *cures* into light.
- **Camera gestures:** during a gesture, the bloom canvases follow a CSS transform. They recompute once the gesture ends (not when a pause mid-gesture lets tiles render).
- **Scope:** Night only. Live layers are not bloomed; the hot trail stands in for that glow.

### 6.8 Caching

| Cache | Key | Built | Evicted |
|---|---|---|---|
| `Cooked` (Float32 SoA) | `id:geomRev` | On commit; on load, visible strokes first | LRU by Float32 bytes: phone 48 MB, tablet 96 MB, desktop 192 MB. Re-cooking is always safe. |
| Decimated LODs (RDP at 1 sp and 4 sp) | `id:geomRev:lod` | Lazily, the first time a stroke draws below 0.5× or 0.125× of its commit scale | With the `Cooked` entry; counted in its bytes |
| Ink table (30 or 180 CSS strings) | `id:colorRev:ground` | On first raster | On restyle or ground flip |
| Tiles, 512² device px | `(level, ix, iy)` | Progressively | Through the CanvasLedger (§6.9). Freed by setting `width = height = 0`. |
| Sheet tiles | `(last recipe id:geomRev, option, ground)` | When a sheet opens | On a new last stroke |
| Chip glyphs | Tool state | On tool change | — |
| Viewport snapshot | doc id | On `pagehide` / `visibilitychange: hidden`, and at most every 10 s while idle | Replaced |

### 6.9 Tiles, camera, resolution, memory

**Resolution.**
- **DPR:** `min(devicePixelRatio, 3)`, further capped so the viewport stays ≤ 8 MP of device pixels. The overlay uses DPR ≤ 2.
- **Tile levels are half-octave:** level `ℓ = ceil(2·log2(scale·DPR))`, with tile density `2^(ℓ/2)` device px per doc unit. Oversampling is therefore ≤ √2, and the visible tile set is ≤ 2× the viewport's pixels.
- **Settled camera translation snaps to whole device pixels**, so at 100% with integer DPR the blits are integer.

**Camera.**
- Scale range is [0.05, 32]. Detents are listed in §5.
- Fit uses the content box plus a 6% margin.
- Rotation is P1. In P0, `camera.rot` and `recipe.rot` are 0.
- **During pan or zoom**, only cached tiles are composited, and stale tiles stay visible. A camera-only gesture frame moves `#base` by CSS transform while its last composite still covers the viewport (§6.2); a composite skips the full clear when the visible tiles' blits cover the viewport. Animating strokes fast-forward, and the bloom waits for the gesture to end (§6.7).
- **One settle per gesture.** A wheel burst, pinch or glide settles once, re-compositing `#base` and the bloom a single time.
- **150 ms after the last camera change**, the current level renders centre-out in time slices, with a one-tile prefetch ring. A gesture that ends (navEnd, a glide's last step) settles at once. A first render left behind on another level pauses until that level is current again.
- **Invalidation** (remove, restyle, lift) re-renders only the dirty sub-rect of each affected tile. That means clip, clear, and redraw the strokes whose boxes intersect it.

**Memory: `render/ledger.ts` (CanvasLedger)** counts every canvas byte: tiles, live layers, bloom, sheets, export.
- **Global caps:** phone 160 MB, tablet 256 MB, desktop 512 MB.
- **Device class** comes from `matchMedia('(pointer: coarse)')`, `navigator.maxTouchPoints` and screen area. It never comes from the user agent.
- **On allocation failure** (`getContext` returns null or the canvas is 0×0), it evicts LRU tiles and retries once.
- **Export** purges tiles before allocating its canvas.

### 6.10 Robustness

**Context loss.**
- On `contextlost` for any canvas, tiles and live layers are disposable: they are marked stale and rebuilt progressively from `Cooked`. The `Cooked` arrays survive.
- On coarse-pointer devices, any hide longer than 30 s marks every tile stale on return, because iPadOS discards background canvas pixels.
- The viewport snapshot covers the gap.

**Precision.**
- Samples are Float32 offsets from a Float64 origin.
- Tile transforms compute `origin − tileOrigin` in Float64 before calling `setTransform`, so ink 10⁶ doc units from the centre does not jitter.

---

## 7. Architecture

### 7.1 Source tree

The tree as built. It differs from the plan in four places: tessellation lives in `render/` (it is pure, so it also serves export and tests), the operator contract is a unit model (`ink/operators/types.ts`, see the deviation note there), the app layer is split finer than planned, and there is no `firstrun.ts` or `persist/snapshot.ts` (the seed lives in `app/replay.ts` and `app/hints.ts`, snapshots in `persist/autosave.ts`).

```
src/
  main.ts                     composition root: boots app/boot.ts in #stage / #chrome; exposes window.__rise in debug builds; no logic
  env.d.ts                    the build-time __DEBUG__ flag (§7.6, §9)
  styles.css                  :root tokens for both grounds; reduced-motion; forced-colors
  assets/seed.ts              first-run recorded seed (base64 Float32 samples + pools, ~1 KB)
  core/        (pure; lib ES2022, no DOM)
    types.ts                  data contracts only (7.2)
    det.ts                    deterministic dsin/dcos/datan2/dexp/dlog/dpow/dhypot; fmix32/hash32; rnd; Ch; fnv1a
    num.ts  geom.ts  pool.ts  mat.ts (rotation() switches to dsin/dcos)
    folds.ts                  symmetry fold counts (Mirror, 3, 4, 5, 6, 8, 12), shared by ink and ui
    oklab.ts                  OKLab/OKLCH, gamut map (presentation; exempt from the Math allow-list)
  ink/         (pure: "the instrument")
    calib.ts                  learner state (pressure, vMed, jitter), lock rules, snapshot(): Calib
    stabilize.ts              One Euro filter + end flush; serialisable state (for resume)
    signals.ts                per-station v, v_n, κ, dwell; entry/exit speed; closure test with hysteresis
    spine.ts                  incremental spine: resample 2.4 sp, corner-aware Chaikin, settled watermark
    envelope.ts               tapers, seated stop, ramp-down, closure weld
    nibs.ts                   width/geometry per nib; dry-split gating
    depth.ts                  DepthField: base + pools, K kernel, ceilings
    rise.ts                   hold detector + pool integrator + Settle (fed filtered samples and a clock)
    noise.ts                  2D gradient noise with analytic derivatives, curl, tables
    color.ts                  INKS, ramps, assignVariant, lineage test, resolveInk -> InkTable (presentation)
    operators/types.ts        FormOps (trunk, chain of growth units, radial seed), Sink, UnitGeom, shared helpers
    operators/registry.ts     FORMS metadata, CURRENT_V, operatorFor(FormId, v), registerOperator (forms lab, tests)
    operators/line.v1.ts  echo.v1.ts  sprout.v1.ts  sprout.v2.ts  drift.v1.ts
    operators/craze.v1.ts  plume.v1.ts  caustic.v1.ts  burin.v1.ts  plait.v1.ts  orbit.v1.ts  ripple.v2.ts   (ripple v1: cooks as Line)
    cook.ts                   createIncrementalCook(); cook(r) = place(createIncrementalCook(draftOf(r)).finish(r), r.xf); cookPreview, spineOf
    symmetry.ts               symmetry copies: placements (symmetryXf), copy colours, placeCooked / placeSpine / placedSamples
  doc/         (pure)
    ids.ts  document.ts  commands.ts  history.ts  serialize.ts  migrate.ts
  scene/       (pure)
    rtree.ts                  dynamic R-tree, quadratic split, max 9 entries per node
    occupancy.ts              multi-level integer-keyed coverage grid (spine capsules) -> c, CS
    scene.ts                  cooked cache (LRU), boxes, change handling, ensure()
    query.ts                  hit, sweep, lasso, lineage candidates, contentBox
    kitchen.ts                async cook queue, time-sliced (P1: ?worker&inline with in-thread fallback)
  render/      (DOM / Canvas2D)
    types.ts                  Renderer, LiveLayer, Overlay, NibCursor, Halo, Glyphs
    tessellate.ts             (pure) ribbon / chisel / bristle / hairline outlines; prefix + morph; Bézier edges; any PathSink
    ledger.ts  camera.ts  ground.ts  batch.ts  raster.ts  tiles.ts  compositor.ts
    bloom.ts  live.ts  overlay.ts  glyphs.ts  renderer.ts
    stats.ts                  render work counters (debug and bench-zoom only, §9)
  input/
    types.ts (InputSink contract)  index.ts (binds DOM events; feeds the arbiter)
    pointer.ts (events -> InputSample; coalesced + predicted; timestamp sanitiser)
    devices.ts (pen mode, palm rules, device class)  arbiter.ts  gestures.ts (pinch, taps, double-tap)
    wheel.ts (burst classifier)  keys.ts (e.code map)
  sched/
    frame.ts (single on-demand rAF loop, measured frame interval)  jobs.ts (generator jobs, priorities)
  persist/
    idb.ts (database `rise` v1)  prefs.ts (localStorage `rise:*`, try/catch)
    files.ts (.rise download/open/drop; reads gzip)  autosave.ts (batched writes, snapshots, thumbnails, quota)
    remix.ts (remix links: the document in the `#r=` fragment, rounded recipes, grid packing, gzip + base64url, MAX_LINK)
  export/
    png.ts  timelapse.ts (Share timelapse: private live layer, one composited canvas, WebCodecs)
    mp4.ts (pure: one H.264 track into a fast-start MP4)  (svg.ts P1)
  ui/
    index.ts (the whole chrome: reads AppState, dispatches Intents)
    dock.ts  chip.ts (tap/drag rule, dead zone, long-press label, tooltip)  sheet.ts  menu.ts  recent.ts
    selectionbar.ts (Delete)  viewchip.ts  toast.ts  hints.ts  help.ts  announce.ts  icons.ts
  app/
    types.ts                  ToolState, Intent, AppState, AppEvent, RiseDebug
    boot.ts                   builds every service and wires them (§8 load sequence)
    runtime.ts                the shared services; doc, history and scene swap together on New / Open
    store.ts                  observable AppState, one-way event channel, dispatch(intent)
    tool.ts                   tool state and first-run defaults; persisted in prefs
    controller.ts             intents and classified gestures -> commands, tool changes, camera moves
    draft.ts                  owns the stroke lifecycle (7.4)
    erase.ts                  eraser sweep, doom mask, one `remove` per gesture
    edits.ts                  undo / redo; each document change announced to the renderer as its animation
    selection.ts              picking, lasso, lift/drop, restyle with live previews
    view.ts                   camera gestures, fit / reset glides, detents, view chip
    replay.ts                 drives recorded strokes through the live pipeline: Replay and the first-run seed
    library.ts                New, Open / drop, Save project, Recent, remix links (copy, open + replay)
    remix.ts                  remix links: judges each rounded recipe by cooking it against the original
    docs.ts                   switching documents (fade, rebuild, autosave, snapshot under the tiles)
    hints.ts                  the five hints
    perf.ts                   CPU counters (debug builds; no-ops in production)
    debug.ts                  ?debug in debug builds only: window.__rise for e2e and benchmarks
    version.ts                the app string written into .rise files
tests/   (see 7.6)
scripts/ harness.mjs  e2e.mjs  bench-zoom.mjs (§9)  shrink.ts (build plugin, §9)  og-image.mjs (link preview + icons)
lab/forms/  the forms lab: prototype Forms, harness, gallery, briefs (not shipped)
README.md   the user-facing guide
```

### 7.2 Key types

```ts
// ---------- core/types.ts (data only; compiles under tsconfig.pure.json) ----------
export type StrokeId = string;          // base36(ms).padStart(9,'0') + base36(counter).padStart(4,'0'); sorts by creation
export type Device = 'pen' | 'mouse' | 'touch';
export type NibId = 'pen' | 'brush' | 'chisel' | 'charcoal';
export type InkId = 'graphite' | 'indigo' | 'oxide' | 'ochre' | 'moss' | 'rose' | 'spectral' | 'custom';
export type FormId = 'line' | 'echo' | 'sprout' | 'drift' | 'ripple'
  | 'craze' | 'plume' | 'caustic' | 'burin' | 'plait' | 'orbit';
/** Forms offered in the UI, in sheet order; Digit1–Digit0 pick the first ten (Ripple has no key). */
export const P0_FORMS: readonly FormId[] = ['line', 'echo', 'sprout', 'drift', 'craze', 'plume', 'caustic', 'burin', 'plait', 'orbit', 'ripple'];
export type Ground = 'night' | 'paper';
export type Vec2 = readonly [number, number];
export type LCh = readonly [L: number, C: number, h: number];
export type Mat2x3 = Float64Array;      // [a b c d e f]
export interface AABB { x0: number; y0: number; x1: number; y1: number }

/** A live sample from input/pointer.ts, in doc units. Never persisted as an object. */
export interface InputSample {
  x: number; y: number;                 // doc units
  t: number;                            // sanitised, strictly increasing ms
  p: number;                            // raw device pressure 0..1; NaN if none (mouse, touch)
  alt: number; az: number;              // radians; alt = π/2, az = 0 when unknown
  r: number;                            // contact radius in sp; NaN if unknown
  predicted: boolean;                   // predicted samples go to LiveLayer.predict only
}
/** Persisted sample rows: Float32, stride 9. x and y are relative to recipe.origin. */
export const enum S { X, Y, T /* ms since down */, P, ALT, AZ, R, C, CS, STRIDE }
/** Pool rows: Float32, stride 4. */
export const enum PL { S /* sp */, A /* levels, k/16 */, T0, T1 /* ms since down, replay only */, STRIDE }
export interface SampleBuf { data: Float32Array; n: number }   // growable (core/pool.ts)
export interface PoolBuf { data: Float32Array; n: number }

export interface Calib { lo: number; hi: number; gamma: number; flat: number; vMed: number; jitter: number; fcMin: number }
export interface StrokeStyle { nib: NibId; size: number /* S, sp */ }
export interface ColorStyle  { ink: InkId; k: number; dh: number; dL: number; lch: { night: LCh; paper: LCh } | null }
export interface FormStyle   { form: FormId; v: number /* operator version */; base: number /* k/4 */ }
export interface Symmetry    { axis: 'v' | 'h'; at: number }   // reserved; always null (symmetry copies use xf)
export interface SymmetryTool { on: boolean; folds: number; cx: number; cy: number }   // tool state; folds 2 = Mirror

/** Fields every recipe-like object shares; operators and buildSpine read only these. */
export interface RecipeCore {
  readonly origin: Vec2;                // Float64 doc coordinates
  readonly z: number;                   // camera scale at pen-down (sp per doc unit)
  readonly rot: number;                 // camera rotation at pen-down; 0 in P0
  readonly seed: number;                // uint32 = hash32(docSeed, counter)
  readonly device: Device;
  readonly calib: Calib;
  readonly stroke: StrokeStyle;
  readonly color: ColorStyle;
  readonly form: FormStyle;
  readonly s0: number;                  // arc offset (sp) of the first station; > 0 only for split pieces
  readonly cut: number;                 // bit 0: head is a cut (no entry taper); bit 1: tail is a cut (no exit taper)
  readonly resume: Float32Array | null; // stabiliser + operator cursors at s0 (split pieces)
}
/** Immutable. A restyle creates a new object that shares `samples`. */
export interface StrokeRecipe extends RecipeCore {
  readonly id: StrokeId;
  readonly created: number;
  readonly samples: Float32Array;       // S.STRIDE rows
  readonly pools: Float32Array;         // PL.STRIDE rows; length 0 = no pools
  readonly closed: boolean;
  readonly radial: boolean;             // L < 6 sp: tap or bloom seed
  readonly sym: Symmetry | null;        // P1
  readonly xf: Mat2x3 | null;           // post-cook placement, doc rel. origin -> same (symmetry copies, format v2; P1 move/scale)
  readonly geomRev: number;             // bumped by replace when geometry inputs change (cache key)
  readonly colorRev: number;            // bumped when only colour changes (re-raster, no re-cook)
}
/** The stroke being drawn; owned by app/draft.ts. */
export interface DraftStroke extends RecipeCore {
  readonly samples: SampleBuf;
  readonly pools: PoolBuf;
  closing: boolean;                     // live closure state (hysteresis applied)
}
export type RecipeView = StrokeRecipe | DraftStroke;

export interface DepthField { readonly base: number; at(s: number): number; maxPool(): number }

export interface Spine {                // structure of arrays; stations every 2.4 sp
  n: number;
  x: Float32Array; y: Float32Array;     // doc, relative to origin
  s: Float32Array;                      // absolute arc length, sp (starts at s0)
  t: Float32Array; p: Float32Array;
  w: Float32Array;                      // UNTAPERED nib width, doc (tapers apply at tessellation)
  vn: Float32Array; k: Float32Array; c: Float32Array; cs: Float32Array;
  alt: Float32Array; az: Float32Array; nx: Float32Array; ny: Float32Array;
  corner: Uint8Array;
  settled: number;                      // stations < settled are final (live only)
  L: number;                            // current length, sp
}

/** Colourless cooked geometry, packed and transferable. Polys sorted by gen. */
export interface Cooked {
  pts: Float32Array;                    // x, y, w, a  (doc, relative to origin; a = arc along poly, sp)
  start: Uint32Array; count: Uint32Array;
  gen: Uint8Array; tone: Uint8Array; alpha: Float32Array;
  born: Float32Array;                   // spine arc (sp) each poly grows from
  unit: Uint32Array;                    // growth unit (anchor / station / chunk index)
  box: Float32Array;                    // 4 per poly
  genStart: Uint32Array;                // genStart[g] = first poly of gen g; length maxGen + 2
  nPolys: number; nPts: number;
  inkBox: AABB; hitBox: AABB;
  ceilingMax: number;                   // realised max depth after caps
  coverage: number;                     // Echo exposure
  bytes: number;                        // Float32 bytes, for the LRU
}
export interface PolyView { index: number; gen: number; alpha: number; tone: number; born: number; unit: number; pts: Float32Array }

// ---------- ink/operators/types.ts ----------
import type { Ch } from '../../core/det';
export type Rng = (ch: Ch, a: number, b?: number) => number;   // rnd(seed, ch, a, b)
export interface Sink {
  begin(gen: number, alpha: number, tone: number, born: number, unit: number): void;
  pt(x: number, y: number, w: number): void;                    // sink accumulates arc a
  end(): void;
}
export interface OperatorState { cursor: number }               // arc (sp) up to which output is final
export interface Operator<St extends OperatorState = OperatorState> {
  readonly id: FormId; readonly v: number;
  readonly locality: 'local' | 'global';
  readonly reach: number;                                       // sp of spine an output point depends on
  readonly dMax: number; readonly baseDefault: number;
  readonly unitBudget: number; readonly strokeBudget: number;   // points
  init(r: RecipeCore, rng: Rng): St;
  /** Emit output for spine arc (cursor, upTo]; sequential chains advance their cursors. */
  advance(st: St, sp: Spine, upTo: number, d: DepthField, out: Sink): void;
  /** Re-emit every growth unit born in [s0, s1] (pool changed); pure per unit. */
  regrow(st: St, sp: Spine, s0: number, s1: number, d: DepthField, out: Sink): void;
  /** Lift: tail zone, closure, and (Echo) all global work. */
  finish(st: St, sp: Spine, d: DepthField, out: Sink): void;
  radial(r: RecipeCore, sp: Spine, depth: number, rng: Rng, out: Sink): void;
  ceiling(st: St, s: number): number;
  /** Serialise cursors for split pieces. */
  snapshot(st: St): Float32Array;
}

// ---------- ink/cook.ts ----------
export interface LiveView { geom: Cooked; ghost: Cooked | null; morph: MorphSet | null }
export interface MorphSet { from: Float32Array; polyFirst: Uint32Array; t0: Float32Array; dur: Float32Array }
export interface IncrementalCook {
  append(nSamples: number): void;                // cooks the newly settled region
  regrow(s0: number, s1: number): void;          // pools changed inside [s0, s1]
  setClosing(on: boolean): void;
  view(): LiveView;                              // valid until the next call on this object; never retain
  drainSettled(cb: (p: PolyView, replaces: number) => void): void;  // each settled poly exactly once; replaces = -1 or old index
  ceiling(s: number): number;
  finish(r: StrokeRecipe): Cooked;               // re-cooks head/tail zones and global work
}
export type CreateIncrementalCook = (d: RecipeView) => IncrementalCook;
export type CookFn = (r: StrokeRecipe) => Cooked;          // ≡ createIncrementalCook(draftOf(r)).finish(r)
export type BuildSpine = (r: RecipeView, from: number, into: Spine) => Spine;

// ---------- ink/color.ts ----------
export interface InkDef { id: InkId; night: LCh; paper: LCh; band: number; hd: number; spectral: boolean }
export interface InkTable { css: readonly string[]; op: 'lighter' | 'multiply'; alphaMax: number }
export type ResolveInk = (c: ColorStyle, g: Ground) => InkTable;
export type AssignVariant = (ink: InkId, counter: number, lineage: ColorStyle | null, custom: ColorStyle['lch']) => ColorStyle;

// ---------- doc ----------
export interface Camera { cx: number; cy: number; scale: number /* [0.05, 32] */; rot: number /* 0 in P0 */ }
export interface DocMeta {
  id: string; title: string; created: number; docSeed: number;
  counter: number;                          // monotonic; outside history
  inkCounters: Record<InkId, number>;       // monotonic; outside history
  ground: Ground; camera: Camera;           // saved, not undoable
}
export type Command =
  | { k: 'add'; recipes: readonly StrokeRecipe[] }
  | { k: 'remove'; ids: readonly StrokeId[] }
  | { k: 'replace'; before: readonly StrokeRecipe[]; after: readonly StrokeRecipe[] }  // inverse = swap; exact
  | { k: 'meta'; patch: { title?: string } }
  | { k: 'batch'; cmds: readonly Command[] };
export interface DocChange { added: StrokeId[]; removed: StrokeId[]; geometry: StrokeId[]; color: StrokeId[]; meta: boolean }
export interface Doc {
  readonly meta: Readonly<DocMeta>;
  get(id: StrokeId): StrokeRecipe | undefined;
  ordered(): readonly StrokeRecipe[];       // z-order = id order (creation); no reordering in v1
  apply(c: Command): Command;               // returns the inverse; the ONLY stroke mutator
  nextSeed(): number;                       // bumps counter
  nextVariant(ink: InkId): number;          // bumps inkCounters[ink]
  setView(v: Partial<Pick<DocMeta, 'ground' | 'camera'>>): void;
  subscribe(fn: (ch: DocChange) => void): () => void;
}
export interface History {
  push(c: Command, inverse: Command): void; undo(): boolean; redo(): boolean;
  readonly canUndo: boolean; readonly canRedo: boolean;   // capped at 500
}

// ---------- scene ----------
export type Priority = 'visible' | 'handoff' | 'prefetch' | 'background';
export interface Scene {
  cooked(id: StrokeId): Cooked | undefined;
  ensure(ids: readonly StrokeId[], prio: Priority): Promise<void>;
  query(box: AABB, out: StrokeId[]): StrokeId[];                     // by inkBox, z-ordered
  hit(p: Vec2, rDoc: number, minAlpha?: number): StrokeId | null;    // capsule, then polys with alpha ≥ minAlpha (0.3)
  sweep(a: Vec2, b: Vec2, rDoc: number, out: Set<StrokeId>): void;   // eraser segment
  lasso(poly: Float64Array): StrokeId[];                             // ≥ 50% of spine stations inside
  crowding(x: number, y: number, z: number): number;                 // c
  sideCrowding(x: number, y: number, nx: number, ny: number, z: number): number;  // CS
  lineage(x: number, y: number, ink: InkId, wDoc: number, now: number): StrokeId | null;
  contentBox(): AABB | null;
}
export interface Kitchen { cook(r: StrokeRecipe, prio: Priority): Promise<Cooked>; cancel(id: StrokeId): void }

// ---------- render/types.ts (DOM types allowed) ----------
export interface NibCursor { kind: NibId | 'erase'; wCss: number; angle: number; css: string }
export interface Halo { x: number; y: number; rCss: number; level: number /* 0..1 of ceiling */; brim: boolean; css: string }
export interface Renderer {
  resize(cssW: number, cssH: number, dpr: number): void;
  setCamera(c: Camera, phase: 'gesture' | 'settled'): void;
  setGround(g: Ground): void;
  invalidate(boxes: readonly AABB[]): void;
  lift(ids: readonly StrokeId[]): Promise<void>;      // selection layer
  drop(): Promise<void>;                              // bake the selection back
  readonly live: LiveLayer;
  readonly overlay: Overlay;
  /** Shared by tiles, bloom, export, sheet tiles. Yields between strokes; returns ids skipped as uncooked. */
  renderRegion(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
               box: AABB, pxPerDoc: number, ground: Ground, paintGround: boolean): Generator<void, StrokeId[]>;
  frame(now: number, budgetMs: number): boolean;      // true while work is pending (keeps rAF alive)
}
export interface LiveLayer {
  begin(d: DraftStroke, cook: IncrementalCook): void;
  update(): void;                                     // after append / regrow / setClosing
  predict(tail: readonly InputSample[]): void;        // drawn once on the overlay, discarded next frame
  halo(h: Halo | null): void;
  commit(r: StrokeRecipe, c: Cooked): void;           // finish reveal, then two-phase bake
  withdraw(): void;                                   // un-grow, no history
  ungrow(r: StrokeRecipe, c: Cooked): void;           // removal animation after tiles re-render
  morph(before: { r: StrokeRecipe; c: Cooked }[], after: { r: StrokeRecipe; c: Cooked }[]): void;  // restyle
  fastForward(): void;
  readonly animating: number;
}
export interface Overlay {
  cursor(p: Vec2 | null, shape: NibCursor): void;
  weld(p: Vec2 | null, rCss: number): void;
  lasso(path: Float64Array | null): void;
  eraser(p: Vec2 | null, rCss: number, doomed: readonly StrokeId[]): void;
  selection(box: AABB | null, ids: readonly StrokeId[]): void;
}

// ---------- app/types.ts ----------
export interface ToolState {
  nib: NibId; lastNib: NibId; sizes: Record<NibId, number>;
  ink: InkId; custom: ColorStyle['lch']; recents: readonly ColorStyle[];   // ≤ 2
  form: FormId; base: Record<FormId, number>;
  mode: 'draw' | 'erase';
  sym: SymmetryTool;                                                        // symmetry (Form sheet switch)
}
export type Intent =
  | { k: 'pickNib'; nib: NibId } | { k: 'pickErase' } | { k: 'pickInk'; ink: InkId | ColorStyle } | { k: 'pickForm'; form: FormId }
  | { k: 'bendSize'; factor: number; done: boolean } | { k: 'bendDepth'; delta: number; done: boolean }
  | { k: 'bendColor'; dh: number; dL: number; done: boolean }
  | { k: 'reseed' } | { k: 'delete' } | { k: 'undo' } | { k: 'redo' } | { k: 'ground'; g: Ground }
  | { k: 'select'; ids: readonly StrokeId[]; add: boolean } | { k: 'deselect' }
  | { k: 'new' } | { k: 'open'; file: File } | { k: 'openRecent'; id: string } | { k: 'deleteRecent'; id: string }
  | { k: 'save' } | { k: 'exportPng' } | { k: 'replay' } | { k: 'fit' } | { k: 'resetView' }
  | { k: 'resetCalibration' } | { k: 'help' };
```

### 7.3 Dependency direction

```
core <- ink <- scene <- render <- export
core <- doc <- scene            doc <- persist
core <- input                   core <- sched
app/* may import everything; ui imports only app/store, app/types and render/glyphs; main.ts wires.
```

**Enforcement:**
- `tsconfig.pure.json` covers `core`, `ink`, `doc` and `scene` with `lib: ["ES2022"]` and no DOM types. `npm run typecheck` runs both configs, so referencing `window`, `document`, `Path2D` or a canvas in those folders fails.
- **No `export declare function`.** Function contracts are type aliases implemented in their own modules, because rolldown reports "Missing export" for declared-only values.
- `tests/purity.test.ts` scans import specifiers for forbidden edges.
- The pure modules run unchanged in vitest (Node) and in a P1 Worker.

### 7.4 Stroke lifecycle (owner: `app/draft.ts`)

1. **pointerdown** (the arbiter says draw):
   - Snapshot camera `z`/`rot`, the `calib` for this device class, and the tool state (nib, size, ink or custom, Form, base).
   - `seed = doc.nextSeed()`.
   - `color = assignVariant(ink, doc.nextVariant(ink) or the lineage's k, scene.lineage(…), custom)`.
   - Create the `DraftStroke`, `createIncrementalCook`, then `live.begin`.
2. **pointermove**, for each coalesced event:
   - Sanitise `t` and convert to doc units.
   - Fill `C` and `CS` from the occupancy grid, at most once per 2.4 sp; otherwise repeat the last value.
   - Append the sample.
   - Then `cook.append(n)` and `live.update()`.
   - Predicted events go to `live.predict`.
3. **Each rAF while down:**
   - `rise.step(filteredTip, p, now)` updates the pools.
   - Changed pool windows go to `cook.regrow(s0, s1)` and the halo to `live.halo`.
   - Hold-start migrates the window's polys from `#dry` to `#wet`.
   - Closure hysteresis drives `cook.setClosing` and `overlay.weld`.
4. **pointerup:**
   - Apply the lift guard (pools at `t_up − 60 ms`) and the radial test.
   - `recipe = freeze(draft)`, then `c = cook.finish(recipe)`.
   - `doc.apply(add)`, plus `doc.apply(replace(pools))` when there are pools (peel), each pushed to history.
   - The scene registers `c`, the occupancy grid splats the stroke, the learner updates, and `live.commit` runs.
5. **Symmetry.** With the tool's symmetry on, pen-down also fixes each copy's placement (`symmetryXf` about the tool's centre, relative to the stroke's origin) and colour; `live.begin(d, cook, copies)` draws the one incremental cook once more per copy through its placement (one cook, `n` draws). At lift each copy is frozen from the stroke's recipe under a new id with its `xf` and colour; its geometry is the stroke's `finish` placed (`≡ cook(copy)`); the stroke and its copies enter the document in the **same** `add` (and peel `replace`), so one undo removes the whole gesture. Split pieces carry their copies the same way.
6. **Auto-split.** At 6000 stations (about 14,400 sp), the stroke commits with `cut` bit 1 set. The continuation starts at once with `s0 = L`, `cut` bit 0 set, the `resume` state, and the same colour family. It is seamless.
7. **pointercancel:** follows §5.

### 7.5 Determinism rules

1. **`cook(recipe)` is pure.** It reads only the recipe and the operator code for `form.v`. It is defined as `createIncrementalCook(draftOf(r)).finish(r)`, so live and committed geometry share one code path.
2. **Randomness is addressed, not streamed.** `rnd(seed, Ch.*, a, b)` takes integer addresses (unit index, level, node). Changing loop order, budgets or chunking never reshuffles output.
3. **Allow-list for geometry modules** (`core/det`, `core/geom`, `core/num`, `core/mat`, `ink/**` except `ink/color.ts`):
   - Allowed: `Math.sqrt/abs/floor/ceil/round/trunc/min/max/imul/fround/sign/clz32`.
   - Banned: the `**` operator, every other `Math.*`, `Date`, `performance`.
   - Transcendentals come from `det.ts`. Hot paths (noise gradients, Drift jitter) use precomputed tables.
   - `tests/purity.test.ts` enforces this on the source text.
4. **Colour is presentation.** `core/oklab.ts` and `ink/color.ts` may use `Math.*`. Colour never feeds geometry, ids or `sceneHash`, and custom inks are stored as LCh numbers, never re-derived. Colour tables are tested to ≤ 1/255 against golden values.
5. **Inference outputs are frozen at creation:** `calib`, `C`/`CS` per sample, `color.k/dh/dL`, `closed`, `radial`, base, pools. Learners update only between strokes.
6. **Context reads only strokes earlier in z-order, and its result is stored.** Deleting a neighbour never changes another stroke.
7. **Local operators use absolute arc length in sp** and never normalised `u`. Only Echo is `global`. Each growth unit is a pure function of the spine within `reach` of it, `d(s)` there, and its own rng address. That is what makes `regrow`, truncation and split pieces exact.
8. **Placement is post-cook.** A recipe with `xf` cooks exactly like the same recipe without it, then every point, chisel angle and box is mapped through `xf` (`ink/symmetry.ts placeCooked`; angles through `datan2`). Spines (`spineOf`) and the samples the occupancy grid and queries read (`placedSamples`) are placed the same way, so hit tests, the eraser, the lasso, lineage and crowding see the ink where it lies. `xf` is stored as six Float64 numbers, so the placement never depends on the engine.
9. **Operators are frozen by version.** To change a look, ship `line.v2.ts`. Never edit v1. Moving old strokes to a new look is an explicit restyle.
   - `CURRENT_V` in `ink/operators/registry.ts` names the version new strokes are drawn with, and `operatorFor(form, v)` cooks every recipe with the version stored in `recipe.form.v`.
   - Shipped: Sprout v2 (§2.3.5) and Drift v2 (§2.3.6).
   - `registerOperator(form, v)` lets the forms lab and tests cook prototypes through the real pipeline at versions ≥ 100, which no shipped recipe uses.
10. **Timestamps** are sanitised to be strictly increasing (`+0.25` ms minimum step). Predicted samples are never stored.
11. **Precision:** samples are Float32 offsets from a Float64 origin. Files store base64 little-endian Float32, which round-trips exactly.
12. **Device-adaptive cost changes presentation only:** reveal timing, tile level, prefetch, preview cadence. It never changes geometry.

### 7.6 Tests

**Status (2026-10-08):** 1195 vitest tests in 77 files under `tests/`, all passing (symmetry: `tests/ink-symmetry.test.ts`, the v2 format fixture; Share timelapse: `tests/export.timelapse.test.ts`, schedule, framing, encoder choice and the MP4 box layout; remix links: `tests/doc-persist.remix.test.ts`, version 1 links still open exactly, lossless packing, rounding grids, the same link when a remix is shared again, the size limit, damaged payloads); 28 e2e scenarios. The forms lab has its own suite (`npx vitest run --config lab/vitest.config.ts`).

**vitest (Node):**
- **`det`:** bit-exact golden vectors, plus relative error ≤ 1e-12 against `Math.*` over Rise's ranges.
- **`purity`:** import edges, the Math allow-list, and the bans.
- **Golden hashes:** `fnv1a(Cooked)` per fixture per operator version (`tests/fixtures/ink-forms.golden.json`). Fixtures cover every Form, pools, closed loops, radial seeds and split pieces. Each lab Form and Sprout v2 also has its own behaviour file (`tests/ink-forms.<form>.test.ts`, `ink-forms.sprout2.test.ts`).
- **Incremental ≡ full:** random chunk sizes, random hold and Settle schedules, and random closure toggles, for every Form. Equality is bitwise.
- **Continuity:** `max |cook(d) − cook(d + 1/16)|` is bounded per Form. Line at d = 0 equals the spine ribbon. Sprout and Drift truncation equals a direct cook.
- **Operator safety:** budgets respected, no NaN, `inkBox` contains every point, `genStart` is sorted.
- **Colour:** gamut invariants. Indigo × Ochre on Paper lands at h 130–170. Ramps match golden tables to ≤ 1/255.
- **Doc property test:** 200 seeded random commands, then undo-all, deep-equals the empty document (counters excluded as monotonic). `replace` round-trips are exact.
- **Serialisation:** round-trips bit-exactly. Every format fixture migrates to the golden `sceneHash`.
- **Structures:** the R-tree equals brute force on 10k boxes and 1k queries. Occupancy returns to zero after add and remove.
- **Rise:** the hold detector per device class, the pressure gate, Settle, the ceiling and the lift guard.
- **Input:** the timestamp sanitiser, the wheel burst classifier, tap / double-tap / 2-finger-tap classification, and the pen-mode palm rules.

**e2e (`scripts/e2e.mjs` on `harness.mjs`):**
- **Target:** the single-file build opened via `file://` in Chromium. Pen input uses pressure and tilt at 240 Hz timestamps. The suite drives the **debug variant** (`vite build --mode debug` → `dist-debug/index.html`, which it builds itself): the same app with `window.__rise` compiled in. The production file (`build:single`) has no debug hooks (`__DEBUG__` is a build-time constant), so the `prod-file` scenario only checks that it boots, draws, logs no errors and exposes nothing.
- **Golden fixtures in other engines:** Firefox via puppeteer-core BiDi; the step reports SKIPPED when `FIREFOX_PATH` is absent. WebKit (Playwright) is P1. **Not built yet.**
- **Scenarios** (28; `--only name,name` runs a subset; `--budget` runs `boot-budget`, `phone-layout` and `symmetry`):
  - `prod-file`: the production file boots, draws, logs no errors and has no `window.__rise`
  - `boot-budget`, `phone-layout`: control-budget DOM counts at rest, with ink and after an undo, on desktop and phone (the selection counts are checked in the selection scenarios)
  - `draw-each-form` (the first four), `draw-new-forms` (the six lab Forms, their taps, and a `.rise` round trip of their ids), `radial-seeds`
  - `rise-hold-pen`, `rise-hold-mouse`: rise by hold, and peel undo
  - `closure`: preview equals committed
  - `erase-sweep`
  - `select-restyle-delete`, `lasso-restyle-bend`, `sample-alt-click`
  - `undo-redo-50`
  - `reload-persist` (identical `sceneHash`), `rise-file-roundtrip`, `export-png` (dimensions), `documents` (New, reopen and delete from Recent)
  - `first-run-seed`, `hints`, `replay`
  - `share-hint`, `share-hint-phone`: no share hint at 5 strokes or right after the 6th; it shows at the pause after, alone, with the desktop or touch text, dismisses itself, and a reload plus a new stroke never brings it back. `share-hint-shared`: Copy remix link before stroke 6 means it never shows, and that is in prefs
  - `timelapse`: `Shift+P` shows the progress toast, drawing goes on while it records, the video downloads (`rise-*.mp4`, intercepted); the debug hook's recording loads in a `<video>` at 1080 px wide with a 3–12.5 s duration that matches its frame count, and its first and last frames match (the seamless loop) while the middle differs. The video and three frames are written to `e2e-out/`. `timelapse-vertical`: on a touch device the recording is 1080 × 1920
  - `symmetry`: the Form sheet holds 10 tiles plus the switch; the switch turns on 6-fold symmetry with no extra control at rest; the copies draw while the pen is down (pixel probe); one stroke makes 6 strokes with 6 Spectral hues in a v2 file; one undo removes them, redo restores them, a reload keeps them (identical `sceneHash`) and the switch state; `M` turns it off; Mirror makes 2
  - `remix-link`: a 6-fold Spectral stroke becomes a link (debug hook; the menu intent toasts); a fresh browser with a drawing of its own opens it: replay runs, the fragment leaves the address bar, a new document, the visitor's drawing still in Recent, the stage within a pixel-diff bound of the sender's (mean < 0.5/255, < 0.5 % of pixels off by more than 16), sharing it again gives the same link; a truncated link pasted into the open app toasts and changes nothing
  - `navigate`, `touch-pinch`
  - `stress-300`: a 300-stroke document with 20 wheel zoom steps
- **Not built yet:** the hand-off tolerance test (§6.2 Fidelity).
- **Performance gates** are CPU-side only (§9). Raster numbers are trend-only in CI and gated on real devices.

---

## 8. Persistence, history and export

### History

**Commands are plain data, and `apply` returns the inverse.** Undo and redo are two stacks capped at 500 entries. Each user action maps to exactly one entry, except a risen stroke, which maps to two so it can peel.

| User action | Command |
|---|---|
| One stroke without pools | 1 `add` |
| One stroke with pools | `add`, then `replace` (pools); undo peels |
| One stroke with symmetry on | the same `add` (or `add` + `replace`) carrying the stroke and all its copies: one undo removes the whole gesture |
| One eraser gesture, or Delete | 1 `remove` |
| One restyle (tap, chip-drag release, `[` `]`, `-` `=`, Reseed) | 1 `replace` |
| Auto-split pieces | 1 `batch` of `add`s |

**Not in history:**
- Ground, camera and tool state (symmetry included).
- **New.** It switches to a fresh document, and the old one is listed in Recent. There is no Clear.

**Other rules:**
- An undo during a stroke's animation fast-forwards the animation, then plays the un-grow.
- Persisting the undo stack across reloads is P2.

### Autosave (P0)

**IndexedDB database `rise`, version 1:**

| Store | Key | Contents |
|---|---|---|
| `docs` | doc id | Meta, camera, ground, counters, updated time |
| `strokes` | `[docId, strokeId]` | Recipes, with Float32Arrays stored natively |
| `snaps` | doc id | Viewport snapshot (WebP or PNG blob) and its camera |
| `thumbs` | doc id | 96 px thumbnail for Recent, derived from the snapshot |

**Write rules:**
- Each command puts or deletes only the records it touched. Writes are batched every 250 ms and flushed on `visibilitychange: hidden` and `pagehide`.
- Snapshots are written on hide, and at most every 10 s while idle.
- Prefs live in `localStorage` under `rise:*`, with try/catch: calibration per device class, tool state, pen-mode flag and timestamp, hints shown, first-run done. The `rise:` prefix matters because Chrome gives every `file://` page the same origin.
- After the 10th stroke of the first document, `navigator.storage.persist()` is requested once.

**Load sequence:**
1. Paint the snapshot (≤ 300 ms).
2. Drawing is possible at once.
3. Cook strokes in the saved viewport first and replace snapshot regions as tiles complete.
4. Cook the rest in background jobs.

**Failures.** If IndexedDB is unavailable (for example `file://` in some browsers), or a write throws `QuotaExceededError`, the not-autosaving dot and its toast (with **Save**) appear and drawing carries on.

### Recent (P0, inside the menu)

- The last 12 documents, newest first, each with its title, date and thumbnail.
- Tap to open. Each has a delete action, with confirmation inside the sheet.
- Opening keeps the current document in Recent.

### `.rise` project file (P0)

```json
{ "format": "rise", "version": 2, "app": "rise-sketch@0.1.0",
  "meta": { "title": "...", "created": 0, "docSeed": 0, "counter": 0, "inkCounters": {}, "ground": "night",
            "camera": { "cx": 0, "cy": 0, "scale": 1, "rot": 0 } },
  "strokes": [ { "id": "...", "created": 0, "device": "pen", "origin": [0, 0], "z": 1, "rot": 0, "seed": 0,
                 "calib": {}, "stroke": { "nib": "brush", "size": 9 },
                 "color": { "ink": "moss", "k": 3, "dh": 1.2, "dL": 0.01, "lch": null },
                 "form": { "form": "sprout", "v": 1, "base": 2 },
                 "closed": false, "radial": false, "s0": 0, "cut": 0, "resume": null, "sym": null, "xf": null,
                 "stride": 9, "samples": "<base64 LE Float32>", "pools": "<base64 LE Float32, stride 4>" } ] }
```

**Saving:**
- `Mod+S` or the menu downloads `<title>.rise`.
- P1: the File System Access API overwrites in place, and `navigator.share({files})` is used on iPad.

**Opening:**
- Menu → Open…, `Mod+O`, or dropping a `.rise` file on the canvas. It opens as a new document, with a toast; the previous one stays in Recent.
- Geometry is always re-cooked on open, so files stay small. `geomRev` and `colorRev` reset to 0.

**Format evolution:**
- Migrations are an ordered list `migrations[v](json) → json`, with a fixture kept for every format version (`tests/fixtures/doc-v1.rise`, `doc-v2.rise`).
- **Version 2** (symmetry): `xf` is live, so a stroke with an `xf` (a symmetry copy, `[a, b, c, d, e, f]`) is placed by it. Version 1 never wrote one and never applied one, so the 1 → 2 migration clears any `xf` a v1 file carries and its strokes cook exactly where they were drawn. An older app refuses a v2 file ("newer than this app understands") instead of piling the copies onto their stroke. The IndexedDB schema is unchanged (recipes already stored `xf`).
- P1: gzip through `CompressionStream`, detected by the magic bytes `1f 8b`.

### Export

**PNG (P0).** `Mod+E` or Menu → Export image. No dialog.
- **Framing and source:** the content bounds plus a 6% margin, rendered from recipes through `renderRegion` with the ground painted. It never upscales the screen bitmap.
- **Scale:** output density is `camera.scale · k` px per doc unit, with `k = clamp(3000/longEdge_css, 1, 4)`, where `longEdge_css` is the content's long edge at the current zoom.
- **Pixel caps:** phone 8 MP, tablet 16.7 MP, desktop 32 MP. Tiles are purged through the ledger first.
- **Progress:** a progress toast with **Cancel** appears if the export takes > 300 ms, because it cooks strokes outside the view.
- **File:** named `rise-YYYYMMDD-HHMM.png`, delivered by `<a download>`. P1 uses share on iPad.

**Replay (P0).** Menu → Replay or `P`.
- Strokes re-run through the live pipeline in creation order, with their own timestamps and pool timings (`t0`, `t1`). Pools rise visibly.
- **Speed:** `k = max(1.5, T_ink/18 s)`, with gaps capped at 250 ms.
- The UI is hidden, a 1 px progress line runs along the bottom, and any input stops playback.
- The same `app/replay.ts` drives the first-run seed and the e2e suite.

**Share timelapse.** Menu → Share timelapse or `Shift+P`. No dialog.
- **What:** frame 0 is the finished piece (the poster frame chat apps show, and the hook: the payoff first), which dissolves over 0.6 s into the replay already under way. The drawing then replays stroke by stroke, each trunk drawn at its own pace with its hot nib and each Form growing exactly as in Replay. On Night the bloom swells once (0.9 s, +80 % of its weight) as the last growth ends, and the finished piece holds for 1 s. The last frame is therefore the first, and the clip loops as a social autoplay loop without a seam.
- **Wordmark:** `sketch.syberlabs.io` at 37 px semibold (about 13 pt on a phone), 62–66 % opaque on the current ground: bottom right, or centred under the safe zone in the vertical frame.
- **Render path:** the screen is a stack of CSS-blended canvases (§6.2), so it cannot be recorded. `export/timelapse.ts` builds a **private live layer** (`createLiveLayer`) over two offscreen canvases at video size and calls the same `play` as Replay, on a video clock. Strokes that finish bake into an offscreen base through the tiles' `drawInk`, and on Night the base's bloom (`bloomOf`, shared with `render/bloom.ts`) cures in over 400 ms as on screen. Each frame composites ground, base, bloom, `#dry` and `#wet` into **one** canvas with `lighter` / `multiply`, the canvas ops behind the CSS blends, as the snapshot does. The app's renderer, tiles and camera are untouched, so drawing and navigation go on while it records.
- **Framing:** on a phone or tablet (coarse pointer), **1080 × 1920** (9:16), with the content centred in the feed apps' safe zone (240 px clear at the top for their header, 520 px at the bottom for caption, account and buttons, 60 px at the sides). Elsewhere, 1080 × 1080, or 1080 × 1350 (4:5) when the content is ≥ 1.12× taller than wide. The content plus a 10% margin, magnified at most 3× the zoom it was drawn at. Why (§13 After the build #10): the format follows where the file is posted, and that follows the device, not the share sheet. From a phone it goes to Reels, TikTok, Shorts or Stories, which fill the screen at 9:16 and letterbox anything else. From a desktop it goes to X, Reddit, Discord or Slack, where square holds up best in a feed.
- **Duration:** the replay timeline (gaps capped at 250 ms) of drawing time `T` plays at `k = T / clamp(T / 1.5, 5 s, 10 s)`, never slower than 0.5×, starting at frame 0 (under the dissolve); the last growth finishes, then a 1 s hold. Anything still growing at 11 s fast-forwards, so a video lasts at most 12 s.
- **Encoding:** WebCodecs `VideoEncoder`, H.264 (High, then Main, then Constrained Baseline, level 4.0) at 30 fps and 12 Mb/s, a keyframe every 2 s; every frame gets its exact timestamp and frames are encoded as fast as the device allows (≤ 10 ms of work per rAF, at most 4 frames queued). `export/mp4.ts` writes a fast-start MP4 (`moov` before `mdat`). No `MediaRecorder` fallback (§13 After the build #9).
- **Delivery:** on a phone or tablet (coarse pointer) where `navigator.canShare({ files })` is true, the share sheet (title "Made in RISE Sketch", url: the drawing's remix link as recording began, or `https://sketch.syberlabs.io` when it is too big for one). The sheet needs a fresh user gesture, which a recording outlasts, so a **Share** toast action opens it; closing the sheet turns the toast into **Save**, and any other failure downloads instead. Desktops download, even where the browser has a sheet (§13 After the build #14). The file is `rise-YYYYMMDD-HHMM.mp4`.
- **Unsupported:** without WebCodecs H.264 (Safari before 16.4), the item exports the PNG instead, and its toast says why.
- **Progress:** one toast with progress and **Cancel** (`Escape` cancels too). The fraction is frames done over the expected length: the pen strokes' end, raised as each `play` returns when it will end (growth and pools included), plus the hold. The menu item waits while a recording runs.

**Remix links.** Menu → Copy remix link. No dialog, no server: the drawing stays on the device until the person sends the link.
- **What:** `https://sketch.syberlabs.io/#r=<payload>`. The fragment never leaves the browser, so no server sees the drawing. Links always point at the shipped app, whatever page made them (the single file, a preview).
- **What travels** (version 2, §13 #13): each recipe's input rounded to grids no one can see. Positions to 1/16 sp at the stroke's zoom (a power of two in doc units, so every value is exact in Float32), sample time to 1 ms, pressure to 2⁻¹⁰, tilt to 2⁻⁸ rad, crowding to 2⁻⁸, contact radius to 1/4 sp, origin and a copy's offset like positions, calibration to 4 significant digits. Seeds, ids, Forms, nibs, inks, pools, resume and every discrete field stay exact. A rounding is kept only if it cooks to the same picture: `app/remix.ts` cooks the original and the rounded recipe and requires every point of each within a 1 sp grid cell (or a neighbouring one) of the other's. If it fails, a finer grid is tried (1/128 sp, 1/8 ms; then 1/1024 sp, 1/64 ms), then the recipe goes exact. A rounding that would make two sample times meet is skipped rather than stretching time. Symmetry copies differ only by placement, so each gesture is judged once.
- **Consequence:** the remix looks like the sender's drawing but is not bit-identical to it; its `sceneHash` differs. It cooks the same on every device (it is just a recipe), and a recipe already on a grid is carried as it is, so sharing a remix again gives the same link.
- **Payload** (`persist/remix.ts`): the `.rise` text with each typed array replaced by a blob index, all gzipped (`CompressionStream`) and base64url-encoded. Each blob is lossless: **grid** (per column, the coarsest power-of-two grid its values sit on, then zigzag varints of the grid indexes' first or second differences, whichever is shorter; 0 is NaN) or **words** (column-wise deltas of the 32-bit words in byte planes) for arrays on no coarse grid. Identical arrays are stored once: a symmetry copy shares its stroke's samples, pools and resume. A leading version byte: 1 (PR #14, all words) or 2, with a mode byte per blob. Version 1 links keep opening, bit-exact.
- **Limit:** `MAX_LINK` = 32 768 characters for the whole link. Past it the item says "Too big for a link. Save the project to share it." with **Save**, instead of making a link that chat apps would cut. Decoding refuses longer payloads too, which bounds what a hostile link can inflate to.
- **Copying:** `ClipboardItem` with the link as a promise, so the write keeps the click's user activation (Safari); `writeText` where `ClipboardItem` is missing.
- **Opening:** at boot, and on `hashchange` for a link pasted into an open tab. The fragment is removed first (`history.replaceState`), so a reload never imports it twice. The drawing opens like a file (`parseDoc`: a new document, fresh id) and Replay runs once; the visitor's own drawing stays in Recent. A damaged or truncated link toasts and loads nothing. With a link, the first-run seed is not armed.

**SVG (P1):**
- One `<path>` per batch, decimated with RDP at 0.25 output px, coordinates to 2 decimals, grouped per stroke.
- An `isolation: isolate` root over a ground `<rect>`, with `mix-blend-mode: plus-lighter` on Night (browser-fidelity target) and `multiply` on Paper (portable).
- Hairline polys become an opacity multiplier.

**P2:**
- ~~WebM via `captureStream` and `MediaRecorder`~~ **Shipped** as Share timelapse (MP4 through WebCodecs), above.
- PNG files with the project embedded in a `tEXt` chunk (hand-written CRC32).
- Banded export of very large images through a hand-written PNG encoder over `CompressionStream`.

---

## 9. Performance budgets and LOD

**Reference devices:**
- an iGPU laptop (Intel Iris Xe or Apple M1 class)
- an iPad (9th generation, A13)
- a mid-range Android phone (Pixel 6a class)

**Where budgets are measured:**
- **CPU-side** work (input, cook, tessellate, path build) is measured in-app with `performance.now()`, in e2e runs at 4× CPU throttling.
- **Raster and total-frame** budgets are gated on the reference devices at each milestone.

**Budgets**

| Metric | Budget | Where |
|---|---|---|
| Input handler, per event | ≤ 0.3 ms; no allocation in app code | e2e CPU |
| Live frame CPU (incremental cook, regrow, tessellate, path build), p95 | ≤ 4 ms (≤ 12 ms at 4× throttle) | e2e CPU |
| Live frame total, including raster, p95 | ≤ 10 ms | Devices |
| Rise frame | Same as the live frame | Both |
| Pan / zoom frame | ≤ 3 ms CPU, ≤ 8 ms total | Both; `scripts/bench-zoom.mjs` reports frame intervals, `renderer.frame` CPU and the `render/stats.ts` work counters per gesture phase, trend-only under SwiftShader. It reads `window.__rise`, so like e2e it builds and drives the debug variant (`dist-debug/`) itself; `--no-build` reuses it. |
| Bake slices | ≤ 6 ms per frame; no dropped frames | Devices |
| Erase, undo, lift → tiles updated (≤ 500 strokes in view, warm cache) | ≤ 100 ms, then the 200 ms un-grow | Devices |
| Settle → visible tiles complete | ≤ 400 ms for ≤ 200 strokes in view, warm cache | Devices |
| Cold load | Snapshot painted ≤ 300 ms; drawing possible ≤ 500 ms; visible strokes refined at ≥ 100 strokes/s on the laptop | Devices |
| Time to pixel | ≤ 2 frames, with prediction covering ≤ 16 ms | Devices |
| Idle | 0 rAF; no recurring timers (one-shot timers for chrome return, autosave batching and toasts are fine) | e2e |
| Heap growth during a 10 s stroke | ≤ 1 MB, no major GC | e2e |
| Single-file bundle | ≤ 200 KB minified JS+CSS, ≤ 65 KB gzipped, no network requests | build |
| Memory | Canvases: phone 160, tablet 256, desktop 512 MB (ledger). `Cooked`: 48, 96, 192 MB. | Devices |
| Supported document | 2,000 strokes and 20 M cooked points at these budgets. Larger documents work with cook-on-demand and LRU churn. | e2e stress |

**Single-file bundle, status (2026-10-05).** `dist-single/index.html` is 481 kB minified and 174.5 kB gzipped with Sprout v2 in; the shrink work below took it from 488 / 175 kB to 469 / 170 kB (444 kB JS + 24 kB CSS) before Sprout v2 added 12 kB. The budget above is **not met**. What the build already does:
- Debug-only code (`app/debug.ts`, the perf counters, `live.inspect()`, `RTree.validate()`) sits behind the build-time `__DEBUG__` flag and is absent from production builds. e2e uses the debug variant (§7.6).
- `scripts/shrink.ts` runs in every build. Using the TypeScript checker, it inlines every cross-module `const enum` read, which oxc cannot do file by file, and gives `private`/`protected` members `$`-prefixed short names. References are matched to members by declaration, not by symbol identity: the checker can return a fresh symbol for an inherited member used in a subclass, and until 2026-10-08 13 such references in `render/live.ts` kept their long names while their declarations were renamed. In production that made every replayed trunk pop in whole and disconnected the replay's pool rise, which unit tests (unshrunk sources) could not see. `tests/build.shrink.test.ts` now guards it.
- The modulepreload polyfill is off.

Terser with 3 passes and unsafe options does no better than oxc (±0.5 %). What is left is live code: per-file attribution from a source-mapped build puts the largest modules at render/live 45 kB, ink/cook 20 kB, renderer 17 kB, tessellate 14 kB and controller 14 kB, with each Form operator between 2.5 and 9.5 kB. Reaching 200 / 65 kB would mean cutting features or mangling public property names, which is unsafe here because names reach `.rise` JSON, IndexedDB, intents and the DOM. The budget needs to be revised, or features moved behind lazy loading (which the single-file format inlines anyway).

**Scheduler.** One rAF loop, which runs only while work is pending. Each frame:
1. Drain input.
2. Step rise and closure on the rAF clock.
3. Run the live cook and draw, using dirty rects.
4. Advance animations.
5. Re-composite the base if it is dirty.
6. Run background jobs for `clamp(0.45·frameInterval − liveMs, 1, 6)` ms, where the frame interval is measured per display, so 120 Hz screens work.

**Job priority:**
1. Hand-off bakes.
2. Visible stale tiles.
3. Lift / drop.
4. Prefetch ring.
5. Bloom refresh.
6. Autosave and snapshot encoding.
7. Sheet tiles and thumbnails.

**LOD rules:**
1. **Geometry is cooked once, at commit scale.** Zoom never re-cooks it in v1. Quadratic-Bézier edges keep deep zoom smooth. Zoom-refined detail is P2.
2. **Generation cull:** skip generations whose maximum `w_device · alpha < 0.06`, using `genStart`. Generation 0 is exempt.
3. **Hairline rule:** if a poly's device width is < 1, stroke its centreline at 1 device px with alpha × `w_device`. Deep generations fade steadily instead of shimmering.
4. **Decimated LODs:** below 0.5× of the commit scale, draw the RDP-1 sp copy. Below 0.125×, draw the RDP-4 sp copy. Both are built lazily.
5. **Stroke cull:** if the `inkBox` diagonal is < 3 device px, draw one dot in the mean colour. Below 0.5 px, skip it.
6. **Tiles:** half-octave levels. During gestures, show whatever level exists until settle.
7. **Live region:** `#wet` holds only the unsettled tail (`tip − 24 sp − reach`), the hot window (≤ 120 sp), the pool window and animating polys. Prediction is limited to 16 ms or 24 sp.
8. **Animations:** at most 4 strokes animating at once; extras fast-forward. A camera gesture fast-forwards all of them.
9. **Budgets are fixed per growth unit, with a causal total per stroke.** A device never changes what a stroke grows into.
10. **Selection previews:** live at 30 Hz for ≤ 12 strokes; larger selections update on release. Lift is capped at 200 strokes or 2 M points.

---

## 10. Accessibility and responsive behaviour

### Accessibility (P0)

**Controls:**
- Every control is a real `<button>`. Its `aria-label` includes its state and its drag ("Form: Sprout, depth 2. Drag up or down to change depth."), plus `aria-haspopup` and `aria-expanded`.
- **Keyboard path for chip drags:** with a chip focused, ArrowUp/ArrowDown bend its amount (Color also takes ArrowLeft/Right for hue). Each step is one quarter level, one `[` `]` step, or 5° of hue / 0.02 of L.
- **Sheets** are `role="dialog"`. Tiles sit in a `radiogroup` with roving tabindex: arrows move, Enter or Space chooses, and `Esc` closes and returns focus to the chip.

**Keyboard paths for gestures:**
- Depth: `-` and `=`.
- Selection: `Mod+A`. P1 adds Tab through strokes.
- Sampling: Color sheet recent slot 1 while something is selected.
- Every other action is in the key map (§5).

**Visibility:**
- Focus rings show on `:focus-visible`: 2 px, offset 2 px, `#8fb3ff` on Night and `#2747a8` on Paper.
- Text contrast is ≥ 4.5:1 and control edges ≥ 3:1 on both grounds.
- The dock and sheet backing is the ground colour at 86% with a 14 px blur, so contrast holds over bright ink.
- A selected tile shows a 2 px outline plus a dot, never colour alone.

**Sizing:**
- Touch targets are ≥ 44 px (48 px on coarse pointers).
- UI is sized in rem and follows the browser's text size.
- `user-scalable=no` stays, because the canvas owns pinch.

**Screen readers.** A polite, throttled `aria-live` region announces events: "Sprout stroke added", "Rose to depth 3", "Undone: pools removed", "3 strokes selected", "Image saved". The canvas is `role="img"` with a summary label such as "14 strokes: 8 Sprout, 6 Drift, Night ground."

**Motion.** `prefers-reduced-motion` applies the list in §6.6, and also turns off touch inertia (P1) and the chip pulse.

**Forced colours.** `forced-colors` switches the chrome to system colours. The ink canvas is unchanged.

**P2, Seed.** On the focused canvas, Enter drops one of 12 recorded seed gestures at the centre of the view. Arrow keys nudge it, `=` raises it, and it grows in the current Form. This gives keyboard and switch users real creative agency.

### Responsive

| Class | Rule | Layout |
|---|---|---|
| **Phone** | width < 600 px, or coarse pointer with short side < 500 px | Bottom dock above `env(safe-area-inset-bottom)`: view chip (conditional) · three 48 px chips · Undo · Redo (conditional). Menu top-left at 44 px. Delete takes the view chip's slot during a selection. Sheets are bottom sheets (≤ 46% of the height, 3-column grid, swipe down to close). Long-press a chip for its name and drag. |
| **Phone landscape** | phone and width > height | The dock goes vertical on the trailing edge, and sheets open from that edge. |
| **Tablet** | coarse pointer, larger screen | Desktop layout with 48 px targets. Pen hover reveals the chrome. P2: drag the dock to any edge for handedness. |
| **Desktop** | ≥ 1100 px wide and a fine pointer | 40 px chips. Sheets 7–9 tiles wide in one row; the eleven-tile Form sheet is two rows (6 + 5). Tooltips after 600 ms that include the shortcut and the drag ("Form · Sprout · 1–0 · drag ↕ to deepen"). Nib cursor. |

**Viewport handling:**
- Canvases resize on `resize` and `visualViewport` changes, debounced 120 ms. Tiles are kept, since they are world-anchored.
- `#view` keeps `touch-action: none`. Safari `gesturestart` is prevented, and `contextmenu` is prevented on the canvas.

---

## 11. v1 scope

**Status (2026-10-05).**
- **P0 is built**, all six milestones, except the items marked **Not built** in M6 below.
- **Beyond the plan, shipped:** six more Forms (Craze, Plume, Caustic, Burin, Plait, Orbit, §2.3.10–§2.3.15) with keys 5–9 and 0 and a ten-tile Form sheet, and Sprout v2 (§2.3.5).
- **Shipped after the build:** Drift v2 (§2.3.6).
- **Shipped after the build:** symmetry drawing: Mirror (P1) and radial symmetry (P2) as one feature (§2.3.1, §13 After the build #6), with `.rise` format v2.
- **Shipped after the build:** Share timelapse, the P2 WebM timelapse as a shareable MP4 (§8, §13 After the build #8).
- **Still P1 and P2:** everything listed under those headings below. Charcoal and paper tooth, tilt shading, view rotation, selection move/scale/rotate, partial erase, SVG export and the Worker are not started. Opening a gzipped `.rise` already works; saving one does not.

### P0: one focused build, in six milestones (built)

**M1: Foundation**
- Build: `tsconfig.pure.json` and a `typecheck` that runs both configs.
- `core/types.ts`; `mat.rotation` moved to `dsin`/`dcos`.
- `doc`: ids, commands with `replace`, history, serialize/migrate v1.
- `scene`: R-tree, occupancy (spine capsules → `c`, `CS`), queries, kitchen.
- `sched`: frame loop and jobs.
- Purity test with the Math allow-list.

**M2: Instrument**
- Pointer pipeline: coalesced and predicted samples, timestamp sanitiser, no allocation per event.
- `devices.ts`: pen mode, palms, device class.
- Calibration learner, including jitter `J` and the lock rules.
- One Euro filter with end flush; signals; incremental spine with a numeric settled watermark; corner-aware Chaikin.
- Envelope: tapers at tessellation, flick and seated endings, live closure weld with hysteresis and the weld ring.
- Nibs: Pen, Brush with dry-split, Chisel.
- Tessellation: Bézier edges, inner-corner clamp, unified chisel path, batching.
- Nib cursor.

**M3: Growth**
- Operators v1 with resumable state: Line (lattice offset field), Echo (crystal, snowflake, ghost, fold-out anchors), Sprout (developmental templates, `CS` side, speed lean, tropism), Drift (curl field, ceiling and truncation).
- Radial seeds for all four Forms.
- `DepthField` and pools; `rise.ts` (thresholds × J, pressure gate, Settle, ceiling, lift guard).
- `IncrementalCook`, with `regrow`, `drainSettled`, `finish`, and `cook ≡ finish`.
- Per-unit and causal budgets; auto-split with `s0`/`cut`/`resume`.
- Crowding uses (gen ≥ 1) and the hierarchy rule.

**M4: Light and pigment**
- Colour: 7 inks × 2 ramps, variants, lineage, 30/180-colour buckets, custom inks with twins, glow budget, Echo exposure.
- CSS grounds.
- Ledger; tiles (half-octave, 512², dirty sub-rects, LRU); compositor (CSS blend stack plus best-effort fallback).
- Live layer: dry/wet, hot trail, prefix/morph reveal, halo, un-grow, restyle morph, two-phase bake, lift/drop.
- Night bloom, double-buffered.
- Camera: pan and zoom, detents, fit, reset, snapped translation.
- Hairline, generation-cull and LOD rules.
- Context-loss handling.

**M5: Product**
- Arbiter and gestures for every input in §5: wheel burst classifier, the `e.code` key map, 2-finger-tap undo, double-tap selection, pen-mode finger tap and hold-lasso.
- Selection: Mod-click, lasso, lift and dim, restyle by tap and chip drag with live preview, reseed by re-tap and `R`, Delete.
- Erase: sweep, doom mask, pen eraser end, barrel button, right-drag with travel threshold, `E`, Erase tile, chip eraser glyph.
- Sampling: Alt-click, and the selection colour in recent slot 1.
- Dock and chips (tap/drag rule); sheets with static tiles of the last stroke (with the use rule and labels).
- Menu with Recent; view chip, including the lost-ink arrow; toasts (the §4 list only); 4 hints; help sheet with Reset calibration.
- First-run seed.
- aria-live, labels and keyboard paths; phone, landscape, tablet and desktop layouts.

**M6: Persistence and shipping**
- IndexedDB autosave, snapshots and thumbnails; quota handling; `rise:` prefs.
- `.rise` save, open and drop.
- PNG export with progress and Cancel.
- Replay.
- The full vitest suite (§7.6).
- e2e: budget counts, each Form, rise, peel undo, closure, erase, selection, undo, reload hash, export, seed, stress (§7.6). **Not built:** the hand-off tolerance test and the Firefox golden run.
- Performance pass on the three reference devices. **Not recorded** in the repo; CPU-side numbers come from e2e and `scripts/bench-zoom.mjs`.
- Single-file bundle within its budget. **Not met** (§9).

### Beyond the plan (shipped)

- **Six Forms from the forms lab:** Craze, Plume, Caustic, Burin, Plait, Orbit (§2.3.10–§2.3.15), on keys 5–9 and 0, with a ten-tile Form sheet (§13).
- **Sprout v2:** clean crotches, so branches no longer stack into white dashes on Night (§2.3.5).
- **Cheaper pan and zoom:** transform-only gesture frames, one settle per gesture, blank layers skipped (§6.2, §6.7, §6.9).
- **A debug build:** `__DEBUG__`, `build:debug` and the `prod-file` check (§7.6, §9).
- **Share timelapse:** the replay as a 6–12 s MP4, shared or downloaded (§8).

### P1

**Forms, nibs and materials:**
- Charcoal, with paper tooth and the drying rim.
- Tilt shading.
- Bud dots on Sprout tips.
- P3 colour across all canvases at once.

**Interaction:**
- View rotation.
- Selection move, duplicate, and scale/rotate (`xf`).
- Partial erase of local Forms. It cuts the spine into pieces using the existing `s0`/`cut`/`resume`; geometry outside `reach` of a cut stays bit-identical; Echo is always erased whole.
- ~~Mirror, whose axis is a non-interactive 15% hairline while drawing and draggable only at rest.~~ **Shipped** with radial symmetry (§2.3.1). The hairline is built; dragging the axis is not (the centre is the view centre when symmetry is switched on).
- Drag a tile onto ink.
- Hold-to-repeat undo; Tab through strokes; touch inertia (τ = 325 ms); Safari trackpad rotate.

**Context:**
- Drift combs along ink (a frozen orientation snapshot in the recipe).
- Drift vortex inside closed loops.
- Sprout collision.
- Finger contact-radius pressure.

**System:**
- Lean mode: automatic halved reveal times, 30 Hz previews and no prefetch when p95 exceeds 6 ms.
- Animated sheet tiles and chip glyphs.
- Cook and tile Worker.
- WebKit golden run (Playwright).

**Files:** SVG export; gzip `.rise` (opening one already works); File System Access and share.

### P2

**Rendering:**
- WebGL2 HDR accumulation renderer with Canvas2D fallback.
- Zoom-refined detail for Line and Echo.
- Pool wash on closed loops.
- Hatch fill.

**Erasing:** cutting a selected stroke.

**Files and output:**
- PNG with the project embedded.
- Banded giant export.
- ~~WebM timelapse~~ (**shipped** as Share timelapse, §8); replay scrubbing.
- Persisted undo history.

**Interaction:**
- ~~Radial symmetry~~ (**shipped** with Mirror, §2.3.1); enclosure.
- Haptics (`navigator.vibrate`, Android only).
- Paste a hex value to create an ink.
- Keyboard Seed.
- Movable dock.

### Cut (not on the roadmap)

- Sound.
- Scribble-to-erase.
- Layers.
- "Apply to all".
- Whole-recipe eyedropper.
- Focus mode.
- Size dots.
- Selection Sink/Rise steppers.
- Count badge.
- Sibling colour separation.
- Finger-hold sampling and the loupe.
- Three-finger redo.
- Two-finger double-tap fit.
- Selection hold-to-rise (replaced by the Form chip drag).
- Any slider, numeric field or settings page.

---

## 12. What was removed from the demo, and why

| Removed | Replaced by | Why |
|---|---|---|
| The 262 px panel: title, tagline, 5 operator buttons, 6 sliders and 4 actions (15 controls always visible) | 4–5 controls at rest, 0 while drawing | Less is more. The canvas is the product. |
| **Depth** slider (global, 1–6) | Base depth per Form (Form chip drag), plus local pools by holding | Depth becomes a property of the mark, applied where the hand lingers |
| **Shape** and **Density** sliders, and their per-operator relabelling (Wobble, Roughness, Bias, Angle and so on) | Ink Grammar inference (§2.3, §3.3) | They changed meaning with each operator, and Bare nib's "Smoothing" did nothing (`opRaw` never read `dens`) |
| **Nib width** slider | Per-nib size (chip drag, active tile drag, `[ ]`) plus zoom-relative width | Size is a property of the nib, set by gesture |
| **Pressure response** slider | Percentile calibration learner per device class, which locks after 150 strokes | The ink adapts to the hand, then holds still |
| **Ink** as a 4-step range slider | Color sheet with 7 inks, sampled colours and a hue/tone chip drag | A continuous control for a categorical choice is an anti-pattern |
| **Apply to all** | Selection plus chip restyle and reseed | It was global and destructive, and broke "frozen once laid" |
| `C` instant clear (no undo); bare `U`, `A`, `S` keys | New (old document kept in Recent); standard Mod shortcuts; `e.code` bindings | Destructive single keys are a trap |
| `H` panel toggle | Chrome hides itself on contact | Nothing left to toggle |
| Status line with point counts and the permanent hint bar | `?debug` HUD, the aria-live region, the help sheet, 4 one-time hints | Developer telemetry is not product UI |
| Bare nib's random per-point wobble | One Euro smoothing; depth 0 of any Form | Random jitter is noise, not intelligence |
| Taper by index (9 points) | Arc-length tapers with flick and seated endings, applied at tessellation | Taper length used to change with resampling |
| Live preview at reduced depth and 0.72 alpha, which popped on release | Incremental full-quality cook with the same code path as commit, and a hot trail that converges exactly | What you see is what you get |
| `Math.random()` seeds, sequential mulberry32, global `hueCounter += 47` | Addressed hash RNG, per-document counters, golden-ratio variants, lineage | Reproducibility, plus preview = final |
| Normalised-`u` sampling (`samplePressure`, `length/14` spine, `posFrac` hue) | Absolute arc length in sp | Locality is what makes incremental cooking possible |
| `performance.now()` in the handler, which gave coalesced events identical timestamps | Sanitised `e.timeStamp` per coalesced event | Correct speed signal |
| `JSON.parse(JSON.stringify(P))` every frame; one object per sample | Pooled SoA Float32 buffers | GC discipline |
| A rAF loop that runs forever | On-demand rAF loop | Idle costs nothing |
| Full rebake on every erase, undo and resize; O(strokes × points) erase on each move | World tiles, R-tree hit and sweep, dirty sub-rect invalidation | Scales to large drawings |
| Eraser hit-testing raw spine points only | Spine capsule plus visible cooked geometry, with a doom mask | You erase what you see |
| Screen-space strokes on a fixed viewport | Infinite world canvas: pan and zoom (rotation in P1) | Degrees of freedom without controls |
| HSL colour strings per poly per frame | Hand-written OKLCH with designed Night/Paper ramps and cached buckets | Perceptual colour, two grounds, zero per-frame string building |
| PNG hard-coded to `#12141a` at viewport resolution; DPR capped at 2 | Content-framed export from recipes at up to 4×, following the ground; DPR up to 3 under an 8 MP cap | Export quality |
| Blue hover ring and crosshair cursor | Nib cursor in the ink, at true size and shape | The cursor is the nib |
| Self-Koch falling back to Roughen on closed loops; "Bias" slider flip | Snowflake built from your own generator; area-based flip | Closed loops get their own behaviour; the flip is inferred |
| Sprout rule chosen by the density slider; parallel rewriting that resized everything with depth; strict alternating sides | Curvature-chosen templates (strings kept); developmental growth; sides chosen away from neighbours or toward the convex side; speed lean; tropism | Organic, continuous, aware |
| Sum-of-sines attractor field that pooled; "Field scale" slider | Divergence-free curl noise; zoom sets the scale | No clumping; scale by gesture |

**Kept from the demo:**
- Stroke-as-seed.
- All five algorithms: Bare and Roughen merged as Line, Self-Koch as Echo, the L-system as Sprout, the Attractor as Drift. All are refined, versioned and local except Echo.
- The three L-system rule strings.
- Additive ink of light on a dark ground, now Night, with Paper as its pigment twin.
- Ribbon tessellation.
- Coalesced pen input with pressure and tilt.
- The pen's eraser end.
- Budget-capped depth.
- Hidden chrome.

---

## 13. Decisions log

Verdicts: **A** = accepted as proposed, **A\*** = accepted with a change (stated), **R** = rejected or deferred.

### Clutter critique

| # | Point | Verdict | Reason |
|---|---|---|---|
| 1 | Hold at pen-down selects instead of growing | A | Hold at pen-down is now **Bloom**. Selection moved to Mod-click, a pen-mode finger tap, or a touch-only double-tap. The tagline gesture can never mean anything else. |
| 2 | Rise triggers by accident and cannot be reversed | A | 450/600 ms onsets, pen pressure gate, per-device thresholds × J (J moved to P0), peel undo, Settle in P0. Intent is now a signal and recovery is cheap. |
| 3 | Selection breaks the budget; the bar is a stepper | A* | One chip rule (tap = kind, drag = amount), a Delete-only bar, reseed by re-tap, no badge, selection budget of 6. Pinch scale/rotate goes to P1 with move. |
| 4 | Crowding fights layering | A | Generation 0 is never affected by crowding. Going over ink always intensifies the seed. |
| 5 | Closure invisible until lift | A | Weld ring, live weld, 1.5× hysteresis, and e2e preview == committed. |
| 6 | Echo contradicts the depth contract | A* | (a) ghost during holds; (b) live ceilings with a brim flash. (c) Instead, depth is re-indexed so depth 0 = trunk and crystal α = `smoothstep(0, 0.5, d)`; it fixes the same dead level without double-adding. |
| 7 | Three sampling routes, one dangerous | A* | Finger-hold sampling and the Sample button are cut. Alt-click stays. Selection colour in recent slot 1 applies on **every** device, which also gives a keyboard path. |
| 8 | Erase is an invisible sticky mode | A | Eraser glyph on the chip with a one-tap return, ≥ 4 sp travel for right-drag, no trackpad two-finger click-drag, `B` never cycles into Erase. |
| 9 | Size dots are a 5-step slider | A | Dots cut. Size = chip drag, active-tile drag, `[ ]`, with a 6 px dead zone. |
| 10 | Calibration drift | A | Fast for 150 strokes, then ≤ 1% per stroke within ±15%. Reset in Gestures & keys. |
| 11 | Variants stripe hatching | A* | Sibling separation cut. Lineage by proximity `max(6 sp, 3w)` or recency (< 3 s, ≤ 48 sp). The parallel test is dropped, because colour must be known at pen-down, before direction exists. |
| 12 | Touch gesture conflicts | A | Two-finger double-tap fit and three-finger redo are cut. |
| 13 | Palms and permanent pen mode | A* | All palm rules and the 30 min expiry are adopted. The "Draw with fingers" toast shows once per session, not on every pan, because a repeated toast is nagging. |
| 14 | Modifiers, wheel, layouts | A* | Mod = ⌘/Ctrl, and `e.code` bindings with layout-map labels. The wheel is classified per burst (400 ms gap), not per session, because laptop users switch between mouse and trackpad. |
| 15 | Zoom drift changes stroke character | A | Detents at 25–400% within ±8%, and a 4% scale dead zone on two-finger gestures. |
| 16 | New strands documents | A | Recent in the menu is P0. The New toast points to it. |
| 17 | Replay is nearly free | A | P0, on the same `replay.ts` as the first-run seed and e2e. |
| 18 | Colour too thin | A | Rose ink, chip hue/tone drag in P0, 2 recents (9 tiles). |
| 19 | P0 materials look flat | A | Night bloom and Brush dry-split are P0. |
| 20 | Lost on the infinite canvas | A | The view chip shows an arrow to the ink, and a tap fits. |
| 21 | Sheet tiles contradictory or unreadable | A | Labels always shown. Last-stroke use rule. True-size nib tiles. |
| 22 | Focus mode redundant | A | Cut. `H` is unbound. |
| 23 | Toasts duplicate Undo | A | Toasts only for New, Open/drop, export progress/done, autosave failure, and the pen-mode notice. |
| 24 | Undo unreachable on phones | A | Undo and Redo sit at the trailing end of the dock, the view chip at the leading end. |
| 25 | Mirror axis while drawing | A | Non-interactive 15% hairline while drawing; draggable only at rest (P1). |
| 26 | Partial erase unspecified | A* | Behaviour is P1. `s0`, `cut` and `resume` are in the v1 format **and used in P0** by auto-split, so the mechanism is exercised before partial erase ships. |

### Feasibility critique

| # | Point | Verdict | Reason |
|---|---|---|---|
| 1 | Unbounded draw calls | A | Fills batched by (tone, alpha bucket), ≤ 96 per stroke per tile, `genStart`, per-poly boxes, no `Path2D`. Overlaps merge within a batch, which matches the demo's look. |
| 2 | Animation re-runs operators | A | Prefix and morph reveal. Sprout and Drift units are cooked at the ceiling and truncated. Echo fold-out uses cached anchors. |
| 3 | Incremental ≠ full | A | `cook ≡ incremental.finish`, resumable operators, a numeric watermark, declared head/tail zones, tapers at tessellation. |
| 4 | Budgets per stroke break locality | A | Per-unit plus causal budgets, 6k-station auto-split, and the Line resampling fixed with a nested lattice. |
| 5 | Sprout's fractional depth undefined | A* | Developmental growth (generation-indexed lengths; the new generation extends) instead of subdivision. It is continuous by construction, prefix-truncatable, and keeps the demo's templates verbatim. |
| 6 | Same-frame hand-off vs time slicing | A | Two-phase bake. |
| 7 | "Pixel-identical" is false | A | Half-octave tiles, snapped translation, a measured tolerance test, no guarantee for the fallback. |
| 8 | Memory ignores canvases and iOS | A | CanvasLedger with global caps, CSS grounds, overlay DPR ≤ 2, evict-and-retry, purge before export, device class without UA sniffing. |
| 9 | Cold-load budget impossible | A* | A viewport snapshot, written on hide and at most every 10 s idle, not on every 250 ms flush (encoding cost). Lazy decimated LODs in P0. Budgets restated. |
| 10 | Crowding reads cooked geometry | A | Spine-capsule splats at add and load; integer grid. |
| 11 | Dimming and fade impossible on baked tiles | A* | The erase preview is an overlay doom mask. The selection is **lifted** into its own layer, which brings back dimming through CSS opacity and enables live restyle previews. Capped at 200 strokes or 2 M points. |
| 12 | Module contracts block parallel work (1–9) | A | Types split, function type aliases, `geomRev`/`colorRev`, a `replace` command, Kitchen in `scene` with `ensure`, `app/draft.ts` owns the lifecycle, `drainSettled`, monotonic counters, pools in the schema, zero-padded ids. |
| 13.1 | Math allow-list, ban `**` and `cbrt` | A* | Applied to geometry modules. Colour modules are exempt (presentation-only, 8-bit output, tolerance-tested, custom inks stored as numbers), so no `dcbrt` is needed. |
| 13.2 | Accuracy target and tables | A | ≤ 1e-12 relative; tables for noise gradients and Drift jitter. |
| 13.3 | Cross-engine goldens | A* | Firefox (puppeteer BiDi) in P0. WebKit (Playwright) in P1, because it needs a heavy dev install. |
| 13.4 | Firefox timestamp rounding | A | Strictly increasing sanitised `t`. |
| 13.5 | sRGB in P0 | A | P3 switches every canvas at once, in P1. |
| 14 | Echo rise mid-stroke | A | The ghost deepens during holds and dissolves at lift. It is a declared exception. |
| 15 | Harness measures the wrong thing | A | CPU budgets in CI; raster budgets on devices; CI raster numbers are trend-only. |
| 16 | Chisel core double-adds; corner notches | A | Core in the same path. Inner offsets clamped. |
| 17 | Tone steps and facets | A | Chunks split at bucket changes; quadratic Bézier edges. |
| 18 | Full clears; backdrop cost | A | Dirty rects. Hidden chrome is set to `visibility: hidden`. |
| 19 | Input details | A | `?? [e]` fallback, "no allocation in app code", rAF-clock holds, filtered travel, desynchronized overlay. |
| 20 | Context loss | A | Canvases are disposable and rebuilt from `Cooked`; the snapshot covers the gap. |
| 21 | Far-origin precision | A | Float64 offset before `setTransform`. |
| 22 | Export progress and scale; SVG size | A | Progress toast with Cancel; density defined from the current zoom; SVG decimated and batched. |
| 23 | "0 timers" wording | A | "No recurring timers". |
| B | Move out of P0 | A* | Rotation, move/`xf`, lean mode and animated sheet tiles go to P1. The blit fallback is best effort. The finger loupe is cut outright, not deferred. Dimming and erase fade stay in P0 through lift and the doom mask. |
| C1–C14 | Missing decisions | A | 2k strokes / 20 M points · 6k-station split · merge within batch · developmental Sprout · Echo ghost · half-octave 512² tiles with dirty sub-rects (fewer `drawImage` calls than 256²) · sRGB · desynchronized overlay with ≤ 2 frames + 16 ms prediction · rAF rise clock · quota → dot + toast, `storage.persist()`, `rise:` namespace · rebuild on context loss · `draft.ts` and `store.dispatch` · Float32-only accounting · hold-to-lasso removed. |
| D | Sound parts | A | Kept unchanged. |

### Delight critique

| # | Point | Verdict | Reason |
|---|---|---|---|
| 1 | Rise acts like a depth slider on a timer | A | Depth field with local pools. The biggest change in this revision. It removed the rise LOD exception and the 8 ms rise budget. |
| 2 | Rise not discoverable | A | First-run recorded seed. The text hint is only a fallback at stroke 5. |
| 3 | Line and nibs have nothing alive | A* | Hot trail on Night and wet ink on Paper, with the decay renormalised so it ends at exactly the committed alpha (no 2% pop at hand-off). |
| 4 | A tap makes a dead speck | A | Radial seeds in P0. Line keeps a dot at depth 0, so stippling survives. |
| 5 | Echo dead while drawing | A | Uniform 8-vertex ghost that snaps to a snowflake on closure. A declared exception. |
| 6 | Restyle needs a ritual | R (P1) | Drag a tile onto ink ships in P1, **without** hover preview: baked additive tiles cannot hide the target cheaply on hover. Selection restyle covers P0. |
| 7 | Default ink hides the colour intelligence | A | Moss is the first-run ink. Graphite stays first in the sheet. |
| 8 | Night without bloom looks like neon vector lines | A | Bloom in P0, double-buffered, cured over 400 ms. |
| 9 | Colour has no gesture; Form needs a hold every time | A | The chip rule: hue/tone drag on Color, base-depth drag on Form. |
| 10 | Context only ever means less | A* | Sprout grows away from neighbours in P0 (`CS` channel, stride 9), and the grammar says "awareness". Drift combing stays P1, because its frozen field snapshot inflates every Drift recipe. |
| 11 | Removal is a pop | A* | Un-grow for every removal of ≤ 24 strokes; New and Open use a 200 ms fade instead, since un-growing a whole drawing is expensive and noisy. |
| 12 | Gauge is chrome; pens can't recover | A | The halo is drawn as ink, with a brim flash. Settle in P0. |
| 13 | Sprout ignores speed | A | Wind lean of `−0.5·smoothstep(1.0, 2.4, v_n)` rad. |
| 14 | Replay is P1 | A | P0. |
| 15 | Erasing on phones costs two sheet trips | A | Eraser glyph on the chip with a one-tap return. |
| 16 | Zoomed-in fractals go coarse | R (P2) | Quadratic Bézier edges remove faceting for v1. Per-tile refinement doubles invalidation and memory complexity for a narrow gain. |

### Self-corrections to the draft

| Draft item | Change | Reason |
|---|---|---|
| Drift on Paper used station spacing ×1.67 | Paper uses α 0.30 instead; geometry never depends on the ground | Flipping the ground must not re-cook anything |
| Selection hold-to-rise (P1) | Cut | The Form chip drag on a selection does it without a mode |
| Draft 4 × 4 colour buckets; 12 Spectral hues | 6 × 5, and 36 Spectral hues | Visible tone and hue steps once chunks split at bucket changes |
| Erase as a tile only, with a sticky mode | Unchanged tile, plus a chip glyph that shows the mode | A mode the user cannot see is a trap |
| Line depth range 0–6 | 0–5 | Level 6 hats (0.75 sp) alias at the 0.5 sp lattice floor |

### After the build

Decisions taken once P0 was running. Same verdict scale.

| # | Point | Verdict | Reason |
|---|---|---|---|
| 1 | Promote six lab Forms (Craze, Plume, Caustic, Burin, Plait, Orbit) into the app | A | Each was judged in the forms lab against its brief and adds a primitive the first four lack. All are local chains, pass incremental ≡ full and need no change to `cook.ts`. They ship with unchanged geometry, as `v1` operators with their own golden hashes. |
| 2 | The Form sheet shows ten tiles, over the 9-tile cap of §1.2 | A* | Accepted as the one exception. Ten Forms are ten kinds, and hiding some behind a second page or a "more" tile would add a control. The sheet lays out as two rows of five on desktop and tablet and a 3-column grid on phones; no other sheet may exceed 9. |
| 3 | Number keys for ten Forms | A | `Digit1`–`Digit9` and `Digit0` follow sheet order, so the key is the tile's position. Ripple, shipped later as the eleventh Form, has no key (§13 #7). `Shift+Digit1` and `Shift+Digit0` keep fit and 100%. |
| 4 | Fix Sprout's white dashes on Night by editing `sprout.v1.ts` | R | §7.5 rule 8: operators are frozen by version. The fix ships as `sprout.v2.ts` with `CURRENT_V.sprout = 2`. Old documents keep cooking with v1 and look exactly as they were drawn; moving them to v2 is an explicit restyle. |
| 5 | Drift v2: filaments emerge from the trunk edge | A | Shipped. Same versioning as Sprout v2: a new `drift.v2.ts`, v1 kept for old documents. |
| 6 | Symmetry: ship P1 Mirror and P2 radial symmetry as one kaleidoscope feature | A* | One control: the Form sheet's single permitted two-way switch, **Free \| Symmetry**, so the at-rest budget (4/5) and the ten-tile Form sheet are unchanged. The fold count is the switch's amount (drag sideways, the chip rule), shown as spokes, not a number: zero sliders, still one numeric readout. Copies are real recipes placed by `xf` after the cook, not re-cooked transformed samples: re-cooking rotated samples would let Caustic's lamp, Drift's curl field and Float32 rounding differ per petal, while placement keeps every petal bit-identical and costs one cook per gesture. Spectral copies take `dh = 360°·i/n` in the recipe (a rainbow wheel). One gesture is one history entry; afterwards the copies are separate strokes (you erase what you touch). **Changed from the P1 line:** the axis is not draggable at rest; the centre is the view centre when switched on, because a grab target near the centre would conflict with hold = rise. `.rise` goes to format v2. |
| 7 | Ship Ripple (P1) as the eleventh Form | A* | Promoted from lab prototype v107 as `ripple.v2.ts` (v1 recipes keep cooking as Line, §7.5 rule 8). The Form sheet grows to 11 tiles (6 + 5 on desktop); this widens exception #2 rather than adding a control, and the at-rest budget is unchanged. No number key: `Digit1`–`Digit0` are full, and a letter would break the position rule. The P1 numbers in §2.3.7 were revised in the lab (see the brief). |
| 8 | Share timelapse: ship the P2 WebM timelapse as the way a drawing leaves the app | A* | One menu item and `Shift+P`, no settings, so the control budget is unchanged (the menu grows to eight items). **Changed from P2:** MP4/H.264 through WebCodecs with a hand-written fast-start MP4 writer (`export/mp4.ts`, about 150 lines, no dependency) instead of WebM through `MediaRecorder`: every social app and the iOS share sheet take MP4 and few take WebM, and `MediaRecorder` stamps frames with the wall clock, so a busy main thread drops frames (in headless Chrome it lost whole seconds), while WebCodecs gets an exact timestamp per frame and runs faster than real time. `MediaRecorder` stays as the fallback, and the PNG export when neither exists. Frames come from a private live layer on the same `play` as Replay, so the video is what Replay shows; nothing about operators, recipes or the format changes. `Shift+P`, not `Mod+Shift+E`: that chord is the P1 SVG export, Firefox opens its network panel on Ctrl+Shift+E, and P is already Replay. Square 1080 px by default, 4:5 for tall drawings (the portrait feed format); the wordmark is the loop back to the app. Fixed on the way: a symmetry copy's replay now counts with its stroke against the four-animation cap (`live.play`), so six petals grow together instead of two popping in. Cost: +13 kB minified, +5 kB gzipped on the single file. |
| 9 | Remix links: a drawing travels in its link | A | The viral loop: a recipient opens the exact drawing, watches it grow (Replay runs once) and keeps drawing on it. A drawing is already a list of small deterministic recipes, so the link carries the document itself in the URL fragment: no backend, and nothing leaves the device until the person sends it. One menu item, no shortcut, so the control budget is unchanged (the menu grows to nine items). **Encoding, measured** on e2e-drawn documents (pen strokes of 110–140 samples; full link length in characters, plain gzip of the `.rise` text → the shipped encoding): 10 strokes 25 410 → **13 753**; 50 strokes 150 117 → **82 346**; 10 strokes in 6-fold symmetry (60 recipes) 38 501 → **20 073**; 50 in 6-fold (300 recipes) 171 098 → **74 681**. Float32 samples are noisy in their low bits, so base64 text gzips poorly; word deltas per column in byte planes save about 45 %. Rejected: second-order deltas (5–8 % larger), XOR deltas (smaller win), quantising samples (breaks bit-identical cooking), Brotli (not in `CompressionStream`). Symmetry copies already share their arrays in memory but `serializeDoc` writes each copy's arrays in full; the link stores each distinct array once. **Limit 32 768 characters:** every browser opens it, and Slack (40 000), WhatsApp (65 536), iMessage and email carry it whole; Discord, Telegram and SMS cut far shorter links, so no realistic limit serves them. That fits about 20–25 ordinary strokes or about 15 symmetry gestures; larger drawings get a plain "too big" toast pointing at Save project. Share timelapse uses the link as its share url when it fits. Cost: +4 kB minified, +1.2 kB gzipped on the single file. |
| 10 | Share timelapse: drop the `MediaRecorder` fallback | A | Review of #8. It served only browsers with `MediaRecorder` but no WebCodecs H.264 encoder (in practice Safari 14.1–16.3), was the one path no test exercised, and by its nature made the worse video: wall-clock stamps, dropped frames when the main thread is busy, WebM where the platform lacked MP4 recording, and a real-time wait. Those browsers get the PNG with a toast that says why, which was already the path for browsers with neither. −110 lines in `export/timelapse.ts`; WebCodecs output is unchanged frame for frame. |
| 11 | Share timelapse for the feeds: result-first loop, 9:16 from phones, legible mark | A | Judged on recorded frames of five drawings (6-fold Spectral mandala, Paper scene, Ripple, a 3-stroke doodle, 40 strokes). Before: frame 0 was a near-empty canvas, which is the poster a chat app shows; the loop cut from the finished piece to that empty frame (mean \|Δ\| 3–18 between the last and first frames); and the wordmark was 23 px at 42 % opacity, about 8 pt on a phone. Now frame 0 is the finished piece dissolving into the replay, so the first second already moves, and the loop seam is under 1.1 (encoder noise). On Night the bloom swells once as the last growth ends. The vertical frame is chosen by device, not by `canShare`, because a phone's video goes to the 9:16 feeds whether it leaves by the share sheet or the camera roll. The feeds overlay the bottom 520 px and the top 240 px, so the drawing and the mark stay clear of both. Tried and dropped, because the frames showed no gain: skipping unchanged frames (lossless, no measurable speed-up in time-to-video) and a deeper encode queue; encoder settings (realtime, hardware, software, 6 Mb/s) also left the time unchanged. In headless Chrome the cost is the emulated GPU compositing, not the code. Progress now uses each play's real end time, so the toast no longer stalls at 80–90 %. |
| 12 | `scripts/shrink.ts`: match renamed members by declaration | A | Found while judging the timelapse frames: every replayed trunk appeared whole at its first frame, in Replay as well as the video. 13 references in `render/live.ts` (`arcReveal`, `sVis`, `depthPending`, `requireSettled`, `maxW`, `camRev`, `groundRev`, `beyond`) were left unrenamed by the build. Fixed by matching on the declaration; `tests/build.shrink.test.ts` resolves every `this.<member>` in `live.ts` with an independent checker. Same bundle size. |
| 13 | A fifth hint makes sharing discoverable | A | Share timelapse and Copy remix link live in the menu, where a new user never looks, and every share is a visitor. No control is added: it is the existing hint system with its rules (once ever, in prefs; one at a time; never while drawing; gone after 4 s or when you share). **The moment:** the first pause of 4.5 s once the drawing has 6 strokes. Six strokes is past the rise hint (stroke 5) and is a drawing, not a test scribble; the pause means growth has settled and the user is looking at the result, which is when "share it" makes sense, while mid-flow it would interrupt. The pause outlasts any hint shown at the last lift, so it never stacks on the rise or nav hint. **Rejected:** right after Replay ends (the moment you just watched it grow, but Replay is also in the menu, so only users who already found Share would see it); on stroke count alone (fires mid-flow and fades unseen while drawing); after export (the user is already sharing). The text names the shortcut on desktop (`⇧P`, as the menu shows it) and the path on touch, since a hint is not a button. Using either share item marks it done for good. |
| 14 | Share timelapse: desktops download, and a closed sheet offers Save | A | Reported from Windows: Shift+P ended on a **Share** toast that opened the Windows share sheet, which lists few apps (not Discord desktop) and whose Copy pasted nothing usable in Discord, and nothing ever saved the file. Desktop Chrome and Edge on Windows report `canShare({ files })` true, and the e2e scenario hid this by stubbing `canShare` away. Now the sheet is used only on a coarse pointer, the same device test as the 9:16 framing: phone sheets reach the feed and chat apps and include Save to Photos / Files, while on a desktop a downloaded file drags into any app. On a phone, closing the sheet turns the toast into **Save** (one action per toast, so the control budget is unchanged), so there is always a way to keep the file. The e2e scenarios now offer a share sheet on both: the desktop asserts it stays closed and the file downloads; the phone shares, closes the sheet, taps Save and gets the file. Both fail on the previous code. |
| 15 | Remix links v2: the link carries the drawing rounded, judged by cooking, not its exact bits | A | #9 required the remix to cook bit-identically to the sender's drawing. That rule was ours, not the product's: what matters is that the recipient sees the same drawing and their copy is deterministic. Dropping it lets the input be rounded. **Measured, not guessed** (headless Chrome, real engine, original vs rounded at the fitted view and at 4× zoom, pixels off by more than 16 in any channel): positions are the sensitive column (1/8 sp doubles the change of 1/16 sp); time from 1/4 to 1 ms changes nothing; pressure below 10 bits, tilt below 8 and crowding below 8 start to show; so the knee is 1/16 sp, 1 ms, 2⁻¹⁰, 2⁻⁸, 2⁻⁸. **Why a judge and not per-Form rules:** growth that branches on its input is chaotic on some strokes whatever the Form. On sharp zigzag scribbles over other ink every Form rearranged (Sprout 12 % of pixels, Burin 10 %, Drift and Craze 7 % at the fitted view), and even 1/4096 sp or 1/1024 ms alone moved Drift's filaments; the same Forms on smooth strokes moved only sub-pixel. So the app cooks each rounded recipe against the original (every point within a 1 sp cell of the other's), tries 1/128 sp then 1/1024 sp grids, and otherwise sends that recipe exact. Judging costs 10–170 ms per link (symmetry copies are judged once per gesture). **Result** (rounded vs original after the judge, pixels off by more than 16 at fit / at 4×): 6-fold Spectral mandala 0.72 % / 3.6 % (edge shifts of under a pixel), Ripple 0.10 / 0.18 %, Sprout with holds and pools 0.23 / 0.09 %, fast crowded scribble 0.11 / 0 % (3 of 4 strokes sent exact), Echo 0.05 / 0.12 %, Caustic and Plume 0.17 / 1.2 %, a 50-stroke piece of all eleven Forms 0.29 / 0.99 %; mean difference at most 0.25/255 at fit. Side by side none is distinguishable. **Packing:** a lossless grid coder (power-of-two exponent per column, first or second differences as zigzag varints) replaces byte planes for rounded arrays; second differences save 7–11 % on smooth paths and steady clocks. **Sizes** (full link, characters, v1 → v2): pen strokes drawn like the e2e suite: 10 strokes 19 669 → **8 117**, 50 strokes 105 034 → **39 509**, 10 gestures in 6-fold symmetry (60 recipes) 24 437 → **11 055**, 50 in 6-fold (300) 94 145 → **43 353**; with pen noise in pressure, tilt and timing: 10 strokes 24 886 → 9 666, 50 strokes of all Forms 135 430 → 61 234, 10 gestures 6-fold 31 301 → 13 866, 50 gestures 6-fold 139 209 → 62 513. That is 2.2–2.7× (not the 4× hoped for: crowding, time and pressure are noisy at any visible-safe grid, and strokes sent exact cost what they did). **Fit under 32 768** (the first N of each drawing): 39 e2e-style strokes or 35 symmetry gestures (v1: 17 and 14); with pen noise 26 strokes or 25 gestures (v1: 13 and 9). The cap stays: Slack cuts at 40 000 characters, so raising it buys little and risks the cut. Version 1 links keep opening, bit-exact. Rejected: dropping bit-identity per Form (chaos is per stroke), a fixed fine grid for everything (saves little), coarser time with forced steps (would stretch fast input). |

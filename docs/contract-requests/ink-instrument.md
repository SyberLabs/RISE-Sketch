# ink-instrument: contract requests and integration notes

Each entry: problem, proposed change, workaround used. None of these block anyone; every
listed export in BUILD.md §2 exists with its listed signature.

## 1. app/draft.ts should append a final sample row at pointerup

**Problem.** The seated stop (DESIGN §2.2.2: `v_exit_n < 0.15` and dwell ≥ 60 ms) is a lift
zone measured from the stored rows. Mouse, trackpad and most touch screens send no
`pointermove` while the contact is still, and `InputSink.strokeEnd(how)` carries no sample,
so a mouse that stops and waits before releasing leaves no evidence of the dwell in the
recipe. Seated stops then never trigger for mouse/touch.

**Proposed change (app behaviour, no type change).** At `strokeEnd('commit')`, before
freezing, app/draft.ts appends one row that repeats the last row's X/Y/P/ALT/AZ/R/C/CS with
`T = lift time` (ms since down, same clock, sanitised `≥ t_prev + 0.25`).

**Workaround used.** None possible inside ink/. With the extra row, `endDwell()` measures the
wait and the end flush is unaffected (the lift point equals the last position). Pens already
stream rows while still, so pen behaviour is the same either way.

## 2. `Learner.observe` needs the stroke's zoom

**Problem.** The listed signature `observe(d, samples, rows, jitter)` has no `z`. Rows are in
doc units, so the learned `vMed` (sp/ms) is wrong at any zoom other than 100%.

**Proposed change.** An optional fifth parameter: `observe(d, samples, rows, jitter, z?)`.
Implemented that way (backward compatible). **app/ should pass `recipe.z`.**

## 3. `Spine` could carry `z`

**Problem.** `Spine.x/y` are doc units while every gesture measure is in sp; a pure consumer
that only has a `Spine` (e.g. `closureTest(sp, wasClosing)`) cannot convert.

**Proposed change.** Add `z: number` (sp per doc unit) to `Spine` in core/types.ts.

**Workaround used.** ink/spine.ts exports `interface InkSpine extends Spine { z: number }` and
every spine it creates is an `InkSpine`. `envelope.spineZ(sp)` reads it, or estimates z from
arc vs chord for foreign spines.

## Integration notes (no change requested)

- **Rise input.** `SpineBuilder.tip(now)` returns exactly what `RiseInput` needs: filtered
  tip x/y (sp, relative to origin), `s` (provisional end arc), `travel`, and `p` (calibrated
  for pens; for mouse/touch the synthesised pressure advanced to `now` on the rAF clock, so a
  still mouse pools at ≈ 0.9). `now` is ms since pen-down.
- **Closure.** Call `closureTest(cook.spine(), draft.closing)` once per rAF and feed the result
  to `cook.setClosing`. `SpineBuilder.finish(closed?)` takes an optional override; by default
  it reads `StrokeRecipe.closed` / `DraftStroke.closing`, so freezing `closed = draft.closing`
  keeps `cook(r) ≡ finish(r)`.
- **Lift zones.** `finish()` edits previously settled stations only on closed strokes, and only
  x/y/nx/ny/k with `s ≥ L − W − 6` (W = `weldWidth(len, gap)` ≤ 50 sp) or `s ≤ s0 + 6`. For a
  live weld preview, run the exported `weldSpine(copy, z)` on a copy of the live spine. It is
  the exact function `finish()` applies. The weld is tangent-continuous: the tail arrives in
  the start's direction (no kink at the seam) unless the two directions differ by more than
  ~60° (a deliberately pointed loop keeps its point).
- **End-flush timing.** On a finished stroke the stations of the end-flush segment (filtered
  tip → raw lift point) run on past the last row's time by the filter time constant τ
  (typically 3–45 ms, at most ~133 ms), so `Spine.t` strictly increases to the end and `vn` is
  continuous there. Do not assume `t[n−1]` equals the last sample's T.
- **`tip().travel`** includes `s0`, i.e. it is the travel of the whole (possibly split) stroke,
  so `RiseInput.travel` from it never blooms a continuation at s = 0.
- **Corrupt rows** (non-finite X, Y or T) are skipped by the spine, the envelope's speed and
  dwell measures and the learner; Rise ignores a non-finite tip and treats a NaN ceiling as
  uncapped. No NaN can reach a station, an envelope or a pool row from them.
- **Entry taper.** `liveEnvelope(...).teFinal` says when Te can no longer change from more
  samples (≥ 40 ms of rows). Closure toggles Te between its value and 0 (head zone ≤ 30 sp).
  The trunk tessellates with `TeTrunk` (= min(Te, 0.25·len) at lift); operators use `inF`.
- **Auto-split.** Take `snapshot()` right after appending the rows of piece 1; commit piece 1
  with those rows and `cut |= 2`. For a cut tail, `finish()` keeps exactly the stations that
  were settled, so piece 1 ends on the snapshot station. The continuation gets
  `s0 = snap[RESUME.S]`, `cut |= 1`, `resume = snap`, and
  `samples = continuationSamples(rows, n, snap)`. Its spine starts on that same station.
- **Spine.L** is the absolute end arc `s[n−1]`. For split pieces the length is `L − s0`.

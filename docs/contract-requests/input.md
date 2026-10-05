# Contract requests: input

## 1. Pen-mode change and finger-pan notifications (InputController)

**Problem.** `AppState.penMode` must track pen mode, which flips on the first pen event
(including a bare hover), at the 30 min expiry, and on `disablePenMode()`. The §4 toast
"Fingers pan while a pen is in use" must show on the first pen-mode one-finger pan of a
session. The frozen `InputController` has only a `penMode` getter, and `InputSink.pan`
cannot tell a one-finger pan from a pinch, wheel or Space-drag.

**Proposed change.** Add to `InputController` (src/input/types.ts):
```ts
onPenMode(fn: (on: boolean) => void): () => void;
onFingerPan(fn: () => void): () => void;
```
(or the equivalent sink methods `penMode(on)` / `fingerPan()`).

**Workaround used.** `createInput` returns `InputControllerEx` (exported from
`src/input/index.ts`), a structural superset of `InputController` with exactly these two
methods plus `readonly state: ArbiterState`. `onPenMode(false)` fires when the 30 min
expiry happens (a single re-armed timer), not lazily at the next touch, so
`AppState.penMode` (help rows, hints) never goes stale. app/ can type its handle as
`InputControllerEx` today; nothing else changes.

## 2. Touch-only double-tap defers the tap's strokeEnd (document on InputSink)

**Problem.** DESIGN §3.4: on touch-only devices a double-tap selects and "the first tap's
seed un-grows, with no history entry". The first tap is an ordinary stroke (radial seed)
that starts at once for latency. To withdraw it without a history entry, its
`strokeEnd` is deferred for the double-tap window (300 ms). A second tap within 24 px then
gets `strokeEnd('withdraw')` + `select(x, y, true)`; otherwise it gets `strokeEnd('commit')`.

**Consequence for app/.** For a touch tap, `contact(false)` arrives at the real lift and
`strokeEnd` arrives up to 300 ms later. app/draft.ts should stop stepping `rise` at
`contact(false)` and use that time as `t_up` for the lift guard. (With no moves after the
lift, a 300 ms tail would otherwise start a faint pre-halo at the finger's 350 ms threshold.)
Any other gesture, mouse press, key, wheel, page hide, or press on the chrome commits
the pending tap first, so history order is never disturbed. The one exception is a pen
touching down inside the window: the tap is then taken for the hand landing just before
the pen (only possible on the first pen use, since pen mode has no finger strokes) and
gets `strokeEnd('withdraw')`, exactly like a live finger stroke under a landing pen.

**Proposed change.** Document this on `InputSink.strokeEnd` / `contact`, or add an
explicit `strokeLift(): void` that fires at the physical lift.

## 3. `select(x, y, add)` semantics (document on InputSink)

- Mod-click passes `add = shiftKey`.
- Pen-mode finger taps and touch double-taps pass `add = true`, because "tap more ink"
  adds to the selection (§3.4).
- **app/ should deselect on a miss regardless of `add`**, since "tap empty canvas"
  deselects on touch.
- Lassos from touch double-tap-drag and pen-mode hold-drag pass `add = false`.
- Mod-drag passes `add = shiftKey`.

## 4. Object reuse (document on InputSink)

The note "reused objects: copy what you keep" is only on `strokeMove`. The input layer also
reuses the sample passed to `strokeBegin` and the object passed to `hover`. `KeyAction`
values are shared frozen constants. Proposed: put the note on the interface doc.

## 5. `contact(true/false)` is sent only for contacts that draw, erase, lasso or navigate

Clicks never hide the chrome: Mod-click, Alt-click, pen-mode finger taps, the second tap
of a double-tap, a bare right-click, and a 2-finger tap that never drew. Hiding the chrome
for 700 ms after a selection click would delay the selection feedback (dock outline,
Delete). Proposed: reword the `contact` doc from "Any contact on the canvas" to
"Any drawing, erasing, lasso or navigation contact".

## 6. Notes for render/app (no change needed)

- `strokeMove(samples, predicted)` already provides a capped prediction: up to 16 ms and
  24 sp past the last real sample. It comes from `getPredictedEvents()`, or from a line fit
  through the last 3 samples. The overlay should draw it as is, without extrapolating again.
- Stroke sample `t` is strictly increasing within a stroke, including the begin sample
  and the lift sample. The lift sample is emitted only if it moved ≥ 1 px, and a pen's
  zero lift pressure is replaced by the last pressure, so it never fakes a ramp-down.
- `navEnd('pinch')` is sent only when zoom engaged (the 4 % dead zone was exceeded);
  a two-finger pan without zoom ends with `'drag'`. `navEnd('wheel')` comes 400 ms after
  the last wheel event (the burst gap). A quicker tile settle is the renderer's choice.
- Pen mode is remembered across reloads under `localStorage['rise:penmode']`
  (wall-clock ms of the last pen event; expires after 30 min). input/ writes it directly,
  because it may import only core/. `disablePenMode()` clears it. "Reset calibration"
  may also clear it if desired.

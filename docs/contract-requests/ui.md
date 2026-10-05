# Contract requests: ui

Each entry: problem, proposed change, workaround used.

## 1. Screen-space selection bounds for Delete (AppState)

- **Problem.** DESIGN §4 places Delete "just above the selection's bounds" on desktop / tablet. AppState
  carries only the selected ids, so the UI cannot know where the selection is on screen.
- **Proposed change.** Add to `AppState`:
  `selectionRect: { x: number; y: number; w: number; h: number } | null` (viewport CSS px, updated on
  camera settle and selection change).
- **Workaround.** `ui/selectionbar.ts` reads an optional `selectionRect` from the state object
  (`AppStateWithRect`). If the app supplies it, Delete sits centred 12 px above it (below it near the
  top edge, clamped to the viewport). Without it, Delete sits centred just above the dock, as in the
  §4 selection wireframe. Phones always use the dock's leading slot.

## 2. `chromeHidden` semantics (clarification)

- **Problem.** The comment says "chrome is hidden (fades back 700 ms after release)" without saying who
  owns the delay. The early return near the dock (§4) needs the pointer position and the dock rect, which
  only the UI has.
- **Decision / request.** The app sets `chromeHidden` to the raw contact state (true on the first canvas
  contact, false when all contacts lift). The UI owns the 700 ms return delay, the early return (mouse
  within 80 px of the dock, hovering pen within 96 px) and the 90 ms / 220 ms fades. Please do not delay
  `chromeHidden = false` in the app, or the return becomes 1.4 s.

## 3. The selection's style is not in AppState

- **Problem.** §3.4: "Tap the selection's own Form tile again → Reseed", and "with a selection, recent slot
  1 shows the selected stroke's colour". The UI sees `tool`, not the selection's recipes.
- **Proposed change.** While a selection exists, the app mirrors the selection's uniform style into
  `tool` (nib, ink/custom, form; leave a field unchanged when the selection is mixed) and puts the
  selection's colour in `tool.recents[0]`.
- **Workaround.** The UI always dispatches `pickForm` (never `reseed`) from the Form sheet; the app must
  treat `pickForm` of the selection's own Form as a reseed. Recent slot 1 is labelled "Selection" while a
  selection exists and dispatches `pickCustom` with `tool.recents[0]`.

## 4. One-shot bends from the keyboard

- **Problem.** Bend intents are "relative to the value at drag start", but a keyboard step (§10: ArrowUp /
  ArrowDown on a focused chip) has no drag.
- **Decision.** A key step is sent as a single intent with `done: true` (for example
  `{ k: 'bendDepth', delta: 0.25, done: true }`) with no preceding `done: false`. The app must treat a
  `done: true` bend without an open drag as a complete one-step bend (one history entry when it targets a
  selection). A drag whose pointer is cancelled by the system ends with neutral values and `done: true`
  (`factor: 1`, `delta: 0`, `dh: 0, dL: 0`).

## 5. Wiring notes for app (no contract change)

- `ui/index.ts` imports `../styles.css`; `main.ts` must not import it again, and `index.html` does not
  link it.
- Glyph canvases: before each `glyphs.chip` / `glyphs.tile` call the UI sets `canvas.width/height` to the
  canvas's CSS box × dpr (dpr ≤ 3). Glyphs should draw to the backing-store size it is given.
- The UI dispatches `hintDone` when a hint dismisses itself after 4 s, and for `draw` at the first canvas
  contact; it also honours `hints[id] === 'showing'` without an event (default texts) and hides a hint
  when its state becomes `'done'`. Please make `hintDone` idempotent.
- During replay the UI lays a transparent catcher over the page; a `pointerdown` on it dispatches
  `stopReplay` (so that touch does not start a stroke).
- Pressing the canvas while a sheet is open hits the sheet backdrop: it dispatches
  `openSheet: null` and does not draw.

## 6. `GROUND_TOKENS.night.uiBorder` (render-core, for consistency)

- **Problem.** `#636975` gives 2.2:1 against the 86 % surface when bright additive ink sits under it,
  below the §10 rule (control edges ≥ 3:1).
- **Workaround.** `styles.css` uses `#80868f` for Night (≥ 3:1 over the ground and over white light;
  checked by `tests/ui.contrast.test.ts`). Paper warning and danger text were darkened for the same reason.
  render-core may want to adopt the same value if it draws UI edges on canvases.

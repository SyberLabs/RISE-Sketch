# render-core: contract requests and integration notes

Each entry: problem, proposed change, workaround used. No frozen contract needs changing. Every
export listed in BUILD.md §4 exists with its listed signature; additions are optional parameters
or new exports.

## 1. Convention for chunked polys (ink-forms): share the boundary point exactly

**Problem.** DESIGN §6.3 says trunk chunks "share an edge exactly", but `Cooked` has no per-poly
flag saying which end continues into a neighbour. Two round caps at a chunk boundary overlap and
double-add a bead under 'lighter' (Night), and leave a darker bead under 'multiply' (Paper).

**Proposed change (convention, no type change).** Emit consecutive polys of a chunked run
(trunk chunks, brush bristle chunks, Drift filament thirds) so that:
- poly i+1 comes immediately after poly i in the poly order;
- poly i's last point equals poly i+1's first point bit for bit (x, y, w; for chisel also `ang`);
- both have the same `kind` and `gen`, and for gen ≥ 1 the same `unit`.

**What render-core does.** `tracePoly` detects this and welds the two polys with one shared flat
edge (the miter at the shared point, computed identically from both sides). Ribbons get a
perpendicular-ish miter edge; chisels are clipped on the nib line through the shared point.
Joints sharper than 60° fall back to caps. Gen ≥ 1 polys with different `unit` never weld, so a
branch that happens to start at its sibling's tip still gets its round cap.

## 2. Hot ink on Night needs alpha above 1 (render-live)

**Problem.** DESIGN §3.2 draws hot chunks at `α·(1 + h·η)`. The trunk has α = 1, so on Night the
hot trail would be clamped to 1 and never look hotter.

**What render-core does.** `drawCooked(..., { hot })` multiplies the bucketed alpha exactly (it is
not re-bucketed, so the trail cools continuously and lands exactly on the committed alpha at
η = 0). On 'lighter', an alpha above 1 becomes a second additive pass of (alpha − 1). On
'multiply', alpha is clamped to the ground's alphaMax (0.85, Paper safety; see §6).

## 3. Chisel core width without S (no change requested)

**Problem.** DESIGN §6.4: the chisel core is `0.12S` thick, but `Cooked` carries only the edge
length E per point (`w`), with the envelope applied.

**Workaround used.** Core thickness = `0.15·E` (equal to 0.12S at p = 0.5, since E = S·(0.6 + 0.4p)).
It tapers with the envelope like the nib, which is what a real broad-edge nib does.

## Integration notes (no change requested)

- **Coordinates.** Every render-core drawing call takes `m` = doc-relative-to-origin → device px
  (`viewMatrix(origin, cam, cssW, cssH, dpr)` for the viewport, `regionMatrix(origin, box,
  pxPerDoc)` for tiles/export/glyphs). `drawCooked` saves/restores the context and draws with an
  identity transform; `clipDev` is in the same device px.
- **Batching and hand-off.** Overlaps union only inside one `drawCooked` call. To match a tile
  pixel for pixel, the live layer should draw a stroke's overlapping polys in one call (use
  `polys` + `clipDev`, not one call per poly).
- **Reveal.** Pass `reveal` and `drawCooked` handles chunk welds: it welds a chunk's start only when
  its predecessor is fully revealed, and its end only when its successor has started. Growing tips
  are round. For sub-ranges of one poly (the 12 sp hot-window chunks) use `TraceOpts.arcFrom` /
  `arcTo`: adjacent ranges share their cut edge exactly.
- **LOD.** `lodBytes(c)` reports the bytes of a stroke's lazily built decimated copies, so the
  Cooked LRU can count them (DESIGN §6.8). `commitScale(c)` recovers z from the arc column.
- **Ledger.** `createLedger(cls?, make?)` returns a ledger with extras:
  `alloc(w, h, tag, ctxSettings?)` (e.g. `{ desynchronized: true }` for the overlay), `adopt`,
  `byTag`, `count`. The cap is a budget that triggers `onPressure` evictors. `null` is returned
  only when the browser refuses a context twice.
- **Ground.** `applyGround(el, g, animate)` creates two absolutely positioned layers inside `el`
  and makes `el` its own stacking context (`isolation: isolate`), so the layers' z-index never
  covers the ink canvases. The 400 ms cross-fade keeps the old ground opaque underneath until the
  fade ends. Re-call it after a devicePixelRatio change to keep the grain at one texel per device
  pixel. `paintGround` matches the CSS ground to within 0.1 of an 8-bit level (measured).

## Review addendum (render-core reviewer)

### 4. Chunk boundaries near sharp corners (for ink-forms): convention request, no type change

**Problem.** Adjacent chunks are separate fills (different tones), so they must partition the ink
exactly or the overlap double-adds (a bright fleck on Night, a dark one on Paper). A flat shared
edge (weld) is an exact partition on curves and at gentle corners. render-core clips each piece's
outline at its flat ends, which makes curves and corners up to 30° exact. A weld lying within about
w/2 of a SHARPER corner station cannot be exact with a straight edge: the corner's far arm crosses
it. There render-core keeps the overlap rather than cutting into legitimate ink. Measured on a
w/2 = 15 px ribbon, a corner of 35–100° near a cut leaves roughly 20–160 px² of double coverage.

**Proposed convention.** When a trunk chunk boundary would fall within w/2 (of the local width) of
a spine station flagged `corner` (turn > 30°):
- for turns ≤ 60°, put the boundary EXACTLY at the corner station. The weld then splits on the
  corner's bisector, which is exact;
- for turns > 60°, move the boundary at least w/2 away from the corner. A joint sharper than 60°
  falls back to round caps, whose overlap is a bead.

**Workaround used.** None needed for correctness. Without the convention the overlap simply stays.

### 5. Hot-window cuts (for render-live): integration notes

- `TraceOpts.arcFrom/arcTo` are snapped, by at most 2 device px: onto the poly's own ends (within
  2 px), else to a 1 px grid along the arc, else onto an interior station within half a pixel
  whose vertex turns ≤ 60° (where the cut edge becomes the vertex bisector, i.e. exact). Reason:
  measured in Chrome, two different fill edges inside one pixel row (a sub-pixel or ~1 px range
  between two fills) come out up to 25 % too dark or too bright. Pass the SAME number to both
  neighbours of a cut. A range that snaps empty draws nothing and returns false.
- For exact splits at sharp corners, choose hot-window cut arcs at corner stations (≤ 60°), or
  keep them w/2 away from corners sharper than 30°, as in §4.

### 6. Alpha semantics of drawCooked (render-live, render-world, glyphs)

- The bucketed value is the poly's design alpha (× the hairline / dot-area factor). The ground's
  `alphaMax` and `alphaScale` multiply it EXACTLY at fill time. So Paper never exceeds 0.85
  (before this review, 0.85 bucketed to 0.875), a fade via `alphaScale` is continuous, and
  batching never depends on `alphaScale`. Fill alpha is clamped to 1 (Night) or alphaMax (Paper).
  Canvas ignores globalAlpha > 1 and would keep the previous batch's alpha.
- The generation cull uses alphaMax but not `alphaScale`, so a fade never pops generations.
- The stroke-cull dot (stroke < 3 device px) now honours `polys`, `reveal` and `hot`: its alpha
  counts only the drawn part, so a stroke split across #dry/#wet sums to one dot, not two.

### 7. Per-poly `box` and dirty rects (render-live, render-world)

A ribbon's miter vertex reaches up to 1.155·w/2 from its point (turns ≤ 60°), beyond the `box`,
which holds points ± w/2. Pad a poly box by `0.08 × min(box width, box height) + 1` device px
before using it as a dirty rect or a tile-intersection test (drawCooked's `clipDev` test already
does this). Otherwise a thick corner beside a tile seam or a cleared rect loses a sliver.

### 8. Other behaviour changes from the review (no contract change)

- A chisel weld also requires the same `ang` at the shared point (one nib line).
- A single-station chisel poly draws the nib footprint (E × core), not a disc of diameter E.
- Welds under a morph use the morphed (drawn) positions. drawCooked unwelds neighbours whose
  `morph.t` differ.
- `drawCooked(..., { lod: false })` draws sub-pixel dots at their true size.

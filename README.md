<p align="center"><img src="docs/assets/rise-sketch-logo.jpg" width="120" alt="RISE Sketch logo: a glowing blue pen nib over a curved stroke, on dark green"></p>

<h1 align="center">RISE Sketch</h1>

**Your stroke is the seed. Hold still, and it rises.**

RISE Sketch is a drawing instrument where every mark is alive. You draw a stroke, and a growth *Form*
grows it: into coastline, crystal, botany, smoke, feathers, braids, a hand's breadth behind
the nib. There are no sliders. The ink reads your hand instead: speed, pressure, lean, stillness,
zoom and the ink already on the page.

It runs in any modern browser, works offline, and ships as a single HTML file.

## The three primitives

At the bottom of the screen are three chips. **Tap a chip to choose a kind; drag it to bend that
kind's one amount.**

| Chip | Tap to choose | Drag to bend |
|---|---|---|
| **Stroke** | the nib: Pen, Brush, Chisel — or Erase | size |
| **Color** | the ink: Graphite, Indigo, Oxide, Ochre, Moss, Rose, Spectral, plus two recent custom inks; and the ground, Night or Paper | hue (sideways) and tone (up/down) |
| **Form** | what the stroke grows into (below); and symmetry, Free or Mirror / Kaleido | base depth |

The sheets show *your own last stroke* drawn through each option, so you can see what you'd get.

### Forms

| Key | Form | What it grows |
|---|---|---|
| 1 | Line | the bare stroke, weathering into coastline as it deepens |
| 2 | Echo | the stroke folds into itself as a crystal; a closed loop becomes a snowflake |
| 3 | Sprout | branching botany; a tap bursts into a bush |
| 4 | Drift | silky smoke pouring off the stroke |
| 5 | Craze | a drying film that cracks into a cellular network |
| 6 | Plume | a feather vane; speed ruffles it, a loop becomes an eye-spot |
| 7 | Caustic | the stroke as a mirror; light folds into caustics at bends |
| 8 | Burin | engraver's hatching on the shadow side |
| 9 | Plait | three strands braiding over and under |
| 0 | Orbit | a rope of looping orbits; a tap draws a spirograph rose |
| — | Ripple | interference contours that breathe and beat into moiré; a tap is a bullseye |

### Symmetry: Mirror and kaleidoscope

The Form sheet has one switch, **Free | Symmetry**. Turn it on and every stroke you draw is repeated
around the centre of the view (where you were looking when you switched it on): reflected across a
vertical axis for **Mirror**, or turned into **3, 4, 5, 6, 8 or 12** copies for the kaleidoscope
(6 by default). Drag the switch sideways (or press its arrow keys) to change the number of folds;
the switch and a small badge on the Form chip show them as spokes. A faint hairline shows the axis
or spokes; it is never something you can grab.

The copies draw live with your stroke and grow exactly like it. With **Spectral** ink each copy
turns the hue a step further round the wheel, so a six-fold mandala is a rainbow. One undo removes
the whole gesture; each copy is its own stroke afterwards (erase, select and restyle it alone;
`R` reseeds the last gesture as a whole). To move the centre, switch symmetry off, look somewhere
else, and switch it on again.

## How the ink reads your hand

**Speed = wildness · Pressure = weight & opening · Hold = rise · Lean = direction · Zoom = scale · Nearby ink = awareness**

- **Hold still** mid-stroke and the ink *pools*: growth deepens right where you paused. With a pen,
  easing off the pressure during a hold lets it settle back. The first undo drains a pool; the
  second removes the stroke.
- **Tap** to plant a seed; hold before moving to make it bloom.
- **Close a loop** and the ends weld seamlessly.
- **Zoom in** for finer marks — nib size is in screen pixels.
- Rise learns your lightest and heaviest touch, your speed and your hand's tremor, then holds still.

**Night** composites ink as light (overlaps glow); **Paper** composites it as pigment (overlaps
glaze). The same drawing works on both; press `G` to switch.

## Gestures

**Mouse / trackpad:** drag to draw · right-drag to erase · wheel or pinch to zoom (a trackpad scroll
pans) · Space-drag to pan · Ctrl/⌘-click to select, Ctrl/⌘-drag to lasso (Shift adds) ·
Alt/⌥-click to sample a colour from the ink.

**Pen + fingers (tablet):** the pen draws (eraser end or barrel button erases) · one finger pans,
two fingers pan and zoom · tap ink with a finger to select, hold then drag to lasso · two-finger
tap undoes.

**Symmetry (every device):** Form chip → the Free | Symmetry switch; drag it sideways for more or
fewer folds.

**Touch only:** one finger draws · two fingers pan and zoom · two-finger tap undoes · double-tap ink
to select (then drag to lasso) · double-tap the canvas to deselect.

With strokes selected, the chips restyle the selection, and tapping the selection's own Form again
reseeds it.

## Keys

| Key | Action |
|---|---|
| `1`–`9`, `0` | choose a Form |
| `B` / `Shift+B` | next / previous nib |
| `C` / `Shift+C` | next / previous ink |
| `G` | Night / Paper |
| `E` | erase mode |
| `[` `]` | size smaller / larger |
| `-` `=` | depth shallower / deeper |
| `R` | reseed the selection, else the last stroke |
| `M` / `Shift+M` | symmetry on / off (centred on the view) / next fold count |
| `Ctrl/⌘+Z`, `Ctrl+Y` / `⇧⌘Z` | undo / redo |
| `Ctrl/⌘+A` · `Del` · `Esc` | select all · delete selection · deselect / close |
| `Shift+1` / `Shift+0` | fit the drawing / 100% |
| `P` | replay the drawing |
| `Shift+P` | share a timelapse video of the drawing |
| `Ctrl/⌘+S` · `Ctrl/⌘+O` · `Ctrl/⌘+E` | save `.rise` · open · export PNG |
| `?` | gestures and keys |

## Files

- Your drawing **autosaves** in the browser. The menu lists **Recent** drawings; **New** keeps the
  old one in Recent.
- **Save project** downloads a `.rise` file (the drawing as recipes, so it reopens exactly);
  open it from the menu or drop it on the canvas. Files are format version 2 (symmetry copies);
  version 1 files still open.
- **Export image** saves a high-resolution PNG framed to your drawing.
- **Replay** redraws the whole drawing, stroke by stroke, as it was made.
- **Share timelapse** turns that replay into a 6–12 second video (MP4, 1080 px square, or 4:5 for a
  tall drawing) of the ink growing, on your ground, with a small `sketch.syberlabs.io` mark. Where
  your device can share files, a **Share** button opens the share sheet; otherwise the video
  downloads. You can keep drawing while it records.
- **Copy remix link** copies a link that carries the drawing itself. Whoever opens it gets that
  exact drawing as a new document, watches it grow, and can keep drawing on it; their own drawing
  stays in Recent. The drawing rides in the part of the link after `#`, which browsers never send
  to a server, so it stays private until you send the link. Links are capped at 32 KB (about 20
  strokes, or 15 symmetry gestures); a bigger drawing says so, and Save project shares it instead.
  A shared timelapse carries the remix link when it fits.

## Building and running

Requires Node 20.19+ or 22.12+.

```sh
npm install
npm run dev            # development server
npm run build:single   # dist-single/index.html: one self-contained file, opens by double-click
npm run build          # regular multi-file build in dist/
```

Checks: `npm run typecheck` · `npx vitest run` (unit tests) ·
`npm run build:single && node scripts/e2e.mjs` (end-to-end in headless Chrome; set `CHROME_PATH`
if Chrome isn't in the default location; `--budget` runs only the control-budget scenarios).

## For contributors

- `docs/DESIGN.md` — the product and technical specification.
- `docs/BUILD.md` — module ownership and the contracts between modules.
- `lab/forms/` — the forms lab, where new Forms are prototyped against the real pipeline
  (see `lab/forms/README.md`).
- `procedural-ink.html` — the original single-file demo Rise grew from.

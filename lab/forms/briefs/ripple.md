# Ripple — interference moiré contours

| | |
|---|---|
| file | `lab/forms/ripple.form.ts`, `ops.id 'ripple'`, `v 107` |
| ink | spectral (rings deepen and shimmer in hue outward; any ink works) |
| locality | local chain, `reach 52`, `halfWin 52` (12 sp unit + 40 sp cleanup window), trunk plain `{w 1, α 1}` |
| depth | `dMax 6`, `baseDefault 2`, `radialCeiling 6` |
| budgets | `unitBudget 640` (ceiling drops in 1/16 steps above it), `strokeBudget 16000` (causal) |
| mood | bold · op-art · light (an interference field on Night, survey-map contours on Paper) |

## Concept

The stroke is a ridge on a survey map, or a line laid in still water: contour rings run parallel to it on both sides, ever wider apart outward, and wrap round the open ends. Each ring breathes along the arc in a slow sine whose phase lags ring by ring, so density waves sweep outward in chevrons, the way they do in a Bridget Riley *Current*. Rings alternate bright and faint, and their tone deepens outward. Where the rings of two strokes, or of two distant parts of one stroke, cross at a slight angle, they beat into moiré. On Night the crossings add up into interference fringes. On Paper the same field reads as contours. No other Form draws a *field* round the line: Line weathers it, Echo repeats it, Sprout and Drift grow from it, Caustic reflects off it, and Orbit circles it.

## Algorithm (operator model)

Unit `j` covers 12 sp of arc, `[s_j, s_j + 12]`, with `s_j = s0 + 12j`. It holds all ten rings on both sides over that arc, plus the head caps (unit 0) and the tail caps (the last unit, at finish).

```
b(s)    = 1.2·w̄ + 3 sp                          w̄ = nib width (sp), tent-averaged over ±12 sp
δ_k(s)  = b·1.18^(k−1)·A_σ·(1 + a·sin(2πs/λ − 0.35k)) + n_k·ν_kσ(s)        ring k = 1..10, side σ = ±1
a       = 0.07 + 0.2·smoothstep(0.4, 2.2, v̄n)      (≤ 0.27 < 0.18/|1.18e^(−0.35i) − 1| = 0.43: rings never cross)
λ       = 32 + 2.5S sp;   n_k = min(0.4k, 0.1·gap_k);   ν = smooth value noise on a 14 sp lattice, rnd(seed, Geometry, …)
A_σ     = (1 + 0.35σ·tilt_n)·(1 − 0.3·max(0, σ·cs))
point   = pos(s) + σ·δ_k·n̄_k(s),   n̄_k = station normals tent-averaged over clamp(0.25δ_k, 2.4, 12) sp
cursor  : s_0 = s0, s_{j+1} = s_j + 12;  need = s_j + 52;  keep(s) = s < L
samples : arcs s_j + 2m, plus chord subdivision where a ring segment exceeds 3 sp (outside corners), ≤ 10 per segment
cleanup : width × smoothstep(0.965, 0.995, q/δ_k), q = distance to the spine stations within ±40 sp; points at 0 dropped (runs)
collapse: on the concave side (σ·κ̄ > 0) × smoothstep(0.97, 0.8, δ_k·|κ̄|)  — inward rings shrink until they vanish
```

Every ring point is a pure function of its arc, so neighbouring units share their joint point bit for bit. The cleanup is the spec's "drop points within 0.9δ of the seed", done as a local soft fade: inside a corner the rings of the two legs meet in clean mitred V's. Each unit is cooked once at its ceiling (all ten rings) and then truncated.

**Ends.** On an open stroke every ring wraps round the end in two quarter caps that meet at a shared apex. Their radius runs from δ_k on each side to the mean at the apex, and each quarter is drawn as a prefix of `f_k` from its joint. The head caps live in unit 0. A live-cooked unit 0 always draws them; if the stroke closes, the weld zone re-cooks it without them, so cook ≡ finish stays exact under closure flicker. The tail caps belong to the last unit, which is only ever cooked at finish. **Closed loop:** no caps. Units within 40 sp of `L` (inside the 56 sp weld zone) ramp each ring point toward that ring's start point at `s0`, so every ring joins itself exactly.

```
depth  : K(D) = 2·D·(0.6 + 0.8p);   f_k = clamp(K − k + 1, 0, 1)
         ring k's runs are drawn as a dash CENTRED in the unit, of fraction f_k of its span, at alpha × f_k:
         a new ring arrives as a dashed contour whose dashes lengthen until they join (never a pop)
alpha  : min(1, 0.95·0.93^(k−1)·(even rings 0.6)·(0.6 + 0.5p)·glow(c))·f_k;   gen = k
tone   : toneOf(p, min(k, 4)), then alternating buckets 3 / 4 for rings 5–10 (Spectral shimmers ring by ring)
width  : max(clamp(0.05w̄ + 0.4, 0.45, 1.1), min(0.38·gap_k, 3.2)) sp, even rings × 0.7    (op-art duty: hairlines in, bands out)
         × (0.6 + 0.4·E_in) (the entry taper only thins the field) × a 0.6 pinch within 2 sp of every joint
```

## Gen table

| D | rings (p = 0.5) | what appears |
|---|---|---|
| 0 | 0 | the bare stroke |
| 1 | 2 | a halo: two hairline contours hugging the stroke, the second dashed |
| 2 (base) | 4 | a contour band, bright / faint, breathing gently; the open ends are round |
| 3 | 6 | the waves read: density chevrons sweep outward; outer rings thicken into bands |
| 4 | 8 | a survey map: rings of nearby strokes overlap and beat |
| 5–6 | 10 | the full field (about 45 sp out with the brush): an op-art poster round your line |

Pressure scales the count: p = 0.15 draws 2.9 rings at base 2, p = 0.9 draws 5.3.

## Gesture grammar

| Gesture | What visibly changes |
|---|---|
| Speed | wobble: modulation 7 % → 27 % of each ring's offset; a fast hand throws the field into big waves (the brush also thins, which tightens the rings) |
| Pressure | more rings (`K ∝ 0.6 + 0.8p`), brighter rings (`α ∝ 0.6 + 0.5p`), and wider spacing through the brush width |
| Lean / tilt | one side's rings spread ×(1 + 0.35·tilt_n), the other side's pack in: the field leans with the pen |
| Curvature & corners | convex sides fan out into round contours; concave sides meet in mitred V's; inside a loop the rings shrink into a bullseye until they collapse |
| Closing a loop | no caps; the outer rings close round the loop and the inner rings fill it as a bullseye; the seam is exact |
| Holding | the pool raises `D` locally, so extra rings bloom outward round the hold like a stone dropped in water, then fall back over 32 sp |
| Nearby ink | side ink packs that side's rings ×(1 − 0.3·cs), which makes the interference denser; glow(c) dims the field |
| Nib | pen: tight hairline contours (b ≈ 6 sp); brush: the full field; chisel: the same rings round a chisel trunk |
| Zoom | everything is in sp, so zooming in gives a finer field |

## Radial seed (tap / bloom)

A bullseye. `K(D)` evenly spaced rings sit at radius `b + (k − 1)·0.42b`, with `b` taken from `max(w, 0.6S)` so a light tap still reads. Each ring is a five-lobed wobble whose phase turns ring by ring. It grows as an arc of fraction `f_k`, centred on a golden-angle phase, so the target spirals in and then closes. A second family of the same rings, round a centre 1.6 gaps away and with the opposite wobble, fades in over `D ∈ [0.5, 2]`. The two families beat into moiré fringes. A held tap blooms more rings.

## Night / Paper

**Night.** Additive light. The inner rings are bright hairlines and the outer rings fainter, wider bands. Odd rings are 1.7× brighter than even ones, so the field shimmers. With Spectral ink the hue steps 15° per ring and then flickers between the last two buckets. Overlapping fields of different strokes add up into interference fringes, which is the glow. The joint pinch keeps unit joints from flashing.

**Paper.** Multiplied pigment with the 0.78 hierarchy, which lifts the outer rings relative to Night. It reads as a survey map: thin contours, round ends, dashed outer index lines, and contours that thicken outward.

## Budgets

Brush, S 9, p 0.5: about 7 samples per ring side per unit, so 10 rings × 2 sides × 7 ≈ 140, plus chord subdivision outside corners. That is about 12 points per sp at D 6, or about 5 at base 2. The head and tail units add up to about 300 cap points at D 6, and the 640 unit ceiling holds them. At D 6 the 16k causal budget covers about 1.1 k sp of stroke; at base 2 about 3 k sp.

## Acceptance criteria (judged in screenshots)

1. **Contours.** On a straight run the rings are ordered outward on both sides and never cross, with gaps growing 1.18× per ring. Every open end is round. Inside a corner the rings meet in mitred V's, with no swallowtail loops.
2. **Field and interference.** At depth 4 and above, the modulation reads as sweeping density waves (strong on the fast stroke). Where two fields, or two parts of one stroke, overlap, they beat into moiré. On Night no joint flashes and no ring blows out to white.
3. **Loop, hold, tap.** The loop's rings close exactly at the seam and fill the inside as a bullseye that collapses before the centre. A hold blooms extra rings round the hold only. A tap is a growing spiral of arcs that closes into a bullseye, and a second offset family beats against it from D ≈ 1.

## Decisions vs DESIGN §2.3.7

The spec gives: rings `round(1.4d)`, `δ_i = (1.2w̄ + 3)·1.22^i`, noise `0.4i`, then spatial-hash cleanup and Chaikin. This brief departs from it as follows:

- `δ_i` is read as ring i's offset. Read as a cumulative spacing, 10 rings would sit 245 sp out.
- Growth is 1.18 and `K = 2D(0.6 + 0.8p)`. At 1.22 and 1.4D, base 2 was a thin tube of 2–3 rings; the new rule also lets pressure add rings.
- The cleanup is a local soft fade, which stays exact under chunking.
- There is no Chaikin pass. The rings are analytic offset curves sampled at 2 sp, plus chord subdivision.
- Noise is capped at 0.1 of the ring gap, so contours never cross.
- Reach is 52, not 24: the cleanup has to see across a corner.
- The modulation, the duty widths and the bright / faint alternation are the psychedelic layer, which the spec leaves open.

## Notes for promotion

- **Unit joints do not weld.** `tessellate.joinable` welds gen ≥ 1 polys only within one unit (and only when they are adjacent in the poly order), so the round ends of two units' ring polys overlap at every 12 sp joint and double-expose on Night. Ripple hides this with a 0.6× width pinch at joints. Orbit hides its joints in the trunk instead. A promotion-time engine option would let welds cross units, for example matching gen, tone and alpha with a bit-identical shared point on consecutive units. That would remove the pinch and give perfectly smooth rings.
- **Hue per ring.** Spectral hue only moves through `tone % 5` (15° per bucket, at most 4 steps). A per-ring hue step beyond bucket 4 would let the outer rings run through the spectrum, the strongest psychedelic lever left.

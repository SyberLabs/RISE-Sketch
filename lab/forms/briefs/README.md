# Form briefs — the six to prototype

Chosen from twelve concepts (organic / structural / cultural angles) for beauty, aliveness under the hand, distinctness from Line, Echo, Sprout and Drift and from each other, and feasibility in the lab's operator model. All six are **local chains** (one is a trunk replacement plus chain); none needs a change to `cook.ts`. Each brief fixes the algorithm, defaults, gesture grammar, tap / loop / hold behaviour, Night and Paper intent, budgets and three acceptance criteria a judge checks in screenshots.

| v | name | ink | one line | mood |
|---|---|---|---|---|
| 101 | [craze](craze.md) | oxide | the stroke is a drying film that cracks into a cellular network of T-junctions; seams glow hottest over the trunk on Night, etch darkest on Paper | bold · natural fracture · pigment |
| 102 | [plume](plume.md) | ochre | a vane of dense parallel barbs grows from both edges of the shaft; fast = ruffled and swept back, a closed loop is an ocellus with a clear pupil | delicate · organic · light |
| 103 | [caustic](caustic.md) | spectral | the stroke is a mirror lit from the side you lean toward; reflected rays fan off it and fold into a burning caustic where it bends, a circle holds a nephroid | delicate · light · structural |
| 104 | [burin](burin.md) | graphite | engraver's lozenge ticks on the shadow side, following the form; cross-hatch then stipple as it rises, a loop shades into a sphere | bold · structural · pigment |
| 105 | [plait](plait.md) | indigo | three strands braid around a thinning core, passing over and under with carved gaps; a held tap ties a trefoil | bold · structural · pigment |
| 106 | [orbit](orbit.md) | rose | a satellite's trochoid trail curls along the line as an unbroken rope of loops; epicycles make lace, a tap draws a spirograph rose | bold · dynamics · pigment / light |

Prototype order (distinctiveness × beauty ÷ risk): **caustic** (cheapest, most novel, ~150 lines), **craze** (cheapest network, both grounds free), **burin** (its chisel variant is free), **plume** (density is the one risk), **plait** (the over/under test first), **orbit** (reuses the period-unit skeleton; the chisel flourish second).

## Not chosen, and why

- **Frost** (organic). Beautiful, but its tap is a stellar dendrite and its lattice ferns are a crystal: that is Echo's territory ("a crystal of light", loops → snowflakes), and the fern silhouette echoes Sprout's fern template. Also the highest poly count per sp of the twelve. Its best idea, a page-shared lattice orientation, is worth stealing later.
- **Shard** (structural). The same cellular-crack family as Craze with five times the code (band-space Voronoi, ownership, seam) and the highest point cost; Craze carries the T-junction story more cheaply and reads correctly on both grounds without a brute-force exactness proof. Its sunflower tap is the one thing lost.
- **Mycelium** (organic). A wandering branching tree reads as a Sprout variant at gallery distance, and its signature behaviour (reaching *toward* nearby ink) is precisely the Night blow-out case the glow budget exists to prevent. Its anastomosis needs global work.
- **Helix** (structural). The same strands-around-the-line family as Plait, with wide additive fills (satin faces) that overlap at d ≥ 3, and an uncontrolled face parity across a closed seam. Plait's over/under is the more distinct primitive and lives on Paper, where Helix is weakest.
- **Sashiko** (cultural). Discrete marks along the line, the same family as Burin's marks across it; charming and cheap, but it reads as a dashed decoration rather than a Form that changes what the stroke *is*, and its loop tiling drops a column. Burin's sphere shading is the stronger loop story.
- **Swash** (cultural). Pooling on a straight run does nothing visible, which breaks the product's core promise (hold = rise); its lead-in and terminal swash both want a finish-time hook with `L`. The thick/thin-by-direction trunk is a fine idea for a nib, not a Form.

Shared rules every brief respects (from `lab/forms/README.md` and `cook.ts`): chain units never see closure (every loop behaviour is curvature-local); tail units may read `L` only when `cx.final` and inside the tail re-cook zone (`s + halfWin ≥ L − 56`); depth is continuous by prefix truncation and width easing; randomness only via `rnd(seed, Ch.*, integer addr, k)`; the Math allow-list plus `core/det.ts`.

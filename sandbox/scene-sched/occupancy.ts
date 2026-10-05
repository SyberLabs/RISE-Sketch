/**
 * Visual check of the pure scene layer: crowding heat map c (reader zoom 1), side
 * crowding CS arrows for a rightward stroke (normal = up), hit probes and a lasso.
 * Doc units = canvas px (camera z = 1). Results land in window.__result.
 */
import { createScene } from '../../src/scene/scene';
import { createJobs } from '../../src/sched/jobs';
import { S } from '../../src/core/types';
import type { StrokeRecipe } from '../../src/core/types';
import { FakeDoc, linePts, makeRecipe, trunkCooked } from '../../tests/scene-sched.helpers';

declare global { interface Window { __result?: unknown } }

const cv = document.getElementById('c') as HTMLCanvasElement;
const ctx = cv.getContext('2d')!;
const W = cv.width, H = cv.height;

let n = 1;
const rs: StrokeRecipe[] = [];
const add = (pts: [number, number][], size: number, z = 1, ink: StrokeRecipe['color']['ink'] = 'moss') => {
  // samples are relative to the origin (first point), like real recipes
  const [ox, oy] = pts[0];
  const r = makeRecipe({ n: n++, pts: pts.map(([x, y]) => [(x - ox) * 1, (y - oy) * 1] as [number, number]), origin: [ox, oy], size, z, ink });
  rs.push(r);
  return r;
};

// 1. dense hatching
for (let k = 0; k < 12; k++) add(linePts(80, 70 + k * 7, 260, 70 + k * 7, 40), 6);
// 2. spiral
const spiral: [number, number][] = [];
for (let i = 0; i < 300; i++) { const a = i * 0.07, rr = 8 + i * 0.32; spiral.push([450 + Math.cos(a) * rr, 190 + Math.sin(a) * rr]); }
add(spiral, 5, 1, 'indigo');
// 3. sine wave
const sine: [number, number][] = [];
for (let x = 60; x <= 1040; x += 4) sine.push([x, 450 + 40 * Math.sin(x / 40)]);
add(sine, 9, 1, 'oxide');
// 4. a fat brush
add(linePts(700, 110, 1000, 160, 60), 40, 1, 'rose');
// 5. fine strokes drawn zoomed in (z = 4, level 1): still within two levels of a z = 1 reader
for (let k = 0; k < 8; k++) add(linePts(820, 300 + k * 4, 900, 310 + k * 4, 30), 9, 4);
// 6. a tap
add([[600, 300]], 20);
// 7. a broad stroke drawn far zoomed out (z = 0.125, level 6): NOT nearby for a z = 1 reader
add(linePts(300, 580, 520, 560, 40), 9, 0.125, 'ochre');

const doc = new FakeDoc(rs);
doc.meta.camera = { cx: W / 2, cy: H / 2, scale: 1, rot: 0 };
const jobs = createJobs();
const scene = createScene({ doc, cook: r => trunkCooked(r, (0.7 * r.stroke.size) / r.z), jobs, requestFrame() {} });

// cold read before the warm job ran (pen-down on an unwarmed area)
let t0 = performance.now();
const cold = scene.crowding(170, 100, 1);
const coldMs = performance.now() - t0;
t0 = performance.now();
while (jobs.run(6)) { /* drain warm job */ }
const warmMs = performance.now() - t0;
const cooked = scene.ensure(rs.map(r => r.id), 'visible');
while (jobs.run(100)) { /* cook */ }

// heat map of c
t0 = performance.now();
const STEP = 4;
let maxC = 0, queries = 0;
for (let y = 0; y < H; y += STEP) {
  for (let x = 0; x < W; x += STEP) {
    const c = scene.crowding(x + STEP / 2, y + STEP / 2, 1);
    queries++;
    if (c > maxC) maxC = c;
    if (c <= 0) continue;
    ctx.fillStyle = `rgba(255, ${Math.round(140 - 100 * c)}, 40, ${(0.15 + 0.75 * c).toFixed(3)})`;
    ctx.fillRect(x, y, STEP, STEP);
  }
}
const heatMs = performance.now() - t0;

// strokes on top
const draw = (r: StrokeRecipe, color: string, widthScale = 1) => {
  const m = r.samples.length / S.STRIDE;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, (0.7 * r.stroke.size / r.z) * widthScale);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < m; i++) {
    const x = r.origin[0] + r.samples[i * S.STRIDE + S.X], y = r.origin[1] + r.samples[i * S.STRIDE + S.Y];
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  if (m === 1) { ctx.arc(r.origin[0], r.origin[1], ctx.lineWidth / 2, 0, 6.3); ctx.fill(); } else ctx.stroke();
};
for (const r of rs) draw(r, r.z < 0.5 ? 'rgba(160,160,170,0.25)' : 'rgba(235,238,245,0.55)');

// CS arrows for a stroke travelling right (normal = up, −y)
ctx.strokeStyle = '#4fd1e8';
ctx.lineWidth = 1.5;
let maxCS = 0;
for (let y = 16; y < H; y += 32) {
  for (let x = 16; x < W; x += 32) {
    const cs = scene.sideCrowding(x, y, 0, -1, 1);
    if (Math.abs(cs) > Math.abs(maxCS)) maxCS = cs;
    if (Math.abs(cs) < 0.02) continue;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - cs * 14); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y - cs * 14, 1.6, 0, 6.3); ctx.fillStyle = '#4fd1e8'; ctx.fill();
  }
}

// lasso around the spiral's left half and the whole hatch block
const lassoPts = [60, 50, 280, 50, 280, 170, 450, 120, 452, 330, 300, 330, 60, 170];
const sel = new Set(scene.lasso(Float64Array.from(lassoPts)));
ctx.setLineDash([5, 4]); ctx.strokeStyle = '#f5d76e'; ctx.lineWidth = 1;
ctx.beginPath();
for (let i = 0; i < lassoPts.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, lassoPts[i], lassoPts[i + 1]);
ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
for (const r of rs) if (sel.has(r.id)) draw(r, 'rgba(245,215,110,0.9)', 0.5);

// hit probes
const probes: [number, number, number][] = [
  [170, 77, 1], [170, 80.5, 0.5], [740, 125, 1], [1000, 175, 1], [600, 308, 1], [600, 318, 1], [450, 190, 2],
  [400, 573, 2], [860, 312, 0.5], [530, 470, 1],
];
const hits: (string | null)[] = [];
ctx.font = '10px ui-monospace, monospace';
for (const [x, y, r] of probes) {
  const id = scene.hit([x, y], r);
  hits.push(id);
  ctx.beginPath(); ctx.arc(x, y, Math.max(3, r), 0, 6.3);
  ctx.strokeStyle = id ? '#5ef08a' : '#ff5f6d'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = id ? '#5ef08a' : '#ff5f6d';
  ctx.fillText(id ? '#' + parseInt(id.slice(-4), 36) : 'miss', x + 6, y - 6);
}

const lineage = scene.lineage(262, 72, 'moss', 2, 1e4);
const result = {
  strokes: rs.length, coldCrowding: +cold.toFixed(3), coldMs: +coldMs.toFixed(2), warmJobMs: +warmMs.toFixed(1),
  heatQueries: queries, heatMs: Math.round(heatMs), usPerQuery: +((heatMs * 1000) / queries).toFixed(1),
  maxC: +maxC.toFixed(3), maxCS: +maxCS.toFixed(3),
  lasso: [...sel].map(id => parseInt(id.slice(-4), 36)).sort((a, b) => a - b),
  hits: hits.map(id => (id ? parseInt(id.slice(-4), 36) : null)),
  lineageOfHatchEnd: lineage ? parseInt(lineage.slice(-4), 36) : null,
  farZoomedOutStrokeCrowding: +scene.crowding(400, 572, 1).toFixed(3),
  cells: scene.occupancy.cells, blocks: scene.occupancy.blocks,
};
cooked.then(() => {
  window.__result = result;
  document.getElementById('out')!.textContent = JSON.stringify(result);
});

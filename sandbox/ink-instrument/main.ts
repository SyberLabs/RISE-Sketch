/**
 * ink-instrument visual check: synthetic gestures through the real spine builder,
 * envelope and nib widths, drawn as filled ribbons (raw samples as grey dots,
 * corners red, settled watermark blue in the live panel). The bottom-right panel
 * takes real pointer input (pen pressure / mouse synthesised pressure).
 */
import type { DraftStroke, Spine, StrokeRecipe } from '../../src/core/types';
import { S } from '../../src/core/types';
import { buildSpine, createSpineBuilder, type SpineBuilder } from '../../src/ink/spine';
import { finalEnvelope, liveEnvelope, closureTest, type InkEnvelope } from '../../src/ink/envelope';
import { chiselAngle } from '../../src/ink/nibs';
import { DEFAULT_CALIB } from '../../src/ink/calib';
import { Hand, recipe } from '../../tests/ink-instrument.fixtures';

const cv = document.getElementById('c') as HTMLCanvasElement;
const ctx = cv.getContext('2d')!;
const W = innerWidth, H = innerHeight, dpr = devicePixelRatio || 1;
cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
ctx.scale(dpr, dpr);

interface Panel { title: string; r: StrokeRecipe; x: number; y: number; scale: number }
const COLS = 4, PW = W / COLS, PH = (H - 10) / 2;

function panels(): Panel[] {
  const out: Panel[] = [];
  const add = (title: string, r: StrokeRecipe, scale = 1) => {
    const i = out.length;
    out.push({ title, r, x: (i % COLS) * PW, y: Math.floor(i / COLS) * PH, scale });
  };
  // 1. slow L-corner, brush
  const a = new Hand(20, 60, { jitter: 0.15, seed: 1, p: 0.5 });
  a.moveTo(150, 60, 0.6).moveTo(200, 60, 0.1).hold(120).moveTo(200, 120, 0.1).moveTo(200, 260, 0.6, 0.8);
  add('corner: slow L (brush, pen)', recipe(a.rows()));
  // 2. closed loop (welded) on top of the same loop open, offset
  const b = new Hand(240, 150, { jitter: 0.2, seed: 2, p: 0.6 });
  b.arc(150, 150, 90, 0, 2 * Math.PI - 0.12, 1.0);
  add('closed loop, welded (brush)', recipe(b.rows(), { closed: true }));
  // 3. flick-off exit and flick-in entry
  const c = new Hand(20, 220, { seed: 3, p: 0.6 });
  c.moveTo(60, 180, 2.4).moveTo(140, 140, 0.5).moveTo(300, 40, 2.8, 0.3);
  add('flick in + flick off (brush, pen)', recipe(c.rows()));
  // 4. seated stop with tremor
  const d = new Hand(20, 150, { jitter: 0.5, seed: 4, p: 0.6 });
  d.moveTo(200, 120, 0.8).moveTo(240, 120, 0.1).hold(160);
  add('seated stop, tremor σ 0.5 (pen)', recipe(d.rows(), { calib: { ...DEFAULT_CALIB.pen, jitter: 0.7 } }));
  // 5. mouse scribble, synthesised pressure
  const e = new Hand(20, 40, { hz: 125, seed: 5, p: 0.5 });
  e.moveTo(120, 60, 0.25).moveTo(160, 200, 2.2).arc(200, 200, 40, Math.PI, 2 * Math.PI, 0.4).moveTo(300, 60, 1.6).moveTo(310, 70, 0.05);
  add('mouse: synthesised pressure', recipe(e.rows(1, true), { device: 'mouse' }));
  // 6. chisel with tilt
  const f = new Hand(30, 200, { seed: 6, p: 0.6, alt: 0.6, az: 0.5 });
  f.arc(160, 200, 120, Math.PI, 2 * Math.PI, 0.7);
  add('chisel, tilted (az 0.5 rad)', recipe(f.rows(), { nib: 'chisel', size: 14 }));
  // 7. fast end: the end flush reaches the raw lift point
  const g = new Hand(20, 220, { hz: 125, seed: 7 });
  g.moveTo(140, 200, 0.6).arc(140, 120, 80, Math.PI / 2, -Math.PI / 6, 2.6);
  add('mouse, fast curved end (flush)', recipe(g.rows(1, true), { device: 'mouse', nib: 'pen', size: 4 }));
  return out;
}

function drawRibbon(sp: Spine, env: InkEnvelope, z: number, nib: string, color: string): void {
  const n = sp.n;
  if (n === 0) return;
  ctx.fillStyle = color;
  if (nib === 'chisel') {
    for (let i = 1; i < n; i++) {
      const e0 = sp.w[i - 1] * env.at(sp.s[i - 1]) / 2, e1 = sp.w[i] * env.at(sp.s[i]) / 2;
      const a0 = chiselAngle(sp.alt[i - 1], sp.az[i - 1]), a1 = chiselAngle(sp.alt[i], sp.az[i]);
      ctx.beginPath();
      ctx.moveTo(sp.x[i - 1] + Math.cos(a0) * e0, sp.y[i - 1] + Math.sin(a0) * e0);
      ctx.lineTo(sp.x[i] + Math.cos(a1) * e1, sp.y[i] + Math.sin(a1) * e1);
      ctx.lineTo(sp.x[i] - Math.cos(a1) * e1, sp.y[i] - Math.sin(a1) * e1);
      ctx.lineTo(sp.x[i - 1] - Math.cos(a0) * e0, sp.y[i - 1] - Math.sin(a0) * e0);
      ctx.closePath(); ctx.fill();
    }
    return;
  }
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const h = sp.w[i] * env.at(sp.s[i]) / 2;
    const x = sp.x[i] + sp.nx[i] * h, y = sp.y[i] + sp.ny[i] * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--) {
    const h = sp.w[i] * env.at(sp.s[i]) / 2;
    ctx.lineTo(sp.x[i] - sp.nx[i] * h, sp.y[i] - sp.ny[i] * h);
  }
  ctx.closePath(); ctx.fill();
  // round caps where the envelope leaves width at the ends
  for (const i of [0, n - 1]) {
    const h = sp.w[i] * env.at(sp.s[i]) / 2;
    if (h > 0.2) { ctx.beginPath(); ctx.arc(sp.x[i], sp.y[i], h, 0, 2 * Math.PI); ctx.fill(); }
  }
  void z;
}

function drawSpineMarks(sp: Spine, rows: Float32Array, nRows: number, z: number, settled = -1): void {
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let i = 0; i < nRows; i++) {
    const o = i * S.STRIDE;
    ctx.fillRect(rows[o + S.X] - 0.6, rows[o + S.Y] - 0.6, 1.2, 1.2);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.6 / z;
  ctx.beginPath();
  for (let i = 0; i < sp.n; i++) { if (i === 0) ctx.moveTo(sp.x[i], sp.y[i]); else ctx.lineTo(sp.x[i], sp.y[i]); }
  ctx.stroke();
  for (let i = 0; i < sp.n; i++) {
    if (sp.corner[i]) { ctx.fillStyle = '#d0302a'; ctx.beginPath(); ctx.arc(sp.x[i], sp.y[i], 3, 0, 2 * Math.PI); ctx.fill(); }
  }
  if (settled > 0 && settled <= sp.n) {
    const i = settled - 1;
    ctx.strokeStyle = '#1f6fd0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sp.x[i] + sp.nx[i] * 14, sp.y[i] + sp.ny[i] * 14); ctx.lineTo(sp.x[i] - sp.nx[i] * 14, sp.y[i] - sp.ny[i] * 14); ctx.stroke();
  }
}

function label(p: { x: number; y: number }, text: string, sub: string): void {
  ctx.fillStyle = '#222'; ctx.font = '600 12px system-ui'; ctx.fillText(text, p.x + 8, p.y + 16);
  ctx.fillStyle = '#666'; ctx.font = '11px system-ui'; ctx.fillText(sub, p.x + 8, p.y + 30);
}

/** ?panel=i&k=6&fx=..&fy=.. : one panel magnified around (fx, fy) (stroke coordinates), unwelded copy in red. */
function zoomView(q: URLSearchParams, all: Panel[]): number {
  const p = all[+q.get('panel')!], k = +(q.get('k') ?? 6), fx = +(q.get('fx') ?? 0), fy = +(q.get('fy') ?? 0);
  const sp = buildSpine(p.r), env = finalEnvelope(p.r, sp);
  const open = buildSpine({ ...p.r, closed: false }), envO = finalEnvelope({ ...p.r, closed: false }, open);
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(k, k); ctx.translate(-fx, -fy);
  drawRibbon(open, envO, 1, p.r.stroke.nib, 'rgba(200,60,40,0.35)');
  drawRibbon(sp, env, 1, p.r.stroke.nib, 'rgba(32,40,60,0.75)');
  drawSpineMarks(sp, p.r.samples, p.r.samples.length / S.STRIDE, k);
  ctx.fillStyle = '#1f6fd0';
  for (let i = 0; i < sp.n; i++) ctx.fillRect(sp.x[i] - 0.25, sp.y[i] - 0.25, 0.5, 0.5);
  ctx.restore();
  label({ x: 0, y: 0 }, `${p.title} ×${k}`, 'red: same stroke unwelded / blue: stations / grey: raw samples');
  return 1;
}

function gallery(all: Panel[]): number {
  let drawn = 0;
  for (const p of all) {
    const sp = buildSpine(p.r);
    const env = finalEnvelope(p.r, sp);
    ctx.save();
    ctx.strokeStyle = '#d8d2c4'; ctx.strokeRect(p.x + 0.5, p.y + 0.5, PW - 1, PH - 1);
    ctx.translate(p.x + 10, p.y + 34);
    const z = p.r.z;
    drawRibbon(sp, env, z, p.r.stroke.nib, 'rgba(32,40,60,0.88)');
    drawSpineMarks(sp, p.r.samples, p.r.samples.length / S.STRIDE, z);
    ctx.restore();
    const corners = Array.from(sp.corner.subarray(0, sp.n)).filter(Boolean).length;
    label(p, p.title, `n ${sp.n}  L ${sp.L.toFixed(0)}  Te ${env.Te.toFixed(1)}  Tx ${env.Tx.toFixed(1)}  ${env.seated ? 'seated ' : ''}${env.closed ? 'closed ' : ''}corners ${corners}`);
    drawn++;
  }
  return drawn;
}

const query = new URLSearchParams(location.search);
const zoomed = query.has('panel');
const drawn = zoomed ? zoomView(query, panels()) : gallery(panels());

// ---------------------------------------------------------------- live panel (real pointer input)
const live = { x: 3 * PW, y: PH };
let draft: DraftStroke | null = null, builder: SpineBuilder | null = null, closing = false, t0 = 0;
const hud = document.getElementById('hud')!;

function liveFrame(final: boolean): void {
  ctx.save();
  ctx.fillStyle = '#f4f1ea'; ctx.fillRect(live.x, live.y, PW, PH);
  ctx.strokeStyle = '#d8d2c4'; ctx.strokeRect(live.x + 0.5, live.y + 0.5, PW - 1, PH - 1);
  ctx.restore();
  label(live, 'live: draw here', final ? 'finished' : draft ? 'drawing' : 'pen / mouse / touch');
  if (!draft || !builder) return;
  const sp = builder.spine, rows = draft.samples;
  const env = final ? finalEnvelope(draft, sp) : liveEnvelope(draft, sp);
  ctx.save();
  ctx.beginPath(); ctx.rect(live.x, live.y, PW, PH); ctx.clip();
  drawRibbon(sp, env, 1, draft.stroke.nib, closing ? 'rgba(20,110,70,0.88)' : 'rgba(32,40,60,0.88)');
  drawSpineMarks(sp, rows.data, rows.n, 1, final ? -1 : sp.settled);
  ctx.restore();
  hud.textContent = `n ${sp.n} settled ${sp.settled} L ${sp.L.toFixed(1)} lag ${(sp.settled > 0 ? sp.L - sp.s[sp.settled - 1] : 0).toFixed(1)} sp  closing ${closing}`;
}

cv.addEventListener('pointerdown', ev => {
  if (zoomed || ev.clientX < live.x || ev.clientY < live.y) return;
  cv.setPointerCapture(ev.pointerId);
  const device = ev.pointerType === 'pen' ? 'pen' : ev.pointerType === 'touch' ? 'touch' : 'mouse';
  t0 = ev.timeStamp;
  draft = {
    origin: [0, 0], z: 1, rot: 0, seed: 1, device, calib: DEFAULT_CALIB[device],
    stroke: { nib: 'brush', size: 9 }, color: { ink: 'moss', k: 0, dh: 0, dL: 0, lch: null },
    form: { form: 'line', v: 1, base: 0 }, s0: 0, cut: 0, resume: null,
    samples: { data: new Float32Array(256 * S.STRIDE), n: 0 }, pools: { data: new Float32Array(0), n: 0 }, closing: false,
  };
  builder = createSpineBuilder(draft);
  closing = false;
  push(ev);
});
let lastT = -1;
function push(ev: PointerEvent): void {
  if (!draft || !builder) return;
  const evs = ev.getCoalescedEvents?.() ?? [ev];
  for (const e of evs.length ? evs : [ev]) {
    const buf = draft.samples;
    if ((buf.n + 1) * S.STRIDE > buf.data.length) { const g = new Float32Array(buf.data.length * 2); g.set(buf.data); buf.data = g; }
    const t = Math.max(e.timeStamp - t0, lastT + 0.25);
    lastT = t;
    const o = buf.n * S.STRIDE, d = buf.data;
    d[o + S.X] = e.clientX; d[o + S.Y] = e.clientY; d[o + S.T] = t;
    d[o + S.P] = draft.device === 'pen' ? e.pressure : NaN;
    d[o + S.ALT] = Math.PI / 2; d[o + S.AZ] = 0; d[o + S.R] = NaN; d[o + S.C] = 0; d[o + S.CS] = 0;
    buf.n++;
  }
  builder.append();
  closing = closureTest(builder.spine, closing);
  draft.closing = closing;
  liveFrame(false);
}
cv.addEventListener('pointermove', ev => { if (draft && ev.buttons) push(ev); });
cv.addEventListener('pointerup', () => {
  if (!draft || !builder) return;
  builder.finish(closing);
  liveFrame(true);
  (window as unknown as { __live: unknown }).__live = { n: builder.spine.n, settled: builder.spine.settled, closing };
  draft = null; builder = null; lastT = -1;
});

if (!zoomed) liveFrame(false);
(window as unknown as { __drawn: number }).__drawn = drawn;

/**
 * Input sandbox: binds createInput to a full-viewport stage and logs every sink call
 * (window.__log), drawing strokes / lassos so a screenshot shows what happened.
 * Driven by sandbox/input/drive.mjs through scripts/harness.mjs.
 */
import type { Device, InputSample } from '../../src/core/types';
import type { InputSink, KeyAction } from '../../src/input/types';
import { createInput, type InputControllerEx } from '../../src/input/index';

interface Probe {
  log: string[];
  input: InputControllerEx;
  mode: 'draw' | 'erase';
  blocked: boolean;
  tViolations: number;
  predictedSeen: number;
  pressures: number[];
  penModes: boolean[];
  fingerPans: number;
  clear(): void;
}

declare global {
  interface Window { __input: Probe }
}

const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.getElementById('ink') as HTMLCanvasElement;
const out = document.getElementById('log') as HTMLElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

const fit = (): void => {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};
fit();
addEventListener('resize', fit);

const log: string[] = [];
let renderQueued = false;
const render = (): void => {
  renderQueued = false;
  out.textContent = log.slice(-48).join('\n');
};
const push = (line: string): void => {
  // Collapse runs of identical lines (hover / move spam) into one with a count.
  const last = log[log.length - 1];
  const m = last ? /^(.*?)(?: ×(\d+))?$/.exec(last) : null;
  if (m && m[1] === line) log[log.length - 1] = `${line} ×${Number(m[2] ?? 1) + 1}`;
  else log.push(line);
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(render);
  }
};
const f1 = (v: number): string => (Number.isNaN(v) ? 'NaN' : v.toFixed(1));

let lastT = -Infinity;
let stroke: { x: number; y: number; p: number }[] = [];
let strokeErase = false;
let lasso: number[] = [];

const drawStroke = (): void => {
  if (stroke.length < 1) return;
  ctx.strokeStyle = strokeErase ? '#ff7a7a' : '#9fe3a8';
  ctx.lineCap = 'round';
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1], b = stroke[i];
    ctx.lineWidth = 1 + 8 * (Number.isNaN(b.p) ? 0.5 : b.p);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  if (stroke.length === 1) {
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(stroke[0].x, stroke[0].y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
};

const probe = {} as Probe;
const keep = (s: InputSample): void => {
  if (!(s.t > lastT)) probe.tViolations++;
  lastT = s.t;
  stroke.push({ x: s.x, y: s.y, p: s.p });
  if (!Number.isNaN(s.p)) probe.pressures.push(s.p);
};

const sink: InputSink = {
  strokeBegin(device: Device, s: InputSample, mode: 'draw' | 'erase') {
    lastT = -Infinity;
    stroke = [];
    strokeErase = mode === 'erase';
    keep(s);
    push(`begin ${device} ${mode} ${Math.round(s.x)},${Math.round(s.y)} p=${f1(s.p)}`);
  },
  strokeMove(samples: readonly InputSample[], predicted: readonly InputSample[]) {
    for (const s of samples) keep(s);
    for (const q of predicted) if (q.predicted) probe.predictedSeen++;
    push('move');
  },
  strokeEnd(how: 'commit' | 'withdraw') {
    if (how === 'commit') drawStroke();
    push(`end ${how} (${stroke.length} samples)`);
  },
  hover(p) {
    push(p ? `hover ${p.device}` : 'hover null');
  },
  pan(dx: number, dy: number) {
    push(`pan ${f1(dx)},${f1(dy)}`);
  },
  zoom(factor: number, cx: number, cy: number) {
    push(`zoom ${factor.toFixed(4)} @${Math.round(cx)},${Math.round(cy)}`);
  },
  navEnd(kind) {
    push(`navEnd ${kind}`);
  },
  select(x: number, y: number, add: boolean) {
    push(`select ${Math.round(x)},${Math.round(y)}${add ? ' add' : ''}`);
    ctx.strokeStyle = '#8fb3ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 10, y - 10, 20, 20);
  },
  lassoBegin(x: number, y: number, add: boolean) {
    lasso = [x, y];
    push(`lassoBegin ${Math.round(x)},${Math.round(y)}${add ? ' add' : ''}`);
  },
  lassoMove(x: number, y: number) {
    lasso.push(x, y);
    push('lassoMove');
  },
  lassoEnd() {
    ctx.strokeStyle = '#8fb3ff';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < lasso.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, lasso[i], lasso[i + 1]);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    push(`lassoEnd (${lasso.length / 2} pts)`);
  },
  sample(x: number, y: number) {
    push(`sample ${Math.round(x)},${Math.round(y)}`);
  },
  twoFingerTap() {
    push('twoFingerTap');
  },
  key(a: KeyAction) {
    const extra = 'dir' in a ? ` ${a.dir}` : 'index' in a ? ` ${a.index}` : 'factor' in a ? ` ${a.factor}` : 'delta' in a ? ` ${a.delta}` : '';
    push(`key ${a.k}${extra}`);
  },
  contact(active: boolean) {
    push(`contact ${active}`);
  },
};

// ?quiet: a sink that allocates nothing (allocation / timing probes, see alloc.mjs).
const quiet = location.search.includes('quiet');
const counts = { begin: 0, move: 0, samples: 0, end: 0, other: 0 };
const quietSink: InputSink = {
  strokeBegin() { counts.begin++; },
  strokeMove(s) { counts.move++; counts.samples += s.length; },
  strokeEnd() { counts.end++; },
  hover() { counts.other++; },
  pan() { counts.other++; },
  zoom() { counts.other++; },
  navEnd() { counts.other++; },
  select() { counts.other++; },
  lassoBegin() { counts.other++; },
  lassoMove() { counts.other++; },
  lassoEnd() { counts.other++; },
  sample() { counts.other++; },
  twoFingerTap() { counts.other++; },
  key() { counts.other++; },
  contact() { counts.other++; },
};

// Handler timing: a capture listener on window runs before the input's target
// listener, a bubbling listener on document after it.
const handlerMs: number[] = [];
let tIn = 0;
addEventListener('pointermove', () => { tIn = performance.now(); }, true);
document.addEventListener('pointermove', () => { if (handlerMs.length < 20000) handlerMs.push(performance.now() - tIn); });

const input = createInput({
  target: stage,
  mode: () => probe.mode,
  keysBlocked: () => probe.blocked,
  isMac: /Mac|iPhone|iPad/.test(navigator.platform),
}, quiet ? quietSink : sink);
(window as unknown as { __perf: unknown }).__perf = { counts, handlerMs };

Object.assign(probe, {
  log, input, mode: 'draw', blocked: false, tViolations: 0, predictedSeen: 0, pressures: [], penModes: [], fingerPans: 0,
  clear() {
    log.length = 0;
    probe.tViolations = 0;
    probe.predictedSeen = 0;
    probe.pressures = [];
    render();
  },
} satisfies Partial<Probe>);
input.onPenMode(on => {
  probe.penModes.push(on);
  push(`[penMode ${on}]`);
});
input.onFingerPan(() => {
  probe.fingerPans++;
  push('[fingerPan]');
});
window.__input = probe;

// A focused widget that handles B itself (preventDefault, no stopPropagation): the canvas map must not also fire.
document.getElementById('eater')?.addEventListener('keydown', e => {
  if (e.code === 'KeyB') e.preventDefault();
});

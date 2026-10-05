/**
 * UI sandbox: a scriptable mock Store (with a tiny reducer so the page is interactive), fake
 * Glyphs, and a fake ink stage. `window.__ui` lets scripts set state, emit events, read the intent
 * log and count visible interactive controls. Not product code.
 */
import type { AppEvent, AppState, Intent, RecentDoc, Store } from '../../src/app/types';
import type { ColorStyle, FormId, NibId } from '../../src/core/types';
import { INK_ORDER, P0_NIBS } from '../../src/core/types';
import { createUI } from '../../src/ui/index';
import { createFakeGlyphs, paintStage, paintThumb } from './fakeglyphs';

const NIB_RANGE: Record<NibId, [number, number]> = { pen: [0.75, 12], brush: [2, 48], chisel: [3, 48], charcoal: [2, 40] };
const DMAX: Record<FormId, number> = { line: 5, echo: 5, sprout: 4, drift: 6, ripple: 6 };

const customRose: ColorStyle = { ink: 'custom', k: 0, dh: 0, dL: 0, lch: { night: [0.78, 0.14, 330], paper: [0.45, 0.15, 330] } };
const customTeal: ColorStyle = { ink: 'custom', k: 0, dh: 0, dL: 0, lch: { night: [0.82, 0.11, 190], paper: [0.42, 0.1, 195] } };

export function baseState(): AppState {
  return {
    tool: {
      nib: 'brush', lastNib: 'brush',
      sizes: { pen: 2.5, brush: 9, chisel: 12, charcoal: 7 },
      ink: 'moss', custom: null, recents: [],
      form: 'sprout', base: { line: 0, echo: 2, sprout: 2, drift: 2, ripple: 2 },
      mode: 'draw', mirror: null,
    },
    ground: 'night', selection: [], canUndo: false, canRedo: false, hasInk: false,
    zoom: 100, inkInView: true, inkDirection: null, chromeHidden: false, sheet: null, lastRecipe: null,
    docTitle: 'Untitled drawing', recentDocs: [], autosaveOk: true, replaying: false, replayProgress: 0,
    exporting: false, penMode: false, firstRun: false,
    hints: { draw: 'pending', rise: 'pending', form: 'pending', nav: 'pending' },
    reducedMotion: false, isTouch: false, isMac: false,
  };
}

let state = baseState();
const subs = new Set<(s: AppState, prev: AppState) => void>();
const evs = new Set<(e: AppEvent) => void>();
const intents: Intent[] = [];

function set(patch: Partial<AppState>): void {
  const prev = state;
  state = { ...state, ...patch };
  for (const fn of subs) fn(state, prev);
}
function tool(patch: Partial<AppState['tool']>): void { set({ tool: { ...state.tool, ...patch } }); }
function emit(e: AppEvent): void { for (const fn of evs) fn(e); }

let bendStart: { size: number; base: number; lch: ColorStyle['lch'] } | null = null;
function reduce(i: Intent): void {
  const t = state.tool;
  switch (i.k) {
    case 'openSheet': set({ sheet: i.sheet }); break;
    case 'pickNib': tool({ nib: i.nib, lastNib: i.nib, mode: 'draw' }); break;
    case 'pickErase': tool({ mode: 'erase', lastNib: t.nib }); break;
    case 'exitErase': tool({ mode: 'draw', nib: t.lastNib }); break;
    case 'pickInk': tool({ ink: i.ink, custom: null }); break;
    case 'pickCustom': tool({ ink: 'custom', custom: i.color.lch }); break;
    case 'pickForm': tool({ form: i.form }); break;
    case 'ground': set({ ground: i.g }); document.documentElement.dataset.ground = i.g; repaint(); break;
    case 'bendSize': {
      bendStart ??= { size: t.sizes[t.nib], base: t.base[t.form], lch: t.custom };
      const [lo, hi] = NIB_RANGE[t.nib];
      tool({ sizes: { ...t.sizes, [t.nib]: Math.max(lo, Math.min(hi, bendStart.size * i.factor)) } });
      if (i.done) bendStart = null;
      break;
    }
    case 'bendDepth': {
      bendStart ??= { size: t.sizes[t.nib], base: t.base[t.form], lch: t.custom };
      tool({ base: { ...t.base, [t.form]: Math.max(0, Math.min(DMAX[t.form], bendStart.base + i.delta)) } });
      if (i.done) bendStart = null;
      break;
    }
    case 'bendColor': {
      if (i.done) {
        const c: ColorStyle = { ink: 'custom', k: 0, dh: 0, dL: 0, lch: { night: [0.8 + i.dL, 0.13, (135 + i.dh + 360) % 360], paper: [0.5 + i.dL, 0.12, (128 + i.dh + 360) % 360] } };
        tool({ ink: 'custom', custom: c.lch, recents: [c, ...t.recents].slice(0, 2) });
      }
      break;
    }
    case 'undo': set({ canRedo: true, canUndo: state.canUndo && Math.random() > 0.3 }); emit({ k: 'announce', text: 'Undone: stroke removed' }); break;
    case 'redo': set({ canUndo: true, canRedo: false, hasInk: true }); break;
    case 'delete': set({ selection: [], canUndo: true, canRedo: false }); emit({ k: 'announce', text: 'Strokes deleted' }); break;
    case 'viewChip': set(state.inkInView ? { zoom: 100 } : { inkInView: true, zoom: 64 }); break;
    case 'fit': set({ inkInView: true, zoom: 64 }); break;
    case 'replay': set({ replaying: true, replayProgress: 0.2 }); break;
    case 'stopReplay': set({ replaying: false }); break;
    case 'new': emit({ k: 'toast', id: 'new', text: 'New canvas. The last one is in Recent.' }); set({ hasInk: false, canUndo: false, canRedo: false }); break;
    case 'deleteRecent': set({ recentDocs: state.recentDocs.filter(d => d.id !== i.id) }); break;
    case 'hintDone': set({ hints: { ...state.hints, [i.id]: 'done' } }); break;
    default: break;
  }
}

const store: Store = {
  get: () => state,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  on(fn) { evs.add(fn); return () => evs.delete(fn); },
  dispatch(i) { intents.push(i); reduce(i); },
};

// ---- stage
const stage = document.getElementById('stage')!;
const stageCanvas = document.createElement('canvas');
stageCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
stage.appendChild(stageCanvas);
let stageInk = false;
function repaint(): void { paintStage(stageCanvas, state.ground, stageInk); }
addEventListener('resize', repaint);

function thumbs(n: number): RecentDoc[] {
  const out: RecentDoc[] = [];
  const now = Date.now();
  const titles = ['Moss study', 'Night garden', 'Coastline', 'Snowflakes', 'Untitled drawing', 'Smoke', 'Fern rows', 'Indigo tide', 'Rose crackle', 'Ochre field', 'Echoes', 'Drift'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('canvas');
    c.width = 192; c.height = 128;
    paintThumb(c, i % 3 === 2 ? 'paper' : 'night', 3 + i * 7);
    out.push({ id: `doc${i}`, title: titles[i % titles.length], updated: now - i * i * 3.1e6 - i * 4e5, strokes: 3 + i * 11, thumb: c.toDataURL('image/png') });
  }
  return out;
}

/** Count visible, interactive controls in the chrome, split by region. */
function count(): { chrome: string[]; sheet: string[]; toast: string[]; radios: number; switches: number } {
  const root = document.getElementById('chrome')!;
  const sel = 'button, [role="button"], [role="radio"], [role="switch"], a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const seen = new Set<Element>();
  const out = { chrome: [] as string[], sheet: [] as string[], toast: [] as string[], radios: 0, switches: 0 };
  const vw = innerWidth, vh = innerHeight;
  root.querySelectorAll<HTMLElement>(sel).forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);
    if ((el as HTMLButtonElement).disabled || el.closest('[inert]')) return;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return;
    const name = el.getAttribute('aria-label') || el.textContent?.trim() || el.className;
    if (el.closest('.r-sheet')) {
      out.sheet.push(name);
      if (el.getAttribute('role') === 'radio') out.radios++;
      if (el.getAttribute('role') === 'switch') out.switches++;
    } else if (el.closest('.r-toast')) out.toast.push(name);
    else out.chrome.push(name);
  });
  return out;
}

const glyphs = createFakeGlyphs();
const ui = createUI(document.getElementById('chrome')!, store, glyphs);

/** Named states for screenshots and manual poking (?s=name). */
function preset(name: string): void {
  stageInk = false;
  const b = baseState();
  const keep = { isTouch: state.isTouch, isMac: state.isMac, ground: state.ground, reducedMotion: state.reducedMotion };
  const ink = { hasInk: true, canUndo: true, lastRecipe: null };
  switch (name) {
    case 'rest': set({ ...b, ...keep, firstRun: true, hints: { ...b.hints, draw: 'showing' } }); break;
    case 'ink': stageInk = true; set({ ...b, ...keep, ...ink }); break;
    case 'undo': stageInk = true; set({ ...b, ...keep, ...ink, canRedo: true }); break;
    case 'zoom': stageInk = false; set({ ...b, ...keep, ...ink, zoom: 240, inkInView: false, inkDirection: -2.5 }); break;
    case 'max': stageInk = true; set({ ...b, ...keep, ...ink, canRedo: true, zoom: 140 }); break;
    case 'selection': stageInk = true; set({ ...b, ...keep, ...ink, canRedo: true, zoom: 140, selection: ['a', 'b', 'c'], tool: { ...b.tool, recents: [customTeal, customRose] } }); break;
    case 'stroke': stageInk = true; set({ ...b, ...keep, ...ink, sheet: 'stroke' }); break;
    case 'color': stageInk = true; set({ ...b, ...keep, ...ink, sheet: 'color', tool: { ...b.tool, recents: [customRose] } }); break;
    case 'form': stageInk = true; set({ ...b, ...keep, ...ink, sheet: 'form' }); break;
    case 'menu': stageInk = true; set({ ...b, ...keep, ...ink, sheet: 'menu', recentDocs: thumbs(7), autosaveOk: false }); break;
    case 'help': stageInk = true; set({ ...b, ...keep, ...ink, sheet: 'help' }); break;
    case 'toast': stageInk = true; set({ ...b, ...keep, ...ink }); emit({ k: 'toast', id: 'autosave', text: 'Not autosaving', action: { label: 'Save', intent: { k: 'save' } } }); break;
    case 'export': stageInk = true; set({ ...b, ...keep, ...ink, exporting: true }); emit({ k: 'toast', id: 'export', text: 'Exporting image…', progress: 0.45, action: { label: 'Cancel', intent: { k: 'cancelExport' } } }); break;
    case 'erase': stageInk = true; set({ ...b, ...keep, ...ink, tool: { ...b.tool, mode: 'erase' } }); break;
    case 'drawing': stageInk = true; set({ ...b, ...keep, ...ink, chromeHidden: true }); break;
    case 'replay': stageInk = true; set({ ...b, ...keep, ...ink, replaying: true, replayProgress: 0.42 }); break;
    case 'hints': stageInk = true; set({ ...b, ...keep, ...ink }); emit({ k: 'hint', id: 'rise', text: 'Hold still to make it rise.', at: { x: innerWidth * 0.62, y: innerHeight * 0.42 } }); emit({ k: 'hint', id: 'form', text: 'Try another Form' }); emit({ k: 'pulse', target: 'form' }); break;
    default: break;
  }
  repaint();
}

const w = window as unknown as Record<string, unknown>;
w.__ui = {
  set, tool, emit, preset, count, intents, glyphs, store, ui,
  state: () => state,
  inks: INK_ORDER, nibs: P0_NIBS,
  ground(g: 'night' | 'paper') { set({ ground: g }); document.documentElement.dataset.ground = g; repaint(); },
};

const q = new URLSearchParams(location.search);
if (q.get('touch') === '1') set({ isTouch: true });
if (q.get('mac') === '1') set({ isMac: true });
if (q.get('ground') === 'paper') (w.__ui as { ground(g: string): void }).ground('paper');
preset(q.get('s') ?? 'rest');

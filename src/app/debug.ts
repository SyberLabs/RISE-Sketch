/**
 * `?debug` only: window.__rise, the RiseDebug test plumbing scripts/e2e.mjs drives
 * (src/app/types.ts). None of it is product UI.
 */
import type { RiseDebug } from './types';
import type { App } from './boot';
import { parseDoc, sceneHash, serializeDoc } from '../doc/serialize';
import { adoptDocument } from './docs';
import { VERSION } from './version';
import { prefKeys, prefKey } from '../persist/prefs';
import { remixLink } from './remix';
import { cook } from '../ink/cook';
import { paintGround } from '../render/ground';
import { readStats } from '../render/stats';

export { VERSION };

declare global {
  interface Window { __rise?: RiseDebug }
}

/** Interactive controls the user can see in #chrome (DESIGN §1.2 budget). */
function visibleControls(chrome: HTMLElement): { count: number; labels: string[] } {
  if (chrome.classList.contains('is-hidden')) return { count: 0, labels: [] };
  const labels: string[] = [];
  for (const el of chrome.querySelectorAll<HTMLElement>('button, [role="button"], a[href], input, select, textarea')) {
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-hidden') === 'true') continue;
    if (el.closest('[hidden], .is-off, [aria-hidden="true"]')) continue;
    if (el.getClientRects().length === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let op = 1;
    for (let e: HTMLElement | null = el; e && e !== chrome; e = e.parentElement) op *= Number(getComputedStyle(e).opacity) || 0;
    if (op < 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
    labels.push((el.getAttribute('aria-label') || el.textContent || el.className).trim());
  }
  return { count: labels.length, labels };
}

/**
 * The chrome is still moving: waiting out its 700 ms return after a contact, or a CSS transition
 * (fades, sheets growing) is running. Infinite animations do not count.
 */
function chromeSettling(app: App): boolean {
  const s = app.rt.store.get();
  if (!s.chromeHidden && !s.replaying && app.chrome.classList.contains('is-hidden')) return true;
  const anims = app.chrome.getAnimations?.({ subtree: true }) ?? [];
  for (const a of anims) {
    if (a.playState !== 'running') continue;
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === 'number' && Number.isFinite(end)) return true;
  }
  return false;
}

/** Composite the stage's layers at one CSS pixel (slow; tests only). */
function probe(app: App, sx: number, sy: number): [number, number, number, number] {
  const st = app.rt.store.get();
  const W = Math.max(1, app.stage.clientWidth), H = Math.max(1, app.stage.clientHeight);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [0, 0, 0, 0];
  paintGround(ctx, W, H, st.ground);
  const op: GlobalCompositeOperation = st.ground === 'night' ? 'lighter' : 'multiply';
  for (const id of ['base', 'bloomA', 'bloomB', 'dry', 'wet']) {
    const el = app.stage.querySelector<HTMLCanvasElement>('#' + id);
    if (!el || !el.width || !el.height) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    ctx.globalAlpha = Number(s.opacity) || 0;
    if (ctx.globalAlpha <= 0) continue;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(el, 0, 0, el.width, el.height, 0, 0, W, H);
  }
  const d = ctx.getImageData(Math.max(0, Math.min(W - 1, Math.round(sx))), Math.max(0, Math.min(H - 1, Math.round(sy))), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

/** Install window.__rise for the e2e suite. */
export function installDebug(app: App): void {
  const { rt } = app;
  const api: RiseDebug = {
    version: VERSION,
    idle(timeoutMs = 8000) {
      const t0 = performance.now();
      let calm = 0;
      return new Promise<boolean>(resolve => {
        const tick = (): void => {
          if (!app.busy() && !chromeSettling(app)) { if (++calm >= 3) { resolve(true); return; } } else calm = 0;
          if (performance.now() - t0 > timeoutMs) { resolve(false); return; }
          setTimeout(tick, 25);
        };
        tick();
      });
    },
    state: () => rt.store.get(),
    dispatch: i => rt.store.dispatch(i),
    sceneHash: () => sceneHash(rt.doc.ordered()),
    strokeCount: () => rt.doc.size,
    lastStroke() {
      const ord = rt.doc.ordered();
      const r = ord.length ? ord[ord.length - 1] : null;
      if (!r) return null;
      const c = rt.scene.cookedFor(r) ?? rt.scene.cooked(r.id) ?? cook(r);
      let maxGen = -1;
      for (let i = 0; i < c.nPolys; i++) if (c.gen[i] > maxGen) maxGen = c.gen[i];
      let maxPool = 0;
      for (let i = 1; i < r.pools.length; i += 4) if (r.pools[i] > maxPool) maxPool = r.pools[i];
      return {
        id: r.id, form: r.form.form, nib: r.stroke.nib, ink: r.color.ink, device: r.device,
        pools: Math.floor(r.pools.length / 4), maxPool, radial: r.radial, closed: r.closed,
        nPolys: c.nPolys, nPts: c.nPts, gens: maxGen + 1, base: r.form.base,
      };
    },
    camera: () => ({ ...rt.renderer.getCamera() }),
    toScreen: (x, y) => app.ctl.view.toScreen(x, y),
    toDoc: (sx, sy) => app.ctl.view.toDoc(sx, sy),
    visibleControls: () => visibleControls(app.chrome),
    serialize: () => serializeDoc(rt.doc.meta, rt.doc.ordered(), VERSION),
    async load(text) {
      const { meta, strokes } = parseDoc(text);
      adoptDocument(rt, app.ctl, meta, strokes, 'fade');
    },
    remixUrl: () => remixLink(rt.doc),
    exportPng: async () => (await app.ctl.exportPng(false)) ?? { width: 0, height: 0, bytes: 0 },
    async timelapse() {
      const r = await app.ctl.shareTimelapse(false);
      if (!r) return null;
      return { url: URL.createObjectURL(r.blob), bytes: r.blob.size, width: r.width, height: r.height, frames: r.frames, durationMs: r.durationMs };
    },
    perf: reset => rt.perf.read(reset),
    renderStats: opts => readStats(opts),
    probe: (sx, sy) => probe(app, sx, sy),
    async wipe() {
      try { await rt.autosave.flush(); } catch { /* nothing to keep */ }
      rt.autosave.dispose();
      const s = rt.docStore;
      if (s) {
        try { for (const d of await s.listDocs()) await s.deleteDoc(d.id); } catch (err) { console.error('[rise] wipe failed', err); }
      }
      for (const k of prefKeys()) {
        try { localStorage.removeItem(prefKey(k)); } catch { /* storage unavailable */ }
      }
    },
  };
  window.__rise = api;
}

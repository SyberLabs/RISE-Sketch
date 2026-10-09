/**
 * Boot: build every service and wire them (DESIGN §7.1, §8 load sequence).
 *
 *  1. Open the document store (IndexedDB; null when unavailable) and load the most recent
 *     document, else start a new one.
 *  2. doc + history (cap 500) + jobs + frame loop + scene (cooked LRU sized per device class).
 *  3. Renderer on #stage, sized, at the document's camera and ground; the saved viewport snapshot
 *     stands in until the visible tiles are cooked; the rest cooks in background jobs.
 *  4. Controller (input sink, intents, draft, eraser, camera), input on #stage, UI on #chrome.
 *  5. Autosave (batched writes, snapshots while idle), learner (calibration per device class).
 *  6. A remix link in the address (`#r=…`, now or later) opens as a new document and replays; the
 *     fragment is removed first, so a reload never imports it twice.
 *
 * Frame participants, in order: the draft (rows -> cook, Rise, closure) · the camera glide and
 * view-chip state · the renderer (live layer, tiles, composite, overlay, bloom) · background jobs.
 */
import type { AppState, HintId } from './types';
import type { Doc } from '../core/types';
import { cook, spineOf } from '../ink/cook';
import { createLearner } from '../ink/calib';
import { createDoc, newMeta } from '../doc/document';
import { createHistory } from '../doc/history';
import { makeDocId } from '../doc/ids';
import { createScene, COOKED_CAP_BYTES, type SceneImpl } from '../scene/scene';
import { createJobs } from '../sched/jobs';
import { attachJobs, createFrameLoop } from '../sched/frame';
import { createRenderer } from '../render/renderer';
import { deviceClass } from '../render/ledger';
import { createInput } from '../input/index';
import { createUI } from '../ui/index';
import { openDocStore, type DocStore } from '../persist/idb';
import { createAutosave, type AutosaveInternal } from '../persist/autosave';
import { onDropFiles } from '../persist/files';
import { remixPayload } from '../persist/remix';
import { prefs } from '../persist/prefs';
import { createStore } from './store';
import { createPerf } from './perf';
import { loadTool } from './tool';
import { Controller } from './controller';
import { showStoredSnapshot } from './docs';
import type { Runtime } from './runtime';

export interface BootOptions { stage: HTMLElement; chrome: HTMLElement }

/** The running app (debug hooks and the composition root hold it). */
export interface App {
  readonly rt: Runtime;
  readonly ctl: Controller;
  readonly stage: HTMLElement;
  readonly chrome: HTMLElement;
  /** True while anything will still change the picture or the storage without new input. */
  busy(): boolean;
}

const HINT_IDS: readonly HintId[] = ['draw', 'rise', 'form', 'nav', 'share'];

async function loadLatest(store: DocStore | null): Promise<{ meta: Doc['meta']; strokes: import('../core/types').StrokeRecipe[] } | null> {
  if (!store) return null;
  try {
    const list = await store.listDocs();
    for (const d of list) {
      const got = await store.loadDoc(d.id);
      if (got) return got;
    }
  } catch (err) {
    console.error('[rise] could not load the last document', err);
  }
  return null;
}

/** Build and start the app inside #stage / #chrome. */
export async function boot(o: BootOptions): Promise<App> {
  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
  const coarseMq = matchMedia('(pointer: coarse)');
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const isMac = /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || navigator.platform || navigator.userAgent);

  // ---- 1. storage and the document
  const docStore = await openDocStore().catch(() => null);
  const loaded = await loadLatest(docStore);
  const now = Date.now();
  const rand = (Math.random() * 4294967296) >>> 0;
  const meta = loaded ? loaded.meta : newMeta(now, rand, makeDocId(now, rand));
  const doc = createDoc(meta, loaded ? loaded.strokes : undefined);
  const history = createHistory(doc, 500);

  // ---- 2. scheduling and the scene
  const jobs = createJobs();
  const loop = createFrameLoop();
  const makeScene = (d: Doc): SceneImpl => createScene({
    doc: d, cook, jobs, requestFrame: () => loop.request(), spineOf, cacheBytes: COOKED_CAP_BYTES[deviceClass()],
  });
  const scene = makeScene(doc);

  // ---- 3. state
  const firstRun = !prefs.get<boolean>('firstRunDone', false);
  const doneHints = prefs.get<string[]>('hints', []);
  const hints = {} as Record<HintId, 'pending' | 'showing' | 'done'>;
  for (const h of HINT_IDS) hints[h] = doneHints.includes(h) ? 'done' : 'pending';
  // first run: the hint shows with the seed; arriving on a remix link it waits for the replay to end
  if (hints.draw === 'pending') hints.draw = !firstRun ? 'done' : remixPayload(location.hash) ? 'pending' : 'showing';
  const ordered = doc.ordered();
  const initial: AppState = {
    tool: loadTool(),
    ground: doc.meta.ground,
    selection: [], selectionRect: null,
    canUndo: false, canRedo: false,
    hasInk: doc.size > 0,
    zoom: doc.meta.camera.scale * 100, inkInView: true, inkDirection: null,
    chromeHidden: false, sheet: null,
    lastRecipe: ordered.length ? ordered[ordered.length - 1] : null,
    docTitle: doc.meta.title, currentDocId: doc.meta.id,
    recentDocs: [],
    autosaveOk: docStore !== null,
    replaying: false, replayProgress: 0, exporting: false, recording: false,
    penMode: false, firstRun, hints,
    reducedMotion: reducedMq.matches, isTouch: coarseMq.matches, isMac,
  };
  const store = createStore(initial);
  document.documentElement.dataset.ground = initial.ground;

  // ---- 4. renderer
  const renderer = createRenderer({
    root: o.stage, doc, scene, requestFrame: () => loop.request(), reducedMotion: () => store.get().reducedMotion,
  });
  const autosave = createAutosave(docStore) as AutosaveInternal;
  const learner = createLearner(prefs);
  const perf = createPerf();
  const rt: Runtime = {
    doc, history, scene, renderer, jobs, loop, store, learner, autosave, docStore, input: null, perf,
    reduced: () => store.get().reducedMotion,
    makeScene,
  };
  const ctl = new Controller(rt, o.stage);
  store.setDispatcher(i => ctl.dispatch(i));

  // viewport: size first (the settled camera snaps to device pixels), then the saved camera
  const resize = (): void => {
    const W = o.stage.clientWidth || window.innerWidth, H = o.stage.clientHeight || window.innerHeight;
    renderer.resize(W, H, window.devicePixelRatio || 1);
    ctl.view.setSize(W, H);
  };
  resize();
  renderer.setGround(initial.ground, false);
  ctl.view.reset(doc.meta.camera);
  let resizeTimer = 0;
  const onResize = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { resizeTimer = 0; resize(); }, 120);
  };
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);

  // frame participants
  let frameT0 = 0;
  loop.add(now => { frameT0 = performance.now(); return ctl.drafts.frame(now); }, 0);
  loop.add(now => ctl.view.frame(now), 5);
  loop.add((now, budget) => {
    const more = renderer.frame(now, budget);
    // CPU of every frame in which something moves: a live stroke, an animation or the camera
    if (ctl.drafts.active || ctl.view.navActive || renderer.live.animating > 0) perf.live(performance.now() - frameT0);
    return more;
  }, 10);
  // background jobs (cooks, occupancy warm-up) take the frame's leftover budget, and none at all
  // while a stroke is being drawn: one cook is not sliceable and must never cost the nib a frame
  attachJobs(loop, { run: budget => (ctl.drafts.active ? jobs.pending > 0 : jobs.run(budget)) });

  doc.subscribe(ch => ctl.docChanged(ch));
  ctl.refreshDoc();

  // cold load: the saved snapshot covers the view until its tiles are cooked; the rest cooks
  // in background jobs (visible strokes are requested at a higher priority by the tiles)
  if (doc.size > 0) {
    showStoredSnapshot(rt, doc.meta.id);
    scene.ensure(ordered.map(r => r.id), 'background').catch(() => undefined);
  }

  // ---- 5. input and chrome
  const input = createInput({
    target: o.stage,
    mode: () => store.get().tool.mode,
    keysBlocked: () => store.get().sheet !== null,
    isMac,
  }, ctl);
  rt.input = input;
  store.set({ penMode: input.penMode });
  input.onPenMode(on => store.set({ penMode: on }));
  input.onFingerPan(() => ctl.fingerPan());
  createUI(o.chrome, store, renderer.glyphs);
  // a dropped .rise opens as a new document (DESIGN §8)
  onDropFiles(o.stage, files => ctl.library.dropped(files));
  // the first-run seed (DESIGN §3.0): plays after 600 ms idle; the first pointerdown anywhere
  // un-grows it, and the same event may start the user's own stroke
  if (firstRun && doc.size === 0 && !remixPayload(location.hash)) {
    ctl.player.armSeed();
    const onFirstDown = (): void => { ctl.player.dissolveSeed(); };
    window.addEventListener('pointerdown', onFirstDown, { capture: true, passive: true });
  }

  reducedMq.addEventListener('change', () => store.set({ reducedMotion: reducedMq.matches }));
  coarseMq.addEventListener('change', () => store.set({ isTouch: coarseMq.matches }));

  // ---- 6. persistence
  autosave.attach(doc);
  autosave.setSnapshotSource(
    () => renderer.snapshot(1280).then(blob => (blob ? { blob, cam: { ...renderer.getCamera() } } : null)),
    () => ctl.busy || ctl.view.navActive,
  );
  const notAutosaving = (): void => store.emit({
    k: 'toast', id: 'autosave', text: 'Not autosaving', action: { label: 'Save', intent: { k: 'save' } },
  });
  autosave.onStatus(ok => {
    store.set({ autosaveOk: ok });
    if (!ok) notAutosaving();
  });
  if (!docStore) notAutosaving();
  void ctl.library.refreshRecent();
  const openLink = (): void => {
    const payload = remixPayload(location.hash);
    if (!payload) return;
    window.history.replaceState(window.history.state, '', location.pathname + location.search);
    void ctl.library.openRemix(payload);
  };
  openLink();
  window.addEventListener('hashchange', openLink);

  const app: App = {
    rt, ctl, stage: o.stage, chrome: o.chrome,
    busy: () =>
      renderer.busy || loop.running || jobs.pending > 0 || ctl.busy || ctl.view.navActive ||
      ctl.player.playing || ctl.player.seedPending ||
      (input.state !== 'idle') || (docStore !== null && autosave.pending),
  };
  return app;
}

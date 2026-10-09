/**
 * Switching documents (DESIGN §8: New, Open, a Recent document, a dropped file). The document
 * arrives as metadata plus recipes, and everything bound to a document is rebuilt around it in
 * one task:
 *
 *   the old document's live state ends (replay, seed, selection, a stroke in flight) and its
 *   snapshot is taken -> doc + history (cap 500) + scene (fresh cooked cache and occupancy) ->
 *   rebound renderer (200 ms base fade, never un-grow: DESIGN §3.2) -> autosave attached (the
 *   previous document's pending writes are flushed first) -> its camera and ground adopted ->
 *   its stored snapshot shown under the tiles (cold load) -> background cooks queued.
 *
 * Opening keeps the previous document in storage (it is listed in Recent); nothing here deletes.
 */
import type { DocMeta, StrokeRecipe } from '../core/types';
import { createDoc } from '../doc/document';
import { createHistory } from '../doc/history';
import type { Runtime } from './runtime';
import type { Controller } from './controller';

/** Make `meta` + `strokes` the current document. */
export function adoptDocument(rt: Runtime, ctl: Controller, meta: DocMeta, strokes: readonly StrokeRecipe[], anim: 'fade' | 'none'): void {
  ctl.leaveDocument();
  rt.renderer.live.fastForward();
  void rt.autosave.snapshotNow(false);
  // Opening/restoring selects this document for the next boot without changing its art.
  const doc = createDoc({ ...meta, updated: Date.now() }, strokes);
  const old = rt.scene;
  const scene = rt.makeScene(doc);
  rt.doc = doc;
  rt.history = createHistory(doc, 500);
  rt.scene = scene;
  rt.renderer.rebind(doc, scene, anim);
  old.dispose();
  doc.subscribe(ch => ctl.docChanged(ch));
  rt.autosave.attach(doc, { persistMeta: true });
  ctl.adoptView(meta.ground, meta.camera);
  ctl.refreshDoc();
  if (doc.size > 0) {
    showStoredSnapshot(rt, doc.meta.id);
    scene.ensure(doc.ordered().map(r => r.id), 'background').catch(() => undefined);
  }
}

/** Cold load: the stored viewport snapshot stands in until the visible tiles are cooked (DESIGN §8). */
export function showStoredSnapshot(rt: Runtime, docId: string): void {
  const store = rt.docStore;
  if (!store || typeof createImageBitmap !== 'function') return;
  store.getSnapshot(docId).then(async s => {
    if (!s || rt.doc.meta.id !== docId) return;
    const bmp = await createImageBitmap(s.blob);
    if (rt.doc.meta.id === docId) rt.renderer.showSnapshot(bmp, s.cam);
  }).catch(() => undefined);
}

/**
 * Browser check of the persistence layer (IndexedDB, autosave lifecycle, files, prefs).
 *
 * phase=write: fresh database; a document is edited through Doc/History with autosave
 * attached; a snapshot + thumbnail are stored; a hidden-page flush is checked; then
 * one more stroke is added and the page navigates away at once, so that stroke only
 * survives if the pagehide flush works.
 * phase=read: list, load and compare by sceneHash; snapshot / thumbnail read back;
 * reattach writes nothing; files round trip (plain + gzip); drop target; prefs;
 * failure status; connection loss recovery; delete.
 */
import type { Doc, StrokeRecipe } from '../../src/core/types';
import { addCmd, metaCmd, patchRecipe, removeCmd, replaceCmd } from '../../src/doc/commands';
import { cloneMeta, createDoc, newMeta } from '../../src/doc/document';
import { createHistory } from '../../src/doc/history';
import { makeDocId } from '../../src/doc/ids';
import { parseDoc, sceneHash, serializeDoc } from '../../src/doc/serialize';
import { createAutosave, thumbFromSnapshot } from '../../src/persist/autosave';
import type { AutosaveInternal } from '../../src/persist/autosave';
import { downloadBlob, gzipText, onDropFiles, pickFile, readFileText, riseFilename } from '../../src/persist/files';
import { openDocStore, DB_NAME } from '../../src/persist/idb';
import type { DocStore, StoreBatch } from '../../src/persist/idb';
import { prefs } from '../../src/persist/prefs';
import { randomRecipe, seeded } from '../../tests/doc-persist.helpers';

interface Check { name: string; ok: boolean; detail?: string }
const checks: Check[] = [];
const log = document.getElementById('log') as HTMLOListElement;
const w = window as unknown as { __result?: { phase: string; ok: boolean; checks: Check[] } };

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'bad';
  li.textContent = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`;
  log.appendChild(li);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const hex = (h: number) => '0x' + (h >>> 0).toString(16).padStart(8, '0');

function deleteDb(): Promise<void> {
  return new Promise(res => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = r.onerror = r.onblocked = () => res();
  });
}

async function snapshotBlob(label: string): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(160, 100, 10, 160, 100, 180);
  grd.addColorStop(0, '#18324a'); grd.addColorStop(1, '#07090c');
  g.fillStyle = grd; g.fillRect(0, 0, 320, 200);
  g.strokeStyle = '#9fe0a6'; g.lineWidth = 6; g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i <= 60; i++) { const x = 30 + i * 4.3, y = 100 + Math.sin(i / 6) * 50; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  g.fillStyle = '#d9dde3'; g.font = '16px system-ui'; g.fillText(label, 16, 186);
  return new Promise(res => c.toBlob(b => res(b as Blob), 'image/png'));
}

/** Wrap a store to count writes. */
function counting(store: DocStore): { store: DocStore; writes: () => number } {
  let n = 0;
  const wrapped: DocStore = Object.create(store);
  wrapped.writeBatch = (b: StoreBatch) => { n++; return store.writeBatch!(b); };
  wrapped.putStrokes = (id, rs) => { n++; return store.putStrokes(id, rs); };
  wrapped.putMeta = (m, c) => { n++; return store.putMeta(m, c); };
  return { store: wrapped, writes: () => n };
}

async function writePhase(): Promise<void> {
  await deleteDb();
  const store = await openDocStore();
  check('openDocStore resolves a store', !!store);
  if (!store) return;

  const rand = seeded(2024);
  const id = makeDocId(Date.now(), 0xc0ffee);
  const doc = createDoc(newMeta(Date.now(), 99, id));
  const h = createHistory(doc);
  const autosave = createAutosave(store) as AutosaveInternal;
  autosave.attach(doc);
  const commit = (c: Parameters<Doc['apply']>[0]) => h.push(c, doc.apply(c));

  for (let i = 0; i < 12; i++) commit(addCmd([randomRecipe(rand, doc.nextId(), { pools: i % 4 === 0 })]));
  const ids = doc.ordered().map(r => r.id);
  const victim = doc.get(ids[3]) as StrokeRecipe;
  commit(replaceCmd([victim], [patchRecipe(victim, { color: { ...victim.color, ink: 'rose', lch: null } }, 'color')]));
  commit(removeCmd([ids[5], ids[6]]));
  commit(metaCmd('Sandbox garden'));
  commit(addCmd([randomRecipe(rand, doc.nextId())]));
  h.undo(); // the last add is undone: it must not be stored
  doc.setView({ ground: 'paper', camera: { cx: 12.5, cy: -3.25, scale: 1.5, rot: 0 } });

  await sleep(100);
  check('nothing written before the 250 ms batch window', (await store.syncInfo!(id)).ids.length === 0);
  await sleep(250);
  const info = await store.syncInfo!(id);
  check('batched write landed after 250 ms', info.exists && info.ids.length === doc.size, `${info.ids.length}/${doc.size}`);
  await autosave.flush();
  check('autosave ok after flush', autosave.ok);

  const snap = await snapshotBlob('saved snapshot');
  await store.putSnapshot(id, snap, doc.meta.camera);
  const thumb = await thumbFromSnapshot(snap, 96);
  check('thumbnail derived from snapshot', !!thumb && thumb.size > 0, thumb ? `${thumb.type}, ${thumb.size} B` : 'null');
  if (thumb) await store.putThumb(id, thumb);

  // an older second document, written directly
  const other = createDoc(newMeta(Date.now() - 60_000, 5, makeDocId(Date.now() - 60_000, 1)));
  other.apply(addCmd([randomRecipe(rand, other.nextId()), randomRecipe(rand, other.nextId())]));
  const om = cloneMeta(other.meta);
  om.updated = Date.now() - 60_000;
  await store.putStrokes(om.id, other.ordered());
  await store.putMeta(om, other.size);

  // hidden page: flush without waiting for the batch timer
  commit(addCmd([randomRecipe(rand, doc.nextId())]));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  await sleep(60);
  check('visibilitychange:hidden flushes at once', (await store.syncInfo!(id)).ids.length === doc.size);
  delete (document as unknown as { visibilityState?: string }).visibilityState;

  // pagehide: add a stroke and leave immediately; only the pagehide flush can save it
  commit(addCmd([randomRecipe(rand, doc.nextId(), { pools: true })]));
  const q = new URLSearchParams({ phase: 'read', id, other: om.id, n: String(doc.size), hash: String(sceneHash(doc.ordered())), title: doc.meta.title });
  w.__result = { phase: 'write', ok: checks.every(c => c.ok), checks };
  sessionStorage.setItem('rise-sandbox-write', JSON.stringify(checks));
  location.replace('?' + q.toString());
}

async function readPhase(q: URLSearchParams): Promise<void> {
  const prior = JSON.parse(sessionStorage.getItem('rise-sandbox-write') || '[]') as Check[];
  for (const c of prior) check('[write] ' + c.name, c.ok, c.detail);
  const id = q.get('id')!, otherId = q.get('other')!, n = Number(q.get('n')), hash = Number(q.get('hash'));
  const raw = await openDocStore();
  check('reopen store after reload', !!raw);
  if (!raw) return;
  const { store, writes } = counting(raw);

  const list = await store.listDocs();
  check('listDocs: newest first', list.length === 2 && list[0].id === id && list[1].id === otherId, list.map(d => `${d.title}:${d.strokes}`).join(', '));
  const loaded = await store.loadDoc(id);
  check('loadDoc returns the document', !!loaded);
  if (!loaded) return;
  check('pagehide flush saved the last stroke', loaded.strokes.length === n, `${loaded.strokes.length}/${n}`);
  check('sceneHash identical after reload', sceneHash(loaded.strokes) === hash, `${hex(sceneHash(loaded.strokes))} vs ${hex(hash)}`);
  check('meta: title, ground, camera, counters', loaded.meta.title === q.get('title') && loaded.meta.ground === 'paper'
    && loaded.meta.camera.cx === 12.5 && loaded.meta.camera.scale === 1.5 && loaded.meta.counter > 0, JSON.stringify(loaded.meta.camera));
  const pressure = loaded.strokes.find(r => r.device !== 'pen');
  check('Float32 samples stored natively (NaN pressure kept)', loaded.strokes.every(r => r.samples instanceof Float32Array) && (!pressure || Number.isNaN(pressure.samples[3])));
  check('loaded recipes are frozen and z-ordered', loaded.strokes.every((r, i, a) => Object.isFrozen(r) && (i === 0 || a[i - 1].id < r.id)));
  const revs = new Set(loaded.strokes.flatMap(r => [r.geomRev, r.colorRev]));
  check('loaded strokes get one session-fresh rev (stored revs are not reused)', revs.size === 1 && [...revs][0] > 0, [...revs].join(','));
  const listed = list.find(d => d.id === id)!;
  check('summary stroke count matches', listed.strokes === loaded.strokes.length);

  const snap = await store.getSnapshot(id);
  check('snapshot read back with camera', !!snap && snap.blob.size > 0 && snap.cam.cx === 12.5, snap ? `${snap.blob.type} ${snap.blob.size} B` : 'null');
  if (snap) (document.getElementById('snap') as HTMLImageElement).src = URL.createObjectURL(snap.blob);
  const thumb = await store.getThumb(id);
  if (thumb) {
    const bmp = await createImageBitmap(thumb);
    check('thumbnail decodes, long edge 96 px', Math.max(bmp.width, bmp.height) === 96, `${bmp.width}x${bmp.height}`);
    (document.getElementById('thumb') as HTMLImageElement).src = URL.createObjectURL(thumb);
  } else check('thumbnail read back', false);

  // reattaching the loaded document reconciles to nothing
  const doc = createDoc(loaded.meta, loaded.strokes);
  const autosave = createAutosave(store) as AutosaveInternal;
  const statuses: boolean[] = [];
  autosave.onStatus(s => statuses.push(s));
  autosave.attach(doc);
  await sleep(400);
  check('reattach of a stored document writes nothing', writes() === 0, `${writes()} writes`);
  doc.apply(metaCmd('Renamed'));
  await sleep(350);
  check('a change after reattach is written once', writes() === 1 && (await store.listDocs()).some(d => d.title === 'Renamed'));
  autosave.dispose();

  // failure status with a store that throws QuotaExceededError
  const failing: DocStore = Object.create(raw);
  failing.writeBatch = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
  const fa = createAutosave(failing);
  const fs: boolean[] = [];
  fa.onStatus(s => fs.push(s));
  const fdoc = createDoc(newMeta(Date.now(), 1, 'failing-doc'));
  fa.attach(fdoc);
  fdoc.apply(addCmd([randomRecipe(seeded(1), fdoc.nextId())]));
  await sleep(350);
  check('quota failure turns autosave status off', !fa.ok && fs[0] === false);
  fa.dispose();

  // files: .rise round trip and gzip
  const text = serializeDoc(loaded.meta, loaded.strokes, 'rise-sketch@0.1.0');
  const file = new File([text], riseFilename(loaded.meta.title), { type: 'application/json' });
  const back = parseDoc(await readFileText(file));
  check('.rise file round trip keeps sceneHash', sceneHash(back.strokes) === hash && back.meta.id !== id, `${file.name}, ${file.size} B`);
  const gz = await gzipText(text);
  if (gz) {
    const gzText = await readFileText(new File([gz], 'x.rise'));
    check('gzip .rise is inflated on read', gzText === text, `${gz.size} B gz vs ${text.length} B`);
  } else check('CompressionStream available', false);

  // drop target
  const drop = document.getElementById('drop') as HTMLElement;
  let dropped: File[] = [];
  const off = onDropFiles(drop, f => { dropped = f; });
  const dt = new DataTransfer();
  dt.items.add(file);
  drop.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  const flagged = drop.dataset.drop === '1';
  const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
  drop.dispatchEvent(over);
  drop.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  check('onDropFiles delivers dropped files', flagged && over.defaultPrevented && dropped.length === 1 && dropped[0].name === file.name && !drop.dataset.drop);
  off();

  // prefs in a real browser
  prefs.set('sandbox', { a: 1 });
  check('prefs round trip under rise:', localStorage.getItem('rise:sandbox') === '{"a":1}' && prefs.get('sandbox', {}).hasOwnProperty('a'));
  prefs.remove('sandbox');

  const persisted = await store.requestPersist();
  check('requestPersist resolves a boolean', typeof persisted === 'boolean', String(persisted));

  // delete
  await store.deleteDoc(id);
  const after = await store.listDocs();
  check('deleteDoc removes it from the list', after.length === 1 && after[0].id === otherId);
  check('deleteDoc removes strokes, snapshot and thumbnail',
    (await store.loadDoc(id)) === null && (await store.getSnapshot(id)) === null && (await store.getThumb(id)) === null && (await raw.syncInfo!(id)).ids.length === 0);

  // connection loss: another context deletes the database under us; concurrent
  // callers must share one reconnect (no leaked extra connections)
  await deleteDb();
  const factory = indexedDB as IDBFactory & { open: IDBFactory['open'] };
  const realOpen = factory.open.bind(indexedDB);
  let opens = 0;
  factory.open = (name: string, version?: number) => { opens++; return realOpen(name, version); };
  const [reopened, again, info] = await Promise.all([
    raw.listDocs().then(l => l, () => null),
    raw.listDocs().then(l => l, () => null),
    raw.syncInfo!('nothing').then(s => s, () => null),
  ]);
  delete (factory as { open?: unknown }).open;
  check('recovers from a lost connection (versionchange / delete)', Array.isArray(reopened) && reopened.length === 0 && Array.isArray(again) && !!info && !info.exists);
  check('concurrent calls share one reconnect', opens === 1, `${opens} open() calls`);
  raw.close?.();
}

/** Buttons the harness clicks (a real click gives the user activation file pickers need). */
function wireFileButtons(): void {
  const x = window as unknown as { __picked?: string | null | undefined; __pickDone?: boolean };
  (document.getElementById('pick') as HTMLButtonElement).onclick = () => {
    x.__pickDone = false;
    void pickFile('.rise,application/json').then(async f => {
      x.__picked = f ? `${f.name}:${(await readFileText(f)).length}` : null;
      x.__pickDone = true;
    });
  };
  (document.getElementById('save') as HTMLButtonElement).onclick = () => {
    downloadBlob(new Blob(['{"format":"rise"}'], { type: 'application/json' }), riseFilename('My: drawing/1?'));
  };
}

async function main(): Promise<void> {
  wireFileButtons();
  const q = new URLSearchParams(location.search);
  const phase = q.get('phase') ?? 'write';
  (document.getElementById('phase') as HTMLElement).textContent = `phase: ${phase}`;
  try {
    if (phase === 'write') await writePhase();
    else await readPhase(q);
  } catch (e) {
    check('no exception', false, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  if (phase !== 'write' || !checks.every(c => c.ok)) {
    w.__result = { phase, ok: checks.every(c => c.ok), checks };
    (document.getElementById('phase') as HTMLElement).textContent = `phase: ${phase} — ${checks.filter(c => c.ok).length}/${checks.length} passed`;
  }
}

void main();

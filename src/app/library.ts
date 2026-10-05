/**
 * Documents (DESIGN §8): New, Open… / drop, Save project, Recent.
 *
 *  - New switches to a fresh document; the old one stays in storage and so in Recent (never a
 *    Clear). Toast: "New canvas. The last one is in Recent." when the old one had ink.
 *  - Open (picker, Mod+O, a dropped .rise) parses the file into a NEW document (fresh id, fresh
 *    revs; parseDoc) and adopts it with the 200 ms base fade. Toast: "Opened ⟨title⟩".
 *  - Save downloads `<title>.rise`.
 *  - Recent: the last 12 stored documents, newest first, with their autosave thumbnails as
 *    object URLs (revoked when they leave the list). Opening one loads it from IndexedDB and
 *    shows its cold-load snapshot until the tiles are cooked. Deleting the current document first
 *    moves to a fresh one, so autosave never resurrects it.
 */
import type { StrokeRecipe } from '../core/types';
import { newMeta } from '../doc/document';
import { makeDocId } from '../doc/ids';
import { parseDoc, serializeDoc } from '../doc/serialize';
import { downloadBlob, pickFile, readFileText, riseFilename } from '../persist/files';
import type { RecentDoc } from './types';
import type { Runtime } from './runtime';
import type { Controller } from './controller';
import { adoptDocument } from './docs';
import { VERSION } from './version';

/** Recent lists at most this many documents (DESIGN §4). */
export const RECENT_MAX = 12;

export class Library {
  private readonly thumbs = new Map<string, string>();
  private refreshing: Promise<void> | null = null;

  constructor(private readonly rt: Runtime, private readonly ctl: Controller) {}

  // ---------------------------------------------------------------- new / open / save

  /** A fresh document; the current one stays in Recent. */
  newDoc(): void {
    const rt = this.rt;
    const hadInk = rt.doc.size > 0;
    const now = Date.now(), rand = (Math.random() * 4294967296) >>> 0;
    const meta = newMeta(now, rand, makeDocId(now, rand));
    // the new canvas keeps the ground you are working on
    meta.ground = rt.store.get().ground;
    adoptDocument(rt, this.ctl, meta, [], hadInk ? 'fade' : 'none');
    if (hadInk) rt.store.emit({ k: 'toast', id: 'new', text: 'New canvas. The last one is in Recent.' });
    rt.store.emit({ k: 'announce', text: 'New canvas' });
    this.scheduleRefresh();
  }

  /** Menu → Open… / Mod+O. Must be called from a user gesture (the picker needs one). */
  async openPicker(): Promise<void> {
    let f: File | null = null;
    try { f = await pickFile('.rise,application/json,text/plain'); } catch { f = null; }
    if (f) await this.openFile(f);
  }

  /** Open a .rise file as a new document (picker or drop). */
  async openFile(f: File): Promise<void> {
    const rt = this.rt;
    let parsed: { meta: import('../core/types').DocMeta; strokes: StrokeRecipe[] };
    try {
      const text = await readFileText(f);
      parsed = parseDoc(text);
    } catch (err) {
      console.error('[rise] could not open', f.name, err);
      rt.store.emit({ k: 'toast', id: 'open', text: `Couldn't open ${f.name}` });
      return;
    }
    const title = parsed.meta.title.trim() || f.name.replace(/\.rise$/i, '') || 'Untitled';
    if (!parsed.meta.title.trim()) parsed.meta.title = title;
    adoptDocument(rt, this.ctl, parsed.meta, parsed.strokes, 'fade');
    rt.store.emit({ k: 'toast', id: 'open', text: `Opened ${title}` });
    this.scheduleRefresh();
  }

  /** Files dropped on the canvas: the first .rise (or JSON) file opens. */
  dropped(files: readonly File[]): void {
    const f = files.find(x => /\.rise$/i.test(x.name)) ?? files.find(x => /json|text/.test(x.type)) ?? files[0];
    if (f) void this.openFile(f);
  }

  /** Mod+S / menu: download `<title>.rise`. */
  save(): void {
    const rt = this.rt;
    let text: string;
    try { text = serializeDoc(rt.doc.meta, rt.doc.ordered(), VERSION); } catch (err) {
      console.error('[rise] could not save', err);
      rt.store.emit({ k: 'toast', id: 'save', text: "Couldn't save the project" });
      return;
    }
    downloadBlob(new Blob([text], { type: 'application/json' }), riseFilename(rt.doc.meta.title || 'Untitled'));
    rt.store.emit({ k: 'announce', text: 'Project saved' });
  }

  // ---------------------------------------------------------------- recent

  async openRecent(id: string): Promise<void> {
    const rt = this.rt, store = rt.docStore;
    if (!store || id === rt.doc.meta.id) return;
    let got: { meta: import('../core/types').DocMeta; strokes: StrokeRecipe[] } | null = null;
    try { got = await store.loadDoc(id); } catch (err) { console.error('[rise] could not load', id, err); }
    if (!got) {
      rt.store.emit({ k: 'announce', text: 'That drawing is no longer stored' });
      this.scheduleRefresh();
      return;
    }
    if (id === rt.doc.meta.id) return;  // opened meanwhile
    adoptDocument(rt, this.ctl, got.meta, got.strokes, 'fade');
    rt.store.emit({ k: 'toast', id: 'open', text: `Opened ${got.meta.title.trim() || 'Untitled'}` });
    this.scheduleRefresh();
  }

  async deleteRecent(id: string): Promise<void> {
    const rt = this.rt, store = rt.docStore;
    if (!store) return;
    if (id === rt.doc.meta.id) {
      // the document on the canvas: move to a fresh one first, so autosave never writes it again
      const now = Date.now(), rand = (Math.random() * 4294967296) >>> 0;
      const meta = newMeta(now, rand, makeDocId(now, rand));
      meta.ground = rt.store.get().ground;
      adoptDocument(rt, this.ctl, meta, [], 'fade');
      try { await rt.autosave.flush(); } catch { /* the delete below wins */ }
    }
    try { await store.deleteDoc(id); } catch (err) { console.error('[rise] could not delete', id, err); }
    rt.store.emit({ k: 'announce', text: 'Drawing deleted' });
    await this.refreshRecent();
  }

  /** Re-read the Recent list (menu open, document switches, deletes). Coalesced. */
  scheduleRefresh(): void {
    if (this.refreshing) return;
    this.refreshing = new Promise<void>(resolve => setTimeout(resolve, 400)).then(() => { this.refreshing = null; return this.refreshRecent(); });
  }

  async refreshRecent(): Promise<void> {
    const rt = this.rt, store = rt.docStore;
    if (!store) return;
    let list: { id: string; title: string; updated: number; strokes: number }[];
    try { list = (await store.listDocs()).slice(0, RECENT_MAX); } catch (err) { console.error('[rise] could not list documents', err); return; }
    const docs: RecentDoc[] = [];
    const seen = new Set<string>();
    for (const d of list) {
      seen.add(d.id);
      let thumb = this.thumbs.get(d.id) ?? null;
      if (!thumb) {
        try {
          const b = await store.getThumb(d.id);
          if (b) { thumb = URL.createObjectURL(b); this.thumbs.set(d.id, thumb); }
        } catch { thumb = null; }
      }
      docs.push({ id: d.id, title: d.title, updated: d.updated, strokes: d.strokes, thumb });
    }
    for (const [id, url] of this.thumbs) if (!seen.has(id)) { URL.revokeObjectURL(url); this.thumbs.delete(id); }
    const prev = rt.store.get().recentDocs;
    const same = prev.length === docs.length && prev.every((p, i) => {
      const d = docs[i];
      return p.id === d.id && p.title === d.title && p.updated === d.updated && p.strokes === d.strokes && p.thumb === d.thumb;
    });
    if (!same) rt.store.set({ recentDocs: docs });
  }

  /** A thumbnail may have been rewritten (autosave snapshot): forget the cached URL. */
  invalidateThumb(id: string): void {
    const u = this.thumbs.get(id);
    if (u) { URL.revokeObjectURL(u); this.thumbs.delete(id); }
  }
}

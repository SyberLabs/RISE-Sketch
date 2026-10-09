/**
 * File plumbing for `.rise` save / open / drop and image export (DESIGN §8).
 * Saving downloads through `<a download>`; opening uses a transient
 * `<input type=file>`; dropping is bound to the canvas element. `readFileText`
 * transparently inflates gzip files (magic `1f 8b`, the P1 compressed format)
 * where DecompressionStream exists, and reads the project out of an exported PNG.
 */
import { isPng, projectOf } from './pngproject';

/** Characters that are invalid in file names on at least one major OS. */
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

/** A safe file name: invalid characters replaced, trimmed, never empty, at most 120 chars before the extension. */
export function safeFilename(name: string, ext = ''): string {
  let base = String(name).replace(BAD_NAME, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, base.length - ext.length).trim();
  if (!base) base = 'untitled';
  if (base.length > 120) base = base.slice(0, 120).trim();
  return base + ext;
}

/** Deliver a blob as a download named `filename` (sanitised). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename(filename);
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously cancels the download in some engines (Safari, old Firefox).
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Show the system file picker. Resolves with the chosen file, or null when the
 * user cancels (the `cancel` event where supported, else a focus-return check).
 */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    let done = false;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (f: File | null): void => {
      if (done) return;
      done = true;
      if (focusTimer !== null) clearTimeout(focusTimer);
      removeEventListener('focus', onFocus);
      input.remove();
      resolve(f);
    };
    // Fallback for engines without the `cancel` event: the window regains focus when the
    // dialog closes; `change` follows within a moment if a file was chosen.
    const onFocus = (): void => {
      if (focusTimer !== null) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => finish(input.files?.[0] ?? null), 1000);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.appendChild(input);
    setTimeout(() => addEventListener('focus', onFocus), 0);
    input.click();
  });
}

const GZIP0 = 0x1f, GZIP1 = 0x8b;

/**
 * Read a file as UTF-8 text (BOM stripped), inflating gzip content when the browser can. A PNG
 * yields the `.rise` it carries (persist/pngproject.ts), or null when it carries none.
 */
export async function readFileText(f: File): Promise<string | null> {
  const buf = new Uint8Array(await f.arrayBuffer());
  if (isPng(buf)) return projectOf(buf);
  if (buf.length >= 2 && buf[0] === GZIP0 && buf[1] === GZIP1) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed .rise files');
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return stripBom(await new Response(stream).text());
  }
  return stripBom(new TextDecoder('utf-8').decode(buf));
}

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Gzip text (the P1 compressed `.rise`); null when CompressionStream is unavailable. */
export async function gzipText(text: string, type = 'application/octet-stream'): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], { type });
}

const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/**
 * Accept files dropped on `el`. While files are dragged over it, `el` carries
 * `data-drop="1"` (a styling hook). Returns an unsubscribe function.
 */
export function onDropFiles(el: HTMLElement, fn: (files: File[]) => void): () => void {
  let depth = 0;
  const clear = (): void => { depth = 0; delete el.dataset.drop; };
  const over = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // allow the drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const enter = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    el.dataset.drop = '1';
  };
  const leave = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) clear();
  };
  const drop = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    clear();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) fn(files);
  };
  el.addEventListener('dragenter', enter);
  el.addEventListener('dragover', over);
  el.addEventListener('dragleave', leave);
  el.addEventListener('drop', drop);
  return () => {
    el.removeEventListener('dragenter', enter);
    el.removeEventListener('dragover', over);
    el.removeEventListener('dragleave', leave);
    el.removeEventListener('drop', drop);
    clear();
  };
}

/** `<title>.rise` download name for a document title. */
export function riseFilename(title: string): string {
  return safeFilename(title, '.rise');
}

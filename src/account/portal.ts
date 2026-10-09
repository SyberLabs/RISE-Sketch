import type { App } from '../app/boot';
import { adoptDocument } from '../app/docs';
import { downloadBlob, riseFilename } from '../persist/files';
import { serializeDoc } from '../doc/serialize';
import { VERSION } from '../app/version';
import { ACCOUNT_ORIGIN, SIGN_IN_URL, AccountError, getAccount, listDrawings, drawingPayload, saveDrawing, type Account, type DrawingPayload, type SavedDrawing } from './service';
import { restoreAccountDrawing } from './restore';
import './portal.css';

/** Always reachable independently of the drawing chrome's hide/show modes. */
export function mountAccountPortal(app: App): void {
  const entrance = document.createElement('a');
  entrance.className = 'sketch-account-entry'; entrance.href = SIGN_IN_URL; entrance.textContent = 'Sign in';
  entrance.setAttribute('aria-label', 'Sign in to SyberLabs');
  document.body.append(entrance);
  // Existing modal sheets own focus and hit testing while open.
  const backdrop = app.chrome.querySelector<HTMLElement>('.r-backdrop');
  const syncModal = () => { entrance.hidden = Boolean(backdrop && !backdrop.hidden && backdrop.dataset.modal === 'true'); entrance.inert = entrance.hidden; };
  if (backdrop) new MutationObserver(syncModal).observe(backdrop, { attributes: true, attributeFilter: ['hidden', 'data-modal'] });
  syncModal();
  let account: Account | null = null, generation = 0, identityGeneration = 0;
  const refresh = async () => {
    const current = ++generation;
    let value: Account | null = null;
    try { if (/^https?:$/.test(location.protocol)) value = await getAccount(); } catch { /* drawing remains usable offline */ }
    if (current !== generation) return;
    const changed = (account?.id ?? null) !== (value?.id ?? null);
    if (changed) identityGeneration++;
    account = value;
    if (changed) document.querySelector<HTMLDialogElement>('.sketch-account-panel')?.close();
    entrance.textContent = value ? 'Account' : 'Sign in';
    entrance.title = value ? `SyberLabs account: ${value.label}` : 'Sign in to SyberLabs';
    entrance.setAttribute('aria-label', value ? 'Open SyberLabs account' : 'Sign in to SyberLabs');
  };
  window.addEventListener('focus', refresh); void refresh();
  entrance.addEventListener('click', event => {
    if (!account || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (document.querySelector('.sketch-account-panel')) return;
    const owner = account, capturedGeneration = identityGeneration;
    openPanel(app, owner, entrance, refresh, () => account?.id === owner.id && identityGeneration === capturedGeneration);
  });
}
function openPanel(app: App, account: Account, entrance: HTMLElement, refresh: () => Promise<void>, isCurrent: () => boolean): void {
  const dialog = document.createElement('dialog'); dialog.className = 'sketch-account-panel';
  dialog.setAttribute('aria-labelledby', 'sketch-account-title');
  dialog.innerHTML = `<header><small>SYBERLABS / SKETCH</small><button type="button" data-close aria-label="Close account">×</button></header>
    <h1 id="sketch-account-title">Your orbit.</h1><p data-user></p>
    <p>Your drawing lives in this browser. Save a private account backup when you choose.</p>
    <p class="sketch-account-links"><a href="${ACCOUNT_ORIGIN}/admin/">Open portal ↗</a><a href="${ACCOUNT_ORIGIN}/admin/saves">Saved things ↗</a></p>
    <label for="sketch-backup-name">Backup name</label><input id="sketch-backup-name" maxlength="100">
    <div class="sketch-account-actions"><button type="button" data-save>Save to account</button><button type="button" data-download>Download drawing</button></div>
    <div class="sketch-account-list-heading"><h2>Saved drawings</h2><button type="button" data-reload>Refresh backups</button></div>
    <label for="sketch-backup-list">Account backups</label><select id="sketch-backup-list" aria-describedby="sketch-backup-detail"></select>
    <p id="sketch-backup-detail" data-detail></p>
    <p id="sketch-restore-help">Open a backup as a new drawing. Your current drawing stays in Recent; a local download is made first.</p>
    <label class="sketch-account-confirm"><input type="checkbox" data-confirm aria-describedby="sketch-restore-help"><span data-confirm-label>Open selected backup in this browser</span></label>
    <button type="button" data-restore>Restore drawing</button><p data-status role="status" aria-live="polite"></p>
    <a href="${SIGN_IN_URL}" data-signin hidden>Sign in again</a>`;
  dialog.querySelector('[data-user]')!.textContent = account.label;
  const name = dialog.querySelector<HTMLInputElement>('#sketch-backup-name')!;
  name.value = (app.rt.doc.meta.title || 'My drawing').slice(0, 100);
  const list = dialog.querySelector<HTMLSelectElement>('#sketch-backup-list')!;
  const confirm = dialog.querySelector<HTMLInputElement>('[data-confirm]')!;
  const status = dialog.querySelector<HTMLElement>('[data-status]')!;
  const save = dialog.querySelector<HTMLButtonElement>('[data-save]')!;
  const restore = dialog.querySelector<HTMLButtonElement>('[data-restore]')!;
  const download = dialog.querySelector<HTMLButtonElement>('[data-download]')!;
  const reload = dialog.querySelector<HTMLButtonElement>('[data-reload]')!;
  const detail = dialog.querySelector<HTMLElement>('[data-detail]')!;
  const confirmLabel = dialog.querySelector<HTMLElement>('[data-confirm-label]')!;
  let closed = false, busy = false;
  let listState: 'loading' | 'ready' | 'error' = 'loading';
  let rows: SavedDrawing[] = [];
  let pending: { name: string; payload: DrawingPayload; requestId: string; expectedUserId: string } | null = null;
  const controls = () => { save.disabled = busy || !name.value.trim(); restore.disabled = busy || listState !== 'ready' || !list.value || !confirm.checked; download.disabled = busy; reload.disabled = busy; name.disabled = busy; list.disabled = busy || listState !== 'ready' || !rows.length; confirm.disabled = busy || listState !== 'ready' || !list.value; };
  const selection = () => {
    const row = rows.find(row => row.id === list.value);
    detail.textContent = row ? `Saved ${new Date(row.createdAt).toLocaleString()} · ${Math.max(1, Math.ceil(row.bytes / 1024)).toLocaleString()} KB` : 'Save your current drawing to create your first private backup.';
    confirmLabel.textContent = row ? `Open “${row.name}” in this browser` : 'Open selected backup in this browser';
  };
  const sameAccount = async () => { if ((await getAccount()).id !== account.id) throw new AccountError('Your account changed. Close this panel and reopen it before saving or restoring.', 401); };
  const loadList = async () => {
    const selected = list.value;
    listState = 'loading'; confirm.checked = false; detail.textContent = 'Loading your account backups…'; controls();
    let loaded: SavedDrawing[];
    try { loaded = await listDrawings(account.id); }
    catch (error) { if (!closed) { listState = 'error'; detail.textContent = 'Backups could not be loaded. Refresh backups to try again; your drawing is unchanged.'; controls(); } throw error; }
    if (closed) return;
    rows = loaded; listState = 'ready';
    list.replaceChildren();
    for (const row of rows) { const option = document.createElement('option'); option.value = row.id; option.textContent = `${row.name} · ${new Date(row.createdAt).toLocaleDateString()}`; list.append(option); }
    if (!rows.length) list.append(Object.assign(document.createElement('option'), { value: '', textContent: 'No account backups yet' }));
    if (rows.some(row => row.id === selected)) list.value = selected;
    selection(); controls();
  };
  const run = async (message: string, action: () => Promise<void>) => {
    if (busy || closed) return; busy = true; controls(); status.textContent = message; list.setAttribute('aria-busy', 'true');
    dialog.querySelector<HTMLAnchorElement>('[data-signin]')!.hidden = true;
    try { await action(); } catch (error) {
      if (!closed) { status.textContent = error instanceof Error ? error.message : 'Account storage is unavailable.'; dialog.querySelector<HTMLAnchorElement>('[data-signin]')!.hidden = !(error instanceof AccountError && error.status === 401); }
    } finally { busy = false; if (!closed) { controls(); list.setAttribute('aria-busy', 'false'); } }
  };
  const downloadCurrent = () => downloadBlob(new Blob([serializeDoc(app.rt.doc.meta, app.rt.doc.ordered(), VERSION)], { type: 'application/json' }), riseFilename(app.rt.doc.meta.title || 'Untitled'));
  name.addEventListener('input', () => { pending = null; controls(); }); list.addEventListener('change', () => { confirm.checked = false; selection(); controls(); }); confirm.addEventListener('change', controls);
  reload.addEventListener('click', () => void run('Refreshing your backups…', async () => { await loadList(); if (!closed) status.textContent = 'Your account backups are up to date.'; }));
  save.addEventListener('click', () => void run('Saving your private drawing backup…', async () => {
    await sameAccount(); if (closed) return;
    pending ??= { name: name.value.trim(), payload: drawingPayload(app.rt.doc.meta, app.rt.doc.ordered()), requestId: crypto.randomUUID(), expectedUserId: account.id };
    await saveDrawing(pending.name, pending.payload, pending.requestId, pending.expectedUserId); pending = null;
    try { await loadList(); if (!closed) status.textContent = 'Private drawing backup saved to your account.'; }
    catch (error) { if (!closed) { status.textContent = 'Private drawing backup saved to your account. The backup list could not refresh; use Refresh backups to try again.'; dialog.querySelector<HTMLAnchorElement>('[data-signin]')!.hidden = !(error instanceof AccountError && error.status === 401); } }
  }));
  download.addEventListener('click', () => downloadCurrent());
  restore.addEventListener('click', () => void run('Restoring your drawing and preserving the current one…', async () => {
    await sameAccount(); if (closed) return;
    const parsed = await restoreAccountDrawing(list.value, account.id, {
      isCurrent: () => !closed && isCurrent(),
      flush: () => app.rt.autosave.flush(),
      autosaveOk: () => app.rt.autosave.ok,
      backup: downloadCurrent,
      adopt: async drawing => {
        adoptDocument(app.rt, app.ctl, drawing.meta, drawing.strokes, 'fade');
        await app.rt.autosave.flush();
        if (!app.rt.autosave.ok) throw new AccountError('Drawing opened, but browser autosave is unavailable. Keep the downloaded backup.');
      },
    });
    if (closed) return;
    pending = null; confirm.checked = false; name.value = (parsed.meta.title || 'My drawing').slice(0, 100);
    void app.ctl.library.refreshRecent(); status.textContent = 'Drawing restored. Your previous drawing is in Recent and the downloaded backup.';
  }));
  dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { closed = true; dialog.remove(); entrance.focus(); void refresh(); }, { once: true });
  document.body.append(dialog); dialog.showModal(); controls();
  void run('Loading your account backups…', async () => { await loadList(); if (!closed) status.textContent = rows.length ? 'Your account backups are ready.' : 'No account backups yet. Save your drawing above to keep a private copy.'; });
}

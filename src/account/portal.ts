import type { App } from '../app/boot';
import { adoptDocument } from '../app/docs';
import { downloadBlob, riseFilename } from '../persist/files';
import { serializeDoc } from '../doc/serialize';
import { VERSION } from '../app/version';
import { ACCOUNT_ORIGIN, SIGN_IN_URL, AccountError, getAccount, listDrawings, drawingPayload, saveDrawing, type Account, type DrawingPayload } from './service';
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
    <h2>Saved drawings</h2><label for="sketch-backup-list">Account backups</label><select id="sketch-backup-list"></select>
    <p>Open a backup as a new drawing. Your current drawing stays in Recent; a local download is made first.</p>
    <label class="sketch-account-confirm"><input type="checkbox" data-confirm> Open selected backup in this browser</label>
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
  let closed = false, busy = false;
  let pending: { name: string; payload: DrawingPayload; requestId: string; expectedUserId: string } | null = null;
  const controls = () => { save.disabled = busy || !name.value.trim(); restore.disabled = busy || !list.value || !confirm.checked; download.disabled = busy; name.disabled = busy; list.disabled = busy; confirm.disabled = busy; };
  const sameAccount = async () => { if ((await getAccount()).id !== account.id) throw new AccountError('Your account changed. Close this panel and reopen it before saving or restoring.', 401); };
  const loadList = async () => {
    const rows = await listDrawings(account.id); if (closed) return;
    list.replaceChildren();
    for (const row of rows) { const option = document.createElement('option'); option.value = row.id; option.textContent = `${row.name} · ${new Date(row.createdAt).toLocaleDateString()}`; list.append(option); }
    if (!rows.length) list.append(Object.assign(document.createElement('option'), { value: '', textContent: 'No account backups yet' }));
  };
  const run = async (action: () => Promise<void>) => {
    if (busy || closed) return; busy = true; controls(); status.textContent = 'Working…';
    try { await action(); } catch (error) {
      if (!closed) { status.textContent = error instanceof Error ? error.message : 'Account storage is unavailable.'; dialog.querySelector<HTMLAnchorElement>('[data-signin]')!.hidden = !(error instanceof AccountError && error.status === 401); }
    } finally { busy = false; if (!closed) controls(); }
  };
  const downloadCurrent = () => downloadBlob(new Blob([serializeDoc(app.rt.doc.meta, app.rt.doc.ordered(), VERSION)], { type: 'application/json' }), riseFilename(app.rt.doc.meta.title || 'Untitled'));
  name.addEventListener('input', () => { pending = null; controls(); }); list.addEventListener('change', () => { confirm.checked = false; controls(); }); confirm.addEventListener('change', controls);
  save.addEventListener('click', () => void run(async () => {
    await sameAccount(); if (closed) return;
    pending ??= { name: name.value.trim(), payload: drawingPayload(app.rt.doc.meta, app.rt.doc.ordered()), requestId: crypto.randomUUID(), expectedUserId: account.id };
    await saveDrawing(pending.name, pending.payload, pending.requestId, pending.expectedUserId); pending = null;
    await loadList(); if (!closed) status.textContent = 'Private drawing backup saved to your account.';
  }));
  download.addEventListener('click', () => downloadCurrent());
  restore.addEventListener('click', () => void run(async () => {
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
  void run(async () => { await loadList(); if (!closed) status.textContent = 'Your account backups are ready.'; });
}

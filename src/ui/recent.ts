/**
 * Recent drawings, inside the menu (DESIGN §4, §8 "Recent"): the last 12 documents, newest first,
 * each with its title, date and a 96 px thumbnail. Tap to open; each has a delete action with the
 * confirmation inside the sheet ("Delete … ?" Delete / Keep, focus on Keep).
 */
import type { RecentDoc } from '../app/types';
import { icon } from './icons';
import type { UICtx } from './index';

export const RECENT_MAX = 12;

export type WhenCategory = 'today' | 'yesterday' | 'week' | 'year' | 'older';

const DAY = 86400000;
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Which kind of date label an edit time gets, relative to `now` (local days). Pure. */
export function whenCategory(updated: number, now: number): WhenCategory {
  const today = startOfDay(now);
  if (updated >= today) return 'today';
  if (updated >= startOfDay(today - DAY / 2)) return 'yesterday';
  if (updated >= startOfDay(today - 6 * DAY + DAY / 2)) return 'week';
  return new Date(updated).getFullYear() === new Date(now).getFullYear() ? 'year' : 'older';
}

/** "Today, 14:32" · "Yesterday" · "Monday" · "3 Oct" · "3 Oct 2025" in the user's locale. */
export function formatWhen(updated: number, now: number, locale?: string): string {
  if (!Number.isFinite(updated) || !Number.isFinite(now)) return ''; // never "Invalid Date"
  const d = new Date(updated);
  switch (whenCategory(updated, now)) {
    case 'today': return `Today, ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
    case 'yesterday': return 'Yesterday';
    case 'week': return d.toLocaleDateString(locale, { weekday: 'long' });
    case 'year': return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    case 'older': return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  }
}

/** "1 stroke" / "23 strokes" (a missing or bad count reads as 0). */
export function strokeCount(n: number): string {
  const k = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return k === 1 ? '1 stroke' : `${k} strokes`;
}

export interface RecentView {
  readonly el: HTMLElement;
  update(docs: readonly RecentDoc[], force: boolean): void;
  /** Focus the first row (or Back when the list is empty). */
  focusFirst(): void;
  dispose(): void;
}

export function createRecent(ctx: UICtx, onBack: () => void): RecentView {
  const el = document.createElement('div');
  el.className = 'r-recent';
  const head = document.createElement('div');
  head.className = 'r-subhead';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'r-btn r-back';
  back.setAttribute('aria-label', 'Back to the menu');
  back.appendChild(icon('back', 20));
  back.addEventListener('click', onBack);
  const title = document.createElement('h2');
  title.className = 'r-subtitle';
  title.textContent = 'Recent';
  head.append(back, title);
  const list = document.createElement('ul');
  list.className = 'r-rows r-scroll';
  list.setAttribute('aria-label', 'Recent drawings');
  const empty = document.createElement('p');
  empty.className = 'r-empty';
  empty.textContent = 'Drawings you start or open will wait here.';
  el.append(head, list, empty);

  let docs: readonly RecentDoc[] = [];

  /** The open button of the row for `id`, if listed. */
  const rowOpen = (id: string): HTMLElement | null =>
    list.querySelector<HTMLElement>(`.r-row[data-id="${CSS.escape(id)}"] .r-row-open`);

  const row =(d: RecentDoc, now: number): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'r-row';
    li.dataset.id = d.id;
    const name = d.title.trim() || 'Untitled';
    const when = formatWhen(d.updated, now);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'r-row-open';
    const facts = when ? [when, strokeCount(d.strokes)] : [strokeCount(d.strokes)];
    open.setAttribute('aria-label', `Open ${name}, ${facts.join(', ')}`);
    const well = document.createElement('span');
    well.className = 'r-rthumb';
    if (d.thumb) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = d.thumb;
      well.appendChild(img);
    }
    const text = document.createElement('span');
    text.className = 'r-row-text';
    const t = document.createElement('span');
    t.className = 'r-row-title';
    t.textContent = name;
    const meta = document.createElement('span');
    meta.className = 'r-row-meta';
    meta.textContent = facts.join(' · ');
    text.append(t, meta);
    open.append(well, text);
    open.addEventListener('click', () => {
      ctx.dispatch({ k: 'openRecent', id: d.id });
      ctx.dispatch({ k: 'openSheet', sheet: null });
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'r-btn r-row-del';
    del.setAttribute('aria-label', `Delete ${name}`);
    del.appendChild(icon('trash', 18));

    const confirm = document.createElement('div');
    confirm.className = 'r-confirm';
    confirm.hidden = true;
    const q = document.createElement('span');
    q.className = 'r-confirm-q';
    q.textContent = `Delete “${name}”?`;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'r-textbtn is-danger';
    yes.textContent = 'Delete';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'r-textbtn';
    keep.textContent = 'Keep';
    confirm.append(q, yes, keep);

    const setConfirm = (on: boolean): void => {
      li.classList.toggle('is-confirm', on);
      confirm.hidden = !on;
      open.hidden = on;
      del.hidden = on;
      (on ? keep : del).focus({ preventScroll: true });
    };
    del.addEventListener('click', () => setConfirm(true));
    keep.addEventListener('click', () => setConfirm(false));
    yes.addEventListener('click', () => {
      // Focus moves to the neighbouring row by id: a synchronous store rebuilds the list inside
      // dispatch, so element references taken before it may already be detached.
      const sib = (li.nextElementSibling ?? li.previousElementSibling) as HTMLElement | null;
      const nextId = sib?.dataset.id;
      ctx.dispatch({ k: 'deleteRecent', id: d.id });
      ctx.announcer.say(`${name} deleted`);
      ((nextId !== undefined ? rowOpen(nextId) : null) ?? back).focus({ preventScroll: true });
    });
    confirm.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setConfirm(false); } });

    li.append(open, del, confirm);
    return li;
  };

  return {
    el,
    update(next, force) {
      if (!force && next === docs) return;
      docs = next;
      const now = Date.now();
      const active = document.activeElement;
      const activeId = active && list.contains(active) ? (active.closest('.r-row') as HTMLElement | null)?.dataset.id : undefined;
      list.replaceChildren(...docs.slice(0, RECENT_MAX).map(d => row(d, now)));
      empty.hidden = docs.length > 0;
      // Keep focus on the same document; if it went away, on the first row (never on <body>).
      if (activeId) (rowOpen(activeId) ?? list.querySelector<HTMLElement>('.r-row-open') ?? back).focus({ preventScroll: true });
    },
    focusFirst() {
      (list.querySelector<HTMLElement>('.r-row-open') ?? back).focus({ preventScroll: true });
    },
    dispose() { el.remove(); },
  };
}

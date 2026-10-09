import type { DocMeta, StrokeRecipe } from '../core/types';
import { parseDoc, serializeDoc } from '../doc/serialize';
import { VERSION } from '../app/version';

export const ACCOUNT_ORIGIN = 'https://syberlabs.io';
export const SIGN_IN_URL = `${ACCOUNT_ORIGIN}/auth/signin?next=${encodeURIComponent('/admin/return?app=sketch')}`;
export interface Account { id: string; label: string }
export interface SavedDrawing { id: string; app: 'sketch'; name: string; createdAt: number; bytes: number }
export interface DrawingPayload { schema: 'sketch.account-document.v1'; document: unknown }
export class AccountError extends Error { constructor(message: string, public readonly status = 0) { super(message); } }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export async function accountRequest(path: string, body?: unknown, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetcher(`${ACCOUNT_ORIGIN}/admin/api/v1/${path}`, {
    credentials: 'include', cache: 'no-store', ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SyberLabs-Account': 'v1' }, body: JSON.stringify(body),
    }),
  }); } catch { throw new AccountError('Account storage is unreachable. Your browser drawing is unchanged.'); }
  if (!response.ok) {
    const errors: Record<number, string> = {
      401: 'Sign in again to use your account.', 403: 'Account access is unavailable from this address.',
      404: 'This backup is unavailable.', 409: 'Your account may be full. Download your drawing or visit Saved things in the portal.',
      413: 'This drawing is too large for an account backup (1 MB maximum). Download it instead.',
    };
    throw new AccountError(errors[response.status] || 'Account storage is unavailable. Your browser drawing is unchanged.', response.status);
  }
  let data: unknown;
  try { data = await response.json(); } catch { throw new AccountError('Account returned unreadable data. Your browser drawing is unchanged.'); }
  if (!record(data) || data.version !== 1) throw new AccountError('Account returned unsupported data. Your browser drawing is unchanged.');
  return data;
}
export async function getAccount(fetcher?: typeof fetch): Promise<Account> {
  const { user } = await accountRequest('account', undefined, fetcher);
  if (!record(user) || typeof user.id !== 'string' || typeof user.label !== 'string') throw new AccountError('Account returned an invalid profile.');
  return { id: user.id, label: user.label };
}
export async function listDrawings(fetcher?: typeof fetch): Promise<SavedDrawing[]> {
  const { saves } = await accountRequest('saves?app=sketch', undefined, fetcher);
  if (!Array.isArray(saves) || saves.some(s => !record(s) || s.app !== 'sketch' || typeof s.id !== 'string' || typeof s.name !== 'string' || !Number.isFinite(s.createdAt) || !Number.isFinite(s.bytes))) throw new AccountError('Account returned an invalid backup list.');
  return saves as SavedDrawing[];
}
/** The existing .rise serializer exports drawing content only, never browser credentials or settings. */
export function drawingPayload(meta: DocMeta, strokes: readonly StrokeRecipe[]): DrawingPayload {
  return { schema: 'sketch.account-document.v1', document: JSON.parse(serializeDoc(meta, strokes, VERSION)) };
}
export function parseDrawingPayload(payload: unknown): ReturnType<typeof parseDoc> {
  if (!record(payload) || payload.schema !== 'sketch.account-document.v1' || !record(payload.document)) throw new AccountError('This backup is not a RISE Sketch drawing.');
  try { return parseDoc(JSON.stringify(payload.document)); }
  catch { throw new AccountError('This drawing failed validation. Your browser drawing is unchanged.'); }
}
export function saveDrawing(name: string, payload: DrawingPayload, requestId: string, fetcher?: typeof fetch) {
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 1024 * 1024) throw new AccountError('This drawing is too large for an account backup. Download it instead.', 413);
  return accountRequest('saves', { app: 'sketch', name, payload, requestId }, fetcher);
}
export async function loadDrawing(id: string, fetcher?: typeof fetch) {
  const { save } = await accountRequest(`saves/${encodeURIComponent(id)}`, undefined, fetcher);
  if (!record(save) || save.app !== 'sketch' || save.id !== id) throw new AccountError('This backup is not the requested Sketch drawing.');
  return parseDrawingPayload(save.payload);
}

import { AccountError, loadDrawing } from './service';
import type { parseDoc } from '../doc/serialize';
export interface RestoreBoundary {
  isCurrent(): boolean;
  flush(): Promise<void>;
  autosaveOk(): boolean;
  backup(): void;
  adopt(drawing: ReturnType<typeof parseDoc>): void | Promise<void>;
}
/** Remote data and local persistence can both finish after the panel's identity has changed. */
export async function restoreAccountDrawing(id: string, owner: string, boundary: RestoreBoundary, fetcher?: typeof fetch): Promise<ReturnType<typeof parseDoc>> {
  const current = () => {
    if (!boundary.isCurrent()) throw new AccountError('Your account changed. Reopen the account panel before restoring. Your browser drawing is unchanged.', 409);
  };
  current();
  const parsed = await loadDrawing(id, owner, fetcher);
  current();
  await boundary.flush();
  current();
  if (!boundary.autosaveOk()) throw new AccountError('Browser autosave is unavailable. Download your drawing before restoring.');
  boundary.backup();
  current();
  await boundary.adopt(parsed);
  return parsed;
}

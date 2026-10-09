import { describe, expect, it, vi } from 'vitest';
import { newMeta } from '../src/doc/document';
import { drawingPayload } from '../src/account/service';
import { restoreAccountDrawing } from '../src/account/restore';
const drawing = drawingPayload(newMeta(1234, 42, 'fixture'), []);
const response = () => Response.json({ version: 1, save: { id: 'saved', app: 'sketch', payload: drawing } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
for (const [from, to] of [['owner-a', 'owner-b'], ['owner-b', 'owner-a']]) {
  describe(`stale restore ${from} to ${to}`, () => {
    it('refuses a valid delayed detail before touching local autosave or canvas', async () => {
      const detail = deferred<Response>(); let identity = from, generation = 1;
      const captured = generation;
      const boundary = { isCurrent: () => identity === from && generation === captured, flush: vi.fn(async () => {}), autosaveOk: () => true, backup: vi.fn(), adopt: vi.fn() };
      const request = restoreAccountDrawing('saved', from, boundary, vi.fn<typeof fetch>().mockReturnValue(detail.promise));
      const denied = expect(request).rejects.toThrow('account changed');
      identity = to; generation++; detail.resolve(response());
      await denied;
      expect(boundary.flush).not.toHaveBeenCalled(); expect(boundary.backup).not.toHaveBeenCalled(); expect(boundary.adopt).not.toHaveBeenCalled();
    });
    it('refuses adoption after a delayed local flush and remains stale if the original account returns', async () => {
      const flushing = deferred<void>(), entered = deferred<void>(); let identity = from, generation = 1;
      const captured = generation;
      const boundary = { isCurrent: () => identity === from && generation === captured, flush: vi.fn(() => { entered.resolve(); return flushing.promise; }), autosaveOk: () => true, backup: vi.fn(), adopt: vi.fn() };
      const request = restoreAccountDrawing('saved', from, boundary, vi.fn<typeof fetch>().mockImplementation(async () => response()));
      const denied = expect(request).rejects.toThrow('account changed');
      await entered.promise;
      identity = to; generation++;
      identity = from; generation++; // A→B→A does not revive the old operation.
      flushing.resolve(); await denied;
      expect(boundary.backup).not.toHaveBeenCalled(); expect(boundary.adopt).not.toHaveBeenCalled();
    });
  });
}

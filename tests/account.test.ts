import { describe, expect, it, vi } from 'vitest';
import { newMeta } from '../src/doc/document';
import { drawingPayload, parseDrawingPayload, getAccount, listDrawings, saveDrawing, loadDrawing, SIGN_IN_URL } from '../src/account/service';
const mock = (data: unknown, status = 200) => vi.fn<typeof fetch>().mockImplementation(async () => Response.json(data, { status }));
const meta = () => newMeta(1234, 42, 'local-test-doc');

describe('Sketch private account protocol', () => {
  it('uses host cookies, no bearer token and the canonical internal return', async () => {
    const fetcher = mock({ version: 1, user: { id: 'one', label: '<script>reader</script>' } });
    expect(await getAccount(fetcher)).toEqual({ id: 'one', label: '<script>reader</script>' });
    expect(fetcher).toHaveBeenCalledWith('https://syberlabs.io/admin/api/v1/account', { credentials: 'include', cache: 'no-store' });
    expect(new URL(SIGN_IN_URL).searchParams.get('next')).toBe('/admin/return?app=sketch');
  });
  it('uploads only serialized art on explicit save, with mutation header and caller retry id', async () => {
    const fetcher = mock({ version: 1, save: { id: 'saved' } });
    const payload = drawingPayload(meta(), []);
    await saveDrawing('Private art', payload, 'same-retry-id', fetcher);
    await saveDrawing('Private art', payload, 'same-retry-id', fetcher);
    const [, options] = fetcher.mock.calls[0];
    expect(options?.headers).toEqual({ 'Content-Type': 'application/json', 'X-SyberLabs-Account': 'v1' });
    expect(options?.credentials).toBe('include');
    expect(options?.body).toBe(fetcher.mock.calls[1][1]?.body);
    const body = JSON.parse(String(options?.body));
    expect(body.app).toBe('sketch'); expect(body.requestId).toBe('same-retry-id');
    expect(body.payload.schema).toBe('sketch.account-document.v1');
    expect(Object.keys(body.payload)).toEqual(['schema', 'document']);
    expect(parseDrawingPayload(body.payload).meta.title).toBe(meta().title);
  });
  it('bounds uploaded payload bytes before making a network request', () => {
    const fetcher = mock({ version: 1 });
    expect(() => saveDrawing('Huge', { schema: 'sketch.account-document.v1', document: { text: '🔥'.repeat(300000) } }, 'id', fetcher)).toThrow('too large');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates version, profile, backup metadata and unavailable account responses', async () => {
    await expect(getAccount(mock({ version: 2, user: {} }))).rejects.toThrow('unsupported');
    await expect(getAccount(mock({ version: 1, user: { id: [] } }))).rejects.toThrow('invalid profile');
    await expect(getAccount(mock({}, 401))).rejects.toMatchObject({ status: 401 });
    await expect(listDrawings(mock({ version: 1, saves: [null] }))).rejects.toThrow('invalid backup');
    await expect(listDrawings(mock({ version: 1, saves: [{ id: 'a', app: 'omni', name: 'foreign', createdAt: 1, bytes: 1 }] }))).rejects.toThrow('invalid backup');
    await expect(getAccount(vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')))).rejects.toThrow('browser drawing is unchanged');
  });
  it('parses downloaded art before restore; refuses foreign/malformed snapshots and mismatched ids', async () => {
    const payload = drawingPayload(meta(), []);
    const loaded = await loadDrawing('saved', mock({ version: 1, save: { id: 'saved', app: 'sketch', payload } }));
    expect(loaded.meta.title).toBe(meta().title);
    for (const save of [{ id: 'saved', app: 'rise', payload }, { id: 'foreign', app: 'sketch', payload }, { id: 'saved', app: 'sketch', payload: { ...payload, document: {} } }]) {
      await expect(loadDrawing('saved', mock({ version: 1, save }))).rejects.toThrow();
    }
    for (const bad of [null, { schema: 'foreign' }, { ...payload, document: { format: 'rise', strokes: ['bad'] } }]) expect(() => parseDrawingPayload(bad)).toThrow();
    await expect(loadDrawing('other-owner-id', mock({}, 404))).rejects.toMatchObject({ status: 404 });
  });
});

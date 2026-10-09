/** app/counters.ts and worker/index.ts: privacy-first usage counters (DESIGN §8 Privacy, §13 #17). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { count, EVENTS } from '../src/app/counters';
import worker, { PER_MINUTE, type D1 } from '../worker/index';

describe('client', () => {
  let beacons: [string, unknown][];
  const nav = (patch: object = {}) => vi.stubGlobal('navigator', {
    onLine: true, doNotTrack: null, sendBeacon: (u: string, b: unknown) => { beacons.push([u, b]); return true; }, ...patch,
  });
  beforeEach(() => { beacons = []; nav(); vi.stubGlobal('location', { protocol: 'https:' }); });
  afterEach(() => vi.unstubAllGlobals());

  it('sends only the event name to /e', () => {
    count('visit');
    expect(beacons).toEqual([['/e', 'visit']]);
  });
  it('once: at most once per page load', () => {
    count('stroke_first', true); count('stroke_first', true);
    expect(beacons).toEqual([['/e', 'stroke_first']]);
  });
  it('sends nothing under Do Not Track or Global Privacy Control', () => {
    nav({ doNotTrack: '1' }); count('visit');
    nav({ globalPrivacyControl: true }); count('visit');
    expect(beacons).toEqual([]);
  });
  it('sends nothing offline or from the single file', () => {
    nav({ onLine: false }); count('visit');
    nav(); vi.stubGlobal('location', { protocol: 'file:' }); count('visit');
    expect(beacons).toEqual([]);
  });
  it('never throws', () => {
    nav({ sendBeacon: () => { throw new TypeError('boom'); } });
    expect(() => count('visit')).not.toThrow();
    vi.stubGlobal('navigator', undefined);
    expect(() => count('remix_copied')).not.toThrow();
  });
  it('allow-lists the named events and one per Form', () => {
    for (const e of ['visit', 'visit_remix', 'stroke_first', 'timelapse_done', 'timelapse_shared', 'timelapse_saved', 'remix_copied', 'remix_too_big', 'install', 'symmetry_on', 'form_sprout', 'form_ripple']) expect(EVENTS.has(e)).toBe(true);
    for (const e of [...EVENTS]) expect(e).toMatch(/^[a-z_]{1,32}$/);
  });
});

describe('worker', () => {
  const db = () => {
    const runs: unknown[][] = [];
    const d: D1 & { runs: unknown[][] } = {
      runs,
      prepare: sql => ({ bind: (...v: unknown[]) => [sql, ...v] }),
      batch: async s => { runs.push(s); return []; },
    };
    return d;
  };
  const post = (body: string, init: RequestInit = {}) => new Request('https://sketch.syberlabs.io/e', { method: 'POST', body, ...init });
  const run = async (req: Request, DB?: D1) => {
    const waits: Promise<unknown>[] = [];
    const res = await worker.fetch(req, { DB }, { waitUntil: p => { waits.push(p); } });
    await Promise.all(waits);
    return res.status;
  };

  it('counts an allow-listed event for today', async () => {
    const d = db();
    expect(await run(post('visit'), d)).toBe(204);
    const [create, bump] = d.runs[0] as [unknown[], unknown[]];
    expect(String(create[0])).toMatch(/CREATE TABLE IF NOT EXISTS counts/);
    expect(bump).toEqual([expect.stringMatching(/ON CONFLICT \(day, event\) DO UPDATE SET n = n \+ 1/), new Date().toISOString().slice(0, 10), 'visit']);
  });
  it('refuses anything else, storing nothing', async () => {
    const d = db();
    expect(await run(post('evil'), d)).toBe(400);
    expect(await run(post('visit#r=abc'), d)).toBe(400);
    expect(await run(post('x'.repeat(33)), d)).toBe(400);
    const big = { url: 'https://sketch.syberlabs.io/e', method: 'POST', headers: new Headers({ 'content-length': '100000' }), text: () => { throw new Error('read'); } };
    expect(await run(big as unknown as Request, d)).toBe(413);
    expect(await run(new Request('https://sketch.syberlabs.io/e'), d)).toBe(405);
    expect(await run(new Request('https://sketch.syberlabs.io/x', { method: 'POST', body: 'visit' }), d)).toBe(404);
    expect(d.runs).toEqual([]);
  });
  it('without a database (previews) accepts and stores nothing', async () => {
    expect(await run(post('visit'))).toBe(204);
  });
  it('a failed write is answered 204 all the same', async () => {
    const d = db();
    d.batch = async () => { throw new Error('D1 down'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(post('visit'), d)).toBe(204);
    err.mockRestore();
  });
  it('caps writes per isolate per minute', async () => {
    const d = db();
    for (let i = 0; i < PER_MINUTE + 5; i++) await run(post('visit'), d);
    expect(d.runs.length).toBeLessThanOrEqual(PER_MINUTE);
  });
});

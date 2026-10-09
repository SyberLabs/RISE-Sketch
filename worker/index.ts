/**
 * The app's only server code (DESIGN §8 Privacy, §13 #17). Static assets are served without it;
 * `assets.run_worker_first` in wrangler.jsonc sends just `/e` here.
 *
 * POST /e with an allow-listed event name as the whole body adds one to `counts(day, event)` in D1.
 * It reads nothing else from the request: no IP, no header but the body's length, no URL beyond
 * the path. The table is created on first use, so a deploy needs no migration step. Without a
 * database binding (Worker Previews have none) it accepts and stores nothing.
 */
import { EVENTS } from '../src/app/counters';

/** The slice of the D1 API used here. */
export interface D1 {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
}
export interface Env { DB?: D1 }
interface Ctx { waitUntil(p: Promise<unknown>): void }

const CREATE = 'CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, event TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, event))';
const BUMP = 'INSERT INTO counts (day, event, n) VALUES (?1, ?2, 1) ON CONFLICT (day, event) DO UPDATE SET n = n + 1';
/** Writes per minute one isolate accepts; past it, requests are answered and dropped. */
export const PER_MINUTE = 600;

let minute = 0, writes = 0;

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    if (new URL(req.url).pathname !== '/e') return new Response(null, { status: 404 });
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    // every event name is under 32 bytes: refuse a declared bigger body before reading it
    if (Number(req.headers.get('content-length')) > 32) return new Response(null, { status: 413 });
    const event = await req.text();
    if (!EVENTS.has(event)) return new Response(null, { status: 400 });
    const now = Date.now(), m = Math.floor(now / 60000);
    if (m !== minute) { minute = m; writes = 0; }
    if (env.DB && ++writes <= PER_MINUTE) {
      const day = new Date(now).toISOString().slice(0, 10);
      ctx.waitUntil(env.DB.batch([env.DB.prepare(CREATE).bind(), env.DB.prepare(BUMP).bind(day, event)])
        .catch(err => console.error('count not stored', err)));
    }
    return new Response(null, { status: 204 });
  },
};

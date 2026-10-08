// Offline shell for sketch.syberlabs.io (registered from src/main.ts on http(s) only).
// Page loads go to the network first, so a deploy shows up on the next load; offline, the last
// good shell answers. A shell is "good" once index.html and every asset it names are cached
// together: a new index.html replaces the old one only after all its assets are in, then
// everything it no longer names is dropped. Hashed assets are then served from the cache.
const CACHE = 'rise-shell';
const INDEX = new URL('./', self.location).href;

const isPage = res => res.ok && (res.headers.get('content-type') ?? '').startsWith('text/html');

async function keepShell(res) {
  const html = await res.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map(m => new URL(m[1], INDEX).href);
  // Not cache.addAll: the SPA fallback answers a missing asset with index.html and a 200.
  const got = await Promise.all(assets.map(url => fetch(url)));
  if (got.some(r => !r.ok || isPage(r))) throw new Error('incomplete build');
  const cache = await caches.open(CACHE);
  await Promise.all(got.map((r, i) => cache.put(assets[i], r)));
  await cache.put(INDEX, res);
  const keep = new Set([INDEX, ...assets]);
  for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
}

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(fetch(INDEX, { cache: 'no-cache' }).then(res => isPage(res) && keepShell(res)));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (isPage(res)) e.waitUntil(keepShell(res.clone()).catch(() => { /* keep the last good shell */ }));
      return res;
    }, async () => (await caches.match(INDEX)) ?? Response.error()));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit ?? fetch(req)));
});

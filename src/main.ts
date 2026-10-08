/**
 * Composition root (DESIGN §7.1): boot the app inside #stage / #chrome, and in `?debug` builds
 * expose window.__rise for the e2e suite. No logic lives here.
 *
 * The debug hooks exist only when __DEBUG__ is set at build time (dev, vitest, `--mode debug`);
 * the production bundle has no window.__rise, and `?debug` is ignored there.
 *
 * Production builds served over http(s) link the web manifest and register the offline shell
 * (public/sw.js). Not in index.html: a file:// single file has neither, and Chrome logs a CORS
 * error for a manifest link there.
 */
import { boot } from './app/boot';
import { installDebug } from './app/debug';

const stage = document.getElementById('stage') as HTMLElement;
const chrome = document.getElementById('chrome') as HTMLElement;

boot({ stage, chrome }).then(
  app => { if (__DEBUG__ && new URLSearchParams(location.search).has('debug')) installDebug(app); },
  err => console.error('[rise] boot failed', err),
);

if (!__DEBUG__ && /^https?:$/.test(location.protocol)) {
  document.head.append(Object.assign(document.createElement('link'), { rel: 'manifest', href: './manifest.webmanifest' }));
  navigator.serviceWorker?.register('./sw.js').catch(err => console.warn('[rise] offline shell not installed', err));
}

/**
 * Composition root (DESIGN §7.1): boot the app inside #stage / #chrome, and in `?debug` builds
 * expose window.__rise for the e2e suite. No logic lives here.
 */
import { boot } from './app/boot';
import { installDebug } from './app/debug';

const stage = document.getElementById('stage') as HTMLElement;
const chrome = document.getElementById('chrome') as HTMLElement;
const debug = new URLSearchParams(location.search).has('debug');

boot({ stage, chrome }).then(
  app => { if (debug) installDebug(app); },
  err => console.error('[rise] boot failed', err),
);

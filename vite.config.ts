import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { shrink } from './scripts/shrink.ts';

// Modes:
//  - `vite build --mode single` emits one self-contained HTML file (dist-single/index.html) that
//    opens by double-click, like the original procedural-ink.html demo. This is what users get.
//  - `vite build --mode debug` emits the same single file with the `?debug` test plumbing
//    (window.__rise, perf counters) compiled in, to dist-debug/index.html. scripts/e2e.mjs builds
//    and drives this one. Dev (`vite`) and vitest also have __DEBUG__ on.
// `__DEBUG__` is a build-time constant, so the production bundles carry none of that code.
// Every build also runs scripts/shrink.ts (type-aware const-enum inlining and private-member
// renaming; see there). Bundle budget: DESIGN §9.
export default defineConfig(({ mode }) => {
  const single = mode === 'single' || mode === 'debug';
  const debug = mode !== 'single' && mode !== 'production';
  return {
    base: './',
    plugins: [shrink(), single ? viteSingleFile() : null],
    define: { __DEBUG__: JSON.stringify(debug) },
    build: {
      target: 'es2022',
      outDir: mode === 'debug' ? 'dist-debug' : single ? 'dist-single' : 'dist',
      emptyOutDir: true,
      // One module and no preload links: the modulepreload polyfill would be dead weight.
      modulePreload: { polyfill: false },
      // shrink's one-off type-check dominates build time by design; skip rolldown's timing report.
      rolldownOptions: { checks: { bundlerTimings: false } },
    },
    server: { port: 5173, strictPort: false },
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
    },
  };
});

/**
 * Build-time flag (vite.config.ts `define`): true in dev, vitest and the `--mode debug` e2e build;
 * false in the production builds (`build`, `build:single`), where every `if (__DEBUG__)` branch
 * and the code only it reaches is removed by the minifier.
 */
declare const __DEBUG__: boolean;

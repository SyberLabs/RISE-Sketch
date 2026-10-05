// Dev server for the render-world sandbox. HMR and watching are off so edits other engineers make
// to shared modules never reload the page mid-run. src/render/live.ts and overlay.ts resolve to
// the sandbox stand-ins only while the real files do not exist (or RW_STANDIN=1 forces them).
//   npx vite --config sandbox/render-world/vite.config.mjs --port 5183 --strictPort
import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const force = process.env.RW_STANDIN === '1';

export default defineConfig({
  root,
  server: { hmr: false, watch: { ignored: ['**/*'] } },
  plugins: [{
    name: 'render-world-standins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || (source !== './live' && source !== './overlay')) return null;
      if (!/[\\/]src[\\/]render[\\/]renderer\.ts/.test(importer)) return null;
      const real = resolve(dirname(importer), source + '.ts');
      if (!force && existsSync(real)) return null;
      return resolve(here, 'standins', source.slice(2) + '.ts');
    },
  }],
});

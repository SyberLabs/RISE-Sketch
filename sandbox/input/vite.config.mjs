// Dev server for the input sandbox with HMR off, so edits other engineers make to
// shared modules never reload the page in the middle of a driven run.
//   npx vite --config sandbox/input/vite.config.mjs --port 5185 --strictPort
import { defineConfig } from 'vite';

export default defineConfig({
  server: { hmr: false, watch: { ignored: ['**/*'] } },
});

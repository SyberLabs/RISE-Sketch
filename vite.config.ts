import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build --mode single` emits one self-contained HTML file (dist-single/index.html)
// that opens by double-click, like the original procedural-ink.html demo.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: {
    target: 'es2022',
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: false },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));

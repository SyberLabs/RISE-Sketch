import { defineConfig } from 'vitest/config';

// Forms-lab tests, run from the repo root:
//   npx vitest run --config lab/vitest.config.ts [lab/forms/<name>]
export default defineConfig({
  test: {
    include: ['lab/**/*.test.ts'],
    environment: 'node',
  },
});

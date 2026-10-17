import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/test_*.ts'],
    // A scratch HOME/XDG/CURATED_BRAIN_DIR for every test file (and every
    // child it spawns): no test can reach the real home or brain.
    setupFiles: ['tests/setup-home.ts'],
    exclude: ['node_modules', 'lib'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/test_*.ts'],
    exclude: ['node_modules', 'lib'],
  },
});

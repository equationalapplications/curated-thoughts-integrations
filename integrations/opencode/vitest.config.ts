import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/test_*.ts'],
    // tests/host/** is the Bun-only OpenCode host contract (`bun test
    // tests/host/contract.test.ts`, checks.host); it imports bun:test and
    // spawns a real OpenCode binary, so vitest must never collect it.
    exclude: ['node_modules', 'lib', 'tests/host/**'],
    // Until the first unit tests land (Task 2+), an empty run is a pass.
    passWithNoTests: true,
  },
});

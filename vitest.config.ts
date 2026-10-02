import { defineConfig } from 'vitest/config';

// Unit and provider tests. They need neither Docker nor network access.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/provider/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/codelists/generated.ts'],
      reporter: ['text-summary', 'lcov'],
      // A little below the figures measured when they were set (98.4 % lines, 96.9 %
      // statements, 97.3 % functions, 93.2 % branches), so coverage cannot fall unnoticed.
      thresholds: { lines: 97, statements: 95, functions: 96, branches: 91 },
    },
  },
});

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
      // A little below the measured figures (97 % lines, 91 % branches), so coverage
      // cannot fall unnoticed.
      thresholds: { lines: 95, statements: 93, functions: 94, branches: 89 },
    },
  },
});

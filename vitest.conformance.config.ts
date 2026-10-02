import { defineConfig } from 'vitest/config';

// Conformance tests run the official validation in Docker (npm run validator:build first).
export default defineConfig({
  test: {
    include: ['test/conformance/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});

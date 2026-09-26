// Keeps the usage example in README.md honest. The ```ts block in the README must be
// examples/readme-usage.ts with the published import path, and that file must run and
// print what the README comments say.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
});

it('shows the same code as examples/readme-usage.ts', () => {
  const readme = readFileSync(`${root}README.md`, 'utf8');
  const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  expect(blocks).toHaveLength(1);
  const example = readFileSync(`${root}examples/readme-usage.ts`, 'utf8').replace("from '../src/index.js'", "from 'einvoice-ae'");
  expect(blocks[0]).toBe(example);
});

it('runs the README usage example', async () => {
  const printed: unknown[] = [];
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => void printed.push(value));
  await import('../../examples/readme-usage.js');
  expect(printed[0]).toBe(9250);
  expect(printed[1]).toMatch(/^[0-9a-f]{64}$/);
});

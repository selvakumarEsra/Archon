import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest base config for all workspace packages.
 *
 * Per-package configs extend this via `mergeConfig`. The key choices:
 *
 * - `isolate: true` + `pool: 'forks'`: each test file runs in its own worker
 *   process. This is what eliminates the cross-file mock.module() pollution
 *   that forced per-batch test scripts under bun:test (oven-sh/bun#7823).
 * - `globals: false`: every test file imports `describe`/`test`/`expect`
 *   explicitly. Matches the existing style in this repo.
 * - `environment: 'node'`: server-side default. @archon/web overrides to
 *   'happy-dom' for DOM tests.
 */
export const baseConfig = defineConfig({
  test: {
    isolate: true,
    globals: false,
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});

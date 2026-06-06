# Bun → Node Migration: Stage 2 — Vitest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `bun test` with Vitest across 179 test files. Keep Bun as the runtime executing `dev`/`start`/`scripts` — only the test runner changes. Add Node 22 entry to CI test matrix to prove Vitest passes on Node before Stage 3 ships a Node-only artifact.

**Architecture:** Add Vitest and `@vitest/coverage-v8` as workspace devDependencies. Shared `vitest.config.base.ts` at repo root, per-package `vitest.config.ts` extending it. Codemod all `'bun:test'` imports to `'vitest'`. Mechanically translate `mock.module()` → `vi.mock()`, `mock()` → `vi.fn()`, `spyOn()` → `vi.spyOn()`. Collapse the 20+5+6+3 per-batch test scripts in `core`/`workflows`/`adapters`/`isolation` to single `vitest run` invocations — Vitest isolates per-file by default. Delete `bunfig.toml`.

**Tech Stack:** Vitest 2.x, `@vitest/coverage-v8`, `happy-dom` for `@archon/web` (DOM tests), tsx still in scope (Stage 4). Bun still runs the CLI/server.

---

## File structure

**Created:**
- `vitest.config.base.ts` (repo root)
- `packages/{paths,git,isolation,providers,workflows,core,adapters,server,cli,web}/vitest.config.ts` — 10 configs (docs-web has no tests)

**Modified:**
- Every `*.test.ts` and `*.test.tsx` under `packages/` — `import ... from 'bun:test'` → `'vitest'`; mock API calls translated.
- Every `packages/*/package.json` `"test"` script — collapse batched `bun test X && bun test Y` invocations to `vitest run`.
- `packages/core/src/test/setup.ts` — `'bun:test'` imports → `'vitest'`.
- `packages/core/src/test/mocks/{database,platform,logger}.ts` — same translation.
- `.github/workflows/test.yml` — add Node 22 matrix entry running `pnpm -r test` on Node alongside the existing Bun job.

**Deleted:**
- `bunfig.toml` (only contains `[test]` config which Vitest replaces).

---

## Task 1: Add Vitest as a workspace devDependency

- [ ] **Step 1: Install Vitest at the root**

Run:
```bash
pnpm add -D -w vitest @vitest/coverage-v8 happy-dom
```

`-w` puts it in root `devDependencies` so all workspace packages can use it.

- [ ] **Step 2: Verify install**

Run:
```bash
pnpm exec vitest --version
```
Expected: a 2.x version string.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build(vitest): add vitest, @vitest/coverage-v8, happy-dom devDeps"
```

---

## Task 2: Add the shared Vitest base config

- [ ] **Step 1: Create `vitest.config.base.ts`**

```ts
import { defineConfig } from 'vitest/config';

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
```

`pool: 'forks'` with `singleFork: false` runs each test file in its own worker process — equivalent to Bun's per-file process isolation. This is what makes the per-package batch splits unnecessary.

- [ ] **Step 2: Commit**

```bash
git add vitest.config.base.ts
git commit -m "build(vitest): shared base config for workspace test isolation"
```

---

## Task 3: Codemod `'bun:test'` imports to `'vitest'`

This is the bulk mechanical work. Vitest's API is near-identical to `bun:test`:

| `bun:test` | Vitest |
|---|---|
| `describe`, `test`, `it`, `expect` | identical names from `'vitest'` |
| `beforeAll`, `afterAll`, `beforeEach`, `afterEach` | identical |
| `mock` (the namespace import) | `vi` |
| `mock(fn)` | `vi.fn(fn)` |
| `mock.module(path, factory)` | `vi.mock(path, factory)` |
| `spyOn(obj, key)` | `vi.spyOn(obj, key)` |
| `type Mock` | `type Mock` from `'vitest'` |

- [ ] **Step 1: Rewrite all `bun:test` imports across `packages/`**

Run on macOS (BSD sed):
```bash
find packages -name "*.test.ts" -o -name "*.test.tsx" | xargs sed -i '' "s|from 'bun:test'|from 'vitest'|g; s|from \"bun:test\"|from \"vitest\"|g"
```

On Linux (GNU sed): drop the `''`:
```bash
find packages -name "*.test.ts" -o -name "*.test.tsx" | xargs sed -i "s|from 'bun:test'|from 'vitest'|g; s|from \"bun:test\"|from \"vitest\"|g"
```

- [ ] **Step 2: Migrate the shared mock helpers** (these are imported by many test files)

`packages/core/src/test/mocks/database.ts`, `platform.ts`, `logger.ts`, and `packages/core/src/test/setup.ts` all import `mock` or `spyOn` from `bun:test`. After the sed pass, the imports point to `vitest`, but the API surface is slightly different:

- Replace `mock` (the namespace) with `vi`. Every call site of `mock.module(...)` becomes `vi.mock(...)` and every `mock(fn)` becomes `vi.fn(fn)`.
- `type Mock` import from `vitest` still works (Vitest exports `Mock`).

Use targeted text edits per file. Read each file first, identify the API surface used, translate.

- [ ] **Step 3: Replace `mock.module()` calls** across all test files

Run:
```bash
find packages -name "*.test.ts" -o -name "*.test.tsx" | xargs grep -l "mock\.module" | while read f; do
  sed -i '' "s|mock\.module(|vi.mock(|g" "$f"
done
```

- [ ] **Step 4: Replace bare `mock(` calls** with `vi.fn(`

This is trickier — `mock(...)` could be a function call OR part of a property access. The safe approach: only replace `mock(` when it appears with a `mock` import from vitest. Run a targeted audit:
```bash
grep -rn '\bmock(' packages/ --include="*.test.ts" --include="*.test.tsx" | grep -v "vi\.mock\|mockReturn\|mockResolved\|mockImplement\|mockRejected\|mockClear" | head -50
```

For each hit: if it's `mock(fn)` creating a mock function, change to `vi.fn(fn)` and add `vi` to the imports (replace `mock` in the import line).

Use the per-file Edit tool for these — they're context-dependent.

- [ ] **Step 5: Replace `spyOn` and `type Mock` imports**

`spyOn` is exported by Vitest under `vi.spyOn`. Either:
- (Preferred) Change import: `import { vi } from 'vitest'`; call sites become `vi.spyOn(...)`.
- (Acceptable) Re-export: `import { vi } from 'vitest'; const spyOn = vi.spyOn;`.

`type Mock` works as-is in Vitest.

Translate per-file using the Edit tool.

- [ ] **Step 6: Audit residual `bun:test` references**

Run:
```bash
grep -rn "bun:test\|from ['\"]bun:test['\"]" packages/ --include="*.ts" --include="*.tsx"
```
Expected: zero hits.

- [ ] **Step 7: Commit**

```bash
git add packages/
git commit -m "build(vitest): migrate bun:test imports and mock API to vitest"
```

---

## Task 4: Add per-package `vitest.config.ts`

Most packages get an identical config that just extends the base. `@archon/web` needs `environment: 'happy-dom'` for React component tests.

- [ ] **Step 1: Generic config** (for `paths`, `git`, `isolation`, `providers`, `workflows`, `core`, `adapters`, `server`, `cli`)

Each `packages/<pkg>/vitest.config.ts`:
```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.config.base';

export default mergeConfig(baseConfig, defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
}));
```

- [ ] **Step 2: `@archon/web` config** (DOM environment + React)

`packages/web/vitest.config.ts`:
```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { baseConfig } from '../../vitest.config.base';

export default mergeConfig(baseConfig, defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
    setupFiles: [],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
}));
```

If `@vitejs/plugin-react` isn't already installed (it's used by Vite for the web dev server), add it:
```bash
pnpm add -D --filter @archon/web @vitejs/plugin-react
```

- [ ] **Step 3: `@archon/core` setup file**

`@archon/core` currently uses `packages/core/src/test/setup.ts` as a Bun preload. Wire it into Vitest:

`packages/core/vitest.config.ts`:
```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.config.base';

export default mergeConfig(baseConfig, defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
}));
```

- [ ] **Step 4: Commit**

```bash
git add packages/*/vitest.config.ts
git commit -m "build(vitest): per-package vitest configs"
```

---

## Task 5: Collapse per-package `test` scripts

The current `test` scripts in `core`/`workflows`/`adapters`/`isolation` are 20/5/6/3 batches of `bun test X && bun test Y && ...`. Under Vitest's per-file isolation, all of that collapses to `vitest run`.

- [ ] **Step 1: Rewrite each package's `test` script to `vitest run`**

Files to edit:
- `packages/paths/package.json`
- `packages/git/package.json`
- `packages/isolation/package.json`
- `packages/providers/package.json`
- `packages/workflows/package.json`
- `packages/core/package.json`
- `packages/adapters/package.json`
- `packages/server/package.json`
- `packages/cli/package.json`
- `packages/web/package.json`

Each `"test": "bun test ..."` (varying batch counts) → `"test": "vitest run"`.

Also rewrite `"test:watch"` in `packages/server/package.json` if present: `bun test --watch` → `vitest`.

Also: change `packages/core/package.json` `"build"` from `"echo 'No build needed - Bun runs TypeScript directly'"` → leave alone (Stage 3 introduces tsup builds).

- [ ] **Step 2: Smoke-test on the smallest package**

Run:
```bash
pnpm --filter @archon/paths test
```
Expected: Vitest runs all `@archon/paths` test files. Should pass.

- [ ] **Step 3: Commit**

```bash
git add packages/*/package.json
git commit -m "build(vitest): collapse per-batch test scripts to vitest run"
```

---

## Task 6: Per-package test runs — fix Vitest-specific failures

Run each package's tests in isolation and fix any that fail due to API differences. Order from smallest to largest dependency footprint.

- [ ] **Step 1: `@archon/paths`**

```bash
pnpm --filter @archon/paths test
```
Fix failures inline. Commit per-package.

- [ ] **Step 2: `@archon/git`**

```bash
pnpm --filter @archon/git test
```

- [ ] **Step 3: `@archon/isolation`**

```bash
pnpm --filter @archon/isolation test
```

- [ ] **Step 4: `@archon/providers`**

```bash
pnpm --filter @archon/providers test
```

- [ ] **Step 5: `@archon/workflows`**

```bash
pnpm --filter @archon/workflows test
```

- [ ] **Step 6: `@archon/core`**

```bash
pnpm --filter @archon/core test
```
Largest package; most likely to surface mock-module conflicts.

- [ ] **Step 7: `@archon/adapters`**

```bash
pnpm --filter @archon/adapters test
```

- [ ] **Step 8: `@archon/server`**

```bash
pnpm --filter @archon/server test
```

- [ ] **Step 9: `@archon/cli`**

```bash
pnpm --filter @archon/cli test
```

- [ ] **Step 10: `@archon/web`**

```bash
pnpm --filter @archon/web test
```

Per-package commit:
```bash
git add packages/<pkg>/
git commit -m "test(vitest): fix <pkg> tests for vitest API"
```

Common fix patterns to expect:
- `vi.mock(...)` is hoisted to the top of the file; if the factory closes over a variable, that variable must be declared with `var`/`let` at module scope (not inside the factory). For `const` declarations consumed inside the factory, prefix with `vi.hoisted(() => ...)`.
- `mock(fn).mockResolvedValue(x)` (Bun) → `vi.fn().mockResolvedValue(x)` (Vitest) — same API.
- Bun's `mock()` returns a `Mock` directly callable; Vitest's `vi.fn()` is too. No translation needed at call sites.

---

## Task 7: Delete `bunfig.toml`

`bunfig.toml` contains only `[test]` settings (root, preload, coverage) — all superseded by Vitest configs.

- [ ] **Step 1: Delete the file**

```bash
git rm bunfig.toml
```

- [ ] **Step 2: Audit for `bunfig.toml` references**

```bash
grep -rn "bunfig\.toml" . --include="*.md" --include="*.yml" --include="*.yaml" --include="*.json" --include="Dockerfile*" 2>/dev/null | grep -v node_modules | grep -v "^./docs/"
```
Expected: zero non-docs hits.

- [ ] **Step 3: Commit**

```bash
git commit -m "build(vitest): remove bunfig.toml — vitest configs replace it"
```

---

## Task 8: Add Node 22 matrix entry to CI test workflow

This is the load-bearing change for Stage 3 — it proves Vitest passes on Node 22 before Stage 3 ships a Node-only published artifact.

- [ ] **Step 1: Update `.github/workflows/test.yml`**

Current `test` job runs on `ubuntu-latest`/`windows-latest` with Bun + pnpm. Add a parallel `test-node` job that runs only the test step on Node 22.

Append to `.github/workflows/test.yml` after the existing `test` job:

```yaml
  test-node:
    name: Tests (Node ${{ matrix.node-version }})
    strategy:
      matrix:
        node-version: [22]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9.15.0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run tests
        run: pnpm run test
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci(vitest): add Node 22 test matrix entry"
```

---

## Task 9: Update CLAUDE.md test isolation note

`CLAUDE.md` has a section explaining Bun's `mock.module()` pollution and per-package batch splits. That entire note becomes irrelevant under Vitest's per-file isolation.

- [ ] **Step 1: Remove the test-isolation paragraph from `CLAUDE.md`**

Locate the section under "### Testing" titled "**Test isolation (mock.module pollution):**" and the surrounding paragraph that explains the per-batch splits. Delete it.

Also delete or update the line `**Do NOT run `bun test` from the repo root**` — under Vitest, `pnpm run test` orchestrates per-package vitest invocations and there's no pollution issue.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(vitest): drop bun:test mock-pollution note — Vitest isolates per-file"
```

---

## Task 10: Full verification gate

- [ ] **Step 1: Clean install**

```bash
rm -rf node_modules packages/*/node_modules
pnpm install --frozen-lockfile
```

- [ ] **Step 2: Type-check all packages**

```bash
pnpm -r type-check
```
Expected: clean exit.

- [ ] **Step 3: Run full validate**

```bash
pnpm run validate
```
Expected: all checks pass; `pnpm run test` invokes Vitest in every package.

- [ ] **Step 4: Push branch and open PR**

```bash
git push -u origin feat/bun-to-node-stage-2-vitest
gh pr create --base feat/bun-to-node-stage-1-pnpm --title "build(vitest): Stage 2 of Bun → Node migration — migrate tests to Vitest" --body "..."
```

PR base is **Stage 1's branch** (stacked PR pattern). After Stage 1 merges into dev, GitHub will auto-update Stage 2's base to dev.

---

## Self-review notes

- Vitest auto-hoists `vi.mock()` calls — this is different from Bun's `mock.module()`. Tests that mock-then-import patterns rely on may need to use `vi.hoisted()` for module-scoped variables referenced in the factory.
- Vitest's per-file isolation eliminates the cross-file mock pollution that forced the batch splits. If any test currently relies on shared module-mocks across files (unintentional), it breaks here — flag and refactor case-by-case.
- The `bun test --watch` command in `packages/server` becomes `vitest` (Vitest's default mode is watch).
- Snapshot tests, if any, may need `--update` on first run with Vitest because the snapshot file format is identical but the comparison path may differ.
- The `coverage` directory generated by Bun's preset is replaced by Vitest's V8 coverage in the same path.

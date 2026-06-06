# Bun → Node Migration Design

**Date:** 2026-06-06
**Status:** Approved (design)
**Driver:** Hosting/deployment constraint — Archon must be installable from npm (`npx archon` / `npm i -g archon`), not as a curl-installed compiled binary.
**Approach:** Staged dual-runtime migration in four shippable PRs.

---

## 1. End-state architecture

After all four stages land, Bun is removed entirely from the repo. Contributors install Node and pnpm only.

| Concern | Today (Bun) | After migration (Node) |
|---|---|---|
| Runtime | Bun ≥1.3.0 | Node ≥22 LTS |
| Package manager | `bun` + `bun.lock` | `pnpm` + `pnpm-lock.yaml` |
| Workspace command | `bun --filter '*' X` | `pnpm -r X` |
| Dev runtime | `bun --watch src/index.ts` | `tsx watch src/index.ts` |
| Test runner | `bun test` (177 files) | `vitest` (same files, migrated imports) |
| Build tool | None — direct TS execution | tsup (esbuild-based, ESM + .d.ts) |
| Distribution | `bun build --compile` → 4 OS binaries via curl | Single `archon` npm package |
| CLI entrypoint | `./src/cli.ts` shebang `#!/usr/bin/env bun` | `./dist/cli.js` shebang `#!/usr/bin/env node` |
| Script-node runtimes | `runtime: bun` \| `runtime: uv` | `runtime: node` \| `runtime: uv` (bun → load-time error) |
| Docker base | `oven/bun:1.3` | `node:22-alpine` |
| CI runner setup | `oven-sh/setup-bun` | `actions/setup-node` + `pnpm/action-setup` |
| `engines` | `bun: ^1.3.0` | `node: >=22` |

**Monorepo layout is unchanged.** The eleven workspace packages keep their boundaries and exports. The only structural addition is each package's `dist/` build output and a top-level `dist-publish/` staging area for the single published `archon` artifact.

**Key tool choices:**
- **tsup** for builds — esbuild-wrapped, monorepo-friendly, produces ESM + `.d.ts` with shebang preservation. De facto standard for publishing TS CLIs (used by t3-stack, drizzle-orm internals).
- **Vitest** for tests — closest API parity to `bun:test`, mature mock system, per-file isolation by default.
- **tsx** for dev TS execution — production-stable, hides TS execution behind a clean process spawn. Preferred over `node --experimental-strip-types` (which strips types only — no `tsconfig.json` paths, no decorators, flagged experimental until Node 26 LTS).
- **pnpm 9** for installs/workspaces — fast, disk-efficient, deterministic.
- **Node 22 LTS** as the minimum supported version.

---

## 2. Stage 1 — pnpm migration

**Goal:** Replace Bun's package manager + workspace runner with pnpm. Bun still executes all code. Smallest possible diff per stage.

**Changes:**
- Delete `bun.lock`, add `pnpm-lock.yaml`. Add `packageManager: "pnpm@9.x"` to root `package.json`.
- Add `pnpm-workspace.yaml`:
  ```yaml
  packages:
    - 'packages/*'
  ```
- Rewrite every script in root + workspace `package.json` files:
  - `bun --filter '*' X` → `pnpm -r X`
  - `bun --filter @archon/server dev` → `pnpm --filter @archon/server dev`
  - `bun x eslint .` → `pnpm exec eslint .`
  - `bun run scripts/foo.ts` — **stays as `bun run` for now**. Stage 1 doesn't touch the runtime; build scripts continue executing via Bun until Stage 4.
- Workspace `"workspace:*"` protocol references — pnpm and Bun both accept it; no change.
- CI: install pnpm via `pnpm/action-setup@v4` before `oven-sh/setup-bun`. Bun stays in CI (still needed for `bun test` and `bun run scripts/*`).
- Root `package.json` `engines` adds `"node": ">=22"` alongside the existing `"bun": "^1.3.0"`. This is the load-bearing change that lets Stage 2 add a Node matrix entry to CI.
- `.husky/pre-commit` and `.lintstagedrc.json`: swap any `bun x` → `pnpm exec`.
- `Dockerfile`: install pnpm via `corepack enable && corepack prepare pnpm@9 --activate` before existing Bun layers. Both runtimes present during transition.

**Why this stage exists in isolation:** every later stage assumes pnpm is the install/orchestration layer. Doing Vitest migration with Bun-as-package-manager still active means rewriting `package.json` scripts twice.

**Verification gate:**
- `pnpm install` clean from scratch produces a working tree
- `pnpm -r type-check` passes
- `pnpm -r test` passes (proxies to `bun test` inside each package)
- `pnpm run validate` passes
- Docker image builds and runs

**Risk:** very low. pnpm and Bun both implement npm install semantics; workspace protocol is identical. Lockfile churn is large but mechanical.

**Rollback:** `git revert` restores `bun.lock` and old scripts. No runtime behavior changed.

---

## 3. Stage 2 — Vitest migration

**Goal:** Move 177 test files from `bun:test` to Vitest. Bun still runs `dev`/`start`/`scripts`; only the test runner changes.

**API translation (mechanical, codemod-able):**

| `bun:test` | Vitest |
|---|---|
| `import { describe, test, expect } from 'bun:test'` | `import { describe, test, expect } from 'vitest'` |
| `import { mock, spyOn } from 'bun:test'` | `import { vi } from 'vitest'` → `vi.fn()`, `vi.spyOn()` |
| `mock.module('./foo', () => ({ ... }))` | `vi.mock('./foo', () => ({ ... }))` |
| `mock(fn)` | `vi.fn(fn)` |
| `beforeAll`, `afterAll`, `beforeEach`, `afterEach` | identical names from `'vitest'` |
| Matchers (`toEqual`, `toBe`, etc.) | identical (Vitest uses Jest-compatible matchers) |

**Test isolation collapses.** Vitest isolates per-file by default — each test file runs in its own worker with a fresh module registry. The current per-package batch splits in `package.json` (20 batches in `@archon/core`, 5 in `@archon/workflows`, 6 in `@archon/adapters`, 3 in `@archon/isolation`) exist only because Bun's `mock.module()` pollutes the process-global module cache (oven-sh/bun#7823). All of that collapses to a single `vitest run` per package.

**Vitest config strategy:**
- One shared `vitest.config.base.ts` at the repo root.
- Per-package `vitest.config.ts` extending the base.
- Base settings: `test.isolate: true` (explicit), `test.globals: false` (force explicit imports — matches current style), `test.setupFiles: ['./src/test/setup.ts']` where one exists, `test.environment: 'node'` for server packages; `'happy-dom'` for `@archon/web`.

**Per-package script change:**
```jsonc
// Before
"test": "bun test src/handlers/command-handler.test.ts && bun test src/handlers/clone.test.ts && ... (20 batches)"
// After
"test": "vitest run"
```

**Migration tactic — package-by-package, not file-by-file:**
1. Pick the smallest package first (`@archon/paths` or `@archon/git`).
2. Add Vitest config + script. Codemod-rewrite all `'bun:test'` imports in that package.
3. Run `pnpm --filter @archon/paths test` — must pass.
4. Repeat per package. Each package is one commit. Stage 2 is ~11 commits in one PR.
5. After all packages, delete `bunfig.toml` (only contains `[test]` config) and the `preload` workflow.

**Mock-module audit:** the per-batch splits exist because conflicting `mock.module()` calls across files cause cross-file pollution under Bun. Under Vitest's per-file isolation, those collisions become benign. But: any test that **relies** on cross-file mock pollution (intentionally or accidentally) breaks. Required: one-time grep for shared module-mocks during migration; flag for case-by-case review.

**Shared mock helpers** (`packages/core/src/test/setup.ts`, `packages/core/src/test/mocks/{database,platform,logger}.ts`) all import from `'bun:test'`. They get migrated first since every test file consumes them.

**Verification gate:**
- `pnpm -r test` passes (now all Vitest)
- `pnpm run validate` passes
- CI matrix runs on Node 22 AND Bun (proves both still work — Bun is still the runtime executing the source)

**Risk:** medium. Vitest API parity is high but not perfect — `mock.module` semantics differ subtly from `vi.mock` (hoisting behavior, factory closures). Expect ~5–10 tests per package to need manual fixes. The batch-collapse simplification is a significant win for test runtime and clarity.

**Rollback:** revert the PR. `bunfig.toml` returns, scripts return, tests run on Bun. Each per-package commit inside the PR is individually revertable.

---

## 4. Stage 3 — Node build + npm publish

Largest stage. After it lands, `npx archon` works. The curl-binary path stays parallel and is retired in Stage 4.

### Build pipeline

Per-package `tsup.config.ts` produces `dist/index.js` (ESM only — Node 22 has stable ESM; no dual-format needed since nothing is externally consumed during transition):
```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'], // varies per package
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
});
```

Per-package script additions:
```jsonc
"scripts": {
  "build": "tsup",
  "dev": "tsx watch src/index.ts" // server/cli only
}
```

`main` and `exports` still point at `./src/*.ts` during Stage 3. Internal workspace consumers go through tsx in dev and tsup-built dist in the published bundle.

### Single published `archon` package

The published artifact is **not** any one workspace package — it's a top-level publish target assembled at build time.

New directory: `dist-publish/` (gitignored):
```
dist-publish/
├── package.json          # generated: name, version, bin, files, deps
├── dist/
│   ├── cli.js            # bundled CLI entry (workspace deps inlined)
│   ├── server.js         # bundled server entry
│   └── web/              # web UI static dist (vite build output)
├── .archon/              # bundled defaults (commands, workflows, skills)
└── README.md             # subset of docs for npm page
```

**Bundling strategy:** tsup with `noExternal: [/^@archon\//]` — workspace packages inlined into the published bundle. External npm deps (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`, `hono`, `better-auth`, `pino`, `dotenv`, etc.) stay as runtime deps in the published `package.json` and resolve from the user's `node_modules`.

Reasoning: keeps the bundle small, lets users update SDK deps independently, matches npm package convention.

Generated `dist-publish/package.json`:
```json
{
  "name": "archon",
  "version": "x.y.z",
  "type": "module",
  "bin": { "archon": "./dist/cli.js" },
  "files": ["dist/", ".archon/"],
  "engines": { "node": ">=22" },
  "dependencies": { /* runtime deps copied from internal package.jsons, deduped */ }
}
```

Built by `scripts/build-publish.ts` — runs tsup on the CLI entry with workspace inlining, copies the vite web dist, copies `.archon/` bundled defaults, generates the publish `package.json` by walking workspace deps and merging external deps.

### CLI entry

`packages/cli/src/cli.ts` shebang becomes `#!/usr/bin/env node`. In dev, `pnpm cli` runs via tsx (respects the shebang in-process). In publish, the bundled `dist/cli.js` retains the shebang and is executable.

### Embedded assets — what changes, what doesn't

**Already binary-safe (no change needed):**
- `packages/workflows/src/defaults/bundled-defaults.generated.ts` — embedded at build time, content is string-literal TS, works under Node identically.
- `packages/core/src/db/bundled-schema.generated.ts` — same pattern.
- `packages/paths/src/bundled-build.ts` — same pattern; the binary-build script rewrites it pre-build.

**Needs adjustment:**
- `BUNDLED_IS_BINARY` constant currently distinguishes "compiled Bun binary" from "source build". In Stage 3 it gets reinterpreted as **"running from published npm dist"** vs **"running from source"** — true when launched via the published `archon`, false in dev. Behavior gates that key off this constant (web-dist path resolution, update-check skip, vendor path layout) all still work; they just have a different meaning for "packaged install". Existing tests for these branches stay valid.
- **Web UI dist path resolution.** In a Bun binary, web UI is downloaded on first `archon serve` and cached to `~/.archon/web-dist/<version>/`. For the npm package, web UI is **bundled into the published package itself** (`dist-publish/dist/web/`) — no first-run download. `getWebDistDir()` in `@archon/paths` learns a third branch: "if running from published npm dist, resolve relative to the package's own `dist/web/`". Strict simplification: zero network at first run, faster start, version-locked web.
- `archon serve --download-only` becomes a no-op with a helpful message. Kept for backwards compatibility with any scripts users wrote against it; removed in a later major version.

### Bun API replacements

`Bun.YAML.parse`/`stringify` (3 call sites: `packages/core/src/config/config-loader.ts:166,601`, `packages/workflows/src/loader.ts:72`) → `yaml` npm package (most popular, YAML 1.2 semantics, used by docusaurus / k8s tooling):
```ts
import { parse, stringify } from 'yaml';
```
`yaml` becomes a runtime dep of `@archon/core` and `@archon/workflows`. No behavior change.

`Bun.version` in `packages/paths/src/telemetry.ts:125` → reports `process.versions.node` instead. Telemetry field becomes `nodeVersion`. Old `bunVersion` field dropped (telemetry consumer is internal, no compat concern).

### Release pipeline

`scripts/build-binaries.sh` stays untouched during Stage 3 — parallel binary release continues, retired in Stage 4. New `scripts/build-publish.ts` runs alongside it. CI release job grows two new steps:
```yaml
- run: pnpm run build:publish
- run: cd dist-publish && npm publish --access public
```
Triggered by the existing release-PR-merged event in `.github/workflows/release.yml`. NPM auth via `NPM_TOKEN` secret (provisioning is a one-time human step before the first Stage 3 release).

### Dev experience after Stage 3

- `pnpm dev` → starts server (`tsx watch`) + web (`vite`) — identical UX to today's `bun run dev`.
- `pnpm cli workflow run X` → runs CLI via tsx, no build needed.
- `pnpm build:publish` → produces `dist-publish/` locally for inspection.
- `node dist-publish/dist/cli.js workflow list` → smoke-test the published-shape build locally.

### Verification gate

- `pnpm build:publish` produces a `dist-publish/` that runs end-to-end (`node dist-publish/dist/cli.js doctor` passes)
- Smoke test: `npm pack dist-publish/` → `npm i -g ./archon-x.y.z.tgz` → `archon workflow list` works in a fresh shell
- Web UI loads from bundled dist (no network at `archon serve` start)
- Both Bun-binary path (`dist/binaries/archon-*`) and Node-npm path build green from one `pnpm validate`
- Docker image with Node 22 base runs the published-package path

### Risk

**High.** This stage integrates everything: workspace bundling correctness, shebang/exec permissions on different OSes (especially Windows), web-dist resolution across three contexts (dev, binary, npm), and the new release pipeline. Expect at least one externalization mistake (a dep tsup tries to inline that should stay external, or vice versa) during first dry-run publish.

### Rollback

Revert the PR. `dist-publish/` and the build script disappear. The binary build pipeline is untouched, so curl-install continues working. Publishing to npm is a one-way action per version — if a bad version ships, `npm deprecate archon@x.y.z "bad release"` and publish the next patch. The `dist-publish/` build is gated behind a release-time CI step, so reverting before release has no external footprint.

---

## 5. Stage 4 — Remove Bun

After Stage 4, Bun is gone from the repo.

### `runtime: bun` script-node — breaking change

Change to `@archon/workflows`:
- `runtime: bun` → load-time error at `parseWorkflow()`:
  > `runtime: bun` is no longer supported. Replace with `runtime: node`. For TypeScript scripts, no further change needed (executed via tsx). For JavaScript scripts, ensure ES module syntax.
- Add `runtime: node` — executes `.ts`/`.js` via `tsx` (added as a runtime dependency of the published `archon` npm package, so it resolves from the user's `node_modules`).
- `runtime: uv` unchanged.
- `packages/workflows/src/validator.ts` covers it so `pnpm cli validate workflows` flags every offender in a user's repo.

**`tsx` vs `node --experimental-strip-types`:** picked **tsx** for stability. The native type-stripping flag only erases types (no path mapping, no decorators, no JSX) and is still flagged experimental on Node 22. Revisit in a future Node LTS once the native loader covers our needs.

**User communication:**
- CHANGELOG entry under `BREAKING CHANGES`.
- `archon doctor` warns if any workflow YAML in `.archon/workflows/` or `~/.archon/workflows/` uses `runtime: bun`.
- One-shot codemod: `archon migrate workflows --runtime-bun-to-node` — best-effort sed-style rewrite handling the common case; reports anything ambiguous.

### Dev runtime swap

- `packages/server/package.json`: `"dev": "bun --watch src/index.ts"` → `"dev": "tsx watch src/index.ts"`
- `packages/cli/package.json`: `"cli": "bun src/cli.ts"` → `"cli": "tsx src/cli.ts"`
- Root `package.json`: `"cli": "bun --cwd packages/cli src/cli.ts"` → `"cli": "pnpm --filter @archon/cli cli"`
- `scripts/generate-bundled-defaults.ts`, `scripts/check-bundled-skill.ts`, `scripts/generate-bundled-schema.ts` — all currently run via `bun run`. Switch to `tsx`. These scripts use no Bun APIs in their own code (confirmed during exploration), so the runner swap is purely cosmetic.

### CLI shebang

`packages/cli/src/cli.ts` — already `#!/usr/bin/env node` after Stage 3. No further change.

### CI: matrix collapses

`.github/workflows/*.yml`:
- Remove dual Node-and-Bun test matrix. CI runs Node 22 + Node 24 only.
- Remove `oven-sh/setup-bun` from every job.
- Remove the `bun build --compile` binary build matrix — curl-install path retired.
- `scripts/build-binaries.sh` → deleted.
- `scripts/checksums.sh` → deleted (checksummed Bun binaries).
- Release workflow: only the npm publish step remains. GitHub Releases still cut, linking to npm versions instead of binary downloads.

### Docker

`Dockerfile`:
- Drop Bun install/setup layers. Base becomes `node:22-alpine` (or `node:24-alpine` if Node 24 is current LTS at execution time).
- Entry: `CMD ["node", "/app/dist/cli.js", "serve"]` against the bundled npm-publish layout.
- pnpm via `corepack enable && corepack prepare pnpm@9 --activate` in builder stage.
- Image size shrinks (Bun binary was ~50MB in the layer).

### Curl-install retirement

`curl | sh` install script (referenced from README / docs site) replaced with:
```
npm i -g archon
# or
npx archon serve
```
Old curl URLs return a deprecation notice for one minor version, then 410 Gone. Existing installed binaries on user machines keep working; they don't update past the last binary-supporting version. `archon doctor` detects "installed via curl-binary path" via the existing `BUNDLED_IS_BINARY` heuristic and suggests `npm i -g archon` to migrate.

### Cleanup list

Deleted:
- `bun.lock`
- `bunfig.toml`
- `scripts/build-binaries.sh`, `scripts/checksums.sh`
- `bun-types`, `@types/bun` from `devDependencies`
- `"bun": "^1.3.0"` from `engines`
- Remaining `bun x` / `bun run` invocations in `.husky/`, `.lintstagedrc.json`, docs samples

Updated:
- `CLAUDE.md`, `CONTRIBUTING.md`, `README.md` — install/dev/test instructions go Node + pnpm
- `packages/docs-web/` — same, plus the `runtime: bun` → `runtime: node` migration guide as a dedicated page
- The "test isolation (mock.module pollution)" note in `CLAUDE.md` is dropped — Vitest's per-file isolation makes it irrelevant

### Verification gate

- Fresh-clone bootstrap: `pnpm install && pnpm run validate` passes on a machine with no Bun installed
- `archon migrate workflows --runtime-bun-to-node` codemod handles bundled-default workflows that use `runtime: bun` (audit during execution: confirm any in `.archon/workflows/defaults/`)
- Docker image runs with no Bun in the build context
- `archon doctor` produces a clean report

### Risk

**Low–medium.** Most breaking-change risk lives in `runtime: bun` user workflows — we can't see those repos, so the migration guide + codemod + doctor warning are the safety net. Internal swap of `bun --watch` → `tsx watch` is mechanical.

### Rollback

Hardest stage to roll back if a user-facing bug ships, because the curl-install path is gone. Mitigation:
- Cut a minor version bump for Stage 4 (semver signal that something major changed).
- Keep the previous minor available on npm so users can `npm i -g archon@<previous>` if needed.

---

## 6. Cross-cutting concerns

The four stages each say what changes in their slice. This section makes explicit how cross-cutting concerns evolve across all four stages.

### CI matrix progression

| Stage | Matrix |
|---|---|
| Today | Bun 1.3 on Linux/macOS |
| Stage 1 (pnpm) | Bun 1.3 + pnpm 9 (Bun still runs everything; pnpm just installs) |
| Stage 2 (Vitest) | Bun 1.3 + pnpm 9 + Vitest; **add Node 22 matrix entry running tests-only on Node** to prove Vitest works on Node before Stage 3 depends on it |
| Stage 3 (build/publish) | Bun 1.3 (binary release) + Node 22 (npm release) — full dual-channel CI |
| Stage 4 (remove Bun) | Node 22 + Node 24 only |

The Stage 2 Node matrix entry is load-bearing: it proves Vitest passes on Node before Stage 3 commits to publishing a Node-only artifact.

### Docker progression

| Stage | Image |
|---|---|
| Today | `oven/bun:1.3` base |
| Stage 1 | `oven/bun:1.3` + corepack pnpm 9 layered on top |
| Stage 2 | Same as Stage 1 (test runner doesn't affect runtime image) |
| Stage 3 | Two Dockerfiles: `Dockerfile.bun` (existing) + `Dockerfile.node` (new, `node:22-alpine`); both built in CI; only Node image gets pushed to a `:node` tag during transition |
| Stage 4 | Single `Dockerfile` on `node:22-alpine`. `Dockerfile.bun` deleted. |

`docker-compose.yml` and `docker-entrypoint.sh` need a quick sweep at Stage 4 — likely a few `bun` references to swap to `node`. Confirmed during execution.

### `scripts/` directory migration

Currently `scripts/` has TS files (`generate-bundled-defaults.ts`, `check-bundled-skill.ts`, `generate-bundled-schema.ts`) run via `bun run`, plus shell scripts.

| Stage | Runner |
|---|---|
| Stages 1–2 | `bun run scripts/foo.ts` (unchanged) |
| Stage 3 | Still `bun run` — Stage 3 doesn't touch build-script runners |
| Stage 4 | Swap to `tsx scripts/foo.ts` |

The scripts use **no Bun runtime APIs** (verified during exploration). The runner swap is cosmetic.

### Test isolation documentation removal

`CLAUDE.md` currently has a ~20-line section explaining mock-pollution and per-package batch splits. That entire section gets deleted in Stage 2 (or Stage 4 at the latest). Current batch counts (20/5/6/3) are a Bun-specific workaround that doesn't exist under Vitest.

### `engines` field timeline

| Stage | `engines` |
|---|---|
| Today | `"bun": "^1.3.0"` |
| Stages 1–2 | `"bun": "^1.3.0", "node": ">=22"` (Node added as a documented test target) |
| Stage 3 | Published `archon` package on npm declares `"node": ">=22"`; root repo `engines` keeps both |
| Stage 4 | `"node": ">=22"` only |

### Bundled defaults regeneration contract

`bun run generate:bundled` and `bun run check:bundled` are documented contract points in `CLAUDE.md`. They survive the migration as `pnpm run generate:bundled` (Stage 1) and continue executing the same scripts via the same runner until Stage 4 swaps to `tsx`. The contract — generated file must match on-disk defaults — is unchanged at every stage.

---

## 7. Non-goals, open questions, rollback summary

### Explicit non-goals

These are **out of scope** for this migration:

- **Refactoring `packages/*` boundaries.** Monorepo layout stays exactly as-is. No mergers, no extractions, no `exports` map cleanups beyond what the build pipeline strictly needs.
- **Touching providers' SDK interactions.** `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, etc. stay on the same versions. If an SDK has a Bun-only quirk, address as a bug, not as part of this migration.
- **TypeScript config modernization.** `tsconfig.json` settings stay where they are; no switch to `verbatimModuleSyntax` or `nodenext` resolution mid-migration.
- **Adopting Node's experimental TS support.** Stage 4 ships `tsx`. Revisiting in a year is fine; not a Stage 4 task.
- **Changing the published API surface.** Internal `@archon/*` packages stay internal; nothing new gets exposed on npm.
- **Performance tuning.** Bun is faster than Node at startup; we accept that as a trade for npm distribution.

### Open questions (resolved during execution)

These have a default but warrant a final check during implementation:

- **Codex SDK Node compatibility.** Codex SDK runs on Node; the `binary-resolver` includes a Bun-aware vendor path (`~/.archon/vendor/codex/`). Verify path resolution under Node still finds the vendored binary identically. Likely a non-issue — paths are filesystem operations, not Bun APIs. Confirm during Stage 3 smoke tests.
- **`@earendil-works/pi-coding-agent` CJS/ESM interop.** The bundled-binaries script comments that this package triggered the Bun bytecode bug. Under tsup + Node, CJS/ESM dual-format handling differs. Verify the package loads cleanly during Stage 3 build verification. Workaround if needed: keep this package external in tsup (`noExternal: false` for it specifically) so Node's resolver handles it.
- **Better Auth on Node.** Already supported (Better Auth is Node-first). No work expected, just verification during Stage 3.
- **SQLite native binding.** Bun ships SQLite built-in via `bun:sqlite`. Need to confirm whether `@archon/core/db/adapters/sqlite.ts` uses `bun:sqlite` (which would need migration to `better-sqlite3` or `node:sqlite`). **This is the one place the audit might have a gap — verify at Stage 1 kickoff.** If found, this becomes a Stage 1 or Stage 3 task, not a surprise.

### Rollback summary

| Stage | Rollback complexity |
|---|---|
| 1 (pnpm) | Trivial — `git revert`, lockfile returns |
| 2 (Vitest) | Easy — `git revert`, `bunfig.toml` returns, tests run on Bun again |
| 3 (npm publish) | Easy for the repo — `git revert`; npm version can't be unpublished but can be `npm deprecate`d |
| 4 (Bun removal) | Hardest — affects external users via `runtime: bun` workflows. Mitigated by minor-version bump signaling, codemod tooling, and `archon doctor` warnings before users hit a hard break |

---

## Decision log

| Decision | Choice | Rationale |
|---|---|---|
| Distribution shape | Single `archon` npm package | Matches current curl-binary UX; no monorepo publishing overhead |
| Dev runtime | Node-only (Bun fully removed) | User requirement: complete Bun removal |
| Package manager | pnpm 9 | Best monorepo support, `pnpm --filter` maps 1:1 onto `bun --filter` |
| Test runner | Vitest | Closest API parity to `bun:test`; per-file isolation eliminates current batch splits |
| Build tool | tsup | De facto standard for TS CLI publishing; esbuild-fast |
| Dev TS runner | tsx | Production-stable; `node --experimental-strip-types` not viable yet |
| Node minimum | 22 LTS | Current Active LTS; stable ESM, fetch, test runner |
| `runtime: bun` script nodes | Hard break with codemod + doctor warning | User chose explicit break over silent fallback |
| Staging | Four independent PRs (pnpm → Vitest → build/publish → remove Bun) | Each shippable and revertable in isolation |

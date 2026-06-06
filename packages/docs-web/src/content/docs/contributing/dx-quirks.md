---
title: DX Quirks
description: Known development experience quirks and workarounds when working on the Archon codebase.
category: contributing
audience: [developer]
status: current
sidebar:
  order: 6
---

Development experience notes and workarounds.

## Bun Log Elision

When running `bun dev` from the repo root, Bun's `--filter` truncates logs:

```
@archon/server dev $ bun --watch src/index.ts
│ [129 lines elided]
│ [Hono] Server listening on port 3090
└─ Running...
```

**To see full logs**, run directly from the server package:

```bash
cd packages/server && bun --watch src/index.ts
```

Or:

```bash
bun --cwd packages/server run dev
```

Note: The root `bun dev` uses `--filter` to fix hot reload path issues, but this comes with log condensing.

## Test Mock Isolation

Vitest runs each test file in its own worker process, so `vi.mock()` calls do not leak between files. Add a new test file with `vi.mock()` and `vitest run` picks it up automatically — no batch splitting required.

## Worktree Port Allocation

Worktrees auto-allocate ports (3190–4089 range, hash-based on path). Same worktree always gets same port.

- Main repo defaults to 3090
- Override: `PORT=4000 bun dev`
- Same worktree always gets same port (deterministic)

## Running tests

Use `pnpm run test` at the repo root (orchestrates per-package `vitest run`) or `pnpm --filter @archon/<pkg> test` for a single package. Watch mode: `pnpm --filter @archon/<pkg> exec vitest` (Vitest's default mode).

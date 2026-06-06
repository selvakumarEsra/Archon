# Community Forge Adapters

Forge adapters connect Archon to code hosting platforms (GitHub, GitLab, etc.) via webhooks.

## Interface

Implement `IPlatformAdapter` from `@archon/core`:

```typescript
import type { IPlatformAdapter } from '@archon/core';

export class MyForgeAdapter implements IPlatformAdapter {
  async handleWebhook(payload: string, signature: string): Promise<void> {
    // 1. Verify webhook signature
    // 2. Parse event (issue comment, PR review, etc.)
    // 3. Check authorization
    // 4. Route to handleMessage or command handler
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    // Post comment on issue/PR
  }

  async start(): Promise<void> {
    // Initialize API client
  }

  stop(): void {
    // Cleanup
  }

  // ... implement remaining IPlatformAdapter methods
}
```

## Key Differences from Chat Adapters

- **Webhook-driven**: Events arrive via HTTP POST, not polling
- **Heavier lifecycle**: Forge adapters manage repos, codebases, and isolation environments
- **Conversation ID**: Typically `owner/repo#number` format
- **Auth**: Webhook signature verification + user allowlist

## Directory Structure

```
community/forge/
└── your-adapter/
    ├── adapter.ts      # Main adapter class
    ├── auth.ts         # Webhook signature + user auth
    ├── types.ts        # Webhook event types
    ├── index.ts        # Barrel export
    └── adapter.test.ts
```

## Registration

Register in `packages/server/src/index.ts` with a webhook route:

```typescript
import { MyForgeAdapter } from '@archon/adapters/community/forge/my-forge';

// In main():
const myForge = new MyForgeAdapter(token, secret, lockManager);
await myForge.start();

// Add webhook endpoint
app.post('/webhooks/my-forge', async (c) => {
  const signature = c.req.header('x-signature');
  if (!signature) return c.json({ error: 'Missing signature' }, 400);
  const payload = await c.req.text();
  myForge.handleWebhook(payload, signature).catch(/* error handler */);
  return c.text('OK', 200);
});
```

## Testing

### Mock isolation

Vitest runs each test file in its own worker process, so `vi.mock()` calls scoped to one file do not leak across files. You do not need to plan batch splits — just add your test file and the `vitest run` script picks it up automatically.

### Lazy logger pattern

Always use a module-level `cachedLog` + `getLog()` getter so test mocks can intercept `createLogger` before the logger is instantiated:

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.my-forge');
  return cachedLog;
}
```

### Log event naming

Follow the `{domain}.{action}_{state}` convention. Standard states: `_started`, `_completed`, `_failed`. Always pair `_started` with `_completed` or `_failed`.

```typescript
// ✅ CORRECT
getLog().info({ conversationId }, 'adapter.comment_post_completed');
getLog().error({ err, conversationId }, 'adapter.comment_post_failed');

// ❌ WRONG
getLog().info({ conversationId }, 'comment_posted');
getLog().error({ err }, 'error_posting');
```

## Reference

See the GitHub adapter (`packages/adapters/src/forge/github/`) for a complete working example.

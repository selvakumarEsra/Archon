/**
 * Tests for resolveUserId — the server-level helper that wraps
 * userDb.findOrCreateUserByPlatformIdentity with a never-throws guarantee.
 *
 * The never-throws contract is load-bearing for Slack/Telegram/Discord
 * message handling: if resolveUserId ever rethrows, the entire conversation
 * silently stops being processed. Regressions here are catastrophic.
 */
import { vi, describe, test, expect, beforeEach } from 'vitest';

// Mute the server logger so test output stays readable + capture warn calls.
const warnCalls: { obj: object; evt: string }[] = [];
const mockLogger = {
  fatal: vi.fn(() => undefined),
  error: vi.fn(() => undefined),
  warn: vi.fn((obj: object, evt: string) => {
    warnCalls.push({ obj, evt });
  }),
  info: vi.fn(() => undefined),
  debug: vi.fn(() => undefined),
  trace: vi.fn(() => undefined),
  child: vi.fn(function (this: unknown) {
    return this;
  }),
  bindings: vi.fn(() => ({ module: 'server' })),
  isLevelEnabled: vi.fn(() => true),
  level: 'info',
};
vi.mock('@archon/paths', () => ({
  createLogger: () => mockLogger,
  // Other paths exports the server might pull in transitively
  logArchonPaths: vi.fn(() => undefined),
  validateAppDefaultsPaths: vi.fn(() => undefined),
  shutdownTelemetry: vi.fn(() => Promise.resolve()),
}));

const findOrCreate = vi.fn(async (_p: string, _id: string, _name?: string) => ({
  id: 'user-uuid',
  display_name: 'Resolved',
  email: null,
  created_at: new Date(),
  updated_at: new Date(),
}));
vi.mock('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: findOrCreate,
}));

import { resolveUserId } from './index';

describe('resolveUserId', () => {
  beforeEach(() => {
    findOrCreate.mockClear();
    warnCalls.length = 0;
  });

  test('returns user id when resolution succeeds', async () => {
    const result = await resolveUserId('slack', 'U123', 'Alice');
    expect(result).toBe('user-uuid');
    expect(findOrCreate).toHaveBeenCalledWith('slack', 'U123', 'Alice');
  });

  test('coerces numeric platform ids to string (telegram)', async () => {
    await resolveUserId('telegram', 7654321, 'Bob');
    expect(findOrCreate).toHaveBeenCalledWith('telegram', '7654321', 'Bob');
  });

  test('returns undefined for undefined platform user id WITHOUT calling DB', async () => {
    const result = await resolveUserId('discord', undefined, undefined);
    expect(result).toBeUndefined();
    expect(findOrCreate).not.toHaveBeenCalled();
  });

  test('returns undefined for empty-string platform user id WITHOUT calling DB', async () => {
    const result = await resolveUserId('slack', '', undefined);
    expect(result).toBeUndefined();
    expect(findOrCreate).not.toHaveBeenCalled();
  });

  test('NEVER throws when DB resolution fails (load-bearing invariant)', async () => {
    findOrCreate.mockRejectedValueOnce(new Error('db pool exhausted'));
    let thrown: unknown;
    let returned: string | undefined;
    try {
      returned = await resolveUserId('slack', 'U_FAIL', 'X');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(returned).toBeUndefined();
  });

  test('logs failure as static server.user_resolve_failed event (not platform-templated)', async () => {
    findOrCreate.mockRejectedValueOnce(new Error('connection refused'));
    await resolveUserId('telegram', 999, undefined);

    const failedCall = warnCalls.find(c => c.evt === 'server.user_resolve_failed');
    expect(failedCall).toBeDefined();
    expect(failedCall?.obj).toHaveProperty('platform', 'telegram');
    expect(failedCall?.obj).toHaveProperty('platformUserId', '999');
    // Confirm we did NOT use a per-platform event name (would collide with the
    // GitHub adapter's own `github.user_resolve_failed` event).
    expect(warnCalls.find(c => c.evt === 'telegram.user_resolve_failed')).toBeUndefined();
  });
});

import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must precede the dynamic import of ./api below.
// Covers: GET /api/auth/status (enabled/disabled shape) and the non-enforcing
// ?mine filter on the runs + conversations list endpoints (session-first, then
// the X-Archon-User header, threaded into the DB query as a userId filter).
// ---------------------------------------------------------------------------

const noopLogger = () => ({
  fatal: vi.fn(() => undefined),
  error: vi.fn(() => undefined),
  warn: vi.fn(() => undefined),
  info: vi.fn(() => undefined),
  debug: vi.fn(() => undefined),
  trace: vi.fn(() => undefined),
  child: vi.fn(function (this: unknown) {
    return this;
  }),
  bindings: vi.fn(() => ({ module: 'test' })),
  isLevelEnabled: vi.fn(() => true),
  level: 'info',
});

// --- Controllable web-auth module (../auth) ---
let authEnabled = false;
let signupMode: 'allowlist' | 'open' | 'disabled' = 'disabled';
let apiGateEnabled = false;
let authInstance: { api: { getSession: (args: unknown) => Promise<unknown> } } | null = null;

vi.mock('../auth', () => ({
  getAuth: () => authInstance,
  isWebAuthEnabled: () => authEnabled,
  getSignupMode: () => signupMode,
  isApiGateEnabled: () => apiGateEnabled,
}));

// --- Identity resolution ---
const mockFindOrCreateUser = vi.fn(async (_platform: string, platformUserId: string) => ({
  id: `user-from-${platformUserId}`,
  display_name: null,
  email: null,
  role: 'admin' as const,
  created_at: new Date(),
  updated_at: new Date(),
}));

vi.mock('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
}));

// --- List endpoints we assert the filter threading on ---
const mockListWorkflowRuns = vi.fn(async (_opts?: { userId?: string }) => [] as unknown[]);
const mockListConversations = vi.fn(
  async (
    _limit?: number,
    _platform?: string,
    _codebaseId?: string,
    _excludeEmpty?: boolean,
    _userId?: string
  ) => [] as unknown[]
);

vi.mock('@archon/core', () => ({
  handleMessage: vi.fn(async () => {}),
  getDatabaseType: () => 'postgresql',
  loadConfig: vi.fn(async () => ({})),
  cloneRepository: vi.fn(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: vi.fn(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: vi.fn(async () => {}),
  isPerUserGitHubEnabled: () => false,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: noopLogger,
}));

vi.mock('@archon/paths', () => ({
  createLogger: noopLogger,
  getWorkflowFolderSearchPaths: vi.fn(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: vi.fn(() => ['.archon/commands']),
  getDefaultCommandsPath: vi.fn(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: vi.fn(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: (owner: string, repo: string, runId: string): string =>
    `/tmp/.archon/workspaces/${owner}/${repo}/artifacts/runs/${runId}`,
}));

mockAllWorkflowModules();

vi.mock('@archon/git', () => ({
  removeWorktree: vi.fn(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

vi.mock('@archon/core/db/conversations', () => ({
  listConversations: mockListConversations,
  findConversationByPlatformId: vi.fn(async () => null),
  getOrCreateConversation: vi.fn(async () => ({ id: 'c', platform_conversation_id: 'web-x' })),
  softDeleteConversation: vi.fn(async () => {}),
  updateConversationTitle: vi.fn(async () => {}),
  getConversationById: vi.fn(async () => null),
}));

vi.mock('@archon/core/db/codebases', () => ({
  listCodebases: vi.fn(async () => []),
  getCodebase: vi.fn(async () => null),
  deleteCodebase: vi.fn(async () => {}),
}));

vi.mock('@archon/core/db/isolation-environments', () => ({
  listByCodebase: vi.fn(async () => []),
  updateStatus: vi.fn(async () => {}),
}));

vi.mock('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mockListWorkflowRuns,
  listDashboardRuns: vi.fn(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: vi.fn(async () => null),
  getWorkflowRunByWorkerPlatformId: vi.fn(async () => null),
}));

vi.mock('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: vi.fn(async () => []),
  createWorkflowEvent: vi.fn(async () => {}),
}));

vi.mock('@archon/core/db/messages', () => ({
  addMessage: vi.fn(async () => ({ id: 'm' })),
  listMessages: vi.fn(async () => []),
}));

vi.mock('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: vi.fn(async () => []),
}));

import { registerApiRoutes } from './api';

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: vi.fn(() => {}),
    emitSSE: vi.fn(async () => {}),
    emitLockEvent: vi.fn(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: vi.fn(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: vi.fn(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

describe('GET /api/auth/status', () => {
  beforeEach(() => {
    authEnabled = false;
    // `disabled` is the real default posture (no allowlist + no open-signup flag).
    signupMode = 'disabled';
    authInstance = null;
  });

  test('auth disabled → { enabled: false, signup: disabled }', async () => {
    const app = makeApp();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, signup: 'disabled' });
  });

  test('enabled + no allowlist → { enabled: true, signup: disabled } (safe default)', async () => {
    authEnabled = true;
    const app = makeApp();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, signup: 'disabled' });
  });

  test('enabled + allowlist → { enabled: true, signup: allowlist }', async () => {
    authEnabled = true;
    signupMode = 'allowlist';
    const app = makeApp();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, signup: 'allowlist' });
  });
});

describe('server-side /api/* gate', () => {
  beforeEach(() => {
    authEnabled = false;
    apiGateEnabled = false;
    authInstance = null;
    mockFindOrCreateUser.mockClear();
  });
  afterEach(() => {
    apiGateEnabled = false; // don't leak the gate into other describes
  });

  test('gate off (default) → /api/conversations is reachable unauthenticated', async () => {
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(200);
  });

  test('gate on + no identity → 401 on a protected /api route', async () => {
    apiGateEnabled = true;
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(401);
  });

  test('gate on → /api/auth/status stays public (login surface allowlisted)', async () => {
    apiGateEnabled = true;
    authEnabled = true;
    const res = await makeApp().request('/api/auth/status');
    expect(res.status).toBe(200);
  });

  test('gate on → /api/health is never blocked by the gate (healthcheck allowlist)', async () => {
    apiGateEnabled = true;
    // /api/health is registered in startServer, not registerApiRoutes, so it 404s
    // in this app — but the assertion that matters is it is NOT a 401 (the gate let it through).
    const res = await makeApp().request('/api/health');
    expect(res.status).not.toBe(401);
  });

  test('gate on + Better Auth session → protected route passes', async () => {
    apiGateEnabled = true;
    authEnabled = true;
    authInstance = {
      api: { getSession: async () => ({ user: { id: 'sess-1', name: 'A', email: 'a@x.io' } }) },
    };
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(200);
  });

  test('gate on + X-Archon-User header → protected route passes', async () => {
    apiGateEnabled = true;
    const res = await makeApp().request('/api/conversations', {
      headers: { 'X-Archon-User': 'alice' },
    });
    expect(res.status).toBe(200);
  });

  // Fail-closed: a session lookup that throws (e.g. DB outage) with NO trusted
  // header must NOT admit the request. resolveAuthContext swallows the throw and
  // returns undefined, which the gate maps to 401 — never access-granted.
  test('gate on + session lookup throws + no header → 401 (fails closed)', async () => {
    apiGateEnabled = true;
    authEnabled = true;
    authInstance = {
      api: {
        getSession: async () => {
          throw new Error('PG connection refused');
        },
      },
    };
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(401);
  });
});

describe('?mine filter — non-enforcing', () => {
  beforeEach(() => {
    authEnabled = false;
    signupMode = 'open';
    authInstance = null;
    mockListWorkflowRuns.mockClear();
    mockListConversations.mockClear();
    mockFindOrCreateUser.mockClear();
  });

  test('runs: no ?mine → listWorkflowRuns called without a userId filter', async () => {
    const app = makeApp();
    const res = await app.request('/api/workflows/runs');
    expect(res.status).toBe(200);
    const opts = mockListWorkflowRuns.mock.calls[0]?.[0];
    expect(opts?.userId).toBeUndefined();
  });

  test('runs: ?mine=true with X-Archon-User header → filters by resolved userId', async () => {
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      headers: { 'X-Archon-User': 'alice' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'alice', 'alice');
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-alice');
  });

  test('runs: ?mine=true with a Better Auth session → session wins over header', async () => {
    authEnabled = true;
    authInstance = {
      api: {
        getSession: async () => ({ user: { id: 'sess-1', name: 'Sessioned', email: 's@x.io' } }),
      },
    };
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      // header present too — session must take precedence
      headers: { 'X-Archon-User': 'header-user' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'sess-1', 'Sessioned');
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-sess-1');
  });

  test('conversations: no ?mine → listConversations called without a userId filter', async () => {
    const app = makeApp();
    const res = await app.request('/api/conversations');
    expect(res.status).toBe(200);
    // listConversations(limit, platform, codebaseId, excludeEmpty, userId)
    expect(mockListConversations.mock.calls[0]?.[4]).toBeUndefined();
  });

  test('conversations: ?mine=true with X-Archon-User header → filters by userId', async () => {
    const app = makeApp();
    const res = await app.request('/api/conversations?mine=true', {
      headers: { 'X-Archon-User': 'bob' },
    });
    expect(res.status).toBe(200);
    expect(mockListConversations.mock.calls[0]?.[4]).toBe('user-from-bob');
  });

  // The headline guarantee of this PR: ?mine is non-enforcing. With no
  // resolvable identity (no session, no header) it must degrade to listing
  // everything — NOT to an empty/zero-result gate.
  test('runs: ?mine=true with no identity → still returns all (no userId filter)', async () => {
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true');
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBeUndefined();
  });

  test('conversations: ?mine=true with no identity → still returns all (no userId filter)', async () => {
    const app = makeApp();
    const res = await app.request('/api/conversations?mine=true');
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockListConversations.mock.calls[0]?.[4]).toBeUndefined();
  });

  // Resilience: a Better Auth session lookup that throws (e.g. DB outage) must
  // fall through to the trusted proxy header rather than dropping attribution.
  test('runs: ?mine=true — session lookup throws → falls through to header', async () => {
    authEnabled = true;
    authInstance = {
      api: {
        getSession: async () => {
          throw new Error('PG connection refused');
        },
      },
    };
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      headers: { 'X-Archon-User': 'fallback-user' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'fallback-user', 'fallback-user');
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-fallback-user');
  });
});

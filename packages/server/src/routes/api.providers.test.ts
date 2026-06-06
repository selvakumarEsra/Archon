import { vi, describe, test, expect, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import {
  makeDiscoverWorkflowsMock,
  makeLoaderMock,
  makeCommandValidationMock,
} from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports
// ---------------------------------------------------------------------------

const mockLoadConfig = vi.fn(async () => ({
  assistants: { claude: { model: 'sonnet' } },
  worktree: { baseBranch: 'main' },
}));
const mockGetDatabaseType = vi.fn(() => 'sqlite' as const);

vi.mock('@archon/core', () => ({
  handleMessage: vi.fn(async () => {}),
  getDatabaseType: mockGetDatabaseType,
  loadConfig: mockLoadConfig,
  cloneRepository: vi.fn(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: vi.fn(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  toSafeConfig: (config: unknown) => config,
  generateAndSetTitle: vi.fn(async () => {}),
  updateGlobalConfig: vi.fn(async () => {}),
  createLogger: () => ({
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
  }),
}));

vi.mock('@archon/paths', () => ({
  createLogger: () => ({
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
  }),
  getWorkflowFolderSearchPaths: vi.fn(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: vi.fn(() => ['.archon/commands']),
  getDefaultCommandsPath: vi.fn(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: vi.fn(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  isDocker: vi.fn(() => false),
}));

vi.mock('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
vi.mock('@archon/workflows/loader', makeLoaderMock);
vi.mock('@archon/workflows/command-validation', makeCommandValidationMock);
vi.mock('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: vi.fn(() => false),
}));

vi.mock('@archon/git', () => ({
  removeWorktree: vi.fn(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

vi.mock('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: vi.fn(async () => null),
  listConversations: vi.fn(async () => []),
  getOrCreateConversation: vi.fn(async () => null),
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
  listByCodebaseWithAge: vi.fn(async () => []),
  updateStatus: vi.fn(async () => {}),
}));
vi.mock('@archon/core/db/workflows', () => ({
  listWorkflowRuns: vi.fn(async () => []),
  listDashboardRuns: vi.fn(async () => ({ runs: [], total: 0, counts: {} })),
  getWorkflowRun: vi.fn(async () => null),
  cancelWorkflowRun: vi.fn(async () => {}),
  getWorkflowRunByWorkerPlatformId: vi.fn(async () => null),
  getRunningWorkflows: vi.fn(async () => []),
}));
vi.mock('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: vi.fn(async () => []),
}));
vi.mock('@archon/core/db/messages', () => ({
  addMessage: vi.fn(async () => null),
  listMessages: vi.fn(async () => []),
}));
vi.mock('@archon/core/db/env-vars', () => ({
  getEnvVars: vi.fn(async () => []),
  getEnvVarKeys: vi.fn(async () => []),
  setEnvVar: vi.fn(async () => {}),
  deleteEnvVar: vi.fn(async () => {}),
}));
vi.mock('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: vi.fn(async () => []),
}));

// Bootstrap registry after mocks
clearRegistry();
registerBuiltinProviders();

import { registerApiRoutes } from './api';

type Hono = InstanceType<typeof OpenAPIHono>;

function makeApp(): Hono {
  const app = new OpenAPIHono();
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
    getStats: vi.fn(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/providers
// ---------------------------------------------------------------------------

describe('GET /api/providers', () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
  });

  test('returns 200 with provider list', async () => {
    const response = await app.request('/api/providers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: unknown[] };
    expect(body.providers).toBeDefined();
    expect(Array.isArray(body.providers)).toBe(true);
  });

  test('includes built-in providers', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: { id: string; builtIn: boolean }[];
    };
    const ids = body.providers.map(p => p.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(body.providers.every(p => p.builtIn)).toBe(true);
  });

  test('returns correct shape per provider (no factory or isModelCompatible)', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: Record<string, unknown>[];
    };
    for (const provider of body.providers) {
      expect(provider).toHaveProperty('id');
      expect(provider).toHaveProperty('displayName');
      expect(provider).toHaveProperty('capabilities');
      expect(provider).toHaveProperty('builtIn');
      // Non-serializable fields must NOT leak
      expect(provider).not.toHaveProperty('factory');
      expect(provider).not.toHaveProperty('isModelCompatible');
    }
  });

  test('capabilities have expected boolean fields', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: {
        capabilities: Record<string, boolean> & {
          structuredOutput: 'enforced' | 'best-effort' | false;
        };
      }[];
    };
    const caps = body.providers[0].capabilities;
    expect(typeof caps.sessionResume).toBe('boolean');
    expect(typeof caps.mcp).toBe('boolean');
    expect(typeof caps.hooks).toBe('boolean');
    // structuredOutput is the tiered union, not a boolean.
    expect(['enforced', 'best-effort', false]).toContain(caps.structuredOutput);
  });
});

import { vi, describe, test, expect, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
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
const mockIsDocker = vi.fn(() => false);
const mockGetStats = vi.fn(() => ({
  active: 1,
  queuedTotal: 2,
  queuedByConversation: [] as { conversationId: string; queuedMessages: number }[],
  maxConcurrent: 10,
  activeConversationIds: [] as string[],
}));

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
  isDocker: mockIsDocker,
}));

vi.mock('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
vi.mock('@archon/workflows/loader', makeLoaderMock);
vi.mock('@archon/workflows/command-validation', makeCommandValidationMock);
vi.mock('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {
    'archon-assist': '# archon-assist command',
    plan: '# plan command',
    implement: '# implement command',
  },
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
  getOrCreateConversation: vi.fn(async () => ({
    id: 'internal-uuid-123',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
    ai_assistant_type: 'claude',
  })),
  softDeleteConversation: vi.fn(async () => {}),
  updateConversationTitle: vi.fn(async () => {}),
  getConversationById: vi.fn(async () => null),
}));

vi.mock('@archon/core/db/codebases', () => ({
  listCodebases: vi.fn(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: vi.fn(async () => null),
  deleteCodebase: vi.fn(async () => {}),
}));

vi.mock('@archon/core/db/isolation-environments', () => ({
  listByCodebase: vi.fn(async () => []),
  updateStatus: vi.fn(async () => {}),
}));

const mockGetRunningWorkflows = vi.fn(
  async () =>
    [] as { id: string; conversation_id: string; workflow_name: string; started_at: string }[]
);

vi.mock('@archon/core/db/workflows', () => ({
  listWorkflowRuns: vi.fn(async () => []),
  listDashboardRuns: vi.fn(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: vi.fn(async () => null),
  cancelWorkflowRun: vi.fn(async () => {}),
  getWorkflowRunByWorkerPlatformId: vi.fn(async () => null),
  getRunningWorkflows: mockGetRunningWorkflows,
}));

vi.mock('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: vi.fn(async () => []),
}));

vi.mock('@archon/core/db/messages', () => ({
  addMessage: vi.fn(async () => ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user',
    content: 'hi',
    metadata: '{}',
    created_at: new Date().toISOString(),
  })),
  listMessages: vi.fn(async () => []),
}));

vi.mock('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: vi.fn(async () => []),
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): Hono {
  const app = new OpenAPIHono();
  const mockWebAdapter = {
    setConversationDbId: vi.fn((_platformId: string, _dbId: string) => {}),
    emitSSE: vi.fn(async () => {}),
    emitLockEvent: vi.fn(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: vi.fn(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mockGetStats,
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/health
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  beforeEach(() => {
    mockGetStats.mockReset();
    mockGetRunningWorkflows.mockReset();
    mockIsDocker.mockClear(); // preserve base () => false implementation; only clear call records
  });

  test('returns status ok with adapter and concurrency info', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      active: 0,
      queuedTotal: 2,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => [
      { id: 'run-1', conversation_id: 'conv-1', workflow_name: 'assist', started_at: '2026-01-01' },
    ]);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      adapter: string;
      concurrency: { active: number; activeConversationIds: string[] };
      runningWorkflows: number;
      version: string;
    };
    expect(body.status).toBe('ok');
    expect(body.adapter).toBe('web');
    expect(body.concurrency).toBeDefined();
    expect(body.concurrency.active).toBe(1);
    expect(body.concurrency.activeConversationIds).toEqual(['conv-1']);
    expect(body.runningWorkflows).toBe(1);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  test('includes running background workflows in concurrency.active count', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => [
      { id: 'run-1', conversation_id: 'conv-1', workflow_name: 'assist', started_at: '2026-01-01' },
      { id: 'run-2', conversation_id: 'conv-2', workflow_name: 'plan', started_at: '2026-01-01' },
    ]);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      concurrency: { active: number; activeConversationIds: string[] };
      runningWorkflows: number;
    };
    expect(body.concurrency.active).toBe(2);
    expect(body.concurrency.activeConversationIds).toEqual(['conv-1', 'conv-2']);
    expect(body.runningWorkflows).toBe(2);
  });

  test('deduplicates conversation IDs tracked by both lock manager and DB', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      active: 1,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: ['conv-1'],
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => [
      { id: 'run-1', conversation_id: 'conv-1', workflow_name: 'assist', started_at: '2026-01-01' },
    ]);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      concurrency: { active: number; activeConversationIds: string[] };
    };
    // Should NOT double-count conv-1
    expect(body.concurrency.active).toBe(1);
    expect(body.concurrency.activeConversationIds).toEqual(['conv-1']);
  });

  test('combines lock manager and background workflow counts', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      active: 1,
      queuedTotal: 3,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: ['conv-1'],
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => [
      { id: 'run-2', conversation_id: 'conv-2', workflow_name: 'plan', started_at: '2026-01-01' },
    ]);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      concurrency: { active: number; queuedTotal: number; activeConversationIds: string[] };
      runningWorkflows: number;
    };
    expect(body.concurrency.active).toBe(2);
    expect(body.concurrency.queuedTotal).toBe(3);
    expect(body.concurrency.activeConversationIds).toEqual(['conv-1', 'conv-2']);
    expect(body.runningWorkflows).toBe(1);
  });

  test('returns 200 without any auth requirements', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
  });

  test('includes is_docker: false in non-Docker environment', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);
    mockIsDocker.mockReturnValueOnce(false);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { is_docker: boolean };
    expect(body.is_docker).toBe(false);
  });

  test('includes is_docker: true in Docker environment', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);
    mockIsDocker.mockReturnValueOnce(true);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { is_docker: boolean };
    expect(body.is_docker).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/config
// ---------------------------------------------------------------------------

describe('GET /api/config', () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    mockGetDatabaseType.mockReset();
  });

  test('returns config and database type', async () => {
    mockLoadConfig.mockImplementationOnce(async () => ({
      assistants: { claude: { model: 'sonnet' } },
    }));
    mockGetDatabaseType.mockImplementationOnce(() => 'sqlite');

    const app = makeApp();
    const response = await app.request('/api/config');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      config: { assistants: { claude: { model: string } } };
      database: string;
    };
    expect(body.config).toBeDefined();
    expect(body.database).toBe('sqlite');
    expect(body.config.assistants.claude.model).toBe('sonnet');
  });

  test('reflects postgres database type when configured', async () => {
    mockLoadConfig.mockImplementationOnce(async () => ({}));
    mockGetDatabaseType.mockImplementationOnce(() => 'postgresql');

    const app = makeApp();
    const response = await app.request('/api/config');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { database: string };
    expect(body.database).toBe('postgresql');
  });

  test('returns 500 when loadConfig throws', async () => {
    mockLoadConfig.mockImplementationOnce(async () => {
      throw new Error('config file missing');
    });

    const app = makeApp();
    const response = await app.request('/api/config');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get config');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/commands
// ---------------------------------------------------------------------------

describe('GET /api/commands', () => {
  test('returns commands array with bundled commands', async () => {
    const app = makeApp();
    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    expect(Array.isArray(body.commands)).toBe(true);

    // BUNDLED_COMMANDS mock has 3 entries
    const bundledCommands = body.commands.filter(c => c.source === 'bundled');
    expect(bundledCommands.length).toBeGreaterThan(0);
  });

  test('includes archon-assist as bundled command', async () => {
    const app = makeApp();
    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    const archonAssist = body.commands.find(c => c.name === 'archon-assist');
    expect(archonAssist).toBeDefined();
    expect(archonAssist?.source).toBe('bundled');
  });

  test('includes plan and implement as bundled commands', async () => {
    const app = makeApp();
    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    const names = body.commands.map(c => c.name);
    expect(names).toContain('plan');
    expect(names).toContain('implement');
  });

  test('returns commands with cwd query param without error', async () => {
    const app = makeApp();
    // Use the registered codebase path (/tmp/project from the mock) so validateCwd passes
    const response = await app.request('/api/commands?cwd=/tmp/project');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: Array<{ name: string }> };
    expect(Array.isArray(body.commands)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/openapi.json — guards @hono/zod-openapi spec generation
// (the v0 -> v1 / zod v4 upgrade is a major bump; this confirms every
// registered route's schema still serializes without throwing).
// ---------------------------------------------------------------------------

describe('GET /api/openapi.json', () => {
  test('generates a valid OpenAPI 3 document for all registered routes', async () => {
    const app = makeApp();
    const response = await app.request('/api/openapi.json');
    expect(response.status).toBe(200);

    const doc = (await response.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(typeof doc.info.title).toBe('string');
    // A representative sample of registered routes must be present, including
    // ones whose schemas use the patterns touched by the zod v4 migration
    // (z.record key types, z.string().datetime(), the node-sessions route).
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(doc.paths['/api/health']).toBeDefined();
    expect(doc.paths['/api/workflows/{name}/node-sessions']).toBeDefined();
    // The datetime-heavy, highest-traffic routes are the ones the zod-to-openapi
    // v7 -> v8 serialization change most threatens (z.string().datetime() fields
    // on conversation/codebase schemas). A route can register in `paths` while
    // its schema silently fails to serialize, so also assert the component
    // schemas those routes reference actually made it into the document.
    expect(doc.paths['/api/conversations']).toBeDefined();
    expect(doc.paths['/api/codebases']).toBeDefined();
    const schemas = doc.components?.schemas ?? {};
    expect(Object.keys(schemas).length).toBeGreaterThan(10);
    expect(schemas['Conversation']).toBeDefined();
    expect(schemas['Codebase']).toBeDefined();
    expect(schemas['WorkflowEvent']).toBeDefined();
  });
});

import { vi, describe, test, expect, beforeEach } from 'vitest';
import { createMockLogger } from '../test/mocks/logger';
import { MockPlatformAdapter } from '../test/mocks/platform';
import type { Conversation, Codebase } from '../types';
import type { IsolationEnvironmentRow } from '@archon/isolation';

// ─── Mock setup (BEFORE importing module under test) ─────────────────────────

const mockLogger = createMockLogger();
vi.mock('@archon/paths', () => ({
  createLogger: vi.fn(() => mockLogger),
  getArchonWorkspacesPath: vi.fn(() => '/home/test/.archon/workspaces'),
  ensureArchonWorkspacesPath: vi.fn(() => Promise.resolve('/home/test/.archon/workspaces')),
  getArchonHome: vi.fn(() => '/home/test/.archon'),
}));

// DB mocks
const mockUpdateConversation = vi.fn(() => Promise.resolve());
vi.mock('../db/conversations', () => ({
  getOrCreateConversation: vi.fn(() => Promise.resolve(null)),
  getConversationByPlatformId: vi.fn(() => Promise.resolve(null)),
  updateConversation: mockUpdateConversation,
  touchConversation: vi.fn(() => Promise.resolve()),
}));

vi.mock('../db/codebases', () => ({
  getCodebase: vi.fn(() => Promise.resolve(null)),
  listCodebases: vi.fn(() => Promise.resolve([])),
  createCodebase: vi.fn(() => Promise.resolve({ id: 'new-codebase-id' })),
}));

vi.mock('../db/isolation-environments', () => ({
  createIsolationStore: vi.fn(() => ({
    updateStatus: vi.fn(() => Promise.resolve()),
  })),
}));

// orchestrator.ts resolves the per-user no-reply email for worktree git identity;
// mock it (like the other db deps) so the real db/connection + adapters aren't
// dragged into this test's light module graph.
vi.mock('../db/user-github-token-store', () => ({
  getUserGithubNoreplyEmail: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../db/sessions', () => ({
  getActiveSession: vi.fn(() => Promise.resolve(null)),
  createSession: vi.fn(() => Promise.resolve(null)),
  updateSession: vi.fn(() => Promise.resolve()),
  deactivateSession: vi.fn(() => Promise.resolve()),
  transitionSession: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../handlers/command-handler', () => ({
  handleCommand: vi.fn(() => Promise.resolve({ message: '', modified: false, success: true })),
  parseCommand: vi.fn((msg: string) => ({
    command: msg.split(/\s+/)[0].substring(1),
    args: msg.split(/\s+/).slice(1),
  })),
}));

vi.mock('@archon/providers', () => ({
  getAgentProvider: vi.fn(() => null),
}));

vi.mock('../workflows/store-adapter', () => ({
  createWorkflowDeps: vi.fn(() => ({
    store: {},
    getAgentProvider: () => ({}),
    loadConfig: async () => ({}),
  })),
}));

vi.mock('../config/config-loader', () => ({
  loadConfig: vi.fn(() => Promise.resolve({})),
  loadRepoConfig: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../utils/worktree-sync', () => ({
  syncArchonToWorktree: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../services/cleanup-service', () => ({
  cleanupToMakeRoom: vi.fn(() => Promise.resolve({ removed: [] })),
  getWorktreeStatusBreakdown: vi.fn(() => Promise.resolve({ active: 0, stale: 0, merged: 0 })),
  STALE_THRESHOLD_DAYS: 7,
}));

// Mock @archon/isolation — shared resolve mock so tests can control return values
const mockResolve = vi.fn(() => Promise.resolve({ status: 'none' as const, cwd: '/workspace' }));

class MockIsolationResolver {
  resolve = mockResolve;
  constructor(_deps: unknown) {}
}

vi.mock('@archon/isolation', () => ({
  IsolationResolver: MockIsolationResolver,
  IsolationBlockedError: class IsolationBlockedError extends Error {
    constructor(
      message: string,
      public reason?: string
    ) {
      super(message);
      this.name = 'IsolationBlockedError';
    }
  },
  configureIsolation: vi.fn(() => undefined),
  getIsolationProvider: vi.fn(() => ({})),
}));

vi.mock('./prompt-builder', () => ({
  buildOrchestratorPrompt: vi.fn(() => 'prompt'),
  buildProjectScopedPrompt: vi.fn(() => 'prompt'),
}));

vi.mock('../utils/error-formatter', () => ({
  classifyAndFormatError: vi.fn((err: Error) => `⚠️ Error: ${err.message}`),
}));

vi.mock('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: vi.fn(() => Promise.resolve({ workflows: [], errors: [] })),
}));
vi.mock('@archon/workflows/executor', () => ({
  executeWorkflow: vi.fn(() => Promise.resolve()),
}));
vi.mock('@archon/workflows/router', () => ({
  findWorkflow: vi.fn(() => undefined),
}));
vi.mock('@archon/workflows/utils/tool-formatter', () => ({
  formatToolCall: vi.fn(() => ''),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('../services/title-generator', () => ({
  generateAndSetTitle: vi.fn(() => Promise.resolve()),
}));

// ─── Import module under test AFTER all mocks ────────────────────────────────

const { validateAndResolveIsolation } = await import('./orchestrator');

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeEnvRow(overrides?: Partial<IsolationEnvironmentRow>): IsolationEnvironmentRow {
  return {
    id: 'env-1',
    codebase_id: 'cb-1',
    workflow_type: 'issue',
    workflow_id: '42',
    provider: 'worktree',
    working_path: '/worktrees/issue-42',
    branch_name: 'issue-42',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'web',
    metadata: {},
    ...overrides,
  };
}

function makeConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    platform_type: 'web',
    platform_conversation_id: 'web-conv-1',
    codebase_id: 'cb-1',
    cwd: '/workspace',
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: null,
    hidden: false,
    deleted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeCodebase(overrides?: Partial<Codebase>): Codebase {
  return {
    id: 'cb-1',
    name: 'test-repo',
    default_cwd: '/workspace/test-repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateAndResolveIsolation', () => {
  let platform: MockPlatformAdapter;

  beforeEach(() => {
    platform = new MockPlatformAdapter();
    mockUpdateConversation.mockClear();
    mockResolve.mockClear();
  });

  test('linked_issue_reuse triggers reuse message', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase();

    mockResolve.mockResolvedValueOnce({
      status: 'resolved',
      env: makeEnvRow(),
      cwd: '/worktrees/issue-42',
      method: { type: 'linked_issue_reuse', issueNumber: 99 },
    });

    const result = await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'Reusing worktree from issue #99');
    expect(result.status).toBe('new');
  });

  test('created with autoCleanedCount triggers cleanup message', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase();

    mockResolve.mockResolvedValueOnce({
      status: 'resolved',
      env: makeEnvRow(),
      cwd: '/worktrees/issue-42',
      method: { type: 'created', autoCleanedCount: 3 },
    });

    const result = await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      'Cleaned up 3 merged worktree(s) to make room.'
    );
    expect(result.status).toBe('new');
  });
});

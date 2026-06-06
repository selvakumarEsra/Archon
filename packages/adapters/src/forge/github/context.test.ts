/**
 * Tests for GitHub adapter context passing to handleMessage.
 *
 * These tests verify that contextToAppend (issueContext) is set correctly
 * for both slash command and non-slash command webhook events.
 *
 * Separated from adapter.test.ts because these require heavy module mocking
 * of @archon/core and database modules to test the full handleWebhook flow.
 */
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';

// --- Module mocks (must be before imports that use them) ---

// Mock logger to suppress noisy output during tests
const mockLogger = {
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
};
vi.mock('@archon/paths', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

const mockHandleMessage = vi.fn(async () => {});

const mockGetOrCreateConversation = vi.fn(async () => ({
  id: 'conv-1',
  codebase_id: null,
  cwd: null,
  isolation_env_id: null,
}));

const mockUpdateConversation = vi.fn(async () => {});

const mockFindCodebaseByRepoUrl = vi.fn(async () => null);

const mockCreateCodebase = vi.fn(async () => ({
  id: 'codebase-1',
  name: 'testrepo',
  repo_url: 'https://github.com/testuser/testrepo',
  default_cwd: '/workspace/testuser/testrepo',
  commands: {},
}));

const mockGetLinkedIssueNumbers = vi.fn(async () => []);

vi.mock('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  classifyAndFormatError: () => 'Error occurred',
  ConversationNotFoundError: class extends Error {},
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  getLinkedIssueNumbers: mockGetLinkedIssueNumbers,
  onConversationClosed: vi.fn(async () => {}),
  getArchonWorkspacesPath: () => '/workspace',
  getCommandFolderSearchPaths: () => [],
  ConversationLockManager: class {
    async acquireLock(_id: string, handler: () => Promise<void>): Promise<void> {
      await handler();
    }
    getStats() {
      return {
        active: 0,
        queuedTotal: 0,
        queuedByConversation: [],
        maxConcurrent: 10,
        activeConversationIds: [],
      };
    }
  },
}));

vi.mock('@archon/git', () => ({
  isWorktreePath: vi.fn(async () => false),
  cloneRepository: vi.fn(async () => ({ ok: true, value: undefined })),
  syncRepository: vi.fn(async () => ({ ok: true, value: undefined })),
  addSafeDirectory: vi.fn(async () => undefined),
  toRepoPath: (p: string) => p,
  toBranchName: (n: string) => n,
}));

vi.mock('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  updateConversation: mockUpdateConversation,
}));

vi.mock('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  createCodebase: mockCreateCodebase,
  updateCodebase: vi.fn(async () => {}),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      callback(null, { stdout: '', stderr: '' });
    }
  ),
  exec: vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, '', '');
    }
  ),
}));

// Note: fs/promises is NOT mocked here. The adapter methods that use readdir/access
// (ensureRepoReady, autoDetectAndLoadCommands) are mocked at the adapter level in
// createTestAdapter(). Using vi.mock('fs/promises') would leak globally and break
// other tests (e.g., version.test.ts) since Bun's mock.module persists across files.

// --- Imports (after mocks) ---

import { GitHubAdapter } from './adapter';

// --- Test helpers ---

const WEBHOOK_SECRET = 'test-webhook-secret';

function signPayload(payload: string): string {
  return 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
}

function createIssueCommentPayload(
  commentBody: string,
  options: {
    issueNumber?: number;
    issueTitle?: string;
    isPR?: boolean;
    commentAuthor?: string;
  } = {}
): string {
  const {
    issueNumber = 42,
    issueTitle = 'Test Issue Title',
    isPR = false,
    commentAuthor = 'user123',
  } = options;

  const issue: Record<string, unknown> = {
    number: issueNumber,
    title: issueTitle,
    body: 'Issue body',
    user: { login: 'creator' },
    labels: [],
    state: 'open',
  };

  if (isPR) {
    issue.pull_request = {
      url: `https://api.github.com/repos/testuser/testrepo/pulls/${issueNumber}`,
    };
  }

  return JSON.stringify({
    action: 'created',
    issue,
    comment: {
      body: commentBody,
      user: { login: commentAuthor },
    },
    repository: {
      owner: { login: 'testuser' },
      name: 'testrepo',
      full_name: 'testuser/testrepo',
      html_url: 'https://github.com/testuser/testrepo',
      default_branch: 'main',
    },
    sender: { login: commentAuthor },
  });
}

/**
 * Create an adapter with mocked internals for testing handleWebhook.
 */
function createTestAdapter(): GitHubAdapter {
  const adapter = new GitHubAdapter({ kind: 'pat', token: 'fake-token' }, WEBHOOK_SECRET, {
    acquireLock: vi.fn(async (_id: string, handler: () => Promise<void>) => {
      await handler();
    }),
    getStats: () => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    }),
  } as unknown as InstanceType<typeof import('@archon/core').ConversationLockManager>);

  // @ts-expect-error - mock private method for testing
  adapter.verifySignature = vi.fn(() => true);

  // @ts-expect-error - mock private Octokit for API calls during webhook flow
  adapter.octokit = {
    rest: {
      repos: {
        get: vi.fn(() =>
          Promise.resolve({
            data: { default_branch: 'main' },
          })
        ),
      },
      issues: {
        createComment: vi.fn(() => Promise.resolve({ data: {} })),
        listComments: vi.fn(() => Promise.resolve({ data: [] })),
      },
      pulls: {
        get: vi.fn(() =>
          Promise.resolve({
            data: {
              head: {
                ref: 'feature-branch',
                sha: 'abc123def456',
                repo: { full_name: 'testuser/testrepo' },
              },
              base: {
                repo: { full_name: 'testuser/testrepo' },
              },
            },
          })
        ),
      },
    },
  };

  // @ts-expect-error - mock private method to skip filesystem operations
  adapter.ensureRepoReady = vi.fn(async () => {});

  // @ts-expect-error - mock private method to skip command loading
  adapter.autoDetectAndLoadCommands = vi.fn(async () => {});

  return adapter;
}

describe('GitHubAdapter non-slash command context passing', () => {
  let adapter: GitHubAdapter;
  let originalAllowedUsers: string | undefined;

  beforeEach(() => {
    // Clear env var so auth doesn't reject test senders
    originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
    delete process.env.GITHUB_ALLOWED_USERS;

    mockHandleMessage.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockUpdateConversation.mockClear();
    mockFindCodebaseByRepoUrl.mockClear();
    mockCreateCodebase.mockClear();
    mockGetLinkedIssueNumbers.mockClear();
    adapter = createTestAdapter();
  });

  afterEach(() => {
    if (originalAllowedUsers !== undefined) {
      process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
    } else {
      delete process.env.GITHUB_ALLOWED_USERS;
    }
  });

  test('should set contextToAppend for issue_comment events on issues', async () => {
    const payload = createIssueCommentPayload('@archon help me with this issue', {
      issueNumber: 99,
      issueTitle: 'Bug in login flow',
    });

    await adapter.handleWebhook(payload, signPayload(payload));

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const contextArg = mockHandleMessage.mock.calls[0][3]?.issueContext as string;
    expect(contextArg).toBe(
      'GitHub Issue #99: "Bug in login flow"\nUse \'gh issue view 99\' for full details if needed.'
    );
  });

  test('should set contextToAppend for issue_comment events on PRs', async () => {
    const payload = createIssueCommentPayload('@archon review this PR', {
      issueNumber: 55,
      issueTitle: 'Add dark mode',
      isPR: true,
    });

    await adapter.handleWebhook(payload, signPayload(payload));

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const contextArg = mockHandleMessage.mock.calls[0][3]?.issueContext as string;
    expect(contextArg).toBe(
      'GitHub Issue #55: "Add dark mode"\nUse \'gh issue view 55\' for full details if needed.'
    );
  });

  test('should set contextToAppend with different issue numbers and titles', async () => {
    const payload = createIssueCommentPayload('@archon investigate this bug', {
      issueNumber: 33,
      issueTitle: 'Memory leak in worker',
    });

    await adapter.handleWebhook(payload, signPayload(payload));

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const contextArg = mockHandleMessage.mock.calls[0][3]?.issueContext as string;
    expect(contextArg).toBe(
      'GitHub Issue #33: "Memory leak in worker"\nUse \'gh issue view 33\' for full details if needed.'
    );
  });

  test('should also set contextToAppend for slash commands (existing behavior)', async () => {
    const payload = createIssueCommentPayload('@archon /status', {
      issueNumber: 10,
      issueTitle: 'Setup tracking',
    });

    await adapter.handleWebhook(payload, signPayload(payload));

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const contextArg = mockHandleMessage.mock.calls[0][3]?.issueContext as string;
    expect(contextArg).toBe(
      'GitHub Issue #10: "Setup tracking"\nUse \'gh issue view 10\' for full details if needed.'
    );
  });

  test('context format matches between slash and non-slash commands', async () => {
    // Slash command
    const slashPayload = createIssueCommentPayload('@archon /help', {
      issueNumber: 42,
      issueTitle: 'Test Issue',
    });
    await adapter.handleWebhook(slashPayload, signPayload(slashPayload));
    const slashContext = mockHandleMessage.mock.calls[0][3]?.issueContext as string;

    mockHandleMessage.mockClear();

    // Non-slash command
    const nonSlashPayload = createIssueCommentPayload('@archon help me debug this', {
      issueNumber: 42,
      issueTitle: 'Test Issue',
    });
    await adapter.handleWebhook(nonSlashPayload, signPayload(nonSlashPayload));
    const nonSlashContext = mockHandleMessage.mock.calls[0][3]?.issueContext as string;

    // Both should produce the same context string
    expect(slashContext).toBe(nonSlashContext);
    expect(slashContext).toBe(
      'GitHub Issue #42: "Test Issue"\nUse \'gh issue view 42\' for full details if needed.'
    );
  });
});

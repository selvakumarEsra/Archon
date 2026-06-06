/**
 * Tests for isolation complete command
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isolationCompleteCommand, isolationCleanupMergedCommand } from './isolation';

const mockLogger = {
  fatal: vi.fn(() => undefined),
  error: vi.fn(() => undefined),
  warn: vi.fn(() => undefined),
  info: vi.fn(() => undefined),
  debug: vi.fn(() => undefined),
  trace: vi.fn(() => undefined),
  child: vi.fn(() => mockLogger),
};

vi.mock('@archon/paths', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

const mockFindActiveByBranchName = vi.fn(() => Promise.resolve(null));

vi.mock('@archon/core/db/isolation-environments', () => ({
  findActiveByBranchName: mockFindActiveByBranchName,
  findActiveByWorkflow: vi.fn(() => Promise.resolve(null)),
  listAllActiveWithCodebase: vi.fn(() => Promise.resolve([])),
  listByCodebaseWithAge: vi.fn(() => Promise.resolve([])),
  findStaleEnvironments: vi.fn(() => Promise.resolve([])),
  create: vi.fn(() => Promise.resolve({ id: 'iso-123' })),
  updateStatus: vi.fn(() => Promise.resolve()),
}));

const mockGetActiveWorkflowRunByPath = vi.fn(() => Promise.resolve(null));

vi.mock('@archon/core/db/workflows', () => ({
  getActiveWorkflowRunByPath: mockGetActiveWorkflowRunByPath,
}));

const mockRemoveEnvironment = vi.fn(() =>
  Promise.resolve({ worktreeRemoved: true, branchDeleted: true, warnings: [] })
);
const mockCleanupMergedWorktrees = vi.fn(() => Promise.resolve({ removed: [], skipped: [] }));

vi.mock('@archon/core/services/cleanup-service', () => ({
  removeEnvironment: mockRemoveEnvironment,
  cleanupMergedWorktrees: mockCleanupMergedWorktrees,
}));

const mockListEnvironments = vi.fn(() =>
  Promise.resolve({
    codebases: [
      {
        codebaseId: 'cb-1',
        defaultCwd: '/test/repo',
        repositoryUrl: 'https://github.com/owner/repo',
        environments: [],
      },
    ],
    totalEnvironments: 0,
    ghostsReconciled: 0,
  })
);
const mockCleanupMergedEnvironments = vi.fn(() => Promise.resolve({ removed: [], skipped: [] }));

vi.mock('@archon/core/operations/isolation-operations', () => ({
  listEnvironments: mockListEnvironments,
  cleanupMergedEnvironments: mockCleanupMergedEnvironments,
}));

const mockHasUncommittedChanges = vi.fn(() => Promise.resolve(false));
// Default: gh returns empty PR array, git log returns empty string (no commits to report)
const mockExecFileAsync = vi.fn((cmd: string) =>
  Promise.resolve({ stdout: cmd === 'gh' ? '[]' : '', stderr: '' })
);

const mockGetDefaultBranch = vi.fn(() => Promise.resolve('main'));

vi.mock('@archon/git', () => ({
  hasUncommittedChanges: mockHasUncommittedChanges,
  execFileAsync: mockExecFileAsync,
  toWorktreePath: vi.fn((p: string) => p),
  toRepoPath: vi.fn((p: string) => p),
  toBranchName: vi.fn((b: string) => b),
  worktreeExists: vi.fn(() => Promise.resolve(true)),
  getDefaultBranch: mockGetDefaultBranch,
}));

vi.mock('@archon/isolation', () => ({
  getIsolationProvider: vi.fn(() => ({
    destroy: vi.fn(() => Promise.resolve({ warnings: [] })),
  })),
}));

const mockEnv = {
  id: 'env-123',
  branch_name: 'feature-branch',
  working_path: '/test/worktree',
  codebase_id: 'cb-123',
  codebase_default_cwd: '/test/repo',
  workflow_id: 'wf-123',
  workflow_type: 'branch',
  status: 'active',
  provider: 'worktree',
  created_by_platform: 'cli',
  metadata: {},
  created_at: new Date().toISOString(),
};

describe('isolationCompleteCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFindActiveByBranchName.mockReset();
    mockRemoveEnvironment.mockReset();
    mockHasUncommittedChanges.mockReset();
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockGetActiveWorkflowRunByPath.mockReset();
    mockGetActiveWorkflowRunByPath.mockResolvedValue(null);
    mockExecFileAsync.mockReset();
    // Default: gh returns empty PR array, git log returns empty string (no commits)
    mockExecFileAsync.mockImplementation((cmd: string) =>
      Promise.resolve({ stdout: cmd === 'gh' ? '[]' : '', stderr: '' })
    );
    mockGetDefaultBranch.mockReset();
    mockGetDefaultBranch.mockResolvedValue('main');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('completes a branch when env is found and all checks pass', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).toHaveBeenCalledWith('env-123', {
      force: false,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 0 failed, 0 not found');
  });

  it('prints not found when env does not exist', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(null);

    await isolationCompleteCommand(['nonexistent-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Not found: nonexistent-branch (no active isolation environment)'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 0 failed, 1 not found');
  });

  it('blocks when env has uncommitted changes without --force', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);

    await isolationCompleteCommand(['dirty-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: dirty-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ uncommitted changes in worktree');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks when there is a running workflow on the branch', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockGetActiveWorkflowRunByPath.mockResolvedValueOnce({
      id: 'run-abc',
      workflow_name: 'implement',
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ running workflow: implement (id: run-abc)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks when there is an open PR on the branch', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify([{ number: 140, title: 'fix: add metrics session_id' }]),
          stderr: '',
        });
      }
      // git log: empty (no unmerged/unpushed)
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '    ✗ open PR #140 — "fix: add metrics session_id"'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks when there are unmerged commits', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.includes(`main..feature-branch`)) {
        return Promise.resolve({
          stdout: 'abc1234 fix: something\ndef5678 fix: other\n',
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 2 commit(s) not merged into main');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks when there are unpushed commits', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        return Promise.resolve({ stdout: 'abc1234 wip: unpushed commit\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 1 commit(s) not pushed to remote');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks with "never pushed" when origin/<branch> does not exist', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ branch has never been pushed to remote');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('reports all blockers together when multiple checks fail', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);
    mockGetActiveWorkflowRunByPath.mockResolvedValueOnce({
      id: 'run-abc',
      workflow_name: 'implement',
    });
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify([{ number: 140, title: 'fix: metrics' }]),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ uncommitted changes in worktree');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ running workflow: implement (id: run-abc)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ open PR #140 — "fix: metrics"');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('skips PR check with warning when gh CLI is not available', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === 'gh') {
        const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
        return Promise.reject(err);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '  Warning: gh CLI not available — skipping open PR check'
    );
    // Should still complete since gh check is non-fatal
    expect(mockRemoveEnvironment).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
  });

  it('proceeds despite all checks when --force is set', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);
    mockGetActiveWorkflowRunByPath.mockResolvedValueOnce({
      id: 'run-abc',
      workflow_name: 'implement',
    });
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });

    await isolationCompleteCommand(['dirty-branch'], { force: true, deleteRemote: true });

    // All safety checks should NOT be called when force is true
    expect(mockHasUncommittedChanges).not.toHaveBeenCalled();
    expect(mockGetActiveWorkflowRunByPath).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(mockRemoveEnvironment).toHaveBeenCalledWith('env-123', {
      force: true,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: dirty-branch');
  });

  it('counts failed when removeEnvironment throws', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockRejectedValueOnce(new Error('git error: cannot remove worktree'));

    await isolationCompleteCommand(['bad-branch'], { force: false, deleteRemote: true });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Failed: bad-branch — git error: cannot remove worktree'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('handles multiple branches with mixed results', async () => {
    mockFindActiveByBranchName
      .mockResolvedValueOnce(mockEnv) // found: branch-1
      .mockResolvedValueOnce(null) // not found: branch-2
      .mockResolvedValueOnce(mockEnv); // found: branch-3 (will fail)
    mockRemoveEnvironment
      .mockResolvedValueOnce({ worktreeRemoved: true, branchDeleted: true, warnings: [] }) // branch-1 succeeds
      .mockRejectedValueOnce(new Error('some error')); // branch-3 fails

    await isolationCompleteCommand(['branch-1', 'branch-2', 'branch-3'], {
      force: false,
      deleteRemote: true,
    });

    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 1 failed, 1 not found');
  });
  it('counts as failed when removeEnvironment returns skippedReason (ghost worktree)', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: false,
      branchDeleted: false,
      skippedReason: 'has uncommitted changes',
      warnings: [],
    });

    await isolationCompleteCommand(['ghost-branch'], { force: true, deleteRemote: true });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Blocked: ghost-branch — has uncommitted changes'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('    Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('counts as failed when removeEnvironment returns partial (worktree not removed, branch deleted)', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: false,
      branchDeleted: true,
      warnings: ['Some warning'],
      skippedReason: undefined,
    });

    await isolationCompleteCommand(['partial-branch'], { force: true, deleteRemote: true });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Partial: partial-branch — worktree was not removed from disk (branch deleted, DB updated)'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ⚠ Some warning');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('surfaces warnings from removeEnvironment result', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: false,
      warnings: ["Cannot delete branch 'feature-branch': checked out elsewhere"],
    });

    await isolationCompleteCommand(['feature-branch'], { force: true, deleteRemote: true });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "  Warning: Cannot delete branch 'feature-branch': checked out elsewhere"
    );
    // Should still count as completed since worktree was removed
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 0 failed, 0 not found');
  });
});

describe('isolationCleanupMergedCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCleanupMergedEnvironments.mockReset();
    mockCleanupMergedEnvironments.mockResolvedValue({ removed: [], skipped: [] });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('passes includeClosed=true when --include-closed flag is set', async () => {
    await isolationCleanupMergedCommand({ includeClosed: true });
    expect(mockCleanupMergedEnvironments).toHaveBeenCalledWith('cb-1', '/test/repo', {
      includeClosed: true,
    });
  });

  it('defaults to includeClosed=false', async () => {
    await isolationCleanupMergedCommand();
    expect(mockCleanupMergedEnvironments).toHaveBeenCalledWith('cb-1', '/test/repo', {});
  });
});

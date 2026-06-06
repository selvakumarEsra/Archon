import { vi, describe, test, expect, beforeEach } from 'vitest';

// Mock @archon/git before importing the module under test
const mockExecFileAsync = vi.fn(
  async (_cmd: string, _args: string[]): Promise<{ stdout: string; stderr: string }> => ({
    stdout: '/usr/bin/bun\n',
    stderr: '',
  })
);

vi.mock('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

// Mock @archon/paths logger
vi.mock('@archon/paths', () => ({
  createLogger: vi.fn(() => ({
    fatal: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    warn: vi.fn(() => undefined),
    info: vi.fn(() => undefined),
    debug: vi.fn(() => undefined),
    trace: vi.fn(() => undefined),
  })),
  getCommandFolderSearchPaths: vi.fn(() => ['.archon/commands']),
  getDefaultCommandsPath: vi.fn(() => '/defaults/commands'),
  findMarkdownFilesRecursive: vi.fn(async () => []),
}));

// Mock defaults and command-validation used by validator
vi.mock('./defaults/bundled-defaults', () => ({
  BUNDLED_COMMANDS: {},
  isBinaryBuild: () => false,
}));

vi.mock('./command-validation', () => ({
  isValidCommandName: () => true,
}));

import { checkRuntimeAvailable, clearRuntimeCache } from './validator';

describe('checkRuntimeAvailable', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    clearRuntimeCache();
  });

  test('returns true when binary is found (exit 0)', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/usr/bin/bun\n', stderr: '' });
    const result = await checkRuntimeAvailable('bun');
    expect(result).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['bun']);
  });

  test('returns false when binary is not found (non-zero exit)', async () => {
    mockExecFileAsync.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: which uv'), { code: 1 })
    );
    const result = await checkRuntimeAvailable('uv');
    expect(result).toBe(false);
    expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['uv']);
  });

  test('returns false when which itself throws', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('ENOENT: which not found'));
    const result = await checkRuntimeAvailable('bun');
    expect(result).toBe(false);
  });

  test('calls which with the runtime name', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/usr/local/bin/uv\n', stderr: '' });
    await checkRuntimeAvailable('uv');
    expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['uv']);
  });

  test('returns true for bun when available', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/usr/bin/bun', stderr: '' });
    expect(await checkRuntimeAvailable('bun')).toBe(true);
  });

  test('returns true for uv when available', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/home/user/.cargo/bin/uv', stderr: '' });
    expect(await checkRuntimeAvailable('uv')).toBe(true);
  });
});

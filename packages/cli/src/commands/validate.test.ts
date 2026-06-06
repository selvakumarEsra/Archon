import { vi, afterEach, beforeEach, describe, expect, test } from 'vitest';

const mockDiscoverWorkflowsWithConfig = vi.fn(() => Promise.resolve({ workflows: [], errors: [] }));

vi.mock('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));

const mockLoadRepoConfig = vi.fn(() => Promise.resolve(null));
const mockLoadConfig = vi.fn(() =>
  Promise.resolve({
    assistant: 'claude',
    aliases: {},
    tiers: {},
  })
);

vi.mock('@archon/core', () => ({
  loadConfig: mockLoadConfig,
  loadRepoConfig: mockLoadRepoConfig,
}));

import { validateWorkflowsCommand } from './validate';

describe('validateWorkflowsCommand', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const mockConsoleLog = vi.fn(() => {});
  const mockConsoleError = vi.fn(() => {});

  beforeEach(() => {
    mockDiscoverWorkflowsWithConfig.mockClear();
    mockLoadRepoConfig.mockClear();
    mockLoadConfig.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    mockLoadRepoConfig.mockResolvedValue(null);
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
    });
  });

  test('rejects bundled @custom model refs via discovered source', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        {
          source: 'bundled',
          workflow: {
            name: 'bad-bundled',
            model: '@custom',
            nodes: [{ id: 'step1', prompt: 'hello' }],
          },
        },
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand('/tmp/repo', undefined, true);

    expect(exitCode).toBe(1);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).toContain('@custom');
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });
});

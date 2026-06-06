/**
 * Tests for the CLI chat command
 */
import { vi, describe, test, expect, beforeEach } from 'vitest';

// Mock logger before any imports
const mockLogger = {
  fatal: vi.fn(() => undefined),
  error: vi.fn(() => undefined),
  warn: vi.fn(() => undefined),
  info: vi.fn(() => undefined),
  debug: vi.fn(() => undefined),
  trace: vi.fn(() => undefined),
  child: vi.fn(() => mockLogger),
  bindings: vi.fn(() => ({ module: 'test' })),
  isLevelEnabled: vi.fn(() => true),
  level: 'info',
};

vi.mock('@archon/paths', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock @archon/core/db/messages (used by CLIAdapter for persistence)
vi.mock('@archon/core/db/messages', () => ({
  addMessage: vi.fn(() => Promise.resolve()),
}));

// Mock handleMessage from @archon/core
const mockHandleMessage = vi.fn(() => Promise.resolve());

vi.mock('@archon/core', () => ({
  handleMessage: mockHandleMessage,
}));

import { chatCommand } from './chat';
import { CLIAdapter } from '../adapters/cli-adapter';

describe('chatCommand', () => {
  beforeEach(() => {
    mockHandleMessage.mockClear();
  });

  test('should call handleMessage with a CLIAdapter, unique conversationId, and the message', async () => {
    await chatCommand('Hello, agent!');

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);

    const [adapter, conversationId, message] = mockHandleMessage.mock.calls[0] as [
      CLIAdapter,
      string,
      string,
    ];

    expect(adapter).toBeInstanceOf(CLIAdapter);
    expect(conversationId).toMatch(/^cli-chat-\d+-[a-z0-9]+$/);
    expect(message).toBe('Hello, agent!');
  });

  test('should use batch streaming mode for the CLIAdapter', async () => {
    await chatCommand('test');

    const [adapter] = mockHandleMessage.mock.calls[0] as [CLIAdapter, string, string];
    expect(adapter.getStreamingMode()).toBe('batch');
  });

  test('should generate a unique conversationId for each invocation', async () => {
    await chatCommand('first message');
    await chatCommand('second message');

    const [, id1] = mockHandleMessage.mock.calls[0] as [unknown, string, string];
    const [, id2] = mockHandleMessage.mock.calls[1] as [unknown, string, string];

    expect(id1).not.toBe(id2);
  });

  test('should forward the exact message string to handleMessage', async () => {
    const complexMessage = '/workflow run assist "build a feature"';
    await chatCommand(complexMessage);

    const [, , message] = mockHandleMessage.mock.calls[0] as [unknown, string, string];
    expect(message).toBe(complexMessage);
  });

  test('should propagate errors thrown by handleMessage', async () => {
    mockHandleMessage.mockRejectedValueOnce(new Error('Orchestrator unavailable'));

    await expect(chatCommand('will fail')).rejects.toThrow('Orchestrator unavailable');
  });

  test('should have conversationId prefixed with cli-chat-', async () => {
    await chatCommand('prefix check');

    const [, conversationId] = mockHandleMessage.mock.calls[0] as [unknown, string, string];
    expect(conversationId.startsWith('cli-chat-')).toBe(true);
  });

  test('CLIAdapter passed to handleMessage should have cli platform type', async () => {
    await chatCommand('platform type check');

    const [adapter] = mockHandleMessage.mock.calls[0] as [CLIAdapter, string, string];
    expect(adapter.getPlatformType()).toBe('cli');
  });

  test('should not log to console for empty string message', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await chatCommand('');
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

import type { IPlatformAdapter, MessageMetadata } from '../../types';
import { vi, type Mock } from 'vitest';

export class MockPlatformAdapter implements IPlatformAdapter {
  public sendMessage: Mock<
    (conversationId: string, message: string, metadata?: MessageMetadata) => Promise<void>
  > = vi.fn(() => Promise.resolve());
  public ensureThread: Mock<
    (originalConversationId: string, messageContext?: unknown) => Promise<string>
  > = vi.fn((originalConversationId: string) => Promise.resolve(originalConversationId));
  public getStreamingMode: Mock<() => 'stream' | 'batch'> = vi.fn(() => 'stream' as const);
  public getPlatformType: Mock<() => string> = vi.fn(() => 'mock');
  public start: Mock<() => Promise<void>> = vi.fn(() => Promise.resolve());
  public stop: Mock<() => void> = vi.fn(() => undefined);

  public reset(): void {
    this.sendMessage.mockClear();
    this.ensureThread.mockClear();
    this.getStreamingMode.mockClear();
    this.getPlatformType.mockClear();
    this.start.mockClear();
    this.stop.mockClear();
  }
}

export const createMockPlatform = (): MockPlatformAdapter => new MockPlatformAdapter();

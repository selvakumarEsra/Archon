import { vi } from 'vitest';
import type { Logger } from 'pino';

export interface MockLogger extends Logger {
  fatal: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  info: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  trace: ReturnType<typeof mock>;
  child: ReturnType<typeof mock>;
}

export function createMockLogger(): MockLogger {
  const logger = {
    fatal: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    warn: vi.fn(() => undefined),
    info: vi.fn(() => undefined),
    debug: vi.fn(() => undefined),
    trace: vi.fn(() => undefined),
    child: vi.fn(() => logger),
    bindings: vi.fn(() => ({ module: 'test' })),
    isLevelEnabled: vi.fn(() => true),
    level: 'info',
  } as unknown as MockLogger;
  return logger;
}

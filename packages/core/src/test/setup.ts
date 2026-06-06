// Global test setup for Vitest
import { afterEach, afterAll, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

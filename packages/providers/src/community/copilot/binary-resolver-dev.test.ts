/**
 * Tests for the Copilot binary resolver in dev mode (BUNDLED_IS_BINARY=false).
 * Separate file because binary-mode tests mock BUNDLED_IS_BINARY=true.
 */
import { vi, describe, test, expect } from 'vitest';
import { createMockLogger } from '../../test/mocks/logger';

vi.mock('@archon/paths', () => ({
  createLogger: vi.fn(() => createMockLogger()),
  BUNDLED_IS_BINARY: false,
  getArchonHome: vi.fn(() => '/tmp/test-archon-home'),
}));

import { resolveCopilotBinaryPath } from './binary-resolver';

describe('resolveCopilotBinaryPath (dev mode)', () => {
  test('returns undefined when BUNDLED_IS_BINARY is false', async () => {
    const result = await resolveCopilotBinaryPath();
    expect(result).toBeUndefined();
  });

  test('returns undefined even with config path set', async () => {
    const result = await resolveCopilotBinaryPath('/some/custom/path');
    expect(result).toBeUndefined();
  });
});

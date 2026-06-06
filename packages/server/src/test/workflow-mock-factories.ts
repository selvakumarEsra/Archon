import type { Mock } from 'vitest';
import { vi } from 'vitest';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import type { ParseResult } from '@archon/workflows/loader';

/**
 * Register all 4 @archon/workflows vi.mock() calls at once.
 * Must be called before importing the module under test.
 */
export function mockAllWorkflowModules(): void {
  vi.mock('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
  vi.mock('@archon/workflows/loader', makeLoaderMock);
  vi.mock('@archon/workflows/command-validation', makeCommandValidationMock);
  vi.mock('@archon/workflows/defaults', makeDefaultsMock);
}

export function makeDiscoverWorkflowsMock(): {
  discoverWorkflowsWithConfig: Mock<() => Promise<WorkflowLoadResult>>;
} {
  return {
    discoverWorkflowsWithConfig: vi.fn(
      async (): Promise<WorkflowLoadResult> => ({ workflows: [], errors: [] })
    ),
  };
}

export function makeLoaderMock(): {
  parseWorkflow: Mock<() => ParseResult>;
} {
  return {
    parseWorkflow: vi.fn(
      (): ParseResult => ({
        workflow: null,
        error: { filename: '', error: 'stub', errorType: 'parse_error' },
      })
    ),
  };
}

/**
 * Stub that always returns true. Tests relying on actual name validation
 * (path traversal, dot-prefix) should use their own inline mock instead.
 */
export function makeCommandValidationMock(): {
  isValidCommandName: Mock<() => boolean>;
} {
  return {
    isValidCommandName: vi.fn(() => true),
  };
}

export function makeDefaultsMock(): {
  BUNDLED_WORKFLOWS: Record<string, string>;
  BUNDLED_COMMANDS: Record<string, string>;
  isBinaryBuild: Mock<() => boolean>;
} {
  return {
    BUNDLED_WORKFLOWS: {},
    BUNDLED_COMMANDS: {},
    isBinaryBuild: vi.fn(() => false),
  };
}

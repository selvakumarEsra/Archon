import { vi, describe, test, expect, beforeEach } from 'vitest';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = vi.fn(() => Promise.resolve(createQueryResult([])));

vi.mock('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

vi.mock('@archon/paths', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(() => {}),
    warn: vi.fn(() => {}),
    error: vi.fn(() => {}),
    debug: vi.fn(() => {}),
    trace: vi.fn(() => {}),
    fatal: vi.fn(() => {}),
  })),
}));

import { getCodebaseEnvVars, setCodebaseEnvVar, deleteCodebaseEnvVar } from './env-vars';

describe('env-vars', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  describe('getCodebaseEnvVars', () => {
    test('returns flat Record from rows', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { key: 'FOO', value: 'bar' },
          { key: 'BAZ', value: 'qux' },
        ])
      );
      const result = await getCodebaseEnvVars('codebase-1');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
      expect(mockQuery.mock.calls[0][1]).toEqual(['codebase-1']);
    });

    test('returns empty object when no rows', async () => {
      const result = await getCodebaseEnvVars('codebase-1');
      expect(result).toEqual({});
    });
  });

  describe('setCodebaseEnvVar', () => {
    test('issues upsert with correct params', async () => {
      await setCodebaseEnvVar('codebase-1', 'MY_KEY', 'my_value');
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('DO UPDATE SET value');
      expect(params[1]).toBe('codebase-1');
      expect(params[2]).toBe('MY_KEY');
      expect(params[3]).toBe('my_value');
    });
  });

  describe('deleteCodebaseEnvVar', () => {
    test('issues DELETE with codebaseId and key', async () => {
      await deleteCodebaseEnvVar('codebase-1', 'MY_KEY');
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('DELETE FROM remote_agent_codebase_env_vars');
      expect(params).toEqual(['codebase-1', 'MY_KEY']);
    });
  });
});

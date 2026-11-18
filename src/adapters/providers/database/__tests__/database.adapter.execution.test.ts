import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgMocks = vi.hoisted(() => {
  const client = {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
  };
  const Client = vi.fn(function MockClient() {
    return client;
  });
  return { client, Client };
});

vi.mock('pg', () => ({ default: { Client: pgMocks.Client } }));

import {
  DatabaseAdapter,
  MAX_QUERY_STATEMENT_TIMEOUT_MS,
} from '../database.adapter.js';

function connectedAdapter(): DatabaseAdapter {
  const adapter = new DatabaseAdapter();
  adapter.connect({ connectionUrl: 'postgresql://user:secret@database.example.com:5432/app' });
  return adapter;
}

beforeEach(() => {
  pgMocks.Client.mockClear();
  pgMocks.client.connect.mockReset().mockResolvedValue(undefined);
  pgMocks.client.query.mockReset();
  pgMocks.client.end.mockReset().mockResolvedValue(undefined);
});

describe('DatabaseAdapter query execution', () => {
  it('enforces read-only mode in PostgreSQL and commits a successful diagnostic query', async () => {
    pgMocks.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ one: 1 }], rowCount: 1, fields: [{ name: 'one', dataTypeID: 23 }] })
      .mockResolvedValueOnce({});

    const result = await connectedAdapter().query('SELECT 1', [], { readOnly: true });

    expect(result).toMatchObject({ success: true, rows: [{ one: 1 }], rowCount: 1 });
    expect(pgMocks.client.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN READ ONLY',
      'SELECT 1',
      'COMMIT',
    ]);
    expect(pgMocks.Client).toHaveBeenCalledWith(expect.objectContaining({
      statement_timeout: MAX_QUERY_STATEMENT_TIMEOUT_MS,
      query_timeout: MAX_QUERY_STATEMENT_TIMEOUT_MS,
    }));
    expect(pgMocks.client.end).toHaveBeenCalledOnce();
  });

  it('rolls back read-only transactions when PostgreSQL rejects the query', async () => {
    pgMocks.client.query
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('statement timeout'))
      .mockResolvedValueOnce({});

    const result = await connectedAdapter().query('SELECT pg_sleep(60)', [], { readOnly: true });

    expect(result).toEqual({ success: false, error: 'statement timeout' });
    expect(pgMocks.client.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN READ ONLY',
      'SELECT pg_sleep(60)',
      'ROLLBACK',
    ]);
    expect(pgMocks.client.end).toHaveBeenCalledOnce();
  });

  it('rejects oversized row sets before returning them', async () => {
    pgMocks.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2, fields: [] })
      .mockResolvedValueOnce({});

    const result = await connectedAdapter().query('SELECT * FROM users', [], { readOnly: true, maxRows: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('1-row diagnostic limit');
    expect(result.rows).toBeUndefined();
    expect(pgMocks.client.query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('rejects oversized serialized responses before returning them', async () => {
    pgMocks.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ payload: 'too large' }], rowCount: 1, fields: [] })
      .mockResolvedValueOnce({});

    const result = await connectedAdapter().query('SELECT payload FROM events', [], {
      readOnly: true,
      maxResponseBytes: 5,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('5-byte diagnostic response limit');
    expect(result.rows).toBeUndefined();
    expect(pgMocks.client.query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('retains a confirmed mutation outcome if result serialization fails after the query completed', async () => {
    pgMocks.client.query.mockResolvedValueOnce({ rows: [{ value: 1n }], rowCount: 1, fields: [] });
    const result = await connectedAdapter().query('UPDATE counters SET value = value + 1 RETURNING value', [], { readOnly: false });
    expect(result).toMatchObject({ success: false, mutationOutcome: 'committed' });
    expect(result.error).toContain('mutation committed');
    expect(result.error).toContain('Do not repeat the write');
    expect(pgMocks.client.query).toHaveBeenCalledOnce();
  });

  it('leaves a transport failure uncertain and never retries or claims a rollback', async () => {
    pgMocks.client.query.mockRejectedValueOnce(new Error('Connection terminated'));
    const result = await connectedAdapter().query('UPDATE counters SET value = value + 1', [], { readOnly: false });
    expect(result).toMatchObject({ success: false, mutationOutcome: 'unknown' });
    expect(result.error).toContain('mutation outcome is unknown');
    expect(pgMocks.client.query).toHaveBeenCalledOnce();
  });
});

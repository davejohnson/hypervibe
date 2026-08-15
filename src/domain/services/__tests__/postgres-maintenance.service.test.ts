import { describe, expect, it, vi } from 'vitest';
import {
  observePostgresWriteFence,
  setPostgresWriteFence,
  type PostgresMaintenanceClient,
} from '../postgres-maintenance.service.js';

function clients(initial: boolean) {
  let fenced = initial;
  const created: PostgresMaintenanceClient[] = [];
  const createClient = vi.fn((): PostgresMaintenanceClient => {
    const client: PostgresMaintenanceClient = {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('current_user')) return { rows: [{ role: 'app', database: 'appdb' }] };
        if (sql.includes(' SET default_transaction_read_only')) fenced = true;
        if (sql.includes(' RESET default_transaction_read_only')) fenced = false;
        if (sql.includes('SHOW default_transaction_read_only')) return { rows: [{ default_transaction_read_only: fenced ? 'on' : 'off' }] };
        if (sql.includes('SHOW transaction_read_only')) return { rows: [{ transaction_read_only: fenced ? 'on' : 'off' }] };
        return { rows: [] };
      }),
    };
    created.push(client);
    return client;
  });
  return { createClient, created };
}

describe('PostgreSQL maintenance fence', () => {
  it('sets and verifies the fence through a fresh connection', async () => {
    const deps = clients(false);
    const result = await setPostgresWriteFence('postgres://secret@example/app', true, deps);
    expect(result).toEqual({ state: 'fenced' });
    expect(deps.createClient).toHaveBeenCalledTimes(2);
  });

  it('removes and verifies the fence through a fresh connection', async () => {
    const deps = clients(true);
    const result = await setPostgresWriteFence('postgres://secret@example/app', false, deps);
    expect(result).toEqual({ state: 'unfenced' });
    expect(deps.createClient).toHaveBeenCalledTimes(2);
  });

  it('returns unknown without leaking connection or SQL diagnostics', async () => {
    const observation = await observePostgresWriteFence('postgres://user:password@private.example/app', {
      createClient: () => ({
        connect: vi.fn(async () => { throw new Error('password at private.example rejected'); }),
        end: vi.fn(async () => undefined),
        query: vi.fn(),
      }),
    });
    expect(observation.state).toBe('unknown');
    expect(JSON.stringify(observation)).not.toContain('password');
    expect(JSON.stringify(observation)).not.toContain('private.example');
  });
});

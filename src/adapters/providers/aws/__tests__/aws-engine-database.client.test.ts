import { beforeEach, describe, expect, it, vi } from 'vitest';

const statements: Array<{ sql: string; database: string }> = [];
vi.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: class { async send(command: { input: { sql: string; database: string } }) { statements.push(command.input); return { records: [] }; } },
  ExecuteStatementCommand: class { constructor(public input: unknown) {} },
}));
let rdsReply: () => Promise<unknown> = async () => ({});
vi.mock('@aws-sdk/client-rds', async (original) => ({ ...(await original<object>()), RDSClient: class { async send() { return rdsReply(); } } }));
vi.mock('@aws-sdk/client-ssm', async (original) => ({ ...(await original<object>()), SSMClient: class { async send() { return {}; } } }));
vi.mock('@aws-sdk/client-secrets-manager', async (original) => ({ ...(await original<object>()), SecretsManagerClient: class { async send() { return {}; } } }));

const { clusterSnapshotState, dropAuroraEnvironmentDatabase, ensureDatabaseLogin } = await import('../aws-engine.client.js');
const access = { region: 'us-west-2', credentials: { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' } };
const database = { name: 'app_demo', owner: 'app_demo_owner', waker: 'app_demo_waker' };
const cluster = { clusterArn: 'arn:aws:rds:us-west-2:111122223333:cluster:hv-app-shared-postgres', masterSecretArn: 'arn:secret' };

describe('testing environments on the shared Aurora cluster', () => {
  beforeEach(() => { statements.length = 0; });

  it('get their own database that no other login can connect to', async () => {
    await ensureDatabaseLogin(access, { ...cluster, parameter: '/hypervibe/env/DATABASE_URL', wakerSecrets: ['hypervibe/hv-app-demo/worker-waker'],
      endpoint: 'db.example', databaseUrlKey: 'DATABASE_URL', database });
    const sql = statements.map((entry) => entry.sql);
    expect(sql).toContain('CREATE DATABASE app_demo OWNER app_demo_owner');
    expect(sql).toContain('REVOKE ALL ON DATABASE app_demo FROM PUBLIC');
    expect(sql).toContain('GRANT CONNECT ON DATABASE app_demo TO app_demo_waker');
    expect(statements.find((entry) => entry.sql.startsWith('ALTER SCHEMA public'))?.database).toBe('app_demo');
  });

  it('drop only their own database and logins at teardown', async () => {
    await dropAuroraEnvironmentDatabase(access, { ...cluster, database });
    expect(statements.map((entry) => entry.sql)).toContain('DROP DATABASE IF EXISTS app_demo WITH (FORCE)');
    await expect(ensureDatabaseLogin(access, { ...cluster, parameter: 'p', wakerSecrets: [], endpoint: 'e', databaseUrlKey: 'DATABASE_URL',
      database: { ...database, name: 'app; DROP DATABASE other' } })).rejects.toThrow(/invalid/);
  });

  it('tell an earlier final snapshot apart from none and from an unreadable answer', async () => {
    const fault = (name: string) => Object.assign(new Error(name), { name });
    rdsReply = async () => ({ DBClusterSnapshots: [{ DBClusterSnapshotIdentifier: 'hv-app-shared-postgres-final', SnapshotCreateTime: new Date('2026-11-15T10:00:00Z') }] });
    expect(await clusterSnapshotState(access, 'hv-app-shared-postgres-final')).toEqual({ state: 'present', createdAt: '2026-11-15T10:00:00.000Z' });
    rdsReply = async () => { throw fault('DBClusterSnapshotNotFoundFault'); };
    expect(await clusterSnapshotState(access, 'hv-app-shared-postgres-final')).toEqual({ state: 'absent' });
    rdsReply = async () => { throw fault('AccessDenied'); };
    expect((await clusterSnapshotState(access, 'hv-app-shared-postgres-final')).state).toBe('unknown');
    rdsReply = async () => ({ DBClusterSnapshots: [] });
    expect((await clusterSnapshotState(access, 'hv-app-shared-postgres-final')).state).toBe('unknown');
  });
});

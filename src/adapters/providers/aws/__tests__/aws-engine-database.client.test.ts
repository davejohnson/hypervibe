import { beforeEach, describe, expect, it, vi } from 'vitest';

const credentialArn = 'arn:aws:secretsmanager:us-west-2:111122223333:secret:hypervibe/env/database-query-AbCd12';
const ssmWrites: Record<string, unknown>[] = [];
const secretWrites: Record<string, unknown>[] = [];
let existingUrl = '';
const statements: Array<{ sql: string; database: string }> = [];
vi.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: class { async send(command: { input: { sql: string; database: string } }) { statements.push(command.input); return { records: [] }; } },
  ExecuteStatementCommand: class { constructor(public input: unknown) {} },
}));
let rdsReply: () => Promise<unknown> = async () => ({});
vi.mock('@aws-sdk/client-rds', async (original) => ({ ...(await original<object>()), RDSClient: class { async send() { return rdsReply(); } } }));
vi.mock('@aws-sdk/client-ssm', async (original) => ({ ...(await original<object>()), SSMClient: class { async send(command: { input: Record<string, unknown> }) { if ('WithDecryption' in command.input) return { Parameter: { Name: command.input.Name, Value: existingUrl } }; ssmWrites.push(command.input); return {}; } destroy() {} } }));
vi.mock('@aws-sdk/client-secrets-manager', async (original) => ({ ...(await original<object>()), SecretsManagerClient: class { async send(command: { input: Record<string, unknown> }) { if ('SecretString' in command.input) { secretWrites.push(command.input); return { ARN: credentialArn, VersionId: 'current' }; } return { ARN: credentialArn, Name: 'hypervibe/env/database-query', Tags: [{ Key: 'managed-by', Value: 'hypervibe' }, { Key: 'hv-environment', Value: 'env' }], VersionIdsToStages: { current: ['AWSCURRENT'] } }; } destroy() {} } }));

const { clusterSnapshotState, dropAuroraEnvironmentDatabase, ensureDatabaseLogin } = await import('../aws-engine.client.js');
const access = { region: 'us-west-2', credentials: { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' } };
const database = { name: 'app_demo', owner: 'app_demo_owner', waker: 'app_demo_waker' };
const cluster = { clusterArn: 'arn:aws:rds:us-west-2:111122223333:cluster:hv-app-shared-postgres', masterSecretArn: 'arn:secret' };

describe('testing environments on the shared Aurora cluster', () => {
  beforeEach(() => { statements.length = 0; ssmWrites.length = 0; secretWrites.length = 0; existingUrl = 'postgresql://app_demo_owner:private-existing-password@db.example:5432/app_demo?sslmode=require'; });

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


describe('approved environment query credential creation', () => {
  const params = { ...cluster, parameter: '/hypervibe/env/DATABASE_URL', wakerSecrets: [], endpoint: 'db.example', databaseUrlKey: 'DATABASE_URL', database,
    queryCredential: { arn: credentialArn, accountId: '111122223333', environmentId: 'env' } };
  beforeEach(() => { statements.length = 0; ssmWrites.length = 0; secretWrites.length = 0; existingUrl = 'postgresql://app_demo_owner:private-existing-password@db.example:5432/app_demo?sslmode=require'; });
  it('stores the same fresh application login in SSM and the exact reviewed query secret', async () => {
    const result = await ensureDatabaseLogin(access, params);
    expect(result.success).toBe(true);
    const url = new URL(String(ssmWrites[0]!.Value));
    const secret = JSON.parse(String(secretWrites[0]!.SecretString));
    expect(secretWrites[0]!.SecretId).toBe(credentialArn);
    expect(secret).toEqual({ username: 'app_demo_owner', password: decodeURIComponent(url.password) });
    expect(JSON.stringify(result)).not.toContain(secret.password);
  });
  it('upgrades an existing app credential without changing its password or running administrator SQL', async () => {
    const result = await ensureDatabaseLogin(access, { ...params, appLogin: false });
    expect(result.success).toBe(true);
    expect(statements).toEqual([]); expect(ssmWrites).toEqual([]);
    expect(JSON.parse(String(secretWrites[0]!.SecretString))).toEqual({ username: 'app_demo_owner', password: 'private-existing-password' });
  });
  it('stops an upgrade before writing when the retained SSM login targets a different database', async () => {
    existingUrl = 'postgresql://hvadmin:private-other-password@db.example:5432/postgres';
    await expect(ensureDatabaseLogin(access, { ...params, appLogin: false })).resolves.toMatchObject({ success: false, status: 'blocked' });
    expect(secretWrites).toEqual([]); expect(statements).toEqual([]); expect(ssmWrites).toEqual([]);
  });
});

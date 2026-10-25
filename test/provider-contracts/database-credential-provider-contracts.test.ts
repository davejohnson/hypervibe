import { afterEach, expect, it, vi } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { databaseCredentialLifecycle } from '../../src/domain/ports/database-credential.port.js';
import { SupabaseAdapter } from '../../src/adapters/providers/supabase/supabase.adapter.js';
import { NeonAdapter } from '../../src/adapters/providers/neon/neon.adapter.js';
import { CloudSqlAdapter } from '../../src/adapters/providers/gcp/cloudsql.adapter.js';
import { AzurePostgresAdapter } from '../../src/adapters/providers/azure/azure-postgres.adapter.js';
import { FlyDatabaseAdapter } from '../../src/adapters/providers/fly/fly-database.adapter.js';
import { DigitalOceanDatabaseAdapter } from '../../src/adapters/providers/digitalocean/digitalocean-database.adapter.js';
import { RdsAdapter } from '../../src/adapters/providers/aws/rds.adapter.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../../src/adapters/providers/railway/railway-database.factory.js';
import type { IDatabaseAdapter } from '../../src/domain/ports/database.port.js';
import type { Environment } from '../../src/domain/entities/environment.entity.js';
import type { Component } from '../../src/domain/entities/component.entity.js';
import { RDSClient } from '@aws-sdk/client-rds';
import { Readable } from 'node:stream';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const adapters = [new SupabaseAdapter(), new NeonAdapter(), new CloudSqlAdapter(), new AzurePostgresAdapter(), new FlyDatabaseAdapter(), new DigitalOceanDatabaseAdapter(), new RdsAdapter(),
  createRailwayDatabaseAdapter({ hostingAdapter: new RailwayAdapter(), envRepo: { findById: () => null } as any })];

it('every registered database provider has an actual database authentication rotation port', () => {
  const registered = providerRegistry.all().filter(provider => provider.metadata.lifecycle?.databaseEngines?.includes('postgres')).map(provider => provider.metadata.name).sort();
  expect(adapters.map(adapter => adapter.name).sort()).toEqual(registered);
  for (const adapter of adapters) expect(databaseCredentialLifecycle(adapter), adapter.name).toBeDefined();
});

const env = { id: 'local-env', name: 'production', projectId: 'project', platformBindings: {} } as Environment;
function database(adapter: IDatabaseAdapter, externalId = 'native-db', username = 'postgres') {
  const component = { id: 'local-component', environmentId: env.id, externalId, type: 'postgres', bindings: { provider: adapter.name,
    providerScope: { accountId: 'account' }, username, database: 'appdb', connectionString: `postgresql://${username}:old@db.example/appdb` } } as Component;
  vi.spyOn(adapter, 'observeDatabase').mockResolvedValue({ provider: adapter.name, externalId, engine: 'postgres', status: 'running' });
  vi.spyOn(adapter, 'getConnectionUrl').mockResolvedValue(String(component.bindings.connectionString));
  return component;
}

// These native HTTP observations are reconstructed from the official contracts
// listed in docs/database-credential-rotation.md, not captured live success.
it('Supabase resets the database password through its native management endpoint only', async () => {
  const adapter = new SupabaseAdapter(); await adapter.connect({ accessToken: 'synthetic-token', organizationId: 'org' });
  const component = database(adapter);
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => { requests.push({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) }); return Response.json({ message: 'Password updated' }); }));
  const port = databaseCredentialLifecycle(adapter)!;
  const target = await port.inspect(env, component, { environment: env.name, component: component.id, username: 'postgres', database: 'appdb' });
  expect(await port.rotate(env, component, target, 'new-password')).toMatchObject({ state: 'acknowledged' });
  expect(requests).toEqual([{ path: '/v1/projects/native-db/database/password', method: 'PATCH', body: { password: 'new-password' } }]);
});

it.each(['fly', 'digitalocean'] as const)('%s recovers the exact provider-generated password without another reset', async provider => {
  const adapter = provider === 'fly' ? new FlyDatabaseAdapter() : new DigitalOceanDatabaseAdapter();
  await adapter.connect(provider === 'fly' ? { apiToken: 'flyv1-synthetic', organizationSlug: 'org' } : { apiToken: 'dop_v1_synthetic' });
  const component = database(adapter, 'native-db', 'app-user');
  let password = 'old'; let resets = 0;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') { resets++; password = 'provider-generated-password'; throw new Error('lost acknowledgement'); }
    expect(url.pathname).toBe(provider === 'fly' ? '/v1/postgres/native-db/users/app-user/credentials' : '/v2/databases/native-db/users/app-user');
    return Response.json(provider === 'fly' ? { data: { username: 'app-user', password } } : { user: { name: 'app-user', password } });
  }));
  const port = databaseCredentialLifecycle(adapter)!;
  const target = await port.inspect(env, component, { environment: env.name, component: component.id, username: 'app-user', database: 'appdb' });
  expect(target.inputMode).toBe('provider-generated');
  expect(await port.readCurrent(env, component, target)).toBe('old');
  expect(await port.rotate(env, component, target)).toEqual({ state: 'unknown' });
  expect(await port.readCurrent(env, component, target)).toBe('provider-generated-password');
  expect(resets).toBe(1);
});

it('RDS changes the master authentication and refuses unrelated pending modifications', async () => {
  const adapter = new RdsAdapter();
  await adapter.connect({ accessKeyId: 'AKIASYNTHETIC', secretAccessKey: 'synthetic', region: 'us-east-1' });
  const component = database(adapter, 'native-db', 'app-user');
  let pending: Record<string, unknown> = {};
  const send = vi.spyOn(RDSClient.prototype, 'send').mockImplementation(async command => {
    const name = command.constructor.name;
    if (name === 'DescribeDBInstancesCommand') return { DBInstances: [{ DBInstanceIdentifier: 'native-db', MasterUsername: 'app-user', PendingModifiedValues: pending }] };
    expect(name).toBe('ModifyDBInstanceCommand');
    expect((command as any).input).toEqual({ DBInstanceIdentifier: 'native-db', MasterUserPassword: 'frozen-password', ApplyImmediately: true });
    return { DBInstance: { DBInstanceIdentifier: 'native-db' } };
  });
  const port = databaseCredentialLifecycle(adapter)!;
  const target = await port.inspect(env, component, { environment: env.name, component: component.id, username: 'app-user', database: 'appdb' });
  expect(await port.rotate(env, component, target, 'frozen-password')).toEqual({ state: 'acknowledged' });
  pending = { DBInstanceClass: 'db.m7g.large' };
  const before = send.mock.calls.length;
  expect(await port.rotate(env, component, target, 'frozen-password')).toEqual({ state: 'blocked' });
  expect(send.mock.calls.slice(before).every(([command]) => command.constructor.name === 'DescribeDBInstancesCommand')).toBe(true);
});

it('Cloud SQL sends a password-only exact user update and verifies its operation identity', async () => {
  const adapter = new CloudSqlAdapter();
  await adapter.connect({ projectId: 'cloud-project', region: 'us-central1', credentials: '{}' });
  vi.spyOn(adapter as any, 'getAccessToken').mockResolvedValue('synthetic-token');
  const component = database(adapter, 'native-db', 'app-user');
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ name: 'password-operation', targetProject: 'cloud-project', targetId: 'native-db', status: 'DONE' });
  }));
  const port = databaseCredentialLifecycle(adapter)!;
  const target = await port.inspect(env, component, { environment: env.name, component: component.id, username: 'app-user', database: 'appdb' });
  expect(await port.rotate(env, component, target, 'frozen-password')).toEqual({ state: 'acknowledged', operationId: 'password-operation' });
  expect(calls[0]).toEqual({ url: 'https://sqladmin.googleapis.com/v1/projects/cloud-project/instances/native-db/users?name=app-user', method: 'PUT', body: { name: 'app-user', password: 'frozen-password' } });
});

it('Azure updates only the exact administrator password on the accepted server', async () => {
  const adapter = new AzurePostgresAdapter();
  await adapter.connect({ tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId: '22222222-2222-4222-8222-222222222222', clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'synthetic' });
  const externalId = '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/group/providers/Microsoft.DBforPostgreSQL/flexibleServers/db';
  const component = database(adapter, externalId, 'app-user');
  const mutations: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.host === 'login.microsoftonline.com') return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
    expect(url.pathname).toBe(externalId);
    if (init?.method === 'PATCH') mutations.push(JSON.parse(String(init.body)));
    return Response.json({ id: externalId, name: 'db', properties: { administratorLogin: 'app-user', state: 'Ready' } });
  }));
  const port = databaseCredentialLifecycle(adapter)!;
  const target = await port.inspect(env, component, { environment: env.name, component: component.id, username: 'app-user', database: 'appdb' });
  expect(await port.rotate(env, component, target, 'frozen-password')).toEqual({ state: 'acknowledged' });
  expect(mutations).toEqual([{ properties: { administratorLoginPassword: 'frozen-password' } }]);
});

it('Cloud SQL does not accept completion belonging to a different database operation', async () => {
  const adapter = new CloudSqlAdapter();
  await adapter.connect({ projectId: 'cloud-project', region: 'us-central1', credentials: '{}' });
  vi.spyOn(adapter as any, 'getAccessToken').mockResolvedValue('synthetic-token');
  const component = database(adapter, 'native-db', 'app-user');
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => Response.json(init?.method === 'PUT'
    ? { name: 'password-operation', targetProject: 'cloud-project', targetId: 'native-db', status: 'PENDING' }
    : { name: 'other-operation', targetProject: 'other-project', targetId: 'other-db', status: 'DONE' })));
  const port = databaseCredentialLifecycle(adapter)!;
  const target = await port.inspect(env, component, { environment: env.name, component: component.id, username: 'app-user', database: 'appdb' });
  expect(await port.rotate(env, component, target, 'frozen-password')).toEqual({ state: 'unknown' });
});

it('RDS serializes the real AWS Query contract for the exact frozen master password', async () => {
  const adapter = new RdsAdapter();
  await adapter.connect({ accessKeyId: 'AKIASYNTHETIC', secretAccessKey: 'synthetic', region: 'us-east-1' });
  const component = database(adapter, 'native-db', 'app-user');
  const mutations: URLSearchParams[] = [];
  (adapter as any).rds = new RDSClient({ region: 'us-east-1', credentials: { accessKeyId: 'AKIASYNTHETIC', secretAccessKey: 'synthetic' }, requestHandler: {
    handle: async (request: any) => {
      const body = new URLSearchParams(request.body); const action = body.get('Action');
      expect(body.get('Version')).toBe('2014-10-31'); expect(body.get('DBInstanceIdentifier')).toBe('native-db');
      let xml: string;
      if (action === 'DescribeDBInstances') xml = '<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances><DBInstance><DBInstanceIdentifier>native-db</DBInstanceIdentifier><MasterUsername>app-user</MasterUsername></DBInstance></DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>';
      else {
        expect(action).toBe('ModifyDBInstance'); mutations.push(body);
        xml = '<ModifyDBInstanceResponse><ModifyDBInstanceResult><DBInstance><DBInstanceIdentifier>native-db</DBInstanceIdentifier></DBInstance></ModifyDBInstanceResult></ModifyDBInstanceResponse>';
      }
      return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Readable.from([xml]) } };
    },
  } });
  const port = databaseCredentialLifecycle(adapter)!;
  const target = await port.inspect(env, component, { environment: env.name, component: component.id, username: 'app-user', database: 'appdb' });
  expect(await port.rotate(env, component, target, 'frozen&password')).toEqual({ state: 'acknowledged' });
  expect(Object.fromEntries(mutations[0])).toEqual({ Action: 'ModifyDBInstance', Version: '2014-10-31', DBInstanceIdentifier: 'native-db', MasterUserPassword: 'frozen&password', ApplyImmediately: 'true' });
});

it('RDS preserves Secrets Manager ownership and recovers a generated master password after a lost reset response', async () => {
  const adapter = new RdsAdapter();
  await adapter.connect({ accessKeyId: 'AKIASYNTHETIC', secretAccessKey: 'synthetic', region: 'us-east-1' });
  const component = database(adapter, 'native-db', 'app-user');
  component.bindings.providerScope = { accountId: '123456789012', region: 'us-east-1' };
  const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!synthetic';
  let password = 'old'; let resets = 0;
  vi.spyOn(RDSClient.prototype, 'send').mockImplementation(async function (this: RDSClient, command: any) {
    if (command.constructor.name === 'DescribeDBInstancesCommand') return { DBInstances: [{ DBInstanceIdentifier: 'native-db', MasterUsername: 'app-user', MasterUserSecret: { SecretArn: secretArn, SecretStatus: 'active' } }] };
    expect(command.input).toEqual({ DBInstanceIdentifier: 'native-db', RotateMasterUserPassword: true, ApplyImmediately: true });
    expect(await this.config.maxAttempts()).toBe(1);
    resets++; password = 'provider-generated-password'; throw new Error('lost response');
  });
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ SecretId: secretArn });
    return Response.json({ ARN: secretArn, VersionId: 'version-1', SecretString: JSON.stringify({ username: 'app-user', password }) });
  }));
  const port = databaseCredentialLifecycle(adapter)!;
  const target = await port.inspect(env, component, { environment: env.name, component: component.id, username: 'app-user', database: 'appdb' });
  expect(target.inputMode).toBe('provider-generated');
  expect(target.providerScope.masterUserSecretArn).toBe(secretArn);
  expect(await port.readCurrent(env, component, target)).toBe('old');
  expect(await port.rotate(env, component, target)).toEqual({ state: 'unknown' });
  expect(await port.readCurrent(env, component, target)).toBe('provider-generated-password');
  expect(resets).toBe(1);
});

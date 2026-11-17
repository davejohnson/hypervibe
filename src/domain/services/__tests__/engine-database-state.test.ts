import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
const engine = vi.hoisted(() => ({ inspectState: vi.fn() }));
vi.mock('../../../adapters/engine/opentofu/install.js', () => ({ ensureEngineBinary: async () => ({ ok: true, binary: '/synthetic/tofu' }), enginePluginCacheDir: () => '/synthetic/cache' }));
vi.mock('../../../adapters/engine/opentofu/engine.js', () => ({ OpenTofuEngine: class { inspectState = engine.inspectState; } }));
import { recoverEngineDatabaseBinding } from '../engine-database-state.service.js';
const project = { id: 'project-id', name: 'renamed-project' } as Project;
const environment = { id: 'environment-id', projectId: project.id, name: 'renamed-preview' } as Environment;
const aws = { accessKeyId: 'LOCALACCESSKEY1234', secretAccessKey: 'private-local-secret-value-32-characters', roleArn: 'arn:aws:iam::111122223333:role/hypervibe/hypervibe-deploy', accountId: '111122223333', region: 'us-west-2' };
const clusterArn = 'arn:aws:rds:us-west-2:111122223333:cluster:original-cluster';
const document = (resources: unknown[]) => ({ format_version: '1.0', values: { root_module: { resources } } });
const resource = (address: string, type: string, values: Record<string, unknown>) => ({ address, mode: 'managed', type, values });
let shared: unknown; let own: unknown; let calls: string[];
beforeEach(() => {
  calls = [];
  shared = document([resource('aws_rds_cluster.postgres', 'aws_rds_cluster', { arn: clusterArn, endpoint: 'original.cluster.us-west-2.rds.amazonaws.com' })]);
  own = document([resource('aws_lambda_function.web', 'aws_lambda_function', { environment: [{ variables: { HYPERVIBE_PARAMETER_PATH: '/hypervibe/environment-id/' } }] })]);
  engine.inspectState.mockImplementation(async ({ project: projectState, state }) => ({ ok: true, present: true, value: projectState(state.partition === 'project-shared' ? shared : own) }));
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async (request: any) => {
    calls.push(request.hostname);
    const xml = '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASSUMEDACCESSKEY123</AccessKeyId><SecretAccessKey>private-assumed-secret</SecretAccessKey><SessionToken>private-session-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>';
    const json = JSON.stringify({ Parameter: { Name: '/hypervibe/environment-id/DATABASE_URL', Value: 'postgresql://original_owner:private-runtime-password@original.cluster.us-west-2.rds.amazonaws.com:5432/original_database' } });
    return { response: { statusCode: 200, headers: { 'content-type': request.hostname.startsWith('sts.') ? 'text/xml' : 'application/x-amz-json-1.1' }, body: Readable.from([request.hostname.startsWith('sts.') ? xml : json]) } };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('recovers native AWS identity from exact shared state and the environment-owned runtime secret without deriving renamed names', async () => {
  const binding = await recoverEngineDatabaseBinding(project, environment, 'aws', aws);
  expect(binding).toEqual({ clusterArn, accountId: '111122223333', region: 'us-west-2', name: 'original_database', owner: 'original_owner' });
  expect(JSON.stringify(binding)).not.toContain('private-');
  expect(engine.inspectState.mock.calls.map(([request]) => request.state)).toContainEqual({ provider: 'aws', projectId: project.id, environmentId: environment.id, partition: 'environment' });
});
it('recovers worker-only AWS credential references without a web workload', async () => {
  own = document([resource('aws_ecs_task_definition.worker', 'aws_ecs_task_definition', { container_definitions: JSON.stringify([{ environment: [{ name: 'HYPERVIBE_PARAMETER_PATH', value: '/hypervibe/environment-id/' }] }]) })]);
  expect((await recoverEngineDatabaseBinding(project, environment, 'aws', aws)).name).toBe('original_database');
});
it.each(['duplicate', 'scope', 'missing-reference', 'other-environment'])('refuses %s state before retrieving any runtime credential', async variant => {
  if (variant === 'duplicate') shared = document([resource('aws_rds_cluster.postgres', 'aws_rds_cluster', {}), resource('aws_rds_cluster.postgres', 'aws_rds_cluster', {})]);
  if (variant === 'scope') shared = document([resource('aws_rds_cluster.postgres', 'aws_rds_cluster', { arn: clusterArn.replace('111122223333', '444455556666') })]);
  if (variant === 'missing-reference') own = document([]);
  if (variant === 'other-environment') own = document([resource('aws_lambda_function.web', 'aws_lambda_function', { environment: [{ variables: { HYPERVIBE_PARAMETER_PATH: '/hypervibe/another/' } }] })]);
  await expect(recoverEngineDatabaseBinding(project, environment, 'aws', aws)).rejects.toThrow();
  expect(calls.some(host => host.startsWith('ssm.'))).toBe(false);
});
it('recovers the Azure shared server and exact per-environment Key Vault reference', async () => {
  const subscriptionId = '11111111-1111-4111-8111-111111111111';
  const serverId = `/subscriptions/${subscriptionId}/resourceGroups/hv-original/providers/Microsoft.DBforPostgreSQL/flexibleServers/original`;
  const secretUrl = 'https://original-vault.vault.azure.net/secrets/original-environment-database-url';
  shared = document([resource('azurerm_postgresql_flexible_server.postgres', 'azurerm_postgresql_flexible_server', { id: serverId, fqdn: 'original.postgres.database.azure.com' })]);
  own = document([resource('azurerm_container_app.web', 'azurerm_container_app', { secret: [{ name: 'database-url', key_vault_secret_id: secretUrl }] })]);
  const connection = { tenantId: subscriptionId, subscriptionId, clientId: subscriptionId, deployPrincipalId: subscriptionId, clientSecret: 'private-client-secret', clientSecretExpiresAt: '2099-01-01T00:00:00Z', resourceGroup: 'hv-original', location: 'westus2' };
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    requests.push(String(input));
    return String(input).includes('login.microsoftonline.com') ? Response.json({ access_token: 'private-token' })
      : Response.json({ id: `${secretUrl}/version`, value: 'postgresql://original_owner:private-runtime-password@original.postgres.database.azure.com:5432/original_db' });
  }));
  const binding = await recoverEngineDatabaseBinding(project, environment, 'azure', connection);
  expect(binding).toEqual({ serverId, subscriptionId, resourceGroup: 'hv-original', host: 'original.postgres.database.azure.com', name: 'original_db', owner: 'original_owner', secretUrl });
  expect(requests.at(-1)).toBe(`${secretUrl}?api-version=7.4`); expect(JSON.stringify(binding)).not.toContain('private-');
});

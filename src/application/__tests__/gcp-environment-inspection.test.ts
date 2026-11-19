import { JWT } from 'google-auth-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '../../adapters/providers/gcp/gcs.adapter.js';
import { CloudSqlAdapter } from '../../adapters/providers/gcp/cloudsql.adapter.js';
import { registerHvDbTools } from '../../tools/hv-db.tools.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { registerConnectionsTools } from '../../tools/connections.tools.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import { registerLifecycleTools } from '../../tools/lifecycle.tools.js';
import { CommandRegistry } from '../commands.js';
import { createCommandContext } from '../context.js';

const remote = 'https://github.com/acme/app.git';
const selected = 'prod-hv-app';
const defaultId = 'staging-hv-app';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hv-inspect-gcp-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(join(directory, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(scopedProject?: string, declareTarget = true) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'inspect-app', defaultPlatform: 'cloudrun', gitRemoteUrl: remote });
  const spec = { version: 1, project: project.name, environments: {
    staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
    production: { hosting: { provider: 'cloudrun', ...(declareTarget ? { gcpProjectId: selected } : {}) }, services: { web: {} } },
  } };
  new ProjectSpecRepository().insert(project.id, 1, spec);
  for (const [name, projectId] of [['staging', defaultId], ['production', selected]] as const) {
    ctx.repos.environments.create({ projectId: project.id, name, platformBindings: { provider: 'cloudrun', projectId,
      environmentId: 'us-central1', region: 'us-central1', engine: { database: { instanceName: 'app-db' } } } });
  }
  const connect = (scope: string, projectId: string) => {
    const credentialsEncrypted = ctx.secretStore.encryptObject({ projectId, credentials: JSON.stringify({
      type: 'service_account', project_id: projectId, private_key: 'unused-test-key', client_email: `deployer@${projectId}.iam.gserviceaccount.com`,
    }) });
    for (const provider of ['cloudrun', 'cloudsql']) {
      const row = ctx.repos.connections.create({ provider, scope, credentialsEncrypted });
      ctx.repos.connections.updateStatus(row.id, 'verified');
    }
  };
  connect('acme/app', defaultId);
  if (scopedProject) connect('acme/app#gcp:' + selected, scopedProject);
  const read = vi.spyOn(CloudRunAdapter.prototype, 'observe').mockImplementation(async function(this: CloudRunAdapter) {
    return { provider: 'cloudrun', observedAt: new Date().toISOString(), projectExists: true,
      projectId: this.engineConnection().projectId, services: [], databases: [], partial: false, warnings: [] };
  });
  const commands = new CommandRegistry();
  registerLifecycleTools(commands, ctx);
  registerCoreTools(commands, ctx);
  registerConnectionsTools(commands, ctx);
  registerHvDbTools(commands, ctx);
  return {
    read,
    bucketContext: async () => {
      const environment = ctx.repos.environments.findByProjectAndName(project.id, 'production')!;
      const resolved = await ctx.adapterFactory.getStorageOperations('gcs', project, { environment });
      return resolved.adapter?.resolveObservationContext?.(project.name, environment, 'us-central1');
    },
    requirements: (environment: string) => commands.execute('hv_connections', { project: project.name, view: 'requirements', environment }),
    checklist: () => commands.execute('hv_spec', { project: project.name }),
    inspect: (env: string) => commands.execute('hv_inspect', { provider: 'cloudrun', project: project.name, env }),
    verify: (scope: string, withProject = true) => commands.execute('hv_inspect', {
      provider: 'cloudrun', resource: 'connection', scope, ...(withProject ? { project: project.name } : {}),
    }),
    query: (env: string) => commands.execute('hv_db_query', { project: project.name, env, sql: 'SELECT 1' }),
  };
}

it('inspects two Cloud Run environments through their respective Google projects', async () => {
  const { inspect } = fixture(selected);
  expect(await inspect('staging')).toMatchObject({ ok: true, data: { observed: { projectId: defaultId } } });
  expect(await inspect('production')).toMatchObject({ ok: true, data: { observed: { projectId: selected } } });
});

it.each([undefined, defaultId])('stops before reading when the selected project has missing or mismatched access (%s)', async projectId => {
  const { inspect, read } = fixture(projectId);
  expect(await inspect('production')).toMatchObject({ ok: false, error: { code: 'MISSING_CONNECTION' } });
  expect(read).not.toHaveBeenCalled();
});

it('reports missing production access independently of verified staging access', async () => {
  const { checklist } = fixture();
  expect(await checklist()).toMatchObject({ ok: true, data: { connections: {
    required: expect.arrayContaining([
      expect.objectContaining({ provider: 'cloudrun', status: 'verified', environments: ['staging'] }),
      expect.objectContaining({ provider: 'cloudrun', status: 'missing', environments: ['production'] }),
    ]),
  } } });
});

it.each([
  [undefined, 'missing'], [defaultId, 'unverified'], [selected, 'verified'],
])('checks the native project of filtered production requirements (%s)', async (credentialProject, status) => {
  const { requirements } = fixture(credentialProject);
  expect(await requirements('production')).toMatchObject({ ok: true, data: { connections: [
    { provider: 'cloudrun', scope: 'acme/app#gcp:' + selected, environments: ['production'], status },
  ] } });
});

it('opens the SQL connector with production credentials for the bound production instance', async () => {
  const { query } = fixture(selected);
  const connect = vi.spyOn(CloudSqlAdapter.prototype, 'connect');
  const acquire = vi.spyOn(CloudSqlAdapter.prototype, 'acquireTemporaryDatabaseAccess')
    .mockRejectedValue(new Error('Stopped at the SQL connector boundary.'));
  expect(await query('production')).toMatchObject({ ok: false, error: { message: expect.stringContaining('SQL connector boundary') } });
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ projectId: selected }));
  expect(acquire).toHaveBeenCalledOnce();
});

it('stops before opening a SQL connector when only staging has access', async () => {
  const { query } = fixture();
  const acquire = vi.spyOn(CloudSqlAdapter.prototype, 'acquireTemporaryDatabaseAccess');
  expect(await query('production')).toMatchObject({ ok: false, error: { code: 'MISSING_CONNECTION' } });
  expect(acquire).not.toHaveBeenCalled();
});

it('uses production’s verified Cloud Run connection to inspect the GCS project for backup reads', async () => {
  const { bucketContext } = fixture(selected);
  vi.spyOn(JWT.prototype, 'getAccessToken').mockImplementation(async () => ({ token: 'test-only' }));
  expect(await bucketContext()).toMatchObject({ receipt: { success: true }, context: { projectId: selected } });
});

it('verifies an explicit connection scope using only the matching repository and Google project', async () => {
  const { verify } = fixture(selected);
  const reads: string[] = [];
  vi.spyOn(CloudRunAdapter.prototype, 'verify').mockImplementation(async function(this: CloudRunAdapter) {
    reads.push(this.engineConnection().projectId);
    return { success: true };
  });
  expect(await verify('acme/app#gcp:' + selected)).toMatchObject({ ok: true });
  expect(reads).toEqual([selected]);
  for (const scope of ['acme/app#gcp:missing-project', 'elsewhere/app#gcp:' + selected]) {
    expect(await verify(scope)).toMatchObject({ ok: false });
  }
  expect(await verify('acme/app#gcp:' + selected, false)).toMatchObject({ ok: false });
  expect(reads).toEqual([selected]);
});

it('stops inspecting a bound production environment after its selector is removed', async () => {
  const { inspect, read } = fixture(selected, false);
  expect(await inspect('production')).toMatchObject({ ok: false, error: { code: 'MISSING_CONNECTION' } });
  expect(read).not.toHaveBeenCalled();
});

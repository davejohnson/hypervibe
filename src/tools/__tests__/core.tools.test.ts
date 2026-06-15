import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { hashEnvValue, type ObservedState } from '../../domain/ports/observe.port.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-core-tools-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const { createServer } = await import('../../server.js');
  const server = createServer();
  const client = new Client({ name: 'core-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content as Array<{ type: string; text: string }>)[0];
      return JSON.parse(content.text) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const SPEC = {
  project: 'core-spec-app',
  environments: {
    staging: {
      hosting: { provider: 'railway' },
      services: { web: { startCommand: 'npm start' } },
      envVars: { NODE_ENV: 'staging' },
    },
  },
};

describe('hv_spec_set / hv_spec_get', () => {
  it('creates a project, stores the spec, and bumps revisions on merge', async () => {
    const t = await makeClient();
    const set = await t.call('hv_spec_set', { spec: SPEC });
    expect(set.ok).toBe(true);
    expect(set.data.revision).toBe(1);
    expect(set.next).toContain('hv_plan');

    const merge = await t.call('hv_spec_set', {
      project: 'core-spec-app',
      spec: { environments: { staging: { services: { worker: { workloadKind: 'worker' } } } } },
    });
    expect(merge.data.revision).toBe(2);

    const get = await t.call('hv_spec_get', { project: 'core-spec-app' });
    expect(get.ok).toBe(true);
    expect(get.data.environments.staging.services).toEqual(['web', 'worker']);
    await t.close();
  });

  it('persists top-level gitRemoteUrl into project metadata', async () => {
    const t = await makeClient();
    const gitRemoteUrl = 'git@github.com:davejohnson/apreskeys.com.git';
    const set = await t.call('hv_spec_set', {
      spec: {
        ...SPEC,
        project: 'remote-spec-app',
        gitRemoteUrl,
      },
    });
    expect(set.ok).toBe(true);
    expect(set.data.project.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(new ProjectRepository().findByName('remote-spec-app')!.gitRemoteUrl).toBe(gitRemoteUrl);

    const get = await t.call('hv_spec_get', { project: 'remote-spec-app' });
    expect(get.ok).toBe(true);
    expect(get.data.project.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(get.data.projectMeta.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(get.data.spec.gitRemoteUrl).toBe(gitRemoteUrl);
    await t.close();
  });

  it('syncs gitRemoteUrl from a merge patch into an existing project', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    const gitRemoteUrl = 'https://github.com/davejohnson/apreskeys.com.git';

    const merge = await t.call('hv_spec_set', {
      project: 'core-spec-app',
      spec: { gitRemoteUrl },
    });
    expect(merge.ok).toBe(true);
    expect(merge.data.project.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(new ProjectRepository().findByName('core-spec-app')!.gitRemoteUrl).toBe(gitRemoteUrl);
    await t.close();
  });

  it('rejects invalid specs with field-level details', async () => {
    const t = await makeClient();
    const bad = await t.call('hv_spec_set', {
      spec: {
        project: 'bad-app',
        environments: { staging: { hosting: { provider: 'railway' }, services: { job: { workloadKind: 'cron' } } } },
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('VALIDATION');
    expect(JSON.stringify(bad.error.details)).toContain('cronSchedule');
    await t.close();
  });

  it('rejects unknown hosting providers with the available list', async () => {
    const t = await makeClient();
    const bad = await t.call('hv_spec_set', {
      spec: {
        project: 'bad-provider-app',
        environments: { staging: { hosting: { provider: 'definitely-not-real' }, services: {} } },
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('VALIDATION');
    expect(bad.hint).toContain('railway');
    await t.close();
  });
});

describe('hv_plan / hv_status / hv_apply', () => {
  function verifyConnection(provider: string) {
    const repo = new ConnectionRepository();
    const conn = repo.create({ provider, credentialsEncrypted: 'x' });
    repo.updateStatus(conn.id, 'verified');
  }

  function verifyRailwayConnection() {
    verifyConnection('railway');
  }

  function mockObserved(observed: ObservedState | null) {
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue(
      observed
        ? {
          success: true,
          adapter: {
            name: 'railway',
            capabilities: {
              supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
              supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
              supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
              supportsObserve: true,
            },
            connect: async () => {}, verify: async () => ({ success: true }),
            ensureProject: async () => ({ success: true, message: 'ok' }),
            ensureComponent: async () => { throw new Error('unused'); },
            deploy: async () => { throw new Error('unused'); },
            setEnvVars: async () => ({ success: true, message: 'ok' }),
            observe: async () => observed,
          },
        }
        : { success: false, error: 'no adapter' }
    );
  }

  it('plans creates for a fresh environment and blocks without connections', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    mockObserved(null);

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });
    expect(plan.ok).toBe(true);
    expect(plan.data.verified).toBe(false);
    expect(plan.data.summary.create).toBeGreaterThan(0);
    expect(plan.data.blocked).toContainEqual(expect.objectContaining({ provider: 'railway' }));
    expect(plan.hint).toContain('hv_connect');
    await t.close();
  });

  it('reports drift via hv_status against observed state', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    verifyRailwayConnection();
    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: { web: { serviceId: 's-1' } } },
    });
    mockObserved({
      provider: 'railway', observedAt: new Date().toISOString(),
      projectExists: true, projectId: 'rp-1',
      services: [{
        name: 'web', externalId: 's-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'node legacy.js' },
        envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [], partial: false, warnings: [],
    });

    const status = await t.call('hv_status', { project: 'core-spec-app', env: 'staging' });
    expect(status.ok).toBe(true);
    expect(status.data.verified).toBe(true);
    expect(status.data.inSync).toBe(false);
    const drift = status.data.drift.find((a: { id: string }) => a.id === 'service:web');
    expect(drift.type).toBe('update');
    await t.close();
  });

  it('rejects hv_apply when the spec changed after planning', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    verifyRailwayConnection();
    mockObserved(null);

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });
    expect(plan.ok).toBe(true);

    // Supersede the spec
    await t.call('hv_spec_set', {
      project: 'core-spec-app',
      spec: { environments: { staging: { envVars: { EXTRA: '1' } } } },
    });

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(false);
    expect(apply.error.message).toContain('Re-run hv_plan');
    await t.close();
  });

  it('refuses to apply without verified connections', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    mockObserved(null);
    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(false);
    expect(apply.error.code).toBe('MISSING_CONNECTION');
    await t.close();
  });

  it('destroys a locally managed provider service that was removed from the spec', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    verifyRailwayConnection();

    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const { ServiceRepository } = await import('../../adapters/db/repositories/service.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: {
          web: { serviceId: 's-web' },
          daily: { serviceId: 's-daily' },
        },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'daily',
      buildConfig: { workloadKind: 'cron', cronSchedule: '0 8 * * *' },
    });

    const observedState: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [
        {
          name: 'web', externalId: 's-web', workloadKind: 'web', customDomains: [],
          config: { startCommand: 'npm start' },
          envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        },
        {
          name: 'daily', externalId: 's-daily', workloadKind: 'cron', customDomains: [],
          config: { startCommand: 'npm run cron', cronSchedule: '0 8 * * *' },
          envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        },
      ],
      databases: [],
      partial: false,
      warnings: [],
    };
    const deleteService = vi.fn(async () => ({ success: true }));
    const adapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {}, verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('hosting deploy should not run for service destroy'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      observe: async () => observedState,
      deleteService,
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter } as any);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter } as any);

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'service:daily:destroy',
      type: 'destroy',
    }));
    expect(plan.data.unmanaged).not.toContainEqual(expect.objectContaining({ kind: 'service', name: 'daily' }));

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(deleteService).toHaveBeenCalledWith('s-daily');
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:daily:destroy',
      status: 'succeeded',
    }));

    const updatedEnvironment = new EnvironmentRepository().findById(environment.id)!;
    const services = updatedEnvironment.platformBindings.services as Record<string, unknown>;
    expect(services).toMatchObject({ web: { serviceId: 's-web' } });
    expect(services.daily).toBeUndefined();
    expect(new ServiceRepository().findByProjectAndName(project.id, 'daily')).toBeNull();
    await t.close();
  });

  it('creates a replacement database without deploying or destroying the old database in the same apply', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'core-spec-app',
        environments: {
          production: {
            hosting: { provider: 'cloudrun' },
            services: { web: { startCommand: 'npm start' } },
            database: { provider: 'supabase' },
            envVars: { NODE_ENV: 'production' },
          },
        },
      },
    });
    verifyConnection('cloudrun');
    verifyConnection('supabase');

    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const { ComponentRepository } = await import('../../adapters/db/repositories/component.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    const now = new Date();
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'cloudsql-1',
      bindings: {
        provider: 'cloudsql',
        instanceId: 'cloudsql-1',
        connectionUrl: 'postgres://old-cloudsql',
        connectionName: 'gcp-project:us-central1:app',
      },
    });

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'cloudrun',
        capabilities: {
          supportedBuilders: ['dockerfile'], supportedComponents: [],
          supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
          supportsReleaseCommand: false, supportsMultiEnvironment: false, managedTls: true,
          supportsObserve: true,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        ensureProject: async () => ({ success: true, message: 'ok' }),
        ensureComponent: async () => { throw new Error('unused'); },
        deploy: async () => { throw new Error('hosting deploy should not run'); },
        observe: async () => ({
          provider: 'cloudrun',
          observedAt: new Date().toISOString(),
          projectExists: true,
          projectId: 'gcp-project',
          environmentId: 'production',
          services: [{
            name: 'web', externalId: 'gcp-project-web', workloadKind: 'web', customDomains: [],
            config: { startCommand: 'npm start' },
            envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('production') },
            status: 'running',
          }],
          databases: [{ provider: 'cloudsql', engine: 'postgres', externalId: 'cloudsql-1', status: 'running' }],
          partial: false,
          warnings: [],
        }),
      },
    } as any);
    const provision = vi.fn(async (_type: string, env: { id: string }) => ({
      component: {
        id: 'supabase-component',
        environmentId: env.id,
        type: 'postgres',
        externalId: 'supabase-1',
        bindings: {
          provider: 'supabase',
          instanceId: 'supabase-1',
          connectionUrl: 'postgres://new-supabase',
          host: 'db.supabase.co',
          port: 5432,
          username: 'postgres',
          password: 'pw',
          database: 'postgres',
        },
        createdAt: now,
        updatedAt: now,
      },
      receipt: { success: true, message: 'Provisioned Supabase Postgres' },
      connectionUrl: 'postgres://new-supabase',
      envVars: { DATABASE_URL: 'postgres://new-supabase', DATABASE_SSL: 'true' },
    }));
    const destroy = vi.fn(async () => ({ success: true, message: 'destroyed' }));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'supabase',
        capabilities: {
          supportedDatabases: ['postgres'], supportedCaches: [],
          supportsPooling: true, supportsReadReplicas: false,
          supportsPointInTimeRecovery: false, serverlessOptimized: true,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        provision,
        getConnectionUrl: async () => 'postgres://new-supabase',
        destroy,
      },
    } as any);
    const hostingSpy = vi.spyOn(adapterFactory, 'getHostingAdapter').mockRejectedValue(new Error('hosting should not run'));

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({ id: 'database:supabase', type: 'create' }));
    expect(plan.data.actions.find((action: { id: string }) => action.id === 'database:cloudsql:destroy')).toBeUndefined();

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'database:supabase',
      status: 'succeeded',
    }));
    expect(provision).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(hostingSpy).not.toHaveBeenCalled();

    const component = new ComponentRepository().findByEnvironmentAndType(environment.id, 'postgres')!;
    expect(component.bindings.provider).toBe('supabase');
    expect(component.bindings.previousProvider).toBe('cloudsql');
    expect(component.bindings.previousExternalId).toBe('cloudsql-1');
    expect(component.bindings.previousBindings).toMatchObject({
      provider: 'cloudsql',
      connectionUrl: 'postgres://old-cloudsql',
    });
    await t.close();
  });
});

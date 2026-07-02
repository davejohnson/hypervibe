import { describe, expect, it } from 'vitest';
import { diffEnvironment, confirmGatedActionIds } from '../diff.engine.js';
import { hashEnvValue, type ObservedState, type ObservedService } from '../../ports/observe.port.js';
import { environmentSpecSchema, type EnvironmentSpec } from '../../spec/spec.schema.js';
import type { LocalSnapshot } from '../plan.types.js';
import type { Service } from '../../entities/service.entity.js';

function spec(overrides: Record<string, unknown> = {}): EnvironmentSpec {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    services: { web: { startCommand: 'npm start', healthCheckPath: '/health', public: true } },
    database: { provider: 'railway' },
    envVars: { NODE_ENV: 'production' },
    ...overrides,
  });
}

function observedWeb(overrides: Partial<ObservedService> = {}): ObservedService {
  return {
    name: 'web',
    externalId: 'svc-1',
    workloadKind: 'web',
    url: 'https://web.up.railway.app',
    customDomains: [],
    config: { startCommand: 'npm start', healthCheckPath: '/health', public: true },
    envVarKeys: ['NODE_ENV'],
    envVarHashes: { NODE_ENV: hashEnvValue('production') },
    status: 'running',
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    projectId: 'rail-proj-1',
    environmentId: 'rail-env-1',
    services: [observedWeb()],
    databases: [{ provider: 'railway', engine: 'postgres', externalId: 'db-1', status: 'running' }],
    partial: false,
    warnings: [],
    ...overrides,
  };
}

function localService(name: string): Service {
  return {
    id: `local-${name}`,
    projectId: 'p1',
    name,
    buildConfig: {},
    envVarSpec: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function local(overrides: Partial<LocalSnapshot> = {}): LocalSnapshot {
  return {
    projectExists: true,
    environmentExists: true,
    services: [localService('web')],
    components: [],
    bindings: {
      provider: 'railway',
      projectId: 'rail-proj-1',
      environmentId: 'rail-env-1',
      services: { web: { serviceId: 'svc-1' } },
    },
    ...overrides,
  };
}

describe('diffEnvironment — in sync', () => {
  it('returns noops when everything matches', () => {
    const result = diffEnvironment({ spec: spec(), envName: 'production', observed: observed(), local: local() });
    expect(result.actions.every((a) => a.type === 'noop')).toBe(true);
    expect(result.actions.every((a) => a.verified)).toBe(true);
    expect(result.unmanaged).toEqual([]);
  });
});

describe('diffEnvironment — creates', () => {
  it('creates project and services when nothing exists', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'staging',
      observed: observed({ projectExists: false, services: [], databases: [] }),
      local: local({ bindings: undefined, services: [], components: [] }),
    });
    const byId = new Map(result.actions.map((a) => [a.id, a]));
    expect(byId.get('project:railway')?.type).toBe('create');
    expect(byId.get('service:web')?.type).toBe('create');
    expect(byId.get('service:web')?.dependsOn).toEqual(['project:railway']);
    expect(byId.get('database:railway')?.type).toBe('create');
  });
});

describe('diffEnvironment — config drift', () => {
  it('detects changed startCommand and missing env var', () => {
    const live = observedWeb({
      config: { startCommand: 'node old.js', healthCheckPath: '/health', public: true },
      envVarKeys: [],
      envVarHashes: {},
    });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.verified).toBe(true);
    expect(web.diff).toContainEqual({ field: 'startCommand', from: 'node old.js', to: 'npm start' });
    expect(web.diff).toContainEqual({ field: 'env:NODE_ENV' });
  });

  it('detects env var drift by hash without exposing values', () => {
    const live = observedWeb({ envVarHashes: { NODE_ENV: hashEnvValue('staging') } });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    const envDiff = web.diff!.find((d) => d.field === 'env:NODE_ENV')!;
    expect(envDiff.from).toBeUndefined();
    expect(envDiff.to).toBeUndefined();
  });

  it('detects managed database env var drift after a database component exists', () => {
    const live = observedWeb({
      envVarKeys: ['NODE_ENV', 'DATABASE_URL'],
      envVarHashes: {
        NODE_ENV: hashEnvValue('production'),
        DATABASE_URL: hashEnvValue('postgres://old'),
      },
    });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
      managedDatabaseEnvVars: {
        DATABASE_URL: 'postgres://new',
        DATABASE_SSL: 'true',
      },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.diff).toContainEqual({ field: 'env:DATABASE_URL' });
    expect(web.diff).toContainEqual({ field: 'env:DATABASE_SSL' });
  });

  it('merges managed queue env vars into the desired env, with spec.envVars winning on conflict', () => {
    const live = observedWeb({
      envVarKeys: ['NODE_ENV', 'QUEUE_BACKEND', 'QUEUE_NAMES'],
      envVarHashes: {
        NODE_ENV: hashEnvValue('production'),
        QUEUE_BACKEND: hashEnvValue('pubsub'),
        // Live matches the spec override, not the managed queue value.
        QUEUE_NAMES: hashEnvValue('spec-wins'),
      },
    });
    const result = diffEnvironment({
      spec: spec({ envVars: { NODE_ENV: 'production', QUEUE_NAMES: 'spec-wins' } }),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
      managedQueueEnvVars: {
        QUEUE_BACKEND: 'pubsub',
        QUEUE_NAMES: 'email-jobs',
        QUEUE_TOPIC_EMAIL_JOBS: 'projects/gcp-project/topics/gcp-project-email-jobs',
      },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    // Queue-only var missing live → drift.
    expect(web.diff).toContainEqual({ field: 'env:QUEUE_TOPIC_EMAIL_JOBS' });
    // spec.envVars wins over managedQueueEnvVars, so QUEUE_NAMES is in sync.
    expect(web.diff).not.toContainEqual({ field: 'env:QUEUE_NAMES' });
    expect(web.diff).not.toContainEqual({ field: 'env:QUEUE_BACKEND' });
  });

  it('ignores config fields the spec does not manage', () => {
    const minimal = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { web: {} },
    });
    const live = observedWeb({ config: { startCommand: 'whatever', public: false } });
    const result = diffEnvironment({
      spec: minimal,
      envName: 'production',
      observed: observed({ services: [live], databases: [] }),
      local: local(),
    });
    expect(result.actions.find((a) => a.id === 'service:web')!.type).toBe('noop');
  });
});

describe('diffEnvironment — provider switches', () => {
  it('creates the new database without destroying the old one in the initial provider change plan', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'cloudsql' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
    });
    const create = result.actions.find((a) => a.id === 'database:cloudsql')!;
    expect(create.type).toBe('create');
    expect(create.reason).toContain('Create the new database first');
    expect(result.actions.find((a) => a.id === 'database:railway:destroy')).toBeUndefined();
    expect(confirmGatedActionIds(result.actions)).toEqual([]);
  });

  it('emits confirm-gated destroy for the previous database after cutover is recorded', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'supabase' } }),
      envName: 'production',
      observed: observed({
        databases: [{ provider: 'supabase', engine: 'postgres', externalId: 'supabase-1', status: 'running' }],
      }),
      local: local({
        components: [{
          id: 'c1', environmentId: 'e1', type: 'postgres',
          bindings: { provider: 'supabase', previousProvider: 'cloudsql' }, externalId: 'supabase-1',
          createdAt: new Date(), updatedAt: new Date(),
        }],
      }),
    });
    const create = result.actions.find((a) => a.id === 'database:supabase')!;
    const destroy = result.actions.find((a) => a.id === 'database:cloudsql:destroy')!;
    expect(create.type).toBe('noop');
    expect(destroy.type).toBe('destroy');
    expect(destroy.dataBearing).toBe(true);
    expect(destroy.requiresConfirm).toBe(true);
    expect(destroy.reason).toContain('confirm only after cutover is verified');
    expect(confirmGatedActionIds(result.actions)).toEqual(['database:cloudsql:destroy']);
  });

  it('replaces services when the hosting provider changes', () => {
    const result = diffEnvironment({
      spec: spec({ hosting: { provider: 'cloudrun' }, database: { provider: 'cloudsql' } }),
      envName: 'production',
      observed: null,
      local: local(),
    });
    const byId = new Map(result.actions.map((a) => [a.id, a]));
    expect(byId.get('project:cloudrun')?.type).toBe('create');
    const web = byId.get('service:web')!;
    expect(web.type).toBe('replace');
    expect(web.reason).toContain('railway');
    expect(web.dependsOn).toEqual(['project:cloudrun']);
  });

  it('confirm-gates destroy when the database is removed from the spec', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({ databases: [] }),
      local: local({
        components: [{
          id: 'c1', environmentId: 'e1', type: 'postgres',
          bindings: { provider: 'railway' }, externalId: 'db-1',
          createdAt: new Date(), updatedAt: new Date(),
        }],
      }),
    });
    const destroy = result.actions.find((a) => a.id === 'database:railway:destroy')!;
    expect(destroy.requiresConfirm).toBe(true);
    expect(destroy.dataBearing).toBe(true);
  });
});

describe('diffEnvironment — unverified fallback', () => {
  it('marks all actions unverified when observe is unavailable', () => {
    const result = diffEnvironment({ spec: spec(), envName: 'staging', observed: null, local: local() });
    expect(result.actions.every((a) => a.verified === false)).toBe(true);
    expect(result.actions.find((a) => a.id === 'service:web')!.type).toBe('noop');
  });

  it('creates unbound services from local state', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'staging',
      observed: null,
      local: local({ bindings: { provider: 'railway', projectId: 'rail-proj-1', services: {} } }),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('create');
    expect(web.verified).toBe(false);
  });
});

describe('diffEnvironment — unmanaged resources', () => {
  it('reports live services and databases absent from the spec, never destroys them', () => {
    const rogue = observedWeb({ name: 'legacy-worker', externalId: 'svc-9' });
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({ services: [observedWeb(), rogue] }),
      local: local(),
    });
    expect(result.unmanaged).toContainEqual(
      expect.objectContaining({ kind: 'service', name: 'legacy-worker' })
    );
    // observed db exists but no local component → unmanaged, not destroy
    expect(result.unmanaged).toContainEqual(expect.objectContaining({ kind: 'database', name: 'postgres' }));
    expect(result.actions.filter((a) => a.type === 'destroy')).toEqual([]);
  });

  it('plans destroy for services removed from the spec when local bindings prove ownership', () => {
    const removed = observedWeb({ name: 'daily', externalId: 'svc-daily', workloadKind: 'cron' });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [observedWeb(), removed] }),
      local: local({
        services: [localService('web'), localService('daily')],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'svc-1' }, daily: { serviceId: 'svc-daily' } },
        },
      }),
    });

    expect(result.unmanaged).not.toContainEqual(expect.objectContaining({ kind: 'service', name: 'daily' }));
    expect(result.actions).toContainEqual(expect.objectContaining({
      id: 'service:daily:destroy',
      type: 'destroy',
      resource: expect.objectContaining({ kind: 'service', name: 'daily', provider: 'railway' }),
      verified: true,
    }));
  });

  it('plans unverified destroy for locally bound services removed from the spec when observation is unavailable', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: null,
      local: local({
        services: [localService('web'), localService('daily')],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'svc-1' }, daily: { serviceId: 'svc-daily' } },
        },
      }),
    });

    expect(result.actions).toContainEqual(expect.objectContaining({
      id: 'service:daily:destroy',
      type: 'destroy',
      verified: false,
    }));
  });
});

describe('diffEnvironment — domain and workload', () => {
  it('updates when the domain is not attached and noops when it is', () => {
    const withDomain = spec({ domain: 'myapp.dev' });
    const detached = diffEnvironment({ spec: withDomain, envName: 'production', observed: observed(), local: local() });
    expect(detached.actions.find((a) => a.id === 'domain:myapp.dev')!.type).toBe('update');

    const attached = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: { 'myapp.dev': { dnsConfigured: true } },
        })],
      }),
      local: local(),
    });
    expect(attached.actions.find((a) => a.id === 'domain:myapp.dev')!.type).toBe('noop');
  });

  it('updates when a provider-attached domain has no observed verification status', () => {
    const withDomain = spec({ domain: 'myapp.dev' });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({ services: [observedWeb({ customDomains: ['myapp.dev'] })] }),
      local: local(),
    });

    const domain = result.actions.find((a) => a.id === 'domain:myapp.dev')!;
    expect(domain.type).toBe('update');
    expect(domain.reason).toContain('provider verification status was not observed');
  });

  it('updates when the domain is attached but provider DNS is not configured', () => {
    const withDomain = spec({ domain: 'myapp.dev' });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': {
              dnsConfigured: false,
              dnsRecords: [
                {
                  name: '_railway.myapp.dev',
                  type: 'TXT',
                  value: 'verify-token',
                  status: 'DNS_RECORD_STATUS_PENDING',
                },
              ],
            },
          },
        })],
      }),
      local: local(),
    });

    const domain = result.actions.find((a) => a.id === 'domain:myapp.dev')!;
    expect(domain.type).toBe('update');
    expect(domain.reason).toContain('required DNS records are not configured');
    expect(domain.metadata?.dnsRecords).toEqual([
      expect.objectContaining({ name: '_railway.myapp.dev', type: 'TXT' }),
    ]);
  });

  it('replaces a service whose cron-ness changed', () => {
    const cronSpec = spec({ services: { web: { workloadKind: 'cron', cronSchedule: '0 3 * * *' } } });
    const result = diffEnvironment({ spec: cronSpec, envName: 'production', observed: observed(), local: local() });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('replace');
    expect(web.diff).toContainEqual({ field: 'workloadKind', from: 'web', to: 'cron' });
  });

  it('treats web<->worker as an update on providers that observe the kind', () => {
    const workerSpec = spec({
      hosting: { provider: 'cloudrun' },
      services: { web: { workloadKind: 'worker', startCommand: 'npm start', healthCheckPath: '/health', public: true } },
    });
    const result = diffEnvironment({
      spec: workerSpec,
      envName: 'production',
      observed: observed({ provider: 'cloudrun' }),
      local: local({
        bindings: {
          provider: 'cloudrun',
          projectId: 'gcp-proj-1',
          services: { web: { serviceId: 'svc-1' } },
        },
      }),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.diff).toContainEqual({ field: 'workloadKind', from: 'web', to: 'worker' });
  });

  it('skips the web<->worker field diff on railway, whose observe cannot distinguish them', () => {
    const workerSpec = spec({
      services: { web: { workloadKind: 'worker', startCommand: 'npm start', healthCheckPath: '/health', public: true } },
    });
    const result = diffEnvironment({ spec: workerSpec, envName: 'production', observed: observed(), local: local() });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('noop');
  });
});

describe('diffEnvironment — deploy source', () => {
  it('warns when a railway spec has services but deploy.strategy is not "branch"', () => {
    const result = diffEnvironment({ spec: spec(), envName: 'production', observed: observed(), local: local() });
    expect(result.warnings.some((w) => w.includes('NO CODE WILL BE DEPLOYED'))).toBe(true);

    const manual = diffEnvironment({
      spec: spec({ deploy: { strategy: 'manual' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
    });
    expect(manual.warnings.some((w) => w.includes('NO CODE WILL BE DEPLOYED'))).toBe(true);

    const branch = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
    });
    expect(branch.warnings.some((w) => w.includes('NO CODE WILL BE DEPLOYED'))).toBe(false);
  });

  it('flags a live service that has never deployed as drift, not converged', () => {
    const live = observedWeb({ status: 'empty' });
    const result = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('no code deployed');
  });

  it('flags a missing deploy source as drift when strategy is branch', () => {
    const result = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('Deploy source is not connected');
  });

  it('flags branch mismatch and accepts matching sources in any repo format', () => {
    const linked = observedWeb({ source: { repo: 'https://github.com/Dave/Seq-Planner.git', branch: 'main' } });
    const matching = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed({ services: [linked] }),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    expect(matching.actions.find((a) => a.id === 'service:web')!.type).toBe('noop');

    const wrongBranch = observedWeb({ source: { repo: 'dave/seq-planner', branch: 'develop' } });
    const mismatch = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed({ services: [wrongBranch] }),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    const web = mismatch.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('branch is develop, expected main');
  });

  it('flags a linked source with an unknown branch so apply reconnects it', () => {
    const linkedWithoutBranch = observedWeb({ source: { repo: 'dave/seq-planner' } });
    const result = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed({ services: [linkedWithoutBranch] }),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('branch is not recorded');
  });

  it('ignores deploy source when strategy is not branch', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed(),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    expect(result.actions.find((a) => a.id === 'service:web')!.type).toBe('noop');
  });

  it('combines no-code drift with configuration drift in one update action', () => {
    const live = observedWeb({
      status: 'empty',
      config: { startCommand: 'node old.js', healthCheckPath: '/health', public: true },
    });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('no code deployed');
    expect(web.reason).toContain('Configuration drift');
    expect(web.diff).toContainEqual({ field: 'startCommand', from: 'node old.js', to: 'npm start' });
  });
});

describe('diffEnvironment — partial observation', () => {
  it('surfaces warnings when observation is partial', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ partial: true, warnings: ['env var read failed for web'] }),
      local: local(),
    });
    expect(result.warnings).toContain('env var read failed for web');
    expect(result.warnings.some((w) => w.includes('partial'))).toBe(true);
  });
});

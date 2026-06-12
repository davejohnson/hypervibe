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
  it('emits confirm-gated destroy for database provider change, ordered after create', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'cloudsql' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
    });
    const create = result.actions.find((a) => a.id === 'database:cloudsql')!;
    const destroy = result.actions.find((a) => a.id === 'database:railway:destroy')!;
    expect(create.type).toBe('create');
    expect(destroy.type).toBe('destroy');
    expect(destroy.dataBearing).toBe(true);
    expect(destroy.requiresConfirm).toBe(true);
    expect(destroy.dependsOn).toEqual(['database:cloudsql']);
    expect(confirmGatedActionIds(result.actions)).toEqual(['database:railway:destroy']);
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
});

describe('diffEnvironment — domain and workload', () => {
  it('updates when the domain is not attached and noops when it is', () => {
    const withDomain = spec({ domain: 'myapp.dev' });
    const detached = diffEnvironment({ spec: withDomain, envName: 'production', observed: observed(), local: local() });
    expect(detached.actions.find((a) => a.id === 'domain:myapp.dev')!.type).toBe('update');

    const attached = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({ services: [observedWeb({ customDomains: ['myapp.dev'] })] }),
      local: local(),
    });
    expect(attached.actions.find((a) => a.id === 'domain:myapp.dev')!.type).toBe('noop');
  });

  it('replaces a service whose workload kind changed', () => {
    const cronSpec = spec({ services: { web: { workloadKind: 'cron', cronSchedule: '0 3 * * *' } } });
    const result = diffEnvironment({ spec: cronSpec, envName: 'production', observed: observed(), local: local() });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('replace');
    expect(web.diff).toContainEqual({ field: 'workloadKind', from: 'web', to: 'cron' });
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

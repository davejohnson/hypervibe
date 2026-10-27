import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { hashEnvValue, type ObservedState } from '../../domain/ports/observe.port.js';

// Synthetic application-boundary observations. Independent incident requirement:
// unchanged raw references and resolved configuration equality do not establish
// deployed configuration or SQL authentication. Real SCRAM coverage lives in
// database-credential.postgres.test.ts; these tests do not claim live Railway evidence.
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hv-db-consumers-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(root, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'consumer-readiness', defaultPlatform: 'railway' });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: {
    hosting: { provider: 'railway' }, database: { provider: 'railway', engine: 'postgres' },
    services: Object.fromEntries(['web', 'worker', 'cron'].map(name => [name, {
      workloadKind: name, startCommand: `node ${name}.js`, ...(name === 'cron' ? { cronSchedule: '0 * * * *' } : {}),
      databaseEnvAliases: { POSTGRES_DB_URL: 'DATABASE_URL' },
    }])),
  } } });
  new ProjectSpecRepository().insert(project.id, 1, spec);
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'project', environmentId: 'production',
    services: Object.fromEntries(['web', 'worker', 'cron'].map(name => [name, { serviceId: `id-${name}` }])),
  } });
  const hashes = { DATABASE_URL: hashEnvValue('synthetic-new'), POSTGRES_DB_URL: hashEnvValue('synthetic-new') };
  const observed: ObservedState = { provider: 'railway', observedAt: '2026-10-25T00:00:00Z', projectExists: true,
    projectId: 'project', environmentId: 'production', partial: false, warnings: [], databases: [],
    completeness: { services: 'complete' },
    services: ['web', 'worker', 'cron'].map(name => ({ name, externalId: `id-${name}`,
      workloadKind: name as 'web' | 'worker' | 'cron', status: 'running', config: {}, customDomains: [],
      envVarKeys: Object.keys(hashes), envVarHashes: hashes, envVarState: 'resolved',
      deployment: { id: `old-${name}`, activeDeploymentIds: [`old-${name}`], configurationState: 'resolved',
        envVarHashes: { DATABASE_URL: hashEnvValue('synthetic-old'), POSTGRES_DB_URL: hashEnvValue('synthetic-old') } },
    })),
  };
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed, warnings: [] });
  const registry = new CommandRegistry(); registerCoreTools(registry, ctx);
  return { ctx, environment, observed, hashes, read: () => registry.execute('hv_status', { project: project.name, env: 'production' }) as Promise<any> };
}

describe('upstream database credential consumer readiness', () => {
  it('does not equate an idle cron schedule with known selected deployment activation', async () => {
    const f = fixture();
    f.observed.services.forEach(service => { service.deployment = { id: `new-${service.name}`, activeDeploymentIds: [`new-${service.name}`], configurationState: 'resolved', envVarHashes: f.hashes }; });
    const cron = f.observed.services.find(service => service.name === 'cron')!;
    cron.config.cronSchedule = '0 * * * *';
    cron.deployment!.activeDeploymentIds = [];
    const result = await f.read();
    expect(result.data.databaseConsumers.find((entry: any) => entry.service === 'cron')).toMatchObject({
      deployedConfiguration: 'match', oldDeployments: 'unknown', authentication: 'unchecked', applicationOperation: 'unchecked',
    });
    expect(result.data.inSync).toBe(false);
    expect(result.data.runtimeConfiguration.status).toBe('unknown');
  });

  it.each(['deployment-snapshot', 'runtime-instances'] as const)('reports %s provenance without implying authentication', async evidence => {
    const f = fixture();
    f.observed.services.forEach(service => { service.deployment = { id: `new-${service.name}`, activeDeploymentIds: [`new-${service.name}`],
      configurationState: 'resolved', configurationEvidence: evidence, envVarHashes: f.hashes }; });
    const result = await f.read();
    expect(result.data.databaseConsumers.every((entry: any) => entry.deployedConfigurationEvidence === evidence && entry.authentication === 'unchecked')).toBe(true);
  });

  it('requires activation for unchanged references whose current resolved values differ from every deployed consumer', async () => {
    const f = fixture(); const before = f.ctx.repos.environments.findById(f.environment.id);
    const result = await f.read();
    expect(result.ok).toBe(true);
    expect(result.data.restartRequired).toBe(true);
    expect(result.data.inSync).toBe(false);
    expect(result.data.databaseConsumers.map((entry: any) => entry.service)).toEqual(['cron', 'web', 'worker']);
    expect(result.data.databaseConsumers).toEqual(expect.arrayContaining([expect.objectContaining({
      service: 'worker', checkedNames: ['DATABASE_URL', 'POSTGRES_DB_URL'], deployedConfiguration: 'mismatch',
      authentication: 'unchecked', applicationOperation: 'unchecked',
    })]));
    expect(f.ctx.repos.environments.findById(f.environment.id)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain(hashEnvValue('synthetic-new'));
    expect(JSON.stringify(result)).not.toContain(hashEnvValue('synthetic-old'));
  });

  it('keeps partial rollout pending across repeated reads and rejects success with stale aliases', async () => {
    const f = fixture();
    f.observed.services[0].deployment = { id: 'new-web', activeDeploymentIds: ['new-web'], configurationState: 'resolved', envVarHashes: f.hashes };
    f.observed.services[1].deployment!.id = 'successful-but-stale-worker';
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.read();
      expect(result.data.restartRequired).toBe(true);
      expect(result.data.runtimeConfiguration.services.map((entry: any) => entry.service)).toEqual(['cron', 'worker']);
    }
    f.observed.services.forEach(service => { service.deployment = { id: `new-${service.name}`, activeDeploymentIds: [`new-${service.name}`], configurationState: 'resolved', envVarHashes: f.hashes }; });
    const complete = await f.read();
    expect(complete.data.restartRequired).toBe(false);
    expect(complete.data.databaseConsumers.every((entry: any) => entry.authentication === 'unchecked')).toBe(true);
  });

  it.each(['missing-snapshot', 'missing-drain', 'traffic-only-coverage', 'different-scope', 'duplicate-identity', 'missing-bound-scope', 'unresolved-configured', 'unknown-workload'])('keeps %s evidence unknown rather than current', async failure => {
    const f = fixture();
    f.observed.services.forEach(service => { service.deployment = { id: `new-${service.name}`, activeDeploymentIds: [`new-${service.name}`], configurationState: 'resolved', envVarHashes: f.hashes }; });
    if (failure === 'missing-snapshot') delete f.observed.services[0].deployment!.envVarHashes;
    if (failure === 'missing-drain') delete f.observed.services[0].deployment!.activeDeploymentIds;
    if (failure === 'traffic-only-coverage') f.observed.services[0].deployment!.activeDeploymentCoverage = 'traffic';
    if (failure === 'different-scope') f.observed.environmentId = 'staging';
    if (failure === 'duplicate-identity') f.observed.services.push({ ...f.observed.services[0] });
    if (failure === 'missing-bound-scope') f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { projectId: undefined, environmentId: undefined });
    if (failure === 'unresolved-configured') f.observed.services[0].envVarState = 'unknown';
    if (failure === 'unknown-workload') f.observed.services[0].status = 'unknown';
    const result = await f.read();
    expect(result.data.inSync).toBe(false);
    expect(result.data.runtimeConfiguration.status).toBe('unknown');
  });

  it.each(['alias-only', 'overlapping-old-deployment', 'failed-workload'])('keeps %s pending despite matching primary configured URL and deployment success', async failure => {
    const f = fixture();
    f.observed.services.forEach(service => { service.deployment = { id: `new-${service.name}`, activeDeploymentIds: [`new-${service.name}`], configurationState: 'resolved', envVarHashes: { ...f.hashes } }; });
    if (failure === 'alias-only') f.observed.services[0].deployment!.envVarHashes!.POSTGRES_DB_URL = hashEnvValue('synthetic-stale-alias');
    if (failure === 'overlapping-old-deployment') f.observed.services[0].deployment!.activeDeploymentIds!.push('older-web');
    if (failure === 'failed-workload') f.observed.services[0].status = 'failed';
    const result = await f.read();
    expect(result.data.restartRequired).toBe(true);
    expect(result.data.runtimeConfiguration.services.map((entry: any) => entry.service)).toEqual(['web']);
    expect(result.data.inSync).toBe(false);
    expect(JSON.stringify(result)).not.toContain(hashEnvValue('synthetic-stale-alias'));
  });
});

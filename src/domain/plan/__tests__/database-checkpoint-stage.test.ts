import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { PublicDnsClient } from '../../../adapters/dns/public-dns.client.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../application/devops-providers.js';
import { SpecStore } from '../../spec/spec.store.js';
import { PlanService } from '../plan.service.js';
import { planRunDocumentSchema } from '../converge.executor.js';
import type { PlanAction } from '../plan.types.js';
import * as resilience from '../../services/database-resilience-plan.service.js';

// Orchestration fixture only. Provider request/response contracts live in
// railway.checkpoint.api-contract.test.ts. The owner requires a backup before
// unrelated production reconciliation, even when the deploy workflow is stale.
const checkpoint: PlanAction = {
  id: 'database:railway:checkpoint:pre-release',
  type: 'create',
  resource: { kind: 'database', provider: 'railway', name: 'checkpoint:pre-release' },
  verified: true,
  reason: 'Create the explicitly requested recovery checkpoint',
  requiresConfirm: true,
  billable: true,
  dataBearing: true,
  metadata: { operation: 'databaseCheckpointCreate', checkpointId: 'pre-release' },
};

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-checkpoint-stage-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  vi.spyOn(PublicDnsClient.prototype, 'query').mockResolvedValue({ status: 'unknown' });
});
afterEach(() => vi.restoreAllMocks());

async function planWithCheckpoint(action = checkpoint) {
  const project = new ProjectRepository().create({
    name: 'checkpoint-before-release', defaultPlatform: 'railway',
    gitRemoteUrl: 'https://github.com/acme/checkpoint-before-release',
  });
  new SpecStore().replace(project, {
    version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
    secrets: { UNRELATED_SECRET: { principal: 'github:alice', environments: ['production'] } },
    environments: { production: {
      hosting: { provider: 'railway' },
      services: { web: { startCommand: 'npm start', public: true } },
      database: { provider: 'railway', engine: 'postgres' },
      email: { enabled: false },
      envVars: { UNRELATED_SETTING: 'new-value' },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    } },
  });
  const connections = new ConnectionRepository();
  for (const [provider, credentials] of Object.entries({
    railway: { apiToken: 'test-railway-token' },
    github: { apiToken: 'test-github-token', login: 'acme', packageReadToken: 'test-package-token' },
  })) {
    const connection = connections.create({ provider, credentialsEncrypted: getSecretStore().encryptObject(credentials) });
    connections.updateStatus(connection.id, 'verified');
  }
  new EnvironmentRepository().create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'project-1', environmentId: 'production-1', services: { web: { serviceId: 'web-1' } },
  } });
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({
    warnings: [], observed: {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
    projectId: 'project-1', environmentId: 'production-1', partial: false, warnings: [],
    services: [{ name: 'web', externalId: 'web-1', workloadKind: 'web', sourceState: 'disconnected',
      config: { startCommand: 'npm start', public: true }, envVarKeys: [], envVarHashes: {}, customDomains: [], status: 'running' }],
    databases: [],
    },
  });
  vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
  vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets').mockResolvedValue([]);
  vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
  vi.spyOn(GitHubAdapter.prototype, 'getEnvironmentVariable').mockResolvedValue(null);
  const planResilience = vi.spyOn(resilience, 'planDatabaseResilience').mockReturnValue({
    actions: [action], warnings: [], unmanaged: [], serviceDependencies: [],
  });
  const planner = new PlanService();
  return { project, planner, planResilience, result: await planner.plan(project, 'production', { includeEnvFile: false }) };
}

describe('database checkpoint safety stage', () => {
  it('keeps the checkpoint before stale CI publication and excludes runtime inputs and convergence markers', async () => {
    const { result } = await planWithCheckpoint();
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('database-checkpoint');
    expect(result.actions).toEqual([checkpoint]);
    expect(result.blocked).toEqual([]);
    const document = new RunRepository().findById(result.planRunId)!.plan;
    expect(document).not.toHaveProperty('inputRequired');
    expect(document).not.toHaveProperty('overrides');
    expect(document).not.toHaveProperty('integrationFingerprints');
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
  });

  it('keeps an unknown checkpoint blocked instead of falling through to a production update', async () => {
    const blocked = { ...checkpoint, type: 'update' as const, verified: false,
      metadata: { ...checkpoint.metadata, blockedReason: 'checkpoint_observation_unknown' } };
    const { result } = await planWithCheckpoint(blocked);
    expect(result).toMatchObject({ scope: 'database-checkpoint', actions: [blocked] });
  });

  it.each(['unbound', 'unknown'] as const)('isolates a declared snapshot with %s primary through the real resilience planner', async (state) => {
    const { project, planner, planResilience } = await planWithCheckpoint();
    planResilience.mockRestore();
    const store = new SpecStore();
    const current = store.get(project)!;
    current.spec.environments.production.database!.resilience = { checkpoint: { id: 'pre-release' } };
    store.replace(project, current.spec);
    if (state === 'unknown') {
      const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
      new ComponentRepository().create({ environmentId: environment.id, type: 'postgres', externalId: 'db',
        bindings: { provider: 'railway', providerScope: { projectId: 'project-1', environmentId: 'production-1' } } });
      vi.mocked(PlanService.prototype.observeEnvironment).mockResolvedValue({ warnings: [], observed: {
        provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
        projectId: 'project-1', environmentId: 'production-1', partial: true, warnings: ['synthetic database outage'],
        services: [], databases: [], completeness: { databases: 'unknown' },
      } });
    }
    const result = await planner.plan(project, 'production', { includeEnvFile: false });
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('database-checkpoint');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ verified: false, metadata: {
      operation: 'databaseCheckpointCreate', blockedReason: state === 'unbound'
        ? 'database_checkpoint_primary_unbound' : 'database_resilience_observation_unknown',
    } });
    expect(planRunDocumentSchema.safeParse(new RunRepository().findById(result.planRunId)!.plan).success).toBe(true);
  });

  it('returns to normal publication after a verified checkpoint and rejects partial plans while pending', async () => {
    const { project, planner, planResilience } = await planWithCheckpoint();
    const partial = await planner.plan(project, 'production', { serviceFilter: ['web'], includeEnvFile: false });
    expect(partial).toMatchObject({ error: expect.stringContaining('pending database checkpoint') });
    planResilience.mockReturnValue({ actions: [{ ...checkpoint, type: 'noop' }], warnings: [], unmanaged: [], serviceDependencies: [] });
    const complete = await planner.plan(project, 'production', { includeEnvFile: false });
    expect(complete).toMatchObject({ scope: 'managed-ci-publication' });
  });

  it('does not carry a pending data migration cross-environment lock into the checkpoint stage', async () => {
    const { project, planner } = await planWithCheckpoint();
    const store = new SpecStore();
    const current = store.get(project)!;
    current.spec.environments.staging = {
      ...current.spec.environments.production,
      envVars: {}, services: {},
    };
    current.spec.environments.production.database!.resilience = { checkpoint: { id: 'pre-release' } };
    current.spec.environments.production.dataMigration = {
      id: 'pending-copy', fromEnvironment: 'staging', include: { database: true, storage: [] },
    };
    store.replace(project, current.spec);
    const source = new EnvironmentRepository().create({ projectId: project.id, name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'project-1', environmentId: 'staging-1' } });
    new ComponentRepository().create({ environmentId: source.id, type: 'postgres', externalId: 'source-db',
      bindings: { provider: 'railway', providerScope: { projectId: 'project-1', environmentId: 'staging-1' } } });
    const result = await planner.plan(project, 'production', { includeEnvFile: false });
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('database-checkpoint');
    expect(result.actions).toEqual([checkpoint]);
    const document = new RunRepository().findById(result.planRunId)!.plan;
    expect(document).not.toHaveProperty('lockEnvironmentIds');
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
  });

  it('validates the persisted scope so a checkpoint cannot authorize unrelated writes', () => {
    const document = { kind: 'hv_plan', scope: 'database-checkpoint', environmentName: 'production', specRevision: 1,
      observedFingerprint: 'observed-state', actions: [checkpoint] };
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    const unrelated = { ...checkpoint, id: 'service:web', resource: { kind: 'service', provider: 'railway', name: 'web' }, metadata: {} };
    for (const altered of [
      { actions: [] }, { actions: [checkpoint, unrelated] }, { actions: [{ ...checkpoint, type: 'destroy' }] },
      { overrides: { envVarKeys: ['UNRELATED_SECRET'] } }, { integrationFingerprints: {} },
      { inputRequired: [{ key: 'UNRELATED_SECRET', principal: 'github:alice', reason: 'Runtime input' }] },
      { lockEnvironmentIds: ['another-environment'] },
    ]) expect(planRunDocumentSchema.safeParse({ ...document, ...altered }).success).toBe(false);
  });
});

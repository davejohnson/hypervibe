import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSchema, execute, GraphQLError, parse, validate } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import '../../adapters/providers/railway/railway.adapter.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { applyDatabaseSeed } from '../apply-plan.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { bindingIdentityFingerprint } from '../../domain/services/binding-identity.js';

const schema = buildSchema(readFileSync('test/provider-contracts/railway/schema.graphql', 'utf8'));
const repository = 'davejohnson/invoice-express';
const image = `ghcr.io/${repository}@sha256:${'a'.repeat(64)}`;
const invoiceCredentials = { username: 'invoice-reader', password: 'synthetic-invoice-package-token' };

/**
 * AGENTS.md requires exact repository credentials before intentional wildcard or
 * global fallback, and forbids credentials scoped to another repository.
 * Railway documents service-level private-image registry credentials at
 * https://docs.railway.com/builds/private-registries. The pinned official SDL
 * independently validates our real request serialization and synthetic replies.
 * Only fetch is replaced; seed dispatch, encrypted connections, credential
 * selection, adapter construction, task execution and cleanup remain real.
 * This proves selection/transport, not live registry authentication or image boot.
 */
function installRailwayTransport(failFirstAttempt = false, beforeDeploy?: () => void) {
  const services = new Map([
    ['web-id', { id: 'web-id', name: 'web', projectId: 'rail-project', deletedAt: null }],
  ]);
  const configured: Array<Record<string, unknown>> = [];
  const contractErrors: string[] = [];
  const connection = (nodes: unknown[]) => ({
    edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null },
  });
  const root = {
    project: ({ id }: { id: string }) => {
      expect(id).toBe('rail-project');
      return { id, services: connection([...services.values()]) };
    },
    service: ({ id }: { id: string }) => {
      const service = services.get(id);
      if (!service) throw new GraphQLError('Service not found', { extensions: { code: 'NOT_FOUND' } });
      return { ...service, serviceInstances: connection([{ id: `instance-${id}`, environmentId: 'rail-staging' }]) };
    },
    serviceInstance: ({ serviceId, environmentId }: { serviceId: string; environmentId: string }) => {
      expect(environmentId).toBe('rail-staging');
      if (!services.has(serviceId)) {
        throw new GraphQLError('ServiceInstance not found', { extensions: { code: 'NOT_FOUND' } });
      }
      return { id: `instance-${serviceId}`, serviceId, environmentId, deletedAt: null, source: { image } };
    },
    variables: () => ({ DATABASE_URL: 'postgresql://synthetic-db/app' }),
    serviceCreate: ({ input }: { input: { projectId: string; environmentId: string; name: string } }) => {
      expect(input).toMatchObject({ projectId: 'rail-project', environmentId: 'rail-staging' });
      const task = { id: 'task-id', name: input.name, projectId: 'rail-project', deletedAt: null };
      services.set(task.id, task);
      return task;
    },
    serviceInstanceUpdate: (args: Record<string, unknown>) => {
      configured.push(args);
      return true;
    },
    serviceInstanceDeployV2: () => { beforeDeploy?.(); return 'task-deployment'; },
    deployment: () => ({ status: failFirstAttempt && configured.length === 1 ? 'FAILED' : 'SUCCESS' }),
    deploymentLogs: () => failFirstAttempt && configured.length === 1 ? [] : [{
      timestamp: '2026-10-22T00:00:00.000Z', message: '__HYPERVIBE_TASK_EXIT:0__', severity: 'INFO',
    }],
    serviceDelete: (args: { id: string; environmentId: string }) => {
      expect(args).toEqual({ id: 'task-id', environmentId: 'rail-staging' });
      services.delete(args.id);
      return true;
    },
  };
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const document = parse(request.query);
    const errors = validate(schema, document);
    contractErrors.push(...errors.map((error) => error.message));
    const result = errors.length
      ? { errors }
      : await execute({ schema, document, rootValue: root, variableValues: request.variables });
    contractErrors.push(...(result.errors ?? [])
      .filter((error) => error.extensions?.code !== 'NOT_FOUND')
      .map((error) => error.message));
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  }));
  return { configured, contractErrors, services };
}

describe('database seed private-image credential scope', () => {
  let directory: string;
  let ctx: CommandContext;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-seed-registry-contract-'));
    vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
    SqliteAdapter.resetInstance();
    SecretStore.resetInstance();
    initializeDatabase(path.join(directory, 'test.db'));
    ctx = createCommandContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    SqliteAdapter.resetInstance();
    SecretStore.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['current', 'stale-plan', 'generation-changed-during-task', 'invalid-marker'] as const)(
    'retains seed history and binds completion to the exact storage generation: %s', async scenario => {
      const connection = ctx.repos.connections.create({ provider: 'railway', scope: null,
        credentialsEncrypted: ctx.secretStore.encryptObject({ apiToken: 'synthetic-railway-token' }) });
      ctx.repos.connections.updateStatus(connection.id, 'verified');
      const project = ctx.repos.projects.create({ name: 'generation-test', defaultPlatform: 'railway' });
      const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging',
        platformBindings: { provider: 'railway', projectId: 'rail-project', environmentId: 'rail-staging',
          services: { web: { serviceId: 'web-id' } } } });
      ctx.repos.services.create({ projectId: project.id, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {} });
      const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'database-id' });
      const target = { provider: 'railway', externalId: 'database-id',
        providerScope: { projectId: 'rail-project', environmentId: 'rail-staging' } };
      const completed = { intentId: 'fresh-storage', target, storageId: 'volume-new', storageInstanceId: 'instance-new',
        deploymentId: 'database-deploy', configurationFingerprint: 'a'.repeat(64), verifiedAt: '2026-10-26T00:00:00.000Z' };
      const history = { commandHash: 'old-command', seededAt: '2026-07-01T00:00:00.000Z' };
      ctx.repos.components.updateBindings(component.id, { provider: 'railway', providerScope: target.providerScope,
        volumeId: completed.storageId, volumeInstanceId: completed.storageInstanceId, seed: history,
        freshInitialization: scenario === 'invalid-marker' ? { progress: { phase: 'complete' } } : {
          metadata: { operation: 'databaseFreshInitialize', componentId: component.id, intentId: completed.intentId, target,
            configurationFingerprint: completed.configurationFingerprint, bindingsFingerprint: 'b'.repeat(64), environmentFingerprint: 'c'.repeat(64) },
          inspectionEncrypted: 'opaque-encrypted-inspection', startedAt: '2026-10-25T23:59:00.000Z',
          progress: { phase: 'complete', storageId: completed.storageId, storageInstanceId: completed.storageInstanceId,
            deploymentId: completed.deploymentId }, storageBindings: { volumeId: completed.storageId,
            volumeInstanceId: completed.storageInstanceId }, completed,
        } });
      const generation = bindingIdentityFingerprint(completed);
      const action: PlanAction = { id: 'database:railway:seed', type: 'update', verified: true, reason: 'Seed this new generation',
        resource: { kind: 'database', name: 'seed', provider: 'railway' }, metadata: {
          operation: 'databaseSeed', engine: 'postgres', command: 'npm run db:seed', commandHash: 'reviewed-command',
          ...(scenario !== 'stale-plan' ? { databaseGeneration: generation } : {}),
        } };
      const transport = installRailwayTransport(false, scenario === 'generation-changed-during-task'
        ? () => { ctx.repos.components.updateBindings(component.id, { volumeId: 'replacement-volume' }); } : undefined);
      const result = await applyDatabaseSeed(ctx, project, environment.name, action);
      expect(transport.contractErrors).toEqual([]);
      if (scenario === 'current') {
        expect(result.success).toBe(true);
        expect(ctx.repos.components.findById(component.id)?.bindings.seed).toMatchObject({
          commandHash: 'reviewed-command', databaseGeneration: generation,
        });
      } else {
        expect(result).toMatchObject({ success: false, status: 'blocked' });
        expect(ctx.repos.components.findById(component.id)?.bindings.seed).toEqual(history);
        expect(transport.configured).toHaveLength(scenario === 'generation-changed-during-task' ? 1 : 0);
      }
    });

  it.each([
    { label: 'exact repository ahead of stale global', global: true, invoice: true, remote: `git@github.com:${repository}.git`, expected: invoiceCredentials },
    { label: 'exact repository ahead of unrelated scope', global: false, invoice: true, remote: `https://github.com/${repository}.git`, expected: invoiceCredentials },
    { label: 'intentional organization wildcard', global: true, invoice: true, invoiceScope: 'davejohnson/*', remote: `git@github.com:${repository}.git`, expected: invoiceCredentials },
    { label: 'intentional global fallback', global: true, invoice: false, remote: `git@github.com:${repository}.git`, expected: { username: 'global-reader', password: 'synthetic-stale-global-token' } },
    { label: 'unknown repository cannot adopt a scoped credential', global: false, invoice: true, remote: undefined, expected: undefined },
    { label: 'non-GitHub repository cannot adopt a scoped credential', global: false, invoice: true, remote: `git@gitlab.com:${repository}.git`, expected: undefined },
    { label: 'unknown repository retains intentional global fallback', global: true, invoice: true, remote: undefined, expected: { username: 'global-reader', password: 'synthetic-stale-global-token' } },
    { label: 'failed boot followed by seed reapply', global: true, invoice: true, remote: `git@github.com:${repository}.git`, expected: invoiceCredentials, retry: true },
  ])('$label', async (scenario) => {
    const connect = (provider: string, scope: string | null, credentials: Record<string, string>) => {
      const connection = ctx.repos.connections.create({
        provider, scope, credentialsEncrypted: ctx.secretStore.encryptObject(credentials),
      });
      ctx.repos.connections.updateStatus(connection.id, 'verified');
    };
    connect('railway', null, { apiToken: 'synthetic-railway-token' });
    if (scenario.global) connect('github', null, { login: 'global-reader', packageReadToken: 'synthetic-stale-global-token' });
    connect('github', 'aaa-unrelated/other-project', { login: 'other-reader', packageReadToken: 'synthetic-unrelated-token' });
    if (scenario.invoice) connect('github', scenario.invoiceScope ?? repository, { login: invoiceCredentials.username, packageReadToken: invoiceCredentials.password });
    const project = ctx.repos.projects.create({
      name: 'invoice-express', defaultPlatform: 'railway', gitRemoteUrl: scenario.remote,
    });
    const environment = ctx.repos.environments.create({
      projectId: project.id, name: 'staging', platformBindings: {
        provider: 'railway', projectId: 'rail-project', environmentId: 'rail-staging',
        services: { web: { serviceId: 'web-id' } },
      },
    });
    ctx.repos.services.create({ projectId: project.id, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {} });
    const database = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres' });
    const action: PlanAction = {
      id: 'database:seed', type: 'update', resource: { kind: 'database', name: 'seed', provider: 'railway' },
      verified: true, reason: 'Declared seed is pending',
      metadata: { command: 'npm run db:seed', commandHash: 'synthetic-command-hash', engine: 'postgres' },
    };
    const transport = installRailwayTransport(scenario.retry);

    if (scenario.retry) {
      const failed = await applyDatabaseSeed(ctx, project, environment.name, action);
      expect(failed.success).toBe(false);
      expect(ctx.repos.components.findById(database.id)?.bindings.seed).toBeUndefined();
      expect(transport.services.has('task-id')).toBe(false);
    }

    const result = await applyDatabaseSeed(ctx, project, environment.name, action);

    expect(transport.contractErrors).toEqual([]);
    expect(result.success).toBe(true);
    expect(transport.services.has('task-id')).toBe(false);
    expect(ctx.repos.components.findById(database.id)?.bindings.seed).toMatchObject({ commandHash: 'synthetic-command-hash' });
    expect(transport.configured).toHaveLength(scenario.retry ? 2 : 1);
    for (const configured of transport.configured) {
      expect(configured).toMatchObject({ serviceId: 'task-id', environmentId: 'rail-staging', input: { source: { image } } });
      expect((configured.input as Record<string, unknown>).registryCredentials).toEqual(scenario.expected);
    }
  });
});

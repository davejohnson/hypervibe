import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildSchema, execute, GraphQLError, parse, validate } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import type { DatabaseTaskCheckpoint, EnvironmentTaskOptions } from '../../../../domain/ports/hosting.port.js';
import { buildDatabaseInitializationCommand, DATABASE_INITIALIZATION_AUTH_COMMAND_HASH } from '../../../../domain/services/database-initialization-program.js';
import * as packagePull from '../../github/package-pull.js';

const schema = buildSchema(readFileSync('test/provider-contracts/railway/schema.graphql', 'utf8'));
const image = `ghcr.io/example/application@sha256:${'a'.repeat(64)}`;
const command = () => buildDatabaseInitializationCommand();
const commandHash = () => DATABASE_INITIALIZATION_AUTH_COMMAND_HASH;
const source = { provider: 'railway', primaryExternalId: 'database-id',
  providerScope: { projectId: 'project-one', environmentId: 'staging' },
  resourceIdentity: { volumeId: 'volume-one', volumeInstanceId: 'volume-instance-one' } };
const environment = { id: 'local-staging', name: 'staging', platformBindings: {
  provider: 'railway', projectId: 'project-one', environmentId: 'staging', services: { web: { serviceId: 'web-id' } },
} } as unknown as Environment;
const service = { id: 'local-web', name: 'web', buildConfig: {} } as Service;
const connection = (nodes: unknown[]) => ({ edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } });

// Synthetic provider state executed through the pinned official SDL, not request
// echoes or captured traffic. The selected-reference contract follows Railway's
// https://docs.railway.com/guides/variables#reference-variables. Native SUCCESS
// is deliberately independent of finite command completion. User requirements
// establish durable intent and no unrelated-variable/task adoption authority.
async function fixture(options: { lostCreate?: boolean; lostConfigure?: boolean; lostDeploy?: boolean; failCleanup?: boolean;
  logs?: string[]; wrongVolume?: boolean; sourceImage?: string; wrongDeployment?: boolean; conflictName?: boolean;
  replacedTaskInstance?: boolean; sourceVariablesMissing?: boolean } = {}) {
  const mutations: Array<{ field: string; args: any }> = [];
  const requests: Array<{ query: string; variables: any }> = [];
  const services = new Map([
    ['web-id', { id: 'web-id', name: 'web', projectId: 'project-one', deletedAt: null }],
    ['database-id', { id: 'database-id', name: 'database', projectId: 'project-one', deletedAt: null }],
    ['other-task', { id: 'other-task', name: 'hv-task-unrelated', projectId: 'project-one', deletedAt: null }],
  ]);
  if (options.conflictName) services.set('conflict-id', { id: 'conflict-id', name: 'hv-db-database-init-101', projectId: 'project-one', deletedAt: null });
  const taskVariables: Record<string, string> = {};
  let taskConfiguration: any = { source: null, startCommand: null, restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 };
  const success = `__HYPERVIBE_DATABASE_INITIALIZATION:${JSON.stringify({ version: 1, executionId: 'database-init-101',
    mode: 'authenticate', commandHash: commandHash(), authentication: 'authenticated', migration: 'unchecked' })}`;
  const logs = options.logs ?? [success, '__HYPERVIBE_TASK_EXIT:0__'];
  const root = {
    project: ({ id }: any) => ({ id, services: () => connection([...services.values()]) }),
    environment: ({ id }: any) => ({ id, projectId: 'project-one', deletedAt: null,
      variables: () => connection([
        { id: 'db-url', name: 'DATABASE_URL', serviceId: 'database-id', environment: { id: 'staging', projectId: 'project-one' } },
        { id: 'db-direct', name: 'DIRECT_URL', serviceId: 'database-id', environment: { id: 'staging', projectId: 'project-one' } },
        { id: 'web-url', name: 'DATABASE_URL', serviceId: 'web-id', environment: { id: 'staging', projectId: 'project-one' } },
        { id: 'web-secret', name: 'UNRELATED_MAIL_SECRET', serviceId: 'web-id', environment: { id: 'staging', projectId: 'project-one' } },
      ].filter(variable => !options.sourceVariablesMissing || variable.serviceId !== 'database-id')),
      volumeInstances: () => connection([{ id: options.wrongVolume ? 'wrong-instance' : 'volume-instance-one', serviceId: 'database-id', environmentId: 'staging',
        mountPath: '/var/lib/postgresql/data', deletedAt: null, isPendingDeletion: false,
        volume: { id: 'volume-one', projectId: 'project-one' } }]),
    }),
    service: ({ id }: any) => {
      const found = services.get(id);
      if (!found) throw new GraphQLError('Service not found', { extensions: { code: 'NOT_FOUND' } });
      return { ...found, serviceInstances: () => connection([{ id: `instance-${id}`, environmentId: 'staging' }]) };
    },
    serviceInstance: ({ serviceId, environmentId }: any) => {
      if (!services.has(serviceId)) throw new GraphQLError('ServiceInstance not found', { extensions: { code: 'NOT_FOUND' } });
      return { id: serviceId === 'task-id' && options.replacedTaskInstance ? 'replacement-task-instance' : `instance-${serviceId}`, serviceId, environmentId, deletedAt: null,
        ...(serviceId === 'task-id' ? taskConfiguration : { source: { image: options.sourceImage ?? image } }) };
    },
    serviceCreate: ({ input }: any) => {
      mutations.push({ field: 'serviceCreate', args: { input } });
      services.set('task-id', { id: 'task-id', name: input.name, projectId: 'project-one', deletedAt: null });
      Object.assign(taskVariables, input.variables);
      if (options.lostCreate) throw new Error('Lost creation acknowledgement with synthetic-private-value');
      return { id: 'task-id', name: input.name };
    },
    serviceInstanceUpdate: (args: any) => {
      mutations.push({ field: 'serviceInstanceUpdate', args });
      taskConfiguration = { ...taskConfiguration, ...args.input };
      if (options.lostConfigure) throw new Error('Lost configuration acknowledgement with synthetic-private-value');
      return true;
    },
    serviceInstanceDeployV2: (args: any) => {
      mutations.push({ field: 'serviceInstanceDeployV2', args });
      if (options.lostDeploy) throw new Error('Lost deployment acknowledgement with synthetic-private-value');
      return 'task-deployment';
    },
    deployment: () => ({ id: 'task-deployment', projectId: 'project-one', environmentId: options.wrongDeployment ? 'production' : 'staging', serviceId: 'task-id', status: 'SUCCESS' }),
    deploymentLogs: () => logs.map(message => ({ timestamp: '2026-10-27T00:00:00Z', message, severity: 'INFO' })),
    serviceDelete: (args: any) => {
      mutations.push({ field: 'serviceDelete', args });
      if (options.failCleanup) throw new Error('Cleanup failed with synthetic-private-value');
      services.delete(args.id); return true;
    },
    variables: ({ serviceId, unrendered }: any) => {
      expect(serviceId).toBe('task-id'); expect(unrendered).toBe(true);
      return { ...taskVariables };
    },
  };
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); requests.push(request);
    const document = parse(request.query);
    expect(validate(schema, document).map(error => error.message)).toEqual([]);
    const response = await execute({ schema, document, rootValue: root, variableValues: request.variables });
    return Response.json(response);
  }));
  const adapter = new RailwayAdapter();
  await adapter.connect({ apiToken: 'synthetic-api-token' });
  return { adapter, mutations, requests, services, logs, success, taskVariables };
}

function privateConfiguration() {
  return JSON.stringify({ version: 1, executionId: 'database-init-101', mode: 'authenticate', commandHash: commandHash(),
    keys: ['DATABASE_URL', 'POSTGRES_DB_URL'], expectedHashes: { DATABASE_URL: createHash('sha256').update('synthetic-private-value').digest('hex'), POSTGRES_DB_URL: createHash('sha256').update('synthetic-private-value').digest('hex') },
    authentication: { username: 'postgres', database: 'railway' } });
}

function options(persist: (state: DatabaseTaskCheckpoint) => Promise<DatabaseTaskCheckpoint>): EnvironmentTaskOptions {
  return { timeoutMs: 1, pollIntervalMs: 1, declaredTask: {
    variableMode: 'references' as const, sweep: false as const, expectedImage: image, executionId: 'database-init-101',
    registryCredentials: { username: 'registry-user', token: 'synthetic-registry-token' },
    databaseTask: { mode: 'authenticate' as const, source, commandHash: commandHash(),
      variableReferences: [{ sourceServiceId: 'database-id', variableName: 'DIRECT_URL', targetName: 'DATABASE_URL' },
        { sourceServiceId: 'database-id', variableName: 'DIRECT_URL', targetName: 'POSTGRES_DB_URL' }],
      privateConfiguration: privateConfiguration(), persist },
  } };
}

function journal() {
  let state: DatabaseTaskCheckpoint | undefined;
  const history: DatabaseTaskCheckpoint[] = [];
  const taskOptions = options(async next => {
    state = structuredClone(next); history.push(state);
    return structuredClone(state);
  });
  return { taskOptions, history, get state() { return state; }, resume() { taskOptions.declaredTask!.databaseTask!.state = state; } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Railway resumable private database task contract', () => {
  it('requires durable intent before creating any private task', async () => {
    const f = await fixture();
    const persist = vi.fn(async () => { throw new Error('Durable intent unavailable'); });
    await f.adapter.runJob(environment, service, command(), options(persist));
    expect(f.mutations).toEqual([]);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('passes only explicitly selected database aliases, never unrelated application secrets', async () => {
    const f = await fixture();
    await f.adapter.runJob(environment, service, command(), options(async next => structuredClone(next)));
    const variables = f.mutations.find(item => item.field === 'serviceCreate')?.args.input.variables;
    expect(variables).toEqual({ DATABASE_URL: '${{database.DIRECT_URL}}', POSTGRES_DB_URL: '${{database.DIRECT_URL}}',
      HYPERVIBE_DATABASE_TASK_CONFIG: privateConfiguration() });
    expect(f.services.has('other-task')).toBe(true);
  });

  it('executes the configured shell wrapper and records exit after the private program replaces its own shell', async () => {
    const f = await fixture(); const j = journal();
    await f.adapter.runJob(environment, service, command(), j.taskOptions);
    const startCommand = f.mutations.find(item => item.field === 'serviceInstanceUpdate')!.args.input.startCommand;
    // No connection variables means the real program fails closed before SQL;
    // this independently executes the exact serialized Railway startCommand.
    const actual = spawnSync('/bin/sh', ['-c', startCommand], { encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, HYPERVIBE_DATABASE_TASK_CONFIG: privateConfiguration() } });
    expect(actual.error).toBeUndefined();
    expect(actual.status).toBe(1);
    expect(actual.stdout).toContain('"authentication":"unknown"');
    expect(actual.stdout.trim().split('\n').at(-1)).toBe('__HYPERVIBE_TASK_EXIT:1__');
    expect(actual.stderr).toBe('');
  });

  it('persists finite completion before cleanup and resumes completed execution without writes', async () => {
    const f = await fixture(); const j = journal();
    const result = await f.adapter.runJob(environment, service, command(), j.taskOptions);
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, receipt: { success: true, data: { cleanupVerified: true } } });
    expect(j.history.map(state => state.phase)).toEqual(['create-attempted', 'created', 'created', 'configure-attempted',
      'configured', 'deploy-attempted', 'deployed', 'terminal', 'cleanup-attempted', 'complete']);
    expect(j.history.find(state => state.phase === 'terminal')?.terminal).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(f.mutations.map(item => item.field)).toEqual(['serviceCreate', 'serviceInstanceUpdate', 'serviceInstanceDeployV2', 'serviceDelete']);
    expect(JSON.stringify(j.state)).not.toContain(JSON.parse(privateConfiguration()).expectedHashes.POSTGRES_DB_URL);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
    expect(result.output).toBeUndefined();
    j.resume(); const count = f.requests.length;
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).status).toBe('completed');
    expect(f.requests).toHaveLength(count);
  });

  it.each(['create', 'deploy'] as const)('does not replay a lost %s acknowledgement or adopt a same-named resource', async mutation => {
    const f = await fixture(mutation === 'create' ? { lostCreate: true } : { lostDeploy: true }); const j = journal();
    const result = await f.adapter.runJob(environment, service, command(), j.taskOptions);
    expect(result.receipt.success).toBe(false);
    expect(j.state?.phase).toBe(`${mutation}-attempted`);
    j.resume(); const count = f.mutations.length;
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).receipt.success).toBe(false);
    expect(f.mutations).toHaveLength(count);
    expect(f.services.has('task-id')).toBe(true);
  });

  it('reconciles a lost configuration acknowledgement by exact readback without reconfiguring', async () => {
    const f = await fixture({ lostConfigure: true }); const j = journal();
    await f.adapter.runJob(environment, service, command(), j.taskOptions);
    expect(j.state?.phase).toBe('configure-attempted');
    j.resume();
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).status).toBe('completed');
    expect(f.mutations.filter(item => item.field === 'serviceInstanceUpdate')).toHaveLength(1);
  });

  it('resumes only owned cleanup after a terminal result, without another command execution', async () => {
    const injected = { failCleanup: true, sourceImage: image }; const f = await fixture(injected); const j = journal();
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).receipt.success).toBe(false);
    expect(j.state?.phase).toBe('cleanup-attempted');
    injected.failCleanup = false; injected.sourceImage = 'changed-after-terminal:latest'; j.resume();
    delete j.taskOptions.declaredTask!.registryCredentials;
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).status).toBe('completed');
    expect(f.mutations.filter(item => item.field === 'serviceCreate')).toHaveLength(1);
    expect(f.mutations.filter(item => item.field === 'serviceInstanceDeployV2')).toHaveLength(1);
  });

  it('finishes retained cleanup on provider-confirmed absence without another delete', async () => {
    const f = await fixture({ failCleanup: true }); const j = journal();
    await f.adapter.runJob(environment, service, command(), j.taskOptions);
    f.services.delete('task-id'); j.resume(); const count = f.mutations.length;
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).status).toBe('completed');
    expect(f.mutations).toHaveLength(count);
  });

  it('does not clean up or rerun when terminal-result persistence fails', async () => {
    const f = await fixture(); let state: DatabaseTaskCheckpoint | undefined;
    let refuse = true;
    const taskOptions = options(async next => {
      if (next.phase === 'terminal' && refuse) throw new Error('Synthetic save failure');
      state = structuredClone(next); return structuredClone(next);
    });
    await f.adapter.runJob(environment, service, command(), taskOptions);
    expect(state?.phase).toBe('deployed');
    expect(f.services.has('task-id')).toBe(true);
    refuse = false; taskOptions.declaredTask!.databaseTask!.state = state;
    expect((await f.adapter.runJob(environment, service, command(), taskOptions)).status).toBe('completed');
    expect(f.mutations.filter(item => item.field === 'serviceInstanceDeployV2')).toHaveLength(1);
  });

  it.each(['created', 'deployed'] as const)('retains acknowledged native IDs when the %s checkpoint cannot be saved', async refusedPhase => {
    const f = await fixture(); let durable: DatabaseTaskCheckpoint | undefined;
    const taskOptions = options(async next => {
      if (next.phase === refusedPhase) throw new Error('Journal failed with synthetic-private-value');
      durable = structuredClone(next); return structuredClone(next);
    });
    const result = await f.adapter.runJob(environment, service, command(), taskOptions);
    expect(result).toMatchObject({ status: 'running', receipt: { success: false, data: {
      phase: refusedPhase === 'created' ? 'create-attempted' : 'deploy-attempted', cleanupVerified: false,
      recoveryRequired: true, databaseTaskAcknowledgement: { version: 1, phase: refusedPhase, taskServiceId: 'task-id',
        ...(refusedPhase === 'deployed' ? { taskInstanceId: 'instance-task-id', deploymentId: 'task-deployment' } : {}) },
    } } });
    expect(durable?.phase).toBe(refusedPhase === 'created' ? 'create-attempted' : 'deploy-attempted');
    expect(f.mutations.map(item => item.field)).toEqual(refusedPhase === 'created' ? ['serviceCreate']
      : ['serviceCreate', 'serviceInstanceUpdate', 'serviceInstanceDeployV2']);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
    expect(JSON.stringify(result)).not.toContain(JSON.parse(privateConfiguration()).expectedHashes.DATABASE_URL);
    taskOptions.declaredTask!.databaseTask!.state = durable;
    const count = f.mutations.length;
    expect((await f.adapter.runJob(environment, service, command(), taskOptions)).receipt.success).toBe(false);
    expect(f.mutations).toHaveLength(count);
  });

  it('leaves SUCCESS without a finite result and exit pending, then recovers the same deployment', async () => {
    const f = await fixture({ logs: [] }); const j = journal();
    const pending = await f.adapter.runJob(environment, service, command(), j.taskOptions);
    expect(pending).toMatchObject({ status: 'running', receipt: { success: false } });
    expect(j.state?.phase).toBe('deployed');
    f.logs.push(f.success, '__HYPERVIBE_TASK_EXIT:0__'); j.resume();
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).status).toBe('completed');
    expect(f.mutations.filter(item => item.field === 'serviceInstanceDeployV2')).toHaveLength(1);
  });

  it.each(['image', 'volume', 'issuer-references', 'credentials', 'task-variables'] as const)(
    'observes and cleans only the acknowledged deployment after mutable %s changes', async changed => {
      const injected = { logs: [] as string[], sourceImage: image, wrongVolume: false, sourceVariablesMissing: false };
      const f = await fixture(injected); const j = journal();
      await f.adapter.runJob(environment, service, command(), j.taskOptions);
      expect(j.state?.phase).toBe('deployed');
      if (changed === 'image') injected.sourceImage = 'changed-application:latest';
      if (changed === 'volume') injected.wrongVolume = true;
      if (changed === 'issuer-references') injected.sourceVariablesMissing = true;
      if (changed === 'credentials') {
        delete j.taskOptions.declaredTask!.registryCredentials;
        vi.spyOn(packagePull, 'githubPackagePullCredentials').mockReturnValue(null);
      }
      if (changed === 'task-variables') f.taskVariables.DATABASE_URL = '${{different.DATABASE_URL}}';
      f.logs.push(f.success, '__HYPERVIBE_TASK_EXIT:0__'); j.resume();
      const mutations = f.mutations.length; const requests = f.requests.length;
      const result = await f.adapter.runJob(environment, service, command(), j.taskOptions);
      expect(result).toMatchObject({ status: 'completed', receipt: { success: true, data: { cleanupVerified: true } } });
      expect(f.mutations.slice(mutations).map(item => item.field)).toEqual(['serviceDelete']);
      expect(f.requests.slice(requests).some(item => /DatabaseTaskSource|DatabaseTaskVariables|DatabaseTaskReferenceReadback/.test(item.query))).toBe(false);
      expect(j.state?.phase).toBe('complete');
    });

  it.each(['instance', 'deployment-environment'] as const)('keeps acknowledged deployment recovery scoped when %s changes', async changed => {
    const injected = { logs: [] as string[], replacedTaskInstance: false, wrongDeployment: false };
    const f = await fixture(injected); const j = journal();
    await f.adapter.runJob(environment, service, command(), j.taskOptions);
    if (changed === 'instance') injected.replacedTaskInstance = true;
    else injected.wrongDeployment = true;
    f.logs.push(f.success, '__HYPERVIBE_TASK_EXIT:0__'); j.resume(); const count = f.mutations.length;
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).receipt.success).toBe(false);
    expect(f.mutations).toHaveLength(count);
    expect(j.state?.phase).toBe('deployed');
  });

  it.each([{ wrongVolume: true }, { sourceImage: 'postgres:15' }, { conflictName: true }])('blocks changed source or ambiguous identity before writes: %j', async injected => {
    const f = await fixture(injected); const j = journal();
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).receipt.success).toBe(false);
    expect(f.mutations).toEqual([]);
  });

  it('does not accept a task deployment from a sibling environment', async () => {
    const f = await fixture({ wrongDeployment: true }); const j = journal();
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).receipt.success).toBe(false);
    expect(f.mutations.some(item => item.field === 'serviceDelete')).toBe(false);
  });

  it.each(['missing', 'duplicate', 'wrong-execution', 'nonzero-exit', 'embedded'] as const)('does not infer authentication from misleading finite evidence: %s', async mismatch => {
    const f = await fixture({ logs: [] }); const j = journal();
    if (mismatch === 'duplicate') f.logs.push(f.success, f.success);
    else if (mismatch === 'wrong-execution') f.logs.push(f.success.replace('database-init-101', 'unrelated-execution'));
    else if (mismatch === 'embedded') f.logs.push('Application output\n' + f.success);
    else if (mismatch === 'nonzero-exit') f.logs.push(f.success);
    f.logs.push(mismatch === 'nonzero-exit' ? '__HYPERVIBE_TASK_EXIT:7__' : '__HYPERVIBE_TASK_EXIT:0__');
    const result = await f.adapter.runJob(environment, service, command(), j.taskOptions);
    expect(result).toMatchObject({ status: 'failed', receipt: { success: false, data: { cleanupVerified: true } } });
    expect(result.output).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Application output');
  });

  it.each(['entry-count', 'entry-bytes', 'total-bytes'] as const)('keeps oversized log evidence pending without copying it into outcomes: %s', async excess => {
    const f = await fixture(); const j = journal();
    if (excess === 'entry-count') f.logs.push(...Array.from({ length: 500 }, () => 'untrusted-output'));
    else if (excess === 'entry-bytes') f.logs.push('untrusted-output'.repeat(5000));
    else f.logs.push(...Array.from({ length: 300 }, () => 'untrusted-output'.repeat(300)));
    const result = await f.adapter.runJob(environment, service, command(), j.taskOptions);
    expect(result).toMatchObject({ status: 'running', receipt: { success: false, data: { cleanupVerified: false } } });
    expect(j.state?.phase).toBe('deployed');
    expect(f.services.has('task-id')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('untrusted-output');
  });

  it.each([0, 7])('correlates an exact migration command and finite migration exit %s', async exitCode => {
    const f = await fixture({ logs: [] }); const j = journal();
    const migration = 'node dist/migrate.js'; const hash = createHash('sha256').update(migration).digest('hex');
    const task = j.taskOptions.declaredTask!.databaseTask!;
    task.mode = 'migrate'; task.commandHash = hash;
    task.privateConfiguration = JSON.stringify({ ...JSON.parse(privateConfiguration()), mode: 'migrate', commandHash: hash,
      migration: { command: migration, timeoutMs: 30_000 } });
    f.logs.push(`__HYPERVIBE_DATABASE_INITIALIZATION:${JSON.stringify({ version: 1, executionId: 'database-init-101',
      mode: 'migrate', commandHash: hash, authentication: 'authenticated', migration: exitCode === 0 ? 'completed' : 'failed', exitCode })}`,
    `__HYPERVIBE_TASK_EXIT:${exitCode}__`);
    const result = await f.adapter.runJob(environment, service, command(), j.taskOptions);
    expect(result.status).toBe(exitCode === 0 ? 'completed' : 'failed');
    expect(result.receipt.data).toMatchObject({ cleanupVerified: true, databaseTask: { mode: 'migrate', commandHash: hash, exitCode } });
    expect(f.mutations.find(item => item.field === 'serviceInstanceUpdate')?.args.input.startCommand).not.toContain(migration);
  });

  it('rejects misleading persistence acknowledgements before the first mutation', async () => {
    const f = await fixture();
    await f.adapter.runJob(environment, service, command(), options(async next => ({ ...next, authorityHash: 'b'.repeat(64) })));
    expect(f.mutations).toEqual([]);
  });

  it.each(['instance', 'name'] as const)('refuses cleanup after the exact owned task %s changes', async changed => {
    const injected = { failCleanup: true, replacedTaskInstance: false }; const f = await fixture(injected); const j = journal();
    await f.adapter.runJob(environment, service, command(), j.taskOptions);
    expect(j.state?.phase).toBe('cleanup-attempted');
    const count = f.mutations.length;
    injected.failCleanup = false;
    if (changed === 'instance') injected.replacedTaskInstance = true;
    else f.services.get('task-id')!.name = 'user-retained-service';
    j.resume();
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).receipt.success).toBe(false);
    expect(f.mutations).toHaveLength(count);
    expect(f.services.has('task-id')).toBe(true);
  });

  it('does not trust a retained success label with a mismatched finite receipt', async () => {
    const injected = { failCleanup: true }; const f = await fixture(injected); const j = journal();
    await f.adapter.runJob(environment, service, command(), j.taskOptions);
    j.resume();
    j.taskOptions.declaredTask!.databaseTask!.state!.terminal!.result!.executionId = 'another-execution';
    const count = f.mutations.length; injected.failCleanup = false;
    expect((await f.adapter.runJob(environment, service, command(), j.taskOptions)).receipt.success).toBe(false);
    expect(f.mutations).toHaveLength(count);
  });

  it.each([undefined, 'https://github.com/other/application.git', 'https://github.com/example/application.git'])('selects package pull credentials from authoritative repository scope: %s', async remote => {
    const select = vi.spyOn(packagePull, 'githubPackagePullCredentials').mockImplementation(input => input?.githubRepo === 'example/application'
      ? { username: 'scoped-owner', token: 'synthetic-scoped-token' } : null);
    const f = await fixture(); const j = journal();
    delete j.taskOptions.declaredTask!.registryCredentials;
    if (remote) j.taskOptions.gitRemoteUrl = remote;
    const result = await f.adapter.runJob(environment, service, command(), j.taskOptions);
    const exact = remote?.includes('/example/') === true;
    expect(result.receipt.success).toBe(exact);
    expect(select).toHaveBeenCalledWith({ githubRepo: remote ? remote.includes('/example/') ? 'example/application' : 'other/application' : undefined });
    if (exact) expect(f.mutations.find(item => item.field === 'serviceInstanceUpdate')?.args.input.registryCredentials)
      .toEqual({ username: 'scoped-owner', password: 'synthetic-scoped-token' });
    else expect(f.mutations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('synthetic-scoped-token');
  });

  it('preserves intentional verified global package credential fallback without repository context', async () => {
    const select = vi.spyOn(packagePull, 'githubPackagePullCredentials').mockReturnValue({ username: 'global-owner', token: 'synthetic-global-token' });
    const f = await fixture(); const j = journal(); delete j.taskOptions.declaredTask!.registryCredentials;
    const result = await f.adapter.runJob(environment, service, command(), j.taskOptions);
    expect(result.status).toBe('completed');
    expect(select).toHaveBeenCalledWith({ githubRepo: undefined });
    expect(f.mutations.find(item => item.field === 'serviceInstanceUpdate')?.args.input.registryCredentials)
      .toEqual({ username: 'global-owner', password: 'synthetic-global-token' });
    expect(JSON.stringify(result)).not.toContain('synthetic-global-token');
  });
});

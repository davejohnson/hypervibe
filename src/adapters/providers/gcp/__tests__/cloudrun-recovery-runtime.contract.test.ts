import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudSqlAdapter } from '../cloudsql.adapter.js';
import { GcsStorageAdapter } from '../gcs.adapter.js';
import { executeManagedBackup, verifyManagedBackupAuthority } from '../../../../application/managed-backup.js';
import { recoveryRuntimeBindings } from '../../../../domain/services/runtime-evidence.js';
import { runtimeExecutionCoordinatesSchema } from '../../../../lib/value-free-coordinates.js';
import { compileBackupWorkflow } from '../../../../domain/services/backup-workflow.service.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import { SecretStore } from '../../../secrets/secret-store.js';
import { observeRecoveryRuntime, planRecoveryRuntime, applyRecoveryRuntimeAction } from '../../../../domain/services/recovery-runtime.service.js';
import { resolveManagedBackupTarget } from '../../../../domain/services/managed-backup-target.service.js';
import type { BackupPolicyContext } from '../../../../domain/services/backup-policy.service.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudRunRecoveryRuntime } from '../cloudrun-recovery-runtime.js';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import type { RecoveryRuntimeBinding, RecoveryRuntimeTarget } from '../../../../domain/ports/recovery-runtime.port.js';

// Reconstructed Google REST resources; real serialized HTTP client. No live IAM,
// network reachability, helper execution or recovery durability is certified.
// https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/create
// https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion
// https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/setIamPolicy
// Secret Manager returns numeric project names even when addressed by project ID.
// Native metadata captured 2026-11-01; see connect-cloud-prepared-hosting.md.
const projectId = 'sequence-contract';
const projectNumber = '123456789012';
const ciIdentity = { schemaVersion: 1, projectId, projectNumber,
  workloadIdentityProvider: `projects/${projectNumber}/locations/global/workloadIdentityPools/hv-ci-test/providers/github`,
  serviceAccountEmail: `ci-backup@${projectId}.iam.gserviceaccount.com`, serviceAccountUniqueId: '223456789012345678901',
  repository: 'studio/sequence', repositoryId: '12345', repositoryOwnerId: '67890', branch: 'main', environment: 'staging',
  workflow: '.github/workflows/deploy.yml', backupWorkflow: '.github/workflows/hypervibe-backup-staging.yml' };
const region = 'us-west1';
const instance = 'database';
const databaseUrl = 'postgresql://app:synthetic-private-password@/app?host=%2Fcloudsql%2Fsequence-contract%3Aus-west1%3Adatabase';
const credentialHash = createHash('sha256').update(databaseUrl).digest('hex');
const envId = '11111111-1111-4111-8111-111111111111';
const runnerImage = `ghcr.io/example/backup@sha256:${'a'.repeat(64)}`;
let target: RecoveryRuntimeTarget;
let sa: any;
let secret: any;
let versions: any[];
let policies: Map<string, any>;
let sql: any;
let calls: Array<{ url: string; method: string; body: any }>;
let loseVersionResponse: boolean;
let rejectWriteStatus: number | undefined;
let rejectCommittedVersionRead: boolean;
let localCallerCanActAs: boolean;
let bucketProjectNumber: string;
let ciAccountUniqueId: string;
let loseDeleteResponse: boolean;
let retainDelete: boolean;
let loseArchivePolicyResponse: boolean;
let job: any;
let execution: any;
let task: any;
let shortParentNames = false;
let jobFault: 'failed' | 'lost-run' | 'retained-delete' | 'wrong-operation' | 'missing-task-status' | 'wrong-task-identity' | 'stale-generation' | 'wrong-execution-parent' | 'wrong-task-parent' | 'wrong-cleanup-parent' | undefined;

beforeEach(() => {
  target = { environment: { id: envId, projectId: 'local-project', name: 'staging', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'cloudrun', projectId, environmentId: region, services: {} } }, database: { provider: 'cloudsql', primaryExternalId: instance, providerScope: { projectId, region }, resourceIdentity: { instanceId: instance } }, destination: { provider: 'gcs', externalId: 'sequence-archive', instanceScope: { projectId } }, objects: [{ name: 'media', identity: { provider: 'gcs', externalId: 'sequence-media', instanceScope: { projectId } } }], runnerImage, privateInputFingerprints: { databaseUrl: credentialHash } };
  sa = undefined; secret = undefined; versions = []; policies = new Map(); calls = []; loseVersionResponse = false; rejectWriteStatus = undefined; rejectCommittedVersionRead = false;
  shortParentNames = false; job = undefined; execution = undefined; task = undefined; jobFault = undefined; localCallerCanActAs = true; bucketProjectNumber = projectNumber; ciAccountUniqueId = ciIdentity.serviceAccountUniqueId; loseDeleteResponse = false; retainDelete = false; loseArchivePolicyResponse = false;
  sql = { name: instance, project: projectId, region, connectionName: `${projectId}:${region}:${instance}`, databaseVersion: 'POSTGRES_17', state: 'RUNNABLE', settings: { ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [] } }, ipAddresses: [{ type: 'PRIMARY', ipAddress: '203.0.113.20' }] };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: url.toString(), method, body });
    if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: localCallerCanActAs ? ['iam.serviceAccounts.actAs'] : [] });
    if (rejectCommittedVersionRead && method === 'GET' && versions.length > 0 && url.pathname.endsWith(':access')) return Response.json({ error: { code: 403 } }, { status: 403 });
    if (rejectWriteStatus && ['POST', 'PUT'].includes(method) && !url.pathname.endsWith(':getIamPolicy')) return Response.json({ error: { code: rejectWriteStatus, message: 'synthetic-private-password' } }, { status: rejectWriteStatus });
    if (url.hostname === 'run.googleapis.com') {
      if (method === 'GET' && url.pathname.endsWith('/jobs')) return Response.json({ jobs: job ? [job] : [] });
      const operation = (kind: string, response: any) => Response.json({ name: `projects/${jobFault === 'wrong-operation' ? 'another-project' : projectId}/locations/${region}/operations/${kind}`, done: true, response });
      if (method === 'POST' && url.pathname.endsWith('/jobs')) {
        job = { ...body, name: `projects/${projectId}/locations/${region}/jobs/${url.searchParams.get('jobId')}`, uid: '22222222-2222-4222-8222-222222222222', etag: 'job-etag', generation: '1', observedGeneration: jobFault === 'stale-generation' ? '0' : '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' } };
        return operation('create-job', job);
      }
      if (method === 'POST' && url.pathname.endsWith(':run')) {
        execution = { name: `${job.name}/executions/one`, uid: '33333333-3333-4333-8333-333333333333', job: shortParentNames ? job.name.split('/').at(-1) : job.name, labels: job.labels, template: job.template.template, taskCount: 1, succeededCount: jobFault === 'failed' ? 0 : 1, ...(jobFault === 'failed' ? { failedCount: 1 } : {}), conditions: [{ type: 'Completed', state: jobFault === 'failed' ? 'CONDITION_FAILED' : 'CONDITION_SUCCEEDED' }], completionTime: '2026-10-24T12:00:00Z', etag: 'execution-etag' };
        task = { name: `${execution.name}/tasks/0`, uid: '44444444-4444-4444-8444-444444444444', execution: shortParentNames ? execution.name.split('/').at(-1) : execution.name, job: shortParentNames ? job.name.split('/').at(-1) : job.name, completionTime: execution.completionTime, ...job.template.template, serviceAccount: jobFault === 'wrong-task-identity' ? `deploy@${projectId}.iam.gserviceaccount.com` : job.template.template.serviceAccount, lastAttemptResult: { ...(jobFault !== 'missing-task-status' ? { status: {} } : {}), ...(jobFault === 'failed' ? { exitCode: 1 } : {}) } };
        // The recorded native Task also omits uid; scope comes from the full
        // task path under the exact UID-verified Execution, never a short name.
        if (shortParentNames) delete task.uid;
        if (jobFault === 'wrong-execution-parent') execution.job = job.name.replace(projectId, 'other-project');
        if (jobFault === 'wrong-task-parent') task.execution = execution.name.replace(projectId, 'other-project');
        if (jobFault === 'lost-run') throw new Error('Lost execution response, credential could be echoed by a provider');
        return operation('run-job', execution);
      }
      if (url.pathname.endsWith('/tasks')) {
        if (jobFault === 'wrong-cleanup-parent') execution.job = job.name.replace(projectId, 'other-project');
        return Response.json({ tasks: [task] });
      }
      if (url.pathname.includes('/executions/')) {
        if (method === 'DELETE') { const previous = execution; execution = undefined; return operation('delete-execution', previous); }
        return execution ? Response.json(execution) : Response.json({ error: { code: 404 } }, { status: 404 });
      }
      if (method === 'DELETE') {
        const previous = job; if (jobFault !== 'retained-delete') job = undefined;
        return operation('delete-job', previous);
      }
      return job ? Response.json(job) : Response.json({ error: { code: 404 } }, { status: 404 });
    }
    if (url.hostname === 'sqladmin.googleapis.com') return Response.json(sql);
    if (url.hostname === 'cloudresourcemanager.googleapis.com' && method === 'GET') return Response.json({ projectId, name: `projects/${projectNumber}`, state: 'ACTIVE' });
    if (url.hostname === 'compute.googleapis.com') return Response.json({ name: 'backup', selfLink: `https://www.googleapis.com/compute/v1/projects/${projectId}/regions/${region}/subnetworks/backup`, network: `https://www.googleapis.com/compute/v1/projects/${projectId}/global/networks/private`, region: `https://www.googleapis.com/compute/v1/projects/${projectId}/regions/${region}` });
    if (url.hostname === 'storage.googleapis.com' && !url.pathname.endsWith('/iam')) {
      if (url.pathname === '/storage/v1/b') return Response.json({ items: [{ name: url.searchParams.get('prefix'), location: region, labels: { hypervibe_environment_id: envId } }] });
      if (url.pathname.includes('/o/')) return Response.json({ error: { code: 404 } }, { status: 404 });
      if (url.pathname.endsWith('/o')) return Response.json({ items: [] });
      return Response.json({ name: url.pathname.split('/').at(-1), projectNumber: bucketProjectNumber, location: region, labels: { hypervibe_environment_id: envId } });
    }
    if (/:(get|set)IamPolicy$/.test(url.pathname) || url.pathname.endsWith('/iam')) {
      const key = url.origin + (url.hostname === 'secretmanager.googleapis.com'
        ? url.pathname.replace(`/projects/${projectId}/`, `/projects/${projectNumber}/`) : url.pathname).replace(/:(get|set)IamPolicy$/, ':policy');
      if (url.pathname.endsWith(':setIamPolicy') || method === 'PUT') policies.set(key, { ...(body.policy ?? body), etag: 'updated-etag' });
      if (loseArchivePolicyResponse && method === 'PUT' && url.pathname === '/storage/v1/b/sequence-archive/iam') throw new Error('synthetic lost archive grant response');
      return Response.json(policies.get(key) ?? { version: 3, etag: 'initial-etag', bindings: [{ role: 'roles/viewer', members: ['user:retained@example.test'] }] });
    }
    if (url.hostname === 'iam.googleapis.com') {
      if (method === 'DELETE') { if (!retainDelete) sa = undefined; if (loseDeleteResponse) throw new Error('lost delete acknowledgement'); return Response.json({}); }
      if (method === 'GET' && url.pathname.endsWith(`/serviceAccounts/${ciIdentity.serviceAccountUniqueId}`))
        return Response.json({ projectId, email: ciIdentity.serviceAccountEmail, uniqueId: ciAccountUniqueId, disabled: false });
      if (method === 'POST' && url.pathname.endsWith('/serviceAccounts')) {
        sa = { name: `projects/${projectId}/serviceAccounts/${body.accountId}@${projectId}.iam.gserviceaccount.com`, projectId, email: `${body.accountId}@${projectId}.iam.gserviceaccount.com`, uniqueId: '123456789012345678901', description: body.serviceAccount.description };
        return Response.json(sa);
      }
      return sa ? Response.json(sa) : Response.json({ error: { code: 404 } }, { status: 404 });
    }
    if (url.hostname === 'secretmanager.googleapis.com') {
      if (method === 'DELETE') { if (!retainDelete) secret = undefined; if (loseDeleteResponse) throw new Error('lost delete acknowledgement'); return Response.json({}); }
      if (url.pathname.endsWith(':addVersion')) {
        const version = { name: `${secret.name}/versions/${versions.length + 1}`, state: 'ENABLED', payload: body.payload };
        versions.push(version);
        if (loseVersionResponse) throw new Error('Lost response after committed version');
        return Response.json({ name: version.name, state: version.state });
      }
      if (url.pathname.endsWith('/versions')) return Response.json({ versions: versions.map(({ payload: _payload, ...version }) => version) });
      if (/\/versions\/\d+:access$/.test(url.pathname)) {
        const version = versions.find(item => item.name === url.pathname.slice(4).replace(/:access$/, '').replace(`projects/${projectId}/`, `projects/${projectNumber}/`));
        return Response.json({ name: version.name, payload: version.payload });
      }
      if (/\/versions\/\d+$/.test(url.pathname)) {
        const version = versions.find(item => item.name === url.pathname.slice(4).replace(`projects/${projectId}/`, `projects/${projectNumber}/`));
        return version ? Response.json({ name: version.name, state: version.state }) : Response.json({ error: { code: 404 } }, { status: 404 });
      }
      if (method === 'POST' && url.pathname.endsWith('/secrets')) {
        secret = { name: `projects/${projectNumber}/secrets/${url.searchParams.get('secretId')}`, labels: body.labels, etag: 'secret-etag', replication: { automatic: {} } };
        return Response.json(secret);
      }
      return secret ? Response.json(secret) : Response.json({ error: { code: 404 } }, { status: 404 });
    }
    throw new Error('Unexpected Google REST request');
  }));
});

describe('Cloud Run private recovery job transport', () => {
  async function execute() {
    const runtime = driver(); let binding: RecoveryRuntimeBinding | undefined; let executionTarget: any;
    for (let index = 0; index < 12; index++) {
      const observed = await runtime.inspect({ target, binding, mode: 'ensure' });
      if (observed.state === 'ready') { executionTarget = observed.executionTarget; break; }
      if (observed.state !== 'action') throw new Error(JSON.stringify(observed));
      const attemptId = `attempt-${index}`;
      binding = { provider: 'cloudrun', evidence: binding?.evidence ?? {}, pending: { attemptId, step: observed.step } };
      const result = await runtime.apply({ target, binding, mode: 'ensure', step: observed.step, attemptId, ...(observed.step.privateInputKeys ? { privateInputs: { databaseUrl } } : {}) });
      if (!result.receipt.success) throw new Error(JSON.stringify(result));
      binding = result.binding;
    }
    const executionId = '55555555-5555-4555-8555-555555555555';
    const config = { version: 1, operation: 'recovery-set', project: 'sequence', environment: 'staging', runId: executionId, contractHash: 'a'.repeat(64), database: { source: target.database }, destination: target.destination, archiveBucket: target.destination.externalId,
      objects: target.objects.map(object => ({ ...object, bucket: object.identity.externalId })), nativeAccess: executionTarget.worker };
    const adapter = new CloudRunAdapter();
    await adapter.connect({ projectId, region, credentials: JSON.stringify({ type: 'service_account', project_id: projectId, client_email: `deploy@${projectId}.iam.gserviceaccount.com`, private_key: 'synthetic' }) });
    Object.assign(adapter, { accessToken: 'synthetic-deployer-token', tokenExpiry: new Date(Date.now() + 60_000) });
    const now = new Date();
    return adapter.runJob(target.environment, { id: 'backup', projectId: 'local-project', name: 'backup', buildConfig: { builder: 'dockerfile' }, envVarSpec: {}, createdAt: now, updatedAt: now }, 'node /opt/hypervibe/dist/ci/backup-runner.js', { timeoutMs: 100, pollIntervalMs: 1, managedRecoveryTask: { variableMode: 'references', sweep: false, executionId, expectedImage: runnerImage, databaseSource: target.database, executionTarget,
        variableReferences: [], variables: { HYPERVIBE_BACKUP_CONFIG: JSON.stringify(config) } } });
  }

  it('verifies scoped recovery executions and tasks with short native parent references', async () => {
    shortParentNames = true;
    const result = await execute();
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, receipt: { success: true, data: { cleanupVerified: true } } });
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith(':run'))).toHaveLength(1);
  });

  it('executes only the pinned helper under its prepared identity, then proves task and job cleanup', async () => {
    const result = await execute();
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, receipt: { success: true, data: { cleanupVerified: true } } });
    const create = calls.find(call => call.method === 'POST' && call.url.includes('run.googleapis.com') && call.url.includes('/jobs?'))!;
    expect(create.body.template.template).toMatchObject({ serviceAccount: sa.email, maxRetries: 0, containers: [{ image: runnerImage, command: ['node'], args: ['/opt/hypervibe/dist/ci/backup-runner.js'] }] });
    expect(create.body.template.template.containers[0].env).toContainEqual({ name: 'HYPERVIBE_BACKUP_DATABASE_URL', valueSource: { secretKeyRef: { secret: secret.name, version: '1' } } });
    expect(JSON.stringify(create.body)).not.toContain('synthetic-private-password');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-password');
    expect(calls.filter(call => call.method === 'DELETE' && call.url.includes('run.googleapis.com'))).toHaveLength(2);
    expect(secret).toBeDefined(); // Durable prepared credential, not an ephemeral export.
  });

  it.each(['failed', 'lost-run', 'retained-delete', 'wrong-operation', 'missing-task-status', 'wrong-task-identity', 'stale-generation', 'wrong-execution-parent', 'wrong-task-parent', 'wrong-cleanup-parent'] as const)('never certifies %s as a completed recovery', async fault => {
    jobFault = fault;
    const result = await execute();
    expect(result.receipt.success).toBe(false);
    expect(result.output).toBeUndefined();
    if (fault === 'lost-run') expect(calls.some(call => call.method === 'DELETE' && call.url.includes('run.googleapis.com'))).toBe(false);
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith(':run'))).toHaveLength(['wrong-operation', 'stale-generation'].includes(fault) ? 0 : 1);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function driver() {
  return new CloudRunRecoveryRuntime({ connection: () => ({ projectId, region, deployerEmail: `deploy@${projectId}.iam.gserviceaccount.com` }), token: async () => 'synthetic-deployer-token', adminToken: async () => 'synthetic-admin-token' });
}

async function advanceUntil(component: string, runtime = driver()) {
  let binding: RecoveryRuntimeBinding | undefined;
  for (let index = 0; index < 12; index++) {
    const observed = await runtime.inspect({ target, binding, mode: 'ensure' });
    if (observed.state !== 'action') throw new Error(JSON.stringify(observed));
    const attemptId = `attempt-${index}`;
    binding = { provider: 'cloudrun', evidence: binding?.evidence ?? {}, pending: { attemptId, step: observed.step } };
    if (observed.step.component === component) return { runtime, binding, step: observed.step, attemptId };
    const result = await runtime.apply({ target, binding, mode: 'ensure', step: observed.step, attemptId, ...(observed.step.privateInputKeys ? { privateInputs: { databaseUrl } } : {}) });
    if (!result.receipt.success) throw new Error(JSON.stringify(result));
    binding = result.binding;
  }
  throw new Error('Missing preparation step');
}

describe('Cloud Run staged recovery preparation', () => {
  it('recovers a created numeric-project secret from its original intent without a second create', async () => {
    const staged = await advanceUntil('database-secret');
    await staged.runtime.apply({ ...staged, target, mode: 'ensure' });
    // Retain the original pending state, as after a lost acknowledgement or the
    // old project-ID-only ownership check. Creation is independently observable.
    expect(secret.name).toMatch(new RegExp(`^projects/${projectNumber}/secrets/`));
    const observed = await staged.runtime.inspect({ target, binding: staged.binding, mode: 'ensure' });
    expect(observed).toMatchObject({ state: 'action', step: { component: 'database-secret', operation: 'recover', target: staged.step.target } });
    if (observed.state !== 'action') throw new Error('Missing read-only recovery');
    const before = calls.length;
    expect((await staged.runtime.apply({ ...staged, target, mode: 'ensure', step: observed.step })).receipt.success).toBe(true);
    expect(calls.slice(before).every(call => call.method === 'GET' || call.url.endsWith(':getIamPolicy'))).toBe(true);
    expect(calls.filter(call => call.method === 'POST' && call.url.includes('/secrets?secretId='))).toHaveLength(1);
  });

  it('rejects an identical secret name and ownership labels in another numeric project', async () => {
    const staged = await advanceUntil('database-secret');
    await staged.runtime.apply({ ...staged, target, mode: 'ensure' });
    secret.name = secret.name.replace(projectNumber, '923456789012');
    calls = [];
    expect(await staged.runtime.inspect({ target, binding: staged.binding, mode: 'ensure' })).toMatchObject({ state: 'unknown' });
    expect(calls.every(call => call.method === 'GET' || call.url.endsWith(':getIamPolicy'))).toBe(true);
  });

  it('preserves a previously recorded project-ID version while observing its numeric native name', async () => {
    const staged = await advanceUntil('archive-access');
    const binding = { provider: 'cloudrun', evidence: { ...staged.binding.evidence,
      secretVersion: staged.binding.evidence.secretVersion!.replace(projectNumber, projectId) } };
    const before = structuredClone(binding);
    expect(await staged.runtime.inspect({ target, binding, mode: 'ensure' })).toMatchObject({ state: 'action', step: { component: 'archive-access' } });
    expect(binding).toEqual(before);
  });

  it('rejects duplicate version aliases instead of treating them as distinct writes', async () => {
    const staged = await advanceUntil('archive-access');
    versions.push({ ...versions[0], name: versions[0].name.replace(projectNumber, projectId) });
    expect(await staged.runtime.inspect({ target, binding: { provider: 'cloudrun', evidence: staged.binding.evidence }, mode: 'ensure' })).toMatchObject({ state: 'unknown' });
  });

  it.each([false, true])('prepares only the native-verified CI principal from its retained authorization; replaced=%s', async replaced => {
    target.environment.platformBindings.gcpGithubWorkloadIdentity = JSON.stringify(ciIdentity);
    if (replaced) ciAccountUniqueId = '923456789012345678901';
    const runtime = new CloudRunRecoveryRuntime({ connection: () => ({ projectId, region, defaultAuthentication: true }),
      token: async () => 'synthetic-local-user-token' });
    const first = await runtime.inspect({ target, mode: 'ensure' });
    if (replaced) {
      expect(first).toMatchObject({ state: 'unknown' });
      expect(calls.some(call => ['POST', 'PUT', 'DELETE'].includes(call.method))).toBe(false);
      return;
    }
    expect(first).toMatchObject({ state: 'action', step: { component: 'identity' } });
    if (first.state !== 'action') throw new Error('Missing identity creation');
    const binding = { provider: 'cloudrun', evidence: {}, pending: { attemptId: 'ci-worker-identity', step: first.step } };
    const created = await runtime.apply({ target, binding, mode: 'ensure', step: first.step, attemptId: 'ci-worker-identity' });
    expect(created.receipt.success).toBe(true);
    expect(await runtime.inspect({ target, binding: created.binding, mode: 'ensure' })).toMatchObject({
      state: 'action', step: { component: 'deployer-access', target: { member: `serviceAccount:${ciIdentity.serviceAccountEmail}` } } });
  });

  it('recovers an uncertain controller archive grant without another IAM write', async () => {
    target.environment.platformBindings.gcpGithubWorkloadIdentity = JSON.stringify(ciIdentity);
    const runtime = new CloudRunRecoveryRuntime({ connection: () => ({ projectId, region, defaultAuthentication: true }),
      token: async () => 'synthetic-local-user-token', adminToken: async () => 'synthetic-local-user-token' });
    const f = await advanceUntil('controller-archive-access', runtime);
    loseArchivePolicyResponse = true; calls = [];
    const result = await runtime.apply({ target, mode: 'ensure', ...f });
    expect(result.receipt.success).toBe(false);
    const observed = await runtime.inspect({ target, binding: f.binding, mode: 'ensure' });
    expect(observed).toMatchObject({ state: 'action', step: { component: 'controller-archive-access', operation: 'recover' } });
    if (observed.state !== 'action') throw new Error('Missing read-only recovery');
    const recovered = await runtime.apply({ target, mode: 'ensure', ...f, step: observed.step });
    expect(recovered.receipt.success).toBe(true);
    // The real native receipt must survive the same value-free boundary used by
    // shared plan/apply and the serialized helper execution contract.
    expect(() => recoveryRuntimeBindings(recovered.binding)).not.toThrow();
    expect(runtimeExecutionCoordinatesSchema.safeParse({ binding: JSON.stringify(recovered.binding) }).success).toBe(true);
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(JSON.stringify(recovered)).not.toContain(databaseUrl);
  });

  it('rejects an environment-labelled bucket belonging to another native project before preparation', async () => {
    bucketProjectNumber = '999999999999';
    expect(await driver().inspect({ target, mode: 'ensure' })).toMatchObject({ state: 'unknown' });
    expect(calls.some(call => ['POST', 'PUT', 'DELETE'].includes(call.method))).toBe(false);
  });
  it.each([true, false])('checks native local caller actAs authority without inventing a service-account member: %s', async authorized => {
    localCallerCanActAs = authorized;
    const runtime = new CloudRunRecoveryRuntime({ connection: () => ({ projectId, region, defaultAuthentication: true }),
      token: async () => 'synthetic-local-user-token', adminToken: async () => 'synthetic-local-user-token' });
    const first = await runtime.inspect({ target, mode: 'ensure' });
    expect(first).toMatchObject({ state: 'action', step: { component: 'identity' } });
    if (first.state !== 'action') throw new Error('Missing reviewed identity creation');
    const binding = { provider: 'cloudrun', evidence: {}, pending: { attemptId: 'local-identity', step: first.step } };
    const created = await runtime.apply({ target, binding, mode: 'ensure', step: first.step, attemptId: 'local-identity' });
    expect(created.receipt.success).toBe(true);
    const next = await runtime.inspect({ target, binding: created.binding, mode: 'ensure' });
    expect(next).toMatchObject(authorized ? { state: 'action', step: { component: 'database-access' } } : { state: 'unknown' });
    expect(calls.some(call => call.url.endsWith(':testIamPermissions') && call.body.permissions[0] === 'iam.serviceAccounts.actAs')).toBe(true);
    expect(calls.some(call => call.url.endsWith(':setIamPolicy'))).toBe(false);
  });

  it('prepares native SQL/GCS recovery before any application service exists, one resource step at a time', async () => {
    const runtime = driver(); let binding: RecoveryRuntimeBinding | undefined;
    const components: string[] = [];
    for (let index = 0; index < 12; index++) {
      const observed = await runtime.inspect({ target, binding, mode: 'ensure' });
      if (observed.state === 'ready') {
        expect(observed.executionTarget).toMatchObject({ provider: 'cloudrun', worker: { provider: 'cloudrun', configuration: { projectId, instanceConnectionName: `${projectId}:${region}:${instance}`, ipType: 'PUBLIC', runtimeServiceAccountEmail: sa.email } } });
        expect(components).toEqual(['identity', 'deployer-access', 'database-access', 'database-secret', 'database-secret-version', 'database-secret-access', 'archive-access', 'source-access:media']);
        expect(JSON.stringify(observed)).not.toContain('synthetic-private-password');
        expect(calls.some(call => call.url.includes('/services/'))).toBe(false);
        return;
      }
      expect(observed.state).toBe('action');
      if (observed.state !== 'action') throw new Error(JSON.stringify(observed));
      const before = calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method) && !call.url.includes(':getIamPolicy')).length;
      const attemptId = `attempt-${index}`;
      binding = { provider: 'cloudrun', evidence: binding?.evidence ?? {}, pending: { attemptId, step: observed.step } };
      const result = await runtime.apply({ target, binding, mode: 'ensure', step: observed.step, attemptId, ...(observed.step.privateInputKeys ? { privateInputs: { databaseUrl } } : {}) });
      expect(result.receipt.success, JSON.stringify(result)).toBe(true);
      expect(calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method) && !call.url.includes(':getIamPolicy')).length - before).toBe(1);
      components.push(observed.step.component); binding = result.binding;
    }
    throw new Error('Preparation did not reach ready');
  });

  it.each(['identity', 'deployer-access', 'database-secret', 'database-secret-version'])('keeps an uncertain %s attempt pending while its effect is absent', async component => {
    const staged = await advanceUntil(component);
    const before = calls.length;
    expect(await staged.runtime.inspect({ target, binding: staged.binding, mode: 'ensure' })).toMatchObject({ state: 'waiting' });
    expect(calls.slice(before).every(call => call.method === 'GET' || call.url.includes(':getIamPolicy'))).toBe(true);
  });

  it('blocks a private-only source with no observed VPC route without mutation', async () => {
    sql.settings.ipConfiguration = { ipv4Enabled: false, privateNetwork: `projects/${projectId}/global/networks/private` };
    sql.ipAddresses = [{ type: 'PRIVATE', ipAddress: '10.0.0.5' }];
    expect(await driver().inspect({ target, mode: 'ensure' })).toMatchObject({ state: 'unknown' });
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('independently reads the exact prepared VPC subnet before selecting PRIVATE connectivity', async () => {
    sql.settings.ipConfiguration = { ipv4Enabled: false, privateNetwork: `projects/${projectId}/global/networks/private` };
    sql.ipAddresses = [{ type: 'PRIVATE', ipAddress: '10.0.0.5' }];
    target.environment.platformBindings.cacheNetwork = { provider: 'cloudrun', projectId, region, network: 'private', subnetwork: 'backup', egress: 'PRIVATE_RANGES_ONLY' };
    expect(await driver().inspect({ target, mode: 'ensure' })).toMatchObject({ state: 'action', step: { component: 'identity' } });
    expect(calls.some(call => call.url === `https://compute.googleapis.com/compute/v1/projects/${projectId}/regions/${region}/subnetworks/backup`)).toBe(true);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('does not infer an application admin identity or source database scope', async () => {
    target.database.providerScope.projectId = 'another-project';
    expect(await driver().inspect({ target, mode: 'ensure' })).toMatchObject({ state: 'unknown' });
    expect(calls).toEqual([]);
  });

  it('uses Google label values within the published 63-character limit', async () => {
    const staged = await advanceUntil('database-secret');
    expect((await staged.runtime.apply({ ...staged, target, mode: 'ensure' })).receipt.success).toBe(true);
    const created = calls.find(call => call.method === 'POST' && call.url.includes('/secrets?secretId='))!;
    expect(Object.values(created.body.labels).every(value => typeof value === 'string' && value.length <= 63)).toBe(true);
  });

  it('recovers a lost secret-version response from one exact new immutable version without writing another', async () => {
    const staged = await advanceUntil('database-secret-version');
    loseVersionResponse = true;
    const failed = await staged.runtime.apply({ ...staged, target, mode: 'ensure', privateInputs: { databaseUrl } });
    expect(failed.receipt.success).toBe(false);
    expect(failed.receipt.data).toMatchObject({ mutationAttempted: true });
    expect(failed.receipt.data?.mutationRejected).not.toBe(true);
    expect(JSON.stringify(failed)).not.toContain('synthetic-private-password');
    const inspected = await staged.runtime.inspect({ target, binding: staged.binding, mode: 'ensure' });
    expect(inspected).toMatchObject({ state: 'action', step: { component: 'database-secret-version', operation: 'recover' } });
    if (inspected.state !== 'action') throw new Error('Missing recovery frontier');
    const recovered = await staged.runtime.apply({ ...staged, target, mode: 'ensure', step: inspected.step });
    expect(recovered).toMatchObject({ receipt: { success: true }, binding: { evidence: { secretVersion: versions[0].name, credentialHash } } });
    expect(calls.filter(call => call.url.endsWith(':addVersion'))).toHaveLength(1);
  });

  it.each(['identity', 'deployer-access', 'database-secret', 'database-secret-version'])('classifies a definite rejected %s write separately from an uncertain result', async component => {
    const staged = await advanceUntil(component);
    rejectWriteStatus = 403;
    const result = await staged.runtime.apply({ ...staged, target, mode: 'ensure', ...(staged.step.privateInputKeys ? { privateInputs: { databaseUrl } } : {}) });
    expect(result.receipt).toMatchObject({ success: false, data: { mutationAttempted: true, mutationRejected: true } });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-password');
  });

  it('retains an acknowledged secret write when its verification read is rejected', async () => {
    const staged = await advanceUntil('database-secret-version');
    rejectCommittedVersionRead = true;
    const result = await staged.runtime.apply({ ...staged, target, mode: 'ensure', privateInputs: { databaseUrl } });
    expect(result.receipt).toMatchObject({ success: false, data: { mutationAttempted: true } });
    expect(result.receipt.data?.mutationRejected).not.toBe(true);
    expect(versions).toHaveLength(1);
    rejectCommittedVersionRead = false;
    expect(await staged.runtime.inspect({ target, binding: staged.binding, mode: 'ensure' })).toMatchObject({ state: 'action', step: { operation: 'recover' } });
    expect(calls.filter(call => call.url.endsWith(':addVersion'))).toHaveLength(1);
  });

  it('keeps conflicting encrypted input and ambiguous version recovery blocked', async () => {
    const staged = await advanceUntil('database-secret-version');
    expect((await staged.runtime.apply({ ...staged, target, mode: 'ensure', privateInputs: { databaseUrl: 'different-secret' } })).receipt.success).toBe(false);
    expect(calls.some(call => call.url.endsWith(':addVersion'))).toBe(false);
    loseVersionResponse = true;
    await staged.runtime.apply({ ...staged, target, mode: 'ensure', privateInputs: { databaseUrl } });
    versions.push({ ...versions[0], name: `${secret.name}/versions/2` });
    expect(await staged.runtime.inspect({ target, binding: staged.binding, mode: 'ensure' })).toMatchObject({ state: 'unknown' });
    expect(calls.filter(call => call.url.endsWith(':addVersion'))).toHaveLength(1);
  });
});


describe('shared backup preparation with actual Cloud Run and SQL adapters', () => {
  it('plans and applies each prerequisite before first deployment, keeping private inputs encrypted until committed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hv-native-recovery-'));
    vi.stubEnv('HYPERVIBE_DATA_DIR', directory); SecretStore.resetInstance();
    try {
      sql.settings.settingsVersion = '42'; sql.settings.backupConfiguration = { enabled: true };
      const now = new Date();
      const credentials = { projectId, region, credentials: JSON.stringify({ type: 'service_account', project_id: projectId, client_email: `deploy@${projectId}.iam.gserviceaccount.com`, private_key: 'synthetic' }) };
      const adapter = new CloudRunAdapter(); await adapter.connect(credentials);
      const database = new CloudSqlAdapter(); await database.connect(credentials);
      for (const connected of [adapter, database]) Object.assign(connected, { accessToken: 'synthetic-deployer-token', tokenExpiry: new Date(Date.now() + 60_000) });
      // Inject credential readers only; all provider methods and serialized HTTP remain real.
      Object.assign(adapter.recoveryRuntime, { dependencies: { connection: () => ({ projectId, region, deployerEmail: `deploy@${projectId}.iam.gserviceaccount.com` }), token: async () => 'synthetic-deployer-token', adminToken: async () => 'synthetic-admin-token' } });
      target.environment.platformBindings.storage = Object.fromEntries([{ name: 'archive', identity: target.destination }, ...target.objects].map(object => [object.name, { ...object.identity, region, status: 'ready' }]));
      const context = { project: { id: target.environment.projectId, name: 'sequence', defaultPlatform: 'cloudrun', policies: {}, createdAt: now, updatedAt: now }, environment: target.environment,
        spec: { hosting: { provider: 'cloudrun', region }, services: {}, database: { provider: 'cloudsql', engine: 'postgres' }, storage: { archive: { provider: 'gcs', region, type: 'bucket', purpose: 'backup', injectInto: [] }, media: { provider: 'gcs', region, type: 'bucket', injectInto: [] } }, backups: { mode: 'daily', destination: 'archive', runnerImage, fileReferenceQueries: [{ storageName: 'media', query: 'SELECT object_key FROM files' }] } },
        components: [{ id: 'component', environmentId: envId, externalId: instance, type: 'postgres', createdAt: now, updatedAt: now, bindings: { provider: 'cloudsql', providerScope: { projectId, region }, connectionUrl: databaseUrl } }],
        adapterFactory: { getProviderAdapter: async () => ({ success: true, adapter }), getDatabaseAdapter: async () => ({ success: true, adapter: database }), getStorageAdapter: async () => { throw new Error('Native worker must not export a bucket credential.'); } },
      } as unknown as BackupPolicyContext;
      expect(await resolveManagedBackupTarget(context)).toMatchObject({ state: 'blocked' });
      const pendingBeforeWrites: string[] = [];
      for (let index = 0; index < 12; index++) {
        const observed = await observeRecoveryRuntime(context);
        if (observed.state === 'ready') {
          expect(pendingBeforeWrites).toHaveLength(8);
          expect(planRecoveryRuntime(observed)).toEqual([]);
          const ready = await resolveManagedBackupTarget(context);
          expect(ready).toMatchObject({ state: 'ready', target: { executionTarget: { provider: 'cloudrun', worker: { configuration: { ipType: 'PUBLIC' } } } } });
          expect(JSON.stringify(ready)).not.toContain('synthetic-private-password');
          expect(context.environment!.platformBindings.recoveryRuntimeSecretInputs).toBeUndefined();
          expect(calls.some(call => call.url.includes('/services/'))).toBe(false);
          if (ready.state !== 'ready') throw new Error('Prepared contract unavailable');
          const prepared = ready.target;
          expect(prepared).toMatchObject({ environmentId: envId, hosting: { region }, executionTarget: { environmentId: envId, region } });
          target.environment.platformBindings.recoveryDatabases = [{ componentId: 'component', provider: 'cloudsql', engine: 'postgres', externalId: instance }];
          const spec = { version: 1, project: 'sequence', gitRemoteUrl: 'git@github.com:owner/sequence.git', runtime: { kind: 'node', version: '24' }, environments: { staging: context.spec } };
          const bindings = { version: 1, project: 'sequence', environments: { staging: { platformBindings: target.environment.platformBindings } } };
          const files = new Map(compileBackupWorkflow({ project: 'sequence', environment: 'staging', contractHash: ready.contractHash, runnerImage, providerCredentialNames: ready.providerCredentialNames, contract: prepared }).map(file => [file.path, file.content]));
          files.set('.hypervibe/spec.json', JSON.stringify(spec)); files.set('.hypervibe/bindings.json', JSON.stringify(bindings));
          const sha = 'b'.repeat(40);
          const github = { getRepository: async () => ({ default_branch: 'main' }), getRef: async () => ({ object: { sha } }), getFileContent: async (_owner: string, _repo: string, path: string) => files.get(path) ?? null,
            listWorkflows: async () => ({ total_count: 1, workflows: [{ path: '.github/workflows/hypervibe-backup-staging.yml', state: 'active' }] }) };
          const authority = await verifyManagedBackupAuthority({ target: prepared, contractHash: ready.contractHash, runnerImage, repository: 'owner/sequence', sha, ref: 'refs/heads/main', github: github as any });
          expect(authority.environment).toMatchObject({ id: envId, name: 'staging' });
          // A new CI connection begins at its provider default; dispatch must
          // restore reviewed placement rather than reuse the in-memory planner.
          const ciHosting = new CloudRunAdapter(); await ciHosting.connect({ ...credentials, region: undefined });
          Object.assign(ciHosting, { accessToken: 'synthetic-deployer-token', tokenExpiry: new Date(Date.now() + 60_000) });
          const gcs = new GcsStorageAdapter({ fetch, mediaFetch: fetch, tokenProvider: async () => ({ token: 'synthetic-deployer-token', email: `deploy@${projectId}.iam.gserviceaccount.com` }) }); await gcs.connect(credentials);
          vi.spyOn(providerRegistry, 'createAdapter').mockImplementation(async provider => {
            if (provider === 'cloudrun') return ciHosting;
            if (provider === 'cloudsql') return database;
            if (provider === 'gcs') return gcs;
            throw new Error('Unexpected recovery provider');
          });
          let failure: any;
          try { await executeManagedBackup({ target: authority.target, environment: authority.environment, operation: 'backup', repository: 'owner/sequence', runId: '123', credentials: { GCP_PROJECT_ID: projectId, GCP_SERVICE_ACCOUNT_JSON: credentials.credentials } }); }
          catch (error) { failure = error; }
          // REST transport proves dispatch and cleanup. No helper process ran,
          // so there is deliberately no completed archive manifest to certify.
          expect(failure?.diagnostic?.stage).toBe('completion-record');
          expect(calls.filter(call => call.method === 'POST' && call.url.includes('/jobs?'))).toHaveLength(1);
          expect(calls.filter(call => call.method === 'DELETE' && call.url.includes('run.googleapis.com'))).toHaveLength(2);
          expect(calls.some(call => call.url.includes('us-central1'))).toBe(false);
          return;
        }
        const action = planRecoveryRuntime(observed)[0]!;
        expect(action?.verified, JSON.stringify(observed)).toBe(true);
        expect(JSON.stringify(action)).not.toContain('synthetic-private-password');
        const result = await applyRecoveryRuntimeAction({ context, action, confirmedActionIds: new Set([action.id]), save: async patch => {
          expect(JSON.stringify(patch)).not.toContain('synthetic-private-password');
          if (patch.recoveryRuntime?.pending) pendingBeforeWrites.push(patch.recoveryRuntime.pending.step.component);
          for (const [key, value] of Object.entries(patch)) if (value === undefined) delete target.environment.platformBindings[key]; else target.environment.platformBindings[key] = value;
        } });
        expect(result.success, JSON.stringify(result)).toBe(true);
      }
      throw new Error('Shared preparation did not converge');
    } finally { SecretStore.resetInstance(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });
});


describe('reviewed recovery teardown preserves backup data and unrelated access', () => {
  async function prepared(runtime = driver()) {
    let binding: RecoveryRuntimeBinding | undefined;
    for (let index = 0; index < 15; index++) {
      const observed = await runtime.inspect({ target, binding, mode: 'ensure' });
      if (observed.state === 'ready') return { runtime, binding: binding! };
      if (observed.state !== 'action') throw new Error(JSON.stringify(observed));
      const attemptId = `prepare-${index}`;
      const result = await runtime.apply({ target, mode: 'ensure', step: observed.step, attemptId,
        binding: { provider: 'cloudrun', evidence: binding?.evidence ?? {}, pending: { attemptId, step: observed.step } },
        ...(observed.step.privateInputKeys ? { privateInputs: { databaseUrl } } : {}) });
      if (!result.receipt.success) throw new Error(JSON.stringify(result));
      binding = result.binding;
    }
    throw new Error('Preparation did not terminate');
  }
  function clearDedicatedPolicies() {
    for (const [key, policy] of policies) if (key.includes('iam.googleapis.com') || key.includes('secretmanager.googleapis.com'))
      policies.set(key, { ...policy, bindings: policy.bindings.filter((b: any) => b.role !== 'roles/viewer') });
  }
  async function removalUntil(component: string) {
    const f = await prepared(); clearDedicatedPolicies(); let binding = f.binding;
    for (let index = 0; index < 12; index++) {
      const observed = await f.runtime.inspect({ target, binding, mode: 'destroy' });
      if (observed.state !== 'action') throw new Error(JSON.stringify(observed));
      const attemptId = `remove-${index}`;
      binding = { ...binding, pending: { attemptId, step: observed.step } };
      if (observed.step.component === component) return { ...f, binding, step: observed.step, attemptId };
      const result = await f.runtime.apply({ target, binding, mode: 'destroy', step: observed.step, attemptId });
      if (!result.receipt.success) throw new Error(JSON.stringify(result)); binding = result.binding!;
    }
    throw new Error('No removal frontier');
  }
  it.each([false, true])('limits controller object access to its archive and verifies lifetime during removal: replaced=%s', async replaced => {
    target.environment.platformBindings.gcpGithubWorkloadIdentity = JSON.stringify(ciIdentity);
    const runtime = new CloudRunRecoveryRuntime({ connection: () => ({ projectId, region, defaultAuthentication: true }),
      token: async () => 'synthetic-local-user-token', adminToken: async () => 'synthetic-local-user-token' });
    const f = await prepared(runtime);
    const controller = `serviceAccount:${ciIdentity.serviceAccountEmail}`;
    const archiveKey = 'https://storage.googleapis.com/storage/v1/b/sequence-archive/iam';
    const sourceKey = 'https://storage.googleapis.com/storage/v1/b/sequence-media/iam';
    expect(policies.get(archiveKey).bindings).toContainEqual({ role: 'roles/storage.objectUser', members: expect.arrayContaining([controller]) });
    expect(policies.get(sourceKey).bindings.some((b: any) => b.members.includes(controller))).toBe(false);
    expect(calls.some(call => call.url.includes('cloudresourcemanager') && call.url.endsWith(':setIamPolicy')
      && call.body.policy.bindings.some((b: any) => b.role.startsWith('roles/storage.')))).toBe(false);
    expect(f.binding.evidence.controllerUniqueId).toBe(ciIdentity.serviceAccountUniqueId);
    clearDedicatedPolicies();
    // Removal remains possible after separately authorized CI trust is disconnected.
    delete target.environment.platformBindings.gcpGithubWorkloadIdentity;
    if (replaced) ciAccountUniqueId = '923456789012345678901';
    let binding = f.binding; calls = []; const removalOrder: string[] = [];
    for (let index = 0; index < 15; index++) {
      const observed = await runtime.inspect({ target, binding, mode: 'destroy' });
      if (replaced) { expect(observed.state).toBe('unknown'); break; }
      if (observed.state === 'ready') break;
      expect(observed.state, JSON.stringify(observed)).toBe('action');
      if (observed.state !== 'action') throw new Error('Missing removal frontier');
      removalOrder.push(observed.step.component);
      const attemptId = `controller-remove-${index}`;
      const result = await runtime.apply({ target, mode: 'destroy', step: observed.step, attemptId,
        binding: { ...binding, pending: { attemptId, step: observed.step } } });
      expect(result.receipt.success, JSON.stringify(result)).toBe(true); binding = result.binding!;
    }
    if (replaced) expect(calls.every(call => call.method === 'GET' || call.url.includes(':getIamPolicy'))).toBe(true);
    else {
      expect(await runtime.inspect({ target, binding, mode: 'destroy' })).toMatchObject({ state: 'ready' });
      expect(policies.get(archiveKey).bindings).toEqual([{ role: 'roles/viewer', members: ['user:retained@example.test'] }]);
      expect(removalOrder[0]).toBe('deployer-access');
      expect(removalOrder.indexOf('controller-archive-access')).toBeLessThan(removalOrder.indexOf('archive-access'));
      expect(removalOrder.indexOf('archive-access')).toBeLessThan(removalOrder.indexOf('database-secret'));
      expect(removalOrder.at(-1)).toBe('identity');
    }
  });
  it.each([false, true])('does not repeat a deletion after lost acknowledgement; still present=%s', async retained => {
    const f = await removalUntil('database-secret');
    retainDelete = retained; loseDeleteResponse = true; calls = [];
    const result = await f.runtime.apply({ target, mode: 'destroy', ...f });
    expect(result.receipt.success).toBe(false);
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    const observed = await f.runtime.inspect({ target, binding: f.binding, mode: 'destroy' });
    expect(observed.state).toBe(retained ? 'waiting' : 'action');
    if (!retained && observed.state === 'action') {
      expect(observed.step.operation).toBe('recover');
      const recovered = await f.runtime.apply({ target, mode: 'destroy', ...f, step: observed.step });
      expect(recovered.receipt.success).toBe(true);
    }
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
  it('preserves an independently added secret reader and blocks credential deletion', async () => {
    const f = await prepared(); clearDedicatedPolicies();
    const key = `https://secretmanager.googleapis.com/v1/${secret.name}:policy`;
    const policy = policies.get(key); policy.bindings.push({ role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:independent-runtime@example.iam.gserviceaccount.com'] });
    calls = [];
    expect(await f.runtime.inspect({ target, binding: f.binding, mode: 'destroy' })).toMatchObject({ state: 'unknown' });
    expect(secret).toBeDefined(); expect(sa).toBeDefined();
    expect(calls.some(call => call.method === 'DELETE' || call.method === 'PUT' || call.url.includes(':setIamPolicy'))).toBe(false);
  });
  it.each([false, true])('reviews reverse frontiers and preserves archive data with legacy version aliases=%s', async legacyAliases => {
    const f = await prepared(); let binding = f.binding;
    if (legacyAliases) binding = { ...binding, evidence: { ...binding.evidence,
      secretVersion: binding.evidence.secretVersion!.replace(projectNumber, projectId),
      ownedVersions: JSON.stringify(JSON.parse(binding.evidence.ownedVersions!).map((name: string) => name.replace(projectNumber, projectId))) } };
    const accountUniqueId = sa.uniqueId, secretName = secret.name;
    // Dedicated resource policies have no independently added consumers. Bucket
    // and project policies retain unrelated users throughout removal.
    policies.set(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${accountUniqueId}:policy`, { ...policies.get(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${accountUniqueId}:policy`), bindings: policies.get(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${accountUniqueId}:policy`).bindings.filter((b: any) => b.role !== 'roles/viewer') });
    policies.set(`https://secretmanager.googleapis.com/v1/${secretName}:policy`, { ...policies.get(`https://secretmanager.googleapis.com/v1/${secretName}:policy`), bindings: policies.get(`https://secretmanager.googleapis.com/v1/${secretName}:policy`).bindings.filter((b: any) => b.role !== 'roles/viewer') });
    calls = [];
    for (let index = 0; index < 12; index++) {
      const observed = await f.runtime.inspect({ target, binding, mode: 'destroy' });
      if (observed.state === 'ready') break;
      expect(observed.state, JSON.stringify(observed)).toBe('action');
      if (observed.state !== 'action') return;
      expect(observed.step.operation).toBe('destroy'); expect(observed.step.requiresConfirm).toBe(true);
      const attemptId = `remove-${index}`;
      const result = await f.runtime.apply({ target, mode: 'destroy', step: observed.step, attemptId,
        binding: { ...binding, pending: { attemptId, step: observed.step } } });
      expect(result.receipt.success, JSON.stringify(result)).toBe(true); binding = result.binding!;
    }
    expect(await f.runtime.inspect({ target, binding, mode: 'destroy' })).toMatchObject({ state: 'ready' });
    expect(sa).toBeUndefined(); expect(secret).toBeUndefined();
    const deletions = calls.filter(call => call.method === 'DELETE');
    expect(deletions.map(call => call.url)).toEqual([
      `https://secretmanager.googleapis.com/v1/${secretName.replace(projectNumber, projectId)}?etag=secret-etag`,
      `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${accountUniqueId}`,
    ]);
    for (const [url, policy] of policies) if (url.includes('storage.googleapis.com') || url.includes('cloudresourcemanager.googleapis.com'))
      expect(policy.bindings).toEqual([{ role: 'roles/viewer', members: ['user:retained@example.test'] }]);
    expect(calls.some(call => call.url.includes('/o') && call.method !== 'GET')).toBe(false);
    expect(JSON.stringify(binding)).not.toContain(databaseUrl);
  });
  it.each(['replaced-account', 'running-job', 'unknown-version'] as const)('blocks %s without a destructive write', async scenario => {
    const f = await prepared();
    if (scenario === 'replaced-account') sa.uniqueId = '923456789012345678901';
    if (scenario === 'running-job') job = { name: `projects/${projectId}/locations/${region}/jobs/retained`, template: { template: { serviceAccount: sa.email } } };
    if (scenario === 'unknown-version') versions.push({ name: `${secret.name}/versions/99`, state: 'ENABLED' });
    calls = [];
    expect(await f.runtime.inspect({ target, binding: f.binding, mode: 'destroy' })).toMatchObject({ state: 'unknown' });
    expect(calls.some(call => call.method === 'DELETE' || call.method === 'PUT' || call.url.includes(':setIamPolicy'))).toBe(false);
  });
});

it.each(['permission:controller-any-bucket-access', 'permission:controller-archive-access:other', 'password'])('rejects unreviewed coordinate key %s', key => {
  expect(() => recoveryRuntimeBindings({ provider: 'cloudrun', evidence: { [key]: 'a'.repeat(64) } })).toThrow();
});
it.each(['not-a-fingerprint', 'Bearer synthetic', 'postgresql://synthetic'])('rejects a credential-like controller grant value: %s', value => {
  expect(() => recoveryRuntimeBindings({ provider: 'cloudrun', evidence: { 'permission:controller-archive-access': value } })).toThrow();
});

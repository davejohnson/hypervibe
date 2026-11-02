import { gcpAccountPolicyGetContractResponse } from '../../../../test/gcp-iam-policy-contract.js';
import { gcpRoleGetContractResponse } from '../../../../test/gcp-iam-role-contract.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import type { CloudInstallationRecord, LocalCloudScopePreparationIntent } from '../../../../domain/ports/cloud-installation.port.js';
import { createGcpGithubCiPreparationDriver, gcpGithubCiPreparationBinding, deriveGcpGithubCiDisconnectionScope, gcpGithubCiDisconnectionReady, gcpGithubCiPreparationScopeSchema } from '../gcp-github-ci-preparation.js';

// Reconstructed from official IAM v1 WorkloadIdentityPool/Provider, ServiceAccount,
// Role and IAM Policy REST JSON, not a live Google installation. Only transport
// is substituted; the shared approval/journal/recovery runtime executes unchanged.
const selection = { scopeKind: 'operator-hosting-v1', billingAccountName: 'billingAccounts/ABCDEF-123456-ABCDEF',
  githubRepository: 'synthetic-owner/synthetic-app', githubRepositoryId: '123456789', githubRepositoryOwnerId: '987654321',
  githubBranch: 'main', githubWorkflow: '.github/workflows/deploy-cloudrun-staging.yml' };
const intent: LocalCloudScopePreparationIntent = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  customerId: 'local-project', appId: 'local-project', environment: 'staging', provider: 'gcp', hostingProvider: 'cloudrun',
  execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, mode: 'connect', stage: 'scope-preparation', keys: [],
  source: { kind: 'local-spec', repository: 'github.com/synthetic-owner/synthetic-app', specRevision: 1, specDigest: 'a'.repeat(64) },
  predecessor: { installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', planDigest: 'b'.repeat(64) }, selection,
  nativeScope: { ...selection, scopeKind: 'github-ci-identity', projectId: 'synthetic-project', projectNumber: '123456789012',
    projectCreateTime: '2026-10-25T00:00:00Z', projectParent: 'none', projectInstallationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    projectAttemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', region: 'us-central1', artifactRepository: 'hypervibe',
    artifactRepositoryName: 'projects/synthetic-project/locations/us-central1/repositories/hypervibe',
    artifactRepositoryCreateTime: '2026-10-25T01:00:00Z' } };

const privateProof = { artifactInstallationId: '11111111-1111-4111-8111-111111111111', artifactAttemptId: '22222222-2222-4222-8222-222222222222' };
function boundary(options: { lose?: string; unknown?: boolean; collision?: boolean; conflict?: boolean; registryReplacement?: boolean; denyWrites?: boolean; privateProof?: boolean; wrongRegistryOwner?: boolean } = {}) {
  let record: CloudInstallationRecord<LocalCloudScopePreparationIntent> | null = null;
  const resources = new Map<string, Record<string, unknown>>();
  const operations = new Map<string, Record<string, unknown>>();
  const writes: Array<{ url: string; body: Record<string, any> }> = [];
  let lossApplied = false;
  const unrelated = { role: 'roles/viewer', members: ['user:existing@example.invalid'], condition: { title: 'existing', expression: 'true' } };
  const projectPolicy: Record<string, any> = { version: 3, etag: 'project-etag-1', bindings: [unrelated] };
  const registryPolicy: Record<string, any> = { version: 3, etag: 'registry-etag-1', bindings: [unrelated] };
  const accountPolicy: Record<string, any> = { version: 3, etag: 'account-etag-1', bindings: [] };
  const projectOwner = createHash('sha256').update(JSON.stringify([intent.customerId, intent.appId, intent.environment, intent.nativeScope.projectInstallationId])).digest('hex');
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), body = init.body ? JSON.parse(String(init.body)) : undefined;
    const invalidRoleGet = gcpRoleGetContractResponse(url, init.method ?? 'GET', init.body);
    if (invalidRoleGet) return invalidRoleGet;
    const invalidPolicyRead = gcpAccountPolicyGetContractResponse(url, init.method ?? 'GET', init.body);
    if (invalidPolicyRead) return invalidPolicyRead;
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-local-administrator-token');
    if (url.hostname === 'cloudresourcemanager.googleapis.com' && url.pathname === '/v3/projects/synthetic-project') {
      if (options.unknown) return Response.json({}, { status: 403 });
      return Response.json({ name: 'projects/123456789012', projectId: 'synthetic-project', state: 'ACTIVE',
        createTime: intent.nativeScope.projectCreateTime,
        labels: { 'hv-installation': projectOwner.slice(0, 63), 'hv-attempt': intent.nativeScope.projectAttemptId } });
    }
    if (url.hostname === 'cloudbilling.googleapis.com') return Response.json({ name: 'projects/synthetic-project/billingInfo',
      projectId: 'synthetic-project', billingAccountName: selection.billingAccountName, billingEnabled: true });
    if (url.hostname === 'artifactregistry.googleapis.com' && !url.pathname.includes(':')) return Response.json({
      name: intent.nativeScope.artifactRepositoryName, format: 'DOCKER', mode: 'STANDARD_REPOSITORY', createTime: options.registryReplacement ? '2026-10-25T02:00:00Z' : intent.nativeScope.artifactRepositoryCreateTime,
      ...(options.privateProof ? { description: `hypervibe:operator-registry:${options.wrongRegistryOwner ? 'f'.repeat(64) : createHash('sha256').update(JSON.stringify([intent.customerId, intent.appId, intent.environment, privateProof.artifactInstallationId])).digest('hex')}:${privateProof.artifactAttemptId}` } : {}) });
    if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: ['iam.workloadIdentityPools.create',
      'iam.workloadIdentityPoolProviders.create', 'iam.serviceAccounts.create', 'iam.serviceAccounts.setIamPolicy', 'iam.roles.create', 'resourcemanager.projects.setIamPolicy', 'artifactregistry.repositories.setIamPolicy'] });
    if (url.pathname.endsWith(':getIamPolicy')) return Response.json(url.hostname === 'iam.googleapis.com' ? accountPolicy : url.hostname === 'artifactregistry.googleapis.com' ? registryPolicy : projectPolicy);
    if (url.pathname.endsWith(':setIamPolicy')) {
      writes.push({ url: url.toString(), body });
      const target = url.hostname === 'iam.googleapis.com' ? accountPolicy : url.hostname === 'artifactregistry.googleapis.com' ? registryPolicy : projectPolicy;
      expect(body.policy.etag).toBe(target.etag);
      if (options.conflict) return Response.json({}, { status: 412 });
      if (options.denyWrites) return Response.json({}, { status: 403 });
      Object.assign(target, body.policy, { etag: target.etag + '-next' });
      if (!lossApplied && options.lose === 'trust-removal' && target === accountPolicy && !target.bindings.length) {
        lossApplied = true; throw new Error('synthetic removal acknowledgment lost');
      }
      expect(projectPolicy.bindings).toContainEqual(unrelated);
      return Response.json(target);
    }
    const name = url.pathname.replace(/^\/v1\//, '');
    if (init.method !== 'POST') {
      if (operations.has(name)) return Response.json(operations.get(name));
      if (resources.has(name)) return Response.json(resources.get(name));
      if (options.collision && name.includes('/workloadIdentityPools/')) return Response.json({ name, state: 'ACTIVE', mode: 'FEDERATION_ONLY', description: 'unrelated owner' });
      return Response.json({}, { status: 404 });
    }
    writes.push({ url: url.toString(), body });
    if (name.endsWith('/workloadIdentityPools') || name.endsWith('/providers')) {
      const id = url.searchParams.get('workloadIdentityPoolId') ?? url.searchParams.get('workloadIdentityPoolProviderId');
      const resourceName = `${name}/${id}`;
      resources.set(resourceName, { ...body, name: resourceName, state: 'ACTIVE' });
      const operationName = `${resourceName}/operations/synthetic-operation`;
      operations.set(operationName, { name: operationName, done: true, response: { name: resourceName } });
      if (!lossApplied && options.lose === (name.endsWith('/providers') ? 'provider' : 'pool')) { lossApplied = true; throw new Error('synthetic transport acknowledgment lost'); }
      return Response.json({ name: operationName, done: false });
    }
    if (name.endsWith('/serviceAccounts')) {
      const email = `${body.accountId}@synthetic-project.iam.gserviceaccount.com`, resourceName = `${name}/${email}`;
      const account = { ...body.serviceAccount, name: resourceName, email, projectId: 'synthetic-project', uniqueId: '123456789012345678901', disabled: false };
      resources.set(resourceName, account); return Response.json(account);
    }
    if (name.endsWith('/roles')) {
      const role = { ...body.role, name: `${name}/${body.roleId}` }; resources.set(role.name, role); return Response.json(role);
    }
    throw new Error('Unexpected synthetic provider mutation');
  };
  const driver = createGcpGithubCiPreparationDriver({ fetch: request });
  const input = { driver, authentication: { kind: 'local-administrator' as const, administrator: { getAccessToken: async () => 'synthetic-local-administrator-token' } },
    authorize: async () => true,
    store: { read: async () => structuredClone(record), compareAndSwap: async (_id: string, expected: number | null, next: CloudInstallationRecord<LocalCloudScopePreparationIntent>) => {
      if (expected !== (record?.revision ?? null)) return false; record = structuredClone(next); return true;
    } } };
  return { input, writes, resources, projectPolicy, accountPolicy, registryPolicy, resetRecord: () => { record = null; }, record: () => record! };
}

describe('reviewed local GitHub→Google workload identity lifecycle', () => {
  it('accepts complete private ownership proof independently of public helper preparation', () => {
    expect(gcpGithubCiPreparationScopeSchema.parse({ ...intent.nativeScope, ...privateProof })).toMatchObject(privateProof);
    for (const key of Object.keys(privateProof)) {
      const incomplete = { ...privateProof } as Record<string, string>; delete incomplete[key];
      expect(gcpGithubCiPreparationScopeSchema.safeParse({ ...intent.nativeScope, ...incomplete }).success).toBe(false);
    }
    expect(gcpGithubCiPreparationScopeSchema.safeParse(intent.nativeScope).success).toBe(true);
  });
  it('checks private ownership before CI writes even when no public helper exists', async () => {
    const options = { privateProof: true, wrongRegistryOwner: false };
    const f = boundary(options), selected = { ...intent, nativeScope: { ...intent.nativeScope, ...privateProof } };
    const planned = await planCloudInstallationV1({ ...f.input, intent: selected });
    expect(f.writes).toHaveLength(0);
    options.wrongRegistryOwner = true;
    const action = planned.plan.actions[0];
    const result = await applyCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: planned.plan.digest,
      confirmActions: [action.id], onlyActionId: action.id });
    expect(result.status).toBe('blocked'); expect(f.writes).toHaveLength(0);
  });
  it('retains complete public helper proof without granting CI permission to that repository', () => {
    const proof = { artifactInstallationId: '11111111-1111-4111-8111-111111111111', artifactAttemptId: '22222222-2222-4222-8222-222222222222',
      publicArtifactRepository: 'operator-public', publicArtifactRepositoryName: 'projects/synthetic-project/locations/us-central1/repositories/operator-public',
      publicArtifactRepositoryCreateTime: '2026-10-25T02:00:00Z', publicArtifactInstallationId: '33333333-3333-4333-8333-333333333333',
      publicArtifactAttemptId: '44444444-4444-4444-8444-444444444444' };
    expect(gcpGithubCiPreparationScopeSchema.parse({ ...intent.nativeScope, ...proof })).toMatchObject(proof);
    for (const key of Object.keys(proof)) {
      const partial = { ...proof } as Record<string, string>; delete partial[key];
      expect(gcpGithubCiPreparationScopeSchema.safeParse({ ...intent.nativeScope, ...partial }).success).toBe(false);
    }
    expect(gcpGithubCiPreparationScopeSchema.safeParse({ ...intent.nativeScope, ...proof,
      publicArtifactRepositoryName: 'projects/unrelated-project/locations/us-central1/repositories/operator-public' }).success).toBe(false);
  });
  it('creates only one exact confirmed native action, preserves unrelated IAM, and resumes after restart without keys', async () => {
    const f = boundary(); let record = await planCloudInstallationV1({ ...f.input, intent });
    expect(f.writes).toHaveLength(0); expect(record.plan.actions).toHaveLength(7);
    for (const [index, action] of record.plan.actions.entries()) {
      const before = f.writes.length;
      record = await applyCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest,
        confirmActions: [action.id], onlyActionId: action.id });
      expect(f.writes.length - before).toBe(1);
      expect(Object.keys(record.completed)).toHaveLength(index + 1);
    }
    expect(record.status).toBe('scope-ready');
    expect(gcpGithubCiPreparationBinding(record)).toMatchObject({ serviceAccountUniqueId: '123456789012345678901', repositoryId: selection.githubRepositoryId });
    expect(f.projectPolicy.bindings.some((binding: any) => binding.role === 'roles/artifactregistry.writer')).toBe(false);
    expect(f.registryPolicy.bindings).toContainEqual({ role: 'roles/artifactregistry.writer', members: [
      'serviceAccount:' + gcpGithubCiPreparationBinding(record).serviceAccountEmail] });
    const before = f.writes.length;
    await reconcileCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest });
    expect(f.writes).toHaveLength(before);
    expect(JSON.stringify(record)).not.toMatch(/synthetic-local-administrator-token|private_key|refresh_token/);
    expect(f.writes.some(write => write.url.includes('/keys'))).toBe(false);
    const provider = f.writes.find(write => write.url.includes('/providers?'))!.body;
    expect(provider.oidc).toMatchObject({ issuerUri: 'https://token.actions.githubusercontent.com' });
    expect(provider.attributeCondition).toContain('assertion.repository_id == "123456789"');
    expect(provider.attributeCondition).toContain('assertion.repository_owner_id == "987654321"');
    expect(provider.attributeCondition).toContain('environment:staging');
    expect(provider.attributeCondition).not.toContain('pull_request');
  });
  it('keeps backup-controller object access out of the project-wide CI role', async () => {
    const f = boundary(); const backup = { ...intent, nativeScope: { ...intent.nativeScope,
      githubBackupWorkflow: '.github/workflows/hypervibe-backup-staging.yml' } };
    let record = await planCloudInstallationV1({ ...f.input, intent: backup });
    const action = record.plan.actions.find(action => action.id === 'gcp:github-ci:create-role')!;
    record = await applyCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest,
      confirmActions: [action.id], onlyActionId: action.id });
    expect(record.completed[action.id]).toBeDefined();
    const permissions = f.writes[0].body.role.includedPermissions as string[];
    expect(permissions).toContain('storage.buckets.get');
    expect(permissions.some(permission => permission.startsWith('storage.objects.'))).toBe(false);
    expect(permissions).not.toContain('secretmanager.versions.access');
    expect(permissions).not.toContain('iam.serviceAccounts.actAs');
  });
  it.each([false, true])('disconnects only the three reviewed grants; lost acknowledgment=%s', async lost => {
    const f = boundary({ lose: lost ? 'trust-removal' : undefined });
    let connected = await planCloudInstallationV1({ ...f.input, intent });
    for (const action of connected.plan.actions) connected = await applyCloudInstallationV1({ ...f.input,
      installationId: intent.installationId, planDigest: connected.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
    const before = f.writes.length, resourcesBefore = structuredClone([...f.resources]);
    const nativeScope = deriveGcpGithubCiDisconnectionScope(connected);
    const disconnect: LocalCloudScopePreparationIntent = { ...intent, installationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      source: { ...intent.source, specRevision: 2 }, predecessor: { installationId: connected.installationId, planDigest: connected.plan.digest },
      selection: { ...selection, githubAccess: 'disconnect' }, nativeScope };
    f.resetRecord();
    let record = await planCloudInstallationV1({ ...f.input, intent: disconnect });
    expect(f.writes).toHaveLength(before); expect(record.plan.actions).toHaveLength(3);
    for (const action of record.plan.actions) {
      const writesBefore = f.writes.length;
      record = await applyCloudInstallationV1({ ...f.input, installationId: disconnect.installationId, planDigest: record.plan.digest,
        confirmActions: [action.id], onlyActionId: action.id });
      record = await reconcileCloudInstallationV1({ ...f.input, installationId: disconnect.installationId,
        planDigest: record.plan.digest, onlyActionId: action.id });
      expect(f.writes).toHaveLength(writesBefore + 1);
    }
    expect(record.status).toBe('scope-ready'); expect(gcpGithubCiDisconnectionReady(record)).toBe(true);
    expect(f.accountPolicy.bindings).toEqual([]);
    expect(f.projectPolicy.bindings).toHaveLength(1); expect(f.registryPolicy.bindings).toHaveLength(1);
    expect([...f.resources]).toEqual(resourcesBefore);
    expect(f.writes.slice(before).every(write => write.url.endsWith(':setIamPolicy'))).toBe(true);
    const driftedOriginal = { ...connected, status: 'blocked' as const, completed: {} };
    expect(deriveGcpGithubCiDisconnectionScope(driftedOriginal)).toEqual(nativeScope);
    await reconcileCloudInstallationV1({ ...f.input, installationId: disconnect.installationId, planDigest: record.plan.digest });
    expect(f.writes).toHaveLength(before + 3);
  });
  it.each([{ registryReplacement: true }, { unknown: true }])('stops before mutation after a prerequisite changes: %j', async drift => {
    const state: Parameters<typeof boundary>[0] = {};
    const f = boundary(state); const record = await planCloudInstallationV1({ ...f.input, intent });
    Object.assign(state, drift);
    const action = record.plan.actions[0];
    const result = await applyCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest,
      confirmActions: [action.id], onlyActionId: action.id });
    expect(result.status).toBe('blocked'); expect(f.writes).toHaveLength(0);
  });
  it.each([412, 403])('requires a separately confirmed retry after IAM rejects the write with %s', async status => {
    const state: Parameters<typeof boundary>[0] = {};
    const f = boundary(state); let record = await planCloudInstallationV1({ ...f.input, intent });
    for (const action of record.plan.actions.slice(0, 4)) record = await applyCloudInstallationV1({ ...f.input,
      installationId: intent.installationId, planDigest: record.plan.digest, confirmActions: [action.id], onlyActionId: action.id });
    Object.assign(state, status === 412 ? { conflict: true } : { denyWrites: true });
    const action = record.plan.actions[4], before = f.writes.length;
    record = await applyCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest,
      confirmActions: [action.id], onlyActionId: action.id });
    expect(record.status).toBe('blocked'); expect(record.attempts.at(-1)?.status).toBe('rejected');
    const attempt = record.attempts.at(-1)!;
    Object.assign(state, { conflict: false, denyWrites: false });
    record = await applyCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest,
      confirmActions: [action.id], onlyActionId: action.id });
    expect(record.reason).toBe('retry_confirmation_required'); expect(f.writes).toHaveLength(before + 1);
    record = await applyCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest,
      confirmActions: [action.id], onlyActionId: action.id, retryActions: [{ actionId: action.id, attemptId: attempt.id }] });
    expect(record.completed[action.id]).toBeDefined(); expect(f.writes).toHaveLength(before + 2);
  });
  it('recovers a lost create acknowledgment by its exact owned resource without another create', async () => {
    const f = boundary({ lose: 'pool' }); let record = await planCloudInstallationV1({ ...f.input, intent });
    const action = record.plan.actions[0];
    record = await applyCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest,
      confirmActions: [action.id], onlyActionId: action.id });
    expect(f.writes).toHaveLength(1);
    record = await reconcileCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest });
    expect(record.completed[action.id]).toBeDefined(); expect(f.writes).toHaveLength(1);
    f.resources.clear();
    const drift = await reconcileCloudInstallationV1({ ...f.input, installationId: intent.installationId, planDigest: record.plan.digest });
    expect(drift.status).toBe('blocked'); expect(f.writes).toHaveLength(1);
  });
  it.each([{ unknown: true }, { collision: true }])('blocks unknown authority or existing unowned identities before writes: %j', async options => {
    const f = boundary(options); await expect(planCloudInstallationV1({ ...f.input, intent })).rejects.toBeDefined();
    expect(f.writes).toHaveLength(0);
  });
});

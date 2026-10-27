import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGcpLocalArtifactRegistryDriver } from '../../src/adapters/providers/gcp/gcp-local-artifact-registry.js';
import { createGcpLocalProjectAllocationCapability } from '../../src/adapters/providers/gcp/gcp-local-project-allocation.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../src/domain/services/cloud-installation-runtime.js';
import type { CloudInstallationRecord, LocalCloudScopePreparationIntent } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed Artifact Registry v1 repository/Operation plus CRM Project
// response. Native identities are synthetic, responses are not request echoes.
const allocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const installationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const owner = createHash('sha256').update(JSON.stringify(['app', 'app', 'test', installationId])).digest('hex');
const projectOwner = createHash('sha256').update(JSON.stringify(['app', 'app', 'test', allocationId])).digest('hex');
const repository = 'projects/local-operator-project/locations/us-central1/repositories/hypervibe';
const operation = 'projects/local-operator-project/locations/us-central1/operations/create-images';
const intent = { schemaVersion: 1, installationId, customerId: 'app', appId: 'app', environment: 'test',
  source: { kind: 'local-spec', repository: 'github.com/acme/app', specRevision: 2, specDigest: 'b'.repeat(64) },
  execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, hostingProvider: 'cloudrun',
  provider: 'gcp', mode: 'connect', stage: 'scope-preparation', keys: [],
  selection: { scopeKind: 'operator-hosting-v1', billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' },
  predecessor: { installationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', planDigest: 'a'.repeat(64) },
  nativeScope: { scopeKind: 'operator-artifact-registry-v1', projectId: 'local-operator-project', projectNumber: '123456789012',
    projectCreateTime: '2026-10-25T00:00:00Z', projectParent: 'none', projectInstallationId: allocationId,
    projectAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC',
    region: 'us-central1', artifactRepository: 'hypervibe', artifactRepositoryName: repository } };

function fixture(fault?: 'lost-ack' | 'forbidden' | 'collision' | 'operation-error' | 'wrong-operation' | 'replaced' | 'missing-time' | 'operation-replacement' | 'grant-lost-ack' | 'grant-conflict' | 'grant-forbidden' | 'policy-no-etag' | 'private-replacement', declaredLifetime = false, publicRegistry = false) {
  const repository = `projects/local-operator-project/locations/us-central1/repositories/${publicRegistry ? 'operator-public' : 'hypervibe'}`;
  const selectedIntent = publicRegistry ? { ...intent, nativeScope: { ...intent.nativeScope, scopeKind: 'operator-public-artifact-registry-v1', artifactRepositoryCreateTime: '2026-10-25T00:30:00Z', artifactInstallationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', artifactAttemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', publicArtifactRepository: 'operator-public', publicArtifactRepositoryName: repository } } : intent;
  let policy = { version: 3, etag: 'initial-etag', bindings: [{ role: 'roles/artifactregistry.reader', members: ['user:retained@example.test'] }] };
  let saved: CloudInstallationRecord<LocalCloudScopePreparationIntent> | null = null;
  let created = false, replace = false, createdAttempt = ''; 
  const writes: string[] = [];
  const nativeRepository = () => ({ name: repository, format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
    description: `hypervibe:operator-registry:${owner}:${createdAttempt || saved!.attempts.at(-1)!.id}`,
    ...(fault === 'missing-time' ? {} : { createTime: replace ? '2026-10-25T02:00:00Z' : '2026-10-25T01:00:00Z' }) });
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const method = init.method ?? 'GET';
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-user-token');
    expect(init.redirect).toBe('error');
    if (url.pathname === '/v3/projects/local-operator-project') return Response.json({ name: 'projects/123456789012',
      projectId: 'local-operator-project', state: 'ACTIVE', createTime: intent.nativeScope.projectCreateTime,
      labels: { 'hv-installation': projectOwner.slice(0, 63), 'hv-attempt': intent.nativeScope.projectAttemptId } });
    if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: ['artifactregistry.repositories.get', 'artifactregistry.repositories.create', 'artifactregistry.repositories.getIamPolicy', 'artifactregistry.repositories.setIamPolicy'] });
    if (publicRegistry && url.pathname === '/v1/' + intent.nativeScope.artifactRepositoryName) {
      const privateOwner = createHash('sha256').update(JSON.stringify(['app', 'app', 'test', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'])).digest('hex');
      return Response.json({ name: intent.nativeScope.artifactRepositoryName, format: 'DOCKER', mode: 'STANDARD_REPOSITORY', createTime: fault === 'private-replacement' ? '2026-10-25T00:40:00Z' : '2026-10-25T00:30:00Z', description: `hypervibe:operator-registry:${privateOwner}:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee` });
    }
    if (url.pathname === '/v1/' + repository + ':getIamPolicy') return Response.json(fault === 'policy-no-etag' ? { ...policy, etag: undefined } : policy);
    if (url.pathname === '/v1/' + repository + ':setIamPolicy') {
      expect(method).toBe('POST'); const body = JSON.parse(String(init.body));
      expect(Object.keys(body)).toEqual(['policy']);
      expect(body.policy.etag).toBe(policy.etag);
      expect(body.policy.bindings).toContainEqual({ role: 'roles/artifactregistry.reader', members: ['user:retained@example.test', 'allUsers'] });
      writes.push(url.href);
      if (fault === 'grant-conflict' || fault === 'grant-forbidden') return Response.json({ error: { message: 'synthetic-user-token' } }, { status: fault === 'grant-conflict' ? 412 : 403 });
      policy = { ...body.policy, etag: 'updated-etag' };
      if (fault === 'grant-lost-ack') throw new Error('synthetic-user-token');
      return Response.json(policy);
    }
    if (url.pathname.endsWith('/billingInfo')) return Response.json({ name: 'projects/local-operator-project/billingInfo',
      projectId: 'local-operator-project', billingAccountName: intent.nativeScope.billingAccountName, billingEnabled: true });
    if (url.pathname === '/v1/' + repository) {
      expect(method).toBe('GET');
      if (fault === 'forbidden') return Response.json({}, { status: 403 });
      if (fault === 'collision') return Response.json({ name: repository, format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
        description: 'unrelated-existing-repository', createTime: '2025-01-01T00:00:00Z' });
      return created ? Response.json({ ...nativeRepository(), ...(fault === 'operation-replacement' ? { createTime: '2026-10-25T03:00:00Z' } : {}) }) : Response.json({}, { status: 404 });
    }
    if (url.pathname === '/v1/projects/local-operator-project/locations/us-central1/repositories' && method === 'POST') {
      expect(saved!.attempts.at(-1)?.status).toBe('attempted');
      expect(url.searchParams.get('repositoryId')).toBe(publicRegistry ? 'operator-public' : 'hypervibe');
      expect(JSON.parse(String(init.body))).toEqual({ format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
        description: `hypervibe:operator-registry:${owner}:${createdAttempt || saved!.attempts.at(-1)!.id}` });
      writes.push(url.href); created = true; createdAttempt = saved!.attempts.at(-1)!.id;
      if (fault === 'lost-ack') throw new Error('synthetic-user-token');
      return Response.json({ name: fault === 'wrong-operation' ? 'projects/foreign-project/locations/us-central1/operations/create' : operation });
    }
    if (url.pathname === '/v1/' + operation) return Response.json({ name: operation, done: true,
      ...(fault === 'operation-error' ? { error: { code: 7, message: 'synthetic-user-token' } } : { response: {
        '@type': 'type.googleapis.com/google.devtools.artifactregistry.v1.Repository', ...nativeRepository() } }) });
    throw new Error('Unexpected reconstructed native request');
  };
  const driver = createGcpLocalArtifactRegistryDriver({ fetch: request, public: publicRegistry } as any);
  const context = { driver, authentication: { kind: 'local-administrator', administrator: { getAccessToken: async () => 'synthetic-user-token' } } as const,
    authorize: async () => true, store: { read: async () => structuredClone(saved), compareAndSwap: async (_id: string, revision: number | null, next: any) => {
      if ((saved?.revision ?? null) !== revision) return false; saved = structuredClone(next); return true;
    } } };
  return { writes, saved: () => saved, replace: () => { replace = true; },
    plan: () => planCloudInstallationV1({ ...context, intent: declaredLifetime ? { ...intent, nativeScope: { ...intent.nativeScope, artifactRepositoryCreateTime: '2020-01-01T00:00:00Z' } } : selectedIntent }),
    apply: (confirm = true, selectedActions?: string[]) => applyCloudInstallationV1({ ...context, installationId, planDigest: saved!.plan.digest, ...(selectedActions?.length === 1 ? { onlyActionId: selectedActions[0] } : {}),
      confirmActions: selectedActions ?? (confirm ? publicRegistry ? ['gcp:local-scope:public-artifact-registry', 'gcp:local-scope:public-artifact-reader'] : ['gcp:local-scope:artifact-registry'] : []) }),
    recover: () => reconcileCloudInstallationV1({ ...context, installationId, planDigest: saved!.plan.digest }), driver };
}
describe('reviewed local image repository preparation', () => {
  it.each([false, true])('retains private creation authority in the final binding; separate public repository=%s', async publicRegistry => {
    const f = fixture(undefined, false, publicRegistry); await f.plan(); await f.apply();
    const record = f.saved()!;
    const expected = publicRegistry
      ? { artifactInstallationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', artifactAttemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }
      : { artifactInstallationId: installationId, artifactAttemptId: record.attempts[0].id };
    // The installation and exact acknowledged attempt belong to the retained
    // creation journal, never a new binding, publication or public-reader grant.
    const binding = createGcpLocalProjectAllocationCapability().continuation!.binding(record, { region: 'us-central1' });
    expect(binding.platformBindings.providerScope).toMatchObject(expected);
    expect(binding.platformBindings.providerScope).toMatchObject({ billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' });
    const before = f.writes.length;
    await f.recover();
    expect(createGcpLocalProjectAllocationCapability().continuation!.binding(f.saved()!, { region: 'us-central1' }).platformBindings).toEqual(binding.platformBindings);
    expect(f.writes).toHaveLength(before);
  });
  it('pins the independent native operation result and repository lifetime contracts', () => {
    const base = new URL('./gcp/artifact-registry/', import.meta.url);
    const source = JSON.parse(readFileSync(new URL('source.json', base), 'utf8'));
    const snapshots = new Map<string, string>();
    for (const entry of source.sources) {
      const bytes = readFileSync(new URL(entry.snapshot, base));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      snapshots.set(entry.snapshot, bytes.toString('utf8'));
    }
    expect(snapshots.get('repository.proto')).toContain('package google.devtools.artifactregistry.v1;');
    expect(snapshots.get('repository.proto')).toMatch(/message Repository \{/);
    expect(snapshots.get('repository.proto')).toMatch(/google\.protobuf\.Timestamp create_time = 5\s*\[\(google\.api\.field_behavior\) = OUTPUT_ONLY\]/);
    const create = snapshots.get('service.proto')!.split('rpc CreateRepository(')[1].split('rpc UpdateRepository(')[0];
    expect(create).toContain('response_type: "google.devtools.artifactregistry.v1.Repository"');
  });
  it('requires exact confirmation and records only independently observed native lifetime', async () => {
    const f = fixture(); await f.plan(); await f.apply(false); expect(f.writes).toEqual([]);
    expect((await f.apply()).status).toBe('scope-ready'); expect(f.writes).toHaveLength(1);
    expect(f.driver.scopePreparation!.resolvedScope(f.saved()!)).toMatchObject({ artifactRepositoryName: repository,
      artifactRepositoryCreateTime: '2026-10-25T01:00:00Z' });
    await f.recover(); await f.apply(); expect(f.writes).toHaveLength(1);
    expect(JSON.stringify(f.saved())).not.toContain('synthetic-user-token');
  });
  it('recovers a lost acknowledgment only from exact attempt ownership, never a second create', async () => {
    const f = fixture('lost-ack'); await f.plan(); await f.apply(); await f.recover(); await f.apply();
    expect(f.writes).toHaveLength(1); expect(f.saved()?.status).toBe('scope-ready');
  });
  it.each(['forbidden', 'collision'] as const)('rejects %s before any create', async fault => {
    const f = fixture(fault); await expect(f.plan()).rejects.toThrow(); expect(f.writes).toEqual([]);
  });
  it.each(['operation-error', 'wrong-operation', 'missing-time', 'operation-replacement'] as const)('does not complete or blindly resubmit %s', async fault => {
    const f = fixture(fault); await f.plan(); await f.apply(); await f.recover(); await f.apply();
    expect(f.saved()?.status).not.toBe('scope-ready'); expect(f.writes).toHaveLength(1);
    expect(JSON.stringify(f.saved())).not.toContain('synthetic-user-token');
  });
  it('rejects an input lifetime that pretends creation already happened', async () => {
    const f = fixture(undefined, true); await expect(f.plan()).rejects.toThrow(); expect(f.writes).toEqual([]);
  });
  it('blocks a same-name replacement after completion', async () => {
    const f = fixture(); await f.plan(); await f.apply(); f.replace(); await f.recover();
    expect(f.saved()?.status).not.toBe('scope-ready'); expect(f.writes).toHaveLength(1);
  });
});


it('creates a separate public operator repository and separately grants only its reader policy', async () => {
  const f = fixture(undefined, false, true);
  await f.plan();
  expect(f.saved()!.plan.actions.map(action => action.id)).toEqual(['gcp:local-scope:public-artifact-registry', 'gcp:local-scope:public-artifact-reader']);
  await f.apply(true, ['gcp:local-scope:public-artifact-registry']);
  expect(f.writes).toHaveLength(1);
  expect((await f.apply(true, ['gcp:local-scope:public-artifact-reader'])).status).toBe('scope-ready');
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1]).toBe('https://artifactregistry.googleapis.com/v1/projects/local-operator-project/locations/us-central1/repositories/operator-public:setIamPolicy');
  expect(f.driver.scopePreparation!.resolvedScope(f.saved()!)).toMatchObject({ artifactRepository: 'hypervibe', publicArtifactRepository: 'operator-public', publicArtifactRepositoryCreateTime: '2026-10-25T01:00:00Z', publicArtifactInstallationId: installationId });
  await f.recover(); await f.apply(); expect(f.writes).toHaveLength(2);
});


it('recovers an uncertain public-reader grant without a second IAM write', async () => {
  const f = fixture('grant-lost-ack', false, true); await f.plan(); await f.apply(); await f.recover(); await f.apply();
  expect(f.saved()?.status).toBe('scope-ready'); expect(f.writes).toHaveLength(2);
  expect(JSON.stringify(f.saved())).not.toContain('synthetic-user-token');
});
it.each(['grant-conflict', 'grant-forbidden', 'policy-no-etag'] as const)('does not certify %s as public access', async fault => {
  const f = fixture(fault, false, true); await f.plan(); await f.apply(); await f.recover();
  expect(f.saved()?.status).not.toBe('scope-ready');
  expect(f.writes.filter(url => url.endsWith(':setIamPolicy')).length).toBe(fault === 'policy-no-etag' ? 0 : 1);
  expect(JSON.stringify(f.saved())).not.toContain('synthetic-user-token');
});
it('verifies the private repository lifetime before touching the separate public repository', async () => {
  const f = fixture('private-replacement', false, true); await expect(f.plan()).rejects.toThrow(); expect(f.writes).toEqual([]);
});

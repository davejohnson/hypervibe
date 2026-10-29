import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { DatabaseFreshInitializationProgress } from '../../../../domain/ports/database-fresh-initialization.port.js';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from './railway-http.fixture.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const mountPath = '/var/lib/postgresql/data';
const dataPath = `${mountPath}/pgdata`;
const password = 'synthetic-initializer-password';
const rawVariables = {
  POSTGRES_PASSWORD: password, POSTGRES_USER: 'postgres', POSTGRES_DB: 'railway',
  PGUSER: '${{POSTGRES_USER}}', PGDATABASE: '${{POSTGRES_DB}}', PGPASSWORD: '${{POSTGRES_PASSWORD}}',
  PGHOST: 'postgres-db.railway.internal', PGPORT: '5432',
  DATABASE_URL: 'postgresql://${{PGUSER}}:${{PGPASSWORD}}@${{PGHOST}}:${{PGPORT}}/${{PGDATABASE}}',
  DIRECT_URL: '${{DATABASE_URL}}', KEEP_ME: 'unchanged',
};

async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}, nativeEnvironmentId = productionId) {
  vi.stubEnv('HYPERVIBE_RAILWAY_INITIALIZATION_POLL_ATTEMPTS', '2');
  vi.stubEnv('HYPERVIBE_RAILWAY_INITIALIZATION_POLL_INTERVAL_MS', '0');
  const http = await railwayHttpFixture({ renderVariableReferences: true,
    mutationEnvironments: [nativeEnvironmentId], ...options });
  const serviceId = nativeEnvironmentId === productionId ? 'production-postgres-db' : 'staging-postgres-db';
  const service = http.services.get(serviceId) ?? http.addService(serviceId, 'postgres-db', nativeEnvironmentId);
  Object.assign(service.instances.get(nativeEnvironmentId)!, { source: { image: 'postgres:16' }, startCommand: null,
    preDeployCommand: null, latestDeployment: { id: 'old-deployment', status: 'SUCCESS' } });
  http.variables.set(`${serviceId}/${nativeEnvironmentId}`, { ...rawVariables });
  const environment = { ...http.environment, id: `local-${nativeEnvironmentId}`, name: nativeEnvironmentId === productionId ? 'production' : 'staging',
    platformBindings: { provider: 'railway', projectId, environmentId: nativeEnvironmentId } };
  const component: Component = { id: 'local-database', environmentId: environment.id, type: 'postgres', externalId: serviceId,
    bindings: { provider: 'railway', resourceKind: 'service', pluginName: 'postgres-db',
      providerScope: { projectId, environmentId: nativeEnvironmentId } }, createdAt: new Date(), updatedAt: new Date() };
  const database = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter, envRepo: { findById: () => environment } });
  return { ...http, environment, component, database, service, serviceId, nativeEnvironmentId };
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.database.freshInitialization).toBeDefined();
  const eligibility = await f.database.freshInitialization!.inspect({ environment: f.environment, component: f.component });
  expect(eligibility.state).toBe('eligible');
  if (eligibility.state !== 'eligible') throw new Error('Expected independently observed eligibility');
  let progress: DatabaseFreshInitializationProgress = { phase: 'prepared' };
  const checkpoints: Array<{ progress: DatabaseFreshInitializationProgress; mutations: number }> = [];
  const saveProgress = async (next: DatabaseFreshInitializationProgress) => {
    progress = structuredClone(next);
    checkpoints.push({ progress, mutations: f.mutations.length });
  };
  const apply = () => f.database.freshInitialization!.apply({ environment: f.environment, component: f.component,
    reviewed: eligibility.inspection, progress, saveProgress });
  return { apply, checkpoints, inspection: eligibility.inspection, progress: () => progress };
}

function alterResponse(operation: string, alter: (response: any) => void) {
  const transport = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const response = await transport(url, init);
    if (!JSON.parse(String(init?.body)).query.includes(operation)) return response;
    const body = await response.json();
    alter(body);
    return Response.json(body, { status: response.status });
  }));
}

/**
 * Reconstructed from the redacted 2026-10-28 patch/snapshot observations pinned
 * in successor-observation.json. Identities, credentials, manifest values and
 * timings below are synthetic. This does not emulate an undocumented provider
 * scheduler or infer lineage from elapsed time/the submitted mutation.
 */
type InitializationFixture = Awaited<ReturnType<typeof fixture>>;
type FixtureDeployment = NonNullable<ReturnType<InitializationFixture['deployments']['get']>>;
type StorageAttachmentProof = {
  predecessor: FixtureDeployment; successor: FixtureDeployment & { meta: Record<string, any> };
  patch: Record<string, any>; instance: NonNullable<ReturnType<InitializationFixture['service']['instances']['get']>>;
  storageId: string; operationId: string; desiredRaw: Record<string, string>;
};
function installStorageAttachmentSuccessor(f: InitializationFixture,
  change?: (proof: StorageAttachmentProof) => void) {
  function reconstruct(): StorageAttachmentProof {
    const predecessor = [...f.deployments.values()][0]!;
    const storageId = [...f.volumes.keys()][0]!;
    const operationId = 'storage-attachment-patch';
    const deploymentId = 'storage-attachment-successor';
    const manifest = { build: {}, deploy: { startCommand: null, preDeployCommand: null, runtime: 'V2', numReplicas: 1 } };
    const metadata: Record<string, any> = { image: 'postgres:16', imageDigest: `sha256:${'a'.repeat(64)}`, runtime: 'V2',
      serviceManifest: manifest, volumeMounts: [mountPath] };
    Object.assign(predecessor, { status: 'REMOVED', deploymentStopped: true, meta: structuredClone(metadata),
      createdAt: '2026-10-28T02:58:07.000Z', updatedAt: '2026-10-28T02:58:22.000Z' });
    const successor = { ...structuredClone(predecessor), id: deploymentId, snapshotId: 'snapshot-successor',
      status: 'SUCCESS', deploymentStopped: false, meta: { ...structuredClone(metadata), patchId: operationId },
      createdAt: '2026-10-28T02:58:08.000Z', updatedAt: '2026-10-28T02:58:19.000Z' };
    f.deployments.set(deploymentId, successor);
    const desiredRaw = { ...rawVariables, PGDATA: dataPath };
    // The real snapshots preserve raw reference definitions. They are separate
    // immutable records, not the fixture's mutable rendered variable projection.
    f.deploymentSnapshots.set(predecessor.id, { id: predecessor.snapshotId, variables: structuredClone(desiredRaw) });
    f.deploymentSnapshots.set(deploymentId, { id: successor.snapshotId, variables: structuredClone(desiredRaw) });
    const patch = { id: operationId, environmentId: f.nativeEnvironmentId,
      environment: { id: f.nativeEnvironmentId, projectId }, status: 'COMMITTED',
      createdAt: '2026-10-28T02:58:04.000Z', updatedAt: '2026-10-28T02:58:07.000Z',
      appliedAt: '2026-10-28T02:58:07.000Z', lastAppliedError: null,
      patch: { services: { [f.serviceId]: { volumeMounts: { [storageId]: { mountPath } } } },
        volumes: { [storageId]: { isCreated: true } } } };
    f.environmentPatches.set(operationId, patch);
    const instance = f.service.instances.get(f.nativeEnvironmentId)!;
    instance.latestDeployment = successor;
    instance.activeDeployments = [successor];
    return { predecessor, successor, patch, instance, storageId, operationId, desiredRaw };
  }
  let proof: ReturnType<typeof reconstruct>;
  alterResponse('mutation InitializeDatabaseDeployment', () => {
    proof = reconstruct();
    change?.(proof);
  });
  return () => proof;
}

// Independent contracts: official Railway docs commit 4bc46bc0ba1b27d50c5ef0393132753982b31112,
// manage-volumes/services/variables/deployments.md; Docker PostgreSQL16 Dockerfile
// and entrypoint at dfc76bb299b057785026eb2eea39556b6fe52983. See pinned evidence.
// Assumption challenged: volume/deployment acknowledgements alone permit success
// or retry. Counterexamples below lose receipts and independently change storage.
// Only HTTP transport is mocked, executed against the pinned official SDL.
// Provider state is synthetic; this is not live SQL, backup or durability proof.
describe('Railway existing database fresh initialization through serialized GraphQL', () => {
  it('keeps reviewed official contract source pins in the normal acceptance gate', () => {
    const directory = 'test/provider-contracts/railway/database-initialization/';
    const source = JSON.parse(readFileSync(`${directory}source.json`, 'utf8'));
    for (const entry of source.sources) {
      const bytes = readFileSync(`${directory}${entry.file}`);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    }
  });

  it('pins reconstructed successor observations and their official contracts without claiming causal lineage', () => {
    const directory = 'test/provider-contracts/railway/database-initialization/';
    const source = JSON.parse(readFileSync(`${directory}successor-source.json`, 'utf8'));
    expect(source.evidenceKind).toBe('reconstructed-observation-and-existing-official-source-pins');
    expect(source.observation.file).toBe('successor-observation.json');
    expect(source.sources.map((entry: { file: string }) => entry.file)).toEqual([
      '../source.json', '../schema.graphql', 'source.json', 'manage-volumes.md', 'manage-services.md',
      'manage-deployments.md', 'manage-variables.md',
    ]);
    for (const entry of [source.observation, ...source.sources]) {
      expect(createHash('sha256').update(readFileSync(`${directory}${entry.file}`)).digest('hex')).toBe(entry.sha256);
    }
    expect(source.sources[1].sourceRevision).toBe('f60f3a77b980c47f1136909fbd9a443e29a2b95f');
    expect(source.sources[1].sourceUrl).toBe('https://raw.githubusercontent.com/railwayapp/cli/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/gql/schema.json');
    for (const entry of source.sources.slice(3)) {
      expect(entry.sourceRevision).toBe('4bc46bc0ba1b27d50c5ef0393132753982b31112');
      expect(entry.sourceUrl).toBe(`https://github.com/railwayapp/docs/blob/${entry.sourceRevision}/content/docs/integrations/api/${entry.file}`);
    }
    const observation = JSON.parse(readFileSync(`${directory}${source.observation.file}`, 'utf8'));
    expect(observation.evidenceKind).toBe('reconstructed-from-redacted-live-observations');
    expect(observation.causalAttribution.known).toBe(false);
    expect(source.hypervibeAcceptanceRule.providerDocumentedLineage).toBe(false);
    expect(observation.environmentPatch.privateChecks.isCreatedTrue).toBe(true);
    expect(observation.deploymentSnapshots.valueRepresentationChecks.PGPASSWORD.bothResolved).toBe(false);
  });

  it('keeps reviewed replica source revisions, URLs and exact excerpt hashes in the normal acceptance gate', () => {
    const evidence = JSON.parse(readFileSync('test/provider-contracts/railway/replica-configuration-source.json', 'utf8'));
    const cliRevision = 'f60f3a77b980c47f1136909fbd9a443e29a2b95f';
    const docsRevision = '4bc46bc0ba1b27d50c5ef0393132753982b31112';
    const expectedSources = [
      { repository: 'cli', revision: cliRevision, path: 'src/gql/schema.json' },
      { repository: 'cli', revision: cliRevision, path: 'src/controllers/config/environment.rs' },
      { repository: 'cli', revision: cliRevision, path: 'src/controllers/regions.rs' },
      { repository: 'cli', revision: cliRevision, path: 'src/commands/scale.rs' },
      { repository: 'docs', revision: docsRevision, path: 'content/docs/config-as-code/reference.md' },
    ];
    expect(evidence.evidenceKind).toBe('official-source-excerpts');
    expect(evidence.sources).toHaveLength(expectedSources.length);
    for (const [index, expected] of expectedSources.entries()) {
      const source = evidence.sources[index];
      expect(source.path).toBe(expected.path);
      expect(source.revision).toBe(expected.revision);
      expect(source.url).toBe(`https://github.com/railwayapp/${expected.repository}/blob/${expected.revision}/${expected.path}`);
      expect(source.excerpts.length).toBeGreaterThan(0);
      for (const excerpt of source.excerpts) {
        expect(createHash('sha256').update(excerpt.text, 'utf8').digest('hex')).toBe(excerpt.sha256);
      }
    }
  });
  it.each([productionId, stagingId])('keeps exact existing service and references in %s while attaching fresh storage', async nativeEnvironmentId => {
    const f = await fixture({}, nativeEnvironmentId);
    const untouched = JSON.stringify([...f.environments].filter(([id]) => id !== nativeEnvironmentId));
    const buckets = JSON.stringify([...f.buckets]);
    const run = await start(f);
    const result = await run.apply();
    expect(result.state).toBe('complete');
    expect(result.progress).toMatchObject({ phase: 'complete', storageId: expect.any(String), storageInstanceId: expect.any(String), deploymentId: expect.any(String) });
    expect(result.storageBindings).toEqual({ volumeId: result.progress.storageId, volumeInstanceId: result.progress.storageInstanceId,
      volumeTarget: { projectId, environmentId: nativeEnvironmentId, serviceId: f.serviceId, mountPath } });
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert', 'volumeCreate', 'serviceInstanceDeployV2']);
    expect(f.mutations[0].args.input).toEqual({ projectId, environmentId: nativeEnvironmentId, serviceId: f.serviceId,
      variables: { PGDATA: dataPath }, replace: false, skipDeploys: true });
    expect(f.variables.get(`${f.serviceId}/${nativeEnvironmentId}`)).toEqual({ ...rawVariables, PGDATA: dataPath });
    expect(f.services.get(f.serviceId)?.name).toBe('postgres-db');
    expect(f.service.instances.get(nativeEnvironmentId)?.source).toEqual({ image: 'postgres:16' });
    expect(run.checkpoints.map(({ progress, mutations }) => [progress.phase, mutations])).toEqual([
      ['configuration-attempted', 0], ['configuration-verified', 1], ['storage-attempted', 1],
      ['storage-identified', 2], ['storage-verified', 2], ['activation-attempted', 2], ['activation-identified', 3], ['complete', 3],
    ]);
    expect(JSON.stringify([...f.environments].filter(([id]) => id !== nativeEnvironmentId))).toBe(untouched);
    expect(JSON.stringify([...f.buckets])).toBe(buckets);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(f.contractErrors).toEqual([]);
    const count = f.mutations.length;
    expect((await run.apply()).state).toBe('complete');
    expect(f.mutations).toHaveLength(count);
  });

  it.each([productionId, stagingId])('reconciles the exact storage attachment successor in %s while retaining the original deployment acknowledgement', async nativeEnvironmentId => {
    const f = await fixture({}, nativeEnvironmentId);
    const run = await start(f);
    const proof = installStorageAttachmentSuccessor(f);
    const result = await run.apply();
    expect(result).toMatchObject({ state: 'complete', progress: { phase: 'complete',
      deploymentId: proof().predecessor.id, storageId: proof().storageId,
      activationReconciliation: { version: 1, kind: 'storage-attachment',
        deploymentId: proof().successor.id, operationId: proof().operationId } } });
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert', 'volumeCreate', 'serviceInstanceDeployV2']);
    expect(f.variables.get(`${f.serviceId}/${nativeEnvironmentId}`)).toEqual(proof().desiredRaw);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(f.contractErrors).toEqual([]);
    const count = f.mutations.length;
    expect(await run.apply()).toMatchObject({ state: 'complete', progress: result.progress });
    expect(f.mutations).toHaveLength(count);
  });

  it('reconciles explicit regional replica proof with a null scalar without flattening raw snapshot references', async () => {
    const f = await fixture();
    f.service.instances.get(productionId)!.numReplicas = null;
    const multiRegionConfig = { 'us-west2': { numReplicas: 1 } };
    f.environments.get(productionId)!.config.services![f.serviceId].deploy = { multiRegionConfig };
    const run = await start(f);
    const proof = installStorageAttachmentSuccessor(f, p => {
      for (const deployment of [p.predecessor, p.successor]) {
        deployment.meta!.serviceManifest.deploy.numReplicas = null;
        deployment.meta!.serviceManifest.deploy.multiRegionConfig = structuredClone(multiRegionConfig);
      }
    });
    const result = await run.apply();
    expect(result).toMatchObject({ state: 'complete', progress: { deploymentId: proof().predecessor.id,
      activationReconciliation: { deploymentId: proof().successor.id } } });
    expect(f.variables.get(`${f.serviceId}/${productionId}`)!.PGPASSWORD).toBe('${{POSTGRES_PASSWORD}}');
    expect(f.mutations).toHaveLength(3);
    expect(f.contractErrors).toEqual([]);
  });

  it.each([
    'missing-patch', 'wrong-patch-id', 'wrong-environment', 'wrong-project', 'staged-patch', 'unapplied-patch',
    'extra-top-level', 'extra-service', 'extra-service-field', 'extra-mount', 'extra-mount-field',
    'wrong-mount', 'extra-volume', 'extra-volume-field', 'not-created', 'malformed-created', 'missing-volume',
    'missing-snapshot', 'snapshot-identity', 'snapshot-password', 'snapshot-reference', 'snapshot-pgdata',
    'snapshot-extra-variable', 'predecessor-snapshot-drift', 'both-snapshots-drift',
    'image', 'both-images-drift', 'image-digest', 'both-invalid-digest', 'runtime', 'manifest', 'both-startup-drift',
    'both-predeploy-drift', 'both-replicas-drift', 'missing-metadata', 'volume-mounts',
    'both-wrong-volume-mounts', 'both-extra-volume-mounts',
    'predecessor-running', 'predecessor-not-stopped', 'successor-stopped', 'successor-pending',
    'successor-scope', 'multiple-active', 'no-active', 'not-latest',
    'storage-instance', 'storage-pending-deletion', 'storage-mount', 'current-variables',
  ] as const)('refuses storage successor reconciliation with %s and repeats no mutations', async scenario => {
    const f = await fixture();
    const run = await start(f);
    const proof = installStorageAttachmentSuccessor(f, p => {
      const opaque = p.patch.patch as Record<string, any>;
      const snapshot = f.deploymentSnapshots.get(p.successor.id)!;
      const values = snapshot.variables as Record<string, string>;
      if (scenario === 'missing-patch') f.environmentPatches.delete(p.operationId);
      if (scenario === 'wrong-patch-id') p.patch.id = 'unrelated-patch';
      if (scenario === 'wrong-environment') p.patch.environmentId = stagingId;
      if (scenario === 'wrong-project') p.patch.environment.projectId = 'another-project';
      if (scenario === 'staged-patch') p.patch.status = 'STAGED';
      if (scenario === 'unapplied-patch') p.patch.appliedAt = null;
      if (scenario === 'extra-top-level') opaque.variables = { UNREVIEWED: 'value' };
      if (scenario === 'extra-service') opaque.services.other = { volumeMounts: {} };
      if (scenario === 'extra-service-field') opaque.services[f.serviceId].deploy = { startCommand: 'unreviewed' };
      if (scenario === 'extra-mount') opaque.services[f.serviceId].volumeMounts.other = { mountPath: '/other' };
      if (scenario === 'extra-mount-field') opaque.services[f.serviceId].volumeMounts[p.storageId].isDeleted = false;
      if (scenario === 'wrong-mount') opaque.services[f.serviceId].volumeMounts[p.storageId].mountPath = '/other';
      if (scenario === 'extra-volume') opaque.volumes.other = { isCreated: true };
      if (scenario === 'extra-volume-field') opaque.volumes[p.storageId].isDeleted = false;
      if (scenario === 'not-created') opaque.volumes[p.storageId].isCreated = false;
      if (scenario === 'malformed-created') opaque.volumes[p.storageId].isCreated = 'true';
      if (scenario === 'missing-volume') delete opaque.volumes[p.storageId];
      if (scenario === 'missing-snapshot') f.deploymentSnapshots.delete(p.successor.id);
      if (scenario === 'snapshot-identity') snapshot.id = 'unlinked-snapshot';
      if (scenario === 'snapshot-password') values.POSTGRES_PASSWORD = 'synthetic-drift-password';
      if (scenario === 'snapshot-reference') values.PGPASSWORD = password;
      if (scenario === 'snapshot-pgdata') values.PGDATA = '/other';
      if (scenario === 'snapshot-extra-variable') values.UNREVIEWED = 'value';
      if (scenario === 'predecessor-snapshot-drift') {
        (f.deploymentSnapshots.get(p.predecessor.id)!.variables as Record<string, string>).PGDATA = '/other';
      }
      if (scenario === 'both-snapshots-drift') {
        values.POSTGRES_PASSWORD = 'synthetic-drift-password';
        (f.deploymentSnapshots.get(p.predecessor.id)!.variables as Record<string, string>).POSTGRES_PASSWORD = values.POSTGRES_PASSWORD;
      }
      if (scenario === 'image') p.successor.meta.image = 'postgres:17';
      if (scenario === 'both-images-drift') p.predecessor.meta!.image = p.successor.meta.image = 'postgres:17';
      if (scenario === 'image-digest') p.successor.meta.imageDigest = `sha256:${'b'.repeat(64)}`;
      if (scenario === 'both-invalid-digest') p.predecessor.meta!.imageDigest = p.successor.meta.imageDigest = 'malformed';
      if (scenario === 'runtime') p.successor.meta.runtime = 'unreviewed-runtime';
      if (scenario === 'manifest') p.successor.meta.serviceManifest.deploy.startCommand = 'unreviewed';
      if (scenario === 'both-startup-drift') {
        p.predecessor.meta!.serviceManifest.deploy.startCommand = p.successor.meta.serviceManifest.deploy.startCommand = 'unreviewed';
      }
      if (scenario === 'both-predeploy-drift') {
        p.predecessor.meta!.serviceManifest.deploy.preDeployCommand = p.successor.meta.serviceManifest.deploy.preDeployCommand = ['unreviewed'];
      }
      if (scenario === 'both-replicas-drift') {
        p.predecessor.meta!.serviceManifest.deploy.numReplicas = p.successor.meta.serviceManifest.deploy.numReplicas = 2;
      }
      if (scenario === 'missing-metadata') p.successor.meta = {};
      if (scenario === 'volume-mounts') p.successor.meta.volumeMounts = [];
      if (scenario === 'both-wrong-volume-mounts') p.predecessor.meta!.volumeMounts = p.successor.meta.volumeMounts = ['/other'];
      if (scenario === 'both-extra-volume-mounts') p.predecessor.meta!.volumeMounts = p.successor.meta.volumeMounts = [mountPath, '/other'];
      if (scenario === 'predecessor-running') p.predecessor.status = 'SUCCESS';
      if (scenario === 'predecessor-not-stopped') p.predecessor.deploymentStopped = false;
      if (scenario === 'successor-stopped') p.successor.deploymentStopped = true;
      if (scenario === 'successor-pending') p.successor.status = 'DEPLOYING';
      if (scenario === 'successor-scope') p.successor.environmentId = stagingId;
      if (scenario === 'multiple-active') p.instance.activeDeployments = [p.successor, p.predecessor];
      if (scenario === 'no-active') p.instance.activeDeployments = [];
      if (scenario === 'not-latest') p.instance.latestDeployment = { id: 'unrelated', status: 'SUCCESS' };
      const volume = f.volumes.get(p.storageId)!;
      if (scenario === 'storage-instance') volume.id = 'unreviewed-storage-instance';
      if (scenario === 'storage-pending-deletion') volume.isPendingDeletion = true;
      if (scenario === 'storage-mount') volume.mountPath = '/other';
      if (scenario === 'current-variables') f.variables.get(`${f.serviceId}/${productionId}`)!.KEEP_ME = 'changed';
    });
    const result = await run.apply();
    expect(result.state).not.toBe('complete');
    expect(result.progress).toMatchObject({ phase: 'activation-identified', deploymentId: proof().predecessor.id,
      storageId: proof().storageId });
    expect((result.progress as Record<string, unknown>).activationReconciliation).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(password);
    expect((await run.apply()).state).not.toBe('complete');
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert', 'volumeCreate', 'serviceInstanceDeployV2']);
  });

  it('refuses a candidate swap after reading successor proof and keeps the original acknowledgements', async () => {
    const f = await fixture();
    const run = await start(f);
    const proof = installStorageAttachmentSuccessor(f);
    alterResponse('environmentPatch', () => {
      proof().instance.latestDeployment = { id: 'unreviewed-later-deployment', status: 'SUCCESS' };
      proof().instance.activeDeployments = [{ id: 'unreviewed-later-deployment' }];
    });
    const result = await run.apply();
    expect(result.state).not.toBe('complete');
    expect(result.progress.deploymentId).toBe(proof().predecessor.id);
    expect(f.mutations).toHaveLength(3);
  });

  it('refuses an immutable snapshot identity changing during verification even with identical values', async () => {
    const f = await fixture();
    const run = await start(f);
    const proof = installStorageAttachmentSuccessor(f);
    alterResponse('query InitializedDatabaseActivationPatch', () => {
      proof().successor.snapshotId = 'unexpected-replacement-snapshot';
      f.deploymentSnapshots.get(proof().successor.id)!.id = proof().successor.snapshotId;
    });
    const result = await run.apply();
    expect(result.state).not.toBe('complete');
    expect(result.progress.deploymentId).toBe(proof().predecessor.id);
    expect(f.mutations).toHaveLength(3);
  });

  it.each(['Successor', 'Patch'])('retains acknowledgements when the %s proof read is denied and scrubs provider errors', async operation => {
    const f = await fixture({ responseOverride: request => request.query.includes(`query InitializedDatabaseActivation${operation}`)
      ? Response.json({ errors: [{ message: `Provider echoed ${password}` }] }, { status: 403 }) : undefined });
    const run = await start(f);
    const proof = installStorageAttachmentSuccessor(f);
    const result = await run.apply();
    expect(result.state).not.toBe('complete');
    expect(result.progress).toMatchObject({ deploymentId: proof().predecessor.id, storageId: proof().storageId });
    expect(JSON.stringify(result)).not.toContain(password);
    expect((await run.apply()).state).not.toBe('complete');
    expect(f.mutations).toHaveLength(3);
  });

  it('reverifies a successor after a lost local completion acknowledgement without repeating provider writes', async () => {
    const f = await fixture();
    const run = await start(f);
    const proof = installStorageAttachmentSuccessor(f);
    let persisted: DatabaseFreshInitializationProgress = { phase: 'prepared' };
    let failCompletion = true;
    const apply = () => f.database.freshInitialization!.apply({ environment: f.environment, component: f.component,
      reviewed: run.inspection, progress: persisted, saveProgress: async next => {
        if (next.phase === 'complete' && failCompletion) {
          failCompletion = false;
          throw new Error('Synthetic lost local completion acknowledgement');
        }
        persisted = structuredClone(next);
      } });
    expect((await apply()).state).not.toBe('complete');
    expect(persisted).toMatchObject({ phase: 'activation-identified', deploymentId: proof().predecessor.id });
    const result = await apply();
    expect(result).toMatchObject({ state: 'complete', progress: { deploymentId: proof().predecessor.id,
      activationReconciliation: { deploymentId: proof().successor.id, operationId: proof().operationId } } });
    expect(f.mutations).toHaveLength(3);
  });

  it('retains completed successor proof and fails closed if another deployment becomes current on retry', async () => {
    const f = await fixture();
    const run = await start(f);
    const proof = installStorageAttachmentSuccessor(f);
    const first = await run.apply();
    expect(first.state).toBe('complete');
    proof().instance.latestDeployment = { id: 'unreviewed-later-deployment', status: 'SUCCESS' };
    proof().instance.activeDeployments = [{ id: 'unreviewed-later-deployment' }];
    const retry = await run.apply();
    expect(retry.state).not.toBe('complete');
    expect(retry.progress).toEqual(first.progress);
    expect(f.mutations).toHaveLength(3);
  });

  // Railway CLI f60f3a77, controllers/config/environment.rs and
  // controllers/regions.rs, defines explicit regional replica counts separately
  // from the nullable ServiceInstance scalar. This reconstructed configured
  // topology is not a claim about live running replicas or a null-to-one default.
  it('initializes from explicit single-region proof when the scalar replica count is null, without rewriting replicas or repeating writes', async () => {
    const f = await fixture();
    f.service.instances.get(productionId)!.numReplicas = null;
    const deploy = { multiRegionConfig: { 'us-west2': { numReplicas: 1 } } };
    f.environments.get(productionId)!.config.services![f.serviceId].deploy = structuredClone(deploy);
    const run = await start(f);
    const result = await run.apply();
    expect(result.state).toBe('complete');
    expect(result.progress).toMatchObject({ phase: 'complete', storageId: expect.any(String),
      storageInstanceId: expect.any(String), deploymentId: expect.any(String) });
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert', 'volumeCreate', 'serviceInstanceDeployV2']);
    expect(f.mutations[0].args.input.variables).toEqual({ PGDATA: dataPath });
    expect(f.service.instances.get(productionId)!.numReplicas).toBeNull();
    expect(f.environments.get(productionId)!.config.services![f.serviceId].deploy).toEqual(deploy);
    const count = f.mutations.length;
    expect(await run.apply()).toMatchObject({ state: 'complete', progress: result.progress });
    expect(f.mutations).toHaveLength(count);
    expect(f.contractErrors).toEqual([]);
  });

  it.each([undefined, '1', -1, 0.5])('keeps omitted or malformed scalar replica evidence unknown despite a valid regional map: %j', async scalar => {
    const f = await fixture();
    f.environments.get(productionId)!.config.services![f.serviceId].deploy = {
      multiRegionConfig: { 'us-west2': { numReplicas: 1 } },
    };
    // Deliberately corrupt the serialized response after schema execution so
    // missing selected fields are distinguishable from contract-permitted null.
    alterResponse('query DatabaseInitializationTarget', body => {
      if (scalar === undefined) delete body.data.serviceInstance.numReplicas;
      else body.data.serviceInstance.numReplicas = scalar;
    });
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('unknown');
    expect(f.mutations).toEqual([]);
  });

  it.each([
    undefined, null, {}, { multiRegionConfig: undefined }, { multiRegionConfig: null }, { multiRegionConfig: {} },
    { multiRegionConfig: { 'us-west2': null } },
    { multiRegionConfig: { 'us-west2': {} } },
    { multiRegionConfig: { 'us-west2': { numReplicas: null } } },
    { multiRegionConfig: { 'us-west2': { numReplicas: '1' } } },
    { multiRegionConfig: { 'us-west2': { numReplicas: -1 } } },
    { multiRegionConfig: { 'us-west2': { numReplicas: 0.5 } } },
  ])('does not invent a replica count from null plus incomplete regional proof: %j', async deploy => {
    const f = await fixture();
    f.service.instances.get(productionId)!.numReplicas = null;
    f.environments.get(productionId)!.config.services![f.serviceId].deploy = deploy;
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('unknown');
    expect(f.mutations).toEqual([]);
    expect(f.contractErrors).toEqual([]);
  });

  it.each([
    { scalar: null, regional: 0 }, { scalar: null, regional: 2 },
    { scalar: 0, regional: 1 }, { scalar: 1, regional: 0 }, { scalar: 2, regional: 1 },
  ])('rejects non-single or contradictory configured replica counts: %j', async ({ scalar, regional }) => {
    const f = await fixture();
    f.service.instances.get(productionId)!.numReplicas = scalar;
    f.environments.get(productionId)!.config.services![f.serviceId].deploy = {
      multiRegionConfig: { 'us-west2': { numReplicas: regional } },
    };
    expect((await f.database.freshInitialization!.inspect(f)).state).not.toBe('eligible');
    expect(f.mutations).toEqual([]);
    expect(f.contractErrors).toEqual([]);
  });

  it('rejects a reviewed single replica moving to another region before any writes', async () => {
    const f = await fixture();
    f.environments.get(productionId)!.config.services![f.serviceId].deploy = {
      multiRegionConfig: { 'us-west2': { numReplicas: 1 } },
    };
    const run = await start(f);
    f.environments.get(productionId)!.config.services![f.serviceId].deploy = {
      multiRegionConfig: { 'us-east4': { numReplicas: 1 } },
    };
    expect((await run.apply()).state).not.toBe('complete');
    expect(f.mutations).toEqual([]);
    expect((await run.apply()).state).not.toBe('complete');
    expect(f.mutations).toEqual([]);
  });

  it.each([1, null].flatMap(scalar => ['moved', 'missing', 'null', 'empty'].map(change => ({ scalar, change }))))
  ('retains the acknowledged volume without repeating writes when scalar $scalar regional proof becomes $change', async ({ scalar, change }) => {
    const f = await fixture();
    f.service.instances.get(productionId)!.numReplicas = scalar;
    f.environments.get(productionId)!.config.services![f.serviceId].deploy = {
      multiRegionConfig: { 'us-west2': { numReplicas: 1 } },
    };
    const run = await start(f);
    alterResponse('mutation InitializationVolumeCreate', () => {
      f.environments.get(productionId)!.config.services![f.serviceId].deploy = change === 'missing' ? {}
        : { multiRegionConfig: change === 'moved' ? { 'us-east4': { numReplicas: 1 } }
          : change === 'null' ? null : {} };
    });
    const result = await run.apply();
    expect(result.state).toBe('unknown');
    expect(result.progress.storageId).toEqual(expect.any(String));
    expect(result.progress.deploymentId).toBeUndefined();
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert', 'volumeCreate']);
    expect(await run.apply()).toMatchObject({ state: 'unknown', progress: { storageId: result.progress.storageId } });
    expect(f.mutations).toHaveLength(2);
    expect(f.volumes.has(result.progress.storageId!)).toBe(true);
    expect(f.contractErrors).toEqual([]);
  });

  it.each(['preserved', 'replaced-with-null'] as const)('preserves version-one retry authorization when its scalar proof is %s', async scalarState => {
    const f = await fixture({ dropVariableResponse: true });
    // Reconstructed persisted format from the c11923ac producer and this
    // synthetic provider fixture. Its fixed old fingerprint is deliberately
    // independent of the new inspection producer and contains no regional proof.
    const url = `postgresql://postgres:${password}@postgres-db.railway.internal:5432/railway`;
    const reviewed = {
      target: { provider: 'railway', externalId: 'production-postgres-db',
        providerScope: { projectId, environmentId: productionId } },
      configurationFingerprint: 'c8880600b4aab95883f6d385d271774dea73f209e8816f9dd442738359469728',
      privateConfiguration: {
        version: 1, instanceId: 'instance-production-postgres-db-environment-production',
        image: 'postgres:16', serviceName: 'postgres-db', startCommand: null, preDeployCommand: null,
        rawVariables: { ...rawVariables }, issuerVariables: {
          POSTGRES_PASSWORD: password, POSTGRES_USER: 'postgres', POSTGRES_DB: 'railway',
          PGPASSWORD: password, PGUSER: 'postgres', PGDATABASE: 'railway',
          PGHOST: 'postgres-db.railway.internal', PGPORT: '5432', DATABASE_URL: url, DIRECT_URL: url,
        },
        dataPath, desiredPGDATA: dataPath,
      },
    };
    let progress: DatabaseFreshInitializationProgress = { phase: 'prepared' };
    const apply = () => f.database.freshInitialization!.apply({ environment: f.environment, component: f.component,
      reviewed, progress, saveProgress: async next => { progress = structuredClone(next); } });
    expect(await apply()).toMatchObject({ state: 'unknown', progress: { phase: 'configuration-attempted' } });
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert']);
    if (scalarState === 'replaced-with-null') {
      f.service.instances.get(productionId)!.numReplicas = null;
      f.environments.get(productionId)!.config.services![f.serviceId].deploy = {
        multiRegionConfig: { 'us-west2': { numReplicas: 1 } },
      };
    }
    const result = await apply();
    expect(result.state).toBe(scalarState === 'preserved' ? 'complete' : 'unknown');
    const expectedWrites = scalarState === 'preserved'
      ? ['variableCollectionUpsert', 'volumeCreate', 'serviceInstanceDeployV2'] : ['variableCollectionUpsert'];
    expect(f.mutations.map(mutation => mutation.field)).toEqual(expectedWrites);
    expect((await apply()).state).toBe(result.state);
    expect(f.mutations.map(mutation => mutation.field)).toEqual(expectedWrites);
    expect(f.contractErrors).toEqual([]);
  });

  it.each(['volume', 'deployment'] as const)('retains an uncertain %s write without adopting or repeating it', async operation => {
    const f = await fixture(operation === 'volume' ? { dropVolumeCreateResponse: true } : { dropDeploymentResponse: true });
    const run = await start(f);
    const first = await run.apply();
    expect(first.state).toBe('unknown');
    expect(first.progress.phase).toBe(operation === 'volume' ? 'storage-attempted' : 'activation-attempted');
    expect(operation === 'volume' ? first.progress.storageId : first.progress.deploymentId).toBeUndefined();
    const count = f.mutations.length;
    expect((await run.apply()).state).toBe('unknown');
    expect(f.mutations).toHaveLength(count);
    expect(f.mutations.some(mutation => mutation.field.endsWith('Delete'))).toBe(false);
    expect(f.contractErrors).toEqual([]);
  });

  it.each([
    ['INITIALIZING', 'pending'], ['BUILDING', 'pending'], ['DEPLOYING', 'pending'], ['QUEUED', 'pending'],
    ['WAITING', 'pending'], ['NEEDS_APPROVAL', 'pending'], ['FAILED', 'failed'], ['CRASHED', 'failed'],
    ['REMOVED', 'failed'], ['REMOVING', 'failed'], ['SKIPPED', 'failed'], ['SLEEPING', 'failed'], ['SUCCESS', 'complete'],
  ])('interprets official deployment status %s as %s', async (deploymentStatus, state) => {
    const f = await fixture({ deploymentStatus });
    const run = await start(f);
    const result = await run.apply();
    expect(result.state).toBe(state);
    expect(result.progress).toMatchObject({ storageId: expect.any(String), deploymentId: expect.any(String) });
    expect((await run.apply()).state).toBe(state);
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert', 'volumeCreate', 'serviceInstanceDeployV2']);
    expect(f.contractErrors).toEqual([]);
  });

  it.each(['FAILED', 'CRASHED'])('classifies the exact %s deployment with stopped instances as failed', async deploymentStatus => {
    const f = await fixture({ deploymentStatus });
    const run = await start(f);
    alterResponse('mutation InitializeDatabaseDeployment', () => {
      [...f.deployments.values()][0]!.deploymentStopped = true;
    });
    const result = await run.apply();
    expect(result.state).toBe('failed');
    expect(result.progress).toMatchObject({ phase: 'activation-identified', deploymentId: expect.any(String) });
    expect((await run.apply()).state).toBe('failed');
    expect(f.mutations).toHaveLength(3);
    expect(f.contractErrors).toEqual([]);
  });

  it.each(['PGPASSWORD', 'PGUSER', 'PGDATABASE', 'DATABASE_URL', 'DIRECT_URL'])('refuses inconsistent initializer alias %s', async key => {
    const f = await fixture();
    f.variables.get(`${f.serviceId}/${productionId}`)![key] = 'wrong';
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('ineligible');
    expect(f.mutations).toEqual([]);
  });

  it.each(['POSTGRES_PASSWORD', 'POSTGRES_USER', 'POSTGRES_DB'])('does not invent missing initializer %s', async key => {
    const f = await fixture();
    delete f.variables.get(`${f.serviceId}/${productionId}`)![key];
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('ineligible');
    expect(f.mutations).toEqual([]);
  });

  it.each([
    { user: undefined, db: undefined, effectiveUser: 'postgres', effectiveDb: 'postgres' },
    { user: '', db: '', effectiveUser: 'postgres', effectiveDb: 'postgres' },
    { user: 'existing_owner', db: undefined, effectiveUser: 'existing_owner', effectiveDb: 'existing_owner' },
    { user: undefined, db: 'existing_db', effectiveUser: 'postgres', effectiveDb: 'existing_db' },
  ])('uses documented empty/missing user and database defaults privately: $user / $db', async ({ user, db, effectiveUser, effectiveDb }) => {
    const f = await fixture();
    const raw = f.variables.get(`${f.serviceId}/${productionId}`)!;
    if (user === undefined) delete raw.POSTGRES_USER; else raw.POSTGRES_USER = user;
    if (db === undefined) delete raw.POSTGRES_DB; else raw.POSTGRES_DB = db;
    raw.PGUSER = effectiveUser;
    raw.PGDATABASE = effectiveDb;
    const before = structuredClone(raw);
    const run = await start(f);
    expect((await run.apply()).state).toBe('complete');
    expect(f.variables.get(`${f.serviceId}/${productionId}`)).toEqual({ ...before, PGDATA: dataPath });
    expect(f.mutations[0].args.input.variables).toEqual({ PGDATA: dataPath });
  });

  it.each(['PGUSER', 'PGDATABASE', 'DATABASE_URL'])('rejects alias %s that disagrees with documented initializer defaults', async alias => {
    const f = await fixture();
    const raw = f.variables.get(`${f.serviceId}/${productionId}`)!;
    delete raw.POSTGRES_USER; delete raw.POSTGRES_DB;
    raw.PGUSER = 'postgres'; raw.PGDATABASE = 'postgres';
    raw[alias] = alias === 'DATABASE_URL' ? `postgresql://other:${password}@postgres-db.railway.internal:5432/postgres` : 'other';
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('ineligible');
    expect(f.mutations).toEqual([]);
  });

  it.each(['POSTGRES_PASSWORD_FILE', 'POSTGRES_USER_FILE', 'POSTGRES_DB_FILE', 'POSTGRES_INITDB_ARGS',
    'POSTGRES_INITDB_WALDIR', 'POSTGRES_HOST_AUTH_METHOD', 'RAILWAY_RUN_UID', 'PGOPTIONS'])('rejects unreviewed initialization control %s', async key => {
    const f = await fixture();
    f.variables.get(`${f.serviceId}/${productionId}`)![key] = 'synthetic-custom-value';
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('ineligible');
    expect(f.mutations).toEqual([]);
  });

  it.each(['postgres:17', 'postgres:18', 'custom/postgres:16', 'postgres:latest'])('rejects an image outside the reviewed postgres16 contract: %s', async image => {
    const f = await fixture();
    f.service.instances.get(productionId)!.source = { image };
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('ineligible');
    expect(f.mutations).toEqual([]);
  });

  it.each(['custom-start', 'custom-predeploy', 'replicas', 'deploying', 'wrong-name', 'malformed-scope'] as const)('refuses unsafe target %s', async scenario => {
    const f = await fixture();
    const instance = f.service.instances.get(productionId)!;
    if (scenario === 'custom-start') instance.startCommand = 'postgres -D /tmp/other';
    if (scenario === 'custom-predeploy') instance.preDeployCommand = ['initdb'];
    if (scenario === 'replicas') instance.numReplicas = 2;
    if (scenario === 'deploying') instance.latestDeployment!.status = 'DEPLOYING';
    if (scenario === 'wrong-name') f.service.name = 'renamed';
    if (scenario === 'malformed-scope') f.component.bindings.providerScope = { projectId, environmentId: '' };
    expect((await f.database.freshInitialization!.inspect(f)).state).not.toBe('eligible');
    expect(f.mutations).toEqual([]);
  });

  it.each([{ projectId }, {}, undefined])('independently verifies missing native scope without rewriting legacy bindings: %j', async providerScope => {
    const f = await fixture();
    if (providerScope === undefined) delete f.component.bindings.providerScope;
    else f.component.bindings.providerScope = providerScope;
    const before = structuredClone(f.component.bindings);
    const run = await start(f);
    expect(run.inspection.target.providerScope).toEqual({ projectId, environmentId: productionId });
    const result = await run.apply();
    expect(result.state).toBe('complete');
    expect(result.storageBindings).not.toHaveProperty('providerScope');
    expect(f.component.bindings).toEqual(before);
  });

  it('refuses an unknown existing deployment status before writes', async () => {
    const f = await fixture();
    alterResponse('query DatabaseInitializationTarget', body => { body.data.serviceInstance.latestDeployment.status = 'FUTURE_UNKNOWN'; });
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('unknown');
    expect(f.mutations).toEqual([]);
  });

  it('rejects multiple regional replicas even when the scalar replica count is one', async () => {
    const f = await fixture();
    f.environments.get(productionId)!.config.services![f.serviceId].deploy = {
      multiRegionConfig: { 'us-west2': { numReplicas: 1 }, 'us-east4': { numReplicas: 1 } },
    };
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('unknown');
    expect(f.mutations).toEqual([]);
  });

  it.each([`${mountPath}//pgdata`, `${mountPath}/pgdata/`, `${mountPath}/./pgdata`, `${mountPath}/../other`])
  ('refuses a non-normalized PGDATA child path %s', async path => {
    const f = await fixture();
    f.variables.get(`${f.serviceId}/${productionId}`)!.PGDATA = path;
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('ineligible');
    expect(f.mutations).toEqual([]);
  });

  it.each([mountPath, '/different-mount'])('does not adopt or replace an existing volume at %s', async existingMount => {
    const f = await fixture({ pageSize: 1 });
    f.addVolume('production-web', productionId, '/documents');
    f.addVolume(f.serviceId, productionId, existingMount);
    expect((await f.database.freshInitialization!.inspect(f)).state).not.toBe('eligible');
    expect(f.mutations).toEqual([]);
  });

  it('paginates all scoped volume state and leaves other environments and document storage untouched', async () => {
    const f = await fixture({ pageSize: 1 });
    const same = f.addVolume('production-web', productionId, '/documents');
    const other = f.addVolume(f.serviceId, stagingId, mountPath);
    const before = JSON.stringify([same, other]);
    const run = await start(f);
    expect((await run.apply()).state).toBe('complete');
    expect(JSON.stringify([same, other])).toBe(before);
    expect(f.volumes.size).toBe(3);
    expect(f.requests.some(request => request.query.includes('EnvironmentVolumeInstances') && request.variables.after)).toBe(true);
    expect(f.contractErrors).toEqual([]);
  });

  it('preserves an existing valid PGDATA reference and does not issue a variable write', async () => {
    const f = await fixture();
    Object.assign(f.variables.get(`${f.serviceId}/${productionId}`)!, { DATA_PARENT: mountPath, PGDATA: '${{DATA_PARENT}}/pgdata' });
    const run = await start(f);
    expect((await run.apply()).state).toBe('complete');
    expect(f.variables.get(`${f.serviceId}/${productionId}`)?.PGDATA).toBe('${{DATA_PARENT}}/pgdata');
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['volumeCreate', 'serviceInstanceDeployV2']);
  });

  it.each(['password', 'alias', 'extra-variable', 'image', 'name', 'volume'] as const)('blocks changed reviewed %s before any writes', async change => {
    const f = await fixture();
    const run = await start(f);
    const vars = f.variables.get(`${f.serviceId}/${productionId}`)!;
    if (change === 'password') vars.POSTGRES_PASSWORD = 'new-synthetic-password';
    if (change === 'alias') vars.PGPASSWORD = password;
    if (change === 'extra-variable') vars.EXTRA = 'changed';
    if (change === 'image') f.service.instances.get(productionId)!.source.image = 'postgres:16.9';
    if (change === 'name') f.service.name = 'renamed';
    if (change === 'volume') f.addVolume(f.serviceId, productionId, mountPath);
    expect((await run.apply()).state).not.toBe('complete');
    expect(f.mutations).toEqual([]);
  });

  it.each(['unchanged', 'changed', 'missing'] as const)('reconciles lost configuration acknowledgement only with exact %s readback', async scenario => {
    const f = await fixture({ dropVariableResponse: true });
    const run = await start(f);
    expect((await run.apply()).state).toBe('unknown');
    expect(run.progress().phase).toBe('configuration-attempted');
    if (scenario === 'changed') f.variables.get(`${f.serviceId}/${productionId}`)!.KEEP_ME = 'changed';
    if (scenario === 'missing') delete f.variables.get(`${f.serviceId}/${productionId}`)!.PGDATA;
    expect((await run.apply()).state).toBe(scenario === 'unchanged' ? 'complete' : 'unknown');
    expect(f.mutations.filter(mutation => mutation.field === 'variableCollectionUpsert')).toHaveLength(1);
    if (scenario !== 'unchanged') expect(f.mutations).toHaveLength(1);
  });

  it.each(['configuration-attempted', 'storage-attempted', 'storage-identified', 'activation-attempted', 'activation-identified'] as const)
  ('awaits durable %s progress and retains any acknowledged identity on persistence failure', async failedPhase => {
    const f = await fixture();
    const run = await start(f);
    const saved: DatabaseFreshInitializationProgress[] = [];
    const result = await f.database.freshInitialization!.apply({ environment: f.environment, component: f.component,
      reviewed: run.inspection, progress: { phase: 'prepared' }, saveProgress: async progress => {
        if (progress.phase === failedPhase) throw new Error('Synthetic state persistence failure');
        saved.push(progress);
      } });
    expect(result.state).toBe('unknown');
    expect(result.progress.phase).toBe(failedPhase);
    const expected = { 'configuration-attempted': 0, 'storage-attempted': 1, 'storage-identified': 2,
      'activation-attempted': 2, 'activation-identified': 3 }[failedPhase];
    expect(f.mutations).toHaveLength(expected);
    if (['storage-identified', 'activation-attempted', 'activation-identified'].includes(failedPhase)) expect(result.progress.storageId).toBeDefined();
    if (failedPhase === 'activation-identified') expect(result.progress.deploymentId).toBeDefined();
  });

  it('retains the acknowledged volume ID when the returned identity never matches scoped storage', async () => {
    const f = await fixture({ volumeCreateResponseId: 'unmatched-acknowledged-volume' });
    const run = await start(f);
    const result = await run.apply();
    expect(result).toMatchObject({ state: 'unknown', progress: { phase: 'storage-identified', storageId: 'unmatched-acknowledged-volume' } });
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert', 'volumeCreate']);
    expect((await run.apply()).state).toBe('unknown');
    expect(f.mutations).toHaveLength(2);
  });

  it('resumes delayed storage visibility from its acknowledged ID without another create', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture({ volumeDelayMs: 60_000 });
    const run = await start(f);
    const first = await run.apply();
    expect(first).toMatchObject({ state: 'pending', progress: { phase: 'storage-identified', storageId: expect.any(String) } });
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert', 'volumeCreate']);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await run.apply()).state).toBe('complete');
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert', 'volumeCreate', 'serviceInstanceDeployV2']);
  });

  it.each(['instance', 'pending-deletion', 'mount', 'variables'] as const)('refuses changed %s after deployment acknowledgement', async change => {
    const f = await fixture();
    const run = await start(f);
    alterResponse('mutation InitializeDatabaseDeployment', () => {
      const volume = [...f.volumes.values()][0]!;
      if (change === 'instance') volume.id = 'another-volume-instance';
      if (change === 'pending-deletion') volume.isPendingDeletion = true;
      if (change === 'mount') volume.mountPath = '/another-mount';
      if (change === 'variables') f.variables.get(`${f.serviceId}/${productionId}`)!.KEEP_ME = 'changed';
    });
    const result = await run.apply();
    expect(result).toMatchObject({ state: 'unknown', progress: { phase: 'activation-identified',
      storageId: expect.any(String), storageInstanceId: expect.any(String), deploymentId: expect.any(String) } });
    expect(f.mutations).toHaveLength(3);
    expect((await run.apply()).state).toBe('unknown');
    expect(f.mutations).toHaveLength(3);
  });

  it.each(['volume', 'deployment'] as const)('retains %s identity after later read permission is lost without leaking provider errors', async operation => {
    let deny = false;
    const f = await fixture({ responseOverride: request => {
      if (deny && request.query.includes(operation === 'volume' ? 'query WebVolumeServiceTarget' : 'query InitializedDatabaseDeployment')) {
        return Response.json({ errors: [{ message: `Provider echoed ${password}` }] }, { status: 403 });
      }
      return undefined;
    } });
    const run = await start(f);
    alterResponse(operation === 'volume' ? 'mutation InitializationVolumeCreate' : 'mutation InitializeDatabaseDeployment', () => { deny = true; });
    const result = await run.apply();
    expect(result.state).toBe('unknown');
    expect(result.progress.storageId).toBeDefined();
    if (operation === 'deployment') expect(result.progress.deploymentId).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(password);
    const count = f.mutations.length;
    expect((await run.apply()).state).toBe('unknown');
    expect(f.mutations).toHaveLength(count);
  });

  it.each([null, [], { environmentId: 'wrong-environment' }, { projectId: 'wrong-project' }, { extra: 'unsupported' }])
  ('blocks malformed or contradictory recorded scope %j', async providerScope => {
    const f = await fixture();
    f.component.bindings.providerScope = providerScope;
    expect((await f.database.freshInitialization!.inspect(f)).state).toBe('unknown');
    expect(f.mutations).toEqual([]);
  });

  it.each(['deploymentId', 'serviceId', 'environmentId', 'projectId', 'latestId', 'stopped', 'missing-status'] as const)
  ('rejects mismatched or missing deployment evidence: %s', async mismatch => {
    const f = await fixture();
    const run = await start(f);
    alterResponse('query InitializedDatabaseDeployment', body => {
      if (mismatch === 'latestId') body.data.serviceInstance.latestDeployment.id = 'unrelated';
      else if (mismatch === 'stopped') body.data.deployment.deploymentStopped = true;
      else if (mismatch === 'missing-status') delete body.data.deployment.status;
      else body.data.deployment[mismatch === 'deploymentId' ? 'id' : mismatch] = 'unrelated';
    });
    const result = await run.apply();
    expect(result.state).toBe('unknown');
    expect(result.progress.deploymentId).toBeDefined();
    expect(f.mutations).toHaveLength(3);
  });

  it.each(['missing-variables', 'missing-environment', 'wrong-project', 'missing-volume-page', 'forbidden'] as const)
  ('treats incomplete or unauthorized observations as unknown: %s', async scenario => {
    const f = await fixture();
    if (scenario === 'missing-volume-page') alterResponse('query EnvironmentVolumeInstances', body => { delete body.data.environment.volumeInstances.pageInfo; });
    else if (scenario === 'forbidden') alterResponse('query DatabaseInitializationTarget', body => {
      delete body.data; body.errors = [{ message: `${password} should not escape`, extensions: { code: 'FORBIDDEN' } }];
    });
    else alterResponse('query DatabaseInitializationTarget', body => {
      if (scenario === 'missing-variables') delete body.data.rawVariables;
      if (scenario === 'missing-environment') delete body.data.environment;
      if (scenario === 'wrong-project') body.data.environment.projectId = 'another-project';
    });
    const result = await f.database.freshInitialization!.inspect(f);
    expect(result.state).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(password);
    expect(f.mutations).toEqual([]);
  });
});

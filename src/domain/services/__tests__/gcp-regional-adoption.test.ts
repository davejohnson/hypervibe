import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { OpenTofuEngine } from '../../../adapters/engine/opentofu/engine.js';
import * as install from '../../../adapters/engine/opentofu/install.js';
import { runCloudPrepare } from '../cloud-prepare.execute.js';
import { getCloudPrepareProfile } from '../cloud-prepare.js';
import { buildGcpBootstrapConfiguration } from '../../../adapters/providers/gcp/tofu/gcp-setup.backend.js';
import { engineStatePaths, ensureEngineStateDirectories } from '../../../adapters/engine/opentofu/workspace.js';
import type { EngineConfiguration } from '../../ports/infrastructure-engine.port.js';

const gcpProjectId = 'legacy-engine-app';
const deploy = `hypervibe-deploy@${gcpProjectId}.iam.gserviceaccount.com`;
const runtime = `hypervibe-runtime@${gcpProjectId}.iam.gserviceaccount.com`;
const bucket = `${gcpProjectId}-hv-build-source`;
const repository = `projects/${gcpProjectId}/locations/us-central1/repositories/hypervibe`;
const repositoryAddress = 'google_artifact_registry_repository.release_images_us_central1';
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-regional-adoption-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'test.db'));
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/not-executed' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(directory);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const profile = getCloudPrepareProfile('cloudrun')!;
  const project = new ProjectRepository().create({ name: 'legacy-regional-app', defaultPlatform: 'cloudrun', policies: { cloudPreparation: { cloudrun: {
    provider: 'cloudrun', version: profile.version, preparedAt: '2026-10-01T00:00:00Z', gcpProjectId,
    deployServiceAccountEmail: deploy, runtimeServiceAccountEmail: runtime, runtimeServiceAccountUniqueId: '123456789012345678902',
    requiredApis: [...profile.requiredApis], requiredRoles: [...profile.requiredRoles], runtimeRequiredRoles: ['roles/cloudsql.client', 'roles/secretmanager.secretAccessor'], runtimeServiceAccountAccessRoles: ['roles/iam.serviceAccountUser'],
  } } } });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'cloudrun', projectId: gcpProjectId, environmentId: 'us-central1', engine: { kind: 'opentofu' }, services: { web: { serviceId: 'web-staging' } },
  } });
  const reservation = new RunRepository().reserveApply({ projectId: project.id, environmentId: environment.id, planRunId: 'historical-engine-release', environmentName: 'staging', specRevision: 1 });
  if (!reservation.reserved) throw new Error('Could not seed release receipt');
  const released = reservation.run;
  new RunRepository().addReceipt(released.id, { step: 'release:web', status: 'success', timestamp: '2026-10-01T00:01:00Z', result: { imageUri: `us-central1-docker.pkg.dev/${gcpProjectId}/hypervibe/web@sha256:${'a'.repeat(64)}` } });
  new RunRepository().updateStatus(released.id, 'succeeded');
  const configurations: EngineConfiguration[] = [];
  const managed = new Set<string>();
  const plan = vi.spyOn(OpenTofuEngine.prototype, 'plan').mockImplementation(async ({ configuration }) => {
    configurations.push(configuration);
    const segment = { id: 'setup-segment', engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
    return { ok: true, segmentId: segment.id, segment, planFile: '/not-executed', blockers: [], unmanagedDeletes: [],
      actions: Object.entries(configuration.resources).map(([address, mapping]) => ({ id: mapping.actionId, type: managed.has(address) ? 'noop' as const : configuration.imports?.[address] ? 'update' as const : 'create' as const,
        resource: { kind: mapping.kind, name: mapping.name, provider: 'gcp' }, verified: true, reason: 'Saved setup preview',
        metadata: { engineSegment: { ...segment, addresses: [address] }, ...(configuration.imports?.[address] ? { engineAdopt: true } : {}) } })),
    };
  });
  const apply = vi.spyOn(OpenTofuEngine.prototype, 'apply').mockImplementation(async ({ approvedAddresses }) => ({ outcomes: Object.fromEntries(approvedAddresses.map((address) => [address, 'succeeded' as const])), diagnostics: [] }));
  let condition: 'owned' | 'foreign' | 'unknown' | 'malformed' | 'missing' | 'public' = 'owned';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET' && !url.endsWith(':getIamPolicy')) throw new Error('Provider infrastructure mutation is forbidden in the admission probe.');
    if (url.includes('cloudresourcemanager.googleapis.com/v3/projects/')) return Response.json({ projectId: gcpProjectId, name: 'projects/123456789', state: 'ACTIVE' });
    if (url.includes('serviceusage.googleapis.com/')) {
      const service = url.split('/').at(-1); return Response.json({ name: `projects/123456789/services/${service}`, parent: 'projects/123456789', config: { name: service }, state: 'ENABLED' });
    }
    if (url.includes('/serviceAccounts/')) {
      const email = decodeURIComponent(url.split('/serviceAccounts/')[1]!.split(':getIamPolicy')[0]!);
      if (url.endsWith(':getIamPolicy')) return Response.json({ etag: 'test-etag', bindings: [{ role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:${deploy}`] }, { role: 'roles/iam.serviceAccountTokenCreator', members: [`serviceAccount:${deploy}`] }] });
      return Response.json({ name: `projects/${gcpProjectId}/serviceAccounts/${email}`, projectId: gcpProjectId, email, uniqueId: email === runtime ? '123456789012345678902' : '123456789012345678901', disabled: false });
    }
    if (url.includes(`storage.googleapis.com/storage/v1/b/${bucket}`)) {
      if (condition === 'missing') return new Response('{}', { status: 404 });
      if (condition === 'unknown') return new Response('{}', { status: 403 });
      return Response.json({ name: condition === 'malformed' ? 'different-bucket' : bucket, projectNumber: '123456789', location: 'US', labels: { 'managed-by': condition === 'foreign' ? 'another-owner' : 'hypervibe' }, iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' }, lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 14 } }] } });
    }
    if (url.endsWith(':getIamPolicy')) {
      if (condition === 'public') return Response.json({ bindings: [{ role: 'roles/artifactregistry.reader', members: ['allUsers'] }] });
      const resources = (configurations[0]?.files['project-setup.tf.json'] as { resource?: { google_project_iam_member?: Record<string, { role: string; member: string }> } } | undefined)?.resource?.google_project_iam_member ?? {};
      return Response.json({ bindings: Object.values(resources).map((entry) => ({ role: entry.role, members: [entry.member] })) });
    }
    if (url.includes('artifactregistry.googleapis.com/v1/')) return Response.json({ name: repository, format: 'DOCKER', mode: 'STANDARD_REPOSITORY', description: 'Container images built by Hypervibe' });
    return new Response('{}', { status: 404 });
  }));
  return { project, environment, released, configurations, managed, plan, apply, setCondition: (value: typeof condition) => { condition = value; }, params: { project, provider: 'cloudrun', gcpProjectId, deployServiceAccountEmail: deploy, runtimeServiceAccountEmail: runtime, adminAccessToken: 'private-admin-token' } };
}

describe('legacy engine regional setup adoption', () => {
  it('previews explicit imports for exact proven existing build resources', async () => {
    const f = fixture(); const result = await runCloudPrepare(f.params);
    expect(result.success, String(result.error)).toBe(true);
    expect(f.configurations[0]?.imports).toMatchObject({ 'google_storage_bucket.build_source': bucket, [repositoryAddress]: repository });
    expect(JSON.stringify(f.configurations[0])).toContain('prevent_destroy');
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('retains durable release evidence after more than 200 unrelated successful applies', async () => {
    const f = fixture();
    const runs = new RunRepository();
    const unrelatedEnvironment = new EnvironmentRepository().create({ projectId: f.project.id, name: 'unrelated', platformBindings: {} });
    for (let index = 0; index < 201; index++) {
      for (const environment of [f.environment, unrelatedEnvironment]) {
        const reservation = runs.reserveApply({ projectId: f.project.id, environmentId: environment.id, planRunId: `unrelated-${environment.id}-${index}`, environmentName: environment.name, specRevision: 1 });
        if (!reservation.reserved) throw new Error('Could not seed unrelated activity');
        runs.addReceipt(reservation.run.id, { step: environment === f.environment ? 'credentials:rotate' : 'release:web', status: 'success', timestamp: new Date().toISOString(), result: { imageUri: `us-central1-docker.pkg.dev/${gcpProjectId}/hypervibe/web@sha256:${'b'.repeat(64)}` } });
        runs.updateStatus(reservation.run.id, 'succeeded');
      }
    }
    expect(runs.findByProjectId(f.project.id, 200).map(run => run.id)).not.toContain(f.released.id);
    const result = await runCloudPrepare(f.params);
    expect(result.success, String(result.error)).toBe(true);
    expect(f.configurations[0]?.imports).toMatchObject({ 'google_storage_bucket.build_source': bucket, [repositoryAddress]: repository });
    expect(f.apply).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'unknown', 'malformed', 'missing', 'public'] as const)('blocks %s resource evidence before any engine plan or apply', async condition => {
    const f = fixture(); f.setCondition(condition);
    const result = await runCloudPrepare(f.params);
    expect(result.success).toBe(false);
    expect(f.plan).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  });
  it('confirms the unchanged saved import artifact without replanning', async () => {
    const f = fixture(); const preview = await runCloudPrepare(f.params);
    expect(preview.success, String(preview.error)).toBe(true);
    const confirmed = await runCloudPrepare({ ...f.params, confirm: true });
    expect(confirmed.success, String(confirmed.error)).toBe(true);
    expect(f.plan).toHaveBeenCalledOnce(); expect(f.apply).toHaveBeenCalledOnce();
    expect(f.apply.mock.calls[0]![0].planId).toBe(preview.planId);
    expect(f.apply.mock.calls[0]![0].approvedAddresses).toEqual(expect.arrayContaining(['google_storage_bucket.build_source', repositoryAddress]));
  });
  it('does not adopt a matching name without durable release evidence', async () => {
    const f = fixture(); new RunRepository().updateStatus(f.released.id, 'failed');
    const result = await runCloudPrepare(f.params);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('matching name alone') });
    expect(f.plan).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  });
  it('keeps previously approved bootstrap resources in their existing contribution', async () => {
    const f = fixture();
    const bootstrap = buildGcpBootstrapConfiguration({ projectId: gcpProjectId, billingAccountName: 'billingAccounts/123456-ABCDEF-789012', deployServiceAccountEmail: deploy, runtimeServiceAccountEmail: runtime });
    Object.keys(bootstrap.resources).forEach((address) => f.managed.add(address));
    const paths = engineStatePaths({ provider: 'gcp', projectId: f.project.id, environmentId: gcpProjectId, partition: 'project-shared' }, directory);
    ensureEngineStateDirectories(paths);
    fs.writeFileSync(path.join(paths.root, 'setup-manifest.json'), JSON.stringify({ contributions: { bootstrap } }), { mode: 0o600 });
    const preview = await runCloudPrepare(f.params);
    expect(preview.success, String(preview.error)).toBe(true);
    expect(f.configurations[0]?.imports ?? {}).toEqual({});
    const file = fs.readdirSync(paths.plans).find((name) => name.endsWith('.json'))!;
    const saved = JSON.parse(fs.readFileSync(path.join(paths.plans, file), 'utf8')) as { manifest: { contributions: Record<string, EngineConfiguration> } };
    const base = saved.manifest.contributions['prepare-base-us-central1']!;
    expect(base.resources).not.toHaveProperty('google_storage_bucket.build_source');
    expect(base.resources).not.toHaveProperty(repositoryAddress);
    expect(saved.manifest.contributions.bootstrap!.resources).toHaveProperty(repositoryAddress);
  });
  it('blocks a create for an observed existing resource when shared engine state is missing', async () => {
    const f = fixture();
    const bootstrap = buildGcpBootstrapConfiguration({ projectId: gcpProjectId, billingAccountName: 'billingAccounts/123456-ABCDEF-789012', deployServiceAccountEmail: deploy, runtimeServiceAccountEmail: runtime });
    const paths = engineStatePaths({ provider: 'gcp', projectId: f.project.id, environmentId: gcpProjectId, partition: 'project-shared' }, directory);
    ensureEngineStateDirectories(paths);
    fs.writeFileSync(path.join(paths.root, 'setup-manifest.json'), JSON.stringify({ contributions: { bootstrap } }), { mode: 0o600 });
    const result = await runCloudPrepare(f.params);
    expect(result.success).toBe(false); expect(f.apply).not.toHaveBeenCalled();
  });

  it('rechecks ownership before confirming the saved import without replacing its plan', async () => {
    const f = fixture(); const preview = await runCloudPrepare(f.params);
    expect(preview.success, String(preview.error)).toBe(true);
    f.setCondition('foreign');
    const confirmed = await runCloudPrepare({ ...f.params, confirm: true });
    expect(confirmed.success).toBe(false);
    expect(f.plan).toHaveBeenCalledOnce(); expect(f.apply).not.toHaveBeenCalled();
  });

});

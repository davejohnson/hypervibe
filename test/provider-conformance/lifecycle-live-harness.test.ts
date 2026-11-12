import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertFixtureHttpResponse, readFixtureJournal, runDisposableFixture, saveFixtureJournal, type FixtureJournal, type LifecycleFixtureDriver, type NativeFixtureResource } from './lifecycle-live-harness.js';
import { liveFixtureCoverage, liveFixtureProfiles, selectLiveFixtureProfile } from './live-fixture-profiles.js';
import { observeGcpFixtureResource, plannedGcpServiceIdentities, projectGcpFixtureState, projectRailwayFixtureInventory, readRailwayFixtureInventory, RAILWAY_FIXTURE_INVENTORY_QUERY, gcpFixtureConfigurationScope, assertGcpFixtureContinuationScope, assertGcpFixtureInventoryScope } from './fixture-native-inventory.js';
import { buildSchema, parse, validate } from 'graphql';
import { assertFixtureActionScope, assertFixtureContinuation, assertFixtureLifecycleConsent, assertFixtureTarget, fixturePreview, verifiedGcpFixtureCredentials } from './fixture-authorization.js';
import { hostingProviderContracts } from './provider-matrix.js';

const resource: NativeFixtureResource = { provider: 'gcp', type: 'google_cloud_run_v2_service', address: 'google_cloud_run_v2_service.web', id: 'projects/test-project/locations/us-central1/services/web' };
const fresh = (): FixtureJournal => ({ version: 1, profile: 'gcp-engine', project: 'hv-conformance-test', environment: 'fixture', phase: 'prepared', resources: [], checks: { created: false, updated: false, noop: false, absent: false } });
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(overrides: Partial<LifecycleFixtureDriver> = {}) {
  let current: NativeFixtureResource[] = [];
  const phases: string[] = [];
  const saved: FixtureJournal[] = [];
  const driver: LifecycleFixtureDriver = {
    inventory: vi.fn(async () => [...current]),
    converge: vi.fn(async (revision) => { phases.push(revision); current = revision === 'absent' ? [] : [resource]; }),
    assertNoop: vi.fn(async () => {}), verifyRunning: vi.fn(async () => {}), observe: vi.fn(async () => 'absent'), ...overrides,
  };
  return { driver, phases, saved, journal: fresh(), save: (journal: FixtureJournal) => saved.push(structuredClone(journal)) };
}

describe('disposable fixture lifecycle boundary', () => {
  it('never mutates an interrupted fixture when cleanup-only was not selected', async () => {
    const f = fixture(); f.journal.phase = 'creating'; f.journal.resources = [resource];
    await expect(runDisposableFixture(f)).rejects.toThrow(/cleanup-only/);
    expect(f.driver.converge).not.toHaveBeenCalled();
  });
  it('verifies create, noop, update, and every saved exact identity after teardown', async () => {
    const f = fixture();
    await runDisposableFixture(f);
    expect(f.phases).toEqual(['create', 'update', 'absent']);
    expect(f.driver.verifyRunning).toHaveBeenNthCalledWith(1, 'create');
    expect(f.driver.verifyRunning).toHaveBeenNthCalledWith(2, 'update');
    expect(f.driver.observe).toHaveBeenCalledWith(resource);
    expect(f.saved.find((snapshot) => snapshot.phase === 'cleaning')?.resources).toEqual([resource]);
    expect(f.journal).toMatchObject({ phase: 'cleaned', checks: { created: true, noop: true, updated: true, absent: true } });
  });

  it.each(['present', 'unknown'] as const)('does not treat empty bindings or an empty plan as native absence: %s', async (state) => {
    const f = fixture({ observe: vi.fn(async () => state) });
    await expect(runDisposableFixture(f)).rejects.toThrow(/cleanup is unverified/);
    expect(f.journal.phase).toBe('cleanup-required');
    expect(f.journal.resources).toEqual([resource]);
    expect(f.journal.checks.absent).toBe(false);
  });

  it('retains inventory and uses the same cleanup contract after an interrupted release', async () => {
    const controller = new AbortController();
    const f = fixture({ verifyRunning: vi.fn(async () => controller.abort()) });
    await expect(runDisposableFixture({ ...f, signal: controller.signal })).rejects.toThrow(/interrupted/);
    expect(f.phases).toEqual(['create', 'absent']);
    expect(f.journal.phase).toBe('cleaned');
    expect(f.driver.observe).toHaveBeenCalledWith(resource);
  });

  it('recovers after partial apply with durable exact inventory', async () => {
    let attempted = false;
    const f = fixture({ inventory: vi.fn(async () => attempted ? [resource] : []),
      converge: vi.fn(async (revision) => { attempted = revision !== 'absent'; if (attempted) throw new Error('simulated lost acknowledgement'); }) });
    await expect(runDisposableFixture(f)).rejects.toThrow('simulated lost acknowledgement');
    expect(f.journal).toMatchObject({ phase: 'cleaned', resources: [resource], checks: { created: false, absent: true } });
  });

  it('does not delete an existing environment when the empty-fixture preflight fails', async () => {
    const f = fixture({ inventory: vi.fn(async () => [resource]) });
    await expect(runDisposableFixture(f)).rejects.toThrow(/not empty/);
    expect(f.driver.converge).not.toHaveBeenCalled();
  });

  it('preserves recovery authority when inventory is unreadable instead of assuming it is empty', async () => {
    const f = fixture({ inventory: vi.fn(async () => { throw new Error('unreadable'); }) });
    f.journal.phase = 'cleanup-required'; f.journal.resources = [resource];
    await expect(runDisposableFixture({ ...f, cleanupOnly: true })).rejects.toThrow(/cleanup is unverified/);
    expect(f.driver.converge).not.toHaveBeenCalled();
    expect(f.journal.resources).toEqual([resource]);
  });

  it('resumes cleanup without recreating or releasing a fixture', async () => {
    const f = fixture(); f.journal.phase = 'cleanup-required'; f.journal.resources = [resource];
    await runDisposableFixture({ ...f, cleanupOnly: true });
    expect(f.phases).toEqual(['absent']);
    expect(f.driver.verifyRunning).not.toHaveBeenCalled();
  });

  it('persists only safe identity evidence and round trips the recovery journal', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'hv-fixture-journal-')); directories.push(directory);
    const file = path.join(directory, 'journal.json');
    const journal = fresh(); journal.resources = [{ ...resource, secret: 'must-not-persist' } as NativeFixtureResource];
    saveFixtureJournal(file, journal);
    expect(readFileSync(file, 'utf8')).not.toContain('must-not-persist');
    expect(readFixtureJournal(file).resources).toEqual([resource]);
  });

  it.each([{ status: 503, body: {} }, { status: 200, body: { ok: true } }, { status: 200, body: { service: 'hypervibe-provider-conformance', revision: 'stale' } }])('rejects a response that is not the expected running app: %j', ({ status, body }) => {
    expect(() => assertFixtureHttpResponse(status, body, 'create')).toThrow(/expected create/);
  });
});

describe('dedicated fixture authorization', () => {
  const target = { profile: 'gcp-engine', project: 'hypervibe-engine-pilot', internalProjectId: 'internal-id', nativeProjectId: 'native-project', region: 'us-central1', repository: 'owner/fixture' };
  it('requires the exact explicit prepared-platform marker, not a project-name heuristic', () => {
    const marker = { version: 1, purpose: 'disposable-provider-conformance', ...target };
    expect(() => assertFixtureTarget(marker, target)).not.toThrow();
    for (const field of Object.keys(target)) expect(() => assertFixtureTarget({ ...marker, [field]: 'different' }, target)).toThrow(/No provider mutation/);
    expect(() => assertFixtureTarget({ ...marker, purpose: 'application' }, target)).toThrow();
  });
  it('persists a safe preview and continues only its exact saved plan in the same environment', () => {
    const scope = { profile: 'gcp-engine', project: target.project, environment: 'fixture-unique' };
    const preview = fixturePreview({ data: { planId: 'saved-plan', actions: [{ id: 'create:web', type: 'create', resource: { kind: 'service', name: 'web', provider: 'cloudrun', secret: 'not-evidence' }, billable: true, metadata: { secret: 'not-evidence' } }] } }, scope);
    expect(JSON.stringify(preview)).not.toContain('not-evidence');
    expect(() => assertFixtureContinuation(preview, scope, 'saved-plan')).not.toThrow();
    expect(() => assertFixtureContinuation(preview, scope, undefined)).toThrow(/exact saved/);
    expect(() => assertFixtureContinuation(preview, scope, 'newer-plan')).toThrow();
    expect(() => assertFixtureContinuation(preview, { ...scope, environment: 'production' }, 'saved-plan')).toThrow();
  });
  it('does not claim Railway datastore coverage without declaring those resources', () => {
    const profile = liveFixtureProfiles.find((entry) => entry.id === 'railway')!;
    const fixture = hostingProviderContracts.find((entry) => entry.provider === 'railway')!.managedWorkflow!;
    expect(profile.capabilities).toContain('database:railway'); expect(fixture.database?.provider).toBe('railway');
    expect(profile.capabilities).toContain('cache:railway'); expect(fixture.cache?.provider).toBe('railway');
    expect(profile.capabilities).toContain('storage:railway'); expect(Object.values(fixture.storage ?? {}).every((item) => item.provider === 'railway')).toBe(true);
    expect(profile.capabilities).toContain('queue:railway'); expect(Object.keys(fixture.queues ?? {})).toEqual(['jobs']);
    expect(fixture.workflow).toBe('deploy-railway-production.yml');
  });
  it('blocks incidental origin/platform mutations from the Cloudflare-only fixture', () => {
    expect(() => assertFixtureActionScope([{ type: 'create', resource: { kind: 'load-balancer' } }, { type: 'noop', resource: { kind: 'service' } }], ['load-balancer'])).not.toThrow();
    for (const kind of ['service', 'project', 'environment', 'storage', undefined]) {
      expect(() => assertFixtureActionScope([{ type: 'destroy', resource: { kind } }], ['load-balancer'])).toThrow(/retained test-platform/);
    }
  });
  it('uses only an exact verified repository connection matching the native project and runtime identity', () => {
    const expected = { repository: 'owner/fixture', nativeProjectId: 'fixture-project', runtimeServiceAccountEmail: 'runtime@fixture-project.iam.gserviceaccount.com' };
    const saved = { provider: 'cloudrun', scope: expected.repository, status: 'verified', credentials_encrypted: 'ciphertext' };
    const decoded = { projectId: expected.nativeProjectId, runtimeServiceAccountEmail: expected.runtimeServiceAccountEmail, credentials: 'private-input' };
    expect(verifiedGcpFixtureCredentials(saved, expected, () => decoded)).toEqual(decoded);
    for (const invalid of [{ ...saved, scope: null }, { ...saved, scope: 'other/repo' }, { ...saved, status: 'pending' }, null]) {
      const decrypt = vi.fn(() => decoded);
      expect(() => verifiedGcpFixtureCredentials(invalid, expected, decrypt)).toThrow(/repository-scoped/);
      expect(decrypt).not.toHaveBeenCalled();
    }
    expect(() => verifiedGcpFixtureCredentials(saved, expected, () => ({ ...decoded, projectId: 'another-project' }))).toThrow(/does not match/);
    expect(() => verifiedGcpFixtureCredentials(saved, expected, () => ({ ...decoded, runtimeServiceAccountEmail: 'different' }))).toThrow(/does not match/);
  });
  it('requires separate consent for the bounded lifecycle, beyond an initial plan ID', () => {
    expect(() => assertFixtureLifecycleConsent(undefined)).toThrow(/bounded create/);
    expect(() => assertFixtureLifecycleConsent('1')).not.toThrow();
  });
  it('rejects later native addresses, identity changes, replacements and unrelated operations before apply', () => {
    const configuration = { files: { 'fixture.tf.json': { resource: {
      google_cloud_run_v2_service: { web: { project: 'test-project', location: 'us-central1', name: 'web', labels: { 'managed-by': 'hypervibe', 'hv-service': 'web' } } },
      google_cloud_run_v2_service_iam_member: { web_public: { project: 'test-project', location: 'us-central1', name: '${google_cloud_run_v2_service.web.name}', role: 'roles/run.invoker', member: 'allUsers' } },
    } } } };
    const initial = gcpFixtureConfigurationScope(configuration, 'test-project', 'us-central1');
    expect(() => assertGcpFixtureInventoryScope([resource], initial)).not.toThrow();
    expect(() => assertGcpFixtureInventoryScope([{ ...resource, id: 'projects/test-project/locations/us-central1/services/other' }], initial)).toThrow(/identity differs/);
    expect(() => assertGcpFixtureInventoryScope([{ ...resource, address: 'google_cloud_run_v2_service.surprise' }], initial)).toThrow(/identity differs/);
    const action = { id: 'service:web', type: 'update', resource: { kind: 'service', name: 'web', provider: 'gcp' }, metadata: { engineSegment: { addresses: initial.map((entry) => entry.address) } } };
    const scope = { initial, current: initial, actions: [action], stage: 'update' as const, recordedAddresses: initial.map((entry) => entry.address) };
    expect(() => assertGcpFixtureContinuationScope(scope)).not.toThrow();
    expect(() => assertGcpFixtureContinuationScope({ ...scope, current: [...initial, { address: 'google_cloud_run_v2_service.surprise', identity: 'new' }] })).toThrow(/expands/);
    expect(() => assertGcpFixtureContinuationScope({ ...scope, current: initial.map((entry) => ({ ...entry, identity: 'changed' })) })).toThrow(/replaces/);
    for (const type of ['create', 'replace', 'destroy']) expect(() => assertGcpFixtureContinuationScope({ ...scope, actions: [{ ...action, type }] })).toThrow(/unapproved/);
    expect(() => assertGcpFixtureContinuationScope({ ...scope, actions: [{ ...action, metadata: { engineSegment: { addresses: ['google_cloud_run_v2_service.surprise'] } } }] })).toThrow(/unapproved/);
    expect(() => assertGcpFixtureContinuationScope({ ...scope, actions: [{ ...action, id: 'secret:new' }] })).toThrow(/unapproved/);
    expect(() => assertGcpFixtureContinuationScope({ ...scope, current: [], stage: 'absent', actions: [{ ...action, type: 'destroy' }] })).not.toThrow();
    expect(() => assertGcpFixtureContinuationScope({ ...scope, current: [], stage: 'absent', actions: [{ ...action, type: 'destroy' }], recordedAddresses: [] })).toThrow(/unapproved/);
  });
});

describe('native absence readers', () => {
  it('projects only explicitly allowed engine identities from secret-bearing state', () => {
    const state = { values: { root_module: { resources: [{ ...resource, mode: 'managed', values: { id: resource.id, password: 'private-value', env: [{ value: 'private-value' }] } }] } } };
    expect(projectGcpFixtureState(state)).toEqual([resource]);
    expect(() => projectGcpFixtureState({})).toThrow(/incomplete/);
    expect(() => projectGcpFixtureState({ values: { root_module: { resources: [{ type: 'unknown_resource' }] } } })).toThrow(/no exact native absence reader/);
  });

  it.each([404, 403, 500, 200])('accepts only provider-confirmed 404 as absence: HTTP %s', async (status) => {
    const transport = vi.fn(async () => Response.json(status === 200 ? { name: resource.id } : { error: { code: status } }, { status }));
    expect(await observeGcpFixtureResource(resource, 'private-token', { projectId: 'test-project', region: 'us-central1' }, transport)).toBe(status === 404 ? 'absent' : status === 200 ? 'present' : 'unknown');
    expect(transport.mock.calls[0][0]).toBe(`https://run.googleapis.com/v2/${resource.id}`);
  });

  it('rejects scope drift before contacting the provider and does not mistake null success for absence', async () => {
    const transport = vi.fn(async () => Response.json(null));
    expect(await observeGcpFixtureResource(resource, 'token', { projectId: 'other-project', region: 'us-central1' }, transport)).toBe('unknown');
    expect(transport).not.toHaveBeenCalled();
    expect(await observeGcpFixtureResource(resource, 'token', { projectId: 'test-project', region: 'us-central1' }, transport)).toBe('unknown');
  });

  it('persists deterministic reviewed candidates without inferring ownership from a name search', () => {
    const configuration = { files: { 'cloudrun.tf.json': { resource: { google_cloud_run_v2_service: { web: { project: 'test-project', location: 'us-central1', name: 'web', labels: { 'managed-by': 'hypervibe', 'hv-service': 'web' } } } } } } };
    expect(plannedGcpServiceIdentities(configuration, 'test-project', 'us-central1')).toEqual([resource]);
    expect(() => plannedGcpServiceIdentities(configuration, 'other-project', 'us-central1')).toThrow(/different/);
    const expanded = structuredClone(configuration);
    Object.assign(expanded.files['cloudrun.tf.json'].resource.google_cloud_run_v2_service, { surprise: { ...expanded.files['cloudrun.tf.json'].resource.google_cloud_run_v2_service.web, name: 'surprise' } });
    expect(() => plannedGcpServiceIdentities(expanded, 'test-project', 'us-central1')).toThrow(/one web service/);
  });

  it('validates Railway diagnostic queries against the pinned official schema', () => {
    const schema = buildSchema(readFileSync(new URL('../provider-contracts/railway/schema.graphql', import.meta.url), 'utf8'));
    expect(validate(schema, parse(RAILWAY_FIXTURE_INVENTORY_QUERY))).toEqual([]);
  });

  it('requires complete exact Railway project inventory, including volumes and buckets', async () => {
    const page = (id: string) => ({ pageInfo: { hasNextPage: false }, edges: [{ node: { id } }] });
    const data = { data: { project: { id: 'native-project', services: page('service-1'), volumes: page('volume-1'), buckets: page('bucket-1') } } };
    const transport = vi.fn(async () => Response.json(data));
    const inventory = await readRailwayFixtureInventory('private-token', 'native-project', transport);
    expect(inventory.map((entry) => entry.id)).toEqual(['service-1', 'volume-1', 'bucket-1']);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).variables).toEqual({ projectId: 'native-project' });
    expect(() => projectRailwayFixtureInventory({ data: { project: null } }, 'native-project')).toThrow();
    data.data.project.volumes.pageInfo.hasNextPage = true;
    expect(() => projectRailwayFixtureInventory(data, 'native-project')).toThrow(/partial/);
  });
});

describe('live fixture coverage contract', () => {
  it('requires an automated profile for every nonplanned provider capability', () => {
    const coverage = liveFixtureCoverage();
    expect(coverage.filter((entry) => entry.status === 'requires-live-proof').every((entry) => entry.profile)).toBe(true);
    for (const profile of liveFixtureProfiles) expect(readFileSync(profile.runner, 'utf8').length).toBeGreaterThan(0);
    expect(coverage.filter((entry) => /ecs|azure|rds/.test(entry.capability)).every((entry) => entry.status === 'unavailable')).toBe(true);
    expect(selectLiveFixtureProfile('gcp-engine').path).toBe('engine');
    expect(() => selectLiveFixtureProfile('ecs')).toThrow(/unavailable/);
  });
});

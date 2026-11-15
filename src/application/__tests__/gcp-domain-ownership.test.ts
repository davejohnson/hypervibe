import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineContext } from '../infrastructure-engine.js';
import type { DomainMappingObservation } from '../infrastructure-engine-domain.js';
import { verifyGcpDomainEngineOwnership } from '../gcp-domain-ownership.js';

const mocks = vi.hoisted(() => ({ inspectState: vi.fn(), install: vi.fn() }));
vi.mock('../../adapters/engine/opentofu/engine.js', () => ({ OpenTofuEngine: class { inspectState = mocks.inspectState; } }));
vi.mock('../../adapters/engine/opentofu/install.js', () => ({ ensureEngineBinary: mocks.install, enginePluginCacheDir: () => '/synthetic/plugins' }));
vi.mock('../../adapters/secrets/secret-store.js', () => ({ getSecretStore: () => ({}) }));

// Reconstructed from pinned Google 8.9.0 schema/source: metadata and spec are
// singleton blocks; state namespace is normalized to the configured project ID.
const domain = 'app.example.com';
const nativeId = 'locations/us-central1/namespaces/example-project/domainmappings/app.example.com';
const address = 'google_cloud_run_domain_mapping.domain_app_example_com';
const context = { environment: { id: 'environment-one', platformBindings: {} }, gcpProjectId: 'example-project', region: 'us-central1',
  auth: { env: {}, redact: [] }, state: { provider: 'gcp', projectId: 'project-one', environmentId: 'environment-one', partition: 'environment' } } as unknown as EngineContext;
const live: Extract<DomainMappingObservation, { state: 'present' }> = { state: 'present', uid: 'owned-immutable-uid', namespace: '123456789',
  domain, serviceName: 'web-production', ready: false, certificate: 'CertificatePending', sourceFingerprint: 'fixture-fingerprint' };
const resource = () => ({ mode: 'managed', type: 'google_cloud_run_domain_mapping', address, values: { id: nativeId,
  metadata: [{ namespace: 'example-project', uid: live.uid }], spec: [{ route_name: live.serviceName }], sensitive_other_value: 'private-state-value' } });
function state(value: unknown) {
  mocks.inspectState.mockImplementation(async ({ project }: { project: (value: unknown) => unknown }) => ({ ok: true, present: true, value: project(value) }));
}
function owned(value: unknown = resource()) { state({ format_version: '1.0', values: { root_module: { resources: [value] } } }); }
beforeEach(() => { mocks.inspectState.mockReset(); mocks.install.mockResolvedValue({ ok: true, binary: '/synthetic/tofu' }); owned(); });

describe('Cloud Run engine mapping ownership', () => {
  it('accepts interrupted creation with exact state UID even before the local domain receipt exists', async () => {
    expect(await verifyGcpDomainEngineOwnership(context, domain, live)).toEqual({ ready: true });
    expect(mocks.inspectState).toHaveBeenCalledWith(expect.objectContaining({ state: context.state, configuration: { files: {}, resources: {} } }));
  });
  it('rejects a same-name same-route mapping when engine state is absent', async () => {
    mocks.inspectState.mockResolvedValue({ ok: true, present: false });
    expect((await verifyGcpDomainEngineOwnership(context, domain, live)).ready).toBe(false);
  });
  it.each(['uid', 'id', 'namespace', 'route', 'address', 'tainted'] as const)('rejects a different or unsafe %s', async field => {
    const item = resource();
    if (field === 'uid') item.values.metadata[0]!.uid = 'replacement-uid';
    if (field === 'id') item.values.id = nativeId.replace('example-project', 'foreign-project');
    if (field === 'namespace') item.values.metadata[0]!.namespace = 'foreign-project';
    if (field === 'route') item.values.spec[0]!.route_name = 'other-service';
    if (field === 'address') item.address = 'google_cloud_run_domain_mapping.external';
    owned(field === 'tainted' ? { ...item, tainted: true } : item);
    expect((await verifyGcpDomainEngineOwnership(context, domain, live)).ready).toBe(false);
  });
  it('blocks partial state that has a native ID but no immutable UID', async () => {
    const item = resource(); item.values.metadata[0]!.uid = ''; owned(item);
    expect((await verifyGcpDomainEngineOwnership(context, domain, live)).ready).toBe(false);
  });
  it.each([{}, { format_version: '1.0' }, { format_version: '1.0', values: { root_module: { resources: {} } } }])('blocks incomplete state %#', async raw => {
    state(raw); expect((await verifyGcpDomainEngineOwnership(context, domain, live)).ready).toBe(false);
  });
  it('never emits raw state or engine diagnostics', async () => {
    mocks.inspectState.mockResolvedValue({ ok: false, error: 'private-state-value' });
    expect(JSON.stringify(await verifyGcpDomainEngineOwnership(context, domain, live))).not.toContain('private-state-value');
  });
  it('does not inspect private state for an absent mapping', async () => {
    expect((await verifyGcpDomainEngineOwnership(context, domain, { state: 'absent' })).ready).toBe(false);
    expect(mocks.inspectState).not.toHaveBeenCalled();
  });
});

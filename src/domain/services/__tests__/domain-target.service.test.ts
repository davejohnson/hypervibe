import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../adapter.factory.js';
import { observeDomainTarget, registerEngineWebServiceResolver } from '../domain-target.service.js';

describe('provider-observed traffic target readiness', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function setup() {
    const source: any = { id: 'source', projectId: 'project', name: 'production', platformBindings: { provider: 'railway', projectId: 'old-project', environmentId: 'old-env', services: { web: { serviceId: 'old-web' } } } };
    const target: any = { id: 'target', projectId: 'project', name: 'next', platformBindings: { provider: 'railway', projectId: 'new-project', environmentId: 'new-env', providerScope: { projectId: 'new-project', location: 'new-env' }, services: { web: { serviceId: 'new-web', url: 'https://new-web.up.railway.app' } } } };
    const targetSpec: any = { hosting: { provider: 'railway', region: 'new-env' }, services: { web: { workloadKind: 'web', public: true, healthCheckPath: '/healthz' } } };
    const environmentSpec: any = { hosting: { provider: 'railway' }, domain: 'app.example.com', domainTarget: { environment: 'next', service: 'web' } };
    const project: any = { id: 'project', name: 'app' };
    vi.spyOn(SpecStore.prototype, 'getForInspection').mockReturnValue({ spec: { environments: { next: targetSpec } }, revision: 1 } as any);
    vi.spyOn(EnvironmentRepository.prototype, 'findByProjectAndName').mockReturnValue(target);
    const observed: any = { provider: 'railway', projectExists: true, projectId: 'new-project', environmentId: 'new-env', completeness: { project: 'complete', environment: 'complete', services: 'complete' }, services: [{ name: 'web', externalId: 'new-web', workloadKind: 'web', url: 'https://new-web.up.railway.app', status: 'running', config: { public: true }, customDomains: [] }], partial: false };
    const adapter = { name: 'railway', capabilities: { supportsObserve: true }, configureTarget: vi.fn(), observe: vi.fn(async () => observed) };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter } as any);
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    return { params: { project, environment: source, environmentSpec }, target, targetSpec, observed, fetchMock };
  }

  it('automatically resolves flagless GCP targets through the engine observer', async () => {
    const fixture = setup();
    fixture.targetSpec.hosting = { provider: 'cloudrun', region: 'us-central1' };
    const resolve = vi.fn(async () => ({ provider: 'cloudrun', providerProjectId: 'gcp-project',
      providerEnvironmentId: 'us-central1', serviceId: 'projects/gcp-project/locations/us-central1/services/web',
      resourceUid: 'exact-live-uid', url: 'https://web.run.app' }));
    registerEngineWebServiceResolver(resolve);
    const result = await observeDomainTarget(fixture.params);
    expect(result).toMatchObject({ state: 'ready', target: { origin: 'https://web.run.app' } });
    expect(resolve).toHaveBeenCalledWith({ project: fixture.params.project, environment: fixture.target,
      environmentName: 'next', service: 'web' });
    expect(adapterFactory.getProviderAdapter).not.toHaveBeenCalled();
    expect(fixture.fetchMock).toHaveBeenCalledWith('https://web.run.app/healthz', expect.objectContaining({ redirect: 'manual' }));
  });

  it('keeps unknown engine target evidence unknown without a legacy fallback', async () => {
    const fixture = setup();
    fixture.targetSpec.hosting = { provider: 'cloudrun' };
    registerEngineWebServiceResolver(async () => ({ unknown: 'Native service identity is not verified.' }));
    expect(await observeDomainTarget(fixture.params)).toMatchObject({ state: 'unknown', reason: 'Native service identity is not verified.' });
    expect(adapterFactory.getProviderAdapter).not.toHaveBeenCalled();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it('binds a running existing web service and probes its provider URL without following redirects', async () => {
    const fixture = setup();
    const result = await observeDomainTarget(fixture.params);
    expect(result).toMatchObject({ state: 'ready', target: { origin: 'https://new-web.up.railway.app', targetFingerprint: expect.any(String) } });
    expect(fixture.fetchMock).toHaveBeenCalledWith('https://new-web.up.railway.app/healthz', expect.objectContaining({ redirect: 'manual' }));
    const fingerprint = result.target?.targetFingerprint;
    fixture.target.platformBindings.environmentId = 'another-region';
    const changed = await observeDomainTarget(fixture.params);
    expect(changed.state).toBe('unknown');
    expect(changed.target?.targetFingerprint).not.toBe(fingerprint);
  });

  it.each(['scope', 'service', 'unknown', 'private', 'custom-hostname', 'unhealthy', 'chain'])('blocks %s targets without establishing ready state', async kind => {
    const fixture = setup();
    if (kind === 'scope') fixture.observed.projectId = 'different-project';
    if (kind === 'service') fixture.observed.services[0].externalId = 'replacement';
    if (kind === 'unknown') fixture.observed.completeness.services = 'unknown';
    if (kind === 'private') fixture.observed.services[0].config.public = false;
    if (kind === 'custom-hostname') fixture.observed.services[0].url = 'https://app.example.com';
    if (kind === 'unhealthy') fixture.fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    if (kind === 'chain') fixture.targetSpec.domainTarget = { environment: 'third', service: 'web' };
    expect((await observeDomainTarget(fixture.params)).state).toBe('unknown');
    if (kind !== 'unhealthy') expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it('pins the live service lifetime even when an older binding has no saved UID', async () => {
    const fixture = setup();
    fixture.observed.services[0].resourceUid = 'live-uid-one';
    const first = await observeDomainTarget(fixture.params);
    fixture.observed.services[0].resourceUid = 'live-uid-two';
    const second = await observeDomainTarget(fixture.params);
    expect(first.state).toBe('ready');
    expect(second.state).toBe('ready');
    expect(second.target?.targetFingerprint).not.toBe(first.target?.targetFingerprint);
  });

  it.each(['replacement-uid', undefined])('rejects a saved UID without matching live lifetime evidence (%s)', async liveUid => {
    const fixture = setup();
    fixture.target.platformBindings.services.web.resourceUid = 'original-uid';
    fixture.observed.services[0].resourceUid = liveUid;
    expect((await observeDomainTarget(fixture.params)).state).toBe('unknown');
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });
});

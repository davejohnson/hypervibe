import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectCommittedBindingsV1,
  inspectHostedEnvironmentV1,
  type CommittedSpecInspectionInputV1,
} from '../../hosted.js';
import { railwayHttpFixture, projectId, stagingId, productionId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';

const revision = 'a'.repeat(40);
const now = () => new Date('2026-09-22T10:00:00Z');
function source(document: unknown): CommittedSpecInspectionInputV1 {
  const content = new TextEncoder().encode(JSON.stringify(document));
  return { schemaVersion: 1, provider: 'github', repository: {
    id: '123', path: 'acme/demo', remoteIdentity: 'github.com/acme/demo',
  }, revision, content, contentSha256: createHash('sha256').update(content).digest('hex') };
}
function spec(services: Record<string, unknown> = { web: { public: false, startCommand: 'node server.js' } }) {
  return source({ version: 1, project: 'demo', gitRemoteUrl: 'https://github.com/acme/demo',
    environments: { staging: { hosting: { provider: 'railway' }, services, envVars: { FEATURE: 'private-feature-value' } } } });
}
function bindings(serviceId = 'staging-web') {
  return source({ version: 1, project: 'demo', environments: { staging: { platformBindings: {
    provider: 'railway', projectId, environmentId: stagingId,
    services: { web: { serviceId } }, databaseUrl: 'postgres://private-user:private-password@db/db',
  } } } });
}
function input() {
  return { schemaVersion: 1 as const, source: spec(), environment: 'staging', bindings: bindings(),
    connection: { provider: 'railway', scope: { projectId, environmentId: stagingId },
      credentials: { apiToken: 'synthetic-contract-token', workspaceId: 'workspace-contract' } } };
}

afterEach(() => vi.unstubAllGlobals());

describe('hosted desired/current inspection v1', () => {
  it.each(['domains', 'details', 'null-instance', 'omitted-startCommand'])('does not match private configuration when a selected response field is missing (%s)', async (missing) => {
    const fixture = await railwayHttpFixture();
    const service = fixture.addService('staging-web', 'web', stagingId);
    Object.assign(service.instances.get(stagingId)!, { startCommand: 'node server.js' });
    fixture.variables.set(`staging-web/${stagingId}`, { FEATURE: 'private-feature-value' });
    // Execute the query against the independent official schema first, then
    // simulate a truncated or inconsistent successful response on the wire.
    const schemaFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await schemaFetch(...args);
      const body = await response.json() as { data: {
        project: { services: { edges: Array<{ node: { serviceInstances: { edges: Array<{ node: Record<string, unknown> }> } } }> } };
        serviceInstance: Record<string, unknown> | null;
      } };
      const query = JSON.parse(String(args[1]?.body)).query as string;
      if (missing === 'domains' && query.includes('GetProjectDetails')) {
        for (const edge of body.data.project.services.edges) {
          for (const instance of edge.node.serviceInstances.edges) delete instance.node.domains;
        }
      }
      if (query.includes('GetServiceInstance')) {
        if (missing === 'details') body.data.serviceInstance = {};
        if (missing === 'null-instance') body.data.serviceInstance = null;
        if (missing === 'omitted-startCommand') delete body.data.serviceInstance!.startCommand;
      }
      return Response.json(body);
    });
    const report = await inspectHostedEnvironmentV1(input(), { now });
    expect(report.resources.find(resource => resource.id === 'service:web')?.status).toBe('unknown');
    expect(report.coverage.status).not.toBe('complete');
    expect(fixture.contractErrors).toEqual([]);
    expect(fixture.mutations).toEqual([]);
  });

  it('reads exact committed binding provenance in memory and exports only safe identities', () => {
    const receipt = inspectCommittedBindingsV1(bindings());
    expect(receipt.source).toMatchObject({ revision, path: '.hypervibe/bindings.json' });
    expect(receipt.environments.staging).toEqual({ provider: 'railway', projectId, environmentId: stagingId,
      services: { web: { serviceId: 'staging-web' } } });
    expect(JSON.stringify(receipt)).not.toContain('private-password');
  });

  it('compares provider configuration through the serialized official GraphQL schema without mutations', async () => {
    const fixture = await railwayHttpFixture();
    const service = fixture.addService('staging-web', 'web', stagingId);
    Object.assign(service.instances.get(stagingId)!, { startCommand: 'node old-server.js' });
    fixture.variables.set(`staging-web/${stagingId}`, { FEATURE: 'private-feature-value' });
    const report = await inspectHostedEnvironmentV1(input(), { now });
    expect(report.source.revision).toBe(revision);
    expect(report.scope).toEqual({ provider: 'railway', projectId, environmentId: stagingId });
    expect(report.resources.find(resource => resource.id === 'service:web')).toMatchObject({
      status: 'drifted', desired: { exists: true }, current: { exists: true },
      fields: expect.arrayContaining([{ field: 'startCommand', status: 'drifted', desired: 'configured', current: 'configured' }]),
    });
    expect(report.observedAt).not.toBeNull();
    const serialized = JSON.stringify(report);
    for (const secret of ['synthetic-contract-token', 'node old-server.js', 'node server.js', 'private-feature-value', 'private-password', 'envVarHashes']) {
      expect(serialized).not.toContain(secret);
    }
    expect(fixture.contractErrors).toEqual([]);
    expect(fixture.mutations).toEqual([]);
    expect(fixture.requests.some(request => request.variables.environmentId === productionId)).toBe(false);
  });

  it('reports matching managed configuration without treating runtime failure as infrastructure drift', async () => {
    const fixture = await railwayHttpFixture();
    const service = fixture.addService('staging-web', 'web', stagingId);
    Object.assign(service.instances.get(stagingId)!, { startCommand: 'node server.js', latestDeployment: { id: 'failed-run', status: 'FAILED' } });
    fixture.variables.set(`staging-web/${stagingId}`, { FEATURE: 'private-feature-value' });
    const report = await inspectHostedEnvironmentV1(input(), { now });
    expect(report.resources.find(resource => resource.id === 'service:web')?.status).toBe('matching');
    expect(report.coverage.unsupportedCapabilities).toContain('runtime-health');
  });

  it('keeps an unbound desired resource unknown instead of adopting its name match', async () => {
    const fixture = await railwayHttpFixture();
    fixture.addService('other-web', 'web', stagingId);
    const request = input();
    request.bindings = source({ version: 1, project: 'demo', environments: { staging: { platformBindings: {
      provider: 'railway', projectId, environmentId: stagingId, services: {},
    } } } });
    const report = await inspectHostedEnvironmentV1(request, { now });
    expect(report.resources.find(resource => resource.id === 'service:web')).toMatchObject({ status: 'unknown', reasonCode: 'binding_missing' });
    expect(report.resources.find(resource => resource.externalId === 'other-web')).toMatchObject({ status: 'unmanaged' });
    expect(fixture.mutations).toEqual([]);
  });

  it('does not contact a provider without bindings or with a contradictory connection scope', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const request = input();
    const { bindings: omitted, ...unbound } = request;
    void omitted;
    expect((await inspectHostedEnvironmentV1(unbound, { now })).resources[0].status).toBe('unknown');
    request.connection.scope.environmentId = productionId;
    expect((await inspectHostedEnvironmentV1(request, { now })).resources[0].reasonCode).toBe('scope_mismatch');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects mismatched committed binding revision or digest before provider reads', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const request = input(); request.bindings.revision = 'b'.repeat(40);
    await expect(inspectHostedEnvironmentV1(request, { now })).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
    request.bindings.revision = revision; request.bindings.contentSha256 = '0'.repeat(64);
    await expect(inspectHostedEnvironmentV1(request, { now })).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks declarations outside supported observation as unsupported, never matching the environment', async () => {
    const request = input();
    request.source = source({ version: 1, project: 'demo', gitRemoteUrl: 'https://github.com/acme/demo',
      environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} }, database: { provider: 'supabase' } } } });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const report = await inspectHostedEnvironmentV1(request, { now });
    expect(report.coverage.status).toBe('unsupported');
    expect(report.resources.every(resource => resource.status === 'unsupported')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts the web project-token credential through the real provider boundary', async () => {
    const fixture = await railwayHttpFixture({ projectTokenScope: { projectId, environmentId: stagingId } });
    const service = fixture.addService('staging-web', 'web', stagingId);
    Object.assign(service.instances.get(stagingId)!, { startCommand: 'node server.js' });
    fixture.variables.set(`staging-web/${stagingId}`, { FEATURE: 'private-feature-value' });
    const request = { ...input(), connection: { ...input().connection, credentials: { projectToken: 'synthetic-project-token' } } };
    const report = await inspectHostedEnvironmentV1(request, { now });
    expect(report.resources.find(resource => resource.id === 'service:web')?.status).toBe('matching');
    expect(fixture.requests[0].query).toContain('projectToken');
    expect(fixture.mutations).toEqual([]);
  });

  it('reports a bound resource missing only after a complete exact-scope inventory', async () => {
    const fixture = await railwayHttpFixture();
    const report = await inspectHostedEnvironmentV1(input(), { now });
    expect(report.resources.find(resource => resource.id === 'service:web')).toMatchObject({
      status: 'missing', desired: { exists: true }, current: { exists: false },
      fields: expect.arrayContaining([expect.objectContaining({ field: 'startCommand', status: 'drifted' })]),
    });
    expect(fixture.mutations).toEqual([]);
  });

  it('does not lose a removed but still bound live service from the desired/current comparison', async () => {
    const fixture = await railwayHttpFixture(); fixture.addService('staging-web', 'web', stagingId);
    const request = input(); request.source = spec({});
    const report = await inspectHostedEnvironmentV1(request, { now });
    expect(report.resources.find(resource => resource.externalId === 'staging-web')).toMatchObject({
      status: 'drifted', desired: { exists: false }, current: { exists: true }, reasonCode: 'undesired_managed_resource',
    });
  });

  it('keeps failed variable reads unknown and never returns echoed provider secrets', async () => {
    const fixture = await railwayHttpFixture({ responseOverride: request => request.query.includes('GetVariables')
      ? Response.json({ errors: [{ message: 'private-provider-password' }] }, { status: 403 }) : undefined });
    fixture.addService('staging-web', 'web', stagingId);
    const report = await inspectHostedEnvironmentV1(input(), { now });
    expect(report.resources.find(resource => resource.id === 'service:web')?.status).toBe('unknown');
    expect(report.coverage.status).toBe('partial');
    expect(JSON.stringify(report)).not.toContain('private-provider-password');
  });

  it('bounds declared output and provider work and never upgrades omitted scope to complete', async () => {
    const fixture = await railwayHttpFixture();
    const report = await inspectHostedEnvironmentV1({ ...input(), limits: { maxResources: 1 } }, { now });
    expect(report.resources).toHaveLength(1);
    expect(report.coverage.omittedResources).toBe(1);
    expect(report.coverage.status).not.toBe('complete');
    expect(fixture.requests.some(request => request.query.includes('GetServiceInstanceDetails'))).toBe(false);
  });

  it('redacts exact credentials even if provider inventory echoes them as an innocent label', async () => {
    const fixture = await railwayHttpFixture();
    fixture.addService('echo-service', 'synthetic-contract-token', stagingId);
    const report = await inspectHostedEnvironmentV1(input(), { now });
    expect(JSON.stringify(report)).not.toContain('synthetic-contract-token');
  });

  it.each([true, false])('compares explicitly retired variable presence (present=%s)', async (present) => {
    const fixture = await railwayHttpFixture();
    const service = fixture.addService('staging-web', 'web', stagingId);
    Object.assign(service.instances.get(stagingId)!, { startCommand: 'node server.js' });
    fixture.variables.set(`staging-web/${stagingId}`, { FEATURE: 'private-feature-value',
      ...(present ? { RETIRED_CONFIG: 'private-retired-value' } : {}) });
    const request = input();
    const document = JSON.parse(new TextDecoder().decode(request.source.content));
    document.environments.staging.removeEnvVars = ['RETIRED_CONFIG'];
    request.source = source(document);
    const report = await inspectHostedEnvironmentV1(request, { now });
    expect(report.resources.find(resource => resource.id === 'service:web')).toMatchObject({
      status: present ? 'drifted' : 'matching',
      fields: expect.arrayContaining([{ field: 'env:RETIRED_CONFIG', status: present ? 'drifted' : 'matching',
        desired: 'not configured', current: present ? 'configured' : 'not configured' }]),
    });
    expect(JSON.stringify(report)).not.toContain('private-retired-value');
    expect(fixture.mutations).toEqual([]);
  });

  it('retains explicit incomplete coverage for declared runtime, deployment, local files and migration policy', async () => {
    const fixture = await railwayHttpFixture(); fixture.addService('staging-web', 'web', stagingId);
    const request = input();
    const document = JSON.parse(new TextDecoder().decode(request.source.content));
    document.runtime = { kind: 'node', version: '24' };
    Object.assign(document.environments.staging, {
      deploy: { strategy: 'manual' }, envFile: { mode: 'explicit', include: ['EXTERNAL_CONFIG'] },
      migrations: { mode: 'tool', command: 'node migrate.js' },
    });
    request.source = source(document);
    const report = await inspectHostedEnvironmentV1(request, { now });
    expect(report.coverage.status).toBe('partial');
    expect(report.resources.find(resource => resource.kind === 'environment')?.fields).toEqual(expect.arrayContaining(
      ['runtime', 'deploy', 'envFile', 'migrations'].map(field => ({ field, status: 'unsupported', desired: 'configured', current: null }))
    ));
  });
});

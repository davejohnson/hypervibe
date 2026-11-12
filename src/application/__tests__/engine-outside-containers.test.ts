import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { gcpSecretStore, planInfrastructureEngine } from '../infrastructure-engine.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import * as install from '../../adapters/engine/opentofu/install.js';
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-outside-containers-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'outside-containers', defaultPlatform: 'cloudrun' });
  project.gitRemoteUrl = 'https://github.com/example/outside-containers';
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  const labels = { 'managed-by': 'hypervibe', 'hv-environment': environment.id };
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'cloudrun', scope: 'example/outside-containers', credentialsEncrypted: getSecretStore().encryptObject({
    projectId: 'demo-project', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({ type: 'service_account', private_key: 'test-private-key', client_email: 'deploy@demo-project.iam.gserviceaccount.com' }),
  }) });
  connections.updateStatus(connection.id, 'verified');
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
  }, secrets: { API_KEY: { ownership: 'delegated', principal: 'app-owner', environments: ['staging'] } } });
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('test-token');
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/not-executed' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(directory);
  const configurations: EngineConfiguration[] = [];
  const enginePlan = vi.spyOn(OpenTofuEngine.prototype, 'plan').mockImplementation(async ({ configuration }) => {
    configurations.push(configuration);
    const segment = { id: 'engine-segment', engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
    return { ok: true, segmentId: segment.id, segment, planFile: '/not-executed', blockers: [], unmanagedDeletes: [],
      actions: Object.entries(configuration.resources).filter(([address]) => address.startsWith('google_secret_manager_secret.') || address.startsWith('google_cloud_run_v2_service.'))
        .map(([address, resource]) => ({ id: resource.actionId, type: 'create' as const, resource: { kind: resource.kind, name: resource.name, provider: 'gcp' }, verified: true, reason: 'engine preview', metadata: { engineSegment: { ...segment, addresses: [address] } } })),
    };
  });
  let state: 'absent' | 'unknown' | 'foreign' | 'empty' | 'ready' = 'absent';
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method) throw new Error('Plan and collection readiness must not mutate the provider.');
    if (url.includes('/secrets?')) return Response.json({ secrets: [] });
    if (state === 'unknown') return new Response('', { status: 403 });
    if (state === 'absent') return new Response('', { status: 404 });
    if (url.endsWith('/versions/latest')) return state === 'ready'
      ? Response.json({ state: 'ENABLED', name: 'projects/demo-project/secrets/hv-staging-api-key/versions/7' })
      : new Response('', { status: 404 });
    return Response.json({ labels: state === 'foreign' ? { ...labels, 'hv-environment': 'other-environment' } : labels });
  });
  vi.stubGlobal('fetch', fetch);
  return { ctx, project, environment, spec, configurations, enginePlan, fetch, setState: (value: typeof state) => { state = value; } };
}

describe('outside keys under the engine container boundary', () => {
  it('plans containers before collecting values, then wires only the exact saved version', async () => {
    const f = fixture();
    const params = { project: f.project, spec: f.spec, specRevision: 1, environmentName: 'staging' };
    const first = await planInfrastructureEngine(f.ctx, params);
    expect(first).not.toHaveProperty('blocked');
    if ('blocked' in first) throw new Error(first.blocked.join('; '));
    expect(first.actions).toContainEqual(expect.objectContaining({ id: 'secret-container:hv-staging-api-key' }));
    expect(first.actions.find(action => action.id === 'secret:API_KEY')).toBeUndefined();
    expect(JSON.stringify(f.configurations[0]!.files['cloudrun.tf.json'])).not.toContain('secret_key_ref');
    f.setState('empty');
    expect(await planInfrastructureEngine(f.ctx, params)).toMatchObject({ blocked: [expect.stringContaining('hv_secrets')], missingOutsideKeys: ['API_KEY'] });
    expect(f.enginePlan).toHaveBeenCalledOnce();
    f.setState('ready');
    expect(await planInfrastructureEngine(f.ctx, params)).not.toHaveProperty('blocked');
    expect(JSON.stringify(f.configurations.at(-1)!.files['cloudrun.tf.json'])).toContain('"version":"7"');
    expect(f.fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('preserves the migration container round before its private value transfer', async () => {
    const f = fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { engine: { pendingImportedSecrets: ['API_KEY'] } });
    f.setState('empty');
    const planned = await planInfrastructureEngine(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, environmentName: 'staging' });
    expect(planned).not.toHaveProperty('blocked');
    expect(JSON.stringify(f.configurations.at(-1)!.files['cloudrun.tf.json'])).not.toContain('secret_key_ref');
  });

  it.each(['absent', 'unknown', 'foreign'] as const)('blocks collection before opening a page for %s containers', async (state) => {
    const f = fixture(); f.setState(state);
    const store = await gcpSecretStore(f.ctx, f.project, f.spec, 'staging');
    expect(store).toHaveProperty('blocked');
    expect(f.fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('collects only after ownership is verified and rechecks that boundary on observe', async () => {
    const f = fixture(); f.setState('empty');
    const store = await gcpSecretStore(f.ctx, f.project, f.spec, 'staging');
    if ('blocked' in store) throw new Error(store.blocked);
    expect(await store.observe('API_KEY')).toBe('absent');
    f.setState('ready');
    expect(await store.observe('API_KEY')).toBe('present');
    f.setState('foreign');
    expect(await store.observe('API_KEY')).toHaveProperty('unknown');
  });
});

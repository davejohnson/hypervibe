import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { observeSecret, writeSecretVersion, planInfrastructureEngine, recordSecretVersionMetadata } from '../infrastructure-engine.js';
import * as infrastructure from '../infrastructure-engine.js';
import * as launch from '../launch.js';
import * as hosting from '../../domain/services/hosting-env.service.js';
import { migrateEnvironment } from '../migrate.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import * as install from '../../adapters/engine/opentofu/install.js';
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';
import { buildCloudRunConfiguration } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-engine-secrets-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
function owned() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'engine-secrets', defaultPlatform: 'cloudrun' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  return { ctx, project, environment, labels: { 'managed-by': 'hypervibe', 'hv-environment': environment.id } };
}
const secret = 'hv-staging-jwt-secret';
const base = `https://secretmanager.googleapis.com/v1/projects/demo-project/secrets/${secret}`;

describe('engine-owned Secret Manager containers', () => {
  it('never creates a missing container while writing a value', async () => {
    const { labels } = owned();
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) { writes.push(`${init.method} ${url}`); return Response.json({ name: `projects/demo-project/secrets/${secret}/versions/1` }); }
      return new Response('', { status: 404 });
    }));
    const result = await writeSecretVersion('test-token', 'demo-project', secret, labels, 'private-value');
    expect(writes).toEqual([]);
    expect(result).toMatchObject({ success: false, status: 'blocked', message: expect.stringContaining('hv_plan') });
  });

  it('writes only a version and preserves exact version-bound credential metadata', async () => {
    const { labels } = owned();
    const writes: string[] = [];
    let version = '1';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) {
        writes.push(`${init.method} ${url}`);
        if (url.endsWith(':addVersion')) { version = '2'; return Response.json({ name: `projects/demo-project/secrets/${secret}/versions/2` }); }
        return Response.json({});
      }
      return Response.json(url.endsWith('/versions/latest') ? { state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/${version}` } : { labels });
    }));
    expect(await writeSecretVersion('test-token', 'demo-project', secret, { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b' }, 'private-value')).toBeUndefined();
    expect(writes).toEqual([`POST ${base}:addVersion`]);
    expect(await observeSecret('test-token', 'demo-project', secret)).toMatchObject({ state: 'present', value: { latestVersion: '2', labels: { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b' } } });
  });

  it('puts containers and their retirement in the saved engine graph without secret values', () => {
    const configuration = buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1', services: [], environmentId: 'env-123',
      secrets: [{ secretId: secret, labels: { 'managed-by': 'hypervibe', 'hv-environment': 'env-123' } }], retiredSecrets: ['hv-staging-retired'],
    } as Parameters<typeof buildCloudRunConfiguration>[0]);
    expect(configuration.files['secrets.tf.json']).toMatchObject({ resource: { google_secret_manager_secret: expect.any(Object) } });
    expect(Object.values(configuration.resources)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: `secret-container:${secret}`, kind: 'secret', dataBearing: true }),
      expect.objectContaining({ actionId: 'secret-container:hv-staging-retired', kind: 'secret', dataBearing: true }),
    ]));
    expect(JSON.stringify(configuration)).not.toContain('private-value');
  });

  it('plans containers before value writes and wires services only after enabled versions exist', async () => {
    const { ctx, project, environment, labels } = owned();
    project.gitRemoteUrl = 'https://github.com/example/secrets';
    const connection = new ConnectionRepository().create({ provider: 'cloudrun', scope: 'example/secrets', credentialsEncrypted: getSecretStore().encryptObject({
      projectId: 'demo-project', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
      credentials: JSON.stringify({ type: 'service_account', private_key: 'test-private-key', client_email: 'deploy@demo-project.iam.gserviceaccount.com' }),
    }) });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
      staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
    }, secrets: { JWT_SECRET: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'] } } });
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
    let ready = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('Planning cannot write to Google.');
      if (url.includes('/secrets?')) return Response.json({ secrets: ready ? [{ name: `projects/demo-project/secrets/${secret}` }] : [] });
      if (!ready) return new Response('', { status: 404 });
      return Response.json(url.endsWith('/versions/latest') ? { state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/2` } : { labels });
    }));
    const first = await planInfrastructureEngine(ctx, { project, spec, specRevision: 1, environmentName: environment.name });
    expect(first).not.toHaveProperty('blocked');
    if ('blocked' in first) throw new Error(first.blocked.join('; '));
    const value = first.actions.find((action) => action.id === 'secret:JWT_SECRET')!;
    expect(value.dependsOn).toEqual([`secret-container:${secret}`]);
    expect(first.actions.indexOf(value)).toBeGreaterThan(first.actions.findIndex((action) => action.id === `secret-container:${secret}`));
    expect(JSON.stringify(configurations[0]!.files['cloudrun.tf.json'])).not.toContain('secret_key_ref');
    ready = true;
    const second = await planInfrastructureEngine(ctx, { project, spec, specRevision: 1, environmentName: environment.name });
    expect(second).not.toHaveProperty('blocked');
    expect(JSON.stringify(configurations.at(-1)!.files['cloudrun.tf.json'])).toContain('secret_key_ref');
    expect(JSON.stringify(configurations.at(-1)!.files['cloudrun.tf.json'])).toContain('"version":"2"');
    expect(enginePlan).toHaveBeenCalledTimes(2);
  });

  it('blocks unknown or foreign containers without writing versions', async () => {
    const { labels } = owned();
    for (const response of [new Response('', { status: 403 }), Response.json({ labels: { ...labels, 'managed-by': 'another-owner' } })]) {
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method) throw new Error('Unowned container must not be mutated.');
        return url.endsWith('/versions/latest') ? new Response('', { status: 404 }) : response;
      });
      vi.stubGlobal('fetch', fetch);
      expect(await writeSecretVersion('test-token', 'demo-project', secret, labels, 'private-value')).toMatchObject({ success: false, status: 'blocked' });
      expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    }
  });


  it('prepares imported secret containers through approved infrastructure before copying values', async () => {
    const { ctx, project, environment } = owned();
    const target = ctx.repos.environments.create({ projectId: project.id, name: 'gcp' });
    ctx.repos.services.create({ projectId: project.id, name: 'web' });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
      staging: { hosting: { provider: 'railway' }, services: { web: {} } },
      gcp: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
    } });
    new ProjectSpecRepository().insert(project.id, 1, spec);
    const events: string[] = [];
    const engineContext = { environment: target, gcpProjectId: 'demo-project', region: 'us-central1',
      adapter: { engineAccessToken: async () => 'test-token' } } as unknown as infrastructure.EngineContext;
    vi.spyOn(infrastructure, 'resolveEngineContext').mockResolvedValue(engineContext);
    vi.spyOn(hosting, 'readHostingEnvVars').mockResolvedValue({ success: true, provider: 'railway', variables: { API_KEY: 'private-value' } });
    const write = vi.spyOn(infrastructure, 'writeSecretVersion').mockImplementation(async () => { events.push('copy-value'); return undefined; });
    let authorized = false;
    let rounds = 0;
    vi.spyOn(launch, 'launchEnvironment').mockImplementation(async (_ctx, params) => {
      if (params.stopAfter === 'prepare') return { status: 'ready', phase: 'prepare', infrastructureRounds: 0 };
      events.push('container-plan');
      const binding = ctx.repos.environments.findById(target.id)!.platformBindings as { engine?: infrastructure.EngineBinding };
      if (!authorized) {
        expect(binding.engine?.pendingImportedSecrets).toEqual(['API_KEY']);
        return { status: 'needs_confirmation', confirmActions: ['secret-container:hv-gcp-api-key'], changes: [], estimatedMonthlyCost: {} } as unknown as launch.LaunchResult;
      }
      rounds++;
      return rounds === 1 ? { status: 'ready', phase: 'infrastructure', infrastructureRounds: 1 }
        : { status: 'blocked', message: 'WIRE_ROUND_REACHED' };
    });
    const params = { project, from: environment.name, to: target.name, importSecrets: true };
    expect(await migrateEnvironment(ctx, params)).toMatchObject({ status: 'needs_confirmation' });
    expect(write).not.toHaveBeenCalled();
    authorized = true;
    events.length = 0;
    expect(await migrateEnvironment(ctx, params)).toMatchObject({ status: 'blocked', message: 'WIRE_ROUND_REACHED' });
    expect(events).toEqual(['container-plan', 'copy-value', 'container-plan']);
    expect((ctx.repos.environments.findById(target.id)!.platformBindings as { engine: infrastructure.EngineBinding }).engine).toMatchObject({ importedSecrets: ['API_KEY'], pendingImportedSecrets: [] });
  });


  it('does not apply old credential metadata to an unacknowledged new version', async () => {
    const { labels, ctx, environment } = owned();
    let version = '1';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) { version = '2'; throw new Error('Acknowledgement lost'); }
      return Response.json(url.endsWith('/versions/latest') ? { state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/${version}` }
        : { labels: { ...labels, 'hv-db-generation': '1', 'hv-db-login': 'app_a' } });
    }));
    expect(await writeSecretVersion('test-token', 'demo-project', secret, { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b' }, 'private-value')).toMatchObject({ success: false, status: 'pending' });
    expect(await observeSecret('test-token', 'demo-project', secret)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('unrecognized version') });
    expect(JSON.stringify(ctx.repos.environments.findById(environment.id)!.platformBindings)).not.toContain('private-value');
  });

  it('preserves adopted labels while exact-version metadata clears a completed retirement', async () => {
    const { labels } = owned();
    const legacy = { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b', 'hv-db-retire': 'app_a' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/versions/latest')
      ? { state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/7` } : { labels: legacy })));
    expect(await observeSecret('test-token', 'demo-project', secret)).toMatchObject({ state: 'present', value: { labels: legacy } });
    expect(recordSecretVersionMetadata('demo-project', secret, '7', { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b' })).toBe(true);
    const observed = await observeSecret('test-token', 'demo-project', secret);
    expect(observed).toMatchObject({ state: 'present', value: { containerLabels: legacy, labels: { 'hv-db-generation': '2', 'hv-db-login': 'app_b' } } });
    if (observed.state !== 'present') throw new Error('Expected owned container');
    expect(observed.value.labels).not.toHaveProperty('hv-db-retire');
  });

});

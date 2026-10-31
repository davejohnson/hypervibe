import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../../../application/providers.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { resolvePlanActionAuthority } from '../../plan/action-authority.js';
import { secretContainerBindings, secretContainerBindingSchema } from '../../ports/secret-destination-lifecycle.port.js';
import { mergeRepoPlatformBindings, readRepoBindingsFile, writeRepoBindingsForEnvironment } from '../../spec/repo-bindings-file.js';
import { CloudRunAdapter } from '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { EcsExpressAdapter } from '../../../adapters/providers/aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../../../adapters/providers/azure/azure-container-apps.adapter.js';

const destination = { provider: 'gcp-secret-manager' as const, projectId: 'synthetic-project', projectNumber: '123456789012', secretId: 'staging-api' };
const owner = { repository: 'github.com/acme/app', environment: 'staging', key: 'API_TOKEN' };
const attempted = { destination, owner, attemptId: '11111111-1111-4111-8111-111111111111', state: 'attempted' as const };
const ready = { ...attempted, state: 'ready' as const, resource: 'projects/123456789012/secrets/staging-api', createTime: '2026-10-24T00:01:00.123456789Z' };
afterEach(() => vi.unstubAllEnvs());
describe('secret container setup capability and durable nonsecret binding contract', () => {
  it('accounts for every hosting provider and distinguishes setup from runtime reference support', () => {
    expect(providerRegistry.namesFor('hosting').sort()).toEqual(['azure-container-apps', 'cloudrun', 'digitalocean', 'ecs', 'fly', 'railway', 'vercel']);
    for (const provider of providerRegistry.namesFor('hosting')) {
      expect(providerRegistry.getMetadata(provider)?.secretDestinationSetupProviders ?? [], provider).toEqual(provider === 'cloudrun' ? ['gcp-secret-manager'] : []);
      const action = { id: 'secret-destination:API_TOKEN', type: 'create' as const, verified: true, billable: true, requiresConfirm: true,
        reason: 'Reviewed empty creation', resource: { kind: 'secret' as const, name: 'API_TOKEN', provider },
        metadata: { operation: 'secretDestinationPrepare', destination, owner, mode: 'create' } };
      expect(resolvePlanActionAuthority(action)?.capability, provider).toBe(provider === 'cloudrun' ? 'secret.destination.prepare' : undefined);
    }
    expect(new CloudRunAdapter().secretDestinationSetup.providers).toEqual(['gcp-secret-manager']);
    expect((new EcsExpressAdapter() as any).secretDestinationSetup).toBeUndefined();
    expect((new AzureContainerAppsAdapter() as any).secretDestinationSetup).toBeUndefined();
  });
  it('roundtrips exact attempt and lifetime across repository export without admitting credential fields', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hv-secret-binding-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
      vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
      const now = new Date();
      const project = { id: 'local-project', name: 'app', gitRemoteUrl: 'https://github.com/acme/app.git', defaultPlatform: 'cloudrun', policies: {}, createdAt: now, updatedAt: now };
      const environment = { id: 'local-env', projectId: project.id, name: 'staging', platformBindings: { provider: 'cloudrun', secretDestinationContainers: { API_TOKEN: ready }, apiToken: 'synthetic-must-not-export' }, createdAt: now, updatedAt: now };
      const file = writeRepoBindingsForEnvironment(project, environment, root)!;
      expect(readFileSync(file, 'utf8')).not.toContain('synthetic-must-not-export');
      const imported = readRepoBindingsFile(project.name, root)!.document.environments.staging.platformBindings;
      expect(secretContainerBindings(mergeRepoPlatformBindings({}, imported).secretDestinationContainers)).toEqual({ API_TOKEN: ready });
      expect(() => writeRepoBindingsForEnvironment(project, { ...environment, platformBindings: { secretDestinationContainers: { API_TOKEN: { ...ready, value: 'synthetic-must-not-export' } } } }, root)).toThrow();
      expect(readFileSync(file, 'utf8')).not.toContain('synthetic-must-not-export');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps the strongest matching recovery state when another device imports an older attempt', () => {
    expect(mergeRepoPlatformBindings({ secretDestinationContainers: { API_TOKEN: ready } }, { secretDestinationContainers: { API_TOKEN: attempted } }).secretDestinationContainers).toEqual({ API_TOKEN: ready });
    expect(mergeRepoPlatformBindings({ secretDestinationContainers: { API_TOKEN: attempted } }, { secretDestinationContainers: { API_TOKEN: ready } }).secretDestinationContainers).toEqual({ API_TOKEN: ready });
    expect(mergeRepoPlatformBindings({ secretDestinationContainers: { API_TOKEN: ready } }, { secretDestinationContainers: {} }).secretDestinationContainers).toEqual({ API_TOKEN: ready });
  });
  it.each([
    { attemptId: '22222222-2222-4222-8222-222222222222' },
    { owner: { ...owner, environment: 'production' } },
    { destination: { ...destination, projectNumber: '987654321098' } },
    { createTime: '2026-10-24T01:00:00Z' },
  ])('rejects conflicting imported ownership or lifetime: %j', change => {
    expect(() => mergeRepoPlatformBindings({ secretDestinationContainers: { API_TOKEN: ready } }, { secretDestinationContainers: { API_TOKEN: { ...ready, ...change } } })).toThrow();
  });
  it('requires native lifetime for ready state and never accepts a different native identity', () => {
    expect(secretContainerBindingSchema.safeParse({ ...attempted, state: 'ready' }).success).toBe(false);
    expect(secretContainerBindingSchema.safeParse({ ...ready, resource: 'projects/987654321098/secrets/staging-api' }).success).toBe(false);
  });
});

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import * as backend from '../../adapters/providers/aws/tofu/aws-engine.backend.js';
import * as setup from '../../adapters/providers/aws/aws-setup.client.js';
import * as client from '../../adapters/providers/aws/aws-release.client.js';
import * as local from '../local-repository.js';
import * as shared from '../engine-shared.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { planAwsInfrastructureEngine } from '../infrastructure-engine-aws.js';
import { upgradeAwsRuntimeImage } from '../infrastructure-engine-aws-release.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'hv-runtime-upgrade-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'app', defaultPlatform: 'aws' });
  const connection = new ConnectionRepository().create({ provider: 'aws', scope: project.name, credentialsEncrypted: getSecretStore().encryptObject({
    accessKeyId: 'test-access-key-1234', secretAccessKey: 'test-secret-key-for-aws-fixture-only', roleArn: 'arn:aws:iam::123456789012:role/hypervibe/hypervibe-deploy-fixture', accountId: '123456789012', region: 'us-west-2',
  }) });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  vi.spyOn(backend, 'awsEngineAuthentication').mockResolvedValue({ env: { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_SESSION_TOKEN: 'test' }, redact: [] });
  vi.spyOn(setup, 'awsAccessCurrent').mockResolvedValue('current');
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test' });
  ctx.repos.environments.updatePlatformBindings(environment.id, { aws: { kind: 'opentofu', imageUri: 'registry/app@sha256:old' } });
  const spec = projectSpecSchema.parse({ version: 1, project: 'app', environments: { test: { hosting: { provider: 'aws', engine: 'opentofu' }, services: { web: {} } } } });
  return { ctx, project, spec, specRevision: 1, environmentName: 'test' };
}
describe('AWS runtime secret protocol upgrade', () => {
  it('reviews and orders a new image release before runtime permission changes', async () => {
    const f = fixture();
    execFileSync('git', ['init', '-q', directory]);
    execFileSync('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
    vi.spyOn(local, 'localRepositoryFor').mockReturnValue(directory);
    vi.spyOn(shared, 'openTofuEngine').mockResolvedValue({ plan: async (input: { state: { environmentId: string } }) => ({ ok: true, blockers: [], actions: [{
      id: input.state.environmentId.endsWith('-build') ? 'builds:images' : 'identity:runtime', type: 'update', verified: true, resource: { kind: 'service', name: 'runtime', provider: 'aws' }, reason: 'fixture',
    }] }) } as never);
    const plan = await planAwsInfrastructureEngine(f.ctx, f);
    if ('blocked' in plan) throw new Error(plan.blocked.join('; '));
    const build = plan.actions.find((action) => action.id === 'build:image')!;
    expect(build.reason).toContain('release the new secrets loader');
    expect(build.metadata).toMatchObject({ runtimeUpgrade: true, image: expect.stringContaining('-hv-secrets-v2') });
    expect(build.dependsOn).toContain('builds:images');
    expect(plan.actions.find((action) => action.id === 'identity:runtime')!.dependsOn).toContain('build:image');
  });
  it('blocks before changing anything when the old image cannot be rebuilt', async () => {
    const f = fixture();
    vi.spyOn(local, 'localRepositoryFor').mockReturnValue(undefined);
    expect(await planAwsInfrastructureEngine(f.ctx, f)).toMatchObject({ blocked: [expect.stringContaining('rebuild and release')] });
  });
  it.each(['failed', 'unknown'] as const)('stops an unverified image release (%s)', async (status) => {
    const f = fixture();
    vi.spyOn(client, 'functionExists').mockResolvedValue(true);
    vi.spyOn(client, 'releaseFunction').mockResolvedValue({ service: 'web', status, message: 'not verified' });
    expect(await upgradeAwsRuntimeImage({ region: 'us-west-2', prefix: 'hv-app-test', accountId: '123456789012', credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' } }, f.spec, 'test', 'registry/app@sha256:new')).toContain('did not finish');
  });
});

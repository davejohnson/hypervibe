import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../adapters/providers/github/github.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { releaseGcpEngineServices } from '../infrastructure-engine.js';
import { CommandRegistry } from '../commands.js';
import { registerHvDeployTools } from '../../tools/hv-deploy.tools.js';

// #680: GitHub's archive API authenticates the exact repository/ref, responds
// with a 302 archive URL, and archives have a wrapper directory. Fixtures are
// reconstructed from https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar
// and https://docs.github.com/en/rest/commits/commits#get-a-commit.
let directory: string;
const sha = 'a'.repeat(40);
const token = 'synthetic-private-repository-token';
const root = `owner-app-${sha.slice(0, 7)}`;
let archive: Buffer;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-remote-release-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  mkdirSync(path.join(directory, root));
  writeFileSync(path.join(directory, root, 'package.json'), '{"name":"exact-source"}\n');
  archive = execFileSync('tar', ['czf', '-', '-C', directory, root], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function fixture(githubScope?: string, verified = true) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'remote-release', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/owner/app.git' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  ctx.repos.environments.updatePlatformBindings(environment.id, { projectId: 'demo-project', environmentId: 'us-central1',
    engine: { kind: 'opentofu' }, services: { web: { serviceId: 'web-staging' } } });
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'cloudrun', scope: 'owner/app', credentialsEncrypted: getSecretStore().encryptObject({
    projectId: 'demo-project', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({ type: 'service_account', private_key: 'test-private-key', client_email: 'deploy@demo-project.iam.gserviceaccount.com' }),
  }) });
  connections.updateStatus(connection.id, 'verified');
  if (githubScope) {
    const github = connections.create({ provider: 'github', scope: githubScope, credentialsEncrypted: getSecretStore().encryptObject({ apiToken: token }) });
    if (verified) connections.updateStatus(github.id, 'verified');
  }
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl, environments: {
    staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
  } });
  const uploadBuild = vi.spyOn(CloudRunAdapter.prototype, 'buildReleaseImageFromArchive').mockResolvedValue({ success: false, error: 'Stopped at the build boundary.' });
  const cloneBuild = vi.spyOn(CloudRunAdapter.prototype, 'buildReleaseImage').mockResolvedValue({ success: false, error: 'Unsafe clone fallback reached.' });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (url.startsWith('https://api.github.com/repos/owner/app/commits/')) return Response.json({ sha, url: `https://api.github.com/repos/owner/app/commits/${sha}` });
    if (url === `https://api.github.com/repos/owner/app/tarball/${sha}`) return new Response(null, { status: 302,
      headers: { location: `https://codeload.github.com/owner/app/legacy.tar.gz/${sha}?token=private-receipt` } });
    if (url.startsWith('https://codeload.github.com/')) return new Response(new Uint8Array(archive), { headers: { 'content-type': 'application/gzip' } });
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetch);
  const release = (revision = sha) => releaseGcpEngineServices(ctx, { project, spec, environmentName: 'staging', specRevision: 1, revision });
  return { project, spec, ctx, uploadBuild, cloneBuild, fetch, release };
}

describe('GCP release without a local checkout', () => {
  it('authenticates GitHub once, freezes the commit, and uploads its archive without giving the token to the build', async () => {
    const f = fixture('owner/app');
    const result = await f.release();
    expect(result).not.toHaveProperty('blocked');
    expect(f.cloneBuild).not.toHaveBeenCalled();
    expect(f.uploadBuild).toHaveBeenCalledOnce();
    expect(f.uploadBuild.mock.calls[0]![2]).toEqual({ archive, commitSha: sha, bucket: 'demo-project-hv-build-source', sourceDirectory: root });
    expect(JSON.stringify(f.uploadBuild.mock.calls)).not.toContain(token);
    expect(f.fetch.mock.calls.slice(0, 2).every(([, init]) => new Headers(init?.headers).get('authorization') === `Bearer ${token}`)).toBe(true);
    expect(new Headers(f.fetch.mock.calls[2]![1]?.headers).has('authorization')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-receipt');
  });

  it.each([[undefined, true], ['other/repository', true], ['owner/app', false]] as const)(
    'blocks before either build when the GitHub connection is missing, unrelated, or unverified (%s)', async (scope, verified) => {
      const f = fixture(scope, verified);
      expect(await f.release()).toMatchObject({ blocked: expect.stringMatching(/local.*repository.*connect GitHub/i) });
      expect(f.cloneBuild).not.toHaveBeenCalled();
      expect(f.uploadBuild).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    });

  it('uses the declared deployment branch through the public deploy command', async () => {
    const f = fixture('owner/app');
    f.spec.environments.staging!.deploy = { strategy: 'manual', branch: 'release/next' };
    new ProjectSpecRepository().insert(f.project.id, 1, f.spec);
    const commands = new CommandRegistry();
    registerHvDeployTools(commands, f.ctx);
    const result = await commands.execute('hv_deploy', { project: f.project.name, env: 'staging' });
    expect(result).toMatchObject({ ok: false, error: { details: { results: [{ message: 'Stopped at the build boundary.' }] } } });
    expect(f.fetch.mock.calls[0]![0]).toBe('https://api.github.com/repos/owner/app/commits/release%2Fnext');
    const plan = new RunRepository().findByProjectId(f.project.id).find(run => run.type === 'plan');
    expect(plan?.plan).toMatchObject({ actions: [{ reason: expect.stringContaining(`release/next (${sha})`) }] });
    expect(f.cloneBuild).not.toHaveBeenCalled();
    expect(f.uploadBuild).toHaveBeenCalledOnce();
  });

  it('blocks mismatching project/spec repository identities before source or build requests', async () => {
    const f = fixture('owner/app');
    f.spec.gitRemoteUrl = 'https://github.com/other/app.git';
    expect(await f.release()).toMatchObject({ blocked: expect.stringContaining('different source repositories') });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.cloneBuild).not.toHaveBeenCalled();
    expect(f.uploadBuild).not.toHaveBeenCalled();
  });
});

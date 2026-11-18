import { generateKeyPairSync } from 'node:crypto';
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
import { formatCommandResult } from '../presentation.js';
import { CommandRegistry } from '../commands.js';
import { registerHvObservabilityTools } from '../../tools/hv-observability.tools.js';
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

function fixture(githubScope?: string, verified = true, privateKey = 'test-private-key') {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'remote-release', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/owner/app.git' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  ctx.repos.environments.updatePlatformBindings(environment.id, { projectId: 'demo-project', environmentId: 'us-central1',
    engine: { kind: 'opentofu' }, services: { web: { serviceId: 'web-staging' } } });
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'cloudrun', scope: 'owner/app', credentialsEncrypted: getSecretStore().encryptObject({
    projectId: 'demo-project', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({ type: 'service_account', private_key: privateKey, client_email: 'deploy@demo-project.iam.gserviceaccount.com' }),
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

// #706. The transport fixtures follow Google's Cloud Run Execution and Cloud Logging
// monitored-resource contracts. The job's name deliberately differs from the selector.
// https://docs.cloud.google.com/logging/docs/api/v2/resource-list#tag_cloud_run_job
// https://docs.cloud.google.com/logging/docs/api/platform-logs#run
// https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions
describe('Google release command results and logs', () => {
  const job = 'bound-migration-job';
  const region = 'europe-west1';
  const projectId = 'demo-project';
  const image = `registry.example/app@sha256:${'b'.repeat(64)}`;
  const executionPrefix = `projects/${projectId}/locations/${region}/jobs/${job}/executions/`;
  const logs = { source: 'release-command', project: 'remote-release', env: 'staging' };
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  function setup(outcome: 'success' | 'failure' | 'unknown' = 'success', httpStatus = 200) {
    const f = fixture('owner/app', true, privateKey);
    const environment = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')!;
    const bindings = { projectId, environmentId: region, engine: { kind: 'opentofu', releaseJob: job },
      services: { web: { serviceId: 'web-staging' }, 'release-command': { serviceId: 'a-real-service' } } };
    f.ctx.repos.environments.updatePlatformBindings(environment.id, bindings);
    f.spec.environments.staging!.hosting.region = region;
    f.spec.environments.staging!.migrations = { mode: 'releaseCommand', command: 'npm run migrate' };
    new ProjectSpecRepository().insert(f.project.id, 1, f.spec);
    f.uploadBuild.mockResolvedValue({ success: true, imageUri: image });
    const github = f.fetch.getMockImplementation()!;
    const prefix = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}`;
    let runs = 0;
    f.fetch.mockImplementation(async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 });
      if (url === `${prefix}/jobs/${job}`) return Response.json(init?.method === 'PATCH' ? { done: true } :
        { name: `projects/${projectId}/locations/${region}/jobs/${job}`, etag: 'job-etag', template: { template: { containers: [{ image }] } } });
      if (url === `${prefix}/jobs/${job}:run`) {
        if (outcome === 'unknown') throw new Error('Simulated connection loss');
        return Response.json({ done: true, response: { name: `${executionPrefix}${job}-${++runs}`,
          ...(outcome === 'success' ? { succeededCount: 1 } : { failedCount: 1 }) } });
      }
      if (String(url).split('?')[0] === `${prefix}/services/web-staging`) return Response.json(init?.method === 'PATCH' ? { done: true } :
        { etag: 'service-etag', template: { containers: [{ image }] }, uri: 'https://web.example.test',
          latestReadyRevision: 'web-1', latestCreatedRevision: 'web-1', terminalCondition: { state: 'CONDITION_SUCCEEDED' } });
      if (String(url) === 'https://web.example.test/') return new Response(null, { status: httpStatus });
      if (url === 'https://logging.googleapis.com/v2/entries:list') return Response.json({ entries: [{
        resource: { type: 'cloud_run_job', labels: { project_id: projectId, location: region, job_name: job } },
        severity: 'INFO', timestamp: '2026-11-10T12:00:00Z', textPayload: 'Applied two migrations',
      }] });
      return github(url, init);
    });
    const commands = new CommandRegistry();
    registerHvDeployTools(commands, f.ctx);
    registerHvObservabilityTools(commands, f.ctx);
    return { ...f, commands, environment, bindings, prefix };
  }

  it.each([
    ['success', 200, true, 'released'],
    ['success', 503, false, 'released'],
    ['failure', 200, false, 'failed'],
    ['unknown', 200, false, 'unknown'],
  ] as const)('reports %s job execution with a working logs pointer when health returns %d', async (outcome, health, ok, status) => {
    const f = setup(outcome, health);
    const deploy = await f.commands.execute('hv_deploy', { project: f.project.name, env: 'staging' });
    const results = ok ? deploy.data : deploy.error?.details;
    expect(deploy.ok, JSON.stringify(results)).toBe(ok);
    expect(results).toMatchObject({ results: [
      { service: 'release command', status, ...(outcome === 'unknown' ? {} : { logs: { command: 'hv_logs', arguments: { ...logs, execution: `${executionPrefix}${job}-1` } } }) },
      { service: 'web', status: ok ? 'released' : 'failed' },
    ] });
    const rendered = formatCommandResult('hv_deploy', deploy);
    expect(rendered).toContain('hv_logs');
    if (outcome !== 'unknown') expect(rendered).toContain(`execution="${executionPrefix}${job}-1"`);
    if (outcome === 'failure') {
      const binding = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
      expect(binding).not.toHaveProperty('engine.releaseRun');
    }
    if (ok) expect(deploy.data).toMatchObject({ message: 'Released 1 service(s).' });
    const changedWeb = f.fetch.mock.calls.some(([url, init]) => String(url).includes('/services/') && init?.method === 'PATCH');
    expect(changedWeb).toBe(outcome === 'success');
  });

  it('keeps the first execution readable after a second deploy runs the same job', async () => {
    const f = setup();
    const deploy = async () => {
      const result = await f.commands.execute('hv_deploy', { project: f.project.name, env: 'staging' });
      expect(result.ok).toBe(true);
      return (result.data as { results: Array<{ logs: { command: string; arguments: Record<string, string> } }> }).results[0]!.logs;
    };
    const first = await deploy();
    const second = await deploy();
    expect(first.arguments.execution).toBe(`${executionPrefix}${job}-1`);
    expect(second.arguments.execution).toBe(`${executionPrefix}${job}-2`);
    const normal = f.fetch.getMockImplementation()!;
    let returnedExecution = `${job}-1`;
    f.fetch.mockImplementation(async (url, init) => {
      if (!String(url).includes('logging.googleapis.com')) return normal(url, init);
      const filter: string = JSON.parse(String(init?.body)).filter;
      expect(filter).toContain(`labels."run.googleapis.com/execution_name"="${job}-1"`);
      return Response.json({ entries: [{ labels: { 'run.googleapis.com/execution_name': returnedExecution },
        resource: { type: 'cloud_run_job', labels: { project_id: projectId, location: region, job_name: job } },
        timestamp: '2026-11-10T12:00:00Z', textPayload: 'First execution output' }] });
    });
    const read = await f.commands.execute(first.command, first.arguments);
    expect(read).toMatchObject({ ok: true, data: { execution: first.arguments.execution, logs: [{ message: 'First execution output' }] } });
    const foreign = await f.commands.execute(first.command, { ...first.arguments, execution: first.arguments.execution!.replace('/demo-project/', '/foreign/') });
    expect(foreign.ok).toBe(false);
    expect(f.fetch.mock.calls.filter(([url]) => String(url).includes('logging.googleapis.com'))).toHaveLength(1);
    returnedExecution = `${job}-2`;
    const mixed = await f.commands.execute(first.command, first.arguments);
    expect(mixed.ok).toBe(false);
    expect(JSON.stringify(mixed)).not.toContain('First execution output');
  });

  it('keeps an execution with no terminal task evidence pending across deploy retries', async () => {
    const f = setup();
    const name = executionPrefix + job + '-unknown';
    const normal = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (url.endsWith(':run')) return Response.json({ done: true, response: { name } });
      if (url.endsWith(name)) return Response.json({ name, completionTime: '2026-11-10T12:00:00Z' });
      return normal(url, init);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.commands.execute('hv_deploy', { project: f.project.name, env: 'staging' });
      expect(result).toMatchObject({ ok: false, error: { details: { results: [
        { service: 'release command', status: 'unknown', logs: { arguments: { execution: name } } }, { service: 'web', status: 'failed' },
      ] } } });
      const binding = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
      expect(binding).toMatchObject({ engine: { releaseRun: { execution: name } } });
    }
    expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith(':run'))).toHaveLength(1);
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('/services/web-staging'))).toBe(false);
  });

  it('omits execution logs when the build fails before the job can run', async () => {
    const f = setup();
    f.uploadBuild.mockResolvedValue({ success: false, error: 'Build failed before dispatch.' });
    const result = await f.commands.execute('hv_deploy', { project: f.project.name, env: 'staging' });
    const { results } = result.error!.details as { results: Array<Record<string, unknown>> };
    expect(results[0]).toMatchObject({ service: 'release command', status: 'failed' });
    expect(results[0]).not.toHaveProperty('logs');
  });

  it('reads exactly the bound migration job even when a service has the same selector name', async () => {
    const f = setup();
    const read = await f.commands.execute('hv_logs', { ...logs, limit: 2 });
    expect(read).toMatchObject({ ok: true, data: { source: 'release-command', count: 1, logs: [{ message: 'Applied two migrations' }] } });
    expect(formatCommandResult('hv_logs', read)).toContain('Applied two migrations');
    const logging = f.fetch.mock.calls.filter(([url]) => url === 'https://logging.googleapis.com/v2/entries:list');
    expect(logging).toHaveLength(1);
    const body = JSON.parse(String(logging[0]![1]?.body));
    expect(body).toMatchObject({ resourceNames: [`projects/${projectId}`], pageSize: 2, orderBy: 'timestamp desc' });
    for (const filter of ['resource.type="cloud_run_job"', `resource.labels.job_name="${job}"`, `resource.labels.location="${region}"`, `resource.labels.project_id="${projectId}"`]) {
      expect(body.filter).toContain(filter);
    }
    expect(body.filter).not.toContain('a-real-service');
  });

  it('checks returned job identity and scrubs the connection token from job output and errors', async () => {
    const f = setup();
    const response = (entry: object) => Response.json({ entries: [entry] });
    const entry = { resource: { type: 'cloud_run_job', labels: { project_id: projectId, location: region, job_name: job } },
      timestamp: '2026-11-10T12:00:00Z', severity: 'DEFAULT', textPayload: 'Migration failed: synthetic-access-token' };
    const normal = f.fetch.getMockImplementation()!;
    let result = response(entry);
    f.fetch.mockImplementation((url, init) => String(url).includes('logging.googleapis.com') ? Promise.resolve(result) : normal(url, init));
    const read = () => f.commands.execute('hv_logs', { ...logs, errorsOnly: true, limit: 1 });
    expect(await read()).toMatchObject({ ok: true, data: { logs: [{ message: 'Migration failed: [redacted]' }] } });
    const query = f.fetch.mock.calls.find(([url]) => String(url).includes('logging.googleapis.com'))!;
    expect(JSON.parse(String(query[1]?.body)).filter).not.toContain('severity>=');
    result = response({ ...entry, resource: { ...entry.resource, labels: { ...entry.resource.labels, job_name: 'other-job' } } });
    const outside = await read();
    expect(outside.ok).toBe(false);
    expect(JSON.stringify(outside)).not.toContain('synthetic-access-token');
    result = new Response('synthetic-access-token', { status: 500 });
    const error = await read();
    expect(error.ok).toBe(false);
    expect(JSON.stringify(error)).not.toContain('synthetic-access-token');
  });

  it.each([
    { engine: { kind: 'opentofu' } },
    { projectId: 'different-project' },
    { environmentId: undefined },
  ])('requires the bound job, project and region before querying logs', async (missing) => {
    const f = setup();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { ...f.bindings, ...missing });
    const read = await f.commands.execute('hv_logs', logs);
    expect(read.ok).toBe(false);
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('logging.googleapis.com'))).toBe(false);
  });
});

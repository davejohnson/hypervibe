import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import * as backend from '../../adapters/providers/aws/tofu/aws-engine.backend.js';
import * as setup from '../../adapters/providers/aws/aws-setup.client.js';
import * as shared from '../engine-shared.js';
import * as awsEngine from '../infrastructure-engine-aws.js';
import * as awsRelease from '../../adapters/providers/aws/aws-release.client.js';
import { buildAwsCommitImage, releaseAwsEngineServices } from '../infrastructure-engine-aws-release.js';
import { createCommandContext } from '../context.js';
import { packageLocalCommit, runLocalCommitRelease, selectReleaseWorkloads, type LocalCommitReleaseTarget, type LocalCommitSource } from '../engine-release.js';

// Contract (docs/opentofu-engine-aws.md, docs/opentofu-engine-azure.md): a release
// builds one exact commit, then changes only each service's running image; the
// first release only builds; a failed or unknown step stops dependent services.
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-engine-release-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

const source: LocalCommitSource = { commitSha: 'a'.repeat(40), archive: Buffer.from('archive'), uncommittedChangesExcluded: true };

function fixture(overrides: Partial<LocalCommitReleaseTarget> = {}) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'engine-release', defaultPlatform: 'aws' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'testing' });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { testing: {
    hosting: { provider: 'aws', engine: 'opentofu' },
    services: { web: { startCommand: 'npm start' }, worker: { workloadKind: 'worker', startCommand: 'npm run worker' } },
  } } });
  const recorded: string[] = [];
  const target: LocalCommitReleaseTarget = {
    cloudName: 'TestCloud', provider: 'aws', environmentId: environment.id, buildPhrase: 'in the test builder', firstImage: false, createdNoun: 'services',
    resourceOf: (name) => `native/${name}`,
    build: vi.fn(async () => ({ image: 'registry/app@sha256:1', logsUrl: 'https://logs.example/1' })),
    recordImage: (image) => { recorded.push(image); },
    releaseWorkload: vi.fn(async ({ name, image }) => ({ service: name, status: 'released' as const, imageUri: image, message: `${name} released.` })),
    ...overrides,
  };
  const run = () => runLocalCommitRelease({ project, spec, environmentName: 'testing', specRevision: 1 }, source, ['web', 'worker'], target);
  return { target, recorded, run, ctx, project, environment, spec };
}

describe('shared engine release', () => {
  it('builds once, records the image, then releases each service with its native identity', async () => {
    const f = fixture();
    const result = await f.run();
    if ('blocked' in result) throw new Error(result.blocked);
    expect(f.target.build).toHaveBeenCalledExactlyOnceWith(source);
    expect(f.recorded).toEqual(['registry/app@sha256:1']);
    expect(vi.mocked(f.target.releaseWorkload).mock.calls.map(([workload]) => workload)).toEqual([
      { name: 'web', kind: 'web', resource: 'native/web', image: 'registry/app@sha256:1' },
      { name: 'worker', kind: 'worker', resource: 'native/worker', image: 'registry/app@sha256:1' },
    ]);
    expect(result.results.map(({ service, status }) => [service, status])).toEqual([['web', 'released'], ['worker', 'released']]);
    expect(result.source).toEqual({ kind: 'local-commit', revision: source.commitSha, commitSha: source.commitSha, uncommittedChangesExcluded: true });
  });

  it.each([{ selected: ['worker'] }, { selected: ['web'] }, { selected: ['web', 'worker'] }])('scopes a local AWS release to its selected workloads ($selected)', async ({ selected }) => {
    const { ctx, project, environment, spec } = fixture();
    const existing = ctx.repos.environments.updatePlatformBindings(environment.id, { aws: { imageUri: 'old-image' } })!;
    const context = { environment: existing, connection: { region: 'us-west-2', accountId: '111122223333' }, prefix: 'hv-test',
      parameterPath: '/hypervibe/test/', credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' } } as awsEngine.AwsEngineContext;
    vi.spyOn(awsEngine, 'resolveAwsEngineContext').mockResolvedValue(context);
    vi.spyOn(awsRelease, 'webServiceExists').mockResolvedValue(true);
    const build = vi.spyOn(awsRelease, 'buildImage').mockImplementation(async target =>
      ({ imageUri: 'default-digest', ...(target.webCommands ? { webImageUri: 'web-digest' } : {}) }));
    const web = vi.spyOn(awsRelease, 'releaseWebService').mockResolvedValue({ service: 'web', status: 'released', message: 'released' });
    const worker = vi.spyOn(awsRelease, 'releaseTask').mockResolvedValue({ service: 'worker', status: 'released', message: 'released' });
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
    git('init'); writeFileSync(path.join(directory, 'Dockerfile'), 'FROM scratch\nENTRYPOINT ["/init"]\nCMD ["serve"]\n');
    git('add', 'Dockerfile'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'app');

    const result = await releaseAwsEngineServices(ctx, { project, spec, environmentName: 'testing', specRevision: 1, services: selected, sourceDirectory: directory });
    if ('blocked' in result) throw new Error(result.blocked);
    expect(result.results.map(item => item.status)).toEqual(selected.map(() => 'released'));
    expect(build.mock.calls[0]![0].webCommands).toBe(selected.includes('web'));
    expect(web.mock.calls.map(call => call[3])).toEqual(selected.includes('web') ? ['web-digest'] : []);
    expect(worker.mock.calls.map(call => call[3])).toEqual(selected.includes('worker') ? ['default-digest'] : []);
  });

  it.each([false, true])('blocks a missing generated web default before a local release or first AWS build (override first %s)', async overrideFirst => {
    const { ctx, project, environment, spec } = fixture();
    const explicit = spec.environments.testing!.services.web!;
    const plain = { ...explicit, startCommand: undefined };
    spec.environments.testing!.services = overrideFirst ? { web: explicit, plain } : { plain, web: explicit };
    const target = { environmentId: environment.id, region: 'us-west-2', accountId: '111122223333', prefix: 'hv-test',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' } };
    vi.spyOn(awsEngine, 'resolveAwsEngineContext').mockResolvedValue({ ...target, environment, connection: target } as unknown as awsEngine.AwsEngineContext);
    const build = vi.spyOn(awsRelease, 'buildImage');
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'app');
    const first = await buildAwsCommitImage(target, spec, 'testing', directory, git('rev-parse', 'HEAD'));
    const release = await releaseAwsEngineServices(ctx, { project, spec, environmentName: 'testing', specRevision: 1, sourceDirectory: directory });
    expect(first).toMatchObject({ error: expect.stringMatching(/startCommand.*Dockerfile/) });
    expect(release).toMatchObject({ blocked: expect.stringMatching(/startCommand.*Dockerfile/) });
    expect(build).not.toHaveBeenCalled();
  });

  it('uses the web variant only for declared web overrides at creation and when reconstructing a plan from bindings', () => {
    const { environment, spec } = fixture();
    const env = spec.environments.testing!;
    env.services.private = { ...env.services.web!, public: false };
    env.services.plain = { ...env.services.web!, startCommand: undefined };
    env.services.nightly = { ...env.services.worker!, workloadKind: 'cron', cronSchedule: '0 1 * * *' };
    const context = { environment, connection: { region: 'us-west-2', accountId: '111122223333' }, prefix: 'hv-test', parameterPath: '/hypervibe/test/' } as awsEngine.AwsEngineContext;
    const first = awsEngine.buildAwsEngineInput(spec, 'testing', context, { secretKeys: [], image: 'original', webImage: 'web-variant' });
    expect(first.services?.map(service => [service.logicalName, service.initialImageUri, service.command])).toEqual([
      ['plain', 'original', undefined], ['private', 'web-variant', ['sh', '-c', 'npm start']], ['web', 'web-variant', ['sh', '-c', 'npm start']],
    ]);
    expect(first.workers?.[0]).toMatchObject({ initialImageUri: 'original', command: ['sh', '-c', 'npm run worker'] });
    expect(first.jobs?.[0]).toMatchObject({ initialImageUri: 'original', command: ['sh', '-c', 'npm run worker'] });
    const released = { ...context, environment: { ...environment, platformBindings: { aws: { imageUri: 'original', webImageUri: 'web-variant' } } } };
    expect(awsEngine.buildAwsEngineInput(spec, 'testing', released, { secretKeys: [] })).toEqual(first);
  });

  it('only builds on the first release and points to the infrastructure plan', async () => {
    const f = fixture({ firstImage: true, createdNoun: 'workloads' });
    const result = await f.run();
    if ('blocked' in result) throw new Error(result.blocked);
    expect(f.target.releaseWorkload).not.toHaveBeenCalled();
    expect(result.results).toEqual([expect.objectContaining({ service: 'image', status: 'released', buildLogsUrl: 'https://logs.example/1',
      message: expect.stringContaining('create the workloads from it') })]);
  });

  it.each([
    ['failed', { error: 'The image build failed; see its log.' }, 'failed'],
    ['still running', { error: 'The image build is still running.', unknown: true }, 'unknown'],
  ] as const)('releases no service when the build %s', async (_label, built, status) => {
    const f = fixture({ build: vi.fn(async () => built) });
    const result = await f.run();
    if ('blocked' in result) throw new Error(result.blocked);
    expect(f.target.releaseWorkload).not.toHaveBeenCalled();
    expect(f.recorded).toEqual([]);
    expect(result.results.map(({ service, status: outcome }) => [service, outcome])).toEqual([['image', status], ['web', 'failed'], ['worker', 'failed']]);
  });

  it('reports a provider rejection as unknown, never as released', async () => {
    const f = fixture({ releaseWorkload: vi.fn(async () => { throw new Error('throttled'); }) });
    const result = await f.run();
    if ('blocked' in result) throw new Error(result.blocked);
    expect(result.results[0]).toMatchObject({ service: 'web', status: 'unknown', message: expect.stringContaining('TestCloud rejected the release step') });
    expect(result.results.some(({ status }) => status === 'released')).toBe(false);
  });

  it('rejects a service the environment does not declare and picks the web start command', () => {
    const spec = projectSpecSchema.parse({ version: 1, project: 'p', environments: { testing: { hosting: { provider: 'aws', engine: 'opentofu' },
      services: { worker: { workloadKind: 'worker', startCommand: 'npm run worker' }, web: { startCommand: 'npm start' } } } } });
    const environment = spec.environments.testing!;
    expect(selectReleaseWorkloads(environment, ['web', 'ghost'])).toEqual({ blocked: 'ghost is not a service in this environment.' });
    expect(selectReleaseWorkloads(environment, undefined)).toEqual({ selected: ['worker', 'web'], web: 'web', startCommand: 'npm start' });
  });

  it('packages the committed files with the generated Dockerfile and excludes uncommitted changes', async () => {
    const repository = path.join(directory, 'repo');
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    execFileSync('git', ['init', '-q', repository]);
    writeFileSync(path.join(repository, 'app.js'), 'committed\n');
    git('add', '.'); git('commit', '-q', '-m', 'first');
    writeFileSync(path.join(repository, 'app.js'), 'uncommitted\n');
    const packaged = await packageLocalCommit(repository, { format: 'tar.gz', dockerfileName: '.hv.Dockerfile',
      dockerfileFor: (existing) => `FROM scratch # had=${existing !== undefined}`, addFiles: { 'extra/loader.cjs': 'loader' } });
    if ('blocked' in packaged) throw new Error(packaged.blocked);
    expect(packaged.commitSha).toBe(git('rev-parse', 'HEAD').trim());
    expect(packaged.uncommittedChangesExcluded).toBe(true);
    const archive = path.join(directory, 'source.tar.gz');
    writeFileSync(archive, packaged.archive);
    const read = (name: string) => execFileSync('tar', ['-xzOf', archive, name], { encoding: 'utf8' });
    expect(read('app.js')).toBe('committed\n');
    expect(read('.hv.Dockerfile')).toBe('FROM scratch # had=false');
    expect(read('extra/loader.cjs')).toBe('loader');
    expect(await packageLocalCommit(path.join(directory, 'missing'), { format: 'zip', dockerfileName: 'D', dockerfileFor: () => '' }))
      .toEqual({ blocked: expect.stringContaining('could not package this repository') });
  });
});

it.each([{ imageHasDockerfile: undefined, change: 'create' }, { imageHasDockerfile: false, change: 'create' }, { imageHasDockerfile: true, change: 'create' }, { imageHasDockerfile: undefined, change: 'noop' }])('checks Dockerfile evidence when a plan uses an earlier image (proof $imageHasDockerfile, action $change)', async ({ imageHasDockerfile, change }) => {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'image-app', defaultPlatform: 'aws' });
  ctx.repos.environments.create({ projectId: project.id, name: 'testing', platformBindings: { aws: { imageUri: `111122223333.dkr.ecr.us-west-2.amazonaws.com/hv-image-app-testing@sha256:${'a'.repeat(64)}`, webImageUri: `111122223333.dkr.ecr.us-west-2.amazonaws.com/hv-image-app-testing@sha256:${'b'.repeat(64)}`, imageHasDockerfile }, services: { admin: {} } } });
  const accountId = '111122223333'; const region = 'us-west-2';
  const connection = ctx.repos.connections.create({ provider: 'aws', scope: project.name, credentialsEncrypted: getSecretStore().encryptObject({ accountId, region,
    roleArn: `arn:aws:iam::${accountId}:role/hypervibe/hypervibe-deploy`, accessKeyId: 'LOCALACCESSKEY1234', secretAccessKey: 'private-local-secret-32-characters' }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  vi.spyOn(backend, 'awsEngineAuthentication').mockResolvedValue({ env: {}, redact: [] });
  vi.spyOn(setup, 'awsAccessCurrent').mockResolvedValue('current');
  const action = { id: 'service:plain', type: change, verified: true, reason: 'New web service', resource: { kind: 'service', name: 'plain', provider: 'aws' } };
  const plan = vi.fn(async () => ({ ok: true, blockers: [], actions: [action] }));
  vi.spyOn(shared, 'openTofuEngine').mockResolvedValue({ plan } as never);
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { testing: { hosting: { provider: 'aws', engine: 'opentofu' },
    services: { admin: { startCommand: 'node admin.js' }, plain: {} } } } });
  const result = await awsEngine.planAwsInfrastructureEngine(ctx, { project, spec, specRevision: 1, environmentName: 'testing' });
  if (imageHasDockerfile || change === 'noop') expect(result).toHaveProperty('actions');
  else expect(result).toMatchObject({ blocked: [expect.stringMatching(/Dockerfile/)] });
});

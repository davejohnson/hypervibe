import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
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
  return { target, recorded, run };
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

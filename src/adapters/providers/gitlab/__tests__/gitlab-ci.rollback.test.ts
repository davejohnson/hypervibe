import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { SecretStore } from '../../../secrets/secret-store.js';
import { SpecStore } from '../../../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../../../domain/spec/spec.schema.js';

const observeManagedProgram = vi.hoisted(() => vi.fn());

vi.mock('../gitlab-ci.lifecycle.js', () => ({
  observeGitLabManagedProgram: observeManagedProgram,
}));

import { executeGitLabCiRollback } from '../gitlab-ci.rollback.js';

const currentSha = 'a'.repeat(40);
const targetSha = 'b'.repeat(40);
const programHash = 'c'.repeat(64);
const repository = {
  provider: 'gitlab',
  nativeId: '42',
  instanceScope: 'https://gitlab.com',
  canonicalScope: 'https://gitlab.com/acme/storefront',
  path: 'acme/storefront',
  defaultBranch: 'main',
  webUrl: 'https://gitlab.com/acme/storefront',
  cloneUrls: ['https://gitlab.com/acme/storefront.git'],
};
const spec = projectSpecSchema.parse({
  version: 1,
  project: 'storefront',
  gitRemoteUrl: repository.cloneUrls[0],
  runtime: { kind: 'node', version: '22' },
  devops: {
    code: { provider: 'gitlab', scope: repository.canonicalScope },
    ci: { provider: 'gitlab-ci' },
  },
  environments: {
    production: {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web', startCommand: 'npm start' } },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: false },
    },
  },
});

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-gitlab-rollback-'));
  previousDataDir = process.env.HYPERVIBE_DATA_DIR;
  process.env.HYPERVIBE_DATA_DIR = dataDir;
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(dataDir, 'test.db')).migrate();
  observeManagedProgram.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  if (previousDataDir === undefined) delete process.env.HYPERVIBE_DATA_DIR;
  else process.env.HYPERVIBE_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function seed() {
  const project = new ProjectRepository().create({
    name: spec.project,
    defaultPlatform: 'railway',
    gitRemoteUrl: spec.gitRemoteUrl,
  });
  new SpecStore().replace(project, spec);
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
  });
  return { project, environment };
}

function program(tagState: { sha?: string }) {
  const mutationOrder: string[] = [];
  const adapter = {
    listRuns: vi.fn().mockResolvedValue([
      { id: '20', name: 'Pipeline 20', phase: 'succeeded', nativeStatus: 'success', sha: currentSha, createdAt: '2026-08-18T12:00:00Z' },
      { id: '19', name: 'Pipeline 19', phase: 'succeeded', nativeStatus: 'success', sha: targetSha, createdAt: '2026-08-17T12:00:00Z' },
    ]),
    listJobs: vi.fn().mockImplementation(async (_repository, pipelineId: string) => ([{
      id: pipelineId === '20' ? '200' : '190',
      attempt: 'current',
      name: 'hypervibe:deploy:railway:production',
      phase: 'succeeded',
      nativeStatus: 'success',
      completedAt: pipelineId === '20' ? '2026-08-18T12:10:00Z' : '2026-08-17T12:10:00Z',
    }])),
    readJobArtifactFile: vi.fn().mockImplementation(async (_repository, jobId: string) => {
      const current = jobId === '200';
      return {
        state: 'present',
        value: JSON.stringify({
          version: 1,
          provider: 'railway',
          repository: repository.canonicalScope,
          environment: 'production',
          sha: current ? currentSha : targetSha,
          programFingerprint: programHash,
        }),
      };
    }),
    observeTag: vi.fn().mockImplementation(async () => (
      tagState.sha ? { state: 'present', value: { name: 'rollback', sha: tagState.sha } } : { state: 'absent' }
    )),
    createTag: vi.fn().mockImplementation(async (_repository, _tag, sha: string) => {
      mutationOrder.push('tag');
      tagState.sha = sha;
    }),
    dispatch: vi.fn().mockImplementation(async (_repository, request) => {
      mutationOrder.push('dispatch');
      return { id: '21', name: 'Pipeline 21', phase: 'queued', nativeStatus: 'pending', sha: request.sha, ref: request.ref };
    }),
  };
  observeManagedProgram.mockResolvedValue({
    adapter,
    repository,
    project: { id: 42 },
    rootPath: '.gitlab-ci.yml',
    ref: 'main',
    programHash,
    deployJobName: 'hypervibe:deploy:railway:production',
    hostingProvider: 'railway',
  });
  return { adapter, mutationOrder };
}

describe('GitLab CI rollback', () => {
  it('creates one immutable evidence-bound tag before dispatching the rollback pipeline', async () => {
    const { project, environment } = seed();
    const tagState: { sha?: string } = {};
    const { adapter, mutationOrder } = program(tagState);

    const result = await executeGitLabCiRollback({ project, environment });

    expect(result).toMatchObject({
      ok: true,
      success: false,
      pending: true,
      status: 'pending',
      rollbackToSha: targetSha,
      currentSha,
      sourceArtifactId: '190:.hypervibe-release.json',
      sourceWorkflowRunId: '19',
      observedLatestWorkflowRunId: '20',
      selection: 'previous_successful',
    });
    expect(mutationOrder).toEqual(['tag', 'dispatch']);
    expect(adapter.createTag).toHaveBeenCalledWith(
      repository,
      `hypervibe-rollback-production-${targetSha.slice(0, 12)}-190`,
      targetSha
    );
    expect(adapter.dispatch).toHaveBeenCalledWith(repository, expect.objectContaining({
      definition: '.gitlab-ci.yml',
      ref: `hypervibe-rollback-production-${targetSha.slice(0, 12)}-190`,
      sha: targetSha,
      inputs: expect.objectContaining({
        rollback: 'true',
        expected_latest_run_id: '20',
        source_artifact_id: '190:.hypervibe-release.json',
        source_pipeline_id: '19',
      }),
    }));
  });

  it('blocks a rollback-tag collision and never dispatches', async () => {
    const { project, environment } = seed();
    const { adapter, mutationOrder } = program({ sha: 'd'.repeat(40) });

    const result = await executeGitLabCiRollback({ project, environment });

    expect(result).toMatchObject({ ok: true, success: false, status: 'blocked' });
    expect(mutationOrder).toEqual([]);
    expect(adapter.createTag).not.toHaveBeenCalled();
    expect(adapter.dispatch).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGitLabDeploymentGateRuntime } from '../gitlab-ci.lifecycle.js';

const sha = 'a'.repeat(40);

function deployment(input: {
  id: number;
  jobId: number;
  pipelineId: number;
  ref?: string;
}) {
  return {
    id: input.id,
    ref: input.ref ?? 'main',
    sha,
    environment: { name: 'production' },
    deployable: {
      id: input.jobId,
      pipeline: { id: input.pipelineId },
    },
  };
}

function stubBaseEnvironment(): void {
  vi.stubEnv('CI_API_V4_URL', 'https://gitlab.example.com/api/v4');
  vi.stubEnv('CI_PROJECT_ID', '42');
  vi.stubEnv('CI_JOB_ID', '200');
  vi.stubEnv('CI_PIPELINE_ID', '20');
  vi.stubEnv('CI_JOB_TOKEN', 'job-token');
  vi.stubEnv('CI_COMMIT_SHA', sha);
  vi.stubEnv('CI_COMMIT_REF_NAME', 'main');
  vi.stubEnv('HYPERVIBE_ENVIRONMENT', 'production');
  vi.stubEnv('HYPERVIBE_ROLLBACK', 'false');
  vi.stubEnv('HYPERVIBE_EXPECTED_LATEST_RUN_ID', '');
  vi.stubEnv('HYPERVIBE_SOURCE_ARTIFACT_ID', '');
  vi.stubEnv('HYPERVIBE_SOURCE_PIPELINE_ID', '');
}

async function runGate(deployments: unknown[]): Promise<void> {
  stubBaseEnvironment();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(deployments), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
  const source = Buffer.from(buildGitLabDeploymentGateRuntime(), 'utf8').toString('base64');
  await import(`data:text/javascript;base64,${source}#${Math.random()}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GitLab deployment-order gate', () => {
  it('allows only the exact current deployment identity', async () => {
    await expect(runGate([
      deployment({ id: 100, jobId: 200, pipelineId: 20 }),
      deployment({ id: 99, jobId: 190, pipelineId: 19 }),
    ])).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/v4/projects/42/deployments' }),
      expect.objectContaining({ headers: expect.objectContaining({ 'JOB-TOKEN': 'job-token' }) })
    );
  });

  it('rejects the current job when a newer environment deployment exists', async () => {
    await expect(runGate([
      deployment({ id: 101, jobId: 220, pipelineId: 22 }),
      deployment({ id: 100, jobId: 200, pipelineId: 20 }),
    ])).rejects.toThrow('newer GitLab deployment');
  });

  it('binds rollback execution to reviewed pipeline and artifact ordering', async () => {
    stubBaseEnvironment();
    vi.stubEnv('CI_PIPELINE_ID', '21');
    vi.stubEnv('CI_COMMIT_REF_NAME', `hypervibe-rollback-production-${sha.slice(0, 12)}-190`);
    vi.stubEnv('HYPERVIBE_ROLLBACK', 'true');
    vi.stubEnv('HYPERVIBE_EXPECTED_LATEST_RUN_ID', '20');
    vi.stubEnv('HYPERVIBE_SOURCE_ARTIFACT_ID', '190:.hypervibe-release.json');
    vi.stubEnv('HYPERVIBE_SOURCE_PIPELINE_ID', '19');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      deployment({ id: 101, jobId: 200, pipelineId: 21, ref: `hypervibe-rollback-production-${sha.slice(0, 12)}-190` }),
      deployment({ id: 100, jobId: 199, pipelineId: 20 }),
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const source = Buffer.from(buildGitLabDeploymentGateRuntime(), 'utf8').toString('base64');
    await expect(import(`data:text/javascript;base64,${source}#rollback-${Math.random()}`))
      .resolves.toBeDefined();
  });
});

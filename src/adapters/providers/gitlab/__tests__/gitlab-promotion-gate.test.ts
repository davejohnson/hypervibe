import { afterEach, describe, expect, it, vi } from 'vitest';
import { environmentDeploymentContractHash } from '../../../../domain/services/deployment-contract.service.js';
import { buildGitLabPromotionGateRuntime } from '../gitlab-ci.lifecycle.js';

const sha = 'a'.repeat(40);
const wrongSha = 'b'.repeat(40);
const sourceJob = 'hypervibe:deploy:railway:staging';
const programFingerprint = 'c'.repeat(64);
const deploymentSpec = {
  version: 1,
  project: 'storefront',
  gitRemoteUrl: 'https://gitlab.com/acme/storefront',
  environments: {
    staging: { hosting: { provider: 'railway' } },
  },
  secrets: {},
};
const deploymentContractFingerprint = environmentDeploymentContractHash(deploymentSpec, 'staging');
const providerIdentity = {
  projectId: 'rail-project',
  environmentId: 'rail-staging',
};

function sourceDeployment(deployedSha = sha) {
  return {
    id: 91,
    status: 'success',
    sha: deployedSha,
    environment: { name: 'staging' },
    deployable: {
      id: 190,
      name: sourceJob,
      status: 'success',
      pipeline: { id: 19, sha: deployedSha, status: 'success' },
    },
  };
}

function sourceEvidence(deployedSha = sha) {
  return {
    version: 2,
    provider: 'railway',
    repository: 'https://gitlab.com/acme/storefront',
    environment: 'staging',
    sha: deployedSha,
    programFingerprint,
    deploymentContractFingerprint,
    services: ['web'],
    providerIdentity,
    providerResources: [],
    ci: { projectId: '42', pipelineId: '19', jobId: '190' },
    deployments: [{ deploymentId: 'railway-deployment' }],
  };
}

type PromotionMutation = {
  label: string;
  mutateDeployment?: (deployment: ReturnType<typeof sourceDeployment>) => void;
  mutateEvidence?: (evidence: ReturnType<typeof sourceEvidence>) => void;
  expectedError?: string;
};

function stubEnvironment(): void {
  vi.stubEnv('CI_API_V4_URL', 'https://gitlab.example.com/api/v4');
  vi.stubEnv('CI_PROJECT_ID', '42');
  vi.stubEnv('CI_JOB_TOKEN', 'job-token');
  vi.stubEnv('HYPERVIBE_REPOSITORY', 'https://gitlab.com/acme/storefront');
  vi.stubEnv('HYPERVIBE_PROMOTE_FROM_ENVIRONMENT', 'staging');
  vi.stubEnv('HYPERVIBE_PROMOTE_FROM_PROVIDER', 'railway');
  vi.stubEnv('HYPERVIBE_PROMOTE_FROM_JOB', sourceJob);
  vi.stubEnv('HYPERVIBE_PROMOTION_SHA', sha);
  vi.stubEnv('HYPERVIBE_PROGRAM_FINGERPRINT', programFingerprint);
  vi.stubEnv('HYPERVIBE_PROMOTION_DEPLOYMENT_CONTRACT_FINGERPRINT', deploymentContractFingerprint);
  vi.stubEnv('HYPERVIBE_PROMOTION_SERVICES', JSON.stringify(['web']));
  vi.stubEnv('HYPERVIBE_PROMOTION_PROVIDER_IDENTITY', JSON.stringify(providerIdentity));
  vi.stubEnv('HYPERVIBE_PROMOTION_PROVIDER_RESOURCES', '[]');
  vi.stubEnv('HYPERVIBE_PROMOTION_REQUIRES_IMMUTABLE_IMAGE', 'false');
}

async function executeRuntime(): Promise<void> {
  const runtime = buildGitLabPromotionGateRuntime().replace(
    "import { readFile } from 'node:fs/promises';",
    `const readFile = async () => ${JSON.stringify(JSON.stringify(deploymentSpec))};`
  );
  const source = Buffer.from(runtime, 'utf8').toString('base64');
  await import(`data:text/javascript;base64,${source}#${Math.random()}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GitLab exact-SHA promotion gate', () => {
  it('accepts a successful source deployment with matching unexpired release evidence', async () => {
    stubEnvironment();
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/deployments')) {
        return new Response(JSON.stringify([sourceDeployment()]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/jobs/190/artifacts/.hypervibe-release.json')) {
        return new Response(JSON.stringify(sourceEvidence()), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeRuntime()).resolves.toBeUndefined();
    const deploymentsUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(deploymentsUrl.pathname).toBe('/api/v4/projects/42/deployments');
    expect(Object.fromEntries(deploymentsUrl.searchParams)).toMatchObject({
      environment: 'staging',
      status: 'success',
      order_by: 'id',
      sort: 'desc',
      per_page: '100',
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { Accept: 'application/json', 'JOB-TOKEN': 'job-token' },
    });
  });

  it('rejects missing or expired source release artifacts', async () => {
    stubEnvironment();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/deployments')
        ? new Response(JSON.stringify([sourceDeployment()]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('artifact not found', { status: 404 });
    }));

    await expect(executeRuntime()).rejects.toThrow(
      `No unexpired Hypervibe staging release artifact for ${sha} was found`
    );
  });

  it('rejects successful source deployment evidence for another SHA', async () => {
    stubEnvironment();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      sourceDeployment(wrongSha),
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeRuntime()).rejects.toThrow(
      `No successful staging deployment of ${sha} was found`
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('finds exact source deployment evidence beyond the newest 100 deployments', async () => {
    stubEnvironment();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...sourceDeployment(wrongSha),
      id: 1000 - index,
      deployable: {
        ...sourceDeployment(wrongSha).deployable,
        id: 1000 + index,
      },
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/deployments') && url.searchParams.get('page') === '1') {
        return new Response(JSON.stringify(firstPage), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Next-Page': '2' },
        });
      }
      if (url.pathname.endsWith('/deployments') && url.searchParams.get('page') === '2') {
        return new Response(JSON.stringify([sourceDeployment()]), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Next-Page': '' },
        });
      }
      if (url.pathname.endsWith('/jobs/190/artifacts/.hypervibe-release.json')) {
        return new Response(JSON.stringify(sourceEvidence()), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeRuntime()).resolves.toBeUndefined();
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('page')).toBe('1');
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('page')).toBe('2');
  });

  it('rejects evidence that does not name the exact reviewed source service set', async () => {
    stubEnvironment();
    const evidence = sourceEvidence();
    evidence.services = ['api'];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/deployments')
        ? new Response(JSON.stringify([sourceDeployment()]), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify(evidence), { status: 200 });
    }));

    await expect(executeRuntime()).rejects.toThrow(
      `No unexpired Hypervibe staging release artifact for ${sha} was found`
    );
  });

  it.each<PromotionMutation>([
    {
      label: 'provider',
      mutateEvidence: (evidence) => { evidence.provider = 'cloudrun'; },
    },
    {
      label: 'repository',
      mutateEvidence: (evidence) => { evidence.repository = 'https://gitlab.com/acme/other'; },
    },
    {
      label: 'program fingerprint',
      mutateEvidence: (evidence) => { evidence.programFingerprint = 'd'.repeat(64); },
    },
    {
      label: 'deployment contract fingerprint',
      mutateEvidence: (evidence) => { evidence.deploymentContractFingerprint = 'e'.repeat(64); },
    },
    {
      label: 'provider identity',
      mutateEvidence: (evidence) => {
        evidence.providerIdentity = { ...providerIdentity, environmentId: 'rail-production' };
      },
    },
    {
      label: 'managed source job',
      mutateDeployment: (deployment) => { deployment.deployable.name = 'unreviewed:deploy:job'; },
      expectedError: `No successful staging deployment of ${sha} was found for exact managed job ${sourceJob}`,
    },
    {
      label: 'CI project identity',
      mutateEvidence: (evidence) => { evidence.ci = { ...evidence.ci, projectId: '43' }; },
    },
    {
      label: 'CI pipeline identity',
      mutateEvidence: (evidence) => { evidence.ci = { ...evidence.ci, pipelineId: '18' }; },
    },
    {
      label: 'CI job identity',
      mutateEvidence: (evidence) => { evidence.ci = { ...evidence.ci, jobId: '191' }; },
    },
  ])('rejects evidence with a different $label', async ({ mutateDeployment, mutateEvidence, expectedError }) => {
    stubEnvironment();
    const deployment = sourceDeployment();
    const evidence = sourceEvidence();
    mutateDeployment?.(deployment);
    mutateEvidence?.(evidence);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/deployments')
        ? new Response(JSON.stringify([deployment]), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify(evidence), { status: 200 });
    }));

    await expect(executeRuntime()).rejects.toThrow(
      expectedError ?? `No unexpired Hypervibe staging release artifact for ${sha} was found`
    );
  });

  it('requires an immutable image digest when the source recipe declares one', async () => {
    stubEnvironment();
    vi.stubEnv('HYPERVIBE_PROMOTION_REQUIRES_IMMUTABLE_IMAGE', 'true');
    const evidence = { ...sourceEvidence(), imageUri: 'us-central1-docker.pkg.dev/gcp-project/infraprint/app:latest' };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/deployments')
        ? new Response(JSON.stringify([sourceDeployment()]), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify(evidence), { status: 200 });
    }));

    await expect(executeRuntime()).rejects.toThrow(
      `No unexpired Hypervibe staging release artifact for ${sha} was found`
    );
  });
});

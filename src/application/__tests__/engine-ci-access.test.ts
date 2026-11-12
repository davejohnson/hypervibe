import { afterEach, describe, expect, it, vi } from 'vitest';
import { grantCiReleaseAccess } from '../infrastructure-engine-ci.js';
import { runGcpProjectSetup } from '../../domain/services/gcp-project-setup.service.js';

vi.mock('../../domain/services/gcp-project-setup.service.js', () => ({
  runGcpProjectSetup: vi.fn(async () => ({ success: true, mode: 'preview', planId: 'reviewed-ci-plan', actions: [] })),
}));

afterEach(() => vi.unstubAllGlobals());

describe('GCP CI infrastructure ownership', () => {
  it('previews CI access without creating identities, enabling APIs, or changing IAM directly', async () => {
    // Synthetic transport responses. The independent contract is the user's
    // OpenTofu-only infrastructure requirement; POST setup calls violate it.
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ name: 'projects/123456789', projectId: 'example-project', state: 'ACTIVE' }), { status: 200 });
    }));
    await grantCiReleaseAccess({ projectId: 'local-project', adminToken: 'synthetic-token', gcpProjectId: 'example-project',
      repository: 'owner/app', runtimeServiceAccountEmail: 'runtime@example-project.iam.gserviceaccount.com', confirm: false } as Parameters<typeof grantCiReleaseAccess>[0]);
    expect(requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    expect(runGcpProjectSetup).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'local-project', gcpProjectId: 'example-project', confirm: false,
      contribution: expect.objectContaining({ id: 'ci-release' }),
    }));
    const configuration = vi.mocked(runGcpProjectSetup).mock.calls.at(-1)![0].contribution.configuration;
    expect(JSON.stringify(configuration)).not.toContain('synthetic-token');
    expect(configuration.resources['google_iam_workload_identity_pool_provider.ci_github']).toBeDefined();
  });
});

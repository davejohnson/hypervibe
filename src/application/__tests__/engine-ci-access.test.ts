import { runInNewContext } from 'node:vm';
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
      repository: 'owner/app', repositoryId: '1234', releases: [{ environmentName: 'production', branch: 'main', autoDeploy: false }], runtimeServiceAccountEmail: 'runtime@example-project.iam.gserviceaccount.com', confirm: false } as Parameters<typeof grantCiReleaseAccess>[0]);
    expect(requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    expect(runGcpProjectSetup).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'local-project', gcpProjectId: 'example-project', confirm: false,
      contribution: expect.objectContaining({ id: 'ci-release' }),
    }));
    const configuration = vi.mocked(runGcpProjectSetup).mock.calls.at(-1)![0].contribution.configuration;
    expect(JSON.stringify(configuration)).not.toContain('synthetic-token');
    const resources = (configuration.files['ci-release.tf.json'] as any).resource;
    const condition = resources.google_iam_workload_identity_pool_provider.ci_github.attribute_condition;
    const claims = { repository: 'owner/app', repository_id: '1234', workflow_ref: 'owner/app/.github/workflows/hypervibe-release-production.yml@refs/heads/main',
      ref: 'refs/heads/main', environment: 'production', event_name: 'workflow_dispatch' };
    const admits = (changes: Record<string, string>) => runInNewContext(condition, { assertion: { ...claims, ...changes } });
    expect(admits({})).toBe(true);
    for (const changed of [{ repository_id: '4321' }, { repository: 'owner/other' }, { ref: 'refs/heads/dev' }, { environment: 'staging' },
      { workflow_ref: 'owner/app/.github/workflows/check.yml@refs/heads/main' }, { event_name: 'push' }]) expect(admits(changed as Record<string, string>)).toBe(false);
    expect(resources.google_service_account_iam_member.ci_github.member).toContain('/attribute.repository_id/1234');
    expect(configuration.resources['google_iam_workload_identity_pool_provider.ci_github']).toBeDefined();
  });
});

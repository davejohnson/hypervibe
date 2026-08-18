import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabAdapter, GitLabCredentialsSchema } from '../gitlab.adapter.js';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function adapter(): GitLabAdapter {
  const value = new GitLabAdapter();
  value.connect({ apiToken: 'glpat-secret', instanceUrl: 'https://gitlab.example.com/gitlab' });
  return value;
}

const project = {
  id: 42,
  path_with_namespace: 'acme/apps/storefront',
  default_branch: 'main',
  web_url: 'https://gitlab.example.com/gitlab/acme/apps/storefront',
  http_url_to_repo: 'https://gitlab.example.com/gitlab/acme/apps/storefront.git',
  ssh_url_to_repo: 'git@gitlab.example.com:acme/apps/storefront.git',
};

afterEach(() => vi.restoreAllMocks());

describe('GitLab repository identity', () => {
  it('binds nested projects by instance-scoped numeric id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(project));

    await expect(adapter().observeRepository(project.web_url)).resolves.toEqual({
      state: 'present',
      value: {
        provider: 'gitlab',
        nativeId: '42',
        instanceScope: 'https://gitlab.example.com/gitlab',
        canonicalScope: project.web_url,
        path: project.path_with_namespace,
        defaultBranch: 'main',
        webUrl: project.web_url,
        cloneUrls: [project.http_url_to_repo, project.ssh_url_to_repo],
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example.com/gitlab/api/v4/projects/acme%2Fapps%2Fstorefront',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('treats only provider-confirmed not-found as absence', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ message: 'forbidden' }, 403));
    await expect(adapter().observeRepository(project.web_url)).resolves.toMatchObject({
      state: 'unknown',
      reason: expect.stringContaining('HTTP 403'),
    });

    vi.mocked(globalThis.fetch).mockResolvedValue(json({ message: 'not found' }, 404));
    await expect(adapter().observeRepository(project.web_url)).resolves.toEqual({ state: 'absent' });
  });

  it('keeps uninitialized projects unknown instead of treating them as absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ...project, default_branch: null }));
    await expect(adapter().observeRepository(project.web_url)).resolves.toMatchObject({
      state: 'unknown',
      reason: expect.stringContaining('not initialized'),
    });
  });

  it('carries the observed file revision into atomic update actions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      id: 'b'.repeat(40),
      web_url: `${project.web_url}/-/commit/${'b'.repeat(40)}`,
    }));
    const repository = {
      provider: 'gitlab',
      nativeId: '42',
      instanceScope: 'https://gitlab.example.com/gitlab',
      canonicalScope: project.web_url,
      path: project.path_with_namespace,
      defaultBranch: 'main',
      webUrl: project.web_url,
      cloneUrls: [project.http_url_to_repo, project.ssh_url_to_repo],
    };

    await adapter().createCommit(repository, {
      branch: 'hypervibe/config',
      startSha: 'a'.repeat(40),
      commitMessage: 'Update managed config',
      actions: [{
        action: 'update',
        path: '.gitlab-ci.yml',
        content: 'stages: [deploy]\n',
        lastCommitId: 'c'.repeat(40),
      }],
    });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      actions: [{
        action: 'update',
        file_path: '.gitlab-ci.yml',
        last_commit_id: 'c'.repeat(40),
      }],
    });
  });
});

describe('GitLab CI variables', () => {
  it('fingerprints plaintext values and erases them from the observation boundary', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([{
      key: 'RAILWAY_API_TOKEN',
      value: 'railway-super-secret',
      protected: true,
      masked: true,
      hidden: true,
      environment_scope: 'production',
    }]));

    const result = await adapter().listVariables('42');
    expect(result).toEqual([expect.objectContaining({
      key: 'RAILWAY_API_TOKEN',
      scope: 'production',
      protected: true,
      masked: true,
      hidden: true,
      valueVisibility: 'plaintext',
      valueHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })]);
    expect(JSON.stringify(result)).not.toContain('railway-super-secret');
  });

  it('requires the durable registry pull credential pair together', () => {
    expect(GitLabCredentialsSchema.safeParse({
      apiToken: 'api',
      registryUsername: 'deploy-token-user',
    }).success).toBe(false);
    expect(GitLabCredentialsSchema.safeParse({
      apiToken: 'api',
      registryUsername: 'deploy-token-user',
      registryReadToken: 'read-registry-token',
    }).success).toBe(true);
  });

  it('verifies the durable registry credential without returning provider bodies or tokens', async () => {
    const value = new GitLabAdapter();
    value.connect({
      apiToken: 'api-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
      registryUsername: 'deploy-token-user',
      registryReadToken: 'registry-secret',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ message: 'registry-secret was rejected' }, 401));

    const result = await value.verifyRegistryPull(project);
    expect(result).toEqual({
      success: false,
      error: 'GitLab registry authentication returned HTTP 401',
    });
    expect(JSON.stringify(result)).not.toContain('registry-secret');
  });

  it('rejects an auth token that lacks pull on the exact project repository', async () => {
    const value = new GitLabAdapter();
    value.connect({
      apiToken: 'api-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
      registryUsername: 'deploy-token-user',
      registryReadToken: 'registry-secret',
    });
    const claims = Buffer.from(JSON.stringify({
      access: [{ type: 'repository', name: 'acme/other-project', actions: ['pull'] }],
    })).toString('base64url');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ token: `header.${claims}.signature` }));

    await expect(value.verifyRegistryPull(project)).resolves.toEqual({
      success: false,
      error: 'GitLab registry authentication did not grant pull access to the exact project repository',
    });
  });
});

describe('GitLab runner trust observation', () => {
  it('preserves runner ownership and availability for provider-owned policy checks', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([{
      id: 7,
      runner_type: 'instance_type',
      status: 'online',
      paused: false,
      tag_list: ['saas-linux-small-amd64'],
    }]));

    await expect(adapter().listProjectRunners('42', 'saas-linux-small-amd64')).resolves.toEqual([{
      id: '7',
      runnerType: 'instance_type',
      status: 'online',
      paused: false,
      tags: ['saas-linux-small-amd64'],
    }]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/projects/42/runners?tag_list=saas-linux-small-amd64'),
      expect.objectContaining({ method: 'GET' })
    );
  });
});

describe('GitLab pipeline dispatch', () => {
  it('dispatches only the active definition and verifies the exact ref SHA', async () => {
    const sha = 'a'.repeat(40);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(project))
      .mockResolvedValueOnce(json(project))
      .mockResolvedValueOnce(json({ name: 'main', commit: { id: sha } }))
      .mockResolvedValueOnce(json({
        id: 99,
        status: 'pending',
        ref: 'main',
        sha,
        web_url: `${project.web_url}/-/pipelines/99`,
      }));
    const repository = (await adapter().observeRepository(project.web_url));
    expect(repository.state).toBe('present');
    if (repository.state !== 'present') return;

    await expect(adapter().dispatch(repository.value, {
      definition: '.gitlab-ci.yml',
      ref: 'main',
      sha,
      inputs: { environment: 'production', commit_sha: sha },
    })).resolves.toMatchObject({ id: '99', phase: 'queued', sha });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://gitlab.example.com/gitlab/api/v4/projects/42/pipeline?ref=main',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ inputs: { environment: 'production', commit_sha: sha } }),
      })
    );
  });

  it('rejects a GitLab dispatch without an exact reviewed SHA before creating a pipeline', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(project))
      .mockResolvedValueOnce(json(project));
    const repository = await adapter().observeRepository(project.web_url);
    expect(repository.state).toBe('present');
    if (repository.state !== 'present') return;

    await expect(adapter().dispatch(repository.value, {
      definition: '.gitlab-ci.yml',
      ref: 'main',
      inputs: { environment: 'production' },
    })).rejects.toThrow('requires an exact reviewed commit SHA');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

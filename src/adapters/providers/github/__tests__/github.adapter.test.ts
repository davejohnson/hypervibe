import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
}

function connectedAdapter(): GitHubAdapter {
  const adapter = new GitHubAdapter();
  adapter.connect({ apiToken: 'test-token' });
  return adapter;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitHub Actions environment variables', () => {
  it('returns null when an environment variable is absent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ message: 'Not Found' }, 404)
    );

    await expect(
      connectedAdapter().getEnvironmentVariable(
        'dave',
        'app',
        'staging',
        'HYPERVIBE_APPLIED_SPEC_HASH'
      )
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/dave/app/environments/staging/variables/HYPERVIBE_APPLIED_SPEC_HASH',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('creates a missing GitHub environment and its hash variable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(response({ id: 1 }))
      .mockResolvedValueOnce(response({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(response(undefined, 204));

    await connectedAdapter().setEnvironmentVariable(
      'dave',
      'app',
      'staging',
      'HYPERVIBE_APPLIED_SPEC_HASH',
      'abc123'
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/dave/app/environments/staging',
      expect.objectContaining({ method: 'PUT', body: '{}' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://api.github.com/repos/dave/app/environments/staging/variables',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'HYPERVIBE_APPLIED_SPEC_HASH', value: 'abc123' }),
      })
    );
  });

  it('updates an existing environment variable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ id: 1 }))
      .mockResolvedValueOnce(response({
        name: 'HYPERVIBE_APPLIED_SPEC_HASH',
        value: 'old',
      }))
      .mockResolvedValueOnce(response(undefined, 204));

    await connectedAdapter().setEnvironmentVariable(
      'dave',
      'app',
      'production',
      'HYPERVIBE_APPLIED_SPEC_HASH',
      'new'
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/repos/dave/app/environments/production/variables/HYPERVIBE_APPLIED_SPEC_HASH',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'HYPERVIBE_APPLIED_SPEC_HASH', value: 'new' }),
      })
    );
  });
});

describe('GitHub Actions environment secrets', () => {
  it('deletes an environment-scoped secret', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(undefined, 204));

    await connectedAdapter().deleteEnvironmentSecret(
      'dave',
      'app',
      'production/us',
      'MATCH_PASSWORD'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/dave/app/environments/production%2Fus/secrets/MATCH_PASSWORD',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});

describe('GitHub Actions release evidence', () => {
  it('uses a workflow filename as the encoded route id for run reads and dispatches', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ total_count: 0, workflow_runs: [] }))
      .mockResolvedValueOnce(response(undefined, 204));
    const adapter = connectedAdapter();

    await adapter.listWorkflowRuns('dave', 'app', '.github/workflows/hypervibe pages.yml');
    await adapter.triggerWorkflow('dave', 'app', '.github/workflows/hypervibe pages.yml', 'main');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/dave/app/actions/workflows/hypervibe%20pages.yml/runs',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/dave/app/actions/workflows/hypervibe%20pages.yml/dispatches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ref: 'main', inputs: {} }),
      })
    );
  });

  it('scopes artifact reads to the exact workflow run', async () => {
    const payload = {
      total_count: 1,
      artifacts: [{
        id: 7,
        name: 'hypervibe-server-release-production-0123456789abcdef0123456789abcdef01234567',
        expired: false,
        created_at: '2026-07-31T10:00:00Z',
        updated_at: '2026-07-31T10:00:00Z',
        workflow_run: {
          id: 42,
          repository_id: 1,
          head_repository_id: 1,
          head_branch: 'main',
          head_sha: '0123456789abcdef0123456789abcdef01234567',
        },
      }],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(payload));

    await expect(
      connectedAdapter().listWorkflowRunArtifacts('dave', 'app', 42)
    ).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/dave/app/actions/runs/42/artifacts?per_page=100',
      expect.objectContaining({ method: 'GET' })
    );
  });
});

describe('GitHub repository infrastructure', () => {
  const unicodeWorkflow = 'Deployment blocked — Hypervibe reconciliation required 🚧\n';

  it('writes Unicode file content as UTF-8 Base64', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ sha: 'existing-sha', content: '' }))
      .mockResolvedValueOnce(response({ content: { sha: 'updated-sha' } }));

    await connectedAdapter().createOrUpdateFile(
      'dave',
      'app',
      '.github/workflows/deploy.yml',
      unicodeWorkflow,
      'Update deploy workflow'
    );

    const request = fetchMock.mock.calls[1]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe(unicodeWorkflow);
  });

  it('reads Unicode file content from UTF-8 Base64', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      content: Buffer.from(unicodeWorkflow, 'utf8').toString('base64'),
    }));

    await expect(
      connectedAdapter().getFileContent('dave', 'app', '.github/workflows/deploy.yml')
    ).resolves.toBe(unicodeWorkflow);
  });

  it('reads branch-scoped Unicode file content from UTF-8 Base64', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      sha: 'workflow-sha',
      content: Buffer.from(unicodeWorkflow, 'utf8').toString('base64'),
    }));

    await expect(
      connectedAdapter().getFile('dave', 'app', '.github/workflows/deploy.yml', 'managed')
    ).resolves.toEqual({ sha: 'workflow-sha', content: unicodeWorkflow });
  });

  it('fast-forwards managed refs without force', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(undefined, 204));

    await connectedAdapter().updateRef('dave', 'app', 'heads/hypervibe/github-infrastructure', 'abc123');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/dave/app/git/refs/heads%2Fhypervibe%2Fgithub-infrastructure',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ sha: 'abc123', force: false }),
      })
    );
  });

  it('force-updates a managed ref only when explicitly requested', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(undefined, 204));

    await connectedAdapter().updateRef(
      'dave',
      'app',
      'heads/hypervibe/github-infrastructure',
      'base123',
      { force: true }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/dave/app/git/refs/heads%2Fhypervibe%2Fgithub-infrastructure',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ sha: 'base123', force: true }),
      })
    );
  });

  it('returns pull request provenance for an exact managed head and base', async () => {
    const pull = {
      number: 56,
      html_url: 'https://github.com/dave/app/pull/56',
      title: '[Hypervibe] Sync GitHub infrastructure',
      body: 'Hypervibe generated this pull request.',
      state: 'closed',
      merged_at: '2026-07-28T01:42:56Z',
      head: { ref: 'hypervibe/github-infrastructure', sha: 'head123' },
      base: { ref: 'main', sha: 'base-at-open' },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([pull]));

    await expect(connectedAdapter().listPullRequests('dave', 'app', {
      state: 'closed',
      head: 'dave:hypervibe/github-infrastructure',
      base: 'main',
    })).resolves.toEqual([pull]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/dave/app/pulls?state=closed&per_page=100&head=dave%3Ahypervibe%2Fgithub-infrastructure&base=main',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('sends branch-scoped file deletion metadata', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(undefined, 204));

    await connectedAdapter().deleteFile('dave', 'app', '.github/old.yml', 'deadbeef', 'Remove old file', 'managed');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/dave/app/contents/.github/old.yml',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ message: 'Remove old file', sha: 'deadbeef', branch: 'managed' }),
      })
    );
  });

  it('preserves default workflow permissions while allowing Actions pull requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }))
      .mockResolvedValueOnce(response(undefined, 204));

    await connectedAdapter().allowActionsPullRequests('dave', 'app');

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/dave/app/actions/permissions/workflow',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: true }),
      })
    );
  });
});

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

describe('GitHub repository infrastructure', () => {
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

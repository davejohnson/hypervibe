import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';

function adapterWith(request: ReturnType<typeof vi.fn>): RailwayAdapter {
  const adapter = new RailwayAdapter();
  (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
  return adapter;
}

describe('RailwayAdapter.listProjects', () => {
  it('uses the top-level projects query so workspace projects are included', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      projects: {
        edges: [
          { node: { id: 'p-personal', name: 'personal-app' } },
          { node: { id: 'p-workspace', name: 'workspace-app' } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const projects = await adapterWith(request).listProjects();

    expect(projects.map((p) => p.name)).toEqual(['personal-app', 'workspace-app']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toContain('projects(first: 100');
  });

  it('paginates through all pages', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        projects: {
          edges: [{ node: { id: 'p-1', name: 'one' } }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      })
      .mockResolvedValueOnce({
        projects: {
          edges: [{ node: { id: 'p-2', name: 'two' } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    const projects = await adapterWith(request).listProjects();

    expect(projects.map((p) => p.id)).toEqual(['p-1', 'p-2']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ after: 'cursor-1' });
  });

  it('falls back to me.projects when the top-level query is rejected', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('Not authorized to query projects'))
      .mockResolvedValueOnce({
        me: {
          projects: {
            edges: [{ node: { id: 'p-personal', name: 'personal-app' } }],
          },
        },
      });

    const projects = await adapterWith(request).listProjects();

    expect(projects.map((p) => p.id)).toEqual(['p-personal']);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('throws when not connected', async () => {
    const adapter = new RailwayAdapter();
    await expect(adapter.listProjects()).rejects.toThrow('Not connected');
  });
});

describe('RailwayAdapter.isGitHubRepoAccessible', () => {
  it('returns hasAccess from gitHubRepoAccessAvailable', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      gitHubRepoAccessAvailable: { hasAccess: false, isPublic: false },
    });

    const accessible = await adapterWith(request).isGitHubRepoAccessible('dave/seq-planner');

    expect(accessible).toBe(false);
    expect(request.mock.calls[0]?.[1]).toEqual({ fullRepoName: 'dave/seq-planner' });
  });

  it('returns null when the query fails or the adapter is not connected', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Cannot query field'));
    expect(await adapterWith(request).isGitHubRepoAccessible('dave/seq-planner')).toBeNull();

    const adapter = new RailwayAdapter();
    expect(await adapter.isGitHubRepoAccessible('dave/seq-planner')).toBeNull();
  });
});

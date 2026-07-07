import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function makeEnv(bindings: Record<string, unknown> = {}): Environment {
  return {
    id: 'env-1',
    projectId: 'proj-1',
    name: 'staging',
    platformBindings: bindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RailwayAdapter.ensureProject', () => {
  it('reuses an existing project by name before attempting create', async () => {
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = {
      request: vi.fn(),
    };
    vi.spyOn(adapter, 'findProjectsByName').mockResolvedValue([{ id: 'railway-1', name: 'billforge' }]);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(true);
    expect(receipt.data?.projectId).toBe('railway-1');
    expect(receipt.data?.created).toBe(false);
    expect((adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client.request).not.toHaveBeenCalled();
  });

  it('refuses to guess when multiple same-name projects are visible', async () => {
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = {
      request: vi.fn(),
    };
    vi.spyOn(adapter, 'findProjectsByName').mockResolvedValue([
      { id: 'railway-1', name: 'billforge' },
      { id: 'railway-2', name: 'billforge' },
    ]);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('Multiple Railway projects named "billforge" are visible');
    expect(receipt.error).toContain('railway-1');
    expect(receipt.error).toContain('railway-2');
    expect(receipt.data?.duplicateProjectIds).toEqual(['railway-1', 'railway-2']);
    expect((adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client.request).not.toHaveBeenCalled();
  });

  it('refuses to create when existing-project lookup fails', async () => {
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = {
      request: vi.fn(),
    };
    vi.spyOn(adapter, 'findProjectsByName').mockRejectedValue(new Error('list unavailable'));

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('refused to create a new project');
    expect(receipt.error).toContain('list unavailable');
    expect((adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client.request).not.toHaveBeenCalled();
  });

  it('falls back to alternate create mutation shapes when first create attempt fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        me: { workspaces: { edges: [{ node: { id: 'ws-1' } }] } },
      })
      .mockRejectedValueOnce(new Error('Unknown field "teamId"'))
      .mockResolvedValueOnce({
        projectCreate: { id: 'railway-2', name: 'billforge' },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    (adapter as unknown as { credentials: { teamId?: string } }).credentials = { teamId: 'team-1' };
    vi.spyOn(adapter, 'findProjectsByName').mockResolvedValue([]);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(true);
    expect(receipt.data?.projectId).toBe('railway-2');
    expect(request).toHaveBeenCalledTimes(3);
  });
});

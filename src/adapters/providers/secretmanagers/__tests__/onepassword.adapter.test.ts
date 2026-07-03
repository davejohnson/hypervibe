import { beforeEach, describe, expect, it, vi } from 'vitest';

const createClient = vi.fn();
vi.mock('@1password/sdk', () => ({ createClient }));

import { OnePasswordAdapter } from '../onepassword.adapter.js';

describe('OnePasswordAdapter', () => {
  beforeEach(() => {
    createClient.mockReset();
  });

  it('resolves a secret via op:// reference with explicit field', async () => {
    const resolve = vi.fn().mockResolvedValue('s3cret');
    createClient.mockResolvedValue({ secrets: { resolve, resolveAll: vi.fn() } });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    const result = await adapter.getSecret('Production/stripe', 'secret-key');

    expect(result.value).toBe('s3cret');
    expect(resolve).toHaveBeenCalledWith('op://Production/stripe/secret-key');
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'ops_token' })
    );
  });

  it('defaults to the password field when no key is given', async () => {
    const resolve = vi.fn().mockResolvedValue('hunter2');
    createClient.mockResolvedValue({ secrets: { resolve, resolveAll: vi.fn() } });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    await adapter.getSecret('Production/db');

    expect(resolve).toHaveBeenCalledWith('op://Production/db/password');
  });

  it('batches getSecrets through resolveAll and maps errors per reference', async () => {
    const resolveAll = vi.fn().mockResolvedValue({
      individualResponses: {
        'op://Prod/api/token': { content: { secret: 'tok-123' } },
        'op://Prod/missing/password': { error: { type: 'fieldNotFound', message: 'no such field' } },
      },
    });
    createClient.mockResolvedValue({ secrets: { resolve: vi.fn(), resolveAll } });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    const results = await adapter.getSecrets([
      { provider: '1password', path: 'Prod/api', key: 'token', raw: '1password://Prod/api#token' },
      { provider: '1password', path: 'Prod/missing', raw: '1password://Prod/missing' },
    ]);

    expect(results.get('1password://Prod/api#token')).toEqual({ value: 'tok-123' });
    expect(results.get('1password://Prod/missing')).toEqual({
      value: '',
      metadata: { error: 'fieldNotFound: no such field' },
    });
  });

  it('verify reports failure when the client cannot authenticate', async () => {
    createClient.mockRejectedValue(new Error('invalid service account token'));

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'bad' });
    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid service account token');
  });

  it('verify succeeds when the service account can see at least one vault', async () => {
    createClient.mockResolvedValue({
      secrets: { resolve: vi.fn(), resolveAll: vi.fn() },
      vaults: { list: vi.fn().mockResolvedValue([{ id: 'v1', title: 'Production' }]) },
      items: { list: vi.fn() },
    });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(result.identity).toBe('1Password service account');
  });

  it('verify fails with a clear message when the token has no vault access', async () => {
    createClient.mockResolvedValue({
      secrets: { resolve: vi.fn(), resolveAll: vi.fn() },
      vaults: { list: vi.fn().mockResolvedValue([]) },
      items: { list: vi.fn() },
    });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('no vaults');
  });

  it('lists secrets as vault/item paths, filtered by prefix', async () => {
    const itemsList = vi.fn(async (vaultId: string) => {
      if (vaultId === 'v1') {
        return [{ id: 'i1', title: 'stripe' }, { id: 'i2', title: 'db' }];
      }
      return [{ id: 'i3', title: 'stripe' }];
    });
    createClient.mockResolvedValue({
      secrets: { resolve: vi.fn(), resolveAll: vi.fn() },
      vaults: {
        list: vi.fn().mockResolvedValue([
          { id: 'v1', title: 'Production' },
          { id: 'v2', title: 'Staging' },
        ]),
      },
      items: { list: itemsList },
    });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });

    const all = await adapter.listSecrets();
    expect(all.map((item) => item.path).sort()).toEqual([
      'Production/db',
      'Production/stripe',
      'Staging/stripe',
    ]);

    const filtered = await adapter.listSecrets('Production/');
    expect(filtered.map((item) => item.path).sort()).toEqual([
      'Production/db',
      'Production/stripe',
    ]);
  });

  it('rejects writes with a resolve-only explanation', async () => {
    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    const receipt = await adapter.setSecret('Prod/api', { token: 'x' });
    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('resolve-only');
  });
});

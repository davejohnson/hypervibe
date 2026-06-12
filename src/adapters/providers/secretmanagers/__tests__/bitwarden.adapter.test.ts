import { beforeEach, describe, expect, it, vi } from 'vitest';

const loginAccessToken = vi.fn();
const secretsGet = vi.fn();
const secretsList = vi.fn();
const BitwardenClient = vi.fn(function (this: unknown) {
  return {
    auth: () => ({ loginAccessToken }),
    secrets: () => ({ get: secretsGet, list: secretsList }),
  };
});
vi.mock('@bitwarden/sdk-napi', () => ({ BitwardenClient }));

import { BitwardenAdapter } from '../bitwarden.adapter.js';

const CREDS = { accessToken: '0.token', organizationId: 'org-1' };
const SECRET_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('BitwardenAdapter', () => {
  beforeEach(() => {
    loginAccessToken.mockReset().mockResolvedValue(undefined);
    secretsGet.mockReset();
    secretsList.mockReset();
    BitwardenClient.mockClear();
  });

  it('logs in with the machine account access token', async () => {
    secretsGet.mockResolvedValue({ id: SECRET_ID, key: 'DATABASE_URL', value: 'postgres://x' });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    await adapter.getSecret(SECRET_ID);

    expect(loginAccessToken).toHaveBeenCalledWith('0.token');
  });

  it('fetches a secret directly by uuid', async () => {
    secretsGet.mockResolvedValue({ id: SECRET_ID, key: 'DATABASE_URL', value: 'postgres://x' });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    const result = await adapter.getSecret(SECRET_ID);

    expect(result.value).toBe('postgres://x');
    expect(secretsGet).toHaveBeenCalledWith(SECRET_ID);
    expect(secretsList).not.toHaveBeenCalled();
  });

  it('resolves a secret by key name via the org list', async () => {
    secretsList.mockResolvedValue({ data: [{ id: SECRET_ID, key: 'STRIPE_KEY' }] });
    secretsGet.mockResolvedValue({ id: SECRET_ID, key: 'STRIPE_KEY', value: 'sk_live_x' });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    const result = await adapter.getSecret('STRIPE_KEY');

    expect(result.value).toBe('sk_live_x');
    expect(secretsList).toHaveBeenCalledWith('org-1');
    expect(secretsGet).toHaveBeenCalledWith(SECRET_ID);
  });

  it('returns per-reference errors from getSecrets', async () => {
    secretsList.mockResolvedValue({ data: [{ id: SECRET_ID, key: 'KNOWN' }] });
    secretsGet.mockResolvedValue({ id: SECRET_ID, key: 'KNOWN', value: 'v' });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    const results = await adapter.getSecrets([
      { provider: 'bitwarden', path: 'KNOWN', raw: 'bitwarden://KNOWN' },
      { provider: 'bitwarden', path: 'MISSING', raw: 'bitwarden://MISSING' },
    ]);

    expect(results.get('bitwarden://KNOWN')).toEqual({ value: 'v' });
    expect(results.get('bitwarden://MISSING')?.metadata?.error).toContain('No Bitwarden secret named "MISSING"');
  });

  it('verify lists org secrets and reports identity', async () => {
    secretsList.mockResolvedValue({ data: [] });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(result.identity).toContain('org-1');
  });

  it('rejects writes with a resolve-only explanation', async () => {
    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    const receipt = await adapter.setSecret('ANY', { x: 'y' });
    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('resolve-only');
  });
});

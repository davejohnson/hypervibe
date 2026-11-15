import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudRequestClient, fieldSchema } from '../cloud-request-client.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const environmentId = '22222222-2222-4222-8222-222222222222';
const scope = { baseUrl: 'https://hypervibe.dev', token: 'synthetic-private-grant', projectId, environmentId };
afterEach(() => vi.unstubAllGlobals());

describe('credential field discovery wire contract', () => {
  it('accepts a server-generated discovery label longer than the editable request label', async () => {
    // Pinned Hypercloud fieldsForSource replaces underscores without truncation;
    // requestFields separately caps owner-supplied labels at 120 characters.
    const key = 'A'.repeat(128);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      source: { revision: 'a'.repeat(40), digest: 'b'.repeat(64) },
      sourceError: null, selectedEnvironmentId: environmentId,
      sourceBranch: 'main', environments: [{ id: environmentId, name: 'Staging', preferred: true }],
      availableFields: [{ key, label: key, inputType: 'password' }],
    }));
    vi.stubGlobal('fetch', transport);
    const result = await createCloudRequestClient(scope).fields('main');
    expect(result.availableFields).toEqual([{ key, label: key, inputType: 'password' }]);
    expect(fieldSchema.safeParse({ key, label: key, inputType: 'password' }).success).toBe(false);
    const [url, init] = transport.mock.calls[0];
    expect(new URL(String(url)).searchParams.get('environmentId')).toBe(environmentId);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  });
});

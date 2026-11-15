import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHypervibeCloudPairingClient,
  normalizeHypervibeCloudBaseUrl,
} from '../cloud-pairing.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Hypervibe cloud pairing client', () => {
  it('sends the optional setup branch without changing the strict public response or approval URL contract', async () => {
    // Synthetic response under the owner-approved request-only extension:
    // existing servers/clients keep the same public create/exchange shapes.
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      deviceCode: 'A'.repeat(43), expiresAt: '2026-10-04T12:10:00.000Z', intervalSeconds: 2,
      repository: 'northstar/launchpad', userCode: '2345-6789', verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789',
    }));
    const result = await createHypervibeCloudPairingClient({ fetchImpl }).start('northstar/launchpad', 'integration/security');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ repositoryFullName: 'northstar/launchpad', sourceBranch: 'integration/security' });
    expect(result).not.toHaveProperty('sourceBranch');
    expect(result.verificationUrl).toBe('https://hypervibe.dev/pair?code=2345-6789');
  });
  it.each([
    `https://hypervibe.dev/pair?code=2345-6789&echo=${'A'.repeat(43)}`,
    `https://hypervibe.dev/pair?code=2345-6789&code=${'A'.repeat(43)}`,
    `https://hypervibe.dev/pair?code=2345-6789#${'A'.repeat(43)}`,
  ])('rejects unexpected approval URL components without exposing the private proof (%#)', async (verificationUrl) => {
    // Pinned Hypercloud devicePairingService constructs /pair with one public
    // code parameter. No private device proof belongs in the displayed URL.
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      deviceCode: 'A'.repeat(43), expiresAt: '2026-10-03T12:10:00.000Z',
      intervalSeconds: 2, repository: 'northstar/launchpad', userCode: '2345-6789',
      verificationUrl, purpose: 'credential-requests', environment: 'staging',
    }), { status: 201 }));
    await expect(createHypervibeCloudPairingClient({ fetchImpl,
      grant: { purpose: 'credential-requests', environment: 'staging' },
    }).start('northstar/launchpad')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR', message: expect.not.stringContaining('A'.repeat(43)),
    });
  });

  it('requests separate provider-connection authority without expanding reporting grants', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      deviceCode: 'A'.repeat(43), expiresAt: '2026-09-20T12:10:00.000Z',
      intervalSeconds: 2, repository: 'northstar/launchpad', userCode: '2345-6789',
      verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789',
      purpose: 'provider-connections',
    }), { status: 201 }));
    await createHypervibeCloudPairingClient({ fetchImpl, purpose: 'provider-connections' }).start('northstar/launchpad');
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      repositoryFullName: 'northstar/launchpad', purpose: 'provider-connections',
    });
  });

  it('uses the exact repository and accepts a bounded same-origin pairing response', async () => {
    const deviceCode = 'A'.repeat(43);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      deviceCode,
      expiresAt: '2026-08-27T20:10:00.000Z',
      intervalSeconds: 2,
      repository: 'northstar/launchpad',
      userCode: '2345-6789',
      verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789',
    }), { status: 201, headers: { 'content-type': 'application/json' } }));

    const result = await createHypervibeCloudPairingClient({ fetchImpl }).start(
      'northstar/launchpad'
    );

    expect(result.userCode).toBe('2345-6789');
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://hypervibe.dev/api/v1/pairings'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ repositoryFullName: 'northstar/launchpad' }),
        redirect: 'error',
      })
    );
  });

  it('rejects non-HTTPS non-loopback URLs and unsafe approval redirects', async () => {
    expect(() => normalizeHypervibeCloudBaseUrl('http://hypervibe.dev')).toThrow(
      'requires HTTPS'
    );
    expect(normalizeHypervibeCloudBaseUrl('http://127.0.0.1:3000')).toBe(
      'http://127.0.0.1:3000'
    );

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      deviceCode: 'A'.repeat(43),
      expiresAt: '2026-08-27T20:10:00.000Z',
      intervalSeconds: 2,
      repository: 'northstar/launchpad',
      userCode: '2345-6789',
      verificationUrl: 'https://attacker.example/pair?code=2345-6789',
    }), { status: 201 }));
    await expect(
      createHypervibeCloudPairingClient({ fetchImpl }).start('northstar/launchpad')
    ).rejects.toThrow('unsafe pairing URL');
  });

  it('returns bounded errors without exposing an arbitrary provider response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: `Pairing failed\n${'x'.repeat(400)}` },
      internal: 'do-not-expose',
    }), { status: 400 }));

    await expect(
      createHypervibeCloudPairingClient({ fetchImpl }).exchange('A'.repeat(43))
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.not.stringContaining('do-not-expose'),
    });
  });

  it('maps network failures to one actionable safe error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket path and secret internals');
    });
    await expect(
      createHypervibeCloudPairingClient({ fetchImpl }).start('northstar/launchpad')
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'Could not reach Hypervibe cloud.',
    });
  });
});

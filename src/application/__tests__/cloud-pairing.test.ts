import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHypervibeCloudPairingClient,
  normalizeHypervibeCloudBaseUrl,
} from '../cloud-pairing.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Hypervibe cloud pairing client', () => {
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

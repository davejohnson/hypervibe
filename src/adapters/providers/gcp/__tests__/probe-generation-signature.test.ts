import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { signedObjectUrl } from '../gcp-data.client.js';

it('binds the disposable object generation into the canonical V4 signature', () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const url = new URL(
    signedObjectUrl({
      clientEmail: 'deployer@example.invalid',
      privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      bucket: 'bucket',
      object: 'migrations/prod/probe',
      method: 'GET',
      expiresSeconds: 900,
      generation: '123',
      now: new Date('2026-11-07T00:00:00Z'),
    }),
  );
  expect(url.searchParams.get('generation')).toBe('123');
  const sig = url.searchParams.get('X-Goog-Signature')!;
  const entries = [...url.searchParams]
    .filter(([k]) => k !== 'X-Goog-Signature')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  const req = ['GET', url.pathname, entries, 'host:storage.googleapis.com', '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const str = [
    'GOOG4-RSA-SHA256',
    '20261107T000000Z',
    '20261107/auto/storage/goog4_request',
    createHash('sha256').update(req).digest('hex'),
  ].join('\n');
  expect(createVerify('RSA-SHA256').update(str).verify(key.publicKey, sig, 'hex')).toBe(true);
});

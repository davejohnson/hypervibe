import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { dpopProof } from '../aws-sign-in.js';

describe('AWS sign-in', () => {
  it('signs a DPoP proof AWS can verify with the embedded public key', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const [header, payload, signature] = dpopProof(privateKey, 'https://us-east-1.signin.aws.amazon.com/v1/token').split('.');
    const decoded = JSON.parse(Buffer.from(header!, 'base64url').toString());
    expect(decoded).toMatchObject({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256' } });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ htm: 'POST', htu: 'https://us-east-1.signin.aws.amazon.com/v1/token' });
    const publicKey = crypto.createPublicKey({ key: decoded.jwk, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true);
  });
});

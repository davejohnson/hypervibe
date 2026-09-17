import { describe, expect, it } from 'vitest';
import { serviceSpecSchema } from '../spec.schema.js';

describe('service volume intent', () => {
  it('accepts an explicit persistent mount without bucket credentials or capacity guesses', () => {
    expect(serviceSpecSchema.parse({ volume: { mountPath: '/data' } })).toMatchObject({
      workloadKind: 'web', volume: { mountPath: '/data' },
    });
  });

  it.each(['/', 'data', '/data/../app', '/data/', '/data//media', '/data\u0000'])('rejects unsafe or noncanonical path %j', (mountPath) => {
    expect(serviceSpecSchema.safeParse({ volume: { mountPath } }).success).toBe(false);
  });

  it('does not silently accept unimplemented sizing or deletion policy', () => {
    expect(serviceSpecSchema.safeParse({ volume: { mountPath: '/data', sizeGB: 5 } }).success).toBe(false);
    expect(serviceSpecSchema.safeParse({ volume: { mountPath: '/data', retain: false } }).success).toBe(false);
  });
});

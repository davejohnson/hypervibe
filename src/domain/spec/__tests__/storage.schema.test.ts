import { describe, expect, it } from 'vitest';
import { environmentSpecSchema, storageSpecSchema } from '../spec.schema.js';

describe('storage spec', () => {
  it('accepts Railway storage targeting declared services across hosting providers', () => {
    expect(environmentSpecSchema.safeParse({
      hosting: { provider: 'cloudrun' },
      services: { api: {}, worker: { workloadKind: 'worker' } },
      storage: { uploads: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['api', 'worker'] } },
    }).success).toBe(true);
  });

  it('requires a supported region and at least one service', () => {
    expect(storageSpecSchema.safeParse({ provider: 'railway', type: 'bucket', region: 'xyz', injectInto: ['api'] }).success).toBe(false);
    expect(storageSpecSchema.safeParse({ provider: 'railway', type: 'bucket', region: 'sjc', injectInto: [] }).success).toBe(false);
  });

  it('rejects storage targets that are not declared services', () => {
    const result = environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' }, services: { api: {} },
      storage: { uploads: { provider: 'railway', type: 'bucket', region: 'iad', injectInto: ['missing'] } },
    });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('not declared');
  });

  it('rejects two buckets targeting one service because AWS variable names would collide', () => {
    expect(environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' }, services: { api: {} },
      storage: {
        uploads: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['api'] },
        documents: { provider: 'railway', type: 'bucket', region: 'iad', injectInto: ['api'] },
      },
    }).success).toBe(false);
  });
});

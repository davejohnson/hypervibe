import { describe, expect, it } from 'vitest';
import { environmentSpecSchema } from '../spec.schema.js';

describe('load-balancer spec', () => {
  it('accepts two declared public web origins and applies the health path default', () => {
    const result = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      domain: 'app.example.com',
      services: { webA: {}, webB: { public: true } },
      loadBalancer: { provider: 'cloudflare', services: ['webA', 'webB'] },
    });
    expect(result.loadBalancer).toEqual({
      provider: 'cloudflare',
      services: ['webA', 'webB'],
      healthCheckPath: '/health',
    });
  });

  it('requires a domain and two unique known public web services', () => {
    const invalid = [
      {
        hosting: { provider: 'railway' }, services: { a: {}, b: {} },
        loadBalancer: { provider: 'cloudflare', services: ['a', 'b'] },
      },
      {
        hosting: { provider: 'railway' }, domain: 'app.example.com', services: { a: {}, b: {} },
        loadBalancer: { provider: 'cloudflare', services: ['a', 'a'] },
      },
      {
        hosting: { provider: 'railway' }, domain: 'app.example.com', services: { a: {}, worker: { workloadKind: 'worker' } },
        loadBalancer: { provider: 'cloudflare', services: ['a', 'worker'] },
      },
      {
        hosting: { provider: 'railway' }, domain: 'app.example.com', services: { a: {}, b: {} },
        loadBalancer: { provider: 'cloudflare', services: ['a', 'missing'] },
      },
    ];
    for (const candidate of invalid) {
      expect(environmentSpecSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('rejects non-absolute or whitespace-bearing health check paths', () => {
    expect(environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      domain: 'app.example.com',
      services: { a: {}, b: {} },
      loadBalancer: {
        provider: 'cloudflare',
        services: ['a', 'b'],
        healthCheckPath: 'health check',
      },
    }).success).toBe(false);
  });
});

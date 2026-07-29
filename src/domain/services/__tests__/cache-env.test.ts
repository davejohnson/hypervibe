import { describe, expect, it } from 'vitest';
import { buildCacheEnvVarsFromComponent } from '../cache-env.js';

describe('cache runtime environment', () => {
  it('wires only REDIS_URL for a Redis component', () => {
    const result = buildCacheEnvVarsFromComponent({
      id: 'cache-1',
      environmentId: 'env-1',
      type: 'redis',
      externalId: 'redis-live-1',
      bindings: {
        provider: 'railway',
        connectionUrl: '${{redis-db.REDIS_URL}}',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.envVars).toEqual({
      REDIS_URL: '${{redis-db.REDIS_URL}}',
    });
    expect(result.envVars).not.toHaveProperty('DATABASE_URL');
  });
});

import { describe, expect, it } from 'vitest';
import * as hosted from '../../hosted.js';

describe('transient hosted application secret generation', () => {
  it('provides the declared 32-byte format without opening local secret state', () => {
    expect(hosted).toHaveProperty('generateHostedSecretValueV1');
    const generate = (hosted as unknown as { generateHostedSecretValueV1: (input: unknown) => string }).generateHostedSecretValueV1;
    const first = generate({ generator: 'random-base64url-32-v1', generation: 1 });
    const second = generate({ generator: 'random-base64url-32-v1', generation: 1 });
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(second).not.toBe(first);
    expect(() => generate({ generator: 'unreviewed', generation: 1 })).toThrow();
  });
});

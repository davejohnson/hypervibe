import { describe, expect, it } from 'vitest';
import { HEALTH_CHECK_PATH_PATTERN } from '../health-check-path.js';

// #543: the path is joined to the service's own URL and passed to release tooling on every cloud.
describe('healthCheckPath', () => {
  it.each(['/', '/health', '/api/v1/health-check', '/healthz?deep=1&x=y', '/a.b_c~d/%20'])('accepts %j', (path) => {
    expect(HEALTH_CHECK_PATH_PATTERN.test(path)).toBe(true);
  });

  it.each(['health', '//other.example/x', '/\\other.example', 'https://other.example/x', '/$(env)', '/a b', '/a\nb', '/a;b', "/a'b", '/a`b`', '/a|b', '/a#b', '/${{ secrets.X }}'])(
    'refuses %j', (path) => {
      expect(HEALTH_CHECK_PATH_PATTERN.test(path)).toBe(false);
      // What the refusal prevents: a different host, or anything a URL parser or shell would reinterpret.
    });

  it('every accepted path stays on the service host', () => {
    for (const path of ['/', '/health', '/healthz?deep=1&x=y']) expect(new URL(path, 'https://app.example').host).toBe('app.example');
    expect(new URL('//other.example/x', 'https://app.example').host).toBe('other.example');
    expect(new URL('/\\other.example', 'https://app.example').host).toBe('other.example');
  });
});

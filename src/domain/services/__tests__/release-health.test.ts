import { describe, expect, it } from 'vitest';
import { healthCheckFailed, strictHealthCheck } from '../release-health.js';
import { RELEASE_SCRIPT } from '../../../adapters/providers/gcp/gcp-ci-release-script.js';

// #557: a release is healthy only if a declared health check on a public service answers below 400.
describe('release health rule', () => {
  it('is strict only for a declared path on a service the check can reach without credentials', () => {
    expect(strictHealthCheck({ healthCheckPath: '/health' })).toBe(true);
    expect(strictHealthCheck({ healthCheckPath: '/health', public: true })).toBe(true);
    // No declared path: the check falls back to "/", which many APIs answer with 404.
    expect(strictHealthCheck({})).toBe(false);
    // A private service answers 401/403 to an unauthenticated check by design.
    expect(strictHealthCheck({ healthCheckPath: '/health', public: false })).toBe(false);
  });

  it.each([[200, true, false], [302, true, false], [401, true, true], [404, true, true], [500, true, true], [404, false, false], [403, false, false], [500, false, true], [503, false, true]])(
    'HTTP %s with strict=%s fails: %s', (status, strict, failed) => { expect(healthCheckFailed(status, strict)).toBe(failed); });
});

describe('generated Google release program', () => {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;
  async function run(healthStatus: number, strict: boolean): Promise<void> {
    const service = { etag: 'e', uri: 'https://app.example', latestReadyRevision: 'r2', latestCreatedRevision: 'r2', template: { containers: [{ image: 'old' }] } };
    const fetchStub = async (url: string | URL, init: { method?: string; body?: string } = {}) => {
      if (String(url) === 'https://app.example/health') return new Response('x', { status: healthStatus });
      if (init.method === 'PATCH') { service.template.containers[0]!.image = JSON.parse(init.body!).template.containers[0].image; return Response.json({ done: true }); }
      return Response.json(service);
    };
    const processStub = { argv: ['node', 'release.mjs', 'web-abc', 'img@sha256:1', '/health', 'services', '-'], env: { GCP_TOKEN: 't', GCP_PROJECT: 'p', GCP_REGION: 'r', ...(strict ? { HYPERVIBE_HEALTH_STRICT: '1' } : {}) }, exit: () => undefined };
    await new AsyncFunction('process', 'fetch', 'console', RELEASE_SCRIPT)(processStub, fetchStub, { log: () => undefined });
  }

  it('fails the workflow when a declared health check answers 404', async () => {
    await expect(run(404, true)).rejects.toThrow('/health returned HTTP 404');
  });
  it('still releases on 200, and on 404 when the path was only the "/" fallback rule', async () => {
    await expect(run(200, true)).resolves.toBeUndefined();
    await expect(run(404, false)).resolves.toBeUndefined();
    await expect(run(503, false)).rejects.toThrow('returned HTTP 503');
  });
});

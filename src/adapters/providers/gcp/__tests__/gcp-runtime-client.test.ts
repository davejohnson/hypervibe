import { afterEach, describe, expect, it, vi } from 'vitest';
import { gcpRuntimeRequest } from '../gcp-runtime-client.js';

// Negative transport evidence: a stalled stream need not acknowledge AbortSignal.
// The runtime contract still requires bounded, value-free unknown outcomes.
afterEach(() => vi.useRealTimers());
describe('Google runtime HTTP boundary', () => {
  it('bounds a body that stalls after headers without requiring abort cooperation', async () => {
    vi.useFakeTimers(); let outcome = 'pending';
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })));
    const pending = gcpRuntimeRequest('https://secretmanager.googleapis.com/v1/projects/123/secrets/name', 'synthetic-token', {}, request)
      .then(() => { outcome = 'success'; }, error => { outcome = error.message; });
    await vi.advanceTimersByTimeAsync(15001);
    expect(outcome).toContain('did not return verifiable evidence');
    await pending;
  });
  it('respects a cancelled parent before sending authorization', async () => {
    const controller = new AbortController(); controller.abort();
    const request = vi.fn<typeof fetch>(async () => Response.json({ name: 'unexpected' }));
    await expect(gcpRuntimeRequest('https://iam.googleapis.com/v1/projects/example', 'synthetic-token', { signal: controller.signal }, request)).rejects.toThrow('did not return verifiable evidence');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects successful metadata that echoes the bearer in ordinary fields', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ name: 'projects/example', description: 'prefix synthetic-private-token suffix' }));
    await expect(gcpRuntimeRequest('https://iam.googleapis.com/v1/projects/example', 'synthetic-private-token', {}, request))
      .rejects.toThrow('did not return verifiable evidence');
  });
  it('classifies definite native absence while excluding echoed credential bodies', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('synthetic-token', { status: 404 }));
    expect(await gcpRuntimeRequest('https://iam.googleapis.com/v1/projects/example', 'synthetic-token', {}, request)).toBeNull();
    await expect(gcpRuntimeRequest('https://iam.googleapis.com/v1/projects/example', 'synthetic-token', { method: 'POST' }, request)).rejects.toThrow('HTTP 404');
  });
});

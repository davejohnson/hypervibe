import { describe, expect, it, vi } from 'vitest';
import { verifyAzureHoldingImage } from '../../src/adapters/providers/azure/azure-holding-image.js';
import { azureHoldingImageSchema } from '../../src/adapters/providers/azure/azure-prepared-hosting.js';

// Reconstructed official DockerImage GET transport, not a successful native pull.
// https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.dockerImages/get
// https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.dockerImages
const image = `us-central1-docker.pkg.dev/operator-project/public/holding@sha256:${'a'.repeat(64)}`;
const name = `projects/operator-project/locations/us-central1/repositories/public/dockerImages/holding@sha256:${'a'.repeat(64)}`;
const url = `https://artifactregistry.googleapis.com/v1/projects/operator-project/locations/us-central1/repositories/public/dockerImages/${encodeURIComponent(`holding@sha256:${'a'.repeat(64)}`)}`;
const signal = () => AbortSignal.timeout(1000);
describe('Azure public operator holding image proof', () => {
  it('requires exact anonymous native metadata for the configured digest', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ name, uri: image }));
    expect(azureHoldingImageSchema.parse(image)).toBe(image);
    await expect(verifyAzureHoldingImage(image, { fetch: request, signal: signal() })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
    expect(new Headers(request.mock.calls[0]![1]?.headers).has('authorization')).toBe(false);
  });
  it.each(['image:latest', image.replace('operator-project', '../other'), image.replace('-docker.pkg.dev', '-docker.pkg.dev.evil.test'),
    image.replace('/holding@', '/nested/../holding@')])('rejects unsafe or mutable references before transport: %s', async input => {
    const request = vi.fn<typeof fetch>();
    await expect(verifyAzureHoldingImage(input, { fetch: request, signal: signal() })).rejects.toThrow('public holding image');
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['wrong-name', 'wrong-digest', 'denied', 'redirected', 'different-response-url', 'oversized', 'malformed'])('rejects %s without echoing native content', async scenario => {
    const echo = 'synthetic-private-provider-echo';
    const request = vi.fn<typeof fetch>(async () => {
      if (scenario === 'denied') return Response.json({ error: echo }, { status: 403 });
      if (scenario === 'malformed') return new Response(echo);
      if (scenario === 'oversized') return new Response('x'.repeat(65537));
      const response = Response.json({ name: scenario === 'wrong-name' ? echo : name, uri: scenario === 'wrong-digest' ? echo : image });
      if (scenario === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
      if (scenario === 'different-response-url') Object.defineProperty(response, 'url', { value: 'https://other.example.test' });
      return response;
    });
    const error = await verifyAzureHoldingImage(image, { fetch: request, signal: signal() }).catch(e => e);
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain('public holding image'); expect(error.message).not.toContain(echo);
  });
  it('bounds body reads and cancels an interrupted stream', async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const request: typeof fetch = async () => new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('{')); queueMicrotask(() => controller.abort());
    }, cancel }));
    await expect(verifyAzureHoldingImage(image, { fetch: request, signal: controller.signal })).rejects.toThrow('public holding image');
    expect(cancel).toHaveBeenCalled();
  });
});

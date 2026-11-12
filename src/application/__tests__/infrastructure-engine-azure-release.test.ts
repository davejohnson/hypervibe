import { describe, expect, it } from 'vitest';
import { AzureTokens } from '../azure-ops.js';
import { azurePlatformError, buildWithAcrTasks, releaseAzureApp, templateWithImage } from '../infrastructure-engine-azure-release.js';

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
function fake(route: (method: string, url: string, body?: string) => Response) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url.startsWith('https://login.microsoftonline.com/')) return json(200, { access_token: 'token', expires_in: 3600 });
    return route(method, url, typeof init?.body === 'string' ? init.body : undefined);
  }) as typeof fetch;
  return { calls, tokens: new AzureTokens({ tenantId: 't', clientId: 'c', clientSecret: 's' }, fetchImpl) };
}
const registryId = '/subscriptions/s/resourceGroups/hv-app/providers/Microsoft.ContainerRegistry/registries/hvappshared123456';
const source = { commitSha: 'a'.repeat(40), archive: Buffer.from('tar'), uncommittedChangesExcluded: false };
const digest = `sha256:${'d'.repeat(64)}`;

describe('ACR Tasks builds', () => {
  it('uploads the exact commit, builds it remotely and returns the digest-pinned image', async () => {
    let polls = 0;
    const azure = fake((method, url) => {
      if (url.includes('listBuildSourceUploadUrl')) return json(200, { uploadUrl: 'https://blob.example/upload?sig=x', relativePath: 'source/123/src.tar.gz' });
      if (url.startsWith('https://blob.example/')) return new Response(null, { status: 201 });
      if (url.includes('scheduleRun')) return json(200, { properties: { runId: 'cb1' } });
      if (url.includes('listLogSasUrl')) return json(200, { logLink: 'https://logs.example/cb1' });
      if (url.includes('/runs/cb1?')) return json(200, { properties: polls++ ? { status: 'Succeeded', outputImages: [{ repository: 'app', tag: source.commitSha, digest }] } : { status: 'Running' } });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const built = await buildWithAcrTasks(azure.tokens, { registryId, loginServer: 'hvappshared123456.azurecr.io', source, pollMs: 1 });
    expect(built).toEqual({ image: `hvappshared123456.azurecr.io/app@${digest}`, logsUrl: 'https://logs.example/cb1' });
    const run = JSON.parse(azure.calls.find((call) => call.url.includes('scheduleRun'))!.body!);
    expect(run).toMatchObject({ type: 'DockerBuildRequest', imageNames: [`app:${source.commitSha}`], isPushEnabled: true, sourceLocation: 'source/123/src.tar.gz',
      platform: { os: 'Linux', architecture: 'amd64' } });
  });

  it('explains the free-credit pause and refuses a build without a digest', async () => {
    const base = (schedule: () => Response, run?: () => Response) => fake((_method, url) => {
      if (url.includes('listBuildSourceUploadUrl')) return json(200, { uploadUrl: 'https://blob.example/u', relativePath: 'p' });
      if (url.startsWith('https://blob.example/')) return new Response(null, { status: 201 });
      if (url.includes('scheduleRun')) return schedule();
      if (url.includes('listLogSasUrl')) return json(200, {});
      return run!();
    });
    const paused = base(() => json(400, { error: { code: 'TasksOperationsNotAllowed', message: 'paused' } }));
    await expect(buildWithAcrTasks(paused.tokens, { registryId, loginServer: 'r', source })).resolves.toEqual({ error: expect.stringMatching(/free-credit.*pay-as-you-go/) });
    const noDigest = base(() => json(200, { properties: { runId: 'cb2' } }), () => json(200, { properties: { status: 'Succeeded', outputImages: [{ repository: 'app', digest: 'latest' }] } }));
    await expect(buildWithAcrTasks(noDigest.tokens, { registryId, loginServer: 'r', source, pollMs: 1 })).resolves.toEqual({ error: expect.stringMatching(/refusing to release a mutable tag/) });
  });
});

describe('Container Apps releases', () => {
  const appId = '/subscriptions/s/resourceGroups/hv-app/providers/Microsoft.App/containerApps/hv-app-test-web';
  const template = { revisionSuffix: 'abc', containers: [{ name: 'app', image: 'old', env: [{ name: 'A', value: '1' }] }], scale: { minReplicas: 0 } };

  it('changes only the running image and drops the old revision suffix', () => {
    expect(templateWithImage(template, 'new')).toEqual({ containers: [{ name: 'app', image: 'new', env: [{ name: 'A', value: '1' }] }], scale: { minReplicas: 0 } });
  });

  it('is not fooled by the platform\'s own error pages', () => {
    expect(azurePlatformError(503, 'upstream connect error')).toMatch(/gateway/);
    expect(azurePlatformError(404, '<h1>Error 404 - This Container App is stopped or does not exist.</h1>')).toMatch(/stopped or does not exist/);
    expect(azurePlatformError(404, 'Not found')).toBeUndefined();
    expect(azurePlatformError(200, 'ok')).toBeUndefined();
  });

  const release = (health: () => Response, revisionHealth = 'Healthy') => fake((method, url) => {
    if (url.startsWith('https://hv-app-test-web.example.azurecontainerapps.io/')) return health();
    if (url.includes('/revisions/')) return json(200, { properties: { healthState: revisionHealth } });
    if (method === 'PATCH') return json(202);
    return json(200, { properties: { provisioningState: 'Succeeded', template, latestRevisionName: method === 'GET' && releaseCalls++ ? 'rev-2' : 'rev-1',
      configuration: { ingress: { fqdn: 'hv-app-test-web.example.azurecontainerapps.io' } } } });
  });
  let releaseCalls = 0;

  it('waits for the new revision, then checks health through the app\'s own answer', async () => {
    releaseCalls = 0;
    const azure = release(() => new Response('ok', { status: 200 }));
    const result = await releaseAzureApp(azure.tokens, { id: appId, name: 'web', image: 'img@sha256:1', healthCheckPath: '/health', web: true, waitMs: 1000, fetchTimeoutMs: 1, retryMs: 1 });
    expect(result).toMatchObject({ status: 'released', url: 'https://hv-app-test-web.example.azurecontainerapps.io', health: { status: 200, path: '/health' } });
    const patch = azure.calls.find((call) => call.method === 'PATCH')!;
    expect(JSON.parse(patch.body!).properties.template.containers[0].image).toBe('img@sha256:1');
  });

  it('fails a release whose app never answers, or that Azure reports unhealthy', async () => {
    releaseCalls = 0;
    const down = release(() => new Response('upstream connect error', { status: 503 }));
    await expect(releaseAzureApp(down.tokens, { id: appId, name: 'web', image: 'img', web: true, waitMs: 1000, fetchTimeoutMs: 1, retryMs: 1 })).resolves.toMatchObject({ status: 'failed', message: expect.stringMatching(/did not start/) });
    releaseCalls = 0;
    const unhealthy = release(() => new Response('ok', { status: 200 }), 'Unhealthy');
    await expect(releaseAzureApp(unhealthy.tokens, { id: appId, name: 'web', image: 'img', web: true, waitMs: 1000, fetchTimeoutMs: 1, retryMs: 1 })).resolves.toMatchObject({ status: 'failed', message: expect.stringMatching(/unhealthy/) });
  });
});

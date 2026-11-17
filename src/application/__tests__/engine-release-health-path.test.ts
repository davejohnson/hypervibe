import { LambdaClient } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseFunction } from '../../adapters/providers/aws/aws-release.client.js';
import { AzureTokens } from '../../adapters/providers/azure/azure-ops.client.js';
import { releaseAzureApp } from '../../adapters/providers/azure/azure-release.client.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { selectReleaseWorkloads } from '../engine-release.js';
import { releaseGcpEngineServices } from '../infrastructure-engine.js';

afterEach(() => vi.restoreAllMocks());

describe('stored health paths fail before direct release effects', () => {
  const invalidPaths = ['https://outside.example/health', '//outside.example/health', '/\\outside.example/health', '/health\ncheck'];

  function storedSpec(healthCheckPath: string) {
    const spec = projectSpecSchema.parse({ version: 1, project: 'test', environments: { test: { hosting: { provider: 'cloudrun' }, services: { web: {} } } } });
    // Simulate legacy stored state that predates the current spec validator.
    spec.environments.test!.services.web!.healthCheckPath = healthCheckPath;
    return spec;
  }

  it.each(invalidPaths)('blocks shared AWS/Azure release selection: %j', (healthCheckPath) => {
    const spec = storedSpec(healthCheckPath);
    expect(selectReleaseWorkloads(spec.environments.test!, undefined)).toMatchObject({ blocked: expect.stringMatching(/health.*path/i) });
  });

  it.each(invalidPaths)('blocks GCP before context access: %j', async (healthCheckPath) => {
    const spec = storedSpec(healthCheckPath);
    const context = new Proxy({}, { get() { throw new Error('Release must reject the path before reading context'); } });
    await expect(releaseGcpEngineServices(context as never, {
      project: {} as never, spec, environmentName: 'test', specRevision: 1,
    })).resolves.toMatchObject({ blocked: expect.stringMatching(/health.*path/i) });
  });

  it.each(invalidPaths)('rejects paths at the AWS provider boundary before requests: %j', async (healthCheckPath) => {
    const aws = vi.spyOn(LambdaClient.prototype, 'send').mockRejectedValue(new Error('Unexpected provider request'));
    await expect(releaseFunction({ region: 'us-east-1', accountId: '123456789012', prefix: 'test',
      credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic', sessionToken: 'synthetic' } },
    'web', 'test-web', 'image@sha256:abc', healthCheckPath)).rejects.toThrow(/health.*path/i);
    expect(aws).not.toHaveBeenCalled();
  });

  it.each(invalidPaths)('rejects paths at the Azure provider boundary before requests: %j', async (healthCheckPath) => {
    const azureFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected provider request'));
    const tokens = new AzureTokens({ tenantId: 't', clientId: 'c', clientSecret: 'synthetic' }, azureFetch);
    await expect(releaseAzureApp(tokens, { id: '/synthetic', name: 'web', image: 'image@sha256:abc', web: true, healthCheckPath })).rejects.toThrow(/health.*path/i);
    expect(azureFetch).not.toHaveBeenCalled();
  });
});

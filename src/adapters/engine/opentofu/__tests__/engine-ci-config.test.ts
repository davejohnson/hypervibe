/** Schema validation of the complete native CI identity graphs; no cloud auth or mutations. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAwsConfiguration } from '../../../providers/aws/tofu/aws-engine.config.js';
import { awsEngineBackend } from '../../../providers/aws/tofu/aws-engine.backend.js';
import { buildAzureBuildConfiguration, buildAzureEnvironmentConfiguration } from '../../../providers/azure/tofu/azure-engine.config.js';
import { fullEnvironmentInput } from '../../../providers/azure/tofu/__tests__/azure-fixtures.js';
import { azureEngineBackend } from '../../../providers/azure/tofu/azure-engine.backend.js';
import { OpenTofuEngine } from '../engine.js';
import { ensureEngineBinary } from '../install.js';

const cipher = { encrypt: (text: string) => Buffer.from(text).toString('base64'), decrypt: (text: string) => Buffer.from(text, 'base64').toString() };
const ci = { repository: 'owner/app', branch: 'main', environmentName: 'test' };
describe('CI identity graphs with pinned provider binaries', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-ci-identity-config-'));
  let engine: OpenTofuEngine;
  beforeAll(async () => {
    const previous = process.env.HYPERVIBE_DATA_DIR;
    process.env.HYPERVIBE_DATA_DIR = dataDir;
    try {
      const installed = await ensureEngineBinary();
      if (!installed.ok) throw new Error(installed.error);
      engine = new OpenTofuEngine({ binary: installed.binary, cipher, dataDir, pluginCacheDir: path.join(dataDir, 'plugins'), timeoutMs: 300_000 });
      fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });
    } finally {
      if (previous === undefined) delete process.env.HYPERVIBE_DATA_DIR;
      else process.env.HYPERVIBE_DATA_DIR = previous;
    }
  }, 300_000);
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  it('validates Azure workload-scoped CI identity, federation and role assignments', async () => {
    expect(await engine.validate(azureEngineBackend, buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, ci }))).toEqual({ ok: true });
    expect(await engine.validate(azureEngineBackend, buildAzureBuildConfiguration({ ...fullEnvironmentInput, ci, packageTokenKey: 'NPM_TOKEN' }))).toEqual({ ok: true });
    expect(await engine.validate(azureEngineBackend, buildAzureBuildConfiguration({ ...fullEnvironmentInput, ci }))).toEqual({ ok: true });
  }, 300_000);
  it('validates AWS OIDC role and release policy alongside web, worker and cron resources', async () => {
    const input = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-demo', environmentId: 'env1', parameterPath: '/hypervibe/env1/', ci,
      services: [{ logicalName: 'web', resourceName: 'hv-app-demo-web', initialImageUri: '111122223333.dkr.ecr.us-west-2.amazonaws.com/app:commit', public: true }],
      workers: [{ logicalName: 'worker', resourceName: 'hv-app-demo-worker', initialImageUri: '111122223333.dkr.ecr.us-west-2.amazonaws.com/app:commit' }],
      jobs: [{ logicalName: 'cron', resourceName: 'hv-app-demo-cron', initialImageUri: '111122223333.dkr.ecr.us-west-2.amazonaws.com/app:commit', schedule: '0 1 * * *' }],
    };
    expect(await engine.validate(awsEngineBackend, buildAwsConfiguration(input))).toEqual({ ok: true });
  }, 300_000);
});

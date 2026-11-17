/** Real pinned-provider configuration validation, without cloud credentials or mutations. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAwsBuildConfiguration, buildAwsConfiguration } from '../../../providers/aws/tofu/aws-engine.config.js';
import { awsEngineBackend } from '../../../providers/aws/tofu/aws-engine.backend.js';
import { buildAzureBuildConfiguration } from '../../../providers/azure/tofu/azure-engine.config.js';
import { fullEnvironmentInput } from '../../../providers/azure/tofu/__tests__/azure-fixtures.js';
import { azureEngineBackend } from '../../../providers/azure/tofu/azure-engine.backend.js';
import { OpenTofuEngine } from '../engine.js';
import { ensureEngineBinary } from '../install.js';

const cipher = { encrypt: (text: string) => Buffer.from(text).toString('base64'), decrypt: (text: string) => Buffer.from(text, 'base64').toString() };
describe('private package build configuration with pinned providers', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-build-token-config-'));
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
  it('validates native ACR task identity, YAML and exact secret role', async () => {
    expect(await engine.validate(azureEngineBackend, buildAzureBuildConfiguration({ ...fullEnvironmentInput, packageTokenKey: 'NODE_AUTH_TOKEN' }))).toEqual({ ok: true });
  }, 300_000);
  it('validates CodeBuild native parameter permission and runtime secret scope', async () => {
    const input = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-demo', environmentId: 'env1', parameterPath: '/hypervibe/env1/', packageTokenKey: 'NPM_TOKEN', secretKeys: ['API_KEY'] };
    expect(await engine.validate(awsEngineBackend, buildAwsBuildConfiguration(input))).toEqual({ ok: true });
    expect(await engine.validate(awsEngineBackend, buildAwsConfiguration(input))).toEqual({ ok: true });
  }, 300_000);
});

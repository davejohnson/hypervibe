/** Schema validation of the complete native CI identity graphs; no cloud auth or mutations. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAwsConfiguration } from '../../../providers/aws/tofu/aws-engine.config.js';
import { awsEngineBackend } from '../../../providers/aws/tofu/aws-engine.backend.js';
import { buildAzureBuildConfiguration, buildAzureEnvironmentConfiguration, buildAzureSharedConfiguration } from '../../../providers/azure/tofu/azure-engine.config.js';
import { fullEnvironmentInput, fullSharedInput } from '../../../providers/azure/tofu/__tests__/azure-fixtures.js';
import { azureEngineBackend } from '../../../providers/azure/tofu/azure-engine.backend.js';
import { buildGcpObserverConfiguration, googleObserverBinding, observerKey } from '../../../providers/gcp/tofu/gcp-observer.config.js';
import { gcpSetupBackend } from '../../../providers/gcp/tofu/gcp-setup.backend.js';
import { OpenTofuEngine } from '../engine.js';
import { ensureEngineBinary } from '../install.js';

const cipher = { encrypt: (text: string) => Buffer.from(text).toString('base64'), decrypt: (text: string) => Buffer.from(text, 'base64').toString() };
const ci = { repository: 'owner/app', branch: 'main', environmentName: 'test' };
const observation = { ...ci, repositoryId: '12', ownerId: '34' };
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
    expect(await engine.validate(azureEngineBackend, buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, ci, observation: { ...observation,
      workspaceResourceId: '/subscriptions/' + fullEnvironmentInput.subscriptionId + '/resourceGroups/' + fullEnvironmentInput.resourceGroup + '/providers/Microsoft.OperationalInsights/workspaces/shared-logs' } }))).toEqual({ ok: true });
    expect(await engine.validate(azureEngineBackend, buildAzureSharedConfiguration({ ...fullSharedInput, database: { version: 17, monitorStorage: true } }))).toEqual({ ok: true });
    expect(await engine.validate(azureEngineBackend, buildAzureBuildConfiguration({ ...fullEnvironmentInput, ci, packageTokenKey: 'NPM_TOKEN' }))).toEqual({ ok: true });
    expect(await engine.validate(azureEngineBackend, buildAzureBuildConfiguration({ ...fullEnvironmentInput, ci }))).toEqual({ ok: true });
  }, 300_000);
  it('validates AWS OIDC role and release policy alongside web, worker and cron resources', async () => {
    const input = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-demo', environmentId: 'env1', parameterPath: '/hypervibe/env1/', ci, observation,
      storage: [{ name: 'invoices', bucket: 'hv-app-demo-invoices-111122223333' }],
      database: { name: 'staging', clusterArn: 'arn:aws:rds:us-west-2:111122223333:cluster:hv-app-shared-postgres' },
      services: [{ logicalName: 'web', resourceName: 'hv-app-demo-web', initialImageUri: '111122223333.dkr.ecr.us-west-2.amazonaws.com/app:commit', public: true }],
      workers: [{ logicalName: 'worker', resourceName: 'hv-app-demo-worker', initialImageUri: '111122223333.dkr.ecr.us-west-2.amazonaws.com/app:commit' }],
      jobs: [{ logicalName: 'cron', resourceName: 'hv-app-demo-cron', initialImageUri: '111122223333.dkr.ecr.us-west-2.amazonaws.com/app:commit', schedule: '0 1 * * *' }],
    };
    expect(await engine.validate(awsEngineBackend, buildAwsConfiguration(input))).toEqual({ ok: true });
  }, 300_000);
  it('validates the Cloud Run dashboard, service and job alarms, read identity and exact-job access together', async () => {
    const key = observerKey('demo-project', ci.environmentName);
    const services = Object.fromEntries((['web', 'worker', 'cron'] as const).map(workloadKind => [workloadKind, {
      region: 'us-central1', workloadKind,
      serviceId: 'projects/demo-project/locations/us-central1/' + ({ web: 'services', worker: 'workerPools', cron: 'jobs' })[workloadKind] + '/demo-' + workloadKind,
    }]));
    const binding = googleObserverBinding({ key, project: 'demo-project', number: '123456789', environmentId: 'ENV1', intent: ci, services });
    expect(await engine.validate(gcpSetupBackend, buildGcpObserverConfiguration(binding, key, observation.repositoryId,
      [...(['database', 'cache', 'storage', 'queue'] as const).map(kind => ({ kind, name: kind, native: 'demo-' + kind, region: 'us-central1' })),
        { kind: 'database', name: 'tenant', native: 'demo-shared-pg', region: 'us-central1', tenantDatabase: 'demo_app' }]))).toEqual({ ok: true });
  }, 300_000);
});

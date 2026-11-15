import type { AzureEngineInput, AzureSharedInput } from '../azure-engine.config.js';

const placement = {
  tenantId: '11111111-2222-3333-4444-555555555555', subscriptionId: '66666666-7777-8888-9999-000000000000', resourceGroup: 'hv-billforge', location: 'eastus2',
};

export const fullSharedInput: AzureSharedInput = {
  ...placement, kind: 'shared', prefix: 'hv-billforge-shared', label: 'testing',
  deployPrincipalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', deployPrincipalName: 'hypervibe-deploy-billforge', database: { version: 17 },
};

const group = `/subscriptions/${placement.subscriptionId}/resourceGroups/hv-billforge`;
const image = 'hvbillforgeshared123456.azurecr.io/app:0123456789abcdef0123456789abcdef01234567';

/** A testing environment with every supported piece: web, on-demand worker, cron job, storage and secrets. */
export const fullEnvironmentInput: AzureEngineInput = {
  ...placement, kind: 'environment', prefix: 'hv-billforge-test', environmentId: 'ENV1', environmentName: 'test',
  shared: { registryId: `${group}/providers/Microsoft.ContainerRegistry/registries/hvbillforgeshared123456`, registryLoginServer: 'hvbillforgeshared123456.azurecr.io' },
  vault: { id: `${group}/providers/Microsoft.KeyVault/vaults/hv-billforge-abc123`, uri: 'https://hv-billforge-abc123.vault.azure.net/' },
  storage: [{ name: 'documents', container: 'documents' }],
  services: [{ logicalName: 'web', resourceName: 'hv-billforge-test-web', initialImage: image, public: true, targetPort: 3000, healthCheckPath: '/health', env: { NODE_ENV: 'production', PORT: '3000' } }],
  workers: [{ logicalName: 'worker', resourceName: 'hv-billforge-test-worker', initialImage: image, command: ['sh', '-c', 'npm run worker'],
    pendingWorkQuery: `SELECT count(*) FROM jobs WHERE status = 'queued';` }],
  jobs: [{ logicalName: 'nightly', resourceName: 'hv-billforge-test-nightly', initialImage: image, schedule: '0 3 * * *', command: ['sh', '-c', 'npm run nightly'] }],
  secretKeys: ['DATABASE_URL', 'JWT_SECRET'],
};

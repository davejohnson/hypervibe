import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { AZURE_PLAN_NOT_BUILT, azureEngineProblems, azureProfileFor, buildAzureEngineInput, planAzureInfrastructureEngine } from '../infrastructure-engine-azure.js';

const connection = { tenantId: '11111111-2222-3333-4444-555555555555', subscriptionId: '66666666-7777-8888-9999-000000000000', resourceGroup: 'hv-billforge',
  location: 'eastus2', deployPrincipalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };

const spec = (environment: Record<string, unknown>, name = 'test') => projectSpecSchema.parse({
  version: 1, project: 'billforge',
  environments: { [name]: { hosting: { provider: 'azure', engine: 'opentofu' }, services: { web: { public: true, healthCheckPath: '/health' } }, envVars: { PORT: '3000' }, ...environment } },
});

describe('Azure engine planning', () => {
  it('shares the production shape with staging; other environments are testing', () => {
    expect(azureProfileFor('staging')).toBe('production');
    expect(azureProfileFor('production')).toBe('production');
    expect(azureProfileFor('pr-12')).toBe('testing');
  });

  it('lists what it cannot build instead of ignoring it, and blocks every plan for now', async () => {
    const withWorker = spec({ services: { web: {}, worker: { workloadKind: 'worker' } }, cache: { provider: 'railway' } });
    expect(azureEngineProblems(withWorker, 'test')).toEqual(expect.arrayContaining([expect.stringMatching(/worker.*not built on Azure yet/), expect.stringMatching(/Redis caches/)]));
    expect(azureEngineProblems(spec({}, 'staging'), 'staging')[0]).toMatch(/production profile/);
    const planned = await planAzureInfrastructureEngine({} as never, { project: { id: 'p', name: 'billforge', gitRemoteUrl: null } as never, spec: spec({}), environmentName: 'test' });
    expect(planned.blocked.at(-1)).toBe(AZURE_PLAN_NOT_BUILT);
  });

  it('builds web, database, storage and secrets for a testing environment from the spec', () => {
    const desired = spec({
      database: { provider: 'azure-postgres', version: 17 },
      storage: { documents: { provider: 'azureblob', type: 'bucket', region: 'eastus2', injectInto: ['web'] } },
    });
    expect(azureEngineProblems(desired, 'test')).toEqual([]);
    const input = buildAzureEngineInput(desired, 'test', { connection, project: 'billforge', environment: { id: 'ENV1', platformBindings: { azure: { image: 'r.azurecr.io/app:1' } } } as never },
      { secretKeys: ['DATABASE_URL'] });
    expect(input.database).toEqual({ version: 17 });
    expect(input.storage).toEqual([{ name: 'documents', container: 'documents' }]);
    expect(input.services).toEqual([expect.objectContaining({ logicalName: 'web', resourceName: 'hv-billforge-test-web', initialImage: 'r.azurecr.io/app:1', targetPort: 3000, healthCheckPath: '/health' })]);
    expect(input.services![0]!.env).toMatchObject({ OBJECT_STORAGE_PROVIDER: 'azureblob', AZURE_STORAGE_CONTAINER_NAME: 'documents', PORT: '3000' });
    // Before the first image build, the services are not created yet.
    expect(buildAzureEngineInput(desired, 'test', { connection, project: 'billforge', environment: { id: 'ENV1', platformBindings: {} } as never }, { secretKeys: [] }).services).toEqual([]);
  });
});

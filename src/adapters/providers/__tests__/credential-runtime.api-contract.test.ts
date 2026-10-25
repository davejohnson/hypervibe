import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ECSClient } from '@aws-sdk/client-ecs';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { EcsExpressAdapter } from '../aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../azure/azure-container-apps.adapter.js';
import { FlyAdapter } from '../fly/fly.adapter.js';
import { DigitalOceanAdapter } from '../digitalocean/digitalocean.adapter.js';
import { VercelAdapter } from '../vercel/vercel.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { formatFlyEnvironmentBinding, formatFlyServiceBinding } from '../fly/fly.binding.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';

// Reconstructed documented REST/SDK transport observations. This proves local
// request preservation and exact scope, not live permissions or application use.
const now = new Date();
const service: Service = { id: 'service-local', projectId: 'project-local', name: 'web', buildConfig: { workloadKind: 'web', healthCheckPath: '/different-desired-probe' }, envVarSpec: {}, createdAt: now, updatedAt: now };
const environment = (platformBindings: Record<string, unknown>): Environment => ({ id: 'environment-local', projectId: 'project-local', name: 'production', platformBindings, createdAt: now, updatedAt: now });
const options = { requireCredentialUpdate: true, deferDeployment: true };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([RailwayAdapter, CloudRunAdapter, EcsExpressAdapter, AzureContainerAppsAdapter, FlyAdapter, DigitalOceanAdapter, VercelAdapter])('declares selected credential effects separately from ordinary deployment (%s)', Adapter => {
  const adapter = new Adapter();
  expect(['deferred', 'provider-rollout']).toContain((adapter.capabilities as any).credentialUpdateActivation);
  expect(['readback', 'acknowledgement']).toContain((adapter.capabilities as any).credentialValueEvidence);
});

it.each([false, true])('Cloud Run changes only selected env entries in an exact existing workload; job=%s', async job => {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-west1', credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
  const resource = `projects/gcp-project/locations/us-west1/${job ? 'jobs' : 'services'}/bound-web`;
  const container = { name: 'main', image: `registry/image@sha256:${'a'.repeat(64)}`, args: ['keep'], env: [{ name: 'API_KEY', value: 'old' }, { name: 'KEEP_REFERENCE', valueSource: { secretKeyRef: { secret: 'unrelated-secret', version: '7' } } }], volumeMounts: [{ name: 'data', mountPath: '/data' }] };
  const extra = { serviceAccount: 'workload@gcp-project.iam.gserviceaccount.com', volumes: [{ name: 'data', emptyDir: {} }], containers: [container, { name: 'sidecar', image: 'registry/sidecar:stable', env: [{ name: 'KEEP', value: 'yes' }] }] };
  let current: any = { name: resource, uid: 'workload-uid', etag: 'etag-before', generation: '1', observedGeneration: '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' }, latestReadyRevision: 'old', template: job ? { template: extra } : extra };
  const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/v2/${resource}`);
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); writes.push({ body, mask: url.searchParams.get('updateMask') });
      current = { ...current, template: job ? { ...current.template, template: { ...extra, containers: body.template.template.containers } } : { ...extra, containers: body.template.containers }, latestReadyRevision: 'new' };
      return Response.json({ name: 'projects/gcp-project/locations/us-west1/operations/update', done: true, response: current });
    }
    return Response.json(current);
  }));
  const bound = environment({ provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'us-west1', providerScope: { projectId: 'gcp-project', region: 'us-west1' }, services: { web: { [job ? 'jobName' : 'serviceId']: 'bound-web', resourceUid: 'workload-uid' } } });
  const receipt = await adapter.setEnvVars(bound, { ...service, buildConfig: { ...service.buildConfig, workloadKind: job ? 'cron' : 'web', ...(job ? { cronSchedule: '* * * * *', cronCommand: 'do-not-change-command' } : {}) } }, { API_KEY: 'replacement' }, options);
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ success: true, data: { credentialValueEvidence: 'readback' } });
  if (!job) expect(receipt.data).toMatchObject({ deploymentId: `${resource}/revisions/new`, rolloutBaseline: { deploymentId: `${resource}/revisions/old` } });
  expect(writes).toHaveLength(1);
  expect(writes[0].mask).toBe(job ? null : 'template.containers');
  const actual = job ? writes[0].body.template.template.containers : writes[0].body.template.containers;
  expect(actual).toEqual([{ ...container, env: [{ name: 'API_KEY', value: 'replacement' }, container.env[1]] }, extra.containers[1]]);
  expect(writes[0].body.etag).toBe('etag-before');
  expect(await adapter.readProviderEnvironmentVariables({ environment: bound, service })).toEqual({ success: true, variables: { API_KEY: 'replacement' }, unresolvedKeys: ['KEEP_REFERENCE'] });
  const wrongScope = { ...bound, platformBindings: { ...bound.platformBindings, environmentId: 'other-region' } };
  expect((await adapter.readProviderEnvironmentVariables({ environment: wrongScope, service })).success).toBe(false);
  expect(JSON.stringify(receipt)).not.toContain('replacement');
});

it('ECS uses the exact current container and SDK transport without rebuilding desired configuration', async () => {
  const region = 'us-west-2'; const account = '123456789012';
  const cluster = `arn:aws:ecs:${region}:${account}:cluster/existing`;
  const arn = `arn:aws:ecs:${region}:${account}:service/existing/web`;
  const original = { image: 'registry/image:unchanged', containerPort: 8088, command: ['keep'], environment: [{ name: 'API_KEY', value: 'old' }, { name: 'KEEP', value: 'yes' }], secrets: [{ name: 'REFERENCE', valueFrom: `arn:aws:secretsmanager:${region}:${account}:secret:keep` }] };
  let primaryContainer = original; const writes: any[] = [];
  const client = new ECSClient({ region, credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' }, requestHandler: { handle: async (request: { body?: unknown; headers: Record<string, string> }) => {
    const input = JSON.parse(String(request.body));
    const operation = request.headers['x-amz-target'].split('.').at(-1);
    if (operation === 'DescribeClusters') return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify({ clusters: [{ clusterArn: cluster, status: 'ACTIVE', tags: [] }] })]) } };
    if (operation === 'UpdateExpressGatewayService') { writes.push(input); primaryContainer = input.primaryContainer; }
    else expect(operation).toBe('DescribeExpressGatewayService');
    return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify({ service: { serviceArn: arn, cluster, tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: 'environment-local' }], status: { statusCode: 'ACTIVE' }, currentDeployment: `${arn}/revision/${writes.length ? 'new' : 'old'}`, activeConfigurations: [{ serviceRevisionArn: `${arn}/revision/${writes.length ? 'new' : 'old'}`, primaryContainer, taskRoleArn: `arn:aws:iam::${account}:role/workload`, ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'example.invalid' }] }] } })]) } };
  } } });
  const adapter = new EcsExpressAdapter();
  await adapter.connect({ accessKeyId: 'AKIAEXAMPLE12345678', secretAccessKey: 'synthetic-secret-that-is-long-enough-for-schema', region });
  Object.assign(adapter, { clients: { ecs: client }, accountId: account });
  const receipt = await adapter.setEnvVars(environment({ provider: 'ecs', projectId: cluster, environmentId: cluster, services: { web: { serviceId: arn } } }), service, { API_KEY: 'replacement' }, options);
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ success: true, data: { credentialValueEvidence: 'readback' } });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual({ serviceArn: arn, taskRoleArn: `arn:aws:iam::${account}:role/workload`, primaryContainer: { ...original, environment: [{ name: 'API_KEY', value: 'replacement' }, { name: 'KEEP', value: 'yes' }] } });
  expect(JSON.stringify(receipt)).not.toContain('replacement');
  const observed = await adapter.observe(environment({ provider: 'ecs', projectId: cluster, environmentId: cluster, services: { web: { serviceId: arn } } }));
  expect(observed.services[0]?.envVarKeys).toEqual(['API_KEY', 'KEEP', 'REFERENCE']);
  expect(observed.services[0]?.envVarHashes).not.toHaveProperty('REFERENCE');
  expect(observed.services[0]?.deployment).toMatchObject({ id: `${arn}/revision/new`, activeDeploymentIds: [`${arn}/revision/new`], activeDeploymentCoverage: 'traffic' });
  expect(await (adapter as any).readProviderEnvironmentVariables({ environment: environment({ provider: 'ecs', projectId: cluster, environmentId: cluster, services: { web: { serviceId: arn } } }), service })).toEqual({ success: true, variables: { API_KEY: 'replacement', KEEP: 'yes' }, unresolvedKeys: ['REFERENCE'] });
  expect(writes).toHaveLength(1);
  client.destroy();
});

it('Azure credential update preserves existing secret references, image, identity and unrelated configuration', async () => {
  const subscription = '22222222-2222-4222-8222-222222222222';
  const group = `/subscriptions/${subscription}/resourceGroups/existing`;
  const managed = `${group}/providers/Microsoft.App/managedEnvironments/existing-env`;
  const appId = `${group}/providers/Microsoft.App/containerApps/existing-web`;
  const original = { name: 'main', image: 'registry/image:unchanged', command: ['keep'], resources: { cpu: 1, memory: '2Gi' }, env: [{ name: 'API_KEY', secretRef: 'api-original' }, { name: 'REFERENCE', secretRef: 'key-vault' }] };
  let secrets: any[] = [{ name: 'api-original', value: 'old' }, { name: 'key-vault', keyVaultUrl: 'https://vault.vault.azure.net/secrets/key', identity: 'system' }];
  let app: any = { id: appId, location: 'canadacentral', name: 'existing-web', tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'environment-local' }, identity: { type: 'SystemAssigned', principalId: 'unchanged' }, properties: { managedEnvironmentId: managed, provisioningState: 'Succeeded', latestRevisionName: 'old', latestReadyRevisionName: 'old', template: { revisionSuffix: 'old-suffix', containers: [original], scale: { minReplicas: 2 } }, configuration: { activeRevisionsMode: 'Multiple', registries: [{ server: 'registry', identity: 'system' }], secrets: secrets.map(({ value, ...rest }) => rest) } } };
  const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
    if (url.pathname.endsWith('/listSecrets')) return Response.json({ value: secrets });
    expect(url.pathname).toBe(appId);
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body)); writes.push(patch);
      secrets = patch.properties.configuration.secrets;
      const merge = (target: any, value: any): any => { if (!value || typeof value !== 'object' || Array.isArray(value)) return value; const next = { ...target }; for (const [key, entry] of Object.entries(value)) { if (entry === null) delete next[key]; else next[key] = merge(next[key], entry); } return next; };
      app = merge(app, patch);
      Object.assign(app.properties, { latestRevisionName: 'new', latestReadyRevisionName: 'new', provisioningState: 'Succeeded' });
    }
    return Response.json(app);
  }));
  const adapter = new AzureContainerAppsAdapter();
  await adapter.connect({ tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId: subscription, clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'synthetic-client-secret', location: 'canadacentral' });
  const receipt = await adapter.setEnvVars(environment({ provider: 'azure-container-apps', projectId: group, environmentId: managed, services: { web: { serviceId: appId } } }), service, { API_KEY: 'replacement' }, options);
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ success: true, data: { credentialValueEvidence: 'readback' } });
  expect(writes).toHaveLength(1);
  expect(writes[0].location).toBe('canadacentral');
  expect(app.properties.template.revisionSuffix).toBeUndefined();
  expect(writes[0].properties.configuration).toEqual({ secrets });
  expect(app.identity).toEqual({ type: 'SystemAssigned', principalId: 'unchanged' });
  expect(app.properties.template).toMatchObject({ scale: { minReplicas: 2 }, containers: [{ ...original, env: [{ name: 'API_KEY', secretRef: expect.any(String) }, original.env[1]] }] });
  expect(app.properties.configuration).toMatchObject({ activeRevisionsMode: 'Multiple', registries: [{ server: 'registry', identity: 'system' }] });
  expect(secrets).toContainEqual({ name: 'key-vault', keyVaultUrl: 'https://vault.vault.azure.net/secrets/key', identity: 'system' });
  expect(await (adapter as any).readProviderEnvironmentVariables({ environment: environment({ provider: 'azure-container-apps', projectId: group, environmentId: managed, services: { web: { serviceId: appId } } }), service })).toEqual({ success: true, variables: { API_KEY: 'replacement' }, unresolvedKeys: ['REFERENCE'] });
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(receipt)).not.toContain('replacement');
});

it('Fly stages the exact app secret without modifying or restarting its Machine', async () => {
  const app = { id: 'app-id', name: 'bound-app', organization: { slug: 'test-org' }, status: 'deployed' };
  const envId = formatFlyEnvironmentBinding({ organizationSlug: 'test-org', projectName: 'existing-project', environmentName: 'production' });
  const machine = { id: 'machine-id', instance_id: 'instance-old', state: 'started', config: { image: 'registry/image:unchanged', metadata: { hypervibe_managed: 'true', hypervibe_project_id: 'existing-project', hypervibe_environment_id: envId, hypervibe_service_name: 'web', hypervibe_workload_kind: 'web' } } };
  const writes: string[] = []; let secretReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') {
      writes.push(url.pathname);
      expect(url.pathname).toBe('/v1/apps/bound-app/secrets');
      expect(JSON.parse(String(init.body))).toEqual({ values: { API_KEY: 'replacement' } });
      return Response.json({ version: 9 });
    }
    if (url.pathname === '/v1/apps/bound-app') return Response.json(app);
    if (url.pathname.endsWith('/machines')) return Response.json([machine]);
    if (url.pathname.endsWith('/secrets')) {
      if (secretReads++ === 0) expect(url.searchParams.get('min_version')).toBe('9');
      return Response.json({ secrets: [{ name: 'API_KEY', digest: 'opaque-native-digest' }] });
    }
    throw new Error('Unexpected Fly request');
  }));
  const adapter = new FlyAdapter(); await adapter.connect({ apiToken: 'flyv1-synthetic-token', organizationSlug: 'test-org' });
  const receipt = await adapter.setEnvVars(environment({ provider: 'fly', projectId: 'flyorg:test-org', environmentId: envId, services: { web: { serviceId: formatFlyServiceBinding({ organizationSlug: 'test-org', appId: app.id, appName: app.name, machineId: machine.id }) } } }), service, { API_KEY: 'replacement' }, options);
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ success: true, data: { credentialValueEvidence: 'acknowledgement', credentialUpdateActivation: 'deferred', configurationVersion: 9 } });
  expect(writes).toEqual(['/v1/apps/bound-app/secrets']);
  expect(await (adapter as any).readProviderEnvironmentVariables({ environment: environment({ provider: 'fly', projectId: 'flyorg:test-org', environmentId: envId, services: { web: { serviceId: formatFlyServiceBinding({ organizationSlug: 'test-org', appId: app.id, appName: app.name, machineId: machine.id }) } } }), service })).toEqual({ success: true, variables: {}, unresolvedKeys: ['API_KEY'] });
  expect(writes).toEqual(['/v1/apps/bound-app/secrets']);
  expect(JSON.stringify(receipt)).not.toContain('replacement');
});

it('Vercel changes only selected native production keys without deleting unrelated internal markers', async () => {
  const team = 'team_1234567890'; const project = 'prj_1234567890';
  const mutations: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v2/user') return Response.json({ id: 'user_1234567890', username: 'owner', email: 'owner@example.invalid' });
    if (url.pathname === `/v2/teams/${team}`) return Response.json({ id: team, slug: 'existing-team', name: 'Existing team' });
    if (url.pathname === `/v9/projects/${project}`) return Response.json({ id: project, accountId: team, name: 'bound-project' });
    if (url.pathname.endsWith('/env') && (init?.method ?? 'GET') === 'GET') return Response.json({ envs: [{ id: 'env-marker', key: 'HYPERVIBE_HEALTH_CHECK_PATH', value: '/existing', type: 'sensitive', target: ['production'], comment: 'Managed by Hypervibe' }, { id: 'env-other', key: 'API_KEY', value: 'masked', type: 'sensitive', target: ['preview'] }], pagination: { next: null } });
    if (url.pathname.endsWith('/env') && init?.method === 'POST') { mutations.push(JSON.parse(String(init.body))); return Response.json({}); }
    if (url.pathname === '/v7/deployments') return Response.json({ deployments: [], pagination: { next: null } });
    throw new Error('Unexpected Vercel request');
  }));
  const adapter = new VercelAdapter(); await adapter.connect({ accessToken: 'synthetic-token', teamId: team });
  const receipt = await adapter.setEnvVars(environment({ provider: 'vercel', projectId: `team:${team}`, services: { web: { serviceId: `team:${team}:${project}` } } }), service, { API_KEY: 'replacement' }, options);
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ success: true, data: { credentialValueEvidence: 'acknowledgement' } });
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toEqual([{ key: 'API_KEY', value: 'replacement', type: 'sensitive', target: ['production'], comment: expect.any(String) }]);
  expect(await (adapter as any).readProviderEnvironmentVariables({ environment: environment({ provider: 'vercel', projectId: `team:${team}`, services: { web: { serviceId: `team:${team}:${project}` } } }), service })).toEqual({ success: true, variables: {}, unresolvedKeys: ['HYPERVIBE_HEALTH_CHECK_PATH'] });
  expect(JSON.stringify(receipt)).not.toContain('replacement');
});

it('DigitalOcean updates one exact component using encrypted values and preserves other components and references', async () => {
  let spec: any = { name: 'bound-app', envs: [{ key: 'GLOBAL', value: '${database.DATABASE_URL}', scope: 'RUN_TIME' }], services: [{ name: 'bound-web', image: { registry_type: 'DOCR', registry: 'old-registry', repository: 'web', tag: 'immutable' }, instance_count: 3, envs: [{ key: 'API_KEY', value: 'old', type: 'SECRET', scope: 'RUN_AND_BUILD_TIME' }, { key: 'KEEP', value: '${database.DATABASE_URL}', scope: 'RUN_TIME', type: 'GENERAL' }] }], workers: [{ name: 'worker', image: { registry_type: 'DOCR', registry: 'old-registry', repository: 'worker', tag: 'old' }, envs: [{ key: 'WORKER', value: 'keep' }] }] };
  const original = structuredClone(spec); const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe('/v2/apps/bound-app');
    if (init?.method === 'PUT') { spec = JSON.parse(String(init.body)).spec; writes.push(spec); }
    return Response.json({ app: { id: 'bound-app', spec, active_deployment: { id: writes.length ? 'deployment-new' : 'deployment-old', phase: 'ACTIVE' } } });
  }));
  const adapter = new DigitalOceanAdapter(); await adapter.connect({ apiToken: 'dop_v1_synthetic-token' });
  const receipt = await adapter.setEnvVars(environment({ provider: 'digitalocean', projectId: 'bound-app', services: { web: { serviceId: 'bound-app:services:bound-web' } } }), service, { API_KEY: 'replacement' }, options);
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ success: true, data: { credentialValueEvidence: 'acknowledgement' } });
  expect(writes).toHaveLength(1);
  original.services[0].envs[0].value = 'replacement';
  expect(spec).toEqual(original);
  expect(await (adapter as any).readProviderEnvironmentVariables({ environment: environment({ provider: 'digitalocean', projectId: 'bound-app', services: { web: { serviceId: 'bound-app:services:bound-web' } } }), service })).toEqual({ success: true, variables: { GLOBAL: '${database.DATABASE_URL}', KEEP: '${database.DATABASE_URL}' }, unresolvedKeys: ['API_KEY'] });
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(receipt)).not.toContain('replacement');
});

// A same-name workload in another region is not the accepted target.
it('Cloud Run refuses a bound region mismatch before any provider request', async () => {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-west1', credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
  const requests = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', requests);
  const result = await adapter.setEnvVars(environment({ provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'europe-west1', services: { web: { serviceId: 'bound-web' } } }), service, { API_KEY: 'replacement' }, options);
  expect(result.success).toBe(false);
  expect(requests).not.toHaveBeenCalled();
});

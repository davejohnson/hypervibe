import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ECSClient } from '@aws-sdk/client-ecs';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { railwayHttpFixture, projectId as railwayProject, stagingId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { EcsExpressAdapter } from '../../adapters/providers/aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../../adapters/providers/azure/azure-container-apps.adapter.js';
import { FlyAdapter } from '../../adapters/providers/fly/fly.adapter.js';
import { DigitalOceanAdapter } from '../../adapters/providers/digitalocean/digitalocean.adapter.js';
import { VercelAdapter } from '../../adapters/providers/vercel/vercel.adapter.js';
import { formatFlyEnvironmentBinding, formatFlyServiceBinding } from '../../adapters/providers/fly/fly.binding.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService, type PlanOptions } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { planDelegatedSecrets } from '../../domain/services/delegated-secret.service.js';
import { hashEnvValue, type ObservedState } from '../../domain/ports/observe.port.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { credentialInventory } from '../credential-inventory.js';
import '../providers.js';

// Composition coverage uses the real shared plan/apply/inventory and real native
// credential writers, including ECS SDK HTTP serialization. Native observations
// are a synthetic logical projection here (except Railway's pinned transport).
// Real adapter observations and wire preservation are independently exercised by
// credential-runtime.api-contract.test.ts and each provider adapter suite.
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'hv-credential-all-hosting-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true }); });

async function providerWire(provider: string, environment: Environment) {
  const values: Record<string, string> = { API_KEY: 'accepted-old', ALIAS_KEY: 'accepted-old', KEEP: '${UNCHANGED.REFERENCE}' };
  const writes: string[] = [];
  let serial = 0;
  let adapter: any;
  let binding: Record<string, any> = {};
  const record = (input: Record<string, string>) => { Object.assign(values, input); serial += 1; writes.push(provider); };
  const envEntries = () => Object.entries(values).map(([name, value]) => ({ name, value }));
  let transport: (input: any, init?: RequestInit) => Promise<Response>;
  if (provider === 'railway') {
    const wire = await railwayHttpFixture(); wire.addService('staging-web', 'web', stagingId);
    wire.variables.set(`staging-web/${stagingId}`, values);
    return { adapter: wire.adapter, binding: { provider, projectId: railwayProject, environmentId: stagingId, services: { web: { serviceId: 'staging-web' } } }, values: () => wire.variables.get(`staging-web/${stagingId}`)!, writes: () => wire.mutations.map(m => m.field) };
  }
  if (provider === 'cloudrun') {
    adapter = new CloudRunAdapter();
    await adapter.connect({ projectId: 'gcp-project', region: 'us-west1', credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
    Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
    const resource = 'projects/gcp-project/locations/us-west1/services/bound-web';
    binding = { provider, projectId: 'gcp-project', environmentId: 'us-west1', services: { web: { serviceId: 'bound-web', resourceUid: 'workload-uid' } } };
    const current = () => ({ name: resource, uid: 'workload-uid', etag: `etag-${serial}`, generation: String(serial + 1), observedGeneration: String(serial + 1), terminalCondition: { state: 'CONDITION_SUCCEEDED' }, latestReadyRevision: `${resource}/revisions/${serial}`, template: { containers: [{ name: 'main', image: `registry/web@sha256:${'a'.repeat(64)}`, env: envEntries() }], serviceAccount: 'runtime@gcp-project.iam.gserviceaccount.com' } });
    transport = async (input, init) => {
      expect(new URL(String(input)).pathname).toBe(`/v2/${resource}`);
      if (init?.method === 'PATCH') { const body = JSON.parse(String(init.body)); record(Object.fromEntries(body.template.containers[0].env.map((entry: any) => [entry.name, entry.value]))); return Response.json({ name: 'projects/gcp-project/locations/us-west1/operations/update', done: true, response: current() }); }
      return Response.json(current());
    };
  } else if (provider === 'ecs') {
    const region = 'us-west-2'; const account = '123456789012'; const cluster = `arn:aws:ecs:${region}:${account}:cluster/bound`; const arn = `arn:aws:ecs:${region}:${account}:service/bound/web`;
    adapter = new EcsExpressAdapter(); await adapter.connect({ accessKeyId: 'AKIAEXAMPLE12345678', secretAccessKey: 'synthetic-secret-that-is-long-enough-for-schema', region });
    const client = new ECSClient({ region, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, requestHandler: { handle: async (request: { body?: unknown; headers: Record<string, string> }) => {
      const operation = request.headers['x-amz-target'].split('.').at(-1); const input = JSON.parse(String(request.body));
      if (operation === 'UpdateExpressGatewayService') record(Object.fromEntries(input.primaryContainer.environment.map((entry: any) => [entry.name, entry.value])));
      else expect(operation).toBe('DescribeExpressGatewayService');
      return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify({ service: { cluster, serviceArn: arn, tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: environment.id }], status: { statusCode: 'ACTIVE' }, currentDeployment: `${arn}/revision/${serial}`, activeConfigurations: [{ serviceRevisionArn: `${arn}/revision/${serial}`, primaryContainer: { image: 'registry/web:retained', containerPort: 8080, environment: envEntries() }, taskRoleArn: `arn:aws:iam::${account}:role/runtime`, ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'example.invalid' }] }] } })]) } };
    } } });
    Object.assign(adapter, { clients: { ecs: client }, accountId: account });
    binding = { provider, projectId: cluster, environmentId: cluster, services: { web: { serviceId: arn } } };
    transport = async () => { throw new Error('Unexpected non-SDK request'); };
  } else if (provider === 'azure-container-apps') {
    const subscription = '22222222-2222-4222-8222-222222222222'; const group = `/subscriptions/${subscription}/resourceGroups/bound`; const managed = `${group}/providers/Microsoft.App/managedEnvironments/bound-env`; const id = `${group}/providers/Microsoft.App/containerApps/bound-web`;
    adapter = new AzureContainerAppsAdapter(); await adapter.connect({ tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId: subscription, clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'synthetic', location: 'canadacentral' });
    let app: any = { id, name: 'bound-web', location: 'canadacentral', tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': environment.id }, identity: { type: 'SystemAssigned', principalId: 'runtime' }, properties: { managedEnvironmentId: managed, provisioningState: 'Succeeded', latestReadyRevisionName: 'old', latestRevisionName: 'old', template: { containers: [{ name: 'main', image: 'registry/web:retained', env: envEntries() }] }, configuration: { secrets: [] } } };
    binding = { provider, projectId: group, environmentId: managed, services: { web: { serviceId: id } } };
    transport = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
      if (url.pathname.endsWith('/listSecrets')) return Response.json({ value: app.properties.configuration.secrets });
      expect(url.pathname).toBe(id);
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)); app.properties.configuration.secrets = patch.properties.configuration.secrets;
        if (patch.properties.template) app.properties.template.containers = patch.properties.template.containers;
        const secrets = new Map(app.properties.configuration.secrets.map((entry: any) => [entry.name, entry.value]));
        record(Object.fromEntries(app.properties.template.containers[0].env.map((entry: any) => [entry.name, entry.secretRef ? secrets.get(entry.secretRef) : entry.value])));
        app.properties.latestRevisionName = `new-${serial}`; app.properties.latestReadyRevisionName = `new-${serial}`;
      }
      return Response.json(app);
    };
  } else if (provider === 'fly') {
    adapter = new FlyAdapter(); await adapter.connect({ apiToken: 'flyv1-synthetic', organizationSlug: 'example' });
    const env = formatFlyEnvironmentBinding({ organizationSlug: 'example', projectName: 'existing', environmentName: 'staging' });
    const app = { id: 'app-id', name: 'bound-app', organization: { slug: 'example' } };
    const machine = { id: 'machine-id', instance_id: 'old', state: 'started', config: { image: 'registry/web:retained', metadata: { hypervibe_managed: 'true', hypervibe_project_id: 'existing', hypervibe_environment_id: env, hypervibe_service_name: 'web', hypervibe_workload_kind: 'web' } } };
    binding = { provider, projectId: 'flyorg:example', environmentId: env, services: { web: { serviceId: formatFlyServiceBinding({ organizationSlug: 'example', appId: app.id, appName: app.name, machineId: machine.id }) } } };
    transport = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') { expect(url.pathname).toBe('/v1/apps/bound-app/secrets'); record(JSON.parse(String(init.body)).values); return Response.json({ version: serial }); }
      if (url.pathname.endsWith('/machines')) return Response.json([machine]);
      if (url.pathname.endsWith('/secrets')) return Response.json({ secrets: Object.keys(values).map(name => ({ name, digest: 'opaque' })) });
      if (url.pathname === '/v1/apps/bound-app') return Response.json(app);
      throw new Error('Unexpected Fly route');
    };
  } else if (provider === 'digitalocean') {
    adapter = new DigitalOceanAdapter(); await adapter.connect({ apiToken: 'dop_v1_synthetic' });
    let spec: any = { name: 'bound-app', services: [{ name: 'web', image: { registry_type: 'DOCR', registry: 'registry', repository: 'web', tag: 'retained' }, envs: Object.entries(values).map(([key, value]) => ({ key, value, type: 'SECRET', scope: 'RUN_TIME' })) }] };
    binding = { provider, projectId: 'bound-app', services: { web: { serviceId: 'bound-app:services:web' } } };
    transport = async (input, init) => { expect(new URL(String(input)).pathname).toBe('/v2/apps/bound-app'); if (init?.method === 'PUT') { spec = JSON.parse(String(init.body)).spec; record(Object.fromEntries(spec.services[0].envs.map((entry: any) => [entry.key, entry.value]))); } return Response.json({ app: { id: 'bound-app', spec, active_deployment: { id: `deployment-${serial}`, phase: 'ACTIVE' } } }); };
  } else {
    adapter = new VercelAdapter(); await adapter.connect({ accessToken: 'synthetic-token', teamId: 'team_1234567890' });
    binding = { provider, projectId: 'team:team_1234567890', services: { web: { serviceId: 'team:team_1234567890:prj_1234567890' } } };
    transport = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/user') return Response.json({ id: 'user_1234567890', username: 'owner', email: 'owner@example.invalid' });
      if (url.pathname === '/v2/teams/team_1234567890') return Response.json({ id: 'team_1234567890', slug: 'example', name: 'Example' });
      if (url.pathname === '/v9/projects/prj_1234567890') return Response.json({ id: 'prj_1234567890', accountId: 'team_1234567890', name: 'bound-project' });
      if (url.pathname.endsWith('/env')) { if (init?.method === 'POST') { record(Object.fromEntries(JSON.parse(String(init.body)).map((entry: any) => [entry.key, entry.value]))); return Response.json({}); } return Response.json({ envs: Object.keys(values).map(key => ({ id: `env-${key}`, key, value: 'masked', type: 'sensitive', target: ['production'], comment: 'Managed by Hypervibe' })), pagination: { next: null } }); }
      if (url.pathname === '/v7/deployments') return Response.json({ deployments: [{ uid: 'dpl_old', projectId: 'prj_1234567890', name: 'bound-project', url: 'example.vercel.app', createdAt: 1700000000000, readyState: 'READY', target: 'production' }], pagination: { next: null } });
      throw new Error('Unexpected Vercel route');
    };
  }
  vi.stubGlobal('fetch', vi.fn(transport));
  vi.spyOn(adapter, 'observe').mockImplementation(async (): Promise<ObservedState> => ({ provider, observedAt: new Date().toISOString(), projectExists: true, projectId: binding.projectId, environmentId: binding.environmentId,
    services: [{ name: 'web', externalId: binding.services.web.serviceId, workloadKind: 'web', customDomains: [], config: {}, sourceState: 'disconnected', envVarKeys: Object.keys(values).sort(), envVarHashes: adapter.capabilities.credentialValueEvidence === 'readback' ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, hashEnvValue(value)])) : {}, ...(provider === 'fly' ? { envVarEvidence: 'recorded-update' as const } : {}), status: 'running', deployment: { id: 'old', activeDeploymentIds: ['old', `new-${serial}`], activeDeploymentCoverage: 'traffic' } }], databases: [], completeness: { project: 'complete', environment: 'complete', services: provider === 'vercel' ? 'unknown' : 'complete', serviceIdentities: 'complete' }, partial: provider === 'vercel', warnings: [],
  }));
  return { adapter, binding, values: () => values, writes: () => writes };
}

it.each(['railway', 'cloudrun', 'ecs', 'azure-container-apps', 'fly', 'digitalocean', 'vercel'])('%s composes a scoped two-alias rotation with pending activation and a stable retry', async provider => {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: `credential-${provider}`, defaultPlatform: provider });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {} });
  const wire = await providerWire(provider, environment);
  ctx.repos.environments.updatePlatformBindings(environment.id, wire.binding);
  const file = path.join(dir, '.env'); writeFileSync(file, 'INPUT=replacement-value\n', { mode: 0o600 });
  const credential = { role: 'application-api', label: 'Application API', purpose: 'Authenticate application requests', source: `dotenv:${file}#INPUT`, kind: 'opaque', runtimeConsumers: ['API_KEY', 'ALIAS_KEY'].map(variable => ({ environment: 'staging', service: 'web', variable })) };
  const spec = new SpecStore().replace(project, { version: 1, project: project.name, secrets: Object.fromEntries(['API_KEY', 'ALIAS_KEY'].map(key => [key, { ownership: 'delegated', principal: 'user:owner', environments: ['staging'], credential }])), environments: { staging: { hosting: { provider }, envFile: { mode: 'off' }, services: { web: {} }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } } } });
  ctx.repos.services.create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: wire.adapter });
  const connection = ctx.repos.connections.create({ provider, credentialsEncrypted: getSecretStore().encryptObject({ synthetic: true }) }); ctx.repos.connections.updateStatus(connection.id, 'verified');
  const options = { scope: 'credentials', credential: 'application-api', intent: 'rotate' } as PlanOptions;
  const plan = await new PlanService().plan(project, 'staging', options);
  if ('error' in plan) throw new Error(plan.error);
  expect(wire.writes()).toEqual([]);
  expect(plan.credentialReview?.targets).toHaveLength(2);
  writeFileSync(file, 'INPUT=unreviewed-local-edit\n');
  const applied = await executePlanApply(ctx, { project, spec: spec.spec, specRevision: spec.revision, planId: plan.planRunId, confirmActions: plan.actions.map(action => action.id) });
  expect(applied, JSON.stringify(applied)).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(wire.values()).toEqual({ API_KEY: 'replacement-value', ALIAS_KEY: 'replacement-value', KEEP: '${UNCHANGED.REFERENCE}' });
  const inventory = await credentialInventory(ctx, project, 'staging');
  const role = inventory.roles.find(role => role.id === 'role:application-api')!;
  expect(role.consumers).toHaveLength(2);
  expect(role.consumers.every(consumer => consumer.configuration.presence === 'present')).toBe(true);
  expect(role.consumers.every(consumer => consumer.activation.state === 'pending')).toBe(true);
  expect(JSON.stringify(inventory)).not.toContain('replacement-value');
  expect(JSON.stringify(inventory)).not.toContain('unreviewed-local-edit');
  expect(ctx.repos.environments.findById(environment.id)!.platformBindings.runtimeRollouts).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'web' })]));
  if (wire.adapter.capabilities.credentialValueEvidence === 'acknowledgement') expect(role.consumers.every(consumer => consumer.configuration.comparison === 'unknown')).toBe(true);
  const mutationCount = wire.writes().length;
  writeFileSync(file, 'INPUT=replacement-value\n');
  const retry = await new PlanService().plan(project, 'staging', options);
  if ('error' in retry) throw new Error(retry.error);
  expect(retry.actions.every(action => action.type === 'noop')).toBe(true);
  const latest = ctx.repos.environments.findById(environment.id)!;
  const observed = (await new PlanService().observeEnvironment(project, latest, spec.spec.environments.staging, { hostingOnly: true })).observed;
  const ordinary = planDelegatedSecrets({ spec: spec.spec, environmentName: 'staging', environment: latest, hostingProvider: provider, observed });
  expect(ordinary.blockers).toEqual([]);
  expect(ordinary.actions.every(action => action.type === 'noop')).toBe(true);
  expect(wire.writes()).toHaveLength(mutationCount);
});

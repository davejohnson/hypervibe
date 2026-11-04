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
  } else {
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
  }
  vi.stubGlobal('fetch', vi.fn(transport));
  vi.spyOn(adapter, 'observe').mockImplementation(async (): Promise<ObservedState> => ({ provider, observedAt: new Date().toISOString(), projectExists: true, projectId: binding.projectId, environmentId: binding.environmentId,
    services: [{ name: 'web', externalId: binding.services.web.serviceId, workloadKind: 'web', customDomains: [], config: {}, sourceState: 'disconnected', envVarKeys: Object.keys(values).sort(), envVarHashes: adapter.capabilities.credentialValueEvidence === 'readback' ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, hashEnvValue(value)])) : {}, ...(provider === 'fly' ? { envVarEvidence: 'recorded-update' as const } : {}), status: 'running', deployment: { id: 'old', activeDeploymentIds: ['old', `new-${serial}`], activeDeploymentCoverage: 'traffic' } }], databases: [], completeness: { project: 'complete', environment: 'complete', services: provider === 'vercel' ? 'unknown' : 'complete', serviceIdentities: 'complete' }, partial: provider === 'vercel', warnings: [],
  }));
  return { adapter, binding, values: () => values, writes: () => writes };
}

it.each(['railway', 'cloudrun', 'ecs', 'azure-container-apps'])('%s composes a scoped two-alias rotation with pending activation and a stable retry', async provider => {
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

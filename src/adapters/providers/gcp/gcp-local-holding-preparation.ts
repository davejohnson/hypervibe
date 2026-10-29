import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationProviderContext, type CloudInstallationRecord,
  type LocalCloudScopePreparationIntent } from '../../../domain/ports/cloud-installation.port.js';
import type { LocalHoldingPreparationCapability, LocalPreparedHostingReceiptV1 } from '../../../domain/ports/local-holding-preparation.port.js';
import { parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { GcpSecretWriterClient } from './gcp-secret-writer.client.js';
import { GcpLocalDefaultAuthentication } from './gcp-local-default-authentication.js';
import { gcpBillingPreparationScopeSchema } from './gcp-billing-installation.js';
import { gcpHoldingConfigurationDigest, gcpHoldingServiceConfiguration, gcpObservedHoldingConfiguration } from './gcp-prepared-hosting.js';
import { hasGcpRuntimeRole, parseGcpRuntimePolicy, withGcpRuntimeRole } from './gcp-runtime-client.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().guid();
const image = z.string().max(2048).regex(/^[a-z][a-z0-9-]+-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/[a-z][a-z0-9-]{0,62}\/holding-v1@sha256:[a-f0-9]{64}$/);
const workloads = z.array(z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/), kind: z.enum(['web', 'worker']), public: z.boolean() }).strict()).min(1).max(16);
export const gcpLocalHoldingScopeSchema = z.object({ scopeKind: z.literal('holding-v1'),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/), projectNumber: z.string().regex(/^[1-9]\d{5,29}$/),
  projectCreateTime: z.string().datetime(), projectParent: z.literal('none'), projectInstallationId: id, projectAttemptId: id,
  billingAccountName: gcpBillingPreparationScopeSchema.shape.billingAccountName,
  region: z.string().regex(/^[a-z]+(?:-[a-z0-9]+)+$/), artifactRepository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  artifactRepositoryName: z.string().max(1024), artifactRepositoryCreateTime: z.string().datetime(),
  artifactInstallationId: id, artifactAttemptId: id,
  holdingImage: image, holdingPackageArchiveSha256: sha, holdingPackageLockSha256: sha,
  holdingRepository: z.string().max(1024), holdingRepositoryCreateTime: z.string().datetime(),
  holdingRepositoryInstallationId: id, holdingRepositoryAttemptId: id, topology: z.string().max(2048),
}).strict().superRefine((value, ctx) => {
  const expected = `projects/${value.projectId}/locations/${value.region}/repositories/${value.artifactRepository}`;
  if (value.artifactRepositoryName !== expected || !value.holdingRepository.startsWith(`projects/${value.projectId}/locations/${value.region}/repositories/`))
    ctx.addIssue({ code: 'custom', message: 'Holding resources require the exact reviewed project and region.' });
});
type Intent = LocalCloudScopePreparationIntent;
type Context = CloudInstallationProviderContext<Intent>;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'ownership_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function settings(intent: Intent) {
  const scope = gcpLocalHoldingScopeSchema.parse(intent.nativeScope), topology = workloads.parse(JSON.parse(scope.topology));
  if (new Set(topology.map(item => item.name)).size !== topology.length || topology.some(item => item.kind === 'worker' && item.public)) fail();
  const owner = hash([intent.customerId, intent.appId, intent.environment, intent.installationId]);
  const names = ['holding', ...topology.map(item => `runtime-${item.name}`)];
  const accounts = Object.fromEntries(names.map(key => [key, resourceName(key, { maxLength: 30, scope: [intent.appId, intent.environment] })]));
  const email = (key: string) => `${accounts[key]}@${scope.projectId}.iam.gserviceaccount.com`;
  const account = (key: string) => `projects/${scope.projectId}/serviceAccounts/${email(key)}`;
  const services = Object.fromEntries(topology.map(item => [item.name, `projects/${scope.projectId}/locations/${scope.region}/services/${resourceName(item.name, { maxLength: 49, scope: [scope.projectId, intent.environment] })}`]));
  if (new Set(Object.values(accounts)).size !== names.length || new Set(Object.values(services)).size !== topology.length) fail();
  return { ...scope, topology, owner, accounts, email, account, services };
}
function actions(intent: Intent): CloudInstallationAction[] {
  const s = settings(intent);
  const create = (key: string, kind: 'account' | 'service', name: string, dependsOn: string[] = []): CloudInstallationAction => ({
    id: `gcp:holding:${kind}:${key}`, type: 'create', verified: true, requiresConfirm: true,
    resource: { kind: kind === 'service' ? 'service' : 'project', provider: 'gcp', name },
    ...(kind === 'service' ? { billable: true } : {}), dependsOn,
    reason: kind === 'account' ? 'Create this dedicated identity without granting it runtime or administrator access.' : 'Create this inert holding service with no application configuration, zero minimum instances and maximum one instance.',
    metadata: { operation: `holding-create-${kind}`, category: kind === 'account' ? 'identity' : 'scope', execution: 'api', native: { key } },
  });
  const result = Object.keys(s.accounts).map(key => create(key, 'account', s.account(key)));
  for (const workload of s.topology) {
    const service = create(workload.name, 'service', s.services[workload.name], ['gcp:holding:account:holding', `gcp:holding:account:runtime-${workload.name}`]);
    result.push(service);
    if (workload.public) result.push({ id: `gcp:holding:public:${workload.name}`, type: 'update', verified: true, requiresConfirm: true,
      resource: service.resource, dependsOn: [service.id], reason: 'Allow public invocation only of this inert web endpoint; this does not release application code.',
      metadata: { operation: 'holding-public-invoker', category: 'trust', execution: 'api', native: { key: workload.name } } });
  }
  return result;
}
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['account', 'service']), id: z.string().max(1024),
  identity: z.record(z.string(), z.string().max(2048)) }).strict()).max(1), native: z.object({ operation: z.enum(['holding-create-account', 'holding-create-service', 'holding-public-invoker']),
  installationId: id, attemptId: id, operationName: z.string().max(1024).optional() }).strict() }).strict();
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const proof = evidenceSchema.parse(value), s = settings(intent);
  if (proof.native.installationId !== intent.installationId || proof.native.operationName && (!proof.native.operationName.startsWith(`projects/${s.projectId}/locations/${s.region}/operations/`)
    || !/^[A-Za-z0-9._~-]{1,255}$/.test(proof.native.operationName.split('/').at(-1)!))) fail('identity_mismatch');
  for (const resource of proof.resources) {
    if (resource.identity.owner !== s.owner || !id.safeParse(resource.identity.attemptId).success) fail();
    if (resource.kind === 'account' ? !Object.keys(s.accounts).some(key => s.account(key) === resource.id)
      || !/^[1-9]\d+$/.test(resource.identity.uniqueId ?? '') || Object.keys(resource.identity).sort().join(',') !== 'attemptId,owner,uniqueId'
      : !Object.values(s.services).includes(resource.id) || !id.safeParse(resource.identity.uid).success
        || !sha.safeParse(resource.identity.configurationDigest).success || !/^[1-9]\d*$/.test(resource.identity.generation ?? '')
        || !resource.identity.revision?.startsWith(`${resource.id}/revisions/`) || !safeOrigin(resource.identity.url)
        || Object.keys(resource.identity).sort().join(',') !== 'attemptId,configurationDigest,generation,owner,revision,uid,url') fail('identity_mismatch');
  }
  return proof;
}
function safeOrigin(value: unknown): value is string {
  try { const url = new URL(String(value)); return url.protocol === 'https:' && url.hostname.endsWith('.run.app') && !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
}
function proof(context: ActionContext, attemptId: string, resource?: CloudInstallationEvidence['resources'][number], operationName?: string) {
  return parseEvidence({ resources: resource ? [resource] : [], native: { operation: context.action.metadata.operation,
    installationId: context.intent.installationId, attemptId, ...(operationName ? { operationName } : {}) } }, context.intent);
}
function reason(error: unknown) {
  return error instanceof CloudInstallationBoundaryError ? error.reason : error instanceof DestinationBoundaryError
    ? error.status === 403 ? 'insufficient_permissions' as const : error.status === 401 ? 'authorization_expired' as const : 'provider_error' as const : 'provider_error' as const;
}
const permissions = ['resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'iam.serviceAccounts.create', 'iam.serviceAccounts.get',
  'iam.serviceAccounts.actAs', 'run.services.create', 'run.services.get', 'run.services.getIamPolicy', 'run.services.setIamPolicy', 'run.operations.get', 'artifactregistry.repositories.get'];

async function withHoldingClient<T>(context: Context, request: typeof fetch, work: (client: GcpSecretWriterClient) => Promise<T>, allowFinalRuntimeGrants = false): Promise<T> {
    const s = settings(context.intent), budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', budget.signal));
      const client = new GcpSecretWriterClient({ token, budget, request, beforeWrite: context.beforeMutation, sleep: async () => {} });
      const project = await client.bootstrap.getProject(s.projectId);
      const owner = hash([context.intent.customerId, context.intent.appId, context.intent.environment, s.projectInstallationId]);
      if (!project || project.name !== `projects/${s.projectNumber}` || project.projectId !== s.projectId || project.state !== 'ACTIVE'
        || project.createTime !== s.projectCreateTime || (project.parent ?? 'none') !== s.projectParent
        || project.labels?.['hv-installation'] !== owner.slice(0, 63) || project.labels?.['hv-attempt'] !== s.projectAttemptId) fail();
      const billing = await client.bootstrap.getProjectBillingInfo(s.projectId);
      if (!billing?.billingEnabled || billing.billingAccountName !== s.billingAccountName) fail('billing_assignment_unverified');
      for (const [name, createTime, installationId, attemptId] of [[s.artifactRepositoryName, s.artifactRepositoryCreateTime, s.artifactInstallationId, s.artifactAttemptId],
        [s.holdingRepository, s.holdingRepositoryCreateTime, s.holdingRepositoryInstallationId, s.holdingRepositoryAttemptId]]) {
        const registry = await client.json(`https://artifactregistry.googleapis.com/v1/${name}`);
        const registryOwner = hash([context.intent.customerId, context.intent.appId, context.intent.environment, installationId]);
        if (registry.name !== name || registry.createTime !== createTime || registry.format !== 'DOCKER' || registry.mode !== 'STANDARD_REPOSITORY'
          || registry.description !== `hypervibe:operator-registry:${registryOwner}:${attemptId}`) fail();
      }
      const holdingPolicy = parseGcpRuntimePolicy(await client.policy('registry', s.holdingRepository));
      if (!hasGcpRuntimeRole(holdingPolicy, 'roles/artifactregistry.reader', 'allUsers')) fail('insufficient_permissions');
      const dockerImage = await client.json(`https://artifactregistry.googleapis.com/v1/${s.holdingRepository}/dockerImages/${encodeURIComponent(`holding-v1@${s.holdingImage.split('@')[1]}`)}`);
      if (dockerImage.uri !== s.holdingImage || dockerImage.name !== `${s.holdingRepository}/dockerImages/holding-v1@${s.holdingImage.split('@')[1]}`) fail('identity_mismatch');
      // A brand-new identity must not inherit broad domain/group/public grants.
      // We cannot determine external group membership from a project policy.
      const policy = await client.policy('project', `projects/${s.projectNumber}`);
      const unprivileged = new Set((allowFinalRuntimeGrants ? ['holding'] : Object.keys(s.accounts)).map(key => `serviceAccount:${s.email(key)}`));
      if (policy.bindings.some(binding => binding.members.some(member => unprivileged.has(member) || /^(allUsers|allAuthenticatedUsers|domain:|group:)/.test(member)))) fail('ownership_mismatch');
      return await work(client);
    } finally { budget.close(); }
  }

type GcpLocalHoldingDriver = CloudInstallationDriver<Intent> & {
  readPrepared(receipt: LocalPreparedHostingReceiptV1, token: string, signal: AbortSignal): ReturnType<typeof readGcpLocalPreparedResources>;
};
export function createGcpLocalHoldingDriver(options: { fetch?: typeof fetch } = {}): GcpLocalHoldingDriver {
  const request = options.fetch ?? fetch;
  async function read(client: GcpSecretWriterClient, context: ActionContext) {
    const key = String(context.action.metadata.native.key), s = settings(context.intent);
    if (context.action.metadata.operation === 'holding-create-account') return client.account(s.projectId, s.accounts[key]);
    try { return await client.json(`https://run.googleapis.com/v2/${s.services[key]}`); }
    catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
  }
  function owned(value: Record<string, any>, context: ActionContext, attemptId: string, prior?: CloudInstallationEvidence['resources'][number]) {
    const s = settings(context.intent), key = String(context.action.metadata.native.key);
    if (context.action.metadata.operation === 'holding-create-account') {
      if (value.name !== s.account(key) || value.email !== s.email(key) || value.projectId !== s.projectId
        || value.description !== `hypervibe:holding:${s.owner}:${attemptId}` || !/^[1-9]\d+$/.test(value.uniqueId ?? '') || value.disabled === true
        || prior && prior.identity.uniqueId !== value.uniqueId) fail();
      return { kind: 'account', id: s.account(key), identity: { owner: s.owner, attemptId, uniqueId: String(value.uniqueId) } };
    }
    const workload = s.topology.find(item => item.name === key)!;
    const configuration = gcpObservedHoldingConfiguration(value, { id: s.services[key], lifetimeId: prior?.identity.uid,
      image: s.holdingImage, serviceAccountEmail: s.email('holding'), publicAccess: workload.public });
    if (value.labels?.['hv-owner'] !== s.owner.slice(0, 63) || value.labels?.['hv-attempt'] !== attemptId || !safeOrigin(value.uri)) fail();
    const result = { kind: 'service', id: s.services[key], identity: { owner: s.owner, attemptId, uid: String(value.uid), generation: String(value.generation),
      revision: String(value.latestReadyRevision), configurationDigest: gcpHoldingConfigurationDigest(configuration), url: String(value.uri) } };
    if (prior && !isDeepStrictEqual(prior, result)) fail();
    return result;
  }
  async function serviceProof(client: GcpSecretWriterClient, context: ActionContext) {
    const key = String(context.action.metadata.native.key), original = context.completed[`gcp:holding:service:${key}`];
    if (!original) fail('not_converged');
    const existing = parseEvidence(original, context.intent).resources[0]; if (!existing) fail();
    const create = actions(context.intent).find(item => item.id === `gcp:holding:service:${key}`)!;
    const native = await read(client, { ...context, action: create }); if (!native) fail();
    owned(native, { ...context, action: create }, existing.identity.attemptId, existing); return existing;
  }
  async function inspect(context: ActionContext, recover: boolean) {
    try { driver.parseAction(context.action, context.intent); return await withHoldingClient(context, request, async client => {
      const original = recover ? context.attempt?.evidence : context.completed[context.action.id];
      const saved = original ? parseEvidence(original, context.intent) : undefined;
      if (context.action.metadata.operation === 'holding-public-invoker') {
        const resource = await serviceProof(client, context), policy = parseGcpRuntimePolicy(await client.policy('service', resource.id));
        if (!hasGcpRuntimeRole(policy, 'roles/run.invoker', 'allUsers')) return saved || recover ? { state: 'unknown' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
        if (!saved && !recover) fail();
        return { state: 'satisfied' as const, evidence: saved ?? proof(context, context.attempt!.id, resource) };
      }
      const operationName = saved?.native.operationName as string | undefined;
      let operationResource: Record<string, any> | undefined;
      if (recover && operationName) {
        const operation = await client.json(`https://run.googleapis.com/v2/${operationName}`);
        if (operation.name !== operationName || operation.error) fail('not_converged');
        if (operation.done !== true) return { state: 'pending' as const, reason: 'not_converged' as const };
        if (!operation.response || typeof operation.response !== 'object' || Array.isArray(operation.response)
          || (operation.response as any)['@type'] !== 'type.googleapis.com/google.cloud.run.v2.Service') fail('identity_mismatch');
        operationResource = operation.response as Record<string, any>;
      }
      const native = await read(client, context);
      if (!saved && !recover) { if (native) fail(); return { state: 'action-required' as const }; }
      if (!native) return { state: 'pending' as const, reason: 'not_converged' as const };
      const attemptId = context.attempt?.id ?? saved!.native.attemptId as string;
      const resource = owned(native, context, attemptId, saved?.resources[0]);
      if (operationResource && !isDeepStrictEqual(resource, owned(operationResource, context, attemptId))) fail('identity_mismatch');
      return { state: 'satisfied' as const, evidence: proof(context, attemptId, resource, operationName) };
    }); } catch (error) { return { state: 'unknown' as const, reason: reason(error) }; }
  }
  const driver: GcpLocalHoldingDriver = {
    readPrepared: (receipt, token, signal) => readGcpLocalPreparedResources(receipt, token, signal, request),
    provider: 'gcp', localScopePreparation: { hostingProvider: 'cloudrun', preparation: 'holding-v1' },
    parseScope: value => gcpLocalHoldingScopeSchema.parse(value),
    parseAction(value, intent) { const action = actions(intent).find(item => isDeepStrictEqual(item, value)); if (!action) fail('identity_mismatch'); return action; },
    parseEvidence,
    scopePreparation: { resolvedScope(record) { if (record.status !== 'scope-ready') fail('not_converged'); return record.intent.nativeScope; },
      reviewResources: record => actions(record.intent).map(item => ({ kind: item.resource.kind, name: item.resource.name, scope: record.intent.nativeScope.projectId })) },
    async plan(context) {
      await withHoldingClient(context, request, async client => {
        const result = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${context.intent.nativeScope.projectNumber}:testIamPermissions`,
          { method: 'POST', body: JSON.stringify({ permissions }) });
        const granted = result.permissions;
        if (!Array.isArray(granted) || !permissions.every(permission => granted.includes(permission))) fail('insufficient_permissions');
        for (const action of actions(context.intent).filter(item => item.type === 'create')) {
          const native = await read(client, { ...context, action });
          const previous = context.completed[action.id];
          if (previous) { if (!native) fail(); const prior = parseEvidence(previous, context.intent); owned(native, { ...context, action }, String(prior.native.attemptId), prior.resources[0]); }
          else if (native) fail();
        }
      });
      return { actions: actions(context.intent), review: { resources: actions(context.intent).map(item => ({ kind: item.resource.kind, name: item.resource.name, scope: context.intent.nativeScope.projectId })),
        permissions: [{ principal: 'Exact environment-scoped local administrator', scope: context.intent.nativeScope.projectId, actions: permissions, purpose: 'installation-verification' }],
        costs: [{ resource: context.intent.nativeScope.projectId, description: `Inert services use minimum zero and maximum one instance each. Invocations and image storage can incur charges to ${context.intent.nativeScope.billingAccountName}.`, pricingUrl: 'https://cloud.google.com/run/pricing' }],
        warnings: ['Only inert holding resources are prepared. No application code, environment values, secrets, database, runtime grants or hosted access is installed.',
          'Holding worker minimum zero is temporary; the separately reviewed application release must use normal continuous worker CPU and its nonzero floor.'] } };
    },
    inspect: context => inspect(context, false), recover: context => inspect(context, true),
    async mutate(context) {
      let dispatched = false, retry = () => true;
      try { driver.parseAction(context.action, context.intent); return await withHoldingClient(context, request, async client => {
        const s = settings(context.intent), key = String(context.action.metadata.native.key);
        if (context.action.metadata.operation === 'holding-public-invoker') {
          const resource = await serviceProof(client, context), policy = parseGcpRuntimePolicy(await client.policy('service', resource.id));
          if (hasGcpRuntimeRole(policy, 'roles/run.invoker', 'allUsers')) fail();
          client.beginMutation(); retry = () => client.canRetryRejectedMutation(); dispatched = true;
          const next = withGcpRuntimeRole(policy, 'roles/run.invoker', 'allUsers');
          await client.setPolicy('service', resource.id, { ...next, bindings: next.bindings ?? [] });
          return { state: 'acknowledged' as const, evidence: proof(context, context.attempt.id, resource) };
        }
        if (await read(client, context)) fail();
        if (context.action.metadata.operation === 'holding-create-account') {
          client.beginMutation(); retry = () => client.canRetryRejectedMutation(); dispatched = true;
          const result = await client.json(`https://iam.googleapis.com/v1/projects/${s.projectId}/serviceAccounts`, { method: 'POST',
            body: JSON.stringify({ accountId: s.accounts[key], serviceAccount: { displayName: 'Hypervibe isolated holding identity', description: `hypervibe:holding:${s.owner}:${context.attempt.id}` } }) }, true);
          return { state: 'acknowledged' as const, evidence: proof(context, context.attempt.id, owned(result, context, context.attempt.id)) };
        }
        for (const dependency of context.action.dependsOn ?? []) {
          const action = actions(context.intent).find(item => item.id === dependency)!, saved = context.completed[dependency]; if (!saved) fail('not_converged');
          const previous = parseEvidence(saved, context.intent), native = await read(client, { ...context, action }); if (!native) fail();
          owned(native, { ...context, action }, String(previous.native.attemptId), previous.resources[0]);
        }
        const workload = s.topology.find(item => item.name === key)!;
        client.beginMutation(); retry = () => client.canRetryRejectedMutation(); dispatched = true;
        const operation = await client.json(`https://run.googleapis.com/v2/projects/${s.projectId}/locations/${s.region}/services?serviceId=${s.services[key].split('/').at(-1)}`, {
          method: 'POST', body: JSON.stringify({ ...gcpHoldingServiceConfiguration(s.holdingImage, s.email('holding'), workload.public),
            labels: { 'hv-owner': s.owner.slice(0, 63), 'hv-attempt': context.attempt.id } }) }, true);
        return { state: 'acknowledged' as const, evidence: proof(context, context.attempt.id, undefined, z.string().parse(operation.name)) };
      }); } catch (error) { return dispatched && !retry() ? { state: 'uncertain', reason: reason(error) } : { state: 'rejected', reason: reason(error) }; }
    }, connections: () => [],
  };
  return driver;
}

export function gcpLocalHoldingReceipt(record: CloudInstallationRecord<Intent>): LocalPreparedHostingReceiptV1 {
  if (record.status !== 'scope-ready') fail('not_converged');
  const s = settings(record.intent);
  const resource = (id: string) => { const value = parseEvidence(record.completed[id], record.intent).resources[0]; if (!value) fail(); return value; };
  const principal = (key: string) => ({ kind: 'gcp-service-account' as const, projectId: s.projectId, projectNumber: s.projectNumber,
    serviceAccountEmail: s.email(key), serviceAccountUniqueId: resource(`gcp:holding:account:${key}`).identity.uniqueId });
  return { schemaVersion: 1, purpose: 'local-holding', installationId: record.installationId, planDigest: record.plan.digest,
    appId: record.intent.appId, environment: record.intent.environment, source: record.intent.source, provider: 'gcp', hostingProvider: 'cloudrun', nativeScope: record.intent.nativeScope,
    deployment: { hostingProvider: 'cloudrun', region: s.region, preparation: { kind: 'holding-workloads', image: s.holdingImage },
      workloads: s.topology.map(item => ({ ...item, runtimeSecrets: [] })) },
    preparedResources: { schemaVersion: 1, project: { id: s.projectId, lifetimeId: s.projectCreateTime },
      registry: { id: s.artifactRepositoryName, lifetimeId: s.artifactRepositoryCreateTime, owner: hash([record.intent.customerId, record.intent.appId, record.intent.environment, s.artifactInstallationId]) },
      workloads: s.topology.map(item => { const r = resource(`gcp:holding:service:${item.name}`); return { workload: item.name, kind: 'service', id: r.id, lifetimeId: r.identity.uid, owner: s.owner,
        holding: { image: s.holdingImage, principal: principal('holding'), generation: r.identity.generation, revision: r.identity.revision, configurationDigest: r.identity.configurationDigest } }; }) },
    runtimeIdentities: s.topology.map(item => ({ workload: item.name, installationId: record.installationId, owner: s.owner, principal: principal(`runtime-${item.name}`) })),
    origins: Object.fromEntries(s.topology.filter(item => item.public).map(item => {
      resource(`gcp:holding:public:${item.name}`); return [item.name, resource(`gcp:holding:service:${item.name}`).identity.url];
    })),
    creationProofs: Object.fromEntries(actions(record.intent).map(action => [action.id, parseEvidence(record.completed[action.id], record.intent)])),
  };
}

/** Native observation of journal-proven local resources. No hosted authority,
 * writes, or interpretation of final application convergence occurs here. */
export async function readGcpLocalPreparedResources(receipt: LocalPreparedHostingReceiptV1, token: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<{ workloads: Record<string, Record<string, any>> }> {
  if (receipt.purpose !== 'local-holding' || receipt.provider !== 'gcp' || receipt.hostingProvider !== 'cloudrun') fail('identity_mismatch');
  const intent: Intent = { schemaVersion: 1, installationId: receipt.installationId, customerId: receipt.appId, appId: receipt.appId,
    environment: receipt.environment, source: receipt.source, provider: 'gcp', hostingProvider: 'cloudrun',
    execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, mode: 'connect', stage: 'scope-preparation', keys: [], nativeScope: receipt.nativeScope };
  const s = settings(intent);
  const context: Context = { intent, signal, completed: receipt.creationProofs, authentication: { kind: 'local-administrator', administrator: { getAccessToken: async () => token } },
    beforeMutation: async () => fail('authorization_revoked') };
  return withHoldingClient(context, request, async client => {
    for (const key of Object.keys(s.accounts)) {
      const evidence = parseEvidence(receipt.creationProofs[`gcp:holding:account:${key}`], intent), owned = evidence.resources[0];
      const account = await client.account(s.projectId, s.accounts[key]);
      if (!owned || !account || owned.id !== s.account(key) || account.name !== owned.id || account.email !== s.email(key) || account.projectId !== s.projectId
        || account.uniqueId !== owned.identity.uniqueId || account.description !== `hypervibe:holding:${s.owner}:${owned.identity.attemptId}` || account.disabled) fail();
    }
    const observed: Record<string, Record<string, any>> = {};
    for (const workload of s.topology) {
      const proof = parseEvidence(receipt.creationProofs[`gcp:holding:service:${workload.name}`], intent).resources[0];
      if (!proof) fail();
      const service = await client.json(`https://run.googleapis.com/v2/${s.services[workload.name]}`);
      if (service.name !== proof.id || service.uid !== proof.identity.uid || (service.labels as any)?.['hv-owner'] !== s.owner.slice(0, 63)
        || (service.labels as any)?.['hv-attempt'] !== proof.identity.attemptId || service.uri !== proof.identity.url) fail();
      if (workload.public && !hasGcpRuntimeRole(parseGcpRuntimePolicy(await client.policy('service', proof.id)), 'roles/run.invoker', 'allUsers')) fail();
      observed[workload.name] = service;
    }
    return { workloads: observed };
  }, true); // Final identities may receive separately reviewed runtime grants after preparation.
}
export function createGcpLocalHoldingCapability(): LocalHoldingPreparationCapability {
  return { schemaVersion: 1, provider: 'gcp',
    parseDeclaration({ environment, bindings, publication }) {
      const scope = bindings.providerScope as Record<string, unknown> | undefined, prep = environment.hosting.preparation;
      if (!scope || bindings.provider !== 'cloudrun' || bindings.projectId !== scope.projectId || !prep || publication.kind !== 'holding-v1' || publication.image !== prep.image
        || publication.anonymousPull !== 'verified' || Object.values(environment.services).some(service => service.workloadKind === 'cron')) fail('not_installed');
      if (publication.repository !== scope.publicArtifactRepositoryName || publication.repositoryCreateTime !== scope.publicArtifactRepositoryCreateTime) fail();
      const keys = ['projectId', 'projectNumber', 'projectCreateTime', 'projectParent', 'projectInstallationId', 'projectAttemptId', 'billingAccountName', 'artifactRepository', 'artifactRepositoryName', 'artifactRepositoryCreateTime', 'artifactInstallationId', 'artifactAttemptId'];
      return gcpLocalHoldingScopeSchema.parse({ ...Object.fromEntries(keys.map(key => [key, scope[key]])), scopeKind: 'holding-v1', region: environment.hosting.region ?? bindings.environmentId,
        holdingImage: prep.image, holdingPackageArchiveSha256: publication.packageArchiveSha256, holdingPackageLockSha256: publication.packageLockSha256,
        holdingRepository: publication.repository, holdingRepositoryCreateTime: publication.repositoryCreateTime,
        holdingRepositoryInstallationId: scope.publicArtifactInstallationId, holdingRepositoryAttemptId: scope.publicArtifactAttemptId,
        topology: JSON.stringify(Object.entries(environment.services).sort(([a], [b]) => a.localeCompare(b)).map(([name, service]) => ({ name, kind: service.workloadKind,
          public: service.workloadKind === 'web' && service.public !== false }))) });
    },
    parseRecord: value => parseCloudInstallationRecordV1(value, createGcpLocalHoldingDriver()),
    async create(nativeScope) {
      const scope = gcpLocalHoldingScopeSchema.parse(nativeScope), authentication = new GcpLocalDefaultAuthentication(scope.projectId);
      const budget = new DestinationBudget({ deadlineMs: 15_000 });
      try { await budget.wait(authentication.initialize()); } finally { budget.close(); }
      return { driver: createGcpLocalHoldingDriver({ fetch: authentication.request.bind(authentication) }), authentication: { kind: 'local-administrator', administrator: {
        async getAccessToken(scope, signal) { if (scope !== 'https://www.googleapis.com/auth/cloud-platform' || signal.aborted) fail('authorization_expired'); return authentication.token(); },
      } } };
    }, receipt: gcpLocalHoldingReceipt,
    async verifyOperatorOrigin(receipt, selection) {
      const origin = receipt.origins[selection.service], identity = receipt.runtimeIdentities.find(item => item.workload === selection.runtimeService)?.principal;
      if (!origin || !identity || identity.kind !== 'gcp-service-account'
        || !receipt.deployment.workloads.some(item => item.name === selection.service && item.kind === 'web' && item.public)
        || !receipt.deployment.workloads.some(item => item.name === selection.runtimeService)) fail('identity_mismatch');
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) fail('identity_mismatch');
      const { authentication, driver } = await this.create(receipt.nativeScope);
      const signal = AbortSignal.timeout(30_000);
      // Keep the same authenticated transport used for preparation/recovery:
      // a raw bearer-token fetch drops the user's selected quota project.
      await (driver as GcpLocalHoldingDriver).readPrepared(receipt,
        await authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', signal), signal);
      return { origin, runtimeIdentity: identity };
    },
  };
}

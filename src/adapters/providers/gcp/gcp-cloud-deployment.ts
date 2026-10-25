import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CloudInstallationAction, CloudInstallationAttempt, CloudInstallationDriver, CloudInstallationEvidence,
  CloudInstallationIntent, CloudInstallationProviderContext, CloudInstallationReason } from '../../../domain/ports/cloud-installation.port.js';
import { CloudInstallationBoundaryError } from '../../../domain/ports/cloud-installation.port.js';
import type { CloudDeploymentConnectionV1, CloudDeploymentPreparedResourcesV1, CloudDeploymentTopologyV1, CloudDeploymentReleaseTargetV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { cloudDeploymentPreparedResourcesSchema, CloudDeploymentAccessError, parseCloudDeploymentTopologyV1 } from '../../../domain/services/cloud-deployment-authentication.js';
import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { repoBindingsFileSchema } from '../../../domain/spec/repo-bindings.schema.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { GcpSecretWriterClient, type WriterIamPolicy, type WriterPolicyKind } from './gcp-secret-writer.client.js';
import { gcpHoldingConfigurationDigest, gcpHoldingServiceConfiguration, gcpObservedHoldingConfiguration } from './gcp-prepared-hosting.js';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const scopeSchema = z.object({ projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/), projectNumber: z.string().regex(/^[1-9]\d{5,29}$/) }).strict();
const imageSchema = z.string().max(2048).regex(/^[a-z][a-z0-9-]+-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/[a-z][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/);
const apiNames = ['iam.googleapis.com', 'iamcredentials.googleapis.com', 'run.googleapis.com', 'artifactregistry.googleapis.com', 'secretmanager.googleapis.com'];
const rolePermissions = {
  scope: ['resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'iam.roles.get', 'run.operations.get'],
  host: ['iam.serviceAccounts.get', 'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.getAccessToken'],
  account: ['iam.serviceAccounts.get', 'iam.serviceAccounts.getIamPolicy'],
  serviceRead: ['run.services.get', 'run.services.getIamPolicy'],
  provision: ['run.services.get', 'run.services.getIamPolicy', 'run.services.update', 'run.services.delete', 'run.revisions.get', 'run.revisions.list'],
  release: ['run.services.get', 'run.services.getIamPolicy', 'run.services.update', 'run.revisions.get', 'run.revisions.list'],
  registryRead: ['artifactregistry.repositories.get', 'artifactregistry.repositories.getIamPolicy'],
  registryRelease: ['artifactregistry.repositories.get', 'artifactregistry.repositories.downloadArtifacts', 'artifactregistry.repositories.uploadArtifacts', 'artifactregistry.dockerimages.get'],
  secretRead: ['secretmanager.secrets.get', 'secretmanager.secrets.getIamPolicy', 'secretmanager.versions.get'],
};
type Role = keyof typeof rolePermissions;
const installPermissions = ['resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'resourcemanager.projects.setIamPolicy',
  'iam.roles.create', 'iam.roles.get', 'iam.serviceAccounts.create', 'iam.serviceAccounts.get', 'iam.serviceAccounts.actAs',
  'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.setIamPolicy', 'secretmanager.secrets.get', 'secretmanager.secrets.getIamPolicy',
  'secretmanager.secrets.setIamPolicy', 'secretmanager.versions.get', 'serviceusage.services.get', 'serviceusage.services.enable', 'run.services.create', 'run.services.get',
  'run.services.getIamPolicy', 'run.services.setIamPolicy', 'artifactregistry.repositories.create', 'artifactregistry.repositories.get',
  'artifactregistry.repositories.getIamPolicy', 'artifactregistry.repositories.setIamPolicy'];
const operations = ['verify-scope', 'verify-secret', 'enable-api', 'create-role', 'create-account', 'create-registry', 'create-service', 'grant', 'revoke', 'verify-deployment'] as const;
type Context = CloudInstallationProviderContext;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
function fail(reason: CloudInstallationReason = 'identity_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function reason(error: unknown): CloudInstallationReason {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof DestinationBoundaryError) return error.status === 403 ? 'insufficient_permissions' : error.status === 401 ? 'authorization_expired'
    : error.code === 'deadline_exceeded' ? 'timeout' : error.code === 'scope_mismatch' ? 'identity_mismatch' : 'provider_error';
  return 'provider_error';
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const description = (owner: string, id: string) => `hypervibe:deployment:v1:${owner}:${id}`;
const date = z.string().datetime({ offset: true });
const proofSchema = z.object({ id: z.string().regex(/^projects\/[1-9]\d+$/), lifetimeId: date }).strict();
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['project', 'api', 'role', 'account', 'registry', 'service', 'secret']),
  id: z.string().max(2048).regex(/^projects\/[A-Za-z0-9_.@/-]+$/), identity: z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    attemptId: z.string().guid().optional(), uniqueId: z.string().regex(/^[1-9]\d{5,29}$/).optional(), createTime: date.optional(),
    uid: z.string().guid().optional(), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    revision: z.string().max(2048).optional(), generation: z.string().regex(/^[1-9]\d*$/).optional() }).strict() }).strict()).max(6),
  native: z.object({ operation: z.enum(operations), installationId: z.string().guid(), owner: z.string().regex(/^[a-f0-9]{64}$/),
    actionId: z.string().max(512), attemptId: z.string().guid().optional(), grant: z.object({ policyKind: z.enum(['project', 'account', 'secret', 'service', 'registry']),
      resource: z.string().max(2048), role: z.string().max(512), member: z.string().max(512), retained: z.boolean() }).strict().optional() }).strict(),
}).strict();

function settings(intent: CloudInstallationIntent) {
  if (intent.provider !== 'gcp' || intent.purpose !== 'deployment' || intent.stage !== 'deployment' || !['connect', 'disconnect'].includes(intent.mode) || intent.keys.length) fail();
  const scope = scopeSchema.parse(intent.nativeScope), topology = parseCloudDeploymentTopologyV1(intent.deployment);
  // Every retained item is strictly validated by parseEvidence, including the
  // same original installation ID. Avoid reparsing the entire journal for each
  // individual action/evidence validation (quadratic work during cleanup).
  const originalId = intent.mode === 'disconnect' ? intent.installed?.[0]?.native.installationId : intent.installationId;
  if (!z.string().guid().safeParse(originalId).success || topology.hostingProvider !== 'cloudrun' || !topology.preparation
    || !/^[a-z]+-[a-z]+\d$/.test(topology.region) || topology.workloads.length > 16 || topology.workloads.some(item => item.kind === 'cron' || typeof item.public !== 'boolean')) fail();
  const installationId = String(originalId), parts = [intent.customerId, intent.appId, intent.environment, installationId], owner = digest(parts);
  imageSchema.parse(topology.preparation.image);
  const accountKeys = ['provision', 'release', 'holding', ...topology.workloads.map(item => `runtime:${item.name}`)];
  const accounts = Object.fromEntries(accountKeys.map(key => [key, resourceName(key.replace(':', '-'), { scope: parts, maxLength: 30 })]));
  const account = (key: string) => `projects/${scope.projectId}/serviceAccounts/${accounts[key]}@${scope.projectId}.iam.gserviceaccount.com`;
  const email = (key: string) => `${accounts[key]}@${scope.projectId}.iam.gserviceaccount.com`;
  const roles = Object.fromEntries(Object.keys(rolePermissions).map(key => [key, `projects/${scope.projectId}/roles/${resourceName(key, { scope: parts, compact: true })}`])) as Record<Role, string>;
  const registry = `projects/${scope.projectId}/locations/${topology.region}/repositories/${resourceName('images', { scope: [intent.customerId, intent.appId, intent.environment] })}`;
  const services = Object.fromEntries(topology.workloads.map(item => [item.name,
    `projects/${scope.projectId}/locations/${topology.region}/services/${resourceName(item.name, { maxLength: 49, scope: [scope.projectId, intent.environment] })}`]));
  const refs = new Map<string, string>();
  for (const workload of topology.workloads) for (const item of workload.runtimeSecrets) {
    const d = item.reference.destination;
    if (d.provider !== 'gcp-secret-manager' || d.projectId !== scope.projectId || d.projectNumber !== scope.projectNumber) fail();
    const id = `projects/${scope.projectNumber}/secrets/${d.secretId}`;
    if (refs.has(id) && refs.get(id) !== item.reference.version) fail(); refs.set(id, item.reference.version);
  }
  if (refs.size > 32 || new Set(Object.values(accounts)).size !== accountKeys.length || new Set(Object.values(services)).size !== topology.workloads.length) fail();
  return { ...scope, topology, installationId, owner, accounts, account, email, roles, registry, services, refs };
}
function topology(spec: ProjectSpec, intent: CloudInstallationIntent, holdingImage: string | undefined): CloudDeploymentTopologyV1 {
  const env = spec.environments[intent.environment];
  if (!env || env.hosting.provider !== 'cloudrun' || env.database || env.cache || env.domain || env.loadBalancer || env.migrations
    || Object.keys(env.storage ?? {}).length || Object.keys(env.queues ?? {}).length
    || Object.values(env.services).some(item => item.volume || item.releaseCommand || item.workloadKind === 'cron')) throw new CloudDeploymentAccessError('unsupported');
  const image = imageSchema.parse(holdingImage), refs = Object.entries(env.secretDestinations ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, reference]) => ({ key, reference: runtimeSecretReferenceSchema.parse(reference) }));
  return parseCloudDeploymentTopologyV1({ hostingProvider: 'cloudrun', region: env.hosting.region ?? 'us-central1',
    preparation: { kind: 'holding-workloads', image }, workloads: Object.entries(env.services).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, service]) => ({ name, kind: service.workloadKind, public: service.public ?? service.workloadKind === 'web', runtimeSecrets: refs })) });
}
function action(id: string, operation: typeof operations[number], name: string, category: CloudInstallationAction['metadata']['category'],
  native: Record<string, unknown>, dependsOn: string[] = []): CloudInstallationAction {
  return { id: `gcp:deployment:${id}`, type: ['verify-scope', 'verify-secret'].includes(operation) ? 'noop' : ['grant', 'revoke', 'verify-deployment'].includes(operation) ? 'update' : 'create',
    resource: { kind: 'project', name, provider: 'gcp' }, verified: true, requiresConfirm: !['verify-scope', 'verify-secret'].includes(operation),
    reason: operation === 'revoke' ? 'Remove only reviewed hosted deployment access; preserve application resources and runtime readers.'
      : 'Prepare isolated Google deployment resources and narrow native identities for this app and environment.',
    ...(['create-registry', 'create-service'].includes(operation) ? { billable: true, dataBearing: true } : {}),
    dependsOn: dependsOn.map(id => id.startsWith('gcp:deployment:') ? id : `gcp:deployment:${id}`), metadata: { operation, category, execution: 'api', native } };
}
function actions(intent: CloudInstallationIntent, project: z.infer<typeof proofSchema>, secretLifetimes: Record<string, string> = {}): CloudInstallationAction[] {
  const s = settings(intent);
  if (intent.mode === 'disconnect') return (intent.installed ?? []).map(item => parseEvidence(item, intent)).filter(item => item.native.operation === 'grant'
    && item.native.grant && !(item.native.grant as any).retained).map((item, index) => action(`revoke:${index}`, 'revoke', String((item.native.grant as any).resource), 'trust', { evidence: item }));
  const result = [action('scope', 'verify-scope', project.id, 'scope', project)];
  for (const [id] of s.refs) result.push(action(`secret:${id.split('/').at(-1)}`, 'verify-secret', id, 'scope',
    { id, lifetimeId: secretLifetimes[id] ?? '2000-01-01T00:00:00Z' }, ['scope']));
  const prerequisites = ['scope', ...[...s.refs.keys()].map(id => `secret:${id.split('/').at(-1)}`)];
  for (const api of apiNames) result.push(action(`api:${api}`, 'enable-api', `projects/${s.projectNumber}/services/${api}`, 'scope', { api }, prerequisites));
  for (const role of Object.keys(rolePermissions) as Role[]) result.push(action(`role:${role}`, 'create-role', s.roles[role], 'identity', { role }, ['api:iam.googleapis.com']));
  for (const key of Object.keys(s.accounts)) result.push(action(`account:${key}`, 'create-account', s.account(key), 'identity', { key }, ['api:iam.googleapis.com']));
  result.push(action('registry', 'create-registry', s.registry, 'scope', {}, ['api:artifactregistry.googleapis.com']));
  for (const workload of s.topology.workloads) result.push(action(`service:${workload.name}`, 'create-service', s.services[workload.name], 'scope', { workload: workload.name },
    ['api:run.googleapis.com', 'account:holding', 'registry']));
  const grant = (id: string, policyKind: WriterPolicyKind, resource: string, role: Role | 'roles/iam.serviceAccountUser' | 'roles/secretmanager.secretAccessor' | 'roles/run.invoker',
    member: string, prerequisites: string[], retained = false) => result.push(action(`grant:${id}`, 'grant', resource, 'trust',
    { policyKind, resource, role: role.startsWith('roles/') ? role : s.roles[role as Role], member, retained }, [...prerequisites, ...(!role.startsWith('roles/') ? [`role:${role}`] : [])]));
  for (const key of ['provision', 'release']) {
    grant(`scope:${key}`, 'project', project.id, 'scope', `serviceAccount:${s.email(key)}`, [`account:${key}`]);
    grant(`host:${key}`, 'account', s.account(key), 'host', `serviceAccount:${intent.hostIdentity.serviceAccountEmail}`, [`account:${key}`]);
    grant(`registry:${key}`, 'registry', s.registry, key === 'release' ? 'registryRelease' : 'registryRead', `serviceAccount:${s.email(key)}`, ['registry', `account:${key}`]);
  }
  grant('scope:host', 'project', project.id, 'scope', `serviceAccount:${intent.hostIdentity.serviceAccountEmail}`, ['scope']);
  grant('registry:host', 'registry', s.registry, 'registryRead', `serviceAccount:${intent.hostIdentity.serviceAccountEmail}`, ['registry']);
  for (const key of Object.keys(s.accounts)) for (const reader of ['host', 'provision', 'release']) {
    if ((key === 'provision' || key === 'release') && reader === 'host') continue;
    grant(`account:${key}:${reader}`, 'account', s.account(key), 'account', `serviceAccount:${reader === 'host' ? intent.hostIdentity.serviceAccountEmail : s.email(reader)}`,
      [`account:${key}`, ...(reader === 'host' ? [] : [`account:${reader}`])]);
  }
  for (const workload of s.topology.workloads) {
    const key = `runtime:${workload.name}`;
    for (const deployer of ['provision', 'release']) {
      grant(`runtime:${workload.name}:${deployer}`, 'account', s.account(key), 'roles/iam.serviceAccountUser', `serviceAccount:${s.email(deployer)}`, [`account:${key}`, `account:${deployer}`]);
      grant(`service:${workload.name}:${deployer}`, 'service', s.services[workload.name], deployer as Role, `serviceAccount:${s.email(deployer)}`, [`service:${workload.name}`, `account:${deployer}`]);
    }
    grant(`service:${workload.name}:host`, 'service', s.services[workload.name], 'serviceRead', `serviceAccount:${intent.hostIdentity.serviceAccountEmail}`, [`service:${workload.name}`]);
    for (const item of workload.runtimeSecrets) {
      const d = item.reference.destination; if (d.provider !== 'gcp-secret-manager') fail();
      grant(`reader:${workload.name}:${item.key}`, 'secret', `projects/${s.projectNumber}/secrets/${d.secretId}`, 'roles/secretmanager.secretAccessor', `serviceAccount:${s.email(key)}`, [`account:${key}`, 'api:secretmanager.googleapis.com'], true);
    }
    if (workload.public) grant(`public:${workload.name}`, 'service', s.services[workload.name], 'roles/run.invoker', 'allUsers', [`service:${workload.name}`], true);
  }
  for (const [secret] of s.refs) for (const reader of ['host', 'provision', 'release']) grant(`secret:${secret.split('/').at(-1)}:${reader}`, 'secret', secret, 'secretRead',
    `serviceAccount:${reader === 'host' ? intent.hostIdentity.serviceAccountEmail : s.email(reader)}`, ['api:secretmanager.googleapis.com', ...(reader === 'host' ? [] : [`account:${reader}`])]);
  result.push(action('verify', 'verify-deployment', project.id, 'verification', {}, result.map(item => item.id)));
  if (result.length > 300) throw new CloudDeploymentAccessError('unsupported');
  return result;
}
function parseEvidence(value: unknown, intent: CloudInstallationIntent): CloudInstallationEvidence {
  const parsed = evidenceSchema.parse(value), s = settings(intent);
  if (parsed.native.installationId !== s.installationId || parsed.native.owner !== s.owner) fail('ownership_mismatch');
  const allowed: Record<string, string[]> = { project: [`projects/${s.projectNumber}`], api: apiNames.map(api => `projects/${s.projectNumber}/services/${api}`),
    role: Object.values(s.roles), account: Object.keys(s.accounts).map(s.account), registry: [s.registry], service: Object.values(s.services), secret: [...s.refs.keys()] };
  for (const item of parsed.resources) {
    if (!allowed[item.kind]?.includes(item.id)) fail();
    if (['account', 'role', 'registry', 'service'].includes(item.kind) && (item.identity.owner !== s.owner || !item.identity.attemptId)) fail('ownership_mismatch');
    if (item.kind === 'account' && !item.identity.uniqueId || ['project', 'registry', 'secret'].includes(item.kind) && !item.identity.createTime
      || item.kind === 'service' && (!item.identity.uid || !item.identity.configurationDigest || !item.identity.generation
        || !item.identity.revision?.startsWith(`${item.id}/revisions/`))) fail();
  }
  if (parsed.native.operation === 'grant' || parsed.native.operation === 'revoke') {
    const original = { ...intent, mode: 'connect' as const, installationId: s.installationId, installed: undefined };
    const expected = actions(original, { id: `projects/${s.projectNumber}`, lifetimeId: '2000-01-01T00:00:00Z' })
      .filter(item => item.metadata.operation === 'grant');
    if (!parsed.native.grant || !expected.some(item => (parsed.native.operation === 'revoke' || item.id === parsed.native.actionId)
      && isDeepStrictEqual(item.metadata.native, parsed.native.grant))) fail('ownership_mismatch');
  }
  return parsed;
}
type NativeDeploymentProof = Omit<CloudDeploymentConnectionV1, 'planDigest'>;
function receiptIntent(connection: NativeDeploymentProof): CloudInstallationIntent {
  return { schemaVersion: 1, purpose: 'deployment', stage: 'deployment', mode: 'connect', keys: [], installationId: connection.installationId,
    customerId: connection.customerId, appId: connection.appId, environment: connection.environment, provider: 'gcp',
    source: connection.source, nativeScope: connection.nativeScope, hostIdentity: connection.hostIdentity, deployment: connection.deployment };
}
/** Closed native preparation proof shared by hosted issuance and local adapter admission. */
export function parseGcpPreparedResources(value: unknown, connection: NativeDeploymentProof): CloudDeploymentPreparedResourcesV1 {
  const parsed = cloudDeploymentPreparedResourcesSchema.parse(value), s = settings(receiptIntent(connection));
  if (parsed.project.id !== `projects/${s.projectNumber}` || !date.safeParse(parsed.project.lifetimeId).success || parsed.project.parentId !== undefined
    || parsed.registry.id !== s.registry || !date.safeParse(parsed.registry.lifetimeId).success || parsed.registry.owner !== s.owner
    || parsed.workloads.length !== s.topology.workloads.length) fail();
  for (const key of ['provision', 'release'] as const) {
    const principal = connection.principals[key];
    if (principal.kind !== 'gcp-service-account' || principal.serviceAccountEmail !== s.email(key)) fail();
  }
  for (const workload of s.topology.workloads) {
    const item = parsed.workloads.find(item => item.workload === workload.name), runtime = connection.runtimeIdentities.find(item => item.workload === workload.name);
    if (!item || item.kind !== 'service' || item.id !== s.services[workload.name] || item.owner !== s.owner || !z.string().guid().safeParse(item.lifetimeId).success
      || item.holding.image !== s.topology.preparation!.image || item.holding.principal.kind !== 'gcp-service-account'
      || item.holding.principal.projectId !== s.projectId || item.holding.principal.projectNumber !== s.projectNumber
      || item.holding.principal.serviceAccountEmail !== s.email('holding')
      || !item.holding.generation || !item.holding.revision?.startsWith(`${item.id}/revisions/`)
      || item.holding.configurationDigest !== gcpHoldingConfigurationDigest(gcpHoldingServiceConfiguration(item.holding.image, s.email('holding'), workload.public!))
      || !runtime || runtime.owner !== s.owner || runtime.installationId !== s.installationId || runtime.principal.kind !== 'gcp-service-account'
      || runtime.principal.serviceAccountEmail !== s.email(`runtime:${workload.name}`)) fail();
  }
  if (new Set(parsed.workloads.map(item => item.holding.principal.kind === 'gcp-service-account' ? item.holding.principal.serviceAccountUniqueId : '')).size !== 1) fail();
  const secrets = parsed.secretTargets ?? [];
  if (secrets.length !== s.refs.size || secrets.some(item => !s.refs.has(item.id) || !date.safeParse(item.lifetimeId).success)) fail();
  return parsed;
}

export interface GcpPreparedNativeObservation {
  project: Record<string, unknown>; registry: Record<string, unknown>; workloads: Record<string, Record<string, unknown>>;
}
export interface GcpCloudDeploymentDriver extends CloudInstallationDriver {
  /** Provider-internal read proof shared by receipt sessions and local binding inspection. */
  readPrepared(connection: CloudDeploymentConnectionV1, token: string, signal: AbortSignal): Promise<GcpPreparedNativeObservation>;
}
export function createGcpCloudDeploymentDriver(options: { fetch?: typeof fetch; holdingImage?: string } = {}): GcpCloudDeploymentDriver {
  const request = options.fetch ?? fetch;
  async function withClient<T>(context: Context, work: (client: GcpSecretWriterClient, budget: DestinationBudget) => Promise<T>): Promise<T> {
    settings(context.intent); if (!context.authentication.administrator) fail('authorization_expired');
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30000 });
    try {
      const token = await budget.wait(context.authentication.administrator.getAccessToken(SCOPE, budget.signal));
      return await work(new GcpSecretWriterClient({ token, budget, request, beforeWrite: context.beforeMutation, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }), budget);
    } finally { budget.close(); }
  }
  async function project(client: GcpSecretWriterClient, intent: CloudInstallationIntent) {
    const s = settings(intent), result = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${s.projectNumber}`);
    if (result.name !== `projects/${s.projectNumber}` || result.projectId !== s.projectId || result.state !== 'ACTIVE') fail();
    // Project-only Cloud Asset queries exclude ancestor policies. Until the
    // complete ancestry can be independently verified, this path is no-org only.
    if (result.parent !== undefined && result.parent !== '') fail('insufficient_permissions');
    await scopeAuthority(client, s, await client.policy('project', `projects/${s.projectNumber}`), intent.hostIdentity.serviceAccountEmail);
    return proofSchema.parse({ id: result.name, lifetimeId: result.createTime });
  }
  async function scopeAuthority(client: GcpSecretWriterClient, s: ReturnType<typeof settings>, policy: WriterIamPolicy, host: string) {
    const controlled = new Set([host, ...Object.keys(s.accounts).map(s.email)]);
    for (const binding of policy.bindings) for (const member of binding.members) {
      // Group/principal-set membership cannot be established from this policy.
      // Absence of a direct named grant is not a negative authorization proof.
      if (!member.startsWith('user:') && !member.startsWith('deleted:user:') && !member.startsWith('serviceAccount:')
        && !member.startsWith('deleted:serviceAccount:')) fail('insufficient_permissions');
      if (!member.startsWith('serviceAccount:') || !controlled.has(member.slice('serviceAccount:'.length))) continue;
      if (binding.condition || ![`serviceAccount:${host}`, `serviceAccount:${s.email('provision')}`, `serviceAccount:${s.email('release')}`].includes(member)) fail('insufficient_permissions');
      // Existing collection verifiers may retain a separate read-only custom
      // role. Inspect actual permissions; never infer safety from its name.
      if (!binding.role.startsWith(`projects/${s.projectId}/roles/`)) fail('insufficient_permissions');
      const role = await client.role(binding.role);
      if (!role || role.includedPermissions.some(permission => !rolePermissions.scope.includes(permission))) fail('insufficient_permissions');
    }
  }
  async function publicImage(image: string, budget: DestinationBudget) {
    imageSchema.parse(image);
    const [host, projectId, repository, ...tail] = image.split('/'), region = host.slice(0, -'-docker.pkg.dev'.length), name = tail.join('/');
    const resource = `projects/${projectId}/locations/${region}/repositories/${repository}/dockerImages/${name}`;
    const response = await budget.wait(request(`https://artifactregistry.googleapis.com/v1/projects/${projectId}/locations/${region}/repositories/${repository}/dockerImages/${encodeURIComponent(name)}`,
      { redirect: 'error', signal: budget.signal }));
    if (!response.ok || response.redirected || !response.body) { void response.body?.cancel().catch(() => {}); fail('not_installed'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const item = await budget.wait(reader.read()); if (item.done) break; length += item.value.byteLength; if (length > 65536) fail(); chunks.push(item.value); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (value.name !== resource || value.uri !== image) fail();
    } catch (error) { void reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  }
  function evidence(context: ActionContext, resources: CloudInstallationEvidence['resources'], grant?: Record<string, unknown>) {
    const s = settings(context.intent);
    return parseEvidence({ resources, native: { operation: context.action.metadata.operation, installationId: s.installationId, owner: s.owner,
      actionId: context.action.id, ...(context.attempt ? { attemptId: context.attempt.id } : {}), ...(grant ? { grant } : {}) } }, context.intent);
  }
  function completed(context: Context, key: string) {
    const value = context.completed[`gcp:deployment:${key}`]; if (!value) fail('ownership_mismatch');
    const result = parseEvidence(value, context.intent).resources[0]; if (!result) fail(); return result;
  }
  async function read(client: GcpSecretWriterClient, url: string) {
    try { return await client.json(url); }
    catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
  }
  async function secretProof(client: GcpSecretWriterClient, s: ReturnType<typeof settings>, name: string) {
    const secret = await client.json(`https://secretmanager.googleapis.com/v1/${name}`);
    const version = await client.json(`https://secretmanager.googleapis.com/v1/${name}/versions/${s.refs.get(name)}`);
    if (!s.refs.has(name) || secret.name !== name || !date.safeParse(secret.createTime).success
      || version.name !== `${name}/versions/${s.refs.get(name)}` || version.state !== 'ENABLED') fail();
    return { kind: 'secret' as const, id: name, identity: { createTime: String(secret.createTime) } };
  }
  function ownerAttempt(context: ActionContext, value: Record<string, unknown>, kind: string) {
    const s = settings(context.intent);
    const nativeAttempt = kind === 'account' && typeof value.displayName === 'string'
      ? /^Hypervibe ([a-f0-9-]{36})$/.exec(value.displayName)?.[1]
      : kind === 'service' ? (value.annotations as Record<string, unknown> | undefined)?.['hypervibe.dev/attempt']
        : typeof value.description === 'string' ? value.description.split(':').at(-1) : undefined;
    const expectedAttempt = context.attempt?.id ?? context.completed[context.action.id]?.resources[0]?.identity.attemptId;
    if (!expectedAttempt || nativeAttempt !== expectedAttempt || !z.string().guid().safeParse(nativeAttempt).success) fail('ownership_mismatch');
    if (kind === 'service') {
      const annotations = value.annotations as Record<string, unknown>;
      if (annotations['hypervibe.dev/owner'] !== s.owner || annotations['hypervibe.dev/installation'] !== s.installationId) fail('ownership_mismatch');
    } else if (value.description !== description(s.owner, s.installationId) + (kind === 'account' ? '' : `:${nativeAttempt}`)) fail('ownership_mismatch');
    return { owner: s.owner, attemptId: String(nativeAttempt) };
  }
  async function observeResource(client: GcpSecretWriterClient, context: ActionContext): Promise<CloudInstallationEvidence['resources'][number] | null> {
    const s = settings(context.intent), op = context.action.metadata.operation, name = context.action.resource.name;
    const native = context.action.metadata.native;
    if (op === 'create-account') {
      const value = await read(client, `https://iam.googleapis.com/v1/${name}`); if (!value) return null;
      const marker = ownerAttempt(context, value, 'account');
      if (value.name !== name || value.projectId !== s.projectId || value.email !== s.email(String(native.key))
        || !z.string().regex(/^[1-9]\d{5,29}$/).safeParse(value.uniqueId).success || value.disabled !== undefined && value.disabled !== false) fail();
      return { kind: 'account', id: name, identity: { ...marker, uniqueId: String(value.uniqueId) } };
    }
    if (op === 'create-role') {
      const value = await read(client, `https://iam.googleapis.com/v1/${name}?view=FULL`); if (!value) return null;
      const marker = ownerAttempt(context, value, 'role');
      if (value.name !== name || value.stage !== 'GA' || value.deleted !== undefined && value.deleted !== false || !Array.isArray(value.includedPermissions)
        || !isDeepStrictEqual([...value.includedPermissions].sort(), [...rolePermissions[native.role as Role]].sort())) fail();
      return { kind: 'role', id: name, identity: marker };
    }
    if (op === 'create-registry') {
      const value = await read(client, `https://artifactregistry.googleapis.com/v1/${name}`); if (!value) return null;
      const marker = ownerAttempt(context, value, 'registry');
      if (value.name !== name || value.format !== 'DOCKER' || value.mode !== 'STANDARD_REPOSITORY' || !date.safeParse(value.createTime).success
        || value.remoteRepositoryConfig || value.virtualRepositoryConfig || value.kmsKeyName) fail();
      return { kind: 'registry', id: name, identity: { ...marker, createTime: String(value.createTime) } };
    }
    if (op === 'create-service') {
      const value = await read(client, `https://run.googleapis.com/v2/${name}`); if (!value) return null;
      const marker = ownerAttempt(context, value, 'service'), workload = s.topology.workloads.find(item => item.name === native.workload)!;
      const saved = context.completed[context.action.id]?.resources[0];
      if (saved && value.uid !== saved.identity.uid) fail();
      if (saved && (value.template as Record<string, unknown>)?.serviceAccount !== s.email('holding')) {
        applicationIdentity(value, s, workload.name);
        // Preserve the original creation proof after an independently
        // authorized rollout. This does not claim app configuration convergence.
        return saved;
      }
      const configuration = gcpObservedHoldingConfiguration(value, { id: name, image: s.topology.preparation!.image,
        serviceAccountEmail: s.email('holding'), publicAccess: workload.public! });
      if (saved && (value.generation !== saved.identity.generation || value.latestReadyRevision !== saved.identity.revision)) fail();
      return { kind: 'service', id: name, identity: { ...marker, uid: String(value.uid), configurationDigest: gcpHoldingConfigurationDigest(configuration),
        generation: String(value.generation), revision: String(value.latestReadyRevision) } };
    }
    return fail();
  }
  async function grantResources(client: GcpSecretWriterClient, context: ActionContext, grant: Record<string, unknown>) {
    const s = settings(context.intent), resources: CloudInstallationEvidence['resources'] = [];
    const kind = grant.policyKind as WriterPolicyKind, name = String(grant.resource);
    if (kind === 'project') {
      const native = await project(client, context.intent), expected = completed(context, 'scope');
      if (native.lifetimeId !== expected.identity.createTime) fail(); resources.push(expected);
    } else if (kind === 'secret') {
      const actual = await secretProof(client, s, name), expected = completed(context, `secret:${name.split('/').at(-1)}`);
      if (!isDeepStrictEqual(actual, expected)) fail(); resources.push(expected);
    } else {
      const key = kind === 'registry' ? 'registry' : kind === 'service' ? `service:${s.topology.workloads.find(item => s.services[item.name] === name)?.name}`
        : `account:${Object.keys(s.accounts).find(key => s.account(key) === name)}`;
      const expected = completed(context, key);
      const action = actions(context.intent, { id: `projects/${s.projectNumber}`, lifetimeId: completed(context, 'scope').identity.createTime }).find(item => item.id === `gcp:deployment:${key}`)!;
      const actual = await observeResource(client, { ...context, action, attempt: undefined });
      if (!actual || !isDeepStrictEqual(actual, expected)) fail(); resources.push(actual);
    }
    const memberKey = Object.keys(s.accounts).find(key => `serviceAccount:${s.email(key)}` === grant.member);
    if (memberKey && !resources.some(item => item.id === s.account(memberKey))) {
      const expected = completed(context, `account:${memberKey}`), account = await client.json(`https://iam.googleapis.com/v1/projects/${s.projectId}/serviceAccounts/${expected.identity.uniqueId}`);
      if (account.uniqueId !== expected.identity.uniqueId || account.email !== s.email(memberKey) || account.disabled === true
        || account.description !== description(s.owner, s.installationId)) fail(); resources.push(expected);
    }
    const roleKey = (Object.keys(s.roles) as Role[]).find(key => s.roles[key] === grant.role);
    if (roleKey) {
      const expected = completed(context, `role:${roleKey}`), actual = await client.role(s.roles[roleKey]);
      if (!actual || actual.description !== `${description(s.owner, s.installationId)}:${expected.identity.attemptId}`
        || !isDeepStrictEqual([...actual.includedPermissions].sort(), [...rolePermissions[roleKey]].sort())) fail(); resources.push(expected);
    }
    return resources;
  }
  function grantPolicyResource(context: Context, grant: Record<string, unknown>): string {
    if (grant.policyKind !== 'account') return String(grant.resource);
    const s = settings(context.intent), key = Object.keys(s.accounts).find(key => s.account(key) === grant.resource);
    if (!key) fail();
    return `projects/${s.projectId}/serviceAccounts/${completed(context, `account:${key}`).identity.uniqueId}`;
  }
  async function retainedResource(client: GcpSecretWriterClient, resource: CloudInstallationEvidence['resources'][number], intent: CloudInstallationIntent) {
    const s = settings(intent);
    const host = resource.kind === 'registry' ? 'artifactregistry.googleapis.com/v1' : resource.kind === 'service' ? 'run.googleapis.com/v2'
      : resource.kind === 'secret' ? 'secretmanager.googleapis.com/v1' : resource.kind === 'project' ? 'cloudresourcemanager.googleapis.com/v3' : 'iam.googleapis.com/v1';
    const name = resource.kind === 'account' ? `projects/${s.projectId}/serviceAccounts/${resource.identity.uniqueId}` : resource.id;
    const value = await read(client, `https://${host}/${name}`); if (!value) return null;
    if (value.name !== resource.id || resource.identity.uniqueId && value.uniqueId !== resource.identity.uniqueId
      || resource.identity.uid && value.uid !== resource.identity.uid || resource.identity.createTime && value.createTime !== resource.identity.createTime) fail();
    if (resource.kind === 'account' && (value.disabled === true || value.description !== description(s.owner, s.installationId))) fail('ownership_mismatch');
    if (resource.kind === 'role') {
      const role = (Object.keys(s.roles) as Role[]).find(key => s.roles[key] === resource.id)!;
      if (value.description !== `${description(s.owner, s.installationId)}:${resource.identity.attemptId}` || value.stage !== 'GA' || value.deleted === true
        || !Array.isArray(value.includedPermissions) || !isDeepStrictEqual([...value.includedPermissions].sort(), [...rolePermissions[role]].sort())) fail('ownership_mismatch');
    }
    if (resource.kind === 'registry' && (value.description !== `${description(s.owner, s.installationId)}:${resource.identity.attemptId}` || value.format !== 'DOCKER' || value.mode !== 'STANDARD_REPOSITORY')) fail('ownership_mismatch');
    if (resource.kind === 'service' && ((value.annotations as any)?.['hypervibe.dev/owner'] !== s.owner
      || (value.annotations as any)?.['hypervibe.dev/installation'] !== s.installationId || (value.annotations as any)?.['hypervibe.dev/attempt'] !== resource.identity.attemptId)) fail('ownership_mismatch');
    return value;
  }
  async function cleanupGrant(client: GcpSecretWriterClient, context: ActionContext) {
    const original = parseEvidence(context.action.metadata.native.evidence, context.intent), grant = original.native.grant as Record<string, unknown>;
    if (original.native.operation !== 'grant' || !grant || grant.retained) fail('ownership_mismatch');
    let absent = false;
    for (const item of original.resources) if (!await retainedResource(client, item, context.intent)) absent = true;
    const account = grant.policyKind === 'account' ? original.resources.find(item => item.kind === 'account' && item.id === grant.resource) : undefined;
    const resource = account ? `projects/${settings(context.intent).projectId}/serviceAccounts/${account.identity.uniqueId}` : String(grant.resource);
    return { original, grant, resource, absent };
  }
  // Internal native proof is not a ready receipt: no plan digest or installation
  // status is invented. Public projection stays behind the shared ready gate.
  function nativeProof(context: Context): NativeDeploymentProof {
    const s = settings(context.intent);
    const principal = (key: string) => ({ kind: 'gcp-service-account' as const, projectId: s.projectId, projectNumber: s.projectNumber,
      serviceAccountEmail: s.email(key), serviceAccountUniqueId: completed(context, `account:${key}`).identity.uniqueId });
    const connection: NativeDeploymentProof = { schemaVersion: 1, purpose: 'deployment', installationId: s.installationId,
      customerId: context.intent.customerId, appId: context.intent.appId, environment: context.intent.environment, source: context.intent.source,
      provider: 'gcp', hostingProvider: 'cloudrun', nativeScope: context.intent.nativeScope, hostIdentity: context.intent.hostIdentity, deployment: s.topology,
      principals: { provision: principal('provision'), release: principal('release') },
      runtimeIdentities: s.topology.workloads.map(item => ({ workload: item.name, installationId: s.installationId, owner: s.owner, principal: principal(`runtime:${item.name}`) })),
      preparedResources: { schemaVersion: 1, project: { id: `projects/${s.projectNumber}`, lifetimeId: completed(context, 'scope').identity.createTime },
        registry: { id: s.registry, lifetimeId: completed(context, 'registry').identity.createTime, owner: s.owner },
        secretTargets: [...s.refs.keys()].map(id => { const proof = Object.values(context.completed).flatMap(item => parseEvidence(item, context.intent).resources)
          .find(item => item.kind === 'secret' && item.id === id); if (!proof) fail(); return { id, lifetimeId: proof.identity.createTime }; }),
        workloads: s.topology.workloads.map(item => ({ workload: item.name, kind: 'service', id: s.services[item.name],
          lifetimeId: completed(context, `service:${item.name}`).identity.uid, owner: s.owner,
          holding: { image: s.topology.preparation!.image, principal: principal('holding'), configurationDigest: completed(context, `service:${item.name}`).identity.configurationDigest,
            revision: completed(context, `service:${item.name}`).identity.revision, generation: completed(context, `service:${item.name}`).identity.generation } })) } };
    parseGcpPreparedResources(connection.preparedResources, connection); return connection;
  }
  function applicationIdentity(native: Record<string, unknown>, s: ReturnType<typeof settings>, workload: string) {
    const template = native.template as Record<string, any> | undefined, image = template?.containers?.[0]?.image;
    const prefix = `${s.topology.region}-docker.pkg.dev/${s.projectId}/${s.registry.split('/').at(-1)}/`;
    if (template?.serviceAccount !== s.email(`runtime:${workload}`) || !Array.isArray(template.containers) || template.containers.length !== 1
      || typeof image !== 'string' || !image.startsWith(prefix) || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image)
      || typeof native.etag !== 'string' || !native.etag || !/^[1-9]\d*$/.test(String(native.generation))
      || native.observedGeneration !== native.generation || native.reconciling === true
      || (native.terminalCondition as any)?.state !== 'CONDITION_SUCCEEDED'
      || typeof native.latestCreatedRevision !== 'string' || !native.latestCreatedRevision.startsWith(`${native.name}/revisions/`)
      || native.latestReadyRevision !== native.latestCreatedRevision) fail();
  }
  async function readPreparedWithClient(client: GcpSecretWriterClient, connection: NativeDeploymentProof): Promise<GcpPreparedNativeObservation> {
    const prepared = parseGcpPreparedResources(connection.preparedResources, connection), intent = receiptIntent(connection), s = settings(intent);
    const nativeProject = await project(client, intent);
    if (nativeProject.id !== prepared.project.id || nativeProject.lifetimeId !== prepared.project.lifetimeId) fail();
    const accounts = [...Object.values(connection.principals), ...connection.runtimeIdentities.map(item => item.principal), prepared.workloads[0].holding.principal];
    for (const principal of accounts) {
      if (principal.kind !== 'gcp-service-account') fail();
      const native = await client.json(`https://iam.googleapis.com/v1/projects/${s.projectId}/serviceAccounts/${principal.serviceAccountUniqueId}`);
      if (native.name !== `projects/${s.projectId}/serviceAccounts/${principal.serviceAccountEmail}` || native.projectId !== s.projectId
        || native.email !== principal.serviceAccountEmail || native.uniqueId !== principal.serviceAccountUniqueId
        || native.disabled !== undefined && native.disabled !== false || native.description !== description(s.owner, s.installationId)) fail('ownership_mismatch');
    }
    for (const key of Object.keys(s.roles) as Role[]) {
      const role = await client.role(s.roles[key]);
      if (!role || !role.description.startsWith(`${description(s.owner, s.installationId)}:`)
        || !z.string().guid().safeParse(role.description.split(':').at(-1)).success
        || !isDeepStrictEqual([...role.includedPermissions].sort(), [...rolePermissions[key]].sort())) fail('ownership_mismatch');
    }
    const registry = await client.json(`https://artifactregistry.googleapis.com/v1/${prepared.registry.id}`);
    if (registry.name !== prepared.registry.id || registry.createTime !== prepared.registry.lifetimeId || registry.format !== 'DOCKER' || registry.mode !== 'STANDARD_REPOSITORY'
      || typeof registry.description !== 'string' || !registry.description.startsWith(`${description(s.owner, s.installationId)}:`)
      || !z.string().guid().safeParse(registry.description.split(':').at(-1)).success) fail('ownership_mismatch');
    const workloads: Record<string, Record<string, unknown>> = {};
    for (const item of prepared.workloads) {
      const native = await client.json(`https://run.googleapis.com/v2/${item.id}`), desired = s.topology.workloads.find(value => value.name === item.workload)!;
      const template = native.template as Record<string, any> | undefined, annotations = native.annotations as Record<string, unknown> | undefined;
      if (native.name !== item.id || native.uid !== item.lifetimeId || annotations?.['hypervibe.dev/owner'] !== s.owner
        || annotations?.['hypervibe.dev/installation'] !== s.installationId || !z.string().guid().safeParse(annotations?.['hypervibe.dev/attempt']).success) fail('ownership_mismatch');
      if (template?.serviceAccount === s.email('holding')) {
        const config = gcpObservedHoldingConfiguration(native, { id: item.id, lifetimeId: item.lifetimeId, image: item.holding.image,
          serviceAccountEmail: s.email('holding'), publicAccess: desired.public! });
        if (gcpHoldingConfigurationDigest(config) !== item.holding.configurationDigest || native.generation !== item.holding.generation
          || native.latestReadyRevision !== item.holding.revision) fail();
      } else {
        applicationIdentity(native, s, item.workload);
      }
      workloads[item.workload] = native;
    }
    for (const target of prepared.secretTargets ?? []) {
      const secret = await client.json(`https://secretmanager.googleapis.com/v1/${target.id}`);
      const version = await client.json(`https://secretmanager.googleapis.com/v1/${target.id}/versions/${s.refs.get(target.id)}`);
      if (secret.name !== target.id || secret.createTime !== target.lifetimeId || version.name !== `${target.id}/versions/${s.refs.get(target.id)}` || version.state !== 'ENABLED') fail();
    }
    const grants = actions(intent, nativeProject).filter(item => item.metadata.operation === 'grant').map(item => item.metadata.native);
    const controlled = new Set(accounts.map(item => item.kind === 'gcp-service-account' ? `serviceAccount:${item.serviceAccountEmail}` : ''));
    controlled.add(`serviceAccount:${connection.hostIdentity.serviceAccountEmail}`);
    for (const resource of new Set(grants.map(item => String(item.resource)))) {
      const expected = grants.filter(item => item.resource === resource);
      const principal = accounts.find(item => item.kind === 'gcp-service-account' && resource === `projects/${s.projectId}/serviceAccounts/${item.serviceAccountEmail}`);
      const target = expected[0].policyKind === 'account' && principal?.kind === 'gcp-service-account'
        ? `projects/${s.projectId}/serviceAccounts/${principal.serviceAccountUniqueId}` : resource;
      const policy = await client.policy(expected[0].policyKind as WriterPolicyKind, target);
      // A collection connection may retain a separate verifier role. Apply the
      // same native permission proof to this fresh policy read as at planning.
      const projectPolicy = expected[0].policyKind === 'project';
      if (projectPolicy) await scopeAuthority(client, s, policy, connection.hostIdentity.serviceAccountEmail);
      for (const grant of expected) if (!policy.bindings.some(binding => binding.role === grant.role && !binding.condition && binding.members.includes(String(grant.member)))) fail('authorization_revoked');
      for (const binding of policy.bindings) for (const member of binding.members) {
        const universal = member === 'allUsers' || member === 'allAuthenticatedUsers';
        if (member.startsWith('group:') || member.startsWith('principalSet:') || member.startsWith('domain:') || member.startsWith('projectOwner:')
          || (controlled.has(member) || universal) && !projectPolicy && (!expected.some(grant => grant.role === binding.role && grant.member === member) || binding.condition)) fail('insufficient_permissions');
      }
    }
    return { project: { name: nativeProject.id, createTime: nativeProject.lifetimeId }, registry, workloads };
  }
  function releaseTargets(value: unknown, connection: CloudDeploymentConnectionV1): CloudDeploymentReleaseTargetV1[] {
    const native = parseGcpPreparedResources(connection.preparedResources, connection);
    const schema = z.array(z.object({ workload: z.string(), kind: z.literal('service'),
      service: z.object({ id: z.string(), lifetimeId: z.string().guid() }).strict(), registry: z.object({ id: z.string(), lifetimeId: date }).strict() }).strict());
    const parsed = schema.parse(value);
    const expected = native.workloads.map(item => ({ workload: item.workload, kind: 'service' as const,
      service: { id: item.id, lifetimeId: item.lifetimeId }, registry: { id: native.registry.id, lifetimeId: native.registry.lifetimeId } }));
    if (!isDeepStrictEqual(parsed, expected)) fail(); return parsed;
  }
  async function observe(client: GcpSecretWriterClient, context: ActionContext): Promise<Awaited<ReturnType<CloudInstallationDriver['inspect']>>> {
    const op = context.action.metadata.operation, native = context.action.metadata.native;
    const currentProject = await project(client, context.intent);
    if (op === 'verify-scope') {
      if (!isDeepStrictEqual(proofSchema.parse(native), currentProject)) fail();
      return { state: 'satisfied', evidence: evidence(context, [{ kind: 'project', id: currentProject.id, identity: { createTime: currentProject.lifetimeId } }]) };
    }
    const savedProject = context.intent.mode === 'disconnect' ? context.intent.installed?.flatMap(item => item.resources).find(item => item.kind === 'project') : completed(context, 'scope');
    if (!savedProject || savedProject.id !== currentProject.id || savedProject.identity.createTime !== currentProject.lifetimeId) fail();
    if (op === 'verify-secret') {
      const proof = await secretProof(client, settings(context.intent), String(native.id));
      if (proof.id !== context.action.resource.name || proof.identity.createTime !== native.lifetimeId) fail();
      return { state: 'satisfied', evidence: evidence(context, [proof]) };
    }
    if (op === 'enable-api') {
      const value = await client.json(`https://serviceusage.googleapis.com/v1/${context.action.resource.name}`);
      if (value.name !== context.action.resource.name || !['ENABLED', 'DISABLED'].includes(String(value.state))) fail();
      return value.state === 'ENABLED' ? { state: 'satisfied', evidence: evidence(context, [{ kind: 'api', id: context.action.resource.name, identity: {} }]) }
        : context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
    }
    if (op.startsWith('create-')) {
      const resource = await observeResource(client, context);
      if (!resource) return context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
      const saved = context.completed[context.action.id]?.resources[0]; if (saved && !isDeepStrictEqual(resource, saved)) fail();
      return { state: 'satisfied', evidence: evidence(context, [resource]) };
    }
    if (op === 'grant') {
      const resources = await grantResources(client, context, native), policy = await client.policy(native.policyKind as WriterPolicyKind, grantPolicyResource(context, native));
      const present = policy.bindings.some(item => item.role === native.role && !item.condition && item.members.includes(String(native.member)));
      return present ? { state: 'satisfied', evidence: evidence(context, resources, native) }
        : context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
    }
    if (op === 'revoke') {
      const checked = await cleanupGrant(client, context);
      if (!checked.absent) {
        const policy = await client.policy(checked.grant.policyKind as WriterPolicyKind, checked.resource);
        if (policy.bindings.some(item => item.role === checked.grant.role && !item.condition && item.members.includes(String(checked.grant.member))))
          return context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
      }
      return { state: 'satisfied', evidence: evidence(context, checked.original.resources, checked.grant) };
    }
    if (op === 'verify-deployment') {
      // Administrator success does not establish ongoing hosted authority.
      // Verify every installed lifetime and grant with the actual hosted
      // principal before publishing a usable receipt. API enablement was
      // verified by its own action and needs no ongoing Service Usage grant.
      const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30000 });
      try {
        const token = await budget.wait(context.authentication.host.getAccessToken(budget.signal));
        const hosted = new GcpSecretWriterClient({ token, budget, request,
          beforeWrite: async () => fail('not_installed'), sleep: async () => {} });
        for (const planned of actions(context.intent, currentProject).filter(item => item.metadata.operation !== 'verify-deployment'))
          if (!context.completed[planned.id]) fail('not_installed');
        await readPreparedWithClient(hosted, nativeProof(context));
      } finally { budget.close(); }
      return { state: 'satisfied', evidence: evidence(context, [savedProject]) };
    }
    return { state: 'unknown', reason: 'not_installed' };
  }
  const driver: GcpCloudDeploymentDriver = {
    provider: 'gcp', parseScope: value => scopeSchema.parse(value), parseEvidence,
    async readPrepared(connection, token, signal) {
      const budget = new DestinationBudget({ signal, deadlineMs: 30000 });
      try { return await readPreparedWithClient(new GcpSecretWriterClient({ token, budget, request,
        beforeWrite: async () => { throw new CloudDeploymentAccessError('unsupported'); }, sleep: async () => {} }), connection); }
      finally { budget.close(); }
    },
    parseAction(value, intent) {
      const candidate = value as CloudInstallationAction;
      if (intent.mode === 'disconnect') {
        const match = /^gcp:deployment:revoke:(\d+)$/.exec(candidate?.id ?? '');
        if (!match) fail();
        const original = (intent.installed ?? []).filter(item => item.native.operation === 'grant' && item.native.grant && !(item.native.grant as any).retained)[Number(match[1])];
        if (!original) fail('ownership_mismatch');
        const checked = parseEvidence(original, intent);
        const expected = action(`revoke:${match[1]}`, 'revoke', String((checked.native.grant as any).resource), 'trust', { evidence: checked });
        if (!isDeepStrictEqual(candidate, expected)) fail(); return expected;
      }
      const project = candidate?.metadata?.operation === 'verify-scope' ? proofSchema.parse(candidate.metadata.native)
        : { id: `projects/${scopeSchema.parse(intent.nativeScope).projectNumber}`, lifetimeId: '2000-01-01T00:00:00Z' };
      const lifetimes: Record<string, string> = {};
      if (candidate?.metadata?.operation === 'verify-secret') {
        const native = z.object({ id: z.string(), lifetimeId: date }).strict().parse(candidate.metadata.native);
        lifetimes[native.id] = native.lifetimeId;
      }
      const expected = actions(intent, project, lifetimes).find(item => item.id === candidate?.id);
      if (!expected || !isDeepStrictEqual(expected, candidate)) fail(); return expected;
    },
    async plan(context) {
      return withClient(context, async (client, budget) => {
        const s = settings(context.intent), proof = await project(client, context.intent);
        const permissions = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${s.projectNumber}:testIamPermissions`,
          { method: 'POST', body: JSON.stringify({ permissions: installPermissions }) });
        const granted = permissions.permissions;
        if (!Array.isArray(granted) || installPermissions.some(permission => !granted.includes(permission))) fail('insufficient_permissions');
        await client.policy('project', proof.id);
        if (context.intent.mode === 'connect') await publicImage(s.topology.preparation!.image, budget);
        const lifetimes: Record<string, string> = {};
        if (context.intent.mode === 'connect') for (const id of s.refs.keys()) lifetimes[id] = (await secretProof(client, s, id)).identity.createTime;
        const planned = actions(context.intent, proof, lifetimes);
        return { actions: planned, review: { permissions: planned.filter(item => item.metadata.operation === 'grant').map(item => {
          const grant = item.metadata.native; const role = (Object.keys(s.roles) as Role[]).find(key => s.roles[key] === grant.role);
          return { principal: String(grant.member), scope: String(grant.resource), actions: role ? rolePermissions[role] : [String(grant.role)],
            purpose: grant.member === `serviceAccount:${s.email('release')}` ? 'deployment-release' as const
              : grant.member === `serviceAccount:${s.email('provision')}` ? 'deployment-provision' as const
              : grant.retained ? 'runtime-reader' as const : 'installation-verification' as const };
        }), costs: [{ resource: s.registry, description: 'Artifact Registry image storage and network usage can incur charges.', pricingUrl: 'https://cloud.google.com/artifact-registry/pricing' },
          ...Object.values(s.services).map(resource => ({ resource, description: 'Cloud Run startup and request usage can incur charges; holding workloads have a zero minimum and one-instance maximum.', pricingUrl: 'https://cloud.google.com/run/pricing' }))],
          warnings: ['Initial hosted deployment supports independently verified projects without an organization parent. Cron, release commands, databases and storage require separate supported lifecycles.',
            'The operator holding image contains no application configuration or secret references. The first application release changes its image and runtime identity together.'],
          resources: [{ kind: 'project', name: proof.id, scope: s.projectId }, { kind: 'registry', name: s.registry, scope: s.topology.region },
            ...Object.values(s.services).map(name => ({ kind: 'service', name, scope: s.topology.region }))] } };
      });
    },
    async inspect(context) { try { return await withClient(context, client => observe(client, context)); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async recover(context) { try { return await withClient(context, client => observe(client, context)); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let retry = () => true;
      try { return await withClient(context, async (client, budget) => {
        const s = settings(context.intent), op = context.action.metadata.operation, native = context.action.metadata.native;
        driver.parseAction(context.action, context.intent);
        // A new attempt may dispatch only after a fresh, conclusive absent or
        // missing-grant observation. A previous attempted write never gets here.
        const before = await observe(client, { ...context, attempt: undefined });
        if (before.state === 'satisfied') return { state: 'acknowledged', evidence: before.evidence };
        if (before.state !== 'action-required') fail('not_converged');
        client.beginMutation(); retry = () => client.canRetryRejectedMutation();
        if (op === 'enable-api') await client.bootstrap.enableService(s.projectId, String(native.api));
        else if (op === 'create-role') await client.createRole(s.projectId, s.roles[native.role as Role].split('/').at(-1)!,
          `${description(s.owner, s.installationId)}:${context.attempt.id}`, rolePermissions[native.role as Role], 'Hypervibe scoped deployment');
        else if (op === 'create-account') await client.createAccount(s.projectId, s.accounts[String(native.key)], description(s.owner, s.installationId), `Hypervibe ${context.attempt.id}`);
        else if (op === 'create-registry') {
          const operation = await client.json(`https://artifactregistry.googleapis.com/v1/projects/${s.projectId}/locations/${s.topology.region}/repositories?repositoryId=${s.registry.split('/').at(-1)}`, {
            method: 'POST', body: JSON.stringify({ format: 'DOCKER', mode: 'STANDARD_REPOSITORY', description: `${description(s.owner, s.installationId)}:${context.attempt.id}` }) }, true);
          if (typeof operation.name !== 'string' || !operation.name.startsWith(`projects/${s.projectId}/locations/${s.topology.region}/operations/`) || operation.error) fail('not_converged');
        } else if (op === 'create-service') {
          await publicImage(s.topology.preparation!.image, budget);
          const key = String(native.workload), workload = s.topology.workloads.find(item => item.name === key)!;
          const holding = completed(context, 'account:holding'), account = await client.json(`https://iam.googleapis.com/v1/projects/${s.projectId}/serviceAccounts/${holding.identity.uniqueId}`);
          if (account.uniqueId !== holding.identity.uniqueId || account.email !== s.email('holding') || account.disabled === true) fail();
          const operation = await client.json(`https://run.googleapis.com/v2/projects/${s.projectId}/locations/${s.topology.region}/services?serviceId=${s.services[key].split('/').at(-1)}`, {
            method: 'POST', body: JSON.stringify({ ...gcpHoldingServiceConfiguration(s.topology.preparation!.image, s.email('holding'), workload.public!),
              annotations: { 'hypervibe.dev/owner': s.owner, 'hypervibe.dev/installation': s.installationId, 'hypervibe.dev/attempt': context.attempt.id } }) }, true);
          if (typeof operation.name !== 'string' || !operation.name.startsWith(`projects/${s.projectId}/locations/${s.topology.region}/operations/`) || operation.error) fail('not_converged');
        } else if (op === 'grant') {
          const resource = grantPolicyResource(context, native), policy = await client.policy(native.policyKind as WriterPolicyKind, resource), bindings = structuredClone(policy.bindings);
          // The etag must be obtained before the final lifetime proof: a
          // replacement during this policy read cannot receive the grant.
          await grantResources(client, context, native);
          const found = bindings.find(item => item.role === native.role && !item.condition);
          if (found) { if (!found.members.includes(String(native.member))) found.members.push(String(native.member)); }
          else bindings.push({ role: String(native.role), members: [String(native.member)] });
          await client.setPolicy(native.policyKind as WriterPolicyKind, resource, { ...policy, bindings });
        } else if (op === 'revoke') {
          const checked = await cleanupGrant(client, context); if (checked.absent) fail('not_converged');
          const policy = await client.policy(checked.grant.policyKind as WriterPolicyKind, checked.resource);
          if ((await cleanupGrant(client, context)).absent) fail('not_converged');
          const bindings = policy.bindings.map(binding => binding.role === checked.grant.role && !binding.condition
            ? { ...binding, members: binding.members.filter(member => member !== checked.grant.member) } : binding).filter(binding => binding.members.length);
          await client.setPolicy(checked.grant.policyKind as WriterPolicyKind, checked.resource, { ...policy, bindings });
        } else fail('not_installed');
        const after = await observe(client, context);
        return after.state === 'satisfied' ? { state: 'acknowledged', evidence: after.evidence } : { state: 'uncertain', reason: 'not_converged' };
      }); } catch (error) { return { state: retry() ? 'rejected' : 'uncertain', reason: reason(error) }; }
    }, connections: () => [],
    deployment: { hostingProvider: 'cloudrun', parsePreparedResources: parseGcpPreparedResources,
      prepareIntent: (spec, intent) => topology(spec, intent, options.holdingImage),
      connection(record) {
        if (record.status !== 'ready' || record.intent.mode !== 'connect') throw new CloudDeploymentAccessError('invalid_contract');
        return { ...nativeProof({ intent: record.intent, completed: record.completed } as Context), planDigest: record.plan.digest };
      },
      async issueSession(input) {
        if (input.target !== undefined) throw new CloudDeploymentAccessError('scope_mismatch');
        const principal = input.connection.principals[input.capability]; if (principal.kind !== 'gcp-service-account') fail();
        const budget = new DestinationBudget({ signal: input.signal, deadlineMs: 30000 });
        try {
          const token = await budget.wait(input.host.getAccessToken(budget.signal));
          const client = new GcpSecretWriterClient({ token, budget, request, beforeWrite: input.beforeIssue, sleep: async () => {} });
          await readPreparedWithClient(client, input.connection);
          await input.beforeIssue();
          const issued = await client.json(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${principal.serviceAccountUniqueId}:generateAccessToken`,
            { method: 'POST', body: JSON.stringify({ scope: [SCOPE], lifetime: '900s' }) }, true);
          if (typeof issued.accessToken !== 'string' || !issued.accessToken || issued.accessToken.length > 16384 || /[\r\n]/.test(issued.accessToken)
            || !date.safeParse(issued.expireTime).success || Date.parse(String(issued.expireTime)) <= Date.now() || Date.parse(String(issued.expireTime)) > Date.now() + 960000) fail();
          const info = await destinationJson(request, budget, 'https://oauth2.googleapis.com/tokeninfo', issued.accessToken, { method: 'POST' });
          const expiration = typeof info.exp === 'string' && /^\d+$/.test(info.exp) ? Number(info.exp) * 1000 : NaN;
          if (info.aud !== principal.serviceAccountUniqueId || info.azp !== principal.serviceAccountUniqueId || info.scope !== SCOPE
            || !Number.isFinite(expiration) || expiration <= Date.now() || Math.abs(expiration - Date.parse(String(issued.expireTime))) > 1000) fail();
          await input.beforeIssue();
          return { kind: 'gcp-impersonation', principal, token: issued.accessToken, expiresAt: String(issued.expireTime) };
        } finally { budget.close(); }
      },
      parseReleaseTargets: releaseTargets,
      async verifyReleaseTargets(input) {
        const prepared = parseGcpPreparedResources(input.connection.preparedResources, input.connection), s = settings(receiptIntent(input.connection));
        const envelope = repoBindingsFileSchema.parse(input.bindings), binding = envelope.environments[input.connection.environment]?.platformBindings;
        if (envelope.project !== input.spec.project || !binding || binding.provider !== 'cloudrun' || binding.projectId !== s.projectId || binding.environmentId !== s.topology.region) fail();
        const placement = binding.providerScope as Record<string, unknown> | undefined, services = binding.services as Record<string, Record<string, unknown>> | undefined;
        if (placement?.projectId !== s.projectId || placement?.region !== s.topology.region || placement?.artifactRepository !== s.registry.split('/').at(-1)
          || placement?.artifactRepositoryCreateTime !== prepared.registry.lifetimeId || !services) fail();
        for (const item of prepared.workloads) if (!services[item.workload] || services[item.workload].serviceId !== item.id.split('/').at(-1)
          || services[item.workload].resourceUid !== item.lifetimeId || services[item.workload].jobName
          || services[item.workload].resourceType !== 'service' || services[item.workload].workloadKind !== s.topology.workloads.find(workload => workload.name === item.workload)!.kind) fail();
        const token = await input.host.getAccessToken(input.signal);
        await driver.readPrepared(input.connection, token, input.signal); await input.beforeIssue();
        return releaseTargets(prepared.workloads.map(item => ({ workload: item.workload, kind: 'service', service: { id: item.id, lifetimeId: item.lifetimeId },
          registry: { id: prepared.registry.id, lifetimeId: prepared.registry.lifetimeId } })), input.connection);
      },
      assertSourcePlacement(spec, connection) {
        if (!isDeepStrictEqual(topology(spec, { ...connection, mode: 'connect', stage: 'deployment', keys: [] }, connection.deployment.preparation?.image), connection.deployment))
          throw new CloudDeploymentAccessError('scope_mismatch');
      },
    },
  };
  return driver;
}

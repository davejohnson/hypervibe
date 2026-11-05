import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationIntent, type CloudInstallationObservation,
  type CloudInstallationProviderContext, type CloudInstallationAttempt, type CloudInstallationReason } from '../../../domain/ports/cloud-installation.port.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { GcpSecretWriterClient, type WriterMutationContext, type WriterPolicyKind } from './gcp-secret-writer.client.js';

const scopeSchema = z.object({ projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/), projectNumber: z.string().regex(/^[1-9]\d{5,29}$/) }).strict();
const text = z.string().min(1).max(2048);
const inventorySchema = z.array(z.object({ name: text, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(500);
const snapshotSchema = z.object({ present: z.boolean(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), children: inventorySchema }).strict();
const nativeSchema = z.object({ target: z.string().regex(/^[a-f0-9]{64}$/), snapshot: snapshotSchema }).strict();
const receiptSchema = z.object({ resources: z.tuple([]), native: z.object({ operation: z.literal('retire-hosted-gcp-v1'),
  installationId: z.string().guid(), target: z.string().regex(/^[a-f0-9]{64}$/), absent: z.boolean(),
  operationName: z.string().max(2048).optional() }).strict().refine(value => value.absent || Boolean(value.operationName)) }).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type Context = CloudInstallationProviderContext & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
type Resource = CloudInstallationEvidence['resources'][number];
type Target = { key: string; kind: 'service' | 'grant' | 'account' | 'role' | 'secret' | 'registry'; resource: Resource;
  installationId: string; owner: string; marker?: string; grant?: { kind: WriterPolicyKind; resource: string; role: string; member: string } };
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}` : JSON.stringify(v);
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
/** One read-only review may reuse metadata; no cache survives its client.
 * Apply, inspect and recovery deliberately use the ordinary fresh-read client. */
class RetirementPlanningClient extends GcpSecretWriterClient {
  private readonly metadataReads = new Map<string, Promise<Record<string, unknown>>>();
  override async json(url: string, init: RequestInit = {}, mutation = false, context?: WriterMutationContext): Promise<Record<string, unknown>> {
    const method = init.method ?? 'GET';
    if (mutation || method !== 'GET' && !(method === 'POST' && /:(getIamPolicy|testIamPermissions)$/.test(new URL(url).pathname))
      || init.body !== undefined && typeof init.body !== 'string') fail('not_installed');
    const key = canonical({ method, url, body: init.body });
    let pending = this.metadataReads.get(key);
    if (!pending) {
      if (this.metadataReads.size >= 1024) fail('not_converged');
      pending = super.json(url, init, false, context);
      this.metadataReads.set(key, pending);
    }
    return structuredClone(await pending);
  }
}
function fail(reason: CloudInstallationReason = 'ownership_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function reason(error: unknown): CloudInstallationReason {
  return error instanceof CloudInstallationBoundaryError ? error.reason : error instanceof DestinationBoundaryError
    ? error.status === 403 ? 'insufficient_permissions' : error.status === 401 ? 'authorization_expired' : error.code === 'deadline_exceeded' ? 'timeout' : 'provider_error' : 'provider_error';
}
const hostFor = (kind: Target['kind']) => kind === 'service' ? 'run.googleapis.com/v2' : kind === 'secret' ? 'secretmanager.googleapis.com/v1'
  : kind === 'registry' ? 'artifactregistry.googleapis.com/v1' : 'iam.googleapis.com/v1';
const urlFor = (target: Target, projectId: string) => `https://${hostFor(target.kind)}/${target.kind === 'account'
  ? `projects/${projectId}/serviceAccounts/${target.resource.identity.uniqueId}` : target.resource.id}`;
function nativeOperation(value: unknown, target: Target): string {
  const prefix = target.resource.id.split('/').slice(0, 4).join('/') + '/operations/';
  if (!['service', 'registry'].includes(target.kind) || typeof value !== 'string' || !value.startsWith(prefix)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value.slice(prefix.length))) fail('identity_mismatch');
  return value;
}
/** Consumer authority is the original reviewed deployment, never global discovery or a caller override. */
function recordedRegion(intent: CloudInstallationIntent): string {
  const records = intent.retirement?.records.filter(record => record.intent.purpose === 'deployment');
  if (!records || records.length !== 1) fail('identity_mismatch');
  const original = records[0].intent, region = original.deployment?.region;
  if (original.deployment?.hostingProvider !== 'cloudrun' || typeof region !== 'string' || !/^[a-z]+-[a-z]+\d+$/.test(region)
    || original.nativeScope.projectId !== intent.nativeScope.projectId || original.nativeScope.projectNumber !== intent.nativeScope.projectNumber
    || intent.deployment && intent.deployment.region !== region) fail('identity_mismatch');
  return region;
}

/** Targets come exclusively from creation and grant receipts, never native names discovered during cleanup. */
function targets(intent: CloudInstallationIntent): Target[] {
  if (intent.mode !== 'retire' || intent.retirement?.schemaVersion !== 1 || intent.retirement.data !== 'delete-owned'
    || intent.retirement.records.length !== 2 || intent.provider !== 'gcp') fail();
  const scope = scopeSchema.parse(intent.nativeScope);
  const region = recordedRegion(intent);
  const result: Target[] = [];
  for (const record of intent.retirement.records) {
    const deployment = record.intent.purpose === 'deployment';
    for (const action of record.plan.actions) {
      const evidence = record.completed[action.id]; if (!evidence) fail();
      const operation = evidence.native.operation;
      const kind = operation === 'create-service' ? 'service' : operation === 'create-account' ? 'account' : operation === 'create-role' ? 'role'
        : operation === 'create-secret' ? 'secret' : operation === 'create-registry' ? 'registry' : operation === 'grant' ? 'grant' : undefined;
      if (!kind) continue;
      const completion = record.attempts.filter(attempt => attempt.actionId === action.id).at(-1);
      if (kind !== 'grant' && (!completion || completion.status !== 'succeeded' || !isDeepStrictEqual(completion.evidence, evidence))) fail();
      const owner = String(evidence.native.owner), installationId = record.installationId;
      if (!/^[a-f0-9]{64}$/.test(owner) || evidence.native.installationId !== installationId) fail();
      if (kind === 'grant') {
        const g = deployment ? evidence.native.grant as Record<string, unknown> : { policyKind: evidence.native.policyKind,
          resource: evidence.native.policyResource, role: evidence.native.role, member: evidence.native.member };
        if (!g || !['project', 'account', 'secret', 'service', 'registry'].includes(String(g.policyKind))) fail();
        const grant = { kind: g.policyKind as WriterPolicyKind, resource: String(g.resource), role: String(g.role), member: String(g.member) };
        result.push({ key: hash({ installationId, action: action.id }), kind, resource: { kind: 'iamBinding', id: grant.resource, identity: {} }, installationId, owner, grant });
      } else {
        const resource = evidence.resources.find(item => item.kind === (kind === 'account' && !deployment ? 'serviceAccount' : kind));
        if (!resource || resource.id !== action.resource.name || resource.identity.owner !== owner || !resource.identity.attemptId
          || resource.identity.adoption || kind === 'account' && !resource.identity.uniqueId
          || kind === 'service' && !resource.identity.uid || ['secret', 'registry'].includes(kind) && !resource.identity.createTime) fail();
        const marker = deployment ? `hypervibe:deployment:v1:${owner}:${installationId}${kind === 'account' ? '' : `:${resource.identity.attemptId}`}`
          : `hypervibe:${owner}:${resource.identity.attemptId}`;
        result.push({ key: hash({ installationId, action: action.id }), kind, resource, installationId, owner, marker });
      }
    }
  }
  if (!result.some(item => item.kind === 'secret') || !result.some(item => item.kind === 'registry') || !result.some(item => item.kind === 'service')
    || result.length > 250 || new Set(result.filter(t => t.kind !== 'grant').map(t => t.resource.id)).size !== result.filter(t => t.kind !== 'grant').length) fail();
  // A grant cannot introduce a deletion target outside the exact original scope.
  for (const target of result) if (![scope.projectId, scope.projectNumber].some(project => target.resource.id === `projects/${project}` || target.resource.id.startsWith(`projects/${project}/`))) fail();
  if (result.some(target => ['service', 'registry'].includes(target.kind)
    && !target.resource.id.startsWith(`projects/${scope.projectId}/locations/${region}/`))) fail('identity_mismatch');
  if (result.some(t => t.kind === 'account' && (t.resource.id.endsWith(`/${intent.hostIdentity.serviceAccountEmail}`)
    || t.resource.identity.uniqueId === intent.hostIdentity.subject))) fail();
  const rank = { service: 0, grant: 1, account: 2, role: 3, secret: 4, registry: 5 };
  return result.sort((a, b) => rank[a.kind] - rank[b.kind] || a.key.localeCompare(b.key));
}
function actionFor(target: Target, snapshot: Snapshot, previous?: Target): CloudInstallationAction {
  return { id: `gcp:retire:${target.key}`, type: target.kind === 'grant' ? 'update' : 'destroy',
    resource: { kind: target.kind === 'service' ? 'service' : target.kind === 'secret' ? 'secret' : 'retained-resource', name: target.resource.id, provider: 'gcp' },
    verified: true, requiresConfirm: true, ...(target.kind === 'secret' || target.kind === 'registry' ? { dataBearing: true } : {}),
    ...(previous ? { dependsOn: [`gcp:retire:${previous.key}`] } : {}),
    reason: target.kind === 'grant' ? 'Remove only this installation’s recorded IAM member and role binding.'
      : `Retire the exact recorded customer ${target.kind}${snapshot.children.length ? ` and ${snapshot.children.length} reviewed child metadata entries` : ''}; preserve the shared host.`,
    metadata: { operation: 'retire-hosted-gcp-v1', category: target.kind === 'grant' ? 'trust' : target.kind === 'secret' ? 'secret-container' : 'scope',
      execution: 'api', native: { target: target.key, snapshot } } };
}
function selected(context: Pick<Context, 'intent' | 'action'>) {
  const native = nativeSchema.parse(context.action.metadata.native), all = targets(context.intent), index = all.findIndex(t => t.key === native.target);
  if (index < 0 || !isDeepStrictEqual(context.action, actionFor(all[index], native.snapshot, all[index - 1]))) fail();
  return { target: all[index], snapshot: native.snapshot, all };
}
const absentSnapshot = (): Snapshot => ({ present: false, fingerprint: hash(null), children: [] });
async function read(client: GcpSecretWriterClient, url: string) {
  try { return await client.json(url); } catch (e) { if (e instanceof DestinationBoundaryError && e.status === 404) return null; throw e; }
}
async function inventory(client: GcpSecretWriterClient, url: string, field: string): Promise<Record<string, any>[]> {
  const values: Record<string, any>[] = [], cursors = new Set<string>(), ids = new Set<string>(); let cursor = '';
  for (let page = 0; page < 5; page++) {
    const request = new URL(url); request.searchParams.set('pageSize', '100'); if (cursor) request.searchParams.set('pageToken', cursor);
    const body = await client.json(request.toString());
    if (Object.keys(body).some(key => ![field, 'nextPageToken', 'unreachable', 'totalSize'].includes(key))
      || body.unreachable !== undefined && (!Array.isArray(body.unreachable) || body.unreachable.length)
      || body[field] !== undefined && !Array.isArray(body[field])) fail('not_converged');
    for (const entry of (body[field] ?? []) as Record<string, any>[]) {
      if (!entry || typeof entry.name !== 'string' || ids.has(entry.name) || values.length >= 500) fail('not_converged');
      ids.add(entry.name); values.push(entry);
    }
    if (body.nextPageToken === undefined || body.nextPageToken === '') return values;
    if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length > 4096 || cursors.has(body.nextPageToken)) fail('not_converged');
    cursor = body.nextPageToken; cursors.add(cursor);
  }
  fail('not_converged');
}
function assertIdentity(value: Record<string, any>, target: Target) {
  const r = target.resource, identity = r.identity;
  if (value.name !== r.id || identity.uniqueId && value.uniqueId !== identity.uniqueId || identity.uid && value.uid !== identity.uid
    || identity.createTime && value.createTime !== identity.createTime) fail('identity_mismatch');
  if (target.kind === 'secret') {
    if (value.labels?.['hv-installation'] !== target.owner.slice(0, 63) || value.labels?.['hv-attempt'] !== identity.attemptId) fail();
  // A managed release can legitimately replace holding annotations. The
  // original create receipt's immutable UID is the service lifetime boundary.
  } else if (target.kind !== 'service' && value.description !== target.marker) fail();
  if (target.kind === 'registry' && (value.format !== 'DOCKER' || value.mode !== 'STANDARD_REPOSITORY')) fail();
}
async function snapshot(client: GcpSecretWriterClient, target: Target, intent: CloudInstallationIntent): Promise<{ snapshot: Snapshot; value?: Record<string, any> }> {
  const projectId = intent.nativeScope.projectId;
  if (target.kind === 'grant') {
    const grant = target.grant!;
    const all = targets(intent);
    const parent = all.find(t => t.kind !== 'grant' && (t.resource.id === grant.resource || t.kind === 'account'
      && `projects/${projectId}/serviceAccounts/${t.resource.identity.uniqueId}` === grant.resource));
    if (grant.kind !== 'project' && !parent) fail();
    if (parent && !(await snapshot(client, parent, intent)).snapshot.present)
      return { snapshot: { present: false, fingerprint: hash(grant), children: [] } };
    const role = all.find(t => t.kind === 'role' && t.resource.id === grant.role);
    if (role) await snapshot(client, role, intent);
    const member = all.find(t => t.kind === 'account' && `serviceAccount:${t.resource.id.split('/').at(-1)}` === grant.member);
    if (member) await snapshot(client, member, intent);
    try {
      const policyResource = parent?.kind === 'account' ? `projects/${projectId}/serviceAccounts/${parent.resource.identity.uniqueId}` : grant.resource;
      const policy = await client.policy(grant.kind, policyResource);
      if (policy.bindings.some(b => b.role === grant.role && b.condition && b.members.includes(grant.member))) fail();
      const present = policy.bindings.some(b => b.role === grant.role && !b.condition && b.members.includes(grant.member));
      return { snapshot: { present, fingerprint: hash(grant), children: [] } };
    } catch (e) { if (e instanceof DestinationBoundaryError && e.status === 404) return { snapshot: { present: false, fingerprint: hash(grant), children: [] } }; throw e; }
  }
  const value = await read(client, urlFor(target, projectId));
  if (!value) {
    if (target.kind === 'account' && await read(client, `https://iam.googleapis.com/v1/${target.resource.id}`)) fail('identity_mismatch');
    return { snapshot: absentSnapshot() };
  }
  assertIdentity(value, target);
  if (target.kind === 'role' && value.deleted === true) return { snapshot: absentSnapshot() };
  if (target.kind === 'service' && value.deleteTime) return { snapshot: { present: true, fingerprint: hash({ pending: value.uid }), children: [] }, value };
  const children: z.infer<typeof inventorySchema> = [];
  const list = async (suffix: string, field: string) => {
    for (const child of await inventory(client, `${urlFor(target, projectId)}/${suffix}`, field)) {
      if (!child.name.startsWith(`${target.resource.id}/`)) fail('identity_mismatch');
      // Metadata only. Values and artifact bytes are never requested or persisted.
      const fields = { name: child.name, createTime: child.createTime, uploadTime: child.uploadTime, updateTime: child.updateTime,
        version: child.version, tags: child.tags, state: child.state, sizeBytes: child.sizeBytes, hashes: child.hashes, etag: child.etag };
      if (typeof child.createTime !== 'string' && typeof child.uploadTime !== 'string' && typeof child.updateTime !== 'string') fail('not_converged');
      children.push({ name: child.name, fingerprint: hash(fields) });
    }
  };
  if (target.kind === 'secret') await list('versions', 'versions');
  if (target.kind === 'registry') {
    await list('dockerImages', 'dockerImages'); await list('packages', 'packages'); await list('files', 'files');
    const attachments = await inventory(client, `${urlFor(target, projectId)}/attachments`, 'attachments');
    if (attachments.length) fail(); // Attached non-image data is not part of this narrow retirement.
  }
  if (children.length > 500) fail('not_converged');
  children.sort((a, b) => a.name.localeCompare(b.name));
  // Mutable service revisions are deliberately not held to their initial holding image.
  // Etag/configuration is frozen by the retirement review, not the installation review.
  const metadata = { name: value.name, uid: value.uid, uniqueId: value.uniqueId, createTime: value.createTime, description: value.description,
    labels: value.labels, annotations: value.annotations, includedPermissions: value.includedPermissions, stage: value.stage,
    ...(target.kind === 'service' ? { etag: value.etag } : {}) };
  return { snapshot: { present: true, fingerprint: hash(metadata), children }, value };
}

/** Complete bounded inventory within the recorded region; unrelated host workloads are preserved. */
async function consumers(client: GcpSecretWriterClient, intent: CloudInstallationIntent, all: Target[], afterWorkloads: boolean) {
  const project = intent.nativeScope.projectId;
  const locationName = `projects/${project}/locations/${recordedRegion(intent)}`;
  const workloads = new Map(all.filter(t => t.kind === 'service').map(t => [t.resource.id, t]));
  const accounts = new Set(all.filter(t => t.kind === 'account').map(t => t.resource.id.split('/').at(-1)!));
  const roles = new Set(all.filter(t => t.kind === 'role').map(t => t.resource.id));
  const secrets = new Set(all.filter(t => t.kind === 'secret').flatMap(t => { const name = t.resource.id.split('/').at(-1)!;
    return [name, `projects/${project}/secrets/${name}`, `projects/${intent.nativeScope.projectNumber}/secrets/${name}`]; }));
  const repositories = all.filter(t => t.kind === 'registry').map(t => {
    const parts = t.resource.id.split('/'); return `${parts[3]}-docker.pkg.dev/${project}/${parts[5]}/`;
  });
  const object = (value: unknown): Record<string, any> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('not_converged'); return value as Record<string, any>;
  };
  const references = (raw: unknown) => {
    const template = object(raw);
    if (template.serviceAccount !== undefined && typeof template.serviceAccount !== 'string') fail('not_converged');
    if (accounts.has(template.serviceAccount)) fail();
    if (!Array.isArray(template.containers) || !template.containers.length) fail('not_converged');
    for (const rawContainer of template.containers) {
      const container = object(rawContainer);
      if (typeof container.image !== 'string' || !container.image) fail('not_converged');
      if (repositories.some(prefix => container.image.startsWith(prefix))) fail();
      if (container.env !== undefined && !Array.isArray(container.env)) fail('not_converged');
      for (const rawEnv of container.env ?? []) {
        const env = object(rawEnv); if (env.valueSource === undefined) continue;
        const ref = object(object(env.valueSource).secretKeyRef);
        if (typeof ref.secret !== 'string' || !ref.secret || ref.version !== undefined && typeof ref.version !== 'string') fail('not_converged');
        if (secrets.has(ref.secret)) fail();
      }
    }
    if (template.volumes !== undefined && !Array.isArray(template.volumes)) fail('not_converged');
    for (const rawVolume of template.volumes ?? []) {
      const volume = object(rawVolume); if (volume.secret === undefined) continue;
      const ref = object(volume.secret); if (typeof ref.secret !== 'string' || !ref.secret) fail('not_converged');
      if (secrets.has(ref.secret)) fail();
    }
  };
  const foreignPolicy = async (kind: WriterPolicyKind, resource: string) => {
    const policy = await client.policy(kind, resource);
    if (policy.bindings.some(binding => roles.has(binding.role) || binding.members.some(member => accounts.has(member.replace(/^serviceAccount:/, ''))))) fail();
  };
  for (const kind of ['services', 'jobs', 'workerPools']) {
    const entries = await inventory(client, `https://run.googleapis.com/v2/${locationName}/${kind}`, kind);
    for (const entry of entries) {
      const owned = workloads.get(entry.name);
      if (!entry.name.startsWith(`${locationName}/${kind}/`) || typeof entry.uid !== 'string' || !entry.uid) fail('identity_mismatch');
      if (owned) { if (kind !== 'services' || afterWorkloads) fail(); assertIdentity(entry, owned); continue; }
      references(kind === 'jobs' ? object(entry.template).template : entry.template);
      const collection = kind === 'jobs' ? 'executions' : 'revisions';
      for (const child of await inventory(client, `https://run.googleapis.com/v2/${entry.name}/${collection}`, collection)) {
        if (!child.name.startsWith(`${entry.name}/${collection}/`) || typeof child.uid !== 'string' || !child.uid) fail('identity_mismatch');
        references(kind === 'jobs' ? child.template : child);
      }
      await foreignPolicy('service', entry.name);
    }
  }
  const projectPolicy = await client.policy('project', `projects/${intent.nativeScope.projectNumber}`);
  for (const binding of projectPolicy.bindings) for (const member of binding.members) {
    if (!accounts.has(member.replace(/^serviceAccount:/, '')) && !roles.has(binding.role)) continue;
    if (binding.condition || !all.some(t => t.grant?.kind === 'project' && t.grant.role === binding.role && t.grant.member === member)) fail();
  }
  const owned = (name: string) => all.some(t => t.kind !== 'grant' && t.resource.id.split('/').slice(2).join('/') === name.split('/').slice(2).join('/'));
  const scopeName = (name: unknown) => {
    if (typeof name !== 'string' || ![project, intent.nativeScope.projectNumber].some(p => name.startsWith(`projects/${p}/`))) fail('identity_mismatch');
    return name as string;
  };
  for (const resource of await inventory(client, `https://secretmanager.googleapis.com/v1/projects/${intent.nativeScope.projectNumber}/secrets`, 'secrets')) {
    const name = scopeName(resource.name); if (!owned(name)) await foreignPolicy('secret', name);
  }
  for (const resource of await inventory(client, `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`, 'accounts')) {
    const name = scopeName(resource.name); if (!owned(name)) await foreignPolicy('account', name);
  }
  for (const resource of await inventory(client, `https://artifactregistry.googleapis.com/v1/${locationName}/repositories`, 'repositories')) {
    const id = scopeName(resource.name); if (!id.startsWith(`${locationName}/repositories/`)) fail('identity_mismatch');
    if (!owned(id)) await foreignPolicy('registry', id);
  }
  // Removing a container or custom role must not silently remove additional
  // principals' access. Every binding on an owned parent was installed by one
  // of the selected records; unrelated project policy entries remain untouched.
  for (const parent of all.filter(t => ['service', 'account', 'secret', 'registry'].includes(t.kind))) {
    const value = await read(client, urlFor(parent, project)); if (!value) continue;
    assertIdentity(value, parent);
    const resource = parent.kind === 'account' ? `projects/${project}/serviceAccounts/${parent.resource.identity.uniqueId}` : parent.resource.id;
    const policy = await client.policy(parent.kind as WriterPolicyKind, resource);
    for (const binding of policy.bindings) for (const member of binding.members) {
      if (binding.condition || !all.some(t => t.grant && t.grant.kind === parent.kind && (t.grant.resource === resource || t.grant.resource === parent.resource.id)
        && t.grant.role === binding.role && t.grant.member === member)) fail();
    }
  }
}

export function createGcpCloudRetirementDriver(options: { fetch?: typeof fetch } = {}): CloudInstallationDriver {
  const request = options.fetch ?? fetch;
  async function withClient<T>(context: CloudInstallationProviderContext, work: (client: GcpSecretWriterClient) => Promise<T>, planning = false): Promise<T> {
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      if (!context.authentication.administrator) fail('authorization_expired');
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', budget.signal));
      const Client = planning ? RetirementPlanningClient : GcpSecretWriterClient;
      const client = new Client({ token, budget, request, beforeWrite: () => context.beforeMutation(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
      await client.project(context.intent.nativeScope.projectId, context.intent.nativeScope.projectNumber);
      return await work(client);
    } finally { budget.close(); }
  }
  const receipt = (context: Context): CloudInstallationEvidence => ({ resources: [], native: { operation: 'retire-hosted-gcp-v1',
    installationId: context.intent.installationId, target: selected(context).target.key, absent: true } });
  async function observe(client: GcpSecretWriterClient, context: Context): Promise<CloudInstallationObservation> {
    const chosen = selected(context), live = await snapshot(client, chosen.target, context.intent);
    if (!live.snapshot.present) return { state: 'satisfied', evidence: receipt(context) };
    const operationName = context.attempt?.evidence?.native.operationName;
    if (operationName) {
      const name = nativeOperation(operationName, chosen.target);
      const operation = await read(client, `https://${hostFor(chosen.target.kind)}/${name}`);
      if (!operation || operation.name !== name || operation.done !== undefined && typeof operation.done !== 'boolean')
        return { state: 'unknown', reason: 'not_converged' };
      if (operation.done === true && operation.error !== undefined) return { state: 'rejected', reason: 'provider_error' };
      if (!operation.done) return { state: 'pending', reason: 'not_converged' };
    }
    if (chosen.target.kind === 'service' && live.value?.deleteTime) return { state: 'pending', reason: 'not_converged' };
    if (!chosen.snapshot.present || live.snapshot.fingerprint !== chosen.snapshot.fingerprint || !isDeepStrictEqual(live.snapshot.children, chosen.snapshot.children))
      return { state: 'conflict', reason: 'identity_mismatch' };
    if (context.attempt && context.attempt.status !== 'rejected') return { state: 'pending', reason: 'not_converged' };
    return { state: 'action-required' };
  }
  const driver: CloudInstallationDriver = {
    provider: 'gcp', retirement: { schemaVersion: 1, validateCompletedEvidence(evidence) {
      if (!receiptSchema.parse(evidence).native.absent) fail('not_converged');
    } }, parseScope: value => scopeSchema.parse(value),
    parseAction(value, intent) { const action = value as CloudInstallationAction; selected({ intent, action }); return action; },
    parseEvidence(value, intent) { const parsed = receiptSchema.parse(value), target = targets(intent).find(t => t.key === parsed.native.target);
      if (parsed.native.installationId !== intent.installationId || !target) fail();
      if (parsed.native.operationName) nativeOperation(parsed.native.operationName, target); return parsed; },
    connections: () => [],
    async plan(context) {
      return withClient(context, async client => {
        const all = targets(context.intent); await consumers(client, context.intent, all, false);
        const actions: CloudInstallationAction[] = [];
        for (let i = 0; i < all.length; i++) actions.push(actionFor(all[i], (await snapshot(client, all[i], context.intent)).snapshot, all[i - 1]));
        const removals = { service: 'run.services.delete', account: 'iam.serviceAccounts.delete', role: 'iam.roles.delete',
          secret: 'secretmanager.secrets.delete', registry: 'artifactregistry.repositories.delete' };
        const policies = { project: 'resourcemanager.projects.setIamPolicy', account: 'iam.serviceAccounts.setIamPolicy',
          secret: 'secretmanager.secrets.setIamPolicy', service: 'run.services.setIamPolicy', registry: 'artifactregistry.repositories.setIamPolicy' };
        const permissions = [...new Set(all.filter((_, i) => nativeSchema.parse(actions[i].metadata.native).snapshot.present)
          .map(t => t.kind === 'grant' ? policies[t.grant!.kind] : removals[t.kind]))].sort();
        if (permissions.length) {
          const authority = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${context.intent.nativeScope.projectNumber}:testIamPermissions`,
            { method: 'POST', body: JSON.stringify({ permissions }) });
          const granted = authority.permissions;
          if (!Array.isArray(granted) || permissions.some(permission => !granted.includes(permission))) fail('insufficient_permissions');
        }
        return { actions, review: { resources: all.filter(t => t.kind !== 'grant').map(t => ({ kind: t.kind, name: t.resource.id, scope: context.intent.nativeScope.projectId })),
          permissions: all.filter(t => t.grant).map(t => ({ principal: t.grant!.member, scope: t.grant!.resource, actions: [t.grant!.role], purpose: 'hosted-trust-removal' as const })), costs: [], warnings: [
            'Permanently remove the reviewed customer secret versions and image repository contents. Shared host resources, the customer project, billing link and enabled APIs are retained.',
            'Artifact Registry repository deletion has no etag precondition. Hypervibe rechecks the exact repository lifetime and child inventory immediately before deletion, but a concurrent administrator can still change contents after that check.',
            `Consumer checks cover Cloud Run workloads and image repositories only in the original installation region ${recordedRegion(context.intent)}. Project identity, IAM account and secret-policy checks remain project-scoped. Unrelated host workloads are preserved. Cross-region, cross-project and non-Cloud-Run consumers are not inspected and remain unverified; dedicated installation identities or data must not be manually reused outside this scope.`,
          ] } };
      }, true);
    },
    async inspect(context) { try { return await withClient(context, client => observe(client, context)); } catch (e) { return { state: 'unknown', reason: reason(e) }; } },
    async recover(context) { try { return await withClient(context, client => observe(client, context)); } catch (e) { return { state: 'unknown', reason: reason(e) }; } },
    async mutate(context) {
      let retry = () => true;
      try { return await withClient(context, async client => {
        retry = () => client.canRetryRejectedMutation();
        const chosen = selected(context), target = chosen.target;
        const check = await observe(client, { ...context, attempt: undefined }); if (check.state !== 'action-required') fail('not_converged');
        await consumers(client, context.intent, chosen.all, target.kind !== 'service');
        if (target.kind === 'grant') {
          const grant = target.grant!;
          const parent = chosen.all.find(t => t.kind === 'account' && (t.resource.id === grant.resource
            || `projects/${context.intent.nativeScope.projectId}/serviceAccounts/${t.resource.identity.uniqueId}` === grant.resource));
          const policyResource = parent ? `projects/${context.intent.nativeScope.projectId}/serviceAccounts/${parent.resource.identity.uniqueId}` : grant.resource;
          const policy = await client.policy(grant.kind, policyResource);
          for (const binding of policy.bindings) if (binding.role === grant.role && binding.members.includes(grant.member)) {
            if (binding.condition) fail(); binding.members = binding.members.filter(m => m !== grant.member);
          }
          await client.setPolicy(grant.kind, policyResource, { ...policy, bindings: policy.bindings.filter(b => b.members.length) });
        } else {
          const fresh = await snapshot(client, target, context.intent);
          if (!isDeepStrictEqual(fresh.snapshot, chosen.snapshot) || !fresh.value) fail('identity_mismatch');
          if (target.kind === 'account') {
            const policy = await client.policy('account', `projects/${context.intent.nativeScope.projectId}/serviceAccounts/${target.resource.identity.uniqueId}`);
            if (policy.bindings.length) fail();
          }
          const url = new URL(urlFor(target, context.intent.nativeScope.projectId));
          if (['service', 'secret', 'role'].includes(target.kind)) {
            if (typeof fresh.value.etag !== 'string' || !fresh.value.etag) fail('not_converged'); url.searchParams.set('etag', fresh.value.etag);
          }
          const result = await client.json(url.toString(), { method: 'DELETE' }, true);
          if (['service', 'registry'].includes(target.kind)) {
            const operationName = nativeOperation(result.name, target);
            return { state: 'acknowledged' as const, evidence: { resources: [], native: { operation: 'retire-hosted-gcp-v1',
              installationId: context.intent.installationId, target: target.key, absent: false, operationName } } };
          }
        }
        return { state: 'acknowledged' as const };
      }); } catch (e) { return { state: retry() ? 'rejected' : 'uncertain', reason: reason(e) }; }
    },
  };
  return driver;
}

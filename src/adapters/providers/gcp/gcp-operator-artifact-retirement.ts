import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver, type CloudInstallationEvidence,
  type CloudInstallationProviderContext, type CloudInstallationRecord, type OperatorArtifactIntent } from '../../../domain/ports/cloud-installation.port.js';
import { operatorRetirementOutcomeSchema } from '../../../domain/ports/operator-retirement.port.js';
import { historicalInstallationEvidence } from '../../../domain/services/cloud-installation-runtime.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { GcpSecretWriterClient } from './gcp-secret-writer.client.js';
import { createGcpOperatorArtifactDriver, gcpOperatorArtifactNames, gcpOperatorArtifactScopeSchema, parseGcpOperatorArtifactEvidence } from './gcp-operator-artifacts.js';

type Intent = OperatorArtifactIntent;
type Record = CloudInstallationRecord<Intent>;
type Context = CloudInstallationProviderContext<Intent>;
type ActionContext = Context & { action: CloudInstallationAction };
const root = 'https://artifactregistry.googleapis.com/v1/';
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const targetSchema = z.object({ installationId: z.string().guid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['holding-v1', 'backup-runner-v1', 'application-candidate-v1']),
  image: z.string().max(2048), digest, uploadTime: z.string().datetime(), tag: z.string().regex(/^hv-[a-f0-9-]{36}$/) }).strict();
type Target = z.infer<typeof targetSchema>;
const nativeSchema = targetSchema.extend({ operation: z.enum(['remove-tag', 'remove-version']) }).strict();
type Native = z.infer<typeof nativeSchema>;
function permissions(intent: Intent, mutation = false) { return ['artifactregistry.repositories.get', 'artifactregistry.dockerImages.get', 'artifactregistry.tags.get',
  'artifactregistry.tags.list', 'artifactregistry.versions.get', ...(mutation ? ['artifactregistry.tags.delete'] : []),
  ...(mutation && intent.retirement?.data === 'delete-owned' ? ['artifactregistry.versions.delete'] : [])]; }
function fail(): never { throw new CloudInstallationBoundaryError('identity_mismatch'); }
function validateTarget(intent: Intent, target: Target) {
  const n = gcpOperatorArtifactNames(intent), ref = intent.retirement?.targets.find(item => item.installationId === target.installationId);
  const name = n.candidate ? n.imageName : target.kind;
  if (intent.mode !== 'retire' || !ref || ref.planDigest !== target.planDigest || ref.evidenceDigest !== target.evidenceDigest
    || intent.retirement?.continueFrom || !intent.artifacts.includes(target.kind)
    || target.image !== `${n.host}/${n.projectId}/${n.repository}/${name}@${target.digest}`) fail();
  return { ...n, repositoryName: n.repositoryName, repositoryCreateTime: n.repositoryCreateTime, packageName: `${n.repositoryName}/packages/${name}`, imageName: name,
    version: `${n.repositoryName}/packages/${name}/versions/${target.digest}`, tagName: `${n.repositoryName}/packages/${name}/tags/${target.tag}` };
}
function actionFor(intent: Intent, target: Target, operation: Native['operation']): CloudInstallationAction {
  const n = validateTarget(intent, target), native = { ...target, operation };
  if (operation === 'remove-version' && intent.retirement!.data !== 'delete-owned') fail();
  const tagId = `gcp:operator-artifacts:remove-tag:${target.installationId}:${target.kind}`;
  return { id: operation === 'remove-tag' ? tagId : `gcp:operator-artifacts:remove-version:${target.installationId}:${target.kind}`,
    type: 'destroy', verified: true, requiresConfirm: true, dataBearing: true,
    resource: { kind: 'storage', name: operation === 'remove-tag' ? n.tagName : n.version, provider: 'gcp' },
    ...(operation === 'remove-version' ? { dependsOn: [tagId] } : {}),
    reason: operation === 'remove-tag' ? `Remove only the original publication tag ${target.tag}; preserve the shared repository and its access rules.`
      : `Delete the exact published image ${target.image} after its owned tag is absent. A remaining tag blocks deletion.`,
    metadata: { operation: 'artifact-retirement', category: 'scope', execution: 'api', native } };
}
function parseAction(value: unknown, intent: Intent) {
  const native = nativeSchema.parse(z.object({ metadata: z.object({ native: z.unknown() }) }).parse(value).metadata.native);
  const { operation, ...target } = native;
  const expected = actionFor(intent, target, operation); if (!isDeepStrictEqual(expected, value)) fail(); return expected;
}
function evidence(intent: Intent, action: CloudInstallationAction, operationName?: string, acknowledged = false): CloudInstallationEvidence {
  const native = nativeSchema.parse(action.metadata.native), n = validateTarget(intent, native);
  const retained = intent.retirement!.data === 'retain' ? [{ kind: 'artifact-image', id: native.image,
    identity: { digest: native.digest, uploadTime: native.uploadTime, repositoryCreateTime: n.repositoryCreateTime }, reason: 'data-retention' as const }] : [];
  return { resources: acknowledged ? [] : [{ kind: native.operation === 'remove-tag' ? 'artifact-tag' : 'artifact-version', id: action.resource.name,
    identity: { digest: native.digest, uploadTime: native.uploadTime, repositoryCreateTime: n.repositoryCreateTime } }],
    native: { target: native, ...(operationName ? { operationName } : {}),
      ...(!acknowledged ? { retirement: operatorRetirementOutcomeSchema.parse({ outcome: retained.length ? 'retained-by-choice' : 'removed', retained }) } : {}) } };
}
function operationName(value: unknown, intent: Intent) {
  const n = gcpOperatorArtifactNames(intent), name = z.string().max(2048).parse(value);
  if (!new RegExp(`^projects/(${n.projectId}|${n.projectNumber})/locations/${n.region}/operations/[a-zA-Z0-9_-]+$`).test(name)) fail(); return name;
}
function selectedTargets(intent: Intent, records: Record[]): Target[] {
  if (intent.mode !== 'retire' || !intent.retirement || records.length !== intent.retirement.targets.length
    || new Set(records.map(record => record.installationId)).size !== records.length) fail();
  const current = gcpOperatorArtifactNames(intent);
  const targets = records.flatMap(record => {
    const ref = intent.retirement!.targets.find(item => item.installationId === record.installationId), historical = historicalInstallationEvidence(record);
    if (!ref || !historical || record.intent.mode !== 'connect' || record.plan.digest !== ref.planDigest
      || canonicalJsonSha256(historical) !== ref.evidenceDigest || record.intent.customerId !== intent.customerId
      || record.intent.appId !== intent.appId || record.intent.environment !== intent.environment || record.intent.provider !== intent.provider
      || record.intent.artifactProvider !== intent.artifactProvider || record.intent.source.repository !== intent.source.repository) fail();
    const previous = gcpOperatorArtifactNames(record.intent);
    for (const key of ['projectId', 'projectNumber', 'projectCreateTime', 'projectParent', 'projectInstallationId', 'projectAttemptId',
      'repositoryName', 'repositoryCreateTime', 'registryOwner', 'registryAttemptId']) if (previous[key] !== current[key]) fail();
    return Object.entries(historical).map(([actionId, value]) => {
      const parsed = parseGcpOperatorArtifactEvidence(value, record.intent), resource = parsed.resources[0]; if (!resource) fail();
      const action = record.plan.actions.find(item => item.id === actionId), attempt = record.attempts.filter(item => item.actionId === actionId).at(-1);
      if (!action || action.metadata.operation !== parsed.native.operation || !attempt || attempt.status !== 'succeeded'
        || attempt.id !== parsed.native.attemptId || !isDeepStrictEqual(attempt.evidence, parsed)) fail();
      const target = targetSchema.parse({ ...ref, kind: parsed.native.operation, image: resource.id, digest: resource.identity.digest,
        uploadTime: resource.identity.uploadTime, tag: parsed.native.tag }); validateTarget(intent, target); return target;
    });
  });
  // Shared immutable versions across publication attempts require a combined
  // tag review; do not silently broaden the selected historical publication.
  if (!targets.length || new Set(targets.map(item => item.image)).size !== targets.length) fail();
  return targets.sort((a, b) => a.image.localeCompare(b.image));
}
const reason = (error: unknown) => error instanceof CloudInstallationBoundaryError ? error.reason
  : error instanceof DestinationBoundaryError && error.status === 403 ? 'insufficient_permissions' as const
  : error instanceof DestinationBoundaryError && error.status === 401 ? 'authorization_expired' as const : 'provider_error' as const;

/** Separate from publication: never prepares, pulls or uploads an image. */
export function createGcpOperatorArtifactRetirementDriver(records?: Record[], options: { fetch?: typeof fetch } = {}): CloudInstallationDriver<Intent> {
  const publicationParser = createGcpOperatorArtifactDriver();
  function planned(intent: Intent) {
    if (!records) fail(); return selectedTargets(intent, records).flatMap(target => [actionFor(intent, target, 'remove-tag'),
      ...(intent.retirement!.data === 'delete-owned' ? [actionFor(intent, target, 'remove-version')] : [])]);
  }
  function selected(context: ActionContext) {
    const action = parseAction(context.action, context.intent);
    if (!planned(context.intent).some(item => isDeepStrictEqual(item, action))) fail(); return nativeSchema.parse(action.metadata.native);
  }
  async function withClient<T>(context: Context, work: (client: GcpSecretWriterClient) => Promise<T>, mutation = false) {
    const n = gcpOperatorArtifactNames(context.intent), budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      if (!context.authentication.administrator) throw new CloudInstallationBoundaryError('authorization_expired');
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', budget.signal));
      const client = new GcpSecretWriterClient({ token, budget, request: options.fetch ?? fetch, beforeWrite: context.beforeMutation, sleep: async () => {} });
      const p = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}`);
      const labels = z.record(z.string(), z.string()).parse(p.labels);
      if (p.name !== `projects/${n.projectNumber}` || p.projectId !== n.projectId || p.state !== 'ACTIVE' || p.createTime !== n.projectCreateTime
        || (p.parent ?? 'none') !== n.projectParent || labels['hv-installation'] !== n.projectOwner.slice(0, 63) || labels['hv-attempt'] !== n.projectAttemptId) fail();
      const repository = await client.json(root + n.repositoryName);
      if (repository.name !== n.repositoryName || repository.createTime !== n.repositoryCreateTime || repository.format !== 'DOCKER'
        || repository.mode !== 'STANDARD_REPOSITORY' || repository.description !== `hypervibe:operator-registry:${n.registryOwner}:${n.registryAttemptId}`
        || z.object({ immutableTags: z.boolean().optional() }).passthrough().parse(repository.dockerConfig ?? {}).immutableTags === true) fail();
      const required = permissions(context.intent, mutation);
      const permission = await client.json(root + n.repositoryName + ':testIamPermissions', { method: 'POST', body: JSON.stringify({ permissions: required }) });
      const allowed = z.array(z.string()).parse(permission.permissions); if (!required.every(item => allowed.includes(item))) throw new CloudInstallationBoundaryError('insufficient_permissions');
      return await work(client);
    } finally { budget.close(); }
  }
  async function read(client: GcpSecretWriterClient, url: string) {
    try { return await client.json(url); } catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
  }
  async function inspectNative(client: GcpSecretWriterClient, context: ActionContext, native: Native) {
    const n = validateTarget(context.intent, native);
    const image = await read(client, root + n.repositoryName + '/dockerImages/' + encodeURIComponent(n.imageName + '@' + native.digest));
    if (image && (image.name !== `${n.repositoryName}/dockerImages/${n.imageName}@${native.digest}` || image.uri !== native.image || image.uploadTime !== native.uploadTime)) fail();
    const tag = await read(client, root + n.tagName);
    if (tag && (tag.name !== n.tagName || tag.version !== n.version || !image)) fail();
    const version = await read(client, root + n.version);
    if (version && version.name !== n.version || Boolean(version) !== Boolean(image)) fail();
    // Complete package tag inventory, without provider-side filtering. Unknown
    // pages or a tag moved to another digest never authorize its removal.
    let pageToken: string | undefined; const seen = new Set<string>(), tags = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) });
      const result = await read(client, root + n.packageName + '/tags?' + query);
      if (!result) { if (!image && !tag && !version && page === 0) return { image, tag, version, n }; return fail(); }
      for (const item of z.array(z.object({ name: z.string(), version: z.string() }).passthrough()).max(100).parse(result.tags === undefined ? [] : result.tags)) {
        if (!item.name.startsWith(n.packageName + '/tags/') || !item.version.startsWith(n.packageName + '/versions/') || tags.has(item.name)) fail(); tags.add(item.name);
        if (item.version === n.version && item.name !== n.tagName) fail();
      }
      if (result.nextPageToken === undefined || result.nextPageToken === '') {
        if (Boolean(tag) !== tags.has(n.tagName)) fail();
        return { image, tag, version, n };
      }
      pageToken = z.string().min(1).max(4096).parse(result.nextPageToken); if (seen.has(pageToken)) fail(); seen.add(pageToken);
    }
    return fail();
  }
  async function observe(context: ActionContext & { attempt?: { status: string; evidence?: CloudInstallationEvidence } }) {
    const native = selected(context);
    return withClient(context, async client => {
      const prior = context.attempt?.evidence;
      if (prior?.native.operationName && context.attempt?.status !== 'succeeded') {
        const name = operationName(prior.native.operationName, context.intent), operation = await client.json(root + name);
        if (operation.name !== name || operation.error) fail();
        if (operation.done !== true) return { state: 'pending' as const, reason: 'not_converged' as const };
      }
      const observed = await inspectNative(client, context, native);
      if (native.operation === 'remove-tag' ? !observed.tag : !observed.version) {
        if (context.intent.retirement!.data === 'retain' && !observed.image) fail();
        return { state: 'satisfied' as const, evidence: evidence(context.intent, context.action,
          prior?.native.operationName ? operationName(prior.native.operationName, context.intent) : undefined) };
      }
      return { state: 'action-required' as const };
    });
  }
  const driver: CloudInstallationDriver<Intent> = {
    provider: 'gcp', artifactPublication: { providerName: 'cloudrun', authentication: 'google-user-adc' }, operatorRetirement: { schemaVersion: 1 },
    parseScope: value => gcpOperatorArtifactScopeSchema.parse(value),
    parseAction: (value, intent) => intent.mode === 'connect' ? publicationParser.parseAction(value, intent) : parseAction(value, intent),
    parseEvidence(value, intent) {
      if (intent.mode === 'connect') return publicationParser.parseEvidence(value, intent);
      const native = z.object({ target: nativeSchema, operationName: z.string().optional(), retirement: z.unknown().optional() }).strict()
        .parse(z.object({ native: z.unknown() }).parse(value).native);
      const { operation, ...target } = native.target, action = actionFor(intent, target, operation);
      const name = native.operationName ? operationName(native.operationName, intent) : undefined;
      if (name && operation !== 'remove-version') fail();
      const expected = evidence(intent, action, name, native.retirement === undefined); if (!isDeepStrictEqual(expected, value)) fail(); return expected;
    },
    async plan(context) {
      const actions = planned(context.intent);
      for (const action of actions) await withClient(context, client => inspectNative(client, { ...context, action }, selected({ ...context, action })), true);
      const n = gcpOperatorArtifactNames(context.intent);
      return { actions, review: { resources: actions.map(action => ({ kind: 'artifact-reference', name: action.resource.name, scope: n.repositoryName })),
        permissions: [{ principal: 'Current local operator', scope: n.repositoryName, actions: permissions(context.intent, true), purpose: 'installation-verification' },
          { principal: 'Current local operator', scope: `projects/${n.projectNumber}`, actions: ['resourcemanager.projects.get'], purpose: 'installation-verification' }],
        costs: [{ resource: n.repositoryName, description: 'The shared repository and other images remain. Retained images and repository traffic may still incur charges.', pricingUrl: 'https://cloud.google.com/artifact-registry/pricing' }],
        warnings: ['Only the selected original publication tags and, if selected, their immutable image versions are removed. No repository or IAM grant is deleted.',
          'Removed images can no longer be deployed or used for rollback. Copies downloaded elsewhere are not erased; external consumers cannot be inventoried by Hypervibe.',
          'Tags expose a name and destination, without an immutable creation identity. A same-name replacement pointing to the same digest cannot be distinguished from the original tag.',
          'Tag deletion has no native precondition, and version deletion cannot condition on the observed upload time. External tag moves or same-digest replacement after the final read cannot be excluded. Version deletion uses force=false so any remaining or newly added tag blocks it.',
          ...(context.intent.retirement!.data === 'retain' ? ['The image bytes and immutable URLs remain by choice, including any existing public read access. A later image deletion needs a separately supported review.'] : [])] } };
    },
    async inspect(context) { try { return await observe(context); } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let clientUsed: GcpSecretWriterClient | undefined;
      try {
        const native = selected(context);
        return await withClient(context, async client => {
          clientUsed = client; const current = await inspectNative(client, context, native);
          if (native.operation === 'remove-tag' ? !current.tag : !current.version) return { state: 'acknowledged' as const, evidence: evidence(context.intent, context.action) };
          if (native.operation === 'remove-version' && current.tag) fail();
          const result = await client.json(root + (native.operation === 'remove-tag' ? current.n.tagName : current.n.version + '?force=false'), { method: 'DELETE' }, true);
          if (native.operation === 'remove-tag') { if (Object.keys(result).length) fail(); return { state: 'acknowledged' as const, evidence: evidence(context.intent, context.action, undefined, true) }; }
          const name = operationName(result.name, context.intent); if (result.error) fail();
          return { state: 'acknowledged' as const, evidence: evidence(context.intent, context.action, name, true) };
        }, true);
      } catch (error) { return { state: !clientUsed || clientUsed.canRetryRejectedMutation() ? 'rejected' : 'uncertain', reason: reason(error) }; }
    },
    async recover(context) { try { const result = await observe(context); return result.state === 'action-required' ? { state: 'pending', reason: 'not_converged' } : result;
      } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    connections: () => [], scopePreparation: { resolvedScope: record => record.intent.nativeScope, reviewResources: () => [] },
  };
  return driver;
}

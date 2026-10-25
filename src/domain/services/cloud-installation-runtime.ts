import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { orderActions } from '../plan/order-actions.js';
import { hasExactPlanActionConfirmationAuthority } from '../plan/action-confirmation.js';
import { secretDestinationSchema, secretDestinationIdentity } from '../ports/secret-destination.port.js';
import { cloudDeploymentTopologySchema, parseCloudDeploymentConnectionV1 } from './cloud-deployment-authentication.js';
import {
  CLOUD_INSTALLATION_PROVIDERS, CLOUD_INSTALLATION_SECRET_PROVIDERS, CLOUD_INSTALLATION_REASONS, CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationApplyInput,
  type CloudInstallationContext, type CloudInstallationDriver, type CloudInstallationEvidence,
  type CloudInstallationIntent, type CloudInstallationObservation, type CloudInstallationReason,
  type CloudInstallationRecord, type CloudInstallationProviderContext,
  type CloudInstallationMutation, type CloudInstallationExecutableIntent, type LocalCloudScopePreparationIntent, type OperatorArtifactIntent,
} from '../ports/cloud-installation.port.js';

export class CloudInstallationError extends Error {
  constructor(readonly code: string) { super(`Cloud installation: ${code}.`); this.name = 'CloudInstallationError'; }
}
const text = z.string().min(1).max(2048);
const strings = z.record(z.string(), text);
const reasonSchema = z.enum(CLOUD_INSTALLATION_REASONS);
const hostSchema = z.object({ kind: z.literal('gcp-service-account'), projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  projectNumber: z.string().regex(/^[1-9]\d{5,19}$/), serviceAccountEmail: z.string().max(254).regex(/^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/),
  subject: z.string().regex(/^[1-9]\d{5,29}$/), issuer: z.literal('https://accounts.google.com') }).strict();
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: text, id: text, identity: strings }).strict()).max(300),
  native: z.record(z.string(), z.unknown()) }).strict();
const intentSchema = z.object({ schemaVersion: z.literal(1), installationId: z.string().guid(), customerId: text, appId: text,
  environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  source: z.object({ repository: z.string().max(500).regex(/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/), branch: text,
    revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), specDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  provider: z.enum(CLOUD_INSTALLATION_PROVIDERS), mode: z.enum(['connect', 'connect-existing', 'migrate', 'disconnect']), nativeScope: strings, hostIdentity: hostSchema,
  purpose: z.enum(['collection', 'deployment']).optional(),
  deployment: cloudDeploymentTopologySchema.optional(),
  stage: z.enum(['scope-preparation', 'collection', 'deployment']).optional(),
  scopePreparation: z.object({ installationId: z.string().guid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  keys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(100).refine(keys => new Set(keys).size === keys.length),
  migrationTargets: z.array(z.object({ key: text, destination: secretDestinationSchema }).strict()).min(1).max(100).optional(),
  installed: z.array(evidenceSchema).max(300).optional() }).strict();
const localIntentSchema = intentSchema.omit({ hostIdentity: true, purpose: true, deployment: true, scopePreparation: true,
  migrationTargets: true, installed: true, source: true }).extend({
  selection: strings.optional(),
  predecessor: z.object({ installationId: z.string().guid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  execution: z.object({ kind: z.literal('local-administrator'), authentication: z.literal('google-user-adc') }).strict(),
  hostingProvider: text,
  mode: z.literal('connect'), stage: z.literal('scope-preparation'), keys: z.tuple([]),
  source: z.object({ kind: z.literal('local-spec'), repository: intentSchema.shape.source.shape.repository,
    specRevision: z.number().int().positive(), specDigest: intentSchema.shape.source.shape.specDigest }).strict(),
}).strict();
const artifactIntentSchema = localIntentSchema.omit({ execution: true, hostingProvider: true }).extend({
  execution: z.object({ kind: z.literal('operator-artifact-publisher'), authentication: z.enum(['aws-session', 'google-user-adc']) }).strict(),
  artifactProvider: text, artifacts: z.array(z.enum(['aws-collection-template-v1', 'aws-deployment-template-v1', 'holding-v1', 'backup-runner-v1'])).min(1).max(4),
}).strict();

function localIntent(intent: CloudInstallationExecutableIntent): intent is LocalCloudScopePreparationIntent {
  return 'execution' in intent && intent.execution.kind === 'local-administrator';
}
function artifactIntent(intent: CloudInstallationExecutableIntent): intent is OperatorArtifactIntent {
  return 'execution' in intent && intent.execution.kind === 'operator-artifact-publisher';
}
const actionSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.\/-]{0,255}$/).refine(value => !['constructor', 'prototype', '__proto__'].includes(value)), type: z.enum(['create', 'update', 'replace', 'destroy', 'noop']),
  resource: z.object({ kind: z.enum(['project', 'environment', 'service', 'volume', 'database', 'cache', 'storage', 'retained-resource', 'load-balancer', 'domain',
    'email', 'messaging', 'ci', 'repo', 'ios', 'queue', 'secret', 'payment', 'maintenance']), name: text, provider: z.enum(CLOUD_INSTALLATION_PROVIDERS) }).strict(),
  verified: z.boolean(), reason: text, diff: z.array(z.object({ field: text, from: z.string().max(2048).optional(), to: z.string().max(2048).optional() }).strict()).max(100).optional(),
  dataBearing: z.boolean().optional(), billable: z.boolean().optional(), requiresConfirm: z.boolean().optional(), dependsOn: z.array(text).max(300).optional(),
  metadata: z.object({ operation: text, category: z.enum(['scope', 'identity', 'trust', 'secret-container', 'verification']),
    execution: z.enum(['api', 'external']), native: z.record(z.string(), z.unknown()) }).strict() }).strict();
const reviewSchema = z.object({ resources: z.array(z.object({ kind: text, name: text, scope: text }).strict()).max(300).optional(),
  permissions: z.array(z.object({ principal: text, scope: text, actions: z.array(text).max(100),
  purpose: z.enum(['writer', 'installation-verification', 'hosted-trust-removal', 'deployment-provision', 'deployment-release', 'runtime-reader']) }).strict()).max(300),
  costs: z.array(z.object({ resource: text, description: text, pricingUrl: z.string().url().max(2048) }).strict()).max(300), warnings: z.array(text).max(100) }).strict();
const attemptSchema = z.object({ id: z.string().guid(), actionId: text, status: z.enum(['attempted', 'acknowledged', 'pending', 'uncertain', 'rejected', 'succeeded']),
  startedAt: z.string().datetime(), updatedAt: z.string().datetime(), evidence: evidenceSchema.optional(), externalUrl: z.string().url().max(16384).optional(), reason: reasonSchema.optional() }).strict();
const recordSchema = z.object({ schemaVersion: z.literal(1), installationId: z.string().guid(), revision: z.number().int().nonnegative(), intent: z.unknown(),
  plan: z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), actions: z.array(actionSchema).min(1).max(300), review: reviewSchema, blockedReason: reasonSchema.optional() }).strict(),
  status: z.enum(['review-required', 'pending', 'blocked', 'scope-ready', 'ready', 'disconnected']), attempts: z.array(attemptSchema).max(3000), completed: z.record(z.string(), evidenceSchema), reason: reasonSchema.optional() }).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Defense in depth; exact provider schemas, rather than key filtering, define allowed metadata. */
function nonsecret(value: unknown, depth = 0): void {
  if (depth > 15) throw new CloudInstallationError('invalid_contract');
  if (Array.isArray(value)) { for (const item of value) nonsecret(item, depth + 1); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:value|secretString|secretBinary|password|privateKey|clientSecret|accessToken|refreshToken|idToken|sessionToken|accessKeyId|secretAccessKey)$/i.test(key.replace(/[_-]/g, '')))
        throw new CloudInstallationError('invalid_contract');
      nonsecret(item, depth + 1);
    }
  } else if (typeof value === 'string' && (value.length > 16384 || /-----BEGIN .*PRIVATE KEY-----/.test(value))) throw new CloudInstallationError('invalid_contract');
  else if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new CloudInstallationError('invalid_contract');
}
function contract<T>(work: () => T): T {
  try { const value = work(); nonsecret(value); if (canonical(value).length > 1_000_000) throw new Error(); return value; }
  catch { throw new CloudInstallationError('invalid_contract'); }
}
function parseEvidence<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(value: unknown, intent: I, driver: CloudInstallationDriver<I>): CloudInstallationEvidence {
  return contract(() => evidenceSchema.parse(driver.parseEvidence(evidenceSchema.parse(value), intent)));
}
export function parseCloudInstallationIntentV1<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(value: unknown, driver: CloudInstallationDriver<I>): I {
  return contract(() => {
    const actor = value && typeof value === 'object' && 'execution' in value ? (value as { execution?: { kind?: unknown } }).execution?.kind : undefined;
    const isArtifact = actor === 'operator-artifact-publisher';
    const isLocal = actor === 'local-administrator';
    if (isLocal !== Boolean(driver.localScopePreparation) || isArtifact !== Boolean(driver.artifactPublication)
      || actor !== undefined && !isLocal && !isArtifact || isLocal && isArtifact) throw new Error();
    const parsed = (isArtifact ? artifactIntentSchema.parse(value) : isLocal ? localIntentSchema.parse(value) : intentSchema.parse(value)) as I;
    if (artifactIntent(parsed)) {
      if (!driver.scopePreparation || driver.deployment || parsed.provider !== driver.provider
        || parsed.artifactProvider !== driver.artifactPublication?.providerName
        || parsed.execution.authentication !== driver.artifactPublication.authentication
        || new Set(parsed.artifacts).size !== parsed.artifacts.length || parsed.predecessor?.installationId === parsed.installationId) throw new Error();
      parsed.nativeScope = strings.parse(driver.parseScope(parsed.nativeScope)); return parsed;
    }
    if (localIntent(parsed)) {
      if (!driver.scopePreparation || driver.deployment || parsed.provider !== driver.provider
        || parsed.hostingProvider !== driver.localScopePreparation?.hostingProvider
        || Boolean(parsed.predecessor) !== Boolean(driver.localScopePreparation?.continuation)
        || Boolean(parsed.selection) !== Boolean(parsed.predecessor)
        || parsed.predecessor?.installationId === parsed.installationId) throw new Error();
      parsed.nativeScope = strings.parse(driver.parseScope(parsed.nativeScope));
      return parsed;
    }
    if (!parsed.hostIdentity || parsed.provider !== driver.provider || !parsed.hostIdentity.serviceAccountEmail.endsWith(`@${parsed.hostIdentity.projectId}.iam.gserviceaccount.com`)) throw new Error();
    if (parsed.purpose === 'deployment') {
      if (!driver.deployment || parsed.keys.length || ['migrate', 'connect-existing'].includes(parsed.mode) || parsed.migrationTargets) throw new Error();
      if (parsed.stage === 'scope-preparation') { if (parsed.deployment) throw new Error(); }
      else if (parsed.stage !== 'deployment' || !parsed.deployment || parsed.deployment.hostingProvider !== driver.deployment.hostingProvider) throw new Error();
    } else if (!parsed.keys.length || parsed.stage === 'deployment' || parsed.deployment) throw new Error();
    if (parsed.stage === 'scope-preparation' && (!driver.scopePreparation || ['migrate', 'connect-existing'].includes(parsed.mode) || parsed.mode === 'connect' && parsed.installed || parsed.migrationTargets)) throw new Error();
    if (parsed.scopePreparation && (parsed.mode !== 'connect' || parsed.scopePreparation.installationId === parsed.installationId || !driver.scopePreparation)) throw new Error();
    parsed.nativeScope = strings.parse(driver.parseScope(parsed.nativeScope));
    parsed.installed = parsed.installed?.map(item => parseEvidence(item, parsed, driver));
    if (parsed.mode === 'disconnect' && !parsed.installed?.length) throw new Error();
    if (['migrate', 'connect-existing'].includes(parsed.mode) && !parsed.migrationTargets?.length) throw new Error();
    if (parsed.migrationTargets) {
      const targets = parsed.migrationTargets;
      if (parsed.mode === 'connect' || targets.length !== parsed.keys.length || new Set(targets.map(item => item.key)).size !== parsed.keys.length
        || targets.some(item => !parsed.keys.includes(item.key) || item.destination.provider !== CLOUD_INSTALLATION_SECRET_PROVIDERS[parsed.provider])
        || new Set(targets.map(item => secretDestinationIdentity(item.destination).resource)).size !== targets.length) throw new Error();
    }
    return parsed;
  });
}
function parseActions<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(value: unknown, intent: I, driver: CloudInstallationDriver<I>, blockedReason?: CloudInstallationReason): CloudInstallationAction[] {
  return contract(() => {
    const actions = z.array(actionSchema).min(1).max(300).parse(value).map(raw => actionSchema.parse(driver.parseAction(raw, intent)));
    if (localIntent(intent)) {
      if (!driver.localScopePreparation?.continuation && (actions.length !== 1 || actions[0].resource.kind !== 'project'
        || actions[0].metadata.category !== 'scope' || actions[0].metadata.execution !== 'api'
        || !['create', 'noop'].includes(actions[0].type) || actions[0].dependsOn?.length)) throw new Error();
      if (driver.localScopePreparation?.continuation && actions.some(action => action.metadata.execution !== 'api'
        || !['scope', 'identity', 'trust', 'verification'].includes(action.metadata.category)
        || !['create', 'update', 'noop'].includes(action.type))) throw new Error();
    }
    if (artifactIntent(intent) && actions.some(action => action.metadata.execution !== 'api'
      || !['scope', 'identity', 'trust', 'verification'].includes(action.metadata.category)
      || !['create', 'update', 'noop'].includes(action.type))) throw new Error();
    for (const action of actions) {
      if (action.resource.provider !== intent.provider || (!action.verified && !blockedReason) || (action.type !== 'noop' && action.requiresConfirm !== true)) throw new Error();
      if (intent.mode === 'disconnect' && action.type !== 'noop' && (action.metadata.category !== 'trust' || !['update', 'destroy'].includes(action.type))) throw new Error();
      if (intent.mode !== 'disconnect' && ['destroy', 'replace'].includes(action.type)) throw new Error();
      if (['migrate', 'connect-existing'].includes(intent.mode) && action.metadata.category === 'secret-container' && action.type !== 'noop') throw new Error();
      if (intent.stage === 'scope-preparation' && action.metadata.category === 'secret-container') throw new Error();
      if (intent.purpose === 'deployment' && action.metadata.category === 'secret-container') throw new Error();
    }
    orderActions(actions);
    return actions;
  });
}
function digest(intent: CloudInstallationExecutableIntent, actions: CloudInstallationAction[], review: CloudInstallationRecord['plan']['review'], blockedReason?: CloudInstallationReason): string {
  return createHash('sha256').update(canonical({ intent, actions, review, ...(blockedReason ? { blockedReason } : {}) })).digest('hex');
}
export function parseCloudInstallationRecordV1<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(value: unknown, driver: CloudInstallationDriver<I>): CloudInstallationRecord<I> {
  return contract(() => {
    const raw = recordSchema.parse(value);
    const parsed: CloudInstallationRecord<I> = { ...raw, intent: parseCloudInstallationIntentV1(raw.intent, driver) };
    parsed.plan.actions = parseActions(parsed.plan.actions, parsed.intent, driver, parsed.plan.blockedReason);
    if (parsed.installationId !== parsed.intent.installationId || parsed.plan.digest !== digest(parsed.intent, parsed.plan.actions, parsed.plan.review, parsed.plan.blockedReason)) throw new Error();
    if (parsed.plan.blockedReason && ['scope-ready', 'ready', 'disconnected'].includes(parsed.status)) throw new Error();
    if (parsed.status === 'scope-ready' && parsed.intent.stage !== 'scope-preparation'
      || parsed.intent.stage === 'scope-preparation' && (parsed.status === 'ready' || parsed.status === 'disconnected' && parsed.intent.mode !== 'disconnect')) throw new Error();
    const ids = new Set(parsed.plan.actions.map(action => action.id));
    const attempts = new Set<string>();
    for (const attempt of parsed.attempts) {
      if (!ids.has(attempt.actionId) || attempts.has(attempt.id)) throw new Error();
      attempts.add(attempt.id);
      if (attempt.evidence) attempt.evidence = parseEvidence(attempt.evidence, parsed.intent, driver);
      if (attempt.externalUrl && new URL(attempt.externalUrl).protocol !== 'https:') throw new Error();
    }
    for (const [id, evidence] of Object.entries(parsed.completed)) {
      if (!ids.has(id)) throw new Error();
      parsed.completed[id] = parseEvidence(evidence, parsed.intent, driver);
    }
    if (['scope-ready', 'ready', 'disconnected'].includes(parsed.status) && ids.size !== Object.keys(parsed.completed).length) throw new Error();
    if (parsed.status === 'scope-ready') {
      const resolved = driver.scopePreparation!.resolvedScope(parsed);
      strings.parse(localIntent(parsed.intent) ? resolved : driver.parseScope(resolved));
    }
    return parsed;
  });
}
export function cloudInstallationConnectionsV1(value: unknown, driver: CloudInstallationDriver) {
  const record = parseCloudInstallationRecordV1(value, driver);
  if (record.status !== 'ready' || record.intent.mode === 'disconnect' || record.intent.stage === 'scope-preparation' || record.intent.purpose === 'deployment') throw new CloudInstallationError('not_ready');
  return contract(() => {
    const results = z.array(z.object({ key: text, destination: secretDestinationSchema, writerAuthorization: strings }).strict()).max(100).parse(driver.connections(record));
    if (new Set(results.map(result => result.key)).size !== record.intent.keys.length || results.length !== record.intent.keys.length
      || results.some(result => !record.intent.keys.includes(result.key))) throw new Error();
    if (['migrate', 'connect-existing'].includes(record.intent.mode) && results.some(result => {
      const reviewed = record.intent.migrationTargets?.find(target => target.key === result.key);
      return !reviewed || canonical(reviewed.destination) !== canonical(result.destination);
    })) throw new Error();
    return results;
  });
}
export function cloudInstallationDeploymentConnectionV1(value: unknown, driver: CloudInstallationDriver) {
  const record = parseCloudInstallationRecordV1(value, driver);
  if (record.status !== 'ready' || record.intent.mode === 'disconnect' || record.intent.purpose !== 'deployment' || record.intent.stage !== 'deployment' || !driver.deployment)
    throw new CloudInstallationError('not_ready');
  return contract(() => {
    const connection = parseCloudDeploymentConnectionV1(driver.deployment!.connection(record), {
      provider: driver.provider, hostingProvider: driver.deployment!.hostingProvider, parseScope: scope => driver.parseScope(scope),
      parsePreparedResources: driver.deployment!.parsePreparedResources,
    });
    for (const key of ['installationId', 'customerId', 'appId', 'environment', 'source', 'provider', 'nativeScope', 'hostIdentity', 'deployment'] as const)
      if (canonical(connection[key]) !== canonical(record.intent[key])) throw new Error();
    if (connection.planDigest !== record.plan.digest) throw new Error();
    return connection;
  });
}

/** Pure value-free projection; scope readiness is never collection authorization. */
export function cloudInstallationResolvedScopeV1<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(value: unknown, driver: CloudInstallationDriver<I>): Record<string, string> {
  const record = parseCloudInstallationRecordV1(value, driver);
  if (record.status !== 'scope-ready' || record.intent.stage !== 'scope-preparation' || !driver.scopePreparation) throw new CloudInstallationError('not_ready');
  return contract(() => { const resolved = driver.scopePreparation!.resolvedScope(record); return strings.parse(localIntent(record.intent) || artifactIntent(record.intent) ? resolved : driver.parseScope(resolved)); });
}
export function cloudInstallationNextStageV1(value: unknown, driver: CloudInstallationDriver): 'scope-preparation' | 'collection' | 'deployment' {
  if (driver.localScopePreparation || driver.artifactPublication) throw new CloudInstallationError('unsupported');
  const record = parseCloudInstallationRecordV1(value, driver);
  cloudInstallationResolvedScopeV1(record, driver);
  return contract(() => {
    const stage = z.enum(['scope-preparation', 'collection', 'deployment']).parse(driver.scopePreparation?.continuationStage?.(record) ?? 'collection');
    if (stage === 'scope-preparation') return stage;
    if (stage === 'deployment' && record.intent.purpose !== 'deployment') throw new Error();
    return record.intent.purpose === 'deployment' ? 'deployment' : 'collection';
  });
}
/** Caller first reconciles exact historical attempts. This pure projection cannot invent ownership. */
export function cloudInstallationDisconnectionIntentV1(value: unknown, driver: CloudInstallationDriver, installationId: string): CloudInstallationIntent | null {
  const record = parseCloudInstallationRecordV1(value, driver);
  if (record.intent.mode === 'disconnect' || record.installationId === installationId) throw new CloudInstallationError('scope_mismatch');
  z.string().guid().parse(installationId);
  if (record.intent.stage === 'scope-preparation') {
    if (!driver.scopePreparation?.disconnectionIntent) throw new CloudInstallationError('unsupported');
    const intent = driver.scopePreparation.disconnectionIntent(record, installationId);
    return intent ? parseCloudInstallationIntentV1(intent, driver) : null;
  }
  if (record.attempts.some(attempt => !['succeeded', 'rejected'].includes(attempt.status)
    || attempt.status === 'succeeded' && !record.completed[attempt.actionId])) throw new CloudInstallationError('not_converged');
  if (!record.attempts.length && !Object.keys(record.completed).length) return null;
  const { scopePreparation: _predecessor, stage: _stage, ...original } = record.intent;
  return parseCloudInstallationIntentV1({ ...original, ...(original.purpose === 'deployment' ? { stage: 'deployment' } : {}), installationId, mode: 'disconnect', installed: Object.values(record.completed) }, driver);
}
async function verifyScopePreparation(context: CloudInstallationContext, intent: CloudInstallationIntent, lineage: string[]): Promise<void> {
  if (lineage.length >= 4 || lineage.includes(intent.installationId)) throw new CloudInstallationError('scope_mismatch');
  if (!intent.scopePreparation) return;
  const previous = await read(context, intent.scopePreparation.installationId);
  if (!previous || previous.plan.digest !== intent.scopePreparation.planDigest
    || (previous.intent.purpose ?? 'collection') !== (intent.purpose ?? 'collection')) throw new CloudInstallationError('scope_mismatch');
  for (const key of ['customerId', 'appId', 'environment', 'provider', 'source', 'hostIdentity', 'keys'] as const)
    if (canonical(previous.intent[key]) !== canonical(intent[key])) throw new CloudInstallationError('scope_mismatch');
  if (canonical(cloudInstallationResolvedScopeV1(previous, context.driver)) !== canonical(intent.nativeScope)) throw new CloudInstallationError('scope_mismatch');
  if (cloudInstallationNextStageV1(previous, context.driver) !== (intent.stage ?? 'collection')) throw new CloudInstallationError('scope_mismatch');
  // Stored readiness is historical evidence. Re-read the exact scope before
  // later stage reads/writes too, including final prewrite authorization. The
  // bounded lineage above rejects cycles while recursively checking ancestors.
  for (const action of orderActions(previous.plan.actions) as CloudInstallationAction[]) {
    const attempt = previous.attempts.filter(item => item.actionId === action.id).at(-1);
    const observation = await authorized(context, previous.intent, 'recover', previous.plan.digest, action.id,
      providerContext => attempt ? context.driver.recover({ ...providerContext, action, attempt })
        : context.driver.inspect({ ...providerContext, action }), previous.completed, [...lineage, intent.installationId], previous.attempts);
    if (observation.state !== 'satisfied') throw new CloudInstallationError('reason' in observation ? observation.reason : 'not_converged');
    if (canonical(parseEvidence(observation.evidence, previous.intent, context.driver)) !== canonical(previous.completed[action.id]))
      throw new CloudInstallationError('identity_mismatch');
  }
}

async function bounded<T>(context: Pick<CloudInstallationContext, 'signal' | 'timeoutMs'>, work: (signal: AbortSignal) => Promise<T>, maximumMs = 60000): Promise<T> {
  const timeoutMs = context.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumMs) throw new CloudInstallationError('invalid_contract');
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CloudInstallationError(context.signal?.aborted ? 'cancelled' : 'timeout'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => work(signal)).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function authorized<T, I extends CloudInstallationExecutableIntent>(context: CloudInstallationContext<I>, intent: I,
  phase: 'plan' | 'inspect' | 'mutate' | 'recover', planDigest: string | undefined, actionId: string | undefined,
  work: (input: CloudInstallationProviderContext<I>) => Promise<T>, completed: Readonly<Record<string, CloudInstallationEvidence>> = {}, lineage: string[] = [],
  attempts: CloudInstallationRecord['attempts'] = []): Promise<T> {
  return bounded(context, async signal => {
    if (!await context.authorize({ intent: structuredClone(intent), phase, planDigest, actionId })) throw new CloudInstallationError('authorization_revoked');
    if (artifactIntent(intent)) {
      if (!context.driver.artifactPublication || !('kind' in context.authentication) || context.authentication.kind !== 'operator-artifact-publisher'
        || 'host' in context.authentication || (intent.execution.authentication === 'aws-session' ? !context.authentication.awsSession : !context.authentication.administrator))
        throw new CloudInstallationError('authorization_expired');
    } else if (localIntent(intent)) {
      if (!context.driver.localScopePreparation || !('kind' in context.authentication)
        || context.authentication.kind !== 'local-administrator' || !context.authentication.administrator
        || 'host' in context.authentication) throw new CloudInstallationError('authorization_expired');
    } else {
      await verifyScopePreparation({ ...context, signal } as CloudInstallationContext, intent, lineage);
      if (!('host' in context.authentication) || 'kind' in context.authentication) throw new CloudInstallationError('authorization_expired');
      const suppliedHost = await context.authentication.host.verifyIdentity(signal);
      const host = contract(() => hostSchema.parse(suppliedHost));
      if (canonical(host) !== canonical(intent.hostIdentity)) throw new CloudInstallationError('identity_mismatch');
    }
    if (signal.aborted) throw new CloudInstallationError('cancelled');
    return work({ intent: structuredClone(intent), authentication: context.authentication, signal, completed: structuredClone(completed), attempts: structuredClone(attempts),
      beforeMutation: async () => { throw new CloudInstallationError('mutation_not_authorized'); } });
  }, artifactIntent(intent) ? 600_000 : 60_000);
}
function reason(error: unknown): CloudInstallationReason {
  if (error instanceof CloudInstallationBoundaryError && reasonSchema.safeParse(error.reason).success) return error.reason;
  return error instanceof CloudInstallationError && reasonSchema.safeParse(error.code).success ? error.code as CloudInstallationReason : 'provider_error';
}
async function save<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(context: CloudInstallationContext<I>, record: CloudInstallationRecord<I>, expected: number | null): Promise<CloudInstallationRecord<I>> {
  const next = parseCloudInstallationRecordV1({ ...record, revision: expected === null ? 0 : expected + 1 }, context.driver);
  let success: boolean;
  try { success = await context.store.compareAndSwap(next.installationId, expected, structuredClone(next)); }
  catch { throw new CloudInstallationError('store_unavailable'); }
  if (!success) throw new CloudInstallationError('store_conflict');
  return next;
}
async function read<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(context: CloudInstallationContext<I>, id: string): Promise<CloudInstallationRecord<I> | null> {
  if (!z.string().guid().safeParse(id).success) throw new CloudInstallationError('invalid_contract');
  let raw;
  try { raw = await context.store.read(id); } catch { throw new CloudInstallationError('store_unavailable'); }
  if (raw === null) return null;
  const record = parseCloudInstallationRecordV1(raw, context.driver);
  if (record.installationId !== id) throw new CloudInstallationError('scope_mismatch');
  return record;
}
export async function planCloudInstallationV1<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(input: CloudInstallationContext<I> & { intent: unknown }): Promise<CloudInstallationRecord<I>> {
  const intent = parseCloudInstallationIntentV1(input.intent, input.driver);
  const existing = await read(input, intent.installationId);
  if (existing) {
    if (canonical(intent) !== canonical(existing.intent)) throw new CloudInstallationError('scope_mismatch');
    try { return await authorized(input, intent, 'plan', existing.plan.digest, undefined, async () => existing); }
    catch (error) { throw new CloudInstallationError(reason(error)); }
  }
  let proposal;
  try { proposal = await authorized(input, intent, 'plan', undefined, undefined, context => input.driver.plan(context)); }
  catch (error) { throw new CloudInstallationError(reason(error)); }
  const blockedReason = proposal.blockedReason === undefined ? undefined : contract(() => reasonSchema.parse(proposal.blockedReason));
  const actions = parseActions(proposal.actions, intent, input.driver, blockedReason);
  const review = contract(() => reviewSchema.parse(proposal.review));
  if (intent.scopePreparation) {
    const previous = await read(input, intent.scopePreparation.installationId);
    if (!previous || previous.plan.digest !== intent.scopePreparation.planDigest
    || (previous.intent.purpose ?? 'collection') !== (intent.purpose ?? 'collection')) throw new CloudInstallationError('scope_mismatch');
    review.resources = contract(() => reviewSchema.shape.resources.parse([
      ...(input.driver.scopePreparation!.reviewResources(previous)), ...(review.resources ?? []),
    ]));
  }
  return save(input, { schemaVersion: 1, installationId: intent.installationId, revision: 0, intent,
    plan: { digest: digest(intent, actions, review, blockedReason), actions, review, ...(blockedReason ? { blockedReason } : {}) },
    status: blockedReason ? 'blocked' : 'review-required', ...(blockedReason ? { reason: blockedReason } : {}), attempts: [], completed: {} }, null);
}

async function execute<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(input: CloudInstallationApplyInput<I>, readOnly: boolean): Promise<CloudInstallationRecord<I>> {
  let record = await read(input, input.installationId);
  if (!record) throw new CloudInstallationError('not_found');
  if (record.plan.digest !== input.planDigest) throw new CloudInstallationError('plan_mismatch');
  if (input.onlyActionId && (!(localIntent(record.intent) && input.driver.localScopePreparation?.continuation || artifactIntent(record.intent) && input.driver.artifactPublication)
    || !record.plan.actions.some(action => action.id === input.onlyActionId))) throw new CloudInstallationError('invalid_contract');
  if (record.status === 'disconnected') {
    // A terminal removal receipt is historical evidence. Requiring the removed
    // customer trust to read it would make successful disconnection unrecoverable.
    const completed = record;
    try { return await authorized(input, record.intent, 'recover', record.plan.digest, undefined, async () => completed); }
    catch (error) { throw new CloudInstallationError(reason(error)); }
  }
  const update = async (next: CloudInstallationRecord<I>) => { record = await save(input, next, record!.revision); return record; };
  const stop = (status: CloudInstallationRecord['status'], why: CloudInstallationReason) => update({ ...record!, status, reason: why });
  if (record.plan.blockedReason && (!readOnly || record.attempts.length === 0)) {
    try { await authorized(input, record.intent, 'recover', record.plan.digest, undefined, async () => undefined); }
    catch (error) { return stop('blocked', reason(error)); }
    return stop('blocked', record.plan.blockedReason);
  }
  const confirmed = new Set(input.confirmActions);
  if (!readOnly) {
    const unconfirmed = record.plan.actions.find(action => (!input.onlyActionId || action.id === input.onlyActionId) && action.type !== 'noop'
      && !hasExactPlanActionConfirmationAuthority(action, true, confirmed));
    if (unconfirmed) return stop('blocked', 'confirmation_required');
  }
  const ordered = orderActions(record.plan.actions) as CloudInstallationAction[];
  for (const action of ordered) {
    if (input.onlyActionId && action.id !== input.onlyActionId && !record.completed[action.id]) continue;
    if (input.onlyActionId === action.id && action.dependsOn?.some(id => !record!.completed[id])) return stop('blocked', 'not_converged');
    // Finished records are freshly re-observed too; cached success never grants continuing authority.
    let attempt = record.attempts.filter(item => item.actionId === action.id).at(-1);
    // A blocked review can only recover exact historical attempts. It cannot
    // turn a lookalike resource or a completed prerequisite into new authority.
    if (record.plan.blockedReason && !attempt) continue;
    let observation: CloudInstallationObservation;
    try {
      observation = await authorized(input, record.intent, attempt ? 'recover' : 'inspect', record.plan.digest, action.id,
        context => attempt ? input.driver.recover({ ...context, action: structuredClone(action), attempt: structuredClone(attempt) })
          : input.driver.inspect({ ...context, action: structuredClone(action) }), record.completed, [], record.attempts);
    } catch (error) { return stop(attempt ? 'pending' : 'blocked', reason(error)); }
    if (observation.state === 'satisfied') {
      const evidence = parseEvidence(observation.evidence, record.intent, input.driver);
      const attempts = record.attempts.map(item => item.id === attempt?.id ? { ...item, status: 'succeeded' as const, updatedAt: new Date().toISOString(), evidence } : item);
      await update({ ...record, status: 'pending', reason: undefined, attempts, completed: { ...record.completed, [action.id]: evidence } });
      continue;
    }
    // A durable success becoming missing/unknown is drift, never permission to recreate.
    if (Object.hasOwn(record.completed, action.id)) {
      const completed = { ...record.completed }; delete completed[action.id];
      await update({ ...record, completed, status: 'blocked', reason: 'identity_mismatch' });
      return record;
    }
    if (attempt && attempt.status !== 'rejected') {
      if (observation.state === 'rejected') {
        const rejectionReason = observation.reason;
        await update({ ...record, attempts: record.attempts.map(item => item.id === attempt!.id ? { ...item, status: 'rejected' as const,
          updatedAt: new Date().toISOString(), reason: rejectionReason } : item), status: 'blocked', reason: rejectionReason });
      } else return stop(observation.state === 'conflict' ? 'blocked' : 'pending', 'reason' in observation ? observation.reason : 'not_converged');
      // A newly proven rejection is returned for a separately authorized retry.
      return record;
    }
    if (attempt?.status === 'rejected') {
      if (readOnly || !input.retryActions?.some(retry => retry.actionId === action.id && retry.attemptId === attempt!.id))
        return stop('blocked', 'retry_confirmation_required');
      // A rejected operation has definite no effect; fresh observation still has to authorize its retry.
      try { observation = await authorized(input, record.intent, 'inspect', record.plan.digest, action.id,
        context => input.driver.inspect({ ...context, action: structuredClone(action) }), record.completed, [], record.attempts); }
      catch (error) { return stop('blocked', reason(error)); }
    }
    if (readOnly || action.type === 'noop' || observation.state !== 'action-required')
      return stop('blocked', 'reason' in observation ? observation.reason : 'not_installed');
    const timestamp = new Date().toISOString();
    attempt = { id: randomUUID(), actionId: action.id, status: 'attempted', startedAt: timestamp, updatedAt: timestamp };
    await update({ ...record, status: 'pending', reason: undefined, attempts: [...record.attempts, attempt] });
    let dispatched = false;
    let writeAuthorized = false;
    const attemptedRevision = record.revision;
    const attemptedRecord = record;
    let mutation: CloudInstallationMutation;
    try {
      mutation = await authorized(input, record.intent, 'mutate', record.plan.digest, action.id, context => {
        dispatched = true;
        return input.driver.mutate({ ...context, action: structuredClone(action), attempt: structuredClone(attempt!),
          beforeMutation: async () => {
            await authorized({ ...input, signal: context.signal }, attemptedRecord.intent, 'mutate', attemptedRecord.plan.digest, action.id, async () => {
              const current = await read(input, attemptedRecord.installationId);
              const currentAttempt = current?.attempts.filter(item => item.actionId === action.id).at(-1);
              if (!current || current.revision !== attemptedRevision || currentAttempt?.id !== attempt!.id || currentAttempt.status !== 'attempted')
                throw new CloudInstallationError('store_conflict');
              writeAuthorized = true;
            }, attemptedRecord.completed, [], attemptedRecord.attempts);
          } });
      }, record.completed, [], record.attempts);
    } catch (error) { mutation = { state: dispatched && writeAuthorized ? 'uncertain' as const : 'rejected' as const, reason: reason(error) }; }
    if (['acknowledged', 'external'].includes(mutation.state) && !writeAuthorized)
      mutation = { state: 'uncertain', reason: 'provider_error' };
    const nextAttempt = { ...attempt, updatedAt: new Date().toISOString() };
    if (mutation.state === 'acknowledged') {
      nextAttempt.status = 'acknowledged';
      if (mutation.evidence) nextAttempt.evidence = parseEvidence(mutation.evidence, record.intent, input.driver);
    } else if (mutation.state === 'external') {
      const externalUrl = mutation.url;
      const url = contract(() => {
        const parsed = new URL(externalUrl);
        if (action.metadata.execution !== 'external' || parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
        return parsed.toString();
      });
      nextAttempt.status = 'pending'; nextAttempt.externalUrl = url;
    } else { nextAttempt.status = mutation.state; const mutationReason = mutation.reason; nextAttempt.reason = contract(() => reasonSchema.parse(mutationReason)); }
    await update({ ...record, attempts: record.attempts.map(item => item.id === nextAttempt.id ? nextAttempt : item),
      status: nextAttempt.status === 'rejected' ? 'blocked' : 'pending', reason: nextAttempt.reason });
    if (mutation.state !== 'acknowledged') return record;
    try { observation = await authorized(input, record.intent, 'recover', record.plan.digest, action.id,
      context => input.driver.recover({ ...context, action: structuredClone(action), attempt: structuredClone(nextAttempt) }), record.completed, [], record.attempts); }
    catch (error) { return stop('pending', reason(error)); }
    if (observation.state !== 'satisfied') return stop(observation.state === 'conflict' ? 'blocked' : 'pending', 'reason' in observation ? observation.reason : 'not_converged');
    const evidence = parseEvidence(observation.evidence, record.intent, input.driver);
    await update({ ...record, attempts: record.attempts.map(item => item.id === nextAttempt.id ? { ...item, status: 'succeeded' as const, evidence,
      updatedAt: new Date().toISOString() } : item), completed: { ...record.completed, [action.id]: evidence }, reason: undefined });
  }
  if (record.plan.blockedReason) return stop('blocked', record.plan.blockedReason);
  if (ordered.some(action => !record!.completed[action.id])) return update({ ...record, status: 'pending', reason: undefined });
  return update({ ...record, status: record.intent.mode === 'disconnect' ? 'disconnected' : record.intent.stage === 'scope-preparation' ? 'scope-ready' : 'ready', reason: undefined });
}
export function applyCloudInstallationV1<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(input: CloudInstallationApplyInput<I>): Promise<CloudInstallationRecord<I>> { return execute(input, false); }
export function reconcileCloudInstallationV1<I extends CloudInstallationExecutableIntent = CloudInstallationIntent>(input: CloudInstallationContext<I> & { installationId: string; planDigest: string; onlyActionId?: string }): Promise<CloudInstallationRecord<I>> {
  return execute({ ...input, confirmActions: [] }, true);
}

/** Re-observe the prepared scope, then persist separately reviewed collection or deployment access. */
export async function planCloudInstallationContinuationV1(input: CloudInstallationContext & {
  scopePreparationId: string; scopePreparationDigest: string; installationId: string;
  /** Exact independently read source; required to derive final deployment topology. */
  spec?: ProjectSpec;
}): Promise<CloudInstallationRecord> {
  if (input.driver.localScopePreparation || input.driver.artifactPublication) throw new CloudInstallationError('unsupported');
  if (input.installationId === input.scopePreparationId) throw new CloudInstallationError('scope_mismatch');
  const previous = await reconcileCloudInstallationV1({ ...input, installationId: input.scopePreparationId, planDigest: input.scopePreparationDigest });
  const nativeScope = cloudInstallationResolvedScopeV1(previous, input.driver);
  const stage = cloudInstallationNextStageV1(previous, input.driver);
  const intent: CloudInstallationIntent = { ...previous.intent, installationId: input.installationId, stage, nativeScope,
    scopePreparation: { installationId: previous.installationId, planDigest: previous.plan.digest } };
  if (stage === 'deployment') {
    if (!input.spec || !input.driver.deployment?.prepareIntent) throw new CloudInstallationError('invalid_contract');
    intent.deployment = contract(() => input.driver.deployment!.prepareIntent!(input.spec!, intent));
  }
  return planCloudInstallationV1({ ...input, intent });
}

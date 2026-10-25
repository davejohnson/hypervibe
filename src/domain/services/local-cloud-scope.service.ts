import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudScopePreparationRepository, acceptedJournalLeaf } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getDb } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { environmentConnectionScope } from './project-scope.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { normalizeGitRemoteIdentity } from '../../lib/git-remote.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { CloudInstallationContext, CloudInstallationRecord, CloudInstallationReview, LocalCloudScopePreparationIntent } from '../ports/cloud-installation.port.js';
import { isLocalCloudScopeAction, LOCAL_CLOUD_SCOPE_OPERATION, localCloudScopeActionMetadataSchema,
  localCloudScopePlanSchema, type LocalCloudScopePlan } from '../ports/local-cloud-scope.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { SpecStore, type SpecResult } from '../spec/spec.store.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from './cloud-installation-runtime.js';

type Record = CloudInstallationRecord<LocalCloudScopePreparationIntent>;
const routingSchema = z.object({ intent: z.object({ hostingProvider: z.string().min(1).max(100) }).passthrough() }).passthrough();
const unavailable = () => new Error('Cloud scope preparation could not be verified. Preserve its saved plan and operation history; no replacement or hosting deployment is authorized.');
const active = (record: Record) => record.attempts.length > 0 || Object.keys(record.completed).length > 0;
const acceptedLeaf = acceptedJournalLeaf<Record>;

function parseRecord(value: unknown): Record {
  const provider = routingSchema.parse(value).intent.hostingProvider;
  const capability = providerRegistry.getLocalScopePreparation(provider);
  if (!capability || capability.schemaVersion !== 1) throw unavailable();
  const record = capability.parseRecord(value);
  if (record.intent.hostingProvider !== provider) throw unavailable();
  return record;
}
function repository(project: Project, result: SpecResult): string {
  const identity = normalizeGitRemoteIdentity(result.spec.gitRemoteUrl ?? project.gitRemoteUrl ?? undefined);
  if (!identity) throw new Error('Declare the exact application repository before allocating a cloud project.');
  return identity;
}
function source(project: Project, result: SpecResult): LocalCloudScopePreparationIntent['source'] {
  return { kind: 'local-spec', repository: repository(project, result), specRevision: result.revision, specDigest: canonicalJsonSha256(result.spec) };
}
function journal(project: Project, environment: Environment) {
  return new CloudScopePreparationRepository<Record>({ projectId: project.id, environmentId: environment.id, environmentName: environment.name }, parseRecord, {
    allowHistoricalPredecessor(parent, next) {
      const continuation = providerRegistry.getLocalScopePreparation(next.intent.hostingProvider)?.continuation;
      return Boolean(continuation?.permitsBoundCleanup?.(next.intent.nativeScope) && next.intent.selection
        && parent.intent.hostingProvider === next.intent.hostingProvider
        && isDeepStrictEqual(continuation.nextScope(parent, next.intent.selection), next.intent.nativeScope));
    },
  });
}
function exactEnvironment(project: Project, environment: Environment): boolean {
  const row = new EnvironmentRepository().findById(environment.id);
  return Boolean(new ProjectRepository().findById(project.id) && row && row.projectId === project.id && row.name === environment.name);
}
function sameCurrentSource(project: Project, environment: Environment, intent: LocalCloudScopePreparationIntent): boolean {
  try {
    const currentProject = new ProjectRepository().findById(project.id);
    const current = currentProject ? new SpecStore().getForInspection(currentProject) : null;
    const declaration = current?.spec.environments[environment.name]?.hosting;
    if (!currentProject || !current || !declaration?.scopePreparation || declaration.provider !== intent.hostingProvider
      || !isDeepStrictEqual(source(currentProject, current), intent.source)) return false;
    const capability = providerRegistry.getLocalScopePreparation(declaration.provider);
    return Boolean(capability && (intent.predecessor
      ? declaration.scopePreparation.continuation && isDeepStrictEqual(capability.continuation?.parseSelection(declaration.scopePreparation.continuation.nativeScope, declaration), intent.selection)
      : isDeepStrictEqual(capability.parseScope(declaration.scopePreparation.nativeScope), intent.nativeScope)));
  } catch { return false; }
}
function emptyLocalScope(environment: Environment): boolean {
  const current = new EnvironmentRepository().findById(environment.id);
  return Boolean(current && Object.keys(current.platformBindings).every(key => key === 'provider'));
}
async function context(project: Project, environment: Environment, intent: LocalCloudScopePreparationIntent,
  mode: 'allocate' | 'recover', authorize?: () => boolean,
  prepared?: Pick<CloudInstallationContext<LocalCloudScopePreparationIntent>, 'driver' | 'authentication'>): Promise<CloudInstallationContext<LocalCloudScopePreparationIntent>> {
  const capability = providerRegistry.getLocalScopePreparation(intent.hostingProvider);
  if (!capability || intent.appId !== project.id || intent.customerId !== project.id || intent.environment !== environment.name) throw unavailable();
  const execution = prepared ?? await capability.create(intent.nativeScope);
  return { ...execution, store: journal(project, environment), authorize: async input => {
    if (!exactEnvironment(project, environment) || !isDeepStrictEqual(input.intent, intent) || authorize && !authorize()) return false;
    if (input.phase === 'mutate' && (mode !== 'allocate' || !emptyLocalScope(environment) && !capability.continuation?.permitsBoundCleanup?.(intent.nativeScope))) return false;
    if (!(mode === 'recover' ? input.phase !== 'mutate' : sameCurrentSource(project, environment, intent))) return false;
    if (intent.predecessor) {
      const previous = await journal(project, environment).read(intent.predecessor.installationId);
      if (!previous || previous.plan.digest !== intent.predecessor.planDigest || previous.intent.hostingProvider !== intent.hostingProvider
        || previous.intent.source.repository !== intent.source.repository || !capability.continuation || !intent.selection) return false;
      // Revoking trust must not require that the same trust remain installed.
      // The cleanup driver independently re-observes all native identity lifetimes;
      // only immutable predecessor receipts authorize its exact removal targets.
      const cleanup = capability.continuation.permitsBoundCleanup?.(intent.nativeScope) === true;
      const verified = cleanup ? previous : await reconcileCloudInstallationV1({
        ...await context(project, environment, previous.intent, 'recover', authorize), installationId: previous.installationId, planDigest: previous.plan.digest });
      if (!cleanup && verified.status !== 'scope-ready' || !isDeepStrictEqual(capability.continuation.nextScope(verified, intent.selection), intent.nativeScope)) return false;
    }
    return true;
  } };
}
function projection(record: Record, mode: LocalCloudScopePlan['mode']): { cloudScope: LocalCloudScopePlan; actions: PlanAction[] } {
  const cloudScope: LocalCloudScopePlan = { schemaVersion: 1, installationId: record.installationId,
    installationPlanDigest: record.plan.digest, hostingProvider: record.intent.hostingProvider, mode };
  const originals: PlanAction[] = mode === 'bind' ? [{ id: 'cloud-scope:bind', type: 'update',
    resource: { kind: 'project', name: record.intent.nativeScope.projectId, provider: record.intent.provider },
    verified: true, requiresConfirm: true,
    reason: 'Record nonsecret local-default connections for this exact application/environment and bind its verified cloud project; grant no cloud permissions.' }] : mode === 'recover' && record.intent.predecessor
      ? record.plan.actions.filter(action => record.attempts.some(attempt => attempt.actionId === action.id)) : record.plan.actions;
  const actions: PlanAction[] = mode === 'verified' ? [] : originals.map(original => ({ ...original,
    ...(mode === 'recover' ? { type: 'update' as const, requiresConfirm: false, billable: false, dataBearing: false,
      reason: 'Read only the exact retained preparation and native operation; never repeat an uncertain mutation or adopt a replacement.' }
      : mode === 'allocate' && record.completed[original.id] ? { type: 'noop' as const, requiresConfirm: false, billable: false, dataBearing: false } : {}),
    metadata: { ...cloudScope, operation: LOCAL_CLOUD_SCOPE_OPERATION, nativeActionId: original.id } }));
  return { cloudScope, actions };
}
function binding(project: Project, environment: Environment, record: Record) {
  const capability = providerRegistry.getLocalScopePreparation(record.intent.hostingProvider);
  const current = new SpecStore().getForInspection(project);
  if (!capability?.continuation || !current || !sameCurrentSource(project, environment, record.intent)) throw unavailable();
  const selected = capability.continuation.binding(record, current.spec.environments[environment.name].hosting);
  const scope = environmentConnectionScope(record.intent.source.repository, environment.name);
  return { ...selected, scope };
}
function isBound(project: Project, environment: Environment, record: Record): boolean {
  if (record.status !== 'scope-ready' || !record.intent.predecessor) return false;
  try {
    const current = new SpecStore().getForInspection(project); const desired = current?.spec.environments[environment.name]?.hosting;
    const capability = providerRegistry.getLocalScopePreparation(record.intent.hostingProvider);
    const actual = new EnvironmentRepository().findById(environment.id)?.platformBindings;
    if (!current || !desired || desired.provider !== record.intent.hostingProvider || !actual || !capability?.continuation
      || repository(project, current) !== record.intent.source.repository
      || desired.scopePreparation && (desired.scopePreparation.nativeScope.projectId !== record.intent.nativeScope.projectId
        || !desired.scopePreparation.continuation || !isDeepStrictEqual(capability.continuation.parseSelection(desired.scopePreparation.continuation.nativeScope, desired), record.intent.selection))) return false;
    // Accepted connection/binding identity survives subsequent ordinary deployment
    // source edits. New desired placement belongs to the normal hosting lifecycle.
    const expected = capability.continuation.binding(record, { region: typeof actual.environmentId === 'string' ? actual.environmentId : undefined });
    const scope = environmentConnectionScope(record.intent.source.repository, environment.name);
    return Object.entries(expected.platformBindings).every(([key, value]) => isDeepStrictEqual(actual[key], value))
      && (expected.removeBindings ?? []).every(item => !Object.hasOwn(actual, item.key))
      && expected.connections.every(item => {
        const existing = new ConnectionRepository().findByProviderAndScope(item.provider, scope);
        return existing?.status === 'verified' && isDeepStrictEqual(getSecretStore().decryptObject(existing.credentialsEncrypted), item.config);
      });
  } catch { return false; }
}

function bindLocalScope(project: Project, environment: Environment, record: Record, authorize: () => boolean): void {
  const expected = binding(project, environment, record); const connections = new ConnectionRepository(); const secrets = getSecretStore();
  getDb().transaction(() => {
    if (!authorize() || !sameCurrentSource(project, environment, record.intent)) throw unavailable();
    if (expected.removeBindings?.length) {
      const current = new EnvironmentRepository().findById(environment.id);
      if (!current || !Object.entries(expected.platformBindings).every(([key, value]) => isDeepStrictEqual(current.platformBindings[key], value))) throw unavailable();
      const next = { ...current.platformBindings };
      for (const item of expected.removeBindings) {
        if (Object.hasOwn(next, item.key) && !isDeepStrictEqual(next[item.key], item.expectedValue)) throw unavailable();
        delete next[item.key];
      }
      if (!new EnvironmentRepository().update(environment.id, { platformBindings: next })) throw unavailable();
      return;
    }
    if (!emptyLocalScope(environment)) throw unavailable();
    const missing = expected.connections.filter(item => {
      const existing = connections.findByProviderAndScope(item.provider, expected.scope);
      if (!existing) return true;
      if (existing.status !== 'verified' || !isDeepStrictEqual(secrets.decryptObject(existing.credentialsEncrypted), item.config)) throw unavailable();
      return false;
    });
    connections.upsertVerifiedBatch(missing.map(item => ({ provider: item.provider, scope: expected.scope, credentialsEncrypted: secrets.encryptObject(item.config) })));
    if (!new EnvironmentRepository().updatePlatformBindings(environment.id, expected.platformBindings)) throw unavailable();
  }).immediate();
}

/** Isolated prerequisite before credential lookup. Creating a local row never creates a cloud resource. */
export async function planLocalCloudScope(input: { project: Project; environmentName: string; specResult: SpecResult;
  options?: object }): Promise<{ cloudScope: LocalCloudScopePlan; environment: Environment; actions: PlanAction[]; review: CloudInstallationReview; warnings: string[] } | undefined> {
  const { project, environmentName, specResult } = input;
  const desired = specResult.spec.environments[environmentName]?.hosting;
  let environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
  if (!environment && !desired?.scopePreparation) return undefined;
  if (!environment) environment = new EnvironmentRepository().create({ projectId: project.id, name: environmentName, platformBindings: { provider: desired!.provider } });
  const history = await journal(project, environment).findByScope();
  let record = acceptedLeaf(history);
  if (!record && !desired?.scopePreparation) return undefined;
  if (input.options && ['serviceFilter', 'envVarOverrides', 'envFile', 'includeEnvFile', 'secretRefs'].some(key => Object.hasOwn(input.options!, key)))
    throw new Error('Cloud project preparation is an isolated plan stage and accepts no deployment or credential-value inputs.');
  const capability = providerRegistry.getLocalScopePreparation(record?.intent.hostingProvider ?? desired!.provider);
  if (!capability) throw unavailable();
  if (record) {
    let cleanupScope: { scope: { [key: string]: string }; selection: { [key: string]: string } } | undefined;
    if (desired?.scopePreparation?.continuation && capability.continuation) {
      const selection = capability.continuation.parseSelection(desired.scopePreparation.continuation.nativeScope, desired);
      try {
        const scope = capability.continuation.nextScope(record, selection);
        if (scope && capability.continuation.permitsBoundCleanup?.(scope)) cleanupScope = { scope, selection };
      } catch { /* Ordinary recovery remains authoritative until the prerequisite is ready. */ }
    }
    if (!cleanupScope) {
      const execution = await context(project, environment, record.intent, 'recover');
      record = await reconcileCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest });
    }
    const allocation = history.find(item => item.installationId === record!.installationId && !item.intent.predecessor)
      ?? history.find(item => active(item) && !item.intent.predecessor);
    if (record.status === 'scope-ready' && desired?.scopePreparation && (!allocation || desired.provider !== record.intent.hostingProvider
      || !isDeepStrictEqual(capability.parseScope(desired.scopePreparation.nativeScope), allocation.intent.nativeScope)))
      throw new Error('This environment already allocated a cloud project. Its accepted identity is retained; editing desired names does not authorize a replacement.');
    if (record.status === 'scope-ready' && !desired?.scopePreparation && !emptyLocalScope(environment)) return undefined;
    if ((record.status === 'scope-ready' || cleanupScope) && desired?.scopePreparation?.continuation) {
      if (!capability.continuation) throw unavailable();
      const selection = capability.continuation.parseSelection(desired.scopePreparation.continuation.nativeScope, desired);
      const nextScope = cleanupScope?.scope ?? capability.continuation.nextScope(record, selection);
      if (nextScope) {
        if (!emptyLocalScope(environment) && !capability.continuation.permitsBoundCleanup?.(nextScope)) throw unavailable();
        const currentSource = source(project, specResult); const predecessor = { installationId: record.installationId, planDigest: record.plan.digest };
        const proposed = history.find(item => !active(item) && isDeepStrictEqual(item.intent.source, currentSource)
          && isDeepStrictEqual(item.intent.predecessor, predecessor) && isDeepStrictEqual(item.intent.nativeScope, nextScope) && isDeepStrictEqual(item.intent.selection, selection));
        if (proposed) record = proposed;
        else {
          const intent: LocalCloudScopePreparationIntent = { ...record.intent, installationId: randomUUID(), source: currentSource, nativeScope: nextScope, predecessor, selection };
          record = await planCloudInstallationV1({ ...await context(project, environment, intent, 'allocate'), intent });
        }
      } else if (isBound(project, environment, record)) return undefined;
      else {
        if (!sameCurrentSource(project, environment, record.intent)) throw new Error('The prepared scope source changed before binding. Retain the accepted preparation and review the exact source before a handoff.');
        const expected = binding(project, environment, record);
        return { ...projection(record, 'bind'), environment, review: { ...record.plan.review,
          resources: [{ kind: 'local-environment-binding', name: environment.name, scope: record.intent.nativeScope.projectId },
            ...expected.connections.map(item => ({ kind: 'local-default-connection', name: item.provider, scope: expected.scope }))],
          permissions: [], costs: [], warnings: ['This local metadata handoff stores no credentials. Runtime identities and CI federation remain separately reviewed.'] },
          warnings: ['Confirm this exact environment binding before ordinary hosting planning. No cloud write occurs in this handoff.'] };
      }
    }
  } else {
    if (!desired?.scopePreparation || !emptyLocalScope(environment)) throw unavailable();
    const nativeScope = capability.parseScope(desired.scopePreparation.nativeScope); const currentSource = source(project, specResult);
    record = history.find(item => !item.intent.predecessor && item.intent.hostingProvider === desired.provider
      && isDeepStrictEqual(item.intent.nativeScope, nativeScope) && isDeepStrictEqual(item.intent.source, currentSource));
    if (!record) {
      const nativeExecution = await capability.create(nativeScope);
      const intent: LocalCloudScopePreparationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id,
        appId: project.id, environment: environmentName, source: currentSource, provider: nativeExecution.driver.provider, hostingProvider: desired.provider,
        execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, mode: 'connect', stage: 'scope-preparation', keys: [], nativeScope };
      record = await planCloudInstallationV1({ ...await context(project, environment, intent, 'allocate', undefined, nativeExecution), intent });
    }
  }
  if (record.plan.blockedReason && !record.attempts.length) throw unavailable();
  const mode = record.status === 'scope-ready' ? 'verified' : record.intent.predecessor
    ? record.attempts.some(attempt => !record!.completed[attempt.actionId]) ? 'recover'
      : record.plan.actions.some(action => !record!.completed[action.id]) ? 'allocate' : 'recover'
    : record.attempts.length ? 'recover' : 'allocate';
  // Preserve the approved plan while distinguishing its observations from the
  // current reconciliation result on both public warning surfaces.
  const review = mode === 'allocate' ? record.plan.review : { ...record.plan.review,
    warnings: record.plan.review.warnings.map(warning => `Historical approval review: ${warning}`) };
  return { ...projection(record, mode), environment, review, warnings: [
    ...review.warnings,
    ...record.plan.review.costs.map(item => item.description),
    record.intent.predecessor ? 'Only this retained preparation stage is authorized; later API, identity, binding or hosting stages need their own current plan.'
      : 'This stage allocates an empty cloud project only. Billing, API enablement, cloud connections and hosting are separate reviewed work.',
    'An allocated but unbound project remains in this isolated stage until a separate reviewed lifecycle handoff records its connection and binding; removing this declaration does not adopt it.',
    ...(record.reason ? [`The retained allocation reports ${record.reason}; recovery never repeats a creation request.`] : []),
  ] };
}

/** Pure local prerequisite detection; it neither adopts spec edits nor calls a provider. */
export async function localCloudScopeRequired(project: Project, environmentName: string, spec?: ProjectSpec): Promise<boolean> {
  if (spec?.environments[environmentName]?.hosting.scopePreparation) {
    const existing = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
    const leaf = existing && acceptedLeaf(await journal(project, existing).findByScope());
    return !existing || !leaf || !isBound(project, existing, leaf);
  }
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
  if (!environment) return false;
  return (await journal(project, environment).findByScope()).some(record => record.attempts.length > 0
    && (record.status !== 'scope-ready' || emptyLocalScope(environment)));
}

/** Historical operation status is read-only at the cloud boundary, even after source edits. */
export async function inspectLocalCloudScope(project: Project, environmentName: string) {
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
  if (!environment) return undefined;
  const history = await journal(project, environment).findByScope();
  let record = acceptedLeaf(history) ?? history.at(-1);
  if (!record) return undefined;
  if (record.status === 'scope-ready' && !emptyLocalScope(environment)) return undefined;
  if (record.attempts.length) {
    const execution = await context(project, environment, record.intent, 'recover');
    record = await reconcileCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest });
  }
  return { scope: 'cloud-scope' as const, environment: environmentName, installationId: record.installationId,
    status: record.status, verified: record.status === 'scope-ready', allocationComplete: record.status === 'scope-ready', hostingReady: false,
    resources: Object.values(record.completed).flatMap(value => value.resources), ...(record.reason ? { reason: record.reason } : {}) };
}

export async function applyLocalCloudScope(input: { project: Project; environment: Environment; cloudScope: unknown;
  action?: PlanAction; authorize: () => boolean }): Promise<ActionResult> {
  try {
    const proof = localCloudScopePlanSchema.parse(input.cloudScope);
    const record = await journal(input.project, input.environment).read(proof.installationId);
    if (!record || record.plan.digest !== proof.installationPlanDigest || record.intent.hostingProvider !== proof.hostingProvider) throw unavailable();
    const expected = projection(record, proof.mode);
    if (input.action ? !isLocalCloudScopeAction(input.action) || !expected.actions.some(action => isDeepStrictEqual(input.action, action)) : proof.mode !== 'verified') throw unavailable();
    if (input.action) localCloudScopeActionMetadataSchema.parse(input.action.metadata);
    const readOnly = proof.mode !== 'allocate' || (record.intent.predecessor
      ? record.attempts.some(attempt => attempt.actionId === input.action?.id) : record.attempts.length > 0);
    const execution = await context(input.project, input.environment, record.intent, readOnly ? 'recover' : 'allocate', input.authorize);
    const updated = readOnly
      ? await reconcileCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest,
        ...(record.intent.predecessor && input.action && proof.mode !== 'bind' ? { onlyActionId: input.action.id } : {}) })
      : await applyCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [input.action!.id],
        ...(record.intent.predecessor ? { onlyActionId: input.action!.id } : {}) });
    if (proof.mode === 'bind' && updated.status === 'scope-ready') bindLocalScope(input.project, input.environment, updated, input.authorize);
    const complete = updated.status === 'scope-ready' || ['allocate', 'recover'].includes(proof.mode) && updated.status === 'pending' && !updated.reason && Boolean(updated.completed[input.action!.id]);
    return { success: complete, ...(complete ? {} : { status: updated.status === 'pending' ? 'pending' as const : 'blocked' as const }),
      message: complete ? proof.mode === 'bind' ? 'Bound the exact verified cloud project and nonsecret local connections to this application environment.'
        : updated.intent.predecessor ? 'Verified this exact preparation action. Later stages require a separate current plan.'
        : 'Verified the exact empty project allocation. Billing and hosting have not been configured.'
        : 'The project allocation is unresolved. Retain its exact native operation for read-only recovery; no replacement was authorized.',
      data: { installationId: updated.installationId, status: updated.status, ...(updated.reason ? { reason: updated.reason } : {}),
        resources: Object.values(updated.completed).flatMap(value => value.resources) } };
  } catch { return { success: false, status: 'blocked', message: unavailable().message }; }
}

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
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from './cloud-installation-runtime.js';

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
      return Boolean(continuation?.boundContinuationKind?.(next.intent.nativeScope) === 'cleanup' && next.intent.selection
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
    if (input.phase === 'mutate' && (mode !== 'allocate' || !emptyLocalScope(environment) && !capability.continuation?.boundContinuationKind?.(intent.nativeScope))) return false;
    if (!(mode === 'recover' ? input.phase !== 'mutate' : sameCurrentSource(project, environment, intent))) return false;
    if (intent.predecessor) {
      const previous = await journal(project, environment).read(intent.predecessor.installationId);
      if (!previous || previous.plan.digest !== intent.predecessor.planDigest || previous.intent.hostingProvider !== intent.hostingProvider
        || previous.intent.source.repository !== intent.source.repository || !capability.continuation || !intent.selection) return false;
      // Revoking trust must not require that the same trust remain installed.
      // The cleanup driver independently re-observes all native identity lifetimes;
      // only immutable predecessor receipts authorize its exact removal targets.
      const kind = capability.continuation.boundContinuationKind?.(intent.nativeScope);
      let history = await journal(project, environment).findByScope();
      const retained = history.find(record => record.installationId === intent.installationId);
      // Initial prerequisite installation must not depend on the API it enables.
      // Once that exact installation completed, a transient ancestor read failure
      // may be recovered without granting mutation authority or changing bindings.
      const recoverPrerequisiteParent = kind === 'prerequisite' && mode === 'recover' && input.phase !== 'mutate'
        && previous.status !== 'scope-ready' && retained && isDeepStrictEqual(retained.intent, intent)
        && retained.plan.actions.length > 0 && retained.plan.actions.every(action => retained.completed[action.id]);
      const verified = kind && kind !== 'addition' && !recoverPrerequisiteParent ? previous : await reconcileCloudInstallationV1({
        ...await context(project, environment, previous.intent, 'recover', authorize), installationId: previous.installationId, planDigest: previous.plan.digest });
      if (recoverPrerequisiteParent) history = await journal(project, environment).findByScope();
      if (kind === 'prerequisite' && !retainedBindingMatches(project, environment, verified, history)) return false;
      if (kind === 'addition' && !emptyLocalScope(environment)) {
        // A denied native read must not make the retained operation impossible
        // to inspect. Read-only recovery cannot write or commit a binding;
        // fresh mutations and the final handoff still reject conflicting keys.
        const valid = mode === 'recover' && input.phase !== 'mutate'
          ? retainedBindingMatches(project, environment, verified, history, true)
          : additiveBindingSelection(project, environment, verified, history, intent.nativeScope, retained);
        if (!valid) return false;
      }
      if (!kind && verified.status !== 'scope-ready' || !isDeepStrictEqual(capability.continuation.nextScope(verified, intent.selection, history), intent.nativeScope)) return false;
    }
    return true;
  } };
}
function projection(record: Record, mode: LocalCloudScopePlan['mode'], retryActions?: LocalCloudScopePlan['retryActions']): { cloudScope: LocalCloudScopePlan; actions: PlanAction[] } {
  const cloudScope: LocalCloudScopePlan = { schemaVersion: 1, installationId: record.installationId,
    installationPlanDigest: record.plan.digest, hostingProvider: record.intent.hostingProvider, mode, ...(retryActions ? { retryActions } : {}) };
  let originals: PlanAction[] = mode === 'normalize' ? [{ id: 'cloud-scope:normalize', type: 'update',
    resource: { kind: 'project', name: record.intent.nativeScope.projectId, provider: record.intent.provider },
    verified: true, requiresConfirm: true,
    reason: 'Restore only missing nonsecret ownership metadata from the verified original installation journal; preserve cloud resources, connections and existing bindings.' }]
    : mode === 'bind' ? [{ id: 'cloud-scope:bind', type: 'update',
    resource: { kind: 'project', name: record.intent.nativeScope.projectId, provider: record.intent.provider },
    verified: true, requiresConfirm: true,
    reason: 'Record nonsecret local-default connections for this exact application/environment and bind its verified cloud project; grant no cloud permissions.' }] : mode === 'recover' && record.intent.predecessor
      ? record.plan.actions.filter(action => record.attempts.some(attempt => attempt.actionId === action.id)) : record.plan.actions;
  if (retryActions) {
    // Retry only the reviewed rejected action. Its completed dependency closure
    // remains explicit noop evidence; later work belongs to the next plan.
    const included = new Set(retryActions.map(retry => retry.actionId));
    for (const id of included) {
      const action = record.plan.actions.find(action => action.id === id);
      if (!action) throw unavailable();
      for (const dependency of action.dependsOn ?? []) {
        if (!record.completed[dependency]) throw unavailable();
        included.add(dependency);
      }
    }
    originals = originals.filter(action => included.has(action.id));
  }
  const actions: PlanAction[] = mode === 'verified' ? [] : originals.map(original => ({ ...original,
    ...(retryActions?.some(retry => retry.actionId === original.id)
      ? { reason: `Retry the rejected attempt ${retryActions.find(retry => retry.actionId === original.id)!.attemptId}. ${original.reason}` } : {}),
    ...(mode === 'recover' ? { type: 'update' as const, requiresConfirm: false, billable: false, dataBearing: false,
      reason: 'Read only the exact retained preparation and native operation; never repeat an uncertain mutation or adopt a replacement.' }
      : mode === 'allocate' && record.completed[original.id] ? { type: 'noop' as const, requiresConfirm: false, billable: false, dataBearing: false } : {}),
    metadata: { ...cloudScope, operation: LOCAL_CLOUD_SCOPE_OPERATION, nativeActionId: original.id } }));
  return { cloudScope, actions };
}
async function binding(project: Project, environment: Environment, record: Record) {
  const capability = providerRegistry.getLocalScopePreparation(record.intent.hostingProvider);
  const current = new SpecStore().getForInspection(project);
  if (!capability?.continuation || !current || !sameCurrentSource(project, environment, record.intent)) throw unavailable();
  const selected = capability.continuation.binding(record, current.spec.environments[environment.name].hosting, await journal(project, environment).findByScope());
  const scope = environmentConnectionScope(record.intent.source.repository, environment.name);
  return { ...selected, scope };
}
async function acceptedBinding(project: Project, environment: Environment, record: Record) {
  if (record.status !== 'scope-ready' || !record.intent.predecessor || emptyLocalScope(environment)) return undefined;
  const current = new SpecStore().getForInspection(project); const desired = current?.spec.environments[environment.name]?.hosting;
  const capability = providerRegistry.getLocalScopePreparation(record.intent.hostingProvider);
  const actual = new EnvironmentRepository().findById(environment.id)?.platformBindings;
  if (!current || !desired || desired.provider !== record.intent.hostingProvider || !actual || !capability?.continuation
    || repository(project, current) !== record.intent.source.repository
    || desired.scopePreparation && (desired.scopePreparation.nativeScope.projectId !== record.intent.nativeScope.projectId
      || !desired.scopePreparation.continuation || !isDeepStrictEqual(capability.continuation.parseSelection(desired.scopePreparation.continuation.nativeScope, desired), record.intent.selection))) return undefined;
  // Accepted connection/binding identity survives subsequent ordinary deployment
  // source edits. New desired placement belongs to the normal hosting lifecycle.
  const expected = capability.continuation.binding(record, { region: typeof actual.environmentId === 'string' ? actual.environmentId : undefined }, await journal(project, environment).findByScope());
  const scope = environmentConnectionScope(record.intent.source.repository, environment.name);
  return { expected, actual, scope, repairable: capability.continuation.repairableProviderScopeFields ?? [] };
}
function connectionsMatch(selected: NonNullable<Awaited<ReturnType<typeof acceptedBinding>>>): boolean {
  return selected.expected.connections.every(item => {
    const existing = new ConnectionRepository().findByProviderAndScope(item.provider, selected.scope);
    return existing?.status === 'verified' && isDeepStrictEqual(getSecretStore().decryptObject(existing.credentialsEncrypted), item.config);
  });
}
/** A bootstrap prerequisite may not borrow a same-named or partially repaired binding. */
function retainedBindingMatches(project: Project, environment: Environment, record: Record, history: Record[], readOnlyRepair = false): boolean {
  try {
    const current = new EnvironmentRepository().findById(environment.id);
    const continuation = providerRegistry.getLocalScopePreparation(record.intent.hostingProvider)?.continuation;
    if (!current || current.projectId !== project.id || current.name !== environment.name || record.status !== 'scope-ready' || !continuation) return false;
    const expected = continuation.binding(record, { region: typeof current.platformBindings.environmentId === 'string' ? current.platformBindings.environmentId : undefined }, history);
    const selected = { expected, actual: current.platformBindings, scope: environmentConnectionScope(record.intent.source.repository, environment.name), repairable: [] };
    return Object.entries(expected.platformBindings).every(([key, value]) => {
      if (isDeepStrictEqual(current.platformBindings[key], value)) return true;
      // Preserve the existing reviewed normalization path. Only absent,
      // provider-declared metadata may differ during independent native reads.
      if (!readOnlyRepair || key !== 'providerScope') return false;
      const shape = z.record(z.string(), z.unknown()), actual = shape.safeParse(current.platformBindings[key]), desired = shape.safeParse(value);
      return actual.success && desired.success
        && Object.entries(actual.data).every(([field, item]) => Object.hasOwn(desired.data, field) && isDeepStrictEqual(item, desired.data[field]))
        && Object.keys(desired.data).every(field => Object.hasOwn(actual.data, field) || continuation.repairableProviderScopeFields?.includes(field));
    })
      && (expected.removeBindings ?? []).every(item => !Object.hasOwn(current.platformBindings, item.key)) && connectionsMatch(selected);
  } catch { return false; }
}
/** Existing deployments may add only the provider's declared public identity keys. */
function additiveBindingSelection(project: Project, environment: Environment, predecessor: Record, history: Record[],
  nativeScope: { [key: string]: string }, completed?: Record) {
  try {
    const continuation = providerRegistry.getLocalScopePreparation(predecessor.intent.hostingProvider)?.continuation;
    const current = new EnvironmentRepository().findById(environment.id);
    if (!continuation || !current || continuation.boundContinuationKind?.(nativeScope) !== 'addition'
      || !retainedBindingMatches(project, environment, predecessor, history)) return undefined;
    const keys = continuation.additiveBindingKeys?.(nativeScope);
    const previous = continuation.binding(predecessor, { region: String(current.platformBindings.environmentId) }, history);
    if (!keys?.length || new Set(keys).size !== keys.length || keys.some(key => !key || ['__proto__', 'constructor', 'prototype'].includes(key)
      || Object.hasOwn(previous.platformBindings, key)) || previous.removeBindings?.length) return undefined;
    const expected = completed?.status === 'scope-ready'
      ? continuation.binding(completed, { region: String(current.platformBindings.environmentId) }, history) : undefined;
    if (expected && (expected.removeBindings?.length || !isDeepStrictEqual(expected.connections, previous.connections)
      || !isDeepStrictEqual(Object.fromEntries(Object.entries(expected.platformBindings).filter(([key]) => !keys.includes(key))), previous.platformBindings)
      || keys.some(key => !Object.hasOwn(expected.platformBindings, key)))) return undefined;
    if (keys.some(key => Object.hasOwn(current.platformBindings, key)
      && (!expected || !isDeepStrictEqual(current.platformBindings[key], expected.platformBindings[key])))) return undefined;
    return { keys, current: current.platformBindings, expected };
  } catch { return undefined; }
}
async function isBound(project: Project, environment: Environment, record: Record): Promise<boolean> {
  try {
    const selected = await acceptedBinding(project, environment, record);
    return Boolean(selected && Object.entries(selected.expected.platformBindings).every(([key, value]) => isDeepStrictEqual(selected.actual[key], value))
      && (selected.expected.removeBindings ?? []).every(item => !Object.hasOwn(selected.actual, item.key)) && connectionsMatch(selected));
  } catch { return false; }
}
async function bindingNormalization(project: Project, environment: Environment, record: Record) {
  const selected = await acceptedBinding(project, environment, record);
  if (!selected || !selected.repairable.length || !connectionsMatch(selected)
    || selected.expected.removeBindings?.some(item => Object.hasOwn(selected.actual, item.key) && !isDeepStrictEqual(selected.actual[item.key], item.expectedValue))
    || Object.entries(selected.expected.platformBindings).some(([key, value]) => key !== 'providerScope' && !isDeepStrictEqual(selected.actual[key], value))) return undefined;
  const shape = z.record(z.string(), z.unknown());
  const actual = shape.safeParse(selected.actual.providerScope), expected = shape.safeParse(selected.expected.platformBindings.providerScope);
  if (!actual.success || !expected.success) return undefined;
  const missing = Object.keys(expected.data).filter(key => !Object.hasOwn(actual.data, key));
  if (!missing.length || missing.some(key => !selected.repairable.includes(key))
    || Object.entries(actual.data).some(([key, value]) => !Object.hasOwn(expected.data, key) || !isDeepStrictEqual(expected.data[key], value))) return undefined;
  return { ...selected.actual, providerScope: { ...actual.data, ...Object.fromEntries(missing.map(key => [key, expected.data[key]])) } };
}
async function verifyBindingPrerequisites(project: Project, environment: Environment, record: Record): Promise<void> {
  const capability = providerRegistry.getLocalScopePreparation(record.intent.hostingProvider)?.continuation;
  if (!capability?.bindingPrerequisiteIds) return;
  const history = await journal(project, environment).findByScope();
  const ids = capability.bindingPrerequisiteIds(record, history);
  if (ids.length > 20 || new Set(ids).size !== ids.length) throw unavailable();
  const ancestors = new Set<string>(); let cursor = record;
  while (cursor.intent.predecessor) {
    const prior = history.filter(item => item.installationId === cursor.intent.predecessor!.installationId);
    if (prior.length !== 1 || prior[0].plan.digest !== cursor.intent.predecessor.planDigest || ancestors.has(prior[0].installationId) || ancestors.size >= 20) throw unavailable();
    cursor = prior[0]; ancestors.add(cursor.installationId);
  }
  for (const id of ids) {
    const ancestor = history.find(item => item.installationId === id);
    if (!ancestor || !ancestors.has(id)) throw unavailable();
    const verified = await reconcileCloudInstallationV1({ ...await context(project, environment, ancestor.intent, 'recover'),
      installationId: id, planDigest: ancestor.plan.digest });
    if (verified.status !== 'scope-ready') throw unavailable();
  }
}

async function bindLocalScope(project: Project, environment: Environment, record: Record, authorize: () => boolean): Promise<void> {
  const expected = await binding(project, environment, record); const connections = new ConnectionRepository(); const secrets = getSecretStore();
  const continuation = providerRegistry.getLocalScopePreparation(record.intent.hostingProvider)?.continuation;
  const history = await journal(project, environment).findByScope();
  const predecessor = history.find(item => item.installationId === record.intent.predecessor?.installationId
    && item.plan.digest === record.intent.predecessor.planDigest);
  const additive = !emptyLocalScope(environment) && continuation?.boundContinuationKind?.(record.intent.nativeScope) === 'addition';
  const addition = additive && predecessor ? additiveBindingSelection(project, environment, predecessor, history, record.intent.nativeScope, record) : undefined;
  if (additive && !addition?.expected) throw unavailable();
  getDb().transaction(() => {
    if (!authorize() || !sameCurrentSource(project, environment, record.intent)) throw unavailable();
    if (addition?.expected) {
      if (!predecessor || !additiveBindingSelection(project, environment, predecessor, history, record.intent.nativeScope, record)
        || !new EnvironmentRepository().compareAndSwapPlatformBindings(environment.id, addition.current, { ...addition.current,
          ...Object.fromEntries(addition.keys.map(key => [key, addition.expected!.platformBindings[key]])) })) throw unavailable();
      return;
    }
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
async function normalizeLocalBinding(project: Project, environment: Environment, record: Record, authorize: () => boolean): Promise<void> {
  const previous = new EnvironmentRepository().findById(environment.id)?.platformBindings;
  const next = await bindingNormalization(project, environment, record);
  if (!next) throw unavailable();
  getDb().transaction(() => {
    if (!authorize() || !isDeepStrictEqual(new EnvironmentRepository().findById(environment.id)?.platformBindings, previous)) throw unavailable();
    if (!new EnvironmentRepository().update(environment.id, { platformBindings: next })) throw unavailable();
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
  let history = await journal(project, environment).findByScope();
  let record = acceptedLeaf(history);
  if (!record && !desired?.scopePreparation) return undefined;
  const deploymentInputs = input.options && ['serviceFilter', 'envVarOverrides', 'envFile', 'includeEnvFile', 'secretRefs'].some(key => Object.hasOwn(input.options!, key));
  const isolatedInputs = () => new Error('Cloud project preparation is an isolated plan stage and accepts no deployment or credential-value inputs.');
  const capability = providerRegistry.getLocalScopePreparation(record?.intent.hostingProvider ?? desired!.provider);
  if (!capability) throw unavailable();
  if (record) {
    let boundScope: { scope: { [key: string]: string }; selection: { [key: string]: string }; kind: 'cleanup' | 'prerequisite' | 'addition' } | undefined;
    if (desired?.scopePreparation?.continuation && capability.continuation) {
      const selection = capability.continuation.parseSelection(desired.scopePreparation.continuation.nativeScope, desired);
      let scope: { [key: string]: string } | null | undefined;
      try { scope = capability.continuation.nextScope(record, selection, history); }
      catch { /* Ordinary recovery remains authoritative until a provider admits the continuation. */ }
      const kind = scope && capability.continuation.boundContinuationKind?.(scope);
      if (scope && kind) {
        if (kind === 'prerequisite' && !retainedBindingMatches(project, environment, record, history)) throw unavailable();
        if (kind === 'addition' && !emptyLocalScope(environment)
          && !additiveBindingSelection(project, environment, record, history, scope)) throw unavailable();
        boundScope = { scope, selection, kind };
      }
    }
    if (!boundScope || boundScope.kind === 'addition') {
      const execution = await context(project, environment, record.intent, 'recover');
      record = await reconcileCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest });
    }
    const allocation = history.find(item => item.installationId === record!.installationId && !item.intent.predecessor)
      ?? history.find(item => active(item) && !item.intent.predecessor);
    if (record.status === 'scope-ready' && desired?.scopePreparation && (!allocation || desired.provider !== record.intent.hostingProvider
      || !isDeepStrictEqual(capability.parseScope(desired.scopePreparation.nativeScope), allocation.intent.nativeScope)))
      throw new Error('This environment already allocated a cloud project. Its accepted identity is retained; editing desired names does not authorize a replacement.');
    // An admitted cleanup verifies its own exact native targets; removed trust
    // cannot be required to authorize removing the remaining grants.
    if (record.status === 'scope-ready' && (!boundScope || boundScope.kind === 'addition')) {
      await verifyBindingPrerequisites(project, environment, record);
      history = await journal(project, environment).findByScope();
    }
    if (boundScope?.kind === 'addition' && record.status !== 'scope-ready') throw unavailable();
    if (deploymentInputs) {
      // A completed binding is an ordinary deployment prerequisite. Verify it
      // before passing input handling back to full planning; unfinished or
      // changed scope work must still reject all deployment-value inputs.
      if (await isBound(project, environment, record)) return undefined;
      throw isolatedInputs();
    }
    if (record.status === 'scope-ready' && boundScope?.kind !== 'prerequisite' && await bindingNormalization(project, environment, record)) {
      return { ...projection(record, 'normalize'), environment, review: {
        resources: [{ kind: 'local-environment-binding', name: environment.name, scope: record.intent.nativeScope.projectId }],
        permissions: [], costs: [], warnings: ['Restore only missing nonsecret ownership metadata after verifying the original native creation. Cloud resources, saved credentials and existing metadata remain unchanged.'],
      }, warnings: ['This isolated metadata repair requires confirmation and performs no cloud writes.'] };
    }
    if (record.status === 'scope-ready' && !desired?.scopePreparation && !emptyLocalScope(environment)) return undefined;
    if ((record.status === 'scope-ready' || boundScope) && desired?.scopePreparation?.continuation) {
      if (!capability.continuation) throw unavailable();
      const selection = capability.continuation.parseSelection(desired.scopePreparation.continuation.nativeScope, desired);
      const nextScope = boundScope?.scope ?? capability.continuation.nextScope(record, selection, history);
      if (nextScope) {
        if (!emptyLocalScope(environment) && !capability.continuation.boundContinuationKind?.(nextScope)) throw unavailable();
        const currentSource = source(project, specResult); const predecessor = { installationId: record.installationId, planDigest: record.plan.digest };
        const proposed = history.find(item => !active(item) && isDeepStrictEqual(item.intent.source, currentSource)
          && isDeepStrictEqual(item.intent.predecessor, predecessor) && isDeepStrictEqual(item.intent.nativeScope, nextScope) && isDeepStrictEqual(item.intent.selection, selection)
          && capability.continuation!.isReviewCurrent?.(item) !== false);
        if (proposed) record = proposed;
        else {
          const intent: LocalCloudScopePreparationIntent = { ...record.intent, installationId: randomUUID(), source: currentSource, nativeScope: nextScope, predecessor, selection };
          record = await planCloudInstallationV1({ ...await context(project, environment, intent, 'allocate'), intent });
        }
      } else if (await isBound(project, environment, record)) return undefined;
      else {
        if (!sameCurrentSource(project, environment, record.intent)) throw new Error('The prepared scope source changed before binding. Retain the accepted preparation and review the exact source before a handoff.');
        const expected = await binding(project, environment, record);
        return { ...projection(record, 'bind'), environment, review: { ...record.plan.review,
          resources: [{ kind: 'local-environment-binding', name: environment.name, scope: record.intent.nativeScope.projectId },
            ...expected.connections.map(item => ({ kind: 'local-default-connection', name: item.provider, scope: expected.scope }))],
          permissions: [], costs: [], warnings: ['This local metadata handoff stores no credentials. Runtime identities and CI federation remain separately reviewed.'] },
          warnings: ['Confirm this exact environment binding before ordinary hosting planning. No cloud write occurs in this handoff.'] };
      }
    }
  } else {
    if (deploymentInputs) throw isolatedInputs();
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
  const incompleteAttempts = record.plan.actions.filter(action => !record!.completed[action.id]).map(action =>
    record!.attempts.filter(attempt => attempt.actionId === action.id).at(-1)).filter(attempt => !!attempt);
  const retry = capability.continuation?.isReviewCurrent?.(record) !== false
    && record.intent.predecessor && incompleteAttempts.length && incompleteAttempts.every(attempt => attempt.status === 'rejected')
    ? await reviewCloudInstallationRetryV1({ ...await context(project, environment, record.intent, 'allocate'),
      installationId: record.installationId, planDigest: record.plan.digest }) : undefined;
  const mode = record.status === 'scope-ready' ? 'verified' : retry ? 'allocate' : record.intent.predecessor
    ? record.attempts.some(attempt => !record!.completed[attempt.actionId]) ? 'recover'
      : record.plan.actions.some(action => !record!.completed[action.id]) ? 'allocate' : 'recover'
    : record.attempts.length ? 'recover' : 'allocate';
  // Preserve the approved plan while distinguishing its observations from the
  // current reconciliation result on both public warning surfaces.
  const review = retry?.review ?? (mode === 'allocate' ? record.plan.review : { ...record.plan.review,
    warnings: record.plan.review.warnings.map(warning => `Historical approval review: ${warning}`) });
  return { ...projection(record, mode, retry?.retryActions), environment, review, warnings: [
    ...review.warnings,
    ...review.costs.map(item => item.description),
    record.intent.predecessor ? 'Only this retained preparation stage is authorized; later API, identity, binding or hosting stages need their own current plan.'
      : 'This stage allocates an empty cloud project only. Billing, API enablement, cloud connections and hosting are separate reviewed work.',
    'An allocated but unbound project remains in this isolated stage until a separate reviewed lifecycle handoff records its connection and binding; removing this declaration does not adopt it.',
    ...(record.reason ? [record.intent.predecessor
      ? `The retained preparation stage reports ${record.reason}; ${retry ? 'this new plan requires separate confirmation of its exact rejected-attempt retries' : 'recovery never repeats a mutation'}.`
      : `The retained allocation reports ${record.reason}; recovery never repeats a creation request.`] : []),
  ] };
}

/** Pure local prerequisite detection; it neither adopts spec edits nor calls a provider. */
export async function localCloudScopeRequired(project: Project, environmentName: string, spec?: ProjectSpec): Promise<boolean> {
  if (spec?.environments[environmentName]?.hosting.scopePreparation) {
    const existing = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
    const leaf = existing && acceptedLeaf(await journal(project, existing).findByScope());
    return !existing || !leaf || !await isBound(project, existing, leaf);
  }
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
  if (!environment) return false;
  const history = await journal(project, environment).findByScope(), leaf = acceptedLeaf(history);
  if (leaf && await bindingNormalization(project, environment, leaf)) return true;
  return history.some(record => record.attempts.length > 0
    && (record.status !== 'scope-ready' || emptyLocalScope(environment)));
}

/** Historical operation status is read-only at the cloud boundary, even after source edits. */
export async function inspectLocalCloudScope(project: Project, environmentName: string) {
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
  if (!environment) return undefined;
  const history = await journal(project, environment).findByScope();
  let record = acceptedLeaf(history) ?? history.at(-1);
  if (!record) return undefined;
  if (record.status === 'scope-ready' && !emptyLocalScope(environment) && await isBound(project, environment, record)) return undefined;
  // A continuation's outcome does not describe allocation. Follow only its
  // accepted immutable ancestry and freshly verify the exact allocated lifetime.
  let allocation = record;
  const visited = new Set<string>();
  while (allocation.intent.predecessor) {
    if (visited.has(allocation.installationId) || visited.size >= 20) throw unavailable();
    visited.add(allocation.installationId);
    const predecessor = allocation.intent.predecessor;
    const previous = history.find(item => item.installationId === predecessor.installationId);
    if (!previous || previous.plan.digest !== predecessor.planDigest) throw unavailable();
    allocation = previous;
  }
  if (allocation.installationId !== record.installationId) {
    const execution = await context(project, environment, allocation.intent, 'recover');
    allocation = await reconcileCloudInstallationV1({ ...execution, installationId: allocation.installationId, planDigest: allocation.plan.digest });
  }
  if (record.attempts.length) {
    const execution = await context(project, environment, record.intent, 'recover');
    record = await reconcileCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest });
  }
  // Continuation authorization also refreshes predecessors. Use that latest
  // observation, including a denied read or a replaced native project lifetime.
  if (allocation.installationId === record.installationId) allocation = record;
  else {
    const current = await journal(project, environment).read(allocation.installationId);
    if (!current || current.plan.digest !== allocation.plan.digest) throw unavailable();
    allocation = current;
  }
  const allocationComplete = allocation.status === 'scope-ready';
  const resources = [
    ...(allocationComplete ? Object.values(allocation.completed).flatMap(value => value.resources) : []),
    ...Object.values(record.completed).flatMap(value => value.resources),
  ].filter((resource, index, all) => all.findIndex(other => isDeepStrictEqual(other, resource)) === index);
  return { scope: 'cloud-scope' as const, environment: environmentName, installationId: record.installationId,
    stage: record.intent.predecessor ? 'continuation' as const : 'allocation' as const, actionIds: record.plan.actions.map(action => action.id),
    status: record.status, verified: record.status === 'scope-ready' && allocationComplete, allocationComplete, hostingReady: false,
    resources, ...(record.reason ? { reason: record.reason } : {}) };
}

export async function applyLocalCloudScope(input: { project: Project; environment: Environment; cloudScope: unknown;
  action?: PlanAction; authorize: () => boolean }): Promise<ActionResult> {
  try {
    const proof = localCloudScopePlanSchema.parse(input.cloudScope);
    const record = await journal(input.project, input.environment).read(proof.installationId);
    if (!record || record.plan.digest !== proof.installationPlanDigest || record.intent.hostingProvider !== proof.hostingProvider) throw unavailable();
    if (proof.retryActions && (proof.mode !== 'allocate' || !record.intent.predecessor)) throw unavailable();
    const expected = projection(record, proof.mode, proof.retryActions);
    if (input.action ? !isLocalCloudScopeAction(input.action) || !expected.actions.some(action => isDeepStrictEqual(input.action, action)) : proof.mode !== 'verified') throw unavailable();
    if (input.action) localCloudScopeActionMetadataSchema.parse(input.action.metadata);
    const attempt = record.attempts.filter(attempt => attempt.actionId === input.action?.id).at(-1);
    const retryAction = proof.retryActions?.find(retry => retry.actionId === input.action?.id && retry.attemptId === attempt?.id && attempt.status === 'rejected');
    const readOnly = proof.mode !== 'allocate' || (record.intent.predecessor ? !!attempt && !retryAction : record.attempts.length > 0);
    if (!readOnly && providerRegistry.getLocalScopePreparation(record.intent.hostingProvider)?.continuation?.isReviewCurrent?.(record) === false)
      throw unavailable();
    const execution = await context(input.project, input.environment, record.intent, readOnly ? 'recover' : 'allocate', input.authorize);
    if (proof.retryActions) {
      const current = await reviewCloudInstallationRetryV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest });
      if (!isDeepStrictEqual(current.retryActions, proof.retryActions)) throw unavailable();
    }
    const updated = readOnly
      ? await reconcileCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest,
        ...(record.intent.predecessor && input.action && !['bind', 'normalize'].includes(proof.mode) ? { onlyActionId: input.action.id } : {}) })
      : await applyCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [input.action!.id],
        ...(record.intent.predecessor ? { onlyActionId: input.action!.id } : {}), ...(retryAction ? { retryActions: [retryAction] } : {}) });
    if (['bind', 'normalize'].includes(proof.mode) && updated.status === 'scope-ready') await verifyBindingPrerequisites(input.project, input.environment, updated);
    if (proof.mode === 'bind' && updated.status === 'scope-ready') await bindLocalScope(input.project, input.environment, updated, input.authorize);
    if (proof.mode === 'normalize' && updated.status === 'scope-ready') await normalizeLocalBinding(input.project, input.environment, updated, input.authorize);
    const complete = updated.status === 'scope-ready' || ['allocate', 'recover'].includes(proof.mode) && updated.status === 'pending' && !updated.reason && Boolean(updated.completed[input.action!.id]);
    return { success: complete, ...(complete ? {} : { status: updated.status === 'pending' ? 'pending' as const : 'blocked' as const }),
      message: complete ? proof.mode === 'normalize' ? 'Restored missing nonsecret ownership metadata from the verified original installation; cloud resources and connections were preserved.'
        : proof.mode === 'bind' ? 'Bound the exact verified cloud project and nonsecret local connections to this application environment.'
        : updated.intent.predecessor ? 'Verified this exact preparation action. Later stages require a separate current plan.'
        : 'Verified the exact empty project allocation. Billing and hosting have not been configured.'
        : updated.intent.predecessor
          ? `The cloud preparation action ${input.action?.id ?? updated.plan.actions.map(action => action.id).join(', ')} is unresolved. Retain its exact attempt for read-only recovery; no later stage was authorized.`
          : 'The project allocation is unresolved. Retain its exact native operation for read-only recovery; no replacement was authorized.',
      data: { installationId: updated.installationId, status: updated.status, ...(updated.reason ? { reason: updated.reason } : {}),
        resources: Object.values(updated.completed).flatMap(value => value.resources) } };
  } catch { return { success: false, status: 'blocked', message: unavailable().message }; }
}

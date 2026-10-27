import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudScopePreparationRepository, acceptedJournalLeaf, operatorArtifactJournalNames } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { normalizeGitRemoteIdentity } from '../../lib/git-remote.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import type { CloudInstallationContext, CloudInstallationRecord, LocalCloudScopePreparationIntent } from '../ports/cloud-installation.port.js';
import { isLocalHoldingAction, LOCAL_HOLDING_OPERATION, localHoldingPlanSchema, type LocalHoldingPlan, type LocalPreparedHostingReceiptV1 } from '../ports/local-holding-preparation.port.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { SpecStore, type SpecResult } from '../spec/spec.store.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { environmentConnectionScope } from './project-scope.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from './cloud-installation-runtime.js';

type RecordV1 = CloudInstallationRecord<LocalCloudScopePreparationIntent>;
const route = z.object({ intent: z.object({ hostingProvider: z.string() }).passthrough() }).passthrough();
const unavailable = () => new Error('Holding preparation requires its exact reviewed local project scope, published holding image and retained native identity; no application deployment is authorized.');
function journal(project: Project, environment: Environment) {
  return new CloudScopePreparationRepository<RecordV1>({ projectId: project.id, environmentId: environment.id, environmentName: environment.name }, value => {
    const capability = providerRegistry.getHoldingPreparation(route.parse(value).intent.hostingProvider); if (!capability) throw unavailable();
    return capability.parseRecord(value);
  }, { recordType: 'hosting-preparation' });
}
async function publishedImage(project: Project, environment: Environment, image: string) {
  const scope = { projectId: project.id, environmentId: environment.id, environmentName: environment.name };
  const found: Array<Record<string, string>> = [];
  for (const name of operatorArtifactJournalNames(scope)) {
    const repository = new CloudScopePreparationRepository<any>(scope, value => {
      const provider = (value as any)?.intent?.artifactProvider;
      const capability = typeof provider === 'string' ? providerRegistry.getArtifactPublication(provider) : undefined;
      if (!capability) throw unavailable(); return capability.parseRecord(value);
    }, { recordType: `operator-artifacts:${name}` });
    for (const record of await repository.findByScope()) {
      if (record.status !== 'scope-ready') continue;
      const capability = providerRegistry.getArtifactPublication(record.intent.artifactProvider)!;
      found.push(...capability.receipts(record).filter(receipt => receipt.kind === 'holding-v1' && receipt.image === image));
    }
  }
  if (!found.length || found.some(value => !isDeepStrictEqual(value, found[0]))) throw unavailable();
  return found[0];
}
function source(project: Project, result: SpecResult): LocalCloudScopePreparationIntent['source'] {
  const repository = normalizeGitRemoteIdentity(result.spec.gitRemoteUrl ?? project.gitRemoteUrl ?? undefined); if (!repository) throw unavailable();
  return { kind: 'local-spec', repository, specRevision: result.revision, specDigest: canonicalJsonSha256(result.spec) };
}
function connected(project: Project, environment: Environment, intent: LocalCloudScopePreparationIntent) {
  const selected = new ConnectionRepository().findByProviderAndScope(intent.hostingProvider, environmentConnectionScope(intent.source.repository, environment.name));
  if (!selected || selected.status !== 'verified') return false;
  try {
    const config = z.object({ authMode: z.literal('default'), projectId: z.string(), region: z.string() }).strict().parse(getSecretStore().decryptObject(selected.credentialsEncrypted));
    return project.id === environment.projectId && config.authMode === 'default' && config.projectId === intent.nativeScope.projectId
      && config.region === intent.nativeScope.region;
  } catch { return false; }
}
async function current(project: Project, environment: Environment, intent: LocalCloudScopePreparationIntent) {
  try {
    const freshProject = new ProjectRepository().findById(project.id), fresh = new EnvironmentRepository().findById(environment.id);
    const result = freshProject && new SpecStore().getForInspection(freshProject);
    if (!freshProject || !fresh || fresh.projectId !== project.id || fresh.name !== environment.name || !result
      || !isDeepStrictEqual(source(freshProject, result), intent.source) || !connected(freshProject, fresh, intent)) return false;
    const desired = result.spec.environments[environment.name], capability = providerRegistry.getHoldingPreparation(intent.hostingProvider);
    if (!capability || desired?.hosting.provider !== intent.hostingProvider || !desired.hosting.preparation) return false;
    return isDeepStrictEqual(capability.parseDeclaration({ environment: desired, bindings: fresh.platformBindings,
      publication: await publishedImage(freshProject, fresh, desired.hosting.preparation.image) }), intent.nativeScope);
  } catch { return false; }
}
async function context(project: Project, environment: Environment, intent: LocalCloudScopePreparationIntent, readOnly: boolean,
  authorize: () => boolean = () => true): Promise<CloudInstallationContext<LocalCloudScopePreparationIntent>> {
  const capability = providerRegistry.getHoldingPreparation(intent.hostingProvider);
  if (!capability || intent.appId !== project.id || intent.customerId !== project.id || intent.environment !== environment.name
    || !connected(project, environment, intent)) throw unavailable();
  return { ...await capability.create(intent.nativeScope), store: journal(project, environment), authorize: async input => {
    const fresh = new EnvironmentRepository().findById(environment.id);
    return !!fresh && fresh.projectId === project.id && fresh.name === environment.name && authorize()
      && isDeepStrictEqual(input.intent, intent) && connected(project, fresh, intent)
      && (readOnly ? input.phase !== 'mutate' : await current(project, fresh, intent));
  } };
}
function projection(record: RecordV1, mode: LocalHoldingPlan['mode'], retryActions?: LocalHoldingPlan['retryActions']) {
  const holdingPreparation: LocalHoldingPlan = { schemaVersion: 1, installationId: record.installationId, planDigest: record.plan.digest,
    provider: record.intent.hostingProvider, mode, ...(retryActions ? { retryActions } : {}) };
  let originals: PlanAction[] = mode === 'bind' ? [{ id: 'hosting-preparation:bind', type: 'update', verified: true, requiresConfirm: true,
    resource: { kind: 'project', provider: record.intent.hostingProvider, name: record.intent.environment },
    reason: 'Record the verified inert services, HTTPS origins and separate final identities; application release remains pending.' }]
    : mode === 'recover' ? record.plan.actions.filter(action => record.attempts.some(attempt => attempt.actionId === action.id)) : record.plan.actions;
  if (retryActions) {
    if (mode !== 'prepare') throw unavailable();
    const included = new Set(retryActions.map(retry => retry.actionId));
    for (const id of included) {
      const action = record.plan.actions.find(action => action.id === id); if (!action) throw unavailable();
      for (const dependency of action.dependsOn ?? []) { if (!record.completed[dependency]) throw unavailable(); included.add(dependency); }
    }
    originals = originals.filter(action => included.has(action.id));
  }
  return { holdingPreparation, actions: originals.map(action => ({ ...action,
    ...(retryActions?.some(retry => retry.actionId === action.id) ? { reason: `Retry the rejected attempt ${retryActions.find(retry => retry.actionId === action.id)!.attemptId}. ${action.reason}` } : {}),
    ...(mode === 'recover' ? { type: 'update' as const, requiresConfirm: false, billable: false, dataBearing: false,
      reason: 'Read only the exact retained holding resource and operation; never repeat an uncertain create or public grant.' }
      : mode === 'prepare' && record.completed[action.id] ? { type: 'noop' as const, requiresConfirm: false, billable: false, dataBearing: false } : {}),
    metadata: { ...holdingPreparation, operation: LOCAL_HOLDING_OPERATION, nativeActionId: action.id },
  })) };
}
function matchesBinding(environment: Environment, receipt: LocalPreparedHostingReceiptV1) {
  const bindings = environment.platformBindings, services = bindings.services as Record<string, Record<string, unknown>> | undefined;
  return bindings.provider === receipt.hostingProvider && bindings.projectId === receipt.nativeScope.projectId
    && bindings.environmentId === receipt.deployment.region && !!services && receipt.preparedResources.workloads.every(item =>
      services[item.workload]?.serviceId === item.id.split('/').at(-1) && services[item.workload]?.resourceUid === item.lifetimeId)
    && isDeepStrictEqual(bindings.localPreparedHosting, receipt)
    && (environment.platformBindings.preparedHosting as any)?.receiptDigest === canonicalJsonSha256(receipt);
}
export async function localHoldingWorkRequired(project: Project, environmentName: string, spec?: ProjectSpec): Promise<boolean> {
  const declared = Boolean(spec?.environments[environmentName]?.hosting.preparation);
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName); if (!environment) return declared;
  const record = acceptedJournalLeaf(await journal(project, environment).findByScope());
  return record ? record.status !== 'scope-ready' || !matchesBinding(environment, providerRegistry.getHoldingPreparation(record.intent.hostingProvider)!.receipt(record)) : declared;
}
/** Existing binding bytes are accepted only against the immutable local journal. */
export async function verifiedLocalHoldingReceipt(project: Project, environment: Environment): Promise<LocalPreparedHostingReceiptV1 | undefined> {
  const value = environment.platformBindings.localPreparedHosting; if (value === undefined) return undefined;
  const record = acceptedJournalLeaf(await journal(project, environment).findByScope());
  if (!record || record.status !== 'scope-ready' || !connected(project, environment, record.intent)) throw unavailable();
  const receipt = providerRegistry.getHoldingPreparation(record.intent.hostingProvider)!.receipt(record);
  if (!matchesBinding(environment, receipt)) throw unavailable(); return receipt;
}
export async function planLocalHolding(input: { project: Project; environmentName: string; specResult: SpecResult; options?: object }) {
  const desired = input.specResult.spec.environments[input.environmentName];
  const environment = new EnvironmentRepository().findByProjectAndName(input.project.id, input.environmentName);
  if (!environment) { if (desired?.hosting.preparation) throw unavailable(); return undefined; }
  const history = await journal(input.project, environment).findByScope(); let record = acceptedJournalLeaf(history);
  if (!record && !desired?.hosting.preparation) return undefined;
  const capability = providerRegistry.getHoldingPreparation(record?.intent.hostingProvider ?? desired.hosting.provider); if (!capability) throw unavailable();
  if (record?.status === 'scope-ready' && matchesBinding(environment, capability.receipt(record))) {
    if (desired.hosting.preparation && (desired.hosting.provider !== record.intent.hostingProvider
      || !isDeepStrictEqual(capability.parseDeclaration({ environment: desired, bindings: environment.platformBindings,
        publication: await publishedImage(input.project, environment, desired.hosting.preparation.image) }), record.intent.nativeScope))) throw unavailable();
    return undefined;
  }
  if (input.options && ['serviceFilter', 'envVarOverrides', 'envFile', 'includeEnvFile', 'secretRefs'].some(key => Object.hasOwn(input.options!, key))) throw unavailable();
  if (record) record = await reconcileCloudInstallationV1({ ...await context(input.project, environment, record.intent, true),
    installationId: record.installationId, planDigest: record.plan.digest });
  if (!record) {
    if (!desired.hosting.preparation || !environment.platformBindings.projectId || Object.keys((environment.platformBindings.services ?? {}) as object).length) throw unavailable();
    const nativeScope = capability.parseDeclaration({ environment: desired, bindings: environment.platformBindings,
      publication: await publishedImage(input.project, environment, desired.hosting.preparation.image) });
    const selectedSource = source(input.project, input.specResult);
    record = history.find(item => !item.attempts.length && !Object.keys(item.completed).length && isDeepStrictEqual(item.intent.nativeScope, nativeScope) && isDeepStrictEqual(item.intent.source, selectedSource));
    if (!record) {
      const intent: LocalCloudScopePreparationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: input.project.id, appId: input.project.id,
        environment: input.environmentName, source: selectedSource, provider: capability.provider, hostingProvider: desired.hosting.provider,
        execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, mode: 'connect', stage: 'scope-preparation', keys: [], nativeScope };
      record = await planCloudInstallationV1({ ...await context(input.project, environment, intent, false), intent });
    }
  }
  const stillCurrent = await current(input.project, environment, record.intent);
  const pending = record.plan.actions.filter(action => !record!.completed[action.id]).map(action => record!.attempts.filter(attempt => attempt.actionId === action.id).at(-1)).filter(attempt => !!attempt);
  const retry = stillCurrent && pending.length && pending.every(attempt => attempt.status === 'rejected')
    ? await reviewCloudInstallationRetryV1({ ...await context(input.project, environment, record.intent, false), installationId: record.installationId, planDigest: record.plan.digest }) : undefined;
  const mode = stillCurrent && record.status === 'scope-ready' ? 'bind'
    : retry ? 'prepare' : !stillCurrent || record.attempts.some(attempt => !record!.completed[attempt.actionId]) ? 'recover' : 'prepare';
  return { ...projection(record, mode, retry?.retryActions), environment, review: retry?.review ?? record.plan.review,
    warnings: [...record.plan.review.warnings, ...record.plan.review.costs.map(cost => cost.description),
      'Prepared holding endpoints are inert. OAuth registration and the first application release require separate reviewed actions.'] };
}
export async function applyLocalHolding(input: { project: Project; environment: Environment; holdingPreparation: unknown; action: PlanAction; authorize(): boolean }): Promise<ActionResult> {
  try {
    const selected = localHoldingPlanSchema.parse(input.holdingPreparation), store = journal(input.project, input.environment);
    const record = await store.read(selected.installationId);
    if (!record || record.plan.digest !== selected.planDigest || record.intent.hostingProvider !== selected.provider || !isLocalHoldingAction(input.action)
      || !projection(record, selected.mode, selected.retryActions).actions.some(action => isDeepStrictEqual(action, input.action))) throw unavailable();
    const execution = await context(input.project, input.environment, record.intent, selected.mode !== 'prepare', input.authorize);
    if (selected.retryActions) {
      const fresh = await reviewCloudInstallationRetryV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest });
      if (!isDeepStrictEqual(fresh.retryActions, selected.retryActions)) throw unavailable();
    }
    const attempt = record.attempts.filter(value => value.actionId === input.action.id).at(-1);
    const retry = selected.retryActions?.find(value => value.actionId === input.action.id && value.attemptId === attempt?.id && attempt.status === 'rejected');
    const target = { ...execution, installationId: record.installationId, planDigest: record.plan.digest };
    const updated = selected.mode !== 'prepare' || attempt && !retry
      ? await reconcileCloudInstallationV1(target) : await applyCloudInstallationV1({ ...target, onlyActionId: input.action.id, confirmActions: [input.action.id], ...(retry ? { retryActions: [retry] } : {}) });
    if (selected.mode === 'bind') {
      if (updated.status !== 'scope-ready' || !await current(input.project, input.environment, record.intent) || !input.authorize()) throw unavailable();
      const receipt = providerRegistry.getHoldingPreparation(record.intent.hostingProvider)!.receipt(updated);
      const envs = new EnvironmentRepository(), fresh = envs.findById(input.environment.id); if (!fresh) throw unavailable();
      if (!matchesBinding(fresh, receipt)) {
        if (fresh.platformBindings.localPreparedHosting || fresh.platformBindings.preparedHosting || Object.keys((fresh.platformBindings.services ?? {}) as object).length) throw unavailable();
        const services = Object.fromEntries(receipt.preparedResources.workloads.map(item => [item.workload, {
          serviceId: item.id.split('/').at(-1), resourceUid: item.lifetimeId, resourceType: item.kind,
          workloadKind: receipt.deployment.workloads.find(workload => workload.name === item.workload)!.kind,
          imageUri: item.holding.image, ...(receipt.origins[item.workload] ? { url: receipt.origins[item.workload] } : {}),
        }]));
        const next = { ...fresh.platformBindings, services, localPreparedHosting: receipt, preparedHosting: { schemaVersion: 1,
          installationId: receipt.installationId, planDigest: receipt.planDigest, receiptDigest: canonicalJsonSha256(receipt),
          pendingFirstRelease: receipt.preparedResources.workloads.map(item => item.workload) } };
        if (!envs.compareAndSwapPlatformBindings(fresh.id, fresh.platformBindings, next)) throw unavailable();
      }
      envs.syncRepoBindingsForId(fresh.id);
      return { success: true, message: 'Recorded inert holding endpoints; application release remains pending.', data: { status: 'prepared', origins: receipt.origins, providerMutations: 0 } };
    }
    const success = updated.status === 'scope-ready' || updated.status === 'pending' && !updated.reason && !!updated.completed[input.action.id];
    return { success, ...(success ? {} : { status: updated.status === 'pending' ? 'pending' as const : 'blocked' as const }),
      message: success ? 'Verified this exact inert preparation action; application release remains separate.' : unavailable().message,
      data: { installationId: updated.installationId, status: updated.status, ...(updated.reason ? { reason: updated.reason } : {}) } };
  } catch { return { success: false, status: 'blocked', message: unavailable().message }; }
}

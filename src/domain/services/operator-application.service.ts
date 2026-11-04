import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudScopePreparationRepository, acceptedJournalLeaf, operatorApplicationJournalNames, CLOUD_SCOPE_PREPARATION_LINEAGE_LIMIT } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { normalizeGitRemoteIdentity } from '../../lib/git-remote.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { CLOUD_INSTALLATION_REASONS } from '../ports/cloud-installation.port.js';
import type { CloudInstallationContext, CloudInstallationRecord, OperatorApplicationIntent } from '../ports/cloud-installation.port.js';
import { OPERATOR_APPLICATION_OPERATION, isOperatorApplicationAction, operatorApplicationPlanSchema, type OperatorApplicationPlan } from '../ports/operator-application.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { SpecStore, type SpecResult } from '../spec/spec.store.js';
import { CloudInstallationError, applyCloudInstallationV1, historicalInstallationEvidence, planCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from './cloud-installation-runtime.js';
import { verifiedLocalHoldingReceipt } from './local-holding-preparation.service.js';
import { assertReadySecretContainers } from './secret-container-setup.js';
import { operatorOutputSelectionSchema } from '../ports/operator-output.port.js';
import { preparedHostingMarkerSchema } from '../ports/hosting-prepared.port.js';
import { preparedReleaseAttempts } from './prepared-direct-release.service.js';
import { recoveryRuntimeBindings } from './runtime-evidence.js';
import { manualBackupRecordsSchema } from './manual-backup.service.js';
import { secretContainerBindings } from '../ports/secret-destination-lifecycle.port.js';
import { projectOperatorRetirement } from '../ports/operator-retirement.port.js';
type Registration = CloudInstallationRecord<OperatorApplicationIntent>;
const route = z.object({ intent: z.object({ applicationProvider: z.string() }).passthrough() }).passthrough();
export const operatorApplicationUnavailable = () => new Error('Operator application registration requires its verified native origin, exact owner/source and retained operation. Preserve uncertain attempts and inspect status for any supported, separately reviewed restart. No credential replay is authorized.');
const active = (record: Registration) => record.attempts.length > 0 || Object.keys(record.completed).length > 0;
function journal(project: Project, environment: Environment, name: string) {
  return new CloudScopePreparationRepository<Registration>({ projectId: project.id, environmentId: environment.id, environmentName: environment.name }, value => {
    const capability = providerRegistry.getOperatorApplication(route.parse(value).intent.applicationProvider);
    if (!capability) throw operatorApplicationUnavailable();
    const candidate = value as Registration;
    if (candidate.intent?.retirement?.continueFrom) {
      const outputs = operatorOutputSelectionSchema.parse(candidate.intent.outputs), retirement = providerRegistry.getOperatorOutputDelivery(outputs.hostingProvider)?.retirement;
      if (!retirement) throw retirementUnavailable(); return retirement.parseRecord(value);
    }
    return capability.parseRecord(value);
  }, { recordType: `operator-applications:${name}`,
    allowRetiredPredecessor: (parent, next) => outputContinuation(parent, next.intent),
    allowHistoricalPredecessor: (parent, next) => next.intent.mode === 'retire'
      ? !!historicalInstallationEvidence(parent) && isDeepStrictEqual(next.intent.retirement?.from, { installationId: parent.installationId, planDigest: parent.plan.digest })
      : restartEligible(parent, next.intent, environment) });
}
function outputContinuation(parent: Registration, next: OperatorApplicationIntent): boolean {
  return parent.status === 'retired' && parent.intent.mode === 'retire' && parent.intent.retirement?.data === 'retain'
    && !parent.intent.retirement.continueFrom && next.mode === 'retire' && next.retirement?.data === 'delete-owned'
    && !!next.retirement.outputTargets && isDeepStrictEqual(next.retirement.continueFrom, { installationId: parent.installationId, planDigest: parent.plan.digest })
    && isDeepStrictEqual(next.predecessor, next.retirement.continueFrom)
    && isDeepStrictEqual(parent.intent.retirement.from, next.retirement.from) && isDeepStrictEqual(parent.intent.retirement.targets, next.retirement.targets)
    && isDeepStrictEqual(parent.intent.nativeScope, next.nativeScope) && parent.intent.applicationProvider === next.applicationProvider
    && parent.intent.appId === next.appId && parent.intent.customerId === next.customerId && parent.intent.environment === next.environment
    && parent.intent.source.repository === next.source.repository;
}
function localContext(intent: OperatorApplicationIntent, environment: Environment) {
  return { projectId: intent.appId, environmentId: environment.id, installationId: intent.installationId, intentDigest: canonicalJsonSha256(intent) };
}
function restartEligible(parent: Registration, next: OperatorApplicationIntent, environment: Environment): boolean {
  if (!isDeepStrictEqual(next.predecessor, { installationId: parent.installationId, planDigest: parent.plan.digest })
    || parent.installationId === next.installationId || parent.intent.customerId !== next.customerId || parent.intent.appId !== next.appId
    || parent.intent.environment !== next.environment || parent.intent.applicationProvider !== next.applicationProvider
    || parent.intent.source.repository !== next.source.repository || !isDeepStrictEqual(parent.intent.nativeScope, next.nativeScope)
    || !isDeepStrictEqual(parent.intent.outputs, next.outputs) || !parent.intent.selection?.originDigest
    || parent.intent.selection.originDigest !== next.selection?.originDigest
    || !parent.intent.selection.nativeScopeDigest || parent.intent.selection.nativeScopeDigest !== next.selection?.nativeScopeDigest) return false;
  return providerRegistry.getOperatorApplication(parent.intent.applicationProvider)?.restart?.eligible(parent, localContext(parent.intent, environment)) === true;
}
function restartGuidance(record: Registration, environment: Environment, history: Registration[]) {
  const capability = providerRegistry.getOperatorApplication(record.intent.applicationProvider)?.restart;
  if (!capability?.eligible(record, localContext(record.intent, environment))
    || historicalRegistrations(record, history).length + 1 >= CLOUD_SCOPE_PREPARATION_LINEAGE_LIMIT) return undefined;
  return { restartFrom: { installationId: record.installationId, planDigest: record.plan.digest }, requiresNewApproval: true,
    nativeState: 'unknown', cleanupVerified: false, description: capability.description };
}
function historicalRegistrations(record: Registration, history: Registration[]) {
  const retained: Array<Record<string, unknown>> = []; let cursor = record;
  while (cursor.intent.predecessor) {
    const prior = history.find(item => item.installationId === cursor.intent.predecessor!.installationId);
    if (!prior || prior.plan.digest !== cursor.intent.predecessor.planDigest || retained.length >= CLOUD_SCOPE_PREPARATION_LINEAGE_LIMIT) throw operatorApplicationUnavailable();
    retained.push({ installationId: prior.installationId, planDigest: prior.plan.digest, provider: prior.intent.applicationProvider,
      reviewedResources: prior.plan.review.resources ?? [], nativeState: 'unknown', cleanupVerified: false });
    cursor = prior;
  }
  return retained;
}
function source(project: Project, result: SpecResult): OperatorApplicationIntent['source'] {
  const repository = normalizeGitRemoteIdentity(result.spec.gitRemoteUrl ?? project.gitRemoteUrl ?? undefined);
  if (!repository) throw operatorApplicationUnavailable();
  return { kind: 'local-spec', repository, specRevision: result.revision, specDigest: canonicalJsonSha256(result.spec) };
}
class OperatorRetirementSelectionError extends Error {}
const retirementUnavailable = () => new OperatorRetirementSelectionError('Operator retirement requires the exact completed registration and removal of its runtime consumers, pending releases and recovery work first. Preserve retained identities and review their supported cleanup; no setup or deletion was authorized.');
/** Closed guidance only; provider exception messages never leave this boundary. */
export function operatorRetirementPlanFailure(error: unknown): string {
  if (error instanceof OperatorRetirementSelectionError) return error.message;
  const reason = error instanceof CloudInstallationError && (CLOUD_INSTALLATION_REASONS as readonly string[]).includes(error.code)
    ? error.code : 'provider_error';
  const next = reason === 'authorization_expired' ? 'Sign in again, then re-plan the same retirement.'
    : reason === 'insufficient_permissions' ? 'Verify read access with the current cloud connection, then re-plan the same retirement.'
    : 'Inspect the retained registration and current provider state, then re-plan the same retirement.';
  return `Operator retirement could not verify current provider state (${reason}). ${next} No setup or deletion was authorized.`;
}
/** A desired-state omission alone never proves consumer removal. */
function retirementConsumers(environment: Environment, result: SpecResult, services: string[]) {
  const desired = result.spec.environments[environment.name], bindings = environment.platformBindings;
  const maps = ['services', 'runtimeIdentities'].map(key => z.record(z.string(), z.unknown()).parse(bindings[key] ?? {}));
  const grants = z.record(z.string(), z.record(z.string(), z.unknown())).parse(bindings.storageRuntimeAccess ?? {});
  if (Object.keys(desired.services).length || maps.some(map => Object.keys(map).length) || Object.values(grants).some(map => Object.keys(map).length)
    || bindings.previousHosting !== undefined || recoveryRuntimeBindings(bindings.recoveryRuntime)?.pending
    || bindings.preparedHosting !== undefined && preparedHostingMarkerSchema.parse(bindings.preparedHosting).pendingFirstRelease.some(name => services.includes(name))
    || Object.values(preparedReleaseAttempts(environment)).some(attempt => attempt.status !== 'completed')
    || Object.values(manualBackupRecordsSchema.parse(bindings.manualRecovery ?? {})).some(record => record.checkpoint?.phase !== 'complete')) throw retirementUnavailable();
}
async function retirementSelection(project: Project, environment: Environment, name: string, result: SpecResult) {
  const declaration = result.spec.environments[environment.name]?.operatorApplications?.[name];
  const capability = declaration && providerRegistry.getOperatorApplication(declaration.provider);
  if (!declaration?.retirement || !capability?.retirement) throw retirementUnavailable();
  retirementConsumers(environment, result, [...new Set([declaration.originService, declaration.runtimeService])]);
  const history = await journal(project, environment, name).findByScope(), selectedSource = source(project, result);
  const reference = declaration.retirement.from;
  const parent = history.find(record => record.installationId === reference.installationId && record.plan.digest === reference.planDigest);
  if (!parent || parent.intent.mode !== 'connect' || parent.intent.applicationProvider !== declaration.provider
    || parent.intent.customerId !== project.id || parent.intent.appId !== project.id || parent.intent.environment !== environment.name
    || parent.intent.source.repository !== selectedSource.repository) throw retirementUnavailable();
  const originalSpec = new SpecStore().getRevision(project.id, parent.intent.source.specRevision);
  const original = originalSpec?.environments[environment.name]?.operatorApplications?.[name];
  const { retirement: _retirement, ...selectionDeclaration } = declaration;
  if (!originalSpec || canonicalJsonSha256(originalSpec) !== parent.intent.source.specDigest || !original
    || !isDeepStrictEqual(original, selectionDeclaration)
    || parent.intent.selection?.declarationDigest !== canonicalJsonSha256(original)) throw retirementUnavailable();
  // The declaration retains its original public provider selection. Expanded
  // provider-derived origin/runtime facts come from accepted setup, not discovery.
  const scopeMatches = capability.retirement.matchesScopeSelection?.(declaration.nativeScope, parent.intent.nativeScope)
    ?? Object.entries(declaration.nativeScope).every(([key, value]) => parent.intent.nativeScope[key] === value);
  if (!scopeMatches) throw retirementUnavailable();
  const ancestry = new Map<string, Registration>(); let cursor: Registration | undefined = parent;
  while (cursor) {
    if (ancestry.size >= CLOUD_SCOPE_PREPARATION_LINEAGE_LIMIT || ancestry.has(cursor.installationId)
      || cursor.intent.mode !== 'connect' || cursor.intent.applicationProvider !== declaration.provider
      || cursor.intent.customerId !== project.id || cursor.intent.appId !== project.id || cursor.intent.environment !== environment.name
      || cursor.intent.source.repository !== selectedSource.repository) throw retirementUnavailable();
    ancestry.set(cursor.installationId, cursor);
    const previous: OperatorApplicationIntent['predecessor'] = cursor.intent.predecessor;
    cursor = previous ? history.find(record => record.installationId === previous.installationId && record.plan.digest === previous.planDigest) : undefined;
    if (previous && !cursor) throw retirementUnavailable();
  }
  const refs = declaration.retirement.targets ?? [reference];
  if (new Set(refs.map(item => item.installationId)).size !== refs.length || !refs.some(item => isDeepStrictEqual(item, reference))) throw retirementUnavailable();
  const targets = refs.map(item => {
    const record = ancestry.get(item.installationId), evidence = record && historicalInstallationEvidence(record);
    if (!record || record.plan.digest !== item.planDigest || !evidence) throw retirementUnavailable();
    return { record, reference: { ...item, evidenceDigest: canonicalJsonSha256(evidence) } };
  });
  const leaf = acceptedJournalLeaf(history);
  const retirement = { ...declaration.retirement, targets: targets.map(item => item.reference) };
  const predecessor = retirement.continueFrom ?? reference;
  const proof = { declarationDigest: canonicalJsonSha256(declaration), nativeScopeDigest: canonicalJsonSha256(parent.intent.nativeScope) };
  if (retirement.continueFrom) {
    const previous = history.find(item => item.installationId === predecessor.installationId && item.plan.digest === predecessor.planDigest);
    if (!previous || !outputContinuation(previous, { ...parent.intent, mode: 'retire', predecessor, retirement }) || !parent.intent.outputs
      || !providerRegistry.getOperatorOutputDelivery(parent.intent.outputs.hostingProvider)?.retirement) throw retirementUnavailable();
    const bindings = secretContainerBindings(environment.platformBindings.secretDestinationContainers);
    for (const selected of retirement.outputTargets!) {
      const target = targets.find(item => isDeepStrictEqual({ installationId: item.record.installationId, planDigest: item.record.plan.digest }, selected.from));
      const originalOutput = target?.record.intent.outputs?.destinations.find(item => item.key === selected.key && item.role === selected.role);
      const output = parent.intent.outputs.destinations.find(item => item.key === selected.key && item.role === selected.role);
      if (!output || !originalOutput || !isDeepStrictEqual(output, originalOutput)
        || bindings[selected.key] === undefined && !(leaf?.status === 'retired' && leaf.intent.retirement?.continueFrom && leaf.completed[`operator-output:delete:${selected.key}`])
        || bindings[selected.key] !== undefined && !isDeepStrictEqual(bindings[selected.key], output.binding)) throw retirementUnavailable();
    }
  } else if (retirement.data !== 'retain' && parent.intent.outputs) throw retirementUnavailable();
  if (!leaf || leaf.installationId !== predecessor.installationId && !(leaf.intent.mode === 'retire' && isDeepStrictEqual(leaf.intent.predecessor, predecessor))) throw retirementUnavailable();
  // An accepted successor cannot be superseded by a changed or older review.
  if (leaf.installationId !== predecessor.installationId && (!isDeepStrictEqual(leaf.intent.retirement, retirement)
    || !isDeepStrictEqual(leaf.intent.selection, proof) || !isDeepStrictEqual(leaf.intent.nativeScope, parent.intent.nativeScope))) throw retirementUnavailable();
  return { declaration, capability, parent, targets: targets.map(item => structuredClone(item.record)), predecessor,
    retirement, nativeScope: parent.intent.nativeScope, source: selectedSource, proof };

}
async function selection(project: Project, environment: Environment, name: string, result: SpecResult) {
  const declaration = result.spec.environments[environment.name]?.operatorApplications?.[name];
  if (!declaration) throw operatorApplicationUnavailable();
  const receipt = await verifiedLocalHoldingReceipt(project, environment);
  const originCapability = receipt && providerRegistry.getHoldingPreparation(receipt.hostingProvider);
  const capability = providerRegistry.getOperatorApplication(declaration.provider);
  if (!receipt || !originCapability?.verifyOperatorOrigin || !capability) throw operatorApplicationUnavailable();
  const verified = await originCapability.verifyOperatorOrigin(receipt, { service: declaration.originService, runtimeService: declaration.runtimeService });
  const roles = capability.privateOutputRoles ?? [], selectedRoles = Object.keys(declaration.outputs ?? {});
  if (!isDeepStrictEqual([...roles].sort(), selectedRoles.sort())) throw operatorApplicationUnavailable();
  let outputs: OperatorApplicationIntent['outputs'];
  if (declaration.outputs) {
    const bindings = await assertReadySecretContainers({ project, environment, spec: result.spec, keys: Object.values(declaration.outputs) });
    outputs = operatorOutputSelectionSchema.parse({ hostingProvider: result.spec.environments[environment.name].hosting.provider,
      destinations: Object.entries(declaration.outputs).sort(([a], [b]) => a.localeCompare(b)).map(([role, key]) => ({ role, key, binding: bindings[key],
        ...(capability.privateVerificationRoles?.[role] ? { verificationPurpose: capability.privateVerificationRoles[role] } : {}),
        ...(capability.privateOutputEncodings?.[role] ? { encoding: capability.privateOutputEncodings[role] } : {}) })) });
    if (!providerRegistry.getOperatorOutputDelivery(outputs.hostingProvider)) throw operatorApplicationUnavailable();
  }
  const nativeScope = await capability.parseDeclaration({ name, declaration, ...verified });
  return { declaration, capability, nativeScope, outputs, source: source(project, result), proof: {
    declarationDigest: canonicalJsonSha256(declaration), originDigest: canonicalJsonSha256({ receipt, selection: verified, ...(outputs ? { outputs } : {}) }), nativeScopeDigest: canonicalJsonSha256(nativeScope),
  } };
}
async function current(project: Project, environment: Environment, name: string, intent: OperatorApplicationIntent): Promise<boolean> {
  try {
    const freshProject = new ProjectRepository().findById(project.id), fresh = new EnvironmentRepository().findById(environment.id);
    const result = freshProject && new SpecStore().getForInspection(freshProject);
    if (!freshProject || !fresh || fresh.projectId !== project.id || fresh.name !== intent.environment || !result) return false;
    if (intent.mode === 'retire') {
      const selected = await retirementSelection(freshProject, fresh, name, result);
      return selected.declaration.provider === intent.applicationProvider && selected.source.repository === intent.source.repository
        && isDeepStrictEqual(selected.proof, intent.selection) && isDeepStrictEqual(selected.retirement, intent.retirement)
        && isDeepStrictEqual(selected.nativeScope, intent.nativeScope) && isDeepStrictEqual(selected.predecessor, intent.predecessor)
        && (!intent.retirement?.continueFrom || isDeepStrictEqual(selected.parent.intent.outputs, intent.outputs));
    }
    const selected = await selection(freshProject, fresh, name, result);
    if (selected.declaration.provider !== intent.applicationProvider || selected.source.repository !== intent.source.repository
      || !isDeepStrictEqual(selected.proof, intent.selection) || !isDeepStrictEqual(selected.nativeScope, intent.nativeScope)
      || !isDeepStrictEqual(selected.declaration.restartFrom, intent.predecessor)) return false;
    const history = await journal(freshProject, fresh, name).findByScope(), leaf = acceptedJournalLeaf(history);
    if (leaf && leaf.installationId !== intent.installationId
      && (leaf.installationId !== intent.predecessor?.installationId || history.some(item => item.installationId === intent.installationId && active(item)))) return false;
    if (!intent.predecessor) return !leaf || leaf.installationId === intent.installationId;
    const parent = history.find(item => item.installationId === intent.predecessor!.installationId);
    return !!parent && historicalRegistrations(parent, history).length + 1 < CLOUD_SCOPE_PREPARATION_LINEAGE_LIMIT
      && restartEligible(parent, intent, fresh);
  } catch { return false; }
}
async function context(project: Project, environment: Environment, name: string, intent: OperatorApplicationIntent, readOnly: boolean,
  authorize: () => boolean = () => true): Promise<CloudInstallationContext<OperatorApplicationIntent>> {
  const capability = providerRegistry.getOperatorApplication(intent.applicationProvider);
  if (!capability || intent.customerId !== project.id || intent.appId !== project.id || intent.environment !== environment.name) throw operatorApplicationUnavailable();
  const local = { ...localContext(intent, environment), authorizeCurrent: () => current(project, environment, name, intent) };
  const retiredTargets = intent.mode === 'retire' ? intent.retirement!.targets : undefined;
  const history = retiredTargets ? await journal(project, environment, name).findByScope() : [];
  const targets = retiredTargets?.map(target => {
    const record = history.find(item => item.installationId === target.installationId && item.plan.digest === target.planDigest);
    const evidence = record && historicalInstallationEvidence(record);
    if (!record || !evidence || canonicalJsonSha256(evidence) !== target.evidenceDigest) throw retirementUnavailable();
    return structuredClone(record);
  });
  let connection: Awaited<ReturnType<typeof capability.create>>;
  if (intent.retirement?.continueFrom) {
    const outputs = operatorOutputSelectionSchema.parse(intent.outputs), outputCapability = providerRegistry.getOperatorOutputDelivery(outputs.hostingProvider)?.retirement;
    const previous = history.find(item => item.installationId === intent.retirement!.continueFrom!.installationId && item.plan.digest === intent.retirement!.continueFrom!.planDigest);
    if (!targets || !outputCapability || !previous || !outputContinuation(previous, intent)) throw retirementUnavailable();
    connection = await outputCapability.create(intent, targets);
    const native = await capability.retirement!.create(previous.intent.nativeScope, { ...localContext(previous.intent, environment), authorizeCurrent: local.authorizeCurrent }, targets);
    const driver = connection.driver;
    const verifyRemoved = async (signal: AbortSignal) => {
      for (const action of previous.plan.actions) {
        const observed = await native.driver.inspect({ intent: structuredClone(previous.intent), authentication: native.authentication, signal,
          completed: structuredClone(previous.completed), attempts: structuredClone(previous.attempts), action: structuredClone(action),
          beforeMutation: async () => { throw retirementUnavailable(); } });
        if (observed.state !== 'satisfied' || !isDeepStrictEqual(observed.evidence, previous.completed[action.id])) throw retirementUnavailable();
      }
    };
    connection = { ...connection, driver: { ...driver,
      parseScope: value => native.driver.parseScope(value),
      parseAction: (value, selected) => selected.retirement?.continueFrom ? driver.parseAction(value, selected) : native.driver.parseAction(value, selected),
      parseEvidence: (value, selected) => selected.retirement?.continueFrom ? driver.parseEvidence(value, selected) : native.driver.parseEvidence(value, selected),
      plan: async input => { await verifyRemoved(input.signal); return driver.plan(input); },
      inspect: async input => { await verifyRemoved(input.signal); return driver.inspect(input); },
      mutate: async input => { await verifyRemoved(input.signal); return driver.mutate(input); },
      recover: async input => { await verifyRemoved(input.signal); return driver.recover(input); },
    } };
  } else connection = targets ? await capability.retirement!.create(intent.nativeScope, local, targets) : await capability.create(intent.nativeScope, local);
  return { ...connection, store: journal(project, environment, name),
    // Registration verifies multiple native identities and every selected output
    // before dispatch. Keep a bounded outer budget above each 30s provider call.
    timeoutMs: 60_000,
    authorize: async input => {
      const fresh = new EnvironmentRepository().findById(environment.id);
      return !!fresh && fresh.projectId === project.id && fresh.name === environment.name && authorize() && isDeepStrictEqual(input.intent, intent)
        && (readOnly ? input.phase !== 'mutate' : await current(project, fresh, name, intent));
    } };
}
/** Project recorded completion only. Never return the provider's raw native
 * payload or reinterpret provider retention as permanent erasure. */
function retirementSummary(record: Registration) {
  try {
    return projectOperatorRetirement(record);
  } catch { throw new OperatorRetirementSelectionError('Recorded retirement outcomes could not be safely verified. Preserve the existing record and inspect its supported recovery; no new deletion was authorized.'); }
}
export type OperatorRetirementSummary = NonNullable<ReturnType<typeof retirementSummary>>;

function projection(record: Registration, name: string, mode: OperatorApplicationPlan['mode'], retryActions?: OperatorApplicationPlan['retryActions']) {
  const applicationRegistration: OperatorApplicationPlan = { schemaVersion: 1, name, installationId: record.installationId,
    planDigest: record.plan.digest, provider: record.intent.applicationProvider, mode, ...(retryActions ? { retryActions } : {}) };
  let originals = mode === 'recover' ? record.plan.actions.filter(action => record.attempts.some(attempt => attempt.actionId === action.id)
    || !!record.intent.retirement?.continueFrom && !!record.completed[action.id]) : record.plan.actions;
  if (retryActions) {
    if (mode !== 'prepare' && mode !== 'retire') throw operatorApplicationUnavailable();
    const included = new Set(retryActions.map(retry => retry.actionId));
    for (const id of included) {
      const action = record.plan.actions.find(action => action.id === id); if (!action) throw operatorApplicationUnavailable();
      for (const dependency of action.dependsOn ?? []) { if (!record.completed[dependency]) throw operatorApplicationUnavailable(); included.add(dependency); }
    }
    originals = originals.filter(action => included.has(action.id));
  }
  const actions: PlanAction[] = mode === 'verified' ? [] : originals.map(action => ({ ...action,
    ...(mode === 'recover' ? { type: 'update' as const, requiresConfirm: false, billable: false, dataBearing: false,
      reason: record.intent.retirement?.continueFrom ? 'Verify the exact output container is absent and finish removing only its retained local binding; do not repeat deletion.'
        : 'Read only the exact retained registration identity and operation; do not recreate or replay a credential exchange.' }
      : record.completed[action.id] ? { type: 'noop' as const, requiresConfirm: false, billable: false, dataBearing: false } : {}),
    metadata: { ...applicationRegistration, operation: OPERATOR_APPLICATION_OPERATION, nativeActionId: action.id } }));
  return { applicationRegistration, actions };
}
function projected(record: Registration, name: string, mode: OperatorApplicationPlan['mode'], environment: Environment, retryActions?: OperatorApplicationPlan['retryActions']) {
  const retirement = retirementSummary(record);
  return { ...projection(record, name, mode, retryActions), environment, review: record.plan.review, ...(retirement ? { retirement } : {}),
    warnings: [...record.plan.review.warnings, 'Operator application setup or retirement does not authorize customer installation, repository access or application deployment.'] };
}
function names(project: Project, environment: Environment) {
  return operatorApplicationJournalNames({ projectId: project.id, environmentId: environment.id, environmentName: environment.name });
}
export async function operatorApplicationWorkRequired(project: Project, environmentName: string, spec?: ProjectSpec): Promise<boolean> {
  const declared = Object.keys(spec?.environments[environmentName]?.operatorApplications ?? {});
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName); if (!environment) return !!declared.length;
  for (const name of new Set([...names(project, environment), ...declared])) {
    const record = acceptedJournalLeaf(await journal(project, environment, name).findByScope());
    const restartFrom = spec?.environments[environmentName]?.operatorApplications?.[name]?.restartFrom;
    if (restartFrom && !isDeepStrictEqual(record?.intent.predecessor, restartFrom)) return true;
    if (record?.status === 'retired') { if (!declared.includes(name) || spec?.environments[environmentName]?.operatorApplications?.[name]?.retirement) continue; return true; }
    if (record ? record.status !== 'scope-ready' : declared.includes(name)) return true;
  }
  return false;
}
/** Finished registration is not continuing deployment authority. Runtime
 * references are checked separately; an unfinished or changed setup still blocks. */
export async function assertOperatorApplicationsComplete(project: Project, environment: Environment, spec: ProjectSpec) {
  const declarations = spec.environments[environment.name]?.operatorApplications ?? {};
  const repository = normalizeGitRemoteIdentity(spec.gitRemoteUrl ?? project.gitRemoteUrl ?? undefined);
  for (const name of new Set([...names(project, environment), ...Object.keys(declarations)])) {
    const record = acceptedJournalLeaf(await journal(project, environment, name).findByScope());
    if (record?.status === 'retired' && !declarations[name]) continue;
    if (!record || !historicalInstallationEvidence(record) || record.intent.source.repository !== repository
      || declarations[name] && record.intent.selection?.declarationDigest !== canonicalJsonSha256(declarations[name]))
      throw operatorApplicationUnavailable();
  }
}
/** Explicit retirement is planned before setup prerequisites; completed setup
 * receipts remain historical and are never re-applied to obtain deletion access. */
export async function planOperatorApplicationRetirement(input: { project: Project; environmentName: string; specResult: SpecResult; options?: object }) {
  const declarations = input.specResult.spec.environments[input.environmentName]?.operatorApplications ?? {};
  const environment = new EnvironmentRepository().findByProjectAndName(input.project.id, input.environmentName);
  if (!environment) throw retirementUnavailable();
  if (input.options && ['serviceFilter', 'envVarOverrides', 'envFile', 'secretRefs'].some(key => Object.hasOwn(input.options!, key))
    || (input.options as { includeEnvFile?: boolean } | undefined)?.includeEnvFile === true) throw retirementUnavailable();
  let terminal: { record: Registration; name: string } | undefined;
  for (const name of Object.keys(declarations).sort()) {
    if (!declarations[name].retirement) continue;
    const selected = await retirementSelection(input.project, environment, name, input.specResult);
    const history = await journal(input.project, environment, name).findByScope();
    let record = history.find(item => item.intent.mode === 'retire' && isDeepStrictEqual(item.intent.selection, selected.proof)
      && isDeepStrictEqual(item.intent.retirement, selected.retirement) && item.intent.source.repository === selected.source.repository);
    if (!record) {
      const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: input.project.id, appId: input.project.id,
        environment: input.environmentName, source: selected.source, provider: selected.declaration.provider, applicationProvider: selected.declaration.provider,
        mode: 'retire', stage: 'scope-preparation', keys: [], execution: { kind: 'operator-application', authentication: 'local-operator' },
        selection: selected.proof, nativeScope: selected.nativeScope, predecessor: selected.predecessor, retirement: selected.retirement,
        ...(selected.retirement.continueFrom ? { outputs: selected.parent.intent.outputs } : {}) };
      record = await planCloudInstallationV1({ ...await context(input.project, environment, name, intent, false), intent });
    } else if (active(record) && record.status !== 'retired') {
      record = await reconcileCloudInstallationV1({ ...await context(input.project, environment, name, record.intent, true), installationId: record.installationId, planDigest: record.plan.digest });
    }
    if (record.status === 'retired') {
      if (record.intent.retirement?.continueFrom && record.intent.retirement.outputTargets!.some(target =>
        secretContainerBindings(environment.platformBindings.secretDestinationContainers)[target.key])) return projected(record, name, 'recover', environment);
      terminal = { record, name }; continue;
    }
    if (record.plan.blockedReason) throw retirementUnavailable();
    const pending = record.plan.actions.filter(action => !record!.completed[action.id]).map(action => record!.attempts.filter(attempt => attempt.actionId === action.id).at(-1)).filter(attempt => !!attempt);
    const retry = pending.length && pending.every(attempt => attempt.status === 'rejected')
      ? await reviewCloudInstallationRetryV1({ ...await context(input.project, environment, name, record.intent, false), installationId: record.installationId, planDigest: record.plan.digest }) : undefined;
    return projected(record, name, pending.length && !retry ? 'recover' : 'retire', environment, retry?.retryActions);
  }
  return terminal ? projected(terminal.record, terminal.name, 'retire', environment) : undefined;
}

export async function planOperatorApplications(input: { project: Project; environmentName: string; specResult: SpecResult; options?: object }) {
  const declaration = input.specResult.spec.environments[input.environmentName]?.operatorApplications ?? {};
  if (Object.values(declaration).some(item => item.retirement)) return planOperatorApplicationRetirement(input);
  const environment = new EnvironmentRepository().findByProjectAndName(input.project.id, input.environmentName);
  if (!environment) { if (Object.keys(declaration).length) throw operatorApplicationUnavailable(); return undefined; }
  const histories = new Map<string, Registration[]>();
  for (const name of new Set([...names(input.project, environment), ...Object.keys(declaration)])) histories.set(name, await journal(input.project, environment, name).findByScope());
  const priority = (name: string) => { const record = acceptedJournalLeaf(histories.get(name)!); return record ? record.status === 'scope-ready' ? 1 : 0 : 2; };
  for (const name of [...histories.keys()].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))) {
    const history = histories.get(name)!; let record = acceptedJournalLeaf(history);
    if (record?.status === 'retired') { if (declaration[name]) throw retirementUnavailable(); continue; }
    if (record) record = await reconcileCloudInstallationV1({ ...await context(input.project, environment, name, record.intent, true), installationId: record.installationId, planDigest: record.plan.digest });
    let selected: Awaited<ReturnType<typeof selection>> | undefined;
    try { if (declaration[name]) selected = await selection(input.project, environment, name, input.specResult); }
    catch { if (!record || record.status === 'scope-ready') throw operatorApplicationUnavailable(); }
    const matches = selected && record?.intent.applicationProvider === selected.declaration.provider && record.intent.source.repository === selected.source.repository
      && isDeepStrictEqual(record.intent.selection, selected.proof);
    const makeIntent = (predecessor?: OperatorApplicationIntent['predecessor']): OperatorApplicationIntent => {
      if (!selected) throw operatorApplicationUnavailable();
      return { schemaVersion: 1, installationId: randomUUID(), customerId: input.project.id, appId: input.project.id,
        environment: input.environmentName, source: selected.source, provider: selected.declaration.provider, applicationProvider: selected.declaration.provider,
        mode: 'connect', stage: 'scope-preparation', keys: [], execution: { kind: 'operator-application', authentication: 'local-operator' },
        selection: selected.proof, nativeScope: selected.nativeScope, ...(selected.outputs ? { outputs: selected.outputs } : {}), ...(predecessor ? { predecessor } : {}) };
    };
    let successor: OperatorApplicationIntent | undefined;
    if (selected?.declaration.restartFrom && !(matches && isDeepStrictEqual(record?.intent.predecessor, selected.declaration.restartFrom))) {
      successor = makeIntent(selected.declaration.restartFrom);
      if (!record || historicalRegistrations(record, history).length + 1 >= CLOUD_SCOPE_PREPARATION_LINEAGE_LIMIT
        || !restartEligible(record, successor, environment)) throw operatorApplicationUnavailable();
      record = undefined;
    }
    if (record?.reason === 'authorization_expired') throw new CloudInstallationError('authorization_expired');
    if (record && !matches) {
      if (record.status !== 'scope-ready') return projected(record, name, 'recover', environment);
      // A completed identity cannot be silently replaced or adopted on changed declarations.
      if (selected) throw operatorApplicationUnavailable();
      continue;
    }
    if (!selected) continue;
    if (record?.status === 'scope-ready') continue;
    if (input.options && ['serviceFilter', 'envVarOverrides', 'envFile', 'includeEnvFile', 'secretRefs'].some(key => Object.hasOwn(input.options!, key))) throw operatorApplicationUnavailable();
    if (!record) {
      record = history.find(candidate => !active(candidate) && isDeepStrictEqual(candidate.intent.source, selected!.source) && isDeepStrictEqual(candidate.intent.selection, selected!.proof)
        && isDeepStrictEqual(candidate.intent.predecessor, successor?.predecessor));
      if (!record) {
        const intent = successor ?? makeIntent();
        record = await planCloudInstallationV1({ ...await context(input.project, environment, name, intent, false), intent });
      }
    }
    if (record.plan.blockedReason && !active(record)) throw operatorApplicationUnavailable();
    const pending = record.plan.actions.filter(action => !record!.completed[action.id]).map(action => record!.attempts.filter(attempt => attempt.actionId === action.id).at(-1)).filter(attempt => !!attempt);
    const retry = pending.length && pending.every(attempt => attempt.status === 'rejected')
      ? await reviewCloudInstallationRetryV1({ ...await context(input.project, environment, name, record.intent, false), installationId: record.installationId, planDigest: record.plan.digest }) : undefined;
    return projected(record, name, retry ? 'prepare' : pending.length ? 'recover' : 'prepare', environment, retry?.retryActions);
  }
  return undefined;
}

/** Prepare declared output containers before credentials can be issued. Never bypass an active registration attempt. */
export async function operatorOutputPrerequisiteKeys(project: Project, environmentName: string, spec: ProjectSpec): Promise<string[]> {
  const declarations = spec.environments[environmentName]?.operatorApplications ?? {}, keys = [...new Set(Object.values(declarations).flatMap(item => Object.values(item.outputs ?? {})))];
  if (!keys.length) return [];
  const desired = spec.environments[environmentName], outputCapability = providerRegistry.getOperatorOutputDelivery(desired.hosting.provider);
  for (const declaration of Object.values(declarations)) {
    const capability = providerRegistry.getOperatorApplication(declaration.provider);
    if (!capability || !isDeepStrictEqual([...(capability.privateOutputRoles ?? [])].sort(), Object.keys(declaration.outputs ?? {}).sort())) throw operatorApplicationUnavailable();
  }
  if (!outputCapability || keys.some(key => !desired.secretDestinations?.[key]
    || !outputCapability.providers.includes(desired.secretDestinations[key].destination.provider))) throw operatorApplicationUnavailable();
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName); if (!environment) return keys;
  for (const name of new Set([...names(project, environment), ...Object.keys(declarations)])) {
    const record = acceptedJournalLeaf(await journal(project, environment, name).findByScope());
    if (record && active(record) && record.status !== 'scope-ready') return [];
  }
  const retained = secretContainerBindings(environment.platformBindings.secretDestinationContainers);
  return keys.some(key => retained[key]?.state !== 'ready') ? keys : [];
}
export async function applyOperatorApplications(input: { project: Project; environment: Environment; applicationRegistration: unknown; action: PlanAction; authorize(): boolean }): Promise<ActionResult> {
  try {
    const proof = operatorApplicationPlanSchema.parse(input.applicationRegistration), store = journal(input.project, input.environment, proof.name), record = await store.read(proof.installationId);
    if (!record || record.plan.digest !== proof.planDigest || record.intent.applicationProvider !== proof.provider || !isOperatorApplicationAction(input.action)
      || !projection(record, proof.name, proof.mode, proof.retryActions).actions.some(action => isDeepStrictEqual(action, input.action))) throw operatorApplicationUnavailable();
    const attempt = record.attempts.filter(value => value.actionId === input.action.id).at(-1);
    const retry = proof.retryActions?.find(value => value.actionId === input.action.id && value.attemptId === attempt?.id && attempt.status === 'rejected');
    const readOnly = !['prepare', 'retire'].includes(proof.mode) || !!attempt && !retry || input.action.type === 'noop';
    const target = { ...await context(input.project, input.environment, proof.name, record.intent, readOnly, input.authorize),
      installationId: record.installationId, planDigest: record.plan.digest, onlyActionId: input.action.id };
    if (proof.retryActions && !isDeepStrictEqual((await reviewCloudInstallationRetryV1(target)).retryActions, proof.retryActions)) throw operatorApplicationUnavailable();
    const bindingSnapshot = input.environment.platformBindings;
    const updated = readOnly ? await reconcileCloudInstallationV1(target) : await applyCloudInstallationV1({ ...target, confirmActions: [input.action.id], ...(retry ? { retryActions: [retry] } : {}) });
    if (updated.status === 'retired' && updated.intent.retirement?.continueFrom) {
      if (!await current(input.project, input.environment, proof.name, updated.intent)) throw retirementUnavailable();
      for (const action of updated.plan.actions) {
        const observed = await target.driver.inspect({ intent: structuredClone(updated.intent), authentication: target.authentication,
          signal: AbortSignal.timeout(60_000), completed: structuredClone(updated.completed), attempts: structuredClone(updated.attempts), action,
          beforeMutation: async () => { throw retirementUnavailable(); } });
        if (observed.state !== 'satisfied' || !isDeepStrictEqual(observed.evidence, updated.completed[action.id])) throw retirementUnavailable();
      }
      const outputs = operatorOutputSelectionSchema.parse(updated.intent.outputs), bindings = secretContainerBindings(bindingSnapshot.secretDestinationContainers);
      for (const selected of updated.intent.retirement.outputTargets!) {
        const output = outputs.destinations.find(item => item.key === selected.key)!;
        if (bindings[selected.key] !== undefined && !isDeepStrictEqual(bindings[selected.key], output.binding)) throw retirementUnavailable();
        delete bindings[selected.key];
      }
      if (!new EnvironmentRepository().compareAndSwapPlatformBindings(input.environment.id, bindingSnapshot,
        { ...bindingSnapshot, secretDestinationContainers: bindings })) throw retirementUnavailable();
    }
    const browserHandoff = target.driver.operatorApplication?.pendingBrowser && await current(input.project, input.environment, proof.name, updated.intent)
      ? await target.driver.operatorApplication.pendingBrowser(updated) : undefined;
    const success = updated.status === 'retired' || updated.status === 'scope-ready' || updated.status === 'pending' && !updated.reason && !!updated.completed[input.action.id];
    const historical = updated.intent.predecessor ? historicalRegistrations(updated, await store.findByScope()) : [];
    const retirement = retirementSummary(updated);
    return { success, ...(success ? {} : { status: updated.status === 'pending' ? 'pending' as const : 'blocked' as const }),
      message: success ? updated.intent.mode === 'retire' ? 'Verified the exact operator retirement action; retained native data and history remain recorded.' : 'Verified the exact operator registration action; customer access and deployment remain separate.'
        : browserHandoff && updated.intent.mode === 'retire' ? 'Open the saved browser link and follow the exact registration review. Deletion remains unverified; private values and history are preserved, and dependent cleanup stays blocked.'
        : operatorApplicationUnavailable().message,
      data: { installationId: updated.installationId, status: updated.status, ...(updated.reason ? { reason: updated.reason } : {}),
        ...(retirement ? { retirement } : {}),
        ...(historical.length ? { historicalRegistrations: historical } : {}),
        ...(browserHandoff ? { browserHandoff } : {}),
        ...(updated.status === 'scope-ready' ? { receipts: providerRegistry.getOperatorApplication(proof.provider)!.receipts(updated) } : {}) } };
  } catch { return { success: false, status: 'blocked', message: operatorApplicationUnavailable().message }; }
}

/** Refresh only retained native identities; never create a plan or consume a browser code. */
export async function inspectOperatorApplications(project: Project, environmentName: string, spec?: ProjectSpec) {
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName); if (!environment) return undefined;
  const declared = Object.keys(spec?.environments[environmentName]?.operatorApplications ?? {});
  const registrations: Array<Record<string, unknown>> = [];
  for (const name of new Set([...names(project, environment), ...declared])) {
    const history = await journal(project, environment, name).findByScope(); let record = acceptedJournalLeaf(history) ?? history.at(-1);
    if (!record) { registrations.push({ name, status: 'review-required', verified: false }); continue; }
    const target = active(record) && record.status !== 'retired' ? await context(project, environment, name, record.intent, true) : undefined;
    if (target) record = await reconcileCloudInstallationV1({ ...target, installationId: record.installationId, planDigest: record.plan.digest });
    const verified = record.status === 'scope-ready' && (!declared.includes(name) || await current(project, environment, name, record.intent));
    const browserHandoff = target?.driver.operatorApplication?.pendingBrowser && await current(project, environment, name, record.intent)
      ? await target.driver.operatorApplication.pendingBrowser(record) : undefined;
    const restart = restartGuidance(record, environment, history);
    const retirement = retirementSummary(record);
    registrations.push({ name, installationId: record.installationId, status: record.status, verified,
      ...(retirement ? { retirement } : {}),
      ...(record.intent.predecessor ? { historicalRegistrations: historicalRegistrations(record, history) } : {}),
      ...(restart ? { restart } : {}),
      ...(browserHandoff ? { browserHandoff } : {}),
      ...(record.reason ? { reason: record.reason } : {}), ...(verified ? { receipts: providerRegistry.getOperatorApplication(record.intent.applicationProvider)!.receipts(record) } : {}) });
  }
  if (!registrations.length) return undefined;
  return { scope: 'operator-applications', environment: environmentName, verified: registrations.every(item => item.verified === true), hostingReady: false, registrations };
}

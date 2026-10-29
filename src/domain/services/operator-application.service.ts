import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudScopePreparationRepository, acceptedJournalLeaf, operatorApplicationJournalNames } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { normalizeGitRemoteIdentity } from '../../lib/git-remote.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import type { CloudInstallationContext, CloudInstallationRecord, OperatorApplicationIntent } from '../ports/cloud-installation.port.js';
import { OPERATOR_APPLICATION_OPERATION, isOperatorApplicationAction, operatorApplicationPlanSchema, type OperatorApplicationPlan } from '../ports/operator-application.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { SpecStore, type SpecResult } from '../spec/spec.store.js';
import { CloudInstallationError, applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from './cloud-installation-runtime.js';
import { verifiedLocalHoldingReceipt } from './local-holding-preparation.service.js';
import { assertReadySecretContainers } from './secret-container-setup.js';
import { operatorOutputSelectionSchema } from '../ports/operator-output.port.js';
import { secretContainerBindings } from '../ports/secret-destination-lifecycle.port.js';
type Registration = CloudInstallationRecord<OperatorApplicationIntent>;
const route = z.object({ intent: z.object({ applicationProvider: z.string() }).passthrough() }).passthrough();
export const operatorApplicationUnavailable = () => new Error('Operator application registration requires its verified native origin, exact owner/source and retained operation. Preserve uncertain attempts; no replacement registration or credential replay is authorized.');
const active = (record: Registration) => record.attempts.length > 0 || Object.keys(record.completed).length > 0;
function journal(project: Project, environment: Environment, name: string) {
  return new CloudScopePreparationRepository<Registration>({ projectId: project.id, environmentId: environment.id, environmentName: environment.name }, value => {
    const capability = providerRegistry.getOperatorApplication(route.parse(value).intent.applicationProvider);
    if (!capability) throw operatorApplicationUnavailable(); return capability.parseRecord(value);
  }, { recordType: `operator-applications:${name}` });
}
function source(project: Project, result: SpecResult): OperatorApplicationIntent['source'] {
  const repository = normalizeGitRemoteIdentity(result.spec.gitRemoteUrl ?? project.gitRemoteUrl ?? undefined);
  if (!repository) throw operatorApplicationUnavailable();
  return { kind: 'local-spec', repository, specRevision: result.revision, specDigest: canonicalJsonSha256(result.spec) };
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
    const selected = await selection(freshProject, fresh, name, result);
    return selected.declaration.provider === intent.applicationProvider && selected.source.repository === intent.source.repository
      && isDeepStrictEqual(selected.proof, intent.selection) && isDeepStrictEqual(selected.nativeScope, intent.nativeScope);
  } catch { return false; }
}
async function context(project: Project, environment: Environment, name: string, intent: OperatorApplicationIntent, readOnly: boolean,
  authorize: () => boolean = () => true): Promise<CloudInstallationContext<OperatorApplicationIntent>> {
  const capability = providerRegistry.getOperatorApplication(intent.applicationProvider);
  if (!capability || intent.customerId !== project.id || intent.appId !== project.id || intent.environment !== environment.name) throw operatorApplicationUnavailable();
  return { ...await capability.create(intent.nativeScope, { projectId: project.id, environmentId: environment.id,
    installationId: intent.installationId, intentDigest: canonicalJsonSha256(intent), authorizeCurrent: () => current(project, environment, name, intent) }), store: journal(project, environment, name),
    authorize: async input => {
      const fresh = new EnvironmentRepository().findById(environment.id);
      return !!fresh && fresh.projectId === project.id && fresh.name === environment.name && authorize() && isDeepStrictEqual(input.intent, intent)
        && (readOnly ? input.phase !== 'mutate' : await current(project, fresh, name, intent));
    } };
}
function projection(record: Registration, name: string, mode: OperatorApplicationPlan['mode'], retryActions?: OperatorApplicationPlan['retryActions']) {
  const applicationRegistration: OperatorApplicationPlan = { schemaVersion: 1, name, installationId: record.installationId,
    planDigest: record.plan.digest, provider: record.intent.applicationProvider, mode, ...(retryActions ? { retryActions } : {}) };
  let originals = mode === 'recover' ? record.plan.actions.filter(action => record.attempts.some(attempt => attempt.actionId === action.id)) : record.plan.actions;
  if (retryActions) {
    if (mode !== 'prepare') throw operatorApplicationUnavailable();
    const included = new Set(retryActions.map(retry => retry.actionId));
    for (const id of included) {
      const action = record.plan.actions.find(action => action.id === id); if (!action) throw operatorApplicationUnavailable();
      for (const dependency of action.dependsOn ?? []) { if (!record.completed[dependency]) throw operatorApplicationUnavailable(); included.add(dependency); }
    }
    originals = originals.filter(action => included.has(action.id));
  }
  const actions: PlanAction[] = mode === 'verified' ? [] : originals.map(action => ({ ...action,
    ...(mode === 'recover' ? { type: 'update' as const, requiresConfirm: false, billable: false, dataBearing: false,
      reason: 'Read only the exact retained registration identity and operation; do not recreate or replay a credential exchange.' }
      : record.completed[action.id] ? { type: 'noop' as const, requiresConfirm: false, billable: false, dataBearing: false } : {}),
    metadata: { ...applicationRegistration, operation: OPERATOR_APPLICATION_OPERATION, nativeActionId: action.id } }));
  return { applicationRegistration, actions };
}
function projected(record: Registration, name: string, mode: OperatorApplicationPlan['mode'], environment: Environment, retryActions?: OperatorApplicationPlan['retryActions']) {
  return { ...projection(record, name, mode, retryActions), environment, review: record.plan.review,
    warnings: [...record.plan.review.warnings, 'Operator application registration does not authorize customer installation, repository access or application deployment.'] };
}
function names(project: Project, environment: Environment) {
  return operatorApplicationJournalNames({ projectId: project.id, environmentId: environment.id, environmentName: environment.name });
}
export async function operatorApplicationWorkRequired(project: Project, environmentName: string, spec?: ProjectSpec): Promise<boolean> {
  const declared = Object.keys(spec?.environments[environmentName]?.operatorApplications ?? {});
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName); if (!environment) return !!declared.length;
  for (const name of new Set([...names(project, environment), ...declared])) {
    const record = acceptedJournalLeaf(await journal(project, environment, name).findByScope());
    if (record ? record.status !== 'scope-ready' : declared.includes(name)) return true;
  }
  return false;
}
export async function planOperatorApplications(input: { project: Project; environmentName: string; specResult: SpecResult; options?: object }) {
  const declaration = input.specResult.spec.environments[input.environmentName]?.operatorApplications ?? {};
  const environment = new EnvironmentRepository().findByProjectAndName(input.project.id, input.environmentName);
  if (!environment) { if (Object.keys(declaration).length) throw operatorApplicationUnavailable(); return undefined; }
  const histories = new Map<string, Registration[]>();
  for (const name of new Set([...names(input.project, environment), ...Object.keys(declaration)])) histories.set(name, await journal(input.project, environment, name).findByScope());
  const priority = (name: string) => { const record = acceptedJournalLeaf(histories.get(name)!); return record ? record.status === 'scope-ready' ? 1 : 0 : 2; };
  for (const name of [...histories.keys()].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))) {
    const history = histories.get(name)!; let record = acceptedJournalLeaf(history);
    if (record) record = await reconcileCloudInstallationV1({ ...await context(input.project, environment, name, record.intent, true), installationId: record.installationId, planDigest: record.plan.digest });
    if (record?.reason === 'authorization_expired') throw new CloudInstallationError('authorization_expired');
    let selected: Awaited<ReturnType<typeof selection>> | undefined;
    try { if (declaration[name]) selected = await selection(input.project, environment, name, input.specResult); }
    catch { if (!record || record.status === 'scope-ready') throw operatorApplicationUnavailable(); }
    const matches = selected && record?.intent.applicationProvider === selected.declaration.provider && record.intent.source.repository === selected.source.repository
      && isDeepStrictEqual(record.intent.selection, selected.proof);
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
      record = history.find(candidate => !active(candidate) && isDeepStrictEqual(candidate.intent.source, selected!.source) && isDeepStrictEqual(candidate.intent.selection, selected!.proof));
      if (!record) {
        const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: input.project.id, appId: input.project.id,
          environment: input.environmentName, source: selected.source, provider: selected.declaration.provider, applicationProvider: selected.declaration.provider,
          mode: 'connect', stage: 'scope-preparation', keys: [], execution: { kind: 'operator-application', authentication: 'local-operator' },
          selection: selected.proof, nativeScope: selected.nativeScope };
        if (selected.outputs) intent.outputs = selected.outputs;
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
    const readOnly = proof.mode !== 'prepare' || !!attempt && !retry;
    const target = { ...await context(input.project, input.environment, proof.name, record.intent, readOnly, input.authorize),
      installationId: record.installationId, planDigest: record.plan.digest, onlyActionId: input.action.id };
    if (proof.retryActions && !isDeepStrictEqual((await reviewCloudInstallationRetryV1(target)).retryActions, proof.retryActions)) throw operatorApplicationUnavailable();
    const updated = readOnly ? await reconcileCloudInstallationV1(target) : await applyCloudInstallationV1({ ...target, confirmActions: [input.action.id], ...(retry ? { retryActions: [retry] } : {}) });
    const browserHandoff = target.driver.operatorApplication?.pendingBrowser && await current(input.project, input.environment, proof.name, updated.intent)
      ? await target.driver.operatorApplication.pendingBrowser(updated) : undefined;
    const success = updated.status === 'scope-ready' || updated.status === 'pending' && !updated.reason && !!updated.completed[input.action.id];
    return { success, ...(success ? {} : { status: updated.status === 'pending' ? 'pending' as const : 'blocked' as const }),
      message: success ? 'Verified the exact operator registration action; customer access and deployment remain separate.' : operatorApplicationUnavailable().message,
      data: { installationId: updated.installationId, status: updated.status, ...(updated.reason ? { reason: updated.reason } : {}),
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
    const target = active(record) ? await context(project, environment, name, record.intent, true) : undefined;
    if (target) record = await reconcileCloudInstallationV1({ ...target, installationId: record.installationId, planDigest: record.plan.digest });
    const verified = record.status === 'scope-ready' && (!declared.includes(name) || await current(project, environment, name, record.intent));
    const browserHandoff = target?.driver.operatorApplication?.pendingBrowser && await current(project, environment, name, record.intent)
      ? await target.driver.operatorApplication.pendingBrowser(record) : undefined;
    registrations.push({ name, installationId: record.installationId, status: record.status, verified,
      ...(browserHandoff ? { browserHandoff } : {}),
      ...(record.reason ? { reason: record.reason } : {}), ...(verified ? { receipts: providerRegistry.getOperatorApplication(record.intent.applicationProvider)!.receipts(record) } : {}) });
  }
  if (!registrations.length) return undefined;
  return { scope: 'operator-applications', environment: environmentName, verified: registrations.every(item => item.verified === true), hostingReady: false, registrations };
}

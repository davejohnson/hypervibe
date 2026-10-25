import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudScopePreparationRepository } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
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
  return new CloudScopePreparationRepository<Record>({ projectId: project.id, environmentId: environment.id, environmentName: environment.name }, parseRecord);
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
    return Boolean(capability && isDeepStrictEqual(capability.parseScope(declaration.scopePreparation.nativeScope), intent.nativeScope));
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
    if (input.phase === 'mutate' && (mode !== 'allocate' || !emptyLocalScope(environment))) return false;
    return mode === 'recover' ? input.phase !== 'mutate' : sameCurrentSource(project, environment, intent);
  } };
}
function projection(record: Record, mode: LocalCloudScopePlan['mode']): { cloudScope: LocalCloudScopePlan; actions: PlanAction[] } {
  if (record.plan.actions.length !== 1) throw unavailable();
  const cloudScope: LocalCloudScopePlan = { schemaVersion: 1, installationId: record.installationId,
    installationPlanDigest: record.plan.digest, hostingProvider: record.intent.hostingProvider, mode };
  const original = record.plan.actions[0];
  const actions: PlanAction[] = mode === 'verified' ? [] : [{ ...original,
    ...(mode === 'recover' ? { type: 'update' as const, requiresConfirm: false, billable: false, dataBearing: false,
      reason: 'Read only the exact retained project allocation and its native operation; never repeat creation or adopt a replacement.' } : {}),
    metadata: { ...cloudScope, operation: LOCAL_CLOUD_SCOPE_OPERATION, nativeActionId: original.id } }];
  return { cloudScope, actions };
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
  const attempted = history.filter(record => record.attempts.length > 0);
  if (attempted.length > 1) throw unavailable();
  if (!attempted.length && !desired?.scopePreparation) return undefined;
  if (input.options && ['serviceFilter', 'envVarOverrides', 'envFile', 'includeEnvFile', 'secretRefs'].some(key => Object.hasOwn(input.options!, key)))
    throw new Error('Cloud project allocation is an isolated plan stage and accepts no deployment or credential-value inputs.');
  let record: Record | undefined = attempted[0];
  if (record) {
    // Historical intent wins over edits. This call is read-only at every native
    // boundary and cannot turn a changed source into new allocation authority.
    const execution = await context(project, environment, record.intent, 'recover');
    record = await reconcileCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest });
    if (record.status === 'scope-ready' && desired?.scopePreparation && (desired.provider !== record.intent.hostingProvider
      || !isDeepStrictEqual(providerRegistry.getLocalScopePreparation(desired.provider)?.parseScope(desired.scopePreparation.nativeScope), record.intent.nativeScope)))
      throw new Error('This environment already allocated a cloud project. Its accepted identity is retained; editing desired names does not authorize a replacement.');
    if (record.status === 'scope-ready' && !desired?.scopePreparation && !emptyLocalScope(environment)) return undefined;
  } else {
    const capability = providerRegistry.getLocalScopePreparation(desired!.provider);
    if (!capability || !desired?.scopePreparation || !emptyLocalScope(environment)) throw unavailable();
    const nativeScope = capability.parseScope(desired.scopePreparation.nativeScope);
    const currentSource = source(project, specResult);
    record = history.find(item => item.intent.hostingProvider === desired.provider
      && isDeepStrictEqual(item.intent.nativeScope, nativeScope) && isDeepStrictEqual(item.intent.source, currentSource));
    if (!record) {
      const nativeExecution = await capability.create(nativeScope);
      const intent: LocalCloudScopePreparationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id,
        appId: project.id, environment: environmentName, source: currentSource, provider: nativeExecution.driver.provider, hostingProvider: desired.provider,
        execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, mode: 'connect', stage: 'scope-preparation', keys: [], nativeScope };
      const execution = await context(project, environment, intent, 'allocate', undefined, nativeExecution);
      record = await planCloudInstallationV1({ ...execution, intent });
    }
  }
  if (record.plan.blockedReason && !record.attempts.length) throw unavailable();
  const mode = record.status === 'scope-ready' ? 'verified' : record.attempts.length ? 'recover' : 'allocate';
  return { ...projection(record, mode), environment, review: record.plan.review, warnings: [
    ...record.plan.review.warnings,
    ...record.plan.review.costs.map(item => item.description),
    'This stage allocates an empty cloud project only. Billing, API enablement, cloud connections and hosting are separate reviewed work.',
    'An allocated but unbound project remains in this isolated stage until a separate reviewed lifecycle handoff records its connection and binding; removing this declaration does not adopt it.',
    ...(record.reason ? [`The retained allocation reports ${record.reason}; recovery never repeats a creation request.`] : []),
  ] };
}

/** Pure local prerequisite detection; it neither adopts spec edits nor calls a provider. */
export async function localCloudScopeRequired(project: Project, environmentName: string, spec?: ProjectSpec): Promise<boolean> {
  if (spec?.environments[environmentName]?.hosting.scopePreparation) return true;
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
  const attempted = history.filter(record => record.attempts.length > 0);
  if (attempted.length > 1) throw unavailable();
  let record = attempted[0] ?? history.at(-1);
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
    if (input.action ? !isLocalCloudScopeAction(input.action) || !isDeepStrictEqual(input.action, expected.actions[0]) : proof.mode !== 'verified') throw unavailable();
    if (input.action) localCloudScopeActionMetadataSchema.parse(input.action.metadata);
    const readOnly = proof.mode !== 'allocate' || record.attempts.length > 0;
    const execution = await context(input.project, input.environment, record.intent, readOnly ? 'recover' : 'allocate', input.authorize);
    const updated = readOnly
      ? await reconcileCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest })
      : await applyCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [input.action!.id] });
    const complete = updated.status === 'scope-ready';
    return { success: complete, ...(complete ? {} : { status: updated.status === 'pending' ? 'pending' as const : 'blocked' as const }),
      message: complete ? 'Verified the exact empty project allocation. Billing and hosting have not been configured.'
        : 'The project allocation is unresolved. Retain its exact native operation for read-only recovery; no replacement was authorized.',
      data: { installationId: updated.installationId, status: updated.status, ...(updated.reason ? { reason: updated.reason } : {}),
        resources: Object.values(updated.completed).flatMap(value => value.resources) } };
  } catch { return { success: false, status: 'blocked', message: unavailable().message }; }
}

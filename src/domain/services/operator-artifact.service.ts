import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudScopePreparationRepository, acceptedJournalLeaf, operatorArtifactJournalNames } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { normalizeGitRemoteIdentity } from '../../lib/git-remote.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { CloudInstallationContext, CloudInstallationRecord, OperatorArtifactIntent } from '../ports/cloud-installation.port.js';
import { OPERATOR_ARTIFACT_OPERATION, isOperatorArtifactAction, operatorArtifactPlanSchema, type OperatorArtifactPlan } from '../ports/operator-artifact.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import { orderActions, type ActionResult } from '../plan/converge.executor.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { SpecStore, type SpecResult } from '../spec/spec.store.js';
import { applyCloudInstallationV1, historicalInstallationEvidence, planCloudInstallationV1, reconcileCloudInstallationV1 } from './cloud-installation-runtime.js';
type Record = CloudInstallationRecord<OperatorArtifactIntent>;
const routing = z.object({ intent: z.object({ artifactProvider: z.string().min(1) }).passthrough() }).passthrough();
const unavailable = () => new Error('Operator artifact publication could not be verified. Retain its exact plan, native operation and immutable receipts; no replacement or repeated upload is authorized.');
const active = (record: Record) => record.attempts.length > 0 || Object.keys(record.completed).length > 0;
function parseRecord(value: unknown): Record {
  const provider = routing.parse(value).intent.artifactProvider;
  const capability = providerRegistry.getArtifactPublication(provider);
  if (!capability) throw unavailable();
  const record = capability.parseRecord(value); if (record.intent.artifactProvider !== provider) throw unavailable(); return record;
}
function journal(project: Project, environment: Environment, name: string) {
  return new CloudScopePreparationRepository<Record>({ projectId: project.id, environmentId: environment.id, environmentName: environment.name }, parseRecord,
    { recordType: `operator-artifacts:${name}` });
}
function source(project: Project, result: SpecResult): OperatorArtifactIntent['source'] {
  const repository = normalizeGitRemoteIdentity(result.spec.gitRemoteUrl ?? project.gitRemoteUrl ?? undefined);
  if (!repository) throw unavailable();
  return { kind: 'local-spec', repository, specRevision: result.revision, specDigest: canonicalJsonSha256(result.spec) };
}
function selection(project: Project, environment: Environment, name: string, result: SpecResult) {
  const declaration = result.spec.environments[environment.name]?.operatorArtifacts?.[name];
  if (!declaration) throw unavailable();
  const capability = providerRegistry.getArtifactPublication(declaration.provider); if (!capability) throw unavailable();
  const nativeScope = capability.parseDeclaration(declaration.nativeScope, declaration.artifacts, environment.platformBindings);
  return { declaration, capability, nativeScope, source: source(project, result),
    proof: { declarationDigest: canonicalJsonSha256(declaration), nativeScopeDigest: canonicalJsonSha256(nativeScope),
      ...(declaration.refreshFrom ? { refreshFromDigest: canonicalJsonSha256(declaration.refreshFrom) } : {}) } };
}
function current(project: Project, environment: Environment, name: string, intent: OperatorArtifactIntent): boolean {
  try {
    const freshProject = new ProjectRepository().findById(project.id), freshEnvironment = new EnvironmentRepository().findById(environment.id);
    const result = freshProject && new SpecStore().getForInspection(freshProject);
    if (!freshProject || !freshEnvironment || freshEnvironment.projectId !== project.id || freshEnvironment.name !== intent.environment || !result) return false;
    const selected = selection(freshProject, freshEnvironment, name, result);
    return selected.declaration.provider === intent.artifactProvider && selected.source.repository === intent.source.repository
      && isDeepStrictEqual(selected.proof, intent.selection) && isDeepStrictEqual(selected.declaration.artifacts, intent.artifacts)
      && (!selected.declaration.refreshFrom || isDeepStrictEqual(selected.declaration.refreshFrom, intent.predecessor));
  } catch { return false; }
}
async function context(project: Project, environment: Environment, name: string, intent: OperatorArtifactIntent, readOnly: boolean,
  authorize: () => boolean = () => true): Promise<CloudInstallationContext<OperatorArtifactIntent>> {
  const capability = providerRegistry.getArtifactPublication(intent.artifactProvider);
  if (!capability || intent.customerId !== project.id || intent.appId !== project.id || intent.environment !== environment.name) throw unavailable();
  return { ...await capability.create(intent.nativeScope), store: journal(project, environment, name), timeoutMs: 600_000,
    authorize: async input => {
      const fresh = new EnvironmentRepository().findById(environment.id);
      if (!fresh || fresh.projectId !== project.id || fresh.name !== environment.name || !authorize() || !isDeepStrictEqual(input.intent, intent)
        || readOnly && input.phase === 'mutate' || !readOnly && !current(project, environment, name, intent)) return false;
      if (intent.predecessor) {
        const prior = await journal(project, environment, name).read(intent.predecessor.installationId);
        if (!prior || prior.plan.digest !== intent.predecessor.planDigest || prior.intent.artifactProvider !== intent.artifactProvider
          || prior.intent.source.repository !== intent.source.repository) return false;
        // Provider drivers verify inherited target lifetimes before every native
        // operation. Historical immutable predecessor proof never implies fresh
        // permission, nor requires public grants to remain during future cleanup.
        if (prior.status !== 'scope-ready') return false;
      }
      return true;
    } };
}
function projection(record: Record, name: string, mode: OperatorArtifactPlan['mode']) {
  const artifactPublication: OperatorArtifactPlan = { schemaVersion: 1, name, installationId: record.installationId,
    planDigest: record.plan.digest, provider: record.intent.artifactProvider, mode };
  const originals = mode === 'recover' ? record.plan.actions.filter(action => record.attempts.some(attempt => attempt.actionId === action.id)) : record.plan.actions;
  const actions: PlanAction[] = mode === 'verified' ? [] : originals.map(action => ({ ...action,
    ...(mode === 'recover' ? { type: 'update' as const, requiresConfirm: false, billable: false, dataBearing: false,
      reason: 'Read back the exact retained artifact operation and immutable content; never repeat an uncertain publication.' }
      : record.completed[action.id] ? { type: 'noop' as const, requiresConfirm: false, billable: false, dataBearing: false } : {}),
    metadata: { ...artifactPublication, operation: OPERATOR_ARTIFACT_OPERATION, nativeActionId: action.id } }));
  return { artifactPublication, actions };
}
function projected(record: Record, name: string, mode: OperatorArtifactPlan['mode'], environment: Environment) {
  return { ...projection(record, name, mode), environment, review: record.plan.review,
    warnings: [...record.plan.review.warnings, ...record.plan.review.costs.map(cost => cost.description),
      'Only these exact operator artifact actions are approved by this plan. Infrastructure, content publication and anonymous read access remain distinct.',
      ...(mode === 'recover' ? ['This retained operation is read-only. Removed or changed source declarations cannot authorize unstarted uploads, grants or replacement targets.'] : [])] };
}
function retainedNames(project: Project, environment: Environment) {
  return operatorArtifactJournalNames({ projectId: project.id, environmentId: environment.id, environmentName: environment.name });
}
/** Name matching selects a verification obligation, never mutation authority.
 * Unrelated CI/external images retain the ordinary partial-deployment path. */
export async function selectsOperatorImageTarget(project: Project, environment: Environment, images: string[]) {
  const targets = new Set<string>();
  for (const name of retainedNames(project, environment)) {
    const history = await journal(project, environment, name).findByScope();
    acceptedJournalLeaf(history); // Reject malformed or ambiguous ownership history.
    for (const record of history) for (const evidence of [ ...Object.values(record.completed),
      ...record.attempts.flatMap(attempt => attempt.status === 'succeeded' && attempt.evidence ? [attempt.evidence] : []) ])
      for (const resource of evidence.resources) if (resource.kind === 'image' && /@sha256:[a-f0-9]{64}$/.test(resource.id))
        targets.add(resource.id.split('@')[0]);
  }
  return images.length > 0 && images.every(image => targets.has(image.split('@')[0].replace(/:[^/:]+$/, '')));
}
/** Image-only updates consume exact immutable image receipts. Other completed
 * setup effects retain their current unknown/readiness state without cloud reads. */
export async function verifyOperatorArtifactImages(project: Project, environment: Environment, images: string[]) {
  const required = new Set(images), selected: Record[] = [];
  const repository = normalizeGitRemoteIdentity(project.gitRemoteUrl ?? undefined);
  for (const name of retainedNames(project, environment)) {
    const record = acceptedJournalLeaf(await journal(project, environment, name).findByScope());
    if (!record) continue;
    const historical = historicalInstallationEvidence(record);
    if (!historical || record.intent.source.repository !== repository) throw unavailable();
    const matches = Object.values(historical).flatMap(item => item.resources)
      .filter(resource => resource.kind === 'image' && required.has(resource.id));
    if (!matches.length) continue;
    selected.push(record);
    const fresh = await reconcileCloudInstallationV1({ ...await context(project, environment, name, record.intent, true),
      installationId: record.installationId, planDigest: record.plan.digest });
    if (fresh.status !== 'scope-ready') throw unavailable();
    for (const resource of Object.values(fresh.completed).flatMap(item => item.resources))
      if (resource.kind === 'image') required.delete(resource.id);
  }
  if (required.size || !selected.length) throw unavailable();
}
/** Narrow scopes cannot conceal accepted, unfinished publication work. */
export async function operatorArtifactWorkRequired(project: Project, environmentName: string): Promise<boolean> {
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
  if (!environment) return false;
  for (const name of retainedNames(project, environment)) {
    const record = acceptedJournalLeaf(await journal(project, environment, name).findByScope());
    if (record && record.status !== 'scope-ready') return true;
  }
  return false;
}
export async function planOperatorArtifacts(input: { project: Project; environmentName: string; specResult: SpecResult; options?: object }) {
  const declaration = input.specResult.spec.environments[input.environmentName]?.operatorArtifacts ?? {};
  let environment = new EnvironmentRepository().findByProjectAndName(input.project.id, input.environmentName);
  if (!environment && !Object.keys(declaration).length) return undefined;
  environment ??= new EnvironmentRepository().create({ projectId: input.project.id, name: input.environmentName,
    platformBindings: { provider: input.specResult.spec.environments[input.environmentName].hosting.provider } });
  const names = [...new Set([...retainedNames(input.project, environment), ...Object.keys(declaration)])];
  const histories = new Map<string, Record[]>();
  for (const name of names) histories.set(name, await journal(input.project, environment, name).findByScope());
  const priority = (name: string) => {
    const record = acceptedJournalLeaf(histories.get(name)!);
    return record ? record.status === 'scope-ready' ? 1 : 0 : 2;
  };
  // Renaming or adding a declaration cannot bypass an accepted uncertain write.
  names.sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
  for (const name of names) {
    const history = histories.get(name)!;
    let record = acceptedJournalLeaf(history);
    // Durable operations are admitted before parsing a possibly removed,
    // malformed or reassigned current declaration. Only readback is permitted.
    if (record) record = await reconcileCloudInstallationV1({ ...await context(input.project, environment, name, record.intent, true),
      installationId: record.installationId, planDigest: record.plan.digest });
    let selected: ReturnType<typeof selection> | undefined;
    try { if (declaration[name]) selected = selection(input.project, environment, name, input.specResult); }
    catch { if (!record || record.status === 'scope-ready') throw unavailable(); }
    if (record && record.status !== 'scope-ready' && (!selected || record.intent.source.repository !== selected.source.repository
      || !isDeepStrictEqual(record.intent.selection, selected.proof) || record.intent.artifactProvider !== selected.declaration.provider))
      return projected(record, name, 'recover', environment);
    if (!selected) continue;
    const refreshFrom = selected.declaration.refreshFrom;
    if (!record && refreshFrom) throw unavailable();
    let nextScope: { [key: string]: string } | undefined, predecessor: OperatorArtifactIntent['predecessor'];
    if (record?.status === 'scope-ready') {
      const changed = !isDeepStrictEqual(record.intent.selection, selected.proof) || !isDeepStrictEqual(record.intent.artifacts, selected.declaration.artifacts);
      if (record.intent.artifactProvider !== selected.declaration.provider) throw unavailable();
      if (refreshFrom && record.intent.source.repository !== selected.source.repository) throw unavailable();
      // A completed successor consumes its exact marker. A new refresh must
      // name the current accepted receipt; an ancestor or removed marker must
      // not become an implicit publication through declaration drift.
      if (refreshFrom && !(!changed && isDeepStrictEqual(record.intent.predecessor, refreshFrom))) {
        if (!isDeepStrictEqual(refreshFrom, { installationId: record.installationId, planDigest: record.plan.digest })) throw unavailable();
      } else if (!refreshFrom && record.intent.selection?.refreshFromDigest) throw unavailable();
      const next = changed ? selected.capability.refreshScope?.(record, selected.nativeScope, selected.declaration.artifacts) : selected.capability.nextScope(record);
      if (changed && !next) throw unavailable();
      if (!next) continue;
      nextScope = next; predecessor = { installationId: record.installationId, planDigest: record.plan.digest }; record = undefined;
    } else if (!record) nextScope = selected.nativeScope;
    if (input.options && ['serviceFilter', 'envVarOverrides', 'envFile', 'includeEnvFile', 'secretRefs'].some(key => Object.hasOwn(input.options!, key))) throw unavailable();
    if (!record) {
      // An unrelated spec revision does not replace already prepared content.
      // Current declaration/native scope and the fresh outer plan still govern
      // authority; retain the original immutable intent and reject ambiguity.
      const proposals = history.filter(candidate => !active(candidate) && candidate.intent.source.repository === selected!.source.repository
        && isDeepStrictEqual(candidate.intent.selection, selected!.proof) && isDeepStrictEqual(candidate.intent.predecessor, predecessor));
      if (proposals.length > 1) throw unavailable();
      record = proposals[0];
      if (!record) {
        if (!nextScope) throw unavailable();
        const nativeScope = selected.capability.prepare ? await selected.capability.prepare(nextScope, selected.declaration.artifacts, selected.source) : nextScope;
        const native = await selected.capability.create(nativeScope);
        const intent: OperatorArtifactIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: input.project.id, appId: input.project.id,
          environment: input.environmentName, source: selected.source, provider: native.driver.provider, mode: 'connect', stage: 'scope-preparation', keys: [],
          execution: { kind: 'operator-artifact-publisher', authentication: native.driver.artifactPublication!.authentication }, artifactProvider: selected.declaration.provider,
          artifacts: selected.declaration.artifacts, selection: selected.proof, nativeScope, ...(predecessor ? { predecessor } : {}) };
        record = await planCloudInstallationV1({ ...await context(input.project, environment, name, intent, false), intent });
      }
    }
    if (record.plan.blockedReason && !active(record)) throw unavailable();
    const mode = record.status === 'scope-ready' ? 'verified' : record.attempts.some(attempt => !record!.completed[attempt.actionId]) ? 'recover' : 'prepare';
    return projected(record, name, mode, environment);
  }
  return undefined;
}
export async function applyOperatorArtifacts(input: { project: Project; environment: Environment; artifactPublication: unknown;
  action?: PlanAction; authorize: () => boolean }): Promise<ActionResult> {
  try {
    const proof = operatorArtifactPlanSchema.parse(input.artifactPublication), store = journal(input.project, input.environment, proof.name);
    const record = await store.read(proof.installationId);
    if (!record || record.plan.digest !== proof.planDigest || record.intent.artifactProvider !== proof.provider) throw unavailable();
    const expected = projection(record, proof.name, proof.mode);
    if (input.action ? !isOperatorArtifactAction(input.action) || !expected.actions.some(action => isDeepStrictEqual(action, input.action)) : proof.mode !== 'verified') throw unavailable();
    const readOnly = proof.mode !== 'prepare' || record.attempts.some(attempt => attempt.actionId === input.action?.id);
    const execution = await context(input.project, input.environment, proof.name, record.intent, readOnly, input.authorize);
    // The outer executor skips noops. Re-observe inherited artifact evidence
    // before its dependent action; never synthesize completion or replay a write.
    if (!readOnly) for (const noop of orderActions(record.plan.actions).filter(action => action.type === 'noop' && !record.completed[action.id])) {
      const verified = await reconcileCloudInstallationV1({ ...execution, installationId: record.installationId, planDigest: record.plan.digest,
        onlyActionId: noop.id, authorize: async authorization => authorization.phase !== 'mutate' && execution.authorize(authorization) });
      if (!verified.completed[noop.id] || verified.reason) throw unavailable();
    }
    const target = { ...execution, installationId: record.installationId, planDigest: record.plan.digest, ...(input.action ? { onlyActionId: input.action.id } : {}) };
    const updated = readOnly ? await reconcileCloudInstallationV1(target) : await applyCloudInstallationV1({ ...target, confirmActions: [input.action!.id] });
    const success = updated.status === 'scope-ready' || updated.status === 'pending' && !updated.reason && Boolean(input.action && updated.completed[input.action.id]);
    const capability = providerRegistry.getArtifactPublication(proof.provider)!;
    return { success, ...(success ? {} : { status: updated.status === 'pending' ? 'pending' as const : 'blocked' as const }),
      message: success ? 'Verified this exact operator artifact action; retained only immutable publication references and nonsecret proof.' : unavailable().message,
      data: { installationId: updated.installationId, status: updated.status,
        ...(updated.status === 'scope-ready' ? { receipts: capability.receipts(updated) } : {}), ...(updated.reason ? { reason: updated.reason } : {}) } };
  } catch { return { success: false, status: 'blocked', message: unavailable().message }; }
}

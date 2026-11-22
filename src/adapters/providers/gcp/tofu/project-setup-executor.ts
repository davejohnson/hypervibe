import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ensureEngineBinary, enginePluginCacheDir } from '../../../engine/opentofu/install.js';
import { OpenTofuEngine, type EnginePlanResult, type EngineStepFailure } from '../../../engine/opentofu/engine.js';
import { configurationDigest, engineStatePaths, ensureEngineStateDirectories, fileDigest, type EngineStatePaths } from '../../../engine/opentofu/workspace.js';
import { getSecretStore } from '../../../secrets/secret-store.js';
import { preserveSetupReport, saveSetupReport, setupPlansDirectory } from '../../../storage/gcp-setup-report.js';
import { readReviewApproval, recordSetupReviewExecution, reviewDigest, setupDataDigest as digest } from '../../../storage/review-authorization.js';
import type { PlanReport } from '../../../../domain/plan/plan-report.js';
import { getDataDir, hardenPrivateFile } from '../../../storage/paths.js';
import type { EngineAuthentication, EngineConfiguration, EngineStateIdentity, InfrastructureEngineBackend } from '../../../../domain/ports/infrastructure-engine.port.js';
import { engineSegmentOf } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { PlanAction } from '../../../../domain/plan/plan.types.js';
import {
  bootstrapProjectAddress, isInPlaceBillingUpdate, matchesProjectInstance, matchesRecoveryObservation, selectedProjectBilling, soleProjectAction, verifyBootstrapBillingPlan,
  type GcpProjectRecovery, type ObservedLinkedProject, type ObservedUnlinkedProject, type RecoveryBinding,
} from './project-state-recovery.js';

import { assertIsolationReview, assertOriginalIsolationOwners, hasDeposedIsolationGrant, isolationGrants, isolationRecoveryRequired, isIsolationContribution, matchesIsolationState, retainedIsolations,
  verifyIsolationPlan, type TransferIsolationEvidence } from './transfer-isolation.js';
import { matchesBucketCopyActions, reviewedBucketJob, type TransferBucketJobReview } from './bucket-copy-review.js';
import { matchesTransferBucketJobState, verifyTransferBucketJobPlan, type TransferBucketJobEvidence } from './transfer-bucket-job.js';
import type { TransferSlotEvidence } from '../gcp-transfer-slot-evidence.js';
import { transferSlot, verifyTransferSlotPlan, matchesTransferState, type TransferSlotReview } from './transfer-slot.js';

export interface GcpProjectSetupContribution { id: string; configuration: EngineConfiguration }
export interface GcpProjectSetupParams {
  projectId: string;
  projectName?: string;
  gcpProjectId: string;
  auth: EngineAuthentication;
  /** Stable, non-secret identity of the account granting this access. */
  authenticationScope?: string;
  contribution: GcpProjectSetupContribution;
  confirm?: boolean;
  /** Current Google metadata and the exact transfer pair selected for empty-slot setup. */
  transferSlotReview?: TransferSlotReview;
  /** Re-read the empty secret, its policy and the enabled account after native apply. */
  observeTransferAfterApply?: () => Promise<TransferSlotEvidence>;
  transferBucketJobReview?: TransferBucketJobReview;
  observeBucketJobAfterApply?: () => Promise<TransferBucketJobEvidence>;
  transferIsolationReview?: TransferIsolationEvidence;
  observeIsolationAfterApply?: () => Promise<TransferIsolationEvidence>;
  dataDir?: string;
  /** Explicitly reviewed removals/imports; never inferred from engine output. */
  allowDestroyAddresses?: string[];
  /** Grants whose access condition this contribution owns: a changed condition replaces the grant. */
  allowReplaceAddresses?: string[];
  allowImportAddresses?: string[];
  /** Fresh provider observations proved these resources exist; creation cannot repair missing state. */
  existingResourceAddresses?: string[];
  /** Fresh Resource Manager ACTIVE and Billing API unlinked observations for this exact project. */
  observedUnlinkedProject?: ObservedUnlinkedProject;
  observedLinkedProject?: ObservedLinkedProject;
  /** Authorizes only the reviewed local state repair during a new preview. */
  recoverProjectState?: string;
  /** Exact saved setup plan approved for cloud changes. */
  gcpSetupPlanId?: string;
  requireBrowserApproval?: boolean;
  reviewAfterVerification?: boolean;
  bootstrapConnection?: PlanReport['bootstrapConnection'];
  ciReleaseAccess?: PlanReport['ciReleaseAccess'];
}
export interface GcpProjectSetupResult {
  success: boolean;
  mode: 'preview' | 'confirm';
  planId?: string;
  htmlPath?: string;
  /** The owning workflow records its terminal state after verifying connections. */
  finishReview?: (outcome: 'applied' | 'failed') => boolean;
  actions?: PlanAction[];
  error?: string;
  projectRecovery?: GcpProjectRecovery;
  requiresPlanId?: true;
}
interface SetupManifest { contributions: Record<string, EngineConfiguration> }
interface SetupPreview {
  planId: string; baseline: string; intent: string; planned: EnginePlanResult;
  reviewContributionId?: string;
  setupPurpose?: PlanReport['setupPurpose'];
  bucketCopy?: PlanReport['bucketCopy'];
  manifest: SetupManifest; configuration: EngineConfiguration;
  createdAt?: string; projectName?: string;
  bootstrapConnection?: PlanReport['bootstrapConnection'];
  ciReleaseAccess?: PlanReport['ciReleaseAccess'];
  requiresPlanId?: true;
  observedUnlinkedProject?: ObservedUnlinkedProject;
  observedLinkedProject?: ObservedLinkedProject;
}
export interface GcpProjectSetupDependencies {
  engine: Pick<OpenTofuEngine, 'plan' | 'apply'> & Partial<Pick<OpenTofuEngine, 'inspectState' | 'recoverTaintedResource'>>;
}
export function hasGcpProjectSetup(projectId: string, gcpProjectId: string, dataDir?: string): boolean {
  const paths = engineStatePaths({ provider: 'gcp', projectId, environmentId: gcpProjectId, partition: 'project-shared' }, dataDir);
  return fs.existsSync(path.join(paths.root, 'setup-manifest.json'));
}
export function getGcpProjectSetupContribution(projectId: string, gcpProjectId: string, id: string, dataDir?: string): EngineConfiguration | undefined {
  const paths = engineStatePaths({ provider: 'gcp', projectId, environmentId: gcpProjectId, partition: 'project-shared' }, dataDir);
  return readJson<SetupManifest>(path.join(paths.root, 'setup-manifest.json'), { contributions: {} }).contributions[id];
}
export function getGcpProjectSetupContributions(projectId: string, gcpProjectId: string, dataDir?: string): Record<string, EngineConfiguration> {
  const paths = engineStatePaths({ provider: 'gcp', projectId, environmentId: gcpProjectId, partition: 'project-shared' }, dataDir);
  return readJson<SetupManifest>(path.join(paths.root, 'setup-manifest.json'), { contributions: {} }).contributions;
}
export function getGcpRuntimeIsolation(projectId: string, gcpProjectId: string, runtimeEmail: string, dataDir?: string) {
  return retainedIsolations(getGcpProjectSetupContributions(projectId, gcpProjectId, dataDir), gcpProjectId)
    .find(scope => scope.runtimeEmail === runtimeEmail);
}
function readJson<T>(file: string, fallback: T): T {
  if (!hardenPrivateFile(file)) return fallback;
  const content = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(content) as T; }
  catch { throw new Error('The saved Google Cloud setup data could not be read.'); }
}
function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function boundBaseline(manifest: SetupManifest): string { return 'project-recovery-v1:' + digest(manifest); }

/** An existing preview may carry the original recovery identity on its intent.
 * Find it even when a subsequent request selects a different billing account. */
function recoveryBinding(paths: EngineStatePaths, marker: string, projectId: string): RecoveryBinding | undefined {
  const stored = readJson<RecoveryBinding | undefined>(marker, undefined);
  if (stored !== undefined) {
    if (!stored || stored.projectId !== projectId || typeof stored.projectNumber !== 'string' || !/^[1-9]\d*$/.test(stored.projectNumber)
      || typeof stored.scope !== 'string' || !stored.scope.trim() || typeof stored.selectedAccount !== 'string' || !stored.selectedAccount
      || typeof stored.intent !== 'string' || !/^[a-f0-9]{64}$/.test(stored.intent)) {
      throw new Error('The saved billing recovery identity is invalid. Restore the project setup record before continuing.');
    }
    return stored;
  }
  let binding: RecoveryBinding | undefined;
  for (const name of fs.readdirSync(paths.plans).filter(name => /^setup-[a-f0-9]{64}\.json$/.test(name))) {
    const saved = readJson<SetupPreview | undefined>(path.join(paths.plans, name), undefined);
    if (!saved?.requiresPlanId) continue;
    const observed = saved.observedUnlinkedProject ?? saved.observedLinkedProject;
    const selectedAccount = selectedProjectBilling(saved.configuration, projectId);
    if (!observed || observed.projectId !== projectId || !selectedAccount || name !== `setup-${saved.intent}.json`) {
      throw new Error('The saved billing recovery evidence is incomplete. Restore the reviewed Google project setup before continuing.');
    }
    const candidate = { projectId, projectNumber: observed.projectNumber, scope: observed.scope, intent: saved.intent, selectedAccount };
    if (binding && digest(binding) !== digest(candidate)) throw new Error('Multiple billing recovery records disagree on this project. Review its saved setup before continuing.');
    binding = candidate;
  }
  return binding;
}

/** A preview alone leaves no manifest. The failed initial confirmation wrote the
 * approved manifest and retained the original create preview and encrypted plan. */
function previousBootstrapCreate(
  paths: EngineStatePaths, intent: string, existing: SetupManifest, configuration: EngineConfiguration,
): SetupPreview | undefined {
  const prior = readJson<SetupPreview | undefined>(path.join(paths.plans, `setup-${intent}.json`), undefined);
  if (!prior || prior.intent !== intent || !/^setup-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(prior.planId)
    || !prior.planned?.ok || prior.planned.blockers.length || prior.planned.unmanagedDeletes.length
    || !existing.contributions.bootstrap || digest(prior.manifest) !== digest(existing)
    || digest(prior.configuration) !== digest(configuration)) return;
  const { bootstrap: _initialBootstrap, ...previousContributions } = existing.contributions;
  if (prior.baseline !== digest({ contributions: previousContributions })) return;
  const action = soleProjectAction(prior.planned.actions);
  if (action?.type !== 'create') return;
  const segment = engineSegmentOf(action)!;
  const id = 'opentofu:' + prior.planId;
  const priorConfig = readJson<EngineConfiguration | undefined>(path.join(paths.plans, prior.planId + '.config.json'), undefined);
  const planFile = path.join(paths.plans, prior.planId + '.tfplan');
  if (prior.planned.segmentId === id && prior.planned.segment.id === id && segment.id === id
    && priorConfig && digest(priorConfig) === digest(configuration) && configurationDigest(configuration) === segment.configurationDigest
    && segment.planDigest === prior.planned.segment.planDigest && hardenPrivateFile(planFile) && fileDigest(planFile) === segment.planDigest) return prior;
}

async function reviewFailedProjectPreview(
  failure: EngineStepFailure, engine: GcpProjectSetupDependencies['engine'], params: GcpProjectSetupParams,
  planInput: Parameters<OpenTofuEngine['plan']>[0], paths: EngineStatePaths, intent: string, existing: SetupManifest,
) {
  // prevent_destroy can also indicate an unrelated configuration mistake. Only
  // a checked live identity and the retained, previously approved create prove ownership.
  const observed = params.observedUnlinkedProject;
  if (failure.stage !== 'plan' || !/Resource instance google_project\.hypervibe has prevent_destroy set, but the\s+plan calls for it to be destroyed\./.test(failure.error)
    || !observed || observed.projectId !== params.gcpProjectId || typeof observed.projectNumber !== 'string' || !/^[1-9]\d*$/.test(observed.projectNumber)
    || typeof observed.scope !== 'string' || !observed.scope.trim() || params.contribution.id !== 'bootstrap'
    || !selectedProjectBilling(planInput.configuration, params.gcpProjectId) || !engine.inspectState || !engine.recoverTaintedResource) return;
  const prior = previousBootstrapCreate(paths, intent, existing, planInput.configuration);
  if (!prior || !hardenPrivateFile(paths.statePath)) return;
  const stateDigest = fileDigest(paths.statePath);
  const verifyResource = (document: unknown, tainted: boolean) => matchesProjectInstance(document, observed, tainted);
  const evidence = await engine.inspectState({ ...planInput, project: document => verifyResource(document, true) });
  if (!evidence.ok || !evidence.present || !evidence.value || fileDigest(paths.statePath) !== stateDigest) return;
  const token = digest({ operation: 'recover-google-bootstrap-project', state: planInput.state, stateDigest, observed, intent,
    configuration: digest(planInput.configuration), priorPlan: prior.planId, priorDigest: prior.planned.segment.planDigest });
  return {
    offer: { token, projectId: observed.projectId, projectNumber: observed.projectNumber, previousPlanId: prior.planId },
    command: { ...planInput, address: bootstrapProjectAddress, stateDigest, verifyResource },
  };
}
function mergeValue(left: unknown, right: unknown, location: string): unknown {
  if (left === undefined || digest(left) === digest(right)) return right;
  if (location.endsWith('.depends_on') && Array.isArray(left) && Array.isArray(right)) return [...new Set([...left, ...right])].sort();
  if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const result = { ...left } as Record<string, unknown>;
    for (const [key, value] of Object.entries(right)) result[key] = mergeValue(result[key], value, `${location}.${key}`);
    return result;
  }
  throw new Error(`Project setup contributions disagree at ${location}; preview an explicit shared configuration change.`);
}
/** Compose all retained project ownership before planning any new access. */
export function composeGcpProjectConfiguration(contributions: Record<string, EngineConfiguration>): EngineConfiguration {
  const merged: EngineConfiguration = { files: {}, resources: {}, imports: {} };
  for (const configuration of Object.values(contributions)) {
    for (const [file, document] of Object.entries(configuration.files)) {
      merged.files[file] = mergeValue(merged.files[file], document, file);
    }
    for (const [address, mapping] of Object.entries(configuration.resources)) {
      merged.resources[address] = mergeValue(merged.resources[address], mapping, address) as typeof mapping;
    }
    Object.assign(merged.imports!, configuration.imports ?? {});
  }
  if (Object.keys(merged.imports!).length) merged.files['setup-imports.tf.json'] = {
    import: Object.entries(merged.imports!).map(([to, id]) => ({ to, id })),
  };
  return merged;
}

/**
 * One durable, encrypted OpenTofu state owns all setup for a Google project.
 * Preview persists the complete saved plan. Confirmation never re-plans or
 * extends approval to drift in a previously approved contribution.
 */
export async function executeGcpProjectSetup(backend: InfrastructureEngineBackend, params: GcpProjectSetupParams, overrides?: GcpProjectSetupDependencies): Promise<GcpProjectSetupResult> {
  const mode = params.confirm ? 'confirm' : 'preview';
  let executing: { planId: string; digest: string } | undefined;
  const dataDir = params.dataDir ?? getDataDir();
  const fail = (error: string): GcpProjectSetupResult => {
    if (executing) {
      try { recordSetupReviewExecution(dataDir, params.projectId, params.gcpProjectId, executing.planId, executing.digest, 'failed'); }
      catch { error += ' The saved review could not record the setup failure.'; }
    }
    return { success: false, mode, error, ...(executing && { planId: executing.planId }) };
  };
  const recoveryRequested = params.recoverProjectState !== undefined;
  const staleRecovery = 'The local project-state recovery authorization does not match the current evidence. Preview the existing project again.';
  if (recoveryRequested && (params.confirm || !/^[a-f0-9]{64}$/.test(params.recoverProjectState!))) return fail(staleRecovery);
  if (!params.confirm && params.gcpSetupPlanId !== undefined) return fail('Supply gcpSetupPlanId when confirming the reviewed Google Cloud setup plan.');
  const state: EngineStateIdentity = { provider: 'gcp', projectId: params.projectId, environmentId: params.gcpProjectId, partition: 'project-shared' };
  const paths = engineStatePaths(state, params.dataDir);
  try {
    setupPlansDirectory(params);
    ensureEngineStateDirectories(paths);
  } catch {
    return fail('The private Google Cloud setup state directory could not be opened.');
  }
  // SQLite's OS-backed exclusive lock is released if this process exits. An
  // abandoned marker file can never permanently block setup. The engine still
  // takes its own native state lock while planning/applying.
  const lockFile = path.join(paths.root, 'setup-lock.sqlite');
  let lock: Database.Database | undefined;
  try {
    fs.closeSync(fs.openSync(lockFile, 'a', 0o600));
    lock = new Database(lockFile, { timeout: 0 });
    lock.exec('BEGIN EXCLUSIVE');
    lock.exec('CREATE TABLE IF NOT EXISTS setup_mutex (id INTEGER PRIMARY KEY)');
  } catch (error) {
    lock?.close();
    const busy = (error as { code?: string }).code === 'SQLITE_BUSY';
    return fail(busy ? 'Another project setup is running. Wait for it to finish, then preview again.'
      : 'The project setup lock could not be verified. Restore the local setup-lock.sqlite file before retrying.');
  }
  try {
    const manifestFile = path.join(paths.root, 'setup-manifest.json');
    const existing = readJson<SetupManifest>(manifestFile, { contributions: {} });
    const bucketReview = params.transferBucketJobReview;
    const bucketJob = reviewedBucketJob(params, existing.contributions);
    const isolation = params.transferIsolationReview;
    if (!!isolation !== isIsolationContribution(params.contribution.id)) return fail('Use a dedicated transfer isolation review for these runtime grants.');
    if (isolation) {
      if (params.transferSlotReview || params.allowDestroyAddresses?.length || params.allowReplaceAddresses?.length || params.allowImportAddresses?.length ||
          params.existingResourceAddresses?.length || recoveryRequested || params.observedUnlinkedProject || params.observedLinkedProject) {
        return fail('Review the two application permission changes separately from other project setup.');
      }
      if (params.confirm && (!params.gcpSetupPlanId || !params.observeIsolationAfterApply)) {
        return fail('Confirm the application permission changes using the exact saved isolation plan ID and current Google metadata.');
      }
      assertIsolationReview(existing.contributions, params.contribution, params.gcpProjectId, isolation);
    }
    const review = params.transferSlotReview;
    const slot = review && transferSlot(review.target);
    const previousSlot = slot && existing.contributions[slot.id];
    if (review && slot) {
      if (params.gcpProjectId !== review.target.projectId || params.contribution.id !== slot.id ||
        digest(params.contribution.configuration) !== digest(slot.configuration) ||
        previousSlot && digest(previousSlot) !== digest(slot.configuration) ||
        Object.entries(existing.contributions).some(([owner, config]) => owner !== slot.id && Object.values(slot.addresses).some(address => config.resources[address]))) {
        return fail('The transfer setup belongs to a different project or owner.');
      }
      if (!previousSlot && (review.evidence.account || review.evidence.secret || review.evidence.directAccessor)) {
        return fail('A transfer resource already exists without a matching approved setup. Hypervibe cannot adopt it.');
      }
      if (params.confirm && !params.gcpSetupPlanId) return fail('Supply the exact saved plan ID for this empty migration slot.');
    }
    const manifest = { contributions: { ...existing.contributions, [params.contribution.id]: params.contribution.configuration } };
    const scopes = retainedIsolations(manifest.contributions, params.gcpProjectId);
    for (const scope of scopes) assertOriginalIsolationOwners(manifest.contributions, scope);
    const protectedAddresses = new Set(scopes.flatMap(scope => isolationGrants(scope).map(grant => grant.address)));
    const configuration = composeGcpProjectConfiguration(manifest.contributions);
    // Retain deleted address mappings, so a specifically approved removal is representable.
    const previous = existing.contributions[params.contribution.id];
    Object.assign(configuration.resources, previous?.resources, params.contribution.configuration.resources);
    if (isolation) {
      for (const grant of isolationGrants(isolation.scope)) {
        configuration.resources[grant.address] = { ...configuration.resources[grant.address]!, name: grant.name, requiresConfirm: true };
      }
    }
    const intent = digest({ gcpProjectId: params.gcpProjectId, contribution: params.contribution,
      ...(review ? { transferSlotReview: review } : {}),
      ...(bucketReview ? { transferBucketJobReview: bucketReview } : {}),
      ...(isolation ? { transferIsolationReview: isolation } : {}),
      authenticationScope: params.authenticationScope ?? 'google-project-admin',
      destroy: params.allowDestroyAddresses ?? [], imports: params.allowImportAddresses ?? [], existing: params.existingResourceAddresses ?? [],
      ...(params.allowReplaceAddresses?.length ? { replace: params.allowReplaceAddresses } : {}) });
    const previewFile = path.join(paths.plans, `setup-${intent}.json`);
    const bootstrap = params.contribution.id === 'bootstrap';
    const observed = bootstrap ? params.observedUnlinkedProject : undefined;
    const selectedAccount = bootstrap ? selectedProjectBilling(configuration, params.gcpProjectId) : undefined;
    const marker = path.join(paths.root, 'bootstrap-billing-recovery.json');
    const binding = bootstrap ? recoveryBinding(paths, marker, params.gcpProjectId) : undefined;
    const linked = binding ? params.observedLinkedProject : undefined;
    if (binding && (binding.intent !== intent || binding.selectedAccount !== selectedAccount
      || !matchesRecoveryObservation(binding, observed ?? linked)
      || (linked && (observed || linked.billingAccountName !== 'billingAccounts/' + selectedAccount)))) {
      return fail('Preview the same active project with the original billing account. Its current identity and billing status must match the saved recovery.');
    }
    let saved: SetupPreview;
    let originalReviewDigest: string | undefined;
    if (params.confirm) {
      const preview = readJson<SetupPreview | undefined>(previewFile, undefined);
      if (!preview) return fail('Preview this exact Google Cloud setup before confirming it. No infrastructure was changed.');
      originalReviewDigest = reviewDigest('setup', params.projectId, params.gcpProjectId, preview.planId, preview);
      if (params.requireBrowserApproval || bucketReview) {
        if (params.contribution.id === 'ci-release' && (!params.ciReleaseAccess?.length || !preview.ciReleaseAccess?.length
          || digest(params.ciReleaseAccess) !== digest(preview.ciReleaseAccess))) {
          return fail('Preview GitHub release access again to review the workflows, branches, environments and triggers before approving.');
        }
        if (preview.planId !== params.gcpSetupPlanId || !readReviewApproval(dataDir, preview.planId, originalReviewDigest)
          || (bootstrap && (!preview.bootstrapConnection || !params.bootstrapConnection
            || digest(preview.bootstrapConnection) !== digest(params.bootstrapConnection)))) {
          return { ...fail('This exact setup and its connection scope still need approval. Open the saved review before continuing.'),
            ...(preview.planId === params.gcpSetupPlanId && { planId: preview.planId }) };
        }
      }
      if (!preview.requiresPlanId && (binding || preview.observedUnlinkedProject || preview.observedLinkedProject
        || (params.contribution.id === 'bootstrap' && params.observedUnlinkedProject && isInPlaceBillingUpdate(preview.planned.actions)))) {
        return fail('Preview the current project and billing account again to obtain a plan-bound Google Cloud setup confirmation.');
      }
      if ((preview.requiresPlanId || params.gcpSetupPlanId !== undefined) && params.gcpSetupPlanId !== preview.planId) {
        if (isolation) return fail('Confirm with the exact saved application permission plan ID.');
        return fail(slot ? 'Confirm with the exact saved plan ID for this empty migration slot.' : 'Preview the current Google Cloud setup, review its billing change, and confirm with the gcpSetupPlanId from that preview.');
      }
      if (preview.requiresPlanId && (!binding || !(preview.observedUnlinkedProject && observed && digest(preview.observedUnlinkedProject) === digest(observed))
        && !(preview.observedLinkedProject && linked && digest(preview.observedLinkedProject) === digest(linked)))) {
        return fail('The active project and its billing status could not be verified against this plan. Preview Google Cloud setup again.');
      }
      // Accept first-generation bound previews with their exact ID. New envelopes
      // deliberately fail the manifest-only baseline check in older clients.
      const baseline = preview.requiresPlanId && preview.baseline.startsWith('project-recovery-v1:') ? boundBaseline(existing) : digest(existing);
      if (preview.intent !== intent || preview.baseline !== baseline || digest(preview.configuration) !== digest(configuration)
        || scopes.length && digest(preview.manifest) !== digest(manifest)) {
        return fail('Google Cloud setup changed since preview. Preview the current setup again before confirming.');
      }
      saved = { ...preview, createdAt: preview.createdAt ?? fs.statSync(previewFile).mtime.toISOString() };
    } else {
      saved = { planId: `setup-${randomUUID()}`, reviewContributionId: params.contribution.id, createdAt: new Date().toISOString(), projectName: params.projectName,
        ...(bootstrap && params.bootstrapConnection && { bootstrapConnection: params.bootstrapConnection }),
        ...(params.contribution.id === 'ci-release' && params.ciReleaseAccess && { ciReleaseAccess: params.ciReleaseAccess }),
        intent, baseline: digest(existing), manifest, configuration, planned: undefined as unknown as EnginePlanResult };
    }
    if (isolation) saved.setupPurpose = 'railway-transfer-isolation';
    if (slot) saved.setupPurpose = 'railway-transfer';
    if (bucketJob && bucketReview) {
      saved.setupPurpose = 'railway-bucket-copy';
      const { storageName, sourceBucketName, targetBucket } = bucketReview.scope;
      saved.bucketCopy = { storageName, sourceBucket: sourceBucketName, targetBucket, copyAccount: bucketJob.accountEmail };
    }
    let engine = overrides?.engine;
    if (!engine) {
      const binary = await ensureEngineBinary();
      if (!binary.ok) return fail(binary.error);
      engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir(), dataDir: params.dataDir });
    }
    const interruptedGrant = 'OpenTofu still tracks the previous version of a reviewed app grant. ' + isolationRecoveryRequired;
    const inspectIsolation = async (evidence: TransferIsolationEvidence) => {
      const observed = await engine.inspectState?.({ backend, configuration, auth: params.auth, state,
        project: raw => hasDeposedIsolationGrant(raw, evidence.scope) ? 'deposed' : matchesIsolationState(raw, evidence) });
      if (observed?.ok && observed.present && observed.value === 'deposed') throw new Error(interruptedGrant);
      return observed?.ok && observed.present && observed.value === true;
    };
    const inspectBucketJob = async (evidence: TransferBucketJobEvidence) => {
      if (!bucketJob) return false;
      const observed = await engine.inspectState?.({ backend, configuration, auth: params.auth, state,
        project: raw => matchesTransferBucketJobState(raw, bucketJob, evidence) });
      return observed?.ok && observed.present && observed.value === true;
    };
    if (bucketReview && !await inspectBucketJob(bucketReview.evidence)) {
      return fail('The observed copy job and bucket permissions do not match the original private project state.');
    }
    if (isolation && !await inspectIsolation(isolation)) {
      return fail('The existing transfer slot, build bucket, runtime account or app grants could not be matched to their original private engine state.');
    }
    if (slot && params.confirm && (!params.observeTransferAfterApply || !engine.inspectState)) {
      return fail('Confirming the migration slot requires fresh Google metadata and access to its private engine state.');
    }
    if (slot && review && previousSlot) {
      const current = await engine.inspectState?.({ backend, configuration, auth: params.auth, state,
        project: raw => matchesTransferState(raw, slot, review.evidence) });
      if (!current?.ok || !current.present || !current.value) return fail('The original transfer resources could not be matched to private engine state. No changes are authorized.');
    }
    if (!params.confirm) {
      let verifiedTransfer = false;
      let verifiedBucketJob = false;
      let verifiedIsolation = false;
      let interruptedIsolation = false;
      let verifiedBilling = false;
      const planInput = { backend, configuration, auth: params.auth, state, planId: saved.planId,
        ...(isolation ? { verifyPlannedChanges: (document: unknown) => {
          interruptedIsolation = hasDeposedIsolationGrant(document, isolation.scope);
          if (interruptedIsolation) return false;
          verifiedIsolation = verifyIsolationPlan(document, isolation);
          return verifiedIsolation;
        } } : {}),
        ...(bucketJob && bucketReview ? { verifyPlannedChanges: (document: unknown) => {
          const owned = new Set(Object.values(existing.contributions).flatMap(contribution => Object.keys(contribution.resources)));
          verifiedBucketJob = verifyTransferBucketJobPlan(document, bucketJob, bucketReview.evidence, owned);
          return verifiedBucketJob;
        } } : {}),
        ...(slot && review ? { verifyPlannedChanges: (document: unknown) => {
          verifiedTransfer = verifyTransferSlotPlan(document, slot, review.evidence);
          return verifiedTransfer;
        } } : {}),
        ...(bootstrap ? { verifyPlannedChanges: (document: unknown) => {
          const valid = verifyBootstrapBillingPlan(document, params.gcpProjectId, selectedAccount, observed ?? linked, !!linked);
          verifiedBilling = valid && !!(observed ?? linked);
          return valid;
        } } : {}) };
      let planned = await engine.plan(planInput);
      if (interruptedIsolation) return fail(interruptedGrant);
      if (!planned.ok) {
        const review = await reviewFailedProjectPreview(planned, engine, params, planInput, paths, intent, existing);
        if (!review) return fail(recoveryRequested ? staleRecovery : planned.error);
        if (!recoveryRequested) return { ...fail('The existing Google project can be retained. Review the local state recovery before previewing billing setup.'),
          projectRecovery: review.offer };
        if (review.offer.token !== params.recoverProjectState || !engine.recoverTaintedResource) return fail(staleRecovery);
        // Persist recovery across a process exit between normalization and publication,
        // or a later partial apply that links billing before another setup action fails.
        writeJson(marker, { ...observed!, selectedAccount, intent });
        const repaired = await engine.recoverTaintedResource(review.command);
        if (!repaired.ok) return fail(repaired.error);
        planned = await engine.plan(planInput);
        if (!planned.ok) return fail(`The local project state was repaired. The new setup preview failed. ${planned.error}`);
      } else if (recoveryRequested) return fail(staleRecovery);
      if (observed || linked) {
        if (!verifiedBilling || (observed && !isInPlaceBillingUpdate(planned.actions))) {
          return fail('The setup plan did not retain the existing project with an in-place billing update. Review the project and its saved setup before continuing.');
        }
        if (observed) soleProjectAction(planned.actions)!.billable = true;
        saved.requiresPlanId = true;
        saved.baseline = boundBaseline(existing);
        if (observed) saved.observedUnlinkedProject = observed;
        if (linked) saved.observedLinkedProject = linked;
      }
      if (slot && (!verifiedTransfer || planned.unmanagedDeletes.length)) return fail('The native plan did not match the empty transfer resources reviewed.');
      if (isolation && (!verifiedIsolation || planned.unmanagedDeletes.length)) return fail('The native plan must contain only the two reviewed application grant conditions or their verified no-ops.');
      if (bucketJob && bucketReview && (!verifiedBucketJob || planned.unmanagedDeletes.length ||
          !matchesBucketCopyActions(planned.actions, bucketJob, bucketReview.evidence))) {
        return fail('The plan must contain only the reviewed copy job and its two bucket permissions, or their verified no-ops.');
      }
      const allowed = new Set([...Object.keys(params.contribution.configuration.resources), ...Object.keys(previous?.resources ?? {})]);
      const destroy = new Set(params.allowDestroyAddresses ?? []);
      const replace = new Set(params.allowReplaceAddresses ?? []);
      const imports = new Set(params.allowImportAddresses ?? []);
      const observedPresent = new Set(params.existingResourceAddresses ?? []);
      const unexpected = planned.actions.filter((action) => action.type !== 'noop').find((action) => {
        const addresses = engineSegmentOf(action)?.addresses ?? [];
        if (addresses.some(address => protectedAddresses.has(address))) {
          if (!isolation || action.type !== 'replace' || addresses.length !== 1 ||
              !isolationGrants(isolation.scope).some(grant => grant.address === addresses[0] && isolation.grants[grant.role] === 'broad')) return true;
          return false;
        }
        return !!isolation || addresses.some((address) => !allowed.has(address))
          || (action.type === 'replace' && addresses.some((address) => !replace.has(address)))
          || (action.type === 'create' && addresses.some((address) => observedPresent.has(address)))
          || (action.type === 'destroy' && addresses.some((address) => !destroy.has(address)))
          || (action.metadata?.engineAdopt === true && addresses.some((address) => !imports.has(address)));
      });
      if (isolation) {
        const expected = isolationGrants(isolation.scope).filter(grant => isolation.grants[grant.role] === 'broad').map(grant => grant.address).sort();
        const actual = planned.actions.filter(action => action.type !== 'noop').flatMap(action => engineSegmentOf(action)?.addresses ?? []).sort();
        if (digest(actual) !== digest(expected)) return fail('The displayed actions do not exactly cover the reviewed application permission changes.');
      }
      if (planned.blockers.length || unexpected) return fail(planned.blockers.join(' ') || 'The setup plan changes resources outside this approval. Review the affected project setup separately.');
      saved.planned = planned;
      const prior = readJson<SetupPreview | undefined>(previewFile, undefined);
      if (prior) {
        if (prior.intent !== intent) return fail('The prior Google Cloud setup preview has an unexpected identity.');
        preserveSetupReport(params, { ...prior, createdAt: prior.createdAt ?? fs.statSync(previewFile).mtime.toISOString() }, params.auth.redact);
      }
      const report = saveSetupReport(params, saved, params.auth.redact);
      if (saved.requiresPlanId && !hardenPrivateFile(marker)) {
        const identity = observed ?? linked!;
        writeJson(marker, { projectId: identity.projectId, projectNumber: identity.projectNumber, scope: identity.scope, selectedAccount, intent });
      }
      writeJson(previewFile, saved);
      return { success: true, mode, planId: saved.planId, actions: planned.actions, ...(saved.requiresPlanId ? { requiresPlanId: true } : {}), ...report };
    }
    const report = saveSetupReport(params, saved, params.auth.redact);
    // Older preview files gain display defaults when rendered. Keep the receipt bound to the original saved document.
    const executionDigest = originalReviewDigest!;
    recordSetupReviewExecution(dataDir, params.projectId, params.gcpProjectId, saved.planId, executionDigest, 'running');
    executing = { planId: saved.planId, digest: executionDigest };
    const addresses = saved.planned.actions.filter((action) => action.type !== 'noop').flatMap((action) => engineSegmentOf(action)?.addresses ?? []);
    if (addresses.length > 0) {
      // Keep approved intent after a partial apply so retry cannot orphan completed resources.
      writeJson(manifestFile, saved.manifest);
      const applied = await engine.apply({ backend, auth: params.auth, state, planId: saved.planId,
        segment: { ...saved.planned.segment, addresses }, approvedAddresses: addresses });
      if (addresses.some((address) => applied.outcomes[address] !== 'succeeded')) {
        return fail(applied.diagnostics.join(' ') || 'Project setup has not converged. Preview again to inspect the remaining work.');
      }
    } else writeJson(manifestFile, saved.manifest);
    if (isolation) {
      const unverified = 'The two narrowed application grants and original transfer resources could not be verified after apply. Keep the transfer secret empty and preview again.';
      try {
        const after = await params.observeIsolationAfterApply!();
        assertIsolationReview(saved.manifest.contributions, params.contribution, params.gcpProjectId, after);
        if (digest(after.scope) !== digest(isolation.scope) || after.evidenceDigest !== isolation.evidenceDigest ||
            !isolationGrants(isolation.scope).every(grant => after.grants[grant.role] === 'restricted') ||
            !await inspectIsolation(after)) return fail(unverified);
      } catch { return fail(unverified); }
    }
    if (slot && review) {
      // A new provider object can reuse exactly the name and labels just created.
      // Read back the live identity and compare it to the stored result of this apply.
      const unverified = 'The empty migration slot could not be matched to its private engine state after apply. Preview its current setup again.';
      try {
        const after = await params.observeTransferAfterApply!();
        const { account, secret } = after;
        if (after.projectNumber !== review.evidence.projectNumber || after.directAccessor !== true
          || !account || !/^[1-9][0-9]*$/.test(account.uniqueId) || account.description !== slot.description
          || account.email !== slot.accountEmail || account.name !== 'projects/' + params.gcpProjectId + '/serviceAccounts/' + slot.accountEmail
          || !secret?.createTime || secret.name !== 'projects/' + after.projectNumber + '/secrets/' + slot.secretId
          || !Object.entries(slot.labels).every(([key, value]) => secret.labels[key] === value)
          || review.evidence.account && review.evidence.account.uniqueId !== account.uniqueId
          || review.evidence.secret && review.evidence.secret.createTime !== secret.createTime) return fail(unverified);
        const observed = await engine.inspectState!({ backend, configuration, auth: params.auth, state,
          project: raw => matchesTransferState(raw, slot, after) });
        if (!observed.ok || !observed.present || observed.value !== true) return fail(unverified);
      } catch { return fail(unverified); }
    }
    if (bucketJob && bucketReview) {
      const before = bucketReview.evidence;
      const after = await params.observeBucketJobAfterApply!();
      if (!after.jobUid || !after.creator || !after.viewer || (before.jobUid && before.jobUid !== after.jobUid) ||
          before.projectNumber !== after.projectNumber || before.copyUniqueId !== after.copyUniqueId ||
          before.bucketTimeCreated !== after.bucketTimeCreated || !await inspectBucketJob(after)) {
        return fail('Google could not verify the reviewed job, its bucket permissions and their original identities. Preview the setup again.');
      }
    }
    const finishReview = (outcome: 'applied' | 'failed') => {
      try { recordSetupReviewExecution(dataDir, params.projectId, params.gcpProjectId, saved.planId, executionDigest, outcome); return true; }
      catch { return false; }
    };
    fs.unlinkSync(previewFile);
    if (saved.requiresPlanId && hardenPrivateFile(marker)) fs.unlinkSync(marker);
    if (!params.reviewAfterVerification) recordSetupReviewExecution(dataDir, params.projectId, params.gcpProjectId, saved.planId, executionDigest, 'applied');
    executing = undefined;
    return { success: true, mode, planId: saved.planId, actions: saved.planned.actions, ...report,
      ...(params.reviewAfterVerification && { finishReview }) };
  } catch (error) {
    // Engine errors are already sanitized. Do not echo arbitrary admin input/configuration.
    let message = error instanceof Error ? error.message : 'Project setup failed.';
    for (const secret of params.auth.redact) if (secret) message = message.split(secret).join('[REDACTED]');
    return fail(message);
  } finally { lock.exec('ROLLBACK'); lock.close(); }
}

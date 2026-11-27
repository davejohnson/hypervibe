import { isDeepStrictEqual as equal } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { EngineAuthentication, EngineStateIdentity } from '../domain/ports/infrastructure-engine.port.js';
import type { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { gcpEngineBackend } from '../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { gcpSetupBackend } from '../adapters/providers/gcp/tofu/gcp-setup.backend.js';
import { backupAddresses, gcpBucketBackupProgram } from '../adapters/providers/gcp/tofu/gcp-bucket-backups.js';
import { GoogleBucketBackupError, GoogleBackupRuntimeExposure, readGoogleBackupApplicationAccount, googleBackupOwnershipFromState, googleBackupSourceFromState, observeGoogleBackupProgram, type GoogleBackupOwnership } from '../adapters/providers/gcp/gcp-bucket-backup-evidence.js';
import { readGcsDailyBucketBackups } from '../adapters/providers/gcp/gcp-daily-bucket-backup.js';
import { getDefaultAdminAccessToken } from '../domain/services/cloud-prepare.execute.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import { engineBucketName, engineGcpAdapter } from './infrastructure-engine.js';
import { openTofuEngine, recordEnginePlan } from './engine-shared.js';
import type { CommandContext } from './context.js';
import type { EngineApplyParams, EnginePlanParams } from './cloud-engines.js';
import { applyCloudBucketBackups, planCloudBucketBackups, type PrepareBucketBackup } from './cloud-bucket-backup-engine.js';
import { googleBucketBackupRecords as savedRecords } from './gcp-bucket-backup-records.js';
import { backupAccessAddress, backupAccessContribution, backupAccessScopes, googleBackupPlanMismatch, matchesManagedProjectStorage,
  projectStorageDefinition, storageDefinitionCondition, type BackupAccessReview } from '../adapters/providers/gcp/tofu/backup-archive-access.js';
import { composeGcpProjectConfiguration, getGcpProjectSetupContributions, runGcpProjectSetup, type GcpProjectSetupParams } from '../domain/services/gcp-project-setup.service.js';
import { ConvergeExecutor } from '../domain/plan/converge.executor.js';
import { googleBackupAccessDescriptorSchema } from '../domain/plan/bucket-backup-plan.contract.js';
import type { PlanAction } from '../domain/plan/plan.types.js';

const bindingSchema = z.object({ projectId: z.string(), environmentId: z.string(), provider: z.literal('cloudrun'),
  engine: z.object({ kind: z.literal('opentofu'), storage: z.array(z.string()) }) });
const emptyConfig = { files: {}, resources: {} };
function connectionAccounts(connection: { projectId: string; credentials: string; runtimeServiceAccountEmail?: string }) {
  const key = z.object({ type: z.literal('service_account'), project_id: z.literal(connection.projectId), client_email: z.email() }).safeParse(JSON.parse(connection.credentials));
  if (!key.success || !connection.runtimeServiceAccountEmail) throw new GoogleBucketBackupError('Reconnect the original Google Cloud application and deployment identities before setting up daily file backups.');
  return { deployEmail: key.data.client_email, runtimeEmail: connection.runtimeServiceAccountEmail };
}
function selectedTarget(project: Project, env: Environment, declared: EnvironmentSpec, storageName: string) {
  const storage = declared.storage?.[storageName], binding = bindingSchema.safeParse(env.platformBindings).data;
  if (project.id !== env.projectId || declared?.hosting.provider !== 'cloudrun' || storage?.provider !== 'gcs'
    || storage.purpose === 'backup' || !storage.automatedBackups || !binding || binding.engine.storage.filter(name => name === storageName).length !== 1
    || (declared.hosting.gcpProjectId && declared.hosting.gcpProjectId !== binding.projectId)
    || (declared.hosting.region && declared.hosting.region !== binding.environmentId)) {
    throw new GoogleBucketBackupError('Apply the declared Google Cloud data bucket in this environment before reviewing its daily backups.');
  }
  return { projectId: binding.projectId, region: binding.environmentId, environmentId: env.id, storageName,
    bucket: engineBucketName(binding.projectId, env.name, storageName), location: storage.region.toUpperCase() };
}

async function inspect<T>(engine: OpenTofuEngine, auth: EngineAuthentication, state: EngineStateIdentity, project: (raw: unknown) => T) {
  const result = await engine.inspectState({ backend: gcpEngineBackend, auth, state, configuration: emptyConfig, project });
  if (!result.ok) throw new GoogleBucketBackupError('Hypervibe could not read the original private Google Cloud state. Recover access to it before planning a backup.');
  return result.present ? result.value : undefined;
}
async function readProgram(project: Project, env: Environment, spec: EnvironmentSpec, storageName: string, engine: OpenTofuEngine,
  token: string, accounts: ReturnType<typeof connectionAccounts>) {
  const target = { ...selectedTarget(project, env, spec, storageName), ...accounts };
  const auth = { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token, GOOGLE_PROJECT: target.projectId }, redact: [token] };
  const source = await inspect(engine, auth, { provider: 'gcp', projectId: project.id, environmentId: env.id, partition: 'environment' },
    raw => googleBackupSourceFromState(raw, target));
  if (!source) throw new GoogleBucketBackupError('The selected bucket has no original private environment state. Apply it before setting up daily backups.');
  const program = gcpBucketBackupProgram(source);
  const contributions = getGcpProjectSetupContributions(project.id, source.projectId);
  const configuration = composeGcpProjectConfiguration(contributions);
  if (!configuration.resources[backupAccessAddress(source.runtimeEmail)]) {
    throw new GoogleBucketBackupError('Daily backups require the environment’s original Hypervibe-managed Google storage setup. The application currently has no managed project storage grant to restrict. Recover its original GCS setup before requesting this backup.');
  }
  const condition = storageDefinitionCondition(projectStorageDefinition(configuration, source.runtimeEmail));
  const enrollment = backupAccessScopes(contributions).find(scope => scope.runtimeEmail === source.runtimeEmail && scope.archive === program.archiveName);
  if (enrollment && (enrollment.source !== source.bucket || enrollment.sourceCreated !== source.timeCreated || enrollment.projectNumber !== source.projectNumber)) {
    throw new GoogleBucketBackupError('The saved backup storage restriction belongs to a different original Google Cloud bucket.');
  }
  const priorContributions = { ...contributions };
  if (enrollment) delete priorContributions[backupAccessContribution(enrollment).id];
  const priorCondition = enrollment && storageDefinitionCondition(projectStorageDefinition(composeGcpProjectConfiguration(priorContributions), source.runtimeEmail));
  const grant = await engine.inspectState({ backend: gcpSetupBackend, configuration, auth,
    state: { provider: 'gcp', projectId: project.id, environmentId: source.projectId, partition: 'project-shared' },
    project: document => matchesManagedProjectStorage(document, source.projectId, source.runtimeEmail, condition) ? 'current' :
      enrollment && matchesManagedProjectStorage(document, source.projectId, source.runtimeEmail, priorCondition) ? 'previous' : undefined });
  if (!grant.ok || !grant.present || !grant.value) throw new GoogleBucketBackupError('The original application storage permission differs from its private project setup state. Review the original Google storage setup before requesting a backup.');
  const state = program.state(project.id);
  const owned = await inspect(engine, auth, state, raw => googleBackupOwnershipFromState(raw, program)) ?? {};
  const live = await observeGoogleBackupProgram(program, owned, token, { managedStorage: {
    condition: grant.value === 'previous' ? priorCondition : condition, archiveEnrolled: grant.value === 'current' && !!enrollment } });
  const saved = savedRecords.parse(env.platformBindings.gcpBucketBackups ?? {})[storageName];
  const targetRecord = { projectId: source.projectId, source: source.bucket, sourceCreated: source.timeCreated,
    archive: program.archiveName, schedule: program.jobName };
  const pending = { ...targetRecord, status: 'pending' as const };
  const complete = Object.keys(program.configuration.resources).every(key => !!live[key]);
  const identity = complete ? { ...targetRecord, archiveCreated: live[backupAddresses.archive]!,
    jobUid: live[backupAddresses.job]!, workerUid: live[backupAddresses.worker]!, timerUid: live[backupAddresses.timer]! } : undefined;
  if (saved && !equal(saved, 'status' in saved ? pending : identity)) {
    throw new GoogleBucketBackupError('This environment already recorded a different backup resource identity. Preserve its archive and recover the original program.');
  }
  return { auth, state, source, program, owned, identity, pending };
}

/** Never let a refresh create a replacement, adopt an outside grant or repair an unreviewed resource. */
export function reviewGoogleBucketBackupPlan(document: unknown, addresses: string[], owned: GoogleBackupOwnership) {
  const selected = new Set(addresses);
  const row = z.object({ address: z.string(), type: z.string(), mode: z.literal('managed'), provider_name: z.literal('registry.opentofu.org/hashicorp/google'),
    deposed: z.never().optional(), previous_address: z.never().optional(), change: z.object({ actions: z.array(z.string()), importing: z.never().optional() }) });
  const plan = z.object({ resource_changes: z.array(row), errored: z.literal(false).optional(), complete: z.literal(true).optional(),
    deferred_changes: z.array(z.unknown()).max(0).optional(), resource_drift: z.array(z.unknown()).max(0).optional() }).safeParse(document);
  return plan.success && plan.data.resource_changes.every(change => selected.delete(change.address)
    && change.type === change.address.split('.')[0] && equal(change.change.actions, [Object.hasOwn(owned, change.address) ? 'no-op' : 'create'])) && !selected.size;
}

interface AccessStage { environmentId: string; storageName: string; setup: GcpProjectSetupParams; review: BackupAccessReview }
async function reviewApplicationAccess(exposure: GoogleBackupRuntimeExposure, project: Project, token: string, environmentId: string,
  verify: () => Promise<boolean>): Promise<AccessStage> {
  const { source, archiveName } = exposure.program;
  const readAccount = () => readGoogleBackupApplicationAccount(source, token);
  const account = await readAccount();
  const scope = { projectId: source.projectId, projectNumber: source.projectNumber, runtimeEmail: source.runtimeEmail, runtimeUid: account.uniqueId,
    source: source.bucket, sourceCreated: source.timeCreated, archive: archiveName };
  const contribution = backupAccessContribution(scope);
  const prior = getGcpProjectSetupContributions(project.id, source.projectId);
  // An interrupted attempt may already have recorded this exact contribution. Compare with the original prior grant on retry.
  const retained = { ...prior };
  if (retained[contribution.id] && !equal(retained[contribution.id], contribution.configuration)) throw new GoogleBucketBackupError('The saved application access review belongs to a different source or runtime.');
  delete retained[contribution.id];
  let before, after;
  try {
    before = storageDefinitionCondition(projectStorageDefinition(composeGcpProjectConfiguration(retained), source.runtimeEmail));
    after = storageDefinitionCondition(projectStorageDefinition(composeGcpProjectConfiguration({ ...retained, [contribution.id]: contribution.configuration }), source.runtimeEmail));
  } catch { throw new GoogleBucketBackupError('The project storage grant is outside the original Hypervibe Google setup. Recover its original setup state before reviewing the archive.'); }
  if (!after || !equal(exposure.before, before)) throw new GoogleBucketBackupError('The live application storage condition differs from the saved Google project setup. Restore its original managed setup before reviewing daily backups.');
  const review = { scope, ...(before && { before }), after };
  return { storageName: source.storageName, environmentId, review, setup: {
    projectId: project.id, projectName: project.name, gcpProjectId: source.projectId, auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token, GOOGLE_PROJECT: source.projectId }, redact: [token] },
    authenticationScope: 'bucket-backup-access:' + canonicalJsonSha256(scope), contribution, backupAccessReview: review,
    observeBackupAccessAfterApply: async () => (await readAccount()).uniqueId === account.uniqueId && await verify(),
  } };
}
function prepareWithGoogleAccount(needAccess?: (stage: AccessStage) => void, mismatch?: (reason: string) => void): PrepareBucketBackup {
  let ownerToken: Promise<string> | undefined;
  return async (ctx, { project, environmentName, spec, storageName }) => {
    try {
      const env = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
      if (!env) throw new GoogleBucketBackupError('Apply the Google Cloud environment and its data bucket before setting up daily backup copies.');
      const declared = spec.environments[environmentName]!;
      const selected = selectedTarget(project, env, declared, storageName);
      const connected = await engineGcpAdapter(project, declared.hosting.gcpProjectId);
      if (!connected || connected.engineConnection().projectId !== selected.projectId) {
        return { blocked: 'Reconnect the original Google Cloud project for this environment before reviewing its bucket backups.' };
      }
      const accounts = connectionAccounts(connected.engineConnection());
      // The deployment account cannot create identities. Use the same short-lived user sign-in as Google project setup.
      ownerToken ??= getDefaultAdminAccessToken().catch(() => { throw new GoogleBucketBackupError('Sign in to Google with an account that can set up the backup worker and scheduler in ' + selected.projectId + '.'); });
      const token = await ownerToken, engine = await openTofuEngine();
      if ('blocked' in engine) return engine;
      const read = () => readProgram(project, env, declared, storageName, engine, token, accounts);
      const target = await read().catch(async error => {
        if (error instanceof GoogleBackupRuntimeExposure && needAccess) {
          needAccess(await reviewApplicationAccess(error, project, token, env.id, async () => !!await read().catch(() => undefined)));
        }
        throw error;
      });
      const { auth, state, source, program, owned, pending } = target;
      return { environmentId: env.id, backend: gcpEngineBackend, auth, state, configuration: program.configuration,
        source: 'gs://' + source.bucket, archive: 'gs://' + program.archiveName, scopeFingerprint: canonicalJsonSha256({ source, owned }),
        reviewNotes: 'Setup uses your Google administrator sign-in for project ' + source.projectId + '. Worker ' + program.workerEmail
          + ' receives roles/storage.objectViewer on the source, roles/storage.objectUser on the archive and roles/storage.legacyBucketReader on both buckets.'
          + ' Scheduler ' + program.timerEmail + ' receives roles/run.invoker on job ' + program.jobName + ' for a daily run at 03:00 UTC.'
          + ' Deployment account ' + accounts.deployEmail + ' receives roles/iam.serviceAccountViewer on these two accounts and roles/browser limited to the selected project itself to check its storage policy.',
        reviewPlan: raw => {
          const allowed = reviewGoogleBucketBackupPlan(raw, Object.keys(program.configuration.resources), owned);
          if (!allowed && mismatch) mismatch(googleBackupPlanMismatch(raw, 'daily backup resources'));
          return allowed;
        },
        beforeApply: async () => {
          const current = ctx.repos.environments.findById(env.id);
          if (!current) return false;
          const fresh = await readProgram(project, current, declared, storageName, engine, token, accounts);
          if (!equal(fresh.source, source) || !equal(fresh.owned, owned)) return false;
          // An interrupted apply can leave a real archive before it returns an ID. Keep a cleanup warning
          // across teardown; this possible target never stands in for native ownership or backup evidence.
          const latest = ctx.repos.environments.findById(env.id);
          if (!latest) return false;
          const records = savedRecords.parse(latest.platformBindings.gcpBucketBackups ?? {});
          if (records[storageName]) return equal(records[storageName], pending) || equal(records[storageName], fresh.identity);
          return !!ctx.repos.environments.updatePlatformBindings(env.id, { gcpBucketBackups: { ...records, [storageName]: pending } });
        },
        verifyApplied: async () => {
          for (const wait of [0, 1000, 3000]) {
            if (wait) await delay(wait);
            try {
              const current = ctx.repos.environments.findById(env.id);
              if (!current) return false;
              const observed = await readProgram(project, current, declared, storageName, engine, token, accounts);
              if (!observed.identity || !equal(observed.source, source)) continue;
              const latest = ctx.repos.environments.findById(env.id);
              if (!latest) return false;
              const records = savedRecords.parse(latest.platformBindings.gcpBucketBackups ?? {});
              if (records[storageName] && !equal(records[storageName], pending) && !equal(records[storageName], observed.identity)) return false;
              return !!ctx.repos.environments.updatePlatformBindings(env.id, { gcpBucketBackups: { ...records, [storageName]: observed.identity } });
            } catch { /* A failed read cannot establish completion. Keep the saved engine state for another inspection. */ }
          }
          return false;
        },
      };
    } catch (error) {
      return { blocked: error instanceof GoogleBucketBackupError ? error.message : 'Google Cloud returned incomplete bucket backup identity or permission evidence.' };
    }
  };
}

function accessDescriptor(stage: AccessStage, setupPlanId: string) {
  const { scope } = stage.review;
  return googleBackupAccessDescriptorSchema.parse({ provider: 'gcp', stage: 'restrict-application-storage', storageName: stage.storageName,
    projectId: scope.projectId, source: 'gs://' + scope.source, archive: 'gs://' + scope.archive, runtimeEmail: scope.runtimeEmail,
    setupPlanId, scopeFingerprint: canonicalJsonSha256(stage.review) });
}
function accessAction(stage: AccessStage): PlanAction {
  const { scope, before, after } = stage.review;
  return { id: 'bucket-backup:' + stage.storageName + ':app-access', type: 'replace', resource: { provider: 'gcp', kind: 'project', name: scope.runtimeEmail },
    verified: true, requiresConfirm: true, reason: 'Using your Google administrator sign-in, replace the existing roles/storage.objectUser grant for '
      + scope.runtimeEmail + ' in ' + scope.projectId + ' with the same access excluding gs://' + scope.archive + '. Other buckets and any existing migration export exclusion keep their current access.',
    diff: [{ field: 'storage access condition', from: before?.expression ?? 'Unconditional project storage access', to: after.expression }] };
}
export async function planGcpBucketBackups(ctx: CommandContext, params: EnginePlanParams) {
  let stage: AccessStage | undefined;
  let mismatch: string | undefined;
  const plan = await planCloudBucketBackups(ctx, params, 'gcp', prepareWithGoogleAccount(value => { stage = value; }, reason => { mismatch = reason; }));
  if (mismatch && 'blocked' in plan) return { blocked: [mismatch] };
  if (!stage) return plan;
  const setup = await runGcpProjectSetup(stage.setup);
  if (!setup.success || !setup.planId) return { blocked: [setup.error ?? 'Could not review the original Google application storage permission.'] };
  const descriptor = accessDescriptor(stage, setup.planId);
  return recordEnginePlan({ projectId: params.project.id, environmentId: stage.environmentId, environmentName: params.environmentName,
    specRevision: params.specRevision, scope: 'bucket-backups', engine: { bucketBackup: descriptor },
    actions: [accessAction(stage)],
    warnings: ['After applying this permission change, run hv_plan with scope=backups again to review the separate archive and daily schedule.'] });
}
export async function applyGcpBucketBackups(ctx: CommandContext, params: EngineApplyParams) {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) return { kind: 'blocked' as const, reason: loaded.error };
  const descriptor = googleBackupAccessDescriptorSchema.safeParse((loaded.document.engine as { bucketBackup?: unknown } | undefined)?.bucketBackup).data;
  if (descriptor) {
    const envName = loaded.document.environmentName, id = 'bucket-backup:' + descriptor.storageName + ':app-access';
    const changed = { kind: 'blocked' as const, reason: 'The saved Google Cloud application storage access or its approval changed. Run hv_plan with scope=backups again.' };
    if (loaded.run.projectId !== params.project.id || loaded.document.scope !== 'bucket-backups' || loaded.document.specRevision !== params.specRevision ||
        !params.confirmActions.includes(id) || !params.spec.environments[envName]?.storage?.[descriptor.storageName]?.automatedBackups) return changed;
    let stage: AccessStage | undefined;
    await prepareWithGoogleAccount(value => { stage = value; })(ctx, { project: params.project, spec: params.spec, environmentName: envName, storageName: descriptor.storageName });
    if (!stage || loaded.run.environmentId !== stage.environmentId || !equal(descriptor, accessDescriptor(stage, descriptor.setupPlanId)) ||
        !equal(loaded.document.actions, [accessAction(stage)])) return changed;
    const selected = stage;
    const result = await executor.execute({ planRunId: params.planId, currentSpecRevision: params.specRevision, confirmActions: params.confirmActions,
      handler: async action => {
        if (action.id !== id) return { success: false, message: 'The saved application access action changed.' };
        const outcome = await runGcpProjectSetup({ ...selected.setup, confirm: true, gcpSetupPlanId: descriptor.setupPlanId });
        return { success: outcome.success, message: outcome.success ? 'The original Google storage grant now excludes the backup archive. Run hv_plan with scope=backups to review its daily job.' : outcome.error ?? 'The Google storage restriction could not be verified.' };
      } });
    return { kind: 'executed' as const, envName, result };
  }
  return applyCloudBucketBackups(ctx, params, 'gcp', prepareWithGoogleAccount());
}

export async function observeGcpBucketBackups(project: Project, env: Environment, spec: EnvironmentSpec, storageName: string) {
  try {
    const selected = selectedTarget(project, env, spec, storageName);
    const adapter = await engineGcpAdapter(project, spec.hosting.gcpProjectId);
    if (!adapter || adapter.engineConnection().projectId !== selected.projectId) return;
    const engine = await openTofuEngine();
    if ('blocked' in engine) return;
    const getToken = () => adapter.engineAccessToken();
    const { program, identity } = await readProgram(project, env, spec, storageName, engine, await getToken(), connectionAccounts(adapter.engineConnection()));
    if (!identity) return;
    const { points } = await readGcsDailyBucketBackups(program.runtime(identity.archiveCreated), getToken);
    const latest = points[0];
    if (!latest) return;
    return { source: 'gs://' + identity.source + '#' + program.source.projectNumber + '/' + identity.sourceCreated, startedAt: latest.createdAt,
      archive: 'gs://' + identity.archive + '#' + program.source.projectNumber + '/' + identity.archiveCreated, latestAt: latest.completedAt,
      archiveLocation: 'gs://' + identity.archive, recoveryPoints: points.map(({ date, manifestKey }) => ({ date, manifestKey })) };
  } catch { return; }
}

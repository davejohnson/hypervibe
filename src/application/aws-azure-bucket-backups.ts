import { randomUUID } from 'node:crypto';
import { stateResources } from '../domain/ports/workload-diagnostics.port.js';
import type { EngineAuthentication, EngineConfiguration, EngineStateIdentity, InfrastructureEngineBackend } from '../domain/ports/infrastructure-engine.port.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import { cloudBucketBackupBundle } from '../adapters/providers/cloud-bucket-backup-bundle.js';
import { awsDailyBucketClients, type AwsDailyBucketConfig } from '../adapters/providers/aws/aws-daily-bucket-backup.js';
import { observeAwsBackupBuckets } from '../adapters/providers/aws/aws-bucket-backup-observation.js';
import { buildAwsBucketBackup } from '../adapters/providers/aws/tofu/aws-bucket-backup.config.js';
import { awsEngineBackend } from '../adapters/providers/aws/tofu/aws-engine.backend.js';
import { awsKey } from '../adapters/providers/aws/tofu/aws-engine.config.js';
import { azureBucketId, azureDailyBucketClients, type AzureDailyBucketConfig } from '../adapters/providers/azure/azure-daily-bucket-backup.js';
import { azureBucketBackupAccessReady } from '../adapters/providers/azure/azure-setup.client.js';
import { ARM, AZURE_SCOPES, azureRest, type AzureTokens } from '../adapters/providers/azure/azure-ops.client.js';
import { azureEngineBackend } from '../adapters/providers/azure/tofu/azure-engine.backend.js';
import { buildAzureBucketBackup } from '../adapters/providers/azure/tofu/azure-bucket-backup.config.js';
import { azureKey } from '../adapters/providers/azure/tofu/azure-engine.config.js';
import { observeDailyBucketBackups } from '../domain/services/daily-bucket-backup.service.js';
import { checkBucketEnrollment, decodeEnrollmentWitness, enrolledBucketClients, enrollmentKey } from '../domain/services/bucket-backup-enrollment.js';
import { withBackupEnrollmentProvider } from '../adapters/providers/backup-enrollment-witness.js';
import type { StorageObjectClient } from '../domain/ports/storage.port.js';
import type { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { planCloudBucketBackups, applyCloudBucketBackups, type PrepareBucketBackup } from './cloud-bucket-backup-engine.js';
import type { EnginePlanParams, EngineApplyParams } from './cloud-engines.js';
import { openTofuEngine } from './engine-shared.js';
import { resolveAwsEngineContext } from './infrastructure-engine-aws.js';
import { resolveAzureEngineContext } from './infrastructure-engine-azure.js';
import { createCommandContext, type CommandContext } from './context.js';

type Cloud = 'aws' | 'azure';
type Params = { project: Project; environmentName: string; storageName: string; desired: EnvironmentSpec; spec?: ProjectSpec };
type StateAccess = { auth: EngineAuthentication; backend: InfrastructureEngineBackend; state: EngineStateIdentity };
const emptyConfiguration: EngineConfiguration = { files: {}, resources: {} };
const cleanScope = 'The source, existing archive or workload placement could not be verified against the retained engine state and provider. Preserve the current resources and inspect their ownership.';
function owns(raw: unknown, environmentId: string, label = 'hv-environment'): boolean {
  const tags = raw as Record<string, unknown> | undefined;
  return tags?.['managed-by'] === 'hypervibe' && tags[label] === environmentId.toLowerCase();
}

function retainedEnrollment(rows: ReturnType<typeof stateResources>, cloud: Cloud, source: string, archive: string) {
  const state = rows.get('terraform_data.enrollment');
  const type = cloud === 'aws' ? 'aws_s3_object' : 'azurerm_storage_blob';
  const sourceMarker = rows.get(type + '.source_enrollment'), archiveMarker = rows.get(type + '.archive_enrollment');
  const witnessRow = rows.get('terraform_data.enrollment_witness');
  const scheduled = rows.has(cloud === 'aws' ? 'aws_scheduler_schedule.daily' : 'azurerm_container_app_job.backup');
  if (!state && !sourceMarker && !archiveMarker && !witnessRow && !scheduled) return;
  const id = state?.id;
  const bindings = state?.input as { source?: string; archive?: string } | undefined;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
    bindings?.source !== source || bindings.archive !== archive || (scheduled && !witnessRow) ||
    (witnessRow && (!sourceMarker || !archiveMarker || witnessRow.input !== witnessRow.output))) throw new Error(cleanScope);
  for (const marker of [sourceMarker, archiveMarker]) {
    if (marker && marker[cloud === 'aws' ? 'key' : 'name'] !== enrollmentKey(id)) throw new Error(cleanScope);
  }
  return { id, source: !!sourceMarker, archive: !!archiveMarker, witness: witnessRow ? decodeEnrollmentWitness(witnessRow.output) : undefined };
}

async function verifyEnrollment(markers: ReturnType<typeof retainedEnrollment>, clients: { source: StorageObjectClient; archive: StorageObjectClient }, archivePresent: boolean) {
  try {
    if (!markers) return;
    const key = enrollmentKey(markers.id);
    for (const role of ['source', 'archive'] as const) {
      if (markers[role]) await checkBucketEnrollment(clients[role], markers.id, markers.witness?.[role]);
      else if (role === 'source' || archivePresent) {
        // A provider write may have succeeded before its state was saved. Never overwrite that object on retry.
        const present = await clients[role].list({ prefix: key, maxObjects: 1 });
        if (present.some(object => object.key === key)) throw new Error(cleanScope);
      }
    }
  } finally { clients.source.destroy(); clients.archive.destroy(); }
}

async function stateValue<T>(engine: OpenTofuEngine, access: StateAccess, project: (rows: ReturnType<typeof stateResources>) => T) {
  const inspected = await engine.inspectState({ ...access, configuration: emptyConfiguration, project: raw => project(stateResources(raw)) });
  if (!inspected.ok) throw new Error(cleanScope);
  return inspected.present ? inspected.value : undefined;
}

async function azureResource(tokens: AzureTokens, id: string, version: string) {
  const result = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', ARM + id + '?api-version=' + version);
  if (result.status === 404 && (result.body.error as { code?: string } | undefined)?.code === 'ResourceNotFound') return undefined;
  if (result.status !== 200 || String(result.body.id).toLowerCase() !== id.toLowerCase()) throw new Error(cleanScope);
  return result.body;
}
const azureAccountId = (container: string) => container.split('/blobServices/')[0]!;

export function cloudBucketBackupNames(state: EngineStateIdentity, storageName: string, prefix: string) {
  const suffix = canonicalJsonSha256([state.provider, state.projectId, state.environmentId, storageName]).slice(0, 20);
  return { state: { ...state, environmentId: state.environmentId + '-bk-' + suffix },
    programName: prefix.slice(0, state.provider === 'azure' ? 8 : 10).replace(/-+$/, '') + '-b-' + suffix, suffix };
}
async function currentPlan(engine: OpenTofuEngine, target: StateAccess & { configuration: EngineConfiguration }) {
  const checked = await engine.plan({ ...target, planId: randomUUID() });
  return checked.ok && !checked.blockers.length && !checked.unmanagedDeletes.length && checked.actions.length > 0 &&
    checked.actions.every(action => action.type === 'noop');
}

async function awsProgram(ctx: CommandContext, params: Params, engine: OpenTofuEngine) {
  const { project, environmentName, storageName, desired } = params;
  const context = await resolveAwsEngineContext(ctx, project, environmentName, params.spec);
  if ('blocked' in context) return { blocked: context.blocked };
  const { connection: { accountId, region }, environment, auth, prefix } = context;
  const selected = desired.storage?.[storageName];
  if (desired.hosting.provider !== 'aws' || selected?.provider !== 's3' || !selected.automatedBackups || selected.region !== region) return { blocked: cleanScope };
  const existing = { auth, backend: awsEngineBackend, state: context.state };
  const sourceBucket = await stateValue(engine, existing, rows => {
    const bucket = rows.get('aws_s3_bucket.' + awsKey(storageName));
    if (!bucket || typeof bucket.bucket !== 'string' || bucket.id !== bucket.bucket || bucket.arn !== 'arn:aws:s3:::' + bucket.bucket ||
      !owns(bucket.tags_all, environment.id)) throw new Error(cleanScope);
    return bucket.bucket;
  });
  if (!sourceBucket) return { blocked: 'Deploy the selected S3 source bucket before planning its daily backup.' };
  const named = cloudBucketBackupNames(context.state, storageName, prefix);
  const archiveBucket = 'hv-backup-' + named.suffix + '-' + accountId;
  const config: AwsDailyBucketConfig = { version: 1, provider: 's3', accountId, region, sourceBucket, archiveBucket };
  const backupState = { ...existing, backend: withBackupEnrollmentProvider(existing.backend), state: named.state };
  const retained = await stateValue(engine, backupState, rows => {
    const bucket = rows.get('aws_s3_bucket.archive');
    if (bucket && (bucket.id !== archiveBucket || bucket.arn !== 'arn:aws:s3:::' + archiveBucket || !owns(bucket.tags_all, environment.id))) throw new Error(cleanScope);
    return { bucket: !!bucket, enrollment: retainedEnrollment(rows, 'aws', sourceBucket, archiveBucket) };
  });
  const observed = await observeAwsBackupBuckets(config, environment.id, context.credentials);
  if (!observed) return { blocked: cleanScope };
  const { archivePresent, sourceEpoch } = observed;
  if (archivePresent !== !!retained?.bucket) return { blocked: cleanScope };
  const clients = () => awsDailyBucketClients(config, context.credentials);
  await verifyEnrollment(retained?.enrollment, clients(), archivePresent);
  const configuration = buildAwsBucketBackup({ config, prefix, storageName, environmentId: environment.id, programName: named.programName, worker: cloudBucketBackupBundle('s3') });
  const target = { ...backupState, configuration };
  return { ...target, environmentId: environment.id, source: 'arn:aws:s3:::' + sourceBucket, archive: 'arn:aws:s3:::' + archiveBucket, archiveLocation: 's3://' + archiveBucket,
    sourceEpoch, scopeFingerprint: canonicalJsonSha256([context.state, config, sourceEpoch, archivePresent, retained?.enrollment ?? null]),
    reviewNotes: 'Setup writes one small enrollment marker to the source and archive. The ' + named.programName +
      '-files task role reads the source and manages retained recovery files. The scheduler launches this task daily at 03:17 UTC.',
    verifyApplied: () => currentPlan(engine, target), clients: () => enrolledBucketClients(clients(), retained!.enrollment!.id, retained!.enrollment!.witness!), archivePresent,
    enrolled: !!retained?.enrollment?.witness };
}

async function azureProgram(ctx: CommandContext, params: Params, engine: OpenTofuEngine) {
  const { project, environmentName, storageName, desired } = params;
  const context = await resolveAzureEngineContext(ctx, project, environmentName);
  if ('blocked' in context) return { blocked: context.blocked };
  const { connection: { subscriptionId, resourceGroup, tenantId }, environment, auth, prefix, tokens } = context;
  const selected = desired.storage?.[storageName];
  if (desired.hosting.provider !== 'azure' || selected?.provider !== 'azureblob' || !selected.automatedBackups) return { blocked: cleanScope };
  if (!await azureBucketBackupAccessReady(context.connection)) {
    return { blocked: 'Azure needs owner approval to assign read-only Blob access to the backup job. Use hv_connections provider="azure" action="connect" for this project, then re-plan.' };
  }
  const existing = { auth, backend: azureEngineBackend, state: context.state };
  const source = await stateValue(engine, existing, rows => {
    const account = rows.get('azurerm_storage_account.files');
    const container = rows.get('azurerm_storage_container.' + azureKey(storageName));
    if (!account || !container || typeof account.name !== 'string' || typeof account.location !== 'string' || typeof container.name !== 'string' || typeof container.id !== 'string' ||
        !owns(account.tags, environment.id)) throw new Error(cleanScope);
    const id = azureBucketId(subscriptionId, resourceGroup, account.name, container.name);
    if (String(account.id).toLowerCase() !== azureAccountId(id).toLowerCase() || container.id.toLowerCase() !== id.toLowerCase()) throw new Error(cleanScope);
    return { id, account: account.name, container: container.name, location: account.location };
  });
  if (!source) return { blocked: 'Deploy the selected Azure Blob container before planning its daily backup.' };
  if (source.location.toLowerCase() !== selected.region.toLowerCase()) return { blocked: cleanScope };
  const sourceAccount = await azureResource(tokens, azureAccountId(source.id), '2025-06-01');
  const nativeContainer = await azureResource(tokens, source.id, '2025-08-01');
  if (!sourceAccount || !nativeContainer || !owns(sourceAccount.tags, environment.id) || String(sourceAccount.location).toLowerCase() !== source.location.toLowerCase()) return { blocked: cleanScope };
  const created = (sourceAccount.properties as { creationTime?: string } | undefined)?.creationTime;
  const containerModified = (nativeContainer.properties as { lastModifiedTime?: string; deleted?: boolean } | undefined)?.lastModifiedTime;
  if (!created || !containerModified || !Number.isFinite(Date.parse(created)) || !Number.isFinite(Date.parse(containerModified)) ||
    (nativeContainer.properties as { deleted?: boolean }).deleted === true) return { blocked: cleanScope };
  const sourceEpoch = new Date(Math.max(Date.parse(created), Date.parse(containerModified))).toISOString();
  const named = cloudBucketBackupNames(context.state, storageName, prefix);
  const config: AzureDailyBucketConfig = { version: 1, provider: 'azure-blob', subscriptionId, resourceGroup,
    sourceAccount: source.account, sourceContainer: source.container, archiveAccount: 'hvb' + named.suffix, archiveContainer: 'archive' };
  const archive = azureBucketId(subscriptionId, resourceGroup, config.archiveAccount, config.archiveContainer);
  const backupState = { ...existing, backend: withBackupEnrollmentProvider(existing.backend), state: named.state };
  const retained = await stateValue(engine, backupState, rows => {
    const account = rows.get('azurerm_storage_account.archive');
    const container = rows.get('azurerm_storage_container.archive');
    if (account && (String(account.id).toLowerCase() !== azureAccountId(archive).toLowerCase() || !owns(account.tags, environment.id, 'hv-backup-environment')) ||
      container && (!account || String(container.id).toLowerCase() !== archive.toLowerCase())) throw new Error(cleanScope);
    return { account: !!account, container: !!container, enrollment: retainedEnrollment(rows, 'azure', source.id, archive) };
  });
  const account = await azureResource(tokens, azureAccountId(archive), '2025-06-01');
  if (!!account !== !!retained?.account || account && !owns(account.tags, environment.id, 'hv-backup-environment')) return { blocked: cleanScope };
  const nativeArchive = account ? await azureResource(tokens, archive, '2025-08-01') : undefined;
  if (!!nativeArchive !== !!retained?.container) return { blocked: cleanScope };
  const clients = () => azureDailyBucketClients(config, { getToken: async () => ({ token: await tokens.get(AZURE_SCOPES.storage), expiresOnTimestamp: Date.now() + 5 * 60_000 }) });
  await verifyEnrollment(retained?.enrollment, clients(), !!nativeArchive);
  const configuration = buildAzureBucketBackup({ config, tenantId, location: source.location, environmentId: environment.id,
    storageName, prefix, programName: named.programName, worker: cloudBucketBackupBundle('azure-blob') });
  const target = { ...backupState, configuration };
  return { ...target, environmentId: environment.id, source: source.id, archive,
    archiveLocation: 'https://' + config.archiveAccount + '.blob.core.windows.net/' + config.archiveContainer,
    sourceEpoch, scopeFingerprint: canonicalJsonSha256([context.state, config, sourceEpoch, !!account, !!nativeArchive, retained?.enrollment ?? null]),
    reviewNotes: 'Setup writes one small enrollment marker to the source and archive. The ' + named.programName +
      ' managed identity reads the selected source and manages its private archive. Its dedicated consumption job runs daily at 03:17 UTC.',
    verifyApplied: () => currentPlan(engine, target), archivePresent: !!nativeArchive, enrolled: !!retained?.enrollment?.witness,
    clients: () => enrolledBucketClients(clients(), retained!.enrollment!.id, retained!.enrollment!.witness!) };
}

async function program(ctx: CommandContext, params: Params, provider: Cloud) {
  const engine = await openTofuEngine();
  if ('blocked' in engine) return engine;
  try { return provider === 'aws' ? await awsProgram(ctx, params, engine) : await azureProgram(ctx, params, engine); }
  catch { return { blocked: cleanScope }; }
}
const prepare = (provider: Cloud): PrepareBucketBackup => async (ctx, params) => {
  const inputs = { ...params, desired: params.spec.environments[params.environmentName]! };
  const target = await program(ctx, inputs, provider);
  if ('blocked' in target) return { blocked: target.blocked! };
  return { ...target, beforeApply: async () => {
    const current = await program(ctx, inputs, provider);
    return !('blocked' in current) && current.scopeFingerprint === target.scopeFingerprint;
  }, verifyApplied: async () => {
    const current = await program(ctx, inputs, provider);
    return !('blocked' in current) && current.archivePresent && current.enrolled && current.verifyApplied();
  } };
};
export const planAwsBucketBackups = (ctx: CommandContext, params: EnginePlanParams) => planCloudBucketBackups(ctx, params, 'aws', prepare('aws'));
export const applyAwsBucketBackups = (ctx: CommandContext, params: EngineApplyParams) => applyCloudBucketBackups(ctx, params, 'aws', prepare('aws'));
export const planAzureBucketBackups = (ctx: CommandContext, params: EnginePlanParams) => planCloudBucketBackups(ctx, params, 'azure', prepare('azure'));
export const applyAzureBucketBackups = (ctx: CommandContext, params: EngineApplyParams) => applyCloudBucketBackups(ctx, params, 'azure', prepare('azure'));

export async function observeAwsAzureBucketBackups(project: Project, environment: Environment, desired: EnvironmentSpec, storageName: string) {
  const provider = desired.hosting.provider;
  if (project.id !== environment.projectId || !desired.storage?.[storageName]?.automatedBackups || (provider !== 'aws' && provider !== 'azure')) return;
  const selected = await program(createCommandContext(), { project, environmentName: environment.name, desired, storageName }, provider);
  if ('blocked' in selected || selected.environmentId !== environment.id || !selected.archivePresent || !selected.enrolled || !await selected.verifyApplied()) return;
  const clients = await selected.clients();
  try {
    const evidence = await observeDailyBucketBackups(clients);
    const point = evidence.points.filter(row => Date.parse(row.createdAt) >= Date.parse(selected.sourceEpoch))
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
    return point ? { source: selected.source, archive: selected.archive, latestAt: point.completedAt, startedAt: point.createdAt, archiveLocation: selected.archiveLocation,
      recoveryPoints: evidence.points.map(({ date, manifestKey }) => ({ date, manifestKey })) } : undefined;
  } finally { clients.source.destroy(); clients.archive.destroy(); }
}

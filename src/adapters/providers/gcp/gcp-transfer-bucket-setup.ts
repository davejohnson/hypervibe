import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { inspectTransferIsolation, ProbeProblem } from '../../../application/gcp-transfer-access-readiness.js';
import { engineBucketName } from '../../../application/infrastructure-engine.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { MigrationAccessCapability } from '../../../domain/registry/provider.registry.js';
import { adapterFactory } from '../../../domain/services/adapter.factory.js';
import { runGcpProjectSetup } from '../../../domain/services/gcp-project-setup.service.js';
import { parseStorageBindings } from '../../../domain/services/storage-plan.service.js';
import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { SpecStore } from '../../../domain/spec/spec.store.js';
import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { OpenTofuEngine } from '../../engine/opentofu/engine.js';
import { enginePluginCacheDir, ensureEngineBinary } from '../../engine/opentofu/install.js';
import { getSecretStore } from '../../secrets/secret-store.js';
import { cloudRunJobRequest } from './gcp-cloud-run.client.js';
import { TransferEvidenceError } from './gcp-transfer-slot-evidence.js';
import { gcpEngineBackend, storageEngineKey } from './tofu/gcp-engine.backend.js';
import { transferBucketJob, type TransferBucketJobScope, type TransferBucketJobEvidence } from './tofu/transfer-bucket-job.js';
import type { TransferSlotTarget } from './tofu/transfer-slot.js';

type Request = Parameters<MigrationAccessCapability['prepare']>[0];
const record = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
function reject(message: string): never { throw new TransferEvidenceError(message); }

export function selectTransferBucket(spec: ProjectSpec | undefined, source: Environment | null, target: Environment | null,
  scope: TransferSlotTarget, storageName: string) {
  const from = source && spec?.environments[source.name], to = target && spec?.environments[target.name];
  const binding = parseStorageBindings(source)[storageName];
  const deployed = record(target?.platformBindings.engine)?.storage;
  const railwayScope = { projectId: scope.sourceRailwayProjectId, environmentId: scope.sourceRailwayEnvironmentId };
  if (!/^[a-z][a-z0-9-]{0,60}$/.test(storageName) || source?.id !== scope.sourceEnvironmentId || target?.id !== scope.targetEnvironmentId
    || source.projectId !== target.projectId || source.platformBindings.provider !== 'railway' || from?.hosting.provider !== 'railway'
    || source.platformBindings.projectId !== railwayScope.projectId || source.platformBindings.environmentId !== railwayScope.environmentId
    || target.platformBindings.provider !== 'cloudrun' || target.platformBindings.projectId !== scope.projectId
    || target.platformBindings.environmentId !== scope.targetRegion || record(target.platformBindings.engine)?.kind !== 'opentofu'
    || to?.hosting.provider !== 'cloudrun' || (to.hosting.gcpProjectId && to.hosting.gcpProjectId !== scope.projectId)
    || (to.hosting.region && to.hosting.region !== scope.targetRegion)
    || from.storage?.[storageName]?.provider !== 'railway' || from.storage[storageName].purpose === 'backup'
    || to.storage?.[storageName]?.provider !== 'gcs' || to.storage[storageName].purpose === 'backup'
    || !Array.isArray(deployed) || deployed.filter(name => name === storageName).length !== 1 || !binding
    || binding.provider !== 'railway' || binding.purpose === 'backup' || !isDeepStrictEqual(binding.instanceScope, railwayScope)
    || typeof binding.externalId !== 'string' || !binding.externalId || binding.externalId.trim() !== binding.externalId
    || Object.values(parseStorageBindings(source)).filter(item => item?.externalId === binding.externalId).length !== 1) {
    reject('Select one deployed Railway data bucket and its matching managed Google Cloud data bucket in these environments.');
  }
  return { sourceBucketId: binding.externalId, targetBucket: engineBucketName(scope.projectId, target.name, storageName),
    location: to.storage[storageName].region.toUpperCase() };
}

export function ownedBucketInState(raw: unknown, scope: TransferBucketJobScope, projectNumber: string, created: string, location: string) {
  const rows = record(record(record(raw)?.values)?.root_module)?.resources;
  if (!Array.isArray(rows)) return false;
  const selected = rows.map(record).filter(row => row?.address === 'google_storage_bucket.' + storageEngineKey(scope.storageName));
  const row = selected[0], v = record(row?.values), labels = record(v?.labels);
  return selected.length === 1 && row?.mode === 'managed' && row.type === 'google_storage_bucket'
    && row.provider_name === 'registry.opentofu.org/hashicorp/google' && row.deposed_key === undefined && !row.tainted
    && v?.id === scope.targetBucket && v.name === scope.targetBucket && v.project === scope.target.projectId
    && String(v.project_number) === projectNumber && v.time_created === created && v.location === location
    && v.uniform_bucket_level_access === true && v.public_access_prevention === 'enforced'
    && labels?.['managed-by'] === 'hypervibe' && labels['hv-storage'] === scope.storageName
    && labels['hv-environment'] === scope.target.targetEnvironmentId.toLowerCase();
}

const policySchema = z.object({ version: z.union([z.literal(0), z.literal(1), z.literal(3)]).optional(),
  etag: z.string().min(1), bindings: z.array(z.object({ role: z.string().min(1), members: z.array(z.string().min(1)).min(1),
    condition: z.object({ expression: z.string().min(1) }).optional() })).optional() });
export function observeCopyGrants(raw: unknown, email: string, uniqueId: string, scope: TransferBucketJobScope, projectNumber: string, projectWide = false) {
  const policy = policySchema.safeParse(raw);
  if (!policy.success || (!projectWide && (record(raw)?.resourceId !== 'projects/_/buckets/' + scope.targetBucket || record(raw)?.kind !== 'storage#policy'))) {
    reject('Google did not return the complete IAM policy for the selected resource.');
  }
  const roles = new Set<string>();
  for (const binding of policy.data.bindings ?? []) {
    if (binding.role.includes('_withcond_') || (binding.condition && policy.data.version !== 3)) reject('A bucket copy permission could not be identified.');
    for (const member of binding.members) {
      const set = /^principalSet:\/\/cloudresourcemanager\.googleapis\.com\/(projects|folders|organizations)\/([^/]+)\/type\/ServiceAccount$/.exec(member);
      const broad = member === 'allUsers' || member === 'allAuthenticatedUsers' || (set && (set[1] !== 'projects' || [projectNumber, scope.target.projectId].includes(set[2]!)));
      const alternate = member === 'principal://iam.googleapis.com/projects/-/serviceAccounts/' + uniqueId;
      if (broad || alternate) reject('A broad or additional grant could give the copy account unreviewed access.');
      if (member !== 'serviceAccount:' + email) continue;
      if (projectWide || binding.condition || roles.has(binding.role) || !['roles/storage.objectViewer', 'roles/storage.objectCreator'].includes(binding.role)) {
        reject('The copy account has an additional, conditional or duplicate grant. Review its access before preparing this job.');
      }
      roles.add(binding.role);
    }
  }
  return { viewer: roles.has('roles/storage.objectViewer'), creator: roles.has('roles/storage.objectCreator') };
}

const metadataSchema = z.object({ name: z.string(), id: z.string(), projectNumber: z.string(), timeCreated: z.iso.datetime({ offset: true }),
  location: z.string(), labels: z.record(z.string(), z.string()), iamConfiguration: z.object({ publicAccessPrevention: z.literal('enforced'),
    uniformBucketLevelAccess: z.object({ enabled: z.literal(true) }) }) });

// Include the complete template so an extra sidecar, secret, volume, command or task option stays visible.
const jobFields = 'name,uid,labels,annotations,launchStage,binaryAuthorization,deleteTime,generation,observedGeneration,terminalCondition(type,state),reconciling,executionCount,latestCreatedExecution,template,startExecutionToken,runExecutionToken';
function idleJobUid(raw: unknown, job: ReturnType<typeof transferBucketJob>, projectNumber: string) {
  const obj = record(raw), labels = record(obj?.labels), ready = record(obj?.terminalCondition);
  const { target } = job.scope;
  if (!obj || ![target.projectId, projectNumber].some(project =>
    obj.name === 'projects/' + project + '/locations/' + target.targetRegion + '/jobs/' + job.jobId)
    || typeof obj.uid !== 'string' || !z.uuidv4().safeParse(obj.uid).success || obj.deleteTime !== undefined
    || typeof obj.generation !== 'string' || !/^[1-9]\d*$/.test(obj.generation) || obj.observedGeneration !== obj.generation
    || (obj.reconciling !== undefined && obj.reconciling !== false) || ready?.type !== 'Ready' || ready.state !== 'CONDITION_SUCCEEDED'
    || (obj.executionCount !== undefined && obj.executionCount !== 0) || obj.latestCreatedExecution !== undefined
    || obj.startExecutionToken !== undefined || obj.runExecutionToken !== undefined
    || (obj.launchStage !== undefined && obj.launchStage !== job.spec.launch_stage) || obj.binaryAuthorization !== undefined
    || (obj.annotations !== undefined && !isDeepStrictEqual(obj.annotations, {}))
    || !labels || !Object.entries(job.spec.labels).every(([key,value]) => labels[key] === value)) {
    reject('Google could not verify a ready, unused copy job with the reviewed identity and observed generation.');
  }
  const requested = job.spec.template[0]!, task = requested.template[0]!, container = task.containers[0]!;
  const template = record(obj.template), nativeTask = record(template?.template);
  const containers = nativeTask?.containers, native = Array.isArray(containers) && containers.length === 1 ? record(containers[0]) : undefined;
  const resources = record(native?.resources), limits = record(resources?.limits);
  // The JSON API spells CPU as either a number of cores or a millicore quantity.
  const cpu = limits?.cpu === '1000m' ? '1' : limits?.cpu;
  const sameLimits = isDeepStrictEqual({ ...limits, cpu }, container.resources[0]!.limits);
  const expectedContainer = { name: container.name, image: container.image, command: container.command, args: container.args,
    env: container.env, resources: { limits: limits } };
  const expectedTemplate = { taskCount: requested.task_count, parallelism: requested.parallelism, template: {
    serviceAccount: task.service_account, executionEnvironment: task.execution_environment, maxRetries: task.max_retries,
    timeout: task.timeout, containers: [expectedContainer],
  } };
  if (!sameLimits || !isDeepStrictEqual(template, expectedTemplate)) {
    reject('The live copy job differs from the reviewed account, worker or task settings.');
  }
  return obj.uid;
}

export async function prepareTransferBucketJob(input: Request, target: TransferSlotTarget) {
  try {
    const { project, storageName } = input;
    if (!storageName) reject('Name the data bucket to prepare for this copy.');
    const observe = async () => {
      const store = new EnvironmentRepository();
      const source = store.findByProjectAndName(project.id, input.sourceEnvironment), destination = store.findByProjectAndName(project.id, input.targetEnvironment);
      const { sourceBucketId, targetBucket, location } = selectTransferBucket(new SpecStore().getForInspection(project)?.spec, source, destination, target, storageName);
      const railway = await adapterFactory.getStorageOperations('railway', project, { environment: source });
      if (!railway.success || !railway.adapter.getMigrationBucketName) reject('Restore the Railway connection for this source project.');
      const sourceBucketName = await railway.adapter.getMigrationBucketName({
        projectId: target.sourceRailwayProjectId, environmentId: target.sourceRailwayEnvironmentId,
      }, sourceBucketId)
        .catch(() => reject('Railway could not verify the selected bucket and its native S3 name in the source environment.'));
      const scope = { target, storageName, sourceBucketId, sourceBucketName, targetBucket }, job = transferBucketJob(scope);
      const token = await input.token();
      const isolation = await inspectTransferIsolation({ ...input, target, targetEnvironmentName: input.targetEnvironment,
        sourceEnvironmentName: input.sourceEnvironment, confirm: !!input.planId }, token);
      const { projectNumber, copyUniqueId } = isolation.scope;
      const auth = { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token, GOOGLE_PROJECT: target.projectId }, redact: [token] };
      const read = async (url: string, body?: string) => {
        const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          ...(body && { body }), signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!r.ok) reject('Google could not verify the selected bucket metadata and permissions.');
        return r.json() as Promise<unknown>;
      };
      const bucketUrl = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(targetBucket);
      const [meta, policy, projectPolicy, jobResponse] = await Promise.all([
        read(bucketUrl + '?fields=name,id,projectNumber,timeCreated,location,labels,iamConfiguration'),
        read(bucketUrl + '/iam?optionsRequestedPolicyVersion=3'),
        read('https://cloudresourcemanager.googleapis.com/v3/projects/' + projectNumber + ':getIamPolicy', JSON.stringify({ options: { requestedPolicyVersion: 3 } })),
        cloudRunJobRequest(token, { gcpProjectId: target.projectId, region: target.targetRegion }, '/' + job.jobId + '?fields=' + jobFields),
      ]);
      observeCopyGrants(projectPolicy, job.accountEmail, copyUniqueId, scope, projectNumber, true);
      const grants = observeCopyGrants(policy, job.accountEmail, copyUniqueId, scope, projectNumber);
      const m = metadataSchema.safeParse(meta);
      if (!m.success || m.data.name !== targetBucket || m.data.id !== targetBucket || m.data.projectNumber !== projectNumber || m.data.location !== location
        || m.data.labels['managed-by'] !== 'hypervibe' || m.data.labels['hv-environment'] !== target.targetEnvironmentId.toLowerCase() || m.data.labels['hv-storage'] !== storageName) {
        reject('Google could not verify the identity and ownership of the selected data bucket.');
      }
      const binary = await ensureEngineBinary();
      if (!binary.ok) reject('The private infrastructure engine is unavailable.');
      const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir() });
      const state = await engine.inspectState({ backend: gcpEngineBackend, configuration: { files: {}, resources: {} }, auth,
        state: { projectId: project.id, environmentId: target.targetEnvironmentId, partition: 'environment', provider: 'gcp' },
        project: raw => ownedBucketInState(raw, scope, projectNumber, m.data.timeCreated, location) });
      if (!state.ok || !state.present || !state.value) reject('The live bucket does not match its original identity in the private target environment state.');
      let jobUid: string | null = null;
      if (jobResponse.ok) {
        jobUid = idleJobUid(await jobResponse.json(), job, projectNumber);
      } else if (jobResponse.status !== 404 || record(record(await jobResponse.json())?.error)?.status !== 'NOT_FOUND') reject('Google could not verify whether the exact copy job already exists.');
      const evidence: TransferBucketJobEvidence = { projectNumber, copyUniqueId, bucketTimeCreated: m.data.timeCreated, jobUid, ...grants };
      return { scope, evidence, job, auth };
    };
    const initial = await observe();
    return { ...await runGcpProjectSetup({ projectId: project.id, projectName: project.name, gcpProjectId: target.projectId, auth: initial.auth,
      confirm: !!input.planId, gcpSetupPlanId: input.planId, requireBrowserApproval: input.requireBrowserApproval,
      contribution: { id: initial.job.id, configuration: initial.job.configuration }, authenticationScope: 'migration:prepare-bucket-copy:' + initial.job.id,
      transferBucketJobReview: { scope: initial.scope, evidence: initial.evidence }, observeBucketJobAfterApply: async () => {
        const fresh = await observe();
        if (!isDeepStrictEqual(fresh.scope, initial.scope)) reject('The selected Railway or Google Cloud bucket changed during setup.');
        return fresh.evidence;
      } }) };
  } catch (error) {
    return { success: false, error: error instanceof TransferEvidenceError || error instanceof ProbeProblem ? error.message :
      'Hypervibe could not verify the selected Railway bucket and Google Cloud copy setup. Restore metadata access and preview again.' };
  }
}

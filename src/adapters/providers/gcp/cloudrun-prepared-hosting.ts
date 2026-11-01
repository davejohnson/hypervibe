import type { CloudDeploymentConnectionV1, CloudDeploymentSourceAuthorizationV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { cloudDeploymentEffectiveSourceV1 } from '../../../domain/services/cloud-deployment-authentication.js';
import { preparedHostingMarkerSchema, preparedHostingReleaseEvidenceSchema, type IPreparedHosting, type PreparedHostingBindings, type LocalPreparedHostingLoader,
  type PreparedDirectReleaseEvidence, type PreparedReleaseTaskAdoption } from '../../../domain/ports/hosting-prepared.port.js';
import { createGcpCloudDeploymentDriver, parseGcpPreparedResources } from './gcp-cloud-deployment.js';
import { gcpPreparedApplicationConfiguration, gcpPreparedApplicationDigest, gcpObservedPreparedApplicationConfiguration } from './gcp-prepared-release.js';
import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { describePreparedHosting } from '../../../domain/services/hosting-prepared.service.js';
import { readGcpLocalPreparedResources } from './gcp-local-holding-preparation.js';
import { preparedReleaseAttempts } from '../../../domain/services/prepared-direct-release.service.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { gcpHoldingConfigurationDigest, gcpObservedHoldingConfiguration } from './gcp-prepared-hosting.js';
import { CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION, cloudRunMigrationJobName, cloudRunUnexecutedReleaseJob, verifyCloudRunPreparedExecution, cloudRunPreparedReleaseJobSpec, cloudRunReleaseCommandHash } from './cloudrun-release-command.js';

/** Native read proof for the isolated local metadata frontier. It never adopts
 * or writes cloud resources, and holding readiness is not app convergence. */
export class CloudRunPreparedHosting implements IPreparedHosting {
  constructor(private readonly connection: () => CloudDeploymentConnectionV1, private readonly token: () => Promise<string>, private readonly request: typeof fetch = fetch,
    private readonly sourceAuthorization: () => CloudDeploymentSourceAuthorizationV1 | undefined = () => undefined,
    private readonly local: () => LocalPreparedHostingLoader | undefined = () => undefined) {}
  async inspect({ environment, environmentSpec, releaseEvidence, runtimeEnvVarsByService, preserveReviewedRuntime }: Parameters<IPreparedHosting['inspect']>[0]): ReturnType<IPreparedHosting['inspect']> {
    try {
      const local = this.local(), receipt = local ? await local() : this.connection();
      const connection = describePreparedHosting(receipt), prepared = receipt.purpose === 'deployment'
        ? parseGcpPreparedResources(receipt.preparedResources, receipt) : receipt.preparedResources;
      const driver = createGcpCloudDeploymentDriver({ fetch: this.request });
      if (environment.name !== connection.environment || environment.platformBindings.projectId !== connection.nativeScope.projectId) return { state: 'unknown' };
      if (receipt.purpose === 'deployment') driver.deployment!.assertSourcePlacement!({ environments: { [connection.environment]: environmentSpec } } as ProjectSpec, receipt);
      else if (environmentSpec.hosting.provider !== connection.hostingProvider || environmentSpec.hosting.region !== connection.deployment.region
        || JSON.stringify(Object.keys(environmentSpec.services).sort()) !== JSON.stringify(connection.deployment.workloads.map(item => item.name).sort())
        || connection.deployment.workloads.some(item => environmentSpec.services[item.name]?.workloadKind !== item.kind
          || (item.kind === 'web' && environmentSpec.services[item.name]?.public !== false) !== item.public)) return { state: 'unknown' };
      const receiptDigest = connection.receiptDigest, previous = environment.platformBindings.preparedHosting === undefined ? undefined
        : preparedHostingMarkerSchema.parse(environment.platformBindings.preparedHosting);
      const release = releaseEvidence === undefined ? undefined : preparedHostingReleaseEvidenceSchema.parse(releaseEvidence);
      const source = receipt.purpose === 'deployment' ? cloudDeploymentEffectiveSourceV1(receipt, this.sourceAuthorization()) : undefined;
      if (release && (!source || release.repository.replace(/^github\.com\//, '') !== source.repository.replace(/^github\.com\//, '')
        || release.branch !== source.branch)) return { state: 'unknown' };
      if (previous && (previous.installationId !== connection.installationId || previous.planDigest !== connection.planDigest || previous.receiptDigest !== receiptDigest)) return { state: 'unknown' };
      const observed = receipt.purpose === 'deployment' ? await driver.readPrepared(receipt, await this.token(), AbortSignal.timeout(30000))
        : await readGcpLocalPreparedResources(receipt, await this.token(), AbortSignal.timeout(30000), this.request);
      const pending = previous ? [...previous.pendingFirstRelease] : prepared.workloads.map(item => item.workload);
      const configurations: Record<string, string> = {}, services: PreparedHostingBindings['services'] = {};
      const taskAdoptions: PreparedReleaseTaskAdoption[] = [];
      const directReleaseEvidence: PreparedDirectReleaseEvidence[] = [], attempts = preparedReleaseAttempts(environment);
      for (const item of prepared.workloads) {
        const workload = connection.deployment.workloads.find(value => value.name === item.workload)!;
        const native = observed.workloads[item.workload] as any, desired = environmentSpec.services[item.workload];
        const runtime = connection.runtimeIdentities.find(value => value.workload === item.workload)?.principal;
        if (!desired || workload.kind === 'cron' || runtime?.kind !== 'gcp-service-account') return { state: 'unknown' };
        const holding = native.template.serviceAccount === (item.holding.principal.kind === 'gcp-service-account' ? item.holding.principal.serviceAccountEmail : '');
        if (receipt.purpose === 'local-holding') {
          if (holding) {
            const config = gcpObservedHoldingConfiguration(native, { id: item.id, lifetimeId: item.lifetimeId, image: item.holding.image,
              serviceAccountEmail: native.template.serviceAccount, publicAccess: workload.public === true });
            if (gcpHoldingConfigurationDigest(config) !== item.holding.configurationDigest || native.generation !== item.holding.generation
              || native.latestReadyRevision !== item.holding.revision) return { state: 'unknown' };
          } else {
            const image = native.template.containers?.[0]?.image;
            if (native.template.serviceAccount !== runtime.serviceAccountEmail || typeof image !== 'string'
              || !image.startsWith(`${connection.deployment.region}-docker.pkg.dev/${connection.nativeScope.projectId}/${prepared.registry.id.split('/').at(-1)}/`)
              || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image) || native.template.containers.length !== 1
              || !native.etag || native.reconciling === true || !/^[1-9]\d*$/.test(String(native.generation))
              || native.generation !== native.observedGeneration || native.terminalCondition?.state !== 'CONDITION_SUCCEEDED'
              || !native.latestCreatedRevision?.startsWith(`${item.id}/revisions/`) || native.latestReadyRevision !== native.latestCreatedRevision) return { state: 'unknown' };
          }
        }
        if (!pending.includes(item.workload) && holding) return { state: 'unknown' };
        const attempt = attempts[item.workload];
        if (holding && receipt.purpose === 'local-holding' && attempt && ['attempted', 'uncertain'].includes(attempt.status)
          && !attempt.rolloutAttempted && attempt.target.releaseCommandHash && attempt.releaseTask
          && (attempt.releaseTask.phase === 'create-started' || attempt.releaseTask.phase === 'job-ready' && attempt.releaseTask.adopted)) {
          const jobName = `projects/${connection.nativeScope.projectId}/locations/${connection.deployment.region}/jobs/${cloudRunMigrationJobName(item.id.split('/').at(-1)!)}`;
          if (attempt.releaseTask.jobName !== jobName || attempt.target.resourceUid !== item.lifetimeId) return { state: 'unknown' };
          const response = await this.request(`https://run.googleapis.com/v2/${jobName}`, {
            headers: { Authorization: `Bearer ${await this.token()}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
          if (!response.ok) return { state: 'unknown' };
          const job = await response.json() as any, container = job.template?.template?.containers?.[0];
          if (!cloudRunUnexecutedReleaseJob(job, jobName) || job.template.template.containers.length !== 1
            || job.template.template.serviceAccount !== runtime.serviceAccountEmail || container?.image !== attempt.target.imageUri
            || JSON.stringify(container.command) !== '["/bin/sh"]' || !Array.isArray(container.args) || container.args.length !== 2
            || container.args[0] !== '-lc' || typeof container.args[1] !== 'string'
            || cloudRunReleaseCommandHash(container.args[1]) !== attempt.target.releaseCommandHash) return { state: 'unknown' };
          const executions = await this.request(`https://run.googleapis.com/v2/${jobName}/executions?pageSize=1`, {
            headers: { Authorization: `Bearer ${await this.token()}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
          if (!executions.ok) return { state: 'unknown' };
          const inventory = await executions.json() as any;
          if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) || inventory.nextPageToken
            || inventory.executions !== undefined && (!Array.isArray(inventory.executions) || inventory.executions.length)) return { state: 'unknown' };
          taskAdoptions.push({ workload: item.workload, attemptId: attempt.id, jobName, jobUid: job.uid, jobEtag: job.etag });
        }
        if (!holding && attempt?.target.releaseCommandHash) {
          const task = attempt.releaseTask;
          if (task?.phase !== 'completed' || !attempt.rolloutAttempted
            || native.annotations?.[CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION] !== attempt.target.releaseCommandHash) return { state: 'unknown' };
          const prefix = `projects/${connection.nativeScope.projectId}/locations/${connection.deployment.region}/jobs/`;
          if (!task.jobName.startsWith(prefix) || !/^[a-z][a-z0-9-]+$/.test(task.jobName.slice(prefix.length))
            || !task.executionName?.startsWith(`${task.jobName}/executions/`)
            || !/^[a-zA-Z0-9-]+$/.test(task.executionName.slice(`${task.jobName}/executions/`.length))) return { state: 'unknown' };
          const response = await this.request(`https://run.googleapis.com/v2/${task.executionName}`, {
            headers: { Authorization: `Bearer ${await this.token()}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
          if (!response.ok) return { state: 'unknown' };
          const execution = await response.json() as any, command = execution.template?.containers?.[0]?.args?.[1];
          if (execution.name !== task.executionName || execution.uid !== task.executionUid || typeof command !== 'string'
            || cloudRunReleaseCommandHash(command) !== attempt.target.releaseCommandHash
            || !await verifyCloudRunPreparedExecution({ execution, jobResource: task.jobName, jobUid: task.jobUid!,
              projectNumber: connection.nativeScope.projectNumber, token: await this.token(), request: this.request,
              expected: cloudRunPreparedReleaseJobSpec(gcpObservedPreparedApplicationConfiguration(native), attempt.target.imageUri, command) })) return { state: 'unknown' };
        }
        if (!holding && attempt && (pending.includes(item.workload) && ['attempted', 'uncertain'].includes(attempt.status) || attempt.status === 'completed')
          && attempt.target.receiptDigest === receiptDigest && attempt.target.resourceUid === item.lifetimeId
          && attempt.target.resourceId === item.id.split('/').at(-1) && attempt.target.holdingRevision === item.holding.revision
          && attempt.target.imageUri === native.template.containers[0].image
          && (attempt.status === 'completed' || attempt.target.configurationDigest === previous?.firstReleaseConfigurationDigests?.[item.workload])
          && gcpPreparedApplicationDigest(gcpObservedPreparedApplicationConfiguration(native)) === attempt.target.configurationDigest) {
          directReleaseEvidence.push({ schemaVersion: 1, kind: 'native-direct', attemptId: attempt.id, target: attempt.target,
            revision: String(native.latestReadyRevision), generation: String(native.generation) });
          if (pending.includes(item.workload)) pending.splice(pending.indexOf(item.workload), 1);
        }
        const target = release?.targets.find(value => value.workload === item.workload);
        if (!holding && pending.includes(item.workload) && previous?.firstReleaseConfigurationDigests?.[item.workload]
          && target?.kind === 'service' && target.resourceId === item.id.split('/').at(-1) && target.resourceUid === item.lifetimeId
          && native.template.containers[0].image === release?.imageUri
          && gcpPreparedApplicationDigest(gcpObservedPreparedApplicationConfiguration(native)) === previous.firstReleaseConfigurationDigests[item.workload])
          pending.splice(pending.indexOf(item.workload), 1);
        if (preserveReviewedRuntime && receipt.purpose === 'local-holding' && pending.includes(item.workload)) {
          if (!previous?.firstReleaseConfigurationDigests?.[item.workload]) return { state: 'unknown' };
          configurations[item.workload] = previous.firstReleaseConfigurationDigests[item.workload];
        } else if (pending.includes(item.workload)) configurations[item.workload] = gcpPreparedApplicationDigest(gcpPreparedApplicationConfiguration({
          workloadKind: workload.kind, publicAccess: workload.public === true, serviceAccountEmail: runtime.serviceAccountEmail,
          envVars: gcpPreparedRuntimeEnvVars(runtimeEnvVarsByService?.[item.workload] ?? environmentSpec.envVars, item.workload),
          secretVersionRefs: receipt.purpose === 'deployment' ? Object.fromEntries(workload.runtimeSecrets.map(value => [value.key, value.reference]))
            : Object.fromEntries(Object.entries(environmentSpec.secretDestinations ?? {}).map(([key, value]) => [key, runtimeSecretReferenceSchema.parse(value)])),
          startCommand: desired.startCommand?.trim() || null, healthCheckPath: desired.healthCheckPath?.trim() || null,
          instanceBounds: desired.instanceBounds,
        }));
        services[item.workload] = { serviceId: item.id.split('/').at(-1)!, resourceUid: item.lifetimeId, resourceType: 'service',
          workloadKind: workload.kind, imageUri: String(native.template.containers[0].image) };
      }
      // Only native convergence plus the independently verified managed release
      // and the prior reviewed configuration can retire a pending workload.
      return { state: 'verified', bindings: { provider: 'cloudrun', projectId: connection.nativeScope.projectId,
        environmentId: connection.deployment.region, providerScope: {
          ...(receipt.purpose === 'local-holding' ? parseHostingBindings(environment).providerScope : {}),
          projectId: connection.nativeScope.projectId, region: connection.deployment.region,
          artifactRepository: prepared.registry.id.split('/').at(-1)!, artifactRepositoryCreateTime: prepared.registry.lifetimeId }, services },
      preparation: { schemaVersion: 1, installationId: connection.installationId, planDigest: connection.planDigest, receiptDigest,
        pendingFirstRelease: pending, firstReleaseConfigurationDigests: configurations }, ...(directReleaseEvidence.length ? { directReleaseEvidence } : {}), ...(taskAdoptions.length ? { taskAdoptions } : {}) };
    } catch { return { state: 'unknown' }; }
  }
}

/** Same transport-only keys excluded from first-release review and execution. */
export function gcpPreparedRuntimeEnvVars(values: Record<string, string>, workload: string): Record<string, string> {
  const suffix = workload.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const internal = new Set(['IMAGE_URI', `IMAGE_URI_${suffix}`, 'HYPERVIBE_SOURCE_REPO_URL', 'HYPERVIBE_SOURCE_REVISION',
    'HYPERVIBE_ARTIFACT_REPOSITORY', 'HYPERVIBE_GITHUB_TOKEN', 'HYPERVIBE_CRON_TIME_ZONE']);
  return Object.fromEntries(Object.entries(values).filter(([key]) => !internal.has(key)));
}

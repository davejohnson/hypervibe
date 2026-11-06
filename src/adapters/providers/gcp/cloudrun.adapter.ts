import { createCloudRunRegistryCredentialLifecycle } from './cloudrun-registry-credential.js';
import { z } from 'zod';
import type {
  IProviderAdapter,
  DeploymentMutationOptions,
  Receipt,
  JobResult,
  ProviderCapabilities,
  ProviderRuntimeIdentity,
} from '../../../domain/ports/provider.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import { serviceWorkloadKind, type Service } from '../../../domain/entities/service.entity.js';
import { providerRegistry, type ProviderInspectionRequest } from '../../../domain/registry/provider.registry.js';
import { parseHostingBindings, type EnvironmentTaskOptions, type GetLogsOptions, type LogEntry } from '../../../domain/ports/hosting.port.js';
import { cloudRunJobUpdateBody } from './cloudrun-job-request.js';
import { parseServiceVolumeBindings } from '../../../domain/services/service-volume.service.js';
import { hashEnvValue, type ObservedService, type ObservedState } from '../../../domain/ports/observe.port.js';
import { generatedContainerDockerfile } from '../../../domain/services/generated-container.js';
import type {
  IWorkloadMaintenanceAdapter,
  MaintenanceWorkloadObservation,
  MaintenanceWorkloadSnapshot,
} from '../../../domain/ports/maintenance.port.js';
import type {
  IProviderDeploymentsAdapter,
  IProviderRuntimeLogsAdapter,
  ProviderDeployment,
  ProviderDeploymentsRequest,
  ProviderRuntimeLogsRequest,
  ProviderRuntimeLogsResult,
} from '../../../domain/ports/provider-logs.port.js';
import type {
  IProviderEnvironmentVariablesAdapter,
  ProviderEnvironmentVariablesRequest,
  ProviderEnvironmentVariablesResult,
} from '../../../domain/ports/provider-env-vars.port.js';
import type {
  DeploySourceCredentialProjection,
  IDeploySourceCredentialAdapter,
} from '../../../domain/ports/deploy-source.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import {
  CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION,
  cloudRunMigrationJobName,
  cloudRunReleaseJobConfigurationMismatch,
} from './cloudrun-release-command.js';

// Credentials schema for self-registration
const CloudRunAuthenticationSchema = z.object({
  projectId: z.string().min(1, 'GCP Project ID is required'),
  credentials: z.string().min(1, 'Service account JSON is required'),
  runtimeServiceAccountEmail: z.string().trim().email('Runtime service account email must be valid').optional(),
}).strict().superRefine((value, context) => {
  if (
    value.runtimeServiceAccountEmail
    && !value.runtimeServiceAccountEmail.toLowerCase().endsWith(`@${value.projectId.toLowerCase()}.iam.gserviceaccount.com`)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtimeServiceAccountEmail'],
      message: `Runtime service account must belong to connected GCP project ${value.projectId}`,
    });
  }
});

export const CloudRunCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { region: _legacyRegion, ...authentication } = input as Record<string, unknown>;
  return authentication;
}, CloudRunAuthenticationSchema);

export type CloudRunCredentials = z.infer<typeof CloudRunCredentialsSchema>;
const DEFAULT_CLOUD_RUN_REGION = 'us-central1';
const CloudRunRegionSchema = z.string().trim().min(1, 'GCP region is required');
type ConnectedCloudRunCredentials = CloudRunCredentials & { region: string };

interface CloudRunService {
  name: string;
  uid: string;
  generation: number | string;
  observedGeneration?: number | string;
  reconciling?: boolean;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  uri?: string;
  ingress?: string;
  latestReadyRevision?: string;
  trafficStatuses?: Array<{ revision?: string; percent?: number; tag?: string }>;
  scaling?: {
    scalingMode?: string;
    manualInstanceCount?: number;
    minInstanceCount?: number;
    maxInstanceCount?: number;
  };
  template?: {
    containers?: CloudRunContainer[];
    volumes?: Array<Record<string, unknown>>;
    serviceAccount?: string;
    serviceAccountName?: string;
    vpcAccess?: CloudRunVpcAccess;
  };
  spec?: {
    template?: {
      spec?: {
        containers?: CloudRunContainer[];
        volumes?: Array<Record<string, unknown>>;
        serviceAccountName?: string;
        vpcAccess?: CloudRunVpcAccess;
      };
    };
  };
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
}

interface CloudRunJob {
  name?: string;
  uid?: string;
  etag?: string;
  generation?: string;
  observedGeneration?: string;
  reconciling?: boolean;
  labels?: Record<string, string>;
  template?: {
    template?: {
      containers?: CloudRunContainer[];
      volumes?: Array<Record<string, unknown>>;
      serviceAccount?: string;
      serviceAccountName?: string;
      resources?: Record<string, unknown>;
      vpcAccess?: CloudRunVpcAccess;
    };
  };
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
}

class CloudRunReleaseJobAdoptionRequiredError extends Error {}

interface CloudRunVpcAccess {
  networkInterfaces?: Array<{
    network?: string;
    subnetwork?: string;
    tags?: string[];
  }>;
  egress?: string;
}

interface ResolvedCloudRunVpcAccess {
  /** True when cacheNetwork is explicitly set/null and this action owns convergence. */
  managed: boolean;
  /** Undefined means terminal absence; an object is the exact desired attachment. */
  desired?: {
    network: string;
    subnetwork: string;
    egress: string;
  };
  apiValue?: CloudRunVpcAccess;
}

interface CloudRunRevision {
  name?: string;
  createTime?: string;
  updateTime?: string;
  reconciling?: boolean;
  service?: string;
  logUri?: string;
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
}

interface CloudRunExecution {
  name?: string;
  job?: string;
  runningCount?: number;
  template?: { containers?: CloudRunContainer[] };
  createTime?: string;
  startTime?: string;
  completionTime?: string;
  completionStatus?: string;
  reconciling?: boolean;
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
}

interface CloudSchedulerJob {
  name?: string;
  description?: string;
  schedule?: string;
  timeZone?: string;
  state?: string;
  httpTarget?: {
    uri?: string;
    httpMethod?: string;
    body?: string;
    headers?: Record<string, string>;
    oauthToken?: { serviceAccountEmail?: string; scope?: string };
  };
  status?: {
    code?: number;
    message?: string;
  };
}

interface CloudRunCondition {
  type?: string;
  state?: string;
  status?: string;
  reason?: string;
  message?: string;
}

interface CloudRunDomainMapping {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    routeName?: string;
    certificateMode?: string;
    forceOverride?: boolean;
  };
  status?: {
    mappedRouteName?: string;
    conditions?: CloudRunCondition[];
    resourceRecords?: Array<{
      name?: string;
      rrdata?: string;
      type?: string;
    }>;
  };
}

const CLOUD_RUN_DOMAIN_MAPPING_REGIONS = new Set([
  'asia-east1',
  'asia-northeast1',
  'asia-southeast1',
  'europe-north1',
  'europe-west1',
  'europe-west4',
  'us-central1',
  'us-east1',
  'us-east4',
  'us-west1',
]);

interface CloudRunContainer {
  name?: string;
  image?: string;
  env?: Array<Record<string, unknown>>;
  ports?: Array<Record<string, unknown>>;
  command?: string[];
  args?: string[];
  volumeMounts?: Array<Record<string, unknown>>;
  resources?: Record<string, unknown>;
  startupProbe?: { httpGet?: { path?: string } };
  livenessProbe?: { httpGet?: { path?: string } };
}

interface CloudBuildResult {
  success: boolean;
  imageUri?: string;
  buildId?: string;
  logsUrl?: string;
  resolvedCommitSha?: string;
  error?: string;
}

interface CloudBuildStatus {
  id?: string;
  status?: string;
  statusDetail?: string;
  logsUrl?: string;
  logUrl?: string;
  failureInfo?: {
    type?: string;
    detail?: string;
  };
  steps?: Array<{
    id?: string;
    name?: string;
    status?: string;
    exitCode?: number;
    args?: string[];
  }>;
  sourceProvenance?: {
    resolvedRepoSource?: {
      commitSha?: string;
    };
  };
  results?: {
    images?: Array<{
      name?: string;
      digest?: string;
    }>;
  };
}

interface CloudBuildOperation {
  name?: string;
  done?: boolean;
  metadata?: {
    build?: CloudBuildStatus;
    buildId?: string;
  };
  response?: CloudBuildStatus;
  error?: {
    code?: number;
    status?: string;
    message?: string;
  };
}

interface CloudRunOperation {
  name?: string;
  done?: boolean;
  error?: {
    code?: number;
    status?: string;
    message?: string;
  };
  response?: CloudRunExecution;
}

interface ArtifactRepository {
  name: string;
  format?: string;
  description?: string;
  createTime?: string;
  updateTime?: string;
  sizeBytes?: string;
  mode?: string;
}

interface ArtifactRepositoryList {
  repositories?: ArtifactRepository[];
  nextPageToken?: string;
}

interface ArtifactLocation {
  name?: string;
}

interface ArtifactLocationList {
  locations?: ArtifactLocation[];
  nextPageToken?: string;
}

interface IamBinding {
  role?: string;
  members?: string[];
  condition?: Record<string, unknown>;
}

interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
}

interface CloudLoggingEntry {
  timestamp?: string;
  receiveTimestamp?: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  protoPayload?: Record<string, unknown>;
  resource?: {
    type?: string;
    labels?: Record<string, string>;
  };
  labels?: Record<string, string>;
}

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

export class CloudRunAdapter implements
  IProviderAdapter,
  IWorkloadMaintenanceAdapter,
  IProviderRuntimeLogsAdapter,
  IProviderDeploymentsAdapter,
  IProviderEnvironmentVariablesAdapter,
  IDeploySourceCredentialAdapter {
  readonly name = 'cloudrun';
  readonly registryCredentialLifecycle = createCloudRunRegistryCredentialLifecycle(async (environment, service) => {
    if (!this.credentials) throw new Error();
    const binding = parseHostingBindings(environment); const workload = binding.services?.[service];
    if (binding.provider !== this.name || binding.projectId !== this.credentials.projectId || binding.environmentId !== this.credentials.region || !workload) throw new Error();
    const id = workload.jobName ?? workload.serviceId;
    if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error();
    const name = `projects/${this.credentials.projectId}/locations/${this.credentials.region}/${workload.jobName ? 'jobs' : 'services'}/${id}`;
    return { name, projectId: this.credentials.projectId, environmentId: this.credentials.region, resourceUid: workload.resourceUid };
  }, () => this.getAccessToken());

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [], // Cloud SQL is separate
    supportsAutoWiring: false, // Manual connection needed
    supportsHealthChecks: true,
    supportsCronSchedule: false,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false, // Separate services per env
    managedTls: true,
    supportsObserve: true,
    supportsOneOffTasks: true,
    supportsDeferredDeploy: false,
    credentialUpdateActivation: 'provider-rollout',
    credentialValueEvidence: 'readback',
    supportsDeferredCronActivation: false,
    supportsMaintenance: true,
  };

  readonly deploySourceCredentialProjection: DeploySourceCredentialProjection = {
    connectionProvider: 'github',
    projectEnvironmentVariables: ({ credentials }): Record<string, string> => {
      const apiToken = typeof credentials === 'object'
        && credentials !== null
        && typeof (credentials as Record<string, unknown>).apiToken === 'string'
        ? (credentials as Record<string, string>).apiToken
        : undefined;
      return apiToken ? { HYPERVIBE_GITHUB_TOKEN: apiToken } : {};
    },
  };

  private credentials: ConnectedCloudRunCredentials | null = null;
  private serviceAccountCreds: ServiceAccountCredentials | null = null;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  async connect(credentials: unknown): Promise<void> {
    const parsed = CloudRunCredentialsSchema.parse(credentials);
    const legacyRegion = credentials && typeof credentials === 'object' && typeof (credentials as Record<string, unknown>).region === 'string'
      ? (credentials as Record<string, string>).region
      : DEFAULT_CLOUD_RUN_REGION;
    this.credentials = { ...parsed, region: CloudRunRegionSchema.parse(legacyRegion) };
    try {
      this.serviceAccountCreds = JSON.parse(this.credentials.credentials);
    } catch {
      throw new Error('Invalid service account JSON');
    }
  }

  /** Builds an immutable image in the configured region without touching any Cloud Run resource. */
  async buildReleaseImage(
    service: Service,
    environment: Environment,
    source: { repoUrl: string; revision: string }
  ): Promise<CloudBuildResult> {
    return this.buildImageForService(service, environment, {
      HYPERVIBE_SOURCE_REPO_URL: source.repoUrl,
      HYPERVIBE_SOURCE_REVISION: source.revision,
    });
  }

  async resolveRuntimeIdentity(environment: Environment, service: Pick<Service, 'name' | 'buildConfig'>): Promise<ProviderRuntimeIdentity> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const { projectId, region } = this.credentials;
    if (environment.platformBindings.projectId !== projectId
      || environment.platformBindings.environmentId !== region
      || (environment.platformBindings.region && environment.platformBindings.region !== region)) {
      throw new Error('Cloud Run workload runtime identity requires the exact bound project and region scope.');
    }
    const principal = this.requiredRuntimeServiceAccountEmail('workload storage access');
    if (principal === this.serviceAccountCreds?.client_email) {
      throw new Error('Cloud Run workload runtime identity cannot be the deployment identity.');
    }
    const bindings = environment.platformBindings as {
      services?: Record<string, { serviceId?: string; jobName?: string }>;
    };
    const isJob = serviceWorkloadKind(service) === 'cron';
    const binding = bindings.services?.[service.name];
    const boundId = isJob ? binding?.jobName : binding?.serviceId;
    if (binding && !boundId) throw new Error('Cloud Run workload binding has no matching runtime resource identity.');
    const name = this.workloadResourceName(environment, service.name, boundId);
    if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
      throw new Error('Cloud Run workload binding has an invalid runtime resource name.');
    }
    const resourceName = `projects/${projectId}/locations/${region}/${isJob ? 'jobs' : 'services'}/${name}`;
    const current = isJob
      ? await this.getCloudRunJob(name, await this.getAccessToken())
      : await this.getService(name);
    if (!current) {
      if (boundId) throw new Error('Bound Cloud Run workload is missing; runtime identity remains unknown.');
      return { provider: 'gcp', principal, scope: { projectId }, source: 'configured' };
    }
    if (!boundId) throw new Error('Unbound Cloud Run workload already exists; explicit adoption is required before runtime access.');
    const observedPrincipal = isJob
      ? this.jobRuntimeIdentity(current as CloudRunJob)
      : this.serviceRuntimeIdentity(current as CloudRunService);
    if (current.name !== resourceName || observedPrincipal !== principal) {
      throw new Error('Observed Cloud Run workload resource or runtime identity does not match the selected destination.');
    }
    return { provider: 'gcp', principal, scope: { projectId }, source: 'observed' };
  }

  configureTarget(target: { region?: string }): void {
    if (!target.region) return;
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    this.credentials = {
      ...this.credentials,
      region: CloudRunRegionSchema.parse(target.region),
    };
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string; warning?: string }> {
    if (!this.credentials || !this.serviceAccountCreds) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const token = await this.getAccessToken();

      // A token exchange succeeds even for a service account with zero roles;
      // probe the Cloud Run Admin API since deploys are impossible without it.
      const { projectId, region } = this.credentials;
      const runResponse = await fetch(
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services?pageSize=1`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!runResponse.ok) {
        const text = await runResponse.text();
        if (runResponse.status === 403) {
          return {
            success: false,
            error: [
              'Cloud Run Admin API probe failed with 403.',
              `Grant roles/run.admin to serviceAccount:${this.serviceAccountCreds.client_email} on project ${projectId} — deploys are impossible without it.`,
              `Original error: ${text}`,
            ].join(' '),
          };
        }
        return {
          success: false,
          error: `Cloud Run Admin API probe failed: ${runResponse.status} ${text}`,
        };
      }

      const loggingAccess = await this.verifyCloudLoggingAccess(token);
      if (!loggingAccess.success) {
        return {
          success: true,
          email: this.serviceAccountCreds.client_email,
          warning: loggingAccess.error,
        };
      }
      return {
        success: true,
        email: this.serviceAccountCreds.client_email,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.serviceAccountCreds = null;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async repairLoggingAccess(): Promise<Receipt> {
    if (!this.credentials || !this.serviceAccountCreds) {
      return { success: false, message: 'Not connected', error: 'Call connect() first.' };
    }

    const roles = ['roles/logging.viewer', 'roles/logging.viewAccessor'];
    const member = `serviceAccount:${this.serviceAccountCreds.client_email}`;
    try {
      const token = await this.getAccessToken();
      const updatedRoles = await this.ensureProjectIamBindings({
        token,
        member,
        roles,
      });
      return {
        success: true,
        message: updatedRoles.length > 0
          ? `Granted Cloud Logging read roles to ${member}`
          : `Cloud Logging read roles already present for ${member}`,
        data: {
          member,
          roles,
          updatedRoles,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to repair Cloud Logging IAM access',
        error: error instanceof Error ? error.message : String(error),
        data: {
          member,
          roles,
          requiredPermission: 'resourcemanager.projects.setIamPolicy',
        },
      };
    }
  }

  async getDeployStatus(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string; reason?: string }> {
    if (!this.credentials) {
      return {
        status: 'unknown',
        reason: 'Cloud Run deployment observation requires a verified connection.',
      };
    }

    try {
      const bindings = parseHostingBindings(environment);
      const boundRegion = bindings.environmentId;
      if (boundRegion) {
        this.configureTarget({ region: boundRegion });
      }
      const token = await this.getAccessToken();
      const targetBinding = Object.values(bindings.services ?? {}).find((binding) => (
        binding.serviceId === deploymentId
        || binding.jobName === deploymentId
        || binding.schedulerJobName === deploymentId
      ));
      const resourceType = targetBinding?.resourceType;
      const workloadKind = targetBinding?.workloadKind;
      const scheduledTarget = resourceType === 'scheduledJob' || workloadKind === 'cron';
      const jobTarget = scheduledTarget || resourceType === 'taskJob';
      const serviceTarget = resourceType === 'service'
        || workloadKind === 'web'
        || workloadKind === 'worker';

      const schedulerStatus = (schedulerJob: CloudSchedulerJob, schedulerJobName: string) => {
        const state = (schedulerJob.state ?? '').toUpperCase();
        if (['ENABLED', 'PAUSED'].includes(state)) {
          return { status: 'deployed' };
        }
        if (state === 'UPDATE_FAILED') {
          return {
            status: 'failed',
            ...(schedulerJob.status?.message ? { reason: schedulerJob.status.message } : {}),
          };
        }
        return {
          status: state ? state.toLowerCase() : 'deploying',
          reason: state
            ? `Cloud Scheduler job ${schedulerJobName} is ${state.toLowerCase()}.`
            : `Cloud Scheduler job ${schedulerJobName} did not report a state.`,
        };
      };

      if (scheduledTarget) {
        const schedulerJobName = targetBinding?.schedulerJobName ?? deploymentId;
        const schedulerJob = await this.getCloudSchedulerJob(schedulerJobName, token);
        return schedulerJob
          ? schedulerStatus(schedulerJob, schedulerJobName)
          : {
            status: 'unknown',
            reason: `Cloud Scheduler job ${schedulerJobName} is absent in region ${this.credentials.region}.`,
          };
      }

      if (jobTarget) {
        const jobName = targetBinding?.jobName ?? deploymentId;
        const job = await this.getCloudRunJob(jobName, token);
        const readiness = this.cloudRunJobReadiness(job);
        if (readiness.ready) {
          return { status: 'deployed' };
        }
        if (readiness.error) {
          return { status: 'failed', reason: readiness.error };
        }
        return {
          status: 'unknown',
          reason: `Cloud Run job ${jobName} is absent in region ${this.credentials.region}.`,
        };
      }

      const service = await this.getService(deploymentId);
      if (service) {
        const readiness = this.cloudRunServiceReadiness(service);
        const status = readiness.ready ? 'deployed' : readiness.error ? 'failed' : 'deploying';

        return {
          status,
          url: service.uri,
          ...(readiness.error ? { reason: readiness.error } : {}),
        };
      }
      if (serviceTarget) {
        return {
          status: 'unknown',
          reason: `Cloud Run service ${deploymentId} is absent in region ${this.credentials.region}.`,
        };
      }

      // Legacy bindings may not identify the resource type. Probe remaining
      // Cloud Run shapes only after the service lookup confirms absence.
      const job = await this.getCloudRunJob(deploymentId, token);
      const jobReadiness = this.cloudRunJobReadiness(job);
      if (jobReadiness.ready) return { status: 'deployed' };
      if (jobReadiness.error) return { status: 'failed', reason: jobReadiness.error };
      const schedulerJob = await this.getCloudSchedulerJob(deploymentId, token);
      if (schedulerJob) return schedulerStatus(schedulerJob, deploymentId);

      return {
        status: 'unknown',
        reason: `Cloud Run found no service, job, or scheduler named ${deploymentId} in region ${this.credentials.region}.`,
      };
    } catch (error) {
      return {
        status: 'unknown',
        reason: `Cloud Run deployment observation failed for ${deploymentId}: ${this.formatError(error)}`,
      };
    }
  }

  async runJob(
    environment: Environment,
    service: Service,
    command: string,
    options?: EnvironmentTaskOptions
  ): Promise<JobResult> {
    if (options?.managedRecoveryTask) return {
      jobId: '', status: 'failed', receipt: { success: false,
        message: 'The Cloud Run adapter does not implement managed recovery tasks.',
        data: { applied: 0, skipped: 1, mutationAttempted: false } },
    };
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const startedAt = Date.now();

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; imageUri?: string }>;
    };
    const serviceBinding = bindings.services?.[service.name];
    const serviceName = this.workloadResourceName(
      environment,
      service.name,
      serviceBinding?.serviceId ?? serviceBinding?.jobName
    );
    const sourceService = await this.getService(serviceName);
    const sourceContainer = this.primaryContainer(sourceService);
    const imageUri = sourceContainer?.image ?? bindings.services?.[service.name]?.imageUri;

    if (!imageUri) {
      return {
        jobId: '',
        status: 'failed',
        receipt: {
          success: false,
          message: `Cloud Run environment task requires an image for service ${service.name}`,
          error: 'Deploy the service first so Hypervibe can build and record its Cloud Run image before running one-off environment tasks.',
          data: {
            provider: this.name,
            missing: ['services.' + service.name + '.imageUri'],
            pendingDeploy: true,
          },
        },
      };
    }

    try {
      const token = await this.getAccessToken();
      const vpcAccess = await this.resolveVpcAccess(
        environment,
        this.serviceVpcAccess(sourceService),
        token
      );
      const jobName = this.migrationJobName(serviceName);
      const jobSpec = this.cloudRunJobSpec({
        imageUri,
        command,
        env: sourceContainer?.env ?? [],
        resources: sourceContainer?.resources,
        serviceAccount: sourceService?.template?.serviceAccount
          ?? sourceService?.template?.serviceAccountName
          ?? sourceService?.spec?.template?.spec?.serviceAccountName,
        existingVolumes: this.cloudRunServiceVolumes(sourceService),
        existingVolumeMounts: sourceContainer?.volumeMounts,
        cloudSqlConnectionNames: this.cloudSqlConnectionNamesFromEnvVars(sourceContainer?.env),
        ...(vpcAccess.apiValue !== undefined ? { vpcAccess: vpcAccess.apiValue } : {}),
      });

      const { job: readyJob } = await this.upsertCloudRunJob({
        token,
        jobName,
        jobSpec,
        description: 'environment task',
      });
      this.assertReleaseJobConfiguration(readyJob, jobName, jobSpec);
      this.assertVpcAccess(
        readyJob,
        vpcAccess,
        `Cloud Run job ${jobName}`
      );

      const run = await this.executeCloudRunJob(jobName, token);
      const { operation, execution } = run;
      const status = execution ? this.executionStatus(execution) : 'failed';
      const jobId = execution?.name ?? operation.name ?? jobName;
      if (status !== 'completed') {
        return {
          jobId,
          status: execution ? 'failed' : 'timeout',
          runner: 'cloudrun-job',
          durationMs: Date.now() - startedAt,
          receipt: {
            success: false,
            message: `Cloud Run environment task failed for ${service.name}`,
            error: execution
              ? `Cloud Run execution ${this.lastPathSegment(execution.name) ?? jobId} ended with status ${status}`
              : `Cloud Run execution for ${jobName} did not finish before timeout`,
            data: {
              jobName,
              operationName: operation.name,
              executionName: execution?.name,
              serviceName,
              imageUri,
            },
          },
        };
      }
      return {
        jobId,
        status: 'completed',
        runner: 'cloudrun-job',
        durationMs: Date.now() - startedAt,
        receipt: {
          success: true,
          message: `Completed Cloud Run environment task ${jobName}`,
          data: {
            jobName,
            operationName: operation.name,
            executionName: execution?.name,
            serviceName,
            imageUri,
          },
        },
      };
    } catch (error) {
      return {
        jobId: '',
        status: 'failed',
        runner: 'cloudrun-job',
        durationMs: Date.now() - startedAt,
        receipt: {
          success: false,
          message: `Cloud Run environment task failed for ${service.name}`,
          error: this.formatError(error),
        },
      };
    }
  }

  async readProviderLogs(request: ProviderRuntimeLogsRequest): Promise<ProviderRuntimeLogsResult> {
    const bindings = parseHostingBindings(request.environment);
    const serviceBinding = bindings.services?.[request.serviceName];
    if (!serviceBinding) {
      throw new Error(`Environment/service not fully bound to ${this.name}`);
    }
    const logs = await this.getLogs(request.environment, request.serviceName, {
      limit: request.limit,
      errorsOnly: request.errorsOnly,
    });
    const deploymentId = serviceBinding.serviceId;
    const status = deploymentId
      ? await this.getDeployStatus(request.environment, deploymentId)
      : undefined;
    return {
      deploymentStatus: status?.status ?? 'unknown',
      deploymentId,
      logs: logs.map((log) => ({
        timestamp: log.timestamp.toISOString(),
        severity: log.severity || 'info',
        message: log.message,
      })),
    };
  }

  async listProviderDeployments(request: ProviderDeploymentsRequest): Promise<ProviderDeployment[]> {
    const bindings = parseHostingBindings(request.environment);
    if (request.serviceName && !bindings.services?.[request.serviceName]) {
      throw new Error(`Environment/service not fully bound to ${this.name}`);
    }
    return this.listDeployments(request.environment, request.serviceName, request.limit);
  }

  async getLogs(
    environment: Environment,
    serviceName: string,
    options?: GetLogsOptions
  ): Promise<LogEntry[]> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const token = await this.getAccessToken();
    const bindings = parseHostingBindings(environment);
    const serviceBinding = bindings.services?.[serviceName];
    const targetName = serviceBinding?.jobName ?? serviceBinding?.serviceId ?? serviceName;
    const isJob = serviceBinding?.resourceType === 'scheduledJob' || Boolean(serviceBinding?.jobName);
    const logs = await this.queryCloudLogging({
      token,
      targetName,
      targetKind: isJob ? 'job' : 'service',
      limit: options?.limit ?? 100,
      since: options?.since,
      errorsOnly: options?.errorsOnly,
    });
    return logs.map((entry) => this.toLogEntry(entry));
  }

  async getServiceVariables(
    environment: Environment,
    serviceName: string
  ): Promise<Record<string, string>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const token = await this.getAccessToken();
    const bindings = parseHostingBindings(environment);
    const serviceBinding = bindings.services?.[serviceName];
    const targetName = serviceBinding?.jobName ?? serviceBinding?.serviceId;
    if (!targetName) {
      throw new Error(`Service ${serviceName} is not bound to Cloud Run`);
    }

    const isJob = serviceBinding?.resourceType === 'scheduledJob' || Boolean(serviceBinding?.jobName);
    const container = isJob
      ? this.primaryJobContainer(await this.getCloudRunJob(targetName, token))
      : this.primaryContainer(await this.getCloudRunService(targetName, token));
    const vars: Record<string, string> = {};
    for (const entry of container?.env ?? []) {
      if (typeof entry.name === 'string' && typeof entry.value === 'string') {
        vars[entry.name] = entry.value;
      }
    }
    return vars;
  }

  async readProviderEnvironmentVariables(request: ProviderEnvironmentVariablesRequest): Promise<ProviderEnvironmentVariablesResult> {
    try {
      if (!this.credentials) throw new Error();
      const binding = parseHostingBindings(request.environment);
      const target = binding.services?.[request.service.name];
      const id = target?.jobName ?? target?.serviceId;
      if (binding.provider !== this.name || binding.projectId !== this.credentials.projectId || binding.environmentId !== this.credentials.region
        || !id || !/^[a-z][a-z0-9-]*$/.test(id) || !target?.resourceUid) throw new Error();
      const token = await this.getAccessToken(); const job = Boolean(target.jobName);
      const current = job ? await this.getCloudRunJob(id, token) : await this.getCloudRunService(id, token);
      const expectedName = `projects/${binding.projectId}/locations/${this.credentials.region}/${job ? 'jobs' : 'services'}/${id}`;
      if (!current || current.name !== expectedName || current.uid !== target.resourceUid) throw new Error();
      const container = job ? this.primaryJobContainer(current as CloudRunJob) : this.primaryContainer(current as CloudRunService);
      const entries = container?.env ?? [];
      if (!container || !Array.isArray(entries) || entries.some(entry => typeof entry.name !== 'string') || new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error();
      const variables: Record<string, string> = {}; const unresolvedKeys: string[] = [];
      for (const entry of entries) {
        if (typeof entry.value === 'string' && !entry.valueSource) variables[String(entry.name)] = entry.value;
        else unresolvedKeys.push(String(entry.name));
      }
      return { success: true, variables, ...(unresolvedKeys.length ? { unresolvedKeys: unresolvedKeys.sort() } : {}) };
    } catch { return { success: false, error: 'Exact Cloud Run workload configuration could not be verified.' }; }
  }

  async listDeployments(
    environment: Environment,
    serviceName?: string,
    limit = 10
  ): Promise<Array<{
    id: string;
    status: string;
    createdAt?: string;
    updatedAt?: string;
    url?: string;
    service?: string;
    type?: string;
    logUri?: string;
  }>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const token = await this.getAccessToken();
    const bindings = environment.platformBindings as {
      services?: Record<string, { serviceId?: string; url?: string; jobName?: string; resourceType?: string }>;
    };
    const serviceBindings = bindings.services ?? {};
    const targets = serviceName
      ? [[serviceName, serviceBindings[serviceName]] as const]
      : Object.entries(serviceBindings);
    const deployments: Array<{
      id: string;
      status: string;
      createdAt?: string;
      updatedAt?: string;
      url?: string;
      service?: string;
      type?: string;
      logUri?: string;
    }> = [];

    for (const [name, binding] of targets) {
      if (!binding) continue;
      if (binding.resourceType === 'scheduledJob' || binding.jobName) {
        const jobName = binding.jobName ?? binding.serviceId;
        if (!jobName) continue;
        const executions = await this.listCloudRunJobExecutions(jobName, token, limit);
        for (const execution of executions) {
          deployments.push({
            id: this.lastPathSegment(execution.name) ?? jobName,
            status: this.executionStatus(execution),
            createdAt: execution.startTime ?? execution.createTime,
            updatedAt: execution.completionTime,
            service: name,
            type: 'jobExecution',
          });
        }
        continue;
      }

      const serviceId = binding.serviceId;
      if (!serviceId) continue;
      const service = await this.getCloudRunService(serviceId, token);
      const revisions = await this.listCloudRunRevisions(serviceId, token, limit);
      if (revisions.length === 0) {
        const readiness = this.cloudRunServiceReadiness(service);
        deployments.push({
          id: serviceId,
          status: readiness.ready ? 'deployed' : readiness.error ? 'failed' : 'unknown',
          url: service?.uri ?? binding.url,
          service: name,
          type: 'service',
        });
        continue;
      }
      for (const revision of revisions) {
        const readiness = this.cloudRunServiceReadiness({
          name: revision.name ?? serviceId,
          uid: '',
          generation: '',
          terminalCondition: revision.terminalCondition,
          conditions: revision.conditions,
          reconciling: revision.reconciling,
        });
        deployments.push({
          id: this.lastPathSegment(revision.name) ?? serviceId,
          status: readiness.ready ? 'deployed' : readiness.error ? 'failed' : 'deploying',
          createdAt: revision.createTime,
          updatedAt: revision.updateTime,
          url: service?.uri ?? binding.url,
          service: name,
          type: 'revision',
          logUri: revision.logUri,
        });
      }
    }

    deployments.sort((a, b) => {
      const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at;
    });
    return deployments.slice(0, limit);
  }

  private async observedJobDeployment(job: CloudRunJob, token: string): Promise<Pick<ObservedService, 'deployment'>> {
    if (!job.name || !this.credentials) return {};
    const prefix = `projects/${this.credentials.projectId}/locations/${this.credentials.region}/jobs/`;
    if (!job.name.startsWith(prefix) || job.name.slice(prefix.length).includes('/')) return {};
    try {
      const executions = await this.listCloudRunJobExecutionsStrict(job.name.slice(prefix.length), token);
      const ids = new Set<string>();
      if (executions.some(execution => !execution.name?.startsWith(`${job.name}/executions/`)
        || execution.name.slice(`${job.name}/executions/`.length).includes('/') || execution.job !== job.name
        || !execution.createTime || !Number.isFinite(Date.parse(execution.createTime))
        || ids.has(execution.name) || !ids.add(execution.name))) return {};
      const latest = [...executions].sort((left, right) => Date.parse(right.createTime!) - Date.parse(left.createTime!))[0];
      if (!latest?.name) return {};
      const container = latest.template?.containers?.[0];
      const values = this.observedEnvFromContainer(container);
      return { deployment: { id: latest.name, createdAt: latest.createTime,
        status: this.executionStatus(latest),
        activeDeploymentIds: executions.filter(execution => (execution.runningCount ?? 0) > 0 || !execution.completionTime && this.executionStatus(execution) === 'running').map(execution => execution.name!).sort(),
        activeDeploymentCoverage: 'instances',
        envVarHashes: values.envVarHashes,
        configurationState: container && values.envVarKeys.every(key => Object.hasOwn(values.envVarHashes, key)) ? 'resolved' : 'unknown',
      } };
    } catch { return {}; }
  }

  private observedServiceDeployment(service: CloudRunService): Pick<ObservedService, 'deployment'> {
    const prefix = `${service.name}/revisions/`;
    const revisionId = (id: unknown): string | undefined => typeof id === 'string' && id.length > 0
      ? id.startsWith(prefix) && !id.slice(prefix.length).includes('/') ? id
        : !id.includes('/') ? `${prefix}${id}` : undefined
      : undefined;
    const id = revisionId(service.latestReadyRevision);
    if (!id) return {};
    const traffic = service.trafficStatuses;
    const known = Array.isArray(traffic) && traffic.every(target => revisionId(target.revision)
      && (target.percent === undefined || Number.isInteger(target.percent) && target.percent >= 0 && target.percent <= 100));
    return { deployment: { id, status: this.cloudRunServiceReadiness(service).ready ? 'ready' : 'unknown',
      ...(known ? { activeDeploymentIds: [...new Set(traffic!.filter(target => (target.percent ?? 0) > 0 || Boolean(target.tag)).map(target => revisionId(target.revision)!))].sort(), activeDeploymentCoverage: 'traffic' as const } : {}),
    } };
  }

  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = parseHostingBindings(environment);
    const observedAt = new Date().toISOString();

    if (!bindings.projectId) {
      return {
        provider: this.name,
        observedAt,
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      };
    }
    if (bindings.environmentId && bindings.environmentId !== this.credentials.region) {
      throw new Error(
        `Bound Cloud Run environment is in ${bindings.environmentId}, but desired hosting.region is ${this.credentials.region}. Region changes require an explicit teardown and recreate; Hypervibe will not create a cross-region replacement over existing bindings.`
      );
    }
    if (bindings.projectId !== this.credentials.projectId) {
      throw new Error(`Bound Cloud Run project ${bindings.projectId} does not match connected project ${this.credentials.projectId}. Reconnect the exact target before observing workloads.`);
    }

    const token = await this.getAccessToken();
    const prefix = this.environmentResourcePrefix(environment);
    const environmentLabel = this.labelValue(environment.name);
    const serviceBindings = bindings.services ?? {};
    const warnings: string[] = [];
    const services: ObservedService[] = [];
    let serviceObservationKnown = true;

    let domainMappings: CloudRunDomainMapping[] = [];
    let domainObservationKnown = true;
    if (this.domainMappingRegionSupported()) {
      try {
        domainMappings = await this.listCloudRunDomainMappings(token);
      } catch (error) {
        domainObservationKnown = false;
        warnings.push(`Failed to list Cloud Run domain mappings: ${this.formatError(error)}`);
      }
    }
    const mappingsByRoute = new Map<string, CloudRunDomainMapping[]>();
    for (const mapping of domainMappings) {
      const route = mapping.spec?.routeName ?? mapping.status?.mappedRouteName;
      if (!route) {
        throw new Error(`Cloud Run domain mapping ${mapping.metadata?.name ?? 'unknown'} did not expose its mapped route.`);
      }
      mappingsByRoute.set(route, [
        ...(mappingsByRoute.get(route) ?? []),
        mapping,
      ]);
    }

    let liveServices: CloudRunService[] = [];
    try {
      liveServices = await this.listCloudRunServices(token);
    } catch (error) {
      serviceObservationKnown = false;
      warnings.push(`Failed to list Cloud Run services: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const liveService of liveServices) {
      const externalId = this.lastPathSegment(liveService.name);
      if (!externalId) continue;
      const bindingKey = Object.entries(serviceBindings)
        .find(([, binding]) => binding?.serviceId === externalId)?.[0];
      if (liveService.labels?.['infraprint-environment'] !== environmentLabel && !bindingKey) {
        continue;
      }

      const liveUid = typeof liveService.uid === 'string' && liveService.uid.trim().length > 0
        && liveService.uid === liveService.uid.trim() ? liveService.uid : undefined;
      const boundUid = bindingKey ? serviceBindings[bindingKey]?.resourceUid : undefined;
      const identityKnown = liveUid !== undefined && (boundUid === undefined || boundUid === liveUid);
      if (!identityKnown) {
        serviceObservationKnown = false;
        warnings.push(`Cloud Run workload ${externalId} has a missing or different provider lifetime identity.`);
      }
      const container = this.primaryContainer(liveService);
      const readiness = this.cloudRunServiceReadiness(liveService);
      const startCommand = this.containerStartCommand(container);
      const healthCheckPath = container?.startupProbe?.httpGet?.path ?? container?.livenessProbe?.httpGet?.path;
      const releaseCommandHash = liveService.annotations?.[CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION];
      const cacheNetwork = this.normalizedVpcAccess(this.serviceVpcAccess(liveService));
      let publicAccess: boolean | undefined;
      try {
        publicAccess = await this.observePublicInvoker(externalId, token);
      } catch (error) {
        serviceObservationKnown = false;
        warnings.push(`Failed to read Cloud Run IAM policy for ${externalId}: ${this.formatError(error)}`);
      }
      const serviceMappings = mappingsByRoute.get(externalId) ?? [];
      services.push({
        name: this.observedServiceName(externalId, liveService.labels, bindingKey, prefix),
        externalId,
        ...(liveUid ? { resourceUid: liveUid } : {}),
        // Workers deploy with internal-only ingress; classify by it so the
        // diff can converge a manually flipped ingress back to the spec.
        workloadKind: liveService.ingress === 'INGRESS_TRAFFIC_INTERNAL_ONLY' ? 'worker' : 'web',
        ...(liveService.uri ? { url: liveService.uri } : {}),
        customDomains: serviceMappings.map((mapping) => mapping.metadata!.name!).sort(),
        ...(serviceMappings.length > 0
          ? {
              customDomainStatus: Object.fromEntries(serviceMappings.map((mapping) => [
                mapping.metadata!.name!,
                {
                  providerVerified: this.domainMappingReady(mapping),
                  certificateStatus: this.domainMappingCertificateStatus(mapping),
                  dnsConfigured: this.domainMappingReady(mapping),
                  dnsRecords: this.domainMappingDnsRecords(mapping, mapping.metadata!.name!),
                },
              ])),
            }
          : {}),
        config: {
          ...(startCommand ? { startCommand } : {}),
          ...(releaseCommandHash ? { releaseCommandHash } : {}),
          ...(healthCheckPath ? { healthCheckPath } : {}),
          ...(publicAccess === undefined ? {} : { public: publicAccess }),
          ...(cacheNetwork ? { cacheNetwork } : {}),
        },
        ...this.observedEnvFromContainer(container),
        ...this.observedServiceDeployment(liveService),
        status: !identityKnown ? 'unknown' : readiness.ready ? 'running' : readiness.error ? 'failed' : 'unknown',
        maintenance: {
          state: !identityKnown ? 'unknown' : liveService.scaling?.scalingMode === 'MANUAL'
            && liveService.scaling.manualInstanceCount === 0
            ? 'suspended'
            : readiness.ready ? 'running' : 'unknown',
          providerState: {
            scaling: liveService.scaling ?? { scalingMode: 'AUTOMATIC' },
          },
        },
      });
    }

    let liveJobs: CloudRunJob[] = [];
    try {
      liveJobs = await this.listCloudRunJobs(token);
    } catch (error) {
      serviceObservationKnown = false;
      warnings.push(`Failed to list Cloud Run jobs: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const liveJob of liveJobs) {
      const externalId = this.lastPathSegment(liveJob.name);
      if (!externalId) continue;
      const bindingKey = Object.entries(serviceBindings)
        .find(([, binding]) => binding?.jobName === externalId)?.[0];
      if (liveJob.labels?.['infraprint-environment'] !== environmentLabel && !bindingKey) {
        continue;
      }

      const schedulerJobName = this.schedulerResourceName(
        externalId,
        bindingKey ? serviceBindings[bindingKey]?.schedulerJobName : undefined
      );
      let schedulerJob: CloudSchedulerJob | null = null;
      let schedulerObserved = false;
      try {
        schedulerJob = await this.getCloudSchedulerJob(schedulerJobName, token);
        schedulerObserved = true;
      } catch (error) {
        serviceObservationKnown = false;
        warnings.push(`Failed to read Cloud Scheduler job ${schedulerJobName}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const container = this.primaryJobContainer(liveJob);
      const readiness = this.cloudRunJobReadiness(liveJob);
      const startCommand = this.containerStartCommand(container);
      const pendingActivation = bindingKey ? serviceBindings[bindingKey]?.scheduleActivation : undefined;
      const boundUid = bindingKey ? serviceBindings[bindingKey]?.resourceUid : undefined;
      if (boundUid && liveJob.uid !== boundUid) {
        serviceObservationKnown = false;
        warnings.push(`Scheduled workload ${externalId} has a different provider lifetime identity.`);
      }
      const pendingIdentityMatches = pendingActivation?.jobName === externalId
        && pendingActivation?.jobUid === liveJob.uid
        && liveJob.name === `projects/${this.credentials.projectId}/locations/${this.credentials.region}/jobs/${externalId}`;
      if (pendingActivation && !pendingIdentityMatches) {
        serviceObservationKnown = false;
        warnings.push(`Scheduled workload ${externalId} no longer matches its pending activation identity or trigger state.`);
      }
      const scheduleActivationPending = Boolean(pendingActivation && pendingIdentityMatches && schedulerObserved);
      const cacheNetwork = this.normalizedVpcAccess(liveJob.template?.template?.vpcAccess);
      services.push({
        name: this.observedServiceName(externalId, liveJob.labels, bindingKey, prefix),
        externalId: bindingKey && serviceBindings[bindingKey]?.serviceId === externalId
          ? externalId : schedulerJob ? schedulerJobName : externalId,
        ...(scheduleActivationPending ? { scheduleActivationPending: true } : {}),
        workloadKind: 'cron',
        customDomains: [],
        config: {
          ...(startCommand ? { startCommand } : {}),
          ...(schedulerJob?.schedule ? { cronSchedule: schedulerJob.schedule } : {}),
          ...(cacheNetwork ? { cacheNetwork } : {}),
        },
        ...this.observedEnvFromContainer(container),
        ...await this.observedJobDeployment(liveJob, token),
        status: scheduleActivationPending && !schedulerJob ? 'empty' : readiness.ready ? 'running' : readiness.error ? 'failed' : 'unknown',
        maintenance: {
          state: schedulerJob?.state === 'PAUSED'
            ? 'suspended'
            : schedulerJob?.state === 'ENABLED' ? 'running' : 'unknown',
          providerState: { schedulerState: schedulerJob?.state ?? 'unknown' },
        },
      });
    }

    return {
      provider: this.name,
      observedAt,
      projectExists: true,
      projectId: bindings.projectId,
      environmentId: bindings.environmentId ?? this.credentials.region,
      services,
      databases: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: domainObservationKnown && serviceObservationKnown ? 'complete' : 'unknown',
        databases: 'unknown',
        caches: 'unknown',
        storage: 'complete',
      },
      partial: warnings.length > 0,
      warnings,
    };
  }

  async inspectEnvironmentResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const boundRegion = typeof request.binding?.environmentId === 'string'
      ? request.binding.environmentId
      : undefined;
    if (boundRegion) this.configureTarget({ region: boundRegion });

    const token = await this.getAccessToken();
    const environmentLabel = request.environment
      ? this.labelValue(request.environment.name)
      : undefined;
    const rawServiceBindings = request.binding?.services;
    const serviceBindings = rawServiceBindings && typeof rawServiceBindings === 'object' && !Array.isArray(rawServiceBindings)
      ? rawServiceBindings as Record<string, Record<string, unknown>>
      : {};
    const boundIds = new Set(Object.values(serviceBindings).flatMap((binding) => [
      typeof binding.serviceId === 'string' ? binding.serviceId : undefined,
      typeof binding.jobName === 'string' ? binding.jobName : undefined,
      typeof binding.schedulerJobName === 'string' ? binding.schedulerJobName : undefined,
    ].filter((value): value is string => Boolean(value))));
    const deterministicNames = new Map<string, { name: string; resourceType: 'service' | 'scheduledJob' | 'taskJob' }>();
    if (request.environment) {
      const boundProjectId = typeof request.binding?.projectId === 'string'
        ? request.binding.projectId
        : this.credentials.projectId;
      const prefix = this.environmentResourcePrefix(request.environment, boundProjectId);
      for (const serviceName of request.serviceNames ?? []) {
        for (const providerName of [
          this.workloadResourceName({ ...request.environment, platformBindings: { projectId: boundProjectId } }, serviceName),
          this.stableResourceName(`${prefix}-${serviceName}`),
        ]) {
          deterministicNames.set(providerName, { name: serviceName, resourceType: 'service' });
          deterministicNames.set(this.schedulerResourceName(providerName), { name: serviceName, resourceType: 'scheduledJob' });
          deterministicNames.set(this.migrationJobName(providerName), { name: `${serviceName}-migration`, resourceType: 'taskJob' });
        }
      }
    }
    const [liveServices, liveJobs] = await Promise.all([
      this.listCloudRunServices(token),
      this.listCloudRunJobs(token),
    ]);
    const warnings: string[] = [];
    const resources: Array<Record<string, unknown>> = [];

    for (const liveService of liveServices) {
      const id = this.lastPathSegment(liveService.name);
      if (!id) continue;
      const managedEnvironment = liveService.labels?.['infraprint-environment'];
      const deterministicService = deterministicNames.get(id);
      resources.push({
        id,
        name: liveService.labels?.['infraprint-service'] ?? deterministicService?.name ?? id,
        workloadKind: liveService.ingress === 'INGRESS_TRAFFIC_INTERNAL_ONLY' ? 'worker' : 'web',
        resourceType: 'service',
        managedByHypervibe: Boolean(managedEnvironment || deterministicService),
        managedEnvironment: managedEnvironment ?? null,
        matchesEnvironment: Boolean(
          boundIds.has(id)
          || Boolean(deterministicService)
          || (environmentLabel && managedEnvironment === environmentLabel)
        ),
        ...(liveService.uri ? { url: liveService.uri } : {}),
      });
    }

    for (const liveJob of liveJobs) {
      const jobName = this.lastPathSegment(liveJob.name);
      if (!jobName) continue;
      const boundJob = Object.values(serviceBindings).find((binding) => binding.jobName === jobName);
      const schedulerJobName = this.schedulerResourceName(
        jobName,
        typeof boundJob?.schedulerJobName === 'string' ? boundJob.schedulerJobName : undefined
      );
      let schedulerJob: CloudSchedulerJob | null = null;
      try {
        schedulerJob = await this.getCloudSchedulerJob(schedulerJobName, token);
      } catch (error) {
        warnings.push(`Failed to inspect Cloud Scheduler job ${schedulerJobName}: ${this.formatError(error)}`);
      }
      const managedEnvironment = liveJob.labels?.['infraprint-environment'];
      const deterministicService = deterministicNames.get(jobName)
        ?? deterministicNames.get(schedulerJobName);
      resources.push({
        id: schedulerJob ? schedulerJobName : jobName,
        name: liveJob.labels?.['infraprint-service'] ?? deterministicService?.name ?? jobName,
        workloadKind: 'cron',
        resourceType: deterministicService?.resourceType ?? 'scheduledJob',
        jobName,
        schedulerJobName: schedulerJob ? schedulerJobName : null,
        schedulerState: schedulerJob?.state ?? null,
        managedByHypervibe: Boolean(managedEnvironment || deterministicService),
        managedEnvironment: managedEnvironment ?? null,
        matchesEnvironment: Boolean(
          boundIds.has(jobName)
          || boundIds.has(schedulerJobName)
          || Boolean(deterministicService)
          || (environmentLabel && managedEnvironment === environmentLabel)
        ),
      });
    }

    const matched = resources.filter((resource) => resource.matchesEnvironment === true);
    const selected = matched.slice(0, request.limit);
    const otherResources = resources
      .filter((resource) => resource.matchesEnvironment !== true)
      .slice(0, request.limit)
      .map(({ matchesEnvironment: _matchesEnvironment, ...resource }) => resource);
    return {
      observation: selected.length > 0 ? 'present' : 'absent',
      resource: 'environment',
      project: { id: this.credentials.projectId },
      environment: {
        name: request.environment?.name,
        region: this.credentials.region,
      },
      services: selected,
      otherResources,
      completeness: {
        services: 'complete',
        scheduler: warnings.length > 0 ? 'unknown' : 'complete',
      },
      partial: selected.length < matched.length || otherResources.length < resources.length - matched.length || warnings.length > 0,
      warnings,
    };
  }

  async inspectArtifactResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    if (request.region) this.configureTarget({ region: request.region });
    const selectedId = request.id?.trim();
    if (selectedId) {
      const identity = this.artifactRepositoryIdentity(selectedId);
      if (!identity) {
        throw new Error(`Artifact Registry repository id must match projects/${this.credentials.projectId}/locations/{location}/repositories/{repository}.`);
      }
      this.configureTarget({ region: identity.location });
      const repository = await this.getArtifactRepository(selectedId);
      return {
        observation: repository ? 'present' : 'absent',
        resource: 'artifact',
        project: { id: this.credentials.projectId },
        artifacts: repository ? [this.inspectedArtifactRepository(repository)] : [],
        ...(repository ? {} : { id: selectedId }),
        truncated: false,
        partial: false,
      };
    }

    const token = await this.getAccessToken();
    const { projectId } = this.credentials;
    const locations = request.region
      ? [request.region]
      : await this.listArtifactRegistryLocations(token);
    const candidates: ArtifactRepository[] = [];
    const warnings: string[] = [];
    let truncated = false;

    for (let locationIndex = 0; locationIndex < locations.length; locationIndex++) {
      const location = locations[locationIndex]!;
      const locationCandidates: ArtifactRepository[] = [];
      let locationTruncated = false;
      try {
        let pageToken: string | undefined;
        const seenPageTokens = new Set<string>();
        for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
          const query = new URLSearchParams({ pageSize: String(Math.min(request.limit, 100)) });
          if (pageToken) query.set('pageToken', pageToken);
          const parent = `projects/${projectId}/locations/${location}`;
          const response = await fetch(
            `https://artifactregistry.googleapis.com/v1/${parent}/repositories?${query.toString()}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!response.ok) {
            const body = (await response.text()).slice(0, 500);
            throw new Error(`${response.status}${body ? ` ${body}` : ''}`);
          }
          const page = await response.json() as ArtifactRepositoryList;
          for (const repository of page.repositories ?? []) {
            const identity = this.artifactRepositoryIdentity(repository.name);
            if (!identity || identity.location !== location) {
              throw new Error(`returned an invalid repository identity: ${repository.name}`);
            }
            if (!request.name || repository.name === request.name || identity.repository === request.name) {
              locationCandidates.push(repository);
            }
          }

          if (!request.name && candidates.length + locationCandidates.length > request.limit) {
            locationTruncated = true;
            break;
          }
          if (request.name && candidates.length + locationCandidates.length > 1) {
            locationTruncated = Boolean(page.nextPageToken) || locationIndex < locations.length - 1;
            break;
          }

          pageToken = page.nextPageToken;
          if (!pageToken) break;
          if (seenPageTokens.has(pageToken)) {
            throw new Error('returned a repeated page token');
          }
          seenPageTokens.add(pageToken);
          if (pageNumber === 99) {
            throw new Error('exceeded the bounded repository inventory page limit');
          }
        }
        candidates.push(...locationCandidates);
        truncated = truncated || locationTruncated;
      } catch (error) {
        if (request.region) {
          throw new Error(`Artifact Registry repository inventory failed in ${location}: ${error instanceof Error ? error.message : String(error)}`);
        }
        warnings.push(`Artifact Registry repository inventory failed in ${location}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (truncated || (request.name && candidates.length > 1)) break;
    }

    const artifacts = candidates.slice(0, request.limit).map((repository) => this.inspectedArtifactRepository(repository));
    const incompleteNameSearch = Boolean(request.name && warnings.length > 0);
    return {
      observation: request.name && candidates.length > 1
        ? 'ambiguous'
        : incompleteNameSearch
        ? 'unknown'
        : artifacts.length > 0
        ? 'present'
        : warnings.length > 0
        ? 'unknown'
        : 'absent',
      resource: 'artifact',
      project: { id: projectId },
      region: request.region ?? 'all',
      artifacts,
      ...(request.name ? { name: request.name } : {}),
      truncated: truncated || candidates.length > request.limit,
      partial: warnings.length > 0,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async observeMaintenanceWorkload(
    environment: Environment,
    serviceId: string,
    workloadKind: MaintenanceWorkloadSnapshot['workloadKind']
  ): Promise<MaintenanceWorkloadObservation> {
    const token = await this.getAccessToken();
    const binding = Object.values(parseHostingBindings(environment).services ?? {})
      .find((candidate) => candidate.serviceId === serviceId
        || candidate.jobName === serviceId
        || candidate.schedulerJobName === serviceId);
    if (!binding) {
      return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_workload_unbound' };
    }
    if (workloadKind === 'cron') {
      try {
        const { schedulerJobName, jobName } = binding;
        if (!this.credentials || !schedulerJobName || !jobName
          || !/^[a-zA-Z0-9_-]+$/.test(schedulerJobName) || !/^[a-zA-Z0-9_-]+$/.test(jobName)
          || parseHostingBindings(environment).projectId !== this.credentials.projectId) {
          throw new Error('The scheduled workload identities are missing.');
        }
        const parent = `projects/${this.credentials.projectId}/locations/${this.credentials.region}`;
        const schedulerTarget = `https://run.googleapis.com/v2/${parent}/jobs/${jobName}:run`;
        const scheduler = await this.getCloudSchedulerJob(schedulerJobName, token);
        if (!scheduler || scheduler.name !== `${parent}/jobs/${schedulerJobName}`
          || typeof scheduler.schedule !== 'string' || !scheduler.schedule.trim()
          || (scheduler.timeZone !== undefined && typeof scheduler.timeZone !== 'string')
          || scheduler.httpTarget?.uri !== schedulerTarget || scheduler.httpTarget.httpMethod !== 'POST'
          || !['PAUSED', 'ENABLED'].includes(scheduler.state ?? '')) {
          throw new Error('The scheduled workload configuration could not be verified.');
        }
        const executions = await this.listCloudRunJobExecutionsStrict(jobName, token);
        // Scheduler pause stops future triggers. Execution completion is a separate
        // observation; an absent completion timestamp includes pending executions.
        const draining = executions.some((execution) => !execution.completionTime
          || execution.reconciling === true || (execution.runningCount ?? 0) > 0);
        return {
          serviceId,
          workloadKind,
          wasRunning: scheduler.state === 'ENABLED',
          cronSchedule: scheduler.schedule,
          state: scheduler.state === 'PAUSED' && !draining ? 'suspended' : 'running',
          ...(scheduler.state === 'PAUSED' && draining ? { reason: 'maintenance_executions_draining' } : {}),
          providerState: {
            schedulerJobName, schedulerState: scheduler.state, jobName,
            schedulerTimeZone: scheduler.timeZone || 'UTC', schedulerTarget,
          },
        };
      } catch {
        return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_cron_observation_failed' };
      }
    }
    const serviceName = binding.serviceId ?? serviceId;
    const service = await this.getCloudRunService(serviceName, token);
    if (!service) {
      return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_service_missing' };
    }
    const scaling = service.scaling ?? { scalingMode: 'AUTOMATIC' };
    const suspended = scaling.scalingMode === 'MANUAL' && scaling.manualInstanceCount === 0;
    return {
      serviceId,
      workloadKind,
      wasRunning: !suspended,
      state: suspended ? 'suspended' : 'running',
      numReplicas: scaling.manualInstanceCount,
      providerState: { scaling },
    };
  }

  async suspendMaintenanceWorkload(
    environment: Environment,
    expected: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    const current = await this.observeMaintenanceWorkload(environment, expected.serviceId, expected.workloadKind);
    if (expected.workloadKind === 'cron' && !this.matchesMaintenanceCronSnapshot(current, expected)) {
      return { success: false, message: 'The scheduled workload was not paused', error: 'Its saved schedule or exact workload could not be verified.' };
    }
    if (current.state === 'suspended') {
      return { success: true, message: `Cloud Run workload ${expected.serviceId} is already suspended`, data: { applied: 0, skipped: 1 } };
    }
    if (current.state !== 'running') {
      return { success: false, message: 'Cloud Run workload was not suspended', error: 'The bound workload state is unknown.' };
    }
    try {
      const token = await this.getAccessToken();
      if (expected.workloadKind === 'cron') {
        // A retry after pause must continue draining without issuing another pause.
        if (current.providerState?.schedulerState === 'ENABLED') {
          await this.mutateSchedulerState(String(current.providerState.schedulerJobName), 'pause', token);
        }
      } else {
        await this.updateMaintenanceScaling(expected.serviceId, { scalingMode: 'MANUAL', manualInstanceCount: 0 }, token);
      }
      const verified = await this.waitForMaintenanceState(environment, expected, 'suspended');
      return verified
        ? { success: true, message: `Suspended Cloud Run workload ${expected.serviceId}`, data: { applied: 1, skipped: 0 } }
        : { success: false, message: 'Cloud Run suspension was not verified', error: 'The workload has not finished stopping. Its saved settings remain available for a retry.' };
    } catch {
      return { success: false, message: 'Cloud Run suspension was not verified', error: 'The provider response could not be verified. Retry using the saved maintenance settings.' };
    }
  }

  async resumeMaintenanceWorkload(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    const current = await this.observeMaintenanceWorkload(environment, snapshot.serviceId, snapshot.workloadKind);
    if (snapshot.workloadKind === 'cron' && !this.matchesMaintenanceCronSnapshot(current, snapshot)) {
      return { success: false, message: 'The scheduled workload was not restored', error: 'Its saved schedule or exact workload changed or could not be verified.' };
    }
    if (!snapshot.wasRunning) {
      return current.state === 'suspended'
        ? { success: true, message: `Cloud Run workload ${snapshot.serviceId} was stopped before maintenance`, data: { applied: 0, skipped: 1 } }
        : { success: false, message: 'Cloud Run restoration was blocked', error: 'A workload that was previously stopped is now running.' };
    }
    if (current.state === 'running'
      && (snapshot.workloadKind !== 'cron' || current.providerState?.schedulerState === 'ENABLED')) {
      return { success: true, message: `Cloud Run workload ${snapshot.serviceId} is already running`, data: { applied: 0, skipped: 1 } };
    }
    if (current.state !== 'suspended') {
      return { success: false, message: 'Cloud Run workload was not restored', error: 'The bound workload state is unknown.' };
    }
    const token = await this.getAccessToken();
    if (snapshot.workloadKind === 'cron') {
      await this.mutateSchedulerState(String(snapshot.providerState?.schedulerJobName ?? ''), 'resume', token);
    } else {
      const prior = snapshot.providerState?.scaling;
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)) {
        return { success: false, message: 'Cloud Run workload was not restored', error: 'The exact pre-maintenance scaling configuration is missing.' };
      }
      await this.updateMaintenanceScaling(snapshot.serviceId, prior as Record<string, unknown>, token);
    }
    const verified = await this.waitForMaintenanceState(environment, snapshot, 'running');
    return verified
      ? { success: true, message: `Restored Cloud Run workload ${snapshot.serviceId}`, data: { applied: 1, skipped: 0 } }
      : { success: false, message: 'Cloud Run restoration was not verified', error: 'The provider did not report a running workload before the verification deadline.' };
  }

  private async updateMaintenanceScaling(
    serviceName: string,
    scaling: Record<string, unknown>,
    token: string
  ): Promise<void> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const automatic = scaling.scalingMode === 'AUTOMATIC' || scaling.scalingMode === undefined;
    const body = automatic
      ? { launchStage: 'BETA', scaling: { ...scaling, scalingMode: 'AUTOMATIC', manualInstanceCount: null } }
      : { scaling };
    const updateMask = automatic
      ? 'launchStage,scaling.scalingMode,scaling.manualInstanceCount,scaling.minInstanceCount,scaling.maxInstanceCount'
      : 'scaling.scalingMode,scaling.manualInstanceCount,scaling.minInstanceCount,scaling.maxInstanceCount';
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${this.credentials.projectId}/locations/${this.credentials.region}/services/${encodeURIComponent(serviceName)}?updateMask=${encodeURIComponent(updateMask)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!response.ok) throw new Error(`Cloud Run maintenance scaling failed (${response.status}).`);
  }

  private async mutateSchedulerState(
    schedulerJobName: string,
    operation: 'pause' | 'resume',
    token: string
  ): Promise<void> {
    if (!this.credentials || !schedulerJobName) throw new Error('Cloud Scheduler identity is missing.');
    const response = await fetch(
      `https://cloudscheduler.googleapis.com/v1/projects/${this.credentials.projectId}/locations/${this.credentials.region}/jobs/${encodeURIComponent(schedulerJobName)}:${operation}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }
    );
    if (!response.ok) throw new Error(`Cloud Scheduler ${operation} failed (${response.status}).`);
  }

  private async listCloudRunJobExecutionsStrict(
    jobName: string,
    token: string
  ): Promise<CloudRunExecution[]> {
    if (!this.credentials || !jobName) throw new Error('Cloud Run job identity is missing.');
    const executions: CloudRunExecution[] = [];
    const jobResourceName = `projects/${this.credentials.projectId}/locations/${this.credentials.region}/jobs/${jobName}`;
    const executionPrefix = `${jobResourceName}/executions/`;
    const executionNames = new Set<string>();
    const pageTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 1; page <= 20; page += 1) {
      const query = new URLSearchParams({ pageSize: '1000' });
      if (pageToken) query.set('pageToken', pageToken);
      const response = await fetch(
        `https://run.googleapis.com/v2/projects/${this.credentials.projectId}/locations/${this.credentials.region}/jobs/${encodeURIComponent(jobName)}/executions?${query.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) {
        throw new Error(`Cloud Run execution observation failed (${response.status}).`);
      }
      const rawBody: unknown = await response.json();
      if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        throw new Error('Cloud Run execution inventory is malformed.');
      }
      const body = rawBody as Record<string, unknown>;
      if (body.executions !== undefined && !Array.isArray(body.executions)) {
        throw new Error('Cloud Run execution inventory is malformed.');
      }
      for (const rawExecution of body.executions ?? []) {
        if (!rawExecution || typeof rawExecution !== 'object' || Array.isArray(rawExecution)) {
          throw new Error('Cloud Run execution is malformed.');
        }
        const execution = rawExecution as CloudRunExecution;
        if (typeof execution.name !== 'string' || !execution.name.startsWith(executionPrefix)
          || !/^[a-zA-Z0-9_-]+$/.test(execution.name.slice(executionPrefix.length))
          || executionNames.has(execution.name)
          || (execution.job !== undefined && execution.job !== jobResourceName)
          || (execution.reconciling !== undefined && typeof execution.reconciling !== 'boolean')
          || (execution.runningCount !== undefined && (!Number.isSafeInteger(execution.runningCount) || execution.runningCount < 0))
          || (execution.completionTime !== undefined && (typeof execution.completionTime !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(execution.completionTime)
            || !Number.isFinite(Date.parse(execution.completionTime))))) {
          throw new Error('Cloud Run execution identity or completion could not be verified.');
        }
        executionNames.add(execution.name);
        executions.push(execution);
      }
      if (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string') {
        throw new Error('Cloud Run execution pagination is malformed.');
      }
      pageToken = body.nextPageToken as string | undefined;
      if (!pageToken) return executions;
      if (pageTokens.has(pageToken)) throw new Error('Cloud Run execution pagination repeated.');
      pageTokens.add(pageToken);
    }
    throw new Error('Cloud Run execution observation exceeded the safe pagination bound.');
  }

  private matchesMaintenanceCronSnapshot(
    current: MaintenanceWorkloadObservation,
    snapshot: MaintenanceWorkloadSnapshot
  ): boolean {
    return current.state !== 'unknown' && Boolean(snapshot.cronSchedule)
      && current.cronSchedule === snapshot.cronSchedule
      && ['schedulerJobName', 'jobName', 'schedulerTimeZone', 'schedulerTarget'].every((key) =>
        typeof snapshot.providerState?.[key] === 'string'
        && current.providerState?.[key] === snapshot.providerState[key]);
  }

  private async waitForMaintenanceState(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot,
    expected: 'running' | 'suspended'
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const observed = await this.observeMaintenanceWorkload(environment, snapshot.serviceId, snapshot.workloadKind);
      if (snapshot.workloadKind === 'cron' && !this.matchesMaintenanceCronSnapshot(observed, snapshot)) return false;
      if (observed.state === expected
        && (snapshot.workloadKind !== 'cron' || expected !== 'running'
          || observed.providerState?.schedulerState === 'ENABLED')) return true;
      if (observed.state === 'unknown') return false;
      if (attempt < 120) await this.delay(Number(process.env.HYPERVIBE_GCP_WAIT_DELAY_MS ?? 1000));
    }
    return false;
  }

  // Helper methods

  private domainMappingBaseUrl(): string {
    const { projectId, region } = this.credentials!;
    return `https://${region}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${encodeURIComponent(projectId)}/domainmappings`;
  }

  private domainMappingRegionSupported(): boolean {
    return CLOUD_RUN_DOMAIN_MAPPING_REGIONS.has(this.credentials!.region);
  }

  private async listCloudRunDomainMappings(
    token: string
  ): Promise<CloudRunDomainMapping[]> {
    const mappings: CloudRunDomainMapping[] = [];
    const seenNames = new Set<string>();
    let continuation: string | undefined;
    do {
      const response = await fetch(
        `${this.domainMappingBaseUrl()}?limit=100${continuation ? `&continue=${encodeURIComponent(continuation)}` : ''}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) {
        throw new Error(`Cloud Run domain-mapping list failed with HTTP ${response.status}.`);
      }
      const body = await response.json() as {
        items?: CloudRunDomainMapping[];
        metadata?: { continue?: string };
        unreachable?: string[];
      };
      if (!Array.isArray(body.items)) {
        throw new Error('Cloud Run domain-mapping list returned an invalid items collection.');
      }
      if ((body.unreachable?.length ?? 0) > 0) {
        throw new Error(`Cloud Run domain-mapping observation was incomplete for: ${body.unreachable!.join(', ')}.`);
      }
      for (const mapping of body.items) {
        this.assertDomainMappingIdentity(mapping);
        const name = mapping.metadata!.name!.toLowerCase();
        if (seenNames.has(name)) {
          throw new Error(`Cloud Run returned duplicate domain mapping ${mapping.metadata!.name}.`);
        }
        seenNames.add(name);
        mappings.push(mapping);
      }
      continuation = body.metadata?.continue || undefined;
    } while (continuation);
    return mappings;
  }

  private assertDomainMappingIdentity(
    mapping: CloudRunDomainMapping,
    expectedDomain?: string
  ): void {
    const name = mapping.metadata?.name;
    const uid = mapping.metadata?.uid;
    const namespace = mapping.metadata?.namespace;
    if (!name || !uid || !namespace) {
      throw new Error('Cloud Run returned an incomplete domain-mapping identity.');
    }
    if (namespace !== this.credentials!.projectId) {
      throw new Error(`Cloud Run domain mapping ${name} belongs to namespace ${namespace}, not ${this.credentials!.projectId}.`);
    }
    if (expectedDomain && name.toLowerCase() !== expectedDomain.toLowerCase()) {
      throw new Error(`Cloud Run domain mapping identity ${name} does not match ${expectedDomain}.`);
    }
  }

  private domainMappingReady(mapping: CloudRunDomainMapping): boolean {
    const ready = mapping.status?.conditions?.find((condition) => condition.type === 'Ready');
    return ['True', 'CONDITION_SUCCEEDED'].includes(ready?.status ?? ready?.state ?? '');
  }

  private domainMappingCertificateStatus(mapping: CloudRunDomainMapping): string {
    const certificate = mapping.status?.conditions?.find((condition) =>
      /certificate/i.test(condition.type ?? '')
    );
    const ready = mapping.status?.conditions?.find((condition) => condition.type === 'Ready');
    const condition = certificate ?? ready;
    return condition?.reason
      ?? condition?.status
      ?? condition?.state
      ?? 'PENDING';
  }

  private domainMappingDnsRecords(
    mapping: CloudRunDomainMapping,
    domain: string
  ): Array<{ name: string; type: string; value: string; purpose: string }> {
    return (mapping.status?.resourceRecords ?? []).map((record) => {
      if (!record.type || !record.rrdata) {
        throw new Error(`Cloud Run returned an incomplete DNS record for ${domain}.`);
      }
      return {
        name: domain,
        type: record.type,
        value: record.rrdata,
        purpose: 'traffic verification',
      };
    });
  }

  private async queryCloudLogging(params: {
    token: string;
    targetName: string;
    targetKind: 'service' | 'job';
    limit: number;
    since?: Date;
    errorsOnly?: boolean;
  }): Promise<CloudLoggingEntry[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    const resourceFilter = params.targetKind === 'job'
      ? `resource.type="cloud_run_job" AND resource.labels.job_name="${this.escapeLoggingValue(params.targetName)}"`
      : `resource.type="cloud_run_revision" AND resource.labels.service_name="${this.escapeLoggingValue(params.targetName)}"`;
    const filterParts = [
      `resource.labels.project_id="${this.escapeLoggingValue(projectId)}"`,
      `resource.labels.location="${this.escapeLoggingValue(region)}"`,
      resourceFilter,
      params.since ? `timestamp >= "${params.since.toISOString()}"` : undefined,
      params.errorsOnly ? 'severity>=WARNING' : undefined,
    ].filter((entry): entry is string => Boolean(entry));

    const response = await fetch('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        resourceNames: [`projects/${projectId}`],
        filter: filterParts.join(' AND '),
        orderBy: 'timestamp desc',
        pageSize: params.limit,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(this.cloudLoggingErrorMessage(response.status, text));
    }

    const body = await response.json() as { entries?: CloudLoggingEntry[] };
    return body.entries ?? [];
  }

  private async verifyCloudLoggingAccess(token: string): Promise<{ success: true } | { success: false; error: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const { projectId } = this.credentials;
    const response = await fetch('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        resourceNames: [`projects/${projectId}`],
        filter: 'resource.type="cloud_run_revision"',
        pageSize: 1,
      }),
    });

    if (response.ok) {
      return { success: true };
    }

    const text = await response.text();
    return { success: false, error: this.cloudLoggingErrorMessage(response.status, text) };
  }

  private cloudLoggingErrorMessage(status: number, text: string): string {
    const denied = status === 403 && /PERMISSION_DENIED|Permission denied for all log views|logging\.views\.access/i.test(text);
    if (!denied) {
      return `Cloud Logging API error: ${status} ${text}`;
    }

    const email = this.serviceAccountCreds?.client_email;
    const member = email ? `serviceAccount:${email}` : '<cloudrun-service-account>';
    const projectId = this.credentials?.projectId ?? '<gcp-project-id>';
    return [
      'Cloud Logging API error: 403 Permission denied for all log views.',
      'Cloud Run deploys can continue, but logs_service will fail until the Cloud Run connection service account has Cloud Logging read access.',
      'Required roles: roles/logging.viewer and roles/logging.viewAccessor.',
      `Commands: gcloud projects add-iam-policy-binding ${projectId} --member="${member}" --role="roles/logging.viewer"; gcloud projects add-iam-policy-binding ${projectId} --member="${member}" --role="roles/logging.viewAccessor"`,
      `Original error: ${text}`,
    ].join(' ');
  }

  private async listCloudRunRevisions(serviceName: string, token: string, limit: number): Promise<CloudRunRevision[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}/revisions?pageSize=${Math.max(1, limit)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) return [];
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run revision observation failed: ${response.status}${text ? ` ${text}` : ''}`);
    }

    const body = await response.json() as { revisions?: CloudRunRevision[] };
    return body.revisions ?? [];
  }

  private async listCloudRunJobExecutions(jobName: string, token: string, limit: number): Promise<CloudRunExecution[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}/executions?pageSize=${Math.max(1, limit)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) return [];
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run execution observation failed: ${response.status}${text ? ` ${text}` : ''}`);
    }

    const body = await response.json() as { executions?: CloudRunExecution[] };
    return body.executions ?? [];
  }

  private async listCloudRunServices(token: string): Promise<CloudRunService[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    return this.listCloudRunResources<CloudRunService>(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services`,
      'services',
      token
    );
  }

  private async listCloudRunJobs(token: string): Promise<CloudRunJob[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    return this.listCloudRunResources<CloudRunJob>(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs`,
      'jobs',
      token
    );
  }

  private async listCloudRunResources<T>(baseUrl: string, key: string, token: string): Promise<T[]> {
    const resources: T[] = [];
    const resourceIds = new Set<string>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const url = `${baseUrl}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Run list API error: ${response.status} ${text}`);
      }

      const rawBody = await response.json() as unknown;
      if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        throw new Error('Cloud Run list API returned a malformed response body.');
      }
      const body = rawBody as Record<string, unknown>;
      const collection = body[key];
      if (collection !== undefined && !Array.isArray(collection)) {
        throw new Error(`Cloud Run list API returned a non-array ${key} collection.`);
      }

      const { projectId, region } = this.credentials!;
      const expectedNamePrefix = `projects/${projectId}/locations/${region}/${key}/`;
      for (const rawResource of collection ?? []) {
        if (!rawResource || typeof rawResource !== 'object' || Array.isArray(rawResource)) {
          throw new Error(`Cloud Run list API returned a malformed ${key} resource.`);
        }
        const name = (rawResource as Record<string, unknown>).name;
        if (typeof name !== 'string' || !name.startsWith(expectedNamePrefix)) {
          throw new Error(
            `Cloud Run list API returned a ${key} resource outside exact project ${projectId}, region ${region}, or kind ${key}.`
          );
        }
        const resourceId = name.slice(expectedNamePrefix.length);
        if (!resourceId || resourceId.includes('/')) {
          throw new Error(`Cloud Run list API returned a malformed ${key} resource name.`);
        }
        if (resourceIds.has(resourceId)) {
          throw new Error(`Cloud Run list API returned duplicate ${key} resource id ${resourceId}.`);
        }
        resourceIds.add(resourceId);
        resources.push(rawResource as T);
      }

      const nextPageToken = body.nextPageToken;
      if (nextPageToken !== undefined && typeof nextPageToken !== 'string') {
        throw new Error('Cloud Run list API returned a malformed nextPageToken.');
      }
      pageToken = nextPageToken || undefined;
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) {
          throw new Error('Cloud Run list API repeated a nextPageToken.');
        }
        seenPageTokens.add(pageToken);
      }
    } while (pageToken);
    return resources;
  }

  private observedServiceName(
    externalId: string,
    labels: Record<string, string> | undefined,
    bindingKey: string | undefined,
    prefix: string
  ): string {
    if (bindingKey) {
      return bindingKey;
    }
    const labeled = labels?.['infraprint-service'];
    if (labeled) {
      return labeled;
    }
    return externalId.startsWith(`${prefix}-`) ? externalId.slice(prefix.length + 1) : externalId;
  }

  private containerStartCommand(container: CloudRunContainer | undefined): string | undefined {
    if (!container) {
      return undefined;
    }
    if (
      container.command?.length === 1
      && container.command[0] === '/bin/sh'
      && container.args?.[0] === '-lc'
      && typeof container.args[1] === 'string'
    ) {
      return container.args[1];
    }
    const parts = [...(container.command ?? []), ...(container.args ?? [])];
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  private observedEnvFromContainer(container: CloudRunContainer | undefined): {
    envVarKeys: string[];
    envVarHashes: Record<string, string>;
  } {
    const envVarKeys: string[] = [];
    const envVarHashes: Record<string, string> = {};
    for (const entry of container?.env ?? []) {
      if (typeof entry.name !== 'string') continue;
      envVarKeys.push(entry.name);
      if (typeof entry.value === 'string') {
        envVarHashes[entry.name] = hashEnvValue(entry.value);
      }
    }
    return { envVarKeys, envVarHashes };
  }

  private async observePublicInvoker(serviceName: string, token: string): Promise<boolean> {
    const policy = await this.getServiceIamPolicy(this.cloudRunServiceResource(serviceName), token);
    return this.hasIamBinding(policy.bindings ?? [], 'roles/run.invoker', 'allUsers');
  }

  private toLogEntry(entry: CloudLoggingEntry): LogEntry {
    const timestamp = entry.timestamp ?? entry.receiveTimestamp ?? new Date().toISOString();
    return {
      timestamp: new Date(timestamp),
      severity: this.logSeverity(entry.severity),
      message: this.logMessage(entry),
      raw: JSON.stringify(entry),
    };
  }

  private logSeverity(severity?: string): LogEntry['severity'] {
    const normalized = (severity ?? '').toLowerCase();
    if (['emergency', 'alert', 'critical', 'error'].includes(normalized)) return 'error';
    if (['warning', 'warn'].includes(normalized)) return 'warn';
    return 'info';
  }

  private logMessage(entry: CloudLoggingEntry): string {
    if (entry.textPayload) return entry.textPayload;
    if (entry.jsonPayload) {
      if (typeof entry.jsonPayload.message === 'string') return entry.jsonPayload.message;
      if (typeof entry.jsonPayload.msg === 'string') return entry.jsonPayload.msg;
      return JSON.stringify(entry.jsonPayload);
    }
    if (entry.protoPayload) {
      if (typeof entry.protoPayload.methodName === 'string') return entry.protoPayload.methodName;
      return JSON.stringify(entry.protoPayload);
    }
    return '';
  }

  private executionStatus(execution: CloudRunExecution): string {
    const completion = execution.completionStatus?.toLowerCase();
    if (completion) {
      if (completion.includes('succeed')) return 'completed';
      if (completion.includes('fail') || completion.includes('cancel') || completion.includes('timeout')) return 'failed';
      return completion;
    }
    const readiness = this.cloudRunJobReadiness({
      name: execution.name,
      generation: '',
      observedGeneration: '',
      terminalCondition: execution.terminalCondition,
      conditions: execution.conditions,
      reconciling: execution.reconciling,
    });
    if (readiness.ready) return 'completed';
    if (readiness.error) return 'failed';
    return 'running';
  }

  private async executeCloudRunJob(
    jobName: string,
    token: string
  ): Promise<{ operation: CloudRunOperation; execution: CloudRunExecution | null }> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}:run`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud Run Jobs run error: ${response.status} ${text}`);
    }

    const operation = await response.json() as CloudRunOperation;
    const execution = await this.waitForCloudRunJobExecution(operation, jobName, token);
    return { operation, execution };
  }

  private async waitForCloudRunJobExecution(
    operation: CloudRunOperation,
    jobName: string,
    token: string,
    timeoutMs = 10 * 60 * 1000
  ): Promise<CloudRunExecution | null> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const deadline = Date.now() + timeoutMs;
    let current = operation;
    const { projectId, region } = this.credentials;
    const operationPrefix = `projects/${projectId}/locations/${region}/operations/`;
    const executionPrefix = `projects/${projectId}/locations/${region}/jobs/${jobName}/executions/`;
    if (!operation.name?.startsWith(operationPrefix) || operation.name.length <= operationPrefix.length) {
      throw new Error('Cloud Run Jobs run response did not include a trackable operation identity.');
    }
    const operationName = operation.name;

    while (Date.now() < deadline) {
      if (current.name !== operationName) {
        throw new Error('Cloud Run job execution status returned a different operation identity.');
      }
      if (current.done) {
        if (current.error) {
          throw new Error(
            `Cloud Run job execution operation failed: ${current.error.status ?? current.error.code ?? 'unknown'} ${current.error.message ?? ''}`.trim()
          );
        }
        if (!current.response) {
          throw new Error('Cloud Run job execution operation completed without returning its exact execution.');
        }

        let execution = current.response;
        if (!execution.name?.startsWith(executionPrefix) || execution.name.length <= executionPrefix.length) {
          throw new Error(`Cloud Run job execution operation returned a different execution identity for ${jobName}.`);
        }
        const exactExecutionName = execution.name;
        while (Date.now() < deadline) {
          const status = this.executionStatus(execution);
          if (status === 'completed' || status === 'failed') return execution;
          if (!execution.name) {
            throw new Error('Cloud Run job execution response did not include an execution name.');
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const response = await fetch(`https://run.googleapis.com/v2/${execution.name}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Cloud Run execution status check failed: ${response.status} ${text}`);
          }
          execution = await response.json() as CloudRunExecution;
          if (execution.name !== exactExecutionName) {
            throw new Error(`Cloud Run execution lookup returned a different execution identity for ${jobName}.`);
          }
        }
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
      const response = await fetch(`https://run.googleapis.com/v2/${operationName}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Run job execution operation status check failed: ${response.status} ${text}`);
      }
      current = await response.json() as CloudRunOperation;
    }

    return null;
  }

  private lastPathSegment(value?: string): string | undefined {
    if (!value) return undefined;
    const parts = value.split('/').filter(Boolean);
    return parts[parts.length - 1];
  }

  private stableResourceName(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!normalized) throw new Error('Cloud Run resources require a name');
    if (normalized.length <= 63) return normalized;

    const suffix = `-${hashEnvValue(normalized).slice(0, 10)}`;
    return `${normalized.slice(0, 63 - suffix.length).replace(/-+$/g, '')}${suffix}`;
  }

  private environmentResourcePrefix(
    environment: Pick<Environment, 'name'>,
    providerProjectId?: string
  ): string {
    return this.stableResourceName(
      `${providerProjectId?.trim() || this.credentials?.projectId || 'hypervibe'}-${environment.name}`
    );
  }

  private workloadResourceName(
    environment: Pick<Environment, 'name' | 'platformBindings'>,
    logicalName: string,
    boundId?: string
  ): string {
    if (boundId) return boundId;
    return resourceName(logicalName, { maxLength: 49,
      scope: [this.credentials!.projectId, environment.name] });
  }

  private schedulerResourceName(jobName: string, boundId?: string): string {
    if (boundId) return boundId;
    const normalized = jobName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const suffix = '-schedule';
    if (`${normalized}${suffix}`.length <= 63) return `${normalized}${suffix}`;

    const hashSuffix = `-${hashEnvValue(normalized).slice(0, 10)}${suffix}`;
    return `${normalized.slice(0, 63 - hashSuffix.length).replace(/-+$/g, '')}${hashSuffix}`;
  }

  private migrationJobName(serviceName: string): string {
    return cloudRunMigrationJobName(serviceName);
  }

  private assertReleaseJobConfiguration(
    job: CloudRunJob,
    jobName: string,
    jobSpec: Record<string, unknown>
  ): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const mismatch = cloudRunReleaseJobConfigurationMismatch(
      job,
      `projects/${this.credentials.projectId}/locations/${this.credentials.region}/jobs/${jobName}`,
      jobSpec
    );
    if (mismatch) {
      throw new Error(
        `Cloud Run release job ${jobName} did not converge to the exact candidate ${mismatch}; refusing to execute it.`
      );
    }
  }

  private isArtifactRepositoryName(name: string): boolean {
    const identity = this.artifactRepositoryIdentity(name);
    return Boolean(identity && this.credentials && identity.location === this.credentials.region);
  }

  private artifactRepositoryIdentity(name: string): { location: string; repository: string } | null {
    if (!this.credentials) return null;
    const match = /^projects\/([^/]+)\/locations\/([^/]+)\/repositories\/([^/]+)$/.exec(name);
    if (!match || match[1] !== this.credentials.projectId) return null;
    return { location: match[2]!, repository: match[3]! };
  }

  private async listArtifactRegistryLocations(token: string): Promise<string[]> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const { projectId } = this.credentials;
    const locations: string[] = [];
    const seenLocations = new Set<string>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;

    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const query = new URLSearchParams({ pageSize: '100' });
      if (pageToken) query.set('pageToken', pageToken);
      const response = await fetch(
        `https://artifactregistry.googleapis.com/v1/projects/${projectId}/locations?${query.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        throw new Error(`Artifact Registry location inventory failed: ${response.status}${body ? ` ${body}` : ''}`);
      }
      const page = await response.json() as ArtifactLocationList;
      for (const location of page.locations ?? []) {
        const match = /^projects\/([^/]+)\/locations\/([^/]+)$/.exec(location.name ?? '');
        if (!match || match[1] !== projectId) {
          throw new Error(`Artifact Registry returned an invalid location identity: ${location.name ?? '(missing)'}`);
        }
        const locationId = match[2]!;
        if (!seenLocations.has(locationId)) {
          seenLocations.add(locationId);
          locations.push(locationId);
        }
      }

      pageToken = page.nextPageToken;
      if (!pageToken) return locations;
      if (seenPageTokens.has(pageToken)) {
        throw new Error('Artifact Registry location inventory returned a repeated page token');
      }
      seenPageTokens.add(pageToken);
      if (pageNumber === 99) {
        throw new Error('Artifact Registry location inventory exceeded the bounded page limit');
      }
    }

    throw new Error('Artifact Registry location inventory did not converge');
  }

  private async getArtifactRepository(
    name: string,
    accessToken?: string
  ): Promise<ArtifactRepository | null> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    if (!this.isArtifactRepositoryName(name)) {
      throw new Error(`Artifact Registry repository id must match projects/${this.credentials.projectId}/locations/${this.credentials.region}/repositories/{repository}.`);
    }
    const token = accessToken ?? await this.getAccessToken();
    const response = await fetch(`https://artifactregistry.googleapis.com/v1/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Artifact Registry repository lookup failed: ${response.status} ${body}`);
    }
    return await response.json() as ArtifactRepository;
  }

  private assertArtifactRepository(
    repository: ArtifactRepository,
    expectedName: string
  ): void {
    if (repository?.name !== expectedName) {
      throw new Error(
        `Artifact Registry returned a different repository identity; expected ${expectedName}.`
      );
    }
    if (repository.format !== 'DOCKER') {
      throw new Error(
        `Artifact Registry repository ${expectedName} did not prove DOCKER format.`
      );
    }
  }

  private inspectedArtifactRepository(repository: ArtifactRepository): Record<string, unknown> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const identity = this.artifactRepositoryIdentity(repository.name);
    if (!identity) throw new Error(`Artifact Registry returned an invalid repository identity: ${repository.name}`);
    return {
      id: repository.name,
      name: this.lastPathSegment(repository.name) ?? repository.name,
      providerScope: {
        projectId: this.credentials.projectId,
        location: identity.location,
      },
      format: repository.format ?? null,
      mode: repository.mode ?? null,
      description: repository.description ?? null,
      createTime: repository.createTime ?? null,
      updateTime: repository.updateTime ?? null,
      sizeBytes: repository.sizeBytes ?? null,
      cleanupSupported: true,
    };
  }

  private async waitForArtifactRegistryOperation(
    token: string,
    operation: CloudRunOperation,
    description: string,
    expectedResponseName?: string
  ): Promise<void> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const operationPrefix = `projects/${this.credentials.projectId}/locations/${this.credentials.region}/operations/`;
    if (
      !operation.name?.startsWith(operationPrefix)
      || operation.name.length <= operationPrefix.length
      || operation.name.slice(operationPrefix.length).includes('/')
    ) {
      throw new Error(`Artifact Registry ${description} response did not include an exact operation identity.`);
    }
    const operationName = operation.name;
    let current = operation;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (current.name !== operationName) {
        throw new Error(`Artifact Registry ${description} status returned a different operation identity.`);
      }
      if (current.done) {
        if (current.error) {
          throw new Error(`Artifact Registry ${description} failed: ${current.error.status ?? current.error.code ?? 'unknown'} ${current.error.message ?? ''}`.trim());
        }
        if (expectedResponseName && current.response !== undefined) {
          if (current.response?.name !== expectedResponseName) {
            throw new Error(`Artifact Registry ${description} returned a different repository identity.`);
          }
        }
        return;
      }
      await this.delay(Number(process.env.HYPERVIBE_GCP_WAIT_DELAY_MS ?? 1000));
      const response = await fetch(`https://artifactregistry.googleapis.com/v1/${operationName}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Artifact Registry ${description} operation lookup failed: ${response.status} ${body}`);
      }
      current = await response.json() as CloudRunOperation;
    }
    throw new Error(`Artifact Registry ${description} did not finish before timeout`);
  }

  private escapeLoggingValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private hasIamBinding(bindings: IamBinding[], role: string, member: string): boolean {
    return bindings.some((binding) =>
      binding.role === role
      && !binding.condition
      && (binding.members ?? []).includes(member)
    );
  }

  private async ensureProjectIamBindings(params: {
    token: string;
    member: string;
    roles: string[];
  }): Promise<string[]> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    let policy: IamPolicy;
    try {
      policy = await this.getProjectIamPolicy(params.token);
    } catch (error) {
      if (!this.isDisabledApiError(error, 'cloudresourcemanager.googleapis.com')) {
        throw error;
      }
      await this.enableGoogleService(params.token, 'cloudresourcemanager.googleapis.com');
      policy = await this.getProjectIamPolicy(params.token);
    }
    const bindings = (policy.bindings ?? []).map((binding) => ({
      ...binding,
      members: [...(binding.members ?? [])],
    }));
    const updatedRoles: string[] = [];

    for (const role of params.roles) {
      const existing = bindings.find((binding) => binding.role === role && !binding.condition);
      if (existing?.members?.includes(params.member)) {
        continue;
      }
      if (existing) {
        existing.members = Array.from(new Set([...(existing.members ?? []), params.member]));
      } else {
        bindings.push({ role, members: [params.member] });
      }
      updatedRoles.push(role);
    }

    if (updatedRoles.length > 0) {
      await this.setProjectIamPolicy({ ...policy, bindings }, params.token);
    }

    return updatedRoles;
  }

  private async getProjectIamPolicy(token: string): Promise<IamPolicy> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${this.credentials.projectId}:getIamPolicy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GCP project IAM policy lookup failed: ${response.status} ${text}`);
    }

    return await response.json() as IamPolicy;
  }

  private async enableGoogleService(token: string, serviceName: string): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const response = await fetch(
      `https://serviceusage.googleapis.com/v1/projects/${this.credentials.projectId}/services/${serviceName}:enable`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Cloud Resource Manager API is disabled and Hypervibe could not enable ${serviceName}: ${response.status} ${text}. ` +
        'Grant the connection service account serviceusage.services.enable permission or enable the API once in GCP.'
      );
    }

    const operation = await response.json() as CloudRunOperation;
    if (operation.name) {
      await this.waitForServiceUsageOperation(token, operation, `enable ${serviceName}`);
    }
  }

  private async waitForServiceUsageOperation(
    token: string,
    operation: CloudRunOperation,
    description: string
  ): Promise<void> {
    if (!operation.name || !operation.name.includes('/')) {
      return;
    }

    let current = operation;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (current.done) {
        if (current.error) {
          throw new Error(
            `Service Usage ${description} operation failed: ${current.error.status ?? current.error.code ?? 'unknown'} ${current.error.message ?? ''}`.trim()
          );
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
      const response = await fetch(`https://serviceusage.googleapis.com/v1/${operation.name}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Service Usage ${description} operation status check failed: ${response.status} ${text}`);
      }
      current = await response.json() as CloudRunOperation;
    }

    throw new Error(`Service Usage ${description} operation did not finish before timeout`);
  }

  private isDisabledApiError(error: unknown, serviceName: string): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return this.isDisabledApiMessage(message, serviceName);
  }

  private isDisabledApiMessage(message: string, serviceName: string): boolean {
    return message.includes(serviceName) && /disabled|has not been used/i.test(message);
  }

  private async setProjectIamPolicy(policy: IamPolicy, token: string): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${this.credentials.projectId}:setIamPolicy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policy }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GCP project IAM policy update failed: ${response.status} ${text}`);
    }
  }

  private async getServiceIamPolicy(resource: string, token: string, policyVersion?: number): Promise<IamPolicy> {
    const query = policyVersion ? `?options.requestedPolicyVersion=${policyVersion}` : '';
    const response = await fetch(`https://run.googleapis.com/v2/${resource}:getIamPolicy${query}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud Run IAM policy lookup failed: ${response.status} ${text}`);
    }

    return await response.json() as IamPolicy;
  }

  private cloudRunServiceResource(serviceName: string): string {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const { projectId, region } = this.credentials;
    return `projects/${projectId}/locations/${region}/services/${serviceName}`;
  }

  private async buildImageForService(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>
  ): Promise<CloudBuildResult> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const sourceRepoUrl = envVars['HYPERVIBE_SOURCE_REPO_URL']?.trim();
    if (!sourceRepoUrl) {
      return {
        success: false,
        error: 'Cloud Run builds are automatic, but this project has no gitRemoteUrl. Set the project gitRemoteUrl so Cloud Build can build from source.',
      };
    }
    if (envVars['HYPERVIBE_GITHUB_TOKEN']?.trim()) {
      return {
        success: false,
        error: 'A GitHub credential cannot be embedded in Cloud Build metadata. Use the managed-CI deployment path for private repositories and private packages.',
      };
    }

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;
      const repository = this.sanitizeName(envVars['HYPERVIBE_ARTIFACT_REPOSITORY']?.trim() || 'hypervibe');
      const imageName = this.sanitizeName(`${environment.name}-${service.name}`);
      const revision = envVars['HYPERVIBE_SOURCE_REVISION']?.trim() || 'main';
      const tag = this.sanitizeName(
        `${revision.replace(/^refs\/heads\//, '')}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
      );
      const imageUri = `${region}-docker.pkg.dev/${projectId}/${repository}/${imageName}:${tag}`;

      await this.ensureArtifactRepository(repository, token);
      const build = await this.submitCloudBuild({
        token,
        service,
        sourceRepoUrl,
        revision,
        imageUri,
      });

      return {
        success: true,
        imageUri: build.imageUri,
        buildId: build.id,
        logsUrl: build.logsUrl,
        resolvedCommitSha: build.resolvedCommitSha,
      };
    } catch (error) {
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  private async ensureArtifactRepository(repository: string, token: string): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId, region } = this.credentials;
    const baseUrl = `https://artifactregistry.googleapis.com/v1/projects/${projectId}/locations/${region}/repositories`;
    const repositoryName = `projects/${projectId}/locations/${region}/repositories/${repository}`;
    const existing = await fetch(`${baseUrl}/${repository}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (existing.ok) {
      this.assertArtifactRepository(
        await existing.json() as ArtifactRepository,
        repositoryName
      );
      return;
    }

    if (existing.status !== 404) {
      const text = await existing.text();
      throw new Error(`Artifact Registry lookup failed: ${existing.status} ${text}`);
    }

    const created = await fetch(`${baseUrl}?repositoryId=${encodeURIComponent(repository)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        format: 'DOCKER',
        description: 'Container images built by Hypervibe',
      }),
    });

    if (!created.ok) {
      const text = await created.text();
      throw new Error(`Artifact Registry repository creation failed: ${created.status} ${text}`);
    }

    const operation = await created.json() as CloudRunOperation;
    await this.waitForArtifactRegistryOperation(
      token,
      operation,
      'repository create',
      repositoryName
    );
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const ready = await this.getArtifactRepository(repositoryName, token);
      if (ready) {
        this.assertArtifactRepository(ready, repositoryName);
        return;
      }
      if (attempt < 119) {
        await this.delay(Number(process.env.HYPERVIBE_GCP_WAIT_DELAY_MS ?? 1000));
      }
    }
    throw new Error(
      `Artifact Registry repository ${repositoryName} remained absent after its create operation completed.`
    );
  }

  private async submitCloudBuild(params: {
    token: string;
    service: Service;
    sourceRepoUrl: string;
    revision: string;
    imageUri: string;
  }): Promise<{
    id?: string;
    logsUrl?: string;
    imageUri: string;
    resolvedCommitSha?: string;
  }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId } = this.credentials;
    const response = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: {
          gitSource: {
            url: params.sourceRepoUrl,
            revision: params.revision,
          },
        },
        steps: [{
          name: 'gcr.io/cloud-builders/docker',
          entrypoint: 'bash',
          args: ['-lc', this.cloudBuildScript(params.service, params.imageUri)],
        }],
        images: [params.imageUri],
        timeout: '1200s',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud Build submission failed: ${response.status} ${text}`);
    }

    const build = await response.json() as CloudBuildStatus | CloudBuildOperation;
    return this.waitForCloudBuild(params.token, build, params.imageUri);
  }

  private async waitForCloudBuild(
    token: string,
    buildOrOperation: CloudBuildStatus | CloudBuildOperation,
    submittedImageUri: string
  ): Promise<{
    id?: string;
    logsUrl?: string;
    imageUri: string;
    resolvedCommitSha?: string;
  }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId } = this.credentials;
    let current = this.cloudBuildStatusFromResponse(buildOrOperation);
    let buildId = current?.id ?? this.cloudBuildIdFromOperation(buildOrOperation);
    let operation = this.isCloudBuildOperation(buildOrOperation) ? buildOrOperation : undefined;

    for (let attempt = 0; attempt < 120; attempt++) {
      if (!buildId && operation?.name) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const operationResponse = await fetch(`https://cloudbuild.googleapis.com/v1/${operation.name}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!operationResponse.ok) {
          const text = await operationResponse.text();
          throw new Error(`Cloud Build operation status check failed: ${operationResponse.status} ${text}`);
        }
        operation = await operationResponse.json() as CloudBuildOperation;
        current = this.cloudBuildStatusFromResponse(operation);
        buildId = current?.id ?? this.cloudBuildIdFromOperation(operation);
        if (operation.done && operation.error) {
          throw new Error(
            `Cloud Build operation failed: ${operation.error.status ?? operation.error.code ?? 'unknown'} ${operation.error.message ?? ''}`.trim()
          );
        }
        continue;
      }

      if (!buildId) {
        throw new Error('Cloud Build response did not include a build ID');
      }

      if (!current || current.id !== buildId) {
        const response = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds/${buildId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Cloud Build status check failed: ${response.status} ${text}`);
        }
        current = await response.json() as CloudBuildStatus;
      }

      const status = (current.status ?? '').toUpperCase();
      if (status === 'SUCCESS') {
        const imageUri = this.cloudBuildDigestImageUri(current, submittedImageUri);
        const resolvedCommitSha = current.sourceProvenance?.resolvedRepoSource?.commitSha;
        return {
          id: current.id,
          logsUrl: current.logsUrl ?? current.logUrl,
          imageUri,
          ...(/^[0-9a-f]{40}$/i.test(resolvedCommitSha ?? '')
            ? { resolvedCommitSha: resolvedCommitSha!.toLowerCase() }
            : {}),
        };
      }
      if (['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED'].includes(status)) {
        throw new Error(this.cloudBuildFailureMessage(current, status));
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
      const response = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds/${buildId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Build status check failed: ${response.status} ${text}`);
      }
      current = await response.json() as CloudBuildStatus;
    }

    const logsUrl = current?.logsUrl ?? current?.logUrl;
    throw new Error(`Cloud Build did not finish before timeout${logsUrl ? ` (${logsUrl})` : ''}`);
  }

  private cloudBuildScript(service: Service, imageUri: string): string {
    const dockerfilePath = service.buildConfig.dockerfilePath?.trim() || 'Dockerfile';
    const runtime = service.buildConfig.runtime;
    let generatedDockerfile = '';
    let generationError = 'No explicit project runtime was found. Run hv_spec to review repository evidence.';
    if (runtime) {
      try {
        generatedDockerfile = generatedContainerDockerfile(runtime, service.buildConfig.startCommand);
      } catch (error) {
        generationError = error instanceof Error ? error.message : String(error);
      }
    }
    const generatedDockerfileBase64 = Buffer.from(generatedDockerfile, 'utf8').toString('base64');
    const writeGeneratedDockerfile = generatedDockerfile
      ? `  printf '%s' '${generatedDockerfileBase64}' | base64 --decode > Dockerfile.infraprint`
      : `  echo ${JSON.stringify(generationError)} >&2\n  exit 1`;
    const manifestCondition = runtime?.kind === 'node'
      ? '[ -f package.json ]'
      : runtime?.kind === 'python'
        ? '[ -f requirements.txt ] || [ -f pyproject.toml ]'
        : 'false';

    return [
      'set -euo pipefail',
      `if [ -f ${JSON.stringify(dockerfilePath)} ]; then`,
      `  docker build --pull -t ${JSON.stringify(imageUri)} -f ${JSON.stringify(dockerfilePath)} .`,
      `elif ${manifestCondition}; then`,
      writeGeneratedDockerfile,
      `  docker build --pull -t ${JSON.stringify(imageUri)} -f Dockerfile.infraprint .`,
      'else',
      '  echo "No repository Dockerfile or manifest for an explicit project runtime was found. Run hv_spec to review runtime evidence; custom languages require a Dockerfile." >&2',
      '  exit 1',
      'fi',
    ].join('\n');
  }

  private cloudBuildDigestImageUri(
    build: CloudBuildStatus,
    submittedImageUri: string
  ): string {
    const builtImage = build.results?.images?.find((image) => image.name === submittedImageUri);
    const digest = builtImage?.digest?.toLowerCase();
    if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(
        'Cloud Build succeeded without an exact image digest for the submitted image. Refusing to deploy a mutable tag.'
      );
    }
    const lastSlash = submittedImageUri.lastIndexOf('/');
    const lastColon = submittedImageUri.lastIndexOf(':');
    const repository = lastColon > lastSlash
      ? submittedImageUri.slice(0, lastColon)
      : submittedImageUri.split('@')[0];
    return `${repository}@${digest}`;
  }

  private cloudBuildFailureMessage(build: CloudBuildStatus, status: string): string {
    const logsUrl = build.logsUrl ?? build.logUrl;
    const details = [
      build.statusDetail,
      build.failureInfo?.type,
      build.failureInfo?.detail,
      ...((build.steps ?? [])
        .filter((step) => {
          const stepStatus = (step.status ?? '').toUpperCase();
          return ['FAILURE', 'CANCELLED', 'TIMEOUT'].includes(stepStatus) || typeof step.exitCode === 'number';
        })
        .map((step) => {
          const label = step.id ?? step.name ?? 'unnamed step';
          const exitCode = typeof step.exitCode === 'number' ? ` exit=${step.exitCode}` : '';
          return `${label}: status=${step.status ?? 'unknown'}${exitCode}`;
        })),
    ].filter((entry): entry is string => Boolean(entry));

    return [
      `Cloud Build failed with status ${status}`,
      details.length > 0 ? `: ${details.join('; ')}` : '',
      logsUrl ? ` (${logsUrl})` : '',
    ].join('');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.serviceAccountCreds) {
      throw new Error('No service account credentials');
    }

    // Create JWT
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.serviceAccountCreds.client_email,
      sub: this.serviceAccountCreds.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    };

    const jwt = await this.createJwt(header, payload, this.serviceAccountCreds.private_key);

    // Exchange JWT for access token
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = new Date(Date.now() + (data.expires_in - 60) * 1000);

    return this.accessToken!;
  }

  private async createJwt(
    header: Record<string, string>,
    payload: Record<string, unknown>,
    privateKey: string
  ): Promise<string> {
    const encoder = new TextEncoder();

    const headerB64 = this.base64UrlEncode(JSON.stringify(header));
    const payloadB64 = this.base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${headerB64}.${payloadB64}`;

    // Import private key
    const pemContents = privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\n/g, '');
    const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Sign
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      encoder.encode(unsignedToken)
    );

    const signatureB64 = this.base64UrlEncode(
      String.fromCharCode(...new Uint8Array(signature))
    );

    return `${unsignedToken}.${signatureB64}`;
  }

  private base64UrlEncode(str: string): string {
    return btoa(str)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private async getService(
    serviceName: string
  ): Promise<CloudRunService | null> {
    if (!this.credentials) {
      return null;
    }

    const token = await this.getAccessToken();
    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run API error: ${response.status}${text ? ` ${text}` : ''}`);
    }

    return (await response.json()) as CloudRunService;
  }

  private primaryContainer(service: CloudRunService | null): CloudRunContainer | undefined {
    return service?.template?.containers?.[0] ?? service?.spec?.template?.spec?.containers?.[0];
  }

  private serviceRuntimeIdentity(service: CloudRunService | null): string | undefined {
    return service?.template?.serviceAccount
      ?? service?.template?.serviceAccountName
      ?? service?.spec?.template?.spec?.serviceAccountName;
  }

  private requiredRuntimeServiceAccountEmail(resource: string): string {
    const email = this.credentials?.runtimeServiceAccountEmail?.trim();
    if (!email) {
      throw new Error(
        `Cloud Run runtimeServiceAccountEmail is required to create ${resource}; refusing to run application code as the deploy credential.`
      );
    }
    return email;
  }

  private primaryJobContainer(job: CloudRunJob | null): CloudRunContainer | undefined {
    return job?.template?.template?.containers?.[0];
  }

  private jobRuntimeIdentity(job: CloudRunJob | null): string | undefined {
    return job?.template?.template?.serviceAccount
      ?? job?.template?.template?.serviceAccountName;
  }

  private cloudRunServiceVolumes(service: CloudRunService | null): Array<Record<string, unknown>> | undefined {
    return service?.template?.volumes ?? service?.spec?.template?.spec?.volumes;
  }

  private serviceVpcAccess(service: CloudRunService | null): CloudRunVpcAccess | undefined {
    return service?.template?.vpcAccess ?? service?.spec?.template?.spec?.vpcAccess;
  }

  private normalizeCloudRunNetwork(value: string): string {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const normalized = value.replace(/^https:\/\/www\.googleapis\.com\/compute\/v1\//, '');
    const match = /^projects\/([^/]+)\/global\/networks\/([^/]+)$/.exec(normalized);
    const name = match?.[2] ?? (/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(normalized) ? normalized : undefined);
    const projectId = match?.[1] ?? this.credentials.projectId;
    if (!name || projectId !== this.credentials.projectId) {
      throw new Error(`Cloud Run cache network must belong to connected GCP project ${this.credentials.projectId}; received ${value}.`);
    }
    return `projects/${projectId}/global/networks/${name}`;
  }

  private normalizeCloudRunSubnetwork(value: string): string {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const normalized = value.replace(/^https:\/\/www\.googleapis\.com\/compute\/v1\//, '');
    const match = /^projects\/([^/]+)\/regions\/([^/]+)\/subnetworks\/([^/]+)$/.exec(normalized);
    const name = match?.[3] ?? (/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(normalized) ? normalized : undefined);
    const projectId = match?.[1] ?? this.credentials.projectId;
    const region = match?.[2] ?? this.credentials.region;
    if (!name || projectId !== this.credentials.projectId || region !== this.credentials.region) {
      throw new Error(`Cloud Run cache subnetwork must belong to ${this.credentials.projectId}/${this.credentials.region}; received ${value}.`);
    }
    return `projects/${projectId}/regions/${region}/subnetworks/${name}`;
  }

  private normalizedVpcAccess(value?: CloudRunVpcAccess): ResolvedCloudRunVpcAccess['desired'] {
    const interfaces = value?.networkInterfaces ?? [];
    if (interfaces.length === 0) return undefined;
    if (interfaces.length !== 1 || !interfaces[0]?.network || !interfaces[0].subnetwork) {
      throw new Error('Cloud Run returned an incomplete or ambiguous Direct VPC egress attachment.');
    }
    return {
      network: this.normalizeCloudRunNetwork(interfaces[0].network),
      subnetwork: this.normalizeCloudRunSubnetwork(interfaces[0].subnetwork),
      egress: value?.egress ?? 'PRIVATE_RANGES_ONLY',
    };
  }

  private async resolveVpcAccess(
    environment: Environment,
    current: CloudRunVpcAccess | undefined,
    token: string
  ): Promise<ResolvedCloudRunVpcAccess> {
    const bindings = environment.platformBindings as Record<string, unknown>;
    const retainedVolumes = parseServiceVolumeBindings(environment);
    if (!retainedVolumes) throw new Error('Malformed retained filesystem bindings prevent network changes.');
    const currentNetwork = this.normalizedVpcAccess(current);
    const filesystemUsesCurrentNetwork = Object.values(retainedVolumes).some((volume) => {
      if (volume.provider !== 'cloudrun' || volume.state !== 'staged' || !volume.components.attachment?.externalId) return false;
      const scope = volume.target.instanceScope;
      if (!scope || scope.projectId !== this.credentials!.projectId || scope.region !== this.credentials!.region) throw new Error('Retained filesystem network scope differs from the current cloud connection.');
      return currentNetwork?.network === `projects/${scope.projectId}/global/networks/${scope.network}`
        && currentNetwork.subnetwork === `projects/${scope.projectId}/regions/${scope.region}/subnetworks/${scope.subnetwork}`;
    });
    if (filesystemUsesCurrentNetwork && bindings.cacheNetwork === null) {
      return { managed: false, desired: currentNetwork, ...(current ? { apiValue: current } : {}) };
    }
    if (!Object.prototype.hasOwnProperty.call(bindings, 'cacheNetwork')) {
      return {
        managed: false,
        desired: this.normalizedVpcAccess(current),
        ...(current ? { apiValue: current } : {}),
      };
    }
    if (bindings.cacheNetwork === null) {
      return { managed: true, apiValue: {} };
    }
    const raw = bindings.cacheNetwork;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Cloud Run cacheNetwork binding is invalid; re-run hv_plan before mutating a service.');
    }
    const binding = raw as Record<string, unknown>;
    if (
      binding.provider !== 'cloudrun'
      || binding.projectId !== this.credentials!.projectId
      || binding.region !== this.credentials!.region
      || typeof binding.network !== 'string'
      || typeof binding.subnetwork !== 'string'
      || binding.egress !== 'PRIVATE_RANGES_ONLY'
    ) {
      throw new Error(
        `Cloud Run cacheNetwork must identify cloudrun/${this.credentials!.projectId}/${this.credentials!.region} with exact network, subnetwork, and PRIVATE_RANGES_ONLY egress.`
      );
    }
    const desired = {
      network: this.normalizeCloudRunNetwork(binding.network),
      subnetwork: this.normalizeCloudRunSubnetwork(binding.subnetwork),
      egress: 'PRIVATE_RANGES_ONLY',
    };
    if (filesystemUsesCurrentNetwork && (desired.network !== currentNetwork?.network || desired.subnetwork !== currentNetwork?.subnetwork)) {
      throw new Error('Cache networking cannot replace a VPC retained by a filesystem consumer.');
    }
    await this.verifyVpcResources(desired, token);
    return {
      managed: true,
      desired,
      apiValue: {
        networkInterfaces: [{ network: desired.network, subnetwork: desired.subnetwork }],
        egress: desired.egress,
      },
    };
  }

  private async verifyVpcResources(
    desired: NonNullable<ResolvedCloudRunVpcAccess['desired']>,
    token: string
  ): Promise<void> {
    const networkName = desired.network.split('/').at(-1)!;
    const subnetworkName = desired.subnetwork.split('/').at(-1)!;
    const base = `https://compute.googleapis.com/compute/v1/projects/${this.credentials!.projectId}`;
    const [networkResponse, subnetworkResponse] = await Promise.all([
      fetch(`${base}/global/networks/${encodeURIComponent(networkName)}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch(`${base}/regions/${encodeURIComponent(this.credentials!.region)}/subnetworks/${encodeURIComponent(subnetworkName)}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    for (const [label, response] of [
      [`VPC network ${desired.network}`, networkResponse],
      [`subnetwork ${desired.subnetwork}`, subnetworkResponse],
    ] as const) {
      if (response.ok) continue;
      const detail = (await response.text()).slice(0, 500);
      if (response.status === 404) {
        throw new Error(`${label} does not exist or is not visible. Hypervibe will not create networking implicitly.`);
      }
      throw new Error(`Google Compute API could not verify ${label}: ${response.status}${detail ? ` ${detail}` : ''}`);
    }
    const subnet = await subnetworkResponse.json() as { network?: string };
    if (!subnet.network || this.normalizeCloudRunNetwork(subnet.network) !== desired.network) {
      throw new Error(`Subnetwork ${desired.subnetwork} is not attached to exact VPC ${desired.network}.`);
    }
  }

  private assertVpcAccess(
    resource: CloudRunService | CloudRunJob | null,
    expected: ResolvedCloudRunVpcAccess,
    description: string
  ): void {
    const nestedJobTemplate = (resource as CloudRunJob | null)?.template?.template;
    const actual = nestedJobTemplate
      ? this.normalizedVpcAccess(nestedJobTemplate.vpcAccess)
      : this.normalizedVpcAccess(this.serviceVpcAccess(resource as CloudRunService | null));
    if (JSON.stringify(actual) !== JSON.stringify(expected.desired)) {
      throw new Error(`${description} became ready without the reviewed Direct VPC egress configuration.`);
    }
  }

  private cloudRunJobSpec(params: {
    imageUri: string;
    command: string;
    env: Array<Record<string, unknown>>;
    resources?: Record<string, unknown>;
    serviceAccount?: string;
    labels?: Record<string, string>;
    existingVolumes?: Array<Record<string, unknown>>;
    existingVolumeMounts?: Array<Record<string, unknown>>;
    cloudSqlConnectionNames?: string[];
    replaceManagedDatabaseVars?: boolean;
    vpcAccess?: CloudRunVpcAccess;
  }): Record<string, unknown> {
    const cloudSql = this.cloudSqlVolumeConfig(params.cloudSqlConnectionNames);
    const volumeMounts = cloudSql
      ? this.mergeVolumeMounts(params.existingVolumeMounts, [cloudSql.volumeMount])
      : params.replaceManagedDatabaseVars
        ? this.removeCloudSqlVolumeMounts(params.existingVolumeMounts)
        : params.existingVolumeMounts;
    const resources = params.resources
      ? Object.fromEntries(Object.entries(params.resources).filter(([key]) => key !== 'cpuIdle'))
      : undefined;
    const container = {
      image: params.imageUri,
      command: ['/bin/sh'],
      args: ['-lc', params.command],
      env: params.env,
      ...(resources && Object.keys(resources).length > 0 ? { resources } : {}),
      ...(volumeMounts && volumeMounts.length > 0 ? { volumeMounts } : {}),
    };
    const volumes = cloudSql
      ? this.mergeVolumes(params.existingVolumes, [cloudSql.volume])
      : params.replaceManagedDatabaseVars
        ? this.removeCloudSqlVolumes(params.existingVolumes)
        : params.existingVolumes;

    return {
      ...(params.labels ? { labels: params.labels } : {}),
      template: {
        ...(params.labels ? { labels: params.labels } : {}),
        template: {
          containers: [container],
          ...(volumes && (volumes.length > 0 || params.replaceManagedDatabaseVars) ? { volumes } : {}),
          ...(params.serviceAccount ? { serviceAccount: params.serviceAccount } : {}),
          ...(params.vpcAccess !== undefined ? { vpcAccess: params.vpcAccess } : {}),
          maxRetries: 1,
          timeout: '3600s',
        },
      },
    };
  }

  private async upsertCloudRunJob(params: {
    token: string;
    jobName: string;
    jobSpec: Record<string, unknown>;
    description: string;
    bindingAuthority?: 'bound' | 'unbound';
    onCreateAttempt?: () => void;
    onCreateAccepted?: (identity: { name: string; uid?: string }) => void;
    expectedUid?: string;
  }): Promise<{ created: boolean; job: CloudRunJob }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId, region } = this.credentials;
    const headers = {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    };
    const jobsBaseUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs`;
    const existingJob = await fetch(`${jobsBaseUrl}/${params.jobName}`, {
      headers: { Authorization: `Bearer ${params.token}` },
    });
    const creatingJob = existingJob.status === 404;
    if (!existingJob.ok && !creatingJob) {
      const text = (await existingJob.text()).slice(0, 500);
      throw new Error(`Cloud Run job observation failed: ${existingJob.status}${text ? ` ${text}` : ''}`);
    }
    const liveJob = creatingJob ? null : await existingJob.json() as CloudRunJob;
    if (params.bindingAuthority === 'unbound' && liveJob) {
      throw new CloudRunReleaseJobAdoptionRequiredError(
        `An unbound same-name Cloud Run release job ${params.jobName} already exists; explicit adoption is required before Hypervibe can mutate it.`
      );
    }
    const expectedJobName = `projects/${projectId}/locations/${region}/jobs/${params.jobName}`;
    if (params.bindingAuthority && liveJob && liveJob.name !== expectedJobName) {
      throw new Error(`Cloud Run ${params.description} lookup returned a different resource identity.`);
    }
    if (params.expectedUid && (!liveJob || liveJob.uid !== params.expectedUid || !liveJob.etag)) {
      throw new Error('The bound scheduled workload identity or update precondition changed.');
    }
    const runtimeServiceAccountEmail = liveJob
      ? liveJob.template?.template?.serviceAccount ?? liveJob.template?.template?.serviceAccountName
      : this.requiredRuntimeServiceAccountEmail(params.description);
    if (!runtimeServiceAccountEmail) {
      throw new Error(
        `Cloud Run job ${params.jobName} did not expose its runtime service account; refusing to change its identity.`
      );
    }
    const candidateTask = (params.jobSpec.template as { template?: Record<string, unknown> } | undefined)?.template;
    if (!candidateTask) {
      throw new Error(`Cloud Run ${params.description} candidate did not include a task template.`);
    }
    candidateTask.serviceAccount = runtimeServiceAccountEmail;
    delete candidateTask.serviceAccountName;
    if (params.expectedUid) params.jobSpec.etag = liveJob!.etag;
    if (creatingJob) params.onCreateAttempt?.();
    const upsertResponse = !creatingJob
      ? await fetch(`${jobsBaseUrl}/${params.jobName}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(cloudRunJobUpdateBody(liveJob, params.jobSpec)),
        })
      : await fetch(`${jobsBaseUrl}?jobId=${encodeURIComponent(params.jobName)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(params.jobSpec),
        });

    if (!upsertResponse.ok) {
      const text = await upsertResponse.text();
      throw new Error(`Cloud Run Jobs API error: ${upsertResponse.status} ${text}`);
    }

    const operation = await upsertResponse.json() as CloudRunOperation;
    if (creatingJob && operation.response?.name === expectedJobName) {
      params.onCreateAccepted?.({ name: expectedJobName });
    }
    await this.waitForCloudRunOperation(
      params.token,
      operation,
      `${params.description} ${creatingJob ? 'create' : 'update'}`,
      `projects/${projectId}/locations/${region}/jobs/${params.jobName}`
    );
    const job = await this.waitForCloudRunJobReady(params.jobName, params.token);
    const jobResourceName = `projects/${projectId}/locations/${region}/jobs/${params.jobName}`;
    if (job.name !== jobResourceName) {
      throw new Error(`Cloud Run ${params.description} became ready with a different resource identity.`);
    }
    if (params.expectedUid && job.uid !== params.expectedUid) {
      throw new Error(`Cloud Run ${params.description} became ready with a different resource UID.`);
    }
    const readyRuntimeServiceAccountEmail = job.template?.template?.serviceAccount
      ?? job.template?.template?.serviceAccountName;
    if (readyRuntimeServiceAccountEmail !== runtimeServiceAccountEmail) {
      throw new Error(`Cloud Run ${params.description} became ready without the expected runtime service account.`);
    }

    return { created: creatingJob, job };
  }

  private async getCloudSchedulerJob(
    schedulerJobName: string,
    token: string
  ): Promise<CloudSchedulerJob | null> {
    if (!this.credentials) {
      return null;
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://cloudscheduler.googleapis.com/v1/projects/${projectId}/locations/${region}/jobs/${schedulerJobName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Scheduler API error: ${response.status}${text ? ` ${text}` : ''}`);
    }

    return await response.json() as CloudSchedulerJob;
  }

  private cloudBuildStatusFromResponse(response: CloudBuildStatus | CloudBuildOperation): CloudBuildStatus | undefined {
    if ('status' in response || 'id' in response) {
      return response as CloudBuildStatus;
    }
    if (!this.isCloudBuildOperation(response)) {
      return undefined;
    }
    return response.response ?? response.metadata?.build;
  }

  private cloudBuildIdFromOperation(response: CloudBuildStatus | CloudBuildOperation): string | undefined {
    if (!this.isCloudBuildOperation(response)) {
      return undefined;
    }
    return response.metadata?.build?.id ?? response.metadata?.buildId ?? response.response?.id;
  }

  private isCloudBuildOperation(response: CloudBuildStatus | CloudBuildOperation): response is CloudBuildOperation {
    return 'done' in response || 'metadata' in response || 'response' in response || 'error' in response;
  }

  private async getCloudRunService(serviceName: string, token: string): Promise<CloudRunService | null> {
    if (!this.credentials) {
      return null;
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run service observation failed: ${response.status}${text ? ` ${text}` : ''}`);
    }

    return await response.json() as CloudRunService;
  }

  private cloudRunServiceReadiness(service: CloudRunService | null): { ready: boolean; error?: string } {
    if (!service) {
      return { ready: false };
    }

    const condition = service.terminalCondition ?? service.conditions?.find((entry) => entry.type === 'Ready');
    const state = condition?.state ?? condition?.status;
    const succeeded = state === 'CONDITION_SUCCEEDED' || state === 'True';
    const failed = state === 'CONDITION_FAILED' || state === 'False';
    const generationsMatch = !service.generation || !service.observedGeneration || String(service.generation) === String(service.observedGeneration);

    if (succeeded && generationsMatch && service.reconciling !== true) {
      return { ready: true };
    }

    if (failed && service.reconciling !== true) {
      const reason = condition?.reason ? `${condition.reason}: ` : '';
      return { ready: false, error: `${reason}${condition?.message ?? 'Ready condition failed'}` };
    }

    if (!condition && service.uri) {
      return { ready: true };
    }

    return { ready: false };
  }

  private async waitForCloudRunOperation(
    token: string,
    operation: CloudRunOperation,
    description: string,
    expectedResponseName?: string
  ): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const operationPrefix = `projects/${this.credentials.projectId}/locations/${this.credentials.region}/operations/`;
    if (!operation.name || !operation.name.startsWith(operationPrefix) || operation.name.length <= operationPrefix.length) {
      throw new Error(`Cloud Run ${description} response did not include a trackable operation identity.`);
    }
    const operationName = operation.name;

    let current = operation;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (current.name !== operationName) {
        throw new Error(`Cloud Run ${description} operation status returned a different operation identity.`);
      }
      if (current.done) {
        if (current.error) {
          throw new Error(
            `Cloud Run ${description} operation failed: ${current.error.status ?? current.error.code ?? 'unknown'} ${current.error.message ?? ''}`.trim()
          );
        }
        if (expectedResponseName && !current.response?.name) {
          throw new Error(`Cloud Run ${description} operation completed without a resource identity.`);
        }
        if (expectedResponseName && current.response?.name !== expectedResponseName) {
          throw new Error(`Cloud Run ${description} operation returned a different resource identity.`);
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      const response = await fetch(`https://run.googleapis.com/v2/${operationName}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Run ${description} operation status check failed: ${response.status} ${text}`);
      }
      current = await response.json() as CloudRunOperation;
    }

    throw new Error(`Cloud Run ${description} operation did not finish before timeout`);
  }

  private async waitForCloudRunJobReady(jobName: string, token: string): Promise<CloudRunJob> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const job = await this.getCloudRunJob(jobName, token);
      const readiness = this.cloudRunJobReadiness(job);
      if (readiness.ready) {
        return job!;
      }
      if (readiness.error) {
        throw new Error(`Cloud Run job ${jobName} is not ready: ${readiness.error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Cloud Run job ${jobName} was not ready before timeout`);
  }

  private async getCloudRunJob(
    jobName: string,
    token: string
  ): Promise<CloudRunJob | null> {
    if (!this.credentials) {
      return null;
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run Jobs API error: ${response.status}${text ? ` ${text}` : ''}`);
    }

    return await response.json() as CloudRunJob;
  }

  private cloudRunJobReadiness(job: CloudRunJob | null): { ready: boolean; error?: string } {
    if (!job) {
      return { ready: false };
    }

    const condition = job.terminalCondition ?? job.conditions?.find((entry) => entry.type === 'Ready');
    const state = condition?.state ?? condition?.status;
    const succeeded = state === 'CONDITION_SUCCEEDED' || state === 'True';
    const failed = state === 'CONDITION_FAILED' || state === 'False';
    const generationsMatch = !job.generation || !job.observedGeneration || job.generation === job.observedGeneration;

    if (succeeded && generationsMatch && job.reconciling !== true) {
      return { ready: true };
    }

    if (failed && job.reconciling !== true) {
      const reason = condition?.reason ? `${condition.reason}: ` : '';
      return { ready: false, error: `${reason}${condition?.message ?? 'Ready condition failed'}` };
    }

    return { ready: false };
  }

  private cloudSqlConnectionNamesFromEnvVars(env: Array<Record<string, unknown>> | undefined): string[] {
    const byName = new Map<string, string>();
    for (const entry of env ?? []) {
      if (typeof entry.name === 'string' && typeof entry.value === 'string') {
        byName.set(entry.name, entry.value);
      }
    }
    return this.parseCloudSqlConnectionNames(byName.get('CLOUD_SQL_CONNECTION_NAME') ?? byName.get('INSTANCE_CONNECTION_NAME'));
  }

  private parseCloudSqlConnectionNames(raw: string | undefined): string[] {
    if (!raw) return [];
    return Array.from(new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => /^[^:]+:[^:]+:[^:]+$/.test(entry))
    ));
  }

  private cloudSqlVolumeConfig(connectionNames: string[] | undefined): { volume: Record<string, unknown>; volumeMount: Record<string, unknown> } | undefined {
    if (!connectionNames || connectionNames.length === 0) {
      return undefined;
    }
    return {
      volume: {
        name: 'cloudsql',
        cloudSqlInstance: {
          instances: connectionNames,
        },
      },
      volumeMount: {
        name: 'cloudsql',
        mountPath: '/cloudsql',
      },
    };
  }

  private mergeVolumes(
    existing: Array<Record<string, unknown>> | undefined,
    updates: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    const byName = new Map<string, Record<string, unknown>>();
    for (const entry of existing ?? []) {
      if (typeof entry.name === 'string') {
        byName.set(entry.name, { ...entry });
      }
    }
    for (const entry of updates) {
      if (typeof entry.name === 'string') {
        byName.set(entry.name, { ...entry });
      }
    }
    return [...byName.values()];
  }

  private mergeVolumeMounts(
    existing: Array<Record<string, unknown>> | undefined,
    updates: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    const byName = new Map<string, Record<string, unknown>>();
    for (const entry of existing ?? []) {
      if (typeof entry.name === 'string') {
        byName.set(entry.name, { ...entry });
      }
    }
    for (const entry of updates) {
      if (typeof entry.name === 'string') {
        byName.set(entry.name, { ...entry });
      }
    }
    return [...byName.values()];
  }

  private removeCloudSqlVolumeMounts(
    existing: Array<Record<string, unknown>> | undefined
  ): Array<Record<string, unknown>> {
    return (existing ?? []).filter((entry) => entry.name !== 'cloudsql');
  }

  private removeCloudSqlVolumes(
    existing: Array<Record<string, unknown>> | undefined
  ): Array<Record<string, unknown>> {
    return (existing ?? []).filter((entry) => entry.name !== 'cloudsql');
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error
      ? (error as Error & { cause?: unknown }).cause
      : undefined;
    if (!cause || typeof cause !== 'object') {
      return message;
    }

    const causeRecord = cause as Record<string, unknown>;
    const fields = ['code', 'errno', 'syscall', 'hostname', 'host', 'address', 'port']
      .map((field) => {
        const value = causeRecord[field];
        return typeof value === 'string' || typeof value === 'number' ? `${field}=${value}` : undefined;
      })
      .filter((value): value is string => Boolean(value));
    const causeMessage = cause instanceof Error && cause.message !== message ? cause.message : undefined;
    const details = [causeMessage, ...fields].filter((value): value is string => Boolean(value));
    return details.length > 0 ? `${message} (${details.join(', ')})` : message;
  }

  private sanitizeName(name: string): string {
    // Cloud Run service names must be lowercase, alphanumeric with hyphens
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
  }

  private labelValue(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
    return normalized || 'unknown';
  }

  /** Only selected, reviewed credential updates remain outside the infrastructure engine. */
  async setEnvVars(environment: Environment, service: Service, vars: Record<string, string>, options: DeploymentMutationOptions = {}): Promise<Receipt> {
    if (options.requireCredentialUpdate) return this.setCredentialEnvVars(environment, service, vars);
    return { success: false, message: 'Only reviewed credential updates are available for existing workloads. Resource configuration is moving to OpenTofu.' };
  }

  private async setCredentialEnvVars(environment: Environment, service: Service, vars: Record<string, string>): Promise<Receipt> {
    let attempted = false;
    try {
      if (!this.credentials) throw new Error();
      const binding = parseHostingBindings(environment);
      const target = binding.services?.[service.name];
      const job = serviceWorkloadKind(service) === 'cron';
      const id = job ? target?.jobName : target?.serviceId;
      if (binding.provider !== this.name || binding.projectId !== this.credentials.projectId || binding.environmentId !== this.credentials.region || !id || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error();
      const token = await this.getAccessToken();
      const resource = `projects/${this.credentials.projectId}/locations/${this.credentials.region}/${job ? 'jobs' : 'services'}/${id}`;
      const current: any = job ? await this.getCloudRunJob(id, token) : await this.getCloudRunService(id, token);
      const template = job ? current?.template?.template : current?.template;
      if (current?.name !== resource || !current.uid || !current.etag || (target?.resourceUid && current.uid !== target.resourceUid)
        || !Array.isArray(template?.containers) || !template.containers.length || !template.containers[0].image) throw new Error();
      const original = template.containers[0];
      const keys = new Set(Object.keys(vars));
      const oldEnv = original.env ?? [];
      if (!Array.isArray(oldEnv) || oldEnv.some((entry: any) => typeof entry.name !== 'string') || new Set(oldEnv.map((entry: any) => entry.name)).size !== oldEnv.length) throw new Error();
      const remaining = new Map(Object.entries(vars));
      const env = oldEnv.map((entry: any) => {
        if (!keys.has(entry.name)) return entry;
        remaining.delete(entry.name);
        return { name: entry.name, value: vars[entry.name] };
      }).concat([...remaining].map(([name, value]) => ({ name, value })));
      const containers = [{ ...original, env }, ...template.containers.slice(1)];
      // Jobs have no updateMask in their public REST contract, so preserve the
      // complete writable job and execution template. Services have a field mask.
      const body = job ? { ...Object.fromEntries(['name', 'etag', 'labels', 'annotations', 'launchStage', 'binaryAuthorization'].filter(key => current[key] !== undefined).map(key => [key, current[key]])),
        template: { ...current.template, template: { ...template, containers } } }
        : { name: resource, etag: current.etag, template: { containers } };
      attempted = true;
      const response = await fetch(`https://run.googleapis.com/v2/${resource}${job ? '' : '?updateMask=template.containers'}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error();
      await this.waitForCloudRunOperation(token, await response.json() as CloudRunOperation, 'credential update', resource);
      const after: any = job ? await this.waitForCloudRunJobReady(id, token) : await this.waitForCloudRunServiceReady(id, token);
      const afterTemplate = job ? after?.template?.template : after?.template;
      if (after?.name !== resource || after.uid !== current.uid || this.unappliedRuntimeEnvKeys(afterTemplate?.containers?.[0], vars).length) throw new Error();
      const preserves = (expected: any, actual: any): boolean => Array.isArray(expected)
        ? expected.length === 0 && actual === undefined || Array.isArray(actual) && expected.length === actual.length
          && expected.every((entry, index) => preserves(entry, entry?.name ? actual.find((candidate: any) => candidate.name === entry.name) : actual[index]))
        : expected && typeof expected === 'object'
          ? Boolean(actual) && Object.entries(expected).every(([key, value]) => preserves(value, actual[key]))
          : expected === actual || actual === undefined && [false, 0, ''].includes(expected);
      if (!preserves({ ...template, containers }, afterTemplate)) throw new Error();
      const beforeDeployment = job ? undefined : this.observedServiceDeployment(current).deployment?.id;
      const afterDeployment = job ? undefined : this.observedServiceDeployment(after).deployment?.id;
      return { success: true, message: 'Selected Cloud Run credential configuration verified; runtime and application use require separate evidence.', data: {
        credentialValueEvidence: 'readback', credentialUpdateActivation: job ? 'deferred' : 'provider-rollout',
        serviceId: id, resourceUid: current.uid, configurationUpdated: true, runtimeRolloutRequired: true,
        ...(beforeDeployment ? { rolloutBaseline: { state: 'present', deploymentId: beforeDeployment } } : { rolloutBaseline: { state: 'unknown' } }),
        ...(afterDeployment ? { deploymentId: afterDeployment } : {}), mutationAttempted: true,
      } };
    } catch { return { success: false, message: attempted ? 'Cloud Run credential write requires readback recovery.' : 'Exact Cloud Run credential target could not be verified; no write attempted.', data: { mutationAttempted: attempted } }; }
  }

  private unappliedRuntimeEnvKeys(container: CloudRunContainer | undefined, vars: Record<string, string>): string[] {
    const observed = new Map(
      (container?.env ?? [])
        .filter((entry): entry is { name: string; value?: string } => typeof entry.name === 'string')
        .map((entry) => [entry.name, entry.value])
    );
    return Object.entries(vars).filter(([key, value]) => observed.get(key) !== value).map(([key]) => key);
  }

  private async waitForCloudRunServiceReady(
    serviceName: string,
    token: string
  ): Promise<CloudRunService | null> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const resourceName = `projects/${this.credentials.projectId}/locations/${this.credentials.region}/services/${serviceName}`;
    for (let attempt = 0; attempt < 120; attempt++) {
      const service = await this.getCloudRunService(serviceName, token);
      const readiness = this.cloudRunServiceReadiness(service);
      if (readiness.ready) {
        if (service?.name !== resourceName) {
          throw new Error(
            `Cloud Run service ${serviceName} became ready with a different resource identity: ${service?.name ?? 'missing'}.`
          );
        }
        return service;
      }
      if (readiness.error) {
        throw new Error(`Cloud Run service ${serviceName} is not ready: ${readiness.error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Cloud Run service ${serviceName} was not ready before timeout`);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'cloudrun',
    displayName: 'GCP Cloud Run',
    category: 'deployment',
    credentialsSchema: CloudRunCredentialsSchema,
    setupHelpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    credentials: {
      agentManagedKeys: ['runtimeServiceAccountEmail'],
    },
    maturity: {
      lifecycle: {
        hosting: {
          status: 'planned',
          reason: 'Infrastructure is moving to OpenTofu. Authentication and operational tools remain available.',
        },
      },
    },
    orchestration: {
      diff: {
        workloadKindObservation: 'exact',
      },
      logs: {
        runtime: true,
        deployments: true,
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new CloudRunAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['environment', 'artifact'],
    defaultResource: 'environment',
    selectors: {
      environment: { mode: 'environment-forensics', required: ['project', 'env'], optional: ['scope', 'region', 'limit'], list: true },
      artifact: {
        mode: 'provider-resource',
        optional: ['project', 'scope', 'id', 'name', 'region', 'limit'],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['projectId', 'location'],
        collectionKey: 'artifacts',
      },
    },
    inspect: (adapter, request) => request.resource === 'artifact'
      ? (adapter as CloudRunAdapter).inspectArtifactResources(request)
      : (adapter as CloudRunAdapter).inspectEnvironmentResources(request),
  },
});

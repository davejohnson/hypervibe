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
import { fetchWithRetry } from '../../../utils/fetch-retry.js';
import {
  CLOUD_RUN_RELEASE_COMMAND_HASH_ANNOTATION,
  cloudRunMigrationJobName,
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

export interface CloudBuildResult {
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
    supportsOneOffTasks: false,
    supportsDeferredDeploy: false,
    credentialUpdateActivation: 'provider-rollout',
    credentialValueEvidence: 'readback',
    supportsDeferredCronActivation: false,
    supportsMaintenance: false,
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

  /**
   * OpenTofu engine integration only: the connection's deployment credential
   * for the engine process environment. Callers must redact it from every output.
   */
  engineConnection(): { projectId: string; credentials: string; runtimeServiceAccountEmail?: string } {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const { projectId, credentials, runtimeServiceAccountEmail } = this.credentials;
    return { projectId, credentials, ...(runtimeServiceAccountEmail ? { runtimeServiceAccountEmail } : {}) };
  }

  /** OpenTofu engine integration only: short-lived token for retained operational calls. */
  async engineAccessToken(): Promise<string> {
    return this.getAccessToken();
  }

  /**
   * OpenTofu engine integration only: a short-lived token limited to Google
   * Site Verification, used to prove domain ownership as the deployment identity.
   */
  async siteVerificationAccessToken(): Promise<string> {
    if (!this.serviceAccountCreds) throw new Error('No service account credentials');
    const now = Math.floor(Date.now() / 1000);
    const jwt = await this.createJwt({ alg: 'RS256', typ: 'JWT' }, {
      iss: this.serviceAccountCreds.client_email,
      sub: this.serviceAccountCreds.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 600,
      scope: 'https://www.googleapis.com/auth/siteverification',
    }, this.serviceAccountCreds.private_key);
    const response = await fetchWithRetry('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    }, 4, true);
    if (!response.ok) throw new Error(`Site Verification token exchange failed: HTTP ${response.status}`);
    return ((await response.json()) as { access_token: string }).access_token;
  }

  /** The deployment identity's email, which becomes the verified domain owner. */
  engineDeploymentIdentity(): string {
    if (!this.serviceAccountCreds) throw new Error('No service account credentials');
    return this.serviceAccountCreds.client_email;
  }

  /**
   * Builds from an archive of the user's local repository (an exact commit),
   * so private repositories need no git credentials. The archive is uploaded
   * to the project's private build-source bucket prepared during GCP setup.
   */
  async buildReleaseImageFromArchive(
    service: Service,
    environment: Environment,
    source: { archive: Buffer; commitSha: string; bucket: string }
  ): Promise<CloudBuildResult> {
    if (!this.credentials) return { success: false, error: 'Not connected. Call connect() first.' };
    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;
      const repository = 'hypervibe';
      await this.verifyArtifactRepository(repository, token);
      const object = `source/${environment.name}/${service.name}/${source.commitSha}-${Date.now()}.tar.gz`;
      const upload = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(source.bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip' },
        body: new Uint8Array(source.archive),
      });
      if (upload.status === 403 || upload.status === 404) {
        return { success: false, error: 'The private build-source bucket is not ready. Re-run GCP setup (hv_connections action="prepare" for cloudrun), then retry.' };
      }
      if (!upload.ok) return { success: false, error: `Uploading the source archive failed (HTTP ${upload.status}).` };
      const imageName = this.sanitizeName(`${environment.name}-${service.name}`);
      const imageUri = `${region}-docker.pkg.dev/${projectId}/${repository}/${imageName}:${source.commitSha.slice(0, 12)}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
      const build = await this.submitCloudBuild({
        token, service, sourceRepoUrl: '', revision: source.commitSha, imageUri,
        storageSource: { bucket: source.bucket, object },
      });
      return { success: true, imageUri: build.imageUri, buildId: build.id, logsUrl: build.logsUrl, resolvedCommitSha: source.commitSha };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
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
              `Review and apply the GCP setup plan to grant roles/run.admin deployment access for serviceAccount:${this.serviceAccountCreds.client_email} on project ${projectId}.`,
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
    return {
      success: false,
      message: 'Cloud Logging access changes require an infrastructure plan.',
      error: 'Review and apply the GCP setup plan with hv_connections action="prepare". Logging diagnostics do not change project IAM or enable APIs.',
      data: { applied: 0, skipped: 1, mutationAttempted: false, code: 'ENGINE_PLAN_REQUIRED' },
    };
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
    _environment: Environment,
    _service: Service,
    _command: string,
    options?: EnvironmentTaskOptions
  ): Promise<JobResult> {
    if (options?.managedRecoveryTask) return {
      jobId: '', status: 'failed', receipt: { success: false,
        message: 'The Cloud Run adapter does not implement managed recovery tasks.',
        data: { applied: 0, skipped: 1, mutationAttempted: false } },
    };
    return {
      jobId: '', status: 'failed', receipt: {
        success: false,
        message: 'Arbitrary Cloud Run environment tasks are not supported by the infrastructure engine.',
        error: 'For deployment migrations, declare releaseCommand in hv_spec, review hv_plan, and approve hv_apply. Hypervibe executes that command using the job created by the approved infrastructure plan.',
        data: { applied: 0, skipped: 1, mutationAttempted: false, code: 'ENGINE_TASK_UNSUPPORTED' },
      },
    };
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
    _environment: Environment,
    _expected: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    return this.maintenanceEnginePlanRequired();
  }

  async resumeMaintenanceWorkload(
    _environment: Environment,
    _snapshot: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    return this.maintenanceEnginePlanRequired();
  }

  private maintenanceEnginePlanRequired(): Receipt {
    return {
      success: false,
      message: 'Cloud Run maintenance mutations are unavailable in the infrastructure engine.',
      error: 'Service scaling and schedule changes require a reviewed infrastructure plan. Hypervibe cannot perform this maintenance operation until engine support is available; read-only workload status remains available.',
      data: { applied: 0, skipped: 1, mutationAttempted: false, code: 'ENGINE_MAINTENANCE_UNSUPPORTED' },
    };
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
      `Review and apply the GCP setup plan with hv_connections action="prepare" for ${member} on project ${projectId}.`,
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
    const repository = await response.json() as ArtifactRepository | null;
    if (repository?.name !== name) {
      throw new Error(`Artifact Registry returned a different repository identity; expected ${name}.`);
    }
    return repository;
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

      await this.verifyArtifactRepository(repository, token);
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

  /** Releases may use an existing repository, but never create infrastructure. */
  private async verifyArtifactRepository(repository: string, token: string): Promise<void> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const { projectId, region } = this.credentials;
    const repositoryName = `projects/${projectId}/locations/${region}/repositories/${repository}`;
    const existing = await this.getArtifactRepository(repositoryName, token);
    if (!existing) {
      throw new Error(`Artifact Registry repository ${repositoryName} is not ready. Review and apply the project infrastructure setup plan, then retry the release.`);
    }
    this.assertArtifactRepository(existing, repositoryName);
  }

  private async submitCloudBuild(params: {
    token: string;
    service: Service;
    sourceRepoUrl: string;
    revision: string;
    imageUri: string;
    /** Build from an uploaded archive instead of cloning a git URL. */
    storageSource?: { bucket: string; object: string };
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
    const submit = (buildIdentity?: string) => fetch(`https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: params.storageSource
          ? { storageSource: params.storageSource }
          : {
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
        // A user-specified build identity requires an explicit logging mode.
        ...(buildIdentity
          ? { serviceAccount: `projects/${projectId}/serviceAccounts/${buildIdentity}`, options: { logging: 'CLOUD_LOGGING_ONLY' } }
          : {}),
      }),
    });

    let response = await submit();
    if (response.status === 403) {
      const text = await response.text();
      const deployIdentity = this.serviceAccountCreds?.client_email;
      // Newer projects build as the Compute Engine default account (Editor).
      // Never act as it; build as the deployment identity instead.
      if (!/act as service account/i.test(text) || !deployIdentity) {
        throw new Error(`Cloud Build submission failed: ${response.status} ${text}`);
      }
      response = await submit(deployIdentity);
      if (response.status === 403) {
        throw new Error('Cloud Build cannot run as the Hypervibe deployment identity yet. Re-run GCP setup (hv_connections action="prepare" for cloudrun) to grant the build permissions, then retry.');
      }
    }
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
      // Generated Dockerfiles mount the optional package token as a build secret.
      'export DOCKER_BUILDKIT=1',
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
    const response = await fetchWithRetry('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    }, 4, true);

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

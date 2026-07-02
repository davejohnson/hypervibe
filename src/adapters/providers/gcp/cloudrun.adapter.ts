import { z } from 'zod';
import type {
  IProviderAdapter,
  Receipt,
  ComponentResult,
  DeployResult,
  JobResult,
  ProviderCapabilities,
} from '../../../domain/ports/provider.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import { serviceWorkloadKind, type Service } from '../../../domain/entities/service.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { parseHostingBindings, type GetLogsOptions, type LogEntry } from '../../../domain/ports/hosting.port.js';
import { hashEnvValue, type ObservedService, type ObservedState } from '../../../domain/ports/observe.port.js';

// Credentials schema for self-registration
export const CloudRunCredentialsSchema = z.object({
  projectId: z.string().min(1, 'GCP Project ID is required'),
  credentials: z.string().min(1, 'Service account JSON is required'),
  region: z.string().default('us-central1'),
});

export type CloudRunCredentials = z.infer<typeof CloudRunCredentialsSchema>;

const MANAGED_DATABASE_ENV_KEYS = new Set([
  'DATABASE_URL',
  'DIRECT_URL',
  'DATABASE_POOLER_URL',
  'DATABASE_SSL',
  'CLOUD_SQL_CONNECTION_NAME',
  'INSTANCE_CONNECTION_NAME',
  'DATABASE_HOST',
  'DB_HOST',
  'PGHOST',
  'DATABASE_PORT',
  'DB_PORT',
  'PGPORT',
  'DATABASE_USER',
  'DB_USER',
  'PGUSER',
  'DATABASE_PASSWORD',
  'DB_PASSWORD',
  'PGPASSWORD',
  'DATABASE_NAME',
  'DB_NAME',
  'PGDATABASE',
]);

const MANAGED_DATABASE_SYNC_KEYS = new Set([
  'DATABASE_URL',
  'DIRECT_URL',
  'DATABASE_POOLER_URL',
  'DATABASE_HOST',
  'DB_HOST',
  'PGHOST',
  'CLOUD_SQL_CONNECTION_NAME',
  'INSTANCE_CONNECTION_NAME',
]);

interface CloudRunService {
  name: string;
  uid: string;
  generation: number | string;
  observedGeneration?: number | string;
  reconciling?: boolean;
  labels?: Record<string, string>;
  uri?: string;
  template?: {
    containers?: CloudRunContainer[];
    volumes?: Array<Record<string, unknown>>;
    serviceAccount?: string;
    serviceAccountName?: string;
  };
  spec?: {
    template?: {
      spec?: {
        containers?: CloudRunContainer[];
        volumes?: Array<Record<string, unknown>>;
        serviceAccountName?: string;
      };
    };
  };
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
}

interface CloudRunJob {
  name?: string;
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
    };
  };
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
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
  schedule?: string;
  timeZone?: string;
  state?: string;
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

export class CloudRunAdapter implements IProviderAdapter {
  readonly name = 'cloudrun';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [], // Cloud SQL is separate
    supportsAutoWiring: false, // Manual connection needed
    supportsHealthChecks: true,
    supportsCronSchedule: true, // Cloud Scheduler
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false, // Separate services per env
    managedTls: true,
    supportsObserve: true,
  };

  private credentials: CloudRunCredentials | null = null;
  private serviceAccountCreds: ServiceAccountCredentials | null = null;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as CloudRunCredentials;
    try {
      this.serviceAccountCreds = JSON.parse(this.credentials.credentials);
    } catch {
      throw new Error('Invalid service account JSON');
    }
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string; warning?: string }> {
    if (!this.credentials || !this.serviceAccountCreds) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const token = await this.getAccessToken();
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

  async ensureProject(projectName: string, environment: Environment): Promise<Receipt> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    // Cloud Run doesn't have "projects" in the deployment sense
    // The GCP project is the container
    const bindings = environment.platformBindings as {
      projectId?: string;
      provider?: string;
    };

    const projectId = bindings.projectId || `${projectName}-${environment.name}`;
    const data: Record<string, unknown> = {
      projectId,
      gcpProjectId: this.credentials.projectId,
      region: this.credentials.region,
      environmentId: this.credentials.region,
    };
    const loggingRepair = await this.repairLoggingAccess();
    data.loggingIamRepair = {
      success: loggingRepair.success,
      message: loggingRepair.message,
      ...(loggingRepair.data ? { data: loggingRepair.data } : {}),
    };
    if (!loggingRepair.success) {
      data.loggingIamRepairWarning = loggingRepair.error || loggingRepair.message;
    }

    return {
      success: true,
      message: `Using GCP project: ${this.credentials.projectId}`,
      data,
    };
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    // Cloud Run doesn't provision databases
    // Users should use Cloud SQL separately
    const emptyComponent: Component = {
      id: '',
      environmentId: environment.id,
      type,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return {
      component: emptyComponent,
      receipt: {
        success: false,
        message: `Cloud Run does not provision databases. Use the Cloud SQL adapter separately, then pass DATABASE_URL as an env var.`,
      },
    };
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>
  ): Promise<DeployResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const explicitImageUri = this.imageUriForService(service, envVars);
    const buildResult = explicitImageUri
      ? undefined
      : await this.buildImageForService(service, environment, envVars);
    const imageUri = explicitImageUri ?? buildResult?.imageUri;
    if (!imageUri) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Cloud Run could not build an image for service ${service.name}`,
          error: buildResult?.error ?? 'Project gitRemoteUrl is required so Cloud Build can build and publish the service image automatically.',
          data: {
            provider: this.name,
            phase: 'image_build',
            missing: buildResult?.error?.includes('gitRemoteUrl') ? ['HYPERVIBE_SOURCE_REPO_URL'] : undefined,
          },
        },
      };
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };

    const prefix = bindings.projectId || 'hypervibe';
    const isCron = serviceWorkloadKind(service) === 'cron';
    const serviceName = isCron
      ? bindings.services?.[service.name]?.jobName ?? this.sanitizeName(`${prefix}-${service.name}`)
      : bindings.services?.[service.name]?.serviceId ?? this.sanitizeName(`${prefix}-${service.name}`);

    if (serviceWorkloadKind(service) === 'cron') {
      return this.deployScheduledJob({
        service,
        environment,
        envVars,
        imageUri,
        buildResult,
        prefix,
        jobName: serviceName,
      });
    }

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;

      // Check if service exists
      let cloudRunService: CloudRunService | null = null;
      try {
        cloudRunService = await this.getService(serviceName);
      } catch {
        // Service doesn't exist
      }

      // Build environment variables config. Cloud Run env vars live on the
      // revision, so merge with the live container's env — a deploy that
      // doesn't re-pass every var (e.g. DATABASE_URL injected at database
      // provision time) must not silently wipe it. Passed vars always win.
      const runtimeVars = this.runtimeEnvVarsForService(service, envVars);
      const existingContainer = cloudRunService ? this.primaryContainer(cloudRunService) : undefined;
      const replaceManagedDatabaseVars = this.isManagedDatabaseEnvSync(runtimeVars);
      const env = this.mergeEnvVars(existingContainer?.env, runtimeVars, { replaceManagedDatabaseVars });
      const cloudSqlNames = replaceManagedDatabaseVars
        ? this.cloudSqlConnectionNamesFromEnv(runtimeVars)
        : Array.from(new Set([
            ...this.cloudSqlConnectionNamesFromEnv(runtimeVars),
            ...this.cloudSqlConnectionNamesFromEnvVars(existingContainer?.env),
          ]));
      const cloudSql = this.cloudSqlVolumeConfig(cloudSqlNames);
      const volumeMounts = cloudSql
        ? this.mergeVolumeMounts(existingContainer?.volumeMounts, [cloudSql.volumeMount])
        : replaceManagedDatabaseVars
          ? this.removeCloudSqlVolumeMounts(existingContainer?.volumeMounts)
          : existingContainer?.volumeMounts;
      const templateVolumes = cloudSql
        ? this.mergeVolumes(this.serviceVolumes(cloudRunService), [cloudSql.volume])
        : replaceManagedDatabaseVars
          ? this.removeCloudSqlVolumes(this.serviceVolumes(cloudRunService))
          : this.serviceVolumes(cloudRunService);

      // Build container spec
      const containerSpec = {
        image: imageUri,
        ports: [{ containerPort: parseInt(envVars['PORT'] || '8080', 10) }],
        env,
        ...(volumeMounts && volumeMounts.length > 0 ? { volumeMounts } : {}),
        resources: {
          limits: {
            cpu: envVars['CPU'] || '1',
            memory: envVars['MEMORY'] || '512Mi',
          },
        },
      };

      const labels = {
        'infraprint-environment': this.labelValue(environment.name),
        'infraprint-service': this.labelValue(service.name),
      };

      // Cloud Run Admin API v2 Service shape.
      const serviceSpec = {
        labels,
        ingress: 'INGRESS_TRAFFIC_ALL',
        template: {
          labels,
          containers: [containerSpec],
          ...(templateVolumes && (templateVolumes.length > 0 || replaceManagedDatabaseVars)
            ? { volumes: templateVolumes }
            : {}),
          ...(this.serviceAccountCreds?.client_email
            ? { serviceAccount: this.serviceAccountCreds.client_email }
            : {}),
        },
      };

      const baseUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services`;
      const creatingService = !cloudRunService;
      let serviceOperation: CloudRunOperation | undefined;

      if (cloudRunService) {
        // Update existing service
        const response = await fetch(`${baseUrl}/${serviceName}?updateMask=labels,ingress,template`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(serviceSpec),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Cloud Run API error: ${response.status} ${text}`);
        }

        serviceOperation = await response.json() as CloudRunOperation;
      } else {
        // Create new service
        const response = await fetch(`${baseUrl}?serviceId=${encodeURIComponent(serviceName)}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(serviceSpec),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Cloud Run API error: ${response.status} ${text}`);
        }

        serviceOperation = await response.json() as CloudRunOperation;
      }

      if (serviceOperation) {
        await this.waitForCloudRunOperation(token, serviceOperation, `service ${creatingService ? 'create' : 'update'}`);
      }

      const publicAccess = this.shouldAllowUnauthenticated(service);
      const publicInvokerBindingUpdated = publicAccess
        ? await this.ensurePublicInvoker(serviceName, token)
        : false;

      // Get service URL
      const serviceInfo = await this.waitForCloudRunServiceReady(serviceName, token);
      const url = serviceInfo?.uri;

      return {
        serviceId: service.id,
        externalId: serviceName,
        url,
        status: 'deployed',
        receipt: {
          success: true,
          message: `Deployed ${serviceName} to Cloud Run`,
          data: {
            serviceName,
            url,
            imageUri,
            createdService: creatingService,
            public: publicAccess,
            publicAccessConfigured: publicAccess,
            publicInvokerBindingUpdated,
            environmentId: region,
            ...(buildResult
              ? {
                  build: {
                    id: buildResult.buildId,
                    logsUrl: buildResult.logsUrl,
                  },
                }
              : {}),
          },
        },
      };
    } catch (error) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Deployment failed for ${service.name}`,
          error: this.formatError(error),
        },
      };
    }
  }

  private async deployScheduledJob(params: {
    service: Service;
    environment: Environment;
    envVars: Record<string, string>;
    imageUri: string;
    buildResult?: CloudBuildResult;
    prefix: string;
    jobName: string;
  }): Promise<DeployResult> {
    const { service, environment, envVars, imageUri, buildResult, jobName } = params;
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      if (!service.buildConfig.cronSchedule?.trim()) {
        return {
          serviceId: service.id,
          status: 'failed',
          receipt: {
            success: false,
            message: `Scheduled job ${service.name} is missing cronSchedule`,
            error: 'Cron workloads require buildConfig.cronSchedule.',
          },
        };
      }

      const token = await this.getAccessToken();
      const { region } = this.credentials;
      const runtimeVars = this.runtimeEnvVarsForService(service, envVars);
      // Merge with the live job container env so redeploys don't wipe vars
      // injected outside this call (e.g. DATABASE_URL at provision time).
      const currentJob = await this.getCloudRunJob(jobName, token);
      const currentJobContainer = currentJob ? this.primaryJobContainer(currentJob) : undefined;
      const replaceManagedDatabaseVars = this.isManagedDatabaseEnvSync(runtimeVars);
      const env = this.mergeEnvVars(currentJobContainer?.env, runtimeVars, { replaceManagedDatabaseVars });
      const labels = {
        'infraprint-environment': this.labelValue(environment.name),
        'infraprint-service': this.labelValue(service.name),
        'infraprint-resource': 'scheduled-job',
      };
      const command = service.buildConfig.startCommand?.trim() || 'npm start';
      const cloudSqlConnectionNames = replaceManagedDatabaseVars
        ? this.cloudSqlConnectionNamesFromEnv(runtimeVars)
        : Array.from(new Set([
            ...this.cloudSqlConnectionNamesFromEnv(runtimeVars),
            ...this.cloudSqlConnectionNamesFromEnvVars(currentJobContainer?.env),
          ]));
      const jobSpec = this.cloudRunJobSpec({
        imageUri,
        command,
        env,
        resources: {
          limits: {
            cpu: envVars['CPU'] || '1',
            memory: envVars['MEMORY'] || '512Mi',
          },
        },
        serviceAccount: this.serviceAccountCreds?.client_email,
        labels,
        existingVolumes: currentJob?.template?.template?.volumes,
        existingVolumeMounts: currentJobContainer?.volumeMounts,
        cloudSqlConnectionNames,
        replaceManagedDatabaseVars,
      });

      const { created: createdJob } = await this.upsertCloudRunJob({
        token,
        jobName,
        jobSpec,
        description: 'scheduled job',
      });

      const schedulerJobName = this.sanitizeName(`${jobName}-schedule`);
      const { created: createdScheduler } = await this.upsertCloudSchedulerJob({
        token,
        schedulerJobName,
        jobName,
        schedule: service.buildConfig.cronSchedule.trim(),
        timeZone: envVars['HYPERVIBE_CRON_TIME_ZONE']?.trim() || 'Etc/UTC',
      });

      const cleanupWarning = await this.deleteCloudRunServiceIfExists(jobName, token);

      return {
        serviceId: service.id,
        externalId: schedulerJobName,
        status: 'deployed',
        receipt: {
          success: true,
          message: `Deployed scheduled job ${jobName} to Cloud Run and Cloud Scheduler`,
          data: {
            resourceType: 'scheduledJob',
            jobName,
            schedulerJobName,
            schedule: service.buildConfig.cronSchedule.trim(),
            imageUri,
            environmentId: region,
            createdJob,
            createdScheduler,
            ...(cleanupWarning ? { cleanupWarning } : {}),
            ...(buildResult
              ? {
                  build: {
                    id: buildResult.buildId,
                    logsUrl: buildResult.logsUrl,
                  },
                }
              : {}),
          },
        },
      };
    } catch (error) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Scheduled job deployment failed for ${service.name}`,
          error: this.formatError(error),
        },
      };
    }
  }

  async deleteService(serviceId: string): Promise<{ success: boolean; error?: string; message?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const token = await this.getAccessToken();
      const schedulerJobName = serviceId.endsWith('-schedule') ? serviceId : `${serviceId}-schedule`;
      const jobName = serviceId.endsWith('-schedule') ? serviceId.replace(/-schedule$/, '') : serviceId;
      const warnings = [
        await this.deleteCloudSchedulerJobIfExists(schedulerJobName, token),
        await this.deleteCloudRunJobIfExists(jobName, token),
        await this.deleteCloudRunServiceIfExists(serviceId, token),
        serviceId === jobName ? undefined : await this.deleteCloudRunServiceIfExists(jobName, token),
      ].filter((warning): warning is string => Boolean(warning));

      if (warnings.length > 0) {
        return {
          success: false,
          error: warnings.join('; '),
        };
      }

      return {
        success: true,
        message: `Deleted Cloud Run resources for ${serviceId}`,
      };
    } catch (error) {
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>
  ): Promise<Receipt> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };

    const prefix = bindings.projectId || 'hypervibe';
    const isCron = serviceWorkloadKind(service) === 'cron';
    const serviceName = isCron
      ? bindings.services?.[service.name]?.jobName ?? this.sanitizeName(`${prefix}-${service.name}`)
      : bindings.services?.[service.name]?.serviceId ?? this.sanitizeName(`${prefix}-${service.name}`);

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;

      if (isCron) {
        const runtimeVars = this.runtimeEnvVarsForService(service, vars);
        if (Object.keys(runtimeVars).length === 0) {
          return {
            success: true,
            message: 'No runtime environment variables to set',
            data: { variableCount: 0 },
          };
        }

        const currentJob = await this.getCloudRunJob(serviceName, token);
        const currentContainer = this.primaryJobContainer(currentJob);
        if (!currentContainer?.image) {
          return {
            success: true,
            message: `Skipped scheduled job env var pre-sync because ${serviceName} does not have an existing image; deploy will create/update the job`,
            data: {
              skipped: true,
              reason: 'missing_existing_job_image',
              variableCount: Object.keys(runtimeVars).length,
            },
          };
        }

        const replaceManagedDatabaseVars = this.isManagedDatabaseEnvSync(runtimeVars);
        const jobSpec = this.cloudRunJobSpec({
          imageUri: currentContainer.image,
          command: service.buildConfig.startCommand?.trim() || 'npm start',
          env: this.mergeEnvVars(currentContainer.env, runtimeVars, { replaceManagedDatabaseVars }),
          resources: currentContainer.resources,
          serviceAccount: currentJob?.template?.template?.serviceAccount
            ?? currentJob?.template?.template?.serviceAccountName
            ?? this.serviceAccountCreds?.client_email,
          existingVolumes: currentJob?.template?.template?.volumes,
          existingVolumeMounts: currentContainer.volumeMounts,
          cloudSqlConnectionNames: this.cloudSqlConnectionNamesFromEnv(runtimeVars),
          replaceManagedDatabaseVars,
        });
        await this.upsertCloudRunJob({
          token,
          jobName: serviceName,
          jobSpec,
          description: 'scheduled job env update',
        });

        return {
          success: true,
          message: `Set ${Object.keys(runtimeVars).length} environment variables`,
          data: { variableCount: Object.keys(runtimeVars).length },
        };
      }

      // Get current service
      const currentService = await this.getService(serviceName);
      if (!currentService) {
        return { success: false, message: `Service ${serviceName} not found` };
      }

      const runtimeVars = this.runtimeEnvVarsForService(service, vars);
      if (Object.keys(runtimeVars).length === 0) {
        return {
          success: true,
          message: 'No runtime environment variables to set',
          data: { variableCount: 0 },
        };
      }

      const currentContainer = this.primaryContainer(currentService);
      if (!currentContainer?.image) {
        return {
          success: false,
          message: `Service ${serviceName} does not have an image to preserve while updating environment variables`,
        };
      }

      const replaceManagedDatabaseVars = this.isManagedDatabaseEnvSync(runtimeVars);
      const cloudSqlNames = replaceManagedDatabaseVars
        ? this.cloudSqlConnectionNamesFromEnv(runtimeVars)
        : Array.from(new Set([
            ...this.cloudSqlConnectionNamesFromEnv(runtimeVars),
            ...this.cloudSqlConnectionNamesFromEnvVars(currentContainer.env),
          ]));
      const cloudSql = this.cloudSqlVolumeConfig(cloudSqlNames);
      const volumeMounts = cloudSql
        ? this.mergeVolumeMounts(currentContainer.volumeMounts, [cloudSql.volumeMount])
        : replaceManagedDatabaseVars
          ? this.removeCloudSqlVolumeMounts(currentContainer.volumeMounts)
          : currentContainer.volumeMounts;
      const templateVolumes = cloudSql
        ? this.mergeVolumes(this.serviceVolumes(currentService), [cloudSql.volume])
        : replaceManagedDatabaseVars
          ? this.removeCloudSqlVolumes(this.serviceVolumes(currentService))
          : this.serviceVolumes(currentService);
      const containerSpec = {
        ...(currentContainer.name ? { name: currentContainer.name } : {}),
        image: currentContainer.image,
        ...(currentContainer.ports ? { ports: currentContainer.ports } : {}),
        ...(currentContainer.command ? { command: currentContainer.command } : {}),
        ...(currentContainer.args ? { args: currentContainer.args } : {}),
        ...(currentContainer.resources ? { resources: currentContainer.resources } : {}),
        ...(volumeMounts && volumeMounts.length > 0 ? { volumeMounts } : {}),
        env: this.mergeEnvVars(currentContainer.env, runtimeVars, { replaceManagedDatabaseVars }),
      };
      const templateUpdate: Record<string, unknown> = {
        containers: [containerSpec],
      };
      const updateMask = ['template.containers'];
      if (cloudSql || replaceManagedDatabaseVars) {
        templateUpdate.volumes = templateVolumes ?? [];
        updateMask.push('template.volumes');
      }

      const response = await fetch(
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}?updateMask=${updateMask.join(',')}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template: templateUpdate,
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Run API error: ${response.status} ${text}`);
      }

      return {
        success: true,
        message: `Set ${Object.keys(runtimeVars).length} environment variables`,
        data: { variableCount: Object.keys(runtimeVars).length },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to set environment variables',
        error: this.formatError(error),
      };
    }
  }

  async getDeployStatus(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string }> {
    if (!this.credentials) {
      return { status: 'unknown' };
    }

    try {
      const token = await this.getAccessToken();
      const schedulerJob = await this.getCloudSchedulerJob(deploymentId, token);
      if (schedulerJob) {
        const state = (schedulerJob.state ?? '').toUpperCase();
        if (['ENABLED', 'PAUSED'].includes(state)) {
          return { status: 'deployed' };
        }
        if (state === 'UPDATE_FAILED') {
          return { status: 'failed' };
        }
        return { status: state ? state.toLowerCase() : 'deploying' };
      }

      const service = await this.getService(deploymentId);
      if (!service) {
        const job = await this.getCloudRunJob(deploymentId, token);
        const readiness = this.cloudRunJobReadiness(job);
        if (readiness.ready) {
          return { status: 'deployed' };
        }
        return { status: readiness.error ? 'failed' : 'unknown' };
      }

      const readiness = this.cloudRunServiceReadiness(service);
      const status = readiness.ready ? 'deployed' : readiness.error ? 'failed' : 'deploying';

      return { status, url: service.uri };
    } catch {
      return { status: 'unknown' };
    }
  }

  async runJob(
    environment: Environment,
    service: Service,
    command: string
  ): Promise<JobResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId?: string; imageUri?: string }>;
    };
    const prefix = bindings.projectId || 'hypervibe';
    const serviceName = bindings.services?.[service.name]?.serviceId
      ?? this.sanitizeName(`${prefix}-${service.name}`);
    const sourceService = await this.getService(serviceName);
    const sourceContainer = this.primaryContainer(sourceService);
    const imageUri = sourceContainer?.image ?? bindings.services?.[service.name]?.imageUri;

    if (!imageUri) {
      return {
        jobId: '',
        status: 'failed',
        receipt: {
          success: false,
          message: `Cloud Run migration job requires an image for service ${service.name}`,
          error: 'Deploy the service first so Infraprint can build and record its Cloud Run image before running db_migrate.',
          data: {
            provider: this.name,
            missing: ['services.' + service.name + '.imageUri'],
          },
        },
      };
    }

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;
      const jobBaseName = serviceName.length > 49 ? serviceName.slice(0, 49).replace(/-+$/g, '') : serviceName;
      const jobName = this.sanitizeName(`${jobBaseName}-migration`);
      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      const jobsBaseUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs`;
      const jobSpec = this.cloudRunJobSpec({
        imageUri,
        command,
        env: sourceContainer?.env ?? [],
        resources: sourceContainer?.resources,
        serviceAccount: sourceService?.template?.serviceAccount
          ?? sourceService?.template?.serviceAccountName
          ?? sourceService?.spec?.template?.spec?.serviceAccountName
          ?? this.serviceAccountCreds?.client_email,
        existingVolumes: this.serviceVolumes(sourceService),
        existingVolumeMounts: sourceContainer?.volumeMounts,
        cloudSqlConnectionNames: this.cloudSqlConnectionNamesFromEnvVars(sourceContainer?.env),
      });

      await this.upsertCloudRunJob({
        token,
        jobName,
        jobSpec,
        description: 'migration job',
      });

      const runResponse = await fetch(`${jobsBaseUrl}/${jobName}:run`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      if (!runResponse.ok) {
        const text = await runResponse.text();
        throw new Error(`Cloud Run Jobs run error: ${runResponse.status} ${text}`);
      }

      const operation = await runResponse.json() as { name?: string };
      return {
        jobId: operation.name ?? jobName,
        status: 'running',
        receipt: {
          success: true,
          message: `Started Cloud Run migration job ${jobName}`,
          data: {
            jobName,
            operationName: operation.name,
            serviceName,
            imageUri,
          },
        },
      };
    } catch (error) {
      return {
        jobId: '',
        status: 'failed',
        receipt: {
          success: false,
          message: `Cloud Run migration job failed for ${service.name}`,
          error: this.formatError(error),
        },
      };
    }
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

  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };
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

    const token = await this.getAccessToken();
    const prefix = bindings.projectId;
    const environmentLabel = this.labelValue(environment.name);
    const serviceBindings = bindings.services ?? {};
    const warnings: string[] = [];
    const services: ObservedService[] = [];

    let liveServices: CloudRunService[] = [];
    try {
      liveServices = await this.listCloudRunServices(token);
    } catch (error) {
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

      const container = this.primaryContainer(liveService);
      const readiness = this.cloudRunServiceReadiness(liveService);
      const startCommand = this.containerStartCommand(container);
      const healthCheckPath = container?.startupProbe?.httpGet?.path ?? container?.livenessProbe?.httpGet?.path;
      const publicAccess = await this.observePublicInvoker(externalId, token);
      services.push({
        name: this.observedServiceName(externalId, liveService.labels, bindingKey, prefix),
        externalId,
        workloadKind: 'web',
        ...(liveService.uri ? { url: liveService.uri } : {}),
        customDomains: [],
        config: {
          ...(startCommand ? { startCommand } : {}),
          ...(healthCheckPath ? { healthCheckPath } : {}),
          ...(publicAccess === undefined ? {} : { public: publicAccess }),
        },
        ...this.observedEnvFromContainer(container),
        status: readiness.ready ? 'running' : readiness.error ? 'failed' : 'unknown',
      });
    }

    let liveJobs: CloudRunJob[] = [];
    try {
      liveJobs = await this.listCloudRunJobs(token);
    } catch (error) {
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

      const schedulerJobName = this.sanitizeName(`${externalId}-schedule`);
      let schedulerJob: CloudSchedulerJob | null = null;
      try {
        schedulerJob = await this.getCloudSchedulerJob(schedulerJobName, token);
      } catch (error) {
        warnings.push(`Failed to read Cloud Scheduler job ${schedulerJobName}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const container = this.primaryJobContainer(liveJob);
      const readiness = this.cloudRunJobReadiness(liveJob);
      const startCommand = this.containerStartCommand(container);
      services.push({
        name: this.observedServiceName(externalId, liveJob.labels, bindingKey, prefix),
        externalId: schedulerJob ? schedulerJobName : externalId,
        workloadKind: schedulerJob ? 'cron' : 'job',
        customDomains: [],
        config: {
          ...(startCommand ? { startCommand } : {}),
          ...(schedulerJob?.schedule ? { cronSchedule: schedulerJob.schedule } : {}),
        },
        ...this.observedEnvFromContainer(container),
        status: readiness.ready ? 'running' : readiness.error ? 'failed' : 'unknown',
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
      partial: warnings.length > 0,
      warnings,
    };
  }

  // Helper methods

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

    if (!response.ok) {
      return [];
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

    if (!response.ok) {
      return [];
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

      const body = await response.json() as Record<string, unknown>;
      resources.push(...((body[key] as T[] | undefined) ?? []));
      pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
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

  private async observePublicInvoker(serviceName: string, token: string): Promise<boolean | undefined> {
    try {
      const policy = await this.getServiceIamPolicy(this.cloudRunServiceResource(serviceName), token);
      return this.hasIamBinding(policy.bindings ?? [], 'roles/run.invoker', 'allUsers');
    } catch {
      return undefined;
    }
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

  private escapeLoggingValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private shouldAllowUnauthenticated(service: Service): boolean {
    if (typeof service.buildConfig.public === 'boolean') {
      return service.buildConfig.public;
    }
    return serviceWorkloadKind(service) === 'web';
  }

  private async ensurePublicInvoker(serviceName: string, token: string): Promise<boolean> {
    const role = 'roles/run.invoker';
    const member = 'allUsers';
    const resource = this.cloudRunServiceResource(serviceName);
    const policy = await this.getServiceIamPolicy(resource, token);
    const bindings = (policy.bindings ?? []).map((binding) => ({
      ...binding,
      members: [...(binding.members ?? [])],
    }));

    const alreadyPublic = this.hasIamBinding(bindings, role, member);
    if (alreadyPublic) {
      return false;
    }

    const invokerBinding = bindings.find((binding) => binding.role === role && !binding.condition);
    if (invokerBinding) {
      invokerBinding.members = Array.from(new Set([...(invokerBinding.members ?? []), member]));
    } else {
      bindings.push({ role, members: [member] });
    }

    await this.setServiceIamPolicy(resource, { ...policy, bindings }, token);
    const updatedPolicy = await this.getServiceIamPolicy(resource, token);
    if (!this.hasIamBinding(updatedPolicy.bindings ?? [], role, member)) {
      throw new Error(`Cloud Run IAM policy update for ${serviceName} completed but ${member} is still missing ${role}`);
    }
    return true;
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

  private async getServiceIamPolicy(resource: string, token: string): Promise<IamPolicy> {
    const response = await fetch(`https://run.googleapis.com/v2/${resource}:getIamPolicy`, {
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

  private async setServiceIamPolicy(resource: string, policy: IamPolicy, token: string): Promise<void> {
    const response = await fetch(`https://run.googleapis.com/v2/${resource}:setIamPolicy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policy }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud Run IAM policy update failed: ${response.status} ${text}`);
    }
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

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;
      const repository = this.sanitizeName(envVars['HYPERVIBE_ARTIFACT_REPOSITORY']?.trim() || 'infraprint');
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
        githubToken: envVars['HYPERVIBE_GITHUB_TOKEN']?.trim(),
      });

      return {
        success: true,
        imageUri,
        buildId: build.id,
        logsUrl: build.logsUrl,
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
    const existing = await fetch(`${baseUrl}/${repository}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (existing.ok) {
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
        description: 'Container images built by Infraprint',
      }),
    });

    if (!created.ok) {
      const text = await created.text();
      throw new Error(`Artifact Registry repository creation failed: ${created.status} ${text}`);
    }
  }

  private async submitCloudBuild(params: {
    token: string;
    service: Service;
    sourceRepoUrl: string;
    revision: string;
    imageUri: string;
    githubToken?: string;
  }): Promise<{ id?: string; logsUrl?: string }> {
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
            url: this.cloudBuildGitSourceUrl(params.sourceRepoUrl, params.githubToken),
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
    return this.waitForCloudBuild(params.token, build);
  }

  private async waitForCloudBuild(
    token: string,
    buildOrOperation: CloudBuildStatus | CloudBuildOperation
  ): Promise<{ id?: string; logsUrl?: string }> {
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
        return { id: current.id, logsUrl: current.logsUrl ?? current.logUrl };
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
    const startCommand = service.buildConfig.startCommand?.trim() || 'npm start';
    const generatedDockerfile = [
      'FROM node:20-slim',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi',
      'COPY . .',
      'ENV PORT=8080',
      'EXPOSE 8080',
      `CMD ["sh", "-lc", ${JSON.stringify(startCommand)}]`,
      '',
    ].join('\n');

    return [
      'set -euo pipefail',
      `if [ -f ${JSON.stringify(dockerfilePath)} ]; then`,
      `  docker build -t ${JSON.stringify(imageUri)} -f ${JSON.stringify(dockerfilePath)} .`,
      'elif [ -f package.json ]; then',
      "  cat > Dockerfile.infraprint <<'EOF'",
      generatedDockerfile,
      'EOF',
      `  docker build -t ${JSON.stringify(imageUri)} -f Dockerfile.infraprint .`,
      'else',
      '  echo "No Dockerfile or package.json found. Add a Dockerfile or a Node package.json so Infraprint can build this service automatically." >&2',
      '  exit 1',
      'fi',
    ].join('\n');
  }

  private cloudBuildGitSourceUrl(sourceRepoUrl: string, githubToken?: string): string {
    if (!githubToken) {
      return sourceRepoUrl;
    }

    try {
      const url = new URL(sourceRepoUrl);
      if (url.hostname.toLowerCase() !== 'github.com') {
        return sourceRepoUrl;
      }
      url.username = 'x-access-token';
      url.password = githubToken;
      return url.toString();
    } catch {
      return sourceRepoUrl;
    }
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

  private async getService(serviceName: string): Promise<CloudRunService | null> {
    if (!this.credentials) {
      return null;
    }

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;
      const response = await fetch(
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as CloudRunService;
    } catch {
      return null;
    }
  }

  private primaryContainer(service: CloudRunService | null): CloudRunContainer | undefined {
    return service?.template?.containers?.[0] ?? service?.spec?.template?.spec?.containers?.[0];
  }

  private primaryJobContainer(job: CloudRunJob | null): CloudRunContainer | undefined {
    return job?.template?.template?.containers?.[0];
  }

  private serviceVolumes(service: CloudRunService | null): Array<Record<string, unknown>> | undefined {
    return service?.template?.volumes ?? service?.spec?.template?.spec?.volumes;
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
  }): Record<string, unknown> {
    const cloudSql = this.cloudSqlVolumeConfig(params.cloudSqlConnectionNames);
    const volumeMounts = cloudSql
      ? this.mergeVolumeMounts(params.existingVolumeMounts, [cloudSql.volumeMount])
      : params.replaceManagedDatabaseVars
        ? this.removeCloudSqlVolumeMounts(params.existingVolumeMounts)
        : params.existingVolumeMounts;
    const container = {
      image: params.imageUri,
      command: ['/bin/sh'],
      args: ['-lc', params.command],
      env: params.env,
      ...(params.resources ? { resources: params.resources } : {}),
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
  }): Promise<{ created: boolean }> {
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
    const creatingJob = !existingJob.ok;
    const upsertResponse = existingJob.ok
      ? await fetch(`${jobsBaseUrl}/${params.jobName}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(params.jobSpec),
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
    await this.waitForCloudRunOperation(params.token, operation, `${params.description} ${creatingJob ? 'create' : 'update'}`);
    await this.waitForCloudRunJobReady(params.jobName, params.token);

    return { created: creatingJob };
  }

  private async getCloudSchedulerJob(schedulerJobName: string, token: string): Promise<CloudSchedulerJob | null> {
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

    if (!response.ok) {
      return null;
    }

    return await response.json() as CloudSchedulerJob;
  }

  private async upsertCloudSchedulerJob(params: {
    token: string;
    schedulerJobName: string;
    jobName: string;
    schedule: string;
    timeZone: string;
  }): Promise<{ created: boolean }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId, region } = this.credentials;
    const baseUrl = `https://cloudscheduler.googleapis.com/v1/projects/${projectId}/locations/${region}/jobs`;
    const jobPath = `projects/${projectId}/locations/${region}/jobs/${params.schedulerJobName}`;
    const runUri = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${params.jobName}:run`;
    const schedulerSpec = {
      name: jobPath,
      description: `Run Cloud Run job ${params.jobName}`,
      schedule: params.schedule,
      timeZone: params.timeZone,
      httpTarget: {
        uri: runUri,
        httpMethod: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: btoa('{}'),
        ...(this.serviceAccountCreds?.client_email
          ? {
              oauthToken: {
                serviceAccountEmail: this.serviceAccountCreds.client_email,
                scope: 'https://www.googleapis.com/auth/cloud-platform',
              },
            }
          : {}),
      },
    };
    return this.upsertCloudSchedulerJobOnce({
      ...params,
      baseUrl,
      schedulerSpec,
      retriedAfterEnable: false,
    });
  }

  private async upsertCloudSchedulerJobOnce(params: {
    token: string;
    schedulerJobName: string;
    baseUrl: string;
    schedulerSpec: Record<string, unknown>;
    retriedAfterEnable: boolean;
  }): Promise<{ created: boolean }> {
    const existing = await this.getCloudSchedulerJob(params.schedulerJobName, params.token);
    const headers = {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    };
    const response = existing
      ? await fetch(`${params.baseUrl}/${params.schedulerJobName}?updateMask=description,schedule,timeZone,httpTarget`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(params.schedulerSpec),
        })
      : await fetch(params.baseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(params.schedulerSpec),
        });

    if (!response.ok) {
      const text = await response.text();
      if (
        !params.retriedAfterEnable
        && this.isDisabledApiMessage(text, 'cloudscheduler.googleapis.com')
      ) {
        await this.enableGoogleService(params.token, 'cloudscheduler.googleapis.com');
        return this.upsertCloudSchedulerJobOnce({
          ...params,
          retriedAfterEnable: true,
        });
      }
      throw new Error(`Cloud Scheduler API error: ${response.status} ${text}`);
    }

    return { created: !existing };
  }

  private async deleteCloudRunServiceIfExists(serviceName: string, token: string): Promise<string | undefined> {
    if (!this.credentials) {
      return undefined;
    }

    const { projectId, region } = this.credentials;
    const headers = { Authorization: `Bearer ${token}` };
    const serviceUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`;
    const existing = await fetch(serviceUrl, { headers });
    if (existing.status === 404 || !existing.ok) {
      return undefined;
    }

    const deleted = await fetch(serviceUrl, { method: 'DELETE', headers });
    if (!deleted.ok) {
      const text = await deleted.text();
      return `Skipped stale Cloud Run service cleanup for ${serviceName}: ${deleted.status} ${text}`;
    }

    try {
      const operation = await deleted.json() as CloudRunOperation;
      await this.waitForCloudRunOperation(token, operation, 'stale service delete');
    } catch (error) {
      return `Stale Cloud Run service cleanup for ${serviceName} may still be in progress: ${error instanceof Error ? error.message : String(error)}`;
    }

    return undefined;
  }

  private async deleteCloudRunJobIfExists(jobName: string, token: string): Promise<string | undefined> {
    if (!this.credentials) {
      return undefined;
    }

    const { projectId, region } = this.credentials;
    const headers = { Authorization: `Bearer ${token}` };
    const jobUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}`;
    const existing = await fetch(jobUrl, { headers });
    if (existing.status === 404 || !existing.ok) {
      return undefined;
    }

    const deleted = await fetch(jobUrl, { method: 'DELETE', headers });
    if (!deleted.ok) {
      const text = await deleted.text();
      return `Skipped Cloud Run job cleanup for ${jobName}: ${deleted.status} ${text}`;
    }

    try {
      const operation = await deleted.json() as CloudRunOperation;
      await this.waitForCloudRunOperation(token, operation, 'job delete');
    } catch (error) {
      return `Cloud Run job cleanup for ${jobName} may still be in progress: ${error instanceof Error ? error.message : String(error)}`;
    }

    return undefined;
  }

  private async deleteCloudSchedulerJobIfExists(schedulerJobName: string, token: string): Promise<string | undefined> {
    if (!this.credentials) {
      return undefined;
    }

    const { projectId, region } = this.credentials;
    const headers = { Authorization: `Bearer ${token}` };
    const schedulerUrl = `https://cloudscheduler.googleapis.com/v1/projects/${projectId}/locations/${region}/jobs/${schedulerJobName}`;
    const deleted = await fetch(schedulerUrl, { method: 'DELETE', headers });
    if (deleted.status === 404) {
      return undefined;
    }
    if (!deleted.ok) {
      const text = await deleted.text();
      return `Skipped Cloud Scheduler cleanup for ${schedulerJobName}: ${deleted.status} ${text}`;
    }

    return undefined;
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

  private async waitForCloudRunServiceReady(serviceName: string, token: string): Promise<CloudRunService | null> {
    for (let attempt = 0; attempt < 120; attempt++) {
      const service = await this.getCloudRunService(serviceName, token);
      const readiness = this.cloudRunServiceReadiness(service);
      if (readiness.ready) {
        return service;
      }
      if (readiness.error) {
        throw new Error(`Cloud Run service ${serviceName} is not ready: ${readiness.error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Cloud Run service ${serviceName} was not ready before timeout`);
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

    if (!response.ok) {
      return null;
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
    description: string
  ): Promise<void> {
    if (!operation.name || !operation.name.includes('/operations/')) {
      return;
    }

    let current = operation;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (current.done) {
        if (current.error) {
          throw new Error(
            `Cloud Run ${description} operation failed: ${current.error.status ?? current.error.code ?? 'unknown'} ${current.error.message ?? ''}`.trim()
          );
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      const response = await fetch(`https://run.googleapis.com/v2/${current.name}`, {
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

  private async waitForCloudRunJobReady(jobName: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const job = await this.getCloudRunJob(jobName, token);
      const readiness = this.cloudRunJobReadiness(job);
      if (readiness.ready) {
        return;
      }
      if (readiness.error) {
        throw new Error(`Cloud Run job ${jobName} is not ready: ${readiness.error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Cloud Run job ${jobName} was not ready before timeout`);
  }

  private async getCloudRunJob(jobName: string, token: string): Promise<CloudRunJob | null> {
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

    if (!response.ok) {
      return null;
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

  private cloudSqlConnectionNamesFromEnv(envVars: Record<string, string>): string[] {
    const raw = envVars.CLOUD_SQL_CONNECTION_NAME ?? envVars.INSTANCE_CONNECTION_NAME;
    return this.parseCloudSqlConnectionNames(raw);
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

  private cloudSqlVolumeConfigFromEnv(envVars: Record<string, string>): { volume: Record<string, unknown>; volumeMount: Record<string, unknown> } | undefined {
    return this.cloudSqlVolumeConfig(this.cloudSqlConnectionNamesFromEnv(envVars));
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

  private mergeEnvVars(
    existing: Array<Record<string, unknown>> | undefined,
    updates: Record<string, string>,
    options: { replaceManagedDatabaseVars?: boolean } = {}
  ): Array<Record<string, unknown>> {
    const byName = new Map<string, Record<string, unknown>>();
    for (const entry of existing ?? []) {
      if (typeof entry.name === 'string') {
        if (options.replaceManagedDatabaseVars && MANAGED_DATABASE_ENV_KEYS.has(entry.name)) {
          continue;
        }
        byName.set(entry.name, { ...entry });
      }
    }
    for (const [name, value] of Object.entries(updates)) {
      byName.set(name, { name, value });
    }
    return [...byName.values()];
  }

  private isManagedDatabaseEnvSync(updates: Record<string, string>): boolean {
    return Object.keys(updates).some((key) => MANAGED_DATABASE_SYNC_KEYS.has(key));
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

  private imageUriForService(service: Service, envVars: Record<string, string>): string | undefined {
    return envVars[this.imageEnvKey(service)]?.trim() || envVars['IMAGE_URI']?.trim() || undefined;
  }

  private runtimeEnvVarsForService(service: Service, envVars: Record<string, string>): Record<string, string> {
    const internalKeys = new Set([
      'IMAGE_URI',
      this.imageEnvKey(service),
      'HYPERVIBE_SOURCE_REPO_URL',
      'HYPERVIBE_SOURCE_REVISION',
      'HYPERVIBE_ARTIFACT_REPOSITORY',
      'HYPERVIBE_GITHUB_TOKEN',
      'HYPERVIBE_CRON_TIME_ZONE',
    ]);
    return Object.fromEntries(
      Object.entries(envVars).filter(([key]) => !internalKeys.has(key))
    );
  }

  private imageEnvKey(service: Service): string {
    const serviceKey = service.name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    return `IMAGE_URI_${serviceKey}`;
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
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'cloudrun',
    displayName: 'GCP Cloud Run',
    category: 'deployment',
    credentialsSchema: CloudRunCredentialsSchema,
    setupHelpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
  },
  factory: (credentials) => {
    const adapter = new CloudRunAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});

import type {
  EngineAuthentication,
  EngineConfiguration,
  EngineResourceMapping,
  InfrastructureEngineBackend,
} from '../../../../domain/ports/infrastructure-engine.port.js';

/**
 * GCP half of the OpenTofu engine integration. Everything Google-specific
 * (provider pin, credential env, Cloud Run shape, Secret Manager references)
 * lives here; the shared engine never sees it.
 *
 * Source: https://github.com/opentofu/terraform-provider-google/releases/tag/v8.9.0
 */
export const GOOGLE_PROVIDER_VERSION = '8.9.0';

/**
 * Exact lock hashes produced by `tofu providers lock` for darwin/linux on
 * arm64/amd64. `zh:` entries match the upstream SHA256SUMS archive checksums.
 */
const GOOGLE_PROVIDER_LOCK_HASHES = [
  'h1:BQXx6yc7LPhe6c6RdMAQNsnP5Rcg2QDCm4mAK34cZnI=',
  'h1:Ha7iJ5vQpcptAWCEXB/gzkIkhKDw2ZKxPVqQ3LO9yBs=',
  'h1:LXF4Jsm9aks8FjVTPcBn/ubc2N0X9qN7iyFuSE88Ua0=',
  'h1:Lb8ddQwOczEEPHg+aTSMVSq4cckeB+nXhXbPxLPOtwM=',
  'h1:MUiXp+AnOthO7PGMuqsJCOWen7ifB5VR9YHSOWTVwJk=',
  'h1:N5YxSJfDhYzXTKtjqAO+JpIlU8Gom8VO5wnB3M8AVqg=',
  'h1:NFex8eCfhLW2HU+A0B/z5F8XgppYx7Q6HeqO+oFZ0QI=',
  'h1:Tz/OS7RfwTBamW3VbeU/sFPcIv+jWCNG6f+CWHjFAfk=',
  'h1:dXM5HpwSNgO2aElNKq5bbzsTmE5UN9e3UyJugfJGK08=',
  'h1:dvIlDJPUBTrYcCJrvYwJ1wQE9e44iUBQQse6JvPNisM=',
  'h1:fl/pmRnYqfB0zyTYrHYS43DG6RIzVQoXhME9VPMsVW8=',
  'h1:g0mAfBrYFNBz4fJTbji4Q5YhkkKTdir3HFcM2SMZQxQ=',
  'h1:hXPTLeH+6VHBIC4TDB7apqCpjXJKm6anceZnkPSnRNk=',
  'h1:jxOSQzax3ZoIEcFu4ypm9k6laHMdIKh57Ulkgqu2KC8=',
  'h1:xhlO0mek9DQDI4BeoZKZ1GxLPUD5jgHPEb+iCTIe4LI=',
  'zh:04e7e1d351e84fbb86a50b27e8a0c4b9fb0b658c430d8bad48255332ec76ae27',
  'zh:0d2421475ee0ef57d118e271ee7114f4514fdb4449686bd3d280a32b8a9b759b',
  'zh:2effe13ef3c5c3f7ada295381a392cb0d027790d8015bd5d77e754d8141673a0',
  'zh:58495c9ed94db942bf90222a80c28472e72e05368d0ca5b1cb5d08c6754bbe25',
  'zh:5d259af76dafa4bab3cd5828113bffece3be381d8823188678617947c24e4894',
  'zh:7c2ed6a9e0d63fec024359331b7baae359016572e1328e63b9ef50469ade53a7',
  'zh:8899ded4b859f66fbde51f177d98a27a1a1bd3f663a3574536bf88588393eeaf',
  'zh:930de4f007b0c411a9679a34270e9538b3a037834092a659e875b89390da2953',
  'zh:aea26e80845f3d42a39f30e676c4d9aada913bf4a72336adff45fe15c73350e8',
  'zh:cc4f83e4cedc15e7ba69921aca72df0c66f543fd1688923828787cb08792a6ae',
  'zh:d43111794dd3f7103285a438f20a2c9f4888460ad86525d0d9e52b75ed934f66',
  'zh:d58c54d425a5b33ba5b7ce9ecf46e13a111f2702b12195af1d79f65490d99ba4',
  'zh:ed89123c75b4c65c59cdfa0dd16435eb25dd7f02a87e8971ac543782c0f69986',
  'zh:f47fadbca8129565bf0844279f0a49941888c1e016f55c37ffbb667ee764e88d',
  'zh:f4c7f54f29597788faa2cb53d5ea3b74ad79882e2d1a7267ef90fbb7f216c39a',
];

/** Reference to a Secret Manager secret; never a value. */
export interface GcpSecretReference {
  /** Secret Manager secret id (short name) in the target project. */
  secretId: string;
  /** Pinned numeric version, or `latest` only when rotation-by-restart is intended. */
  version: string;
}

export interface GcpCloudRunServiceInput {
  /** Logical spec name, e.g. `web`. */
  logicalName: string;
  /** Physical Cloud Run name, resolved by Hypervibe's naming/binding rules. */
  resourceName: string;
  /** `job` is a scheduled Cloud Run job triggered by Cloud Scheduler. */
  workload: 'web' | 'worker' | 'job';
  /** job: five-field cron schedule and IANA time zone. */
  schedule?: string;
  timeZone?: string;
  /** job: the shell command each run executes. */
  jobCommand?: string;
  /**
   * Immutable image for first creation. After creation the image is owned by
   * the release path (CI or hv_deploy) and ignored by infrastructure plans.
   */
  initialImage: string;
  runtimeServiceAccountEmail: string;
  port?: number;
  cpu?: string;
  memory?: string;
  minInstances?: number;
  maxInstances?: number;
  command?: string[];
  args?: string[];
  /** Non-secret runtime configuration only. */
  env?: Record<string, string>;
  /** Runtime secrets wired by reference through Secret Manager. */
  secretEnv?: Record<string, GcpSecretReference>;
  /** Grant allUsers run.invoker. Organization policy may forbid this. */
  public: boolean;
  healthCheckPath?: string;
}

export interface GcpCloudRunEngineInput {
  projectId: string;
  region: string;
  services: GcpCloudRunServiceInput[];
  /**
   * Services this environment previously created that are no longer desired.
   * They contribute only address mappings, so their deletion is reviewable
   * instead of being reported as an unmanaged change.
   */
  retiredServices?: string[];
  /** Cloud SQL Postgres owned by the engine. Users and passwords stay with Hypervibe. */
  database?: GcpCloudSqlInput;
  /** A database this environment previously created that is no longer desired. */
  retiredDatabase?: boolean;
  /** Custom domains mapped to services. Ownership verification and DNS stay with Hypervibe. */
  domains?: Array<{ domain: string; service: string }>;
  /** Domains this environment previously mapped that are no longer desired. */
  retiredDomains?: string[];
  /** Cloud Storage buckets; the runtime identity gets object access to each, nothing broader. */
  storage?: GcpStorageInput[];
  /** Buckets this environment previously created that are no longer desired. */
  retiredStorage?: string[];
  runtimeServiceAccountEmail?: string;
  /**
   * Existing resources Hypervibe itself attempted to create (exact recorded
   * identity and ownership label) that engine state does not track yet.
   */
  adopt?: { databaseInstance?: string; buckets?: string[] };
  /** Environment id stamped on owned resources so adoption can prove ownership. */
  environmentId?: string;
  /** Memorystore Redis owned by the engine; Hypervibe publishes REDIS_URL. */
  cache?: GcpCacheInput;
  /** A cache this environment previously created that is no longer desired. */
  retiredCache?: boolean;
  /** Pub/Sub queues: one topic and one subscription each. */
  queues?: Array<{ name: string; topicId: string; ackDeadlineSeconds?: number }>;
  /** Queues this environment previously created that are no longer desired. */
  retiredQueues?: string[];
  /** One-off job that runs the release (migration) command before services switch images. */
  releaseJob?: GcpCloudRunServiceInput;
  retiredReleaseJob?: boolean;
}

export const RELEASE_JOB_KEY = 'release_command';

export function queueEngineKey(name: string): string {
  return `queue_${name.replace(/[^a-z0-9]/g, '_')}`;
}

export interface GcpCacheInput {
  instanceName: string;
  tier: 'BASIC' | 'STANDARD_HA';
  memorySizeGb: number;
  /** VPC network and subnetwork names services use to reach the private Redis address. */
  network: string;
  subnetwork: string;
  /** Wire services (VPC egress + REDIS_URL reference) once Hypervibe has published the URL. */
  wireServices: boolean;
}

export interface GcpStorageInput {
  name: string;
  bucketName: string;
  location: string;
  /** Services that receive the gcs-native-adc-v1 runtime variables. */
  injectInto: string[];
  /**
   * S3-compatible access through Cloud Storage's XML API. The access key itself is a
   * Hypervibe-owned secret referenced by services; only non-secret settings live here.
   */
  s3?: { wired: boolean };
}

/** Variables S3-SDK apps read, pointed at Cloud Storage's S3-compatible endpoint. */
export const S3_COMPATIBLE_SECRET_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;

export function storageEngineKey(name: string): string {
  return `storage_${name.replace(/[^a-z0-9]/g, '_')}`;
}

export function domainEngineKey(domain: string): string {
  return `domain_${domain.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface GcpCloudSqlInput {
  /** Physical instance name; unique per project for a week after deletion, so Hypervibe picks and records it. */
  instanceName: string;
  databaseName: string;
  tier?: string;
  /**
   * Wire services to the database (socket volume + CLOUD_SQL_CONNECTION_NAME).
   * False until Hypervibe's credential exists, so a first deployment never
   * points services at a database they cannot log in to.
   */
  wireServices: boolean;
}

export const DATABASE_ENGINE_ADDRESSES = ['google_sql_database_instance.db', 'google_sql_database.app'] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = new Set(['PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION']);

function engineKey(logicalName: string): string {
  const key = logicalName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error(`Service name ${logicalName} cannot be used as an engine address.`);
  return key;
}

function assertImmutableImage(image: string): void {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error('Cloud Run images managed by the engine must be pinned by digest (image@sha256:...).');
  }
}

function serviceResource(input: GcpCloudRunEngineInput, service: GcpCloudRunServiceInput): Record<string, unknown> {
  assertImmutableImage(service.initialImage);
  if (!service.runtimeServiceAccountEmail.endsWith(`@${input.projectId}.iam.gserviceaccount.com`)) {
    throw new Error(`Runtime identity for ${service.logicalName} must belong to project ${input.projectId}.`);
  }
  const plain = Object.entries(service.env ?? {});
  const secret = Object.entries(service.secretEnv ?? {});
  for (const [name] of [...plain, ...secret]) {
    if (!ENV_NAME.test(name) || RESERVED_ENV.has(name)) throw new Error(`Environment variable ${name} cannot be managed for ${service.logicalName}.`);
  }
  const duplicate = plain.find(([name]) => name in (service.secretEnv ?? {}));
  if (duplicate) throw new Error(`Environment variable ${duplicate[0]} is declared both as a value and as a secret.`);

  const env = [
    ...plain.sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value })),
    ...secret.sort(([a], [b]) => a.localeCompare(b)).map(([name, ref]) => {
      if (!/^[A-Za-z0-9_-]{1,255}$/.test(ref.secretId) || !/^(latest|[1-9][0-9]*)$/.test(ref.version)) {
        throw new Error(`Secret reference for ${name} is invalid.`);
      }
      return { name, value_source: [{ secret_key_ref: [{ secret: ref.secretId, version: ref.version }] }] };
    }),
  ];
  const isWorker = service.workload === 'worker';
  const buckets = (input.storage ?? []).filter((bucket) => bucket.injectInto.includes(service.logicalName));
  if (buckets.length > 1) throw new Error(`Service ${service.logicalName} can receive only one bucket's variables.`);
  for (const bucket of buckets) {
    const reference = `\${google_storage_bucket.${storageEngineKey(bucket.name)}.name}`;
    for (const [name, value] of Object.entries({
      OBJECT_STORAGE_PROVIDER: 'gcs', OBJECT_STORAGE_BUCKET: reference,
      GOOGLE_CLOUD_PROJECT: input.projectId, GOOGLE_CLOUD_STORAGE_BUCKET: reference,
      ...(bucket.s3?.wired ? {
        AWS_ENDPOINT_URL: 'https://storage.googleapis.com', AWS_DEFAULT_REGION: 'auto',
        AWS_S3_BUCKET_NAME: reference, AWS_S3_URL_STYLE: 'path',
        // Cloud Storage's S3 API does not accept the AWS SDK's newer default checksum headers.
        AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED', AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',
      } : {}),
    })) {
      if (env.some((entry) => entry.name === name)) throw new Error(`Environment variable ${name} conflicts with storage ${bucket.name}.`);
      env.push({ name, value });
    }
  }
  const wired = input.database?.wireServices === true;
  if (wired) {
    // The socket path and connection name are infrastructure facts; the credential is a secret reference.
    env.push({ name: 'CLOUD_SQL_CONNECTION_NAME', value: '${google_sql_database_instance.db.connection_name}' });
  }
  const container: Record<string, unknown> = {
    image: service.initialImage,
    ...(service.command ? { command: service.command } : {}),
    ...(service.args ? { args: service.args } : {}),
    ...(isWorker ? {} : { ports: [{ container_port: service.port ?? 8080 }] }),
    resources: [{
      limits: { cpu: service.cpu ?? '1', memory: service.memory ?? '512Mi' },
      cpu_idle: !isWorker,
    }],
    ...(env.length ? { env } : {}),
    ...(wired ? { volume_mounts: [{ name: 'cloudsql', mount_path: '/cloudsql' }] } : {}),
    ...(!isWorker && service.healthCheckPath ? {
      startup_probe: [{ http_get: [{ path: service.healthCheckPath }], failure_threshold: 10, period_seconds: 3 }],
    } : {}),
  };
  return {
    name: service.resourceName,
    project: input.projectId,
    location: input.region,
    ingress: isWorker ? 'INGRESS_TRAFFIC_INTERNAL_ONLY' : 'INGRESS_TRAFFIC_ALL',
    // Hypervibe's approval gate governs deletion; provider-side protection would block approved teardown.
    deletion_protection: false,
    labels: { 'managed-by': 'hypervibe', 'hv-service': engineKey(service.logicalName).replace(/_/g, '-') },
    template: [{
      service_account: service.runtimeServiceAccountEmail,
      scaling: [{
        min_instance_count: service.minInstances ?? (isWorker ? 1 : 0),
        ...(service.maxInstances !== undefined ? { max_instance_count: service.maxInstances } : {}),
      }],
      containers: [container],
      ...(wired ? { volumes: [{ name: 'cloudsql', cloud_sql_instance: [{ instances: ['${google_sql_database_instance.db.connection_name}'] }] }] } : {}),
      // Direct VPC egress reaches the private Redis address; everything else still leaves normally.
      ...(input.cache?.wireServices ? { vpc_access: [{
        network_interfaces: [{ network: input.cache.network, subnetwork: input.cache.subnetwork }],
        egress: 'PRIVATE_RANGES_ONLY',
      }] } : {}),
    }],
    lifecycle: [{
      // Narrow release ownership: only the running image (and the client
      // markers gcloud/CI stamp on deploy) belong to the release writer.
      // Every other template field remains engine-managed, so infrastructure
      // changes keep the currently deployed image instead of rolling back.
      ignore_changes: ['template[0].containers[0].image', 'client', 'client_version'],
    }],
  };
}

function jobAddresses(key: string): string[] {
  return [`google_cloud_run_v2_job.${key}`, `google_cloud_scheduler_job.${key}_schedule`, `google_cloud_run_v2_job_iam_member.${key}_invoker`];
}

/**
 * A scheduled workload: a Cloud Run job with the same runtime identity,
 * configuration, secrets and database wiring as services, a Cloud Scheduler
 * trigger authenticated as the runtime identity, and permission for that
 * identity to start exactly this job.
 */
function addScheduledJob(
  input: GcpCloudRunEngineInput,
  service: GcpCloudRunServiceInput,
  key: string,
  jobs: Record<string, unknown>,
  schedules: Record<string, unknown>,
  jobIam: Record<string, unknown>
): void {
  const scheduled = service.workload === 'job';
  if (scheduled && (!service.schedule || !/^(\S+\s+){4}\S+$/.test(service.schedule.trim()))) throw new Error(`Scheduled job ${service.logicalName} needs a five-field cron schedule.`);
  if (!service.jobCommand?.trim()) throw new Error(`Scheduled job ${service.logicalName} needs an explicit command (startCommand).`);
  // Reuse the service builder for env, secrets and database wiring, then reshape it as a job.
  const base = serviceResource(input, { ...service, workload: 'worker' }) as { labels: unknown; template: Array<Record<string, unknown>> };
  const template = base.template[0]!;
  const container = { ...(template.containers as Array<Record<string, unknown>>)[0] };
  const resources = (container.resources as Array<Record<string, unknown>>)[0]!;
  container.resources = [{ limits: resources.limits }];
  container.command = ['/bin/sh'];
  container.args = ['-lc', service.jobCommand.trim()];
  jobs[key] = {
    name: service.resourceName,
    project: input.projectId,
    location: input.region,
    deletion_protection: false,
    labels: base.labels,
    template: [{
      template: [{
        service_account: service.runtimeServiceAccountEmail,
        max_retries: 1,
        timeout: '3600s',
        containers: [container],
        ...(template.volumes ? { volumes: template.volumes } : {}),
        ...(template.vpc_access ? { vpc_access: template.vpc_access } : {}),
      }],
    }],
    lifecycle: [{ ignore_changes: ['template[0].template[0].containers[0].image', 'client', 'client_version'] }],
  };
  if (!scheduled) return;
  schedules[`${key}_schedule`] = {
    name: `${service.resourceName}-schedule`.slice(0, 500),
    project: input.projectId,
    region: input.region,
    schedule: service.schedule!.trim(),
    time_zone: service.timeZone ?? 'UTC',
    attempt_deadline: '320s',
    http_target: [{
      http_method: 'POST',
      uri: `https://run.googleapis.com/v2/projects/${input.projectId}/locations/${input.region}/jobs/\${google_cloud_run_v2_job.${key}.name}:run`,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{}').toString('base64'),
      oauth_token: [{ service_account_email: service.runtimeServiceAccountEmail, scope: 'https://www.googleapis.com/auth/cloud-platform' }],
    }],
  };
  jobIam[`${key}_invoker`] = {
    project: input.projectId,
    location: input.region,
    name: `\${google_cloud_run_v2_job.${key}.name}`,
    role: 'roles/run.invoker',
    member: `serviceAccount:${service.runtimeServiceAccountEmail}`,
  };
}

export function buildCloudRunConfiguration(input: GcpCloudRunEngineInput): EngineConfiguration {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId)) throw new Error('GCP project id is invalid.');
  if (!/^[a-z]+-[a-z]+[0-9]$/.test(input.region)) throw new Error('GCP region is invalid.');
  const services: Record<string, unknown> = {};
  const iam: Record<string, unknown> = {};
  const resources: Record<string, EngineResourceMapping> = {};
  const seen = new Set<string>();
  const jobs: Record<string, unknown> = {};
  const schedules: Record<string, unknown> = {};
  const jobIam: Record<string, unknown> = {};
  for (const service of input.services) {
    const key = engineKey(service.logicalName);
    if (seen.has(key)) throw new Error(`Duplicate engine address for service ${service.logicalName}.`);
    seen.add(key);
    const mapping: EngineResourceMapping = {
      actionId: `service:${service.logicalName}`, kind: 'service', name: service.logicalName, billable: true,
    };
    if (service.workload === 'job') {
      addScheduledJob(input, service, key, jobs, schedules, jobIam);
      for (const address of jobAddresses(key)) resources[address] = mapping;
      continue;
    }
    services[key] = serviceResource(input, service);
    resources[`google_cloud_run_v2_service.${key}`] = mapping;
    if (service.public && service.workload === 'web') {
      iam[`${key}_public`] = {
        project: input.projectId,
        location: input.region,
        name: `\${google_cloud_run_v2_service.${key}.name}`,
        role: 'roles/run.invoker',
        member: 'allUsers',
      };
      resources[`google_cloud_run_v2_service_iam_member.${key}_public`] = mapping;
    }
  }
  const sql: Record<string, Record<string, unknown>> = {};
  const databaseMapping: EngineResourceMapping = { actionId: 'database:postgres', kind: 'database', name: 'postgres', dataBearing: true, billable: true };
  if (input.database) {
    if (!/^[a-z][a-z0-9-]{0,96}[a-z0-9]$/.test(input.database.instanceName)) throw new Error('Cloud SQL instance name is invalid.');
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.database.databaseName)) throw new Error('Database name is invalid.');
    sql.google_sql_database_instance = { db: {
      name: input.database.instanceName,
      project: input.projectId,
      region: input.region,
      database_version: 'POSTGRES_16',
      // Hypervibe's confirmation gate governs deletion (data-bearing, explicit confirmation).
      deletion_protection: false,
      settings: [{
        // Shared-core tiers require the Enterprise edition.
        edition: 'ENTERPRISE',
        tier: input.database.tier ?? 'db-f1-micro',
        availability_type: 'ZONAL',
        ip_configuration: [{ ipv4_enabled: true }],
        backup_configuration: [{ enabled: true, point_in_time_recovery_enabled: true }],
        user_labels: { 'managed-by': 'hypervibe', ...(input.environmentId ? { 'hv-environment': input.environmentId.toLowerCase() } : {}) },
      }],
    } };
    sql.google_sql_database = { app: {
      name: input.database.databaseName,
      project: input.projectId,
      instance: '${google_sql_database_instance.db.name}',
      // Deleting the instance removes its databases; dropping one first fails while connections exist.
      deletion_policy: 'ABANDON',
    } };
  }
  if (input.database || input.retiredDatabase) {
    for (const address of DATABASE_ENGINE_ADDRESSES) resources[address] = databaseMapping;
  }
  if (input.releaseJob) {
    addScheduledJob(input, { ...input.releaseJob, workload: 'worker' }, RELEASE_JOB_KEY, jobs, schedules, jobIam);
  }
  if (input.releaseJob || input.retiredReleaseJob) {
    resources[`google_cloud_run_v2_job.${RELEASE_JOB_KEY}`] = { actionId: 'release-job:migrations', kind: 'service', name: 'release command' };
  }
  const redis: Record<string, unknown> = {};
  const cacheMapping: EngineResourceMapping = { actionId: 'cache:redis', kind: 'cache', name: 'redis', billable: true };
  if (input.cache) {
    if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(input.cache.instanceName)) throw new Error('Memorystore instance name is invalid.');
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(input.cache.network) || !/^[a-z][a-z0-9-]{0,62}$/.test(input.cache.subnetwork)) throw new Error('Cache network names are invalid.');
    redis.cache = {
      name: input.cache.instanceName,
      project: input.projectId,
      region: input.region,
      tier: input.cache.tier,
      memory_size_gb: input.cache.memorySizeGb,
      redis_version: 'REDIS_7_2',
      authorized_network: `projects/${input.projectId}/global/networks/${input.cache.network}`,
      // AUTH stays on; the generated AUTH string lives only in encrypted engine state and in Secret Manager.
      auth_enabled: true,
      labels: { 'managed-by': 'hypervibe', ...(input.environmentId ? { 'hv-environment': input.environmentId.toLowerCase() } : {}) },
    };
  }
  if (input.cache || input.retiredCache) resources['google_redis_instance.cache'] = cacheMapping;
  const topics: Record<string, unknown> = {};
  const subscriptions: Record<string, unknown> = {};
  for (const queue of input.queues ?? []) {
    if (!/^[a-z][a-z0-9-]{0,60}$/.test(queue.name) || !/^[A-Za-z][A-Za-z0-9._~%+-]{2,254}$/.test(queue.topicId)) throw new Error(`Queue ${queue.name} has an invalid name.`);
    if (!input.runtimeServiceAccountEmail) throw new Error('Queues require the runtime identity.');
    const key = queueEngineKey(queue.name);
    const labels = { 'managed-by': 'hypervibe', 'hv-queue': queue.name, ...(input.environmentId ? { 'hv-environment': input.environmentId.toLowerCase() } : {}) };
    topics[key] = { name: queue.topicId, project: input.projectId, labels };
    subscriptions[key] = {
      name: queue.topicId, project: input.projectId, topic: `\${google_pubsub_topic.${key}.id}`,
      ack_deadline_seconds: queue.ackDeadlineSeconds ?? 60, message_retention_duration: '604800s', labels,
    };
    // Publish/subscribe access comes from the queue setup add-on's runtime grants. Per-queue
    // bindings would require Pub/Sub admin for the deployment identity, which it does not get.
  }
  for (const name of [...(input.queues ?? []).map((queue) => queue.name), ...(input.retiredQueues ?? [])]) {
    const key = queueEngineKey(name);
    // Deleting a queue discards messages still waiting in it.
    const mapping: EngineResourceMapping = { actionId: `queue:${name}`, kind: 'queue', name, dataBearing: true, billable: true };
    for (const address of [`google_pubsub_topic.${key}`, `google_pubsub_subscription.${key}`,
      // Older plans may still track these; mapping them lets their removal be reviewed.
      `google_pubsub_topic_iam_member.${key}_publisher`, `google_pubsub_subscription_iam_member.${key}_subscriber`]) resources[address] = mapping;
  }
  const buckets: Record<string, unknown> = {};
  const bucketIam: Record<string, unknown> = {};
  for (const bucket of input.storage ?? []) {
    if (!/^[a-z][a-z0-9-]{0,60}$/.test(bucket.name) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket.bucketName)) {
      throw new Error(`Storage ${bucket.name} has an invalid name.`);
    }
    if (!input.runtimeServiceAccountEmail) throw new Error('Storage access requires the runtime identity.');
    const key = storageEngineKey(bucket.name);
    buckets[key] = {
      name: bucket.bucketName,
      project: input.projectId,
      location: bucket.location.toUpperCase(),
      uniform_bucket_level_access: true,
      public_access_prevention: 'enforced',
      // Never delete objects implicitly: a non-empty bucket blocks deletion until the user empties it.
      force_destroy: false,
      labels: { 'managed-by': 'hypervibe', 'hv-storage': bucket.name, ...(input.environmentId ? { 'hv-environment': input.environmentId.toLowerCase() } : {}) },
    };
    bucketIam[`${key}_runtime`] = {
      bucket: `\${google_storage_bucket.${key}.name}`,
      role: 'roles/storage.objectUser',
      member: `serviceAccount:${input.runtimeServiceAccountEmail}`,
    };
  }
  for (const name of [...(input.storage ?? []).map((bucket) => bucket.name), ...(input.retiredStorage ?? [])]) {
    const key = storageEngineKey(name);
    const mapping: EngineResourceMapping = { actionId: `storage:${name}`, kind: 'storage', name, dataBearing: true, billable: true };
    resources[`google_storage_bucket.${key}`] = mapping;
    resources[`google_storage_bucket_iam_member.${key}_runtime`] = mapping;
  }
  const domainMappings: Record<string, unknown> = {};
  for (const { domain, service } of input.domains ?? []) {
    if (!DOMAIN_PATTERN.test(domain)) throw new Error(`Domain ${domain} is invalid.`);
    const serviceKey = engineKey(service);
    if (!services[serviceKey]) throw new Error(`Domain ${domain} targets undeclared service ${service}.`);
    const key = domainEngineKey(domain);
    domainMappings[key] = {
      location: input.region,
      name: domain,
      metadata: [{ namespace: input.projectId }],
      spec: [{ route_name: `\${google_cloud_run_v2_service.${serviceKey}.name}` }],
    };
    resources[`google_cloud_run_domain_mapping.${key}`] = { actionId: `domain:${domain}`, kind: 'domain', name: domain };
  }
  for (const domain of input.retiredDomains ?? []) {
    const key = domainEngineKey(domain);
    resources[`google_cloud_run_domain_mapping.${key}`] ??= { actionId: `domain:${domain}`, kind: 'domain', name: domain };
  }
  for (const retired of input.retiredServices ?? []) {
    const key = engineKey(retired);
    if (seen.has(key)) continue;
    const mapping: EngineResourceMapping = { actionId: `service:${retired}`, kind: 'service', name: retired };
    resources[`google_cloud_run_v2_service.${key}`] = mapping;
    resources[`google_cloud_run_v2_service_iam_member.${key}_public`] = mapping;
    for (const address of jobAddresses(key)) resources[address] = mapping;
  }
  const imports: Record<string, string> = {};
  if (input.adopt?.databaseInstance) {
    if (input.adopt.databaseInstance !== input.database?.instanceName) throw new Error('Only the desired database instance can be adopted.');
    imports['google_sql_database_instance.db'] = `projects/${input.projectId}/instances/${input.adopt.databaseInstance}`;
  }
  for (const name of input.adopt?.buckets ?? []) {
    const bucket = (input.storage ?? []).find((entry) => entry.name === name);
    if (!bucket) throw new Error(`Only desired storage can be adopted (${name}).`);
    imports[`google_storage_bucket.${storageEngineKey(name)}`] = bucket.bucketName;
  }
  return {
    ...(Object.keys(imports).length ? { imports } : {}),
    files: {
      ...(Object.keys(imports).length ? { 'imports.tf.json': { import: Object.entries(imports).map(([to, id]) => ({ to, id })) } } : {}),
      'provider.tf.json': { provider: { google: [{ project: input.projectId, region: input.region }] } },
      // An environment with no services is valid desired state (teardown); OpenTofu rejects an empty resource block.
      'jobs.tf.json': Object.keys(jobs).length ? {
        resource: {
          google_cloud_run_v2_job: jobs,
          ...(Object.keys(schedules).length ? { google_cloud_scheduler_job: schedules } : {}),
          ...(Object.keys(jobIam).length ? { google_cloud_run_v2_job_iam_member: jobIam } : {}),
        },
      } : {},
      'cloudrun.tf.json': Object.keys(services).length ? {
        resource: {
          google_cloud_run_v2_service: services,
          ...(Object.keys(iam).length ? { google_cloud_run_v2_service_iam_member: iam } : {}),
          ...(Object.keys(domainMappings).length ? { google_cloud_run_domain_mapping: domainMappings } : {}),
        },
      } : {},
      'cloudsql.tf.json': Object.keys(sql).length ? { resource: sql } : {},
      'memorystore.tf.json': Object.keys(redis).length ? { resource: { google_redis_instance: redis } } : {},
      'pubsub.tf.json': Object.keys(topics).length ? { resource: { google_pubsub_topic: topics, google_pubsub_subscription: subscriptions } } : {},
      'storage.tf.json': Object.keys(buckets).length ? {
        resource: { google_storage_bucket: buckets, google_storage_bucket_iam_member: bucketIam },
      } : {},
    },
    resources,
  };
}

/** Builds engine process credentials from a saved GCP connection. */
export function gcpEngineAuthentication(connection: { projectId: string; credentials: string }): EngineAuthentication {
  let parsed: { type?: string; private_key?: string; client_email?: string };
  try {
    parsed = JSON.parse(connection.credentials);
  } catch {
    throw new Error('The GCP connection credential is not valid JSON.');
  }
  if (parsed.type !== 'service_account' || !parsed.private_key || !parsed.client_email) {
    throw new Error('The GCP connection must hold a Hypervibe-generated deployment service account.');
  }
  return {
    env: { GOOGLE_CREDENTIALS: connection.credentials, GOOGLE_PROJECT: connection.projectId },
    redact: [connection.credentials, parsed.private_key],
  };
}

export const gcpEngineBackend: InfrastructureEngineBackend<GcpCloudRunEngineInput> = {
  provider: 'gcp',
  engine: 'opentofu',
  capabilities: ['hosting'],
  providerRequirements: {
    google: { source: 'hashicorp/google', version: GOOGLE_PROVIDER_VERSION, lockHashes: GOOGLE_PROVIDER_LOCK_HASHES },
  },
  buildConfiguration: buildCloudRunConfiguration,
  buildAuthenticationProbe: ({ projectId }) => ({
    files: {
      'provider.tf.json': { provider: { google: [{ project: projectId }] } },
      'probe.tf.json': {
        data: {
          google_client_openid_userinfo: { identity: {} },
          google_project: { target: { project_id: projectId } },
        },
        output: {
          identity: { value: '${data.google_client_openid_userinfo.identity.email}' },
          project_id: { value: '${data.google_project.target.project_id}' },
          project_number: { value: '${data.google_project.target.number}' },
        },
      },
    },
    resources: {},
  }),
};

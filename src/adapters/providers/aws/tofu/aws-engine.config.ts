import { LOAD_SECRETS_PATH } from '../runtime/load-secrets.js';
import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { addTasks } from './aws-engine.tasks.js';

/**
 * Pure OpenTofu configuration for one AWS environment. Values are non-secret:
 * runtime secrets live in SSM Parameter Store (written by Hypervibe, read by
 * the app's image at start), and the database master password is managed by
 * RDS itself, so no secret ever enters engine state.
 */
export interface AwsEngineInput {
  accountId: string;
  region: string;
  /** Short stable prefix for physical names, e.g. `hv-billforge-aws`. */
  prefix: string;
  /** Environment id stamped on owned resources so adoption can prove ownership. */
  environmentId: string;
  /** SSM path holding this environment's runtime secrets, e.g. `/hypervibe/<env-id>/`. */
  parameterPath: string;
  database?: AwsDatabaseInput;
  storage?: Array<{ name: string; bucket: string }>;
  /** Web services on Lambda (container image with the Lambda Web Adapter). */
  services?: AwsWebServiceInput[];
  /** Background workers on Fargate; on-demand ones sit at zero tasks until there is work. */
  workers?: AwsWorkerInput[];
  /** Scheduled jobs: EventBridge Scheduler runs a Fargate task. */
  jobs?: AwsJobInput[];
  /** Names of the runtime secrets under parameterPath, wired into Fargate tasks by reference. */
  secretKeys?: string[];
}

export interface AwsTaskInput {
  logicalName: string;
  resourceName: string;
  /** Image for first creation (in this environment's registry); the release path owns it afterwards. */
  initialImageUri: string;
  /** Fargate CPU units (256 = 0.25 vCPU) and memory in MB. */
  cpu?: number;
  memory?: number;
  command?: string[];
  env?: Record<string, string>;
}

export interface AwsWorkerInput extends AwsTaskInput {
  /** Run only while this read-only count of pending work is above zero (uses the Aurora Data API). */
  pendingWorkQuery?: string;
  /** Earliest time future work is due; the waker sets a one-time wake for it so a paused database can stay paused. */
  nextWorkAtQuery?: string;
}

export interface AwsJobInput extends AwsTaskInput {
  /** Five-field cron schedule and IANA time zone. */
  schedule: string;
  timeZone?: string;
}

/** Converts a five-field cron to EventBridge Scheduler's six-field form (day-of-week 1-7, one day field '?'). */
export function schedulerCron(schedule: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Schedule "${schedule}" must have five fields.`);
  let [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  dayOfWeek = dayOfWeek.replace(/\d+/g, (day) => String((Number(day) % 7) + 1));
  if (dayOfWeek === '*') dayOfWeek = '?';
  else if (dayOfMonth === '*') dayOfMonth = '?';
  else throw new Error(`Schedule "${schedule}" sets both day of month and day of week, which EventBridge Scheduler does not support.`);
  return `cron(${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek} *)`;
}

export interface AwsWebServiceInput {
  logicalName: string;
  /** Physical function name. */
  resourceName: string;
  /**
   * Image for first creation, already pushed to this environment's registry.
   * Afterwards the release path owns the image and plans ignore it.
   */
  initialImageUri: string;
  /** MB; Lambda CPU scales with memory. */
  memory?: number;
  /** Seconds per request (up to 900). */
  timeout?: number;
  /** Non-secret configuration only; secrets are read from the parameter path at start. */
  env?: Record<string, string>;
  public: boolean;
  healthCheckPath?: string;
}

export interface AwsDatabaseInput {
  /** Exact Aurora PostgreSQL version, the newest minor AWS offers for the spec's major (read at plan time). */
  engineVersion: string;
  /** 0 pauses when idle (staging); production uses at least 0.5. */
  minCapacity: number;
  maxCapacity: number;
  /** The engine already requires TLS by default (rds.force_ssl=1); setting the default again never sticks and drifts. */
  tlsRequiredByDefault?: boolean;
  /** Seconds idle before pausing when minCapacity is 0. */
  pauseAfterSeconds?: number;
}

export const awsKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

export function buildAwsConfiguration(input: AwsEngineInput): EngineConfiguration {
  if (!/^\d{12}$/.test(input.accountId)) throw new Error('AWS account id is invalid.');
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(input.region)) throw new Error('AWS region is invalid.');
  if (!/^[a-z][a-z0-9-]{2,30}$/.test(input.prefix)) throw new Error('AWS name prefix is invalid.');
  const tags = { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() };
  const resources: Record<string, EngineResourceMapping> = {};
  const files: Record<string, unknown> = {
    'provider.tf.json': { provider: { aws: [{ region: input.region, allowed_account_ids: [input.accountId], default_tags: [{ tags }] }] } },
  };

  // Image registry and the app's runtime role (capped by the setup boundary).
  const registry = { actionId: 'registry:images', kind: 'service' as const, name: 'images' };
  const runtime = { actionId: 'identity:runtime', kind: 'service' as const, name: 'runtime' };
  resources['aws_ecr_repository.images'] = registry;
  resources['aws_ecr_lifecycle_policy.images'] = registry;
  resources['aws_iam_role.runtime'] = runtime;
  resources['aws_iam_role_policy.runtime'] = runtime;
  const buckets = input.storage ?? [];
  const runtimeStatements: unknown[] = [
    { Sid: 'Logs', Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' },
    { Sid: 'Secrets', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      Resource: `arn:aws:ssm:${input.region}:${input.accountId}:parameter${input.parameterPath.replace(/\/$/, '')}/*` },
    { Sid: 'DecryptSecrets', Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*', Condition: { StringEquals: { 'kms:ViaService': `ssm.${input.region}.amazonaws.com` } } },
    { Sid: 'PullImages', Effect: 'Allow', Action: ['ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], Resource: '*' },
    ...(buckets.length ? [{ Sid: 'Storage', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      Resource: buckets.flatMap((bucket) => [`arn:aws:s3:::${bucket.bucket}`, `arn:aws:s3:::${bucket.bucket}/*`]) }] : []),
  ];
  const account = `${input.region}:${input.accountId}`;
  const runtimeRoleArn = `arn:aws:iam::${input.accountId}:role/hypervibe/app/${input.prefix}-runtime`;
  const onDemand = (input.workers ?? []).some((worker) => worker.pendingWorkQuery);
  if ((input.jobs ?? []).length || onDemand) {
    // Schedules start this environment's tasks and wakers, handing them only this role.
    runtimeStatements.push(
      { Sid: 'RunTasks', Effect: 'Allow', Action: 'ecs:RunTask', Resource: `arn:aws:ecs:${account}:task-definition/${input.prefix}-*` },
      { Sid: 'StartWakers', Effect: 'Allow', Action: 'states:StartExecution', Resource: `arn:aws:states:${account}:stateMachine:${input.prefix}-*` },
      { Sid: 'PassSelf', Effect: 'Allow', Action: 'iam:PassRole', Resource: runtimeRoleArn },
    );
  }
  if (onDemand) {
    runtimeStatements.push(
      { Sid: 'WakerCount', Effect: 'Allow', Action: 'rds-data:ExecuteStatement', Resource: `arn:aws:rds:${account}:cluster:${input.prefix}-postgres` },
      { Sid: 'WakerLogin', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:${account}:secret:hypervibe/${input.prefix}/*` },
      { Sid: 'WakerScale', Effect: 'Allow', Action: ['ecs:UpdateService', 'ecs:DescribeServices'], Resource: `arn:aws:ecs:${account}:service/${input.prefix}/*` },
      { Sid: 'WakerTimer', Effect: 'Allow', Action: 'scheduler:UpdateSchedule', Resource: `arn:aws:scheduler:${account}:schedule/default/${input.prefix}-*` },
      { Sid: 'WakerDatabaseAwake', Effect: 'Allow', Action: 'cloudwatch:GetMetricData', Resource: '*' },
    );
  }
  files['base.tf.json'] = {
    // The default VPC: databases and tasks use its public subnets (no NAT gateway).
    data: { aws_vpc: { default: { default: true } }, aws_subnets: { default: { filter: [{ name: 'vpc-id', values: ['${data.aws_vpc.default.id}'] }] } } },
    resource: {
      aws_ecr_repository: { images: { name: input.prefix, image_tag_mutability: 'IMMUTABLE', force_delete: true, image_scanning_configuration: [{ scan_on_push: true }] } },
      aws_ecr_lifecycle_policy: { images: { repository: '${aws_ecr_repository.images.name}', policy: JSON.stringify({
        rules: [{ rulePriority: 1, description: 'Keep the last 10 images', selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 10 }, action: { type: 'expire' } }],
      }) } },
      aws_iam_role: { runtime: {
        name: `${input.prefix}-runtime`, path: '/hypervibe/app/',
        permissions_boundary: `arn:aws:iam::${input.accountId}:policy/hypervibe/hypervibe-app-boundary`,
        assume_role_policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole',
          Principal: { Service: ['lambda.amazonaws.com', 'ecs-tasks.amazonaws.com', 'scheduler.amazonaws.com', 'states.amazonaws.com'] } }] }),
      } },
      aws_iam_role_policy: { runtime: { name: 'runtime', role: '${aws_iam_role.runtime.id}', policy: JSON.stringify({ Version: '2012-10-17', Statement: runtimeStatements }) } },
    },
  };

  // Storage: private buckets, objects encrypted, no public access.
  if (buckets.length) {
    const bucketResources: Record<string, Record<string, unknown>> = { aws_s3_bucket: {}, aws_s3_bucket_public_access_block: {}, aws_s3_bucket_ownership_controls: {} };
    for (const bucket of buckets) {
      const key = awsKey(bucket.name);
      const mapping: EngineResourceMapping = { actionId: `storage:${bucket.name}`, kind: 'storage', name: bucket.name, dataBearing: true, billable: true };
      bucketResources.aws_s3_bucket![key] = { bucket: bucket.bucket, force_destroy: false };
      bucketResources.aws_s3_bucket_public_access_block![key] = { bucket: `\${aws_s3_bucket.${key}.id}`, block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true };
      bucketResources.aws_s3_bucket_ownership_controls![key] = { bucket: `\${aws_s3_bucket.${key}.id}`, rule: [{ object_ownership: 'BucketOwnerEnforced' }] };
      for (const type of Object.keys(bucketResources)) resources[`${type}.${key}`] = mapping;
    }
    files['storage.tf.json'] = { resource: bucketResources };
  }

  // Database: Aurora Serverless v2 on a public, TLS-only endpoint (see docs/opentofu-engine-aws.md).
  if (input.database) {
    const version = input.database.engineVersion;
    if (!/^\d+\.\d+$/.test(version)) throw new Error(`Aurora PostgreSQL version ${version} is invalid.`);
    const major = version.split('.')[0];
    const mapping: EngineResourceMapping = { actionId: 'database:postgres', kind: 'database', name: 'postgres', dataBearing: true, billable: true };
    for (const address of ['aws_rds_cluster.postgres', 'aws_rds_cluster_instance.postgres', 'aws_rds_cluster_parameter_group.postgres', 'aws_db_subnet_group.postgres', 'aws_security_group.postgres']) {
      resources[address] = mapping;
    }
    files['database.tf.json'] = {
      resource: {
        aws_security_group: { postgres: { name: `${input.prefix}-postgres`, description: 'Hypervibe: Postgres over TLS', vpc_id: '${data.aws_vpc.default.id}',
          ingress: [{ description: 'Postgres (TLS required by the cluster)', from_port: 5432, to_port: 5432, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'], ipv6_cidr_blocks: [], prefix_list_ids: [], security_groups: [], self: false }],
          egress: [] } },
        aws_db_subnet_group: { postgres: { name: `${input.prefix}-postgres`, subnet_ids: '${data.aws_subnets.default.ids}' } },
        aws_rds_cluster_parameter_group: { postgres: { name: `${input.prefix}-postgres`, family: `aurora-postgresql${major}`,
          ...(input.database.tlsRequiredByDefault ? {} : { parameter: [{ name: 'rds.force_ssl', value: '1' }] }) } },
        aws_rds_cluster: { postgres: {
          cluster_identifier: `${input.prefix}-postgres`, engine: 'aurora-postgresql', engine_mode: 'provisioned', engine_version: version,
          database_name: 'app', master_username: 'hvadmin',
          // RDS keeps the master password in Secrets Manager; it never enters engine state.
          manage_master_user_password: true,
          enable_http_endpoint: true, iam_database_authentication_enabled: true,
          db_subnet_group_name: '${aws_db_subnet_group.postgres.name}', vpc_security_group_ids: ['${aws_security_group.postgres.id}'],
          db_cluster_parameter_group_name: '${aws_rds_cluster_parameter_group.postgres.name}',
          storage_encrypted: true, backup_retention_period: 1, copy_tags_to_snapshot: true,
          deletion_protection: false, skip_final_snapshot: false, final_snapshot_identifier: `${input.prefix}-postgres-final`,
          serverlessv2_scaling_configuration: [{ min_capacity: input.database.minCapacity, max_capacity: input.database.maxCapacity,
            ...(input.database.minCapacity === 0 ? { seconds_until_auto_pause: input.database.pauseAfterSeconds ?? 600 } : {}) }],
          lifecycle: [{ ignore_changes: ['engine_version'] }],
        } },
        aws_rds_cluster_instance: { postgres: {
          identifier: `${input.prefix}-postgres-1`, cluster_identifier: '${aws_rds_cluster.postgres.id}', instance_class: 'db.serverless',
          engine: '${aws_rds_cluster.postgres.engine}', engine_version: '${aws_rds_cluster.postgres.engine_version}',
          publicly_accessible: true, db_subnet_group_name: '${aws_db_subnet_group.postgres.name}',
        } },
      },
      output: {
        database_endpoint: { value: '${aws_rds_cluster.postgres.endpoint}' },
        database_cluster_arn: { value: '${aws_rds_cluster.postgres.arn}' },
        database_master_secret_arn: { value: '${aws_rds_cluster.postgres.master_user_secret[0].secret_arn}' },
      },
    };
  }

  // Image builds: CodeBuild reads a source archive Hypervibe uploads and pushes to the registry.
  const builds: EngineResourceMapping = { actionId: 'builds:images', kind: 'service', name: 'builds' };
  for (const address of ['aws_s3_bucket.build_source', 'aws_s3_bucket_public_access_block.build_source', 'aws_s3_bucket_lifecycle_configuration.build_source',
    'aws_iam_role.build', 'aws_iam_role_policy.build', 'aws_codebuild_project.images']) resources[address] = builds;
  files['builds.tf.json'] = { resource: {
    aws_s3_bucket: { build_source: { bucket: `${input.prefix}-build-${input.accountId}`, force_destroy: true } },
    aws_s3_bucket_public_access_block: { build_source: { bucket: '${aws_s3_bucket.build_source.id}', block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true } },
    aws_s3_bucket_lifecycle_configuration: { build_source: { bucket: '${aws_s3_bucket.build_source.id}', rule: [{ id: 'expire-sources', status: 'Enabled', filter: [{}], expiration: [{ days: 7 }] }] } },
    aws_iam_role: { build: {
      name: `${input.prefix}-build`, path: '/hypervibe/app/', permissions_boundary: `arn:aws:iam::${input.accountId}:policy/hypervibe/hypervibe-app-boundary`,
      assume_role_policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'codebuild.amazonaws.com' } }] }),
    } },
    aws_iam_role_policy: { build: { name: 'build', role: '${aws_iam_role.build.id}', policy: JSON.stringify({ Version: '2012-10-17', Statement: [
      { Sid: 'Logs', Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' },
      { Sid: 'Source', Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: `arn:aws:s3:::${input.prefix}-build-${input.accountId}/*` },
      { Sid: 'Login', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
      { Sid: 'Push', Effect: 'Allow', Resource: `arn:aws:ecr:${input.region}:${input.accountId}:repository/${input.prefix}`, Action: [
        'ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'] },
    ] }) } },
    aws_codebuild_project: { images: {
      name: `${input.prefix}-images`, service_role: '${aws_iam_role.build.arn}', build_timeout: 30,
      artifacts: [{ type: 'NO_ARTIFACTS' }],
      environment: [{ compute_type: 'BUILD_GENERAL1_SMALL', image: 'aws/codebuild/amazonlinux-x86_64-standard:5.0', type: 'LINUX_CONTAINER', privileged_mode: true,
        environment_variable: [{ name: 'REGISTRY', value: '${aws_ecr_repository.images.repository_url}' }] }],
      // Hypervibe uploads source.zip with its generated Dockerfile and starts builds with an IMAGE_TAG override.
      source: [{ type: 'S3', location: `${input.prefix}-build-${input.accountId}/source.zip`, buildspec: JSON.stringify({
        version: '0.2',
        phases: {
          pre_build: { commands: ['aws ecr get-login-password | docker login --username AWS --password-stdin "${REGISTRY%%/*}"'] },
          build: { commands: ['docker build --platform linux/amd64 -f "${DOCKERFILE:-Dockerfile}" -t "$REGISTRY:$IMAGE_TAG" .', 'docker push "$REGISTRY:$IMAGE_TAG"'] },
        },
      }).replace(/\$\{/g, () => '$${') }],
      logs_config: [{ cloudwatch_logs: [{ status: 'ENABLED', group_name: `/hypervibe/${input.prefix}/builds` }] }],
    } },
  } };

  // Web services: Lambda behind a function URL; requests reach the app through the Lambda Web Adapter.
  const services = input.services ?? [];
  if (services.length) {
    const functions: Record<string, unknown> = {};
    const urls: Record<string, unknown> = {};
    const permissions: Record<string, unknown> = {};
    const logGroups: Record<string, unknown> = {};
    const outputs: Record<string, unknown> = {};
    for (const service of services) {
      const key = awsKey(service.logicalName);
      const mapping: EngineResourceMapping = { actionId: `service:${service.logicalName}`, kind: 'service', name: service.logicalName, billable: true };
      logGroups[key] = { name: `/aws/lambda/${service.resourceName}`, retention_in_days: 30 };
      functions[key] = {
        function_name: service.resourceName, role: '${aws_iam_role.runtime.arn}', package_type: 'Image', image_uri: service.initialImageUri,
        memory_size: service.memory ?? 1024, timeout: service.timeout ?? 60, architectures: ['x86_64'],
        environment: [{ variables: {
          ...service.env, HYPERVIBE_PARAMETER_PATH: input.parameterPath,
          // The image's loader reads secrets from Parameter Store before the app starts; npm writes only to /tmp.
          NODE_OPTIONS: `--require ${LOAD_SECRETS_PATH}`, NPM_CONFIG_CACHE: '/tmp/.npm',
          AWS_LWA_PORT: service.env?.PORT ?? '8080', ...(service.healthCheckPath ? { AWS_LWA_READINESS_CHECK_PATH: service.healthCheckPath } : {}),
        } }],
        depends_on: [`aws_cloudwatch_log_group.${key}`, 'aws_iam_role_policy.runtime'],
        // The release path (CI or hv_deploy) owns the image after creation.
        lifecycle: [{ ignore_changes: ['image_uri'] }],
      };
      urls[key] = { function_name: `\${aws_lambda_function.${key}.function_name}`, authorization_type: service.public ? 'NONE' : 'AWS_IAM', invoke_mode: 'RESPONSE_STREAM' };
      for (const address of [`aws_cloudwatch_log_group.${key}`, `aws_lambda_function.${key}`, `aws_lambda_function_url.${key}`]) resources[address] = mapping;
      if (service.public) {
        // Public function URLs need both permissions (Lambda requires InvokeFunction alongside InvokeFunctionUrl).
        permissions[`${key}_url`] = { statement_id: 'public-url', action: 'lambda:InvokeFunctionUrl', function_name: `\${aws_lambda_function.${key}.function_name}`, principal: '*', function_url_auth_type: 'NONE' };
        permissions[`${key}_invoke`] = { statement_id: 'public-invoke', action: 'lambda:InvokeFunction', function_name: `\${aws_lambda_function.${key}.function_name}`, principal: '*' };
        resources[`aws_lambda_permission.${key}_url`] = mapping;
        resources[`aws_lambda_permission.${key}_invoke`] = mapping;
      }
      outputs[`service_${key}_url`] = { value: `\${aws_lambda_function_url.${key}.function_url}` };
    }
    files['services.tf.json'] = {
      resource: { aws_cloudwatch_log_group: logGroups, aws_lambda_function: functions, aws_lambda_function_url: urls, ...(Object.keys(permissions).length ? { aws_lambda_permission: permissions } : {}) },
      output: outputs,
    };
  }

  addTasks(input, files, resources);

  files['outputs.tf.json'] = { output: {
    registry_url: { value: '${aws_ecr_repository.images.repository_url}' },
    runtime_role_arn: { value: '${aws_iam_role.runtime.arn}' },
    build_project: { value: '${aws_codebuild_project.images.name}' },
    build_source_bucket: { value: '${aws_s3_bucket.build_source.id}' },
  } };
  return { files, resources };
}

import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';

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
}

export interface AwsDatabaseInput {
  /** Exact Aurora PostgreSQL version, the newest minor AWS offers for the spec's major (read at plan time). */
  engineVersion: string;
  /** 0 pauses when idle (staging); production uses at least 0.5. */
  minCapacity: number;
  maxCapacity: number;
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
  files['base.tf.json'] = {
    resource: {
      aws_ecr_repository: { images: { name: input.prefix, image_tag_mutability: 'IMMUTABLE', force_delete: true, image_scanning_configuration: [{ scan_on_push: true }] } },
      aws_ecr_lifecycle_policy: { images: { repository: '${aws_ecr_repository.images.name}', policy: JSON.stringify({
        rules: [{ rulePriority: 1, description: 'Keep the last 10 images', selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 10 }, action: { type: 'expire' } }],
      }) } },
      aws_iam_role: { runtime: {
        name: `${input.prefix}-runtime`, path: '/hypervibe/app/',
        permissions_boundary: `arn:aws:iam::${input.accountId}:policy/hypervibe/hypervibe-app-boundary`,
        assume_role_policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole',
          Principal: { Service: ['lambda.amazonaws.com', 'ecs-tasks.amazonaws.com', 'scheduler.amazonaws.com'] } }] }),
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
      data: { aws_vpc: { default: { default: true } }, aws_subnets: { default: { filter: [{ name: 'vpc-id', values: ['${data.aws_vpc.default.id}'] }] } } },
      resource: {
        aws_security_group: { postgres: { name: `${input.prefix}-postgres`, description: 'Hypervibe: Postgres over TLS', vpc_id: '${data.aws_vpc.default.id}',
          ingress: [{ description: 'Postgres (TLS required by the cluster)', from_port: 5432, to_port: 5432, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'], ipv6_cidr_blocks: [], prefix_list_ids: [], security_groups: [], self: false }],
          egress: [] } },
        aws_db_subnet_group: { postgres: { name: `${input.prefix}-postgres`, subnet_ids: '${data.aws_subnets.default.ids}' } },
        aws_rds_cluster_parameter_group: { postgres: { name: `${input.prefix}-postgres`, family: `aurora-postgresql${major}`,
          parameter: [{ name: 'rds.force_ssl', value: '1' }] } },
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

  files['outputs.tf.json'] = { output: {
    registry_url: { value: '${aws_ecr_repository.images.repository_url}' },
    runtime_role_arn: { value: '${aws_iam_role.runtime.arn}' },
  } };
  return { files, resources };
}

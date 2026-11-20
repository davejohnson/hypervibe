import { describe, expect, it } from 'vitest';
import { awsRegistryUrl, awsSharedClusterArn, buildAwsBuildConfiguration, buildAwsConfiguration, buildAwsSharedConfiguration, schedulerCron } from '../aws-engine.config.js';

const base = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-aws', environmentId: 'ENV1', parameterPath: '/hypervibe/env1/' };

describe('AWS engine configuration', () => {
  it('keeps the database off the internet and TLS-only, its password out of state, and its deletion confirmable', () => {
    const config = buildAwsSharedConfiguration({ accountId: base.accountId, region: base.region, prefix: 'hv-app-shared', environmentId: 'shared-testing',
      database: { engineVersion: '18.6', minCapacity: 0, maxCapacity: 2 } });
    const database = config.files['database.tf.json'] as { resource: Record<string, Record<string, Record<string, unknown>>> };
    const cluster = database.resource.aws_rds_cluster!.postgres!;
    expect(cluster.manage_master_user_password).toBe(true);
    expect(cluster).not.toHaveProperty('master_password');
    // No route from the internet (#728): no public address, and the port opens only to the environment's own network.
    expect(database.resource.aws_rds_cluster_instance!.postgres!.publicly_accessible).toBe(false);
    const ingress = (database.resource.aws_security_group!.postgres!.ingress as Array<{ cidr_blocks: string[]; ipv6_cidr_blocks: string[] }>);
    expect(ingress.map((rule) => rule.cidr_blocks)).toEqual([['${data.aws_vpc.default.cidr_block}']]);
    expect(JSON.stringify(database)).not.toMatch(/0\.0\.0\.0\/0|::\/0/);
    expect(database.resource.aws_rds_cluster_parameter_group!.postgres!.parameter).toEqual([{ name: 'rds.force_ssl', value: '1' }]);
    expect(cluster.serverlessv2_scaling_configuration).toEqual([{ min_capacity: 0, max_capacity: 2, seconds_until_auto_pause: 600 }]);
    expect(config.resources['aws_rds_cluster.postgres']).toMatchObject({ actionId: 'shared:database', dataBearing: true, billable: true });
    // Each testing environment creates its own database on it.
    expect(cluster).not.toHaveProperty('database_name');
    expect(awsSharedClusterArn({ ...base, prefix: 'hv-app-shared' })).toBe('arn:aws:rds:us-west-2:111122223333:cluster:hv-app-shared-postgres');
  });

  it('enables recoverable versions and signed browser uploads only for the selected private S3 bucket', () => {
    const config = buildAwsConfiguration({ ...base, storage: [
      { name: 'docs', bucket: 'example-docs', versioning: true, browserUploads: true },
      { name: 'scratch', bucket: 'example-scratch' },
    ] });
    const { resource } = config.files['storage.tf.json'] as { resource: Record<string, Record<string, unknown>> };
    expect(resource.aws_s3_bucket_versioning).toEqual({ docs: { bucket: '${aws_s3_bucket.docs.id}', versioning_configuration: [{ status: 'Enabled' }] } });
    expect(resource.aws_s3_bucket_lifecycle_configuration?.docs).toMatchObject({ rule: [{ status: 'Enabled', noncurrent_version_expiration: [{ noncurrent_days: 30 }] }] });
    expect(resource.aws_s3_bucket_cors_configuration?.docs).toMatchObject({ cors_rule: [{ allowed_methods: ['PUT', 'POST', 'GET', 'HEAD'], allowed_origins: ['*'] }] });
    expect(resource.aws_s3_bucket_public_access_block?.docs).toMatchObject({ block_public_acls: true, block_public_policy: true });
    for (const type of ['aws_s3_bucket_versioning', 'aws_s3_bucket_lifecycle_configuration', 'aws_s3_bucket_cors_configuration']) {
      expect(resource[type]?.scratch).toBeUndefined();
      expect(config.resources[`${type}.docs`]).toMatchObject({ actionId: 'storage:docs', dataBearing: true });
    }
  });

  it('caps the runtime role with the setup boundary and scopes secrets to the environment', () => {
    const config = buildAwsConfiguration({ ...base, secretKeys: ['API_KEY'], storage: [{ name: 'documents', bucket: 'hv-app-aws-documents' }] });
    const role = (config.files['base.tf.json'] as { resource: { aws_iam_role: { runtime: Record<string, string> }; aws_iam_role_policy: { runtime: { policy: string } } } }).resource;
    expect(role.aws_iam_role.runtime.path).toBe('/hypervibe/app/');
    expect(role.aws_iam_role.runtime.permissions_boundary).toBe('arn:aws:iam::111122223333:policy/hypervibe/hypervibe-app-boundary');
    const statements: Array<{ Action: string[] | string; Resource: unknown }> = JSON.parse(role.aws_iam_role_policy.runtime.policy).Statement;
    const parameterPermissions = statements.filter(statement => [statement.Action].flat().some(action => action === '*' || action.startsWith('ssm:')));
    expect(parameterPermissions).toEqual([{ Sid: 'Secrets', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters'],
      Resource: ['arn:aws:ssm:us-west-2:111122223333:parameter/hypervibe/env1/API_KEY'] }]);
    expect(config.resources['aws_s3_bucket.documents']).toMatchObject({ dataBearing: true });
  });
});

describe('AWS image builds', () => {
  it('keep the registry and build project in their own state, so the first image is built before the services', () => {
    const build = buildAwsBuildConfiguration(base);
    const environment = buildAwsConfiguration(base);
    for (const address of ['aws_ecr_repository.images', 'aws_codebuild_project.images', 'aws_iam_role.build']) {
      expect(build.resources[address]).toBeDefined();
      expect(environment.resources[address]).toBeUndefined();
    }
    expect(JSON.stringify(environment.files)).not.toContain('aws_ecr_repository');
    expect(awsRegistryUrl(base)).toBe('111122223333.dkr.ecr.us-west-2.amazonaws.com/hv-app-aws');
  });
});

describe('AWS web services', () => {
  it('runs a public web service as an Express Mode container service with secrets by reference and the release path owning its image', () => {
    const config = buildAwsConfiguration({ ...base, secretKeys: ['API_KEY'], services: [{ logicalName: 'web', resourceName: 'hv-app-aws-web', initialImageUri: 'x', public: true,
      healthCheckPath: '/health', env: { AWS_S3_BUCKET_NAME: 'b', APP_VERSION: 'v1' } }] });
    expect(JSON.stringify(config.files)).not.toMatch(/aws_lambda|lambda\.amazonaws\.com/);
    const tasks = (config.files['tasks.tf.json'] as { resource: Record<string, Record<string, Record<string, any>>>; output: Record<string, { value: string }> });
    const service = tasks.resource.aws_ecs_express_gateway_service!.web!;
    expect(service).toMatchObject({
      service_name: 'hv-app-aws-web', cluster: '${aws_ecs_cluster.main.name}', health_check_path: '/health', wait_for_steady_state: true,
      infrastructure_role_arn: 'arn:aws:iam::111122223333:role/hypervibe/hypervibe-web-infrastructure',
      execution_role_arn: '${aws_iam_role.runtime.arn}', task_role_arn: '${aws_iam_role.runtime.arn}',
      scaling_target: [{ min_task_count: 1, max_task_count: 3 }],
      lifecycle: [{ ignore_changes: ['primary_container[0].image'] }],
    });
    const container = service.primary_container[0];
    expect(container.container_port).toBe(8080);
    expect(container.environment).toEqual(expect.arrayContaining([{ name: 'PORT', value: '8080' }, { name: 'APP_VERSION', value: 'v1' }, { name: 'HYPERVIBE_PARAMETER_PATH', value: '/hypervibe/env1/' }]));
    expect(container.secret).toEqual([{ name: 'API_KEY', value_from: 'arn:aws:ssm:us-west-2:111122223333:parameter/hypervibe/env1/API_KEY' }]);
    // Containers have a public address for outbound calls, but accept web traffic only from inside the network (the load balancer).
    expect(service.network_configuration[0].security_groups).toEqual(['${aws_security_group.tasks.id}']);
    expect(tasks.resource.aws_security_group!.tasks!.ingress).toMatchObject([{ from_port: 8080, to_port: 8080, cidr_blocks: ['${data.aws_vpc.default.cidr_block}'] }]);
    expect(tasks.resource.aws_ecs_cluster_capacity_providers!.main).toMatchObject({ capacity_providers: ['FARGATE'] });
    expect(tasks.output.service_web_url!.value).toBe('${aws_ecs_express_gateway_service.web.ingress_paths[0].endpoint}');
    expect(config.resources['aws_ecs_express_gateway_service.web']).toMatchObject({ actionId: 'service:web', billable: true });
    // An environment created on Lambda moves over in one reviewed replacement instead of blocking on resources the plan no longer declares.
    for (const address of ['aws_lambda_function.web', 'aws_lambda_function_url.web', 'aws_lambda_permission.web_url', 'aws_lambda_permission.web_invoke', 'aws_cloudwatch_log_group.web']) {
      expect(config.resources[address]).toMatchObject({ actionId: 'service:web' });
    }
  });

  it('runs a private web service as an ordinary service with no route from the internet', () => {
    const config = buildAwsConfiguration({ ...base, services: [{ logicalName: 'api', resourceName: 'hv-app-aws-api', initialImageUri: 'x', public: false, env: { PORT: '3000' } }] });
    const tasks = (config.files['tasks.tf.json'] as { resource: Record<string, Record<string, Record<string, any>>> }).resource;
    expect(tasks.aws_ecs_express_gateway_service).toBeUndefined();
    expect(tasks.aws_ecs_service!.api).toMatchObject({ desired_count: 1, deployment_circuit_breaker: [{ enable: true, rollback: true }] });
    expect(tasks.aws_security_group!.tasks!.ingress).toEqual([]);
    expect(JSON.parse(tasks.aws_ecs_task_definition!.api!.container_definitions)[0].environment).toContainEqual({ name: 'PORT', value: '3000' });
  });
});

describe('AWS tasks', () => {
  it('converts five-field cron to EventBridge Scheduler form', () => {
    expect(schedulerCron('0 3 * * 1')).toBe('cron(0 3 ? * 2 *)');
    expect(schedulerCron('*/15 * * * *')).toBe('cron(*/15 * * * ? *)');
    expect(schedulerCron('0 9 1 * *')).toBe('cron(0 9 1 * ? *)');
    expect(() => schedulerCron('0 9 1 * 1')).toThrow(/both day of month and day of week/);
  });

  it('starts on-demand workers at zero, counts only after app activity so the database can pause, wakes on time, and fails open', () => {
    const config = buildAwsConfiguration({ ...base, database: { clusterArn: 'arn:aws:rds:us-west-2:111122223333:cluster:hv-app-shared-postgres', name: 'app_demo' },
      services: [{ logicalName: 'web', resourceName: 'hv-app-web', initialImageUri: 'x', public: true }],
      workers: [{ logicalName: 'worker', resourceName: 'hv-app-worker', initialImageUri: 'x', pendingWorkQuery: 'SELECT 1', nextWorkAtQuery: 'SELECT min(run_at) FROM jobs;' }],
      jobs: [{ logicalName: 'tick', resourceName: 'hv-app-tick', initialImageUri: 'x', schedule: '0 * * * *' }], secretKeys: ['JWT_SECRET'] });
    const tasks = (config.files['tasks.tf.json'] as { resource: Record<string, Record<string, Record<string, unknown>>> }).resource;
    expect(tasks.aws_ecs_service!.worker).toMatchObject({ desired_count: 0, lifecycle: [{ ignore_changes: ['desired_count'] }] });
    // Releases register revisions; the engine tracks the latest instead of reverting them.
    expect(tasks.aws_ecs_task_definition!.worker).toMatchObject({ track_latest: true });
    const definition = JSON.parse(String(tasks.aws_sfn_state_machine!.worker_waker!.definition).replaceAll('$${', '${'));
    expect(definition.QueryLanguage).toBe('JSONata');
    // The environment holds no cluster; its waker counts in its own database on the shared one, and may query only that cluster.
    expect(config.files['database.tf.json']).toBeUndefined();
    expect(JSON.stringify(definition)).toContain('"Database":"app_demo"');
    expect(JSON.stringify(definition)).toContain('cluster:hv-app-shared-postgres');
    const policy = JSON.parse((config.files['base.tf.json'] as { resource: { aws_iam_role_policy: { runtime: { policy: string } } } }).resource.aws_iam_role_policy.runtime.policy);
    expect(policy.Statement.find((statement: { Sid: string }) => statement.Sid === 'WakerCount').Resource).toBe('arn:aws:rds:us-west-2:111122223333:cluster:hv-app-shared-postgres');
    expect(definition.States.Route.Default).toBe('Running');
    expect(definition.States.Route.Choices[0]).toMatchObject({ Next: 'Count' });
    expect(definition.States.IsRunning).toMatchObject({ Choices: [{ Next: 'Count' }], Default: 'HasGroups' });
    // AWS creates the web service's target group, so the waker reads it with the worker's state; an unreadable one counts as activity.
    expect(definition.States.Running.Arguments.Services).toEqual(['hv-app-worker', 'hv-app-web']);
    expect(definition.States.Running.Output).toContain('Services[ServiceName = "hv-app-worker"].DesiredCount > 0');
    expect(definition.States.HasGroups).toMatchObject({ Choices: [{ Next: 'Requests' }], Default: 'Count' });
    expect(definition.States.Requests.Arguments.MetricDataQueries).toContain('"Namespace": "AWS/ApplicationELB", "MetricName": "RequestCountPerTarget"');
    expect(definition.States.Requests.Catch).toEqual([{ ErrorEquals: ['States.ALL'], Next: 'Count' }]);
    // Nothing about the database's own state decides whether to count: counting would keep it awake.
    expect(JSON.stringify(definition)).not.toContain('ServerlessDatabaseCapacity');
    expect(definition.States.Busy).toMatchObject({ Default: 'Zero' });
    expect(tasks.aws_cloudwatch_event_rule!.jobs_finished!.event_pattern).toContain('family:hv-app-tick');
    expect(tasks.aws_cloudwatch_event_target!.worker_waker).toMatchObject({ input: '{"force":true}' });
    expect(definition.States.Count.Catch).toEqual([{ ErrorEquals: ['States.ALL'], Next: 'KeepOne' }]);
    expect(definition.States.NextAt.Arguments.Sql).toContain('FROM (SELECT min(run_at) FROM jobs) AS next_work(t)');
    expect(definition.States.Timer).toMatchObject({ Catch: [{ ErrorEquals: ['States.ALL'], Next: 'KeepOne' }],
      Arguments: { Name: 'hv-app-worker-waker-next', Target: { Arn: 'arn:aws:states:us-west-2:111122223333:stateMachine:hv-app-worker-waker', Input: '{"force":true}' } } });
    expect(definition.States.KeepOne.Arguments.DesiredCount).toBe(1);
    expect(tasks.aws_scheduler_schedule!.worker_waker_next).toMatchObject({ state: 'DISABLED', lifecycle: [{ ignore_changes: ['schedule_expression', 'state'] }] });
    const container = JSON.parse(String(tasks.aws_ecs_task_definition!.worker!.container_definitions))[0];
    expect(container.secrets).toEqual([{ name: 'JWT_SECRET', valueFrom: 'arn:aws:ssm:us-west-2:111122223333:parameter/hypervibe/env1/JWT_SECRET' }]);
    const runtime = (config.files['base.tf.json'] as { resource: { aws_iam_role_policy: { runtime: { policy: string } } } }).resource.aws_iam_role_policy.runtime.policy;
    for (const sid of ['WakerCount', 'WakerScale', 'WakerTimer', 'WakerWebRequests', 'StartWakers', 'PassSelf', 'RunTasks']) expect(runtime).toContain(sid);
  });
});


describe('private package build token boundary', () => {
  it('mounts only the package token in CodeBuild and scopes its read permission', () => {
    const config = buildAwsBuildConfiguration({ ...base, packageTokenKey: 'NODE_AUTH_TOKEN' } as never);
    const file = config.files['builds.tf.json'] as any;
    const policy = JSON.parse(file.resource.aws_iam_role_policy.build.policy);
    expect(policy.Statement).toContainEqual({ Sid: 'PackageToken', Effect: 'Allow', Action: 'ssm:GetParameters', Resource: 'arn:aws:ssm:us-west-2:111122223333:parameter/hypervibe/env1/NODE_AUTH_TOKEN' });
    const buildspec = file.resource.aws_codebuild_project.images.source[0].buildspec;
    expect(buildspec).toContain('--secret id=npm_token,env=NPM_TOKEN');
    expect(buildspec).not.toContain('--build-arg');
  });
});

it('excludes package token keys from web, worker, cron and runtime permissions', () => {
  const image = `${awsRegistryUrl(base)}:commit`;
  const env = { API_MODE: 'live', NPM_TOKEN: 'must-not-render', NODE_AUTH_TOKEN: 'also-private' };
  const config = buildAwsConfiguration({ ...base, secretKeys: ['API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'],
    services: [{ logicalName: 'web', resourceName: 'hv-app-aws-web', initialImageUri: image, public: true, env }],
    workers: [{ logicalName: 'worker', resourceName: 'hv-app-aws-worker', initialImageUri: image, env }],
    jobs: [{ logicalName: 'cron', resourceName: 'hv-app-aws-cron', initialImageUri: image, schedule: '0 1 * * *', env }],
  });
  const rendered = JSON.stringify(config.files);
  expect(rendered).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|must-not-render|also-private|GetParametersByPath/);
  expect(rendered).toContain('API_KEY');
  expect(rendered).toContain('API_MODE');
});


it('plans a separate environment-owned query credential without a secret value or runtime grant', () => {
  const config = buildAwsConfiguration({ ...base, database: { clusterArn: 'arn:aws:rds:us-west-2:111122223333:cluster:shared', name: 'app_test' } });
  expect(config.resources['aws_secretsmanager_secret.database_query']).toMatchObject({ actionId: 'database-query:credential', billable: true, requiresConfirm: true });
  const credential = (config.files['database-access.tf.json'] as any).resource.aws_secretsmanager_secret.database_query;
  expect(credential.name).toBe('hypervibe/env1/database-query');
  expect(credential).not.toHaveProperty('secret_string');
  expect(JSON.stringify((config.files['base.tf.json'] as any).resource.aws_iam_role_policy.runtime)).not.toContain('database-query');
});

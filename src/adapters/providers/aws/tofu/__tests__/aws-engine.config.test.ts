import { describe, expect, it } from 'vitest';
import { buildAwsConfiguration, schedulerCron } from '../aws-engine.config.js';

const base = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-aws', environmentId: 'ENV1', parameterPath: '/hypervibe/env1/' };

describe('AWS engine configuration', () => {
  it('keeps the database TLS-only, its password out of state, and its deletion confirmable', () => {
    const config = buildAwsConfiguration({ ...base, database: { engineVersion: '18.6', minCapacity: 0, maxCapacity: 2 } });
    const database = config.files['database.tf.json'] as { resource: Record<string, Record<string, Record<string, unknown>>> };
    const cluster = database.resource.aws_rds_cluster!.postgres!;
    expect(cluster.manage_master_user_password).toBe(true);
    expect(cluster).not.toHaveProperty('master_password');
    expect(database.resource.aws_rds_cluster_parameter_group!.postgres!.parameter).toEqual([{ name: 'rds.force_ssl', value: '1' }]);
    expect(cluster.serverlessv2_scaling_configuration).toEqual([{ min_capacity: 0, max_capacity: 2, seconds_until_auto_pause: 600 }]);
    expect(config.resources['aws_rds_cluster.postgres']).toMatchObject({ dataBearing: true, billable: true });
  });

  it('caps the runtime role with the setup boundary and scopes secrets to the environment', () => {
    const config = buildAwsConfiguration({ ...base, storage: [{ name: 'documents', bucket: 'hv-app-aws-documents' }] });
    const role = (config.files['base.tf.json'] as { resource: { aws_iam_role: { runtime: Record<string, string> }; aws_iam_role_policy: { runtime: { policy: string } } } }).resource;
    expect(role.aws_iam_role.runtime.path).toBe('/hypervibe/app/');
    expect(role.aws_iam_role.runtime.permissions_boundary).toBe('arn:aws:iam::111122223333:policy/hypervibe/hypervibe-app-boundary');
    expect(role.aws_iam_role_policy.runtime.policy).toContain('parameter/hypervibe/env1/*');
    expect(config.resources['aws_s3_bucket.documents']).toMatchObject({ dataBearing: true });
  });
});

describe('AWS tasks', () => {
  it('converts five-field cron to EventBridge Scheduler form', () => {
    expect(schedulerCron('0 3 * * 1')).toBe('cron(0 3 ? * 2 *)');
    expect(schedulerCron('*/15 * * * *')).toBe('cron(*/15 * * * ? *)');
    expect(schedulerCron('0 9 1 * *')).toBe('cron(0 9 1 * ? *)');
    expect(() => schedulerCron('0 9 1 * 1')).toThrow(/both day of month and day of week/);
  });

  it('starts on-demand workers at zero, hands the count to the waker, and fails open', () => {
    const config = buildAwsConfiguration({ ...base, database: { engineVersion: '18.6', minCapacity: 0, maxCapacity: 2 },
      workers: [{ logicalName: 'worker', resourceName: 'hv-app-worker', initialImageUri: 'x', pendingWorkQuery: 'SELECT 1' }], secretKeys: ['JWT_SECRET'] });
    const tasks = (config.files['tasks.tf.json'] as { resource: Record<string, Record<string, Record<string, unknown>>> }).resource;
    expect(tasks.aws_ecs_service!.worker).toMatchObject({ desired_count: 0, lifecycle: [{ ignore_changes: ['desired_count', 'task_definition'] }] });
    const definition = JSON.parse(String(tasks.aws_sfn_state_machine!.worker_waker!.definition).replaceAll('$${', '${'));
    expect(definition.States.Count.Catch).toEqual([{ ErrorEquals: ['States.ALL'], Next: 'KeepOne' }]);
    expect(definition.States.KeepOne.Parameters.DesiredCount).toBe(1);
    const container = JSON.parse(String(tasks.aws_ecs_task_definition!.worker!.container_definitions))[0];
    expect(container.secrets).toEqual([{ name: 'JWT_SECRET', valueFrom: 'arn:aws:ssm:us-west-2:111122223333:parameter/hypervibe/env1/JWT_SECRET' }]);
  });
});

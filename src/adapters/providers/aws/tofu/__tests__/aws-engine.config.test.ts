import { describe, expect, it } from 'vitest';
import { buildAwsConfiguration } from '../aws-engine.config.js';

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

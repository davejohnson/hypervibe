import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configurationDigest } from '../../../../engine/opentofu/workspace.js';
import { environmentRetirementMappings } from '../../../../engine/opentofu/environment-retirement.js';
import { parseEnginePlan, translateEnginePlan } from '../../../../engine/opentofu/plan-mapping.js';
import { awsEngineProblems, buildAwsEngineInput } from '../../../../../application/infrastructure-engine-aws.js';
import { projectSpecSchema } from '../../../../../domain/spec/spec.schema.js';
import { buildAwsConfiguration, type AwsEngineInput } from '../aws-engine.config.js';

const base = { region: 'us-east-1', accountId: '123456789012', prefix: 'hv-app-staging', environmentId: 'env1', parameterPath: '/hypervibe/env1/' };
const bucket = { name: 'invoices', bucket: 'hv-app-staging-invoices-123456789012' };
const database = { name: 'staging', clusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:hv-app-shared-postgres' };
const monitor = (input: AwsEngineInput) => {
  const config = buildAwsConfiguration(input);
  const doc = config.files['runtime-monitoring.tf.json'] as { resource: Record<string, Record<string, Record<string, any>>> } | undefined;
  return { config, r: doc?.resource, widgets: doc ? JSON.parse(doc.resource.aws_cloudwatch_dashboard.runtime.dashboard_body).widgets : [] };
};

it('monitors an S3-only environment without creating a collector identity or referring to ECS', () => {
  const { r, widgets, config } = monitor({ ...base, nativeMonitoring: true, storage: [bucket] });
  expect(r?.aws_s3_bucket_metric.runtime_invoices).toMatchObject({ name: 'HypervibeRuntime', bucket: '${aws_s3_bucket.invoices.id}' });
  expect(r?.aws_cloudwatch_metric_alarm.runtime_bucket_invoices).toMatchObject({ namespace: 'AWS/S3', metric_name: '5xxErrors', statistic: 'Sum',
    dimensions: { BucketName: '${aws_s3_bucket.invoices.id}', FilterId: '${aws_s3_bucket_metric.runtime_invoices.name}' } });
  expect(JSON.stringify(widgets)).toContain(bucket.bucket);
  expect(config.resources['aws_s3_bucket_metric.runtime_invoices']).toMatchObject({ billable: true, requiresConfirm: true });
  expect(config.files['observer.tf.json']).toBeUndefined();
  expect(JSON.stringify(r)).not.toContain('aws_ecs_cluster');
  expect(r?.aws_cloudwatch_log_metric_filter).toBeUndefined();
  expect((config.files['storage.tf.json'] as any).resource.aws_s3_bucket.invoices.force_destroy).toBe(false);
});

it('labels the shared Aurora writer capacity separately from an individual logical database', () => {
  const { r, widgets, config } = monitor({ ...base, nativeMonitoring: true, database });
  expect(r?.aws_cloudwatch_metric_alarm.runtime_database_capacity).toMatchObject({ namespace: 'AWS/RDS', metric_name: 'ACUUtilization',
    dimensions: { DBInstanceIdentifier: 'hv-app-shared-postgres-1' }, threshold: 90 });
  expect(JSON.stringify(widgets)).toContain('Shared Aurora writer');
  expect(config.files['observer.tf.json']).toBeUndefined();
});

it('scopes native resources to the desired set and leaves an empty or never-enrolled environment alone', () => {
  expect(monitor({ ...base, storage: [bucket], database }).r).toBeUndefined();
  expect(monitor({ ...base, nativeMonitoring: true }).r).toBeUndefined();
  const result = monitor({ ...base, nativeMonitoring: true, storage: [bucket, { name: 'images', bucket: 'hv-app-staging-images-123456789012' }] });
  expect(Object.keys(result.r?.aws_s3_bucket_metric ?? {}).sort()).toEqual(['runtime_images','runtime_invoices']);
  const after = monitor({ ...base, nativeMonitoring: true, storage: [bucket] });
  expect(Object.keys(after.r?.aws_s3_bucket_metric ?? {})).toEqual(['runtime_invoices']);
  expect(JSON.stringify(after.widgets)).not.toContain('-images-');
});

it('builds native-only monitoring from the environment spec without a GitHub repository', () => {
  const spec = projectSpecSchema.parse({ version: 1, project: 'app', environments: { staging: {
    hosting: { provider: 'aws', region: base.region }, runtimeObservation: { branch: 'main' }, services: {},
    storage: { invoices: { type: 'bucket', provider: 's3', region: base.region, injectInto: [] } },
  } } });
  const ctx = { connection: { region: base.region, accountId: base.accountId }, prefix: base.prefix, parameterPath: base.parameterPath,
    environment: { id: 'env1', platformBindings: {} }, shared: {}, database: {} } as Parameters<typeof buildAwsEngineInput>[2];
  const input = buildAwsEngineInput(spec, 'staging', ctx, { secretKeys: [] });
  expect(input.nativeMonitoring).toBe(true);
  expect(input.observation).toBeUndefined();
  expect(monitor(input).r?.aws_s3_bucket_metric).toHaveProperty('runtime_invoices');
  expect(awsEngineProblems(spec, 'staging', { kind: 'opentofu', sharedDatabase: true, databaseLoginAt: '2026-11-26T00:00:00Z' }))
    .toContainEqual(expect.stringContaining('shared Aurora'));
});

it('keeps cron removal, monitor removal, and protected storage distinct in an approved environment plan', () => {
  const scope = { provider: 'aws' as const, accountId: base.accountId, region: base.region, prefix: base.prefix };
  const state = { provider: 'aws', projectId: 'app', environmentId: base.environmentId, partition: 'environment' as const };
  const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-aws-monitor-retire-'));
  try {
    const job = (name: string) => ({ logicalName: name, resourceName: base.prefix + '-' + name, initialImageUri: 'native-image', schedule: '0 3 * * *' });
    const prior = buildAwsConfiguration({ ...base, nativeMonitoring: true, jobs: [job('nightly'), job('always')], storage: [bucket] });
    const next = buildAwsConfiguration({ ...base, jobs: [job('always'), job('renamed')] });
    fs.writeFileSync(path.join(plans, 'old.config.json'), JSON.stringify(prior));
    const tags = { 'managed-by': 'hypervibe', 'hv-environment': base.environmentId.toLowerCase() };
    const evidence: Record<string, Record<string, unknown>> = {
      'aws_ecs_task_definition.nightly': { family: 'hv-app-staging-nightly', tags_all: tags },
      'aws_scheduler_schedule.nightly': { name: 'hv-app-staging-nightly', group_name: 'default' },
      'aws_s3_bucket_metric.runtime_invoices': { name: 'HypervibeRuntime', bucket: bucket.bucket },
      'aws_cloudwatch_metric_alarm.runtime_bucket_invoices': { alarm_name: base.prefix + '-invoices-s3-errors', tags_all: tags },
      'aws_s3_bucket.invoices': { bucket: bucket.bucket, force_destroy: false },
    };
    const shown = JSON.stringify({ resource_changes: Object.entries(evidence).map(([address, before]) => ({
      address, mode: 'managed', type: address.split('.')[0], change: { actions: ['delete'], before, after: null },
    })) });
    const resources = environmentRetirementMappings({ configuration: next, scope, state, plans, shown, applied: (_state, _scope, addresses) =>
      addresses.map(address => ({ ...prior.resources[address]!, address, planId: 'old', configurationDigest: configurationDigest(prior) })) });
    const result = translateEnginePlan({ parsed: parseEnginePlan(shown), provider: 'aws', configuration: { ...next, resources: { ...next.resources, ...resources } },
      segment: { id: 'env', engine: 'opentofu', configurationDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: {} } });
    expect(result.unmanagedDeletes).toEqual(['aws_s3_bucket.invoices']);
    expect(result.actions.map(a => [a.id, a.type, a.requiresConfirm]).sort()).toEqual([
      ['monitor:aws_cloudwatch_metric_alarm.runtime_bucket_invoices','destroy',true], ['monitor:aws_s3_bucket_metric.runtime_invoices','destroy',true], ['service:nightly','destroy',true],
    ]);
    expect(next.resources['aws_ecs_task_definition.renamed']?.actionId).toBe('service:renamed');
  } finally { fs.rmSync(plans, { recursive: true, force: true }); }
});

it('matches retired ECS services to their own cluster, even when a different cluster has the same service name', () => {
  const state = { provider: 'aws', projectId: 'app', environmentId: base.environmentId, partition: 'environment' as const };
  const scope = { provider: 'aws' as const, accountId: base.accountId, region: base.region, prefix: base.prefix };
  const worker = { logicalName: 'worker', resourceName: base.prefix + '-worker', initialImageUri: 'native-image' };
  const previous = buildAwsConfiguration({ ...base, workers: [worker] });
  const address = 'aws_ecs_service.worker';
  const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-ecs-service-retirement-'));
  try {
    fs.writeFileSync(path.join(plans, 'applied.config.json'), JSON.stringify(previous));
    const recover = (cluster: string, tagged = true) => {
      const ecs = 'arn:aws:ecs:' + base.region + ':' + base.accountId;
      const before = { name: worker.resourceName, cluster: ecs + ':cluster/' + cluster, id: ecs + ':service/' + cluster + '/' + worker.resourceName,
        tags_all: tagged ? { 'managed-by': 'hypervibe', 'hv-environment': base.environmentId.toLowerCase() } : {} };
      return environmentRetirementMappings({ configuration: { files: {}, resources: {} }, state, scope, plans,
        shown: JSON.stringify({ resource_changes: [{ mode: 'managed', type: 'aws_ecs_service', address, change: { actions: ['delete'], before } }] }),
        applied: () => [{ address, planId: 'applied', configurationDigest: configurationDigest(previous), ...previous.resources[address]! }] });
    };
    expect(recover(base.prefix)[address]?.actionId).toBe('service:worker');
    expect(recover('different-cluster')).toEqual({});
    expect(recover(base.prefix, false)).toEqual({});
  } finally { fs.rmSync(plans, { recursive: true, force: true }); }
});

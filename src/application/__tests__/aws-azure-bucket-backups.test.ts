import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import type { IHttpClient } from '@azure/storage-blob';
import { AzureSdkBlobDataPlane } from '../../adapters/providers/azure/azure-blob-data-plane.js';
import { s3BucketObjectClient } from '../../domain/services/object-storage-transfer.service.js';
import { checkBucketEnrollment, enrollmentKey } from '../../domain/services/bucket-backup-enrollment.js';
import { buildAwsBucketBackup } from '../../adapters/providers/aws/tofu/aws-bucket-backup.config.js';
import { buildAzureBucketBackup } from '../../adapters/providers/azure/tofu/azure-bucket-backup.config.js';
import { AZURE_ROLES, deployRoleGrants } from '../../adapters/providers/azure/azure-setup.client.js';
import { awsDailyBucketConfig } from '../../adapters/providers/aws/aws-daily-bucket-backup.js';
import { azureDailyBucketConfig, azureBucketId } from '../../adapters/providers/azure/azure-daily-bucket-backup.js';
import { cloudBucketBackupNames, observedAwsBackupBucket } from '../aws-azure-bucket-backups.js';

const state = { provider: 'azure', projectId: 'invoice', environmentId: 'production', partition: 'environment' as const };
const prefix = 'hv-invoice-production', storageName = 'documents';
const worker = Buffer.from("process.stdout.write('reviewed worker');");
const resourceFile = (files: Record<string, unknown>) =>
  (files['daily-bucket-backup.tf.json'] as { resource: Record<string, Record<string, any>> }).resource;
const aws = awsDailyBucketConfig.parse({ version: 1, provider: 's3', accountId: '111122223333', region: 'us-east-1',
  sourceBucket: 'hv-application-documents', archiveBucket: 'hv-archive-111122223333' });
const azure = azureDailyBucketConfig.parse({ version: 1, provider: 'azure-blob', subscriptionId: '11111111-2222-4333-8444-555555555555',
  resourceGroup: 'hv-invoice', sourceAccount: 'hvsource123456', sourceContainer: 'documents', archiveAccount: 'hvarchive123456', archiveContainer: 'archive' });
const jobIdentity = { ...cloudBucketBackupNames(state, storageName, prefix), prefix, environmentId: state.environmentId, worker, storageName };

describe('same-cloud daily file backup', () => {
  it('builds the daily job for a long Azure environment name, with a private independent account and only the two reviewed container roles', () => {
    const config = buildAzureBucketBackup({ ...jobIdentity, config: azure, location: 'eastus', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const resources = resourceFile(config.files);
    const job = resources.azurerm_container_app_job!.backup;
    const runtimeConfig = job.template[0].container[0].env.find((entry: { name: string }) => entry.name === 'HYPERVIBE_BUCKET_BACKUP_CONFIG');
    expect(JSON.parse(runtimeConfig.value).enrollmentWitness).toBe('${terraform_data.enrollment_witness.output}');
    expect(resources.terraform_data!.enrollment_witness.lifecycle).toContainEqual({ prevent_destroy: true, ignore_changes: ['input'] });
    expect(job.name).toBe(jobIdentity.programName);
    expect(job.name.length).toBe(31);
    expect(job.container_app_environment_id).toBe('${azurerm_container_app_environment.backup.id}');
    expect(resources.azurerm_container_app_environment!.backup.workload_profile).toEqual([{ name: 'Consumption', workload_profile_type: 'Consumption' }]);
    // Ordinary Azure teardown inspects resources tagged hv-environment or hv-shared.
    for (const group of Object.values(resources)) for (const value of Object.values(group)) {
      expect(value.tags ?? {}).not.toHaveProperty('hv-environment');
      expect(value.tags ?? {}).not.toHaveProperty('hv-shared');
    }
    expect(job.schedule_trigger_config).toEqual([{ cron_expression: '17 3 * * *', parallelism: 1, replica_completion_count: 1 }]);
    // The live Azure provider fills in profile details and assigns an infrastructure group.
    expect(job.workload_profile_name).toBe('Consumption');
    expect(resources.azurerm_container_app_environment!.backup.lifecycle[0].ignore_changes)
      .toEqual(expect.arrayContaining(['workload_profile', 'infrastructure_resource_group_name']));
    expect(resources.azurerm_storage_account!.archive).toMatchObject({ name: azure.archiveAccount, shared_access_key_enabled: false,
      allow_nested_items_to_be_public: false, lifecycle: [{ prevent_destroy: true }] });
    for (const [side, account, container, role] of [
      ['source', azure.sourceAccount, azure.sourceContainer, AZURE_ROLES.storageBlobDataReader],
      ['archive', azure.archiveAccount, azure.archiveContainer, AZURE_ROLES.storageBlobDataContributor],
    ] as const) {
      expect(resources.azurerm_role_assignment![side]).toMatchObject({ scope: azureBucketId(azure.subscriptionId, azure.resourceGroup, account, container),
        role_definition_id: '/subscriptions/' + azure.subscriptionId + '/providers/Microsoft.Authorization/roleDefinitions/' + role,
        principal_id: '${azurerm_user_assigned_identity.backup.principal_id}' });
    }
    expect(job.template[0].container[0].image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(gunzipSync(Buffer.from(resources.azurerm_storage_blob!.worker.source_content, 'base64'))).toEqual(worker);
    expect(azureDailyBucketConfig.safeParse({ ...azure, archiveAccount: azure.sourceAccount }).success).toBe(false);
  });

  it('keeps the AWS source read-only and the schedule restricted to the exact worker and task roles', () => {
    const named = cloudBucketBackupNames({ ...state, provider: 'aws' }, storageName, prefix);
    const config = buildAwsBucketBackup({ ...jobIdentity, ...named, config: aws });
    const resources = resourceFile(config.files);
    expect(resources.aws_s3_bucket!.archive).toMatchObject({ bucket: aws.archiveBucket, force_destroy: false, lifecycle: [{ prevent_destroy: true }] });
    const policies = resources.aws_iam_role_policy!;
    const source = JSON.parse(policies.files.policy).Statement.filter((s: { Resource: string | string[] }) => JSON.stringify(s.Resource).includes(aws.sourceBucket));
    expect(source.map((s: { Action: string[] }) => s.Action)).toEqual([['s3:ListBucket'], ['s3:GetObject']]);
    expect(policies.execution.policy).not.toContain(aws.sourceBucket);
    const archiveReads = JSON.parse(policies.files.policy).Statement.filter((grant: { Resource: unknown }) => JSON.stringify(grant.Resource).includes('hypervibe-runtime'));
    expect(archiveReads).toHaveLength(1);
    expect(archiveReads[0].Action).toEqual(['s3:GetObject']);
    expect(JSON.parse(policies.schedule.policy).Statement).toEqual([
      expect.objectContaining({ Action: ['ecs:RunTask'], Resource: '${aws_ecs_task_definition.backup.arn}', Condition: { ArnEquals: { 'ecs:cluster': '${aws_ecs_cluster.backup.arn}' } } }),
      expect.objectContaining({ Action: ['iam:PassRole'], Resource: ['${aws_iam_role.files.arn}', '${aws_iam_role.execution.arn}'] }),
    ]);
    const definition = JSON.parse(resources.aws_ecs_task_definition!.backup.container_definitions)[0];
    const runtimeConfig = definition.environment.find((entry: { name: string }) => entry.name === 'HYPERVIBE_BUCKET_BACKUP_CONFIG');
    expect(JSON.parse(runtimeConfig.value).enrollmentWitness).toBe('${terraform_data.enrollment_witness.output}');
    const content = resources.aws_s3_object!.worker.content.trim().split('\n').map((line: string) => line.slice(line.indexOf('=') + 1)).join('');
    expect(gunzipSync(Buffer.from(content, 'base64'))).toEqual(worker);
    expect(definition.environment).toContainEqual({ name: 'HV_WORKER_SHA256', value: createHash('sha256').update(worker).digest('hex') });
    expect(resources.aws_scheduler_schedule!.daily).toMatchObject({ schedule_expression: 'cron(17 3 * * ? *)', schedule_expression_timezone: 'UTC' });
    expect(awsDailyBucketConfig.safeParse({ ...aws, archiveBucket: aws.sourceBucket }).success).toBe(false);
    expect(Object.keys(resources.aws_iam_role!)).toHaveLength(3);
    for (const value of Object.values(resources.aws_iam_role!)) expect(value.name.length).toBeLessThanOrEqual(64);
  });

  it('adds the Blob Data Reader delegation ceiling only when explicitly selected in Azure owner setup', () => {
    expect(JSON.stringify(deployRoleGrants())).not.toContain(AZURE_ROLES.storageBlobDataReader);
    const expanded = deployRoleGrants([], true);
    expect(expanded.filter(row => row.condition)).toHaveLength(1);
    expect(expanded.find(row => row.condition)?.condition).toContain(AZURE_ROLES.storageBlobDataReader);
    expect(expanded.map(row => row.role)).toEqual(deployRoleGrants().map(row => row.role));
  });

  it('signs real S3 SDK requests for the selected owner, and uses only Entra bearer authentication on the selected Blob container', async () => {
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const nativeRevision = { etag: '"0x8D8A20E2374ECB1"', lastModified: '2026-09-30T00:00:00.000Z', versionId: 'original-version' };
    const handle = vi.fn(async () => ({ response: { statusCode: 200, headers: { 'content-length': String(id.length), etag: nativeRevision.etag,
      'last-modified': 'Wed, 30 Sep 2026 00:00:00 GMT', 'x-amz-version-id': nativeRevision.versionId }, body: Readable.from([id]) } }));
    const s3 = s3BucketObjectClient(new S3Client({ region: aws.region, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' },
      requestHandler: { handle } as never }), aws.sourceBucket, aws.accountId);
    await expect(checkBucketEnrollment(s3, id)).resolves.toEqual(nativeRevision); s3.destroy();
    const request = (handle.mock.calls as unknown as [[{ hostname: string; path: string; query: Record<string, unknown>; headers: Record<string, string> }]])[0][0];
    expect(request.hostname).toBe(aws.sourceBucket + '.s3.us-east-1.amazonaws.com');
    expect(request.path).toBe('/' + enrollmentKey(id)); expect(request.query).not.toHaveProperty('versionId');
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(request.headers['x-amz-expected-bucket-owner']).toBe(aws.accountId);

    const getToken = vi.fn(async () => ({ token: 'test-identity-token', expiresOnTimestamp: Date.now() + 60 * 60_000 }));
    const captured: string[] = [];
    const transport: IHttpClient = { async sendRequest(request) {
      captured.push(request.url);
      expect(request.headers.get('authorization')).toBe('Bearer test-identity-token');
      const headers = request.headers.clone();
      headers.set('content-type', 'application/octet-stream'); headers.set('content-length', String(id.length));
      headers.set('etag', nativeRevision.etag); headers.set('x-ms-version-id', nativeRevision.versionId);
      headers.set('last-modified', 'Wed, 30 Sep 2026 00:00:00 GMT');
      return { request, status: 200, headers, readableStreamBody: Readable.from([id]) };
    } };
    const azureClient = new AzureSdkBlobDataPlane(azure.sourceAccount, { getToken }, azure.sourceContainer, transport);
    await expect(checkBucketEnrollment(azureClient, id)).resolves.toEqual(nativeRevision);
    expect(captured).toEqual(['https://' + azure.sourceAccount + '.blob.core.windows.net/documents/' + enrollmentKey(id)]);
    expect(getToken.mock.calls).toHaveLength(1);
  });

  it('requires provider-confirmed absence and account-scoped native tags, including in us-east-1', async () => {
    const send = vi.fn();
    const s3 = { send } as unknown as S3Client;
    const observe = () => observedAwsBackupBucket(s3, aws.archiveBucket, aws.accountId, aws.region, 'ENV');
    for (const [name, status] of [['NoSuchTagSet', 404], ['NotFound', 404], ['AccessDenied', 403], ['NoSuchBucket', 500]]) {
      send.mockRejectedValueOnce({ name, $metadata: { httpStatusCode: status } });
      await expect(observe()).rejects.toThrow(/could not be verified/);
    }
    send.mockRejectedValueOnce({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
    await expect(observe()).resolves.toBe('absent');
    send.mockResolvedValueOnce({ TagSet: [{ Key: 'managed-by', Value: 'hypervibe' }, { Key: 'hv-environment', Value: 'env' }] })
      .mockResolvedValueOnce({ LocationConstraint: undefined });
    await expect(observe()).resolves.toBe('owned');
    for (const [command] of send.mock.calls) expect(command.input.ExpectedBucketOwner).toBe(aws.accountId);
  });
});

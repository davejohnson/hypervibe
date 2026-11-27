import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { GCP_JOB_NODE_IMAGE as NODE_IMAGE } from '../../gcp/gcp-node-image.js';
import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { azureBucketId, azureDailyBucketConfig, type AzureDailyBucketConfig } from '../azure-daily-bucket-backup.js';
import { AZURE_ROLES } from '../azure-setup.client.js';
import { azureProviderFile } from './azure-engine.config.js';
import { enrollmentKey } from '../../../../domain/services/bucket-backup-enrollment.js';
import { enrollmentWitnessReference, frozenEnrollmentWitness, nativeEnrollmentProbe } from '../../backup-enrollment-witness.js';

// Azure supplies the local identity URL and its rotating request header to this
// job. The only remote URL comes from the validated, generated archive settings.
const bootstrap = [
  '(async()=>{',
  "const tokenUrl=new URL(process.env.IDENTITY_ENDPOINT);",
  "tokenUrl.search=new URLSearchParams({'api-version':'2019-08-01',resource:'https://storage.azure.com/',client_id:process.env.AZURE_CLIENT_ID});",
  "const token=await fetch(tokenUrl,{redirect:'error',headers:{'X-IDENTITY-HEADER':process.env.IDENTITY_HEADER}});",
  "if(!token.ok)throw Error(); const {access_token}=await token.json();",
  "const blob=await fetch(process.env.HV_WORKER_URL,{redirect:'error',headers:{authorization:'Bearer '+access_token,'x-ms-version':'2023-11-03'}});",
  "if(!blob.ok || Number(blob.headers.get('content-length'))>5000000)throw Error();",
  "const js=require('node:zlib').gunzipSync(Buffer.from(await blob.text(),'base64'),{maxOutputLength:8000000});",
  "if(require('node:crypto').createHash('sha256').update(js).digest('hex')!==process.env.HV_WORKER_SHA256)throw Error();",
  "require('node:fs').writeFileSync('/tmp/hv-bucket-backup.cjs',js,{flag:'wx',mode:0o600});require('/tmp/hv-bucket-backup.cjs');",
  "})().catch(()=>{console.error('The daily backup program could not be loaded or verified.');process.exitCode=1;});",
].join('\n');

export interface AzureBucketBackupInput {
  config: AzureDailyBucketConfig; tenantId: string; location: string; environmentId: string; storageName: string;
  prefix: string; programName: string; worker: Buffer;
}
export function buildAzureBucketBackup(input: AzureBucketBackupInput): EngineConfiguration {
  const config = azureDailyBucketConfig.parse(input.config);
  const { programName, location, storageName } = input;
  const { subscriptionId, resourceGroup, sourceAccount, sourceContainer, archiveAccount, archiveContainer } = config;
  if (!/^hv-[a-z0-9-]{2,27}[a-z0-9]$/.test(programName) || programName.includes('--')) {
    throw new Error('The daily backup job name is invalid.');
  }
  const archiveId = azureBucketId(subscriptionId, resourceGroup, archiveAccount, archiveContainer);
  const sourceId = azureBucketId(subscriptionId, resourceGroup, sourceAccount, sourceContainer);
  const tags = { 'managed-by': 'hypervibe', 'hv-backup-environment': input.environmentId.toLowerCase() };
  const placed = { location, resource_group_name: resourceGroup, tags };
  const resource: Record<string, Record<string, unknown>> = {};
  const resources: Record<string, EngineResourceMapping> = {};
  const add = (type: string, key: string, value: unknown, group: 'archive' | 'identity' | 'schedule') => {
    (resource[type] ??= {})[key] = value;
    resources[type + '.' + key] = { actionId: 'bucket-backup:' + storageName + ':' + group,
      name: group === 'archive' ? archiveAccount + '/' + archiveContainer : programName + ' ' + group, kind: group === 'archive' ? 'storage' : 'service',
      requiresConfirm: true, ...(group === 'archive' ? { dataBearing: true } : {}), billable: group !== 'identity' };
  };
  const ref = (type: string, key: string, field = 'id') => '${' + type + '.' + key + '.' + field + '}';
  const enrollment = '${terraform_data.enrollment.id}';
  add('terraform_data', 'enrollment', { input: { source: sourceId, archive: archiveId }, lifecycle: [{ prevent_destroy: true }] }, 'archive');
  add('terraform_data', 'enrollment_witness', frozenEnrollmentWitness, 'archive');
  // Ordinary app identities may have contributor on the source storage account. A
  // different account prevents that inherited role from reaching retained files.
  add('azurerm_storage_account', 'archive', { ...placed, name: archiveAccount, account_kind: 'StorageV2', account_tier: 'Standard',
    account_replication_type: 'LRS', https_traffic_only_enabled: true, min_tls_version: 'TLS1_2', allow_nested_items_to_be_public: false,
    shared_access_key_enabled: false, default_to_oauth_authentication: true, cross_tenant_replication_enabled: false,
    lifecycle: [{ prevent_destroy: true }] }, 'archive');
  add('azurerm_storage_container', 'archive', { name: archiveContainer, storage_account_id: ref('azurerm_storage_account', 'archive'),
    container_access_type: 'private', lifecycle: [{ prevent_destroy: true }] }, 'archive');
  const hash = createHash('sha256').update(input.worker).digest('hex');
  const workerKey = 'hypervibe-runtime/worker.txt';
  add('azurerm_storage_blob', 'worker', { name: workerKey, storage_container_id: ref('azurerm_storage_container', 'archive'), type: 'Block',
    content_type: 'text/plain', source_content: gzipSync(input.worker, { level: 9 }).toString('base64') }, 'schedule');
  for (const [key, id] of [['source_enrollment', sourceId], ['archive_enrollment', ref('azurerm_storage_container', 'archive')]] as const) {
    add('azurerm_storage_blob', key, { name: enrollmentKey(enrollment), storage_container_id: id, type: 'Block',
      content_type: 'text/plain', source_content: enrollment, lifecycle: [{ prevent_destroy: true }] }, 'archive');
  }
  add('azurerm_user_assigned_identity', 'backup', { name: programName, ...placed }, 'identity');
  const assignment = (key: string, role: string, scope: string, dependencies: string[] = []) => add('azurerm_role_assignment', key, {
    scope, role_definition_id: '/subscriptions/' + subscriptionId + '/providers/Microsoft.Authorization/roleDefinitions/' + role,
    principal_id: ref('azurerm_user_assigned_identity', 'backup', 'principal_id'), principal_type: 'ServicePrincipal',
    ...(dependencies.length ? { depends_on: dependencies } : {}) }, 'identity');
  assignment('source', AZURE_ROLES.storageBlobDataReader, sourceId);
  assignment('archive', AZURE_ROLES.storageBlobDataContributor, archiveId, ['azurerm_storage_container.archive']);
  add('azurerm_container_app_environment', 'backup', { name: programName, ...placed,
    workload_profile: [{ name: 'Consumption', workload_profile_type: 'Consumption' }],
    lifecycle: [{ ignore_changes: ['workload_profile', 'infrastructure_resource_group_name'] }] }, 'schedule');
  add('azurerm_container_app_job', 'backup', { ...placed, name: programName, container_app_environment_id: ref('azurerm_container_app_environment', 'backup'),
    workload_profile_name: 'Consumption',
    identity: [{ type: 'UserAssigned', identity_ids: [ref('azurerm_user_assigned_identity', 'backup')] }],
    replica_timeout_in_seconds: 7200, replica_retry_limit: 0, schedule_trigger_config: [{ cron_expression: '17 3 * * *', parallelism: 1, replica_completion_count: 1 }],
    template: [{ container: [{ name: 'backup', image: NODE_IMAGE, cpu: 0.5, memory: '1Gi', command: ['node'], args: ['-e', bootstrap],
      env: [{ name: 'AZURE_CLIENT_ID', value: ref('azurerm_user_assigned_identity', 'backup', 'client_id') },
        { name: 'HYPERVIBE_BUCKET_BACKUP_CONFIG', value: JSON.stringify({ ...config, enrollmentId: enrollment, enrollmentWitness: enrollmentWitnessReference }) }, { name: 'HV_WORKER_SHA256', value: hash },
        { name: 'HV_WORKER_URL', value: 'https://' + archiveAccount + '.blob.core.windows.net/' + archiveContainer + '/' + workerKey }] }] }],
    depends_on: ['azurerm_role_assignment.source', 'azurerm_role_assignment.archive', 'azurerm_storage_blob.worker',
      'azurerm_storage_blob.source_enrollment', 'azurerm_storage_blob.archive_enrollment'] }, 'schedule');
  return { files: { 'provider.tf.json': azureProviderFile({ subscriptionId, resourceGroup, location, prefix: input.prefix, tenantId: input.tenantId }),
    'daily-bucket-backup.tf.json': { data: { external: nativeEnrollmentProbe(config) }, resource } }, resources };
}

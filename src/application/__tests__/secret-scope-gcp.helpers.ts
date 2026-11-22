import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import { buildCloudRunConfiguration } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { engineSecretId } from '../../domain/services/engine-secret-id.js';
import { buildEngineInput } from '../infrastructure-engine.js';

export const projectId = 'demo-project';
export const runtime = `hypervibe-runtime@${projectId}.iam.gserviceaccount.com`;
export const delegated = { ownership: 'delegated', principal: 'source system administrator', environments: ['staging'] };
export const generated = { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'] };

/** A web service, an on-demand worker, two scheduled jobs, a bucket, a queue, a database and a release command. */
export function scopeSpec(secrets: Record<string, unknown>, hosting: Record<string, unknown> = {}): ProjectSpec {
  return projectSpecSchema.parse({ version: 1, project: 'clone', environments: { staging: {
    hosting: { provider: 'cloudrun', ...hosting },
    services: {
      web: {},
      worker: { workloadKind: 'worker', onDemand: { pendingWorkQuery: 'SELECT count(*) FROM jobs' } },
      catchup: { workloadKind: 'cron', cronSchedule: '0 4 * * *', startCommand: 'clone catchup' },
      reports: { workloadKind: 'cron', cronSchedule: '0 5 * * *', startCommand: 'clone reports' },
    },
    database: { provider: 'cloudsql' },
    storage: { media: { type: 'bucket', provider: 'gcs', region: 'us-west1', injectInto: ['web', 'catchup'] } },
    queues: { events: {} },
    migrations: { mode: 'releaseCommand', command: 'clone migrate' },
  } }, secrets });
}

/** The generated OpenTofu configuration, assembled the way the planner assembles it. */
export function scopeConfiguration(spec: ProjectSpec, serviceIdentities?: Record<string, string>) {
  const environment = spec.environments.staging!;
  const keys = [...Object.keys(spec.secrets), 'DATABASE_URL'];
  const input = buildEngineInput(spec, 'staging', {
    gcpProjectId: projectId, region: 'us-west1', runtimeServiceAccountEmail: runtime, resourceNameFor: name => name,
    databaseWired: true, importedSecrets: Object.keys(spec.secrets).filter(key => spec.secrets[key]!.ownership === 'delegated'),
    secretVersions: Object.fromEntries(keys.map(key => [key, '1'])),
    ...(serviceIdentities ? { serviceIdentities } : {}),
  } as Parameters<typeof buildEngineInput>[2]);
  const labels = { 'managed-by': 'hypervibe', 'hv-environment': 'env-123' };
  return buildCloudRunConfiguration({
    ...input, runtimeServiceAccountEmail: runtime, environmentId: 'env-123',
    secrets: keys.map(key => ({ secretId: engineSecretId('staging', key), labels })),
    database: { instanceName: 'hv-staging-db', databaseName: 'app', wireServices: true },
    storage: Object.entries(environment.storage ?? {}).map(([name, storage]) => ({ name, bucketName: `hv-bucket-${name}`, location: storage.region, injectInto: storage.injectInto })),
    queues: Object.keys(environment.queues ?? {}).map(name => ({ name, topicId: `hv-staging-${name}` })),
  });
}

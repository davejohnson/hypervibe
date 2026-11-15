import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { engineEnvironmentProblems } from '../../domain/services/infrastructure-engine-selection.js';
import { buildCloudRunConfiguration } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { buildEngineInput } from '../infrastructure-engine.js';

// Contract (docs/development/support-matrix.md): settings an app needs to run for real
// on Google Cloud reach the engine configuration; a cloud that cannot build one says so.
function specFor(provider: 'cloudrun' | 'aws' | 'azure') {
  const storageProvider = provider === 'cloudrun' ? 'gcs' : provider === 'aws' ? 's3' : 'azureblob';
  return projectSpecSchema.parse({ version: 1, project: 'studio', environments: { staging: {
    hosting: { provider },
    services: {
      web: { alwaysOn: true, startCommand: 'sh scripts/start.sh', cpu: '2', memory: '2Gi' },
      worker: { workloadKind: 'worker', startCommand: 'python scripts/worker.py' },
      plain: {},
    },
    storage: { media: { provider: storageProvider, type: 'bucket', region: 'us-west1', injectInto: ['web', 'worker'], versioning: true, browserUploads: true },
      scratch: { provider: storageProvider, type: 'bucket', region: 'us-west1', injectInto: [] } },
  } } });
}

function configuration() {
  const spec = specFor('cloudrun');
  const input = buildEngineInput(spec, 'staging', {
    gcpProjectId: 'demo-project', region: 'us-west1', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    resourceNameFor: (service) => `${service}-staging`,
  });
  return buildCloudRunConfiguration({ ...input, runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    storage: Object.entries(spec.environments.staging!.storage ?? {}).map(([name, storage]) => ({
      name, bucketName: `demo-${name}`, location: storage.region, injectInto: storage.injectInto,
      ...(storage.versioning ? { versioning: true } : {}), ...(storage.browserUploads ? { browserUploads: true } : {}),
    })) });
}

describe('production settings on Google Cloud', () => {
  const files = configuration().files as Record<string, any>;
  const services = files['cloudrun.tf.json'].resource.google_cloud_run_v2_service;
  const buckets = files['storage.tf.json'].resource.google_storage_bucket;

  it('keeps an always-on web service running with its CPU available, and leaves others to scale to zero', () => {
    expect(services.web.template[0].scaling[0].min_instance_count).toBe(1);
    expect(services.web.template[0].containers[0].resources[0]).toEqual({ limits: { cpu: '2', memory: '2Gi' }, cpu_idle: false });
    expect(services.plain.template[0].scaling[0].min_instance_count).toBe(0);
    expect(services.plain.template[0].containers[0].resources[0].cpu_idle).toBe(true);
  });

  it('starts web services and workers with their declared command, and the image default otherwise', () => {
    expect(services.web.template[0].containers[0]).toMatchObject({ command: ['/bin/sh'], args: ['-lc', 'sh scripts/start.sh'] });
    const worker = files['workerpools.tf.json'].resource.google_cloud_run_v2_worker_pool.worker;
    expect(worker.template[0].containers[0]).toMatchObject({ command: ['/bin/sh'], args: ['-lc', 'python scripts/worker.py'] });
    expect(services.plain.template[0].containers[0]).not.toHaveProperty('command');
  });

  it('keeps replaced and deleted files for 30 days only in a versioned bucket', () => {
    expect(buckets.storage_media.versioning).toEqual([{ enabled: true }]);
    expect(buckets.storage_media.lifecycle_rule).toEqual([{ action: [{ type: 'Delete' }], condition: [{ days_since_noncurrent_time: 30, with_state: 'ARCHIVED' }] }]);
    expect(buckets.storage_scratch).not.toHaveProperty('versioning');
    expect(buckets.storage_scratch).not.toHaveProperty('lifecycle_rule');
  });

  it('lets browsers upload to a bucket that asked for it, while every bucket stays private', () => {
    expect(buckets.storage_media.cors[0].method).toEqual(expect.arrayContaining(['PUT', 'POST']));
    expect(buckets.storage_media.cors[0].response_header).toEqual(expect.arrayContaining(['Location', 'Content-Range']));
    expect(buckets.storage_scratch).not.toHaveProperty('cors');
    for (const bucket of Object.values<any>(buckets)) {
      expect(bucket).toMatchObject({ public_access_prevention: 'enforced', uniform_bucket_level_access: true, force_destroy: false });
    }
  });

  it('admits these settings on Google Cloud and refuses them by name on the other clouds', () => {
    expect(engineEnvironmentProblems(specFor('cloudrun'), 'staging')).toEqual([]);
    for (const [provider, cloud] of [['aws', 'AWS'], ['azure', 'Azure']] as const) {
      expect(engineEnvironmentProblems(specFor(provider), 'staging')).toEqual([
        `Service web: alwaysOn is not yet supported on ${cloud}.`,
        `Storage media: versioning is not yet supported on ${cloud}.`,
        `Storage media: browserUploads is not yet supported on ${cloud}.`,
      ]);
    }
  });

  it('rejects alwaysOn on anything but a web service', () => {
    expect(() => projectSpecSchema.parse({ version: 1, project: 'studio', environments: { staging: {
      hosting: { provider: 'cloudrun' }, services: { worker: { workloadKind: 'worker', alwaysOn: true } } } } })).toThrow(/alwaysOn applies only to web services/);
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { InfrastructureEngineBackend } from '../../domain/ports/infrastructure-engine.port.js';
import { cloudBucketBackupBundlePath } from './cloud-bucket-backup-bundle.js';
import type { AwsDailyBucketConfig } from './aws/aws-daily-bucket-backup.js';
import type { AzureDailyBucketConfig } from './azure/azure-daily-bucket-backup.js';

/** OpenTofu registry's package checksums for the supported Darwin and Linux platforms.
 * https://registry.opentofu.org/v1/providers/hashicorp/external/2.3.5/download/darwin/arm64 */
export function withBackupEnrollmentProvider(backend: InfrastructureEngineBackend): InfrastructureEngineBackend {
  return { ...backend, providerRequirements: { ...backend.providerRequirements, external: {
    source: 'hashicorp/external', version: '2.3.5', lockHashes: [
      'h1:uSxBhY6B5Ex8dq8Jc+qPgLj+Ishu5+y755d/MsFlAE4=', 'h1:VsIY+hWGvWHaGvGTSKZslY13lPeAtSTxfZRPbpLMMhs=',
      'h1:jcVmeuuz74tdRt2kj0MpUG9AORdlAlRRQ3k61y0r5Vc=', 'h1:3VK0DggxYvOG1o+2o+araLMi3JQ/wJsJku0+ytaqtLA=',
    ],
  } } };
}

export const enrollmentWitnessReference = '${terraform_data.enrollment_witness.output}';
export const frozenEnrollmentWitness = { input: '${data.external.original_markers.result.witness}',
  lifecycle: [{ prevent_destroy: true, ignore_changes: ['input'] }] };

export function nativeEnrollmentProbe(config: AwsDailyBucketConfig | AzureDailyBucketConfig) {
  const helper = cloudBucketBackupBundlePath('enrollment');
  const digest = createHash('sha256').update(readFileSync(helper)).digest('hex');
  const marker = config.provider === 's3' ? 'aws_s3_object' : 'azurerm_storage_blob';
  const launch = "const fs=require('node:fs'),c=require('node:crypto');if(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex')!==process.argv[2])throw Error('Enrollment reader changed.');require(process.argv[1]);";
  return { original_markers: { program: [process.execPath, '-e', launch, helper, digest],
    query: { config: JSON.stringify(config), enrollmentId: '${terraform_data.enrollment.id}' },
    depends_on: [marker + '.source_enrollment', marker + '.archive_enrollment'] } };
}

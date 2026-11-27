import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** npm build ships standalone workers with the package; cloud jobs require only Node. */
export function cloudBucketBackupBundlePath(provider: 'gcs' | 's3' | 'azure-blob' | 'enrollment'): string {
  const directory = import.meta.url.endsWith('.ts') ? 'node_modules/.cache/hypervibe-bucket-workers' : 'dist/bucket-workers';
  return fileURLToPath(new URL('../../../' + directory + '/' + provider + '.cjs', import.meta.url));
}
export function cloudBucketBackupBundle(provider: 'gcs' | 's3' | 'azure-blob'): Buffer {
  return readFileSync(cloudBucketBackupBundlePath(provider));
}

import { gzipSync } from 'node:zlib';
import { cloudBucketBackupBundle } from '../cloud-bucket-backup-bundle.js';

/** Cloud Run's pinned Node image takes only the packaged, reviewed program.
 * Split the compressed program into command arguments below single-value limits. */
export function gcpDailyBucketBackupCommand(): { command: string[]; args: string[] } {
  const program = gzipSync(cloudBucketBackupBundle('gcs')).toString('base64');
  const chunks = program.match(/.{1,16000}/g)!;
  return { command: ['node'], args: ['-e',
    "eval(require('node:zlib').gunzipSync(Buffer.from(process.argv.slice(1).join(''),'base64')).toString('utf8'))", '--', ...chunks] };
}

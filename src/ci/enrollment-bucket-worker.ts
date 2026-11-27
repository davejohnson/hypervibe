import { ClientSecretCredential } from '@azure/identity';
import { z } from 'zod';
import { awsDailyBucketClients, awsDailyBucketConfig } from '../adapters/providers/aws/aws-daily-bucket-backup.js';
import { azureDailyBucketClients, azureDailyBucketConfig } from '../adapters/providers/azure/azure-daily-bucket-backup.js';
import { checkBucketEnrollment } from '../domain/services/bucket-backup-enrollment.js';

/** OpenTofu external data source. It runs locally with the explicitly supplied
 * deployment identity. Its only cloud calls are GETs of the two enrollment objects. */
async function main() {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const bytes of process.stdin) {
    length += bytes.length;
    if (length > 8_192) throw new Error();
    parts.push(Buffer.from(bytes));
  }
  const input = z.object({ config: z.string(), enrollmentId: z.guid() }).strict().parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
  const config = z.union([awsDailyBucketConfig, azureDailyBucketConfig]).parse(JSON.parse(input.config));
  const value = (name: string) => z.string().min(1).parse(process.env[name]);
  let clients;
  if (config.provider === 's3') {
    if (value('AWS_REGION') !== config.region) throw new Error();
    clients = awsDailyBucketClients(config, { accessKeyId: value('AWS_ACCESS_KEY_ID'), secretAccessKey: value('AWS_SECRET_ACCESS_KEY'), sessionToken: value('AWS_SESSION_TOKEN') });
  } else {
    if (value('ARM_SUBSCRIPTION_ID').toLowerCase() !== config.subscriptionId.toLowerCase()) throw new Error();
    clients = azureDailyBucketClients(config, new ClientSecretCredential(value('ARM_TENANT_ID'), value('ARM_CLIENT_ID'), value('ARM_CLIENT_SECRET')));
  }
  try {
    const [source, archive] = await Promise.all([checkBucketEnrollment(clients.source, input.enrollmentId), checkBucketEnrollment(clients.archive, input.enrollmentId)]);
    process.stdout.write(JSON.stringify({ witness: Buffer.from(JSON.stringify({ source, archive })).toString('base64url') }));
  } finally { clients.source.destroy(); clients.archive.destroy(); }
}
void main().catch(() => { process.stderr.write('The original file backup marker revisions could not be verified.'); process.exitCode = 1; });

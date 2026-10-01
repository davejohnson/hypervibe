/** Hypervibe-owned helper image entrypoint. This runtime accepts no application
 * image, application command, source mount or caller-provided restore target. */
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createRecoverySet } from '../domain/services/recovery-set.service.js';
import { objectRecoveryIdentitySchema } from '../domain/services/object-recovery-set.service.js';
import { recoverySourceIdentitySchema } from '../domain/services/recovery-source.js';
import { createS3ObjectClient } from '../domain/services/object-storage-transfer.service.js';

const configSchema = z.object({
  version: z.literal(1), operation: z.literal('recovery-set'),
  project: z.string().min(1), environment: z.string().min(1), contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  database: z.object({ source: recoverySourceIdentitySchema }).strict().optional(), destination: objectRecoveryIdentitySchema,
  runId: z.string().uuid(), archiveBucket: z.string().min(1),
  objects: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,60}$/), identity: objectRecoveryIdentitySchema,
    bucket: z.string().min(1) }).strict()).max(32),
  fileReferenceQueries: z.array(z.object({ storageName: z.string().min(1), query: z.string().min(1).max(32_768) }).strict()).max(32).optional(),
}).strict();
const credentialsSchema = z.object({
  bucket: z.string().min(1), endpoint: z.string().url(), region: z.string().min(1),
  accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1),
  sessionToken: z.string().min(1).optional(), urlStyle: z.enum(['path', 'virtual']),
}).strict();

export function parseBackupHelperEnvironment(environment: NodeJS.ProcessEnv) {
  try {
    const config = configSchema.parse(JSON.parse(environment.HYPERVIBE_BACKUP_CONFIG ?? ''));
    const credentials = credentialsSchema.parse(JSON.parse(environment.HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON ?? ''));
    const sourceUrl = config.database ? environment.HYPERVIBE_BACKUP_DATABASE_URL ?? '' : undefined;
    const source = sourceUrl ? new URL(sourceUrl) : undefined;
    const privateHost = environment.HYPERVIBE_BACKUP_PRIVATE_HOST;
    const endpoint = new URL(credentials.endpoint);
    if ((config.database && (!source || !['postgres:', 'postgresql:'].includes(source.protocol) || !source.hostname || source.pathname.length < 2
      || !privateHost || source.hostname !== privateHost || !privateHost.endsWith('.internal')))
      || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || credentials.bucket !== config.archiveBucket) throw new Error('invalid scope');
    const sourceCredentials = z.record(credentialsSchema).parse(JSON.parse(environment.HYPERVIBE_BACKUP_OBJECTS_CREDENTIALS_JSON ?? '{}'));
    if (Object.keys(sourceCredentials).length !== config.objects.length || new Set(config.objects.map(item => item.name)).size !== config.objects.length) throw new Error('invalid source scope');
    for (const object of config.objects) {
      const selected = sourceCredentials[object.name];
      if (!selected || selected.bucket !== object.bucket) throw new Error('invalid source scope');
      const url = new URL(selected.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid source endpoint');
    }
    return { config, credentials, sourceCredentials, sourceUrl };
  } catch {
    throw new Error('Backup helper configuration is invalid.');
  }
}

/** Only the bounded, data-free evidence is returned or written to stdout. The
 * private manifest carries object references for the joint recovery coordinator. */
export async function runBackupHelper(environment: NodeJS.ProcessEnv = process.env) {
  const { config, credentials, sourceCredentials, sourceUrl } = parseBackupHelperEnvironment(environment);
  const archive = createS3ObjectClient(credentials);
  const objects = config.objects.map(object => ({ name: object.name, identity: object.identity, client: createS3ObjectClient(sourceCredentials[object.name]) }));
  try {
    const result = await createRecoverySet({ ...config, database: config.database ? { ...config.database, sourceUrl: sourceUrl! } : undefined,
      archive, objects });
    return result.receipt;
  } finally { archive.destroy(); for (const object of objects) object.client.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const evidence = await runBackupHelper();
    process.stdout.write(`HYPERVIBE_RECOVERY_RECEIPT:${JSON.stringify(evidence)}\n`);
  } catch {
    // Errors from configuration/SDK/SQL/tools must never be serialized.
    process.stderr.write('Hypervibe backup helper did not produce verified completion evidence.\n');
    process.exitCode = 1;
  }
}

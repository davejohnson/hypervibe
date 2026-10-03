/** Hypervibe-owned helper image entrypoint. This runtime accepts no application
 * image, application command, source mount or caller-provided restore target. */
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createRecoverySet } from '../domain/services/recovery-set.service.js';
import { objectRecoveryIdentitySchema } from '../domain/services/object-recovery-set.service.js';
import { recoverySourceIdentitySchema } from '../domain/services/recovery-source.js';
import { createS3ObjectClient } from '../domain/services/object-storage-transfer.service.js';
import { formatRecoveryFailureMarker, RecoveryDiagnosticError, recoveryFailure, type RecoveryDiagnostic } from '../domain/ports/recovery-diagnostics.port.js';
import type { StorageObjectClient } from '../domain/ports/storage.port.js';

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
    throw recoveryFailure('worker-input', 'invalid-input', undefined, undefined, 'Backup helper configuration is invalid.');
  }
}

/** Only the bounded, data-free evidence is returned or written to stdout. The
 * private manifest carries object references for the joint recovery coordinator. */
export async function runBackupHelper(environment: NodeJS.ProcessEnv = process.env) {
  let stage: RecoveryDiagnostic['stage'] = 'worker-input';
  let failure: RecoveryDiagnosticError | undefined;
  const clients: StorageObjectClient[] = [];
  try {
    const { config, credentials, sourceCredentials, sourceUrl } = parseBackupHelperEnvironment(environment);
    stage = 'archive-open';
    const archive = createS3ObjectClient(credentials); clients.push(archive);
    stage = 'source-open';
    const objects = config.objects.map(object => {
      const client = createS3ObjectClient(sourceCredentials[object.name]); clients.push(client);
      return { name: object.name, identity: object.identity, client };
    });
    stage = 'recovery-set';
    const result = await createRecoverySet({ ...config, database: config.database ? { ...config.database, sourceUrl: sourceUrl! } : undefined,
      archive, objects });
    return result.receipt;
  } catch (error) {
    failure = recoveryFailure(stage, 'execution', error);
    throw failure;
  } finally {
    let cleanupFailed = false;
    for (const client of clients) {
      try { client.destroy(); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new RecoveryDiagnosticError({
      ...(failure?.diagnostic ?? { stage: 'restore-cleanup', category: 'cleanup' }), localCleanupFailed: true,
    });
  }
}

export async function runBackupHelperCli(environment: NodeJS.ProcessEnv = process.env) {
  let executionId: string | undefined;
  try {
    // Parse the entire non-secret configuration before correlating a failure;
    // an arbitrary object containing a UUID is not execution identity evidence.
    executionId = configSchema.parse(JSON.parse(environment.HYPERVIBE_BACKUP_CONFIG ?? '')).runId;
    const evidence = await runBackupHelper(environment);
    process.stdout.write(`HYPERVIBE_RECOVERY_RECEIPT:${JSON.stringify(evidence)}\n`);
  } catch (error) {
    // Errors from configuration/SDK/SQL/tools must never be serialized.
    if (executionId) {
      const failure = recoveryFailure('worker-input', 'invalid-input', error);
      try { process.stderr.write(`${formatRecoveryFailureMarker(failure.diagnostic, executionId)}\n`); }
      catch { /* Invalid diagnostics cannot widen the safe output contract. */ }
    }
    process.stderr.write('Hypervibe backup helper did not produce verified completion evidence.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runBackupHelperCli();

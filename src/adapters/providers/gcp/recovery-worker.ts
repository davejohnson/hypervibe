import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { IRecoveryWorker, RecoveryWorkerRequest } from '../../../domain/ports/recovery-worker.port.js';
import { recoveryWorkerRegistry } from '../../../domain/registry/recovery-worker.registry.js';
import { createGcsWorkloadObjectClient } from './gcs.adapter.js';

export const gcpRecoveryWorkerConfigurationSchema = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  instanceConnectionName: z.string().regex(/^[a-z][a-z0-9-]+:[a-z]+-[a-z]+\d:[a-z][a-z0-9-]*$/),
  ipType: z.enum(['PRIVATE', 'PUBLIC']),
  runtimeServiceAccountEmail: z.string().email(),
}).strict();

function validated(request: RecoveryWorkerRequest) {
  const configuration = gcpRecoveryWorkerConfigurationSchema.parse(request.configuration);
  const [projectId, region, instanceId] = configuration.instanceConnectionName.split(':');
  if (projectId !== configuration.projectId || !configuration.runtimeServiceAccountEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`)
    || request.database?.source.provider !== 'cloudsql' || request.database.source.primaryExternalId !== instanceId
    || request.database.source.providerScope.projectId !== projectId || request.database.source.providerScope.region !== region
    || request.database.source.resourceIdentity.instanceId !== instanceId || request.archiveBucket !== request.destination.externalId) throw new Error('Native recovery source identity differs.');
  const identities = [request.destination, ...request.objects.map(object => object.identity)];
  if (identities.some(identity => identity.provider !== 'gcs' || identity.instanceScope.projectId !== projectId
    || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(identity.externalId))
    || request.objects.some(object => object.bucket !== object.identity.externalId || object.bucket === request.archiveBucket)) throw new Error('Native recovery storage scope differs.');
  // The Cloud SQL socket URL producer has an empty host. Normalize that exact
  // form only; the reviewed instance, never its URL host, selects the connector.
  const source = new URL((request.sourceUrl ?? '').replace(/^(postgres(?:ql)?:\/\/[^/]+@)\//, '$1localhost/'));
  if (!['postgres:', 'postgresql:'].includes(source.protocol) || !source.username || !source.password || source.pathname.length < 2
    || source.hash || [...source.searchParams.keys()].some(key => !['host', 'sslmode'].includes(key))
    || (source.searchParams.has('host') && source.searchParams.get('host') !== `/cloudsql/${configuration.instanceConnectionName}`)) throw new Error('Native SQL credentials are invalid.');
  return { configuration, source, identities };
}

/** Real Google SDK connector and ADC object streams. Endpoint overrides are
 * dependency-injected HTTP transports for offline contract tests only. */
export function createGcpRecoveryWorker(options: { auth?: GoogleAuth; connectorEndpoint?: string; fetch?: typeof fetch; mediaFetch?: typeof fetch } = {}): IRecoveryWorker {
  return {
    validate(request) { validated(request); },
    async open(request) {
      const { configuration, source, identities } = validated(request);
      const auth = options.auth ?? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
      const credentials = await auth.getCredentials();
      if (credentials.client_email !== configuration.runtimeServiceAccountEmail) throw new Error('The native recovery worker is running as a different Google service account.');
      const connector = new Connector({ auth, ...(options.connectorEndpoint ? { sqlAdminAPIEndpoint: options.connectorEndpoint } : {}) });
      let directory: string | undefined;
      let connectorReady = false;
      let closed = false;
      const close = async () => {
        if (closed) return;
        // Connector1.10.0 close() chains a success-only handler onto cached
        // instance promises. A failed initial refresh owns no live instance;
        // closing that rejected cache produces an unhandled provider error.
        if (connectorReady) connector.close();
        if (directory) await rm(directory, { recursive: true, force: true });
        closed = true;
      };
      try {
        directory = await mkdtemp(join(tmpdir(), 'hv-backup-sql-'));
        const connection = { instanceConnectionName: configuration.instanceConnectionName,
          ipType: configuration.ipType === 'PRIVATE' ? IpAddressTypes.PRIVATE : IpAddressTypes.PUBLIC };
        await connector.getOptions(connection);
        connectorReady = true;
        await connector.startLocalProxy({ ...connection,
          listenOptions: { path: join(directory, '.s.PGSQL.5432'), readableAll: false, writableAll: false } });
        // Both node-postgres and libpq decode an encoded Unix-socket hostname.
        // Keeping it in the URL host also preserves pg_dump's PGHOST projection.
        const sourceUrl = `postgresql://${source.username}:${source.password}@${encodeURIComponent(directory)}${source.pathname}`;
        const client = await auth.getClient();
        return {
          sourceUrl,
          async openStorage(identity) {
            if (closed || !identities.some(allowed => JSON.stringify(allowed) === JSON.stringify(identity))) throw new Error('The worker storage target is outside the reviewed source/archive set.');
            return createGcsWorkloadObjectClient(identity.externalId, async () => {
              const result = await client.getAccessToken();
              const token = typeof result === 'string' ? result : result.token;
              if (!token) throw new Error('Native GCS worker authentication is unavailable.');
              return token;
            }, options);
          },
          close,
        };
      } catch {
        await close();
        throw new Error('The selected Cloud SQL connector could not be established. No alternate network route was attempted.');
      }
    },
  };
}

recoveryWorkerRegistry.register('cloudrun', createGcpRecoveryWorker());

import { z } from 'zod';
import type { CommandRegistrar } from './commands.js';
import { parseCredentialRef } from './credential-reference.js';
import { commandError, commandSuccess } from './results.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { supportsDatabaseAuthentication } from '../domain/ports/database-authentication.port.js';

export function registerDatabaseAuthenticationCommand(registrar: CommandRegistrar): void {
  registrar.register('hv_db_verify_auth',
    'Verify a fresh PostgreSQL connection using a private reference to the exact node-postgres application URL or JSON connection configuration. Runs fixed read-only identity SQL without creating access paths. Caller-declared configured/deployed provenance is not verified; this does not certify deployment or application operation.', {
      credentialsRef: z.string().min(1).describe('env:NAME, dotenv:/absolute/path#KEY, file:/absolute/path, or secret-manager reference containing the application URL or JSON {connectionString, ssl?, options?, application_name?, client_encoding?, enableChannelBinding?}. No plaintext URL input.'),
      driver: z.literal('node-postgres').describe('Exact supported client semantics. Other application drivers remain unsupported.'),
      expectedUsername: z.string().min(1).describe('Intended PostgreSQL login and session identity.'),
      expectedDatabase: z.string().min(1).describe('Intended PostgreSQL database, not a schema.'),
      configurationSource: z.enum(['configured', 'deployed']).describe('Caller-declared provenance only; Hypervibe does not independently certify where the supplied configuration was obtained.'),
    }, async ({ credentialsRef, expectedUsername, expectedDatabase, configurationSource }) => {
      let configuration: Record<string, unknown>;
      try { configuration = await parseCredentialRef('database', credentialsRef, 'connectionString'); }
      catch { return commandError('VALIDATION', 'The private application connection configuration could not be resolved.', { details: { reason: 'configuration_unavailable' } }); }
      try {
        const adapter = await providerRegistry.createAdapter('database', { connectionUrl: configuration.connectionString });
        if (!supportsDatabaseAuthentication(adapter)) return commandError('UNSUPPORTED', 'The operational database adapter has no application authentication verifier.');
        const evidence = { ...await adapter.verifyAuthentication(configuration, { username: expectedUsername, database: expectedDatabase }),
          driver: 'node-postgres', configurationSource, sourceProvenance: 'caller-declared' };
        if (evidence.authentication !== 'authenticated') return commandError(
          evidence.reason?.startsWith('configuration_') || evidence.reason === 'unsupported_configuration' ? 'VALIDATION' : 'PROVIDER_ERROR',
          evidence.authentication === 'rejected' ? 'PostgreSQL rejected the supplied application credential.' : 'Application authentication could not be verified.',
          { details: evidence });
        return commandSuccess(evidence, { warnings: ['Only a fresh connection from this machine and its database/session identity were verified. Running workloads, old deployment retirement, and application queries remain unchecked.'] });
      } catch { return commandError('PROVIDER_ERROR', 'Application authentication could not be verified.'); }
    });
}

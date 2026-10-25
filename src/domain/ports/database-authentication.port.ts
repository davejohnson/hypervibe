/** A fresh application-shaped connection, separate from administrative probes,
 * provider configuration equality, deployment activation, and application use. */
export interface DatabaseAuthenticationEvidence {
  authentication: 'authenticated' | 'rejected' | 'unknown';
  identity: 'match' | 'mismatch' | 'unchecked';
  reason?: 'configuration_invalid' | 'configuration_identity_mismatch' | 'configuration_environment_conflict'
    | 'unsupported_configuration' | 'invalid_password' | 'identity_mismatch' | 'connection_failed';
  connection: 'fresh';
  deployedConfiguration: 'unchecked';
  applicationOperation: 'unchecked';
}

export interface DatabaseAuthenticationVerifier {
  /** Private input; never store or return this object or the resulting URL. */
  verifyAuthentication(configuration: unknown, expected: { username: string; database: string }): Promise<DatabaseAuthenticationEvidence>;
}

export function supportsDatabaseAuthentication(value: unknown): value is DatabaseAuthenticationVerifier {
  return Boolean(value) && typeof value === 'object'
    && typeof (value as Partial<DatabaseAuthenticationVerifier>).verifyAuthentication === 'function';
}

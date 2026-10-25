import type { CredentialTracking } from '../spec/credential.schema.js';
export interface CredentialValidation {
  result: 'passed' | 'failed' | 'unknown';
  tested: string;
  at: string | null;
  applicationOperation: 'unknown';
  accountId?: string;
  evidenceId?: string;
  intendedIdentity?: CredentialTracking['identity'];
}
export interface CredentialCapability {
  managementUrl: string;
  creationUrl?: (descriptor: CredentialTracking) => string;
  validate: (descriptor: CredentialTracking, value: string) => Promise<Omit<CredentialValidation, 'at' | 'applicationOperation'>>;
}
const capabilities = new Map<CredentialTracking['kind'], CredentialCapability>();
export function registerCredentialCapability(kind: CredentialTracking['kind'], capability: CredentialCapability) { capabilities.set(kind, capability); }
export function credentialManagement(descriptor: CredentialTracking) {
  const capability = capabilities.get(descriptor.kind);
  return capability ? { managementUrl: capability.managementUrl, creationUrl: capability.creationUrl?.(descriptor) ?? capability.managementUrl } : undefined;
}
export async function validateCredential(descriptor: CredentialTracking, value: string): Promise<CredentialValidation> {
  const capability = capabilities.get(descriptor.kind);
  if (!capability) return { result: 'unknown', tested: 'No supported credential authentication check.', at: null, applicationOperation: 'unknown' };
  try { return { ...await capability.validate(descriptor, value), at: new Date().toISOString(), applicationOperation: 'unknown', ...(descriptor.identity ? { intendedIdentity: descriptor.identity } : {}) }; }
  catch { return { result: 'unknown', tested: 'Provider validation could not be completed.', at: new Date().toISOString(), applicationOperation: 'unknown' }; }
}

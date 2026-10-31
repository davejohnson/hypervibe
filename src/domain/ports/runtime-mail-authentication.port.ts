import { z } from 'zod';
export const runtimeMailProbeSchema = z.object({ sender: z.email().max(320), recipient: z.email().max(320) }).strict();
export type RuntimeMailProbe = z.infer<typeof runtimeMailProbeSchema>;
export interface RuntimeMailAuthenticationEvidence {
  authentication: 'authenticated' | 'rejected' | 'unknown';
  reason?: 'configuration_invalid' | 'authentication_rejected' | 'access_denied' | 'unexpected_response' | 'provider_unavailable';
  sandbox: true; delivery: 'unchecked'; leastPrivilege: 'unchecked'; senderAuthorization: 'unchecked'; deployedConfiguration: 'unchecked';
}
export interface RuntimeMailAuthenticationVerifier {
  /** Private credential stays inside the adapter. Sandbox validation sends no message. */
  verifyRuntimeMail(input: RuntimeMailProbe): Promise<RuntimeMailAuthenticationEvidence>;
}
export function supportsRuntimeMailAuthentication(value: unknown): value is RuntimeMailAuthenticationVerifier {
  return Boolean(value) && typeof value === 'object' && typeof (value as Partial<RuntimeMailAuthenticationVerifier>).verifyRuntimeMail === 'function';
}

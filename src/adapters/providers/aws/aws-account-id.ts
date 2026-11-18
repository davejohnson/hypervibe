import { responseFields } from '../../../lib/provider-response-fields.js';

/** AWS STS GetCallerIdentity returns the caller's 12-digit account ID. */
export function stsAccountId(identity: { Account?: string }): string {
  return responseFields('AWS STS caller identity').matches('Account', identity.Account, /^\d{12}$/, 'must contain 12 digits');
}

import { z } from 'zod';
import type { RecoverySourceIdentity } from '../ports/recovery-source.port.js';

export const recoveryIdentityStringSchema = z.string()
  .regex(/^[^\u0000-\u001f\u007f]*$/, 'Recovery identities cannot contain control characters.')
  .refine(value => !value.includes('://'), 'Recovery identities cannot contain connection URLs.')
  .transform(value => value.trim()).pipe(z.string().min(1));
const id = recoveryIdentityStringSchema;
// This boundary is also used by repository exports, which bypass ordinary key
// redaction for retained recovery identities. Never accept arbitrary metadata.
const coordinates = (keys: readonly string[]) => z.object(Object.fromEntries(keys.map(key => [key, id.optional()]))).strict()
  .transform(value => Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined)));
export const recoverySourceIdentitySchema = z.object({
  provider: id,
  primaryExternalId: id,
  providerScope: coordinates(['projectId', 'environmentId', 'accountId', 'region', 'subscriptionId',
    'resourceGroup', 'organizationId', 'teamId', 'appId', 'projectRef', 'storageScopeHash'])
    .refine(scope => Object.keys(scope).length > 0, 'An exact recovery source requires provider scope.'),
  resourceIdentity: coordinates(['volumeId', 'volumeInstanceId', 'instanceId', 'instanceArn', 'clusterId',
    'serverId', 'branchId', 'appId']),
}).strict();

export function recoverySourceIdentityMatches(a: RecoverySourceIdentity, b: RecoverySourceIdentity): boolean {
  const same = (left: Record<string, string>, right: Record<string, string>) =>
    JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
  return a.provider === b.provider && a.primaryExternalId === b.primaryExternalId
    && same(a.providerScope, b.providerScope) && same(a.resourceIdentity, b.resourceIdentity);
}

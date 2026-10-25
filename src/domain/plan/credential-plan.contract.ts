import { z } from 'zod';
import type { PlanAction } from './plan.types.js';
import { registryCredentialTargetSchema } from '../ports/registry-credential.port.js';
import { databaseCredentialTargetSchema } from '../ports/database-credential.port.js';

export const CREDENTIAL_OPERATION = 'credentialUpdate';
export const credentialTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('database'), environment: z.string().min(1), environmentId: z.string().min(1), provider: z.string().min(1), key: z.string().min(1), identity: databaseCredentialTargetSchema }).strict(),
  z.object({ kind: z.literal('registry'), environment: z.string().min(1), environmentId: z.string().min(1), provider: z.string().min(1), key: z.string().min(1), service: z.string().min(1), username: z.string().min(1), identity: registryCredentialTargetSchema }).strict(),
  z.object({ kind: z.literal('hosting'), environment: z.string().min(1), environmentId: z.string().min(1), provider: z.string().min(1), key: z.string().min(1), targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/), services: z.array(z.string().min(1)).min(1), activation: z.enum(['deferred', 'provider-rollout']).optional(), valueEvidence: z.enum(['readback', 'acknowledgement']).optional() }).strict(),
  z.object({ kind: z.literal('github'), environment: z.string().min(1), environmentId: z.string().min(1), provider: z.literal('github'), key: z.string().min(1), repository: z.string().regex(/^[^/]+\/[^/]+$/), scope: z.string().optional(), scopeId: z.number().int().positive().optional() }).strict(),
]);
export type CredentialTarget = z.infer<typeof credentialTargetSchema>;
export const credentialActionMetadataSchema = z.object({ operation: z.literal(CREDENTIAL_OPERATION), role: z.string().min(1), intent: z.enum(['adopt', 'rotate']), target: credentialTargetSchema }).strict();
export function isCredentialAction(action: PlanAction): boolean {
  const m = credentialActionMetadataSchema.safeParse(action.metadata);
  return m.success && action.resource.kind === 'secret' && action.resource.name === m.data.target.key
    && action.resource.provider === m.data.target.provider && action.id === credentialActionId(m.data.role, m.data.target)
    && ['update', 'noop'].includes(action.type) && action.verified && action.requiresConfirm === true
    && !action.billable && (m.data.target.kind === 'database' ? action.dataBearing === (m.data.intent === 'rotate') : !action.dataBearing) && !action.dependsOn?.length;
}
export function credentialActionId(role: string, target: CredentialTarget): string {
  return `credential:${role}:${target.kind}:${encodeURIComponent(target.environment)}:${target.key}${target.kind === 'github' ? `:${encodeURIComponent(target.scope ?? 'repository')}` : target.kind === 'registry' ? `:${encodeURIComponent(target.service)}` : ''}`;
}

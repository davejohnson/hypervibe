import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import { secretDestinationIdentity, secretDestinationSchema, type SecretDestination } from './secret-destination.port.js';

export const SECRET_DESTINATION_PREPARE = 'secretDestinationPrepare';
export const secretContainerOwnerSchema = z.object({
  repository: z.string().max(500).regex(/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/), environment: z.string().min(1),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
}).strict();
export const secretContainerIntentSchema = z.object({
  destination: secretDestinationSchema, owner: secretContainerOwnerSchema, attemptId: z.string().guid(),
}).strict();
export type SecretContainerIntent = z.infer<typeof secretContainerIntentSchema>;
export const secretContainerBindingSchema = secretContainerIntentSchema.extend({
  state: z.enum(['attempted', 'ready']),
  resource: z.string().min(1).max(2048).optional(),
  createTime: z.string().datetime({ precision: undefined }).optional(),
}).superRefine((binding, ctx) => {
  if (binding.state === 'ready' && (!binding.resource || !binding.createTime))
    ctx.addIssue({ code: 'custom', message: 'Ready container requires native lifetime identity.' });
  if (binding.resource && binding.resource !== secretDestinationIdentity(binding.destination).resource)
    ctx.addIssue({ code: 'custom', message: 'Container identity differs from its destination.' });
});
export type SecretContainerBinding = z.infer<typeof secretContainerBindingSchema>;
export function secretContainerBindings(raw: unknown): Record<string, SecretContainerBinding> {
  return z.record(z.string(), secretContainerBindingSchema).parse(raw ?? {});
}
export function secretContainerScopeDigest(input: Pick<SecretContainerIntent, 'destination' | 'owner'>): string {
  // 63 lowercase hex characters fit native label limits. This is a scope
  // marker, never a value hash, and must also match a durable local attempt.
  return createHash('sha256').update(JSON.stringify({ owner: secretContainerOwnerSchema.parse(input.owner),
    destination: secretDestinationIdentity(input.destination) })).digest('hex').slice(0, 63);
}
export type SecretContainerObservation = { state: 'absent' } | { state: 'unknown'; reason: string } | {
  state: 'present'; resource: string; createTime: string; hasVersions: boolean;
  scopeDigest?: string; attemptId?: string;
};
export interface SecretDestinationSetup {
  readonly providers: readonly SecretDestination['provider'][];
  /** Read-only suggestions, never declaration or creation authority. */
  discover(environment: Pick<Environment, 'platformBindings'>,
    input: { repository: string; environment: string; keys: string[] }): Promise<
      { state: 'known'; destinations: Record<string, SecretDestination> } | { state: 'unknown'; reason: string }>;
  observe(environment: Pick<Environment, 'platformBindings'>, destination: SecretDestination): Promise<SecretContainerObservation>;
  /** No values, IAM changes, adoption, deletion or automatic POST replay. */
  create(environment: Pick<Environment, 'platformBindings'>, intent: SecretContainerIntent,
    options: { beforeCreate: () => Promise<void> }): Promise<SecretContainerObservation>;
}
export const secretContainerActionMetadataSchema = z.object({ operation: z.literal(SECRET_DESTINATION_PREPARE),
  destination: secretDestinationSchema, owner: secretContainerOwnerSchema,
  mode: z.enum(['create', 'reconcile']), attemptId: z.string().guid().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.mode === 'reconcile') !== Boolean(value.attemptId)) ctx.addIssue({ code: 'custom', message: 'Reconciliation requires an exact retained attempt.' });
});

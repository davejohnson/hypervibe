import { z } from 'zod';
import { secretContainerBindingSchema, type SecretContainerBinding } from './secret-destination-lifecycle.port.js';
import type { RuntimeSecretReference, SecretDestinationDriver } from './secret-destination.port.js';

export const operatorOutputRolesSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/))
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 10 && new Set(Object.values(value)).size === Object.keys(value).length);
export const operatorOutputSelectionSchema = z.object({ hostingProvider: z.string().min(1).max(100),
  destinations: z.array(z.object({ role: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    verificationPurpose: z.literal('github-app-signing-key').optional(),
    encoding: z.literal('base64').optional(),
    binding: secretContainerBindingSchema.refine(value => value.state === 'ready') }).strict()).min(1).max(10),
}).strict().refine(value => new Set(value.destinations.map(item => item.key)).size === value.destinations.length
  && new Set(value.destinations.map(item => item.role)).size === value.destinations.length);
export type OperatorOutputSelection = z.infer<typeof operatorOutputSelectionSchema>;
/** Local operator-owned credential delivery, separately reviewed from customer collection. */
export interface OperatorOutputDeliveryCapability {
  schemaVersion: 1;
  providers: readonly SecretContainerBinding['destination']['provider'][];
  review(binding: SecretContainerBinding, verificationPurpose?: 'github-app-signing-key'): { permissions: string[]; cost: string; pricingUrl: string };
  create(binding: SecretContainerBinding): Promise<{ driver: SecretDestinationDriver;
    verifyReference(reference: RuntimeSecretReference, signal: AbortSignal): Promise<void>;
    /** Internal operator metadata verification only. Never expose through a command or customer collection. */
    readGithubSigningKey?(reference: RuntimeSecretReference, signal: AbortSignal, beforeRead: () => Promise<void>): Promise<string> }>;
}

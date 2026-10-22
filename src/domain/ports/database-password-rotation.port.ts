import { z } from 'zod';
import type { Component } from '../entities/component.entity.js';

export const databasePasswordEndpointSchema = z.object({
  kind: z.enum(['direct', 'pooled']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  database: z.string().min(1),
  /** The SQL identity behind a pooler login can differ from its wire username. */
  expectedRole: z.string().min(1),
}).strict();
export type DatabasePasswordEndpoint = z.infer<typeof databasePasswordEndpointSchema>;

export const databaseCredentialRotationTargetSchema = z.object({
  provider: z.string().min(1),
  resourceId: z.string().min(1),
  providerScope: z.record(z.string().min(1), z.string().min(1)),
  username: z.string().min(1),
  database: z.string().min(1),
  endpoints: z.array(databasePasswordEndpointSchema).min(1).max(8),
}).strict();
export type DatabaseCredentialRotationTarget = z.infer<typeof databaseCredentialRotationTargetSchema>;

export interface DatabasePasswordAuthentication {
  status: 'accepted' | 'rejected' | 'unknown';
  reason?: 'invalid_target' | 'authentication_unknown' | 'password_rejected' | 'identity_mismatch';
}
export interface DatabasePasswordVerification {
  status: 'accepted' | 'rejected' | 'unknown';
  endpoints: Array<DatabasePasswordAuthentication & { kind: 'direct' | 'pooled' }>;
  /** Fresh password rejection does not disconnect an established session. */
  existingSessions: 'unchecked';
}
export interface DatabasePasswordReplacement {
  status: 'acknowledged' | 'rejected' | 'unknown';
  mutationAttempted: boolean;
  reason?: 'invalid_input' | 'identity_changed' | 'provider_rejected' | 'outcome_unknown';
}

/** Issuer operation only. Call exclusively under an exact authorized apply action.
 * Persist the reviewed target, previous and candidate material encrypted before
 * calling replacePassword. Recovery calls verifyPassword with that same material;
 * it must never automatically repeat an uncertain replacement. Verify old accepted
 * and candidate rejected before issuance, then candidate accepted and old rejected.
 * Consumer distribution/rollout and existing-session containment are separate. */
export interface IDatabasePasswordRotation {
  readonly strategy: 'replace-in-place';
  observeTarget(component: Component): Promise<DatabaseCredentialRotationTarget>;
  replacePassword(input: {
    component: Component;
    target: DatabaseCredentialRotationTarget;
    replacementPassword: string;
  }): Promise<DatabasePasswordReplacement>;
  verifyPassword(input: {
    component: Component;
    target: DatabaseCredentialRotationTarget;
    password: string;
  }): Promise<DatabasePasswordVerification>;
}

export function databaseRotationTargetsMatch(left: DatabaseCredentialRotationTarget, right: DatabaseCredentialRotationTarget): boolean {
  const canonical = (target: DatabaseCredentialRotationTarget) => JSON.stringify({
    ...target,
    providerScope: Object.fromEntries(Object.entries(target.providerScope).sort(([a], [b]) => a.localeCompare(b))),
    endpoints: [...target.endpoints].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  return canonical(left) === canonical(right);
}

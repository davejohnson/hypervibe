import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { RecoverySourceIdentity } from './recovery-source.port.js';
import { z } from 'zod';

export const databaseProvisionRecoveryDiagnosticSchema = z.object({
  state: z.enum(['pending', 'unknown', 'blocked']),
  phase: z.enum(['attempt', 'template', 'workflow', 'inventory', 'instance', 'persistence', 'references']),
  code: z.enum(['invalid_attempt', 'template_unavailable', 'template_changed', 'workflow_pending', 'workflow_failed',
    'workflow_unknown', 'inventory_unavailable', 'identity_ambiguous', 'identity_absent', 'identity_mismatch',
    'persistence_unverified', 'references_unverified', 'observation_unavailable']),
}).strict();
export type DatabaseProvisionRecoveryPhase = z.infer<typeof databaseProvisionRecoveryDiagnosticSchema>['phase'];
export type DatabaseProvisionRecoveryCode = z.infer<typeof databaseProvisionRecoveryDiagnosticSchema>['code'];

type VerifiedDatabaseMetadata = {
  source: RecoverySourceIdentity;
  /** Hash of nonsecret native identity/configuration and verification outcomes only. */
  evidenceFingerprint: string;
  /** Internal, provider-validated metadata only. Never includes URLs/passwords,
   * and is never copied to a public plan or receipt. Existing fields are merged. */
  bindings: Record<string, unknown>;
};
export type DatabaseProvisionRecoveryObservation = (VerifiedDatabaseMetadata & (
  { state: 'ready' } | { state: 'candidate'; lineage: 'unproven' }
)) | z.infer<typeof databaseProvisionRecoveryDiagnosticSchema>;

/** Observe a retained create attempt, without provider writes or SQL access.
 * Absence of the capability means recovery is unsupported, never permission to
 * call provision again or infer identity from a resource name. */
export interface IDatabaseProvisionRecovery {
  inspect(input: { environment: Environment; component: Component }): Promise<DatabaseProvisionRecoveryObservation>;
}

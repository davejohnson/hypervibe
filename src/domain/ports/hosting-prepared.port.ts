import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { CloudDeploymentConnectionV1, CloudDeploymentPreparedResourcesV1 } from './cloud-deployment.port.js';
import type { LocalPreparedHostingReceiptV1 } from './local-holding-preparation.port.js';

/** Native preparation facts only. This descriptor grants no hosted session,
 * impersonation, CI, registry publication or provider mutation authority. */
export type PreparedHostingDescriptor = Pick<CloudDeploymentConnectionV1,
  'installationId' | 'planDigest' | 'appId' | 'environment' | 'provider' | 'hostingProvider' | 'nativeScope' | 'deployment' | 'runtimeIdentities'> & {
  receiptDigest: string;
  preparedResources: CloudDeploymentPreparedResourcesV1;
};
export type LocalPreparedHostingLoader = () => Promise<LocalPreparedHostingReceiptV1>;

const coordinate = z.string().min(1).max(2048);
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Nonsecret local journal. Pending workloads still need a verified application rollout. */
export const preparedHostingMarkerSchema = z.object({ schemaVersion: z.literal(1), installationId: z.string().guid(),
  planDigest: digest, receiptDigest: digest,
  pendingFirstRelease: z.array(name).max(50).refine(items => new Set(items).size === items.length),
  firstReleaseConfigurationDigests: z.record(name, digest).optional(),
}).strict().refine(value => !value.firstReleaseConfigurationDigests
  || JSON.stringify(Object.keys(value.firstReleaseConfigurationDigests).sort()) === JSON.stringify([...value.pendingFirstRelease].sort()));
export const preparedHostingBindingsSchema = z.object({ provider: name, projectId: coordinate, environmentId: coordinate.optional(),
  providerScope: z.record(z.string().min(1).max(128), coordinate),
  services: z.record(name, z.object({ serviceId: coordinate, resourceUid: coordinate, resourceType: z.enum(['service', 'job']),
    workloadKind: z.enum(['web', 'worker', 'cron']), imageUri: coordinate, jobName: coordinate.optional(),
  }).strict()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 50),
}).strict();
export type PreparedHostingMarker = z.infer<typeof preparedHostingMarkerSchema>;
export type PreparedHostingBindings = z.infer<typeof preparedHostingBindingsSchema>;
/** Independently verified managed-CI provenance; native providers still verify current runtime state. */
export const preparedHostingReleaseEvidenceSchema = z.object({ schemaVersion: z.literal(1), repository: coordinate, workflow: coordinate, branch: coordinate,
  sourceCommitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), workflowSourceCommitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), runAttempt: z.literal(1), artifactId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workflowInputHash: digest, workflowContentHash: digest, programFingerprint: digest, deploymentContractFingerprint: digest,
  imageUri: z.string().max(2048).regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
  targets: z.array(z.object({ workload: name, kind: z.enum(['service', 'job']), resourceId: coordinate, resourceUid: coordinate }).strict()).min(1).max(50)
    .refine(items => new Set(items.map(item => item.workload)).size === items.length),
}).strict();
export type PreparedHostingReleaseEvidence = z.infer<typeof preparedHostingReleaseEvidenceSchema>;
export const preparedDirectReleaseTargetSchema = z.object({ schemaVersion: z.literal(1),
  installationId: z.string().guid(), planDigest: digest, receiptDigest: digest, workload: name,
  provider: name, projectId: coordinate, environmentId: coordinate, resourceId: coordinate, resourceUid: coordinate,
  holdingRevision: coordinate, configurationDigest: digest,
  imageUri: z.string().max(2048).regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
}).strict();
export const preparedDirectReleaseAttemptSchema = z.object({ id: z.string().guid(), planRunId: z.string().min(1).max(255),
  actionId: coordinate, status: z.enum(['attempted', 'rejected', 'uncertain', 'completed']), target: preparedDirectReleaseTargetSchema,
}).strict();
export const preparedDirectReleaseEvidenceSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('native-direct'),
  attemptId: z.string().guid(), target: preparedDirectReleaseTargetSchema, revision: coordinate, generation: coordinate,
}).strict();
export type PreparedDirectReleaseTarget = z.infer<typeof preparedDirectReleaseTargetSchema>;
export type PreparedDirectReleaseAttempt = z.infer<typeof preparedDirectReleaseAttemptSchema>;
export type PreparedDirectReleaseEvidence = z.infer<typeof preparedDirectReleaseEvidenceSchema>;
/** The application owns exact saved-action authority and durable CAS. The
 * provider must persist begin before PATCH and never replay a retained attempt. */
export interface PreparedDirectReleaseControl {
  read(target: PreparedDirectReleaseTarget): Promise<PreparedDirectReleaseAttempt | undefined>;
  begin(target: PreparedDirectReleaseTarget): Promise<PreparedDirectReleaseAttempt>;
  settle(attemptId: string, status: 'rejected' | 'uncertain'): Promise<void>;
}
export interface PreparedHostingObservation {
  state: 'verified';
  bindings: PreparedHostingBindings;
  preparation: PreparedHostingMarker;
  directReleaseEvidence?: PreparedDirectReleaseEvidence[];
}
export interface IPreparedHosting {
  /** Read-only native lifetime, ownership, holding/final rollout proof. Unknown never authorizes adoption.
   * Final workload evidence may shrink pendingFirstRelease, never reinstate holding transition authority.
   */
  inspect(input: { environment: Environment; environmentSpec: EnvironmentSpec; runtimeEnvVarsByService?: Record<string, Record<string, string>>; preserveReviewedRuntime?: boolean; releaseEvidence?: PreparedHostingReleaseEvidence }): Promise<PreparedHostingObservation | { state: 'unknown' }>;
}

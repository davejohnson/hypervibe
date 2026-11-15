import { isDeepStrictEqual } from 'node:util';
import { gql, type GraphQLClient } from 'graphql-request';
import type { DatabaseFreshInitializationProgress } from '../../../domain/ports/database-fresh-initialization.port.js';
import { recoveryIdentityStringSchema } from '../../../domain/services/recovery-source.js';
import { railwayReplicaConfiguration, type RailwayReplicaConfiguration } from './railway-replica-configuration.js';
import type { RailwayInitializationTarget } from './railway-database-initialization.js';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => {
  const parsed = recoveryIdentityStringSchema.safeParse(value);
  return parsed.success && parsed.data === value;
};
const timestamp = (value: unknown): number => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
  ? Date.parse(value) : NaN;
type ReviewedActivation = {
  acknowledgedId: string; deploymentId: string; storageId: string; instanceId: string; mountPath: string;
  rawVariables: Record<string, string>; image: string; replicaConfiguration?: RailwayReplicaConfiguration;
};
type ActivationEvidence = {
  reconciliation: NonNullable<DatabaseFreshInitializationProgress['activationReconciliation']>;
  /** Compare between observations only; never persist or render provider metadata. */
  privateEvidence: Record<string, unknown>;
};

/** Read-only reconciliation of the provider's exact storage-attachment patch.
 * The original deployment acknowledgement is never replaced. Opaque patch,
 * manifest and snapshot semantics are pinned from redacted observations; the
 * GraphQL schema alone does not constrain them. Raw reference equality proves
 * configuration preservation, not runtime resolution or SQL authentication.
 */
export async function railwayStorageAttachmentActivation(client: GraphQLClient,
  target: RailwayInitializationTarget, reviewed: ReviewedActivation,
): Promise<ActivationEvidence | undefined> {
  try {
    const response = await client.request<unknown>(gql`
      query InitializedDatabaseActivationSuccessor($acknowledgedId: String!, $deploymentId: String!, $serviceId: String!, $environmentId: String!) {
        acknowledged: deployment(id: $acknowledgedId) {
          id projectId environmentId serviceId status deploymentStopped createdAt snapshotId meta
        }
        deployment(id: $deploymentId) {
          id projectId environmentId serviceId status deploymentStopped createdAt snapshotId meta
        }
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          id serviceId environmentId deletedAt latestDeployment { id } activeDeployments { id }
        }
        acknowledgedSnapshot: deploymentSnapshot(deploymentId: $acknowledgedId) { id variables }
        deploymentSnapshot(deploymentId: $deploymentId) { id variables }
      }
    `, { acknowledgedId: reviewed.acknowledgedId, deploymentId: reviewed.deploymentId,
      serviceId: target.serviceId, environmentId: target.environmentId });
    if (!record(response) || !record(response.acknowledged) || !record(response.deployment)
      || !record(response.serviceInstance) || reviewed.acknowledgedId === reviewed.deploymentId) return;
    const acknowledged = response.acknowledged, deployment = response.deployment, instance = response.serviceInstance;
    for (const [observed, id] of [[acknowledged, reviewed.acknowledgedId], [deployment, reviewed.deploymentId]] as const) {
      if (observed.id !== id || observed.projectId !== target.projectId || observed.environmentId !== target.environmentId
        || observed.serviceId !== target.serviceId || !identity(observed.snapshotId)) return;
    }
    if (acknowledged.status !== 'REMOVED' || acknowledged.deploymentStopped !== true
      || deployment.status !== 'SUCCESS' || deployment.deploymentStopped !== false
      || instance.id !== reviewed.instanceId || instance.serviceId !== target.serviceId
      || instance.environmentId !== target.environmentId || instance.deletedAt !== null
      || !record(instance.latestDeployment) || instance.latestDeployment.id !== reviewed.deploymentId
      || !Array.isArray(instance.activeDeployments) || instance.activeDeployments.length !== 1
      || !record(instance.activeDeployments[0]) || instance.activeDeployments[0].id !== reviewed.deploymentId) return;
    for (const [snapshot, observed] of [[response.acknowledgedSnapshot, acknowledged], [response.deploymentSnapshot, deployment]] as const) {
      if (!record(snapshot) || snapshot.id !== observed.snapshotId
        || !isDeepStrictEqual(snapshot.variables, reviewed.rawVariables)) return;
    }
    if (!record(acknowledged.meta) || !record(deployment.meta)) return;
    const before = acknowledged.meta, after = deployment.meta;
    if (!identity(after.patchId) || before.image !== reviewed.image || after.image !== reviewed.image
      || typeof before.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(before.imageDigest)
      || typeof before.runtime !== 'string' || !before.runtime.trim()
      || !record(before.serviceManifest) || !record(before.serviceManifest.build) || !record(before.serviceManifest.deploy)
      || !isDeepStrictEqual(before.volumeMounts, [reviewed.mountPath])
      || ['imageDigest', 'runtime', 'serviceManifest', 'volumeMounts'].some(key => !isDeepStrictEqual(before[key], after[key]))) return;
    const manifest = before.serviceManifest.deploy;
    if (manifest.startCommand !== null && manifest.startCommand !== ''
      || !(manifest.preDeployCommand === null || Array.isArray(manifest.preDeployCommand) && manifest.preDeployCommand.length === 0)) return;
    const replicas = railwayReplicaConfiguration(manifest.numReplicas,
      { services: { [target.serviceId]: { deploy: manifest } } }, target.serviceId);
    if (replicas.count !== 1 || reviewed.replicaConfiguration && !isDeepStrictEqual(replicas, reviewed.replicaConfiguration)) return;

    const result = await client.request<unknown>(gql`
      query InitializedDatabaseActivationPatch($patchId: String!) {
        environmentPatch(id: $patchId) {
          id environmentId environment { id projectId } status createdAt appliedAt patch(decryptVariables: false)
        }
      }
    `, { patchId: after.patchId });
    if (!record(result) || !record(result.environmentPatch)) return;
    const patch = result.environmentPatch;
    if (patch.id !== after.patchId || patch.environmentId !== target.environmentId
      || !record(patch.environment) || patch.environment.id !== target.environmentId
      || patch.environment.projectId !== target.projectId || patch.status !== 'COMMITTED'
      || !isDeepStrictEqual(patch.patch, {
        services: { [target.serviceId]: { volumeMounts: { [reviewed.storageId]: { mountPath: reviewed.mountPath } } } },
        volumes: { [reviewed.storageId]: { isCreated: true } },
      })) return;
    const created = timestamp(patch.createdAt), applied = timestamp(patch.appliedAt);
    const previous = timestamp(acknowledged.createdAt), next = timestamp(deployment.createdAt);
    if (![created, applied, previous, next].every(Number.isFinite)
      || created > applied || created > previous || previous > next || applied > next) return;
    return { reconciliation: { version: 1, kind: 'storage-attachment', deploymentId: reviewed.deploymentId, operationId: after.patchId },
      privateEvidence: { acknowledgedSnapshotId: acknowledged.snapshotId, deploymentSnapshotId: deployment.snapshotId,
        acknowledgedCreatedAt: acknowledged.createdAt, deploymentCreatedAt: deployment.createdAt,
        patchCreatedAt: patch.createdAt, patchAppliedAt: patch.appliedAt,
        imageDigest: before.imageDigest, runtime: before.runtime, serviceManifest: before.serviceManifest } };
  } catch {
    // Provider errors and private snapshots may contain credentials.
    return undefined;
  }
}

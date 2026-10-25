import { gql, type GraphQLClient } from 'graphql-request';
import { hashEnvValue, type ObservedService } from '../../../domain/ports/observe.port.js';

/** Read an immutable deployment snapshot, separately from mutable variables.
 * The pinned SDL exposes an opaque EnvironmentVariables scalar, so validate its
 * shape and reject unexpanded references explicitly. This is deployment
 * configuration evidence only, never process inspection or SQL authentication. */
export async function railwayDeployedConfiguration(client: GraphQLClient, target: {
  projectId: string; environmentId: string; serviceId: string; deploymentId: string;
}): Promise<Pick<NonNullable<ObservedService['deployment']>, 'configurationState' | 'envVarHashes'>> {
  try {
    const result = await client.request<{
      deployment?: { id?: string; projectId?: string; environmentId?: string; serviceId?: string; snapshotId?: string | null };
      deploymentSnapshot?: { id?: string; variables?: unknown } | null;
    }>(gql`
      query GetDeploymentRuntimeConfiguration($deploymentId: String!) {
        deployment(id: $deploymentId) { id projectId environmentId serviceId snapshotId }
        deploymentSnapshot(deploymentId: $deploymentId) { id variables }
      }
    `, { deploymentId: target.deploymentId });
    const deployment = result.deployment;
    const snapshot = result.deploymentSnapshot;
    if (!deployment || deployment.id !== target.deploymentId || deployment.projectId !== target.projectId
      || deployment.environmentId !== target.environmentId || deployment.serviceId !== target.serviceId
      || !deployment.snapshotId || snapshot?.id !== deployment.snapshotId
      || !snapshot.variables || typeof snapshot.variables !== 'object' || Array.isArray(snapshot.variables)) return { configurationState: 'unknown' };
    const entries = Object.entries(snapshot.variables);
    if (entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('${{'))) {
      return { configurationState: 'unknown' };
    }
    return { configurationState: 'resolved', envVarHashes: Object.fromEntries(entries.map(([key, value]) => [key, hashEnvValue(value as string)])) };
  } catch {
    // Provider errors can contain variables. Return only the bounded state.
    return { configurationState: 'unknown' };
  }
}

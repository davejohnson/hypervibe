import { gql, type GraphQLClient } from 'graphql-request';
import { hashEnvValue, type ObservedService } from '../../../domain/ports/observe.port.js';

type Target = { projectId: string; environmentId: string; serviceId: string; deploymentId: string };
type RuntimeReader = { keys: string[]; read: (target: Target, request: { keys: string[] }) => Promise<{
  state: 'verified' | 'unknown'; envVarHashes?: Record<string, string>; instanceIds?: string[];
}> };

/** Read an immutable deployment snapshot, separately from mutable variables.
 * The pinned SDL exposes an opaque EnvironmentVariables scalar, so validate its
 * shape and reject unexpanded references explicitly. This is deployment
 * configuration evidence only, never process inspection or SQL authentication. */
export async function railwayDeployedConfiguration(client: GraphQLClient, target: Target, runtime?: RuntimeReader):
Promise<Pick<NonNullable<ObservedService['deployment']>, 'configurationState' | 'envVarHashes' | 'configurationEvidence' | 'configurationInstanceIds'>> {
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
    if (entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string')) {
      return { configurationState: 'unknown' };
    }
    const values = snapshot.variables as Record<string, string>;
    const selected = runtime?.keys.length ? [...new Set(runtime.keys)].sort()
      : Object.hasOwn(values, 'DATABASE_URL') ? ['DATABASE_URL'] : Object.keys(values);
    if (selected.every(key => typeof values[key] === 'string' && !values[key].includes('${{'))) {
      return { configurationState: 'resolved', configurationEvidence: 'deployment-snapshot',
        envVarHashes: Object.fromEntries(entries.filter(([, value]) => !(value as string).includes('${{')).map(([key, value]) => [key, hashEnvValue(value as string)])) };
    }
    // A raw snapshot reference cannot be rendered from today's mutable values.
    // An explicitly configured existing native runtime reader may instead cover
    // every exact instance. No access key, host trust or route is created here.
    if (runtime && selected.length && selected.some(key => values[key]?.includes('${{'))) {
      const evidence = await runtime.read(target, { keys: selected });
      if (evidence.state === 'verified' && evidence.instanceIds?.length
        && evidence.instanceIds.every(id => typeof id === 'string' && id.length > 0)
        && new Set(evidence.instanceIds).size === evidence.instanceIds.length
        && selected.every(key => /^[a-f0-9]{64}$/.test(evidence.envVarHashes?.[key] ?? ''))) {
        return { configurationState: 'resolved', configurationEvidence: 'runtime-instances',
          configurationInstanceIds: [...evidence.instanceIds].sort(),
          envVarHashes: Object.fromEntries(selected.map(key => [key, evidence.envVarHashes![key]])) };
      }
    }
    return { configurationState: 'unknown' };
  } catch {
    // Provider errors can contain variables. Return only the bounded state.
    return { configurationState: 'unknown' };
  }
}

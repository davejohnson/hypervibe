import { isDeepStrictEqual } from 'node:util';
import { gql, type GraphQLClient } from 'graphql-request';
import { z } from 'zod';
import { migrationVersionSourceSchema, migrationSourceInventorySchema, type MigrationSourceInventory, type MigrationVersionSource } from '../../../domain/plan/migration-version.contract.js';
import { isRailwayPostgresImage } from './railway-postgres-template.js';

type Target = Pick<MigrationVersionSource, 'projectId' | 'environmentId' | 'serviceId'>;
const id = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);
const invalid = (): never => { throw new Error('The exact running Railway database and its private version reply could not be verified.'); };

export function createRailwayVersionInspection(clientFor: () => GraphQLClient | null,
  resolveVolume: (target: Target) => Promise<{ volumeId: string; instanceId: string }>,
  read: (target: MigrationVersionSource) => Promise<MigrationSourceInventory>) {
  async function observe(target: Target): Promise<MigrationVersionSource> {
    const client = clientFor();
    if (!client) return invalid();
    const { projectId, environmentId, serviceId } = z.object({ projectId: id, environmentId: id, serviceId: id }).parse(target);
    const volume = await resolveVolume({ projectId, environmentId, serviceId });
    const result = z.object({ serviceInstance: z.object({ id, serviceId: z.literal(serviceId), environmentId: z.literal(environmentId), deletedAt: z.null(),
      activeDeployments: z.array(z.object({ id })).length(1), latestDeployment: z.object({ id }) }) }).parse(await client.request(gql`
      query MigrationVersionService($environmentId: String!, $serviceId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          id serviceId environmentId deletedAt activeDeployments { id } latestDeployment { id }
        }
      }`, { serviceId, environmentId }));
    const instance = result.serviceInstance, deploymentId = instance.latestDeployment.id;
    if (instance.activeDeployments[0]!.id !== deploymentId) return invalid();
    const { deployment } = z.object({ deployment: z.object({ id: z.literal(deploymentId), projectId: z.literal(projectId),
      environmentId: z.literal(environmentId), serviceId: z.literal(serviceId), status: z.literal('SUCCESS'), deploymentStopped: z.literal(false),
      meta: z.object({ image: z.string().refine(isRailwayPostgresImage), imageDigest: migrationVersionSourceSchema.shape.imageDigest }), instances: z.array(z.object({ id, status: z.literal('RUNNING') })).length(1) }) })
      .parse(await client.request(gql`query MigrationVersionDeployment($id: String!) {
        deployment(id: $id) { id projectId environmentId serviceId status deploymentStopped meta instances { id status } }
      }`, { id: deploymentId }));
    return migrationVersionSourceSchema.parse({ projectId, environmentId, serviceId, serviceInstanceId: instance.id, deploymentId,
      replicaId: deployment.instances[0]!.id, volumeId: volume.volumeId, volumeInstanceId: volume.instanceId, imageDigest: deployment.meta.imageDigest });
  }
  return { observe, async inspect(source: MigrationVersionSource) {
    const reviewed = migrationVersionSourceSchema.parse(source);
    if (!isDeepStrictEqual(await observe(reviewed), reviewed)) return invalid();
    const inventory = migrationSourceInventorySchema.parse(await read(reviewed));
    if (!isDeepStrictEqual(await observe(reviewed), reviewed)) return invalid();
    return inventory;
  } };
}

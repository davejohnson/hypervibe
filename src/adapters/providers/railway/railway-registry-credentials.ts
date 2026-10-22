import { createHash } from 'node:crypto';
import { GraphQLClient, gql } from 'graphql-request';
import { z } from 'zod';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type { RegistryCredentialRepairPort } from '../../../domain/ports/registry-credentials.port.js';

const identity = z.string().min(1);
const snapshot = z.object({
  id: identity, serviceId: identity, environmentId: identity, deletedAt: z.null(),
  source: z.object({ image: identity, repo: z.null() }),
  cronSchedule: z.string().nullable(), startCommand: z.string().nullable(),
  healthcheckPath: z.string().nullable(), numReplicas: z.number().nullable(),
  preDeployCommand: z.unknown().refine(value => value !== undefined),
});

export function railwayRegistryCredentialRepair(client: () => GraphQLClient | null): RegistryCredentialRepairPort {
  const port: RegistryCredentialRepairPort = {
    async observe(environment, serviceName) {
      try {
        const bindings = parseHostingBindings(environment);
        const serviceId = bindings.services?.[serviceName]?.serviceId;
        if (bindings.provider !== 'railway' || !bindings.projectId || !bindings.environmentId || !serviceId || !client()) throw new Error();
        const response = await client()!.request<{ service: unknown; serviceInstance: unknown }>(gql`
          query RegistryCredentialTarget($serviceId: String!, $environmentId: String!) {
            service(id: $serviceId) { id projectId }
            serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
              id serviceId environmentId deletedAt source { image repo }
              cronSchedule startCommand healthcheckPath numReplicas preDeployCommand
            }
          }
        `, { serviceId, environmentId: bindings.environmentId });
        const service = z.object({ id: identity, projectId: identity }).parse(response.service);
        const instance = snapshot.parse(response.serviceInstance);
        if (service.id !== serviceId || service.projectId !== bindings.projectId
          || instance.serviceId !== serviceId || instance.environmentId !== bindings.environmentId) throw new Error();
        return { serviceId, instanceId: instance.id,
          providerScope: { projectId: bindings.projectId, environmentId: bindings.environmentId },
          image: instance.source.image,
          configurationHash: createHash('sha256').update(JSON.stringify(instance)).digest('hex') };
      } catch { throw new Error('Cannot verify the exact existing image-backed service for registry credential repair.'); }
    },
    async update(environment, serviceName, reviewed, credentials) {
      let attempted = false;
      try {
        if (JSON.stringify(await port.observe(environment, serviceName)) !== JSON.stringify(reviewed)) return { state: 'rejected', mutationAttempted: false };
        attempted = true;
        const result = await client()!.request<{ serviceInstanceUpdate: unknown }>(gql`
          mutation RepairRegistryCredentials($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
            serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
          }
        `, { serviceId: reviewed.serviceId, environmentId: reviewed.providerScope.environmentId,
          input: { registryCredentials: { username: credentials.username, password: credentials.token } } });
        if (result.serviceInstanceUpdate === false) return { state: 'rejected', mutationAttempted: true };
        if (result.serviceInstanceUpdate !== true) return { state: 'uncertain', mutationAttempted: true };
        if (JSON.stringify(await port.observe(environment, serviceName)) !== JSON.stringify(reviewed)) return { state: 'uncertain', mutationAttempted: true };
        return { state: 'acknowledged', mutationAttempted: true };
      } catch { return { state: attempted ? 'uncertain' : 'rejected', mutationAttempted: attempted }; }
    },
  };
  return port;
}

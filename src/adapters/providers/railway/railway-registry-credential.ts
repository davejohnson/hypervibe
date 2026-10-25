import { isDeepStrictEqual } from 'node:util';
import { gql, type GraphQLClient } from 'graphql-request';
import { z } from 'zod';
import type { RegistryCredentialLifecycle } from '../../../domain/ports/registry-credential.port.js';

export function createRailwayRegistryCredentialLifecycle(client: () => GraphQLClient | null): RegistryCredentialLifecycle {
  const identity = z.string().min(1);
  const scope = z.object({ provider: z.literal('railway'), projectId: identity, environmentId: identity, services: z.record(z.string(), z.object({ serviceId: identity })) });
  const observed = z.object({ project: z.object({ id: identity }), environment: z.object({ id: identity, projectId: identity, deletedAt: z.null() }), service: z.object({ id: identity, projectId: identity, deletedAt: z.null() }), serviceInstance: z.object({ id: identity, serviceId: identity, environmentId: identity, deletedAt: z.null(), source: z.object({ image: identity, repo: z.null().optional() }) }) });
  const port: RegistryCredentialLifecycle = {
    async inspect(environment, name) {
      try {
        const binding = scope.parse(environment.platformBindings);
        const serviceId = binding.services[name]?.serviceId;
        if (!serviceId || !client()) throw new Error();
        const current = observed.parse(await client()!.request(gql`
          query CredentialRegistryTarget($projectId: String!, $environmentId: String!, $serviceId: String!) {
            project(id: $projectId) { id }
            environment(id: $environmentId) { id projectId deletedAt }
            service(id: $serviceId) { id projectId deletedAt }
            serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id serviceId environmentId deletedAt source { image repo } }
          }`, { projectId: binding.projectId, environmentId: binding.environmentId, serviceId }));
        if (current.project.id !== binding.projectId || current.environment.projectId !== binding.projectId || current.environment.id !== binding.environmentId || current.service.projectId !== binding.projectId || current.service.id !== serviceId || current.serviceInstance.serviceId !== serviceId || current.serviceInstance.environmentId !== binding.environmentId) throw new Error();
        return { provider: 'railway', projectId: binding.projectId, environmentId: binding.environmentId, serviceId, instanceId: current.serviceInstance.id, image: current.serviceInstance.source.image };
      } catch { throw new Error('The exact existing registry credential target cannot be verified.'); }
    },
    async update(environment, service, expected, credential) {
      let attempted = false;
      try {
        const current = await port.inspect(environment, service);
        if (!isDeepStrictEqual(current, expected) || !credential.username || !credential.token) throw new Error();
        attempted = true;
        const result = await client()!.request<{ serviceInstanceUpdate: boolean }>(gql`
          mutation CredentialRegistryUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
            serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
          }`, { serviceId: current.serviceId, environmentId: current.environmentId, input: { registryCredentials: { username: credential.username, password: credential.token } } });
        if (result.serviceInstanceUpdate !== true) throw new Error();
        return { success: true, message: 'Registry credential configuration acknowledged; image pull and runtime activation remain unverified.', data: { mutationAttempted: true, deploymentDeferred: true, runtimeRolloutRequired: true } };
      } catch { return { success: false, message: attempted ? 'Registry credential write is uncertain.' : 'Registry target changed or cannot be verified; no write attempted.', data: { mutationAttempted: attempted } }; }
    },
  };
  return port;
}

import { isDeepStrictEqual } from 'node:util';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { RegistryCredentialLifecycle, RegistryCredentialTarget } from '../../../domain/ports/registry-credential.port.js';
import type { DigitalOceanClient } from './digitalocean.client.js';

export function createDigitalOceanRegistryCredentialLifecycle(client: () => DigitalOceanClient | null): RegistryCredentialLifecycle {
  const observe = async (environment: Environment, service: string) => {
    const binding = parseHostingBindings(environment);
    const serviceId = binding.services?.[service]?.serviceId;
    const parts = serviceId?.split(':');
    if (binding.provider !== 'digitalocean' || !client() || !binding.projectId || !parts || parts.length !== 3 || parts[0] !== binding.projectId
      || (binding.environmentId && binding.environmentId !== binding.projectId) || !['services', 'workers', 'jobs'].includes(parts[1]!)) throw new Error();
    const collection = parts[1] as 'services' | 'workers' | 'jobs';
    const app = await client()!.getApp(binding.projectId);
    const matches = app?.spec[collection]?.filter(item => item.name === parts[2]);
    const component = matches?.length === 1 ? matches[0] : undefined;
    if (!app || app.id !== binding.projectId || !component?.image || component.github || component.git
      || !['GHCR', 'DOCKER_HUB'].includes(component.image.registry_type)) throw new Error();
    const image = component.image;
    const registry = image.registry_type === 'GHCR' ? 'ghcr.io' : 'docker.io';
    const target: RegistryCredentialTarget = { provider: 'digitalocean', projectId: app.id, environmentId: app.id,
      serviceId: serviceId!, instanceId: serviceId!, registry, credentialReference: `${serviceId}/image.registry_credentials`,
      image: `${registry}/${image.registry ? `${image.registry}/` : ''}${image.repository}${image.digest ? `@${image.digest}` : `:${image.tag || 'latest'}`}`, activation: 'provider-rollout' };
    return { app, component, collection, target };
  };
  return {
    async inspect(environment, service) {
      try { return (await observe(environment, service)).target; }
      catch { throw new Error('The exact existing DigitalOcean image credential target cannot be verified. DOCR uses native registry access; external private images must identify a GHCR or Docker Hub image.'); }
    },
    async update(environment, service, expected, credential) {
      let attempted = false;
      try {
        const { app, component, collection, target } = await observe(environment, service);
        if (!isDeepStrictEqual(expected, target) || !credential.username || credential.username.includes(':') || !credential.token) throw new Error();
        const spec = { ...app.spec, [collection]: app.spec[collection]!.map(item => item === component
          ? { ...item, image: { ...item.image!, registry_credentials: `${credential.username}:${credential.token}` } } : item) };
        attempted = true;
        const result = await client()!.updateApp(app.id, spec);
        if (result.id !== app.id) throw new Error();
        const after = await observe(environment, service);
        if (!isDeepStrictEqual(after.target, target)) throw new Error();
        return { success: true, message: 'DigitalOcean accepted the selected image credential. Its automatic deployment and image pull still require verification.', data: { mutationAttempted: true, configurationUpdated: true, credentialValueEvidence: 'acknowledgement', credentialUpdateActivation: 'provider-rollout', runtimeRolloutRequired: true } };
      } catch { return { success: false, message: attempted ? 'DigitalOcean registry credential write is uncertain. Inspect the app update and deployment before another write.' : 'DigitalOcean registry target changed or is unverified; no write attempted.', data: { mutationAttempted: attempted } }; }
    },
  };
}

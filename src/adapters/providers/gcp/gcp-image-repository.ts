import type { EngineConfiguration, EngineStateIdentity } from '../../../domain/ports/infrastructure-engine.port.js';
import { artifactRegistryRepositoryName, buildArtifactRegistryConfiguration } from './tofu/gcp-project.backend.js';

/**
 * A release pushes its image to the repository in the environment's own region.
 * Project setup creates one repository, in the region chosen at setup; an
 * environment in any other region needs its own before it can be released.
 * Images outlive any one environment, so the repository never lives in an
 * environment's state: each region has one project-shared state.
 */
export function imageRepositoryState(projectId: string, region: string, environmentProjectId?: string): EngineStateIdentity {
  const environmentId = environmentProjectId ? `image_repository_${environmentProjectId}_${region}` : `image-repository-${region}`;
  return { provider: 'gcp', projectId, environmentId, partition: 'project-shared' };
}

export function imageRepositoryConfiguration(gcpProjectId: string, region: string): EngineConfiguration {
  return buildArtifactRegistryConfiguration({ projectId: gcpProjectId, region });
}

export type ImageRepositoryObservation = { state: 'present' } | { state: 'absent' } | { state: 'unknown'; reason: string };

/** Only a provider-confirmed 404 is absence; any other failure blocks instead of creating. */
export async function observeImageRepository(token: string, gcpProjectId: string, region: string,
  request: typeof fetch = fetch): Promise<ImageRepositoryObservation> {
  const name = artifactRegistryRepositoryName(gcpProjectId, region);
  let response: Response;
  try {
    response = await request(`https://artifactregistry.googleapis.com/v1/${name}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return { state: 'unknown', reason: `Google could not be reached to check the image repository in ${region}. Nothing was planned; try again.` };
  }
  if (response.status === 404) return { state: 'absent' };
  if (!response.ok) return { state: 'unknown', reason: `Google did not confirm whether the image repository in ${region} exists (HTTP ${response.status}). Nothing was planned.` };
  const body = await response.json().catch(() => undefined) as { name?: string; format?: string } | undefined;
  if (body?.name !== name || body.format !== 'DOCKER') {
    return { state: 'unknown', reason: `The image repository in ${region} exists but is not a Docker repository Hypervibe can release to.` };
  }
  return { state: 'present' };
}

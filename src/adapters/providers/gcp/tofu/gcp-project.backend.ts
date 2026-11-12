import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';

/** Shared with the existing build and CI image paths; never rename during cutover. */
export const GCP_ARTIFACT_REPOSITORY = 'hypervibe';

function assertScope(projectId: string, region: string): void {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('GCP project id is invalid.');
  if (!/^[a-z]+-[a-z]+[0-9]$/.test(region)) throw new Error('GCP region is invalid.');
}

export function artifactRegistryRepositoryName(projectId: string, region: string): string {
  assertScope(projectId, region);
  return `projects/${projectId}/locations/${region}/repositories/${GCP_ARTIFACT_REPOSITORY}`;
}

export function artifactRegistryEngineAddress(region: string): string {
  if (!/^[a-z]+-[a-z]+[0-9]$/.test(region)) throw new Error('GCP region is invalid.');
  return `google_artifact_registry_repository.release_images_${region.replaceAll('-', '_')}`;
}

/**
 * Contribution to the project-shared engine state, never an environment state.
 * The caller must prove an exact state binding or provider-confirmed absence
 * before planning. A same-named live repository is not permission to adopt it.
 *
 * Provider contract: hashicorp/google 8.9.0, pinned under
 * test/provider-contracts/gcp/artifact-registry. Existing images outlive any one
 * environment; both engine and provider deletion guards preserve the repository.
 */
export function buildArtifactRegistryConfiguration(input: { projectId: string; region: string }): EngineConfiguration {
  assertScope(input.projectId, input.region);
  const address = artifactRegistryEngineAddress(input.region);
  const key = address.split('.')[1]!;
  return {
    files: {
      [`artifact-registry-${input.region}.tf.json`]: {
        resource: {
          google_artifact_registry_repository: {
            [key]: {
              project: input.projectId,
              location: input.region,
              repository_id: GCP_ARTIFACT_REPOSITORY,
              format: 'DOCKER',
              mode: 'STANDARD_REPOSITORY',
              description: 'Container images built by Hypervibe',
              deletion_policy: 'PREVENT',
              lifecycle: [{ prevent_destroy: true }],
            },
          },
        },
      },
    },
    resources: {
      [address]: { actionId: `artifact-repository:${input.region}`, kind: 'repo', name: 'release images', billable: true, dataBearing: true },
    },
  };
}

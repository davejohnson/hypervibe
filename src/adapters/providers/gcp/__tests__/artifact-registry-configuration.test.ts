import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { buildArtifactRegistryConfiguration, artifactRegistryEngineAddress, artifactRegistryRepositoryName } from '../tofu/gcp-project.backend.js';
import { GOOGLE_PROVIDER_VERSION } from '../tofu/gcp-engine.backend.js';
import { parseEnginePlan, translateEnginePlan } from '../../../engine/opentofu/plan-mapping.js';

describe('project-shared Artifact Registry configuration', () => {
  it('pins the independent official source used by the release and engine boundary checks', () => {
    const directory = new URL('../../../../../test/provider-contracts/gcp/artifact-registry/', import.meta.url);
    const contract = JSON.parse(readFileSync(new URL('source.json', directory), 'utf8'));
    expect(contract.providerVersion).toBe(GOOGLE_PROVIDER_VERSION);
    for (const entry of contract.files) {
      expect(createHash('sha256').update(readFileSync(new URL(entry.file, directory))).digest('hex')).toBe(entry.sha256);
    }
  });

  it('keeps the existing image destination while making repository creation an explicitly reviewed action', () => {
    const configuration = buildArtifactRegistryConfiguration({ projectId: 'demo-project', region: 'us-central1' });
    const address = artifactRegistryEngineAddress('us-central1');
    const file = configuration.files['artifact-registry-us-central1.tf.json'] as any;
    expect(file.resource.google_artifact_registry_repository.release_images_us_central1).toMatchObject({
      project: 'demo-project', location: 'us-central1', repository_id: 'hypervibe', format: 'DOCKER',
      mode: 'STANDARD_REPOSITORY', deletion_policy: 'PREVENT', lifecycle: [{ prevent_destroy: true }],
    });
    expect(configuration.imports).toBeUndefined();
    expect(artifactRegistryRepositoryName('demo-project', 'us-central1')).toBe('projects/demo-project/locations/us-central1/repositories/hypervibe');
    const changes = parseEnginePlan(JSON.stringify({ resource_changes: [{
      address, type: 'google_artifact_registry_repository', change: { actions: ['create'], before: null, after: { repository_id: 'hypervibe' } },
    }] }));
    const result = translateEnginePlan({ provider: 'gcp', parsed: changes, configuration, segment: { id: 'segment-1', engine: 'opentofu', planDigest: 'plan', configurationDigest: 'configuration', engineVersion: '1.13.9', providerVersions: { google: GOOGLE_PROVIDER_VERSION } } });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ id: 'artifact-repository:us-central1', type: 'create', resource: { kind: 'repo' }, billable: true });
    expect(result.blockers).toEqual([]);
  });

  it('keeps regions separate inside one shared state and rejects invalid scope', () => {
    expect(artifactRegistryEngineAddress('us-central1')).not.toBe(artifactRegistryEngineAddress('us-west1'));
    expect(() => buildArtifactRegistryConfiguration({ projectId: '../other-project', region: 'us-central1' })).toThrow(/project id/);
    expect(() => buildArtifactRegistryConfiguration({ projectId: 'demo-project', region: '../us-west1' })).toThrow(/region/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CLOUD_PREPARE_PROFILES,
  QUEUE_PREPARE_ADDON,
  getCloudPreparation,
  isCloudPrepared,
  isCloudPreparedForRegion,
  isCloudPreparedForStorage,
  withCloudPreparationRecord,
  isCloudPreparedForQueues,
} from '../cloud-prepare.js';

function preparedProject(options: { queueAddon: boolean }) {
  const profile = CLOUD_PREPARE_PROFILES.cloudrun;
  return {
    policies: {
      cloudPreparation: {
        cloudrun: {
          provider: 'cloudrun',
          version: profile.version,
          preparedAt: new Date().toISOString(),
          requiredApis: [
            ...profile.requiredApis,
            ...(options.queueAddon ? QUEUE_PREPARE_ADDON.requiredApis : []),
          ],
          requiredRoles: [
            ...profile.requiredRoles,
            ...(options.queueAddon ? QUEUE_PREPARE_ADDON.requiredRoles : []),
          ],
        },
      },
    },
  };
}

describe('cloud-prepare queue addon', () => {
  it('keeps a v1 record without the queue addon base-prepared (no regression)', () => {
    const project = preparedProject({ queueAddon: false });
    expect(isCloudPrepared(project, 'cloudrun')).toBe(true);
  });

  it('does not consider that record queue-prepared', () => {
    const project = preparedProject({ queueAddon: false });
    expect(isCloudPreparedForQueues(project, 'cloudrun')).toBe(false);
  });

  it('is queue-prepared once the record includes the addon apis and roles', () => {
    const project = preparedProject({ queueAddon: true });
    expect(isCloudPrepared(project, 'cloudrun')).toBe(true);
    expect(isCloudPreparedForQueues(project, 'cloudrun')).toBe(true);
  });

  it('is neither prepared nor queue-prepared without a record', () => {
    const project = { policies: {} };
    expect(isCloudPrepared(project, 'cloudrun')).toBe(false);
    expect(isCloudPreparedForQueues(project, 'cloudrun')).toBe(false);
  });
});

describe('preparation evidence for dedicated GCP projects', () => {
  const production = 'app-production';
  const staging = 'app-staging';
  const legacy = 'app-legacy';

  function evidence(gcpProjectId: string, region: string) {
    const base = preparedProject({ queueAddon: gcpProjectId === production }).policies.cloudPreparation.cloudrun;
    return { ...base, provider: 'cloudrun' as const, gcpProjectId, artifactRepositoryRegions: [region],
      requiredRoles: [...base.requiredRoles, ...(gcpProjectId === staging ? ['roles/storage.admin'] : [])] };
  }

  it.each([[production, staging], [staging, production]])('keeps projects and regions independent when writing %s then %s', (first, second) => {
    const legacyEvidence = evidence(legacy, 'us-central1');
    const project = { policies: withCloudPreparationRecord({}, 'cloudrun', legacyEvidence) };
    expect(getCloudPreparation(project, 'cloudrun', production)).toBeNull();

    for (const id of [first, second]) {
      project.policies = withCloudPreparationRecord(project.policies, 'cloudrun',
        evidence(id, id === production ? 'us-west1' : 'us-east1'), id);
    }

    expect(getCloudPreparation(project, 'cloudrun')).toMatchObject(legacyEvidence);
    expect(isCloudPreparedForRegion(project, 'us-west1', production)).toBe(true);
    expect(isCloudPreparedForRegion(project, 'us-west1', staging)).toBe(false);
    expect(isCloudPreparedForQueues(project, 'cloudrun', production)).toBe(true);
    expect(isCloudPreparedForQueues(project, 'cloudrun', staging)).toBe(false);
    expect(isCloudPreparedForStorage(project, staging)).toBe(true);
    expect(isCloudPreparedForStorage(project, production)).toBe(false);
    expect(isCloudPreparedForStorage(project)).toBe(false);
  });

  it('refuses to record preparation verified for a different native project', () => {
    const stagingEvidence = evidence(staging, 'us-east1');
    expect(() => withCloudPreparationRecord({}, 'cloudrun', stagingEvidence, production)).toThrow(/project/i);
    const malformed = { policies: { gcpProjectPreparations: { [production]: stagingEvidence } } };
    expect(getCloudPreparation(malformed, 'cloudrun', production)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  CLOUD_PREPARE_PROFILES,
  QUEUE_PREPARE_ADDON,
  isCloudPrepared,
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

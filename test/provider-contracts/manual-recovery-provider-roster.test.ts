import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { managedRecoveryTaskCheckpointSchema } from '../../src/domain/ports/managed-recovery-task.port.js';

// Capability admission, not live support. Native distinctions and evidence limits
// are recorded in docs/manual-recovery-task-evidence.md.
describe('durable manual recovery task admission', () => {
  const names = ['azure-container-apps', 'cloudrun', 'digitalocean', 'ecs', 'fly', 'railway', 'vercel'];
  it('requires an explicit named review for every registered hosting provider', () => {
    expect(providerRegistry.namesFor('hosting').sort()).toEqual(names);
  });
  it.each(names)('%s cannot inherit durable recovery from generic job support', name => {
    const capability = providerRegistry.getMetadata(name)?.lifecycle?.hosting?.recoveryTasks;
    expect(capability?.durableProgress === true).toBe(name === 'cloudrun');
    if (name === 'cloudrun') expect(capability).toMatchObject({ variableMode: 'references', execution: 'temporary-workload', databaseProviders: ['cloudsql'], status: 'ready-for-live' });
  });
  it('requires terminal success and value-free coordinates in completed checkpoints', () => {
    const valid = { version: 1, provider: 'cloudrun', authorityHash: 'a'.repeat(64), phase: 'complete',
      coordinates: { jobName: 'projects/test/locations/us-central1/jobs/recovery' }, terminal: { status: 'succeeded', exitCode: 0 } };
    expect(managedRecoveryTaskCheckpointSchema.safeParse(valid).success).toBe(true);
    for (const changed of [
      { ...valid, terminal: undefined }, { ...valid, terminal: { status: 'succeeded', exitCode: 1 } },
      { ...valid, phase: 'running' }, { ...valid, coordinates: { accessToken: 'synthetic-token' } },
      { ...valid, coordinates: { jobName: 'https://not-a-native-coordinate.example' } },
      { ...valid, unexpected: 'not-approved' },
    ]) expect(managedRecoveryTaskCheckpointSchema.safeParse(changed).success).toBe(false);
  });
});

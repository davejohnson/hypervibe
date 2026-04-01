import { describe, expect, it } from 'vitest';
import { filterEnvironmentsByName, summarizeSecretSyncResults } from '../secrets.tools.js';

describe('secrets.tools contract', () => {
  it('filters environments by exact name when provided', () => {
    const envs = [{ name: 'local' }, { name: 'staging' }, { name: 'production' }];
    expect(filterEnvironmentsByName(envs, 'staging')).toEqual([{ name: 'staging' }]);
    expect(filterEnvironmentsByName(envs, undefined)).toEqual(envs);
  });

  it('summarizes sync results consistently', () => {
    const summary = summarizeSecretSyncResults([
      { resolved: 2, failed: 1, synced: true },
      { resolved: 3, failed: 0, synced: false },
      { resolved: 0, failed: 2, synced: false },
    ]);
    expect(summary).toEqual({
      totalResolved: 5,
      totalFailed: 3,
      totalSynced: 1,
    });
  });
});

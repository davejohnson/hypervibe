import { describe, expect, it } from 'vitest';
import { DevOpsProviderRegistry } from '../devops.registry.js';

describe('DevOpsProviderRegistry', () => {
  it('admits a third provider id without changing schemas or generic routing', () => {
    const registry = new DevOpsProviderRegistry();
    registry.registerCodeHost({
      id: 'bitbucket',
      connectionProvider: 'bitbucket',
      suggestedCiProvider: 'bitbucket-pipelines',
      create: () => ({ observeRepository: async () => ({ state: 'absent' as const }) }),
    });
    registry.registerCiProvider({
      id: 'bitbucket-pipelines',
      connectionProvider: 'bitbucket',
      compatibleCodeProviders: ['bitbucket'],
      create: () => ({
        listDefinitions: async () => [],
        listRuns: async () => [],
        listJobs: async () => [],
        getJobLog: async () => '',
        listArtifacts: async () => [],
        dispatch: async () => { throw new Error('not used'); },
      }),
      lifecycle: {
        planDeploy: async () => ({ warnings: [] }),
        applyDeploy: async () => ({ success: false, status: 'blocked', message: 'not implemented' }),
      },
    });

    expect(registry.codeHostIds()).toEqual(['bitbucket']);
    expect(registry.ciProviderIds()).toEqual(['bitbucket-pipelines']);
    expect(registry.compatible('bitbucket', 'bitbucket-pipelines')).toBe(true);
    expect(registry.compatible('github', 'bitbucket-pipelines')).toBe(false);
  });
});

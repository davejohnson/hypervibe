import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import {
  githubActionsServerProgramFingerprint,
  githubActionsWorkflowInputHash
} from '../github-ops.service.js';

// Published input contract before provider-scoped renderer migrations. Keep the
// literal revision and omission of provider metadata independent of production.
function previousInputHash(provider: string, inputTarget: BranchDeployTarget,
  migration: { includeStep: boolean; command?: string }): string {
  const target = { ...inputTarget };
  delete target.providerImageUris;
  delete target.programFingerprint;
  delete target.deploymentContractFingerprint;
  return canonicalJsonSha256({
    version: 1, rendererRevision: 6, provider, target,
    migration: { includeStep: migration.includeStep,
      ...(migration.includeStep && migration.command ? { command: migration.command } : {}) },
  });
}

beforeEach(() => {
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(':memory:').migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
});

describe('provider-scoped managed workflow migrations', () => {

  const target: BranchDeployTarget = {
    environmentName: 'test', kind: 'test', branch: 'main', autoDeployOnPush: false,
    serviceNames: ['web'], providerServiceIds: ['bound-web'],
  };
  const migration = { includeStep: false };

  it('requires reviewed credential evidence producer migrations for every hosting provider', () => {
    // Shared revision 7 adds operation-bound activation evidence to every native
    // deploy producer. Each existing revision 6 workflow must be reviewed again.
    const changed = ['azure-container-apps', 'ecs', 'railway'];
    expect(providerRegistry.all().filter(provider => provider.metadata.orchestration?.ci).map(provider => provider.metadata.name).sort()).toEqual(changed.sort());
    for (const provider of changed) {
      expect(githubActionsWorkflowInputHash({ provider, target, migration }), provider)
        .not.toBe(previousInputHash(provider, target, migration));
    }
  });

  it('uses declared provider revisions generically without changing the server program', () => {
    const provider = 'railway';
    const inputBefore = githubActionsWorkflowInputHash({ provider, target, migration });
    const programBefore = githubActionsServerProgramFingerprint({ provider, target, migration });
    const lookup = providerRegistry.getMetadata.bind(providerRegistry);
    vi.spyOn(providerRegistry, 'getMetadata').mockImplementation(name => {
      const metadata = lookup(name);
      return name === provider ? { ...metadata!, orchestration: { ...metadata!.orchestration,
        ci: { ...metadata!.orchestration!.ci!, rendererRevision: 99 } } } : metadata;
    });
    expect(githubActionsWorkflowInputHash({ provider, target, migration })).not.toBe(inputBefore);
    expect(githubActionsServerProgramFingerprint({ provider, target, migration })).toBe(programBefore);
  });
});

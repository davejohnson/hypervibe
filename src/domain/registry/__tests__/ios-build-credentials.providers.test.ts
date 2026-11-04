import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/devops-providers.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../../adapters/secrets/secret-store.js';
import { devOpsProviderRegistry } from '../devops.registry.js';

// Native environment-scoped variables do not imply a managed iOS release path.
// GitHub: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idenvironment
// GitLab: https://docs.gitlab.com/ci/environments/#limit-the-environment-scope-of-a-cicd-variable
// Transport fixtures reconstruct only the documented repository identity reads;
// this tests Hypervibe's unsupported boundary, not live GitLab iOS compatibility.
const reviewedCiProviders = {
  'github-actions': 'Implemented; serialized transport and shared lifecycle tests cover the exact environment read.',
};

let directory: string;
beforeEach(() => {
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-ios-ci-matrix-'));
  initializeDatabase(path.join(directory, 'test.db'));
});
afterEach(() => {
  vi.restoreAllMocks();
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

describe('iOS build credentials named CI provider review', () => {
  it('requires an explicit decision for every registered CI provider', () => {
    expect(devOpsProviderRegistry.ciProviderIds().sort()).toEqual(Object.keys(reviewedCiProviders).sort());
  });

});

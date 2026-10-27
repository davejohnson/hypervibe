import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { AdapterFactory } from '../adapter.factory.js';

// DG-055 requires exact repository scope. A nested repository's final two
// segments are a different repository, not an authorized alias. Exercise the
// real SQLite/encrypted connection/factory boundary; no provider compatibility
// claim is made by the synthetic adapter that exposes its selected account.
const provider = 'repository-scope-native-contract';
providerRegistry.register({
  metadata: { name: provider, displayName: provider, category: 'deployment',
    credentialsSchema: z.object({ authMode: z.literal('default'), accountId: z.string() }) },
  factory: async credentials => ({ name: provider, accountId: (credentials as { accountId: string }).accountId }),
});
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-repository-connection-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
});
afterEach(() => { SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function seed(scope: string | null, accountId: string) {
  new ConnectionRepository().upsertVerifiedBatch([{ provider, scope,
    credentialsEncrypted: getSecretStore().encryptObject({ authMode: 'default', accountId }) }]);
}
async function resolve(remote: string) {
  const project = new ProjectRepository().create({ name: 'sequence', gitRemoteUrl: remote });
  return new AdapterFactory().getProviderAdapter(provider, project);
}

describe('shared adapter factory repository authority', () => {
  it('selects the exact nested repository connection before global or a shortened different repository', async () => {
    seed('gitlab.example.com/studio/team/sequence', 'selected-account');
    seed('team/sequence', 'different-repository-account');
    seed(null, 'global-account');
    expect(await resolve('git@gitlab.example.com:studio/team/sequence.git')).toMatchObject({
      success: true, adapter: { accountId: 'selected-account' },
    });
  });
  it('does not authorize a different nested repository sharing the final two path segments', async () => {
    seed('team/sequence', 'different-repository-account');
    expect(await resolve('git@gitlab.example.com:studio/team/sequence.git')).toMatchObject({ success: false });
  });
  it('recognizes an explicitly scoped full nested namespace without truncation', async () => {
    seed('studio/team/sequence', 'selected-account');
    expect(await resolve('git@gitlab.example.com:studio/team/sequence.git')).toMatchObject({
      success: true, adapter: { accountId: 'selected-account' },
    });
  });
  it.each([
    { entries: [['github.com/studio/sequence', 'host'], ['studio/sequence', 'repository'], [null, 'global']], expected: 'host' },
    { entries: [['github.com/studio/*', 'host-wildcard'], ['studio/sequence', 'repository'], [null, 'global']], expected: 'host-wildcard' },
    { entries: [['studio/sequence', 'repository'], ['studio/*', 'organization'], [null, 'global']], expected: 'repository' },
    { entries: [['studio/other', 'different'], [null, 'global']], expected: 'global' },
  ])('preserves existing GitHub exact/wildcard/global precedence: $expected', async ({ entries, expected }) => {
    for (const [scope, account] of entries) seed(scope!, account!);
    expect(await resolve('git@github.com:studio/sequence.git')).toMatchObject({ success: true, adapter: { accountId: expected } });
  });
});

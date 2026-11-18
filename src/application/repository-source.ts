import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { isRepositorySourceAdapter, RepositorySourceError, type RepositorySourceArchive } from '../domain/ports/repository-source.port.js';
import { normalizeGitRemoteIdentity } from '../lib/git-remote.js';

/** Select only a verified connection authorized for the project's exact repository. */
export async function repositorySourceArchive(params: { projectRemote?: string; specRemote?: string; revision: string }): Promise<RepositorySourceArchive | { blocked: string }> {
  const projectIdentity = normalizeGitRemoteIdentity(params.projectRemote);
  const specIdentity = normalizeGitRemoteIdentity(params.specRemote);
  if (projectIdentity && specIdentity && projectIdentity.toLowerCase() !== specIdentity.toLowerCase()) {
    return { blocked: 'The project and spec name different source repositories. Reconcile the repository selection before deploying. Nothing was built.' };
  }
  const identity = projectIdentity ?? specIdentity;
  const repository = identity?.match(/^github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i)?.[1];
  const guidance = 'Run from this app’s local git repository, or connect GitHub for this repository. Nothing was built.';
  if (!repository) return { blocked: `Hypervibe cannot download this repository’s source. ${guidance}` };
  const connection = new ConnectionRepository().findBestVerifiedMatch('github', repository);
  if (!connection) return { blocked: `No verified GitHub connection can read this repository. ${guidance}` };
  try {
    const adapter = await providerRegistry.createAdapter('github', getSecretStore().decryptObject(connection.credentialsEncrypted));
    if (!isRepositorySourceAdapter(adapter)) return { blocked: `This repository connection cannot download source archives. ${guidance}` };
    return await adapter.readSourceArchive(repository, params.revision);
  } catch (error) {
    // The provider emits locally classified errors, never raw HTTP bodies or signed URLs.
    return { blocked: `${error instanceof RepositorySourceError ? error.message : 'GitHub source retrieval failed. Check the repository connection and retry.'} ${guidance}` };
  }
}

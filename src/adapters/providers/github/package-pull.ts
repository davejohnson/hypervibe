import { ConnectionRepository } from '../../db/repositories/connection.repository.js';
import { getSecretStore } from '../../secrets/secret-store.js';

/**
 * Rank a GitHub connection scope against a repo for credential selection:
 * exact repo match beats owner wildcard beats unscoped; null = unusable.
 */
export function githubConnectionRank(scope: string | null, repo?: string): number | null {
  if (!repo) {
    return scope === null ? 0 : 1;
  }
  if (scope === repo) {
    return 0;
  }
  if (scope?.endsWith('/*') && repo.startsWith(scope.slice(0, -1))) {
    return 1;
  }
  if (scope === null) {
    return 2;
  }
  return null;
}

/**
 * GHCR pull credentials (username + read:packages token) from the best
 * verified GitHub connection — the same pair hv_ci_setup syncs to GitHub
 * Actions as IMAGE_REGISTRY_USERNAME/IMAGE_REGISTRY_TOKEN.
 */
export function githubPackagePullCredentials(
  options: { githubRepo?: string; githubLogin?: string } = {}
): { username: string; token: string } | null {
  const connectionRepo = new ConnectionRepository();
  const secretStore = getSecretStore();
  const ranked = connectionRepo.findAllByProvider('github')
    .filter((connection) => connection.status === 'verified')
    .flatMap((connection) => {
      const rank = githubConnectionRank(connection.scope, options.githubRepo);
      return rank === null ? [] : [{ connection, rank }];
    })
    .sort((a, b) => a.rank - b.rank);

  for (const { connection } of ranked) {
    const credentials = secretStore.decryptObject<Record<string, unknown>>(connection.credentialsEncrypted);
    const username =
      options.githubLogin
      ?? (typeof credentials.login === 'string' ? credentials.login : undefined)
      ?? (typeof credentials.username === 'string' ? credentials.username : undefined);
    const token =
      typeof credentials.packageReadToken === 'string' && credentials.packageReadToken.length > 0
        ? credentials.packageReadToken
        : undefined;
    if (username && token) {
      return { username, token };
    }
  }
  return null;
}

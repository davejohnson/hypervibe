import { execSync } from 'child_process';

/**
 * Detect the git remote URL of the current working directory.
 */
export function detectGitRemoteUrl(startDir = process.cwd()): string | null {
  try {
    return execSync('git remote get-url origin', {
      cwd: startDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Normalize a Git remote to a credential-free host/path identity for comparison.
 * Supports URL and scp-style SSH remotes without assuming a hosting provider.
 */
export function normalizeGitRemoteIdentity(remoteUrl?: string): string | null {
  if (!remoteUrl) return null;
  const normalized = remoteUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!normalized) return null;
  if (/^(?:\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(normalized)) return null;

  try {
    const url = new URL(normalized);
    const host = url.host.toLowerCase();
    const repoPath = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return host && repoPath ? `${host}/${repoPath}` : null;
  } catch {
    // Not a URL format, continue with SSH-like parsing.
  }

  const sshMatch = normalized.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+)$/i);
  if (!sshMatch) return null;
  const host = sshMatch[1].toLowerCase();
  const repoPath = sshMatch[2].replace(/^\/+/, '').replace(/\/+$/, '');
  return host && repoPath ? `${host}/${repoPath}` : null;
}

/**
 * Parse an "owner/repo" pair from a GitHub remote URL.
 * Supports https, ssh://, and scp-style (git@github.com:owner/repo) remotes.
 * Returns null for non-GitHub remotes.
 */
export function parseGitHubRepoFromRemote(remoteUrl?: string): string | null {
  if (!remoteUrl) {
    return null;
  }

  const normalized = remoteUrl.trim().replace(/\.git$/i, '');

  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }
    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
  } catch {
    // Not a URL format, continue with SSH-like parsing.
  }

  const sshMatch = normalized.match(/^(?:ssh:\/\/)?(?:git@)?github\.com[:/](.+)$/i);
  if (!sshMatch) {
    return null;
  }

  const parts = sshMatch[1].replace(/^\/+/, '').split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

/**
 * Parse the repository path from a remote without assuming a hosting provider.
 * Preserves nested namespaces used by GitLab and other Git hosts.
 */
export function parseRepositoryPathFromRemote(remoteUrl?: string): string | null {
  const identity = normalizeGitRemoteIdentity(remoteUrl);
  if (!identity) return null;
  const slash = identity.indexOf('/');
  const repositoryPath = slash >= 0 ? identity.slice(slash + 1) : '';
  return repositoryPath || null;
}

/**
 * Normalize a git remote to a canonical https clone URL for build systems.
 * GitHub remotes become https://github.com/owner/repo.git; anything else
 * passes through trimmed.
 */
export function normalizeGitRemoteForBuild(remoteUrl?: string): string | undefined {
  if (!remoteUrl) {
    return undefined;
  }

  const trimmed = remoteUrl.trim();
  const repo = parseGitHubRepoFromRemote(trimmed);
  if (repo) {
    return `https://github.com/${repo}.git`;
  }

  return trimmed.length > 0 ? trimmed : undefined;
}

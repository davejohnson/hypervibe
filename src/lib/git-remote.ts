import { execSync } from 'child_process';

/**
 * Detect the git remote URL of the current working directory.
 */
export function detectGitRemoteUrl(): string | null {
  try {
    return execSync('git remote get-url origin', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
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

import type { Project } from '../entities/project.entity.js';

/**
 * Build ordered scope hints from a project's git remote.
 * Most-specific first, so connection lookup can try exact then fallback.
 */
export function getProjectScopeHints(project: Project): string[] {
  if (!project.gitRemoteUrl) {
    return [];
  }

  const parsed = parseGitRemote(project.gitRemoteUrl);
  if (!parsed) {
    return [];
  }

  const hints: string[] = [];
  const fullScope = `${parsed.host}/${parsed.path}`;
  hints.push(fullScope);

  const pathParts = parsed.path.split('/').filter(Boolean);
  if (pathParts.length >= 2) {
    const ownerRepo = `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
    if (ownerRepo !== fullScope) {
      hints.push(ownerRepo);
    }
  }

  return hints;
}

interface ParsedRemote {
  host: string;
  path: string;
}

function parseGitRemote(remoteUrl: string): ParsedRemote | null {
  const normalized = remoteUrl.trim().replace(/\.git$/i, '');

  try {
    const url = new URL(normalized);
    return {
      host: url.hostname.toLowerCase(),
      path: url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''),
    };
  } catch {
    // Not a URL format, continue with SSH-like parsing.
  }

  const sshMatch = normalized.match(/^(?:ssh:\/\/)?(?:git@)?([^/:]+)[:/](.+)$/i);
  if (sshMatch) {
    return {
      host: sshMatch[1].toLowerCase(),
      path: sshMatch[2].replace(/^\/+/, '').replace(/\/+$/, ''),
    };
  }
  return null;
}

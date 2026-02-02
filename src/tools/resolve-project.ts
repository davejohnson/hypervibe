import { execSync } from 'child_process';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import type { Project } from '../domain/entities/project.entity.js';

const projectRepo = new ProjectRepository();

/**
 * Detect the git remote URL of the current working directory.
 */
function detectGitRemoteUrl(): string | null {
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
 * Shared project resolver used across all tools.
 *
 * Resolution order:
 * 1. projectId (exact lookup)
 * 2. projectName (exact lookup)
 * 3. Git remote URL of cwd → findByGitRemoteUrl
 * 4. Fallback: if only one project exists, return it
 * 5. Otherwise null
 */
export function resolveProject(opts: {
  projectId?: string;
  projectName?: string;
}): Project | null {
  if (opts.projectId) {
    return projectRepo.findById(opts.projectId);
  }
  if (opts.projectName) {
    return projectRepo.findByName(opts.projectName);
  }

  // Try git remote auto-detection
  const remoteUrl = detectGitRemoteUrl();
  if (remoteUrl) {
    const match = projectRepo.findByGitRemoteUrl(remoteUrl);
    if (match) return match;
  }

  // Fallback: single project
  const all = projectRepo.findAll();
  if (all.length === 1) return all[0];

  return null;
}

/**
 * Like resolveProject but returns an error response object when resolution fails,
 * suitable for direct return from MCP tool handlers.
 */
export function resolveProjectOrError(opts: {
  projectId?: string;
  projectName?: string;
}): { project: Project } | { error: { content: Array<{ type: 'text'; text: string }> } } {
  const project = resolveProject(opts);
  if (project) return { project };

  const all = projectRepo.findAll();
  const errorMessage = all.length === 0
    ? 'No projects found'
    : `Multiple projects found. Specify projectName.`;

  return {
    error: {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: false,
          error: errorMessage,
          ...(all.length > 1 ? { projects: all.map((p) => ({ id: p.id, name: p.name })) } : {}),
        }),
      }],
    },
  };
}

export { detectGitRemoteUrl };

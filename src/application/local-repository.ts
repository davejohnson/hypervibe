import { execFileSync } from 'child_process';
import path from 'path';
import type { Project } from '../domain/entities/project.entity.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';

/**
 * The local checkout to build from: the repository holding a repo-backed spec,
 * or else the current directory when its git remote is this project's remote.
 * Building from the local commit is what lets private repositories deploy
 * without git credentials.
 */
export function localRepositoryFor(project: Pick<Project, 'gitRemoteUrl'>, specSource?: { kind?: string; path?: string }, cwd = process.cwd()): string | undefined {
  if (specSource?.kind === 'repo' && specSource.path) return path.dirname(path.dirname(specSource.path));
  const expected = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!expected) return undefined;
  try {
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return parseGitHubRepoFromRemote(remote)?.toLowerCase() === expected.toLowerCase() ? root : undefined;
  } catch {
    return undefined;
  }
}

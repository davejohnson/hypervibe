import { execFileSync } from 'child_process';
import path from 'path';
import type { Project } from '../domain/entities/project.entity.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { HvError } from './results.js';

/**
 * The local checkout to build from: the repository holding a repo-backed spec,
 * or else the current directory when its git remote is this project's remote.
 * Building from the local commit is what lets private repositories deploy
 * without git credentials.
 */
export function localRepositoryFor(project: Pick<Project, 'gitRemoteUrl'>, specSource?: { kind?: string; path?: string }, cwd = process.cwd()): string | undefined {
  const expected = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (specSource?.kind === 'repo' && specSource.path) {
    const root = path.dirname(path.dirname(specSource.path));
    // A spec is matched to a project by name, and two repositories can share a name.
    // Building from this checkout is allowed only when it is the project's own repository.
    if (expected) {
      let actual: string | undefined;
      try {
        actual = parseGitHubRepoFromRemote(execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) ?? undefined;
      } catch { /* no readable origin */ }
      if (!actual) throw new HvError('VALIDATION', `Hypervibe could not confirm that ${root} is the repository of this project (${expected}): it has no readable GitHub origin. Nothing was built.`);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new HvError('VALIDATION', `The spec in ${root} belongs to a different repository (${actual}) than this project (${expected}). Nothing was built. Run this from the project's own repository.`);
      }
    }
    return root;
  }
  if (!expected) return undefined;
  try {
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return parseGitHubRepoFromRemote(remote)?.toLowerCase() === expected.toLowerCase() ? root : undefined;
  } catch {
    return undefined;
  }
}

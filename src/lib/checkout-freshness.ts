import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { findRepoRoot, repoSpecEnabled, repoSpecPath } from '../domain/spec/repo-spec-file.js';
import { currentWorkspaceDirectories } from './workspace-context.js';

/**
 * Whether an app checkout a command runs in is up to date with its upstream.
 *
 * Hypervibe reads the app's setup and bindings from files in the checkout, so
 * a checkout that is behind describes an older app than the one that exists.
 * Commands that plan or change real things ask here first.
 *
 * - `behind`: the current branch is behind its upstream by `count` commits.
 * - `current`: the upstream was fetched just now and the branch has all of it.
 * - `unchecked`: nothing says the checkout is behind, but that could not be
 *   established; `reason` says why. Never the same as `current`.
 * - `not-applicable`: not an app checkout Hypervibe reads from, or a CI run,
 *   which deploys exactly the commit it was given.
 */
export type CheckoutFreshness =
  | { state: 'current' }
  | { state: 'behind'; count: number; upstream: string }
  | { state: 'unchecked'; reason: string }
  | { state: 'not-applicable' };

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Git, never interactive and never blocking the process: a remote that wants a password fails instead of waiting for
 * someone to type (no terminal prompt, an askpass that answers nothing, no input), and every call has a time limit.
 * The repository's own choice of ssh command is left alone.
 */
function git(root: string, args: string[], timeout = 5_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' } },
    (error, stdout) => resolve({ ok: !error, out: String(stdout ?? '').trim() }));
    child.stdin?.end();
  });
}

export function runningInCi(): boolean {
  return process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true' || process.env.CI === '1';
}

/**
 * The app checkouts a command could read from: every directory of the session whose repository holds an app setup.
 * With the project named, only those whose setup is that project's; a setup that cannot be read is kept, not skipped.
 */
export function appCheckouts(project?: string): string[] {
  if (runningInCi() || !repoSpecEnabled()) return [];
  const roots = new Set<string>();
  for (const directory of currentWorkspaceDirectories() ?? [process.cwd()]) {
    const root = findRepoRoot(directory);
    if (!root || !existsSync(repoSpecPath(root))) continue;
    let named: unknown;
    try { named = (JSON.parse(readFileSync(repoSpecPath(root), 'utf8')) as { project?: unknown }).project; } catch { named = undefined; }
    if (project === undefined || typeof named !== 'string' || named === project) roots.add(root);
  }
  return [...roots];
}

export async function checkoutFreshness(startDir = process.cwd()): Promise<CheckoutFreshness> {
  if (runningInCi() || !repoSpecEnabled()) return { state: 'not-applicable' };
  const root = findRepoRoot(startDir);
  // Only a checkout Hypervibe reads an app's setup from. A server started in some other repository is not held to that repository's state.
  if (!root || !existsSync(repoSpecPath(root))) return { state: 'not-applicable' };
  // A directory that merely has a `.git` entry but is no repository has no upstream to be behind. Git itself missing is different: that is not knowing.
  if (!(await git(root, ['rev-parse', '--git-dir'])).ok) {
    return (await git(root, ['--version'])).ok ? { state: 'not-applicable' } : { state: 'unchecked', reason: 'git could not be run here' };
  }
  const branch = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!branch.ok || !branch.out) return { state: 'unchecked', reason: 'this checkout is not on a branch, so it has nothing to be behind' };
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!upstream.ok || !upstream.out) return { state: 'unchecked', reason: `branch ${branch.out} has no upstream branch to compare with` };
  const remote = (await git(root, ['config', '--get', `branch.${branch.out}.remote`])).out;
  const merge = (await git(root, ['config', '--get', `branch.${branch.out}.merge`])).out;
  // Both names come from the repository's own configuration. Neither is handed to git unless it is a plain remote name
  // and a well-formed branch ref, and never where git could read it as an option.
  const name = merge.replace(/^refs\/heads\//, '');
  const plain = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  if (remote !== '.' && (!plain.test(remote) || !merge.startsWith('refs/heads/') || !plain.test(name) || !(await git(root, ['check-ref-format', merge])).ok)) {
    return { state: 'unchecked', reason: `the upstream of branch ${branch.out} has a name Hypervibe will not hand to git` };
  }
  // One bounded fetch of the one branch. A branch that tracks another local branch has nothing to fetch.
  const fetched = remote === '.' || (await git(root, ['fetch', '--quiet', '--no-tags', '--', remote, `+${merge}:refs/remotes/${remote}/${name}`], FETCH_TIMEOUT_MS)).ok;
  const behind = await git(root, ['rev-list', '--count', 'HEAD..@{upstream}']);
  const count = behind.ok && /^[0-9]+$/.test(behind.out) ? Number(behind.out) : undefined;
  if (count === undefined) return { state: 'unchecked', reason: `this checkout could not be compared with ${upstream.out}` };
  // What was fetched earlier is still evidence: behind that is behind, whether or not the remote answered now.
  if (count > 0) return { state: 'behind', count, upstream: upstream.out };
  return fetched ? { state: 'current' } : { state: 'unchecked', reason: `${remote} could not be reached, so this checkout was compared with what was last fetched from it` };
}

/** The one sentence a refusal says. `where` names the checkout when a session has more than one. */
export function behindMessage(freshness: Extract<CheckoutFreshness, { state: 'behind' }>, where?: string): string {
  return `This checkout${where ? ` (${where})` : ''} is ${freshness.count} commit${freshness.count === 1 ? '' : 's'} behind ${freshness.upstream}. Run git pull, then run this again.`;
}

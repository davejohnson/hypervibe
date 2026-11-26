import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findRepoRoot, repoSpecEnabled, repoSpecPath } from '../domain/spec/repo-spec-file.js';
import { primaryWorkspaceDirectory } from './workspace-context.js';

/**
 * Whether the app checkout a command runs in is up to date with its upstream.
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

/** Git, never interactive: a remote that wants a password or a host key confirmation fails instead of waiting for someone to type. */
function git(root: string, args: string[], timeout = 5_000): { ok: boolean; out: string } {
  const result = spawnSync('git', args, {
    cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND ?? 'ssh'} -oBatchMode=yes -oConnectTimeout=5` },
  });
  return { ok: !result.error && result.status === 0, out: String(result.stdout ?? '').trim() };
}

export function runningInCi(): boolean {
  return process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true' || process.env.CI === '1';
}

export function checkoutFreshness(startDir = primaryWorkspaceDirectory()): CheckoutFreshness {
  if (runningInCi() || !repoSpecEnabled()) return { state: 'not-applicable' };
  const root = findRepoRoot(startDir);
  // Only a checkout Hypervibe reads an app's setup from. A server started in some other repository is not held to that repository's state.
  if (!root || !existsSync(repoSpecPath(root))) return { state: 'not-applicable' };
  const branch = git(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!branch.ok || !branch.out) return { state: 'unchecked', reason: 'this checkout is not on a branch, so it has nothing to be behind' };
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!upstream.ok || !upstream.out) return { state: 'unchecked', reason: `branch ${branch.out} has no upstream branch to compare with` };
  const remote = git(root, ['config', '--get', `branch.${branch.out}.remote`]).out;
  const merge = git(root, ['config', '--get', `branch.${branch.out}.merge`]).out;
  // One bounded fetch of the one branch. A branch that tracks another local branch has nothing to fetch.
  const fetched = remote === '.' || (remote !== '' && merge !== '' && git(root, ['fetch', '--quiet', '--no-tags', remote, merge.replace(/^refs\/heads\//, '')], FETCH_TIMEOUT_MS).ok);
  const behind = git(root, ['rev-list', '--count', 'HEAD..@{upstream}']);
  const count = behind.ok && /^[0-9]+$/.test(behind.out) ? Number(behind.out) : undefined;
  if (count === undefined) return { state: 'unchecked', reason: `this checkout could not be compared with ${upstream.out}` };
  // What was fetched earlier is still evidence: behind that is behind, whether or not the remote answered now.
  if (count > 0) return { state: 'behind', count, upstream: upstream.out };
  return fetched ? { state: 'current' } : { state: 'unchecked', reason: `${remote || 'the remote'} could not be reached, so this checkout was compared with what was last fetched from it` };
}

/** The one sentence a refusal says. */
export function behindMessage(freshness: Extract<CheckoutFreshness, { state: 'behind' }>): string {
  return `This checkout is ${freshness.count} commit${freshness.count === 1 ? '' : 's'} behind ${freshness.upstream}. Run git pull, then run this again.`;
}

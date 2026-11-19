import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { detectGitRemoteUrl, parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { COMMITTED_SPEC_PATH, MAX_COMMITTED_SPEC_BYTES } from './hosted/committed-spec-inspection.js';

export interface LocalPairingSource {
  version: 1;
  repository: string;
  revision?: string;
  specSha256?: string;
  state: 'committed' | 'no-commit' | 'no-spec' | 'unavailable';
  workingTree: 'clean' | 'dirty' | 'unknown';
  publication: 'unverified';
}

/** A local receipt for the owner. Only the host authenticates its copy of the repository. */
export function localPairingSource(directory: string, repository: string): LocalPairingSource {
  const receipt: LocalPairingSource = { version: 1, repository, state: 'unavailable', workingTree: 'unknown', publication: 'unverified' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, maxBuffer: MAX_COMMITTED_SPEC_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
  if (parseGitHubRepoFromRemote(detectGitRemoteUrl(directory) ?? undefined)?.toLowerCase() !== repository.toLowerCase()) return receipt;
  try { receipt.workingTree = git('status', '--porcelain', '--untracked-files=normal').length ? 'dirty' : 'clean'; }
  catch { /* The committed tree can still be read independently. */ }
  try {
    const revision = git('rev-parse', '--verify', 'HEAD^{commit}').toString().trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) return receipt;
    receipt.revision = revision;
  } catch {
    try {
      const branch = git('symbolic-ref', '--quiet', 'HEAD').toString().trim();
      const status = git('status', '--porcelain=v2', '--branch', '--untracked-files=no').toString().split('\n');
      if (branch.startsWith('refs/heads/') && status.includes('# branch.oid (initial)')
          && status.includes('# branch.head ' + branch.slice('refs/heads/'.length))) return { ...receipt, state: 'no-commit' };
    } catch { /* Broken refs, inaccessible objects and timeouts leave the revision unknown. */ }
    return receipt;
  }
  try {
    const entry = git('ls-tree', '-l', receipt.revision, '--', `:(top,literal)${COMMITTED_SPEC_PATH}`).toString();
    if (!entry) return { ...receipt, state: 'no-spec' };
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\s+(\d+)\t/.exec(entry);
    if (!match || Number(match[2]) > MAX_COMMITTED_SPEC_BYTES) return receipt;
    const bytes = git('cat-file', 'blob', match[1]!);
    return { ...receipt, state: 'committed', specSha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { return receipt; }
}

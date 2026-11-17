/**
 * The exact commit a branch, tag or ref names on a remote, from `git ls-remote`
 * output ("<sha>\t<ref>" per line). A branch wins over a tag of the same name;
 * an annotated tag resolves to the commit it points to.
 */
export function pickRemoteCommit(lsRemoteOutput: string, revision: string): string | undefined {
  const refs = new Map<string, string>();
  for (const line of lsRemoteOutput.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref && /^[0-9a-f]{40}$/.test(sha)) refs.set(ref, sha);
  }
  const candidates = revision.startsWith('refs/') ? [`${revision}^{}`, revision]
    : [`refs/heads/${revision}`, `refs/tags/${revision}^{}`, `refs/tags/${revision}`];
  for (const ref of candidates) if (refs.has(ref)) return refs.get(ref);
  return undefined;
}

/** Why a finished build cannot be released, or undefined when it built exactly the frozen commit. */
export function sourceBuildProblem(frozenCommitSha: string, resolvedCommitSha: string | undefined): string | undefined {
  if (!resolvedCommitSha) return `The build did not report which commit it used, so it cannot be confirmed as ${frozenCommitSha.slice(0, 12)}. Nothing was released.`;
  if (resolvedCommitSha.toLowerCase() !== frozenCommitSha.toLowerCase()) {
    return `The build used a different commit (${resolvedCommitSha.slice(0, 12)}) than the one selected for this release (${frozenCommitSha.slice(0, 12)}). Nothing was released.`;
  }
  return undefined;
}

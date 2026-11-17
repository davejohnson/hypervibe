import { describe, expect, it } from 'vitest';
import { pickRemoteCommit, sourceBuildProblem } from '../release-source.js';

// #303: a release builds one exact commit. A branch name is resolved once, before
// any build, and the build must report that same commit.
const a = 'a'.repeat(40); const b = 'b'.repeat(40);

describe('freezing a remote revision', () => {
  // Output format of `git ls-remote <url> <pattern>`: "<sha>\t<ref>" per line.
  const listing = `${a}\trefs/heads/main\n${b}\trefs/heads/feature/main\n${b}\trefs/tags/main\n`;
  it('resolves a branch name to its exact commit', () => { expect(pickRemoteCommit(listing, 'main')).toBe(a); });
  it('resolves a full ref', () => { expect(pickRemoteCommit(listing, 'refs/tags/main')).toBe(b); });
  it('takes a tag when no branch has the name', () => { expect(pickRemoteCommit(`${b}\trefs/tags/v1\n`, 'v1')).toBe(b); });
  it('prefers the commit an annotated tag points to', () => { expect(pickRemoteCommit(`${a}\trefs/tags/v2\n${b}\trefs/tags/v2^{}\n`, 'v2')).toBe(b); });
  it('gives nothing for a name the remote does not have', () => { expect(pickRemoteCommit(`${b}\trefs/heads/feature/main\n`, 'main')).toBeUndefined(); expect(pickRemoteCommit('', 'main')).toBeUndefined(); });
});

describe('checking what the build actually built', () => {
  it('accepts the exact commit', () => { expect(sourceBuildProblem(a, a)).toBeUndefined(); expect(sourceBuildProblem(a, a.toUpperCase())).toBeUndefined(); });
  it('refuses a different commit (the branch moved, or the build fetched something else)', () => { expect(sourceBuildProblem(a, b)).toMatch(/different commit/); });
  it('refuses a build that does not say which commit it used', () => { expect(sourceBuildProblem(a, undefined)).toMatch(/did not report/); });
});

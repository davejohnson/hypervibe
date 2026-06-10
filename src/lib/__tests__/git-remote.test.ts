import { describe, expect, it } from 'vitest';
import { parseGitHubRepoFromRemote, normalizeGitRemoteForBuild } from '../git-remote.js';

describe('parseGitHubRepoFromRemote', () => {
  it('parses https remotes', () => {
    expect(parseGitHubRepoFromRemote('https://github.com/dave/hypervibe.git')).toBe('dave/hypervibe');
    expect(parseGitHubRepoFromRemote('https://github.com/dave/hypervibe')).toBe('dave/hypervibe');
  });

  it('parses scp-style ssh remotes', () => {
    expect(parseGitHubRepoFromRemote('git@github.com:dave/hypervibe.git')).toBe('dave/hypervibe');
  });

  it('parses ssh:// remotes', () => {
    expect(parseGitHubRepoFromRemote('ssh://git@github.com/dave/hypervibe.git')).toBe('dave/hypervibe');
  });

  it('returns null for non-GitHub remotes', () => {
    expect(parseGitHubRepoFromRemote('https://gitlab.com/dave/hypervibe.git')).toBeNull();
    expect(parseGitHubRepoFromRemote('git@bitbucket.org:dave/hypervibe.git')).toBeNull();
  });

  it('returns null for missing or malformed input', () => {
    expect(parseGitHubRepoFromRemote(undefined)).toBeNull();
    expect(parseGitHubRepoFromRemote('')).toBeNull();
    expect(parseGitHubRepoFromRemote('https://github.com/onlyowner')).toBeNull();
  });
});

describe('normalizeGitRemoteForBuild', () => {
  it('canonicalizes GitHub remotes to https clone URLs', () => {
    expect(normalizeGitRemoteForBuild('git@github.com:dave/hypervibe.git')).toBe('https://github.com/dave/hypervibe.git');
    expect(normalizeGitRemoteForBuild('https://github.com/dave/hypervibe')).toBe('https://github.com/dave/hypervibe.git');
  });

  it('passes through non-GitHub remotes trimmed', () => {
    expect(normalizeGitRemoteForBuild(' https://gitlab.com/dave/x.git ')).toBe('https://gitlab.com/dave/x.git');
  });

  it('returns undefined for empty input', () => {
    expect(normalizeGitRemoteForBuild(undefined)).toBeUndefined();
    expect(normalizeGitRemoteForBuild('  ')).toBeUndefined();
  });
});

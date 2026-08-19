import { describe, expect, it } from 'vitest';
import {
  normalizeGitRemoteForBuild,
  normalizeGitRemoteIdentity,
  parseGitHubRepoFromRemote,
  parseRepositoryPathFromRemote,
} from '../git-remote.js';

describe('normalizeGitRemoteIdentity', () => {
  it('matches equivalent URL and SSH remotes without assuming GitHub', () => {
    expect(normalizeGitRemoteIdentity('git@github.com:dave/hypervibe.git')).toBe(
      normalizeGitRemoteIdentity('https://github.com/dave/hypervibe.git/')
    );
    expect(normalizeGitRemoteIdentity('ssh://git@gitlab.com/Acme/App.git')).toBe('gitlab.com/Acme/App');
  });

  it('preserves case-sensitive paths and non-default ports', () => {
    expect(normalizeGitRemoteIdentity('git@github.com:Dave/Hypervibe.git')).toBe('github.com/Dave/Hypervibe');
    expect(normalizeGitRemoteIdentity('https://git.example.com:8443/Acme/App.git')).toBe('git.example.com:8443/Acme/App');
    expect(normalizeGitRemoteIdentity('https://git.example.com:8444/acme/app.git')).toBe('git.example.com:8444/acme/app');
  });

  it('removes URL credentials from the comparison identity', () => {
    expect(normalizeGitRemoteIdentity('https://token@example.com/Acme/App.git')).toBe('example.com/Acme/App');
  });

  it('returns null for missing or unparseable remotes', () => {
    expect(normalizeGitRemoteIdentity()).toBeNull();
    expect(normalizeGitRemoteIdentity('')).toBeNull();
    expect(normalizeGitRemoteIdentity('not-a-remote')).toBeNull();
    expect(normalizeGitRemoteIdentity('../local-repository.git')).toBeNull();
  });
});

describe('parseRepositoryPathFromRemote', () => {
  it('preserves nested namespaces across hosted git providers', () => {
    expect(
      parseRepositoryPathFromRemote(
        'git@gitlab.example.com:Acme/Platform/Invoice-Perfect.git'
      )
    ).toBe('Acme/Platform/Invoice-Perfect');
    expect(
      parseRepositoryPathFromRemote('https://bitbucket.org/acme/storefront.git')
    ).toBe('acme/storefront');
  });

  it('rejects local and malformed remotes', () => {
    expect(parseRepositoryPathFromRemote('../local-repository.git')).toBeNull();
    expect(parseRepositoryPathFromRemote('not-a-remote')).toBeNull();
  });
});

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

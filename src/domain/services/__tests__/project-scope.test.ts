import { describe, expect, it } from 'vitest';
import { getProjectScopeHints } from '../project-scope.js';

describe('getProjectScopeHints', () => {
  it('extracts host and owner/repo hints from https remotes', () => {
    const hints = getProjectScopeHints({
      id: 'p1',
      name: 'demo',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/acme/demo-app.git',
      policies: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(hints).toEqual(['github.com/acme/demo-app', 'acme/demo-app']);
  });

  it('extracts host and owner/repo hints from ssh remotes', () => {
    const hints = getProjectScopeHints({
      id: 'p1',
      name: 'demo',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'git@github.com:acme/platform.git',
      policies: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(hints).toEqual(['github.com/acme/platform', 'acme/platform']);
  });

  it('returns empty hints when no remote is set', () => {
    const hints = getProjectScopeHints({
      id: 'p1',
      name: 'demo',
      defaultPlatform: 'railway',
      policies: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(hints).toEqual([]);
  });
});

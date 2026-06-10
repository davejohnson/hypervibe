import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { mergeProjectPolicies } from '../project.tools.js';

describe('project.tools policy contract', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-project-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults new greenfield projects to Cloud Run', () => {
    const project = new ProjectRepository().create({ name: 'greenfield-app' });
    expect(project.defaultPlatform).toBe('cloudrun');
  });

  it('merges only provided policy fields', () => {
    const merged = mergeProjectPolicies(
      {
        protectedEnvironments: ['production'],
        requireApprovalForProtectedEnvironments: true,
        existing: 'keep',
      },
      {
        requireApprovalForDestructive: true,
      }
    );

    expect(merged).toEqual({
      protectedEnvironments: ['production'],
      requireApprovalForProtectedEnvironments: true,
      requireApprovalForDestructive: true,
      existing: 'keep',
    });
  });

  it('overwrites desiredState when provided', () => {
    const desiredState = { environmentName: 'staging', serviceName: 'web' };
    const merged = mergeProjectPolicies({}, { desiredState });
    expect(merged.desiredState).toEqual(desiredState);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { resolveManagedMoveTargets } from '../database-move.service.js';
import type { Project } from '../../entities/project.entity.js';
import type { Environment } from '../../entities/environment.entity.js';

const SOURCE_URL = 'postgresql://postgres:oldpass@db.supabase.co:5432/postgres';
const TARGET_URL = 'postgresql://app:newpass@railway.internal:5432/app';

describe('resolveManagedMoveTargets', () => {
  let tempDir: string;
  let project: Project;
  let environment: Environment;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-db-move-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    project = new ProjectRepository().create({ name: 'move-app', defaultPlatform: 'railway' });
    environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves source from previousBindings and target from current bindings', async () => {
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'railway',
        connectionUrl: TARGET_URL,
        previousProvider: 'supabase',
        previousBindings: { provider: 'supabase', connectionString: SOURCE_URL },
      },
    });

    const result = await resolveManagedMoveTargets({ project, environment });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceUrl).toBe(SOURCE_URL);
      expect(result.targetUrl).toBe(TARGET_URL);
      expect(result.sourceProvider).toBe('supabase');
      expect(result.targetProvider).toBe('railway');
    }
  });

  it('fails with no_component when the environment has no postgres component', async () => {
    const result = await resolveManagedMoveTargets({ project, environment });
    expect(result).toMatchObject({ ok: false, code: 'no_component' });
  });

  it('fails with no_source when no previous database is recorded', async () => {
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: { provider: 'railway', connectionUrl: TARGET_URL },
    });

    const result = await resolveManagedMoveTargets({ project, environment });
    expect(result).toMatchObject({ ok: false, code: 'no_source' });
    if (!result.ok) {
      expect(result.hint).toContain('sourceConnectionUrl');
    }
  });

  it('rejects source and target resolving to the same database', async () => {
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'railway',
        connectionUrl: TARGET_URL,
        previousProvider: 'railway',
        previousBindings: { provider: 'railway', connectionUrl: TARGET_URL },
      },
    });

    const result = await resolveManagedMoveTargets({ project, environment });
    expect(result).toMatchObject({ ok: false, code: 'same_database' });
  });

  it('honors explicit URL overrides', async () => {
    const result = await resolveManagedMoveTargets({
      project,
      environment,
      sourceConnectionUrl: SOURCE_URL,
      targetConnectionUrl: TARGET_URL,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceUrl).toBe(SOURCE_URL);
      expect(result.targetUrl).toBe(TARGET_URL);
    }
  });
});

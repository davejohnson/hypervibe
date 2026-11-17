import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { createCommandContext } from '../context.js';

const REMOTE = 'https://github.com/example/app.git';

describe('project resolution when several projects share one repository', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-shared-remote-'));
    repoDir = path.join(tempDir, 'app');
    fs.mkdirSync(repoDir);
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['remote', 'add', 'origin', REMOTE], { cwd: repoDir });
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedTwoProjects(): Promise<void> {
    const projects = new ProjectRepository();
    projects.create({ name: 'app', defaultPlatform: 'railway', gitRemoteUrl: 'git@github.com:example/app.git' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A later project for the same repository, such as a test fixture.
    projects.create({ name: 'app-fixture', defaultPlatform: 'railway', gitRemoteUrl: REMOTE });
  }

  function resolve() {
    return runWithWorkspaceDirectories([repoDir], async () => createCommandContext().resolveProjectOrThrow({}));
  }

  it('selects the project the repository spec names, not the most recent one', async () => {
    await seedTwoProjects();
    fs.mkdirSync(path.join(repoDir, '.hypervibe'));
    fs.writeFileSync(
      path.join(repoDir, '.hypervibe', 'spec.json'),
      JSON.stringify({ version: 1, project: 'app', environments: {} })
    );

    expect((await resolve()).name).toBe('app');
  });

  it('asks for the project instead of guessing when the repository does not say', async () => {
    await seedTwoProjects();

    await expect(resolve()).rejects.toMatchObject({
      code: 'AMBIGUOUS_PROJECT',
      extras: { details: { projects: expect.arrayContaining([
        expect.objectContaining({ name: 'app' }),
        expect.objectContaining({ name: 'app-fixture' }),
      ]) } },
    });
  });
});

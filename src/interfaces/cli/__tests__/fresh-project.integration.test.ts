import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { createCommandRegistry } from '../../../application/commands.js';
import { createCommandContext } from '../../../application/context.js';
import type { CliIo } from '../io.js';
import { runCli } from '../run.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-fresh-cli-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function captureIo(stdin = '') {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    writeOut(value) {
      stdout += value;
    },
    writeErr(value) {
      stderr += value;
    },
    async readStdin() {
      return stdin;
    },
    async confirm() {
      return false;
    },
    stdinIsTTY: false,
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

describe('fresh-project CLI workflow', () => {
  it('reads the bootstrap contract and initializes desired state through the shared command', async () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-fresh-cli-repo-')));
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', [
      'remote',
      'add',
      'origin',
      'git@github.com:davejohnson/fresh-cli-app.git',
    ], { cwd: repoDir });

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      process.chdir(repoDir);
      const registry = createCommandRegistry(createCommandContext());

      const typo = captureIo();
      expect(await runCli(['spec', '--project', 'fresh-cli-ap'], {
        registry,
        io: typo.io,
        initialize: false,
      })).toBe(1);
      expect(typo.stdout()).toContain('Project "fresh-cli-ap" was not found');
      expect(typo.stdout()).toContain('Check the project name');
      expect(typo.stdout()).toContain('fresh-cli-app');
      expect(typo.stdout()).toContain('hypervibe spec');
      expect(typo.stderr()).toBe('');
      expect(new ProjectRepository().findByName('fresh-cli-ap')).toBeNull();

      const read = captureIo();
      expect(await runCli(['spec', '--json'], {
        registry,
        io: read.io,
        initialize: false,
      })).toBe(0);
      expect(JSON.parse(read.stdout())).toMatchObject({
        ok: true,
        data: {
          initialized: false,
          project: { name: 'fresh-cli-app' },
        },
        agentInstruction: { action: 'continue' },
      });
      expect(read.stderr()).toBe('');
      expect(new ProjectRepository().findByName('fresh-cli-app')).toBeNull();

      const write = captureIo(JSON.stringify({
        project: 'fresh-cli-app',
        spec: {
          project: 'fresh-cli-app',
          environments: {
            staging: {
              hosting: { provider: 'railway' },
              services: { web: { startCommand: 'npm start' } },
            },
          },
        },
      }));
      expect(await runCli(['spec', '--input', '-', '--json'], {
        registry,
        io: write.io,
        initialize: false,
      })).toBe(0);
      expect(JSON.parse(write.stdout())).toMatchObject({
        ok: true,
        data: {
          revision: 1,
          project: {
            name: 'fresh-cli-app',
            gitRemoteUrl: 'git@github.com:davejohnson/fresh-cli-app.git',
          },
        },
      });
      expect(write.stderr()).toBe('');
    } finally {
      process.chdir(oldCwd);
      if (oldDisable === undefined) {
        delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      } else {
        process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

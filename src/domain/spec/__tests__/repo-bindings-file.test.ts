import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import { writeRepoBindingsForEnvironment } from '../repo-bindings-file.js';

describe('repo bindings delegated metadata', () => {
  it('persists accepted hashes and principals without persisting secret values', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hypervibe-delegated-bindings-'));
    mkdirSync(path.join(root, '.git'));
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const now = new Date('2026-07-17T00:00:00.000Z');
    const project: Project = {
      id: 'project-1',
      name: 'friend-app',
      defaultPlatform: 'railway',
      policies: {},
      createdAt: now,
      updatedAt: now,
    };
    const environment: Environment = {
      id: 'environment-1',
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        apiToken: 'must-never-be-written',
        delegatedEnvBindings: [{
          name: 'ANTHROPIC_API_KEY',
          principal: 'github:alice',
          valueHash: 'sha256-only',
          source: 'delegated-plan-input',
          syncedAt: now.toISOString(),
          applyRunId: 'apply-1',
          actionId: 'secret:ANTHROPIC_API_KEY',
        }],
      },
      createdAt: now,
      updatedAt: now,
    };

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      const file = writeRepoBindingsForEnvironment(project, environment, root);
      expect(file).toBe(path.join(root, '.hypervibe', 'bindings.json'));
      const serialized = readFileSync(file!, 'utf8');
      const document = JSON.parse(serialized);

      expect(serialized).not.toContain('must-never-be-written');
      expect(document.environments.production.platformBindings.apiToken).toBeUndefined();
      expect(document.environments.production.platformBindings.delegatedEnvBindings).toEqual([
        expect.objectContaining({
          name: 'ANTHROPIC_API_KEY',
          principal: 'github:alice',
          valueHash: 'sha256-only',
          applyRunId: 'apply-1',
        }),
      ]);
    } finally {
      if (oldDisable === undefined) {
        delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      } else {
        process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import { mergeRepoPlatformBindings, writeRepoBindingsForEnvironment } from '../repo-bindings-file.js';

describe('repo bindings delegated metadata', () => {
  it('preserves sanitizer-omitted local fields without preserving removed public fields', () => {
    expect(mergeRepoPlatformBindings({
      github: {
        pagesCertificateAttempt: { domain: 'old.example.com' },
        publicReceipt: 'remove-me',
        openAIActionsSecretName: 'OPENAI_API_KEY',
        openAIActionsSecretHash: 'local-hash',
        openAIActionsSecretSyncedAt: '2026-08-20T00:00:00.000Z',
      },
      localOnlyProvider: { resourceId: 'preserved-top-level' },
    }, {
      github: {
        pagesCertificateAttempt: { domain: 'new.example.com' },
      },
    })).toEqual({
      github: {
        pagesCertificateAttempt: { domain: 'new.example.com' },
        openAIActionsSecretName: 'OPENAI_API_KEY',
        openAIActionsSecretHash: 'local-hash',
        openAIActionsSecretSyncedAt: '2026-08-20T00:00:00.000Z',
      },
      localOnlyProvider: { resourceId: 'preserved-top-level' },
    });
  });

  it('preserves nested CI secret hashes stripped from the repository export', () => {
    expect(mergeRepoPlatformBindings({
      ci: {
        deployBranch: {
          '.github/workflows/deploy.yml': {
            contentHash: 'old-content',
            syncedSecretHashes: { IMAGE_REGISTRY_TOKEN: 'local-hash' },
          },
        },
      },
    }, {
      ci: {
        deployBranch: {
          '.github/workflows/deploy.yml': {
            contentHash: 'new-content',
          },
        },
      },
    })).toEqual({
      ci: {
        deployBranch: {
          '.github/workflows/deploy.yml': {
            contentHash: 'new-content',
            syncedSecretHashes: { IMAGE_REGISTRY_TOKEN: 'local-hash' },
          },
        },
      },
    });
  });

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
        storageProviders: {
          railway: { projectId: 'railway-project', environmentId: 'railway-production' },
        },
        storage: {
          documents: {
            provider: 'railway',
            externalId: 'bucket-documents',
            region: 'sjc',
            services: ['web'],
            envKeys: ['AWS_S3_BUCKET_NAME'],
          },
        },
        delegatedEnvBindings: [{
          name: 'ANTHROPIC_API_KEY',
          principal: 'github:alice',
          valueHash: 'sha256-only',
          source: 'delegated-plan-input',
          syncedAt: now.toISOString(),
          applyRunId: 'apply-1',
          actionId: 'secret:ANTHROPIC_API_KEY',
        }],
        runtimeRollouts: [{
          service: 'worker',
          provider: 'railway',
          serviceExternalId: 'railway-worker',
          baselineDeployment: { state: 'present', id: 'deployment-before-config' },
          requiredAt: now.toISOString(),
          applyRunId: 'apply-1',
          actionIds: ['secret:ANTHROPIC_API_KEY'],
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
      expect(document.environments.production.platformBindings.storage.documents).toMatchObject({
        provider: 'railway',
        externalId: 'bucket-documents',
        instanceScope: { projectId: 'railway-project', environmentId: 'railway-production' },
      });
      expect(document.environments.production.platformBindings.delegatedEnvBindings).toEqual([
        expect.objectContaining({
          name: 'ANTHROPIC_API_KEY',
          principal: 'github:alice',
          valueHash: 'sha256-only',
          applyRunId: 'apply-1',
        }),
      ]);
      expect(document.environments.production.platformBindings.runtimeRollouts).toEqual([
        expect.objectContaining({
          service: 'worker',
          provider: 'railway',
          baselineDeployment: { state: 'present', id: 'deployment-before-config' },
          actionIds: ['secret:ANTHROPIC_API_KEY'],
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

  it('removes the generated file when an environment has no public bindings left', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hypervibe-empty-bindings-'));
    mkdirSync(path.join(root, '.git'));
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const now = new Date('2026-08-20T00:00:00.000Z');
    const project: Project = {
      id: 'project-empty',
      name: 'empty-bindings-app',
      defaultPlatform: 'railway',
      policies: {},
      createdAt: now,
      updatedAt: now,
    };
    const environment: Environment = {
      id: 'environment-empty',
      projectId: project.id,
      name: 'repository',
      platformBindings: {
        github: {
          pagesCertificateAttempt: {
            domain: 'old.example.com',
            attemptedAt: now.toISOString(),
            mode: 'reattach',
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    };

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      const file = writeRepoBindingsForEnvironment(project, environment, root)!;
      expect(existsSync(file)).toBe(true);

      environment.platformBindings = {
        github: {
          openAIActionsSecretHash: 'local-only-hash',
          openAIActionsSecretSyncedAt: now.toISOString(),
        },
      };
      expect(writeRepoBindingsForEnvironment(project, environment, root)).toBeNull();
      expect(existsSync(file)).toBe(false);
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

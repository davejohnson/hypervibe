import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { railwayHttpFixture } from '../../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { SqliteAdapter, initializeDatabase } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { SpecStore } from '../../spec/spec.store.js';
import { PlanService } from '../plan.service.js';
import { createToolContext } from '../../../application/context.js';
import { executePlanApply } from '../../../application/apply-plan.js';

// Provider responses are synthetic state executed by Railway's pinned official
// schema. This exercises the real planner, apply handler and serialized client;
// it does not establish live provider compatibility.
describe('fresh managed-CI project with generated secrets', () => {
  let directory: string;
  let project: ReturnType<ProjectRepository['create']>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-fresh-project-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(directory, 'test.db'));
    project = new ProjectRepository().create({
      name: 'contract-project',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/example/contract-project.git',
    });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      runtime: { kind: 'node', version: '22', installCommand: 'npm ci' },
      secrets: {
        SESSION_SECRET: {
          ownership: 'hypervibe', generator: 'random-base64url-32-v1',
          generation: 1, environments: ['staging'],
        },
      },
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    for (const provider of ['railway', 'github']) {
      const connection = new ConnectionRepository().create({
        provider,
        credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-contract-token' }),
      });
      new ConnectionRepository().updateStatus(connection.id, 'verified');
    }
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['absent', 'existing', 'unreadable'] as const)(
    'isolates project bootstrap from secret writes when the provider project is %s',
    async (state) => {
      const fixture = await railwayHttpFixture({
        projectExists: state === 'existing',
        stagingExists: false,
        responseOverride: state === 'unreadable'
          ? () => Response.json({ errors: [{ message: 'Synthetic permission denied' }] }, { status: 403 })
          : undefined,
      });
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: fixture.adapter });
      vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fixture.adapter as never });
      expect(new EnvironmentRepository().findByProjectAndName(project.id, 'staging')).toBeNull();

      const result = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
      expect(result).not.toHaveProperty('error');
      if ('error' in result) throw new Error(result.error);
      expect(result.scope).toBe('managed-ci-bindings');
      expect(result.verified).toBe(false);
      expect(result.actions.map(({ id }) => id)).toEqual(['project:railway']);
      expect(result.inputRequired).toEqual([]);
      expect(new RunRepository().findById(result.planRunId)?.plan).not.toHaveProperty('overrides');
      expect(fixture.mutations).toEqual([]);

      const currentSpec = new SpecStore().get(project)!;
      const outcome = await executePlanApply(createToolContext(), {
        project, spec: currentSpec.spec, specRevision: currentSpec.revision,
        planId: result.planRunId, confirmActions: [],
      });
      if (state === 'absent') {
        expect(outcome).toMatchObject({ kind: 'executed', result: { success: true } });
        expect(fixture.mutations.map(({ field }) => field)).toEqual(['projectCreate']);
        const next = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
        expect(next).not.toHaveProperty('error');
        if ('error' in next) throw new Error(next.error);
        expect(next.actions.find(({ id }) => id === 'environment:staging')).toMatchObject({ type: 'create' });
        expect(next.actions.some(({ id }) => id === 'project:railway')).toBe(false);
      } else {
        expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
        expect(fixture.mutations).toEqual([]);
      }
      expect(fixture.variables.size).toBe(0);
      expect(fixture.contractErrors).toEqual([]);
    }
  );
});

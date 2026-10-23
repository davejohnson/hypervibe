import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/devops-providers.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { SecretStore, getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { devOpsProviderRegistry } from '../devops.registry.js';

// Native environment-scoped variables do not imply a managed iOS release path.
// GitHub: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idenvironment
// GitLab: https://docs.gitlab.com/ci/environments/#limit-the-environment-scope-of-a-cicd-variable
// Transport fixtures reconstruct only the documented repository identity reads;
// this tests Hypervibe's unsupported boundary, not live GitLab iOS compatibility.
const reviewedCiProviders = {
  'github-actions': 'Implemented; serialized transport and shared lifecycle tests cover the exact environment read.',
  'gitlab-ci': 'Unsupported; registered lifecycle must reject managed iOS releases before generating actions.',
};

let directory: string;
beforeEach(() => {
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-ios-ci-matrix-'));
  initializeDatabase(path.join(directory, 'test.db'));
});
afterEach(() => {
  vi.restoreAllMocks();
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

describe('iOS build credentials named CI provider review', () => {
  it('requires an explicit decision for every registered CI provider', () => {
    expect(devOpsProviderRegistry.ciProviderIds().sort()).toEqual(Object.keys(reviewedCiProviders).sort());
  });

  it.each([undefined, 'production'])('GitLab rejects managed iOS with credentialsEnvironment=%s before actions', async credentialsEnvironment => {
    const spec = projectSpecSchema.parse({
      version: 1, project: 'ios-gitlab', gitRemoteUrl: 'https://gitlab.com/acme/app.git',
      devops: { code: { provider: 'gitlab', scope: 'https://gitlab.com/acme/app' }, ci: { provider: 'gitlab-ci' } },
      environments: { staging: {
        hosting: { provider: 'railway' }, services: { web: {} }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        ios: { bundleId: 'com.example.staging', testflight: { groups: { beta: {} } }, release: {
          services: ['web'], build: { command: 'make ipa', ipaPath: 'App.ipa', ...(credentialsEnvironment ? { credentialsEnvironment } : {}) },
          testflight: { groups: ['beta'] },
        } },
      } },
    });
    const project = new ProjectRepository().create({ name: spec.project, defaultPlatform: 'railway', gitRemoteUrl: spec.gitRemoteUrl });
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'railway', projectId: 'rail-project', environmentId: 'rail-staging', services: { web: { serviceId: 'rail-web' } },
    } });
    const connection = new ConnectionRepository().create({ provider: 'gitlab', scope: spec.devops!.code.scope,
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gitlab-fixture', instanceUrl: 'https://gitlab.com' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    const requests: Array<{ method: string; path: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const pathname = decodeURIComponent(url.pathname);
      requests.push({ method, path: pathname });
      expect(url.origin).toBe('https://gitlab.com');
      expect(method).toBe('GET');
      if (pathname === '/api/v4/user') return Response.json({ id: 7, username: 'owner' });
      if (['/api/v4/projects/acme/app', '/api/v4/projects/42'].includes(pathname)) return Response.json({
        id: 42, path_with_namespace: 'acme/app', default_branch: 'main', web_url: 'https://gitlab.com/acme/app',
        http_url_to_repo: 'https://gitlab.com/acme/app.git', ssh_url_to_repo: 'git@gitlab.com:acme/app.git',
        ci_config_path: '.gitlab-ci.yml', permissions: { project_access: { access_level: 40 } },
      });
      throw new Error('Unexpected read beyond unsupported iOS boundary');
    });
    const result = await devOpsProviderRegistry.ciProvider('gitlab-ci')!.lifecycle.planDeploy({
      project, spec, environmentName: 'staging', environmentSpec: spec.environments.staging, environment,
    });
    expect(result.error).toBe('GitLab CI MVP does not yet render iOS release jobs');
    expect(result.action).toBeUndefined();
    expect(result.actions).toBeUndefined();
    expect(requests.map(request => request.path)).toEqual(['/api/v4/projects/acme/app', '/api/v4/projects/42', '/api/v4/user']);
  });
});

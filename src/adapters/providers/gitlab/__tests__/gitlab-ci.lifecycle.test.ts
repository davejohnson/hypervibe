import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../db/repositories/connection.repository.js';
import { SecretStore, getSecretStore } from '../../../secrets/secret-store.js';
import { SpecStore } from '../../../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { environmentDeploymentContractHash } from '../../../../domain/services/deployment-contract.service.js';
import {
  findGitLabPortableProviderConnection,
  gitLabCiLifecycle,
} from '../gitlab-ci.lifecycle.js';
import '../../railway/railway.adapter.js';
import '../../gcp/cloudrun.adapter.js';
import '../../aws/ecs-express.adapter.js';
import {
  gitLabShellLiteral,
} from '../../railway/railway-ci.recipe.js';

const projectPayload = {
  id: 42,
  path_with_namespace: 'acme/storefront',
  default_branch: 'main',
  web_url: 'https://gitlab.com/acme/storefront',
  http_url_to_repo: 'https://gitlab.com/acme/storefront.git',
  ssh_url_to_repo: 'git@gitlab.com:acme/storefront.git',
  ci_config_path: '.gitlab-ci.yml',
  permissions: { project_access: { access_level: 40 } },
  ci_pipeline_variables_minimum_override_role: 'no_one_allowed',
  ci_forward_deployment_enabled: true,
  ci_forward_deployment_rollback_allowed: false,
  container_registry_access_level: 'private',
};
const commitSha = 'a'.repeat(40);
const spec = projectSpecSchema.parse({
  version: 1,
  project: 'gitlab-ci-app',
  gitRemoteUrl: 'https://gitlab.com/acme/storefront.git',
  runtime: { kind: 'node', version: '22' },
  devops: {
    code: { provider: 'gitlab', scope: 'https://gitlab.com/acme/storefront' },
    ci: { provider: 'gitlab-ci' },
    canonicalEnvironment: 'production',
  },
  environments: {
    staging: {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web', startCommand: 'node server.mjs' } },
      envFile: { mode: 'off' },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: true },
    },
    production: {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web', startCommand: 'node server.mjs' } },
      envFile: { mode: 'off' },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: false },
    },
  },
});

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
}

function filePayload(filePath: string, content: string) {
  return {
    file_path: filePath,
    content: Buffer.from(content, 'utf8').toString('base64'),
    encoding: 'base64',
    last_commit_id: commitSha,
  };
}

function registryPullToken(repository: string): string {
  const claims = Buffer.from(JSON.stringify({
    access: [{ type: 'repository', name: repository, actions: ['pull'] }],
  })).toString('base64url');
  return `header.${claims}.signature`;
}

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-gitlab-ci-'));
  previousDataDir = process.env.HYPERVIBE_DATA_DIR;
  process.env.HYPERVIBE_DATA_DIR = dataDir;
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(dataDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  if (previousDataDir === undefined) delete process.env.HYPERVIBE_DATA_DIR;
  else process.env.HYPERVIBE_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function seed() {
  const project = new ProjectRepository().create({
    name: spec.project,
    defaultPlatform: 'railway',
    gitRemoteUrl: spec.gitRemoteUrl,
  });
  new SpecStore().replace(project, spec);
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'rail-project',
      environmentId: 'rail-environment',
      services: { web: { serviceId: 'rail-service' } },
    },
  });
  new EnvironmentRepository().create({
    projectId: project.id,
    name: 'staging',
    platformBindings: {
      provider: 'railway',
      projectId: 'rail-project',
      environmentId: 'rail-staging-environment',
      services: { web: { serviceId: 'rail-staging-service' } },
    },
  });
  const gitlab = new ConnectionRepository().create({
    provider: 'gitlab',
    scope: spec.devops!.code.scope,
    credentialsEncrypted: getSecretStore().encryptObject({
      apiToken: 'gitlab-api-token',
      instanceUrl: 'https://gitlab.com',
      registryUsername: 'gitlab+deploy-token-1',
      registryReadToken: 'gitlab-registry-read-token',
    }),
  });
  new ConnectionRepository().updateStatus(gitlab.id, 'verified');
  const railway = new ConnectionRepository().create({
    provider: 'railway',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-api-token' }),
  });
  new ConnectionRepository().updateStatus(railway.id, 'verified');
  return { project, environment };
}

describe('GitLab CI reviewed configuration lifecycle', () => {
  it('uses only an exact repository-scoped provider connection or an intentional global fallback', () => {
    const repository = new ConnectionRepository();
    const unrelated = repository.create({
      provider: 'cloudrun',
      scope: 'https://gitlab.com/acme/other-project',
      credentialsEncrypted: 'unrelated',
    });
    repository.updateStatus(unrelated.id, 'verified');

    expect(findGitLabPortableProviderConnection(
      'cloudrun',
      'https://gitlab.com/acme/storefront'
    )).toBeNull();

    const global = repository.create({
      provider: 'cloudrun',
      credentialsEncrypted: 'global',
    });
    repository.updateStatus(global.id, 'verified');
    expect(findGitLabPortableProviderConnection(
      'cloudrun',
      'https://gitlab.com/acme/storefront'
    )?.id).toBe(global.id);

    const exact = repository.create({
      provider: 'cloudrun',
      scope: 'https://gitlab.com/acme/storefront',
      credentialsEncrypted: 'exact',
    });
    repository.updateStatus(exact.id, 'verified');
    expect(findGitLabPortableProviderConnection(
      'cloudrun',
      'https://gitlab.com/acme/storefront'
    )?.id).toBe(exact.id);
  });

  it('quotes generated shell literals without allowing apostrophes to break the command', () => {
    expect(gitLabShellLiteral("acme's storefront")).toBe("'acme'\\''s storefront'");
  });

  it('refuses to publish or tear down a project config that would omit an unbound environment', async () => {
    const cloudRunSpec = projectSpecSchema.parse({
      version: 1,
      project: 'gitlab-cloudrun-app',
      gitRemoteUrl: 'https://gitlab.com/acme/storefront.git',
      runtime: { kind: 'node', version: '22' },
      devops: {
        code: { provider: 'gitlab', scope: 'https://gitlab.com/acme/storefront' },
        ci: { provider: 'gitlab-ci' },
        canonicalEnvironment: 'production',
      },
      environments: {
        staging: {
          hosting: { provider: 'cloudrun', region: 'us-west1' },
          services: { web: { workloadKind: 'web', startCommand: 'node server.mjs' } },
          envFile: { mode: 'off' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
        production: {
          hosting: { provider: 'cloudrun', region: 'us-west1' },
          services: { web: { workloadKind: 'web', startCommand: 'node server.mjs' } },
          envFile: { mode: 'off' },
          deploy: {
            strategy: 'branch',
            trigger: 'ci',
            branch: 'main',
            autoDeploy: false,
            promoteFrom: 'staging',
          },
        },
      },
    });
    const project = new ProjectRepository().create({
      name: cloudRunSpec.project,
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: cloudRunSpec.gitRemoteUrl,
    });
    new SpecStore().replace(project, cloudRunSpec);
    const environmentRepository = new EnvironmentRepository();
    const environment = environmentRepository.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gitlab-cloudrun-app-staging',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        services: {
          web: {
            serviceId: 'gitlab-cloudrun-app-staging-web',
            workloadKind: 'web',
            resourceType: 'service',
          },
        },
      },
    });
    const productionEnvironment = environmentRepository.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'cloudrun' },
    });
    const gitlab = new ConnectionRepository().create({
      provider: 'gitlab',
      scope: cloudRunSpec.devops!.code.scope,
      credentialsEncrypted: getSecretStore().encryptObject({
        apiToken: 'gitlab-api-token',
        instanceUrl: 'https://gitlab.com',
      }),
    });
    new ConnectionRepository().updateStatus(gitlab.id, 'verified');
    const requests: Array<{ method: string; path: string }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const decodedPath = decodeURIComponent(url.pathname);
      requests.push({ method, path: decodedPath });
      if (method === 'GET' && decodedPath.endsWith('/user')) {
        return response({ id: 3, username: 'hypervibe' });
      }
      if (method === 'GET' && /\/api\/v4\/projects\/(?:42|acme\/storefront)$/.test(decodedPath)) {
        return response(projectPayload);
      }
      if (method === 'GET' && decodedPath.endsWith('/projects/42/runners')) {
        return response([{
          id: 100,
          runner_type: 'instance_type',
          status: 'online',
          paused: false,
          tag_list: ['saas-linux-small-amd64'],
        }]);
      }
      if (method === 'GET' && decodedPath.includes('/repository/files/')) {
        return response({ message: 'not found' }, 404);
      }
      if (method === 'GET' && decodedPath.endsWith('/repository/branches/main')) {
        return response({ name: 'main', commit: { id: commitSha } });
      }
      throw new Error(`Unexpected GitLab request: ${method} ${url}`);
    });

    const compiled = await gitLabCiLifecycle.planDeploy({
      project,
      spec: cloudRunSpec,
      environmentName: 'staging',
      environmentSpec: cloudRunSpec.environments.staging,
      environment: environmentRepository.findById(environment.id),
    });
    expect(compiled.actions).toBeUndefined();
    expect(compiled.error).toContain('production');
    expect(requests.every((request) => request.method === 'GET')).toBe(true);

    const teardownSpec = projectSpecSchema.parse({
      ...cloudRunSpec,
      environments: {
        ...cloudRunSpec.environments,
        staging: {
          ...cloudRunSpec.environments.staging,
          services: {
            ...cloudRunSpec.environments.staging.services,
            worker: { workloadKind: 'worker', startCommand: 'node worker.mjs' },
          },
        },
        production: {
          ...cloudRunSpec.environments.production,
          deploy: { strategy: 'manual' },
        },
      },
    });
    environmentRepository.updatePlatformBindings(productionEnvironment.id, {
      ci: {
        gitlabCi: {
          provider: 'gitlab-ci',
          repositoryId: '42',
          instanceScope: 'https://gitlab.com',
          repositoryScope: projectPayload.web_url,
          configurationActive: { programHash: 'old-program', files: [] },
        },
      },
    });
    requests.length = 0;
    const teardown = await gitLabCiLifecycle.planDeploy({
      project,
      spec: teardownSpec,
      environmentName: 'production',
      environmentSpec: teardownSpec.environments.production,
      environment: environmentRepository.findById(productionEnvironment.id),
    });
    expect(teardown.actions).toBeUndefined();
    expect(teardown.error).toContain('staging');
    expect(requests.some((request) => request.path.includes('/runners'))).toBe(false);
    expect(requests.some((request) => request.path.includes('/repository/files/'))).toBe(false);
  });

  it('does not relabel Railway bindings as ECS while another environment plans shared CI', async () => {
    const { project } = seed();
    const transitionSpec = projectSpecSchema.parse({
      ...spec,
      environments: {
        ...spec.environments,
        production: {
          ...spec.environments.production,
          hosting: { provider: 'ecs', region: 'us-east-1' },
          deploy: {
            ...spec.environments.production.deploy,
            autoDeploy: true,
          },
        },
      },
    });
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const decodedPath = decodeURIComponent(url.pathname);
      requests.push(`${method} ${decodedPath}`);
      if (method === 'GET' && decodedPath.endsWith('/user')) {
        return response({ id: 3, username: 'hypervibe' });
      }
      if (method === 'GET' && /\/api\/v4\/projects\/(?:42|acme\/storefront)$/.test(decodedPath)) {
        return response(projectPayload);
      }
      if (method === 'GET' && decodedPath.endsWith('/projects/42/runners')) {
        return response([{
          id: 100,
          runner_type: 'instance_type',
          status: 'online',
          paused: false,
          tag_list: ['saas-linux-small-amd64'],
        }]);
      }
      if (method === 'GET' && decodedPath.includes('/repository/files/')) {
        return response({ message: 'not found' }, 404);
      }
      if (method === 'GET' && decodedPath.endsWith('/repository/branches/main')) {
        return response({ name: 'main', commit: { id: commitSha } });
      }
      throw new Error(`Unexpected GitLab request: ${method} ${url}`);
    });

    const planned = await gitLabCiLifecycle.planDeploy({
      project,
      spec: transitionSpec,
      environmentName: 'staging',
      environmentSpec: transitionSpec.environments.staging,
      environment: new EnvironmentRepository().findByProjectAndName(project.id, 'staging'),
    });
    expect(planned.actions).toBeUndefined();
    expect(planned.error).toContain('production');
    expect(requests.some((request) => request.includes('/runners'))).toBe(false);
    expect(requests.some((request) => request.includes('/repository/files/'))).toBe(false);
  });

  it('publishes one atomic reviewed change, then performs zero mutations at exact convergence', async () => {
    const { project, environment } = seed();
    const committed = new Map<string, string>();
    const variables = new Map<string, Record<string, unknown>>();
    const mutationCalls: Array<{ method: string; url: string; body?: string }> = [];
    let merged = false;
    let mergeRequestCreated = false;
    let mergeRequestSourceSha = 'b'.repeat(40);
    let runnerType = 'group_type';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const decodedPath = decodeURIComponent(url.pathname);
      if (method !== 'GET') mutationCalls.push({ method, url: url.toString(), body: String(init?.body ?? '') });

      if (method === 'GET' && decodedPath.endsWith('/jwt/auth')) {
        return response({ token: registryPullToken(projectPayload.path_with_namespace) });
      }
      if (method === 'GET' && decodedPath.endsWith('/user')) {
        return response({ id: 3, username: 'hypervibe' });
      }

      if (method === 'GET' && /\/api\/v4\/projects\/(?:42|acme\/storefront)$/.test(decodedPath)) {
        return response(projectPayload);
      }
      if (method === 'GET' && decodedPath.endsWith('/projects/42/runners')) {
        expect(url.searchParams.get('tag_list')).toBe('saas-linux-small-amd64');
        return response([{
          id: 100,
          runner_type: runnerType,
          status: 'online',
          paused: false,
          tag_list: ['saas-linux-small-amd64'],
        }]);
      }
      if (method === 'GET' && decodedPath.includes('/repository/files/')) {
        const encodedFile = url.pathname.slice(url.pathname.indexOf('/repository/files/') + '/repository/files/'.length);
        const filePath = decodeURIComponent(encodedFile);
        const ref = url.searchParams.get('ref');
        const content = merged || ref?.startsWith('hypervibe/gitlab-ci-')
          ? committed.get(filePath)
          : undefined;
        return content === undefined ? response({ message: 'not found' }, 404) : response(filePayload(filePath, content));
      }
      if (method === 'GET' && decodedPath.endsWith('/repository/branches/main')) {
        return response({ name: 'main', commit: { id: commitSha } });
      }
      if (method === 'GET' && decodedPath.includes('/repository/branches/hypervibe/gitlab-ci-')) {
        return response({ message: 'not found' }, 404);
      }
      if (method === 'POST' && decodedPath.endsWith('/repository/commits')) {
        const body = JSON.parse(String(init?.body));
        for (const action of body.actions) {
          if (action.action === 'delete') committed.delete(action.file_path);
          else committed.set(action.file_path, action.content);
        }
        return response({ id: 'b'.repeat(40), web_url: `${projectPayload.web_url}/-/commit/${'b'.repeat(40)}` });
      }
      if (method === 'GET' && decodedPath.endsWith('/merge_requests')) {
        const state = url.searchParams.get('state');
        const visible = mergeRequestCreated && (
          (merged && state === 'merged') || (!merged && state === 'opened')
        );
        return response(visible ? [{
          id: 9,
          iid: 3,
          state: merged ? 'merged' : 'opened',
          title: 'Configure Hypervibe GitLab CI deploys',
          source_branch: [...url.searchParams.getAll('source_branch')][0],
          target_branch: 'main',
          sha: mergeRequestSourceSha,
          merge_commit_sha: merged ? commitSha : null,
          web_url: `${projectPayload.web_url}/-/merge_requests/3`,
        }] : []);
      }
      if (method === 'POST' && decodedPath.endsWith('/merge_requests')) {
        const body = JSON.parse(String(init?.body));
        mergeRequestCreated = true;
        return response({
          id: 9,
          iid: 3,
          state: 'opened',
          title: body.title,
          source_branch: body.source_branch,
          target_branch: body.target_branch,
          sha: 'b'.repeat(40),
          web_url: `${projectPayload.web_url}/-/merge_requests/3`,
        });
      }
      if (method === 'GET' && decodedPath.endsWith('/ci/lint')) {
        const includePaths = [...committed.keys()].filter((file) => (
          file === '.gitlab/hypervibe/manifest.yml'
          || file.startsWith('.gitlab/hypervibe/deploy-')
        ));
        const productionProvider = committed.has('.gitlab/hypervibe/deploy-cloudrun-production.yml')
          ? 'cloudrun'
          : 'railway';
        return response({
          valid: true,
          jobs: [
            { name: 'hypervibe:contract:railway:staging', stage: 'contract', environment: 'staging' },
            { name: `hypervibe:contract:${productionProvider}:production`, stage: 'contract', environment: 'production' },
            { name: 'hypervibe:build:railway:staging', stage: 'build' },
            { name: 'hypervibe:deploy:railway:staging', stage: 'deploy', environment: 'staging' },
            ...(productionProvider === 'railway'
              ? [{ name: 'hypervibe:promote:railway:production', stage: 'promotion' }]
              : []),
            { name: `hypervibe:build:${productionProvider}:production`, stage: 'build' },
            { name: `hypervibe:deploy:${productionProvider}:production`, stage: 'deploy', environment: 'production' },
          ],
          includes: includePaths.map((location) => ({
            type: 'local',
            location: `/${location}`,
            context_sha: url.searchParams.get('content_ref') ?? commitSha,
          })),
        });
      }
      if (method === 'GET' && decodedPath.endsWith('/protected_branches')) {
        return response([{ name: 'main', push_access_levels: [{ access_level: 0 }], allow_force_push: false }]);
      }
      if (method === 'GET' && decodedPath.endsWith('/protected_tags')) {
        return response([
          { name: 'hypervibe-rollback-production-*', create_access_levels: [{ access_level: null, user_id: 3 }] },
          { name: 'hypervibe-rollback-staging-*', create_access_levels: [{ access_level: null, user_id: 3 }] },
        ]);
      }
      if (method === 'GET' && decodedPath.endsWith('/protected_environments/production')) {
        return response({ deploy_access_levels: [{ access_level: 40 }] });
      }
      if (method === 'GET' && decodedPath.endsWith('/variables')) {
        return response([...variables.values()]);
      }
      if (method === 'GET' && decodedPath.endsWith('/pipelines')) {
        return response([]);
      }
      if (method === 'POST' && decodedPath.endsWith('/variables')) {
        const body = JSON.parse(String(init?.body));
        variables.set(`${body.key}:${body.environment_scope}`, {
          ...body,
          hidden: body.masked_and_hidden === true,
          masked: body.masked === true || body.masked_and_hidden === true,
        });
        return response(body, 201);
      }
      if (method === 'DELETE' && decodedPath.includes('/variables/')) {
        const key = decodedPath.slice(decodedPath.lastIndexOf('/') + 1);
        variables.delete(`${key}:${url.searchParams.get('filter[environment_scope]')}`);
        return new Response(undefined, { status: 204 });
      }
      throw new Error(`Unexpected GitLab request: ${method} ${url}`);
    });

    const untrustedRunnerPlan = await gitLabCiLifecycle.planDeploy({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      environment,
    });
    expect(untrustedRunnerPlan.error).toContain('project or group runner can claim');
    expect(mutationCalls).toEqual([]);
    runnerType = 'instance_type';

    const planned = await gitLabCiLifecycle.planDeploy({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      environment,
    });
    expect(planned.error).toBeUndefined();
    expect(planned.actions).toHaveLength(1);
    expect(planned.actions?.[0]).toMatchObject({
      id: 'ci:gitlab-ci:configuration',
      type: 'update',
      resource: { kind: 'ci', provider: 'gitlab-ci', name: 'configuration' },
      verified: true,
      metadata: { repositoryId: '42', baseSha: commitSha },
    });
    expect(JSON.stringify(planned)).not.toContain('gitlab-api-token');
    expect(JSON.stringify(planned)).not.toContain('railway-api-token');

    const applied = await gitLabCiLifecycle.applyDeploy({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      action: planned.actions![0],
    });
    expect(applied).toMatchObject({ success: false, status: 'pending' });
    expect(applied.data).toMatchObject({ mergeRequest: `${projectPayload.web_url}/-/merge_requests/3` });
    const commitRequests = mutationCalls.filter((call) => call.method === 'POST' && call.url.includes('/repository/commits'));
    expect(commitRequests).toHaveLength(1);
    const commitBody = JSON.parse(commitRequests[0].body!);
    expect(commitBody.actions.map((action: { file_path: string }) => action.file_path)).toEqual([
      '.gitlab-ci.yml',
      '.gitlab/hypervibe/build-railway-production.sh',
      '.gitlab/hypervibe/build-railway-staging.sh',
      '.gitlab/hypervibe/deploy-railway-production.yml',
      '.gitlab/hypervibe/deploy-railway-staging.yml',
      '.gitlab/hypervibe/finalize-release-evidence.mjs',
      '.gitlab/hypervibe/manifest.yml',
      '.gitlab/hypervibe/railway-deploy.mjs',
      '.gitlab/hypervibe/verify-deployment-contract.cjs',
      '.gitlab/hypervibe/verify-deployment-order.mjs',
      '.gitlab/hypervibe/verify-promotion-evidence.mjs',
    ]);
    const committedFiles = Object.fromEntries(commitBody.actions.map((action: { file_path: string; content: string }) => (
      [action.file_path, action.content]
    )));
    const stagingDeploy = committedFiles['.gitlab/hypervibe/deploy-railway-staging.yml'];
    const appliedSpecGate = stagingDeploy.match(
      /printenv (HYPERVIBE_[0-9A-F]{16}_APPLIED_SPEC_HASH)/
    );
    expect(appliedSpecGate).not.toBeNull();
    const appliedSpecVariable = appliedSpecGate![1];
    const expectedAppliedSpecHash = environmentDeploymentContractHash(spec, 'staging');
    const stagingPushRule = `$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main" && $${appliedSpecVariable} != ""`;
    expect(committedFiles['.gitlab-ci.yml']).toContain(stagingPushRule);
    expect(stagingDeploy).toContain(stagingPushRule);
    expect(stagingPushRule).not.toContain(expectedAppliedSpecHash);
    expect(stagingDeploy).not.toContain(expectedAppliedSpecHash);
    expect(stagingDeploy).toContain('node .gitlab/hypervibe/verify-deployment-contract.cjs');
    expect(stagingDeploy).toContain(
      'export HYPERVIBE_DEPLOYMENT_CONTRACT_FINGERPRINT="$(cat .hypervibe-deployment-contract-fingerprint)"'
    );
    const liveContractRead = stagingDeploy.lastIndexOf(
      `export HYPERVIBE_APPLIED_SPEC_HASH="$(printenv ${appliedSpecVariable} || true)"`
    );
    const deployContractGate = stagingDeploy.lastIndexOf(
      'node .gitlab/hypervibe/verify-deployment-contract.cjs'
    );
    expect(liveContractRead).toBeGreaterThan(stagingDeploy.indexOf('hypervibe:deploy:railway:staging:'));
    expect(liveContractRead).toBeLessThan(deployContractGate);
    expect(deployContractGate).toBeLessThan(
      stagingDeploy.indexOf('node .gitlab/hypervibe/verify-deployment-order.mjs')
    );
    expect(stagingDeploy.match(/node \.gitlab\/hypervibe\/verify-deployment-contract\.cjs/g))
      .toHaveLength(2);
    expect(stagingDeploy.indexOf('hypervibe:contract:railway:staging:'))
      .toBeLessThan(stagingDeploy.indexOf('hypervibe:build:railway:staging:'));
    const manualRule = stagingDeploy.split('\n').find((line: string) => (
      line.includes('$CI_PIPELINE_SOURCE == "api"')
      && line.includes('$[[ inputs.environment ]]')
    ));
    expect(manualRule).toBeDefined();
    expect(manualRule).not.toContain(appliedSpecVariable);
    expect(committedFiles['.gitlab-ci.yml']).toContain('commit_sha:');
    expect(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml'])
      .not.toContain(environmentDeploymentContractHash(spec, 'production'));
    expect(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml']).toContain(
      'sh .gitlab/hypervibe/build-railway-production.sh "$[[ inputs.commit_sha ]]"'
    );
    expect(committedFiles['.gitlab/hypervibe/build-railway-production.sh']).toContain(
      'The checked-out Git SHA does not match the reviewed full deploy SHA'
    );
    expect(committedFiles['.gitlab/hypervibe/build-railway-production.sh']).toContain(
      'Dockerfile and .dockerignore must not be symbolic links'
    );
    expect(committedFiles['.gitlab/hypervibe/build-railway-production.sh']).toContain("cat >> \"$ignorefile\"");
    expect(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml']).toContain(
      'node .gitlab/hypervibe/verify-deployment-order.mjs'
    );
    expect(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml']).toContain(
      'hypervibe:promote:railway:production:'
    );
    expect(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml']).toContain(
      'node .gitlab/hypervibe/verify-promotion-evidence.mjs'
    );
    expect(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml']).toContain(
      'HYPERVIBE_PROMOTION_SERVICES'
    );
    expect(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml']).toContain(
      'HYPERVIBE_PROMOTION_PROVIDER_IDENTITY'
    );
    expect(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml']).toContain(
      'node .gitlab/hypervibe/finalize-release-evidence.mjs'
    );
    expect(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml'].indexOf(
      'hypervibe:promote:railway:production:'
    )).toBeLessThan(committedFiles['.gitlab/hypervibe/deploy-railway-production.yml'].indexOf(
      'hypervibe:build:railway:production:'
    ));
    expect(committedFiles['.gitlab/hypervibe/verify-deployment-order.mjs']).toContain(
      "'JOB-TOKEN': process.env.CI_JOB_TOKEN"
    );
    expect(JSON.stringify(commitBody)).not.toContain('gitlab-api-token');
    expect(JSON.stringify(commitBody)).not.toContain('railway-api-token');

    merged = true;
    mutationCalls.length = 0;
    mergeRequestSourceSha = 'c'.repeat(40);
    const unprovenMerge = await gitLabCiLifecycle.planDeploy({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      environment,
    });
    expect(unprovenMerge.error).toContain('exact reviewed proposal head');
    expect(mutationCalls).toEqual([]);
    mergeRequestSourceSha = 'b'.repeat(40);

    const stagingEnvironment = new EnvironmentRepository()
      .findByProjectAndName(project.id, 'staging')!;
    new EnvironmentRepository().updatePlatformBindings(stagingEnvironment.id, {
      ci: {
        gitlabCi: {
          provider: 'gitlab-ci',
          repositoryId: '42',
          instanceScope: 'https://gitlab.com',
          repositoryScope: projectPayload.web_url,
          variableHashes: { HYPERVIBE_STAGING_LEGACY: 'f'.repeat(64) },
        },
      },
    });
    const rotatedOwnerSpec = projectSpecSchema.parse({
      ...spec,
      environments: {
        ...spec.environments,
        production: {
          ...spec.environments.production,
          deploy: { strategy: 'manual' },
        },
      },
    });
    const ownerRotation = await gitLabCiLifecycle.planDeploy({
      project,
      spec: rotatedOwnerSpec,
      environmentName: 'production',
      environmentSpec: rotatedOwnerSpec.environments.production,
      environment,
    });
    expect(ownerRotation.error).toBeUndefined();
    expect(ownerRotation.actions).toHaveLength(1);
    expect(ownerRotation.actions?.[0]?.metadata).toMatchObject({
      operation: 'ciConfigurationSync',
      removedPaths: expect.arrayContaining([
        '.gitlab/hypervibe/build-railway-production.sh',
        '.gitlab/hypervibe/deploy-railway-production.yml',
      ]),
    });
    new EnvironmentRepository().updatePlatformBindings(stagingEnvironment.id, { ci: null });

    const variablePlan = await gitLabCiLifecycle.planDeploy({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      environment,
    });
    expect(variablePlan.error).toBeUndefined();
    expect(variablePlan.actions).toHaveLength(5);
    expect(variablePlan.actions?.every((action) => action.type === 'create')).toBe(true);
    expect(variablePlan.actions?.every((action) => action.resource.name.includes('HYPERVIBE_'))).toBe(true);
    expect(JSON.stringify(variablePlan)).not.toContain('railway-api-token');
    expect(JSON.stringify(variablePlan)).not.toContain('gitlab-registry-read-token');

    const stagingVariablePlan = await gitLabCiLifecycle.planDeploy({
      project,
      spec,
      environmentName: 'staging',
      environmentSpec: spec.environments.staging,
      environment: new EnvironmentRepository().findByProjectAndName(project.id, 'staging'),
    });
    expect(stagingVariablePlan.error).toBeUndefined();
    expect(stagingVariablePlan.actions).toHaveLength(5);
    const railwayProductionVariableKeys = variablePlan.actions!.map((action) => (
      String(action.metadata?.variableKey)
    ));

    const firstVariableKey = String(variablePlan.actions?.[0]?.metadata?.variableKey);
    variables.set(`${firstVariableKey}:production`, {
      key: firstVariableKey,
      value: 'unowned-value',
      protected: true,
      masked: true,
      hidden: true,
      raw: true,
      environment_scope: 'production',
    });
    const collision = await gitLabCiLifecycle.planDeploy({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      environment,
    });
    expect(collision.error).toContain('without a matching Hypervibe ownership binding');

    mutationCalls.length = 0;
    const racedApply = await gitLabCiLifecycle.applyDeploy({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      action: variablePlan.actions![0],
    });
    expect(racedApply).toMatchObject({ success: false, status: 'blocked' });
    expect(mutationCalls.filter((call) => call.url.endsWith('/variables'))).toEqual([]);
    variables.clear();

    for (const action of variablePlan.actions ?? []) {
      const result = await gitLabCiLifecycle.applyDeploy({
        project,
        spec,
        environmentName: 'production',
        environmentSpec: spec.environments.production,
        action,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
      expect(JSON.stringify(result)).not.toContain('railway-api-token');
      expect(JSON.stringify(result)).not.toContain('gitlab-registry-read-token');
    }
    for (const action of stagingVariablePlan.actions ?? []) {
      const result = await gitLabCiLifecycle.applyDeploy({
        project,
        spec,
        environmentName: 'staging',
        environmentSpec: spec.environments.staging,
        action,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    }

    const appliedHashPlan = await gitLabCiLifecycle.planAppliedSpecHash!({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      environment,
    });
    expect(appliedHashPlan.error).toBeUndefined();
    expect(appliedHashPlan.actions).toHaveLength(1);
    expect(appliedHashPlan.actions?.[0]?.metadata).toMatchObject({
      environmentScope: '*',
      variableKey: expect.stringMatching(/^HYPERVIBE_[0-9A-F]{16}_APPLIED_SPEC_HASH$/),
      valueSource: 'desired:deployment-contract',
    });
    const appliedHash = await gitLabCiLifecycle.applyAppliedSpecHash!({
      project,
      spec,
      environmentName: 'production',
      action: appliedHashPlan.actions![0],
    });
    expect(appliedHash).toMatchObject({ success: true });

    const appliedHashNoop = await gitLabCiLifecycle.planAppliedSpecHash!({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      environment,
    });
    expect(appliedHashNoop).toEqual({ actions: [], warnings: [] });

    mutationCalls.length = 0;
    const converged = await gitLabCiLifecycle.planDeploy({
      project,
      spec,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      environment,
    });
    expect(converged).toEqual({ actions: [], warnings: [] });
    expect(mutationCalls).toEqual([]);

    const envOnlySpec = projectSpecSchema.parse({
      ...spec,
      environments: {
        staging: {
          ...spec.environments.staging,
          envVars: { RELEASE_CHANNEL: 'candidate' },
        },
        production: {
          ...spec.environments.production,
          envVars: { RELEASE_CHANNEL: 'stable' },
        },
      },
    });
    const stableConfiguration = await gitLabCiLifecycle.planDeploy({
      project,
      spec: envOnlySpec,
      environmentName: 'production',
      environmentSpec: envOnlySpec.environments.production,
      environment: new EnvironmentRepository().findById(environment.id),
    });
    expect(stableConfiguration).toEqual({ actions: [], warnings: [] });
    expect(mutationCalls).toEqual([]);
    const changedAppliedContract = await gitLabCiLifecycle.planAppliedSpecHash!({
      project,
      spec: envOnlySpec,
      environmentName: 'production',
      environmentSpec: envOnlySpec.environments.production,
      environment: new EnvironmentRepository().findById(environment.id),
    });
    expect(changedAppliedContract.actions).toHaveLength(1);
    expect(changedAppliedContract.actions?.[0]).toMatchObject({
      type: 'update',
      metadata: { operation: 'ciAppliedSpecHashSync' },
    });

    const switchedSpec = projectSpecSchema.parse({
      ...spec,
      environments: {
        ...spec.environments,
        production: {
          ...spec.environments.production,
          hosting: { provider: 'cloudrun', region: 'us-west1' },
          deploy: { ...spec.environments.production.deploy, autoDeploy: true },
        },
      },
    });
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      provider: 'cloudrun',
      projectId: 'gitlab-cloudrun-app-production',
      providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      services: {
        web: {
          serviceId: 'gitlab-cloudrun-app-production-web',
          workloadKind: 'web',
          resourceType: 'service',
        },
      },
    });
    const cloudrun = new ConnectionRepository().create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({
        credentials: '{"client_email":"ci@example.test"}',
        projectId: 'gcp-project',
      }),
    });
    new ConnectionRepository().updateStatus(cloudrun.id, 'verified');
    mergeRequestCreated = false;
    mutationCalls.length = 0;
    const switchedConfiguration = await gitLabCiLifecycle.planDeploy({
      project,
      spec: switchedSpec,
      environmentName: 'production',
      environmentSpec: switchedSpec.environments.production,
      environment: new EnvironmentRepository().findById(environment.id),
    });
    expect(switchedConfiguration.error).toBeUndefined();
    expect(switchedConfiguration.actions).toHaveLength(1);
    expect(switchedConfiguration.actions?.[0]?.metadata?.operation).toBe('ciConfigurationSync');
    const proposedSwitch = await gitLabCiLifecycle.applyDeploy({
      project,
      spec: switchedSpec,
      environmentName: 'production',
      environmentSpec: switchedSpec.environments.production,
      action: switchedConfiguration.actions![0],
    });
    expect(proposedSwitch).toMatchObject({ success: false, status: 'pending' });

    merged = true;
    const switchedVariables = await gitLabCiLifecycle.planDeploy({
      project,
      spec: switchedSpec,
      environmentName: 'production',
      environmentSpec: switchedSpec.environments.production,
      environment: new EnvironmentRepository().findById(environment.id),
    });
    expect(switchedVariables.error).toBeUndefined();
    const retiredVariables = switchedVariables.actions?.filter((action) => action.type === 'destroy') ?? [];
    expect(retiredVariables).toHaveLength(railwayProductionVariableKeys.length);
    expect(retiredVariables.map((action) => action.metadata?.variableKey).sort())
      .toEqual([...railwayProductionVariableKeys].sort());
    expect(retiredVariables.every((action) => action.dataBearing && action.requiresConfirm)).toBe(true);
    expect(switchedVariables.actions?.filter((action) => action.type === 'create')).toHaveLength(9);
    for (const action of switchedVariables.actions ?? []) {
      const result = await gitLabCiLifecycle.applyDeploy({
        project,
        spec: switchedSpec,
        environmentName: 'production',
        environmentSpec: switchedSpec.environments.production,
        action,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    }
    const productionVariableKeys = [...variables.values()]
      .filter((variable) => variable.environment_scope === 'production')
      .map((variable) => String(variable.key));
    expect(productionVariableKeys.some((key) => railwayProductionVariableKeys.includes(key))).toBe(false);
    const productionGitLabBinding = (
      new EnvironmentRepository().findById(environment.id)?.platformBindings.ci as {
        gitlabCi?: { variableHashes?: Record<string, string> };
      }
    )?.gitlabCi;
    expect(Object.keys(productionGitLabBinding?.variableHashes ?? {})
      .some((key) => railwayProductionVariableKeys.includes(key))).toBe(false);

    const teardownSpec = projectSpecSchema.parse({
      ...switchedSpec,
      environments: {
        staging: { ...switchedSpec.environments.staging, deploy: { strategy: 'manual' } },
        production: { ...switchedSpec.environments.production, deploy: { strategy: 'manual' } },
      },
    });
    merged = true;
    mergeRequestCreated = false;
    mutationCalls.length = 0;
    const expectedTeardownPaths = [...committed.keys()].sort();
    expect(expectedTeardownPaths.length).toBeGreaterThan(0);
    const teardownConfig = await gitLabCiLifecycle.planDeploy({
      project,
      spec: teardownSpec,
      environmentName: 'production',
      environmentSpec: teardownSpec.environments.production,
      environment,
    });
    expect(teardownConfig.error).toBeUndefined();
    expect(teardownConfig.actions).toHaveLength(1);
    expect(teardownConfig.actions?.[0]?.metadata).toMatchObject({
      operation: 'ciConfigurationSync',
    });
    expect(teardownConfig.actions?.[0]?.metadata?.removedPaths).toEqual(expectedTeardownPaths);
    const proposedTeardown = await gitLabCiLifecycle.applyDeploy({
      project,
      spec: teardownSpec,
      environmentName: 'production',
      environmentSpec: teardownSpec.environments.production,
      action: teardownConfig.actions![0],
    });
    expect(proposedTeardown).toMatchObject({ success: false, status: 'pending' });
    const teardownCommit = mutationCalls
      .filter((call) => call.method === 'POST' && call.url.includes('/repository/commits'))
      .at(-1);
    const teardownActions = JSON.parse(teardownCommit!.body!).actions as Array<{
      action: string;
      file_path: string;
    }>;
    expect(teardownActions).toHaveLength(expectedTeardownPaths.length);
    expect(teardownActions.map((action) => action.file_path).sort()).toEqual(expectedTeardownPaths);
    expect(teardownActions.map((action) => action.action)).toEqual(
      expectedTeardownPaths.map(() => 'delete')
    );
    expect(committed.size).toBe(0);
    expect((
      new EnvironmentRepository().findByProjectAndName(project.id, 'staging')?.platformBindings.ci as {
        gitlabCi?: { configurationProposal?: { programHash?: string } };
      }
    )?.gitlabCi?.configurationProposal?.programHash).toBe(teardownConfig.actions?.[0]?.metadata?.programHash);

    merged = true;
    mutationCalls.length = 0;
    const teardownVariables = await gitLabCiLifecycle.planDeploy({
      project,
      spec: teardownSpec,
      environmentName: 'production',
      environmentSpec: teardownSpec.environments.production,
      environment,
    });
    expect(teardownVariables.error).toBeUndefined();
    expect(teardownVariables.actions?.slice(0, -1).every((action) => (
      action.type === 'destroy' && action.dataBearing && action.requiresConfirm
    ))).toBe(true);
    expect(teardownVariables.actions?.at(-1)?.metadata?.operation).toBe('ciBindingRemove');
    for (const action of teardownVariables.actions ?? []) {
      const result = await gitLabCiLifecycle.applyDeploy({
        project,
        spec: teardownSpec,
        environmentName: 'production',
        environmentSpec: teardownSpec.environments.production,
        action,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    }
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'production')?.platformBindings)
      .toMatchObject({ ci: { gitlabCi: null } });

    const stagingTeardown = await gitLabCiLifecycle.planDeploy({
      project,
      spec: teardownSpec,
      environmentName: 'staging',
      environmentSpec: teardownSpec.environments.staging,
      environment: new EnvironmentRepository().findByProjectAndName(project.id, 'staging'),
    });
    expect(stagingTeardown.error).toBeUndefined();
    expect(stagingTeardown.actions?.at(-1)?.metadata?.operation).toBe('ciBindingRemove');
    for (const action of stagingTeardown.actions ?? []) {
      const result = await gitLabCiLifecycle.applyDeploy({
        project,
        spec: teardownSpec,
        environmentName: 'staging',
        environmentSpec: teardownSpec.environments.staging,
        action,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    }
    expect(variables.size).toBe(0);
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'staging')?.platformBindings)
      .toMatchObject({ ci: { gitlabCi: null } });
  });
});

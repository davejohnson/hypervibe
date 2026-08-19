import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/devops-providers.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { SecretStore, getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import { PlanService } from '../../plan/plan.service.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { createToolContext } from '../../../application/context.js';
import {
  applyManagedCodeRepositoryAction,
  planManagedCodeRepository,
} from '../managed-code-repository.service.js';

const scope = 'https://gitlab.example.com/acme/apps/new-app';
const gitRemoteUrl = scope + '.git';
const providerProject = {
  id: 42,
  path_with_namespace: 'acme/apps/new-app',
  default_branch: 'main',
  visibility: 'private' as const,
  web_url: scope,
  http_url_to_repo: gitRemoteUrl,
  ssh_url_to_repo: 'git@gitlab.example.com:acme/apps/new-app.git',
  permissions: { group_access: { access_level: 50 } },
};

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
}

function spec(state: 'present' | 'absent' = 'present') {
  return projectSpecSchema.parse({
    version: 1,
    project: 'new-app',
    gitRemoteUrl,
    devops: {
      code: {
        provider: 'gitlab',
        scope,
        repository: { state, management: 'managed', defaultBranch: 'main', visibility: 'private' },
      },
    },
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: {},
        deploy: { strategy: 'manual' },
      },
    },
  });
}

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-managed-repository-'));
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

function seed(createEnvironment = true) {
  const project = new ProjectRepository().create({ name: 'new-app', defaultPlatform: 'railway', gitRemoteUrl });
  const environment = createEnvironment
    ? new EnvironmentRepository().create({ projectId: project.id, name: 'production' })
    : null;
  const connection = new ConnectionRepository().create({
    provider: 'gitlab',
    scope,
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'secret', instanceUrl: 'https://gitlab.example.com' }),
  });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  return { project, environment };
}

describe('managed code repository lifecycle', () => {
  it('plans one confirmed create, persists only a verified durable id, and is mutation-free at convergence', async () => {
    const { project } = seed();
    let created = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const decodedPath = decodeURIComponent(url.pathname);
      if (method === 'GET' && decodedPath.endsWith('/user')) {
        return response({ id: 3, username: 'owner', can_create_project: true });
      }
      if (method === 'GET' && decodedPath.endsWith('/namespaces/acme/apps')) {
        return response({ id: 8, full_path: 'acme/apps', kind: 'group' });
      }
      if (method === 'GET' && decodedPath.endsWith('/groups/8')) {
        return response({ id: 8, full_path: 'acme/apps', project_creation_level: 'developer' });
      }
      if (method === 'GET' && decodedPath.endsWith('/groups/8/members/all/3')) {
        return response({ access_level: 50 });
      }
      if (method === 'POST' && decodedPath.endsWith('/projects')) {
        created = true;
        return response(providerProject, 201);
      }
      if (method === 'GET' && (decodedPath.endsWith('/projects/acme/apps/new-app') || decodedPath.endsWith('/projects/42'))) {
        return created ? response(providerProject) : response({ message: 'not found' }, 404);
      }
      throw new Error(`Unexpected GitLab request: ${method} ${url}`);
    });

    const planned = await planManagedCodeRepository({ project, spec: spec('present'), environmentName: 'production' });
    expect(planned.action).toMatchObject({ type: 'create', dataBearing: true, requiresConfirm: true });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    const applied = await applyManagedCodeRepositoryAction({
      project,
      spec: spec('present'),
      environmentName: 'production',
      action: planned.action!,
    });
    expect(applied).toMatchObject({ success: true, data: { repositoryId: '42' } });
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'production')?.platformBindings)
      .toMatchObject({ devops: { codeRepository: { nativeId: '42', management: 'managed', visibility: 'private' } } });

    const converged = await planManagedCodeRepository({ project, spec: spec('present'), environmentName: 'production' });
    expect(converged).toMatchObject({ stageRequired: false });
    expect(converged.action).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('blocks unknown observation and never turns it into a create', async () => {
    const { project } = seed();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ message: 'forbidden' }, 403));
    const planned = await planManagedCodeRepository({ project, spec: spec('present'), environmentName: 'production' });
    expect(planned.action).toBeUndefined();
    expect(planned.error).toContain('HTTP 403');
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('retains the durable binding when an acknowledged create has setting drift', async () => {
    const { project } = seed();
    let created = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const decodedPath = decodeURIComponent(url.pathname);
      if (method === 'GET' && decodedPath.endsWith('/user')) {
        return response({ id: 3, username: 'owner', can_create_project: true });
      }
      if (method === 'GET' && decodedPath.endsWith('/namespaces/acme/apps')) {
        return response({ id: 8, full_path: 'acme/apps', kind: 'group' });
      }
      if (method === 'GET' && decodedPath.endsWith('/groups/8')) {
        return response({ id: 8, full_path: 'acme/apps', project_creation_level: 'developer' });
      }
      if (method === 'GET' && decodedPath.endsWith('/groups/8/members/all/3')) {
        return response({ access_level: 50 });
      }
      if (method === 'POST' && decodedPath.endsWith('/projects')) {
        created = true;
        return response(providerProject, 201);
      }
      if (method === 'GET' && decodedPath.endsWith('/projects/acme/apps/new-app')) {
        return created ? response({ ...providerProject, visibility: 'public' }) : response({ message: 'not found' }, 404);
      }
      if (method === 'GET' && decodedPath.endsWith('/projects/42')) {
        return response({ ...providerProject, visibility: 'public' });
      }
      throw new Error(`Unexpected GitLab request: ${method} ${url}`);
    });

    const planned = await planManagedCodeRepository({
      project,
      spec: spec('present'),
      environmentName: 'production',
    });
    const applied = await applyManagedCodeRepositoryAction({
      project,
      spec: spec('present'),
      environmentName: 'production',
      action: planned.action!,
    });

    expect(applied).toMatchObject({
      success: false,
      status: 'blocked',
      message: expect.stringContaining('did not converge'),
    });
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'production')?.platformBindings)
      .toMatchObject({ devops: { codeRepository: { nativeId: '42', visibility: 'public', management: 'managed' } } });
  });

  it('blocks a mismatched managed remote before any provider request', async () => {
    const { project } = seed();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const mismatched = projectSpecSchema.parse({
      ...spec('present'),
      gitRemoteUrl: 'https://gitlab.example.com/acme/apps/different-project.git',
    });

    const planned = await planManagedCodeRepository({
      project,
      spec: mismatched,
      environmentName: 'production',
    });

    expect(planned).toMatchObject({
      stageRequired: true,
      error: expect.stringContaining('gitRemoteUrl'),
    });
    expect(planned.action).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks observed managed-project setting drift without mutating GitLab', async () => {
    const { project, environment } = seed();
    new EnvironmentRepository().updatePlatformBindings(environment!.id, {
      devops: {
        codeRepository: {
          provider: 'gitlab', nativeId: '42', instanceScope: 'https://gitlab.example.com',
          canonicalScope: scope, path: 'acme/apps/new-app', defaultBranch: 'main', webUrl: scope,
          cloneUrls: [gitRemoteUrl], management: 'managed', desiredScope: scope,
        },
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const decodedPath = decodeURIComponent(new URL(String(input)).pathname);
      if ((init?.method ?? 'GET') === 'GET' && decodedPath.endsWith('/projects/42')) {
        return response({ ...providerProject, visibility: 'public' });
      }
      throw new Error(`Unexpected GitLab request: ${init?.method ?? 'GET'} ${input}`);
    });

    const planned = await planManagedCodeRepository({
      project,
      spec: spec('present'),
      environmentName: 'production',
    });

    expect(planned).toMatchObject({
      stageRequired: true,
      error: expect.stringContaining('settings drifted'),
    });
    expect(planned.action).toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('plans exact confirmed destruction only for the bound durable id', async () => {
    const { project, environment } = seed();
    new EnvironmentRepository().updatePlatformBindings(environment!.id, {
      devops: {
        codeRepository: {
          provider: 'gitlab', nativeId: '42', instanceScope: 'https://gitlab.example.com',
          canonicalScope: scope, path: 'acme/apps/new-app', defaultBranch: 'main', webUrl: scope,
          cloneUrls: [gitRemoteUrl], management: 'managed', desiredScope: scope,
        },
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const decodedPath = decodeURIComponent(new URL(String(input)).pathname);
      if (decodedPath.endsWith('/projects/42')) return response(providerProject);
      if (decodedPath.endsWith('/user')) return response({ id: 3, username: 'owner', can_create_project: true });
      if (decodedPath.endsWith('/namespaces/acme/apps')) return response({ id: 8, full_path: 'acme/apps', kind: 'group' });
      if (decodedPath.endsWith('/groups/8')) return response({ id: 8, full_path: 'acme/apps', project_creation_level: 'developer' });
      if (decodedPath.endsWith('/groups/8/members/all/3')) return response({ access_level: 50 });
      throw new Error(`Unexpected GitLab request: ${input}`);
    });
    const planned = await planManagedCodeRepository({ project, spec: spec('absent'), environmentName: 'production' });
    expect(planned.action).toMatchObject({
      type: 'destroy',
      dataBearing: true,
      requiresConfirm: true,
      metadata: { repositoryId: '42', instanceScope: 'https://gitlab.example.com' },
    });
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('removes a self-managed binding only after the exact project is confirmed absent', async () => {
    const { project, environment } = seed();
    new EnvironmentRepository().updatePlatformBindings(environment!.id, {
      devops: {
        codeRepository: {
          provider: 'gitlab', nativeId: '42', instanceScope: 'https://gitlab.example.com',
          canonicalScope: scope, path: 'acme/apps/new-app', defaultBranch: 'main', webUrl: scope,
          cloneUrls: [gitRemoteUrl], management: 'managed', desiredScope: scope,
        },
      },
    });
    let deleted = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const decodedPath = decodeURIComponent(url.pathname);
      if (method === 'GET' && (decodedPath.endsWith('/projects/42') || decodedPath.endsWith('/projects/acme/apps/new-app'))) {
        return deleted ? response({ message: 'not found' }, 404) : response(providerProject);
      }
      if (method === 'GET' && decodedPath.endsWith('/user')) {
        return response({ id: 3, username: 'owner' });
      }
      if (method === 'DELETE' && decodedPath.endsWith('/projects/42')) {
        if (url.searchParams.get('permanently_remove') === 'true') deleted = true;
        return new Response(undefined, { status: url.searchParams.has('permanently_remove') ? 204 : 202 });
      }
      throw new Error(`Unexpected GitLab request: ${method} ${url}`);
    });

    const planned = await planManagedCodeRepository({ project, spec: spec('absent'), environmentName: 'production' });
    const applied = await applyManagedCodeRepositoryAction({
      project,
      spec: spec('absent'),
      environmentName: 'production',
      action: planned.action!,
    });

    expect(applied).toMatchObject({ success: true, data: { repositoryId: '42' } });
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'production')?.platformBindings)
      .toMatchObject({ devops: { codeRepository: null } });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);

    const converged = await planManagedCodeRepository({ project, spec: spec('absent'), environmentName: 'production' });
    expect(converged).toEqual({ stageRequired: false });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);
  });

  it('retains and safely retries a partially acknowledged self-managed deletion', async () => {
    const { project, environment } = seed();
    new EnvironmentRepository().updatePlatformBindings(environment!.id, {
      devops: {
        codeRepository: {
          provider: 'gitlab', nativeId: '42', instanceScope: 'https://gitlab.example.com',
          canonicalScope: scope, path: 'acme/apps/new-app', defaultBranch: 'main', webUrl: scope,
          cloneUrls: [gitRemoteUrl], management: 'managed', desiredScope: scope,
        },
      },
    });
    let scheduled = false;
    let allowPermanent = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const decodedPath = decodeURIComponent(url.pathname);
      if (method === 'GET' && decodedPath.endsWith('/projects/42')) {
        return scheduled ? response({ message: 'not found' }, 404) : response(providerProject);
      }
      if (method === 'GET' && decodedPath.endsWith('/user')) return response({ id: 3, username: 'owner' });
      if (method === 'DELETE' && decodedPath.endsWith('/projects/42') && !url.searchParams.has('permanently_remove')) {
        scheduled = true;
        return new Response(undefined, { status: 202 });
      }
      if (method === 'DELETE' && decodedPath.endsWith('/projects/42') && url.searchParams.get('permanently_remove') === 'true') {
        return allowPermanent
          ? new Response(undefined, { status: 204 })
          : response({ message: 'forbidden' }, 403);
      }
      throw new Error(`Unexpected GitLab request: ${method} ${url}`);
    });

    const firstPlan = await planManagedCodeRepository({ project, spec: spec('absent'), environmentName: 'production' });
    const partial = await applyManagedCodeRepositoryAction({
      project,
      spec: spec('absent'),
      environmentName: 'production',
      action: firstPlan.action!,
    });
    expect(partial).toMatchObject({ success: false, status: 'blocked', message: expect.stringContaining('partially') });
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'production')?.platformBindings)
      .toMatchObject({ devops: { codeRepository: { nativeId: '42', deletionAttemptedAt: expect.any(String), deletionScheduledAt: expect.any(String) } } });

    const retryPlan = await planManagedCodeRepository({ project, spec: spec('absent'), environmentName: 'production' });
    expect(retryPlan.action).toMatchObject({ type: 'destroy', requiresConfirm: true, metadata: { repositoryId: '42' } });
    allowPermanent = true;
    const retried = await applyManagedCodeRepositoryAction({
      project,
      spec: spec('absent'),
      environmentName: 'production',
      action: retryPlan.action!,
    });
    expect(retried).toMatchObject({ success: true, data: { repositoryId: '42' } });
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'production')?.platformBindings)
      .toMatchObject({ devops: { codeRepository: null } });
  });

  it('plans and applies project creation in the reserved repository environment', async () => {
    const { project } = seed(false);
    const repositorySpec = projectSpecSchema.parse({
      ...spec('present'),
      devops: {
        ...spec('present').devops,
        canonicalEnvironment: 'repository',
      },
      environments: {},
    });
    const stored = new SpecStore().replace(project, repositorySpec);
    let created = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const decodedPath = decodeURIComponent(url.pathname);
      if (method === 'GET' && decodedPath.endsWith('/user')) return response({ id: 3, username: 'owner', can_create_project: true });
      if (method === 'GET' && decodedPath.endsWith('/namespaces/acme/apps')) return response({ id: 8, full_path: 'acme/apps', kind: 'group' });
      if (method === 'GET' && decodedPath.endsWith('/groups/8')) return response({ id: 8, full_path: 'acme/apps', project_creation_level: 'developer' });
      if (method === 'GET' && decodedPath.endsWith('/groups/8/members/all/3')) return response({ access_level: 50 });
      if (method === 'POST' && decodedPath.endsWith('/projects')) {
        created = true;
        return response(providerProject, 201);
      }
      if (method === 'GET' && (decodedPath.endsWith('/projects/acme/apps/new-app') || decodedPath.endsWith('/projects/42'))) {
        return created ? response(providerProject) : response({ message: 'not found' }, 404);
      }
      throw new Error(`Unexpected GitLab request: ${method} ${url}`);
    });

    const planned = await new PlanService().plan(project, 'repository');
    expect(planned).not.toHaveProperty('error');
    const plan = planned as Exclude<typeof planned, { error: string }>;
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ id: 'repo:gitlab:create', requiresConfirm: true });

    const outcome = await executePlanApply(createToolContext(), {
      project,
      spec: stored.spec,
      specRevision: stored.revision,
      planId: plan.planRunId,
      confirmActions: ['repo:gitlab:create'],
    });
    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: true,
        receipts: [expect.objectContaining({ actionId: 'repo:gitlab:create', status: 'succeeded' })],
      },
    });
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'repository')?.platformBindings)
      .toMatchObject({ devops: { codeRepository: { nativeId: '42', management: 'managed' } } });
  });

  it('blocks non-canonical environment work until repository lifecycle converges', async () => {
    const { project } = seed();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const decodedPath = decodeURIComponent(url.pathname);
      if ((init?.method ?? 'GET') === 'GET' && decodedPath.endsWith('/projects/acme/apps/new-app')) {
        return response({ message: 'not found' }, 404);
      }
      if (decodedPath.endsWith('/user')) return response({ id: 3, username: 'owner', can_create_project: true });
      if (decodedPath.endsWith('/namespaces/acme/apps')) return response({ id: 8, full_path: 'acme/apps', kind: 'group' });
      if (decodedPath.endsWith('/groups/8')) return response({ id: 8, full_path: 'acme/apps', project_creation_level: 'developer' });
      if (decodedPath.endsWith('/groups/8/members/all/3')) return response({ access_level: 50 });
      throw new Error(`Unexpected GitLab request: ${init?.method ?? 'GET'} ${url}`);
    });

    const planned = await planManagedCodeRepository({
      project,
      spec: projectSpecSchema.parse({
        ...spec('present'),
        devops: { ...spec('present').devops, canonicalEnvironment: 'production' },
        environments: {
          ...spec('present').environments,
          staging: { hosting: { provider: 'railway' }, services: {}, deploy: { strategy: 'manual' } },
        },
      }),
      environmentName: 'staging',
    });
    expect(planned).toMatchObject({
      stageRequired: true,
      error: expect.stringContaining('canonical environment "production"'),
    });
    expect(planned.action).toBeUndefined();
  });
});

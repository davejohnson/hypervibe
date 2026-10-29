import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/devops-providers.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { createToolContext } from '../../../application/context.js';
import { PlanService } from '../../plan/plan.service.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';

// Independent lifecycle invariant: retained uncertain work cannot be bypassed by
// changing desired providers. Native HTTP bodies are synthetic transport data.
describe('retained repository-variable outcome precedes other lifecycle stages', () => {
  let directory: string;
  const githubScope = 'owner/original';
  const gitlabScope = 'https://gitlab.example.com/acme/apps/replacement';
  let methods: string[];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-repository-var-stage-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(directory, 'state.db'));
    for (const [provider, scope, credentials] of [
      ['github', githubScope, { apiToken: 'synthetic-test-token' }],
      ['gitlab', gitlabScope, { apiToken: 'synthetic-test-token', instanceUrl: 'https://gitlab.example.com' }],
    ] as const) {
      const connection = new ConnectionRepository().create({ provider, scope,
        credentialsEncrypted: getSecretStore().encryptObject(credentials) });
      new ConnectionRepository().updateStatus(connection.id, 'verified');
    }
    methods = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (url.hostname === 'api.github.com') {
        if (method === 'GET' && url.pathname === `/repos/${githubScope}`) return Response.json({
          id: 321, full_name: githubScope, default_branch: 'main',
        });
        if (method === 'GET' && url.pathname.endsWith('/actions/variables')) return Response.json({ total_count: 0, variables: [] });
        if (method === 'POST' && url.pathname.endsWith('/actions/variables')) return Response.json({}, { status: 500 });
      }
      const pathname = decodeURIComponent(url.pathname);
      if (method === 'GET' && pathname.endsWith('/user')) return Response.json({ id: 3, username: 'owner', can_create_project: true });
      if (method === 'GET' && pathname.endsWith('/namespaces/acme/apps')) return Response.json({ id: 8, full_path: 'acme/apps', kind: 'group' });
      if (method === 'GET' && pathname.endsWith('/groups/8')) return Response.json({ id: 8, full_path: 'acme/apps', project_creation_level: 'developer' });
      if (method === 'GET' && pathname.endsWith('/groups/8/members/all/3')) return Response.json({ access_level: 50 });
      if (method === 'GET' && pathname.endsWith('/projects/acme/apps/replacement')) return Response.json({}, { status: 404 });
      throw new Error('Unexpected synthetic transport request');
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('blocks a new managed repository stage while the original variable write remains uncertain', async () => {
    const project = new ProjectRepository().create({ name: 'stage-guard', defaultPlatform: 'unconfigured',
      gitRemoteUrl: `https://github.com/${githubScope}.git` });
    const original = new SpecStore().replace(project, projectSpecSchema.parse({ version: 1, project: project.name,
      gitRemoteUrl: project.gitRemoteUrl, devops: { code: { provider: 'github', scope: githubScope },
        ci: { provider: 'github-actions', repositoryVariables: { HEALTH_ENABLED: { value: 'true' } } },
        canonicalEnvironment: 'repository' }, environments: {} }));
    const first = await new PlanService().plan(project, 'repository');
    if ('error' in first) throw new Error(first.error);
    expect(await executePlanApply(createToolContext(), { project, spec: original.spec,
      specRevision: original.revision, planId: first.planRunId, confirmActions: [] }))
      .toMatchObject({ kind: 'executed', result: { success: false, receipts: [{ status: 'pending' }] } });
    const state = new EnvironmentRepository().findByProjectAndName(project.id, 'repository')!.platformBindings.repositoryVariableOwnership;
    expect(state).toMatchObject({ pending: { variableName: 'HEALTH_ENABLED' } });
    new SpecStore().replace(project, projectSpecSchema.parse({ version: 1, project: project.name,
      gitRemoteUrl: `${gitlabScope}.git`, devops: { code: { provider: 'gitlab', scope: gitlabScope,
        repository: { state: 'present', management: 'managed', defaultBranch: 'main', visibility: 'private' } },
        canonicalEnvironment: 'repository' }, environments: {} }));
    methods.length = 0;
    const next = await new PlanService().plan(project, 'repository');
    expect(next).toHaveProperty('error');
    expect(methods.every(method => method === 'GET')).toBe(true);
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'repository')!.platformBindings.repositoryVariableOwnership).toEqual(state);
  });

  it('blocks an already persisted managed-repository apply when another write becomes pending', async () => {
    const project = new ProjectRepository().create({ name: 'existing-plan-guard', defaultPlatform: 'unconfigured',
      gitRemoteUrl: `${gitlabScope}.git` });
    const desired = new SpecStore().replace(project, projectSpecSchema.parse({ version: 1, project: project.name,
      gitRemoteUrl: project.gitRemoteUrl, devops: { code: { provider: 'gitlab', scope: gitlabScope,
        repository: { state: 'present', management: 'managed', defaultBranch: 'main', visibility: 'private' } },
        canonicalEnvironment: 'repository' }, environments: {} }));
    const plan = await new PlanService().plan(project, 'repository');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ type: 'create', resource: { provider: 'gitlab' } });
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'repository')!;
    // Simulate an independently retained earlier attempt arriving after planning;
    // it must gate apply even though this saved plan's spec revision still matches.
    const retained = { version: 1, ciProvider: 'github-actions', repository: {
      provider: 'github', nativeId: '321', instanceScope: 'https://github.com',
      canonicalScope: `https://github.com/${githubScope}`, path: githubScope,
    }, variables: {}, pending: { operation: 'ci.repository-variable.sync', mode: 'create',
      ciProvider: 'github-actions', codeProvider: 'github', repositoryScope: githubScope,
      repositoryId: '321', instanceScope: 'https://github.com', canonicalScope: `https://github.com/${githubScope}`,
      variableName: 'HEALTH_ENABLED', desiredHash: createHash('sha256').update('true').digest('hex'),
      previous: null, ownershipHash: null } };
    new EnvironmentRepository().updatePlatformBindings(environment.id, { repositoryVariableOwnership: retained });
    methods.length = 0;
    const result = await executePlanApply(createToolContext(), { project, spec: desired.spec,
      specRevision: desired.revision, planId: plan.planRunId, confirmActions: [plan.actions[0].id] });
    expect(methods.every(method => method === 'GET')).toBe(true);
    expect(result).toMatchObject({ kind: 'blocked' });
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.repositoryVariableOwnership).toEqual(retained);
  });
});

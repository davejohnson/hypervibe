import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { PlanService } from '../plan.service.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { AppStoreConnectAdapter } from '../../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { isIosAction } from '../../services/appstore-plan.service.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import type { Project } from '../../entities/project.entity.js';
import type { Environment } from '../../entities/environment.entity.js';
import { buildBranchDeployWorkflow } from '../../services/github-ops.service.js';

let project: Project;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-plan-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  project = new ProjectRepository().create({ name: 'plan-test', defaultPlatform: 'railway' });
  new SpecStore().replace(project, {
    version: 1,
    project: project.name,
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: { web: { startCommand: 'npm start' } },
        envVars: { NODE_ENV: 'staging' },
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockObservingAdapter(observed: ObservedState, extra: Record<string, unknown> = {}) {
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
    success: true,
    adapter: {
      ...extra,
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {},
      verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('unused'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      observe: async () => observed,
    },
  });
}

describe('PlanService.plan', () => {
  it('errors when the project has no spec', async () => {
    const bare = new ProjectRepository().create({ name: 'no-spec' });
    const result = await new PlanService().plan(bare, 'staging');
    expect(result).toMatchObject({ error: expect.stringContaining('hv_spec_set') });
  });

  it('errors when the environment is not in the spec', async () => {
    const result = await new PlanService().plan(project, 'production');
    expect(result).toMatchObject({ error: expect.stringContaining('production') });
  });

  it('plans GitHub collaboration only on the canonical environment and blocks missing GitHub connection', async () => {
    const projectRepo = new ProjectRepository();
    project = projectRepo.update(project.id, { gitRemoteUrl: 'https://github.com/davejohnson/plan-test' })!;
    const railway = new ConnectionRepository().create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-token' }),
    });
    new ConnectionRepository().updateStatus(railway.id, 'verified');
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      collaboration: {},
      environments: {
        staging: { hosting: { provider: 'railway' }, services: { web: {} } },
        production: { hosting: { provider: 'railway' }, services: { web: {} } },
      },
    });

    const production = await new PlanService().plan(project, 'production');
    expect(production).not.toHaveProperty('error');
    const productionPlan = production as Exclude<typeof production, { error: string }>;
    expect(productionPlan.actions.find((action) => action.id === 'repo:github-collaboration')).toMatchObject({
      type: 'update',
      resource: { kind: 'repo', name: 'davejohnson/plan-test', provider: 'github' },
    });
    expect(productionPlan.blocked).toEqual([
      expect.objectContaining({ provider: 'github', scope: 'davejohnson/plan-test' }),
    ]);
    expect(productionPlan.blocked[0]?.reason).toContain('https://github.com/settings/tokens');

    const staging = await new PlanService().plan(project, 'staging');
    expect(staging).not.toHaveProperty('error');
    const stagingPlan = staging as Exclude<typeof staging, { error: string }>;
    expect(stagingPlan.actions.find((action) => action.id === 'repo:github-collaboration')).toBeUndefined();
  });

  it('produces a verified plan from observed state and persists the plan run', async () => {
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'node old.js' },
        envVarKeys: ['NODE_ENV'],
        envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'staging');
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(true);
    const web = plan.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.diff).toContainEqual({ field: 'startCommand', from: 'node old.js', to: 'npm start' });

    const run = new RunRepository().findById(plan.planRunId)!;
    expect(run.type).toBe('plan');
    const doc = run.plan as Record<string, unknown>;
    expect(doc.kind).toBe('hv_plan');
    expect(doc.specRevision).toBe(plan.specRevision);
    expect(doc.observedFingerprint).toBeTruthy();
  });

  it('falls back to unverified local diff when the provider has no adapter', async () => {
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(false);
    expect(plan.actions.every((a) => !a.verified)).toBe(true);
    // Untracked environment surfaced as a create action and a local record was made.
    expect(plan.actions.find((a) => a.id === 'environment:staging')?.type).toBe('create');
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'staging')).toBeTruthy();
  });

  it('reuses a shared Railway project binding when planning a new environment', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          database: { provider: 'railway', engine: 'postgres' },
          envVars: { NODE_ENV: 'production' },
        },
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          database: { provider: 'railway', engine: 'postgres' },
          envVars: { NODE_ENV: 'staging' },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-canonical',
        environmentId: 'rail-env-prod',
        services: { web: { serviceId: 'svc-prod' } },
      },
    });
    const observedBindings: Record<string, unknown>[] = [];
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedBuilders: ['nixpacks'],
          supportedComponents: ['postgres'],
          supportsAutoWiring: true,
          supportsHealthChecks: true,
          supportsCronSchedule: true,
          supportsReleaseCommand: false,
          supportsMultiEnvironment: true,
          managedTls: true,
          supportsObserve: true,
        },
        connect: async () => {},
        verify: async () => ({ success: true }),
        ensureProject: async () => ({ success: true, message: 'ok' }),
        ensureComponent: async () => { throw new Error('unused'); },
        deploy: async () => { throw new Error('unused'); },
        setEnvVars: async () => ({ success: true, message: 'ok' }),
        observe: async (environment: Environment) => {
          observedBindings.push(environment.platformBindings);
          return {
            provider: 'railway',
            observedAt: new Date().toISOString(),
            projectExists: true,
            projectId: 'rail-project-canonical',
            services: [],
            databases: [],
            partial: false,
            warnings: ['Could not resolve Railway environment for "staging"'],
          };
        },
      },
    });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions.find((a) => a.id === 'project:railway')).toBeUndefined();
    expect(plan.actions.find((a) => a.id === 'environment:staging')?.type).toBe('create');
    expect(plan.actions.find((a) => a.id === 'service:web')?.type).toBe('create');
    expect(plan.actions.find((a) => a.id === 'database:railway')?.type).toBe('create');
    expect(observedBindings[0]).toMatchObject({
      provider: 'railway',
      projectId: 'rail-project-canonical',
    });
    expect(plan.warnings).toContain(
      'Reusing Railway project binding rail-project-canonical from environment "production" for environment "staging".'
    );
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'staging')?.platformBindings).toMatchObject({
      provider: 'railway',
      projectId: 'rail-project-canonical',
    });
  });

  it('does not guess the shared provider project when sibling environment bindings disagree', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'staging' },
        },
      },
    });
    const envRepo = new EnvironmentRepository();
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rail-project-1' },
    });
    envRepo.create({
      projectId: project.id,
      name: 'preview',
      platformBindings: { provider: 'railway', projectId: 'rail-project-2' },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'unused' });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).toMatchObject({
      error: expect.stringContaining('multiple existing railway project bindings'),
    });
  });

  it('repairs an empty stale Railway project binding from the shared project binding', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'production' },
        },
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'staging' },
        },
      },
    });
    const envRepo = new EnvironmentRepository();
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rail-project-canonical' },
    });
    const staging = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { projectId: 'rail-project-stale' },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions.find((a) => a.id === 'project:railway')).toBeUndefined();
    expect(plan.warnings).toContain(
      'Replaced stale Railway project binding rail-project-stale with shared project binding rail-project-canonical from environment "production" for environment "staging".'
    );
    expect(envRepo.findById(staging.id)?.platformBindings).toMatchObject({
      provider: 'railway',
      projectId: 'rail-project-canonical',
    });
  });

  it('refuses to repair a stale shared project binding when service ids are still attached', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'production' },
        },
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'staging' },
        },
      },
    });
    const envRepo = new EnvironmentRepository();
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rail-project-canonical' },
    });
    envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-stale',
        environmentId: 'rail-env-stale',
        services: { web: { serviceId: 'svc-stale' } },
      },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'unused' });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).toMatchObject({
      error: expect.stringContaining('will not guess because "staging" still has provider environment/service bindings'),
    });
  });

  it('reports blocked providers without verified connections', async () => {
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });
    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.blocked).toContainEqual(expect.objectContaining({ provider: 'railway' }));
  });

  it('requires a Cloudflare connection that matches the requested domain scope', () => {
    const connRepo = new ConnectionRepository();
    const other = connRepo.create({ provider: 'cloudflare', scope: 'other.com', credentialsEncrypted: 'x' });
    connRepo.updateStatus(other.id, 'verified');

    const service = new PlanService();
    const blocked = service.preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'apreskeys.com',
      email: { enabled: false },
      envVars: {},
    });
    expect(blocked).toContainEqual(expect.objectContaining({
      provider: 'cloudflare',
      reason: expect.stringContaining('apreskeys.com'),
    }));

    const matching = connRepo.create({ provider: 'cloudflare', scope: 'apreskeys.com', credentialsEncrypted: 'x' });
    connRepo.updateStatus(matching.id, 'verified');
    const unblocked = service.preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'apreskeys.com',
      email: { enabled: false },
      envVars: {},
    });
    expect(unblocked.some((entry) => entry.provider === 'cloudflare')).toBe(false);
  });

  it('uses the parent Cloudflare zone scope for subdomain preflight', () => {
    const connRepo = new ConnectionRepository();
    const failedSubdomain = connRepo.create({ provider: 'cloudflare', scope: 'staging.apreskeys.com', credentialsEncrypted: 'x' });
    connRepo.updateStatus(failedSubdomain.id, 'failed');

    const service = new PlanService();
    const missing = service.preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'staging.apreskeys.com',
      email: { enabled: false },
      envVars: {},
    });
    expect(missing).toContainEqual(expect.objectContaining({
      provider: 'cloudflare',
      scope: 'apreskeys.com',
      reason: expect.stringContaining('apreskeys.com'),
    }));

    const parent = connRepo.create({ provider: 'cloudflare', scope: 'apreskeys.com', credentialsEncrypted: 'x' });
    connRepo.updateStatus(parent.id, 'verified');
    const unblocked = service.preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'staging.apreskeys.com',
      email: { enabled: false },
      envVars: {},
    });
    expect(unblocked.some((entry) => entry.provider === 'cloudflare')).toBe(false);
  });

  it('warns when observation fails for a tracked environment', async () => {
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1' },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(false);
    expect(plan.warnings.some((w) => w.includes('Cannot observe'))).toBe(true);
  });

  it('warns when the Railway GitHub App cannot access the branch-deploy repo', async () => {
    project = new ProjectRepository().update(project.id, { gitRemoteUrl: 'https://github.com/dave/seq-planner.git' })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
        },
      },
    });
    mockObservingAdapter(
      {
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      },
      { isGitHubRepoAccessible: async () => false }
    );

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.warnings.some((w) => w.includes("Railway's GitHub App cannot access dave/seq-planner"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('github.com/apps/railway-app'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('project member has connected GitHub'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('pending Railway GitHub App permission updates'))).toBe(true);
  });

  it('warns when branch strategy is set but the project has no GitHub remote', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
        },
      },
    });
    mockObservingAdapter(
      {
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      },
      { isGitHubRepoAccessible: async () => true }
    );

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.warnings.some((w) => w.includes('no GitHub remote'))).toBe(true);
  });

  it('uses spec gitRemoteUrl when the project record has no GitHub remote', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: 'git@github.com:dave/spec-backed.git',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
        },
      },
    });
    const isGitHubRepoAccessible = vi.fn(async () => true);
    mockObservingAdapter(
      {
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      },
      { isGitHubRepoAccessible }
    );

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(isGitHubRepoAccessible).toHaveBeenCalledWith('dave/spec-backed');
    expect(plan.warnings.some((w) => w.includes('no GitHub remote'))).toBe(false);
  });

  it('does not warn when the repo is accessible to Railway', async () => {
    project = new ProjectRepository().update(project.id, { gitRemoteUrl: 'git@github.com:dave/seq-planner.git' })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
        },
      },
    });
    mockObservingAdapter(
      {
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      },
      { isGitHubRepoAccessible: async () => true }
    );

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.warnings.some((w) => w.includes('GitHub App'))).toBe(false);
    expect(plan.warnings.some((w) => w.includes('no GitHub remote'))).toBe(false);
  });

  it('orders GitHub Actions deploy setup before domain attachment', async () => {
    project = new ProjectRepository().update(project.id, { gitRemoteUrl: 'git@github.com:dave/apreskeys.com.git' })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          domain: 'apreskeys.com',
          email: { enabled: false },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    const connRepo = new ConnectionRepository();
    const github = connRepo.create({
      provider: 'github',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gh-token', login: 'dave' }),
    });
    connRepo.updateStatus(github.id, 'verified');
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);

    const result = await new PlanService().plan(project, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const ids = plan.actions.map((action) => action.id);
    expect(ids.indexOf('ci:github-actions:production:deploy-branch')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('domain:apreskeys.com')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('ci:github-actions:production:deploy-branch')).toBeLessThan(ids.indexOf('domain:apreskeys.com'));
  });

  it('replans CI deploys when recorded image registry secrets are not available from current credentials', async () => {
    project = new ProjectRepository().update(project.id, { gitRemoteUrl: 'git@github.com:dave/apreskeys.com.git' })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          email: { enabled: false },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    const connRepo = new ConnectionRepository();
    const github = connRepo.create({
      provider: 'github',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gh-token', login: 'dave' }),
    });
    connRepo.updateStatus(github.id, 'verified');
    const railway = connRepo.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-token' }),
    });
    connRepo.updateStatus(railway.id, 'verified');

    const workflow = buildBranchDeployWorkflow('railway', {
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rp-1',
      providerEnvironmentId: 'rail-env-1',
      providerServiceIds: ['svc-1'],
    }, { includeStep: false });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
        ci: {
          deployBranch: {
            [workflow.path]: {
              contentHash: 'old',
              syncedSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
            },
          },
        },
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web',
        externalId: 'svc-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);

    const result = await new PlanService().plan(project, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const ci = plan.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch')!;
    expect(ci.type).toBe('update');
    expect(ci.reason).toContain('provider secrets need syncing');
    expect(ci.metadata?.missingProviderSecrets).toEqual(['IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(plan.warnings).toContainEqual(expect.stringContaining('apiToken needs repo + workflow'));
    expect(plan.warnings).toContainEqual(expect.stringContaining('packageReadToken needs read:packages'));
  });

  it('never blocks the CI workflow sync on confirm-gated previous-provider destroys', async () => {
    project = new ProjectRepository().update(project.id, { gitRemoteUrl: 'git@github.com:dave/apreskeys.com.git' })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          email: { enabled: false },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    const connRepo = new ConnectionRepository();
    const github = connRepo.create({
      provider: 'github',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gh-token', login: 'dave' }),
    });
    connRepo.updateStatus(github.id, 'verified');
    const railway = connRepo.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-token' }),
    });
    connRepo.updateStatus(railway.id, 'verified');
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
        previousHosting: {
          provider: 'cloudrun',
          projectId: 'gcp-1',
          services: { web: { serviceId: 'cr-web' }, cron: { serviceId: 'cr-cron' } },
        },
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web',
        externalId: 'svc-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);

    const result = await new PlanService().plan(project, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const destroyIds = plan.actions
      .filter((action) => action.metadata?.operation === 'previousHostingDestroy')
      .map((action) => action.id);
    expect(destroyIds.sort()).toEqual(['service:cron:previous-destroy', 'service:web:previous-destroy']);
    const ci = plan.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch')!;
    expect(ci.type).not.toBe('noop');
    for (const id of destroyIds) {
      expect(ci.dependsOn ?? []).not.toContain(id);
    }
  });

  it('replans CI deploys when a previously synced GitHub Actions secret value is stale', async () => {
    const ciProject = new ProjectRepository().create({
      name: 'ci-stale-secret-app',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/dave/ci-stale-secret-app',
    });
    new SpecStore().replace(ciProject, {
      version: 1,
      project: ciProject.name,
      gitRemoteUrl: ciProject.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          email: { enabled: false },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    const connRepo = new ConnectionRepository();
    const github = connRepo.create({
      provider: 'github',
      credentialsEncrypted: getSecretStore().encryptObject({
        apiToken: 'gh-token',
        login: 'dave',
        packageReadToken: 'new-package-token',
      }),
    });
    connRepo.updateStatus(github.id, 'verified');
    const railway = connRepo.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-token' }),
    });
    connRepo.updateStatus(railway.id, 'verified');

    const workflow = buildBranchDeployWorkflow('railway', {
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rp-1',
      providerEnvironmentId: 'rail-env-1',
      providerServiceIds: ['svc-1'],
    }, { includeStep: false });
    new EnvironmentRepository().create({
      projectId: ciProject.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
        ci: {
          deployBranch: {
            [workflow.path]: {
              contentHash: sha256(workflow.content),
              syncedSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
              syncedSecretHashes: {
                RAILWAY_API_TOKEN: sha256('railway-token'),
                IMAGE_REGISTRY_USERNAME: sha256('dave'),
                IMAGE_REGISTRY_TOKEN: sha256('old-package-token'),
              },
            },
          },
        },
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web',
        externalId: 'svc-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);

    const result = await new PlanService().plan(ciProject, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const ci = plan.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch')!;
    expect(ci.type).toBe('update');
    expect(ci.reason).toContain('provider secrets need syncing');
    expect(ci.metadata?.missingProviderSecrets).toBeUndefined();
    expect(ci.metadata?.staleProviderSecrets).toEqual(['IMAGE_REGISTRY_TOKEN']);
  });

  it('uses repo-scoped GitHub package credentials when planning CI deploy secrets', async () => {
    const ciProject = new ProjectRepository().create({
      name: 'ci-scoped-secret-app',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/dave/ci-scoped-secret-app',
    });
    new SpecStore().replace(ciProject, {
      version: 1,
      project: ciProject.name,
      gitRemoteUrl: ciProject.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          email: { enabled: false },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    const connRepo = new ConnectionRepository();
    const github = connRepo.create({
      provider: 'github',
      scope: 'dave/ci-scoped-secret-app',
      credentialsEncrypted: getSecretStore().encryptObject({
        apiToken: 'gh-token',
        login: 'dave',
        packageReadToken: 'scoped-package-token',
      }),
    });
    connRepo.updateStatus(github.id, 'verified');
    const railway = connRepo.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-token' }),
    });
    connRepo.updateStatus(railway.id, 'verified');

    const workflow = buildBranchDeployWorkflow('railway', {
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rp-1',
      providerEnvironmentId: 'rail-env-1',
      providerServiceIds: ['svc-1'],
    }, { includeStep: false });
    new EnvironmentRepository().create({
      projectId: ciProject.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
        ci: {
          deployBranch: {
            [workflow.path]: {
              contentHash: sha256(workflow.content),
              syncedSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
              syncedSecretHashes: {
                RAILWAY_API_TOKEN: sha256('railway-token'),
                IMAGE_REGISTRY_USERNAME: sha256('dave'),
                IMAGE_REGISTRY_TOKEN: sha256('scoped-package-token'),
              },
            },
          },
        },
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web',
        externalId: 'svc-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);

    const result = await new PlanService().plan(ciProject, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const ci = plan.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch')!;
    expect(ci.type).toBe('noop');
    expect(ci.metadata?.missingProviderSecrets).toBeUndefined();
    expect(ci.metadata?.staleProviderSecrets).toBeUndefined();
  });

  it('falls back to a verified global GitHub package credential when a repo-scoped connection is unverified', async () => {
    const ciProject = new ProjectRepository().create({
      name: 'ci-shadowed-secret-app',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/dave/ci-shadowed-secret-app',
    });
    new SpecStore().replace(ciProject, {
      version: 1,
      project: ciProject.name,
      gitRemoteUrl: ciProject.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          email: { enabled: false },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    const connRepo = new ConnectionRepository();
    const globalGithub = connRepo.create({
      provider: 'github',
      credentialsEncrypted: getSecretStore().encryptObject({
        apiToken: 'global-gh-token',
        login: 'dave',
        packageReadToken: 'global-package-token',
      }),
    });
    connRepo.updateStatus(globalGithub.id, 'verified');
    connRepo.create({
      provider: 'github',
      scope: 'dave/ci-shadowed-secret-app',
      credentialsEncrypted: getSecretStore().encryptObject({
        apiToken: 'bad-scoped-token',
        login: 'dave',
      }),
    });
    const railway = connRepo.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-token' }),
    });
    connRepo.updateStatus(railway.id, 'verified');

    const workflow = buildBranchDeployWorkflow('railway', {
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rp-1',
      providerEnvironmentId: 'rail-env-1',
      providerServiceIds: ['svc-1'],
    }, { includeStep: false });
    new EnvironmentRepository().create({
      projectId: ciProject.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
        ci: {
          deployBranch: {
            [workflow.path]: {
              contentHash: sha256(workflow.content),
              syncedSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
              syncedSecretHashes: {
                RAILWAY_API_TOKEN: sha256('railway-token'),
                IMAGE_REGISTRY_USERNAME: sha256('dave'),
                IMAGE_REGISTRY_TOKEN: sha256('global-package-token'),
              },
            },
          },
        },
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web',
        externalId: 'svc-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);

    const result = await new PlanService().plan(ciProject, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const ci = plan.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch')!;
    expect(ci.type).toBe('noop');
    expect(ci.metadata?.missingProviderSecrets).toBeUndefined();
    expect(ci.metadata?.staleProviderSecrets).toBeUndefined();
  });

  describe('plan options (serviceFilter / envVarOverrides)', () => {
    function seedTwoServiceSpec() {
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' }, worker: { workloadKind: 'worker' } },
            domain: 'example.com',
            envVars: { NODE_ENV: 'staging' },
          },
        },
      });
    }

    it('rejects a filter naming services not in the spec', async () => {
      seedTwoServiceSpec();
      const result = await new PlanService().plan(project, 'staging', { serviceFilter: ['web', 'ghost'] });
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('ghost');
    });

    it('filters to the subset, drops domain actions, never destroys, and records overrides', async () => {
      seedTwoServiceSpec();
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

      const result = await new PlanService().plan(project, 'staging', {
        serviceFilter: ['web'],
        envVarOverrides: { DEBUG: '1' },
      });
      expect(result).not.toHaveProperty('error');
      const plan = result as Exclude<typeof result, { error: string }>;

      const kinds = plan.actions.map((action) => `${action.resource.kind}:${action.resource.name}`);
      expect(kinds).toContain('service:web');
      expect(kinds).not.toContain('service:worker');
      expect(plan.actions.some((action) => action.resource.kind === 'domain')).toBe(false);
      expect(plan.actions.some((action) => action.type === 'destroy')).toBe(false);
      expect(plan.warnings.some((warning) => warning.includes('Partial plan'))).toBe(true);

      const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
      const overrides = doc.overrides as Record<string, unknown>;
      expect(overrides.services).toEqual(['web']);
      expect(overrides.envVarKeys).toEqual(['DEBUG']);
      // Values are encrypted, never plaintext in the stored plan document.
      expect(typeof overrides.envVarsEncrypted).toBe('string');
      expect(JSON.stringify(doc)).not.toContain('"DEBUG":"1"');
      expect(getSecretStore().decryptObject(overrides.envVarsEncrypted as string)).toEqual({ DEBUG: '1' });
    });

    it('reflects envVar overrides in the diff without touching the spec', async () => {
      new EnvironmentRepository().create({
        projectId: project.id,
        name: 'staging',
        platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
      });
      new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
      mockObservingAdapter({
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: true,
        projectId: 'rp-1',
        environmentId: 're-1',
        services: [{
          name: 'web',
          externalId: 's-1',
          workloadKind: 'web',
          customDomains: [],
          config: { startCommand: 'npm start' },
          envVarKeys: ['NODE_ENV'],
          envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        }],
        databases: [],
        partial: false,
        warnings: [],
      });

      const result = await new PlanService().plan(project, 'staging', { envVarOverrides: { DEBUG: '1' } });
      const plan = result as Exclude<typeof result, { error: string }>;
      const web = plan.actions.find((action) => action.id === 'service:web')!;
      expect(web.type).toBe('update');
      expect(web.diff?.some((entry) => entry.field === 'env:DEBUG')).toBe(true);

      // Spec on disk is untouched by the override.
      const spec = new SpecStore().get(project)!.spec;
      expect(spec.environments.staging.envVars).toEqual({ NODE_ENV: 'staging' });
    });

    it('loads app runtime vars from a deploy env file without storing plaintext or provider tokens', async () => {
      const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-env-file-')), '.env');
      writeFileSync(envFile, [
        'SENDGRID_API_KEY=SG.local-secret',
        'NODE_ENV=from-dotenv',
        'WEBHOOK_URL=http://localhost:4040/hook',
        'LOCAL_DEBUG_FLAG=true',
        'RAILWAY_API_TOKEN=railway-provider-token',
        'NPM_TOKEN=npm-provider-token',
        '',
      ].join('\n'));
      new EnvironmentRepository().create({
        projectId: project.id,
        name: 'staging',
        platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
      });
      new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
      mockObservingAdapter({
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: true,
        projectId: 'rp-1',
        environmentId: 're-1',
        services: [{
          name: 'web',
          externalId: 's-1',
          workloadKind: 'web',
          customDomains: [],
          config: { startCommand: 'npm start' },
          envVarKeys: ['NODE_ENV'],
          envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        }],
        databases: [],
        partial: false,
        warnings: [],
      });

      const result = await new PlanService().plan(project, 'staging', { envFile });
      const plan = result as Exclude<typeof result, { error: string }>;
      const web = plan.actions.find((action) => action.id === 'service:web')!;

      expect(web.type).toBe('update');
      expect(web.diff?.some((entry) => entry.field === 'env:SENDGRID_API_KEY')).toBe(true);
      expect(web.diff?.some((entry) => entry.field === 'env:RAILWAY_API_TOKEN')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:NPM_TOKEN')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:NODE_ENV')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:LOCAL_DEBUG_FLAG')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:WEBHOOK_URL')).toBe(false);
      expect(plan.warnings).toContainEqual(expect.stringContaining(`Loaded 1 deploy env var(s) from ${envFile}`));
      expect(plan.warnings).toContainEqual(expect.stringContaining('Ignored 2 .env key(s) that do not match envFile policy: LOCAL_DEBUG_FLAG, NODE_ENV'));
      expect(plan.warnings).toContainEqual(expect.stringContaining('Skipped 1 .env key(s) with local-only values in runtime mode: WEBHOOK_URL'));
      expect(plan.warnings).toContainEqual(expect.stringContaining('Skipped 2 provider-only .env key(s): NPM_TOKEN, RAILWAY_API_TOKEN'));

      const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
      const overrides = doc.overrides as Record<string, unknown>;
      expect(overrides.envFilePath).toBe(envFile);
      expect(overrides.envFileKeys).toEqual(['SENDGRID_API_KEY']);
      expect(JSON.stringify(doc)).not.toContain('SG.local-secret');
      expect(JSON.stringify(doc)).not.toContain('railway-provider-token');
      expect(JSON.stringify(doc)).not.toContain('npm-provider-token');
      expect(JSON.stringify(doc)).not.toContain('localhost:4040');
      expect(getSecretStore().decryptObject(overrides.envFileVarsEncrypted as string)).toEqual({
        SENDGRID_API_KEY: 'SG.local-secret',
      });
    });

    it('creates the environment-specific env file from base .env before loading deploy vars', async () => {
      const oldCwd = process.cwd();
      const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-env-fallback-plan-'));
      mkdirSync(path.join(root, '.git'));
      mkdirSync(path.join(root, 'app'));
      const realRoot = realpathSync(root);
      const baseEnvFile = path.join(realRoot, '.env');
      const stagingEnvFile = path.join(realRoot, '.env.staging');
      writeFileSync(baseEnvFile, 'SENDGRID_API_KEY=SG.base\n');
      new EnvironmentRepository().create({
        projectId: project.id,
        name: 'staging',
        platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
      });
      new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
      mockObservingAdapter({
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: true,
        projectId: 'rp-1',
        environmentId: 're-1',
        services: [{
          name: 'web',
          externalId: 's-1',
          workloadKind: 'web',
          customDomains: [],
          config: { startCommand: 'npm start' },
          envVarKeys: ['NODE_ENV'],
          envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        }],
        databases: [],
        partial: false,
        warnings: [],
      });

      try {
        process.chdir(path.join(root, 'app'));
        const result = await new PlanService().plan(project, 'staging');
        const plan = result as Exclude<typeof result, { error: string }>;

        expect(plan.warnings).toContainEqual(expect.stringContaining(`Created environment-specific deploy env file at ${stagingEnvFile}`));
        expect(plan.warnings).toContainEqual(expect.stringContaining(`from base ${baseEnvFile}`));
        expect(existsSync(stagingEnvFile)).toBe(true);
        const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
        const overrides = doc.overrides as Record<string, unknown>;
        expect(overrides.envFilePath).toBe(stagingEnvFile);
        expect(overrides.envFileKeys).toEqual(['SENDGRID_API_KEY']);
      } finally {
        process.chdir(oldCwd);
      }
    });

    it('uses spec envFile policy to include custom runtime keys and exclude unwanted keys', async () => {
      const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-env-policy-')), '.env');
      writeFileSync(envFile, [
        'CUSTOM_WORKER_FLAG=true',
        'LOCAL_DEBUG_FLAG=true',
        'SESSION_SECRET=session-runtime',
        '',
      ].join('\n'));
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            envVars: { NODE_ENV: 'staging' },
            envFile: {
              mode: 'explicit',
              include: ['CUSTOM_WORKER_FLAG', 'SESSION_SECRET'],
              exclude: ['SESSION_SECRET'],
            },
          },
        },
      });
      new EnvironmentRepository().create({
        projectId: project.id,
        name: 'staging',
        platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
      });
      new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
      mockObservingAdapter({
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: true,
        projectId: 'rp-1',
        environmentId: 're-1',
        services: [{
          name: 'web',
          externalId: 's-1',
          workloadKind: 'web',
          customDomains: [],
          config: { startCommand: 'npm start' },
          envVarKeys: ['NODE_ENV'],
          envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        }],
        databases: [],
        partial: false,
        warnings: [],
      });

      const result = await new PlanService().plan(project, 'staging', { envFile });
      const plan = result as Exclude<typeof result, { error: string }>;
      const web = plan.actions.find((action) => action.id === 'service:web')!;

      expect(web.diff?.some((entry) => entry.field === 'env:CUSTOM_WORKER_FLAG')).toBe(true);
      expect(web.diff?.some((entry) => entry.field === 'env:SESSION_SECRET')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:LOCAL_DEBUG_FLAG')).toBe(false);
      expect(plan.warnings).toContainEqual(expect.stringContaining('Excluded 1 .env key(s) by envFile.exclude: SESSION_SECRET'));
      expect(plan.warnings).toContainEqual(expect.stringContaining('Ignored 1 .env key(s) that do not match envFile policy: LOCAL_DEBUG_FLAG'));
      const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
      const overrides = doc.overrides as Record<string, unknown>;
      expect(overrides.envFileKeys).toEqual(['CUSTOM_WORKER_FLAG']);
      expect(getSecretStore().decryptObject(overrides.envFileVarsEncrypted as string)).toEqual({
        CUSTOM_WORKER_FLAG: 'true',
      });
    });

    it('does not let deploy env files override managed database env vars', async () => {
      const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-env-db-')), '.env');
      writeFileSync(envFile, [
        'DATABASE_URL=postgres://local-dev-db',
        'SENDGRID_API_KEY=SG.local-secret',
        '',
      ].join('\n'));
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            database: { provider: 'railway', engine: 'postgres' },
            envVars: { NODE_ENV: 'staging' },
          },
        },
      });
      const environment = new EnvironmentRepository().create({
        projectId: project.id,
        name: 'staging',
        platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
      });
      new ComponentRepository().create({
        environmentId: environment.id,
        type: 'postgres',
        bindings: { provider: 'railway', connectionString: 'postgres://managed-db' },
      });
      new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
      mockObservingAdapter({
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: true,
        projectId: 'rp-1',
        environmentId: 're-1',
        services: [{
          name: 'web',
          externalId: 's-1',
          workloadKind: 'web',
          customDomains: [],
          config: { startCommand: 'npm start' },
          envVarKeys: ['NODE_ENV'],
          envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        }],
        databases: [],
        partial: false,
        warnings: [],
      });

      const result = await new PlanService().plan(project, 'staging', { envFile });
      const plan = result as Exclude<typeof result, { error: string }>;
      const web = plan.actions.find((action) => action.id === 'service:web')!;

      expect(web.diff?.some((entry) => entry.field === 'env:DATABASE_URL')).toBe(true);
      expect(plan.warnings).toContainEqual(expect.stringContaining('Ignored 1 .env key(s) because Hypervibe manages them from infrastructure: DATABASE_URL'));
      const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
      const overrides = doc.overrides as Record<string, unknown>;
      expect(overrides.envFileKeys).toEqual(['SENDGRID_API_KEY']);
      expect(getSecretStore().decryptObject(overrides.envFileVarsEncrypted as string)).toEqual({
        SENDGRID_API_KEY: 'SG.local-secret',
      });
    });
  });

  describe('iOS planning', () => {
    const BUNDLE = 'com.example.app';

    function replaceSpecWithIos() {
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            envVars: { NODE_ENV: 'staging' },
            ios: {
              bundleId: BUNDLE,
              capabilities: ['PUSH_NOTIFICATIONS'],
              testflight: { groups: { Beta: { testers: ['a@example.com'] } } },
            },
          },
        },
      });
    }

    function seedAppStoreConnectConnection() {
      const repo = new ConnectionRepository();
      const connection = repo.create({
        provider: 'appstoreconnect',
        credentialsEncrypted: getSecretStore().encryptObject({ keyId: 'K1', issuerId: 'I1', privateKey: 'pk' }),
      });
      repo.updateStatus(connection.id, 'verified');
    }

    it('appends iOS actions after all non-iOS actions when the spec declares ios', async () => {
      replaceSpecWithIos();
      seedAppStoreConnectConnection();
      new EnvironmentRepository().create({
        projectId: project.id,
        name: 'staging',
        platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
      });
      new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
      mockObservingAdapter({
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: true,
        projectId: 'rp-1',
        environmentId: 're-1',
        services: [{
          name: 'web',
          externalId: 's-1',
          workloadKind: 'web',
          customDomains: [],
          config: { startCommand: 'node old.js' },
          envVarKeys: ['NODE_ENV'],
          envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        }],
        databases: [],
        partial: false,
        warnings: [],
      });
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier').mockResolvedValue(null);
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(null);
      vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue([]);
      vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaTesters').mockResolvedValue([]);

      const result = await new PlanService().plan(project, 'staging');
      expect(result).not.toHaveProperty('error');
      const plan = result as Exclude<typeof result, { error: string }>;

      const ids = plan.actions.map((action) => action.id);
      expect(ids).toEqual(expect.arrayContaining([
        `ios:bundle-id:${BUNDLE}`,
        `ios:capabilities:${BUNDLE}`,
        `ios:app:${BUNDLE}`,
        'ios:group:Beta',
        'ios:testers:Beta',
      ]));

      // iOS actions are appended last, after every non-iOS action.
      const iosIndexes = plan.actions.flatMap((action, index) => (isIosAction(action) ? [index] : []));
      const nonIosIndexes = plan.actions.flatMap((action, index) => (isIosAction(action) ? [] : [index]));
      expect(iosIndexes.length).toBeGreaterThan(0);
      expect(nonIosIndexes.length).toBeGreaterThan(0);
      expect(Math.min(...iosIndexes)).toBeGreaterThan(Math.max(...nonIosIndexes));

      // Nothing exists Apple-side, so the chain is verified creates/updates.
      expect(plan.actions.find((action) => action.id === `ios:bundle-id:${BUNDLE}`)).toMatchObject({ type: 'create', verified: true });
      expect(plan.warnings.some((warning) => warning.includes('iOS'))).toBe(false);
    });

    it('plans no iOS actions when the spec has no ios section', async () => {
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });
      const observe = vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier');

      const result = await new PlanService().plan(project, 'staging');
      const plan = result as Exclude<typeof result, { error: string }>;
      expect(plan.actions.some(isIosAction)).toBe(false);
      expect(plan.actions.some((action) => action.id.startsWith('ios:'))).toBe(false);
      expect(observe).not.toHaveBeenCalled();
    });

    it('merges a Cannot-plan-iOS warning and plans zero iOS actions without an appstoreconnect connection', async () => {
      replaceSpecWithIos();
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

      const result = await new PlanService().plan(project, 'staging');
      const plan = result as Exclude<typeof result, { error: string }>;
      expect(plan.actions.some(isIosAction)).toBe(false);
      expect(plan.warnings.some((warning) => warning.includes('Cannot plan iOS') && warning.includes(BUNDLE))).toBe(true);
    });
  });

  it('clears blocked when a verified connection exists', async () => {
    const connRepo = new ConnectionRepository();
    const created = connRepo.create({ provider: 'railway', credentialsEncrypted: 'x' });
    connRepo.updateStatus(created.id, 'verified');
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'mock' });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.blocked).toEqual([]);
  });
});

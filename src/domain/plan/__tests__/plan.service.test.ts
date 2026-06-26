import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { PlanService } from '../plan.service.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import type { Project } from '../../entities/project.entity.js';
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
      serviceNames: ['web'],
      providerProjectId: 'rp-1',
      providerEnvironmentId: 'rail-env-1',
      providerServiceIds: ['svc-1'],
      providerServiceArns: [],
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
      serviceNames: ['web'],
      providerProjectId: 'rp-1',
      providerEnvironmentId: 'rail-env-1',
      providerServiceIds: ['svc-1'],
      providerServiceArns: [],
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
      serviceNames: ['web'],
      providerProjectId: 'rp-1',
      providerEnvironmentId: 'rail-env-1',
      providerServiceIds: ['svc-1'],
      providerServiceArns: [],
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

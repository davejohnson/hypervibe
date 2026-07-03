import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { parseToolEnvelope } from './tool-result.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { AppStoreConnectAdapter } from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { hashEnvValue, type ObservedState } from '../../domain/ports/observe.port.js';
import { buildBranchDeployWorkflow, resolveBranchDeployTargets } from '../../domain/services/github-ops.service.js';
import { bootstrapActionResultFromSummary } from '../core.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-core-tools-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const { createServer } = await import('../../server.js');
  const server = createServer();
  const client = new Client({ name: 'core-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const SPEC = {
  project: 'core-spec-app',
  environments: {
    staging: {
      hosting: { provider: 'railway' },
      services: { web: { startCommand: 'npm start' } },
      envVars: { NODE_ENV: 'staging' },
    },
  },
};

describe('bootstrap action receipt mapping', () => {
  it('fails domain actions when bootstrap records domain attachment or DNS errors', () => {
    const result = bootstrapActionResultFromSummary(
      {
        id: 'domain:apreskeys.com',
        resource: { kind: 'domain', name: 'apreskeys.com', provider: 'railway' },
      },
      {
        success: true,
        summary: {
          customDomainAttached: false,
          customDomainError: 'Problem processing request',
          domainDnsConfigured: false,
          domainDnsError: 'No Cloudflare connection available for apreskeys.com',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Problem processing request');
    expect(result.error).toContain('No Cloudflare connection available for apreskeys.com');
  });

  it('surfaces provider-specific bootstrap errors instead of generic bootstrap failed', () => {
    const result = bootstrapActionResultFromSummary(
      {
        id: 'service:web',
        resource: { kind: 'service', name: 'web', provider: 'railway' },
      },
      {
        success: false,
        summary: {
          sendgridApiKeySyncError: 'SendGrid API key is valid but cannot complete setupEmail. Missing domain-auth scopes.',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing domain-auth scopes');
    expect(result.error).not.toBe('bootstrap failed');
  });

  it('returns CI-pending bootstrap metadata on successful service actions', () => {
    const result = bootstrapActionResultFromSummary(
      {
        id: 'service:web',
        resource: { kind: 'service', name: 'web', provider: 'railway' },
      },
      {
        success: true,
        summary: {
          deploymentMode: 'provision',
          appDeploymentPending: true,
          appDeployment: { status: 'pending_ci' },
          deploySource: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      deploymentMode: 'provision',
      appDeploymentPending: true,
      appDeployment: { status: 'pending_ci' },
      deploySource: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    });
  });
});

describe('hv_spec_set / hv_spec_get', () => {
  it('creates a project, stores the spec, and bumps revisions on merge', async () => {
    const t = await makeClient();
    const set = await t.call('hv_spec_set', { spec: SPEC });
    expect(set.ok).toBe(true);
    expect(set.data.revision).toBe(1);
    expect(set.next).toContain('hv_plan');

    const merge = await t.call('hv_spec_set', {
      project: 'core-spec-app',
      spec: { environments: { staging: { services: { worker: { workloadKind: 'worker' } } } } },
    });
    expect(merge.data.revision).toBe(2);

    const get = await t.call('hv_spec_get', { project: 'core-spec-app' });
    expect(get.ok).toBe(true);
    expect(get.data.environments.staging.services).toEqual(['web', 'worker']);
    await t.close();
  });

  it('persists top-level gitRemoteUrl into project metadata', async () => {
    const t = await makeClient();
    const gitRemoteUrl = 'git@github.com:davejohnson/apreskeys.com.git';
    const set = await t.call('hv_spec_set', {
      spec: {
        ...SPEC,
        project: 'remote-spec-app',
        gitRemoteUrl,
      },
    });
    expect(set.ok).toBe(true);
    expect(set.data.project.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(new ProjectRepository().findByName('remote-spec-app')!.gitRemoteUrl).toBe(gitRemoteUrl);

    const get = await t.call('hv_spec_get', { project: 'remote-spec-app' });
    expect(get.ok).toBe(true);
    expect(get.data.project.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(get.data.projectMeta.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(get.data.spec.gitRemoteUrl).toBe(gitRemoteUrl);
    await t.close();
  });

  it('syncs gitRemoteUrl from a merge patch into an existing project', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    const gitRemoteUrl = 'https://github.com/davejohnson/apreskeys.com.git';

    const merge = await t.call('hv_spec_set', {
      project: 'core-spec-app',
      spec: { gitRemoteUrl },
    });
    expect(merge.ok).toBe(true);
    expect(merge.data.project.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(new ProjectRepository().findByName('core-spec-app')!.gitRemoteUrl).toBe(gitRemoteUrl);
    await t.close();
  });

  it('rejects invalid specs with field-level details', async () => {
    const t = await makeClient();
    const bad = await t.call('hv_spec_set', {
      spec: {
        project: 'bad-app',
        environments: { staging: { hosting: { provider: 'railway' }, services: { job: { workloadKind: 'cron' } } } },
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('VALIDATION');
    expect(JSON.stringify(bad.error.details)).toContain('cronSchedule');
    await t.close();
  });

  it('rejects unknown hosting providers with the available list', async () => {
    const t = await makeClient();
    const bad = await t.call('hv_spec_set', {
      spec: {
        project: 'bad-provider-app',
        environments: { staging: { hosting: { provider: 'definitely-not-real' }, services: {} } },
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('VALIDATION');
    expect(bad.hint).toContain('railway');
    await t.close();
  });

  it('requires confirmation before switching branch deploys to provider-native integrations', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'native-switch-app',
        gitRemoteUrl: 'git@github.com:davejohnson/native-switch-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });

    const bad = await t.call('hv_spec_set', {
      project: 'native-switch-app',
      spec: {
        environments: {
          production: {
            deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
          },
        },
      },
    });

    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('CONFIRM_REQUIRED');
    expect(bad.error.details).toContainEqual(expect.objectContaining({
      environment: 'production',
      provider: 'railway',
    }));
    expect(bad.hint).toContain('Do not switch from trigger="ci" to trigger="native"');

    const get = await t.call('hv_spec_get', { project: 'native-switch-app' });
    expect(get.data.spec.environments.production.deploy.trigger).toBe('ci');
    await t.close();
  });

  it('allows provider-native branch deploys when explicitly confirmed', async () => {
    const t = await makeClient();
    const set = await t.call('hv_spec_set', {
      confirmNativeDeploy: true,
      spec: {
        project: 'native-confirmed-app',
        gitRemoteUrl: 'git@github.com:davejohnson/native-confirmed-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
          },
        },
      },
    });

    expect(set.ok).toBe(true);
    expect(set.data.spec.environments.production.deploy.trigger).toBe('native');
    expect(set.warnings).toContainEqual(expect.stringContaining('Railway native deploys require the Railway GitHub App'));
    await t.close();
  });

  it('returns required connection setup immediately from the desired spec', async () => {
    const t = await makeClient();
    const set = await t.call('hv_spec_set', {
      spec: {
        project: 'connection-check-app',
        gitRemoteUrl: 'git@github.com:davejohnson/connection-check-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'connection-check-app.com',
            domainRegistration: { provider: 'cloudflare' },
            email: { enabled: true },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    expect(set.ok).toBe(true);
    expect(set.data.connections.missing.map((entry: { provider: string }) => entry.provider).sort()).toEqual([
      'cloudflare',
      'github',
      'railway',
      'sendgrid',
    ]);
    expect(set.data.connections.missing.find((entry: { provider: string }) => entry.provider === 'cloudflare')).toMatchObject({
      scope: 'connection-check-app.com',
      hint: expect.stringContaining('connection-check-app.com'),
    });
    expect(set.hint).toContain('Hypervibe can store and verify the missing provider connections with hv_connect');
    expect(set.hint).toContain('Cloudflare Account API Token');
    expect(set.hint).toContain('https://dash.cloudflare.com/?to=/:account/api-tokens');
    expect(set.hint).toContain('Cloudflare User API Token');
    expect(set.hint).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(set.hint).toContain('Cloudflare Dashboard -> Manage Account -> Account API Tokens');
    expect(set.hint).toContain('My Profile -> API Tokens');
    expect(set.hint).toContain('Zone -> Zone Settings -> Read or Edit');
    expect(set.hint).toContain('Zone -> DNS -> Edit.');
    expect(set.hint).toContain('scope="connection-check-app.com"');
    expect(set.hint).toContain('classic personal access token');
    expect(set.hint).toContain('https://github.com/settings/tokens');
    expect(set.hint).toContain('Railway Account API token');
    expect(set.hint).toContain('https://railway.com/account/tokens');
    expect(set.hint).toContain('SendGrid API key (Restricted Access for least privilege');
    expect(set.hint).toContain('mail.send');
    expect(set.hint).toContain('credentialsRef="dotenv:/absolute/path/.env#KEY"');
    expect(set.next).toEqual(['hv_connect', 'hv_plan']);
    await t.close();
  });

  it('does not treat a verified Cloudflare connection for another zone as domain-ready', async () => {
    const repo = new ConnectionRepository();
    const otherZone = repo.create({
      provider: 'cloudflare',
      scope: 'other.com',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cf-token' }),
    });
    repo.updateStatus(otherZone.id, 'verified');

    const t = await makeClient();
    const set = await t.call('hv_spec_set', {
      spec: {
        project: 'wrong-zone-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'apreskeys.com',
          },
        },
      },
    });
    expect(set.ok).toBe(true);
    expect(set.data.connections.missing).toContainEqual(expect.objectContaining({
      provider: 'cloudflare',
      status: 'missing',
      scope: 'apreskeys.com',
    }));
    await t.close();
  });

  it('hydrates a local project from repo-backed desired state and sees teammate spec edits', async () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-team-spec-')));
    mkdirSync(path.join(repoDir, '.git'));
    mkdirSync(path.join(repoDir, '.hypervibe'));
    const specPath = path.join(repoDir, '.hypervibe', 'spec.json');
    const repoSpec = {
      version: 1,
      project: 'team-shared-app',
      gitRemoteUrl: 'git@github.com:davejohnson/team-shared-app.git',
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'production' },
        },
      },
    };
    writeFileSync(specPath, `${JSON.stringify(repoSpec, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(repoDir, '.hypervibe', 'bindings.json'), `${JSON.stringify({
      version: 1,
      project: 'team-shared-app',
      environments: {
        production: {
          platformBindings: {
            provider: 'railway',
            projectId: 'rp-shared',
            environmentId: 're-production',
            apiToken: 'should-not-hydrate',
            connectionString: 'postgres://user:secret@example.com/db',
            services: { web: { serviceId: 'svc-web', deployToken: 'should-not-hydrate' } },
          },
        },
      },
    }, null, 2)}\n`, 'utf8');

    let t: Awaited<ReturnType<typeof makeClient>> | null = null;
    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      process.chdir(repoDir);
      t = await makeClient();

      const get = await t.call('hv_spec_get', {});
      expect(get.ok).toBe(true);
      expect(get.data.project.name).toBe('team-shared-app');
      expect(get.data.project.gitRemoteUrl).toBe('git@github.com:davejohnson/team-shared-app.git');
      expect(get.data.specSource).toEqual({ kind: 'repo', path: specPath });
      const project = new ProjectRepository().findByName('team-shared-app')!;
      expect(project).toBeTruthy();
      expect(new EnvironmentRepository().findByProjectAndName(project.id, 'production')!.platformBindings).toMatchObject({
        provider: 'railway',
        projectId: 'rp-shared',
        environmentId: 're-production',
        services: { web: { serviceId: 'svc-web' } },
      });
      const hydratedBindings = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!.platformBindings as {
        apiToken?: string;
        connectionString?: string;
        services?: { web?: { deployToken?: string } };
      };
      expect(hydratedBindings.apiToken).toBeUndefined();
      expect(hydratedBindings.connectionString).toBeUndefined();
      expect(hydratedBindings.services?.web?.deployToken).toBeUndefined();

      const envRepo = new EnvironmentRepository();
      const hydratedEnvironment = envRepo.findByProjectAndName(project.id, 'production')!;
      envRepo.updatePlatformBindings(hydratedEnvironment.id, {
        ci: {
          deployBranch: {
            '.github/workflows/deploy-railway-production.yml': {
              contentHash: 'workflow-hash',
              syncedSecrets: ['IMAGE_REGISTRY_TOKEN'],
              syncedSecretHashes: { IMAGE_REGISTRY_TOKEN: 'local-secret-hash' },
            },
          },
        },
      });
      await t.close();
      t = await makeClient();
      await t.call('hv_spec_get', {});
      expect(
        new EnvironmentRepository()
          .findByProjectAndName(project.id, 'production')!
          .platformBindings
      ).toMatchObject({
        ci: {
          deployBranch: {
            '.github/workflows/deploy-railway-production.yml': {
              contentHash: 'workflow-hash',
              syncedSecrets: ['IMAGE_REGISTRY_TOKEN'],
              syncedSecretHashes: { IMAGE_REGISTRY_TOKEN: 'local-secret-hash' },
            },
          },
        },
      });

      writeFileSync(specPath, `${JSON.stringify({
        ...repoSpec,
        environments: {
          production: {
            ...repoSpec.environments.production,
            services: {
              ...repoSpec.environments.production.services,
              daily: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 8 * * *' },
            },
          },
        },
      }, null, 2)}\n`, 'utf8');

      const updated = await t.call('hv_spec_get', {});
      expect(updated.ok).toBe(true);
      expect(updated.data.revision).toBe(2);
      expect(updated.data.environments.production.services).toEqual(['web', 'daily']);
      expect(updated.data.spec.environments.production.services.daily).toMatchObject({
        workloadKind: 'cron',
        cronSchedule: '0 8 * * *',
      });
    } finally {
      if (t) await t.close();
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

describe('hv_plan / hv_status / hv_apply', () => {
  function sha256(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  function verifyConnection(provider: string, credentials: Record<string, unknown> = { apiToken: `${provider}-token` }) {
    const repo = new ConnectionRepository();
    const conn = repo.create({ provider, credentialsEncrypted: getSecretStore().encryptObject(credentials) });
    repo.updateStatus(conn.id, 'verified');
  }

  function verifyRailwayConnection() {
    verifyConnection('railway');
  }

  function mockObserved(observed: ObservedState | null) {
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue(
      observed
        ? {
          success: true,
          adapter: {
            name: 'railway',
            capabilities: {
              supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
              supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
              supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
              supportsObserve: true,
            },
            connect: async () => {}, verify: async () => ({ success: true }),
            ensureProject: async () => ({ success: true, message: 'ok' }),
            ensureComponent: async () => { throw new Error('unused'); },
            deploy: async () => { throw new Error('unused'); },
            setEnvVars: async () => ({ success: true, message: 'ok' }),
            observe: async () => observed,
          },
        }
        : { success: false, error: 'no adapter' }
    );
  }

  it('plans creates for a fresh environment and blocks without connections', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    mockObserved(null);

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });
    expect(plan.ok).toBe(true);
    expect(plan.data.verified).toBe(false);
    expect(plan.data.summary.create).toBeGreaterThan(0);
    expect(plan.data.blocked).toContainEqual(expect.objectContaining({ provider: 'railway' }));
    expect(plan.hint).toContain('hv_connect');
    await t.close();
  });

  it('plans Cloudflare domain registration from desired state as a confirm-gated action', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'domain-plan-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'apreskeys.com',
            domainRegistration: { provider: 'cloudflare', years: 1, autoRenew: false },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('cloudflare', { apiToken: 'cf-token', accountId: 'acct-1' });
    mockObserved(null);
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue(null);
    vi.spyOn(CloudflareAdapter.prototype, 'checkRegistrarDomains').mockResolvedValue([
      {
        name: 'apreskeys.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);

    const plan = await t.call('hv_plan', { project: 'domain-plan-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const register = plan.data.actions.find((action: { id: string }) => action.id === 'domain:apreskeys.com:register');
    expect(register).toMatchObject({
      type: 'create',
      resource: { kind: 'domain', name: 'apreskeys.com', provider: 'cloudflare' },
      requiresConfirm: true,
      billable: true,
    });
    expect(JSON.stringify(register.metadata)).toContain('10.00');
    const attach = plan.data.actions.find((action: { id: string }) => action.id === 'domain:apreskeys.com');
    expect(attach.dependsOn).toContain('domain:apreskeys.com:register');
    expect(plan.hint).toContain('confirmActions');
    await t.close();
  });

  it('applies Cloudflare domain registration only when the plan action is explicitly confirmed', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'domain-apply-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'apreskeys.com',
            domainRegistration: { provider: 'cloudflare', years: 1, autoRenew: true },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('cloudflare', { apiToken: 'cf-token', accountId: 'acct-1' });
    const project = new ProjectRepository().findByName('domain-apply-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: { web: { serviceId: 'svc-1' } } },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: ['apreskeys.com'],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue(null);
    vi.spyOn(CloudflareAdapter.prototype, 'checkRegistrarDomains').mockResolvedValue([
      {
        name: 'apreskeys.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);
    const create = vi.spyOn(CloudflareAdapter.prototype, 'createRegistrarRegistration').mockResolvedValue({
      completed: true,
      created_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:00:01.000Z',
      links: { self: '/status', resource: '/domain' },
      state: 'succeeded',
    });

    const plan = await t.call('hv_plan', { project: 'domain-apply-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const unconfirmed = await t.call('hv_apply', { project: 'domain-apply-app', planId: plan.data.planId });
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'domain:apreskeys.com:register',
      status: 'skipped_requires_confirm',
    }));
    expect(create).not.toHaveBeenCalled();

    const plan2 = await t.call('hv_plan', { project: 'domain-apply-app', env: 'production' });
    const confirmed = await t.call('hv_apply', {
      project: 'domain-apply-app',
      planId: plan2.data.planId,
      confirmActions: ['domain:apreskeys.com:register'],
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'domain:apreskeys.com:register',
      status: 'succeeded',
    }));
    expect(create).toHaveBeenCalledWith('acct-1', {
      domainName: 'apreskeys.com',
      autoRenew: true,
      years: 1,
    });
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.domainRegistrations).toMatchObject({
      'apreskeys.com': { provider: 'cloudflare', accountId: 'acct-1', state: 'succeeded', completed: true },
    });
    await t.close();
  });

  it('plans and applies iOS bundle ID, capabilities, and TestFlight actions end to end', async () => {
    const BUNDLE = 'com.example.app';
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'ios-e2e-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            ios: {
              bundleId: BUNDLE,
              capabilities: ['PUSH_NOTIFICATIONS'],
              testflight: { groups: { Beta: { testers: ['a@example.com'] } } },
            },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('appstoreconnect', { keyId: 'K1', issuerId: 'I1', privateKey: 'pk' });
    const project = new ProjectRepository().findByName('ios-e2e-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
      },
    });
    // Hosting is already converged so the only executable actions are ios:*.
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    // ASC reads: bundle ID missing, app record exists, no groups/testers yet.
    const findBundleId = vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier').mockResolvedValue(null);
    const capabilities = vi.spyOn(AppStoreConnectAdapter.prototype, 'getBundleIdCapabilities').mockResolvedValue([]);
    const findApp = vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId')
      .mockResolvedValue({ id: 'app-1', bundleId: BUNDLE, name: 'Example' });
    const listGroups = vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue([]);
    const listTesters = vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaTesters').mockResolvedValue([]);
    // ASC writes used at apply time.
    const registerBundleId = vi.spyOn(AppStoreConnectAdapter.prototype, 'registerBundleId')
      .mockResolvedValue({ id: 'bid-1', identifier: BUNDLE, name: 'ios-e2e-app', platform: 'IOS' });
    const enableCapabilities = vi.spyOn(AppStoreConnectAdapter.prototype, 'enableCapabilities')
      .mockResolvedValue({ enabled: ['PUSH_NOTIFICATIONS'], alreadyEnabled: [], errors: [] });
    const getOrCreateGroup = vi.spyOn(AppStoreConnectAdapter.prototype, 'getOrCreateBetaGroup')
      .mockResolvedValue({ group: { id: 'grp-1', name: 'Beta', isInternal: false }, created: true });
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findBetaGroupByName')
      .mockResolvedValue({ id: 'grp-1', name: 'Beta', isInternal: false });
    const getOrCreateTester = vi.spyOn(AppStoreConnectAdapter.prototype, 'getOrCreateBetaTester')
      .mockResolvedValue({ tester: { id: 'tester-1', email: 'a@example.com' }, created: true });

    const plan = await t.call('hv_plan', { project: 'ios-e2e-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const ids = plan.data.actions.map((action: { id: string }) => action.id);
    expect(ids).toEqual(expect.arrayContaining([
      `ios:bundle-id:${BUNDLE}`,
      `ios:capabilities:${BUNDLE}`,
      `ios:app:${BUNDLE}`,
      'ios:group:Beta',
      'ios:testers:Beta',
    ]));
    expect(plan.data.actions.find((action: { id: string }) => action.id === `ios:bundle-id:${BUNDLE}`)).toMatchObject({
      type: 'create',
      resource: { kind: 'ios', name: BUNDLE, provider: 'appstoreconnect' },
    });
    // The app record already exists, so its action is a noop.
    expect(plan.data.actions.find((action: { id: string }) => action.id === `ios:app:${BUNDLE}`)).toMatchObject({ type: 'noop' });

    const apply = await t.call('hv_apply', { project: 'ios-e2e-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(apply.data.applied).toBe(true);
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: `ios:bundle-id:${BUNDLE}`, status: 'succeeded' }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: `ios:capabilities:${BUNDLE}`, status: 'succeeded' }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: `ios:app:${BUNDLE}`, status: 'skipped_noop' }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: 'ios:group:Beta', status: 'succeeded' }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: 'ios:testers:Beta', status: 'succeeded' }));
    expect(registerBundleId).toHaveBeenCalledWith(BUNDLE, 'ios-e2e-app', 'IOS');
    expect(enableCapabilities).toHaveBeenCalledWith('bid-1', ['PUSH_NOTIFICATIONS']);
    expect(getOrCreateGroup).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1', name: 'Beta' }));
    expect(getOrCreateTester).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@example.com', groupIds: ['grp-1'] }));

    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.ios).toMatchObject({
      bundleIdResourceId: 'bid-1',
      appId: 'app-1',
      testflight: { groups: { Beta: { groupId: 'grp-1' } } },
    });

    // Re-point the reads at the converged Apple-side state for hv_status.
    findBundleId.mockResolvedValue({ id: 'bid-1', identifier: BUNDLE, name: 'ios-e2e-app', platform: 'IOS' });
    capabilities.mockResolvedValue([{ id: 'cap-1', type: 'PUSH_NOTIFICATIONS' }]);
    findApp.mockResolvedValue({ id: 'app-1', bundleId: BUNDLE, name: 'Example' });
    listGroups.mockResolvedValue([{ id: 'grp-1', name: 'Beta', isInternal: false }]);
    listTesters.mockResolvedValue([{ id: 'tester-1', email: 'a@example.com' }]);

    const status = await t.call('hv_status', { project: 'ios-e2e-app', env: 'production' });
    expect(status.ok).toBe(true);
    expect(status.data.ios).toMatchObject({
      bundleId: BUNDLE,
      bundleIdRegistered: true,
      capabilitiesMissing: [],
      appRecord: 'found',
    });
    expect(status.data.ios.groups.inSync).toContain('Beta');
    expect(status.data.inSync).toBe(true);
    await t.close();
  });

  it('plans and applies GitHub Actions deploy workflow setup from deploy.trigger="ci"', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'ci-plan-app',
        gitRemoteUrl: 'git@github.com:davejohnson/ci-plan-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('github', { apiToken: 'gh-token', login: 'davejohnson', packageReadToken: 'gh-package-token' });
    const project = new ProjectRepository().findByName('ci-plan-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });
    const writeWorkflow = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({
      created: true,
      updated: false,
    });
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

    const plan = await t.call('hv_plan', { project: 'ci-plan-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const ci = plan.data.actions.find((action: { id: string }) => action.id === 'ci:github-actions:production:deploy-branch');
    expect(ci).toMatchObject({
      type: 'create',
      resource: { kind: 'ci', name: 'deploy-branch:production', provider: 'github' },
    });
    expect(ci.metadata.workflow.path).toBe('.github/workflows/deploy-railway-production.yml');

    const apply = await t.call('hv_apply', { project: 'ci-plan-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'ci:github-actions:production:deploy-branch',
      status: 'succeeded',
    }));
    expect(writeWorkflow).toHaveBeenCalledWith(
      'davejohnson',
      'ci-plan-app',
      '.github/workflows/deploy-railway-production.yml',
      expect.stringContaining('Deploy Railway (production)'),
      'Add Deploy Railway (production) workflow'
    );
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'ci-plan-app', 'RAILWAY_API_TOKEN', 'railway-token');
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'ci-plan-app', 'IMAGE_REGISTRY_TOKEN', 'gh-package-token');
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.ci).toBeDefined();
    const ciBindingText = JSON.stringify(environment.platformBindings.ci);
    expect(ciBindingText).toContain('syncedSecretHashes');
    expect(ciBindingText).toContain('IMAGE_REGISTRY_TOKEN');
    expect(ciBindingText).not.toContain('gh-package-token');
    expect(ciBindingText).not.toContain('railway-token');
    await t.close();
  });

  it('fails CI workflow apply when Railway image pull credentials are missing', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'ci-missing-image-token-app',
        gitRemoteUrl: 'git@github.com:davejohnson/ci-missing-image-token-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('github', { apiToken: 'gh-token', login: 'davejohnson' });
    const project = new ProjectRepository().findByName('ci-missing-image-token-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({
      created: true,
      updated: false,
    });
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

    const plan = await t.call('hv_plan', { project: 'ci-missing-image-token-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const ci = plan.data.actions.find((action: { id: string }) => action.id === 'ci:github-actions:production:deploy-branch');
    expect(ci.metadata.missingProviderSecrets).toEqual(['IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(plan.data.actionScopedBlocked).toContainEqual(expect.objectContaining({
      provider: 'github',
      reason: expect.stringContaining('repo/workflow API access plus packageReadToken'),
    }));
    expect(plan.warnings).toContainEqual(expect.stringContaining('GitHub apiToken needs repo + workflow'));
    expect(plan.next).toEqual(['hv_connect', 'hv_plan']);

    const apply = await t.call('hv_apply', { project: 'ci-missing-image-token-app', planId: plan.data.planId });
    expect(apply.ok).toBe(false);
    expect(apply.error.code).toBe('MISSING_CONNECTION');
    expect(apply.error.details).toContainEqual(expect.objectContaining({
      provider: 'github',
      reason: expect.stringContaining('repo/workflow API access plus packageReadToken'),
    }));
    expect(apply.hint).toContain('classic personal access token');
    expect(apply.hint).toContain('https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages');
    expect(apply.hint).toContain('apiToken needs repo + workflow');
    expect(apply.hint).toContain('read:packages');
    expect(apply.hint).toContain('packageReadToken');
    expect(apply.hint).toContain('credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"HYPERVIBE_GITHUB_PACKAGES_TOKEN"}');
    expect(apply.hint).toContain('map both keys to the same classic PAT');
    expect(apply.hint).toContain('credentialsRef="file:/absolute/path/github.json"');
    expect(apply.next).toEqual(['hv_connect', 'hv_plan', 'hv_apply']);
    expect(setSecret).not.toHaveBeenCalledWith('davejohnson', 'ci-missing-image-token-app', 'RAILWAY_API_TOKEN', 'railway-token');
    expect(setSecret).not.toHaveBeenCalledWith('davejohnson', 'ci-missing-image-token-app', 'IMAGE_REGISTRY_TOKEN', expect.any(String));
    await t.close();
  });

  it('applies independent CI deploy setup before failing a missing Cloudflare domain action', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'ci-domain-soft-block-app',
        gitRemoteUrl: 'git@github.com:davejohnson/ci-domain-soft-block-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'apreskeys.com',
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('github', { apiToken: 'gh-token', login: 'davejohnson', packageReadToken: 'gh-package-token' });
    const project = new ProjectRepository().findByName('ci-domain-soft-block-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1', url: 'https://web-production.up.railway.app' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({
      created: true,
      updated: false,
    });
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

    const plan = await t.call('hv_plan', { project: 'ci-domain-soft-block-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.blocked).toEqual([]);
    expect(plan.data.actionScopedBlocked).toContainEqual(expect.objectContaining({ provider: 'cloudflare' }));
    expect(plan.next).toContain('hv_apply');

    const apply = await t.call('hv_apply', { project: 'ci-domain-soft-block-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(apply.data.applied).toBe(false);
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'ci:github-actions:production:deploy-branch',
      status: 'succeeded',
    }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'domain:apreskeys.com',
      status: 'failed',
      error: expect.stringContaining('No Cloudflare connection available for apreskeys.com'),
    }));
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'ci-domain-soft-block-app', 'RAILWAY_API_TOKEN', 'railway-token');
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'ci-domain-soft-block-app', 'IMAGE_REGISTRY_TOKEN', 'gh-package-token');
    await t.close();
  });

  it('reports drift via hv_status against observed state', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    verifyRailwayConnection();
    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: { web: { serviceId: 's-1' } } },
    });
    mockObserved({
      provider: 'railway', observedAt: new Date().toISOString(),
      projectExists: true, projectId: 'rp-1',
      services: [{
        name: 'web', externalId: 's-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'node legacy.js' },
        envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [], partial: false, warnings: [],
    });

    const status = await t.call('hv_status', { project: 'core-spec-app', env: 'staging' });
    expect(status.ok).toBe(true);
    expect(status.data.verified).toBe(true);
    expect(status.data.inSync).toBe(false);
    const drift = status.data.drift.find((a: { id: string }) => a.id === 'service:web');
    expect(drift.type).toBe('update');
    await t.close();
  });

  it('reports declared queues as drift when the provider cannot converge them', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'queue-status-app',
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            database: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' }, jobs: { workloadKind: 'worker' } },
            queues: { 'email-jobs': {} },
            envVars: { NODE_ENV: 'staging' },
          },
        },
      },
    });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('queue-status-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: { web: { serviceId: 's-1' } } },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
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

    const status = await t.call('hv_status', { project: 'queue-status-app', env: 'staging' });
    expect(status.ok).toBe(true);
    expect(status.data.inSync).toBe(false);
    expect(status.data.drift).toContainEqual(expect.objectContaining({
      id: 'queue:email-jobs',
      type: 'create',
      verified: false,
      metadata: expect.objectContaining({ unsupported: true }),
    }));
    expect(status.warnings).toContainEqual(expect.stringContaining('does not support queues'));
    await t.close();
  });

  it('reports push-to-deploy ready for synced GitHub Actions deploy workflows', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'ci-status-app',
        gitRemoteUrl: 'git@github.com:davejohnson/ci-status-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            envVars: {},
            email: { enabled: false },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    verifyConnection('railway', { apiToken: 'railway-token' });
    verifyConnection('github', { apiToken: 'gh-token', login: 'davejohnson', packageReadToken: 'gh-package-token' });
    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const project = new ProjectRepository().findByName('ci-status-app')!;
    const envRepo = new EnvironmentRepository();
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-web' } },
      },
    });
    const { targets, migration } = resolveBranchDeployTargets(project);
    const target = targets.find((candidate) => candidate.environmentName === 'production')!;
    const workflow = buildBranchDeployWorkflow('railway', target, migration);
    const environment = envRepo.findByProjectAndName(project.id, 'production')!;
    envRepo.updatePlatformBindings(environment.id, {
      ...(environment.platformBindings as Record<string, unknown>),
      ci: {
        deployBranch: {
          [workflow.path]: {
            contentHash: sha256(workflow.content),
            syncedSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
            syncedSecretHashes: {
              RAILWAY_API_TOKEN: sha256('railway-token'),
              IMAGE_REGISTRY_USERNAME: sha256('davejohnson'),
              IMAGE_REGISTRY_TOKEN: sha256('gh-package-token'),
            },
          },
        },
      },
    });
    mockObserved({
      provider: 'railway', observedAt: new Date().toISOString(),
      projectExists: true, projectId: 'rp-1', environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-web', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start', public: false },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [], partial: false, warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);

    const status = await t.call('hv_status', { project: 'ci-status-app', env: 'production' });

    expect(status.ok).toBe(true);
    expect(status.data.deploySource.pushToDeploy).toBe(true);
    expect(status.data.deploySource.ci).toMatchObject({
      provider: 'github-actions',
      setup: 'in-sync',
      workflow: { path: '.github/workflows/deploy-railway-production.yml', branch: 'main' },
    });
    await t.close();
  });

  it('rejects hv_apply when the spec changed after planning', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    verifyRailwayConnection();
    mockObserved(null);

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });
    expect(plan.ok).toBe(true);

    // Supersede the spec
    await t.call('hv_spec_set', {
      project: 'core-spec-app',
      spec: { environments: { staging: { envVars: { EXTRA: '1' } } } },
    });

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(false);
    expect(apply.error.message).toContain('Re-run hv_plan');
    await t.close();
  });

  it('refuses to apply without verified connections', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    mockObserved(null);
    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(false);
    expect(apply.error.code).toBe('MISSING_CONNECTION');
    expect(apply.hint).toContain('Railway Account API token');
    expect(apply.hint).toContain('https://railway.com/account/tokens');
    expect(apply.next).toEqual(['hv_connect', 'hv_plan', 'hv_apply']);
    await t.close();
  });

  it('destroys a locally managed provider service that was removed from the spec', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', { spec: SPEC });
    verifyRailwayConnection();

    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const { ServiceRepository } = await import('../../adapters/db/repositories/service.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: {
          web: { serviceId: 's-web' },
          daily: { serviceId: 's-daily' },
        },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'daily',
      buildConfig: { workloadKind: 'cron', cronSchedule: '0 8 * * *' },
    });

    const observedState: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [
        {
          name: 'web', externalId: 's-web', workloadKind: 'web', customDomains: [],
          config: { startCommand: 'npm start' },
          envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        },
        {
          name: 'daily', externalId: 's-daily', workloadKind: 'cron', customDomains: [],
          config: { startCommand: 'npm run cron', cronSchedule: '0 8 * * *' },
          envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        },
      ],
      databases: [],
      partial: false,
      warnings: [],
    };
    const deleteService = vi.fn(async () => ({ success: true }));
    const adapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {}, verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('hosting deploy should not run for service destroy'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      observe: async () => observedState,
      deleteService,
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter } as any);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter } as any);

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'service:daily:destroy',
      type: 'destroy',
    }));
    expect(plan.data.unmanaged).not.toContainEqual(expect.objectContaining({ kind: 'service', name: 'daily' }));

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(deleteService).toHaveBeenCalledWith('s-daily');
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:daily:destroy',
      status: 'succeeded',
    }));

    const updatedEnvironment = new EnvironmentRepository().findById(environment.id)!;
    const services = updatedEnvironment.platformBindings.services as Record<string, unknown>;
    expect(services).toMatchObject({ web: { serviceId: 's-web' } });
    expect(services.daily).toBeUndefined();
    expect(new ServiceRepository().findByProjectAndName(project.id, 'daily')).toBeNull();
    await t.close();
  });

  it('creates a replacement database without deploying or destroying the old database in the same apply', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'core-spec-app',
        environments: {
          production: {
            hosting: { provider: 'cloudrun' },
            services: { web: { startCommand: 'npm start' } },
            database: { provider: 'supabase' },
            envVars: { NODE_ENV: 'production' },
          },
        },
      },
    });
    verifyConnection('cloudrun');
    verifyConnection('supabase');

    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const { ComponentRepository } = await import('../../adapters/db/repositories/component.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    const now = new Date();
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'cloudsql-1',
      bindings: {
        provider: 'cloudsql',
        instanceId: 'cloudsql-1',
        connectionUrl: 'postgres://old-cloudsql',
        connectionName: 'gcp-project:us-central1:app',
      },
    });

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'cloudrun',
        capabilities: {
          supportedBuilders: ['dockerfile'], supportedComponents: [],
          supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
          supportsReleaseCommand: false, supportsMultiEnvironment: false, managedTls: true,
          supportsObserve: true,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        ensureProject: async () => ({ success: true, message: 'ok' }),
        ensureComponent: async () => { throw new Error('unused'); },
        deploy: async () => { throw new Error('hosting deploy should not run'); },
        observe: async () => ({
          provider: 'cloudrun',
          observedAt: new Date().toISOString(),
          projectExists: true,
          projectId: 'gcp-project',
          environmentId: 'production',
          services: [{
            name: 'web', externalId: 'gcp-project-web', workloadKind: 'web', customDomains: [],
            config: { startCommand: 'npm start' },
            envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('production') },
            status: 'running',
          }],
          databases: [{ provider: 'cloudsql', engine: 'postgres', externalId: 'cloudsql-1', status: 'running' }],
          partial: false,
          warnings: [],
        }),
      },
    } as any);
    const provision = vi.fn(async (_type: string, env: { id: string }) => ({
      component: {
        id: 'supabase-component',
        environmentId: env.id,
        type: 'postgres',
        externalId: 'supabase-1',
        bindings: {
          provider: 'supabase',
          instanceId: 'supabase-1',
          connectionUrl: 'postgres://new-supabase',
          host: 'db.supabase.co',
          port: 5432,
          username: 'postgres',
          password: 'pw',
          database: 'postgres',
        },
        createdAt: now,
        updatedAt: now,
      },
      receipt: { success: true, message: 'Provisioned Supabase Postgres' },
      connectionUrl: 'postgres://new-supabase',
      envVars: { DATABASE_URL: 'postgres://new-supabase', DATABASE_SSL: 'true' },
    }));
    const destroy = vi.fn(async () => ({ success: true, message: 'destroyed' }));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'supabase',
        capabilities: {
          supportedDatabases: ['postgres'],
          supportsPooling: true, supportsReadReplicas: false,
          supportsPointInTimeRecovery: false, serverlessOptimized: true,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        provision,
        getConnectionUrl: async () => 'postgres://new-supabase',
        destroy,
      },
    } as any);
    const hostingSpy = vi.spyOn(adapterFactory, 'getHostingAdapter').mockRejectedValue(new Error('hosting should not run'));

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({ id: 'database:supabase', type: 'create' }));
    expect(plan.data.actions.find((action: { id: string }) => action.id === 'database:cloudsql:destroy')).toBeUndefined();

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'database:supabase',
      status: 'succeeded',
    }));
    expect(provision).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(hostingSpy).not.toHaveBeenCalled();

    const component = new ComponentRepository().findByEnvironmentAndType(environment.id, 'postgres')!;
    expect(component.bindings.provider).toBe('supabase');
    expect(component.bindings.previousProvider).toBe('cloudsql');
    expect(component.bindings.previousExternalId).toBe('cloudsql-1');
    expect(component.bindings.previousBindings).toMatchObject({
      provider: 'cloudsql',
      connectionUrl: 'postgres://old-cloudsql',
    });
    await t.close();
  });

  it('tears down abandoned-provider services only when confirmed and prunes the previousHosting stash', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'previous-teardown-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
          },
        },
      },
    });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('previous-teardown-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
        previousHosting: {
          provider: 'cloudrun',
          projectId: 'gcp-project',
          services: { web: { serviceId: 'gcp-project-web' } },
        },
      },
    });
    // Railway side is fully in sync, so the only pending action is the
    // confirm-gated teardown of the abandoned Cloud Run service.
    const observedState: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    };
    const railwayAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {}, verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('hosting deploy should not run for previous-provider teardown'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      observe: async () => observedState,
    };
    const deleteService = vi.fn(async () => ({ success: true }));
    const cloudrunAdapter = {
      name: 'cloudrun',
      capabilities: {
        supportedBuilders: ['dockerfile'], supportedComponents: [],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: false, managedTls: true,
        supportsObserve: true,
      },
      deleteService,
    };
    // The teardown must resolve the PREVIOUS provider's adapter, so dispatch
    // on the provider name instead of returning a single adapter.
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async (provider: string) => (
      provider === 'cloudrun'
        ? { success: true, adapter: cloudrunAdapter }
        : { success: true, adapter: railwayAdapter }
    ) as any);

    const plan = await t.call('hv_plan', { project: 'previous-teardown-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'service:web:previous-destroy',
      type: 'destroy',
      requiresConfirm: true,
      resource: { kind: 'service', name: 'web', provider: 'cloudrun' },
    }));

    const unconfirmed = await t.call('hv_apply', { project: 'previous-teardown-app', planId: plan.data.planId });
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:web:previous-destroy',
      status: 'skipped_requires_confirm',
    }));
    expect(deleteService).not.toHaveBeenCalled();

    // Plans are single-use: re-plan before the confirmed apply.
    const plan2 = await t.call('hv_plan', { project: 'previous-teardown-app', env: 'production' });
    expect(plan2.ok).toBe(true);
    const confirmed = await t.call('hv_apply', {
      project: 'previous-teardown-app',
      planId: plan2.data.planId,
      confirmActions: ['service:web:previous-destroy'],
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:web:previous-destroy',
      status: 'succeeded',
    }));
    expect(deleteService).toHaveBeenCalledWith('gcp-project-web');

    const updated = new EnvironmentRepository().findById(environment.id)!;
    expect((updated.platformBindings as Record<string, unknown>).previousHosting ?? null).toBeNull();
    await t.close();
  });

  it('stashes the abandoned provider bindings as previousHosting when the hosting provider switches', async () => {
    const t = await makeClient();
    await t.call('hv_spec_set', {
      spec: {
        project: 'provider-switch-stash-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
          },
        },
      },
    });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('provider-switch-stash-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
    });
    // No observation: the plan falls back to local state and emits the
    // provider-switch replace actions unverified.
    mockObserved(null);
    const fakeRailway = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {},
      verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok', data: { projectId: 'rail-project', environmentId: 'rail-env' } }),
      deploy: async () => ({
        serviceId: 'web',
        externalId: 'rail-web',
        url: 'https://web-production.up.railway.app',
        status: 'deployed',
        receipt: { success: true, message: 'deployed' },
      }),
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      getDeployStatus: async () => ({ status: 'deployed', url: 'https://web-production.up.railway.app' }),
    };
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeRailway } as any);

    const plan = await t.call('hv_plan', { project: 'provider-switch-stash-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'service:web',
      type: 'replace',
    }));

    const apply = await t.call('hv_apply', { project: 'provider-switch-stash-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);

    // The stash is written before the converge pass, so it must hold
    // regardless of how the bootstrap converge itself turned out (here the
    // bootstrap pass fails on the Cloud Run prepare gate, which is fine —
    // the contract under test is the pre-converge stash, not the converge).
    const updated = new EnvironmentRepository().findById(environment.id)!;
    expect((updated.platformBindings as Record<string, unknown>).previousHosting).toMatchObject({
      provider: 'cloudrun',
      projectId: 'gcp-project',
      services: { web: { serviceId: 'gcp-project-web' } },
    });
    await t.close();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { PublicDnsClient } from '../../../adapters/dns/public-dns.client.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../application/devops-providers.js';
import { SpecStore } from '../../spec/spec.store.js';
import type { ProjectSpec } from '../../spec/spec.schema.js';
import { PlanService } from '../plan.service.js';
import type { PlanAction } from '../plan.types.js';
import * as backupPolicy from '../../services/backup-policy.service.js';
import * as backupHealth from '../../services/backup-health.service.js';
import * as resilience from '../../services/database-resilience-plan.service.js';
import { buildBranchDeployWorkflow, resolveBranchDeployTargets } from '../../services/github-ops.service.js';
import { workflowFiles } from '../../services/ci-deploy.service.js';
import { createCommandContext } from '../../../application/context.js';
import { createCommandRegistry } from '../../../application/commands.js';
import { registerCommandRegistry } from '../../../interfaces/mcp/adapter.js';
import { runCli } from '../../../interfaces/cli/run.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import * as bootstrap from '../../services/bootstrap.service.js';
import * as managedCi from '../../services/managed-ci.service.js';

// User requirement (2026-10-29): normal releases do not require enabled backups,
// new archive storage, or fresh recovery evidence. Destructive-operation
// checkpoints remain separate. Provider observations below are synthetic;
// actual PlanService, policy resolution, CI rendering and stored specs run.
describe('optional backup policy at the ordinary deployment planning boundary', () => {
  let directory: string;
  beforeEach(() => {
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
    SqliteAdapter.resetInstance();
    directory = mkdtempSync(path.join(tmpdir(), 'hv-optional-backup-plan-'));
    SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
    vi.spyOn(PublicDnsClient.prototype, 'query').mockResolvedValue({ status: 'unknown' });
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  async function fixture(explicitBackup: boolean, applicationStorage = false) {
    const project = new ProjectRepository().create({ name: 'optional-backups', defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/acme/optional-backups' });
    const spec = new SpecStore().replace(project, { version: 1, project: project.name,
      gitRemoteUrl: project.gitRemoteUrl, runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
      environments: { production: { hosting: { provider: 'railway' },
        services: { web: { startCommand: 'node changed.js', public: true } },
        database: { provider: 'railway', engine: 'postgres' }, email: { enabled: false },
        ...(applicationStorage ? { storage: { documents: { provider: 'railway', region: 'iad', type: 'bucket' as const, injectInto: [] } } } : {}),
        ...(explicitBackup ? { backups: { mode: 'daily' as const } } : {}),
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
      } },
    });
    const scope = { projectId: 'project-1', environmentId: 'production-1' };
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', ...scope, services: { web: { serviceId: 'web-1' } },
        ...(applicationStorage ? { storage: { documents: { provider: 'railway', externalId: 'documents-1',
          region: 'iad', instanceScope: scope, services: [], envKeys: [] } } } : {}),
      } });
    const component = new ComponentRepository().create({ environmentId: environment.id, type: 'postgres', externalId: 'db-1',
      bindings: { provider: 'railway', resourceKind: 'service', providerScope: scope } });
    for (const [provider, credentials] of Object.entries({ railway: { apiToken: 'synthetic-railway' },
      github: { apiToken: 'synthetic-github', login: 'acme', packageReadToken: 'synthetic-package' } })) {
      const connections = new ConnectionRepository();
      const connection = connections.create({ provider, credentialsEncrypted: getSecretStore().encryptObject(credentials) });
      connections.updateStatus(connection.id, 'verified');
    }
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true, ...scope, partial: false, warnings: [],
      services: [{ name: 'web', externalId: 'web-1', workloadKind: 'web', sourceState: 'disconnected',
        config: { startCommand: 'npm start', public: true }, envVarKeys: [], envVarHashes: {}, customDomains: [], status: 'running' }],
      databases: [{ provider: 'railway', engine: 'postgres', externalId: 'db-1', status: 'running', providerScope: scope }],
      ...(applicationStorage ? { storage: [{ name: 'documents', provider: 'railway', kind: 'object' as const,
        status: 'running' as const, externalId: 'documents-1', region: 'iad', instanceScope: scope }] } : {}),
    } });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getEnvironmentVariable').mockResolvedValue(null);
    const { targets, migration } = resolveBranchDeployTargets(project);
    const files = workflowFiles(buildBranchDeployWorkflow('railway', targets[0], migration));
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, name) =>
      files.find(file => file.path === name)?.content ?? null);
    const resource = { kind: 'database' as const, name: 'postgres', provider: 'railway', retained: false,
      bindingState: 'bound' as const, componentId: component.id };
    vi.spyOn(backupPolicy, 'observeBackupPolicy').mockImplementation(async context => ({
      policy: backupPolicy.resolveBackupPolicies({ version: 1, project: project.name, secrets: {},
        environments: { production: context.spec } } as ProjectSpec, [environment], [component]).production,
      resources: [{ resource, state: 'needs-configuration', target: { kind: 'database', componentId: component.id },
        observation: { state: 'known', source: { provider: 'railway', primaryExternalId: 'db-1', providerScope: scope,
          resourceIdentity: { volumeId: 'volume-1', volumeInstanceId: 'instance-1' } }, daily: false,
          policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot' } }],
    }));
    vi.spyOn(backupHealth, 'observeBackupHealth').mockResolvedValue({ observedAt: new Date().toISOString(),
      resources: [{ resource, state: 'missing', reason: 'No completed backup or isolated restore exists.' }] });
    const checkpointPlanner = vi.spyOn(resilience, 'planDatabaseResilience')
      .mockReturnValue({ actions: [], warnings: [], unmanaged: [], serviceDependencies: [] });
    return { project, spec, checkpointPlanner, plan: () => new PlanService().plan(project, 'production', { includeEnvFile: false }) };
  }

  it.each([false, true])('keeps ordinary service changes reachable with explicit backup intent=%s and no completed backup', async explicitBackup => {
    const f = await fixture(explicitBackup);
    const result = await f.plan();
    if ('error' in result) throw new Error(result.error);
    expect({ scope: result.scope, blocked: result.blocked }).toEqual({ scope: 'full', blocked: [] });
    expect(result.actions).toContainEqual(expect.objectContaining({ id: 'service:web', type: 'update' }));
    expect(result.actions.some(action => action.metadata?.operation === 'dailyBackupConfigure'
      || action.resource.name === 'hypervibe-backups')).toBe(false);
    expect(new SpecStore().get(f.project)!.spec.environments.production.backups)
      .toEqual(explicitBackup ? { mode: 'daily' } : undefined);
  });

  it('retains an explicitly requested destructive-operation checkpoint as an isolated prerequisite', async () => {
    const f = await fixture(false);
    const checkpoint: PlanAction = { id: 'database:railway:checkpoint:before-replacement', type: 'create',
      resource: { kind: 'database', provider: 'railway', name: 'checkpoint:before-replacement' },
      verified: true, requiresConfirm: true, billable: true, dataBearing: true,
      reason: 'Explicit recovery checkpoint before destructive replacement',
      metadata: { operation: 'databaseCheckpointCreate', checkpointId: 'before-replacement' } };
    f.checkpointPlanner.mockReturnValue({ actions: [checkpoint], warnings: [], unmanaged: [], serviceDependencies: [] });
    const result = await f.plan();
    expect(result).toMatchObject({ scope: 'database-checkpoint', actions: [checkpoint] });
  });

  it.each([false, true])('does not infer an archive bucket from application storage in an ordinary plan (daily=%s)', async daily => {
    const f = await fixture(daily, true);
    const result = await f.plan();
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('full');
    expect(result.actions.some(action => action.resource.name === 'hypervibe-backups')).toBe(false);
    expect(new SpecStore().get(f.project)!.spec.environments.production.storage)
      .toEqual({ documents: { provider: 'railway', region: 'iad', type: 'bucket', injectInto: [] } });
  });

  it('keeps explicit backup setup reachable without authorizing ordinary application changes', async () => {
    const f = await fixture(true);
    const result = await new PlanService().plan(f.project, 'production', { scope: 'backups' });
    if ('error' in result) throw new Error(result.error);
    expect(result).toMatchObject({ scope: 'backup-policy', blocked: [], actions: [expect.objectContaining({
      metadata: expect.objectContaining({ operation: 'dailyBackupConfigure' }),
    })] });
    expect(result.actions.some(action => action.resource.kind === 'service')).toBe(false);
  });

  it('exposes the same explicit backup setup scope through MCP and CLI', async () => {
    const f = await fixture(true);
    const registry = createCommandRegistry(createCommandContext());
    const server = new McpServer({ name: 'backup-command', version: '1' });
    registerCommandRegistry(server, registry);
    const client = new Client({ name: 'backup-command-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const mcp = await client.callTool({ name: 'hv_plan', arguments: {
        project: f.project.name, env: 'production', scope: 'backups',
      } });
      expect(mcp.structuredContent).toMatchObject({ ok: true, data: { scope: 'backup-policy', pendingActionCount: 1 } });
      let output = ''; let error = '';
      const code = await runCli(['plan', '--project', f.project.name, '--env', 'production', '--scope', 'backups', '--json'], {
        registry, initialize: false, io: { writeOut: value => { output += value; }, writeErr: value => { error += value; },
          readStdin: async () => '', confirm: async () => false, stdinIsTTY: false },
      });
      expect({ code, error }).toEqual({ code: 0, error: '' });
      expect(JSON.parse(output)).toMatchObject({ ok: true, data: { scope: 'backup-policy', pendingActionCount: 1 } });
      const incompatible = await registry.execute('hv_plan', { project: f.project.name, env: 'production', scope: 'backups', services: [] });
      expect(incompatible).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    } finally { await client.close(); await server.close(); }
  });

  it('applies a converged backup diagnostic as a noop even when bootstrap is requested', async () => {
    const f = await fixture(true);
    vi.mocked(backupPolicy.observeBackupPolicy).mockResolvedValue({ policy: { mode: 'daily', source: 'explicit', resources: [] }, resources: [] });
    vi.mocked(backupHealth.observeBackupHealth).mockResolvedValue({ observedAt: new Date().toISOString(), resources: [] });
    vi.spyOn(managedCi, 'planManagedCiDeploy').mockResolvedValue({ actions: [], warnings: [] });
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockImplementation(async () => { throw new Error('Backup diagnostics cannot deploy'); });
    const result = await new PlanService().plan(f.project, 'production', { scope: 'backups' });
    if ('error' in result) throw new Error(result.error);
    expect(result).toMatchObject({ scope: 'backup-readiness', actions: [], blocked: [] });
    const stored = new SpecStore().get(f.project)!;
    const applied = await executePlanApply(createCommandContext(), { project: f.project, spec: stored.spec,
      specRevision: stored.revision, planId: result.planRunId, confirmActions: [], alwaysRunBootstrap: true });
    expect(applied).toMatchObject({ kind: 'executed', result: { success: true, receipts: [] } });
    expect(deploy).not.toHaveBeenCalled();
  });
});

import '../../../application/providers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../../application/context.js';
import { CommandRegistry } from '../../../application/commands.js';
import { registerCoreTools } from '../../../tools/core.tools.js';
import * as infrastructure from '../../../application/infrastructure-engine.js';
import * as dnsIntegrations from '../../../application/dns-integrations.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { compileManagedGitHubFiles } from '../../services/github-infrastructure.service.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import { PlanService } from '../plan.service.js';

describe('repository DNS selection without hosting workloads', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-pages-scope-')); SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'test.db')); });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); fs.rmSync(directory, { recursive: true, force: true }); });
  function setup(platformBindings?: Record<string, unknown>) {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'pages-with-dns', defaultPlatform: 'cloudrun' });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      github: { repository: 'owner/pages', canonicalEnvironment: 'repository',
        collaboration: { issues: { enabled: false, templates: false }, pullRequests: { requirePr: false } },
        pages: { sourcePath: 'public', customDomain: 'example.com' } },
      environments: { repository: { hosting: { provider: 'cloudrun' }, dns: {
        provider: 'gcp', zone: { id: 'example-zone', name: 'example.com', projectId: 'dns-project' },
      } } } });
    new SpecStore().replace(project, spec);
    const environment = platformBindings ? ctx.repos.environments.create({ projectId: project.id, name: 'repository', platformBindings }) : undefined;
    const connection = ctx.repos.connections.create({ provider: 'github', scope: 'owner/pages', credentialsEncrypted: ctx.secretStore.encryptObject({ apiToken: 'synthetic-github-token' }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');
    const files = new Map(compileManagedGitHubFiles(spec.github!).map(file => [file.path, file.content]));
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, file) => files.get(file) ?? null);
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ id: 12, full_name: 'owner/pages', default_branch: 'main', private: false });
    vi.spyOn(GitHubAdapter.prototype, 'listLabels').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getPagesConfig').mockResolvedValue({ cname: 'example.com', build_type: 'workflow', https_enforced: true, url: 'https://example.com', public: true, custom_404: false });
    const hosting = vi.spyOn(adapterFactory, 'getProviderAdapter');
    return { ctx, project, environment, hosting };
  }
  it('uses existing repository planning with an explicit DNS environment and no hosting domain', async () => {
    const { ctx, project, hosting } = setup();
    const planned = await new PlanService().plan(project, 'repository');
    expect(planned).not.toHaveProperty('error');
    if ('error' in planned) throw new Error(planned.error);
    expect(planned.actions.some(action => action.metadata?.operation === 'githubPagesDnsSync')).toBe(true);
    expect(planned.actions.every(action => !['service', 'database', 'project'].includes(action.resource.kind))).toBe(true);
    expect(ctx.repos.environments.findByProjectAndName(project.id, 'repository')).toBeTruthy();
    expect(hosting).not.toHaveBeenCalled();
  });
  it('routes normal hv_plan through the selected repository environment to the DNS stage', async () => {
    const { ctx, project, hosting } = setup();
    const engine = vi.spyOn(infrastructure, 'planInfrastructureEngine').mockRejectedValue(new Error('Hosting infrastructure must not run'));
    const dns = vi.spyOn(dnsIntegrations, 'planPagesEmailDns').mockResolvedValue({ blocked: ['DNS_STAGE_REACHED'] });
    const commands = new CommandRegistry(); registerCoreTools(commands, ctx);
    const result = await commands.execute('hv_plan', { project: project.name, env: 'repository' });
    expect(JSON.stringify(result)).toContain('DNS_STAGE_REACHED');
    expect(dns).toHaveBeenCalledWith(ctx, expect.objectContaining({ environmentName: 'repository' }));
    expect(engine).not.toHaveBeenCalled();
    expect(hosting).not.toHaveBeenCalled();
  });
  it('applies a reviewed repository plan after its DNS stage converges without entering hosting', async () => {
    const { ctx, project, hosting } = setup();
    const dns = vi.spyOn(dnsIntegrations, 'planPagesEmailDns').mockImplementation(async (_ctx, params) => {
      for (const action of params.actions) {
        if (action.metadata?.operation === 'githubPagesDnsSync') {
          action.type = 'noop'; action.verified = true;
          action.metadata = { ...action.metadata, dnsEngineReady: true };
        }
      }
      return null;
    });
    const commands = new CommandRegistry(); registerCoreTools(commands, ctx);
    await commands.execute('hv_plan', { project: project.name, env: 'repository' });
    expect(dns).toHaveBeenCalled();
    const environment = ctx.repos.environments.findByProjectAndName(project.id, 'repository')!;
    const run = ctx.repos.runs.findByEnvironmentId(environment.id).find(value => value.type === 'plan')!;
    const stored = new SpecStore().get(project)!;
    expect(await executePlanApply(ctx, { project, spec: stored.spec, specRevision: stored.revision,
      planId: run.id, confirmActions: [] })).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(hosting).not.toHaveBeenCalled();
  });
  it('rechecks bound hosting resources before applying the repository plan', async () => {
    const { ctx, project, hosting } = setup();
    const planned = await new PlanService().plan(project, 'repository');
    if ('error' in planned) throw new Error(planned.error);
    const environment = ctx.repos.environments.findByProjectAndName(project.id, 'repository')!;
    ctx.repos.environments.update(environment.id, { platformBindings: { unknownResourceInventory: true } });
    const stored = new SpecStore().get(project)!;
    const result = await executePlanApply(ctx, { project, spec: stored.spec, specRevision: stored.revision,
      planId: planned.planRunId, confirmActions: planned.actions.map(action => action.id) });
    expect(result).toMatchObject({ kind: 'blocked', applyBlocked: [{ reason: expect.stringMatching(/existing|unknown|bound/i) }] });
    expect(hosting).not.toHaveBeenCalled();
  });
  it('reports repository status and unverified selected DNS without creating a plan or requiring Cloudflare', async () => {
    const { ctx, project, hosting } = setup();
    const plan = vi.spyOn(dnsIntegrations, 'planPagesEmailDns');
    const commands = new CommandRegistry(); registerCoreTools(commands, ctx);
    const result = await commands.execute('hv_status', { project: project.name, env: 'repository' });
    const output = JSON.stringify(result);
    expect(output).toContain('example-zone');
    expect(output).toContain('unverified');
    expect(output).not.toContain('Cloudflare');
    expect(output).not.toContain('cloudflare');
    expect(ctx.repos.runs.findByProjectId(project.id)).toHaveLength(0);
    expect(plan).not.toHaveBeenCalled();
    expect(hosting).not.toHaveBeenCalled();
  });
  it.each([{ provider: 'cloudrun', projectId: 'existing-cloud-project' }, { unknownResourceInventory: true }])('blocks existing or unknown hosting bindings rather than hiding them: %j', async platformBindings => {
    const { project, hosting } = setup(platformBindings);
    expect(await new PlanService().plan(project, 'repository')).toMatchObject({ error: expect.stringMatching(/existing|unknown|bound/i) });
    expect(hosting).not.toHaveBeenCalled();
  });
  it('blocks retained data resources even when hosting bindings are missing', async () => {
    const { ctx, project, hosting } = setup({ github: {} });
    const environment = ctx.repos.environments.findByProjectAndName(project.id, 'repository')!;
    ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'existing-database' });
    expect(await new PlanService().plan(project, 'repository')).toMatchObject({ error: expect.stringMatching(/resource|bound/i) });
    expect(hosting).not.toHaveBeenCalled();
  });
});

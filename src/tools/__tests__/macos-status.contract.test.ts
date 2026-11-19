import '../../application/providers.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { CommandRegistry } from '../../application/commands.js';
import { createCommandContext } from '../../application/context.js';
import * as engine from '../../application/infrastructure-engine.js';
import * as secrets from '../../application/secret-rotation.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { registerCoreTools } from '../core.tools.js';
import { createCommandRegistry } from '../../application/commands.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';

const fixture = fileURLToPath(new URL('../../../apps/macos/Tests/HypervibeCompanionCoreTests/Fixtures/current-core-status.json', import.meta.url));
let directory: string | undefined;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); SqliteAdapter.resetInstance();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it('captures current registered hv_status responses for the companion decoder contract', async () => {
  directory = mkdtempSync(join(tmpdir(), 'hv-companion-status-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(join(directory, 'data.sqlite')).migrate();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in companion contract capture.'); }));
  // These are synthetic observation inputs; the public command constructs every
  // serialized envelope below. Swift never maintains its own expected core JSON.
  const workerStatus = vi.spyOn(engine, 'engineWorkerStatus').mockResolvedValue({ workers: [
    { service: 'queue-worker', mode: 'on-demand', instances: 0, waker: { state: 'SUCCEEDED', lastRunAt: '2026-11-17T11:59:00.000Z', pendingWork: 0 } },
    { service: 'always-worker', mode: 'always-on', instances: 2 },
    { service: 'unobserved-worker', mode: 'always-on' },
    { service: 'blocked-worker', mode: 'on-demand', instances: 1, waker: { state: 'FAILED', readError: 'access denied' } },
  ], warnings: ['Worker blocked-worker cannot read pending work.'] });
  vi.spyOn(secrets, 'secretAges').mockResolvedValue({ blocked: 'No secret-age observation in this contract fixture.' });
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: {
    provider: 'railway', observedAt: '2026-11-17T12:00:00.000Z', projectExists: true, services: [], databases: [],
    partial: false, warnings: [],
  }, warnings: [] });
  const ctx = createCommandContext();
  const commands = new CommandRegistry(); registerCoreTools(commands, ctx);
  const captures: Record<string, unknown> = {};
  const template = providerRegistry.get('railway')!;
  providerRegistry.register({ ...template, metadata: { ...template.metadata, name: 'fixture-planned-hosting',
    maturity: { ...template.metadata.maturity, lifecycle: { ...template.metadata.maturity?.lifecycle,
      hosting: { status: 'planned', reason: 'Synthetic planned provider for interface compatibility.' } } } } });
  for (const [name, provider] of Object.entries({ gcp: 'cloudrun', gcpNoWorkers: 'cloudrun', aws: 'aws', azure: 'azure', railway: 'railway', plannedProvider: 'fixture-planned-hosting' })) {
    if (name === 'gcpNoWorkers') workerStatus.mockResolvedValueOnce({ workers: [], warnings: [] });
    const project = ctx.repos.projects.create({ name: `companion-${name}`, defaultPlatform: provider });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { testing: { hosting: { provider }, services: {} } } });
    new ProjectSpecRepository().insert(project.id, 1, spec);
    captures[name] = await commands.execute('hv_status', { project: project.name, env: 'testing' });
  }
  const serialized = JSON.stringify(captures, null, 2) + '\n';
  if (process.env.HYPERVIBE_UPDATE_COMPANION_FIXTURES === '1') {
    mkdirSync(dirname(fixture), { recursive: true }); writeFileSync(fixture, serialized);
  }
  expect(serialized, 'Regenerate with HYPERVIBE_UPDATE_COMPANION_FIXTURES=1 npm test -- src/tools/__tests__/macos-status.contract.test.ts, then run the Swift contract tests.').toBe(readFileSync(fixture, 'utf8'));
  expect(captures).toMatchObject({ gcp: { ok: true, data: { engine: 'opentofu' } }, aws: { ok: true }, azure: { ok: true }, railway: { ok: true }, plannedProvider: { ok: false } });
});

// The companion's refresh also reads the spec, recent runs and connections. Each
// answer below comes from the public command; the Swift suite decodes it with the
// decoder the app uses, so changing an answer's shape fails CI (workflow DG-137).
const refreshFixture = fixture.replace('current-core-status.json', 'current-core-refresh.json');
it('captures the other answers the companion refresh decodes', async () => {
  directory = mkdtempSync(join(tmpdir(), 'hv-companion-refresh-'));
  mkdirSync(join(directory, '.git')); mkdirSync(join(directory, '.hypervibe'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(join(directory, 'data.sqlite')).migrate();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in companion contract capture.'); }));
  const spec = projectSpecSchema.parse({ version: 1, project: 'companion-refresh', environments: {
    production: { hosting: { provider: 'cloudrun' }, services: { web: {} }, database: { provider: 'cloudsql' } },
  } });
  writeFileSync(join(directory, '.hypervibe', 'spec.json'), JSON.stringify(spec));
  const cwd = process.cwd(); const disabled = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
  process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0'; process.chdir(directory);
  const root = process.cwd();
  const captures: Record<string, unknown> = {};
  try {
    const ctx = createCommandContext(); const commands = createCommandRegistry(ctx);
    captures.spec = await commands.execute('hv_spec', {});
    const project = ctx.repos.projects.findByName('companion-refresh') ?? ctx.repos.projects.create({ name: 'companion-refresh', defaultPlatform: 'cloudrun' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {} });
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'deploy' });
    ctx.repos.runs.updateStatus(run.id, 'succeeded');
    ctx.repos.connections.create({ provider: 'github', scope: 'example/companion-refresh', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-token' }) });
    captures.runs = await commands.execute('hv_runs', { action: 'list', project: project.name, limit: 10 });
    captures.connections = await commands.execute('hv_connections', { project: project.name });
    captures.catalog = await commands.execute('hv_connections', { repositoryContext: true });
  } finally {
    process.chdir(cwd);
    if (disabled === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC; else process.env.HYPERVIBE_DISABLE_REPO_SPEC = disabled;
  }
  // Row ids are random; number them in order of appearance so the capture is stable.
  const ids = new Map<string, string>();
  const serialized = (JSON.stringify(captures, null, 2) + '\n').replaceAll(root, '/repo').replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`);
    return ids.get(id)!;
  });
  if (process.env.HYPERVIBE_UPDATE_COMPANION_FIXTURES === '1') writeFileSync(refreshFixture, serialized);
  expect(serialized, 'Regenerate with HYPERVIBE_UPDATE_COMPANION_FIXTURES=1 npm test -- src/tools/__tests__/macos-status.contract.test.ts, then run the Swift contract tests.').toBe(readFileSync(refreshFixture, 'utf8'));
  expect(serialized).not.toContain('synthetic-token');
  expect(captures).toMatchObject({ spec: { ok: true }, runs: { ok: true }, connections: { ok: true }, catalog: { ok: true } });
});

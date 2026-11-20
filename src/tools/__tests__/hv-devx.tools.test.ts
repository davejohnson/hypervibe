import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDb, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { runPlanReportPath } from '../../adapters/storage/plan-report-files.js';
import { engineStatePaths } from '../../adapters/engine/opentofu/workspace.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { createToolContext } from '../../application/context.js';
import { registerHvDevxTools } from '../hv-devx.tools.js';
import { CommandRegistry } from '../../application/commands.js';
import { runCli } from '../../interfaces/cli/run.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-devx-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-devx-test', version: '1.0.0' });
  registerHvDevxTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'hv-devx-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function seedRuns() {
  const project = new ProjectRepository().create({ name: 'devx-app' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
  const runRepo = new RunRepository();
  const older = runRepo.create({ projectId: project.id, environmentId: environment.id, type: 'deploy', plan: { step: 'one' } });
  runRepo.updateStatus(older.id, 'succeeded');
  // created_at has millisecond precision; ensure a strict ordering between the two runs.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = runRepo.create({ projectId: project.id, environmentId: environment.id, type: 'deploy', plan: { step: 'two' } });
  runRepo.updateStatus(newer.id, 'failed', 'boom');
  return { project, environment, older, newer };
}

describe('hv_runs', () => {
  it('exports an earlier saved plan by its exact ID even when it predates HTML reports', async () => {
    const { project, environment, older } = await seedRuns();
    const oldId = '2aa09059-899d-4bab-b8f0-e5b2aba13316';
    const document = { kind: 'hv_plan', scope: 'full', specRevision: 1, observedFingerprint: null,
      environmentName: environment.name, actions: [{ id: 'service:original', type: 'create', verified: true,
        resource: { kind: 'service', name: 'original', provider: 'railway' }, reason: 'Create the original service.' }] };
    // Insert a pre-report row directly, as an older installed version would have saved it.
    getDb().prepare(`INSERT INTO runs (id, project_id, environment_id, type, status, plan, receipts, created_at)
      VALUES (?, ?, ?, 'plan', 'succeeded', ?, '[]', '2024-01-01T00:00:00.000Z')`)
      .run(oldId, project.id, environment.id, JSON.stringify(document));
    const newer = new RunRepository().create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { ...document, actions: [], specRevision: 2 } });
    expect(existsSync(runPlanReportPath(oldId))).toBe(false);
    expect(existsSync(runPlanReportPath(newer.id))).toBe(true);
    const t = await makeClient();
    try {
      const mismatched = await t.call('hv_runs', { action: 'report', runId: oldId, env: 'production' });
      expect(mismatched).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(existsSync(runPlanReportPath(oldId))).toBe(false);
      const result = await t.call('hv_runs', { action: 'report', runId: oldId });
      expect(result.data).toEqual({ planId: oldId, htmlPath: runPlanReportPath(oldId) });
      const html = readFileSync(result.data.htmlPath, 'utf8');
      expect(html).toContain('service:original');
      expect(html).toContain(oldId);
      expect(html).not.toContain(newer.id);
      expect(getDb().prepare('SELECT plan FROM runs WHERE id = ?').pluck().get(oldId)).toBe(JSON.stringify(document));
      const registry = new CommandRegistry();
      registerHvDevxTools(registry, createToolContext());
      let stdout = '';
      const exitCode = await runCli(['runs', '--action', 'report', '--run-id', oldId, '--json'], {
        registry, initialize: false,
        io: { writeOut: text => { stdout += text; }, writeErr: vi.fn(), readStdin: async () => '',
          confirm: async () => false, stdinIsTTY: false },
      });
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).data).toEqual(result.data);
      const nonPlan = await t.call('hv_runs', { action: 'report', runId: older.id });
      expect(nonPlan).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      const missingScope = await t.call('hv_runs', { action: 'report', runId: 'setup-abc' });
      expect(missingScope).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    } finally { await t.close(); }
  });

  it('explains the next steps and cost when reopening a saved Google Cloud setup plan', async () => {
    const { project, environment } = await seedRuns();
    // Redacted messages recorded in a 0.1.52 Google Cloud infrastructure report.
    const warnings = [
      'Infrastructure is planned by OpenTofu. Releasing application code is a separate step: run hv_deploy after this apply.',
      'Database: 1 vCPU, 3.75 GB, about US$50 a month plus storage. New databases start with 14 daily backups and 7 days of point-in-time recovery; existing backup and recovery settings are preserved. Deletion protection is on.',
      'Services are connected to the database in the next infrastructure plan, once Hypervibe has created its login. Run hv_plan scope="infrastructure" again after this apply.',
    ];
    const plan = { kind: 'hv_plan', scope: 'infrastructure-engine', environmentName: environment.name, warnings,
      actions: [
        { id: 'database:postgres', type: 'create', verified: true, resource: { kind: 'database', name: 'postgres', provider: 'gcp' } },
        { id: 'database-credential:postgres', type: 'create', verified: true, resource: { kind: 'secret', name: 'database login', provider: 'gcp' } },
        { id: 'service:web', type: 'create', verified: true, resource: { kind: 'service', name: 'web', provider: 'gcp' } },
      ] };
    const repo = new RunRepository();
    const saved = repo.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan });
    const t = await makeClient();
    try {
      const result = await t.call('hv_runs', { action: 'report', runId: saved.id });
      const html = readFileSync(result.data.htmlPath, 'utf8');
      expect(html).toContain('Database cost and protection');
      expect(html).toContain('US$50 a month plus storage');
      expect(html).toContain('14 daily backups');
      expect(html).toContain('7 days');
      expect(html).toContain('Deletion protection is on.');
      expect(html).toContain('What happens next');
      expect(html).toContain('your coding agent prepares');
      expect(html).toContain('need your approval');
      expect(html).toContain('Releasing the app, copying production data and switching live traffic are separate steps.');
      expect(html).not.toContain('Warnings (');
      expect(html).not.toContain('Run hv_plan');
      expect(html).not.toContain('run hv_deploy');
      expect(repo.findById(saved.id)?.plan).toEqual(plan);
    } finally { await t.close(); }
  });

  it('refreshes the report when saved actions change and rolls back a failed report write', async () => {
    const { project, environment } = await seedRuns();
    const repo = new RunRepository();
    const plan = { kind: 'hv_plan', scope: 'full', environmentName: environment.name, actions: [] };
    const input = { projectId: project.id, environmentId: environment.id, type: 'plan', plan };
    const run = repo.create(input);
    const htmlPath = runPlanReportPath(run.id);
    expect(readFileSync(htmlPath, 'utf8')).toContain(run.id);
    const revised = { ...plan, actions: [{ id: 'service:revised', type: 'update',
      resource: { kind: 'service', name: 'revised', provider: 'railway' }, verified: true, reason: 'Adjust the service.' }] };
    repo.updatePlan(run.id, revised);
    expect(readFileSync(htmlPath, 'utf8')).toContain('service:revised');
    // A regular file in place of the report directory is unwritable as a directory even under privileged CI.
    const directory = path.dirname(htmlPath);
    rmSync(directory, { recursive: true });
    writeFileSync(directory, '');
    expect(() => repo.updatePlan(run.id, plan)).toThrow();
    expect(repo.findById(run.id)?.plan).toEqual(revised);
    expect(() => repo.create(input)).toThrow();
    expect(repo.findByProjectId(project.id).filter(saved => saved.type === 'plan')).toHaveLength(1);
  });

  it('exports a saved setup plan only for its exact local project, cloud project, and plan ID', async () => {
    const { project } = await seedRuns();
    const other = new ProjectRepository().create({ name: 'other-app' });
    const gcpProjectId = 'fixture-cloud-project';
    const planId = 'setup-090357e3-40de-40dc-8072-f9715031bf02';
    const intent = '1'.repeat(64);
    const { plans } = engineStatePaths({ provider: 'gcp', projectId: project.id, environmentId: gcpProjectId,
      partition: 'project-shared' }, tempDir);
    mkdirSync(plans, { recursive: true });
    writeFileSync(path.join(plans, `setup-${intent}.json`), JSON.stringify({ intent, planId,
      configuration: { files: {} }, planned: { actions: [], blockers: [] } }));
    const t = await makeClient();
    vi.stubEnv('HYPERVIBE_DATA_DIR', tempDir);
    try {
      const input = { action: 'report', runId: planId, gcpProjectId, project: project.name };
      for (const wrong of [{ project: other.name }, { gcpProjectId: 'other-project' },
        { runId: 'setup-ea55653f-5c30-4f8e-a106-9070947c6a25' }]) {
        expect(await t.call('hv_runs', { ...input, ...wrong })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const result = await t.call('hv_runs', input);
      expect(result.data).toEqual({ planId, htmlPath: path.join(plans, `${planId}.html`) });
      expect(readFileSync(result.data.htmlPath, 'utf8')).toContain(gcpProjectId);
    } finally {
      vi.unstubAllEnvs();
      await t.close();
    }
  });

  it('lists seeded runs with the latest run surfaced first', async () => {
    const { newer } = await seedRuns();
    const t = await makeClient();

    const list = await t.call('hv_runs', { project: 'devx-app' });
    expect(list.ok).toBe(true);
    expect(list.data.count).toBe(2);
    expect(list.data.latest.id).toBe(newer.id);
    expect(list.data.latest.status).toBe('failed');
    expect(list.data.runs[0]).toMatchObject({
      id: newer.id,
      type: 'deploy',
      status: 'failed',
      project: 'devx-app',
      environment: 'staging',
      error: 'boom',
    });
    expect(list.hint).toContain(newer.id);
    await t.close();
  });

  it('hard-bounds run and audit output when a repository over-returns', async () => {
    const { project, newer, older } = await seedRuns();
    const findByProjectId = vi.spyOn(RunRepository.prototype, 'findByProjectId')
      .mockReturnValue([newer, older]);
    const eventOne = new AuditRepository().create({
      action: 'one',
      resourceType: 'run',
      resourceId: newer.id,
    });
    const eventTwo = new AuditRepository().create({
      action: 'two',
      resourceType: 'run',
      resourceId: older.id,
    });
    const findRecent = vi.spyOn(AuditRepository.prototype, 'findRecent')
      .mockReturnValue([eventOne, eventTwo]);
    const t = await makeClient();

    const runs = await t.call('hv_runs', { project: project.name, limit: 1 });
    const audit = await t.call('hv_runs', { action: 'audit', limit: 1 });

    expect(runs.data.runs).toHaveLength(1);
    expect(runs.data.count).toBe(1);
    expect(audit.data.events).toHaveLength(1);
    expect(audit.data.count).toBe(1);
    expect(findByProjectId).toHaveBeenCalledWith(project.id, 1);
    expect(findRecent).toHaveBeenCalledWith(1);
    await t.close();
  });

  it('gets a single run with plan and receipts', async () => {
    const { older } = await seedRuns();
    const t = await makeClient();

    const get = await t.call('hv_runs', { action: 'get', runId: older.id });
    expect(get.ok).toBe(true);
    expect(get.data.run.id).toBe(older.id);
    expect(get.data.run.status).toBe('succeeded');
    expect(get.data.run.plan).toEqual({ step: 'one' });
    expect(get.data.run.receipts).toEqual([]);

    const missing = await t.call('hv_runs', { action: 'get', runId: '00000000-0000-0000-0000-000000000000' });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe('NOT_FOUND');

    const noId = await t.call('hv_runs', { action: 'get' });
    expect(noId.ok).toBe(false);
    expect(noId.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('warns instead of rejecting a harmless limit on one run lookup', async () => {
    const { older } = await seedRuns();
    const t = await makeClient();

    const get = await t.call('hv_runs', { action: 'get', runId: older.id, limit: 1 });

    expect(get.ok).toBe(true);
    expect(get.data.run.id).toBe(older.id);
    expect(get.warnings).toEqual([
      'Ignored option for hv_runs action="get": limit. The requested read still completed.',
    ]);
    await t.close();
  });

  it('constrains run detail to the requested project and environment', async () => {
    const { older } = await seedRuns();
    const otherProject = new ProjectRepository().create({ name: 'other-devx-app' });
    new EnvironmentRepository().create({ projectId: otherProject.id, name: 'production' });
    const t = await makeClient();

    const wrongProject = await t.call('hv_runs', {
      action: 'get',
      runId: older.id,
      project: otherProject.name,
    });
    expect(wrongProject.ok).toBe(false);
    expect(wrongProject.error.code).toBe('NOT_FOUND');

    const wrongEnvironment = await t.call('hv_runs', {
      action: 'get',
      runId: older.id,
      project: 'devx-app',
      env: 'production',
    });
    expect(wrongEnvironment.ok).toBe(false);
    expect(wrongEnvironment.error.code).toBe('NOT_FOUND');

    const constrained = await t.call('hv_runs', {
      action: 'get',
      runId: older.id,
      project: 'devx-app',
      env: 'staging',
    });
    expect(constrained.ok).toBe(true);
    expect(constrained.data.run.id).toBe(older.id);
    await t.close();
  });

  it('redacts secret-bearing run plan fields', async () => {
    const project = new ProjectRepository().create({ name: 'redacted-runs-app' });
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    const run = new RunRepository().create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        overrides: {
          envVarKeys: ['DEBUG'],
          envVarsEncrypted: 'encrypted-debug-value',
          envFileKeys: ['SESSION_SECRET'],
          envFileVarsEncrypted: 'encrypted-env-file-value',
          delegatedSecretKeys: ['AI_API_KEY'],
          delegatedSecretVarsEncrypted: 'encrypted-delegated-value',
          futureCustomEncrypted: 'encrypted-future-value',
          safeMetadata: 'preserved',
        },
        steps: [
          { id: 'legacy', params: { vars: { SECRET_TOKEN: 'plaintext' }, keep: true } },
        ],
      },
    });
    const t = await makeClient();

    const get = await t.call('hv_runs', { action: 'get', runId: run.id });
    expect(get.ok).toBe(true);
    expect(get.data.run.plan.overrides).toEqual({
      envVarKeys: ['DEBUG'],
      envFileKeys: ['SESSION_SECRET'],
      delegatedSecretKeys: ['AI_API_KEY'],
      safeMetadata: 'preserved',
    });
    expect(get.data.run.plan.steps[0].params.vars).toEqual({ SECRET_TOKEN: '***' });
    expect(JSON.stringify(get.data.run.plan)).not.toContain('encrypted-debug-value');
    expect(JSON.stringify(get.data.run.plan)).not.toContain('encrypted-env-file-value');
    expect(JSON.stringify(get.data.run.plan)).not.toContain('encrypted-delegated-value');
    expect(JSON.stringify(get.data.run.plan)).not.toContain('encrypted-future-value');
    expect(JSON.stringify(get.data.run.plan)).not.toContain('plaintext');
    await t.close();
  });

  it('lists audit events via action="audit"', async () => {
    new AuditRepository().create({
      action: 'deploy.started',
      resourceType: 'run',
      resourceId: 'run-1',
      details: { foo: 'bar' },
    });
    const t = await makeClient();

    const audit = await t.call('hv_runs', { action: 'audit', auditAction: 'deploy.started' });
    expect(audit.ok).toBe(true);
    expect(audit.data.count).toBe(1);
    expect(audit.data.events[0]).toMatchObject({
      action: 'deploy.started',
      resourceType: 'run',
      resourceId: 'run-1',
      details: { foo: 'bar' },
    });

    const projectSelector = await t.call('hv_runs', {
      action: 'audit',
      project: 'devx-app',
    });
    expect(projectSelector.ok).toBe(false);
    expect(projectSelector.error.code).toBe('VALIDATION');

    const incompleteResource = await t.call('hv_runs', {
      action: 'audit',
      resourceType: 'run',
    });
    expect(incompleteResource.ok).toBe(false);
    expect(incompleteResource.error.code).toBe('VALIDATION');

    const conflictingFilters = await t.call('hv_runs', {
      action: 'audit',
      resourceType: 'run',
      resourceId: 'run-1',
      auditAction: 'deploy.started',
    });
    expect(conflictingFilters.ok).toBe(false);
    expect(conflictingFilters.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('rejects action-specific selectors and unbounded limits', async () => {
    const t = await makeClient();

    const runIdOnList = await t.call('hv_runs', { action: 'list', runId: 'run-1' });
    expect(runIdOnList.ok).toBe(false);
    expect(runIdOnList.error.code).toBe('VALIDATION');

    const environmentWithoutProject = await t.call('hv_runs', { action: 'list', env: 'staging' });
    expect(environmentWithoutProject.ok).toBe(false);
    expect(environmentWithoutProject.error.code).toBe('VALIDATION');

    const auditFilterOnGet = await t.call('hv_runs', {
      action: 'get',
      runId: 'run-1',
      auditAction: 'deploy.started',
    });
    expect(auditFilterOnGet.ok).toBe(false);
    expect(auditFilterOnGet.error.code).toBe('VALIDATION');

    const registry = new CommandRegistry();
    registerHvDevxTools(registry, createToolContext());
    const excessiveLimit = await registry.execute('hv_runs', { limit: 101 });
    expect(excessiveLimit.ok).toBe(false);
    expect(excessiveLimit.error?.code).toBe('VALIDATION');
    await t.close();
  });
});

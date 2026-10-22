import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter, getDb } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { runCli } from '../../interfaces/cli/run.js';
import { registerCommandRegistry } from '../../interfaces/mcp/adapter.js';
import { formatCommandResult } from '../presentation.js';
import type { Project } from '../../domain/entities/project.entity.js';

// Independent expectations: project-wide incident workflow requested by the user;
// Railway's 2026-10-21 disclosure recommends issuer revocation while deploys are
// paused. AWS IAM documents that replacing consumer configuration and revoking
// an issuer key are separate operations. No provider behavior is mocked here.
let root: string;
let ctx: ReturnType<typeof createCommandContext>;
let registry: ReturnType<typeof createCommandRegistry>;
let project: Project;
const plaintext = 'ordinary-value-that-must-stay-private';
const ciphertext = 'opaque-encrypted-credential-must-not-be-emitted';

function spec() {
  return projectSpecSchema.parse({ version: 1, project: 'rotation-app', gitRemoteUrl: 'https://github.com/example/rotation-app',
    github: { enabled: true, repository: 'example/rotation-app' },
    secrets: {
      API_KEY: { principal: 'owner', environments: ['staging', 'production'], githubActions: { repository: true, environments: ['production'] } },
      SESSION_KEY: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: ['production'] },
      ENCRYPTION_KEY: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', replacementPolicy: 'immutable', environments: ['production'] },
    },
    environments: {
      staging: { hosting: { provider: 'railway' }, services: { web: {} } },
      production: { hosting: { provider: 'railway' }, services: { web: {}, worker: { workloadKind: 'worker' } }, envVars: { UNCLASSIFIED: plaintext } },
    },
  });
}

async function run(input: Record<string, unknown> = {}) {
  return registry.execute('hv_rotation', { project: project.name, ...input });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hypervibe-rotation-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(root, 'test.db')).migrate();
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  ctx = createCommandContext();
  project = ctx.repos.projects.create({ name: 'rotation-app', gitRemoteUrl: 'https://github.com/example/rotation-app' });
  new ProjectSpecRepository().insert(project.id, 1, spec());
  ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: { projectId: 'exact-project', environmentId: 'exact-production' } });
  ctx.repos.connections.create({ provider: 'railway', credentialsEncrypted: ciphertext });
  registry = createCommandRegistry(ctx);
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(root, { recursive: true, force: true });
});

describe('project credential rotation workflow boundary', () => {
  it('prepares an honest offline process without issuing, installing, deploying or revoking keys', async () => {
    const fetch = vi.fn(() => { throw new Error('No provider request is authorized'); });
    vi.stubGlobal('fetch', fetch);
    const readSecretStore = vi.spyOn(ctx, 'secretStore', 'get');
    const ordinaryGet = vi.spyOn(SpecStore.prototype, 'get');
    const writesBefore = getDb().prepare('SELECT total_changes() AS n').get();
    const result = await run({ mode: 'incident' });
    expect(result).toMatchObject({ ok: true, data: {
      mode: 'incident', rotationPerformed: false, executable: false,
      coverage: { complete: false }, mutationCounts: { providerWrites: 0, localWorkflowWrites: 0, ciDispatches: 0 },
    } });
    expect((result.data as any).inventory.length).toBeGreaterThan(0);
    expect((result.data as any).blocked.length).toBeGreaterThan(0);
    expect(result.agentInstruction?.action).toBe('stop_and_report');
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(writesBefore);
    expect(fetch).not.toHaveBeenCalled();
    expect(readSecretStore).not.toHaveBeenCalled();
    expect(ordinaryGet).not.toHaveBeenCalled();
    for (const output of [JSON.stringify(result), formatCommandResult('hv_rotation', result)]) {
      expect(output).not.toContain(plaintext);
      expect(output).not.toContain(ciphertext);
      expect(output).not.toContain('ROTATION COMPLETE');
    }
    expect(formatCommandResult('hv_rotation', result)).toContain('No keys rotated');
    expect(formatCommandResult('hv_rotation', result)).toContain('rewrap');
  });

  it('saves and resumes one exact local snapshot idempotently without an executable plan', async () => {
    const first = await run({ action: 'start', mode: 'incident' });
    expect(first.ok).toBe(true);
    const data = first.data as any;
    expect(data.workflow.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(data.mutationCounts.localWorkflowWrites).toBe(1);
    expect(data).not.toHaveProperty('planId');
    expect(data).not.toHaveProperty('scopeFingerprint');
    expect(ctx.repos.runs.findByProjectId(project.id)).toEqual([]);
    const retry = await run({ action: 'start', mode: 'incident' });
    expect(retry).toMatchObject({ data: { workflow: { id: data.workflow.id }, mutationCounts: { localWorkflowWrites: 0 } } });
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(root, 'test.db')).migrate();
    ctx = createCommandContext(); registry = createCommandRegistry(ctx);
    const status = await run({ action: 'status', workflowId: data.workflow.id });
    expect(status).toMatchObject({ ok: true, data: { status: 'blocked', snapshotCurrent: true,
      workflow: { id: data.workflow.id }, rotationPerformed: false, mutationCounts: { localWorkflowWrites: 0 } } });
    expect((status.data as any).inventory).toEqual(data.inventory);
  });

  it('points to scoped database execution without reading private progress or claiming issuer support is absent everywhere', async () => {
    const components = vi.spyOn(ctx.repos.components, 'findByEnvironmentId').mockImplementation(() => {
      throw new Error('Preparation must not decrypt database credentials to report progress');
    });
    const secretStore = vi.spyOn(ctx, 'secretStore', 'get');
    const result = await run();
    expect(result).toMatchObject({ ok: true, data: {
      rotationPerformed: false, executable: false,
      scopedExecution: { credential: 'database-password', command: 'hv_plan', scope: 'database-rotation',
        availability: 'provider-dependent', prerequisites: 'unchecked', progress: 'not-inspected' },
    } });
    expect((result.data as any).blocked.find((blocker: any) => blocker.code === 'ROTATION_EXECUTION_UNSUPPORTED').message)
      .toContain('project-wide');
    expect(result.hint).toContain('Supabase');
    expect(result.hint).toContain('maintenance');
    expect(components).not.toHaveBeenCalled();
    expect(secretStore).not.toHaveBeenCalled();
  });

  it.each(['spec', 'binding', 'credential'] as const)('preserves original evidence and blocks after %s changes', async (change) => {
    const first = await run({ action: 'start', mode: 'routine' });
    const data = first.data as any;
    if (change === 'spec') {
      const changed = spec();
      if (changed.secrets.API_KEY.ownership === 'delegated') changed.secrets.API_KEY.principal = 'different-owner';
      new ProjectSpecRepository().insert(project.id, 2, changed);
    } else if (change === 'binding') {
      const environment = ctx.repos.environments.findByProjectId(project.id)[0];
      ctx.repos.environments.update(environment.id, { platformBindings: { projectId: 'replacement-project' } });
    } else {
      const connection = ctx.repos.connections.findByProvider('railway')!;
      ctx.repos.connections.updateCredentials(connection.id, 'different-ciphertext');
    }
    const status = await run({ action: 'status', workflowId: data.workflow.id });
    expect(status).toMatchObject({ ok: true, data: { status: 'stale', snapshotCurrent: false, rotationPerformed: false } });
    expect((status.data as any).inventory).toEqual(data.inventory);
    expect((status.data as any).blocked).toContainEqual(expect.objectContaining({ code: 'ROTATION_SCOPE_CHANGED' }));
  });

  it('never treats selecting a project as ownership of another project workflow', async () => {
    const first = await run({ action: 'start', mode: 'incident' });
    const other = ctx.repos.projects.create({ name: 'other-project' });
    const result = await registry.execute('hv_rotation', { project: other.name, action: 'status', workflowId: (first.data as any).workflow.id });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(JSON.stringify(result)).not.toContain('API_KEY');
  });

  it('reconstructs the original connection candidates after project repository metadata changes', async () => {
    const document = spec(); delete document.gitRemoteUrl; delete document.github;
    if (document.secrets.API_KEY.ownership === 'delegated') delete document.secrets.API_KEY.githubActions;
    new ProjectSpecRepository().insert(project.id, 2, projectSpecSchema.parse(document));
    ctx.repos.connections.create({ provider: 'railway', scope: 'example/rotation-app', credentialsEncrypted: 'original-scope-ciphertext' });
    const first = await run({ action: 'start', mode: 'incident' });
    const data = first.data as any;
    ctx.repos.projects.update(project.id, { gitRemoteUrl: 'https://github.com/different/new-repository' });
    const result = await run({ action: 'status', workflowId: data.workflow.id });
    expect(result).toMatchObject({ ok: true, data: { status: 'stale', snapshotCurrent: false } });
    expect((result.data as any).inventory).toEqual(data.inventory);
  });

  it('does not make another project credential update part of this workflow scope', async () => {
    const unrelated = ctx.repos.connections.create({ provider: 'railway', scope: 'another/project', credentialsEncrypted: 'unrelated-ciphertext' });
    const first = await run({ action: 'start', mode: 'incident' });
    ctx.repos.connections.updateCredentials(unrelated.id, 'updated-unrelated-ciphertext');
    const result = await run({ action: 'status', workflowId: (first.data as any).workflow.id });
    expect(result).toMatchObject({ ok: true, data: { snapshotCurrent: true, scopeCheck: 'current' } });
    expect(JSON.stringify(result)).not.toContain('another/project');
  });

  it('preserves connection candidates for a repository remote with a non-default port', async () => {
    const document = spec(); delete document.gitRemoteUrl; delete document.github;
    if (document.secrets.API_KEY.ownership === 'delegated') delete document.secrets.API_KEY.githubActions;
    new ProjectSpecRepository().insert(project.id, 2, projectSpecSchema.parse(document));
    ctx.repos.projects.update(project.id, { gitRemoteUrl: 'https://gitlab.example.test:8443/team/app.git' });
    ctx.repos.connections.create({ provider: 'railway', scope: 'gitlab.example.test/team/app', credentialsEncrypted: 'exact-port-scope-ciphertext' });
    const first = await run({ action: 'start', mode: 'incident' });
    const data = first.data as any;
    const result = await run({ action: 'status', workflowId: data.workflow.id });
    expect(result).toMatchObject({ ok: true, data: { snapshotCurrent: true } });
    expect((result.data as any).inventory).toEqual(data.inventory);
  });

  it('does not adopt repository edits while inspecting or preparing a workflow', async () => {
    mkdirSync(path.join(root, '.git')); mkdirSync(path.join(root, '.hypervibe'));
    const changed = spec(); changed.environments.production.envVars.UNCLASSIFIED = 'different-private-value';
    const file = path.join(root, '.hypervibe/spec.json');
    const bytes = JSON.stringify(changed); writeFileSync(file, bytes);
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
    const insert = vi.spyOn(ProjectSpecRepository.prototype, 'insert');
    for (const action of ['preview', 'start']) {
      const result = await runWithWorkspaceDirectories([root], () => run({ action, mode: 'incident' }));
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      expect(JSON.stringify(result)).not.toContain('different-private-value');
    }
    expect(insert).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(readdirSync(path.join(root, '.hypervibe'))).toEqual(['spec.json']);
  });

  it('does not bootstrap a legacy project, invent an empty scope or create missing environments', async () => {
    const legacy = ctx.repos.projects.create({ name: 'legacy', policies: { desiredState: { environmentName: 'production', services: ['web'] } } });
    const result = await registry.execute('hv_rotation', { project: legacy.name, action: 'start', mode: 'incident' });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(new ProjectSpecRepository().findLatest(legacy.id)).toBeNull();
    expect(ctx.repos.environments.findByProjectId(legacy.id)).toEqual([]);
    expect(ctx.repos.environments.findByProjectAndName(project.id, 'staging')).toBeNull();
  });

  it('keeps the saved original inventory inspectable when current repository state is unreadable', async () => {
    const first = await run({ action: 'start', mode: 'incident' });
    const data = first.data as any;
    mkdirSync(path.join(root, '.git')); mkdirSync(path.join(root, '.hypervibe'));
    const file = path.join(root, '.hypervibe/spec.json');
    writeFileSync(file, '{"token":"broken-private-input",');
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
    const result = await runWithWorkspaceDirectories([root], () => run({ action: 'status', workflowId: data.workflow.id }));
    expect(result).toMatchObject({ ok: true, data: { status: 'blocked', snapshotCurrent: false, scopeCheck: 'unknown' } });
    expect((result.data as any).inventory).toEqual(data.inventory);
    expect((result.data as any).blocked).toContainEqual(expect.objectContaining({ code: 'ROTATION_SCOPE_UNVERIFIED' }));
    expect(JSON.stringify(result)).not.toContain('broken-private-input');
    expect(readFileSync(file, 'utf8')).toBe('{"token":"broken-private-input",');
    expect(new ProjectSpecRepository().findLatest(project.id)?.revision).toBe(1);
  });

  it('preserves machine fields and destination identity when public config matches ordinary output text', async () => {
    const document = spec(); document.environments.production.envVars = { LABEL: 'id', NODE_ENV: 'production' };
    new ProjectSpecRepository().insert(project.id, 2, document);
    const first = await run({ action: 'start', mode: 'incident' });
    const data = first.data as any;
    expect(data.workflow.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(data.inventory.some((entry: any) => entry.destinations.some((destination: any) => destination.environment === 'production'))).toBe(true);
    expect(await run({ action: 'status', workflowId: data.workflow.id })).toMatchObject({ ok: true });
  });

  it('rejects execution, completion attestations and secret values instead of accepting unsupported authority', async () => {
    for (const input of [{ action: 'execute' }, { confirm: true }, { secretRefs: { API_KEY: 'env:PRIVATE' } },
      { completed: true }, { action: 'preview', workflowId: '11111111-1111-4111-8111-111111111111' },
      { action: 'status', mode: 'incident' }]) {
      expect(await run(input)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
  });

  it('routes the same workflow through the real MCP transport and CLI registry', async () => {
    const server = new McpServer({ name: 'rotation-test', version: '1' });
    registerCommandRegistry(server, registry);
    const client = new Client({ name: 'rotation-test-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'hv_rotation', arguments: { project: project.name, mode: 'incident' } });
      let stdout = ''; let stderr = '';
      const exit = await runCli(['rotation', '--project', project.name, '--mode', 'incident', '--json'], {
        registry, initialize: false, io: { writeOut: text => { stdout += text; }, writeErr: text => { stderr += text; },
          readStdin: async () => '', confirm: async () => false, stdinIsTTY: false },
      });
      expect(exit).toBe(0); expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toEqual(result.structuredContent);
      const tool = (await client.listTools()).tools.find(tool => tool.name === 'hv_rotation');
      expect(tool?.annotations?.readOnlyHint).toBe(false); // start writes local workflow state
    } finally { await client.close(); await server.close(); }
  });
});

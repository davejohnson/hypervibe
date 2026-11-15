import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { railwayHttpFixture, projectId, stagingId, productionId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { createCommandContext } from '../../application/context.js';
import { createCommandRegistry } from '../../application/commands.js';
import { registerCommandRegistry } from '../../interfaces/mcp/adapter.js';
import { runCli } from '../../interfaces/cli/run.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-alias-command-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
});

const canonical = 'synthetic-current-credential';
const previous = 'synthetic-previous-credential';
const reference = '${{POSTGRES_PASSWORD}}';
const uri = (password: string) => `postgresql://postgres:${password}@issuer.railway.internal:5432/postgres`;
function assertPrivate(response: unknown) {
  const text = JSON.stringify(response);
  for (const value of [canonical, previous, uri(canonical), uri(previous), uri(reference),
    'synthetic-contract-token', 'privateState', 'inspectionEncrypted',
    ...[canonical, previous, uri(canonical), uri(previous)].map(value => createHash('sha256').update(value).digest('hex'))]) {
    expect(text).not.toContain(value);
  }
}
async function setup(correct = false) {
  const wire = await railwayHttpFixture({ renderVariableReferences: true });
  wire.addService('staging-db', 'postgres-db', stagingId).instances.get(stagingId)!.source = { image: 'postgres:16' };
  wire.variables.set(`staging-db/${stagingId}`, { POSTGRES_PASSWORD: canonical,
    PGPASSWORD: correct ? reference : previous, DATABASE_URL: uri(correct ? reference : previous),
    DATABASE_PRIVATE_URL: uri(correct ? reference : previous), PGUSER: 'postgres', PGDATABASE: 'postgres', KEEP: 'preserved' });
  wire.variables.set(`production-postgres-db/${productionId}`, { POSTGRES_PASSWORD: 'other-environment-value' });
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'alias-command', defaultPlatform: 'railway' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'railway', projectId, environmentId: stagingId, services: { web: { serviceId: 'staging-web' } },
  } });
  ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'staging-db', bindings: {
    provider: 'railway', resourceKind: 'service', providerScope: { projectId, environmentId: stagingId },
  } });
  new SpecStore().replace(project, projectSpecSchema.parse({ version: 1, project: project.name, environments: { staging: {
    hosting: { provider: 'railway' }, services: { web: {} }, database: { provider: 'railway', credentialAliases: { mode: 'issuer-references' } },
  } } }));
  const connection = ctx.repos.connections.create({ provider: 'railway',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-contract-token' }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  const registry = createCommandRegistry(ctx);
  const server = new McpServer({ name: 'alias-command', version: '1' }); registerCommandRegistry(server, registry);
  const client = new Client({ name: 'alias-command-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { wire, project, registry, client, close: async () => { await client.close(); await server.close(); } };
}

// Actual command registration, redaction, MCP and CLI execution plus the real
// Railway adapter/factory and serialized pinned GraphQL boundary. Only HTTP is
// intercepted. Reference rendering is synthetic; no live resolution, SQL auth,
// deployed-container state or issuer-password rotation is claimed.
describe('Railway credential alias command contract', () => {
  it('exposes reviewed scope and verified counts through actual MCP without private evidence', async () => {
    const f = await setup();
    try {
      const plan = await f.client.callTool({ name: 'hv_plan', arguments: {
        project: f.project.name, env: 'staging', scope: 'database-credential-aliases',
      } });
      expect(plan.isError).not.toBe(true);
      const envelope = plan.structuredContent as any;
      expect(envelope).toMatchObject({ ok: true, data: { scope: 'database-credential-aliases', pendingActionCount: 1, blocked: [] } });
      expect(f.wire.mutations).toEqual([]); assertPrivate(plan);
      const applied = await f.client.callTool({ name: 'hv_apply', arguments: {
        project: f.project.name, planId: envelope.data.planId, confirmActions: envelope.data.actions.map((action: any) => action.id),
      } });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toMatchObject({ ok: true, data: { applied: true, receipts: [
        expect.objectContaining({ data: { requestedCount: 3, appliedCount: 3, skippedCount: 0,
          referencesVerified: true, deploymentDeferred: true, authentication: 'unchecked', applicationUse: 'unchecked' } }),
      ] } });
      const human = (applied.content as Array<{ type: string; text?: string }>).map(item => item.text ?? '').join('\n');
      expect(human).toContain('3 changed'); expect(human).toContain('0 skipped'); assertPrivate(applied);
      expect(f.wire.mutations).toEqual([{ field: 'variableCollectionUpsert', args: { input: {
        projectId, environmentId: stagingId, serviceId: 'staging-db', replace: false, skipDeploys: true,
        variables: { PGPASSWORD: reference, DATABASE_URL: uri(reference), DATABASE_PRIVATE_URL: uri(reference) },
      } } }]);
      expect(f.wire.variables.get(`production-postgres-db/${productionId}`)).toEqual({ POSTGRES_PASSWORD: 'other-environment-value' });
      expect(f.wire.contractErrors).toEqual([]);
    } finally { await f.close(); }
  });

  it('accepts the same scope through CLI and applies a verified MCP noop with zero provider writes', async () => {
    const f = await setup(true);
    try {
      expect(f.registry.get('hv_plan')!.inputSchema.safeParse({ project: f.project.name, env: 'staging', scope: 'database-credential-aliases' }).success).toBe(true);
      let stdout = ''; let stderr = '';
      const exitCode = await runCli(['plan', '--project', f.project.name, '--env', 'staging', '--scope', 'database-credential-aliases', '--json'], {
        registry: f.registry, initialize: false, io: { writeOut: text => { stdout += text; }, writeErr: text => { stderr += text; },
          readStdin: async () => '', confirm: async () => false, stdinIsTTY: false },
      });
      expect(exitCode).toBe(0); expect(stderr).toBe('');
      const plan = JSON.parse(stdout);
      expect(plan).toMatchObject({ ok: true, data: { scope: 'database-credential-aliases', pendingActionCount: 0, actions: [], blocked: [] } });
      assertPrivate(plan);
      const applied = await f.client.callTool({ name: 'hv_apply', arguments: { project: f.project.name, planId: plan.data.planId } });
      expect(applied.structuredContent).toMatchObject({ ok: true, data: { applied: true, receipts: [] } });
      assertPrivate(applied); expect(f.wire.mutations).toEqual([]); expect(f.wire.contractErrors).toEqual([]);
    } finally { await f.close(); }
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { railwayHttpFixture, projectId, productionId, stagingId, postgresTemplate } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { createCommandContext } from '../../application/context.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { buildDatabaseEnvVarsFromComponent } from '../../domain/services/database-env.js';
import { registerLifecycleTools } from '../lifecycle.tools.js';
import '../../application/providers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hv-database-import-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(dir, { recursive: true, force: true });
});

async function importClient() {
  const ctx = createCommandContext();
  const connection = ctx.repos.connections.create({ provider: 'railway',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-contract-token' }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  const server = new McpServer({ name: 'database-import-contract', version: '0.0.0' });
  registerLifecycleTools(createMcpCommandRegistrar(server), ctx);
  const client = new Client({ name: 'database-import-contract', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    ctx,
    call: (extra: Record<string, unknown> = {}) => client.callTool({ name: 'hv_import', arguments: {
      provider: 'railway', id: projectId,
      environmentMappings: { production: 'production', staging: 'staging' },
      databaseMappings: { 'database-service': 'postgres' }, confirm: true, ...extra,
    } }),
    close: async () => { await client.close(); await server.close(); },
  };
}

async function databaseFixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const wire = await railwayHttpFixture(options);
  wire.services.clear();
  const service = wire.addService('database-service', 'Postgres', productionId);
  service.instances.get(productionId)!.source = { image: 'ghcr.io/railwayapp-templates/postgres-ssl:18' };
  service.instances.set(stagingId, {
    ...service.instances.get(productionId)!, id: 'database-staging-instance', environmentId: stagingId,
  });
  return wire;
}

// Actual command/MCP, persisted binding, provider runtime projection and GraphQL
// serialization. Only HTTP is intercepted. The public template supplies the
// independent current-template variable keys; lifecycle values are synthetic.
describe('Railway database import runtime reference contract', () => {
  it('round-trips the official template without inventing a private alias, independently in both environments', async () => {
    const wire = await databaseFixture({ renderVariableReferences: true });
    const templateService = Object.values(postgresTemplate.serializedConfig.services)[0] as { variables: Record<string, unknown> };
    expect(templateService.variables.DATABASE_URL).toBeDefined();
    expect(templateService.variables.DATABASE_PRIVATE_URL).toBeUndefined();
    const secret = 'synthetic-import-password';
    wire.variables.set(`database-service/${productionId}`, {
      POSTGRES_PASSWORD: secret, PGPASSWORD: '${{POSTGRES_PASSWORD}}',
      DATABASE_URL: `postgresql://postgres:${secret}@production.internal:5432/app`,
    });
    // An older native template may still expose the private alias: image alone
    // must not choose which reference is safe for this environment.
    wire.variables.set(`database-service/${stagingId}`, {
      POSTGRES_PASSWORD: secret, PGPASSWORD: '${{POSTGRES_PASSWORD}}',
      DATABASE_URL: `postgresql://postgres:${secret}@staging.proxy:5432/app`,
      DATABASE_PRIVATE_URL: `postgresql://postgres:${secret}@staging.internal:5432/app`,
    });
    const command = await importClient();
    try {
      const response = await command.call();
      const envelope = response.structuredContent as { ok: boolean };
      expect(envelope.ok, JSON.stringify(response)).toBe(true);
      const project = command.ctx.repos.projects.findByName('contract-project')!;
      for (const [name, direct] of [['production', 'DATABASE_URL'], ['staging', 'DATABASE_PRIVATE_URL']] as const) {
        const env = command.ctx.repos.environments.findByProjectAndName(project.id, name)!;
        const component = command.ctx.repos.components.findByEnvironmentAndType(env.id, 'postgres')!;
        expect(component.bindings).toMatchObject({ directUrlVariable: direct });
        const environmentId = name === 'production' ? productionId : stagingId;
        expect(component.bindings.providerScope).toEqual({ projectId, environmentId });
        expect(buildDatabaseEnvVarsFromComponent(component).envVars).toEqual({
          DATABASE_URL: '${{Postgres.DATABASE_URL}}', DIRECT_URL: '${{Postgres.' + direct + '}}',
        });
        // The imported identity must immediately satisfy the existing exact
        // scope credential observer; no partial-scope repair or adoption is implied.
        const aliases = await wire.adapter.railwayCredentialAliases.inspect({ component, environment: env });
        expect(aliases.target).toEqual({ provider: 'railway', resourceId: 'database-service',
          providerScope: { projectId, environmentId } });
        expect(aliases.checkedNames).toContain('PGPASSWORD');
        expect(aliases.checkedNames).toContain(direct);
        expect(JSON.stringify(component.bindings)).not.toContain(secret);
      }
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(wire.requests.filter(request => request.query.includes('query GetVariables')).map(request => request.variables))
        .toEqual([
          { projectId, serviceId: 'database-service', environmentId: productionId },
          { projectId, serviceId: 'database-service', environmentId: stagingId },
        ]);
      expect(wire.contractErrors).toEqual([]);
      expect(wire.mutations).toEqual([]);
    } finally { await command.close(); }
  });

  it('selects an observed explicit direct alias only in the confirmed environment, leaving unmapped services unread', async () => {
    const wire = await databaseFixture();
    wire.addService('unmapped-db', 'reporting-postgres', productionId);
    wire.variables.set(`database-service/${productionId}`, {
      DATABASE_URL: 'synthetic-public-url', DATABASE_PRIVATE_URL: 'synthetic-private-url', DIRECT_URL: 'synthetic-direct-url',
    });
    const command = await importClient();
    try {
      const response = await command.call({ environmentMappings: { production: 'production' } });
      expect((response.structuredContent as { ok: boolean }).ok, JSON.stringify(response)).toBe(true);
      const project = command.ctx.repos.projects.findByName('contract-project')!;
      const env = command.ctx.repos.environments.findByProjectAndName(project.id, 'production')!;
      const component = command.ctx.repos.components.findByEnvironmentAndType(env.id, 'postgres')!;
      expect(component.bindings).toMatchObject({ directUrlVariable: 'DIRECT_URL' });
      expect(buildDatabaseEnvVarsFromComponent(component).envVars.DIRECT_URL).toBe('${{Postgres.DIRECT_URL}}');
      expect(command.ctx.repos.environments.findByProjectAndName(project.id, 'staging')).toBeNull();
      expect(wire.requests.filter(request => request.query.includes('query GetVariables')).map(request => request.variables))
        .toEqual([{ projectId, serviceId: 'database-service', environmentId: productionId }]);
      for (const value of Object.values(wire.variables.get(`database-service/${productionId}`)!)) {
        expect(JSON.stringify(response)).not.toContain(value);
        expect(JSON.stringify(component.bindings)).not.toContain(value);
      }
      expect(wire.mutations).toEqual([]);
      expect(wire.contractErrors).toEqual([]);
    } finally { await command.close(); }
  });

  it.each([
    ['missing DATABASE_URL', { DIRECT_URL: 'synthetic-url' }],
    ['empty DATABASE_URL', { DATABASE_URL: '', DIRECT_URL: 'synthetic-url' }],
    ['empty explicit direct alias', { DATABASE_URL: 'synthetic-url', DIRECT_URL: '', DATABASE_PRIVATE_URL: 'synthetic-private-url' }],
    ['empty private alias', { DATABASE_URL: 'synthetic-url', DATABASE_PRIVATE_URL: '' }],
  ] as Array<[string, Record<string, string>]>)('preserves all local state when a selected second environment has %s', async (_name, variables) => {
    const wire = await databaseFixture();
    wire.variables.set(`database-service/${productionId}`, { DATABASE_URL: 'synthetic-good-url' });
    wire.variables.set(`database-service/${stagingId}`, variables);
    const command = await importClient();
    try {
      const response = await command.call();
      expect((response.structuredContent as { ok: boolean }).ok).toBe(false);
      expect(command.ctx.repos.projects.findByName('contract-project')).toBeNull();
      expect(JSON.stringify(response)).not.toContain('synthetic-good-url');
      expect(JSON.stringify(response)).not.toContain('synthetic-private-url');
      expect(wire.mutations).toEqual([]);
    } finally { await command.close(); }
  });

  it.each(['null', 'omitted', 'non-string', 'denied'])('blocks %s variable evidence before adoption and hides provider values', async kind => {
    const secret = 'synthetic-provider-echoed-database-password';
    const wire = await databaseFixture({ responseOverride: request => {
      if (!request.query.includes('query GetVariables')) return undefined;
      if (kind === 'denied') return new Response(JSON.stringify({ errors: [{ message: secret }] }), { status: 403 });
      const data = kind === 'omitted' ? {}
        : { variables: kind === 'null' ? null : { DATABASE_URL: 123 } };
      return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
    } });
    const command = await importClient();
    try {
      const response = await command.call();
      expect((response.structuredContent as { ok: boolean }).ok).toBe(false);
      expect(command.ctx.repos.projects.findByName('contract-project')).toBeNull();
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(wire.mutations).toEqual([]);
    } finally { await command.close(); }
  });

  it('does not read database variable values before adoption confirmation', async () => {
    const wire = await databaseFixture();
    const command = await importClient();
    try {
      const response = await command.call({ confirm: false });
      expect(response.structuredContent).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
      expect(command.ctx.repos.projects.findByName('contract-project')).toBeNull();
      expect(wire.requests.filter(request => request.query.includes('query GetVariables'))).toEqual([]);
      expect(wire.mutations).toEqual([]);
    } finally { await command.close(); }
  });

  it.each(['Postgres${{OTHER}}', 'Postgres}', 'Postgres\nInjected'])('rejects an unsafe observed reference name before local adoption (%j)', async name => {
    const wire = await databaseFixture();
    wire.services.get('database-service')!.name = name;
    wire.variables.set(`database-service/${productionId}`, { DATABASE_URL: 'synthetic-url' });
    wire.variables.set(`database-service/${stagingId}`, { DATABASE_URL: 'synthetic-url' });
    const command = await importClient();
    try {
      const response = await command.call();
      expect(response.structuredContent).toMatchObject({ ok: false });
      expect(command.ctx.repos.projects.findByName('contract-project')).toBeNull();
      expect(JSON.stringify(response)).not.toContain(name);
      expect(wire.mutations).toEqual([]);
      expect(wire.contractErrors).toEqual([]);
    } finally { await command.close(); }
  });

  it('preserves accepted bindings when force-import cannot re-observe a selected reference', async () => {
    const wire = await databaseFixture();
    wire.variables.set(`database-service/${productionId}`, { DATABASE_URL: 'synthetic-url' });
    wire.variables.set(`database-service/${stagingId}`, { DATABASE_URL: 'synthetic-url' });
    const command = await importClient();
    try {
      expect((await command.call()).structuredContent).toMatchObject({ ok: true });
      const project = command.ctx.repos.projects.findByName('contract-project')!;
      const env = command.ctx.repos.environments.findByProjectAndName(project.id, 'production')!;
      const original = command.ctx.repos.components.findByEnvironmentAndType(env.id, 'postgres')!;
      wire.variables.set(`database-service/${productionId}`, { DATABASE_URL: 'synthetic-url', DIRECT_URL: '' });
      expect((await command.call({ force: true })).structuredContent).toMatchObject({ ok: false });
      expect(command.ctx.repos.components.findById(original.id)).toEqual(original);
      expect(wire.mutations).toEqual([]);
    } finally { await command.close(); }
  });
});

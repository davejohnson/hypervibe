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
import { railwayHttpFixture, projectId, stagingId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { createCommandContext } from '../../application/context.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { registerLifecycleTools } from '../lifecycle.tools.js';
import '../../application/providers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hv-inspection-output-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(dir, { recursive: true, force: true });
});

// The actual registered command, redacted envelope, MCP transport and Railway
// GraphQL client are exercised together. Only provider HTTP is intercepted by
// the pinned-schema fixture; these are synthetic values, not live credentials.
describe('Railway inspection public credential comparison contract', () => {
  it.each(['environment', 'database'])('preserves comparisons through MCP %s inspection without exposing their inputs', async resource => {
    const wire = await railwayHttpFixture();
    const current = 'synthetic-current:p@ssword';
    const previous = 'synthetic-previous:p@ssword';
    const url = (password: string) => `postgresql://postgres:${encodeURIComponent(password)}@postgres-db.railway.internal:5432/app`;
    wire.addService('staging-db', 'postgres-db', stagingId).instances.get(stagingId)!.source = { image: 'postgres:16' };
    wire.variables.set(`staging-db/${stagingId}`, {
      POSTGRES_PASSWORD: current, DATABASE_URL: url(previous), DATABASE_PRIVATE_URL: url(current),
      PGPASSWORD: previous, DIRECT_URL: url(current),
    });
    for (const name of ['web', 'worker', 'cron']) {
      wire.addService(`staging-${name}`, name, stagingId);
      wire.variables.set(`staging-${name}/${stagingId}`, {
        DATABASE_URL: name === 'cron' ? '${{postgres-db.DATABASE_URL}}' : url(name === 'web' ? previous : current),
        ...(name === 'web' ? { DIRECT_URL: url(previous) } : {}),
      });
    }

    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'inspection-contract', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'railway', projectId, environmentId: stagingId,
      services: Object.fromEntries(['web', 'worker', 'cron'].map(name => [name, { serviceId: `staging-${name}` }])),
    } });
    ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'staging-db',
      bindings: { provider: 'railway', projectId, providerScope: { projectId, environmentId: stagingId } } });
    for (const name of ['web', 'worker', 'cron']) ctx.repos.services.create({ projectId: project.id, name, buildConfig: {} });
    const connection = ctx.repos.connections.create({ provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-contract-token' }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');

    const server = new McpServer({ name: 'inspection-contract', version: '0.0.0' });
    registerLifecycleTools(createMcpCommandRegistrar(server), ctx);
    const client = new Client({ name: 'inspection-contract', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({ name: 'hv_inspect', arguments: {
        provider: 'railway', project: project.name, env: 'staging', resource,
      } });
      expect(response.isError).not.toBe(true);
      const envelope = response.structuredContent as { ok: boolean; data: { observed: { databases: Array<{ credentialAlignment: unknown }> } } };
      expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
      expect(envelope.data.observed.databases[0].credentialAlignment).toEqual({
        basis: 'configured-variable-values', authentication: 'unverified',
        issuer: { comparisons: [
          { source: 'DATABASE_URL', against: 'POSTGRES_PASSWORD', comparison: { result: 'mismatch' } },
          { source: 'DATABASE_PRIVATE_URL', against: 'POSTGRES_PASSWORD', comparison: { result: 'match' } },
          { source: 'PGPASSWORD', against: 'POSTGRES_PASSWORD', comparison: { result: 'mismatch' } },
          { source: 'DIRECT_URL', against: 'POSTGRES_PASSWORD', comparison: { result: 'match' } },
        ] },
        consumers: [
          { name: 'cron', externalId: 'staging-cron', source: 'DATABASE_URL', issuerSource: 'DATABASE_URL',
            credentialComparison: { result: 'unknown', reason: 'unresolved_reference' }, target: { result: 'unknown', reason: 'unresolved_reference' } },
          { name: 'web', externalId: 'staging-web', source: 'DATABASE_URL', issuerSource: 'DATABASE_URL',
            credentialComparison: { result: 'match' }, target: { result: 'match' } },
          { name: 'web', externalId: 'staging-web', source: 'DIRECT_URL', issuerSource: 'DIRECT_URL',
            credentialComparison: { result: 'mismatch' }, target: { result: 'match' } },
          { name: 'worker', externalId: 'staging-worker', source: 'DATABASE_URL', issuerSource: 'DATABASE_URL',
            credentialComparison: { result: 'mismatch' }, target: { result: 'match' } },
        ],
      });
      expect(Array.isArray(response.content)).toBe(true);
      const content = response.content as Array<{ type: string; text?: string }>;
      const text = content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
      expect(text).toContain('configured-variable-values; authentication unverified');
      expect(text).toContain('DATABASE_URL vs POSTGRES_PASSWORD: mismatch');
      expect(text).toContain('DATABASE_PRIVATE_URL vs POSTGRES_PASSWORD: match');
      expect(text).toContain('PGPASSWORD vs POSTGRES_PASSWORD: mismatch');
      expect(text).toContain('DIRECT_URL vs POSTGRES_PASSWORD: match');
      expect(text).toContain('web DATABASE_URL vs issuer DATABASE_URL: credentials match; target match');
      expect(text).toContain('web DIRECT_URL vs issuer DIRECT_URL: credentials mismatch; target match');
      expect(text).toContain('worker DATABASE_URL vs issuer DATABASE_URL: credentials mismatch; target match');
      expect(text).toContain('cron DATABASE_URL vs issuer DATABASE_URL: credentials unknown (unresolved_reference); target unknown (unresolved_reference)');
      const serialized = JSON.stringify(response);
      for (const secret of [current, previous, url(current), url(previous), 'synthetic-contract-token',
        encodeURIComponent(current), encodeURIComponent(previous),
        createHash('sha256').update(url(current)).digest('hex'), createHash('sha256').update(url(previous)).digest('hex')]) {
        expect(serialized).not.toContain(secret);
      }
      expect(JSON.stringify(envelope.data.observed.databases[0].credentialAlignment)).not.toContain('[redacted]');
      expect(wire.requests.filter(request => request.query.includes('query GetVariables'))).toHaveLength(4);
      expect(wire.contractErrors).toEqual([]);
      expect(wire.mutations).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

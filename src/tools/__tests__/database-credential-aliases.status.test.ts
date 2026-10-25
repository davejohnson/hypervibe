import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter, getDb } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../application/context.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { hashEnvValue } from '../../domain/ports/observe.port.js';
import type { IDatabaseAdapter } from '../../domain/ports/database.port.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { createServer } from '../../server.js';
import { parseToolEnvelope } from './tool-result.js';

let directory: string;
const secret = 'private-status-issuer-fixture';
const names = ['DATABASE_PRIVATE_URL', 'DATABASE_URL', 'PGPASSWORD'];
const target = { provider: 'railway', resourceId: 'database-id',
  providerScope: { projectId: 'provider-project', environmentId: 'provider-environment' } };

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-alias-status-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
});

// Public MCP status boundary with synthetic capability evidence. Native Railway
// serialization/reference resolution is covered separately by its API contract.
async function statusFixture(state: 'drift' | 'unknown' | 'verified', declared = true) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'alias-status', defaultPlatform: 'railway' });
  new SpecStore().replace(project, projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: {
    hosting: { provider: 'railway' }, services: { web: { startCommand: 'npm start' } },
    database: { provider: 'railway', ...(declared ? { credentialAliases: { mode: 'issuer-references' } } : {}) },
    backups: { mode: 'disabled', reason: 'Disposable status fixture without customer data.' },
  } } }));
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: target.providerScope.projectId, environmentId: target.providerScope.environmentId,
    services: { web: { serviceId: 'web-id' } },
  } });
  const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: target.resourceId,
    bindings: { provider: 'railway', resourceKind: 'service', providerScope: target.providerScope, pluginName: 'postgres-db' } });
  const connection = ctx.repos.connections.create({ provider: 'railway', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-token' }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
    projectId: target.providerScope.projectId, environmentId: target.providerScope.environmentId,
    services: [{ name: 'web', externalId: 'web-id', workloadKind: 'web', config: { startCommand: 'npm start' },
      customDomains: [], sourceState: 'disconnected', envVarKeys: ['DATABASE_URL', 'DIRECT_URL'],
      envVarHashes: { DATABASE_URL: hashEnvValue('synthetic-resolved-url'), DIRECT_URL: hashEnvValue('synthetic-resolved-url') },
      status: 'running' }],
    databases: [{ provider: 'railway', engine: 'postgres', externalId: target.resourceId,
      providerScope: target.providerScope, status: 'running' }],
    partial: false, warnings: [],
  } });
  const plan = vi.spyOn(PlanService.prototype, 'plan');
  const inspect = vi.fn(async () => {
    if (state === 'unknown') throw new Error(secret);
    return { target, checkedNames: names, changeNames: state === 'drift' ? names : [], privateState: { password: secret } };
  });
  const repair = vi.fn();
  vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true,
    adapter: { credentialAliases: { inspect, repair } } as unknown as IDatabaseAdapter });
  const before = { runs: getDb().prepare('SELECT COUNT(*) AS count FROM runs').get(),
    bindings: ctx.repos.components.findById(component.id)!.bindings };
  const server = createServer();
  const client = new Client({ name: 'alias-status-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({ name: 'hv_status', arguments: { project: project.name, env: 'production' } });
    expect(plan).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual(before.runs);
    expect(ctx.repos.components.findById(component.id)!.bindings).toEqual(before.bindings);
    expect(JSON.stringify(response)).not.toContain(secret);
    const envelope = parseToolEnvelope(response) as Record<string, any>;
    expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
    return { response, envelope, inspect };
  } finally {
    await client.close(); await server.close();
  }
}

describe('database credential aliases in public status', () => {
  it('reports stale declared aliases as drift without planning or repairing', async () => {
    const { response, envelope, inspect } = await statusFixture('drift');
    expect(envelope.ok).toBe(true);
    expect(envelope.data.inSync).toBe(false);
    expect(envelope.data.databaseAliases).toMatchObject({ state: 'drift', checkedNames: names, changeNames: names, authentication: 'unchecked' });
    expect(envelope.data.drift).toContainEqual(expect.objectContaining({ resource: { kind: 'database', provider: 'railway', name: 'postgres' } }));
    expect(JSON.stringify(response.content)).toContain('DRIFT DETECTED');
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('keeps failed alias observation unknown and never claims in sync', async () => {
    const { response, envelope } = await statusFixture('unknown');
    expect(envelope.ok).toBe(true);
    expect(envelope.data.inSync).toBe(false);
    expect(envelope.data.verified).toBe(false);
    expect(envelope.data.databaseAliases).toMatchObject({ state: 'unknown', authentication: 'unchecked' });
    expect(envelope.data.drift).toEqual([]);
    expect(JSON.stringify(response.content)).toContain('STATUS UNKNOWN');
  });

  it('reports verified references separately from unchecked SQL authentication', async () => {
    const { envelope } = await statusFixture('verified');
    expect(envelope.data.inSync).toBe(false);
    expect(envelope.data.databaseAliases).toMatchObject({ state: 'verified', checkedNames: names, changeNames: [], authentication: 'unchecked' });
    expect(envelope.data.databaseConsumers).toEqual(expect.arrayContaining([expect.objectContaining({ resolvedConfiguration: 'unknown', authentication: 'unchecked' })]));
  });

  it('does not inspect aliases without a declaration', async () => {
    const { envelope, inspect } = await statusFixture('unknown', false);
    expect(envelope.data.inSync, JSON.stringify(envelope.data)).toBe(false);
    expect(envelope.data.databaseAliases).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });
});

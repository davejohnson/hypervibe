import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { HYPERVIBE_VERSION } from '../../version.js';
import { createCommandContext } from '../../application/context.js';
import { createCommandRegistry } from '../../application/commands.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-server-contract-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

/** The pinned tool surface. Changing it is a deliberate, reviewed act. */
const EXPECTED_TOOLS = [
  // Core spec/plan/apply loop
  'hv_spec', 'hv_plan', 'hv_apply', 'hv_status', 'hv_inspect', 'hv_import', 'hv_destroy',
  // Connections
  'hv_connections',
  // Deploy + observability
  'hv_deploy', 'hv_rollback', 'hv_logs', 'hv_health',
  // Database
  'hv_db_query',
  // Secrets
  'hv_secrets',
  // CI
  'hv_ci_status', 'hv_ci_trigger',
  // App Store / iOS
  'hv_appstore_status', 'hv_appstore_submit',
  // DevX
  'hv_runs',
].sort();

async function makeClient() {
  const { createServer } = await import('../../server.js');
  const server = createServer();
  const client = new Client({ name: 'server-contract-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('server tool surface', () => {
  it('identifies the MCP server with the package version', async () => {
    const { client, server } = await makeClient();
    expect(client.getServerVersion()).toEqual({
      name: 'hypervibe',
      version: HYPERVIBE_VERSION,
    });
    await client.close();
    await server.close();
  });

  it('registers exactly the 19 pinned hv_* tools', async () => {
    const { client, server } = await makeClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
    expect(names).toHaveLength(19);
    expect(tools.find((tool) => tool.name === 'hv_ci_status')?.description).toContain(
      'Use this before gh, GitHub connectors/apps, browser/UI inspection, or direct GitHub API calls.'
    );
    expect(names).not.toContain('hv_db_migrate');
    await client.close();
    await server.close();
  });

  it('keeps registry, MCP ids, and friendly CLI routes in one-to-one parity', async () => {
    const registry = createCommandRegistry(createCommandContext());
    const definitions = registry.list();
    const ids = definitions.map((definition) => definition.id).sort();
    const cliPaths = definitions.map((definition) => definition.cliPath.join(' '));

    expect(ids).toEqual(EXPECTED_TOOLS);
    expect(new Set(cliPaths).size).toBe(19);
    expect(registry.get('hv_spec')?.cliPath).toEqual(['spec']);
    expect(registry.get('hv_connections')?.cliPath).toEqual(['connections']);
    expect(registry.get('hv_secrets')?.cliPath).toEqual(['secrets']);
    expect(registry.get('hv_connections')?.inputShape.project).toBeDefined();
    expect(registry.get('hv_secrets')?.inputShape.project).toBeDefined();
    expect(registry.get('hv_plan')?.cliPath).toEqual(['plan']);
    expect(registry.get('hv_db_query')?.cliPath).toEqual(['db', 'query']);
    expect(registry.get('hv_db_migrate')).toBeUndefined();
  });

  it('returns the same structured envelope through the registry and MCP', async () => {
    const registry = createCommandRegistry(createCommandContext());
    const direct = await registry.execute('hv_spec', { project: 'does-not-exist' });
    const { client, server } = await makeClient();
    const overMcp = parseToolEnvelope(await client.callTool({
      name: 'hv_spec',
      arguments: { project: 'does-not-exist' },
    }));

    expect(overMcp).toEqual(direct);
    await client.close();
    await server.close();
  });

  it('instructs agents to inspect managed deploys through Hypervibe', async () => {
    const { HYPERVIBE_SERVER_INSTRUCTIONS } = await import('../../server.js');
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'always inspect workflows, runs, jobs, and logs with hv_ci_status'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'Do not use gh, a GitHub connector/app, the GitHub UI, or direct GitHub API calls to inspect deploys.'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'follow or report its connection/error guidance instead of bypassing Hypervibe'
    );
  });

  it('every tool responds with the structured envelope on error paths', async () => {
    const { client, server } = await makeClient();
    // Representative spread across files: each must return the ok/error envelope, not a protocol error.
    const probes: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'hv_spec', args: { project: 'does-not-exist' } },
      { name: 'hv_plan', args: { project: 'does-not-exist' } },
      { name: 'hv_deploy', args: { project: 'does-not-exist' } },
      { name: 'hv_db_query', args: { project: 'does-not-exist', sql: 'SELECT 1' } },
      { name: 'hv_secrets', args: { project: 'does-not-exist', env: 'production' } },
      { name: 'hv_runs', args: { project: 'does-not-exist' } },
    ];
    for (const probe of probes) {
      const result = await client.callTool({ name: probe.name, arguments: probe.args });
      const body = parseToolEnvelope(result);
      expect(body.ok, `${probe.name} should return ok:false`).toBe(false);
      expect(body.error?.code, `${probe.name} should carry an error code`).toBeTruthy();
      expect(body.error?.message, `${probe.name} should carry an error message`).toBeTruthy();
      expect((result.content as Array<{ text: string }>)[0].text.trim().startsWith('{')).toBe(false);
    }
    await client.close();
    await server.close();
  });
});

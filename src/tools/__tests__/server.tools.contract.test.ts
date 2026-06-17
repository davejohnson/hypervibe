import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';

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
  'hv_spec_set', 'hv_spec_get', 'hv_plan', 'hv_apply', 'hv_status', 'hv_import', 'hv_destroy',
  // Connections
  'hv_connect', 'hv_connections_list',
  // Deploy + observability
  'hv_deploy', 'hv_rollback', 'hv_logs', 'hv_errors', 'hv_health',
  // Database
  'hv_db_query', 'hv_db_migrate', 'hv_db_url',
  // Secrets
  'hv_secrets_set', 'hv_secrets_get', 'hv_secrets_list', 'hv_secrets_sync',
  // Domains + email
  'hv_domain_setup', 'hv_dns_record', 'hv_email_setup', 'hv_email_forwarding', 'hv_email_send',
  // Payments
  'hv_payments_setup', 'hv_stripe_sync',
  // CI
  'hv_ci_setup', 'hv_ci_status', 'hv_ci_trigger',
  // App Store / iOS
  'hv_appstore_status', 'hv_testflight_upload', 'hv_testflight_distribute',
  'hv_appstore_submit', 'hv_appstore_assets', 'hv_appid_register', 'hv_xcode_deploy',
  // DevX
  'hv_tunnel', 'hv_local_bootstrap', 'hv_visualize', 'hv_runs',
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
  it('registers exactly the 42 pinned hv_* tools', async () => {
    const { client, server } = await makeClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
    expect(names).toHaveLength(42);
    await client.close();
    await server.close();
  });

  it('every tool responds with the structured envelope on error paths', async () => {
    const { client, server } = await makeClient();
    // Representative spread across files: each must return the ok/error envelope, not a protocol error.
    const probes: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'hv_spec_get', args: { project: 'does-not-exist' } },
      { name: 'hv_plan', args: { project: 'does-not-exist' } },
      { name: 'hv_deploy', args: { project: 'does-not-exist' } },
      { name: 'hv_db_url', args: { project: 'does-not-exist' } },
      { name: 'hv_secrets_sync', args: { project: 'does-not-exist' } },
      { name: 'hv_dns_record', args: { action: 'zones' } },
      { name: 'hv_email_setup', args: { domain: 'example.com' } },
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

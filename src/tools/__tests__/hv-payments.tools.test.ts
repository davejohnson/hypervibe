import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { StripeAdapter } from '../../adapters/providers/stripe/stripe.adapter.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { createToolContext } from '../context.js';
import { registerHvPaymentsTools } from '../hv-payments.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-payments-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();

  new ConnectionRepository().create({
    provider: 'stripe',
    credentialsEncrypted: getSecretStore().encryptObject({
      sandboxSecretKey: 'sk_test_abc',
      liveSecretKey: 'sk_live_abc',
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-payments-test', version: '1.0.0' });
  registerHvPaymentsTools(server, createToolContext());
  const client = new Client({ name: 'hv-payments-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content as Array<{ type: string; text: string }>)[0];
      return JSON.parse(content.text) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('hv_payments_setup', () => {
  it('lists webhooks for the resolved mode', async () => {
    const list = vi.spyOn(StripeAdapter.prototype, 'listWebhookEndpoints').mockResolvedValue([
      { id: 'we_1', url: 'https://app.example.com/webhooks/stripe', status: 'enabled', enabled_events: ['checkout.session.completed'], created: 1700000000 } as any,
    ]);
    const t = await makeClient();

    const res = await t.call('hv_payments_setup', { action: 'webhooks-list' });
    expect(res.ok).toBe(true);
    expect(res.data.mode).toBe('sandbox');
    expect(res.data.count).toBe(1);
    expect(res.data.webhooks[0]).toMatchObject({ id: 'we_1', status: 'enabled' });
    expect(list).toHaveBeenCalledWith('sandbox');

    const live = await t.call('hv_payments_setup', { action: 'webhooks-list', env: 'production' });
    expect(live.data.mode).toBe('live');
    await t.close();
  });

  it('creates a webhook and syncs the signing secret to the hosting provider', async () => {
    const project = new ProjectRepository().create({ name: 'pay-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { api: { serviceId: 'rs-1' } },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'api' });

    const upsert = vi.spyOn(StripeAdapter.prototype, 'upsertWebhookEndpoint').mockResolvedValue({
      endpoint: { id: 'we_new', url: 'https://pay-app.example.com/webhooks/stripe', status: 'enabled', enabled_events: ['checkout.session.completed'], created: 1700000000 } as any,
      action: 'created',
      secret: 'whsec_test',
    });
    const setEnvVars = vi.fn(async () => ({ success: true, message: 'ok' }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 'railway', setEnvVars } as any,
    });
    const t = await makeClient();

    const res = await t.call('hv_payments_setup', {
      project: 'pay-app',
      env: 'production',
      url: 'https://pay-app.example.com/webhooks/stripe',
    });
    expect(res.ok).toBe(true);
    expect(res.data.mode).toBe('live');
    expect(res.data.webhook).toMatchObject({ id: 'we_new', action: 'created' });
    expect(res.data.secretSynced).toBe(true);
    expect(res.data.envVar).toBe('STRIPE_WEBHOOK_SECRET');
    expect(upsert).toHaveBeenCalledWith('live', 'https://pay-app.example.com/webhooks/stripe', expect.any(Array), { description: 'pay-app - production' });
    expect(setEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'production' }),
      expect.objectContaining({ name: 'api' }),
      { STRIPE_WEBHOOK_SECRET: 'whsec_test' }
    );
    await t.close();
  });

  it('requires a url for setup', async () => {
    new ProjectRepository().create({ name: 'pay-app' });
    const t = await makeClient();
    const res = await t.call('hv_payments_setup', { project: 'pay-app' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION');
    await t.close();
  });
});

describe('hv_stripe_sync', () => {
  it('blocks clear-sandbox without confirm and deletes with confirm', async () => {
    vi.spyOn(StripeAdapter.prototype, 'listCustomers').mockResolvedValue([
      { id: 'cus_1', name: 'Test', email: 'test@example.com', created: 1700000000 } as any,
    ]);
    const clear = vi.spyOn(StripeAdapter.prototype, 'clearCustomers').mockResolvedValue({ deleted: 1, errors: [] });
    const t = await makeClient();

    const preview = await t.call('hv_stripe_sync', { action: 'clear-sandbox' });
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect(preview.error.details.count).toBe(1);
    expect(clear).not.toHaveBeenCalled();

    const confirmed = await t.call('hv_stripe_sync', { action: 'clear-sandbox', confirm: true });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data.deleted).toBe(1);
    expect(clear).toHaveBeenCalledWith('sandbox');
    await t.close();
  });

  it('returns a diff for sync with dryRun without writing anything', async () => {
    vi.spyOn(StripeAdapter.prototype, 'listProducts').mockImplementation(async (mode) =>
      mode === 'sandbox' ? [{ id: 'prod_a', name: 'Pro Plan', active: true } as any] : []
    );
    vi.spyOn(StripeAdapter.prototype, 'listPrices').mockResolvedValue([]);
    const syncData = vi.spyOn(StripeAdapter.prototype, 'syncData');
    const t = await makeClient();

    const res = await t.call('hv_stripe_sync', { action: 'sync', dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.data.sourceMode).toBe('sandbox');
    expect(res.data.targetMode).toBe('live');
    expect(res.data.diff.summary.productsToSync).toBe(1);
    expect(res.data.diff.products.toCreate).toEqual([{ id: 'prod_a', name: 'Pro Plan' }]);
    expect(syncData).not.toHaveBeenCalled();
    await t.close();
  });

  it('syncs data and reports created counts', async () => {
    const syncData = vi.spyOn(StripeAdapter.prototype, 'syncData').mockResolvedValue({
      products: { created: ['prod_a'], skipped: [], errors: [] },
      prices: { created: ['price_a', 'price_b'], skipped: [], errors: [] },
    } as any);
    const t = await makeClient();

    const res = await t.call('hv_stripe_sync', {});
    expect(res.ok).toBe(true);
    expect(res.data.products.created).toBe(1);
    expect(res.data.prices.created).toBe(2);
    expect(syncData).toHaveBeenCalledWith('sandbox', 'live', { preserveIds: true });
    await t.close();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';

type JsonObj = Record<string, unknown>;

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<JsonObj> {
  const result = await client.request(
    {
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    },
    CallToolResultSchema
  );
  const text = result.content.find((content) => content.type === 'text')?.text;
  if (!text) throw new Error(`Tool ${name} returned no text payload`);
  return JSON.parse(text) as JsonObj;
}

function cloudflareResponse<T>(result: T) {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
  };
}

describe('email routing tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-email-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));

    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();
    connectionRepo.create({
      provider: 'cloudflare',
      scope: 'example.com',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'cf-token' }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function createClient() {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'email-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { server, client };
  }

  function stubCloudflareEmailApi() {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;

      if (parsed.pathname === '/client/v4/zones' && parsed.searchParams.get('name') === 'example.com') {
        return Response.json(cloudflareResponse([{
          id: 'zone-123',
          name: 'example.com',
          status: 'active',
          paused: false,
          type: 'full',
          name_servers: ['a.ns.cloudflare.com'],
          account: { id: 'acct-123', name: 'Example Account' },
        }]));
      }

      if (parsed.pathname === '/client/v4/zones/zone-123/email/routing/rules' && method === 'GET') {
        return Response.json(cloudflareResponse([]));
      }

      if (parsed.pathname === '/client/v4/accounts/acct-123/email/routing/addresses' && method === 'GET') {
        return Response.json(cloudflareResponse([]));
      }

      if (parsed.pathname === '/client/v4/accounts/acct-123/email/routing/addresses' && method === 'POST') {
        expect(body).toEqual({ email: 'me@gmail.com' });
        return Response.json(cloudflareResponse({
          id: 'dest-123',
          email: 'me@gmail.com',
          verified: null,
        }));
      }

      if (parsed.pathname === '/client/v4/zones/zone-123/email/routing/dns' && method === 'POST') {
        return Response.json(cloudflareResponse({
          record: [{ type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net', priority: 10 }],
        }));
      }

      if (parsed.pathname === '/client/v4/zones/zone-123/email/routing/rules' && method === 'POST') {
        if (!body) throw new Error('Expected Cloudflare routing rule body');
        expect(body).toEqual({
          name: 'Forward support@example.com to me@gmail.com',
          enabled: true,
          matchers: [{
            type: 'literal',
            field: 'to',
            value: 'support@example.com',
          }],
          actions: [{
            type: 'forward',
            value: ['me@gmail.com'],
          }],
        });
        return Response.json(cloudflareResponse({
          id: 'rule-123',
          name: 'Forward support@example.com to me@gmail.com',
          enabled: true,
          matchers: body.matchers,
          actions: body.actions,
        }));
      }

      throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('creates a Cloudflare forwarding address and reports destination verification state', async () => {
    const fetchMock = stubCloudflareEmailApi();
    const { server, client } = await createClient();

    const payload = await callTool(client, 'email_address_create', {
      domain: 'example.com',
      address: 'support',
      forwardTo: 'me@gmail.com',
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(payload.provider).toBe('cloudflare');
    expect(payload.address).toBe('support@example.com');
    expect(payload.forwardTo).toBe('me@gmail.com');
    expect(payload.destinationCreated).toBe(true);
    expect(payload.destinationVerificationRequired).toBe(true);
    expect(payload.message).toBe('support@example.com was created, but me@gmail.com must accept Cloudflare\'s verification email before forwarding works.');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone-123/email/routing/rules',
      expect.objectContaining({ method: 'POST' })
    );

    await Promise.all([client.close(), server.close()]);
  });

  it('previews forwarding address creation without writing Cloudflare resources', async () => {
    const fetchMock = stubCloudflareEmailApi();
    const { server, client } = await createClient();

    const payload = await callTool(client, 'email_address_create', {
      domain: 'example.com',
      address: 'billing@example.com',
      forwardTo: 'me@gmail.com',
    });

    expect(payload.success).toBe(true);
    expect(payload.mode).toBe('preview');
    expect(payload.plannedChanges).toEqual([
      { action: 'enable_email_routing_dns', domain: 'example.com' },
      { action: 'create_destination', email: 'me@gmail.com' },
      { action: 'create_route', address: 'billing@example.com', forwardTo: 'me@gmail.com' },
    ]);
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone-123/email/routing/rules',
      expect.objectContaining({ method: 'POST' })
    );

    await Promise.all([client.close(), server.close()]);
  });

  it('configures a catch-all route', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;

      if (parsed.pathname === '/client/v4/zones' && parsed.searchParams.get('name') === 'example.com') {
        return Response.json(cloudflareResponse([{
          id: 'zone-123',
          name: 'example.com',
          status: 'active',
          paused: false,
          type: 'full',
          name_servers: [],
          account: { id: 'acct-123' },
        }]));
      }
      if (parsed.pathname === '/client/v4/accounts/acct-123/email/routing/addresses' && method === 'GET') {
        return Response.json(cloudflareResponse([{ id: 'dest-123', email: 'me@gmail.com', verified: '2026-06-09T00:00:00Z' }]));
      }
      if (parsed.pathname === '/client/v4/zones/zone-123/email/routing/dns' && method === 'POST') {
        return Response.json(cloudflareResponse({ record: [] }));
      }
      if (parsed.pathname === '/client/v4/zones/zone-123/email/routing/rules/catch_all' && method === 'PUT') {
        if (!body) throw new Error('Expected Cloudflare catch-all body');
        expect(body).toEqual({
          name: 'Catch-all forward to me@gmail.com',
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'forward', value: ['me@gmail.com'] }],
        });
        return Response.json(cloudflareResponse({
          id: 'catch-all',
          name: body.name,
          enabled: body.enabled,
          matchers: body.matchers,
          actions: body.actions,
        }));
      }
      throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { server, client } = await createClient();

    const payload = await callTool(client, 'email_catchall_set', {
      domain: 'example.com',
      action: 'forward',
      forwardTo: 'me@gmail.com',
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(payload.catchAll).toMatchObject({
      id: 'catch-all',
      enabled: true,
      forwardsTo: ['me@gmail.com'],
    });

    await Promise.all([client.close(), server.close()]);
  });
});

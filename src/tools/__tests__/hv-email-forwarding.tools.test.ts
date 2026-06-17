import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { createToolContext } from '../context.js';
import { registerHvEmailTools } from '../hv-email.tools.js';

type JsonObj = Record<string, any>;

function cloudflareResponse<T>(result: T) {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
  };
}

describe('hv_email_forwarding (Cloudflare email routing)', () => {
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
    const server = new McpServer({ name: 'hv-email-forwarding-test', version: '1.0.0' });
    registerHvEmailTools(server, createToolContext());
    const client = new Client({ name: 'email-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      server,
      client,
      async call(name: string, args: Record<string, unknown> = {}): Promise<JsonObj> {
        const result = await client.callTool({ name, arguments: args });
        return parseToolEnvelope(result) as JsonObj;
      },
    };
  }

  function stubCloudflareEmailApi(alias = 'support@example.com') {
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
          name: `Forward ${alias} to me@gmail.com`,
          enabled: true,
          matchers: [{
            type: 'literal',
            field: 'to',
            value: alias,
          }],
          actions: [{
            type: 'forward',
            value: ['me@gmail.com'],
          }],
        });
        return Response.json(cloudflareResponse({
          id: 'rule-123',
          name: `Forward ${alias} to me@gmail.com`,
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
    const { server, client, call } = await createClient();

    const payload = await call('hv_email_forwarding', {
      action: 'create',
      domain: 'example.com',
      address: 'support',
      forwardTo: 'me@gmail.com',
    });

    expect(payload.ok).toBe(true);
    expect(payload.data.domain).toBe('example.com');
    expect(payload.data.address).toBe('support@example.com');
    expect(payload.data.forwardTo).toBe('me@gmail.com');
    expect(payload.data.destinationCreated).toBe(true);
    expect(payload.data.destinationVerificationRequired).toBe(true);
    expect(payload.hint).toBe('me@gmail.com must accept Cloudflare\'s verification email before forwarding works.');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone-123/email/routing/rules',
      expect.objectContaining({ method: 'POST' })
    );

    await Promise.all([client.close(), server.close()]);
  });

  it('normalizes a fully-qualified alias when creating a forwarding address', async () => {
    const fetchMock = stubCloudflareEmailApi('billing@example.com');
    const { server, client, call } = await createClient();

    const payload = await call('hv_email_forwarding', {
      action: 'create',
      domain: 'example.com',
      address: 'billing@example.com',
      forwardTo: 'me@gmail.com',
    });

    expect(payload.ok).toBe(true);
    expect(payload.data.address).toBe('billing@example.com');
    expect(payload.data.forwardTo).toBe('me@gmail.com');
    expect(fetchMock).toHaveBeenCalledWith(
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
    const { server, client, call } = await createClient();

    const payload = await call('hv_email_forwarding', {
      action: 'catchall',
      domain: 'example.com',
      forwardTo: 'me@gmail.com',
    });

    expect(payload.ok).toBe(true);
    expect(payload.data.catchAll).toMatchObject({
      id: 'catch-all',
      enabled: true,
      forwardsTo: ['me@gmail.com'],
    });

    await Promise.all([client.close(), server.close()]);
  });
});

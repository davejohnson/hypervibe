import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';

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

describe('health tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-health-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createCloudRunProject(url = 'https://web.example.run.app') {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({
      name: 'health-project',
      defaultPlatform: 'cloudrun',
    });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: {
            serviceId: 'health-project-production-web',
            url,
          },
        },
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: {
        workloadKind: 'web',
        startCommand: 'npm start',
        healthCheckPath: '/api/health',
      },
      envVarSpec: {},
    });
  }

  it('checks the stored service health path and root route', async () => {
    createCloudRunProject();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://web.example.run.app/api/health') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://web.example.run.app/') {
        return new Response('', {
          status: 302,
          headers: { location: '/login', 'set-cookie': 'sid=secret; HttpOnly; Secure; SameSite=Lax' },
        });
      }
      throw new Error(`Unexpected health check request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createLegacyTestServer } = await import('./legacy-server.helper.js');
    const server = createLegacyTestServer();
    const client = new Client({ name: 'health-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'health_check', {
      projectName: 'health-project',
      environmentName: 'production',
      serviceName: 'web',
    });

    expect(payload.success).toBe(true);
    expect(payload.provider).toBe('cloudrun');
    expect(payload.baseUrl).toBe('https://web.example.run.app');
    const checks = payload.checks as Array<Record<string, unknown>>;
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      name: 'health',
      url: 'https://web.example.run.app/api/health',
      ok: true,
      status: 200,
      json: { ok: true },
    });
    expect(checks[1]).toMatchObject({
      name: 'root',
      url: 'https://web.example.run.app/',
      ok: true,
      status: 302,
    });
    expect((checks[1].setCookie as Record<string, unknown>).headers).toEqual([
      'sid=***; HttpOnly; Secure; SameSite=Lax',
    ]);

    await Promise.all([client.close(), server.close()]);
  });

  it('checks an explicit URL without requiring a project', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { createLegacyTestServer } = await import('./legacy-server.helper.js');
    const server = createLegacyTestServer();
    const client = new Client({ name: 'health-url-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'health_check', {
      url: 'https://example.com/api/health?ready=true',
    });

    expect(payload.success).toBe(true);
    const checks = payload.checks as Array<Record<string, unknown>>;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: 'health',
      url: 'https://example.com/api/health?ready=true',
      ok: true,
      status: 200,
      bodyPreview: 'ok',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/api/health?ready=true', expect.any(Object));

    await Promise.all([client.close(), server.close()]);
  });

  it('returns an actionable error when no service URL is stored', async () => {
    createCloudRunProject('');

    const { createLegacyTestServer } = await import('./legacy-server.helper.js');
    const server = createLegacyTestServer();
    const client = new Client({ name: 'health-missing-url-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'health_check', {
      projectName: 'health-project',
    });

    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('No public URL is stored for service web');

    await Promise.all([client.close(), server.close()]);
  });
});

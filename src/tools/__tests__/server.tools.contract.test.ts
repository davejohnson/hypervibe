import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';

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
  const text = result.content.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error(`Tool ${name} returned no text payload`);
  return JSON.parse(text) as JsonObj;
}

describe('server-level tools/call contracts', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-contract-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterAll(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('deploy returns project-not-found error via tools/call', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'contract-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'deploy', { projectName: 'missing-project' });
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('Project not found');

    await Promise.all([client.close(), server.close()]);
  });

  it('infra_apply returns preview mode with desired+plan', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'contract-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await callTool(client, 'project_create', { name: 'contract-infra-project' });
    const payload = await callTool(client, 'infra_apply', {
      projectName: 'contract-infra-project',
      confirm: false,
    });

    expect(payload.success).toBe(true);
    expect(payload.mode).toBe('preview');
    expect(typeof payload.desired).toBe('object');
    expect(Array.isArray(payload.plan)).toBe(true);

    await Promise.all([client.close(), server.close()]);
  });

  it('project_policy_set round-trips policy through project_policy_get', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'contract-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await callTool(client, 'project_create', { name: 'contract-policy-project' });
    const setPayload = await callTool(client, 'project_policy_set', {
      projectName: 'contract-policy-project',
      protectedEnvironments: ['production'],
      desiredState: { environmentName: 'staging', serviceName: 'web' },
    });
    expect(setPayload.success).toBe(true);

    const getPayload = await callTool(client, 'project_policy_get', { projectName: 'contract-policy-project' });
    expect(getPayload.success).toBe(true);
    const policies = getPayload.policies as JsonObj;
    expect(policies.protectedEnvironments).toEqual(['production']);
    expect((policies.desiredState as JsonObj).environmentName).toBe('staging');

    await Promise.all([client.close(), server.close()]);
  });

  it('secrets_sync returns project-not-found error via tools/call', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'contract-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'secrets_sync', { projectName: 'missing-project' });
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('Project not found');

    await Promise.all([client.close(), server.close()]);
  });

  it('logs provider matrix returns unsupported error for heroku on deployments/build', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'contract-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const createProjectPayload = await callTool(client, 'project_create', {
      name: 'contract-logs-heroku',
      defaultPlatform: 'heroku',
    });
    expect(createProjectPayload.success).toBe(true);

    const envPayload = await callTool(client, 'env_create', {
      projectName: 'contract-logs-heroku',
      name: 'staging',
    });
    expect(envPayload.success).toBe(true);

    // Ensure logs_build passes its service-binding precondition.
    const env = envPayload.environment as JsonObj;
    const envRepo = new EnvironmentRepository();
    envRepo.updatePlatformBindings(String(env.id), {
      services: { web: { serviceId: 'svc_test' } },
    });

    const depPayload = await callTool(client, 'logs_deployments', {
      projectName: 'contract-logs-heroku',
      environmentName: 'staging',
      serviceName: 'web',
    });
    expect(depPayload.success).toBe(false);
    expect(String(depPayload.error)).toContain('currently supports');
    expect(depPayload.provider).toBe('heroku');

    const buildPayload = await callTool(client, 'logs_build', {
      projectName: 'contract-logs-heroku',
      environmentName: 'staging',
      serviceName: 'web',
    });
    expect(buildPayload.success).toBe(false);
    expect(String(buildPayload.error)).toContain('currently supports');
    expect(buildPayload.provider).toBe('heroku');

    await Promise.all([client.close(), server.close()]);
  });
});

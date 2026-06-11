import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
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
  const text = result.content.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error(`Tool ${name} returned no text payload`);
  return JSON.parse(text) as JsonObj;
}

describe('gcp tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-gcp-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('previews cloud_prepare from the existing Cloud Run deploy connection', async () => {
    const projectRepo = new ProjectRepository();
    const connectionRepo = new ConnectionRepository();
    const project = projectRepo.create({
      name: 'hls-property-care',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'git@github.com:davejohnson/hls-property-care.git',
    });
    connectionRepo.create({
      provider: 'cloudrun',
      scope: 'davejohnson/hls-property-care',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'hls-property-care',
        region: 'us-central1',
        credentials: JSON.stringify({
          type: 'service_account',
          project_id: 'hls-property-care',
          private_key: 'not-used',
          client_email: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
        }),
      }),
    });

    expect(project.name).toBe('hls-property-care');

    const { createLegacyTestServer } = await import('./legacy-server.helper.js');
    const server = createLegacyTestServer();
    const client = new Client({ name: 'cloud-prepare-preview-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'cloud_prepare', {
      projectName: 'hls-property-care',
      provider: 'cloudrun',
    });

    expect(payload).toMatchObject({
      success: true,
      mode: 'preview',
      plan: {
        provider: 'cloudrun',
        version: 'gcp-cloudrun-v1',
        gcpProjectId: 'hls-property-care',
        deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
        member: 'serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      },
    });
    expect((payload.plan as { enableApis: string[] }).enableApis).toContain('cloudscheduler.googleapis.com');
    expect((payload.plan as { grantRoles: string[] }).grantRoles).toContain('roles/logging.viewAccessor');
    expect((payload.plan as { grantRoles: string[] }).grantRoles).toContain('roles/cloudscheduler.admin');

    await Promise.all([client.close(), server.close()]);
  });

  it('enables required APIs, grants deploy service account roles, and records preparation with a one-time admin token', async () => {
    const projectRepo = new ProjectRepository();
    const connectionRepo = new ConnectionRepository();
    const project = projectRepo.create({
      name: 'hls-property-care',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'git@github.com:davejohnson/hls-property-care.git',
    });
    connectionRepo.create({
      provider: 'cloudrun',
      scope: 'davejohnson/hls-property-care',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'hls-property-care',
        region: 'us-central1',
        credentials: JSON.stringify({
          type: 'service_account',
          project_id: 'hls-property-care',
          private_key: 'not-used',
          client_email: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
        }),
      }),
    });

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('serviceusage.googleapis.com') && url.endsWith(':enable') && method === 'POST') {
        return Response.json({ name: 'operations/enable-api', done: true });
      }
      if (url.endsWith(':getIamPolicy') && method === 'POST') {
        return Response.json({
          bindings: [{
            role: 'roles/run.admin',
            members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
          }],
        });
      }
      if (url.endsWith(':setIamPolicy') && method === 'POST') {
        return Response.json(JSON.parse(String(init?.body)).policy);
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createLegacyTestServer } = await import('./legacy-server.helper.js');
    const server = createLegacyTestServer();
    const client = new Client({ name: 'cloud-prepare-apply-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'cloud_prepare', {
      projectName: 'hls-property-care',
      provider: 'cloudrun',
      adminAccessToken: 'admin-token',
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(payload.enabledApis).toEqual(expect.arrayContaining([
      { service: 'cloudscheduler.googleapis.com', status: 'enabled' },
      { service: 'cloudresourcemanager.googleapis.com', status: 'enabled' },
    ]));
    expect(payload.grantedRoles).toEqual(expect.arrayContaining([
      'roles/logging.viewer',
      'roles/logging.viewAccessor',
      'roles/cloudscheduler.admin',
      'roles/cloudsql.client',
    ]));
    expect(payload.existingRoles).toEqual(['roles/run.admin']);
    expect(payload).toMatchObject({
      provider: 'cloudrun',
      version: 'gcp-cloudrun-v1',
    });

    const setIamCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith(':setIamPolicy') && init?.method === 'POST'
    );
    expect(setIamCall).toBeTruthy();
    const setIamBody = JSON.parse(String(setIamCall?.[1]?.body));
    const bindings = setIamBody.policy.bindings as Array<{ role: string; members: string[] }>;
    expect(bindings).toContainEqual({
      role: 'roles/logging.viewAccessor',
      members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
    });
    expect(bindings).toContainEqual({
      role: 'roles/cloudscheduler.admin',
      members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
    });

    const updatedProject = projectRepo.findById(project.id);
    expect(updatedProject?.policies.cloudPreparation).toMatchObject({
      cloudrun: {
        provider: 'cloudrun',
        version: 'gcp-cloudrun-v1',
        gcpProjectId: 'hls-property-care',
        deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      },
    });

    await Promise.all([client.close(), server.close()]);
  });
});

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
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import type { Service } from '../../domain/entities/service.entity.js';
import type { IHostingAdapter } from '../../domain/ports/hosting.port.js';

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

describe('hosting env var tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-hosting-env-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function setupCloudRunProject() {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();

    const project = projectRepo.create({
      name: 'cloudrun-integrations',
      defaultPlatform: 'cloudrun',
    });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
    });
    const service = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: {
        workloadKind: 'web',
        builder: 'dockerfile',
        startCommand: 'npm start',
      },
      envVarSpec: {},
    });
    connectionRepo.create({
      provider: 'sendgrid',
      credentialsEncrypted: secretStore.encryptObject({ apiKey: 'SG.test-key' }),
    });

    return { project, environment, service };
  }

  function stubCloudRunHostingAdapter(varsByService = new Map<string, Record<string, string>>()) {
    const setEnvCalls: Array<{ environment: Environment; service: Service; vars: Record<string, string> }> = [];
    const adapter: IHostingAdapter & {
      getServiceVariables: (environment: Environment, serviceName: string) => Promise<Record<string, string>>;
    } = {
      name: 'cloudrun',
      capabilities: {
        supportedBuilders: ['dockerfile'],
        supportsAutoWiring: false,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: false,
        managedTls: true,
        supportsAutoScaling: true,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return { success: true, message: 'bound' };
      },
      async deploy(service) {
        return {
          serviceId: service.id,
          externalId: `${service.name}-cloudrun`,
          status: 'deployed',
          receipt: { success: true, message: 'deployed' },
        };
      },
      async setEnvVars(environment, service, vars) {
        setEnvCalls.push({ environment, service, vars });
        varsByService.set(service.name, {
          ...(varsByService.get(service.name) ?? {}),
          ...vars,
        });
        return { success: true, message: 'vars synced' };
      },
      async getDeployStatus() {
        return { status: 'deployed' };
      },
      async getServiceVariables(_environment, serviceName) {
        return varsByService.get(serviceName) ?? {};
      },
    };

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: adapter as never,
    });

    return { setEnvCalls, varsByService };
  }

  function stubSendGridScopes(scopes: string[]) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://api.sendgrid.com/v3/scopes') {
        return new Response(JSON.stringify({ scopes }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected SendGrid request: ${url}`);
    }));
  }

  const sendGridSetupScopes = [
    'mail.send',
    'whitelabel.read',
    'whitelabel.create',
    'whitelabel.update',
    'user.email.read',
    'user.email.create',
    'user.email.update',
  ];

  it('sendgrid_setup syncs API key through the Cloud Run hosting adapter', async () => {
    await setupCloudRunProject();
    const { setEnvCalls } = stubCloudRunHostingAdapter();
    stubSendGridScopes(sendGridSetupScopes);

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'sendgrid-cloudrun-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'sendgrid_setup', {
      projectName: 'cloudrun-integrations',
      environmentName: 'production',
      serviceName: 'web',
    });

    expect(payload.success).toBe(true);
    expect(payload.apiKeySynced).toBe(true);
    expect(payload.hostingProvider).toBe('cloudrun');
    expect(setEnvCalls).toHaveLength(1);
    expect(setEnvCalls[0].vars).toEqual({ SENDGRID_API_KEY: 'SG.test-key' });

    await Promise.all([client.close(), server.close()]);
  });

  it('sendgrid_setup resolves the Cloud Run provider from generic bindings', async () => {
    const { environment } = await setupCloudRunProject();
    new EnvironmentRepository().update(environment.id, {
      platformBindings: {
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
    });
    const { setEnvCalls } = stubCloudRunHostingAdapter();
    stubSendGridScopes(sendGridSetupScopes);

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'sendgrid-stale-railway-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'sendgrid_setup', {
      projectName: 'cloudrun-integrations',
      environmentName: 'production',
      serviceName: 'web',
    });

    expect(payload.success).toBe(true);
    expect(payload.hostingProvider).toBe('cloudrun');
    expect(String(payload.apiKeySyncError ?? '')).not.toContain('Railway');
    expect(setEnvCalls).toHaveLength(1);

    await Promise.all([client.close(), server.close()]);
  });

  it('sendgrid_setup rejects keys that cannot authorize a sender email', async () => {
    await setupCloudRunProject();
    const { setEnvCalls } = stubCloudRunHostingAdapter();
    stubSendGridScopes(['mail.send']);

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'sendgrid-cloudrun-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'sendgrid_setup', {
      projectName: 'cloudrun-integrations',
      environmentName: 'production',
      serviceName: 'web',
    });

    expect(payload.success).toBe(false);
    expect(payload.setupReady).toBe(false);
    expect(payload.canAuthorizeSenderEmail).toBe(false);
    expect(payload.missingScopes).toEqual({
      domainAuthentication: ['whitelabel.read', 'whitelabel.create', 'whitelabel.update'],
      senderVerification: ['user.email.read', 'user.email.create', 'user.email.update'],
    });
    expect(setEnvCalls).toHaveLength(0);

    await Promise.all([client.close(), server.close()]);
  });

  it('sendgrid_permissions_check reports setup-ready scoped keys', async () => {
    await setupCloudRunProject();
    stubCloudRunHostingAdapter();
    stubSendGridScopes(['mail.send', 'user.email.read', 'user.email.create', 'user.email.update']);

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'sendgrid-permissions-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'sendgrid_permissions_check', {
      projectName: 'cloudrun-integrations',
    });

    expect(payload.success).toBe(true);
    expect(payload.setupReady).toBe(true);
    expect(payload.canAuthorizeSenderEmail).toBe(true);
    expect(payload.canManageSenderVerification).toBe(true);
    expect(payload.canManageDomainAuthentication).toBe(false);

    await Promise.all([client.close(), server.close()]);
  });

  it('sendgrid_sender_verify_request previews Single Sender authorization', async () => {
    await setupCloudRunProject();
    stubCloudRunHostingAdapter();
    stubSendGridScopes(['user.email.read', 'user.email.create', 'user.email.update']);

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'sendgrid-sender-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'sendgrid_sender_verify_request', {
      projectName: 'cloudrun-integrations',
      fromEmail: 'sender@example.com',
    });

    expect(payload.success).toBe(true);
    expect(payload.mode).toBe('preview');
    expect(payload.plannedAction).toEqual({
      action: 'create_sender_verification_request',
      fromEmail: 'sender@example.com',
      replyTo: 'sender@example.com',
      nickname: 'sender@example.com',
    });

    await Promise.all([client.close(), server.close()]);
  });

  it('integration_sync writes Stripe keys through the Cloud Run hosting adapter', async () => {
    await setupCloudRunProject();
    const { setEnvCalls } = stubCloudRunHostingAdapter();

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'integration-cloudrun-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'integration_sync', {
      provider: 'stripe',
      projectName: 'cloudrun-integrations',
      targetEnvironments: ['production'],
      serviceName: 'web',
      keys: {
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
      },
    });

    expect(payload.success).toBe(true);
    expect(setEnvCalls).toHaveLength(1);
    expect(setEnvCalls[0].vars).toEqual({
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
    });
    const results = payload.results as Array<Record<string, unknown>>;
    expect(results[0].provider).toBe('cloudrun');

    await Promise.all([client.close(), server.close()]);
  });

  it('vars_get reads Cloud Run service variables through the hosting adapter', async () => {
    await setupCloudRunProject();
    stubCloudRunHostingAdapter(new Map([
      ['web', {
        STRIPE_SECRET_KEY: 'sk_test_secret',
        PUBLIC_VALUE: 'visible',
      }],
    ]));

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'vars-get-cloudrun-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'vars_get', {
      projectName: 'cloudrun-integrations',
      environmentName: 'production',
      serviceName: 'web',
    });

    expect(payload.success).toBe(true);
    expect(payload.provider).toBe('cloudrun');
    expect(payload.variables).toEqual({
      STRIPE_SECRET_KEY: '***',
      PUBLIC_VALUE: 'visible',
    });

    await Promise.all([client.close(), server.close()]);
  });
});

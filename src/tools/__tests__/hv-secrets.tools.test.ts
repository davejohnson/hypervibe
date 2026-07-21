import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import * as hostingEnv from '../../domain/services/hosting-env.service.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { createToolContext } from '../context.js';
import { registerHvSecretsTools } from '../hv-secrets.tools.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-secrets-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  delete process.env.COMPANION_TEST_API_KEY;
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-secrets-test', version: '1.0.0' });
  registerHvSecretsTools(server, createToolContext());
  const client = new Client({ name: 'hv-secrets-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('hv_secrets_set target=mapping', () => {
  it('creates, lists, and removes a mapping', async () => {
    new ProjectRepository().create({ name: 'secrets-app' });
    const t = await makeClient();

    const created = await t.call('hv_secrets_set', {
      project: 'secrets-app',
      target: 'mapping',
      key: 'API_KEY',
      secretRef: 'vault://apps/prod#API_KEY',
      environments: ['production'],
    });
    expect(created.ok).toBe(true);
    expect(created.data.mapping.secretRef).toBe('vault://apps/prod#API_KEY');
    expect(created.next).toContain('hv_secrets_sync');

    const list = await t.call('hv_secrets_list', { project: 'secrets-app' });
    expect(list.ok).toBe(true);
    expect(list.data.mappings).toContainEqual(expect.objectContaining({ envVar: 'API_KEY' }));

    const removed = await t.call('hv_secrets_set', {
      project: 'secrets-app',
      target: 'mapping',
      key: 'API_KEY',
      remove: true,
    });
    expect(removed.ok).toBe(true);

    const after = await t.call('hv_secrets_list', { project: 'secrets-app' });
    expect(after.data.mappings).toEqual([]);
    await t.close();
  });

  it('rejects malformed secret refs', async () => {
    new ProjectRepository().create({ name: 'secrets-bad-app' });
    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: 'secrets-bad-app',
      target: 'mapping',
      key: 'API_KEY',
      secretRef: 'not-a-ref',
    });
    expect(result.ok).toBe(false);
    await t.close();
  });
});

describe('hv_secrets_set target=github', () => {
  it('sets a GitHub Actions secret from a dotenv secretRef without echoing the value', async () => {
    new ProjectRepository().create({
      name: 'github-secret-app',
      gitRemoteUrl: 'https://github.com/davejohnson/github-secret-app',
    });
    const github = new ConnectionRepository().create({
      provider: 'github',
      scope: 'davejohnson/github-secret-app',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gh-token' }),
    });
    new ConnectionRepository().updateStatus(github.id, 'verified');
    const envPath = path.join(tempDir, '.env');
    writeFileSync(envPath, 'GHCR_TOKEN=ghp_secret_value\n');
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();
    const t = await makeClient();

    const result = await t.call('hv_secrets_set', {
      project: 'github-secret-app',
      target: 'github',
      key: 'IMAGE_REGISTRY_TOKEN',
      secretRef: `dotenv:${envPath}#GHCR_TOKEN`,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      repository: 'davejohnson/github-secret-app',
      secretName: 'IMAGE_REGISTRY_TOKEN',
      action: 'set',
      valueSource: 'dotenv',
    });
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'github-secret-app', 'IMAGE_REGISTRY_TOKEN', 'ghp_secret_value');
    expect(JSON.stringify(result)).not.toContain('ghp_secret_value');
    await t.close();
  });
});

describe('hv_secrets_set validation', () => {
  it('requires provider/path for manager writes', async () => {
    const t = await makeClient();
    const result = await t.call('hv_secrets_set', { target: 'manager', key: 'X', value: 'y' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('requires a verified manager connection', async () => {
    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      target: 'manager',
      provider: 'vault',
      path: 'apps/prod',
      key: 'X',
      value: 'y',
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('MISSING_CONNECTION');
    expect(result.hint).toContain('hv_connect');
    await t.close();
  });
});

describe('hv_secrets_sync', () => {
  it('reports unsupported rotation providers', async () => {
    new ProjectRepository().create({ name: 'rotate-app' });
    const t = await makeClient();
    const result = await t.call('hv_secrets_sync', {
      project: 'rotate-app',
      rotate: { provider: 'vault', path: 'apps/prod' },
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNSUPPORTED');
    await t.close();
  });

  it('dry-runs with no mappings as an empty sync', async () => {
    new ProjectRepository().create({ name: 'empty-sync-app' });
    const t = await makeClient();
    const result = await t.call('hv_secrets_sync', { project: 'empty-sync-app', dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.data.environments).toEqual([]);
    await t.close();
  });
});

describe('hv_secrets_set target=hosting value sources', () => {
  function seedHostingProject() {
    const project = new ProjectRepository().create({ name: 'hosting-secrets-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    return project;
  }

  it('uses repo-backed desired service metadata when the local service cache is empty', async () => {
    const project = new ProjectRepository().create({
      name: 'repo-backed-secrets-app',
      defaultPlatform: 'cloudrun',
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'cloudrun' },
          services: { worker: { workloadKind: 'worker', startCommand: 'npm run worker' } },
        },
      },
    });
    vi.spyOn(SpecStore.prototype, 'get').mockReturnValue({ spec, revision: 1 });
    const sync = vi.spyOn(hostingEnv, 'syncHostingEnvVars').mockResolvedValue({ success: true, message: 'ok' });

    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: project.name,
      env: 'production',
      service: 'worker',
      key: 'API_KEY',
      secretRef: 'env:COMPANION_TEST_API_KEY',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(sync).not.toHaveBeenCalled();

    process.env.COMPANION_TEST_API_KEY = 'from-local-environment';
    const retry = await t.call('hv_secrets_set', {
      project: project.name,
      env: 'production',
      service: 'worker',
      key: 'API_KEY',
      secretRef: 'env:COMPANION_TEST_API_KEY',
    });
    delete process.env.COMPANION_TEST_API_KEY;

    expect(retry.ok).toBe(true);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({
      service: expect.objectContaining({
        name: 'worker',
        buildConfig: expect.objectContaining({ workloadKind: 'worker' }),
      }),
      vars: { API_KEY: 'from-local-environment' },
    }));
    await t.close();
  });

  it('reads hosting variables using repo-backed service metadata on a fresh local cache', async () => {
    const project = new ProjectRepository().create({
      name: 'repo-backed-secrets-read-app',
      defaultPlatform: 'railway',
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web' } },
        },
      },
    });
    vi.spyOn(SpecStore.prototype, 'get').mockReturnValue({ spec, revision: 1 });
    const read = vi.spyOn(hostingEnv, 'readHostingEnvVars').mockResolvedValue({
      success: true,
      provider: 'railway',
      variables: { API_KEY: 'provider-secret-value' },
    });

    const t = await makeClient();
    const result = await t.call('hv_secrets_get', {
      project: project.name,
      env: 'staging',
      service: 'web',
    });

    expect(result.ok).toBe(true);
    expect(result.data.vars).toEqual({ API_KEY: 'pr************ue' });
    expect(JSON.stringify(result)).not.toContain('provider-secret-value');
    expect(read).toHaveBeenCalledWith(expect.objectContaining({
      service: expect.objectContaining({ name: 'web', projectId: project.id }),
    }));
    await t.close();
  });

  it('reuses one generated value across explicit environment and service destinations', async () => {
    const project = seedHostingProject();
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const sync = vi.spyOn(hostingEnv, 'syncHostingEnvVars').mockResolvedValue({
      success: true,
      message: 'ok',
    });

    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: project.name,
      destinations: [
        { env: 'staging', service: 'web' },
        { env: 'production', service: 'web' },
      ],
      key: 'SESSION_SECRET',
      generate: true,
      generateLength: 32,
    });

    expect(result.ok).toBe(true);
    expect(result.data.destinations).toEqual([
      { environment: 'staging', service: 'web' },
      { environment: 'production', service: 'web' },
    ]);
    expect(sync).toHaveBeenCalledTimes(2);
    const firstValue = sync.mock.calls[0][0].vars.SESSION_SECRET;
    const secondValue = sync.mock.calls[1][0].vars.SESSION_SECRET;
    expect(firstValue).toHaveLength(32);
    expect(secondValue).toBe(firstValue);
    expect(JSON.stringify(result)).not.toContain(firstValue);
    await t.close();
  });

  it('stops a shared write after a provider failure and reports partial progress', async () => {
    const project = seedHostingProject();
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'preview' });
    const sync = vi.spyOn(hostingEnv, 'syncHostingEnvVars')
      .mockResolvedValueOnce({ success: true, message: 'ok' })
      .mockResolvedValueOnce({ success: false, message: 'blocked', error: 'provider rejected write' })
      .mockResolvedValueOnce({ success: true, message: 'must not run' });

    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: project.name,
      destinations: [
        { env: 'staging', service: 'web' },
        { env: 'production', service: 'web' },
        { env: 'preview', service: 'web' },
      ],
      key: 'FEATURE_FLAG',
      value: 'enabled',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.message).toContain('staging/web before the failure');
    expect(result.error.message).toContain('no later destinations were attempted');
    expect(result.error.details).toEqual({
      applied: [{ environment: 'staging', service: 'web' }],
      failed: { environment: 'production', service: 'web' },
    });
    expect(sync).toHaveBeenCalledTimes(2);
    await t.close();
  });

  it('validates every shared destination before changing any provider state', async () => {
    const project = seedHostingProject();
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const sync = vi.spyOn(hostingEnv, 'syncHostingEnvVars').mockResolvedValue({
      success: true,
      message: 'must not run',
    });

    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: project.name,
      destinations: [
        { env: 'staging', service: 'web' },
        { env: 'missing', service: 'web' },
      ],
      key: 'FEATURE_FLAG',
      value: 'enabled',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(sync).not.toHaveBeenCalled();
    await t.close();
  });

  it('warns loudly when a raw value is passed through chat', async () => {
    seedHostingProject();
    const sync = vi.spyOn(hostingEnv, 'syncHostingEnvVars').mockResolvedValue({ success: true, message: 'ok' });

    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: 'hosting-secrets-app',
      env: 'production',
      key: 'SESSION_SECRET',
      value: 'raw-secret-passed-in-chat',
    });

    expect(result.ok).toBe(true);
    expect(result.data.valueSource).toBe('raw');
    expect(result.warnings.join(' ')).toContain('passed through chat');
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ vars: { SESSION_SECRET: 'raw-secret-passed-in-chat' } }));
    await t.close();
  });

  it('resolves secretRef locally so the value never enters chat', async () => {
    seedHostingProject();
    const sync = vi.spyOn(hostingEnv, 'syncHostingEnvVars').mockResolvedValue({ success: true, message: 'ok' });
    const envFile = path.join(tempDir, '.env');
    writeFileSync(envFile, 'SESSION_SECRET=from-dotenv-file\n');

    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: 'hosting-secrets-app',
      env: 'production',
      key: 'SESSION_SECRET',
      secretRef: `dotenv:${envFile}#SESSION_SECRET`,
    });

    expect(result.ok).toBe(true);
    expect(result.data.valueSource).toBe('dotenv');
    expect(result.warnings).toBeUndefined();
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ vars: { SESSION_SECRET: 'from-dotenv-file' } }));
    // The resolved value never appears in the tool response.
    expect(JSON.stringify(result)).not.toContain('from-dotenv-file');
    await t.close();
  });

  it('generate=true sets a server-side random value that never appears in output', async () => {
    seedHostingProject();
    let capturedValue = '';
    vi.spyOn(hostingEnv, 'syncHostingEnvVars').mockImplementation(async (params) => {
      capturedValue = (params.vars as Record<string, string>).SESSION_SECRET;
      return { success: true, message: 'ok' };
    });

    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: 'hosting-secrets-app',
      env: 'production',
      key: 'SESSION_SECRET',
      generate: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data.valueSource).toBe('generated');
    expect(result.warnings).toBeUndefined();
    expect(capturedValue).toHaveLength(48);
    expect(JSON.stringify(result)).not.toContain(capturedValue);
    await t.close();
  });

  it('rejects generate combined with value or secretRef', async () => {
    seedHostingProject();
    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: 'hosting-secrets-app',
      env: 'production',
      key: 'X',
      value: 'y',
      generate: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    await t.close();
  });
});

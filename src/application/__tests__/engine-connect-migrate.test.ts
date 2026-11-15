import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import * as hostingEnv from '../../domain/services/hosting-env.service.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { registerConnectionsTools } from '../../tools/connections.tools.js';
import * as awsConnect from '../aws-connect.js';
import * as azureConnect from '../azure-connect.js';
import { cloudEngineForConnection } from '../cloud-engines.js';
import { CommandRegistry } from '../commands.js';
import { createCommandContext } from '../context.js';
import * as engineSecrets from '../engine-secrets.js';
import { migrateEnvironment } from '../migrate.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-engine-connect-migrate-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

// Contract: generic code selects a cloud's behavior from the engine registry
// (ARCHITECTURE.md, Enforced Boundaries); the tool only renders the step it gets back.
describe('guided connection through the engine registry', () => {
  function fixture() {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'connect-fixture', defaultPlatform: 'aws' });
    const commands = new CommandRegistry();
    registerConnectionsTools(commands, ctx);
    return { project, commands };
  }

  it('offers a guided connection for AWS and Azure only', () => {
    expect(['aws', 'azure', 'cloudrun', 'railway'].map((provider) => Boolean(cloudEngineForConnection(provider)))).toEqual([true, true, false, false]);
  });

  it.each([
    ['needs_approval', { result: { accountId: '123456789012' }, hint: 'Show the list.', ask: 'Ask to approve.' }, { ok: true, ask: 'Ask to approve.' }],
    ['waiting', { result: { url: 'http://127.0.0.1:1/connect/x' }, ask: 'Ask to sign in.' }, { ok: true, ask: 'Ask to sign in.' }],
    ['connected', { result: { accountId: '123456789012' }, next: ['hv_launch', 'hv_plan'] }, { ok: true }],
    ['failed', { result: {}, message: 'AWS refused the role.' }, { ok: false, code: 'PROVIDER_ERROR' }],
    ['invalid', { result: {}, message: 'Bad input.' }, { ok: false, code: 'VALIDATION' }],
  ] as const)('renders an engine step with status %s', async (status, step, expected) => {
    const f = fixture();
    const connect = vi.spyOn(awsConnect, 'connectAwsStep').mockResolvedValue({ status, ...step } as never);
    const result = await f.commands.execute('hv_connections', { provider: 'aws', action: 'connect', project: f.project.name, awsAccountId: '123456789012' }) as any;
    expect(connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ project: expect.objectContaining({ id: f.project.id }), input: expect.objectContaining({ awsAccountId: '123456789012' }) }));
    expect(result.ok).toBe(expected.ok);
    if ('code' in expected) expect(result.error).toMatchObject({ code: expected.code, message: (step as { message?: string }).message });
    if ('ask' in expected) expect(result.agentInstruction).toEqual({ action: 'ask_user', message: expected.ask });
    if (status === 'connected') expect(result.next).toEqual(['hv_launch', 'hv_plan']);
  });

  it('routes Azure to its own step and rejects approval without a subscription before any sign-in', async () => {
    const f = fixture();
    const result = await f.commands.execute('hv_connections', { provider: 'azure', action: 'connect', project: f.project.name, azureApproved: true }) as any;
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'azureApproved needs the azureSubscriptionId from the preview.' } });
    const step = vi.spyOn(azureConnect, 'connectAzureStep').mockResolvedValue({ status: 'needs_choice', result: { subscriptions: [] }, ask: 'Ask which subscription.' });
    const chosen = await f.commands.execute('hv_connections', { provider: 'azure', action: 'connect', project: f.project.name }) as any;
    expect(step).toHaveBeenCalledOnce();
    expect(chosen).toMatchObject({ ok: true, agentInstruction: { action: 'ask_user', message: 'Ask which subscription.' } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// Contract (docs/opentofu-engine-aws.md): migrating into AWS copies runtime settings
// into the secret store after the user sees their names; values are never shown.
describe('settings-only migration', () => {
  function fixture(write: (key: string, value: string) => Promise<string | undefined> = async () => undefined) {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'migrate-fixture', defaultPlatform: 'railway' });
    const source = ctx.repos.environments.create({ projectId: project.id, name: 'production' });
    const target = ctx.repos.environments.create({ projectId: project.id, name: 'testing' });
    ctx.repos.services.create({ projectId: project.id, name: 'web' });
    new ProjectSpecRepository().insert(project.id, 1, projectSpecSchema.parse({ version: 1, project: project.name, environments: {
      production: { hosting: { provider: 'railway' }, services: { web: {} } },
      testing: { hosting: { provider: 'aws', engine: 'opentofu' }, services: { web: {} }, envVars: { PORT: '3000' } },
    } }));
    vi.spyOn(hostingEnv, 'readHostingEnvVars').mockResolvedValue({ success: true, provider: 'railway',
      variables: { STRIPE_KEY: 'sk_live_value', SENTRY_DSN: 'https://dsn.example', PORT: '8080', EMPTY: '' } } as never);
    const writes: string[] = [];
    vi.spyOn(engineSecrets, 'engineSecretStore').mockResolvedValue({
      name: 'AWS Parameter Store', observe: async () => 'absent',
      write: async (key, value) => { const failure = await write(key, value); if (!failure) writes.push(key); return failure; },
    });
    const imported = () => (ctx.repos.environments.findById(target.id)!.platformBindings as { engine?: { importedSecrets?: string[] } }).engine?.importedSecrets;
    const migrate = (importSecrets?: boolean) => migrateEnvironment(ctx, { project, from: source.name, to: target.name, ...(importSecrets ? { importSecrets } : {}) });
    return { migrate, writes, imported };
  }

  it('previews the setting names and writes nothing until approved', async () => {
    const f = fixture();
    const preview = await f.migrate();
    expect(preview).toMatchObject({ status: 'needs_secret_import', keys: ['SENTRY_DSN', 'STRIPE_KEY'], message: expect.stringContaining('into AWS Parameter Store for testing') });
    expect(JSON.stringify(preview)).not.toContain('sk_live_value');
    expect(f.writes).toEqual([]);
    expect(f.imported()).toBeUndefined();
  });

  it('copies each setting, records the names, and says what to run next', async () => {
    const f = fixture();
    const result = await f.migrate(true);
    expect(f.writes).toEqual(['SENTRY_DSN', 'STRIPE_KEY']);
    expect(f.imported()).toEqual(['SENTRY_DSN', 'STRIPE_KEY']);
    expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/2 runtime setting\(s\) are in AWS Parameter Store for testing.*hv_plan scope="infrastructure"/) });
    expect(JSON.stringify(result)).not.toContain('sk_live_value');
  });

  it('records nothing as imported when the store rejects a value', async () => {
    const f = fixture(async (key) => key === 'STRIPE_KEY' ? 'Parameter Store did not accept STRIPE_KEY (AccessDenied).' : undefined);
    const result = await f.migrate(true);
    expect(result).toMatchObject({ status: 'blocked', message: 'Parameter Store did not accept STRIPE_KEY (AccessDenied). Nothing was recorded as imported. Run the migration again.' });
    expect(f.imported()).toBeUndefined();
  });
});

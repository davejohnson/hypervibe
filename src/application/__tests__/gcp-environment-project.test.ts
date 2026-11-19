import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { registerHvMigrateTools } from '../../tools/hv-migrate.tools.js';
import { CommandRegistry } from '../commands.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import * as bootstrap from '../../domain/services/gcp-bootstrap.service.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { engineGcpAdapter, resolveEngineContext } from '../infrastructure-engine.js';
import { launchEnvironment } from '../launch.js';

let directory: string;
const repository = 'example/app';
const production = 'example-app-production';
const staging = 'example-app-staging';
const projectInput = { name: 'app', gitRemoteUrl: 'https://github.com/example/app.git' };

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-environment-project-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected provider call'); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function connect(scope: string, projectId: string, credentials = JSON.stringify({
  type: 'service_account', project_id: projectId, client_email: `deployer@${projectId}.iam.gserviceaccount.com`,
})) {
  const ctx = createCommandContext();
  const row = ctx.repos.connections.upsert({ provider: 'cloudrun', scope,
    credentialsEncrypted: ctx.secretStore.encryptObject({ projectId, credentials }) });
  ctx.repos.connections.updateStatus(row.id, 'verified');
}

function specFor(provider = 'cloudrun', gcpProjectId = production) {
  return { version: 1, project: 'app', environments: {
    production: { hosting: { provider, gcpProjectId }, services: { web: {} } },
  } };
}

it('only accepts a valid project ID on Google Cloud hosting', () => {
  expect(projectSpecSchema.safeParse(specFor()).success).toBe(true);
  expect(projectSpecSchema.safeParse(specFor('railway')).success).toBe(false);
  expect(projectSpecSchema.safeParse(specFor('cloudrun', 'example/app')).success).toBe(false);
});

it('isolates the default and dedicated connections and checks their native target', async () => {
  connect(repository, staging);
  expect((await engineGcpAdapter(projectInput))?.engineConnection().projectId).toBe(staging);
  expect(await engineGcpAdapter(projectInput, production)).toBeUndefined();
  connect(repository + '#gcp:' + production, staging);
  expect(await engineGcpAdapter(projectInput, production)).toBeUndefined();
  connect(repository + '#gcp:' + production, production);
  expect((await engineGcpAdapter(projectInput, production))?.engineConnection().projectId).toBe(production);
  expect((await engineGcpAdapter(projectInput))?.engineConnection().projectId).toBe(staging);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['a different native project', JSON.stringify({ type: 'service_account', project_id: staging, client_email: `deployer@${production}.iam.gserviceaccount.com` })],
  ['a different service account project', JSON.stringify({ type: 'service_account', project_id: production, client_email: `deployer@${staging}.iam.gserviceaccount.com` })],
  ['missing identity fields', '{}'],
  ['malformed JSON', '{'],
])('declines a production-labeled connection with %s before contacting Google', async (_detail, credentials) => {
  connect(repository + '#gcp:' + production, production, credentials);
  expect(await engineGcpAdapter(projectInput, production)).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('previews billing for the dedicated target even when the repository already has a working connection', async () => {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create(projectInput);
  connect(repository, staging);
  const preview = vi.spyOn(bootstrap, 'runGcpBootstrap').mockResolvedValue({ success: true, mode: 'preview',
    target: { projectId: production }, openBillingAccounts: [{ name: 'billingAccounts/EXAMPLE' }] });
  const spec = projectSpecSchema.parse(specFor());
  const result = await launchEnvironment(ctx, { project, spec, specRevision: 1, environmentName: 'production' });
  expect(result).toMatchObject({ status: 'needs_billing_choice', gcpProjectId: production });
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({ environmentProjectId: production, environment: 'production' }));
  expect(fetch).not.toHaveBeenCalled();
});

it('blocks retargeting a bound environment before starting project setup', async () => {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create(projectInput);
  ctx.repos.environments.create({ projectId: project.id, name: 'production',
    platformBindings: { provider: 'cloudrun', projectId: staging, environmentId: 'us-central1' } });
  const preview = vi.spyOn(bootstrap, 'runGcpBootstrap');
  const spec = projectSpecSchema.parse(specFor());
  const result = await launchEnvironment(ctx, { project, spec, specRevision: 1, environmentName: 'production',
    billingAccountName: 'billingAccounts/EXAMPLE', approveAccess: ['gcp-setup'] });
  expect(result).toMatchObject({ status: 'blocked', message: expect.stringContaining(staging) });
  expect(preview).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('saves the chosen project when migration proposes a target and refuses a different project on retry', async () => {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create(projectInput);
  ctx.repos.environments.create({ projectId: project.id, name: 'source' });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    source: { hosting: { provider: 'railway' }, services: { web: {} } },
  } });
  const specs = new ProjectSpecRepository();
  specs.insert(project.id, 1, spec);
  const commands = new CommandRegistry();
  registerHvMigrateTools(commands, ctx);
  const preview = vi.spyOn(bootstrap, 'runGcpBootstrap').mockResolvedValue({ success: true, mode: 'preview',
    target: { projectId: production }, openBillingAccounts: [{ name: 'billingAccounts/EXAMPLE' }] });
  const input = { project: project.name, from: 'source', to: 'production', gcpProjectId: production };
  const first = await commands.execute('hv_migrate', input);
  expect(first).toMatchObject({ ok: true, data: { status: 'needs_billing_choice', gcpProjectId: production } });
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({ environmentProjectId: production }));
  preview.mockClear();
  const retry = await commands.execute('hv_migrate', { ...input, gcpProjectId: staging });
  expect(retry).toMatchObject({ ok: false, error: { message: expect.stringContaining(production) } });
  expect(preview).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('prevents a direct engine operation from adopting an environment owned by another provider', async () => {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create(projectInput);
  ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: { provider: 'railway' } });
  const result = await resolveEngineContext(ctx, project, projectSpecSchema.parse(specFor()), 'production');
  expect(result).toEqual({ blocked: expect.stringContaining('different hosting provider') });
  expect(fetch).not.toHaveBeenCalled();
});

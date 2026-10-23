import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import { SpecStore } from '../../spec/spec.store.js';
import { applyGitHubActionsDeploy, planGitHubActionsDeploy, resolveManagedWorkflowContract, workflowFiles } from '../ci-deploy.service.js';
import { MATCH_SIGNING_REQUIRED_SECRETS, IOS_RELEASE_REQUIRED_SECRETS } from '../ios-release-workflow.service.js';
import * as infrastructure from '../github-infrastructure.service.js';

let directory: string;
beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-ios-credentials-'));
  initializeDatabase(path.join(directory, 'test.db'));
});
afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

const REQUIRED = [...MATCH_SIGNING_REQUIRED_SECRETS, 'BUILD_TOKEN'].sort();
function fixture(options: { source?: string; accepted?: boolean } = { source: 'production' }) {
  const project = new ProjectRepository().create({ name: 'example', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/owner/example' });
  const environments = new EnvironmentRepository();
  for (const name of ['staging', 'production']) environments.create({ projectId: project.id, name, platformBindings: {
    provider: 'railway', projectId: 'railway-project', environmentId: `railway-${name}`, services: { web: { serviceId: `web-${name}` } },
  } });
  const environment = (name: string) => ({
    hosting: { provider: 'railway' }, services: { web: {} }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    ios: { bundleId: `com.example.${name}`, testflight: { groups: { beta: {} } }, release: {
      services: ['web'], build: { command: 'make ipa', ipaPath: 'build/App.ipa', requiredSecrets: ['BUILD_TOKEN'],
        ...(name === 'staging' && options.source !== undefined ? { credentialsEnvironment: options.source } : {}) },
      signing: { provider: 'match' }, testflight: { groups: ['beta'] },
    } },
  });
  new SpecStore().replace(project, { version: 1, project: project.name,
    environments: { staging: environment('staging'), production: environment('production') } });
  const spec = new SpecStore().get(project)!.spec;
  const connections = new ConnectionRepository();
  for (const [provider, credentials] of [
    ['railway', { apiToken: 'railway-fixture' }],
    ['github', { apiToken: 'github-fixture', login: 'owner', packageReadToken: 'package-fixture' }],
    ['appstoreconnect', { keyId: 'KEY', issuerId: 'ISSUER', privateKey: 'private-apple-fixture' }],
  ] as const) {
    const connection = connections.create({ provider, credentialsEncrypted: getSecretStore().encryptObject(credentials) });
    connections.updateStatus(connection.id, 'verified');
  }
  vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'owner', scopes: ['repo', 'workflow'] });
  vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
  const files = new Map<string, string>();
  for (const name of ['staging', 'production']) {
    const contract = resolveManagedWorkflowContract({ project, environmentName: name, environmentSpec: spec.environments[name] });
    if (!contract.ok) throw new Error(contract.error);
    for (const file of workflowFiles(contract.workflow)) files.set(file.path, file.content);
  }
  const workflowRead = vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, file) => options.accepted === false ? null : files.get(file) ?? null);
  const state = { id: 900, name: 'production', keys: [...REQUIRED], status: 200, rules: [] as Array<Record<string, unknown>> };
  const requested: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(init?.method).toBe('GET');
    expect(url.origin).toBe('https://api.github.com');
    requested.push(url.pathname);
    const base = '/repos/owner/example/environments/production';
    if (state.status !== 200) return Response.json({ message: 'raw-secret-echo' }, { status: state.status });
    if (url.pathname === base) return Response.json({ id: state.id, name: state.name });
    if (url.pathname === base + '/secrets') return Response.json({ total_count: state.keys.length,
      secrets: state.keys.map(name => ({ name, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })) });
    if (url.pathname === base + '/deployment_protection_rules') return Response.json({ total_count: state.rules.length, custom_deployment_protection_rules: state.rules });
    throw new Error('Unexpected source observation route');
  });
  const destinationNames = new Map([['production', [...REQUIRED]], ['staging', options.source && options.source.toLowerCase() !== 'staging' ? [] as string[] : [...REQUIRED]]]);
  const destinationRead = vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets').mockImplementation(async (_owner, _repo, name) => [...destinationNames.get(name)!]);
  const writes = vi.spyOn(GitHubAdapter.prototype, 'setEnvironmentSecret').mockImplementation(async (_owner, _repo, name, key) => {
    destinationNames.get(name)!.push(key);
  });
  const publish = vi.spyOn(infrastructure, 'proposeGitHubInfrastructureFiles').mockResolvedValue({ success: false, status: 'pending', message: 'Review prepared', data: { pullRequestNumber: 1 } });
  const plan = (name = 'staging') => planGitHubActionsDeploy({ project, environmentName: name, environmentSpec: spec.environments[name], environment: environments.findByProjectAndName(project.id, name) });
  const apply = (action: NonNullable<Awaited<ReturnType<typeof plan>>['action']>, name = 'staging') => applyGitHubActionsDeploy({ project, environmentName: name, environmentSpec: spec.environments[name], action });
  return { project, spec, state, requested, destinationNames, destinationRead, workflowRead, writes, publish, plan, apply };
}

const invalidSources = [
  ['missing source', (state: ReturnType<typeof fixture>['state']) => { state.status = 404; }],
  ['unknown source', (state: ReturnType<typeof fixture>['state']) => { state.status = 403; }],
  ['missing required secret', (state: ReturnType<typeof fixture>['state']) => { state.keys = state.keys.filter(key => key !== 'BUILD_TOKEN'); }],
  ['unsupported custom protection', (state: ReturnType<typeof fixture>['state']) => { state.rules = [{ id: 7, node_id: 'rule', enabled: true, app: { id: 8, slug: 'review', integration_url: 'https://example.test', node_id: 'app' } }]; }],
] as const;

describe('alternate iOS build credentials plan/apply', () => {
  it('reviews existing source identity and presence before workflow publication without resolving destination secrets', async () => {
    const f = fixture({ source: 'production', accepted: false });
    const planned = await f.plan();
    expect(planned.action).toMatchObject({ verified: true, metadata: { workflowPublicationRequired: true,
      iosBuildCredentialsSource: { id: 900, name: 'production', requiredSecretNames: REQUIRED, presentSecretNames: REQUIRED } } });
    expect(planned.warnings.join(' ')).toMatch(/staging.*production.*secrets|staging.*secrets.*production/);
    expect(f.destinationRead).not.toHaveBeenCalled();
    expect(JSON.stringify(planned)).not.toContain('private-apple-fixture');
    const applied = await f.apply(planned.action!);
    expect(applied.status).toBe('pending');
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each(invalidSources)('blocks publication planning for %s', async (_label, change) => {
    const f = fixture({ source: 'production', accepted: false });
    change(f.state);
    const planned = await f.plan();
    expect(planned.action?.verified).toBe(false);
    expect(JSON.stringify(planned)).not.toContain('raw-secret-echo');
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each([false, true])('checks the exact source again before apply (publication=%s)', async publication => {
    const f = fixture({ source: 'production', accepted: !publication });
    const planned = await f.plan();
    expect(planned.action?.verified).toBe(true);
    f.state.id = 901;
    const applied = await f.apply(planned.action!);
    expect(applied).toMatchObject({ success: false, status: 'blocked' });
    expect(applied.error).toMatch(/source|credentials environment/i);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each(invalidSources.flatMap(([label, change]) => [false, true].map(publication => ({ label, change, publication }))))(
    'blocks every write when the reviewed source changes to $label (publication=$publication)', async ({ change, publication }) => {
    const f = fixture({ source: 'production', accepted: !publication });
    const planned = await f.plan();
    change(f.state);
    const applied = await f.apply(planned.action!);
    expect(applied).toMatchObject({ success: false, status: 'blocked' });
    expect(applied.error).toMatch(/source|credentials environment/i);
    expect(JSON.stringify(applied)).not.toContain('raw-secret-echo');
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each([['staging', 'production'], ['production', 'staging']])('keeps managed writes in their logical environment in %s then %s order', async (first, second) => {
    const f = fixture();
    for (const name of [first, second]) {
      f.writes.mockClear();
      const planned = await f.plan(name);
      const applied = await f.apply(planned.action!, name);
      expect(applied.success, JSON.stringify(applied)).toBe(true);
      expect(f.writes.mock.calls.length).toBeGreaterThan(0);
      expect(f.writes.mock.calls.every(call => call[2] === name)).toBe(true);
      expect(f.writes.mock.calls.map(call => call[3])).toEqual(expect.arrayContaining([...IOS_RELEASE_REQUIRED_SECRETS]));
      expect(f.writes.mock.calls.some(call => REQUIRED.includes(call[3]))).toBe(false);
    }
    expect(f.destinationNames.get('staging')).not.toContain('BUILD_TOKEN');
  });

  it('replans a synced alternate source as noop and applies it without provider mutations', async () => {
    const f = fixture();
    const first = await f.plan();
    expect((await f.apply(first.action!)).success).toBe(true);
    const second = await f.plan();
    expect(second.action).toMatchObject({ type: 'noop', metadata: {
      iosBuildCredentialsSource: { id: 900, name: 'production', requiredSecretNames: REQUIRED, presentSecretNames: REQUIRED },
    } });
    f.writes.mockClear();
    const applied = await f.apply(second.action!);
    expect(applied.success).toBe(true);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('keeps an unchanged source identity when GitHub returns different name casing', async () => {
    const f = fixture();
    const planned = await f.plan();
    f.state.name = 'Production';
    const applied = await f.apply(planned.action!);
    expect(applied.success, JSON.stringify(applied)).toBe(true);
  });

  it('does not include unrelated staging build keys in the managed destination inventory', async () => {
    const f = fixture();
    const planned = await f.plan();
    f.destinationNames.get('staging')!.push(...REQUIRED);
    const applied = await f.apply(planned.action!);
    expect(applied.success, JSON.stringify(applied)).toBe(true);
    expect(f.writes.mock.calls.every(call => call[2] === 'staging')).toBe(true);
  });

  it.each(['missing', 'changed required names'] as const)('rejects %s source review metadata before writes', async mode => {
    const f = fixture();
    const planned = await f.plan();
    if (mode === 'missing') delete planned.action!.metadata!.iosBuildCredentialsSource;
    else (planned.action!.metadata!.iosBuildCredentialsSource as { requiredSecretNames: string[] }).requiredSecretNames = [];
    const applied = await f.apply(planned.action!);
    expect(applied).toMatchObject({ success: false, status: 'blocked' });
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each([undefined, 'staging', 'STAGING'])('preserves ordinary logical source behavior for %s', async source => {
    const f = fixture({ source });
    const planned = await f.plan();
    const applied = await f.apply(planned.action!);
    expect(applied.success, JSON.stringify(applied)).toBe(true);
    expect(planned.action?.metadata?.iosBuildCredentialsSource).toBeUndefined();
    expect(f.requested).toEqual([]);
  });
});

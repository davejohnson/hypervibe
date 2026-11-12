import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import { desiredPagesDnsRecords, GITHUB_PAGES_ACTION_ID, GITHUB_PAGES_DNS_OPERATION } from '../../domain/services/github-pages.service.js';
import { EMAIL_OPERATIONS } from '../../domain/services/email-plan.service.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { planPagesEmailDns, verifyDnsIntegrationSource, type DnsIntegrationDependencies } from '../dns-integrations.js';
import type { Project } from '../../domain/entities/project.entity.js';

// Reconstructed public fields from GitHub GET /repos/{owner}/{repo}/pages and
// SendGrid GET /v3/whitelabel/domains; only fetch is mocked for source checks.
const sendgridAuth = { id: 42, domain: 'example.com', subdomain: 'em', username: 'example', valid: true,
  default: false, legacy: false, dns: {
    dkim1: { host: 's1._domainkey.example.com', type: 'CNAME', data: 's1.sendgrid.net', valid: true },
    dkim2: { host: 's2._domainkey.example.com', type: 'CNAME', data: 's2.sendgrid.net', valid: true },
    mail_cname: { host: 'em.example.com', type: 'CNAME', data: 'u.sendgrid.net', valid: true },
  } };
const emailRecords = [
  { name: 's1._domainkey.example.com', type: 'CNAME', content: 's1.sendgrid.net' },
  { name: 's2._domainkey.example.com', type: 'CNAME', content: 's2.sendgrid.net' },
  { name: 'em.example.com', type: 'CNAME', content: 'u.sendgrid.net' },
  { name: 'inbound.example.com', type: 'MX', content: 'mx.sendgrid.net', priority: 10 },
];
const baseAction = (id: string, metadata: Record<string, unknown>): PlanAction => ({ id, type: 'update', resource: { kind: 'domain', provider: 'cloudflare', name: 'example.com' }, reason: 'test', verified: true, metadata });

describe('DNS consumer engine staging', () => {
  let dataDir: string; let ctx: CommandContext; let project: Project; let spec: ProjectSpec;
  let githubConnectionId: string; let emailConnectionId: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-dns-consumers-'));
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(dataDir, 'test.db'));
    ctx = createCommandContext();
    project = ctx.repos.projects.create({ name: 'dns-consumers', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/owner/repo.git' });
    ctx.repos.environments.create({ projectId: project.id, name: 'production' });
    for (const provider of ['github', 'sendgrid']) {
      const connection = ctx.repos.connections.create({ provider, scope: provider === 'github' ? 'owner/repo' : 'example.com',
        credentialsEncrypted: ctx.secretStore.encryptObject(provider === 'github' ? { apiToken: 'github-test-secret' } : { apiKey: 'SG.test-secret' }) });
      ctx.repos.connections.updateStatus(connection.id, 'verified');
      if (provider === 'github') githubConnectionId = connection.id; else emailConnectionId = connection.id;
    }
    spec = projectSpecSchema.parse({ version: 1, project: project.name, github: { repository: 'owner/repo', pages: { customDomain: 'example.com', sourcePath: 'public' } }, environments: { production: {
      hosting: { provider: 'railway' }, domain: 'example.com', services: { web: { public: true } },
      dns: { provider: 'gcp', zone: { id: 'example-zone', name: 'example.com', projectId: 'example-project' } },
      email: { enabled: true, inbound: { hostname: 'inbound.example.com', service: 'web', aliases: [] } },
    } } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const deps = (): DnsIntegrationDependencies => ({
    prepare: vi.fn(async () => ({ actions: [], ready: false, descriptor: { owner: 'pages' } as never })),
    verify: vi.fn(async () => ({ ready: true })),
    persist: vi.fn(() => ({ planRunId: 'dns-run', environmentName: 'production', specRevision: 1, actions: [], confirmActions: [], warnings: [] })),
  });
  function pagesActions(enabled = true, observed: unknown = { buildType: 'workflow', cname: 'example.com', httpsEnforced: false }): PlanAction[] {
    return [baseAction(GITHUB_PAGES_ACTION_ID, { observed, enabled, operation: 'githubPagesConfigure' }),
      baseAction('pages-dns', { operation: GITHUB_PAGES_DNS_OPERATION, repository: 'owner/repo', enabled,
        desiredRecords: desiredPagesDnsRecords('example.com', 'owner') })];
  }
  const input = (actions: PlanAction[]) => ({ project, spec, environmentName: 'production', specRevision: 1, actions });

  it('prepares independent Pages DNS only after the exact hostname was attached', async () => {
    const dependencies = deps(); const actions = pagesActions();
    expect(await planPagesEmailDns(ctx, input(actions), dependencies)).toMatchObject({ planRunId: 'dns-run' });
    expect(dependencies.prepare).toHaveBeenCalledWith(expect.objectContaining({ owner: 'pages', environmentSpec: expect.objectContaining({ hosting: { provider: 'railway' }, dns: expect.objectContaining({ provider: 'gcp' }) }),
      records: expect.arrayContaining([expect.objectContaining({ name: 'www.example.com', type: 'CNAME', values: ['owner.github.io'], proxied: false })]) }));
    expect(dependencies.persist).toHaveBeenCalledWith(ctx, expect.objectContaining({ source: expect.objectContaining({ kind: 'github-pages', connectionId: githubConnectionId, observed: actions[0]!.metadata!.observed }) }));
  });
  it('plans Pages DNS without inventing a hosting-domain attachment', async () => {
    const dependencies = deps();
    delete spec.environments.production!.domain;
    spec.environments.production!.email = { enabled: false };
    const parsed = projectSpecSchema.parse(spec);
    expect(await planPagesEmailDns(ctx, { ...input(pagesActions()), spec: parsed }, dependencies)).toMatchObject({ planRunId: 'dns-run' });
    expect(dependencies.prepare).toHaveBeenCalledWith(expect.objectContaining({ owner: 'pages', domain: 'example.com' }));
    expect(vi.mocked(dependencies.prepare).mock.calls[0]![0].environmentSpec.domain).toBeUndefined();
  });
  it('keeps the Pages claim attached while preparing owned DNS removal', async () => {
    const dependencies = deps(); const initial = pagesActions(true, null);
    expect(await planPagesEmailDns(ctx, input(initial), dependencies)).toBeNull();
    expect(initial[1]!.metadata?.dnsEngineDeferred).toBe(true);
    expect(initial[1]!.dependsOn).toContain(GITHUB_PAGES_ACTION_ID);
    expect(dependencies.prepare).not.toHaveBeenCalled();
    expect(await planPagesEmailDns(ctx, input(pagesActions(false)), dependencies)).toMatchObject({ planRunId: 'dns-run' });
    expect(dependencies.prepare).toHaveBeenCalledWith(expect.objectContaining({ owner: 'pages', remove: true }));
    expect(await planPagesEmailDns(ctx, input(pagesActions(false, null)), dependencies)).toMatchObject({ blocked: expect.any(Array) });
  });
  it('keeps one stable record-set key when address values change', async () => {
    const dependencies = deps();
    await planPagesEmailDns(ctx, input(pagesActions()), dependencies);
    const first = vi.mocked(dependencies.prepare).mock.calls[0]![0].records.find(record => record.type === 'A')!;
    const changed = pagesActions();
    (changed[1]!.metadata!.desiredRecords as Array<{ type: string; content: string }>).find(record => record.type === 'A')!.content = '192.0.2.10';
    await planPagesEmailDns(ctx, input(changed), dependencies);
    const second = vi.mocked(dependencies.prepare).mock.calls[1]![0].records.find(record => record.type === 'A')!;
    expect(second.key).toBe(first.key);
    expect(first.values).toHaveLength(4);
  });
  it('waits for exact email authorization then freezes MX into the shared engine plan', async () => {
    const dependencies = deps();
    const authorization = baseAction('email:sendgrid:authorization', { candidateExternalId: '42' }); authorization.type = 'create';
    const dns = baseAction('email:cloudflare:dns', { operation: EMAIL_OPERATIONS.dnsSync, authorizationId: '42', desiredRecords: emailRecords });
    expect(await planPagesEmailDns(ctx, input([authorization, dns]), dependencies)).toBeNull();
    expect(dependencies.prepare).not.toHaveBeenCalled();
    authorization.type = 'noop';
    expect(await planPagesEmailDns(ctx, input([authorization, dns]), dependencies)).toMatchObject({ planRunId: 'dns-run' });
    expect(dependencies.prepare).toHaveBeenCalledWith(expect.objectContaining({ owner: 'email', records: expect.arrayContaining([
      expect.objectContaining({ type: 'MX', name: 'inbound.example.com', values: ['10 mx.sendgrid.net.'] }),
    ]) }));
  });
  it('replaces a deprecated DNS action with a verified noop only after engine readiness', async () => {
    const dependencies = deps(); dependencies.prepare = vi.fn(async () => ({ ready: true, actions: [] }));
    const actions = pagesActions(); actions[1]!.metadata!.blockedReason = 'cloudflare_connection_unavailable'; actions[1]!.requiresConfirm = true;
    expect(await planPagesEmailDns(ctx, input(actions), dependencies)).toBeNull();
    expect(actions[1]).toMatchObject({ type: 'noop', verified: true, metadata: { dnsEngineReady: true } });
    expect(actions[1]!.metadata).not.toHaveProperty('blockedReason');
    expect(dependencies.persist).not.toHaveBeenCalled();
  });
  it('blocks incomplete records without asking the engine to invent targets', async () => {
    const dependencies = deps(); const actions = pagesActions(); delete actions[1]!.metadata!.desiredRecords;
    expect(await planPagesEmailDns(ctx, input(actions), dependencies)).toMatchObject({ blocked: expect.any(Array) });
    expect(dependencies.prepare).not.toHaveBeenCalled();
  });
  it('rechecks SendGrid exact identity and frozen targets through its actual HTTP client', async () => {
    let auth = sendgridAuth;
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push(url); expect(init.method).toBe('GET');
      return new Response(JSON.stringify([auth]), { status: 200 });
    }));
    const source = { kind: 'sendgrid-domain', connectionId: emailConnectionId, domain: 'example.com', authorizationId: '42', records: emailRecords };
    expect(await verifyDnsIntegrationSource(ctx, project, spec.environments.production!, source)).toEqual({ ready: true });
    auth = { ...sendgridAuth, id: 99 };
    expect(await verifyDnsIntegrationSource(ctx, project, spec.environments.production!, source)).toMatchObject({ ready: false });
    auth = { ...sendgridAuth, dns: { ...sendgridAuth.dns, dkim1: { ...sendgridAuth.dns.dkim1, data: 'changed.sendgrid.net' } } };
    expect(await verifyDnsIntegrationSource(ctx, project, spec.environments.production!, source)).toMatchObject({ ready: false });
    expect(requests).toEqual(Array(3).fill('https://api.sendgrid.com/v3/whitelabel/domains'));
  });
  it('rejects a changed Pages attachment using the actual GitHub HTTP client', async () => {
    let cname = 'example.com';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.github.com/repos/owner/repo/pages'); expect(init.method).toBe('GET');
      return new Response(JSON.stringify({ cname, build_type: 'workflow', https_enforced: false }), { status: 200 });
    }));
    const source = { kind: 'github-pages', connectionId: githubConnectionId, repository: 'owner/repo', domain: 'example.com', enabled: true,
      observed: { buildType: 'workflow', cname: 'example.com', httpsEnforced: false }, records: desiredPagesDnsRecords('example.com', 'owner') };
    expect(await verifyDnsIntegrationSource(ctx, project, spec.environments.production!, source)).toEqual({ ready: true });
    cname = 'other.example.com';
    expect(await verifyDnsIntegrationSource(ctx, project, spec.environments.production!, source)).toMatchObject({ ready: false });
  });
  it('does not treat an ambiguous Pages 404 as permission to delete DNS', async () => {
    let hasPages = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/pages')
      ? new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      : new Response(JSON.stringify({ id: 123, full_name: 'owner/repo', has_pages: hasPages, default_branch: 'main' }), { status: 200 })));
    const source = { kind: 'github-pages', connectionId: githubConnectionId, repository: 'owner/repo', domain: 'example.com', enabled: false,
      observed: null, records: desiredPagesDnsRecords('example.com', 'owner') };
    expect(await verifyDnsIntegrationSource(ctx, project, spec.environments.production!, source)).toMatchObject({ ready: false });
    hasPages = false;
    expect(await verifyDnsIntegrationSource(ctx, project, spec.environments.production!, source)).toMatchObject({ ready: false });
  });
});

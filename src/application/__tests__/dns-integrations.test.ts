import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import { EMAIL_OPERATIONS } from '../../domain/services/email-plan.service.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { planEmailDns, verifyDnsIntegrationSource, type DnsIntegrationDependencies } from '../dns-integrations.js';
import type { Project } from '../../domain/entities/project.entity.js';

// Reconstructed public fields from SendGrid GET /v3/whitelabel/domains; only
// fetch is mocked for source checks.
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
  let emailConnectionId: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-dns-consumers-'));
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(dataDir, 'test.db'));
    ctx = createCommandContext();
    project = ctx.repos.projects.create({ name: 'dns-consumers', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/owner/repo.git' });
    ctx.repos.environments.create({ projectId: project.id, name: 'production' });
    const connection = ctx.repos.connections.create({ provider: 'sendgrid', scope: 'example.com',
      credentialsEncrypted: ctx.secretStore.encryptObject({ apiKey: 'SG.test-secret' }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');
    emailConnectionId = connection.id;
    spec = projectSpecSchema.parse({ version: 1, project: project.name, github: { repository: 'owner/repo' }, environments: { production: {
      hosting: { provider: 'railway' }, domain: 'example.com', services: { web: { public: true } },
      dns: { provider: 'gcp', zone: { id: 'example-zone', name: 'example.com', projectId: 'example-project' } },
      email: { enabled: true, inbound: { hostname: 'inbound.example.com', service: 'web', aliases: [] } },
    } } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const deps = (): DnsIntegrationDependencies => ({
    prepare: vi.fn(async () => ({ actions: [], ready: false, descriptor: { owner: 'email' } as never })),
    verify: vi.fn(async () => ({ ready: true })),
    persist: vi.fn(() => ({ planRunId: 'dns-run', environmentName: 'production', specRevision: 1, actions: [], confirmActions: [], warnings: [] })),
  });
  function emailActions(): PlanAction[] {
    const authorization = baseAction('email:sendgrid:authorization', { candidateExternalId: '42' }); authorization.type = 'noop';
    return [authorization, baseAction('email:cloudflare:dns', { operation: EMAIL_OPERATIONS.dnsSync, authorizationId: '42', desiredRecords: emailRecords.map(record => ({ ...record })) })];
  }
  const input = (actions: PlanAction[]) => ({ project, spec, environmentName: 'production', specRevision: 1, actions });

  it('waits for exact email authorization then freezes MX into the shared engine plan', async () => {
    const dependencies = deps();
    const authorization = baseAction('email:sendgrid:authorization', { candidateExternalId: '42' }); authorization.type = 'create';
    const dns = baseAction('email:cloudflare:dns', { operation: EMAIL_OPERATIONS.dnsSync, authorizationId: '42', desiredRecords: emailRecords });
    expect(await planEmailDns(ctx, input([authorization, dns]), dependencies)).toBeNull();
    expect(dependencies.prepare).not.toHaveBeenCalled();
    authorization.type = 'noop';
    expect(await planEmailDns(ctx, input([authorization, dns]), dependencies)).toMatchObject({ planRunId: 'dns-run' });
    expect(dependencies.prepare).toHaveBeenCalledWith(expect.objectContaining({ owner: 'email', records: expect.arrayContaining([
      expect.objectContaining({ type: 'MX', name: 'inbound.example.com', values: ['10 mx.sendgrid.net.'] }),
    ]) }));
  });
  it('replaces a deprecated DNS action with a verified noop only after engine readiness', async () => {
    const dependencies = deps(); dependencies.prepare = vi.fn(async () => ({ ready: true, actions: [] }));
    const actions = emailActions(); actions[1]!.metadata!.blockedReason = 'cloudflare_connection_unavailable'; actions[1]!.requiresConfirm = true;
    expect(await planEmailDns(ctx, input(actions), dependencies)).toBeNull();
    expect(actions[1]).toMatchObject({ type: 'noop', verified: true, metadata: { dnsEngineReady: true } });
    expect(actions[1]!.metadata).not.toHaveProperty('blockedReason');
    expect(dependencies.persist).not.toHaveBeenCalled();
  });
  it('blocks incomplete records without asking the engine to invent targets', async () => {
    const dependencies = deps(); const actions = emailActions(); delete actions[1]!.metadata!.desiredRecords;
    expect(await planEmailDns(ctx, input(actions), dependencies)).toMatchObject({ blocked: expect.any(Array) });
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
    expect(requests).toEqual(Array(3).fill('https://api.sendgrid.com/v3/whitelabel/domains?limit=100&offset=0'));
  });
});
